// E2E login bypass. Exists so an automated tester can skip ONLY the GitHub OAuth step. Guard rails, all enforced in code:
//  - POST /auth/e2e with header x-e2e-token, compared in constant time (SHA-256 of both sides, so length does not leak)
//    against the Worker secret E2E_TOKEN. Secret unset => the route does not exist (404, indistinguishable from any unknown path).
//  - the session is for the fixed user `e2e-bot`, never an allowlisted GitHub login, lives 15 minutes, is never refreshed,
//    and stops working the moment E2E_TOKEN is removed (readSession re-checks it on every request).
//  - the session's data scope is 'e2e': conversations, search and usage are filtered by it (see index.ts), push routes are
//    closed to it, and its tool calls go through e2eToolGuard below.
//  - every attempt is logged (outcome, ip, ua) — never the token.
import { makeSession, safeEq, type AuthEnv } from "./auth";
import type { ToolHost } from "./tools";
import { E2E_SCOPE, e2eUserOfSlot, isE2eBiz, isMainBase, parseE2eSlot, parseScope, type Scope } from "./scope";

export const E2E_USER = "e2e-bot";
export const E2E_TTL_S = 15 * 60;
export { E2E_SCOPE };

export interface E2eEnv { E2E_TOKEN?: string }

const enc = new TextEncoder();
async function digestEq(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const hex = (d: ArrayBuffer) => [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return safeEq(hex(da), hex(db));
}

export const e2eEnabled = (env: E2eEnv) => typeof env.E2E_TOKEN === "string" && env.E2E_TOKEN.length >= 32;

const j = (o: unknown, status: number, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

export async function e2eLogin(req: Request, env: AuthEnv & E2eEnv, log: (o: Record<string, unknown>) => void = (o) => console.log(JSON.stringify(o))): Promise<Response> {
  if (!e2eEnabled(env)) return j({ error: "not found" }, 404);
  const meta = { evt: "e2e_login", ip: req.headers.get("cf-connecting-ip") ?? "", ua: (req.headers.get("user-agent") ?? "").slice(0, 80) };
  const tok = req.headers.get("x-e2e-token") ?? "";
  if (!tok) { log({ ...meta, ok: false, why: "no-token" }); return j({ error: "unauthorized" }, 401); }
  if (!(await digestEq(tok, env.E2E_TOKEN!))) { log({ ...meta, ok: false, why: "bad-token" }); return j({ error: "unauthorized" }, 401); }
  // Optional slot (header x-e2e-slot, ONLY after the token matched): "0".."3" strictly, absent = 0 = the classic e2e-bot. Anything else is a 400 (never silently slot 0).
  // The slot only selects WHICH synthetic fixture tenant the same token logs in as; it cannot name any other user, scope or role.
  const rawSlot = req.headers.get("x-e2e-slot");
  const slot = rawSlot === null ? 0 : parseE2eSlot(rawSlot);
  const user = slot === null ? null : e2eUserOfSlot(slot);
  if (!user) { log({ ...meta, ok: false, why: "bad-slot" }); return j({ error: "bad slot" }, 400); }
  const { cookie, session } = await makeSession(env, user, "e2e", E2E_TTL_S);
  log({ ...meta, ok: true, exp: session.exp, slot });
  return j({ ok: true, user, slot, expiresIn: E2E_TTL_S }, 200, { "set-cookie": cookie });
}

// The e2e user shares the real personal-connector (the tool tests need real tools). To keep it away from Erich's notes:
// only these tools exist for it, and every call is constrained to notes the test itself created (titles start with E2E).
export const E2E_TOOLS = new Set(["search_notes", "save_note", "delete_note", "connector_usage"]);
const isE2eTitle = (s: unknown) => typeof s === "string" && /^E2E/i.test(s.trim());

export function e2eToolGuard(inner: ToolHost): ToolHost {
  return {
    async list() { return (await inner.list()).filter((t) => E2E_TOOLS.has(t.name)); },
    async call(name, args) {
      const a = (args ?? {}) as Record<string, unknown>;
      const deny = (why: string) => ({ text: `not permitted for the e2e test user: ${why}`, isError: true });
      if (!E2E_TOOLS.has(name)) return deny(`tool ${name}`);
      if (name === "search_notes") {
        if (!/e2e/i.test(String(a.query ?? ""))) return deny("search_notes query must contain 'E2E'");
        return inner.call(name, { query: a.query, limit: Math.min(Number(a.limit) || 10, 10) });
      }
      if (name === "save_note") {
        if (a.id !== undefined) return deny("updating existing notes");
        if (!isE2eTitle(a.title)) return deny("save_note title must start with 'E2E'");
        return inner.call(name, { title: a.title, body: a.body, tags: a.tags });
      }
      if (name === "delete_note") {
        if (typeof a.id !== "number") return deny("delete_note needs a numeric id");
        const g = await inner.call("get_note", { id: a.id }).catch(() => null);
        let title: unknown; try { title = JSON.parse(g?.text ?? "").title; } catch { /* not found */ }
        if (!isE2eTitle(title)) return deny("delete_note only deletes notes whose title starts with 'E2E'");
        return inner.call(name, { id: a.id });
      }
      return inner.call(name, {});
    },
  };
}

/** Fail-closed scope lookup: only a D1 row holding a valid scope (main, e2e or g:<uid>) resolves. A missing row, an unknown/malformed value or a
 *  D1 error throws, so generation / tools / push are refused rather than defaulting to the real user's scope. */
export async function resolveScope(db: { prepare(q: string): { bind(...a: unknown[]): { first<T>(): Promise<T | null> } } }, id: string | null | undefined): Promise<Scope> {
  if (!id) throw new Error("conversation scope unavailable: no conversation id");
  const r = await db.prepare(`SELECT scope FROM conversations WHERE id=?`).bind(id).first<{ scope: string }>();
  const sc = parseScope(r?.scope);
  if (sc) return sc;
  throw new Error("conversation scope unavailable");
}

/** Internal header the Worker sets (from the validated session, never from client input) on calls to the shared slash-catalog DO,
 *  which has no conversation row to resolve a scope from. Only /tools honours it. */
export const DATA_SCOPE_HEADER = "x-data-scope";
export const headerScope = (h: Headers): Scope | null => parseScope(h.get(DATA_SCOPE_HEADER));

/** Explicit per-scope tool-host table. main -> everything the connector offers (Erich's personal connector), e2e -> only E2E_TOOLS, every
 *  other scope (g:*) -> an EMPTY host: the raw connector is never reachable. */
export const EMPTY_TOOL_HOST: ToolHost = {
  async list() { return []; },
  async call(name) { return { text: `tool ${name} is not available for this account`, isError: true }; },
};
/** Open: only main's own Open space may even see the raw connector, and connectors.ts loadSettings defaults it to OFF there (the filter sits on top of this
 *  table), so tool results never reach a non-Vertex provider unless the user switched it on in that space. e2e and guests in Open: always empty. */
export const toolHostFor = (scope: Scope, raw: ToolHost): ToolHost => (isMainBase(scope) ? raw : isE2eBiz(scope) ? e2eToolGuard(raw) : EMPTY_TOOL_HOST);
/** Catalog DO variant: scope handed over explicitly; none / no connector -> null. */
export const hostForScope = (scope: Scope | null, raw: ToolHost | null): ToolHost | null => (!scope || !raw ? null : toolHostFor(scope, raw));
