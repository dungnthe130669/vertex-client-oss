// Devices v2 step 3 (devv2s3r): the per-device chat/page SESSION LIFECYCLE as ONE pure reducer. No I/O, no clocks (`now` is an input), no randomness. DeviceHub is a thin shell: it feeds inputs in,
// persists the returned state, and executes the returned effects. Every rule here is a review finding of devv2s3 rounds 1-4; the model-based tests (test/device-session.test.ts) assert the invariants after every step.
//
// State machine (one holder per device):
//   none --start--> reserved{gen,conv} --daemon session_started--> active{gen,conv} --stop/ended/error--> none
//   reserved | active --expiry, flag_off, chat_deleted, replaced-after-send--> draining{gen} --stop confirmed (event or cack of the hub stop) | offline-expiry | hard cap--> none
// `gen` is a monotonic counter bumped at every reservation. Queued commands and approvals carry the gen (and conv) they were raised for; when a generation ends, its queued work is cancelled and its approvals expire,
// so nothing of an ended session can be delivered or answered later.

export const HOLD_RESERVED_MS = 15 * 60_000;   // a queued/sent start that never produced a session
export const HOLD_IDLE_MS = 60 * 60_000;       // a session nobody has talked to or heard from for an hour (also the hard cap on `draining`)
export const DRAIN_OFFLINE_MS = 2 * 60_000;    // a draining session on a daemon that is offline this long is considered gone
const BUF_MAX = 100, CIDS_MAX = 24, APPR_KEEP = 200;
/** Held (provisional) input is bounded by SERIALIZED BYTES as well as count: the whole reducer state is one SQLite value (2 MB hard limit). Over any of the three limits the generation fails (provisional_overflow) and drains. */
export const BUF_BYTES = 256 * 1024, ENTRY_BYTES = 64 * 1024, PREVIEW_MAX = 4000;
const enc = new TextEncoder();
const sizeOf = (x: unknown): number => enc.encode(JSON.stringify(x)).length;
const bufBytes = (b: unknown[]): number => b.reduce<number>((n, x) => n + sizeOf(x), 0);
/** The bounded form of a held approval: the attribution-relevant part of the raw frame only (type, cid) and the approval payload with every string cut to PREVIEW_MAX. The raw frame is never kept. */
const boundApproval = (a: { rid: string; e: { type: string; cid?: unknown }; ev: Record<string, unknown>; tool: string; expiresAt: number }): ApprIn => {
  const ev: Record<string, unknown> = {}; for (const [k, v] of Object.entries(a.ev)) ev[k] = typeof v === "string" && v.length > PREVIEW_MAX ? v.slice(0, PREVIEW_MAX) : v;
  return { rid: a.rid, tool: a.tool.slice(0, 200), expiresAt: a.expiresAt, ev, e: { type: "approval_request", ...(typeof a.e.cid === "string" ? { cid: a.e.cid } : {}) } };
};
export const LIFECYCLE = new Set(["session_starting", "session_started", "session_error"]);

export type Json = Record<string, unknown>;
export type Who = { k: "chat"; conv: string } | { k: "page" };
export type Src = "chat" | "legacy" | "hub";
export type Kind = "start" | "say" | "stop" | "approval";
export type Holder = {
  phase: "reserved" | "active" | "draining"; gen: number; conv: string;       // conv = chat conversation id, or "page"
  cid: string;                    // the start command's cid
  startCseq: number;              // its outbox position (0 = unknown)
  since: number; lastActive: number;
  sent: boolean;                  // the start frame was written to a live daemon socket (it may be running even if never confirmed)
  acked: boolean;                 // the daemon acknowledged the start (cack / hello.lastCseq)
  cids: string[];                 // recent command cids of this generation (a daemon error tagged with one of them is this session's)
  stopSeq?: number;               // draining: cseq of the hub's stop (its cack confirms the daemon processed it)
};
export type Entry = { cseq: number; cid: string; gen: number; conv: string | null; src: Src; kind: Kind; allow?: boolean; sent: boolean };
export type Appr = { rid: string; gen: number; conv: string | null; state: "pending" | "allowed" | "denied" | "expired"; expiresAt: number };
export type Ev = { type: string; cid?: string; code?: string; [k: string]: unknown };
/** An input of an older (cid-less) daemon that arrived BEFORE the start's cack: held with the generation it may belong to, folded when hello.lastCseq / the cack confirms that generation, dropped when it ends. */
export type ApprIn = { rid: string; e: Ev; ev: Json; tool: string; expiresAt: number };
export type Prov = { gen: number; e: Ev } | { gen: number; a: ApprIn };
/** Reconnect handoff fence (devv2s3t): a generation ended/was freed WITHOUT its stop being confirmed, so the daemon may still replay that generation's unacknowledged output after the next hello. Until the hub's stop `seq` is cacked on the CURRENT connection every
 *  later command is held back and every input is discarded as belonging to the old generation. hello.lastCseq never satisfies it (the replay follows the hello). */
