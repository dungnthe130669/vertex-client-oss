// D1 side of approval modes (migration 0034): persistent "always allow this domain" grants, the auto-approval audit trail, the admin kill switch and the Settings routes.
// Grants are keyed by the full Scope of the user's OPEN space (web_* exist only there), so one user's grant never reaches another user or another space. Every read fails CLOSED
// (a missing table / D1 error = no grants, Auto off). There is deliberately NO endpoint that creates a grant: a persistent grant is created only by approving a specific parked
// call over the authenticated chat socket (turn-engine decide), so a forged request cannot allow an arbitrary host.
import type { Context, Hono } from "hono";
import type { Env } from "./index";
import { AUDIT_TTL_MS, MAX_USER_GRANTS, grantHost } from "./approval";
import { withSpace, type BaseScope, type Scope } from "./scope";
import { WEB_TOOLS } from "./web-taint";

type App = { Bindings: Env; Variables: { session: import("./auth").Session } };
const noStore = { "cache-control": "no-store" };

/** Admin kill switch: settings row `approval_auto:<base>` = "0" turns Auto and persistent grants off for that base; default enabled. Keyed by WHO (the base), like open_space.
 *  FAIL CLOSED: only a successful read yields on (no row / anything but "0" = on); no DB or a D1 error = off. */
export async function approvalAutoOn(db: D1Database | undefined, base: BaseScope): Promise<boolean> {
  if (!db) return false;
  try {
    const r = await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`approval_auto:${base}`).first<{ value: string }>();
    return r?.value !== "0";
  } catch { return false; }
}
export async function setApprovalAuto(db: D1Database, base: BaseScope, on: boolean): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`approval_auto:${base}`, on ? "1" : "0").run();
}

