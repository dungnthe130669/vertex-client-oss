// Remote mode (read-only): the app shows build-host's work sessions (lane2-work / runner-work) mirrored by the `remote-hub` Worker.
// The binding REMOTE carries no caller identity, so these routes sit behind the normal /api/* session check. Nothing here writes or
// steers: there is no command path (phase 2 in docs/remote-mode.md is not built), and the e2e user never sees real sessions.
import type { Context, Hono } from "hono";
import { guardPrefix, isE2eBase, type Scope } from "./scope";
import type { Env } from "./index";

export type RemoteRow = { id: string; host: string; kind: string; name: string; status: string; started_at: number | null; ended_at: number | null; cwd: string; brief: string; exit_code: number | null; session_ref: string | null; updated_at: number; stale: boolean };
export type RemoteDetail = RemoteRow & { tail: string; report: string };
/** Shape of the RemoteHubRpc entrypoint (see workers/remote-hub/src/index.ts). */
export interface RemoteHub {
  list(opts?: { status?: string; limit?: number }): Promise<RemoteRow[]>;
  get(id: string): Promise<(RemoteDetail & { commands?: RemoteCommand[] }) | null>;
  // Steering. `actor` is the SSO sub this Worker verified from the user's cookie (a binding carries no identity).
  commandCreate(actor: string, sessionId: string, text: string): Promise<Res<{ command: RemoteCommand; nonce: string; nonce_ttl_s: number }>>;
  commandNonce(actor: string, id: string): Promise<Res<{ nonce: string; nonce_ttl_s: number }>>;
  commandApprove(actor: string, id: string, nonce: string): Promise<Res<RemoteCommand>>;
  commandReject(actor: string, id: string): Promise<Res<RemoteCommand>>;
  commandGet(id: string): Promise<RemoteCommand | null>;
}
type Res<T> = { ok: true; data: T } | { ok: false; status: number; error: string };
export type RemoteCommand = { id: string; session_id: string; host: string; name: string; text: string; text_sha256: string; requested_by: string; created_at: number; state: string;
  approved_by: string | null; approved_at: number | null; rejected_by: string | null; rejected_at: number | null; claimed_at?: number | null; finished_at: number | null;
  result_state?: string | null; result_summary?: string | null; exit_code?: number | null; nonce_expires_at?: number | null };

const STATUSES = ["running", "done", "failed", "unknown"];
const ID = /^[a-z0-9][a-z0-9.-]{0,63}:(lane2|runner):[\w.@-]{1,80}$/i;

/** Synthetic sessions served to the e2e user (fixed, obviously fake). Real sessions carry private briefs and transcripts. */
const T0 = 1_700_000_000;
const FIXTURES: RemoteDetail[] = [
  { id: "e2e-host:lane2:e2e-running", host: "e2e-host", kind: "lane2", name: "e2e-running", status: "running", started_at: T0, ended_at: null, cwd: "/srv/e2e/demo", brief: "E2E fixture: a session that is still running.", exit_code: null, session_ref: "00000000-0000-4000-8000-000000000001", updated_at: Math.floor(Date.now() / 1000), stale: false,
    tail: "assistant: Looking at the repo.\ntool Bash: ls -la\nresult: total 0\nassistant: Fixture line FIXTURE-TAIL-OK", report: "" },
  { id: "e2e-host:lane2:e2e-done", host: "e2e-host", kind: "lane2", name: "e2e-done", status: "done", started_at: T0 - 600, ended_at: T0 - 300, cwd: "/srv/e2e/demo", brief: "E2E fixture: a finished session.", exit_code: 0, session_ref: "00000000-0000-4000-8000-000000000002", updated_at: T0 - 300, stale: false,
    tail: "assistant: All done.", report: "## Report\n\nFixture **report** with a list:\n\n- one\n- two\n\n<script>alert(1)</script>" },
  { id: "e2e-host:runner:e2e-failed", host: "e2e-host", kind: "runner", name: "e2e-failed", status: "failed", started_at: T0 - 1200, ended_at: T0 - 900, cwd: "", brief: "E2E fixture: a failed session.", exit_code: 1, session_ref: null, updated_at: T0 - 900, stale: false, tail: "", report: "It failed." },
  { id: "e2e-host:lane2:e2e-stale", host: "e2e-host", kind: "lane2", name: "e2e-stale", status: "running", started_at: T0 - 7200, ended_at: null, cwd: "", brief: "E2E fixture: publisher went quiet.", exit_code: null, session_ref: null, updated_at: T0 - 7000, stale: true, tail: "", report: "" },
];
const rowOf = ({ tail: _t, report: _r, ...row }: RemoteDetail): RemoteRow => row;
const fixtureList = (status?: string) => FIXTURES.filter((f) => !status || f.status === status).map(rowOf);