export type Fence = { seq: number };
export type State = { v: 1; gen: number; nextCseq: number; online: boolean; holder: Holder | null; entries: Entry[]; appr: Appr[]; buf: Prov[]; fence?: Fence | null;
  /** Disconnect gap (devv2s3u/v): the daemon (v0.10.0 hello carries no pending-request snapshot) denies every pending approval when its socket drops and replays any unacknowledged event after the next hello, so an approval request that
   *  arrives in that replay may already be dead. `gap` = offline since the last hello. Order-based replay barrier (devv2s3v, no clock): the daemon resends its unacked backlog synchronously on hello, BEFORE it runs any command we send afterwards on
   *  the same connection, and cacks commands in order. So the hello that follows a gap enqueues a no-op command (`barrier.seq`, a hub deny of a rid that never existed: the daemon ignores an unknown rid and cacks) and every approval request that arrives
   *  before ITS cack on the CURRENT connection is denied, never offered. Pinned on hello like the fence (re-sent, hello.lastCseq never satisfies it); persisted; only that cack clears it. */
  gap?: boolean; barrier?: Fence | null };

export const initState = (): State => ({ v: 1, gen: 0, nextCseq: 1, online: false, holder: null, entries: [], appr: [], buf: [] });

export type Input =
  | { t: "cmd"; who: Who; cid: string; kind: "start" | "say" | "stop"; frame: Json; now: number; full?: boolean }
  | { t: "event"; e: Ev; now: number }
  | { t: "approval_req"; rid: string; e: Ev; ev: Json; tool: string; expiresAt: number; now: number }
  | { t: "answer"; who: Who; rid: string; allow: boolean; now: number }
  | { t: "cack"; cseq: number; now: number }
  | { t: "hello"; lastCseq: number; envOn: boolean; now: number }
  | { t: "deliver"; envOn: boolean; now: number }
  | { t: "offline"; now: number }
  | { t: "tick"; now: number }
  | { t: "flag_off"; all: boolean; now: number }
  | { t: "chat_deleted"; conv: string; now: number }
  | { t: "revoke"; now: number };

export type InputNoNow = Input extends infer I ? (I extends unknown ? Omit<I, "now"> : never) : never;
export type Effect =
  | { k: "enqueue"; cseq: number; cid: string; kind: Kind; src: Src; conv: string | null; gen: number; frame: Json }
  | { k: "send"; cseq: number; cid: string; kind: Kind; conv: string | null; src: Src }                  // write this outbox entry to the live daemon socket (the shell emits cmd_sent)
  | { k: "cancel"; cseqs: number[] }                                                           // delete these undelivered / unconfirmed outbox entries
  | { k: "acked"; cseq: number; cid: string; conv: string | null; kind: Kind; src: Src }                              // the daemon acknowledged this user command (the shell emits cmd_acked)
  | { k: "emit"; e: Ev; tag: string | null }                                                   // append to the event log, tagged with the chat ("page") it belongs to; null = untagged
  | { k: "approval_new"; rid: string; gen: number; conv: string | null; tool: string; ev: Json; expiresAt: number }
  | { k: "approval_state"; rid: string; state: "allowed" | "denied" | "expired"; by: string; conv: string | null }
  | { k: "mark_draining"; gen: number; conv: string; reason: string }
  | { k: "release"; gen: number; conv: string; reason: string };