/** The user's persistent host grants for this Scope. Never throws: an unreadable table = none. Also stamps last_used_at is NOT done here (see touch). */
export async function userHosts(db: D1Database, scope: Scope): Promise<ReadonlySet<string>> {
  try {
    const r = await db.prepare(`SELECT subject FROM tool_grants WHERE scope=? AND tool IN ('web_read','web_screenshot','web_links') LIMIT ?`).bind(scope, MAX_USER_GRANTS).all<{ subject: string }>();
    return new Set((r.results ?? []).map((x) => x.subject));
  } catch { return new Set(); }
}
/** Persist one grant (idempotent). The host is re-validated here so no caller can store an ineligible one. false = nothing stored. */
export async function addGrant(db: D1Database, scope: Scope, tool: string, host: string, now = Date.now()): Promise<boolean> {
  if (!WEB_TOOLS.has(tool) || grantHost(`https://${host}/`) !== host) return false;
  try {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM tool_grants WHERE scope=?`).bind(scope).first<{ n: number }>();
    if ((n?.n ?? 0) >= MAX_USER_GRANTS) return false;
    await db.prepare(`INSERT INTO tool_grants (scope, tool, subject, created_at) VALUES (?,?,?,?) ON CONFLICT(scope, tool, subject) DO NOTHING`).bind(scope, tool, host, now).run();
    return true;
  } catch { return false; }
}
export async function listGrants(db: D1Database, scope: Scope): Promise<Array<{ tool: string; host: string; createdAt: number; lastUsedAt: number | null }>> {
  const r = await db.prepare(`SELECT tool, subject, created_at, last_used_at FROM tool_grants WHERE scope=? ORDER BY subject, tool LIMIT ?`).bind(scope, MAX_USER_GRANTS).all<{ tool: string; subject: string; created_at: number; last_used_at: number | null }>();
  return (r.results ?? []).map((x) => ({ tool: x.tool, host: x.subject, createdAt: x.created_at, lastUsedAt: x.last_used_at }));
}
export async function revokeGrant(db: D1Database, scope: Scope, host: string): Promise<number> {
  const r: any = await db.prepare(`DELETE FROM tool_grants WHERE scope=? AND subject=?`).bind(scope, host).run();
  return Number(r?.meta?.changes ?? 0);
}
export async function revokeAllGrants(db: D1Database, scope: Scope): Promise<void> { await db.prepare(`DELETE FROM tool_grants WHERE scope=?`).bind(scope).run(); }

/** Delete every audit row past its expiry. The one function that enforces the 30-day TTL; called on every audit write, by the every-minute cron and when the list is read. */
export async function purgeAudit(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare(`DELETE FROM approval_audit WHERE expires_at <= ?`).bind(now).run();
}
/** Admin kill switch for Bypass: it follows `approval_auto` (one switch turns Auto AND Bypass off), so there is no separate row. */
/** One row per auto-approved call, written BEFORE the call runs, with the mode (ask/auto/bypass) that approved it. Strict on purpose: if the `mode` column is missing (migration 0035 not applied) the insert
 *  throws and the call stays a card; there is NO fallback insert without the mode, because that would silently lose it. THROWS on failure (the engine then asks instead of auto-approving). Tool + host only: no path, query or text. */
export async function writeAudit(db: D1Database, scope: Scope, e: { conversationId: string; tool: string; subject: string; source: string; mode: string }, now = Date.now()): Promise<void> {
  await db.prepare(`INSERT INTO approval_audit (scope, conversation_id, tool, subject, source, mode, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`).bind(scope, e.conversationId, e.tool, e.subject.slice(0, 253), e.source, e.mode, now, now + AUDIT_TTL_MS).run();
  try { await purgeAudit(db, now); } catch (err) { console.error("audit purge", err instanceof Error ? err.message : String(err)); } // best effort after the row is in; the cron is the backstop
  if (e.source === "user-grant") { try { await db.prepare(`UPDATE tool_grants SET last_used_at=? WHERE scope=? AND tool=? AND subject=?`).bind(now, scope, e.tool, e.subject).run(); } catch { /* cosmetic */ } }
}
/** Bypass confirmation record (who/when/chat): settings row `bypass_confirm:<scope>:<conversation>`. THROWS on failure (the switch is then refused). */
export async function recordBypassConfirm(db: D1Database, scope: Scope, conversationId: string, version: number, now = Date.now()): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`bypass_confirm:${scope}:${conversationId}`, JSON.stringify({ at: now, version, scope, conversationId })).run();
}
export async function listAudit(db: D1Database, scope: Scope, limit = 30): Promise<Array<{ tool: string; host: string; source: string; mode: string | null; at: number; conversationId: string }>> {
  const r = await db.prepare(`SELECT tool, subject, source, mode, created_at, conversation_id FROM approval_audit WHERE scope=? AND expires_at > ? ORDER BY id DESC LIMIT ?`).bind(scope, Date.now(), limit).all<any>();
  return (r.results ?? []).map((x) => ({ tool: x.tool, host: x.subject, source: x.source, mode: x.mode ?? null, at: x.created_at, conversationId: x.conversation_id }));
}

/** Settings > Approvals. Mounted under the global session + CSRF + same-origin gate (auth.ts authenticate: a mutating request needs the CSRF header and a same-origin Origin). The scope is
 *  taken ONLY from the session (scopeOf), never from the request; grants live in the caller's Open space whichever space the page was opened from. */
export function approvalRoutes(app: Hono<App>, scopeOf: (c: Context<App>) => Scope, deps: { baseAuto: (c: Context<App>) => Promise<boolean> }) {
  const sc = (c: Context<App>) => withSpace(scopeOf(c), "open");
  app.get("/api/approvals", async (c) => {
    const scope = sc(c);
    try {
      await purgeAudit(c.env.DB).catch(() => {});
      return c.json({ autoAllowed: await deps.baseAuto(c), grants: await listGrants(c.env.DB, scope), audit: await listAudit(c.env.DB, scope) }, 200, noStore);
    } catch (e) { console.error("approvals", e instanceof Error ? e.message : String(e)); return c.json({ error: "could not load approvals" }, 500, noStore); }
  });
  app.delete("/api/approvals/grants", async (c) => { await revokeAllGrants(c.env.DB, sc(c)); return c.json({ ok: true }, 200, noStore); });
  app.delete("/api/approvals/grants/:host", async (c) => {
    const host = decodeURIComponent(c.req.param("host")).toLowerCase();
    if (grantHost(`https://${host}/`) !== host) return c.json({ error: "bad host" }, 400, noStore);
    const n = await revokeGrant(c.env.DB, sc(c), host);
    return n ? c.json({ ok: true }, 200, noStore) : c.json({ error: "no such grant" }, 404, noStore);
  });
}
