// Pure logic for the local-device screens (docs/vertex-client-vcl-protocol.md): event folding, approval states, formatting. No DOM, no network.
export type Frame = Record<string, any>;
export type ApprovalState = "pending" | "allowed" | "denied" | "expired";
export type Approval = { rid: string; tool: string; preview: string; expires_at: number; ttl_s: number; state: ApprovalState; by?: string };
export type Item =
  | { k: "user"; id: string; text: string }
  | { k: "text"; id: string; text: string }
  | { k: "tool"; id: string; tid: string; name: string; input: string; output?: string; isError?: boolean }
  | { k: "note"; id: string; text: string; n?: number; ts?: number }
  | { k: "error"; id: string; text: string };
/** One sent message (start/say) as the page tracks it: the status line is derived from this + the clock (turnLine). `at` = when the current state was entered (hub-stamped for events, hub-clock-corrected local time otherwise). */
export type TurnState = "sending" | "queued" | "sent" | "delivered" | "accepted" | "starting" | "working" | "done" | "failed";
export type Turn = { cid: string; state: TurnState; at: number; frame?: Frame; failText?: string; cseq?: number };
export type Feed = { items: Item[]; online: boolean; active: boolean; sandbox?: string; bash?: boolean; dir?: string; approvals: Approval[]; resynced: boolean; turn: Turn | null; lastOnline?: number };
export const emptyFeed = (): Feed => ({ items: [], online: false, active: false, approvals: [], resynced: false, turn: null });

export const ERROR_TEXT: Record<string, string> = {
  no_roots: "No directory is configured on this device. Run `vcl root add <dir>` there first.",
  dir_outside_roots: "That directory is not under a configured root on the device.",
  busy: "A session is already running on this device.",
  cmd_failed: "The device hit an error running that command.",
};
const REASON_TEXT: Record<string, string> = { dropped: "connection lost", disconnect: "disconnected from the app", replaced: "replaced by a newer connection", timeout: "no answer from the device; it may be asleep" };
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

const sessionErrorText = (e: Frame) => (ERROR_TEXT[str(e.code)] ?? `Session error (${str(e.code) || "unknown"})${e.message ? `: ${str(e.message)}` : ""}`) + (e.code === "cmd_failed" && e.message ? ` (${str(e.message)})` : "");

// ---- device turn status (docs/vertex-client-devices-v2.md step 1) ----
const RANK: Record<TurnState, number> = { sending: 0, queued: 1, sent: 1, delivered: 2, accepted: 3, starting: 4, working: 5, done: 6, failed: 6 };
const terminal = (t: Turn) => t.state === "done" || t.state === "failed";
export const TURN_MS = { hub: 10_000, device: 15_000, start: 20_000, quiet: 90_000, doneShown: 6_000 } as const;
/** A message was just written to the socket: start tracking it. */
export const beginTurn = (f: Feed, cid: string, frame: Frame, at: number): Feed => ({ ...f, turn: { cid, state: "sending", at, frame } });
/** The hub's cmd_ack reply for the cid (it never goes backwards: cmd_sent/cmd_acked events can arrive before it). */
export const ackTurn = (f: Feed, cid: string, queued: boolean, at: number, cseq?: number): Feed => (f.turn && f.turn.cid === cid && f.turn.state === "sending" ? { ...f, turn: { ...f.turn, state: queued ? "queued" : "sent", at, ...(typeof cseq === "number" && cseq > 0 ? { cseq } : {}) } } : f.turn && f.turn.cid === cid && f.turn.cseq === undefined && typeof cseq === "number" && cseq > 0 ? { ...f, turn: { ...f.turn, cseq } } : f);
/** The hub refused the command outright (err with the cid, e.g. queue_full). */
export const failTurn = (f: Feed, cid: string, text: string, at: number): Feed => (f.turn && f.turn.cid === cid && !terminal(f.turn) ? { ...f, turn: { ...f.turn, state: "failed", at, failText: text } } : f);
/** Stop waiting / dismiss the line. Display only: the command is not recalled (the hub cannot un-send it). */
export const dropTurn = (f: Feed): Feed => ({ ...f, turn: null });

