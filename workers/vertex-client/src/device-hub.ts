// DeviceHub: one Durable Object per paired device (idFromName(deviceId)); the Worker (devices.ts) authenticates first and only then reaches it.
// Holds the daemon socket (tag "device") and the PWA sockets (tag "app"), an ordered event log with replay, a command outbox with acks, and the approval ledger.
// Protocol: docs/vertex-client-vcl-protocol.md. Everything here is fail-closed: a frame that does not parse closes nothing but is answered with an error and ignored.
import { DurableObject } from "cloudflare:workers";
import { LLM_LEASE_S, LLM_MAX_CONCURRENT, LLM_RATE_PER_MIN } from "./bridge-llm-core";
import { PUSH_DEBOUNCE_MS, pushApprovalRequest } from "./device-push";
import { pushTo } from "./push";
import { recordNotification } from "./notifications";
import { vclEnabled, vclEnvEnabled, vclTermEnabled } from "./devices";
import { RateWindow, termStateFrame, TERM_AUDIT_TTL_S, TERM_CAP, admitOpen, b64Bytes, idleExpired, isTermFrame, openExpired, parseTermApp, parseTermDevice, termDeadline, type TermSession } from "./device-term";
import { step, initState, deadline, type State, type Input, type InputNoNow, type Effect, type Result, type Who } from "./device-session";
import { sanitiseSelf, CLOSE, EVENT_RETENTION, HB_TIMEOUT_S, OUTBOX_MAX, VCL_VERSION, approvalEvent, nowS, parseAppFrame, parseDeviceFrame, parseFrame, type Json } from "./device-core";

