import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import worker from "../src/index";
import { CSP, SECURITY_HEADERS } from "../src/headers";
import { SESSION_COOKIE, makeSession, signSession, type Session } from "../src/auth";
import { ProviderError } from "../src/providers/types";

const ORIGIN = "https://app.test";
const baseEnv = (over: Partial<Env> = {}): Env => ({
  SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k",
  GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csec",
  ASSETS: { fetch: async () => new Response("<html>shell</html>", { headers: { "content-type": "text/html" } }) },
  GATEWAY: { fetch: async () => new Response("{}") }, DB: {} as never, CHAT: {} as never, ...over,
});
const models = [{ id: "grok-4.20-reasoning", displayName: "grok" }, { id: "claude-sonnet-5-5", displayName: "claude-sonnet-5-5" }];
const app = createApp({ provider: () => ({ name: "stub", listModels: async () => models, messages: async () => new Response("{}") }) });
const cookieOf = (v: string) => `${SESSION_COOKIE}=${v}`;
const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const h = new Headers(init.headers);
  if (init.cookie) h.set("cookie", init.cookie);
  return new Request(ORIGIN + path, { ...init, headers: h });
};
async function login(env: Env, user = "example-user", via: Session["via"] = "github") {
  const { cookie, session } = await makeSession(env, user, via);
  return { cookie: cookie.split(";")[0], csrf: session.csrf };
}

describe("api auth", () => {
  test("no cookie -> 401", async () => {
    expect((await app.fetch(req("/api/me"), baseEnv())).status).toBe(401);
    expect((await app.fetch(req("/api/models"), baseEnv())).status).toBe(401);
  });
  test("healthy control: valid session -> 200 with user", async () => {
    const env = baseEnv(); const { cookie } = await login(env);
    const r = await app.fetch(req("/api/me", { cookie }), env);
    expect(r.status).toBe(200);
    expect((await r.json() as { user: string }).user).toBe("example-user");
  });
  test("feat2 contract: /api/me = the pre-feat2 fields byte-for-byte + ONLY an additive `features` map of booleans", async () => {
    const env = baseEnv(); const { cookie, csrf } = await login(env);
    const body = await (await app.fetch(req("/api/me", { cookie }), env)).json() as Record<string, unknown>;
    const { features, ...rest } = body;
    expect(Object.keys(rest).sort()).toEqual(["csrf", "defaultModel", "erichOnly", "space", "spaces", "user", "via"]);
    expect(rest).toMatchObject({ user: "example-user", via: "github", csrf, space: "biz", erichOnly: true, spaces: ["biz", "open"] });
    expect(features && typeof features === "object" && !Array.isArray(features)).toBe(true);
    expect(Object.values(features as Record<string, unknown>).every((v) => typeof v === "boolean")).toBe(true);
    expect((features as Record<string, boolean>).chat).toBe(true);
    expect("admin" in body).toBe(false);
  });
  test("garbage / tampered / unsigned cookie -> 401", async () => {
    const env = baseEnv(); const { cookie } = await login(env);
    for (const c of [cookieOf("garbage"), cookieOf("a.b"), cookie.slice(0, -3) + "AAA", cookie + ".extra", cookieOf("")])
      expect((await app.fetch(req("/api/me", { cookie: c }), env)).status).toBe(401);
  });
  test("cookie signed with another secret -> 401", async () => {
    const other = baseEnv({ SESSION_SECRET: "some-other-secret-value" }); const { cookie } = await login(other);
    expect((await app.fetch(req("/api/me", { cookie }), baseEnv())).status).toBe(401);
  });
  test("expired session -> 401", async () => {
    const env = baseEnv(); const now = Math.floor(Date.now() / 1000);
    const v = await signSession(env, { u: "example-user", csrf: "x", iat: now - 100, exp: now - 1, via: "github" });
    expect((await app.fetch(req("/api/me", { cookie: cookieOf(v) }), env)).status).toBe(401);
  });
  test("wrong user (validly signed, not allowlisted) -> 401", async () => {
    const env = baseEnv(); const { cookie } = await login(env, "mallory");
    expect((await app.fetch(req("/api/me", { cookie }), env)).status).toBe(401);
  });
  test("removing a login from the allowlist revokes live sessions", async () => {
    const env = baseEnv(); const { cookie } = await login(env);
    expect((await app.fetch(req("/api/me", { cookie }), { ...env, ALLOWED_GITHUB_LOGINS: "someone-else" })).status).toBe(401);
  });
  test("a validly signed session with an unknown `via` (e.g. old password sessions) -> 401", async () => {
    const env = baseEnv(); const now = Math.floor(Date.now() / 1000);
    const v = await signSession(env, { u: "owner", csrf: "x", iat: now, exp: now + 100, via: "password" as never });
    expect((await app.fetch(req("/api/me", { cookie: cookieOf(v) }), env)).status).toBe(401);
  });
  test("unknown /api path when authed -> 404, unauthed -> 401", async () => {
    const env = baseEnv(); const { cookie } = await login(env);
    expect((await app.fetch(req("/api/nope", { cookie }), env)).status).toBe(404);
    expect((await app.fetch(req("/api/nope"), env)).status).toBe(401);
  });
});