function foldTurn(f: Feed, e: Frame, ts: number): Turn | null {
  const t = f.turn, at = ts;
  const to = (state: TurnState, extra: Partial<Turn> = {}): Turn | null => (t && !terminal(t) ? { ...t, state, at, ...extra } : t);
  /** Command identity. A reconstructed turn (no `frame`) yields only to a newer cmd_sent, so a reload ends on the LATEST command; a locally sent turn is never replaced, and no ack/lifecycle event of another cid replaces anything. */
  const seq = typeof e.cseq === "number" ? e.cseq : undefined;
  const adopt = (_cid: string): boolean => !t || (!t.frame && e.type === "cmd_sent") || (e.type === "cmd_sent" || e.type === "cmd_acked") && seq !== undefined && t.cseq !== undefined && seq > t.cseq; // initial reconstruction; a newer command delivery over a reconstructed turn; or any command the hub numbered AFTER the tracked one (another tab / after reload). A foreign ack of an older or unnumbered command never replaces anything.
  const named = (cid: unknown, state: TurnState): Turn | null => {
    if (typeof cid !== "string") return t;
    if (!t || t.cid !== cid) return adopt(cid) ? { cid, state, at, ...(seq !== undefined ? { cseq: seq } : {}) } : t;
    return RANK[t.state] < RANK[state] ? { ...t, state, at, ...(t.cseq === undefined && seq !== undefined ? { cseq: seq } : {}) } : t.cseq === undefined && seq !== undefined ? { ...t, cseq: seq } : t;
  };
  /** Daemon lifecycle events carry the cid of the command that caused them (vcl >= 0.10.0). Identified: only that command's turn moves. No cid (older daemon, or async output): the latest live turn, as before. */
  const life = (state: TurnState, extra: Partial<Turn> = {}): Turn | null => {
    if (typeof e.cid === "string" && (!t || t.cid !== e.cid)) return adopt(e.cid) ? { cid: e.cid, state, at, ...extra } : t;
    return to(state, extra);
  };
  switch (e.type) {
    case "cmd_sent": return named(e.cid, "delivered");
    case "cmd_acked": { const n = named(e.cid, "accepted"); return n && n.state === "accepted" && f.active ? { ...n, state: "working" } : n; } // a follow-up into a running session emits no session_started: accepted means working
    case "session_starting": return typeof e.cid === "string" && (!t || t.cid !== e.cid) ? life("starting") : t && !terminal(t) && RANK[t.state] < RANK.starting ? to("starting") : t;
    case "session_started": return life("working");
    case "assistant_text": case "tool_use": case "tool_result": return to("working");
    case "turn_done": return to(e.is_error ? "failed" : "done", e.is_error ? { failText: "The turn ended with an error." } : {});
    case "session_error": return life("failed", { failText: sessionErrorText(e) });
    case "session_ended": case "session_stopped": return to("done");
    case "device_offline": return t && !terminal(t) && (t.state === "sent" || t.state === "delivered") ? to("queued") : t; // not accepted yet: the hub replays it on reconnect, so it is queued again
    default: return t;
  }
}