export type Result =
  | { ok: true; cseq?: number; gen?: number; state?: string; conv?: string | null; tag?: string | null; buffered?: boolean }
  | { ok: false; code: "busy" | "not_your_session" | "queue_full" | "unknown_request" | "forbidden" | "expired" | "already_resolved" | "stale_generation"; state?: string };
export type Out = { s: State; fx: Effect[]; r: Result };

const hid = (g: number) => `hub-stop-${g}`;

/** The moment the reducer next needs a tick on its own (holder expiry / pending approval expiry); null = nothing is waiting on a clock. Invariant (model-checked): any non-free holder has a deadline, and a tick AT it changes the state. */
export function deadline(s: State): number | null {
  let at: number | null = null;
  const min = (t: number) => { at = at === null ? t : Math.min(at, t); };
  const h = s.holder;
  if (h) min(h.phase === "reserved" ? h.since + HOLD_RESERVED_MS + 1 : h.phase === "active" ? h.lastActive + HOLD_IDLE_MS + 1 : h.since + (s.online ? HOLD_IDLE_MS : DRAIN_OFFLINE_MS) + 1);
  for (const a of s.appr) if (a.state === "pending") min(a.expiresAt * 1000);
  return at;
}

/** The one entry point. Pure: same (state, input) -> same output; the input state is never mutated. */
export function step(s0: State, i: Input): Out {
  const s: State = structuredClone(s0); const fx: Effect[] = [];
  let r: Result = { ok: true };

  // ---- helpers (close over s / fx) ----
  const cancelEntries = (pred: (e: Entry) => boolean) => { const c = s.entries.filter(pred); if (c.length) { s.entries = s.entries.filter((e) => !pred(e)); fx.push({ k: "cancel", cseqs: c.map((e) => e.cseq) }); } };
  const expireAppr = (pred: (a: Appr) => boolean, by: string) => {
    for (const a of s.appr) if (a.state === "pending" && pred(a)) {
      a.state = "expired"; fx.push({ k: "approval_state", rid: a.rid, state: "expired", by, conv: a.conv });
      // the daemon is told (deny) so a stale approval can never be granted later; a safety denial is never cancelled by anything
      const cseq = s.nextCseq++, cid = `approval:${a.rid}`;
      s.entries.push({ cseq, cid, gen: a.gen, conv: a.conv, src: "hub", kind: "approval", allow: false, sent: false });
      fx.push({ k: "enqueue", cseq, cid, kind: "approval", src: "hub", conv: a.conv, gen: a.gen, frame: { kind: "approval", rid: a.rid, allow: false, reason: "expired" } });
    }
  };
  const enqueue = (cid: string, kind: Kind, src: Src, conv: string | null, gen: number, frame: Json, allow?: boolean): number => {
    const cseq = s.nextCseq++;
    s.entries.push({ cseq, cid, gen, conv, src, kind, ...(allow !== undefined ? { allow } : {}), sent: false });
    fx.push({ k: "enqueue", cseq, cid, kind, src, conv, gen, frame });
    return cseq;
  };
  const release = (reason: string) => { const h = s.holder; if (!h) return; s.holder = null; s.buf = []; fx.push({ k: "release", gen: h.gen, conv: h.conv, reason }); };
  /** Release a holder that may be freed without its stop having been confirmed (draining, stop still unacknowledged): a handoff fence is recorded first. */
  const releaseF = (reason: string) => { const h = s.holder; if (h && h.phase === "draining" && h.stopSeq !== undefined && s.entries.some((e) => e.cseq === h.stopSeq)) s.fence = { seq: h.stopSeq }; release(reason); };
  const overflow = (h: Holder): Result => { fx.push({ k: "emit", e: { type: "session_error", code: "provisional_overflow" }, tag: h.conv }); drainNow("provisional_overflow"); return { ok: false, code: "queue_full" }; };
  const holdable = (h: Holder | null, ecid: string | null, replay: boolean): boolean => !!h && h.phase === "reserved" && ecid === null && h.conv !== "page" && h.sent && !h.acked && !replay;
  const room = (item: Prov): boolean => s.buf.length < BUF_MAX && sizeOf(item) <= ENTRY_BYTES && bufBytes(s.buf) + sizeOf(item) <= BUF_BYTES;
  /** End a generation: cancel its undelivered commands (never the hub's own stops/denials), expire its approvals. */
  const endGen = (h: Holder, by: string) => {
    cancelEntries((e) => e.gen === h.gen && e.src !== "hub" && !(e.kind === "stop"));
    expireAppr((a) => a.gen === h.gen, by);
  };
  /** The cleanup path: the session may be running -> stop it and wait for the confirmation before anything else is admitted. A start that never left the hub is simply dropped. */
  const now = i.now;
  const drainNow = (reason: string) => {
    const h = s.holder; if (!h || h.phase === "draining") return;
    endGen(h, "hub"); s.buf = [];                                                          // its generation ended: provisional input of it is never applied
    if (h.phase === "reserved" && !h.sent) { release(reason); return; }
    h.phase = "draining"; h.since = now; h.lastActive = now;
    const cid = hid(h.gen);
    h.stopSeq = enqueue(cid, "stop", "hub", h.conv, h.gen, { kind: "stop" });
    h.cids.push(cid);
    fx.push({ k: "mark_draining", gen: h.gen, conv: h.conv, reason });
  };
  const tagOf = (h: Holder): string => h.conv;
  /** Whose an event is. Content only for the holder's own session; foreign cids never refresh or release. */
  const own = (h: Holder, e: Ev): boolean => typeof e.cid !== "string" || e.cid === h.cid || h.cids.includes(e.cid);
  const live = (gen: number) => !!s.holder && s.holder.gen === gen;

  const handleEvent = (e: Ev, replay: boolean): void => {
    const h = s.holder; const type = String(e.type); const ecid = typeof e.cid === "string" ? e.cid : null;
    if (!h) { fx.push({ k: "emit", e, tag: null }); return; }
    if (h.phase === "reserved") {
      const mine = ecid !== null ? ecid === h.cid : false;
      // an older daemon (no cid) answers the start only after it acknowledged it; its provisional events arrive BEFORE the cack, so they are held back until then
      if (holdable(h, ecid, replay)) { const item: Prov = { gen: h.gen, e }; if (room(item)) s.buf.push(item); else overflow(h); return; }
      const legacyMine = ecid === null && h.sent && (h.acked || h.conv === "page");
      // an own-cid event proves the daemon processed the start (the same proof a cack is): whatever an older-protocol path held back before it is folded first, in arrival order
      if (mine && s.buf.length) { h.acked = true; h.sent = true; replayBuf(); const h2 = s.holder; if (!h2 || h2.gen !== h.gen || h2.phase !== "reserved") { if (!h2 || h2.gen !== h.gen) { fx.push({ k: "emit", e, tag: null }); return; } handleEvent(e, replay); return; } }
      const answers = mine || legacyMine;
      if (!answers) { fx.push({ k: "emit", e, tag: null }); return; }                     // foreign: never promotes, releases or refreshes
      if (type === "session_started") { h.phase = "active"; h.lastActive = now; fx.push({ k: "emit", e, tag: tagOf(h) }); return; }
      if (type === "session_error") { fx.push({ k: "emit", e, tag: tagOf(h) }); endGen(h, "hub"); release("start_refused"); return; }
      if (type === "session_ended" || type === "session_stopped") { fx.push({ k: "emit", e, tag: null }); return; } // an earlier session's end (e.g. the stop queued before a replacement start): a reserved start has no session to end
      h.lastActive = now; fx.push({ k: "emit", e, tag: tagOf(h) }); return;
    }
    // active / draining: the holder's session
    if (!own(h, e)) { fx.push({ k: "emit", e, tag: null }); return; }                      // another cid: a legacy command's error, never this session's
    fx.push({ k: "emit", e, tag: tagOf(h) });
    if (type === "session_ended" || type === "session_stopped") { endGen(h, "hub"); releaseF(h.phase === "draining" ? "drained" : "ended"); return; }
    if (type === "session_error") {
      const noSess = e.code === "no_session";
      if (h.phase === "draining") { if (noSess || (ecid === null && e.code !== "busy")) { endGen(h, "hub"); releaseF("drained"); } return; }
      if (ecid === h.cid || noSess || (ecid === null && e.code !== "busy")) { endGen(h, "hub"); release("session_error"); return; }
      h.lastActive = now; return;                                                          // e.g. a `busy` refusal of someone else's start while this session runs
    }
    if (h.phase === "active") h.lastActive = now;
  };

  /** Approval of a daemon session. A cid-less one that arrives before the start is confirmed is held (with its payload) exactly like an event: it becomes attributable and answerable only through the confirmed generation. */
  const addApproval = (a0: ApprIn, replay: boolean): Result => {
    const h = s.holder; const e = a0.e;
    if (s.appr.some((a) => a.rid === a0.rid)) return { ok: true, tag: null };
    const ecid = typeof e.cid === "string" ? e.cid : null;
    if (!replay && (s.gap || s.barrier)) {        // possibly the daemon's replay of a request it already denied locally on disconnect: unknown state is denied, not offered
      s.appr.push({ rid: a0.rid, gen: 0, conv: null, state: "expired", expiresAt: a0.expiresAt }); if (s.appr.length > APPR_KEEP) s.appr = s.appr.filter((x, ix) => x.state === "pending" || ix >= s.appr.length - APPR_KEEP);
      enqueue(`approval:${a0.rid}`, "approval", "hub", null, 0, { kind: "approval", rid: a0.rid, allow: false, reason: "replayed_after_disconnect" }, false);
      return { ok: true, tag: null };
    }
    if (holdable(h, ecid, replay)) { const item: Prov = { gen: h!.gen, a: boundApproval(a0) }; if (!room(item)) return overflow(h!); s.buf.push(item); return { ok: true, tag: null, buffered: true }; }
    const mineH = !!h && (h.phase !== "reserved" ? own(h, e) : ecid === h.cid || (ecid === null && h.sent && (h.acked || h.conv === "page")));
    if (!mineH && h && h.conv !== "page") {                                                // a chat holds the device and nothing proves this request is its session's: it is never answerable (by the page or anyone), the daemon is told to deny it
      s.appr.push({ rid: a0.rid, gen: 0, conv: null, state: "expired", expiresAt: a0.expiresAt }); if (s.appr.length > APPR_KEEP) s.appr = s.appr.filter((x, ix) => x.state === "pending" || ix >= s.appr.length - APPR_KEEP);
      enqueue(`approval:${a0.rid}`, "approval", "hub", null, 0, { kind: "approval", rid: a0.rid, allow: false, reason: "unattributed" }, false);
      return { ok: true, tag: null };
    }
    const a: Appr = { rid: a0.rid, gen: mineH ? h!.gen : 0, conv: mineH ? h!.conv : null, state: "pending", expiresAt: a0.expiresAt };
    s.appr.push(a); if (s.appr.length > APPR_KEEP) s.appr = s.appr.filter((x, ix) => x.state === "pending" || ix >= s.appr.length - APPR_KEEP);
    fx.push({ k: "approval_new", rid: a.rid, gen: a.gen, conv: a.conv, tool: a0.tool, ev: a0.ev, expiresAt: a0.expiresAt });
    if (mineH && h!.phase !== "draining") h!.lastActive = now;
    if (mineH && h!.phase === "draining") expireAppr((x) => x.rid === a.rid, "hub"); // a session that is being stopped asks for nothing
    return { ok: true, tag: a.conv, gen: a.gen };
  };
  /** Fold the held input once its generation is confirmed (start acked). Held input of a generation that is gone is dropped; of the live but still unconfirmed one it is KEPT (a disconnect does not lose it). */
  const replayBuf = () => {
    const h = s.holder;
    if (!h) { s.buf = []; return; }
    if (h.phase !== "reserved" || !h.acked) return;
    const b = s.buf.filter((p) => p.gen === h.gen); s.buf = [];
    for (const p of b) { if ("a" in p) addApproval(p.a, true); else handleEvent(p.e, true); }
  };
  /** Clock-driven expiry, reconciled synchronously before admission and before delivery as well as on the alarm. */
  const expire = () => {
    expireAppr((a) => a.expiresAt <= Math.floor(now / 1000), "hub");
    const h = s.holder;
    if (h) {
      if (h.phase === "reserved" && now - h.since > HOLD_RESERVED_MS) drainNow("reserved_expired");
      else if (h.phase === "active" && now - h.lastActive > HOLD_IDLE_MS) drainNow("idle_expired");
      else if (h.phase === "draining") {
        const age = now - h.since;
        if ((!s.online && age >= DRAIN_OFFLINE_MS) || age >= HOLD_IDLE_MS) releaseF("drain_expired");
      }
    }
  };
  /** A stop from the holder itself: its generation ends NOW (pending work cancelled, approvals expired) and the holder drains until THAT stop's cack (or a session_stopped / ended event) confirms the daemon processed it. */
  const userStop = (h: Holder, cseq: number) => {
    if (h.phase === "draining") return;
    endGen(h, "hub"); s.buf = [];
    h.phase = "draining"; h.since = now; h.lastActive = now; h.stopSeq = cseq;
    fx.push({ k: "mark_draining", gen: h.gen, conv: h.conv, reason: "user_stop" });
  };

  const cleanupAll = drainNow;

  switch (i.t) {
    case "cmd": {
      expire();                                                                                         // an expired holder is gone BEFORE this command is admitted (no alarm needed)
      const h = s.holder; const { who, kind, cid } = i; const conv = who.k === "chat" ? who.conv : "page"; const src: Src = who.k === "chat" ? "chat" : "legacy";
      if (i.full) { r = { ok: false, code: "queue_full" }; break; }
      if (kind === "start") {
        if (h && (h.conv !== conv || h.phase !== "reserved")) { r = { ok: false, code: "busy" }; break; }   // single holder; an ACTIVE or draining holder is never touched by a start
        if (h && h.sent) { drainNow("replacement"); r = { ok: false, code: "busy" }; break; }            // it may be running: it drains (stop + confirmation) first; the replacement is admitted only after that
        if (h) {                                                                                        // the same party restarts over its own stale reservation that never left the hub
          endGen(h, "hub");
          const old = s.holder!; s.holder = null; s.buf = [];
          fx.push({ k: "release", gen: old.gen, conv: old.conv, reason: "replaced" });
        }
        const gen = ++s.gen;
        const cseq = enqueue(cid, "start", src, conv, gen, i.frame);
        s.holder = { phase: "reserved", gen, conv, cid, startCseq: cseq, since: now, lastActive: now, sent: false, acked: false, cids: [cid] };
        r = { ok: true, cseq, gen }; break;
      }
      if (who.k === "chat") {
        if (kind === "stop" && !h) { r = { ok: true, cseq: 0, gen: 0 }; break; }   // nothing is held (already confirmed stopped / expired): a repeated Stop is an idempotent no-op, never a dispatch
        if (!h || h.conv !== conv || (kind === "say" && h.phase !== "active")) { r = { ok: false, code: "not_your_session" }; break; }
        if (kind === "stop" && h.phase === "reserved" && !h.sent) { endGen(h, "hub"); release("stopped_before_send"); r = { ok: true, cseq: 0, gen: h.gen }; break; } // zero dispatches
        const cseq = enqueue(cid, kind, src, conv, h.gen, i.frame); h.cids.length >= CIDS_MAX && h.cids.shift(); h.cids.push(cid);
        if (kind === "say") h.lastActive = now;
        if (kind === "stop") userStop(h, cseq);
        r = { ok: true, cseq, gen: h.gen }; break;
      }
      // device page say / stop
      if (h && h.conv !== "page") { r = { ok: false, code: "busy" }; break; }
      if (h) {
        if (kind === "say" && h.phase === "draining") { r = { ok: false, code: "busy" }; break; }   // its session is being stopped: nothing new is said into it
        if (kind === "stop" && h.phase === "reserved" && !h.sent) { endGen(h, "hub"); release("stopped_before_send"); r = { ok: true, cseq: 0, gen: h.gen }; break; }
        const cseq = enqueue(cid, kind, src, "page", h.gen, i.frame); h.cids.length >= CIDS_MAX && h.cids.shift(); h.cids.push(cid);
        if (kind === "say") h.lastActive = now;
        if (kind === "stop") userStop(h, cseq);
        r = { ok: true, cseq, gen: h.gen }; break;
      }
      r = { ok: true, cseq: enqueue(cid, kind, src, "page", 0, i.frame), gen: 0 };          // a session the hub did not see start: passes through as before
      break;
    }
    case "event": if (s.fence) break; handleEvent(i.e, false); break;                       // behind a handoff fence: input of the previous generation, discarded
    case "approval_req": { if (s.fence) { r = { ok: true, tag: null }; break; } r = addApproval({ rid: i.rid, e: i.e, ev: i.ev, tool: i.tool, expiresAt: i.expiresAt }, false); break; }
    case "answer": {
      const a = s.appr.find((x) => x.rid === i.rid);
      if (!a) { r = { ok: false, code: "unknown_request" }; break; }
      const conv = i.who.k === "chat" ? i.who.conv : "page";
      // Answered only through the party it was raised for, and only while ITS generation is the live one: a chat its own session's requests, the page the page's and the ones of unknown origin; never across, never after the session ended.
      if (i.who.k === "page" ? a.conv !== null && a.conv !== "page" : a.conv !== conv) { r = { ok: false, code: "forbidden" }; break; }
      if (a.state !== "pending") { r = { ok: false, code: a.state === "expired" ? "expired" : "already_resolved", state: a.state }; break; }
      if (a.expiresAt <= Math.floor(now / 1000)) { expireAppr((x) => x.rid === a.rid, "hub"); r = { ok: false, code: "expired", state: "expired" }; break; }
      if (a.gen !== 0 && (!s.holder || s.holder.gen !== a.gen || s.holder.phase === "draining")) { expireAppr((x) => x.rid === a.rid, "hub"); r = { ok: false, code: "stale_generation", state: "expired" }; break; }
      a.state = i.allow ? "allowed" : "denied";
      fx.push({ k: "approval_state", rid: a.rid, state: a.state, by: "user", conv: a.conv });
      const cseq = enqueue(`approval:${a.rid}`, "approval", i.who.k === "chat" ? "chat" : "legacy", i.who.k === "chat" ? conv : null, a.gen, { kind: "approval", rid: a.rid, allow: i.allow }, i.allow);
      if (s.holder && s.holder.gen === a.gen) s.holder.lastActive = now;
      r = { ok: true, cseq, state: a.state, conv: a.conv }; break;
    }
    case "cack": case "hello": {
      const through = i.t === "cack" ? i.cseq : i.lastCseq;
      const h = s.holder;
      // hello.lastCseq only proves the daemon RAN a command; the output it still has to replay arrives after the hello. The stop that a handoff fence / a draining holder waits for therefore stays queued (it is re-sent and
      // the daemon re-cacks a duplicate cumulatively) until its cack arrives on THIS connection.
      const pinned = (e: Entry) => i.t === "hello" && ((!!s.fence && e.cseq === s.fence.seq) || (!!s.barrier && e.cseq === s.barrier.seq) || (!!h && h.phase === "draining" && e.cseq === h.stopSeq));
      const done = s.entries.filter((e) => e.cseq <= through && !pinned(e));
      for (const e of done) fx.push({ k: "acked", cseq: e.cseq, cid: e.cid, conv: e.conv, kind: e.kind, src: e.src });
      s.entries = s.entries.filter((e) => e.cseq > through || pinned(e));
      if (h) {
        if (!h.acked && h.startCseq > 0 && h.startCseq <= through) { h.acked = true; h.sent = true; }
        if (i.t === "cack" && h.phase === "draining" && h.stopSeq !== undefined && h.stopSeq <= through) release("stop_confirmed");   // the stop's cack on the live connection: everything the daemon sent before it has been seen
      }
      if (i.t === "cack" && s.online && s.fence && through >= s.fence.seq) s.fence = null;
      if (i.t === "cack" && s.online && s.barrier && through >= s.barrier.seq) s.barrier = null;
      if (i.t === "hello") {
        // a reconnect that follows a gap (or with a barrier still open, or with chat / provisional / fenced state that the daemon may still replay into) opens the barrier; an open one is kept (same command, re-sent)
        if (!s.barrier && (s.gap || (s.holder && s.holder.sent) || s.buf.length || s.fence)) { const seq = enqueue(`barrier:${s.nextCseq}`, "approval", "hub", null, 0, { kind: "approval", rid: `barrier-${s.nextCseq}`, allow: false, reason: "barrier" }, false); s.barrier = { seq }; }
        s.gap = false; s.online = true; for (const e of s.entries) e.sent = false; if (s.holder && !s.holder.acked) s.holder.sent = false; }
      replayBuf();
      if (i.t === "hello") { expire(); step2deliver(i.envOn); }                              // expiry is reconciled before anything is delivered: an expired reservation can never execute even when the reconnect wins the alarm race
      break;
    }
    case "deliver": expire(); step2deliver(i.envOn); break;
    case "offline": {
      if (s.online) s.gap = true; s.online = false;                                                        // provisional input stays: the daemon already discarded what we acknowledged; hello.lastCseq decides whether it belongs to a confirmed start
      expireAppr(() => true, "hub");                                                         // the daemon denies every pending approval when its socket goes away
      s.buf = s.buf.filter((p) => !("a" in p));                                              // ... including the ones held before the start was confirmed
      break;
    }
    case "tick": expire(); break;
    case "flag_off": {
      const h = s.holder;
      // chat environments off: every chat holder is cleaned up (never the page's); the master switch off cleans the page too. Any chat command still queued is cancelled, a stop is not.
      cancelEntries((e) => e.src === "chat" && e.kind !== "stop");
      if (h && (i.all || h.conv !== "page")) { cleanupAll("flag_off"); }
      expireAppr((a) => a.conv !== null && (i.all || a.conv !== "page"), "hub");
      break;
    }
    case "chat_deleted": {
      cancelEntries((e) => e.conv === i.conv && e.src === "chat" && e.kind !== "stop");
      expireAppr((a) => a.conv === i.conv, "hub");
      if (s.holder && s.holder.conv === i.conv) cleanupAll("chat_deleted");
      break;
    }
    case "revoke": {
      cancelEntries(() => true); s.appr.forEach((a) => { if (a.state === "pending") { a.state = "expired"; fx.push({ k: "approval_state", rid: a.rid, state: "expired", by: "hub", conv: a.conv }); } });
      release("revoked"); s.gen++; s.online = false; s.fence = null; s.barrier = null; s.gap = false;
      break;
    }
  }
  return { s, fx, r };

  /** Write every unsent entry, in order, to the live daemon. An env-off read cleans chat work up first (stops survive). Nothing of a dead generation leaves. */
  function step2deliver(envOn: boolean) {
    if (!envOn) {
      cancelEntries((e) => e.src === "chat" && e.kind !== "stop");
      const h = s.holder; if (h && h.conv !== "page") cleanupAll("env_off");
      expireAppr((a) => a.conv !== null && a.conv !== "page", "hub");
    }
    if (!s.online) return;
    const dead = (e: Entry) => e.gen !== 0 && e.src !== "hub" && e.kind !== "stop" && !(e.kind === "approval" && e.allow !== true) && !live(e.gen);
    cancelEntries(dead);
    for (const e of s.entries) if (!e.sent) {
      if (s.fence && e.cseq > s.fence.seq) break; /* held behind the handoff fence: nothing newer than the old generation's stop leaves until that stop is cacked on this connection */ e.sent = true; fx.push({ k: "send", cseq: e.cseq, cid: e.cid, kind: e.kind, conv: e.conv, src: e.src }); if (s.holder && e.kind === "start" && s.holder.startCseq === e.cseq) s.holder.sent = true; }
  }
}