// ---- e2e simulation of steering (D1 e2e_commands). Same contract as remote-hub, but nothing ever leaves this Worker. ----
// After approve the state walks approved (<3 s) -> running (<6 s) -> done; text containing REFUSEME ends `refused`, FAILME ends `failed`.
const NONCE_TTL = 120, MAX_TEXT = 4096;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (t: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
const nowS = () => Math.floor(Date.now() / 1000);
const OUT = "id, session_id, host, name, text, text_sha256, requested_by, created_at, state, approved_by, approved_at, rejected_by, rejected_at, finished_at, nonce_expires_at";
function e2eView(r: Record<string, any>): RemoteCommand {
  let state = r.state as string, result: Partial<RemoteCommand> = {};
  if (state === "approved") {
    const age = nowS() - Number(r.approved_at);
    if (age >= 6) { const f = /REFUSEME/.test(r.text) ? "refused" : /FAILME/.test(r.text) ? "failed" : "done"; state = f === "refused" ? "running" : f; result = { result_state: f, result_summary: f === "done" ? "ok (e2e simulation)" : f === "failed" ? "failed: simulated failure" : "not on the allowlist (e2e simulation)", exit_code: f === "done" ? 0 : f === "failed" ? 1 : null, finished_at: nowS() }; if (f === "refused") state = "refused"; }
    else if (age >= 3) state = "running";
  }
  const { nonce_expires_at: _n, ...rest } = r;
  return { ...rest, state, ...result, nonce_expires_at: null } as RemoteCommand;
}
export async function e2eCommands(db: D1Database, sessionId: string): Promise<RemoteCommand[]> {
  const { results } = await db.prepare(`SELECT ${OUT} FROM e2e_commands WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10`).bind(sessionId).all();
  return results.map((r) => e2eView(r as any));
}
async function e2eCreate(db: D1Database, actor: string, sessionId: string, text: unknown): Promise<Res<{ command: RemoteCommand; nonce: string; nonce_ttl_s: number }>> {
  const bad = (status: number, error: string) => ({ ok: false as const, status, error });
  if (typeof sessionId !== "string" || typeof text !== "string") return bad(400, "bad request");
  if (!text.trim()) return bad(400, "empty text");
  if (new TextEncoder().encode(text).length > MAX_TEXT) return bad(413, "text too large");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return bad(400, "control characters");
  if (/SECRETSHAPE/.test(text)) return bad(422, "text contains a secret-shaped value");
  const f = FIXTURES.find((x) => x.id === sessionId);
  if (!f) return bad(404, "no such session");
  if (f.kind !== "lane2") return bad(422, "only lane2 sessions can be steered");
  if (f.status === "running") return bad(409, "session is running");
  const id = crypto.randomUUID(), t = nowS(), nonce = hex(crypto.getRandomValues(new Uint8Array(24)).buffer);
  const r = await db.prepare(`INSERT INTO e2e_commands (id, session_id, host, name, text, text_sha256, requested_by, created_at, state, nonce_hash, nonce_expires_at)
    SELECT ?,?,?,?,?,?,?,?, 'pending', ?, ? WHERE NOT EXISTS (SELECT 1 FROM e2e_commands WHERE session_id = ? AND ((state = 'pending' AND created_at > ?) OR (state = 'approved' AND approved_at > ?)))`)
    .bind(id, f.id, f.host, f.name, text, await sha(text), actor, t, await sha(nonce), t + NONCE_TTL, f.id, t - 600, t - 6).run();
  await db.prepare(`DELETE FROM e2e_commands WHERE created_at < ?`).bind(t - 86400).run().catch(() => null); // simulation rows don't accumulate
  if (!r.meta.changes) return bad(409, "session already has an open command");
  const row = await db.prepare(`SELECT ${OUT} FROM e2e_commands WHERE id = ?`).bind(id).first();
  return { ok: true, data: { command: e2eView(row as any), nonce, nonce_ttl_s: NONCE_TTL } };
}

type Ctx = Context<{ Bindings: Env; Variables: { session: import("./auth").Session } }>;

export function remoteRoutes(app: Hono<{ Bindings: Env; Variables: { session: import("./auth").Session } }>, scopeOf: (c: Ctx) => Scope) {
  guardPrefix(app, "/api/remote", scopeOf); // Erich-only: main (and the e2e tester); every other scope gets 403 before any handler
  const hub = (c: Ctx) => c.env.REMOTE as RemoteHub | undefined;
  const fixtures = (c: Ctx) => isE2eBase(scopeOf(c)); // every e2e tenant (slots too) gets the synthetic fixtures and NEVER the real hub (fixtures + e2e_commands rows are shared ids: a spec using them is not slot-aware). explicit: only the e2e tester gets fixtures (every other non-main scope was already refused by the guard)
  const enabled = (c: Ctx) => fixtures(c) || !!hub(c);

  app.get("/api/remote/config", (c) => c.json({ enabled: enabled(c), readOnly: true }));

  app.get("/api/remote/sessions", async (c) => {
    const status = c.req.query("status");
    if (status && !STATUSES.includes(status)) return c.json({ error: "bad status" }, 400);
    if (fixtures(c)) return c.json({ enabled: true, sessions: fixtureList(status) });
    if (!hub(c)) return c.json({ enabled: false, sessions: [] });
    try { return c.json({ enabled: true, sessions: await hub(c)!.list({ status: status || undefined, limit: 100 }) }); }
    catch (e) { console.error("remote list", e instanceof Error ? e.message : String(e)); return c.json({ error: "remote hub unavailable" }, 502); }
  });

  app.get("/api/remote/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json({ error: "not found" }, 404);
    if (fixtures(c)) { const f = FIXTURES.find((x) => x.id === id); return f ? c.json({ ...f, commands: await e2eCommands(c.env.DB, id) }) : c.json({ error: "not found" }, 404); }
    if (!hub(c)) return c.json({ error: "remote is not configured" }, 503);
    try {
      const s = await hub(c)!.get(id);
      return s ? c.json(s) : c.json({ error: "not found" }, 404);
    } catch (e) { console.error("remote get", e instanceof Error ? e.message : String(e)); return c.json({ error: "remote hub unavailable" }, 502); }
  });

  // ---- steering (follow-up to an idle lane2 session). Every step is an explicit user action; nothing is auto-approved. ----
  const actor = (c: Ctx) => c.get("session").u;
  const CID = /^[\w-]{1,64}$/;
  const reply = (c: Ctx, r: Res<unknown>, okStatus = 200) => (r.ok ? c.json(r.data as object, okStatus as 200) : c.json({ error: r.error }, r.status as 400));
  const fail = (c: Ctx, e: unknown) => { console.error("remote steer", e instanceof Error ? e.message : String(e)); return c.json({ error: "remote hub unavailable" }, 502); };
  const e2eRow = (c: Ctx, id: string) => c.env.DB.prepare(`SELECT ${OUT} FROM e2e_commands WHERE id = ?`).bind(id).first<Record<string, any>>();

  app.post("/api/remote/commands", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { session_id?: unknown; text?: unknown };
    if (typeof b.session_id !== "string" || !ID.test(b.session_id) || typeof b.text !== "string") return c.json({ error: "bad request" }, 400);
    if (fixtures(c)) return reply(c, await e2eCreate(c.env.DB, actor(c), b.session_id, b.text), 201);
    if (!hub(c)) return c.json({ error: "remote is not configured" }, 503);
    try { return reply(c, await hub(c)!.commandCreate(actor(c), b.session_id, b.text), 201); } catch (e) { return fail(c, e); }
  });

  app.post("/api/remote/commands/:id/nonce", async (c) => {
    const id = c.req.param("id"); if (!CID.test(id)) return c.json({ error: "not found" }, 404);
    if (fixtures(c)) {
      const r = await e2eRow(c, id); if (!r) return c.json({ error: "not found" }, 404);
      if (r.state !== "pending") return c.json({ error: `command is ${r.state}` }, 409);
      const nonce = hex(crypto.getRandomValues(new Uint8Array(24)).buffer);
      await c.env.DB.prepare(`UPDATE e2e_commands SET nonce_hash=?, nonce_expires_at=? WHERE id=? AND state='pending'`).bind(await sha(nonce), nowS() + NONCE_TTL, id).run();
      return c.json({ nonce, nonce_ttl_s: NONCE_TTL });
    }
    if (!hub(c)) return c.json({ error: "remote is not configured" }, 503);
    try { return reply(c, await hub(c)!.commandNonce(actor(c), id)); } catch (e) { return fail(c, e); }
  });

  app.post("/api/remote/commands/:id/approve", async (c) => {
    const id = c.req.param("id"); if (!CID.test(id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { nonce?: unknown };
    if (typeof b.nonce !== "string") return c.json({ error: "nonce required" }, 400);
    if (fixtures(c)) {
      if (b.nonce.length < 16 || b.nonce.length > 128) return c.json({ error: "nonce required" }, 400);
      const t = nowS();
      const r = await c.env.DB.prepare(`UPDATE e2e_commands SET state='approved', approved_by=?, approved_at=?, nonce_hash=NULL, nonce_expires_at=NULL WHERE id=? AND state='pending' AND nonce_hash=? AND nonce_expires_at > ?`).bind(actor(c), t, id, await sha(b.nonce), t).run();
      const row = await e2eRow(c, id);
      if (!row) return c.json({ error: "not found" }, 404);
      if (!r.meta.changes) return c.json({ error: row.state === "pending" ? "bad or expired nonce" : `command is ${row.state}` }, row.state === "pending" ? 403 : 409);
      return c.json(e2eView(row));
    }
    if (!hub(c)) return c.json({ error: "remote is not configured" }, 503);
    try { return reply(c, await hub(c)!.commandApprove(actor(c), id, b.nonce)); } catch (e) { return fail(c, e); }
  });

  app.post("/api/remote/commands/:id/reject", async (c) => {
    const id = c.req.param("id"); if (!CID.test(id)) return c.json({ error: "not found" }, 404);
    if (fixtures(c)) {
      const t = nowS();
      const r = await c.env.DB.prepare(`UPDATE e2e_commands SET state='rejected', rejected_by=?, rejected_at=?, finished_at=?, nonce_hash=NULL, nonce_expires_at=NULL WHERE id=? AND state='pending'`).bind(actor(c), t, t, id).run();
      const row = await e2eRow(c, id);
      if (!row) return c.json({ error: "not found" }, 404);
      return r.meta.changes ? c.json(e2eView(row)) : c.json({ error: `command is ${e2eView(row).state}` }, 409);
    }
    if (!hub(c)) return c.json({ error: "remote is not configured" }, 503);
    try { return reply(c, await hub(c)!.commandReject(actor(c), id)); } catch (e) { return fail(c, e); }
  });

  app.get("/api/remote/commands/:id", async (c) => {
    const id = c.req.param("id"); if (!CID.test(id)) return c.json({ error: "not found" }, 404);
    if (fixtures(c)) { const row = await e2eRow(c, id); return row ? c.json(e2eView(row)) : c.json({ error: "not found" }, 404); }
    if (!hub(c)) return c.json({ error: "remote is not configured" }, 503);
    try { const r = await hub(c)!.commandGet(id); return r ? c.json(r) : c.json({ error: "not found" }, 404); } catch (e) { return fail(c, e); }
  });
}