export type TurnLine = { state: TurnState | "unreachable" | "not_started"; text: string; tone: "info" | "warn" | "error" | "ok"; retry: boolean; stop: boolean };
/** The one status line for the latest sent message: pure of (turn, clock, device name), so a timer tick is all the page needs. null = nothing to show. */
export function turnLine(t: Turn | null, nowMs: number, dev?: string): TurnLine | null {
  if (!t) return null;
  const age = nowMs - t.at, n = dev || "The device";
  switch (t.state) {
    case "sending": return age > TURN_MS.hub ? { state: "unreachable", text: "The app could not reach the hub.", tone: "error", retry: true, stop: true } : { state: "sending", text: "Sending…", tone: "info", retry: false, stop: false };
    case "queued": return { state: "queued", text: "Device is offline. Will run when it reconnects.", tone: "warn", retry: false, stop: true };
    case "sent": case "delivered": return age > TURN_MS.device ? { state: "unreachable", text: `${n} is not answering; it may be asleep or offline.`, tone: "error", retry: true, stop: true } : { state: t.state, text: t.state === "sent" ? `Sent to ${n}…` : `Waiting for ${n}…`, tone: "info", retry: false, stop: false };
    case "accepted": case "starting": return age > TURN_MS.start ? { state: "not_started", text: "The device accepted the message but did not start a session.", tone: "error", retry: true, stop: true } : { state: t.state, text: t.state === "accepted" ? `${n} received it` : "Starting session…", tone: "info", retry: false, stop: false };
    case "working": return age > TURN_MS.quiet ? { state: "working", text: "Still working… (no output for 90 s)", tone: "warn", retry: false, stop: false } : { state: "working", text: "Working…", tone: "info", retry: false, stop: false };
    case "done": return age > TURN_MS.doneShown ? null : { state: "done", text: "Done", tone: "ok", retry: false, stop: false };
    case "failed": return { state: "failed", text: t.failText ?? "Failed", tone: "error", retry: !!t.frame, stop: true };
  }
}

/** Fold one hub event (the `e` of an `ev` frame at `seq`) into the feed. Pure: returns a new Feed. Unknown event types are ignored. */
export function foldEvent(f: Feed, seq: number, e: Frame, ts?: number): Feed {
  const id = `e${seq}`;
  const turn = foldTurn(f, e, ts ?? Date.now());
  if (turn !== f.turn) f = { ...f, turn };
  /** A note identical to the previous item folds into it (count + last time) so a flapping connection is one line, not a wall. */
  const note = (text: string, patch: Partial<Feed> = {}): Feed => {
    const last = f.items[f.items.length - 1];
    if (last && last.k === "note" && last.text === text) { const items = f.items.slice(); items[items.length - 1] = { ...last, n: (last.n ?? 1) + 1, ts }; return { ...f, ...patch, items }; }
    return add({ k: "note", id, text, ts }, patch);
  };
  const add = (it: Item, patch: Partial<Feed> = {}): Feed => ({ ...f, ...patch, items: [...f.items, it] });
  switch (e.type) {
    case "device_online": return note("Device came online", { online: true, ...(ts ? { lastOnline: ts } : {}) });
    case "device_offline": return note(`Device went offline (${REASON_TEXT[e.reason] ?? "unknown reason"})`, { online: false, ...(ts ? { lastOnline: ts } : {}) });
    case "session_started": return add({ k: "note", id, text: `Session started in ${str(e.dir)} · sandbox: ${str(e.sandbox)} · bash: ${e.bash ? "on" : "off"}` }, { active: true, sandbox: str(e.sandbox), bash: !!e.bash, dir: str(e.dir) });
    case "assistant_text": return add({ k: "text", id, text: str(e.text) });
    case "tool_use": return add({ k: "tool", id, tid: str(e.id), name: str(e.name), input: str(e.input) });
    case "tool_result": {
      const i = f.items.findIndex((x) => x.k === "tool" && x.tid === str(e.id) && x.output === undefined);
      if (i < 0) return add({ k: "note", id, text: "Tool result without a matching call" });
      const items = f.items.slice(); items[i] = { ...(items[i] as Extract<Item, { k: "tool" }>), output: str(e.content), isError: !!e.is_error };
      return { ...f, items };
    }
    case "turn_done": return add({ k: "note", id, text: e.is_error ? "Turn ended with an error" : "Turn finished" });
    case "session_ended": return add({ k: "note", id, text: "Session ended" }, { active: false });
    case "session_stopped": return add({ k: "note", id, text: "Session stopped" }, { active: false });
    case "session_error": return add({ k: "error", id, text: sessionErrorText(e) }, e.code === "busy" ? {} : { active: false });
    case "approval_request": {
      if (f.approvals.some((a) => a.rid === e.rid)) return f;
      const a: Approval = { rid: str(e.rid), tool: str(e.tool), preview: str(e.preview), expires_at: Number(e.expires_at) || 0, ttl_s: Number(e.ttl_s) || 0, state: "pending" };
      return { ...f, approvals: [...f.approvals, a] };
    }
    case "approval_resolved": {
      const st = e.state as ApprovalState;
      const approvals = f.approvals.map((a) => (a.rid === e.rid ? { ...a, state: st, by: typeof e.by === "string" ? e.by : undefined } : a));
      const a = approvals.find((x) => x.rid === e.rid);
      return a ? { ...f, approvals, items: [...f.items, { k: "note", id, text: `${a.tool} ${st === "allowed" ? "allowed" : st === "denied" ? "denied" : "expired"}` }] } : f;
    }
    default: return f;
  }
}