describe("CSRF / same-origin on writes", () => {
  const post = (env: Env, init: { cookie?: string; origin?: string | null; csrf?: string }) => {
    const h = new Headers();
    if (init.origin !== null) h.set("origin", init.origin ?? ORIGIN);
    if (init.csrf) h.set("x-csrf-token", init.csrf);
    return app.fetch(req("/api/anything", { method: "POST", headers: h, cookie: init.cookie, body: "{}" }), env);
  };
  test("healthy control: cookie + Origin + CSRF passes auth (then 404, no such route)", async () => {
    const env = baseEnv(); const { cookie, csrf } = await login(env);
    expect((await post(env, { cookie, csrf })).status).toBe(404);
  });
  test("missing Origin -> 403", async () => {
    const env = baseEnv(); const { cookie, csrf } = await login(env);
    expect((await post(env, { cookie, csrf, origin: null })).status).toBe(403);
  });
  test("foreign Origin -> 403", async () => {
    const env = baseEnv(); const { cookie, csrf } = await login(env);
    expect((await post(env, { cookie, csrf, origin: "https://evil.example" })).status).toBe(403);
  });
  test("missing / wrong CSRF token -> 403", async () => {
    const env = baseEnv(); const { cookie } = await login(env);
    expect((await post(env, { cookie })).status).toBe(403);
    expect((await post(env, { cookie, csrf: "wrong" })).status).toBe(403);
  });
  test("no session -> 401 even with matching Origin", async () => {
    expect((await post(baseEnv(), { csrf: "x" })).status).toBe(401);
  });
  test("WebSocket upgrade without Origin -> 403", async () => {
    const env = baseEnv(); const { cookie } = await login(env);
    const r = await app.fetch(req("/api/ws", { cookie, headers: { upgrade: "websocket" } }), env);
    expect(r.status).toBe(403);
  });
  test("logout requires CSRF and clears the cookie", async () => {
    const env = baseEnv(); const { cookie, csrf } = await login(env);
    const bad = await app.fetch(req("/auth/logout", { method: "POST", cookie, headers: { origin: ORIGIN } }), env);
    expect(bad.status).toBe(403);
    const ok = await app.fetch(req("/auth/logout", { method: "POST", cookie, headers: { origin: ORIGIN, "x-csrf-token": csrf } }), env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("password login removed", () => {
  test("/auth/password no longer exists", async () => {
    const h = new Headers({ origin: ORIGIN, "content-type": "application/json" });
    const r = await app.fetch(req("/auth/password", { method: "POST", headers: h, body: JSON.stringify({ password: "x" }) }), baseEnv());
    expect(r.status).toBe(404);
  });
});

describe("github oauth", () => {
  test("login redirect binds state cookie and uses same-origin callback", async () => {
    const r = await app.fetch(req("/auth/login"), baseEnv());
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe(ORIGIN + "/auth/callback");
    expect(r.headers.get("set-cookie")).toContain(loc.searchParams.get("state")!);
  });
  test("login is 503 when OAuth is not configured", async () => {
    expect((await app.fetch(req("/auth/login"), baseEnv({ GITHUB_CLIENT_ID: undefined }))).status).toBe(503);
  });
  test("callback with state mismatch / missing state cookie -> 400", async () => {
    const env = baseEnv();
    expect((await app.fetch(req("/auth/callback?state=a&code=c"), env)).status).toBe(400);
    expect((await app.fetch(req("/auth/callback?state=a&code=c", { cookie: "__Host-vc_oauth_state=b" }), env)).status).toBe(400);
  });
  const cbApp = (login: string) => createApp({
    fetchImpl: (async (u: string) => new Response(JSON.stringify(String(u).includes("access_token") ? { access_token: "t" } : { login }))) as unknown as typeof fetch,
  });
  test("callback: allowlisted user gets a session, other user -> 403 and no cookie", async () => {
    const env = baseEnv();
    const ok = await cbApp("example-user").fetch(req("/auth/callback?state=s&code=c", { cookie: "__Host-vc_oauth_state=s" }), env);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("set-cookie")).toContain("__Host-vc_session=");
    const bad = await cbApp("mallory").fetch(req("/auth/callback?state=s&code=c", { cookie: "__Host-vc_oauth_state=s" }), env);
    expect(bad.status).toBe(403);
    expect(bad.headers.get("set-cookie")).not.toContain("__Host-vc_session=");
    expect(await bad.text()).not.toContain("mallory");
  });
});

describe("/api/models", () => {
  test("proxies provider registry, Claude first, meta joined", async () => {
    const env = baseEnv(); const { cookie } = await login(env);
    const r = await app.fetch(req("/api/models", { cookie }), env);
    const b = await r.json() as { default: string; models: { id: string; meta: unknown }[] };
    expect(b.models.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "grok-4.20-reasoning"]);
    expect(b.models[0]!.meta).not.toBeNull(); expect(b.models[1]!.meta).toBeNull();
    expect(b.default).toBe("claude-sonnet-5-5");
  });
  test("provider failure is reported, never an empty list", async () => {
    const bad = createApp({ provider: () => ({ name: "x", messages: async () => new Response("{}"), listModels: async () => { throw new ProviderError("gateway /v1/models returned 500", 502); } }) });
    const env = baseEnv(); const { cookie } = await login(env);
    const r = await bad.fetch(req("/api/models", { cookie }), env);
    expect(r.status).toBe(502);
  });
});

describe("security headers", () => {
  test("every Worker response (API 401, JSON, static passthrough) carries the security headers", async () => {
    const env = baseEnv();
    for (const path of ["/api/me", "/auth/config", "/anything-spa"]) {
      const r = await worker.fetch(req(path), env, {} as never);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v);
    }
  });
  test("CSP forbids inline script and framing", () => {
    expect(CSP).toContain("script-src 'self'"); expect(CSP).not.toContain("unsafe-inline"); expect(CSP).toContain("frame-ancestors 'none'");
  });
  test("static _headers file matches the Worker's constants", () => {
    const txt = readFileSync(new URL("../web/public/_headers", import.meta.url), "utf8");
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(txt.toLowerCase()).toContain(`${k}: ${v}`.toLowerCase());
  });
  test("static _headers: shell, sw.js, manifest, theme.js are no-cache; hashed assets immutable", () => {
    const txt = readFileSync(new URL("../web/public/_headers", import.meta.url), "utf8");
    const rule = (path: string) => new RegExp(`^${path.replace(/[/*.]/g, "\\$&")}\\n\\s+Cache-Control: (.+)$`, "m").exec(txt)?.[1];
    for (const p of ["/", "/sw.js", "/manifest.webmanifest", "/theme.js", "/index.html"]) expect(rule(p)).toBe("no-cache");
    expect(rule("/assets/*")).toContain("immutable");
  });
  test("API responses are not cacheable", async () => {
    const env = baseEnv(); const { cookie } = await login(env);
    expect((await app.fetch(req("/api/me", { cookie }), env)).headers.get("cache-control")).toBe("no-store");
  });
});
