// Space resolution (spaces T2). The base (who) comes from the signed session only; the client may only choose between that
// user's OWN two spaces: header `x-vc-space` (fetch) or `?space=` (WebSocket / media URLs, which cannot send headers).
// No selector = Business, byte-identical to before spaces. Unknown value = 400, Open not allowed for this user = 403. Fail closed.
import type { Context, Next } from "hono";
import { baseOf, isE2eBase, parseSpace, spaceOf, type BaseScope, type Scope, type Space } from "./scope";

type OpenEnv = { DB?: D1Database; OPEN_SPACE?: string };
const noStore = { "cache-control": "no-store" };

/** May this base use Open? Default-ON for a team user (Erich 2026-10-26: Open is open to all team users; Business stays Vertex only).
 *  - `OPEN_SPACE=off`: nobody. `on`: main and e2e are allowed outright; a team base still goes through its row below (kill switch stays honoured).
 *  - main (Erich, main edition): available by default (PO decision) unless the edition says `off`.
 *  - e2e: only when the edition says `per-user` (tests exercise Open; stub providers only), absent = off.
 *  - every other base (a team user): ON by default. A D1 `settings` row `open_space:<base>` = "0" is the per-user kill switch; row "1" or no row = on.
 *    FAIL CLOSED: only a SUCCESSFUL read yields on. No DB binding or a D1 error = off, because a failed read cannot tell a switched-off user from an
 *    absent row, and an outage must not widen access. */
export async function openAllowed(env: OpenEnv, base: BaseScope): Promise<boolean> {
  const mode = env.OPEN_SPACE;
  if (mode === "off") return false;
  if (mode === "on" && (base === "main" || isE2eBase(base))) return true; // never authorises a team base: that needs its own flag row
  if (base === "main") return true;
  if (isE2eBase(base)) return mode === "per-user";
  if (!env.DB) return false;
  try {
    const r = await env.DB.prepare(`SELECT value FROM settings WHERE name=?`).bind(`open_space:${base}`).first<{ value: string }>();
    return r?.value !== "0"; // read succeeded: no row or anything but "0" = on
  } catch { return false; }
}

/** Per-user flag write (operator / future admin surface): false writes the kill switch ("0") for that team base, true writes "1" (the default anyway). */
export async function setOpenFlag(db: D1Database, base: BaseScope, on: boolean): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`open_space:${base}`, on ? "1" : "0").run();
}

/** The raw selector: header wins over query. null = none given (Business). A present-but-empty value counts as given, so it is a 400. */
export function rawSpace(c: Context): string | null {
  const h = c.req.header("x-vc-space");
  if (h !== undefined) return h;
  const q = c.req.query("space");
  return q === undefined ? null : q;
}

/** The `spaces` capability list for /api/me. */
export async function spacesFor(env: OpenEnv, session: Scope): Promise<Space[]> {
  return spaceOf(session) === "biz" && (await openAllowed(env, baseOf(session))) ? ["biz", "open"] : ["biz"];
}

/** The ONE resolution middleware (mounted on /api/*, after the session gate and the team entitlement check).
 *  `sessionScope` = the Business scope of the session; `set` stores the resolved space for scopeOf(c). */
export const resolveSpace = (sessionScope: (c: any) => Scope, set: (c: any, sp: Space) => void) => async (c: Context, next: Next): Promise<Response | void> => {
  const raw = rawSpace(c);
  if (raw === null) return next(); // no selector: Business, exactly the pre-spaces path
  const sp = parseSpace(raw);
  if (!sp) return c.json({ error: "bad space" }, 400, noStore);
  if (sp === "open") {
    const base = sessionScope(c);
    if (spaceOf(base) !== "biz" || !(await openAllowed(c.env, baseOf(base)))) return c.json({ error: "space unavailable" }, 403, noStore);
    set(c, "open");
  }
  return next();
};