/** The approval the sheet shows: the oldest still pending one that has not run out on OUR clock (server clock skew-corrected by the caller). */
export const nextPending = (f: Feed, nowS: number): Approval | undefined => f.approvals.find((a) => a.state === "pending" && a.expires_at > nowS) ?? f.approvals.find((a) => a.state === "pending");
export const isExpired = (a: Approval, nowS: number) => a.state === "expired" || (a.state === "pending" && a.expires_at <= nowS);
/** 0..1 of the approval window still left. */
export const timeLeftFrac = (a: Approval, nowS: number) => (a.ttl_s > 0 ? Math.max(0, Math.min(1, (a.expires_at - nowS) / a.ttl_s)) : 0);
export const secondsLeft = (expiresAtS: number, nowMs: number) => Math.max(0, Math.ceil(expiresAtS - nowMs / 1000));
export const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export const pairCommand = (code: string, origin: string) => `vcl pair ${code} --url ${origin}`;
export function fmtLastSeen(tsS: number, nowMs: number): string {
  const d = Math.max(0, Math.floor(nowMs / 1000 - tsS));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}
export const newCid = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

// Last-known sandbox/bash per device. Not secret (labels only). The REST list has no such field, so it is remembered from the last session_started this browser saw.
const KEY = "vcl:last";
export type LastInfo = { sandbox?: string; bash?: boolean };
export function rememberInfo(id: string, i: LastInfo, st: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  try { const m = JSON.parse(st.getItem(KEY) ?? "{}"); m[id] = i; st.setItem(KEY, JSON.stringify(m)); } catch { /* storage unavailable */ }
}
export function recalledInfo(id: string, st: Pick<Storage, "getItem"> = localStorage): LastInfo | null {
  try { return JSON.parse(st.getItem(KEY) ?? "{}")[id] ?? null; } catch { return null; }
}

/** Client-side hint for the optional subfolder under a root (POSIX: only `/` separates; every other character is part of a name, spaces and backslashes included). Rejects absolute, `~` / `~/…`, drive-letter `C:\` / `C:/` and `..` components. The daemon stays the authority. */
export function subfolderProblem(sub: string): string | null {
  if (!sub) return null;
  if (sub.startsWith("/") || /^~(\/|$)/.test(sub) || /^[a-zA-Z]:[\\/]/.test(sub)) return "Use a path relative to the folder, without a leading slash.";
  if (sub.split("/").includes("..")) return "“..” is not allowed.";
  return null;
}
/** dir for the start command: the chosen root, plus the optional subfolder, every character of both kept as is. */
export function joinDir(root: string, sub: string): string {
  if (!sub) return root;
  return root.replace(/\/+$/, "") + "/" + sub;
}
/** Display only (option text, title, aria): control, zero-width and bidi characters shown as a visible mark so a path cannot misrepresent itself. The value sent is never this. */
export function visiblePath(p: string): string {
  return p.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "\u00b7");
}
/** A long path shortened in the middle for the option text (the full path stays in title/aria). */
export function shortPath(p: string, max = 34): string {
  if (p.length <= max) return p;
  const keep = max - 1, head = Math.ceil(keep / 3), tail = keep - head;
  return p.slice(0, head) + "…" + p.slice(p.length - tail);
}