type HubEnv = { DB?: D1Database; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };
type Att = { role: "device" | "app"; user: string; hidden?: boolean; lat?: number; term?: boolean };   // lat: the app session's login time (set by the Worker from the signed cookie); term: this socket opened/attached the device terminal and receives its frames
const SQL_INIT = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, e TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS outbox (cseq INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL UNIQUE, frame TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS seen_cids (id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS approvals (rid TEXT PRIMARY KEY, tool TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT)`,
];
SQL_INIT.push(
  // Model-proxy admissions and rate window (src/bridge-llm.ts), persisted so hibernation / reconstruction keeps them.
  `CREATE TABLE IF NOT EXISTS llm_open (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, reserve_usd REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS llm_hits (ts INTEGER NOT NULL)`,
);
const FLAG_TTL_MS = 10_000; // the `vcl:<base>` kill switch is re-read at most this often per DO instance: flag OFF stops established sockets within ~10 s of the next frame (and within RECHECK_S at the latest via the alarm). A fresh instance always reads.
const NOTIFY_APPROVALS_SCOPE_WIDE = false as boolean; // see pushApproval()
const RECHECK_S = 15; // while a socket is open: expire approvals, re-read the kill switch and re-check revocation in D1 at least this often (one cheap D1 read per RECHECK_S per open hub; no socket => no alarm)

export class DeviceHub extends DurableObject<HubEnv> {
  private sql = this.ctx.storage.sql;
  constructor(ctx: DurableObjectState, env: HubEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const q of SQL_INIT) this.sql.exec(q);
      // devv2s3e: per-chat provenance (additive, DO-local): who an event / queued command / approval belongs to. NULL = unknown or hub-level.
      for (const [t, c] of [["events", "conv"], ["outbox", "src"], ["outbox", "conv"], ["approvals", "conv"]] as const)
        if (!this.sql.exec(`SELECT name FROM pragma_table_info('${t}') WHERE name='${c}'`).toArray().length) this.sql.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`);
      await this.schedule();   // a rebuilt DO re-arms the deadline of whatever state it persisted (an offline reservation has no socket to wake it)
    });
  }

  // ---- storage helpers ----
  private meta(k: string): string | null { const r = this.sql.exec(`SELECT v FROM meta WHERE k=?`, k).toArray()[0] as { v: string } | undefined; return r ? r.v : null; }
  private setMeta(k: string, v: string | number) { this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, String(v)); }
  private num(k: string): number { return Number(this.meta(k) ?? 0) || 0; }
  private lastSeq(): number { const r = this.sql.exec(`SELECT COALESCE(MAX(seq),0) AS s FROM events`).toArray()[0] as { s: number }; return r.s; }
  private minSeq(): number { const r = this.sql.exec(`SELECT COALESCE(MIN(seq),0) AS s FROM events`).toArray()[0] as { s: number }; return r.s; }
  private socks(role: Att["role"]): WebSocket[] { return this.ctx.getWebSockets(role); }
  /** Online = a daemon socket that finished its hello and was not declared gone. A socket the hub itself just closed (heartbeat timeout) can linger in getWebSockets() until its close handshake ends: it must not read "online". */
  private deviceOnline(): boolean { return this.socks("device").length > 0 && this.num("online") === 1; }
  private att(ws: WebSocket): Att | null { return (ws.deserializeAttachment() as Att | null) ?? null; }
  private flagAt = 0; private flagVal = false;
  private envEpoch = 0; // same idea for `vcl_env`: bumped whenever an env-OFF is observed on the chat bridge; a bridge request that started its checks before it must not dispatch
  private offEpoch = 0; // bumped whenever an OFF is observed: a read that STARTED before it can never set the ON cache nor let its frame proceed
  /** Same exact-value read as devices.ts vclEnabled (fail closed on a D1 error). Cached for FLAG_TTL_MS (a cache hit costs no D1 read). */
  private flagFresh(): boolean { return Date.now() - this.flagAt < FLAG_TTL_MS; }
  private async flagOn(): Promise<boolean> {
    if (this.flagFresh()) return this.flagVal;
    const epoch = this.offEpoch;
    const o = JSON.parse(this.meta("owner") ?? "null") as { scope: string } | null;
    const on = o ? await vclEnabled(this.env.DB, o.scope as never) : false;
    if (!on) { this.offEpoch++; this.flagVal = false; this.flagAt = 0; return false; } // only ON is cached: OFF re-reads every time, so flipping back ON takes effect at once
    if (epoch !== this.offEpoch) return false; // an OFF was observed while this read was in flight: this ON is stale, drop its frame (the next read decides afresh)
    this.flagVal = true; this.flagAt = Date.now();
    return true;
  }
  /** Caller pattern, no exceptions: `const epoch = this.offEpoch; const on = await this.flagOn(); if (!this.passed(on, epoch)) return;` and then dispatch/persist/forward SYNCHRONOUSLY in that same continuation
   *  (any further await needs its own epoch check). passed() is sync on purpose: an OFF observed by another in-flight read at ANY earlier microtask boundary, including the one between a resolved read and
   *  its caller's resumption, bumped offEpoch, so this frame is dropped and everything is closed. */
  private passed(on: boolean, epoch: number): boolean {
    if (on && epoch === this.offEpoch) return true;
    this.apply({ t: "flag_off", all: true }); this.closeDisabled(); return false;
  }
  /** Kill switch fired: close every socket (both roles) with 4005; the device stays paired and works again when the flag is back on. */
  private closeDisabled() { this.termEnd("disabled", false); for (const w of this.ctx.getWebSockets()) { try { w.close(CLOSE.DISABLED, "vcl disabled"); } catch { /* */ } } }
  private send(ws: WebSocket, o: unknown) { try { ws.send(JSON.stringify(o)); } catch { /* closed; the close handler cleans up */ } }
  /** Long-pollers of /bridge/events (a ChatSession following one turn): woken by every emit(), by revoke and by their own timeout. */
  private waiters = new Set<() => void>();
  private wake() { for (const w of [...this.waiters]) w(); }

  // ---- session lifecycle (devv2s3r): ALL holder / generation / outbox-ownership / approval-generation decisions live in the pure reducer src/device-session.ts. This shell persists its state, feeds it inputs, and executes its effects. ----
  private cur: { actor?: string } = {};
  private sess(): State {
    const raw = this.meta("sess");
    if (raw) { try { return JSON.parse(raw) as State; } catch { /* rebuilt below */ } }
    // First load on a hub that predates the reducer: adopt what is in the outbox / approvals tables (generation 0 = legacy, owner unknown).
    const s = initState();
    const seqRow = this.sql.exec(`SELECT seq FROM sqlite_sequence WHERE name='outbox'`).toArray()[0] as { seq: number } | undefined;
    const rows = this.sql.exec(`SELECT cseq, cid, frame, src, conv FROM outbox ORDER BY cseq`).toArray() as { cseq: number; cid: string; frame: string; src: string | null; conv: string | null }[];
    const sent = this.num("sent_cseq");
    for (const r of rows) { let kind = "approval"; try { const k = (JSON.parse(r.frame) as { kind?: string }).kind; if (k === "start" || k === "say" || k === "stop" || k === "approval") kind = k; } catch { /* */ } s.entries.push({ cseq: r.cseq, cid: r.cid, gen: 0, conv: r.conv, src: r.src === "chat" ? "chat" : "legacy", kind: kind as never, sent: r.cseq <= sent }); }
    s.nextCseq = Math.max(seqRow?.seq ?? 0, ...rows.map((r) => r.cseq), 0) + 1;
    for (const a of this.sql.exec(`SELECT rid, state, expires_at, conv FROM approvals`).toArray() as { rid: string; state: string; expires_at: number; conv: string | null }[]) s.appr.push({ rid: a.rid, gen: 0, conv: a.conv, state: a.state as never, expiresAt: a.expires_at });
    s.online = this.deviceOnline() && this.num("hello_done") === 1;
    return s;
  }
  /** One input -> new state persisted -> effects executed. The only place hub state changes for the session lifecycle. */
  /** Persist-then-act, atomically (devv2s3t): the new reducer state, every SQL effect (outbox / log / approvals) and the caller's `inTx` bookkeeping (the daemon event frontier `last_dseq`) commit in ONE storage transaction, so a failure
   *  anywhere in it (an oversized value, an effect that throws) leaves NOTHING behind and the daemon's unacknowledged event is simply applied again. Socket writes are NOT part of the transaction: they are deferred until after the commit
   *  (a write is idempotent: the daemon skips a cseq it already processed and re-cacks it), so a rolled-back step never leaks a frame or an event to anyone. */
  private defer: (() => void)[] | null = null;
  private apply(i: InputNoNow, actor?: string, inTx?: () => void): Result {
    const prev = this.cur; this.cur = { ...prev, actor };
    const outer = this.defer, post: (() => void)[] = []; this.defer = post;
    let o: ReturnType<typeof step>;
    try {
      o = step(this.sess(), { ...i, now: Date.now() } as Input);
      (this.ctx.storage as unknown as { transactionSync<T>(f: () => T): T }).transactionSync(() => { this.setMeta("sess", JSON.stringify(o.s)); for (const f of o.fx) this.exec(f); inTx?.(); });
    } finally { this.cur = prev; this.defer = outer; }
    const errs: unknown[] = [];
    for (const run of post) { try { run(); } catch (err) { errs.push(err); } }   // committed: now the sockets. A failing effect (e.g. the cmd_sent log write) must not strand the commands queued behind it: run all, report after
    if (errs.length) { if (o.fx.length) this.wake(); throw errs.length === 1 ? errs[0] : new AggregateError(errs, "post-commit effects failed"); }
    if (o.fx.length) this.wake();
    return o.r;
  }
  private exec(f: Effect) {
    switch (f.k) {
      case "enqueue": {
        this.sql.exec(`INSERT OR IGNORE INTO seen_cids (cid) VALUES (?)`, f.cid);
        this.sql.exec(`DELETE FROM seen_cids WHERE id <= (SELECT MAX(id) FROM seen_cids) - 2000`); // dedupe memory is bounded: the last 2000 command ids
        this.sql.exec(`INSERT OR REPLACE INTO outbox (cseq, cid, frame, src, conv) VALUES (?, ?, ?, ?, ?)`, f.cseq, f.cid, JSON.stringify({ t: "cmd", cseq: f.cseq, cid: f.cid, ...f.frame }), f.src === "chat" ? "chat" : "legacy", f.conv);
        return;
      }
      case "cancel": for (const c of f.cseqs) this.sql.exec(`DELETE FROM outbox WHERE cseq=?`, c); return;
      case "send": {
        const row = this.sql.exec(`SELECT frame FROM outbox WHERE cseq=?`, f.cseq).toArray()[0] as { frame: string } | undefined; if (!row) return;
        const write = () => {
          let wrote = false; for (const w of this.socks("device")) { try { w.send(row.frame); wrote = true; } catch { /* closed */ } }
          if (wrote && f.src !== "hub" && (f.kind === "start" || f.kind === "say" || f.kind === "stop")) this.emit({ type: "cmd_sent", cid: f.cid, cseq: f.cseq }, f.conv); // written to a live socket: the page's "delivered" step (not proof the daemon read it, that is cmd_acked)
        };
        if (this.defer) this.defer.push(write); else write();
        return;
      }
      case "acked": {
        this.sql.exec(`DELETE FROM outbox WHERE cseq=?`, f.cseq);
        if (f.src !== "hub" && (f.kind === "start" || f.kind === "say" || f.kind === "stop")) this.emit({ type: "cmd_acked", cid: f.cid, cseq: f.cseq }, f.conv);
        return;
      }
      case "emit": this.emit(f.e, f.tag); return;
      case "approval_new": { // the payload travels with the effect: an approval folded later (after the start's cack) needs nothing from the arrival's transient context
        this.sql.exec(`INSERT OR IGNORE INTO approvals (rid, tool, state, created_at, expires_at, conv) VALUES (?,?, 'pending', ?, ?, ?)`, f.rid, f.tool, nowS(), f.expiresAt, f.conv);
        this.emit({ type: "approval_request", ...f.ev }, f.conv); return;
      }
      case "approval_state": {
        this.sql.exec(`UPDATE approvals SET state=?, resolved_at=?, resolved_by=? WHERE rid=?`, f.state, nowS(), f.state === "expired" ? null : this.cur.actor ?? null, f.rid);
        this.emit({ type: "approval_resolved", rid: f.rid, state: f.state, by: f.state === "expired" ? "hub" : this.cur.actor ?? "user" }, f.conv); return;
      }
      case "mark_draining": case "release": return;
    }
  }
  /** The environment switch is off (or the master flag): chat sessions are cleaned up through the reducer (stop, cancel, expire), never silently dropped. */
  private cleanup(all: boolean) { this.apply({ t: "flag_off", all }); this.deliver(true); }
  private holderOf() { return this.sess().holder; }
  /** The moment the reducer next needs a tick on its own (holder / approval expiry); null = none. The reducer owns the rule (deadline()); the shell only arms the alarm for it. */
  private holderDeadline(): number | null { return deadline(this.sess()); }

  /** Append to the ordered log and fan out to every PWA socket. The seq is the PWA's resume cursor. `conv` = the chat (or "page") the event belongs to; null = hub-level / unknown. */
  private emit(e: Json, conv: string | null = null): number {
    const ts = Date.now();
    this.sql.exec(`INSERT INTO events (ts, e, conv) VALUES (?, ?, ?)`, ts, JSON.stringify(e), conv);
    const seq = this.lastSeq();
    this.sql.exec(`DELETE FROM events WHERE seq <= ?`, seq - EVENT_RETENTION);
    const fan = () => { for (const w of this.socks("app")) this.send(w, { t: "ev", seq, ts, e }); };
    if (this.defer) this.defer.push(fan); else fan();           // inside a reducer step the fan-out waits for the commit
    this.wake();
    return seq;
  }

  /** A user command (chat bridge or device page) through the reducer. Duplicate cids are answered from the dedupe memory first; the reducer decides admission (busy / not_your_session / queue_full) and numbers the entry. Delivery is NOT done here: callers flush/deliver. */
  private submit(who: Who, cid: string, kind: "start" | "say" | "stop", body: Json): { ok: true; cseq: number; dup: boolean } | { ok: false; error: string } {
    const dupRow = this.sql.exec(`SELECT cseq FROM outbox WHERE cid=?`, cid).toArray()[0] as { cseq: number } | undefined;
    if (dupRow) return { ok: true, cseq: dupRow.cseq, dup: true };
    if (this.sql.exec(`SELECT 1 FROM seen_cids WHERE cid=?`, cid).toArray().length > 0) return { ok: true, cseq: 0, dup: true }; // acked and pruned already: still a duplicate
    const full = (this.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).toArray()[0] as { n: number }).n >= OUTBOX_MAX;
    const r = this.apply({ t: "cmd", who, cid, kind, frame: { kind, ...body }, full });
    return r.ok ? { ok: true, cseq: r.cseq ?? 0, dup: false } : { ok: false, error: r.code };
  }
  private hasChatWork(): boolean { return this.sess().entries.some((e) => e.src === "chat" && e.kind !== "stop"); }
  /** The environment switch, read fresh for a delivery decision: ON only if the read says ON and no OFF was observed anywhere while it was in flight. Fail closed. An OFF cleans chat sessions up through the reducer. */
  private async envOnFresh(): Promise<boolean> {
    const own = JSON.parse(this.meta("owner") ?? "null") as { scope: string } | null;
    const ep = this.envEpoch;
    const on = !!own && (await vclEnvEnabled(this.env.DB, own.scope as never).catch(() => false));
    if (!on) { this.envEpoch++; return false; }
    return ep === this.envEpoch;
  }
  /** Deliver the outbox to the live daemon socket. Async only to re-read the kill switch when chat work is waiting; everything after that read is synchronous (no await between the verdict and the sends). */
  private async flush() {
    if (!this.socks("device").length || this.num("hello_done") !== 1) return;
    const envOn = this.hasChatWork() ? await this.envOnFresh() : true;
    this.deliver(envOn);
  }
  private deliver(envOn: boolean) {
    if (this.num("hello_done") !== 1) return;
    this.apply({ t: "deliver", envOn });
  }

  private async schedule() {
    const next = (this.sql.exec(`SELECT MIN(expires_at) AS e FROM approvals WHERE state='pending'`).toArray()[0] as { e: number | null }).e;
    const open = this.ctx.getWebSockets().length > 0;
    let at = next === null ? null : next * 1000;
    const hd = this.holderDeadline(); if (hd !== null) at = at === null ? hd : Math.min(at, hd);
    const td = termDeadline(this.termSess()); if (td !== null) at = at === null ? td : Math.min(at, td);
    if (open) { const r = Date.now() + RECHECK_S * 1000; at = at === null ? r : Math.min(at, r); }
    if (at !== null) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1)); // nothing pending and no socket: a stale alarm just runs alarm() once, which is a no-op
  }

  /** Admission for one model call (body already read and validated by the Worker). Rate window, concurrency and the daily budget (spent today + open reservations + this one)
   *  are decided here against persisted state; the only await (the spend read) comes BEFORE the synchronous check-and-insert, so concurrent admissions cannot all see the same balance.
   *  A lease only frees the slot of a request that ended or crashed: the Worker aborts its upstream call before the lease runs out. Any error here is a 5xx: the Worker fails closed. */
  private async llmAcquire(u: URL, scope: string, dev: string): Promise<Response> {
    const id = u.searchParams.get("id") ?? "", cap = Number(u.searchParams.get("cap")), reserve = Number(u.searchParams.get("reserve"));
    if (!/^[\w-]{8,64}$/.test(id) || !Number.isFinite(cap) || !Number.isFinite(reserve) || reserve < 0) return new Response("bad request", { status: 400 });
    if (!this.env.DB) return new Response("no db", { status: 503 });
    const spent = (await this.env.DB.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM cloud_costs WHERE executor='vcl' AND scope=? AND run_id LIKE ? AND created_at >= date('now')`).bind(scope, `vcl:${dev}:%`).first<{ s: number }>())?.s ?? 0;
    const now = Date.now();
    this.sql.exec(`DELETE FROM llm_open WHERE lease_until < ?`, now);
    this.sql.exec(`DELETE FROM llm_hits WHERE ts < ?`, now - 60_000);
    if (this.sql.exec(`SELECT 1 FROM llm_open WHERE id=?`, id).toArray().length) return Response.json({ ok: false, reason: "dup", retryAfterS: 1 });
    const hits = this.sql.exec(`SELECT COUNT(*) AS n, MIN(ts) AS first FROM llm_hits`).toArray()[0] as { n: number; first: number | null };
    if (hits.n >= LLM_RATE_PER_MIN) return Response.json({ ok: false, reason: "rate", retryAfterS: Math.max(1, Math.ceil((60_000 - (now - (hits.first ?? now))) / 1000)) });
    const open = this.sql.exec(`SELECT COUNT(*) AS n, COALESCE(SUM(reserve_usd),0) AS r FROM llm_open`).toArray()[0] as { n: number; r: number };
    if (open.n >= LLM_MAX_CONCURRENT) return Response.json({ ok: false, reason: "concurrent", retryAfterS: 2 });
    // Over budget when spent + reservations + this one exceed the cap; a lone request is still admitted while the day is under the cap (so a small cap does not block a large max_tokens outright).
    if (spent >= cap || (open.n > 0 && spent + open.r + reserve > cap)) return Response.json({ ok: false, reason: "budget", cap, retryAfterS: 3600 });
    this.sql.exec(`INSERT INTO llm_hits (ts) VALUES (?)`, now);
    this.sql.exec(`INSERT INTO llm_open (id, started_at, lease_until, reserve_usd) VALUES (?,?,?,?)`, id, now, now + LLM_LEASE_S * 1000, reserve);
    return Response.json({ ok: true, id });
  }

  // ---- entry from the Worker (already authenticated; headers carry the verified owner) ----
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const dev = req.headers.get("x-vcl-device") ?? "", scope = req.headers.get("x-vcl-scope") ?? "", user = req.headers.get("x-vcl-user") ?? "";
    if (!dev || !scope || !user) return new Response("not found", { status: 404 });
    // Owner is pinned on first contact and checked on every later one: a request for this device from any other scope or user is a plain 404.
    const owner = this.meta("owner");
    if (owner === null) { if (this.meta("revoked") === "1") return new Response("gone", { status: 410 }); this.setMeta("owner", JSON.stringify({ dev, scope, user })); }
    else { const o = JSON.parse(owner) as { dev: string; scope: string; user: string }; if (o.dev !== dev || o.scope !== scope || o.user !== user) return new Response("not found", { status: 404 }); }
    if (this.meta("revoked") === "1") return new Response("gone", { status: 410 });

    if (u.pathname === "/revoke" && req.method === "POST") {
      this.termEnd("revoked", false);
      this.setMeta("revoked", "1");
      for (const w of this.ctx.getWebSockets()) { try { w.close(CLOSE.REVOKED, "revoked"); } catch { /* */ } }
      await this.ctx.storage.deleteAll();
      this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      this.setMeta("revoked", "1"); // deleteAll wiped the tombstone together with the log, approvals and outbox; a revoked id never serves again
      this.wake(); // a ChatSession long-polling this hub learns at once (its next read answers 410)
      return Response.json({ ok: true });
    }
    if (u.pathname.startsWith("/bridge/")) return this.bridge(u, req, scope, user);
    if (u.pathname === "/llm/acquire" && req.method === "POST") return this.llmAcquire(u, scope, dev);
    if (u.pathname === "/llm/release" && req.method === "POST") { this.sql.exec(`DELETE FROM llm_open WHERE id=?`, u.searchParams.get("id") ?? ""); return Response.json({ ok: true }); }
    if (u.pathname === "/state" && req.method === "GET") {
      const roots = this.meta("roots");
      const on = this.deviceOnline(); // last_heard_ms / hb: display hints only (DO meta, no migration); null/absent unless a daemon is online
      return Response.json({ online: on, lastHeardMs: on && this.num("dev_last_ms") > 0 ? this.num("dev_last_ms") : null, hb: on ? this.num("dev_hb") === 1 : null, ...(roots !== null ? { roots: JSON.parse(roots) } : {}), ...this.selfInfo(), seq: this.lastSeq(), minSeq: this.minSeq(), lastDseq: this.num("last_dseq"), pendingCmds: (this.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).toArray()[0] as { n: number }).n,
        approvals: this.sql.exec(`SELECT rid, state, expires_at FROM approvals ORDER BY created_at`).toArray() });
    }
    if (u.pathname.startsWith("/ws/") && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const role = u.pathname === "/ws/device" ? "device" : u.pathname === "/ws/app" ? "app" : null;
      if (!role) return new Response("not found", { status: 404 });
      const pair = new WebSocketPair();
      if (role === "device" && this.deviceOnline()) this.stampOnline(); // the old socket's close sees the replacement and skips afterDeviceGone: record the last-online moment here
      if (role === "device") { for (const w of this.socks("device")) { try { w.close(CLOSE.REPLACED, "replaced by a newer connection"); } catch { /* */ } } this.expireAllPending(); this.termEnd("device_lost", false); }
      this.ctx.acceptWebSocket(pair[1], [role]);
      const lat = Number(req.headers.get("x-vcl-lat")); // only the Worker reaches this DO: the value comes from the signed session cookie
      pair[1].serializeAttachment({ role, user, ...(role === "app" && Number.isFinite(lat) && lat > 0 ? { lat } : {}) } satisfies Att);
      if (role === "device") {
        this.setMeta("hello_done", 0);
        this.send(pair[1], { t: "welcome", v: VCL_VERSION, lastDseq: this.num("last_dseq"), caps: (await this.termOnFresh()) ? ["hb", TERM_CAP] : ["hb"] }); // caps: an old daemon ignores it; a new one only sends `hb` to a hub that says it understands it // the daemon resends every event after this dseq
      } else {
        const tUsable = await this.termUsable();
        const since = Number(u.searchParams.get("since") ?? 0) || 0, last = this.lastSeq(), min = this.minSeq();
        const resync = since < last && min > since + 1; // events the PWA has not seen were already pruned: it must reload state, not trust the stream
        this.send(pair[1], { t: "hello", v: VCL_VERSION, seq: last, minSeq: min, online: this.deviceOnline(), resync, now: Date.now(), term: tUsable, ...this.selfInfo() });
        if (!resync) for (const r of this.sql.exec(`SELECT seq, ts, e FROM events WHERE seq > ? ORDER BY seq`, since).toArray() as { seq: number; ts: number; e: string }[]) this.send(pair[1], { t: "ev", seq: r.seq, ts: r.ts, e: JSON.parse(r.e) });
        this.apply({ t: "tick" }); // never show a dead request as live
        if (tUsable) this.termAnnounce(pair[1], user);
      }
      await this.schedule();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  // ---- sockets ----
  /** Daemon frames are handled strictly in arrival order: each one awaits the kill-switch read, and a later frame (a session_started) must never be decided before an earlier one (the cack of the start it answers). */
  private devChain: Promise<unknown> = Promise.resolve();
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const a = this.att(ws);
    if (a?.role === "device") { const run = this.devChain.then(() => this.handleMessage(ws, raw)); this.devChain = run.catch(() => undefined); return run; }
    // Terminal frames are ordered: keystrokes (term_in) must reach the device in the order typed, even when one frame waits for a kill-switch read and the next hits the cache. Other app frames stay concurrent as before.
    // The substring test is conservative (a false positive only chains a frame; a term frame always contains `"term_` once JSON-decoded unless escaped, which only costs ordering, never admission: onTermApp re-validates everything).
    if (typeof raw !== "string" || raw.includes('"term_')) { const run = this.appChain.then(() => this.handleMessage(ws, raw)); this.appChain = run.catch(() => undefined); return run; }
    return this.handleMessage(ws, raw);
  }
  private appChain: Promise<unknown> = Promise.resolve();
  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const a = this.att(ws); if (!a || this.meta("revoked") === "1") return;
    const f = parseFrame(raw);
    if (!f) { this.send(ws, { t: "err", code: "bad_frame" }); return; }
    if (a.role === "device") this.setMeta("dev_last_ms", Date.now()); // liveness: any frame from the daemon counts
    if (!((a.role === "app" && (f.t === "ping" || f.t === "vis")) || (a.role === "device" && f.t === "hb"))) {          // everything else is consequential (approvals, commands, daemon events forwarded to the app)
      const epoch = this.offEpoch, on = await this.flagOn();
      if (!this.passed(on, epoch)) return;                                   // drop the frame (passed() closed the sockets)
      if (this.meta("revoked") === "1") return;                              // a revoke may have landed while the flag read was awaited
    }
    if (a.role === "device") return await this.onDevice(ws, f);
    return this.onApp(ws, a, f);
  }

  private async onDevice(ws: WebSocket, raw: Json) {
    if (isTermFrame(raw.t)) { if (this.num("hello_done") !== 1) { this.send(ws, { t: "err", code: "hello_required" }); return; } return this.onTermDevice(ws, raw); }
    const f = parseDeviceFrame(raw);
    if (!f) { this.send(ws, { t: "err", code: "bad_frame" }); return; }
    if (f.t === "hello") {
      // A chat command queued while the device was away is delivered only if the environment switch is STILL on: read it now, before anything below, so the rest of the hello (and the replay) stays synchronous.
      const envOn = this.hasChatWork() ? await this.envOnFresh() : true;
      const wasOnline = this.num("online") === 1;
      this.setMeta("hello_done", 1);
      this.setMeta("dev_hb", f.info?.caps?.includes("hb") ? 1 : 0); // only a daemon that announced hb is subject to the 75 s silence timeout; an older one is never killed for being quiet
      if (f.info?.roots) this.setMeta("roots", JSON.stringify(f.info.roots)); else this.sql.exec(`DELETE FROM meta WHERE k='roots'`); // an older vcl reports none: unknown, not empty
      const me = f.info?.self ?? {};   // comp2: os/arch/termState; an older vcl sends none: unknown (cleared, never kept from a previous hello)
      for (const [k, v] of [["dev_os", me.os], ["dev_arch", me.arch], ["dev_tstate", me.termState], ["dev_twhy", me.termWhy]] as const) { if (v) this.setMeta(k, v); else this.sql.exec(`DELETE FROM meta WHERE k=?`, k); }
      this.setMeta("dev_term", f.info?.caps?.includes(TERM_CAP) ? 1 : 0); // the device advertises it can host a terminal (its own toggle); the hub still needs the flag to use it
      this.setMeta("online", 1);
      void this.termUsable().then((on) => { for (const w of this.socks("app")) this.send(w, { t: "term_caps", on, ...this.selfInfo() }); }).catch(() => {}); // the UI shows the Terminal tab only while this is true
      this.apply({ t: "hello", lastCseq: f.lastCseq, envOn });            // its cack was lost with the old socket, but hello.lastCseq proves it processed these; then everything it has not processed is replayed (gen-checked)
      void this.schedule();
      this.stampOnline();
      if (!wasOnline) this.emit({ type: "device_online" });
      return;
    }
    if (this.num("hello_done") !== 1) { this.send(ws, { t: "err", code: "hello_required" }); return; }
    if (f.t === "hb") return; // liveness only (stamped in webSocketMessage)
    if (f.t === "cack") { this.apply({ t: "cack", cseq: f.cseq }); void this.flush(); return; }   // a cack can lift the handoff fence: whatever it was holding back leaves now
    // ev: strictly in order, exactly once
    const last = this.num("last_dseq");
    if (f.dseq <= last) { this.send(ws, { t: "ack", dseq: last }); return; }              // duplicate after a reconnect: ack again, apply nothing
    if (f.dseq > last + 1) {                                                              // gap: ask for a resend from the first missing one
      // devv2s3w: with a replay barrier / handoff fence open, a same-connection resync must not cross that boundary (the retransmission would arrive after the barrier's in-order cack): restart the handshake instead
      const ss = this.sess();
      if (ss.barrier || ss.fence) { this.resetDevice(ws, "replay_gap", "event gap during replay barrier"); return; }
      this.send(ws, { t: "resync", expect: last + 1 }); return;
    }
    // PERSIST-THEN-ACK: the frontier moves in the same transaction as the state and effects the event produced; if that transaction fails nothing moved and nothing is acknowledged (the daemon re-sends it).
    const frontier = () => this.setMeta("last_dseq", f.dseq);
    const e = f.e;
    try {
      if (e.type === "approval_request") {
        const ev = approvalEvent(e, nowS());
        if (!ev) { frontier(); this.send(ws, { t: "ack", dseq: f.dseq }); this.send(ws, { t: "err", code: "bad_approval_request" }); return; }
        const exists = this.sql.exec(`SELECT 1 FROM approvals WHERE rid=?`, ev.rid).toArray().length > 0;
        if (!exists) {
          this.apply({ t: "approval_req", rid: ev.rid, e: e as never, ev: ev as unknown as Json, tool: ev.tool, expiresAt: ev.expires_at }, undefined, frontier);
          void this.flush();                                                                // a deny the reducer queued for this request (replayed after a disconnect gap / unattributed) leaves now, not at the next unrelated flush
          if (this.sql.exec(`SELECT 1 FROM approvals WHERE rid=? AND state='pending'`, ev.rid).toArray().length) this.ctx.waitUntil(this.pushApproval(ev));   // only an approval that is actually pending is pushed to the user
          void this.schedule();
        } else frontier();
      } else {
        const { type, ...rest } = e; // device events are opaque to the hub except for their type; hub-only types cannot be forged by the daemon
        if (type.startsWith("device_") || type.startsWith("approval_") || type.startsWith("cmd_")) { frontier(); this.send(ws, { t: "ack", dseq: f.dseq }); this.send(ws, { t: "err", code: "reserved_type" }); return; }
        // Every ownership / lifecycle decision (tag, promotion, release, buffering of an older daemon's pre-cack events) is the reducer's.
        this.apply({ t: "event", e: { type, ...rest } as never }, undefined, frontier);
        void this.schedule();
      }
    } catch (err) { console.error("device event not persisted", err instanceof Error ? err.message : String(err)); this.send(ws, { t: "err", code: "persist_failed" }); this.resetDevice(ws, "replay_failed", "event persistence failed"); return; }   // devv2s3w: never keep accepting this connection's cacks (the barrier's in-order cack would clear it while a replayed event was lost): the next hello re-opens the barrier
    this.send(ws, { t: "ack", dseq: f.dseq });
  }

  /** Someone is watching only while a PWA socket is connected and its tab is visible (the PWA reports `vis`; a socket that never reported counts as visible). */
  private watching(): boolean { return this.socks("app").some((w) => this.att(w)?.hidden !== true); }

  /** Web Push for a fresh approval request when nobody is watching. Fail silent: nothing here can affect the approval flow. */
  private async pushApproval(ev: { rid: string; tool: string; preview: string; expires_at: number }) {
    // devv2s3e: SUPPRESSED for every device approval. Notifications and push subscriptions are keyed by scope, not by user, and the body names the device and the file: any other allowlisted user of the scope would
    // read (and be pushed) the owner's approval metadata. Until owner-targeted delivery exists (a user column on notifications + owner-filtered subscriptions) the approval is shown only where it is actionable:
    // the owner's open device page / chat (live cards over their own authenticated sockets). What changed for the device page: no bell entry and no background push for an approval while the page is closed.
    if (NOTIFY_APPROVALS_SCOPE_WIDE === false) return;
    try {
      const o = JSON.parse(this.meta("owner") ?? "null") as { dev: string; scope: string } | null;
      if (!o || !this.env.DB) return;
      const db = this.env.DB, env = this.env, now = Date.now(), last = this.num("last_push_ms");
      if (!this.watching() && now - last >= PUSH_DEBOUNCE_MS) this.setMeta("last_push_ms", now); // claimed synchronously: a burst of requests cannot all pass the 10 s debounce
      await pushApprovalRequest(
        { scope: o.scope, deviceId: o.dev, rid: ev.rid, tool: ev.tool, preview: ev.preview, expiresAt: ev.expires_at, nowMs: now, watching: this.watching(), lastPushMs: last },
        {
          flagOn: () => vclEnabled(db, o.scope as never),
          deviceName: async () => (await db.prepare(`SELECT name FROM devices WHERE id=?`).bind(o.dev).first<{ name: string }>())?.name ?? "",
          pending: () => (this.sql.exec(`SELECT state FROM approvals WHERE rid=?`, ev.rid).toArray()[0] as { state: string } | undefined)?.state === "pending",
          unwatched: () => !this.watching(),
          // Stored for the history page; a visible PWA socket also gets it live as a toast (the bell's unread count follows from the frame).
          record: async (p) => {
            const row = await recordNotification(db, o.scope as never, { kind: "device", title: p.title, body: p.body, url: p.url });
            if (row) for (const w of this.socks("app")) if (this.att(w)?.hidden !== true) this.send(w, { t: "notif", n: row });
          },
          push: (p) => pushTo({ ...env, DB: db }, o.scope as never, p),
        },
      );
    } catch (e) { console.error("device push", e instanceof Error ? e.message : String(e)); }
  }

  private onApp(ws: WebSocket, a: Att, raw: Json) {
    if (raw.t === "ping") { this.send(ws, { t: "pong" }); return; }
    if (raw.t === "vis" && typeof raw.hidden === "boolean") { ws.serializeAttachment({ ...a, hidden: raw.hidden } satisfies Att); return; }
    if (isTermFrame(raw.t)) return this.onTermApp(ws, a, raw);
    const f = parseAppFrame(raw);
    if (!f) { this.send(ws, { t: "err", code: "bad_frame" }); return; }
    if (f.t === "disconnect") {
      for (const w of this.socks("device")) { try { w.close(CLOSE.DISCONNECT, "disconnected from the app"); } catch { /* */ } }
      this.afterDeviceGone("disconnect");
      this.send(ws, { t: "ok", of: "disconnect" });
      return;
    }
    if (f.t === "cmd") {
      // The device page and the chats share one daemon session slot (the reducer's single holder): while a CHAT holds it every page command is refused `busy`; a page start over an ACTIVE holder is refused without touching it.
      const r = this.submit({ k: "page" }, f.cid, f.kind, f.body);
      if (!r.ok) { this.send(ws, { t: "err", code: r.error, cid: f.cid }); void this.flush(); void this.schedule(); return; }   // a refusal can still have started cleanup (a replaced sent reservation drains: its stop leaves now)
      this.send(ws, { t: "cmd_ack", cid: f.cid, cseq: r.cseq, dup: r.dup, queued: !this.deviceOnline() });
      void this.flush(); void this.schedule();
      return;
    }
    // approval_res: bound to request id, this device (this DO) and the user who owns it. First valid response wins; nothing else is ever forwarded.
    const r = this.resolveApproval(f.rid, f.allow, a.user, "page");
    if (!r.ok) { this.send(ws, { t: "err", code: r.code, rid: f.rid, ...(r.state ? { state: r.state } : {}) }); return; }
    void this.flush();
    this.send(ws, { t: "ok", of: "approval_res", rid: f.rid, state: r.state, queued: r.queued });
  }

  /** The one approval decision path (page socket and chat bridge): known rid, owner only; the reducer checks origin, expiry AND that the approval's generation is still the live one. A stale one is closed (denied on the daemon too), never answerable. */
  private resolveApproval(rid: string, allow: boolean, who: string, via: string): { ok: true; state: string; queued: boolean } | { ok: false; code: string; state?: string } {
    const owner = JSON.parse(this.meta("owner") ?? "{}") as { user?: string };
    if (!this.sql.exec(`SELECT 1 FROM approvals WHERE rid=?`, rid).toArray().length) return { ok: false, code: "unknown_request" };
    if (!owner.user || owner.user !== who) return { ok: false, code: "forbidden" };
    const r = this.apply({ t: "answer", who: via === "page" ? { k: "page" } : { k: "chat", conv: via }, rid, allow }, who);
    if (!r.ok) return { ok: false, code: r.code === "stale_generation" ? "expired" : r.code, ...(r.state ? { state: r.state } : {}) };
    void this.schedule();
    return { ok: true, state: r.state ?? (allow ? "allowed" : "denied"), queued: !this.deviceOnline() };
  }

  /** Chat bridge (Devices v2 step 3). Only ChatSession reaches this (DO binding, same verified x-vcl-* headers as every other path, owner pinned above): the page never talks to it and no device token is involved.
   *  POST /bridge/cmd {conv,cid,kind,prompt|text,dir}   queue a start/say/stop for a chat turn; answers the event cursor to follow from
   *  GET  /bridge/events?since=&wait=                    hub events after the cursor (long poll, woken by emit/revoke)
   *  POST /bridge/approval {rid,allow}                   the user's answer, through the same resolveApproval as the page socket */
  private async bridge(u: URL, req: Request, _scope: string, user: string): Promise<Response> {
    if (u.pathname === "/bridge/events" && req.method === "GET") {
      const since = Number(u.searchParams.get("since") ?? 0) || 0, wait = Math.min(Math.max(Number(u.searchParams.get("wait") ?? 0) || 0, 0), 25_000);
      const conv = u.searchParams.get("conv") ?? "";
      if (!/^[\w-]{8,64}$/.test(conv)) return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
      // A chat reads ONLY its own events (tagged with it when they were emitted) plus the two payload-free hub-level ones (device online / offline). Never another chat's text, tool calls or approval cards, never the device page's.
      const read = () => (this.sql.exec(`SELECT seq, ts, e FROM events WHERE seq > ? AND (conv = ? OR (conv IS NULL AND json_extract(e,'$.type') IN ('device_online','device_offline'))) ORDER BY seq LIMIT 200`, since, conv).toArray() as { seq: number; ts: number; e: string }[]).map((r) => ({ seq: r.seq, ts: r.ts, e: JSON.parse(r.e) as Json }));
      let events = read();
      if (!events.length && wait > 0) {
        await new Promise<void>((res) => {
          const done = () => { clearTimeout(t); this.waiters.delete(done); req.signal?.removeEventListener("abort", done); res(); };
          const t = setTimeout(done, wait); this.waiters.add(done); req.signal?.addEventListener("abort", done);
        });
        if (this.meta("revoked") === "1") return new Response("gone", { status: 410 });
        events = read();
      }
      const min = this.minSeq(), last = this.lastSeq(), h = this.holderOf();
      // `mine`: this chat still holds the device. A chat that lost it (another start took over after expiry, or it ended) and has nothing left to read must stop following.
      return Response.json({ events, last, online: this.deviceOnline(), gap: since < last && min > since + 1, mine: h?.conv === conv && h.phase !== "draining" }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method !== "POST") return new Response("not found", { status: 404 });
    const b = (await req.json().catch(() => null)) as Json | null;
    if (!b) return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    this.flagAt = 0; // a chat command is a human action (rare): always a fresh read of the kill switch, never the 10 s cache
    // The environment switch (`vcl_env`) gates every bridge POST (cmd, approval, stop): turning it off must also stop outstanding approvals and nothing enters the outbox. Fresh read, fail closed (a D1 error reads as off).
    // It is read BEFORE the epoch-guarded `vcl` read so that nothing awaits between passed() and the synchronous dispatch below.
    const own = JSON.parse(this.meta("owner") ?? "null") as { scope: string } | null;
    const envEpoch = this.envEpoch; // captured BEFORE any async check: an env-OFF observed by ANY request after this point (even while this one awaits the vcl read below) refuses this one
    // A STOP of the user's own session and the release of a deleted chat are cleanup, not new work: they stay available when the environment switch is off (the reducer decides what they may touch).
    const cleanupOnly = (u.pathname === "/bridge/cmd" && b.kind === "stop") || u.pathname === "/bridge/release";
    const envOk = !!own && (await vclEnvEnabled(this.env.DB, own.scope as never));
    if (!envOk) { this.envEpoch++; this.cleanup(false); if (!cleanupOnly) return Response.json({ ok: false, error: "disabled" }, { status: 404 }); }
    const epoch = this.offEpoch, on = await this.flagOn();
    if (!this.passed(on, epoch) || (envOk && envEpoch !== this.envEpoch)) return Response.json({ ok: false, error: "disabled" }, { status: 404 }); // compared synchronously, right before dispatch
    if (this.meta("revoked") === "1") return new Response("gone", { status: 410 });
    if (u.pathname === "/bridge/release") {
      const rc = typeof b.conv === "string" && /^[\w-]{8,64}$/.test(b.conv) ? b.conv : null;
      if (!rc) return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
      this.apply({ t: "chat_deleted", conv: rc }); this.deliver(true); await this.schedule();
      return Response.json({ ok: true });
    }
    if (u.pathname === "/bridge/approval") {
      const aconv = typeof b.conv === "string" && /^[\w-]{8,64}$/.test(b.conv) ? b.conv : null;
      if (typeof b.rid !== "string" || typeof b.allow !== "boolean" || !aconv) return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
      const r = this.resolveApproval(b.rid, b.allow, user, aconv);
      if (r.ok) this.deliver(envOk);
      return Response.json(r.ok ? { ok: true, state: r.state, queued: r.queued } : { ok: false, error: r.code, ...(r.state ? { state: r.state } : {}) }, { status: r.ok ? 200 : r.code === "forbidden" ? 403 : 409 });
    }
    if (u.pathname === "/bridge/cmd") {
      const conv = typeof b.conv === "string" && /^[\w-]{8,64}$/.test(b.conv) ? b.conv : null;
      const f = parseAppFrame({ t: "cmd", cid: b.cid, kind: b.kind, prompt: b.prompt, text: b.text, dir: b.dir });
      if (!conv || !f || f.t !== "cmd") return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
      // Reservation rules (devv2s3e). The device is held by ONE party. A `start` while someone else (another chat, or the device page) holds it is refused 409 busy BEFORE anything is queued, so a loser never opens a follower
      // or queues a command. The same chat starting again replaces its own stale reservation (its unsent/unacked start is cancelled). `say` and `stop` only from the holder: a chat can never talk into or stop another's session.
      const since = this.lastSeq();
      // Admission (single holder, `busy` before anything is queued, say/stop only from the holder) is the reducer's.
      const r = this.submit({ k: "chat", conv }, f.cid, f.kind, f.body);
      if (!r.ok) { this.deliver(envOk); await this.schedule(); return Response.json({ ok: false, error: r.error }, { status: r.error === "busy" || r.error === "not_your_session" ? 409 : 429 }); } // a refusal can still have started cleanup: its stop leaves now
      this.deliver(envOk);                                                      // the switch was read just above, nothing awaited since
      await this.schedule();                                                    // the reservation's expiry deadline is armed even while the device is offline
      return Response.json({ ok: true, cseq: r.cseq, dup: r.dup, queued: !this.deviceOnline(), since });
    }
    return new Response("not found", { status: 404 });
  }

  /** The daemon denies every pending approval when its socket goes away (daemon.mjs "disconnected"), so none may stay actionable here: the reducer expires them all. */
  private expireAllPending() { this.apply({ t: "offline" }); }
  /** Reset a daemon connection: close the socket and run the offline path now (pending approvals expire, hello_done=0), so the next hello re-opens the replay barrier. */
  private resetDevice(ws: WebSocket, reason: string, why: string) {
    try { this.afterDeviceGone(reason); } finally { try { ws.close(CLOSE.TIMEOUT, why); } catch { /* already closing */ } }
  }
  private afterDeviceGone(reason: string) {
    if (this.num("online") !== 1) return;
    this.termEnd("device_lost", false);   // the device kills its shell when the link is gone; the app is told and the slot is freed
    this.expireAllPending();
    this.setMeta("online", 0); this.setMeta("hello_done", 0);
    this.stampOnline();
    this.emit({ type: "device_offline", reason });
  }

  /** devices.last_online_at = now (unix s): the honest "last online" for the list, written at hello and when the socket goes away. Display data only: a failed write (older D1 without the column, D1 hiccup) is logged and never affects the socket. A revoked row is not touched. */
  private stampOnline() {
    const o = JSON.parse(this.meta("owner") ?? "null") as { dev: string } | null;
    if (!o || !this.env.DB) return;
    this.ctx.waitUntil(this.env.DB.prepare(`UPDATE devices SET last_online_at=MAX(COALESCE(last_online_at,0), ?) WHERE id=? AND revoked_at IS NULL`).bind(nowS(), o.dev).run().then(() => undefined, (e) => console.error("hub last_online_at", e instanceof Error ? e.message : String(e))));
  }

  // ---- device terminal (vclterm3). LIVE RELAY ONLY: frames are forwarded between the one owning app socket(s) and the device socket; the payload is never logged, never written to D1 or to the event log. Contract: docs/vcl-term-hub-api.md ----
  private termAt = 0; private termVal = false;
  private rateIn = new RateWindow(); private rateOut = new RateWindow(); private gapSent = false;
  /** `vcl_term:<base>` read: ON is cached FLAG_TTL_MS (keystrokes must not each cost a D1 read), OFF is re-read every time; fail closed. A fresh read is used for term_open, welcome and the alarm. */
  private async termOnFresh(): Promise<boolean> {
    const o = JSON.parse(this.meta("owner") ?? "null") as { scope: string } | null;
    const on = o ? await vclTermEnabled(this.env.DB, o.scope as never).catch(() => false) : false;
    this.termVal = on; this.termAt = on ? Date.now() : 0; return on;
  }
  /** comp2: the device's self-description as stored from its last hello (whitelisted at parse time; re-validated here since meta is the trust boundary of the feed). Absent keys = unknown (old runtime). */
  private selfInfo(): { os?: string; arch?: string; termState?: string; termWhy?: string } {
    const m = sanitiseSelf({ os: this.meta("dev_os"), arch: this.meta("dev_arch"), termState: this.meta("dev_tstate"), termWhy: this.meta("dev_twhy") });
    return m;
  }
  /** The app may show the Terminal tab: flag on AND the device advertised cap `term` in its last hello AND it is online. Fail closed. */
  private async termUsable(): Promise<boolean> { return this.deviceOnline() && this.num("hello_done") === 1 && this.num("dev_term") === 1 && (await this.termOnFresh().catch(() => false)); }
  private async termOnCached(): Promise<boolean> { return Date.now() - this.termAt < FLAG_TTL_MS && this.termVal ? true : this.termOnFresh(); }
  private termSess(): TermSession | null { const r = this.meta("term"); if (!r) return null; try { return JSON.parse(r) as TermSession; } catch { return null; } }
  private setTerm(s: TermSession | null) { if (s) this.setMeta("term", JSON.stringify(s)); else this.sql.exec(`DELETE FROM meta WHERE k='term'`); }
  /** Tell one app socket about the running session (term_state) so its UI re-attaches. Owner only; the session must already have a sid. Returns whether a frame was sent. */
  private termAnnounce(ws: WebSocket, user: string, owner?: string): boolean {
    const o = owner ?? (JSON.parse(this.meta("owner") ?? "{}") as { user?: string }).user;
    const f = termStateFrame(this.termSess(), user, o); if (!f) return false;
    this.send(ws, f); return true;
  }
  private termSocks(): WebSocket[] { return this.socks("app").filter((w) => this.att(w)?.term === true); }
  private clearTermFlags() { for (const w of this.termSocks()) { const c = this.att(w); if (c) w.serializeAttachment({ ...c, term: false } satisfies Att); } }
  private toTerm(o: unknown) { for (const w of this.termSocks()) this.send(w, o); }
  private toDevice(o: unknown) { const m = JSON.stringify(o); let n = 0; for (const w of this.socks("device")) { try { w.send(m); n++; } catch { /* closed */ } } return n; }
  /** Audit row (open / close, device, root, mode, duration, reason). Never content. Best effort and off the relay path: the migration 0043 may not be applied yet, then this only logs the error (without any terminal data). */
  private termAudit(event: "open" | "close", s: TermSession, extra: { reason?: string } = {}) {
    const o = JSON.parse(this.meta("owner") ?? "null") as { dev: string; scope: string } | null; if (!o || !this.env.DB) return;
    const now = nowS(), dur = event === "close" ? Math.max(0, Math.round(Date.now() / 1000 - s.openedAt / 1000)) : null;
    this.ctx.waitUntil(this.env.DB.prepare(`INSERT INTO term_audit (scope, user, device_id, sid, event, root, mode, duration_s, reason, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(o.scope, s.user, o.dev, s.sid, event, s.root.slice(0, 300), s.mode, dur, extra.reason ?? null, now, now + TERM_AUDIT_TTL_S).run().then(() => undefined, (e) => console.error("term audit", e instanceof Error ? e.message : String(e))));
  }
  /** End the session from the hub side (or because the device is gone): the app is told, the slot is freed, the device is told to kill its shell unless it is the one that is gone. */
  private termEnd(reason: string, notifyDevice: boolean) {
    const s = this.termSess(); if (!s) return;
    this.setTerm(null);
    if (notifyDevice && s.sid) this.toDevice({ t: "term_close", sid: s.sid });
    if (s.sid) { this.toTerm({ t: "term_exit", sid: s.sid, code: null, signal: reason }); this.termAudit("close", s, { reason }); }
    else this.toTerm({ t: "term_error", cid: s.cid, error: reason });
    this.clearTermFlags();
  }
  /** Alarm: idle (no term_in for 30 min) and an open the device never answered. */
  private termTick() {
    const s = this.termSess(); if (!s) return;
    if (openExpired(s, Date.now())) { this.termEnd("open_timeout", false); return; }
    if (s.sid && idleExpired(s, Date.now())) this.termEnd("idle", true);
  }
  private async onTermApp(ws: WebSocket, a: Att, raw: Json) {
    const f = parseTermApp(raw);
    if (!f) { this.send(ws, { t: "err", code: "bad_frame" }); return; }
    const owner = JSON.parse(this.meta("owner") ?? "{}") as { user?: string };
    if (f.t === "term_open") {
      if (!(await this.termOnFresh())) return;                                   // flag off: ignored, as if the feature did not exist
      if (this.meta("revoked") === "1") return;
      const v = admitOpen({ user: a.user, owner: owner.user, lat: a.lat, nowS: nowS(), online: this.deviceOnline() && this.num("hello_done") === 1, hasCap: this.num("dev_term") === 1, session: this.termSess() });
      if (!v.ok) {
        if (v.error === "limit" && this.termAnnounce(ws, a.user, owner.user)) return;  // a session of this owner is already running (an orphan of a dead page): attach to it instead of an error
        this.send(ws, { t: "term_error", cid: f.cid, error: v.error }); return;
      }
      const now = Date.now();
      this.setTerm({ cid: f.cid, sid: null, user: a.user, root: f.root, mode: null, openedAt: now, lastIn: now, cols: f.cols, rows: f.rows });
      ws.serializeAttachment({ ...a, term: true } satisfies Att);
      this.rateIn = new RateWindow(); this.rateOut = new RateWindow(); this.gapSent = false;
      this.toDevice({ t: "term_open", cid: f.cid, root: f.root, cols: f.cols, rows: f.rows });
      await this.schedule();
      return;
    }
    // every other frame belongs to the live session of this device's owner; anything else is ignored (never an error that reveals state to a non-owner)
    const s = this.termSess();
    if (!owner.user || owner.user !== a.user) return;                             // non-owner: silent
    if (!s || s.sid === null || s.sid !== f.sid) {
      // vclterm11: a term_attach for a session that no longer exists (it exited between term_state and the attach): end the new pane explicitly; flag off stays silent
      if (f.t === "term_attach" && (await this.termOnCached())) this.send(ws, { t: "term_exit", sid: f.sid, code: null, signal: "gone" });
      return;
    }
    if (!(await this.termOnCached())) { this.termEnd("disabled", true); return; }
    if (f.t === "term_in") {
      if (!this.rateIn.take(b64Bytes(f.data), Date.now())) { this.send(ws, { t: "term_error", sid: s.sid, error: "rate_limit" }); return; }
      this.setTerm({ ...s, lastIn: Date.now() });
      this.toDevice(f); return;
    }
    if (f.t === "term_attach") ws.serializeAttachment({ ...a, term: true } satisfies Att);
    if (f.t === "term_resize") this.setTerm({ ...s, cols: f.cols, rows: f.rows });
    if (f.t === "term_close") { this.toDevice(f); return; }                      // the session ends when the device answers term_exit
    this.toDevice(f);
  }
  private onTermDevice(_ws: WebSocket, raw: Json) {
    const f = parseTermDevice(raw);
    if (!f) return;                                                              // malformed device term frame: dropped (never stored, never forwarded)
    const s = this.termSess();
    if (f.t === "term_ready") {
      if (!s || s.sid !== null || s.cid !== f.cid) { this.toDevice({ t: "term_close", sid: f.sid }); return; }   // an open the hub already gave up on (timeout / flag off): the device must not keep that shell
      const n = { ...s, sid: f.sid, mode: f.mode ?? null, lastIn: Date.now() }; this.setTerm(n);
      this.termAudit("open", n);
      this.toTerm({ t: "term_ready", cid: f.cid, sid: f.sid, ...(f.mode ? { mode: f.mode } : {}) });
      void this.schedule(); return;
    }
    if (f.t === "term_error") {
      if (s && s.sid === null && f.cid === s.cid) { this.setTerm(null); this.toTerm({ t: "term_error", cid: f.cid, error: f.error }); return; }
      if (s && s.sid !== null && f.sid === s.sid) this.toTerm({ t: "term_error", sid: f.sid, error: f.error });
      return;
    }
    if (!s || s.sid === null || s.sid !== f.sid) return;                         // stale or foreign session id: ignored
    if (f.t === "term_audit") { this.setTerm({ ...s, mode: f.mode }); return; }
    if (f.t === "term_exit") {
      this.setTerm(null); this.termAudit("close", s, { reason: f.reason ?? "exit" });
      this.toTerm({ t: "term_exit", sid: f.sid, code: f.code, signal: f.signal, ...(f.reason ? { reason: f.reason } : {}) });
      this.clearTermFlags();
      return;
    }
    if (f.t === "term_gap") { this.toTerm(f); return; }
    // term_out: bounded by the per-device budget; over it the frame is dropped and the app is told once per burst that output was skipped (it redraws), nothing is buffered
    if (!this.rateOut.take(b64Bytes(f.data), Date.now())) { if (!this.gapSent) { this.gapSent = true; this.toTerm({ t: "term_gap", sid: f.sid, from: f.seq, reason: "rate_limit" }); } return; }
    this.gapSent = false;
    this.toTerm(f);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const a = this.att(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed"); } catch { /* already closing */ }
    if (a?.role === "device" && this.socks("device").filter((w) => w !== ws).length === 0) this.afterDeviceGone(code === CLOSE.REPLACED ? "replaced" : "dropped");
    await this.schedule();
  }
  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws, 1006); }

  /** Close a daemon socket that announced `hb` and has been silent for HB_TIMEOUT_S: a sleeping/locked machine leaves a half-open socket that would otherwise read "online" for hours. Runs from the alarm (every RECHECK_S while a socket is open). */
  private reapSilentDevice(): boolean {
    const dev = this.socks("device");
    if (dev.length === 0 || this.num("dev_hb") !== 1 || this.num("hello_done") !== 1) return false;
    const last = this.num("dev_last_ms");
    if (last === 0 || Date.now() - last <= HB_TIMEOUT_S * 1000) return false;
    for (const w of dev) { try { w.close(CLOSE.TIMEOUT, "no heartbeat"); } catch { /* */ } }
    this.afterDeviceGone("timeout");
    return true;
  }

  async alarm() {
    if (this.meta("revoked") === "1") return;
    this.reapSilentDevice();
    this.termTick();
    this.apply({ t: "tick" });                  // approval expiry + holder expiry (reserved / idle -> draining -> free)
    // The environment switch is re-read for any CHAT holder too (not only queued chat work): turning vcl_env off must stop an active chat session without another POST. A page-only session is never touched by it.
    const h = this.holderOf();
    const needsEnv = this.hasChatWork() || (!!h && h.conv !== "page");
    this.deliver(needsEnv ? await this.envOnFresh() : true);   // a stop queued by the tick (or by env-off cleanup) leaves at once
    // Belt and braces for a revoke whose /revoke call never reached this DO: D1 is the authority.
    const own = JSON.parse(this.meta("owner") ?? "null") as { dev: string } | null;
    if (own && this.ctx.getWebSockets().length > 0 && this.env.DB) {
      this.flagAt = 0; // the alarm always re-reads
      const epoch = this.offEpoch, on = await this.flagOn();
      if (!this.passed(on, epoch)) return;
      if (this.termSess() && !(await this.termOnFresh())) this.termEnd("disabled", true);
      try {
        const d = await this.env.DB.prepare(`SELECT revoked_at FROM devices WHERE id=?`).bind(own.dev).first<{ revoked_at: number | null }>();
        if (!d || d.revoked_at !== null) { this.setMeta("revoked", "1"); for (const w of this.ctx.getWebSockets()) { try { w.close(CLOSE.REVOKED, "revoked"); } catch { /* */ } } return; }
      } catch { /* D1 hiccup: keep serving, the next alarm re-checks */ }
    }
    await this.schedule();
  }
}
