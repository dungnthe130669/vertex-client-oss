// Settings > Cloudflare: link / test / remove the caller's OWN Cloudflare account (src/cf-account.ts). Same scope rule as Open itself: main, or a team user whose
// Open space is not switched off (open_space:<base> = "0" is the kill switch); the e2e tester never (it must not touch a real account). Works from either space: the credential belongs to the
// BASE. The token is write-only: no response, log line or error ever contains it (status shows its last 4 characters only).
import type { Context, Hono } from "hono";
import type { Env } from "./index";
import { MAIN_SCOPE, isE2eBase, baseOf, isGuestScope, type Scope } from "./scope";
import { openAllowed } from "./open-space";
import { CF_ACCT_PROVIDER, CF_ORIGIN, CF_SCOPES, cfAccountOf, cfStatus, cfVerify, encodeCreds, linkableEnv, parseLinkBody } from "./cf-account";
import { deleteUserKey, isMissingTable, putUserKey, readBodyCapped } from "./user-keys";
import { putAllowed } from "./provider-routes";

type App = { Bindings: Env; Variables: { session: import("./auth").Session } };
const noStore = { "cache-control": "no-store" };
const MIGRATION = "migration required: apply 0027 (wrangler d1 migrations apply --remote) before linking an account";
const audit = (op: "link" | "unlink" | "test", base: string, ok?: boolean) => console.info(JSON.stringify({ audit: "cf-account", op, base, ...(ok === undefined ? {} : { ok }) }));

/** May this base manage a linked Cloudflare account? main always; a team user only with Open on; e2e and anything unknown never. Fail closed. */
export async function cfAccountAllowed(env: Env, scope: Scope): Promise<boolean> {
  const base = baseOf(scope);
  if (base === MAIN_SCOPE) return true;
  if (isE2eBase(base) || !isGuestScope(base)) return false;
  return openAllowed(env, base);
}

export function cfAccountRoutes(app: Hono<App>, scopeOf: (c: Context<App>) => Scope, deps: { fetchImpl?: typeof fetch }) {
  const guard = async (c: Context<App>, next: () => Promise<void>) => (await cfAccountAllowed(c.env, scopeOf(c))) ? next() : c.json({ error: "forbidden" }, 403, noStore);
  app.use("/api/cloudflare/*", guard as never);
  const base = (c: Context<App>) => baseOf(scopeOf(c));

  const view = async (c: Context<App>) => ({ ...(await cfStatus(c.env, base(c))), storage: linkableEnv(c.env), origin: CF_ORIGIN, scopes: CF_SCOPES });
  app.get("/api/cloudflare/account", async (c) => c.json(await view(c), 200, noStore));

  app.put("/api/cloudflare/account", async (c) => {
    const b = base(c);
    if (!putAllowed(`cf:${b}`)) return c.json({ error: "too many changes, wait a minute" }, 429, noStore);
    if (!c.env.KEY_ENC_SECRET) return c.json({ error: "key storage not configured" }, 409, noStore);
    const raw = await readBodyCapped(c.req.raw); if (raw === null) return c.json({ error: "body too large" }, 413, noStore);
    let j: unknown = null; try { j = JSON.parse(raw); } catch { /* bad body */ }
    const p = parseLinkBody(j); if ("error" in p) return c.json({ error: p.error }, 400, noStore);
    try { await putUserKey({ DB: c.env.DB, KEY_ENC_SECRET: c.env.KEY_ENC_SECRET }, b, CF_ACCT_PROVIDER, CF_ORIGIN, encodeCreds(p.creds)); }
    catch (e) { if (isMissingTable(e)) return c.json({ error: MIGRATION }, 409, noStore); return c.json({ error: "could not save the account" }, 500, noStore); }
    audit("link", b);
    return c.json({ ok: true, ...(await view(c)) }, 200, noStore);
  });

  app.delete("/api/cloudflare/account", async (c) => {
    const b = base(c);
    try { await deleteUserKey(c.env.DB, b, CF_ACCT_PROVIDER); }
    catch (e) { if (isMissingTable(e)) return c.json({ ok: true, ...(await view(c)) }, 200, noStore); return c.json({ error: "could not remove the account" }, 500, noStore); }
    audit("unlink", b);
    return c.json({ ok: true, ...(await view(c)) }, 200, noStore);
  });

  // ONE harmless read (token verification), nothing billed. Uses the stored link only: the token is never accepted here, so a test can not be used to probe arbitrary tokens.
  app.post("/api/cloudflare/account/test", async (c) => {
    const b = base(c);
    if (!putAllowed(`cft:${b}`)) return c.json({ error: "too many tests, wait a minute" }, 429, noStore);
    const a = await cfAccountOf(c.env, b);
    if (a.kind === "none") return c.json({ ok: false, detail: "No account is linked: the shared account is in use." }, 200, noStore);
    if (a.kind === "error") return c.json({ ok: false, detail: "The stored link cannot be read. Remove it and link again." }, 200, noStore);
    const r = await cfVerify(a.creds, deps.fetchImpl);
    audit("test", b, r.ok);
    return c.json(r, 200, noStore);
  });
}