/** 429 on /api/devices/pair: with retry-after it is the 5-codes-per-10-minutes rule, without it the 3-unused-codes rule (a code you already have still works). */
export const pairLimitMessage = (retryAfterS?: number) => retryAfterS ? `Too many codes. Try again in up to ${Math.max(1, Math.ceil(retryAfterS / 60))} min, or use a code you already created.` : "You already have 3 unused codes. Use one of them, or wait for one to expire (10 min).";

// ---- identity / duplicates (docs/vertex-client-devices-v2.md step 2) ----
type Row = { id: string; name: string; last_seen: number; last_online_at?: number | null; online?: boolean | null };
const nameKey = (n: string) => n.trim().toLowerCase();
/** Name as shown, plus the first 4 hex of the id; `dup` = another row looks the same (same name ignoring case/space), so the short id is worth showing. */
export const deviceLabel = (d: Row, rows: Row[]) => ({ name: d.name, short: d.id.slice(0, 4), dup: rows.some((r) => r.id !== d.id && nameKey(r.name) === nameKey(d.name)) });
const lastTs = (d: Row) => d.last_online_at ?? d.last_seen;
/** Online first, then the most recent last-online. A copy: the input is not touched. */
export const sortDevices = <T extends Row>(rows: T[]): T[] => [...rows].sort((a, b) => Number(b.online === true) - Number(a.online === true) || lastTs(b) - lastTs(a));
/** "online now" / "last online 2 h ago" (hub-stamped); a row without last_online_at (older server, never connected since) falls back to the dial-in time under its own wording. */
export const lastOnlineLine = (d: Row, nowMs: number): string => (d.online === true ? "online now" : typeof d.last_online_at === "number" ? `last online ${fmtLastSeen(d.last_online_at, nowMs)}` : `last seen ${fmtLastSeen(d.last_seen, nowMs)}`);
export const STALE_DAYS = 14;
/** Whole days since an offline device was last seen, when that is STALE_DAYS or more; otherwise null (online or unknown status is never "stale"). */
export function staleDays(d: Row, nowMs: number): number | null {
  if (d.online !== false) return null;
  const days = Math.floor((nowMs / 1000 - lastTs(d)) / 86400);
  return days >= STALE_DAYS ? days : null;
}
/** After pairing `freshId`: the OTHER live rows with the same name, which the user may want to replace. Only offered, never revoked automatically. */
export function replaceCandidates<T extends Row>(rows: T[], freshId: string): T[] {
  const f = rows.find((r) => r.id === freshId);
  return f ? rows.filter((r) => r.id !== freshId && nameKey(r.name) === nameKey(f.name)) : [];
}

export const QUIET_HINT_MS = 10 * 60_000;
/** Hint for an "online" device whose daemon never announced hb (vcl <= 0.9.0 sends nothing when idle, so a sleeping computer keeps a half-open socket): minutes since the hub last heard from it, or null = no hint. Display only; absent fields (older hub), hb daemons and fresh ones give null. */
export function quietMinutes(d: { online?: boolean | null; hb?: boolean; last_heard_at?: number } | null | undefined, nowMs: number): number | null {
  if (!d || d.online !== true || d.hb !== false || typeof d.last_heard_at !== "number") return null;
  const age = nowMs - d.last_heard_at;
  return age > QUIET_HINT_MS ? Math.floor(age / 60_000) : null;
}
export const quietText = (min: number) => `Online, but not heard from for ${min} min — it may be asleep`;
