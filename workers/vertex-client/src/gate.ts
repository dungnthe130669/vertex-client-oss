// The /api/* session gate. Production mounts it through server/middleware.ts (cf-lite); createApp() mounts it itself for tests.
import type { Context, Next } from "hono";
import { authenticate, ssoExchange, type Session } from "./auth";
import { DEFAULT_MODEL } from "./models-meta";

const noStore = { "cache-control": "no-store" };

// Typed loosely on purpose: the cf-lite generated app is `Hono<{ Bindings: Env }>` without our Variables (field-notes/remote-hub-0.6.md gap 2).
export async function apiGate(c: Context<{ Bindings: any; Variables: { session: Session } }>, next: Next): Promise<Response | void> {
  // Landing with only the shared SSO cookie: GET /api/me converts it into our own session (csrf token comes back in the body).
  if (c.req.method === "GET" && c.req.path === "/api/me" && !(await authenticate(c.req.raw, c.env).then((r) => !("err" in r)))) {
    const x = await ssoExchange(c.req.raw, c.env);
    if (x) {
      const s = x.session;
      return c.json({ user: s.u, via: s.via, csrf: s.csrf, defaultModel: DEFAULT_MODEL, sso: true }, 200, { ...noStore, "set-cookie": x.cookie });
    }
  }
  const a = await authenticate(c.req.raw, c.env);
  if ("err" in a) return a.err;
  c.set("session", a.session);
  await next();
  if (a.refreshCookie) c.res.headers.append("set-cookie", a.refreshCookie);
  if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
}
