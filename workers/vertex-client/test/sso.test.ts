import { describe, expect, test } from "bun:test";
import { createApp, type Env } from "../src/index";
import { SESSION_COOKIE, makeSession } from "../src/auth";
import { E2E_USER } from "../src/auth-e2e";

const ORIGIN = "https://app.test";
const b64u = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const PUB = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))));
async function mint(sub = "example-user", over: Record<string, unknown> = {}, signWith = kp.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: "EdDSA", typ: "JWT", kid: "k1" });
  const p = b64u({ iss: "auth.internal.invalid", aud: "dev2", sub, iat: now, exp: now + 3600, ...over });
  const sig = Buffer.from(await crypto.subtle.sign("Ed25519", signWith, new TextEncoder().encode(`${h}.${p}`))).toString("base64url");
  return `${h}.${p}.${sig}`;
}
const env = (o: Partial<Env> = {}): Env => ({
  SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "cs",
  SSO_PUBLIC_KEYS: JSON.stringify({ k1: PUB }), SSO_ISSUER: "auth.internal.invalid", SSO_AUDIENCE: "dev2", SSO_AUTH_ORIGIN: "https://auth.internal.invalid", SSO_ALLOWED_LOGINS: "example-user", E2E_TOKEN: "e".repeat(40),
  ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: {} as never, CHAT: {} as never, ...o,
});
const app = createApp();
const req = (path: string, cookie?: string, init: RequestInit = {}) => new Request(ORIGIN + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...((init.headers as object) ?? {}) } });
const sessionFrom = (r: Response) => /__Host-vc_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];

describe("SSO landing", () => {
  test("valid sso cookie: GET /api/me exchanges it for our own session (same user, csrf, cookie flags)", async () => {
    const r = await app.fetch(req("/api/me", `sso=${await mint()}`), env());
    expect(r.status).toBe(200);
    const j = (await r.json()) as { user: string; via: string; csrf: string };
    expect(j.user).toBe("example-user"); expect(j.via).toBe("github"); expect(j.csrf.length).toBe(32);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toContain("__Host-vc_session="); expect(sc).toContain("HttpOnly"); expect(sc).toContain("SameSite=Strict");
    // and the new session works on its own, with the issued csrf
    const again = await app.fetch(req("/api/me", `${SESSION_COOKIE}=${sessionFrom(r)}`), env());
    expect(((await again.json()) as { csrf: string }).csrf).toBe(j.csrf);
  });
  test("rejected: no cookie, bad signature, expired, wrong sub, other issuer, unconfigured keys", async () => {
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    for (const [name, c, e] of [
      ["none", undefined, env()],
      ["forged", `sso=${await mint("example-user", {}, other.privateKey)}`, env()],
      ["expired", `sso=${await mint("example-user", { iat: 1, exp: 2 })}`, env()],
      ["wrong sub", `sso=${await mint("someone-else")}`, env()],
      ["wrong iss", `sso=${await mint("example-user", { iss: "evil" })}`, env()],
      ["no keys configured", `sso=${await mint()}`, env({ SSO_PUBLIC_KEYS: undefined })],
    ] as const) expect([name, (await app.fetch(req("/api/me", c), e)).status]).toEqual([name, 401]);
  });
  test("cross-site fetch cannot trigger the exchange", async () => {
    const r = await app.fetch(req("/api/me", `sso=${await mint()}`, { headers: { "sec-fetch-site": "cross-site" } }), env());
    expect(r.status).toBe(401);
  });
  test("sso cookie is not a session: mutating and other /api routes stay 401 until exchanged", async () => {
    const e = env(); const c = `sso=${await mint()}`;
    expect((await app.fetch(req("/api/models", c), e)).status).toBe(401);
    expect((await app.fetch(req("/api/conversations", c, { method: "POST", headers: { origin: ORIGIN } }), e)).status).toBe(401);
  });
  test("/auth/e2e ignores SSO entirely (no token -> 401, SSO cookie does not help; unset -> 404)", async () => {
    const c = `sso=${await mint()}`;
    expect((await app.fetch(req("/auth/e2e", c, { method: "POST", headers: { origin: ORIGIN } }), env())).status).toBe(401);
    expect((await app.fetch(req("/auth/e2e", c, { method: "POST", headers: { origin: ORIGIN } }), env({ E2E_TOKEN: undefined }))).status).toBe(404);
  });
  test("e2e bypass still works and never gets an SSO logout redirect", async () => {
    const e = env();
    const r = await app.fetch(req("/auth/e2e", undefined, { method: "POST", headers: { origin: ORIGIN, "x-e2e-token": e.E2E_TOKEN! } }), e);
    expect(r.status).toBe(200);
    const cookie = `${SESSION_COOKIE}=${sessionFrom(r)}`;
    const me = (await (await app.fetch(req("/api/me", cookie), e)).json()) as { user: string; via: string; csrf: string };
    expect([me.user, me.via]).toEqual([E2E_USER, "e2e"]);
    const out = await app.fetch(req("/auth/logout", cookie, { method: "POST", headers: { origin: ORIGIN, "x-csrf-token": me.csrf } }), e);
    expect(((await out.json()) as { ssoLogout: unknown }).ssoLogout).toBeNull();
  });
});

describe("/auth/login", () => {
  test("valid sso -> session cookie + redirect to /", async () => {
    const r = await app.fetch(req("/auth/login", `sso=${await mint()}`), env());
    expect(r.status).toBe(302); expect(r.headers.get("location")).toBe("/"); expect(sessionFrom(r)).toBeTruthy();
  });
  test("no sso -> redirect to auth.dev2 with a return url back to /auth/login?sso=1", async () => {
    const r = await app.fetch(req("/auth/login"), env());
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://auth.internal.invalid/login");
    expect(loc.searchParams.get("return")).toBe(ORIGIN + "/auth/login?sso=1");
  });
  test("bounce that came back without a valid cookie falls back to GitHub (no redirect loop)", async () => {
    const r = await app.fetch(req("/auth/login?sso=1", `sso=${await mint("someone-else")}`), env());
    expect(new URL(r.headers.get("location")!).origin).toBe("https://github.com");
  });
  test("SSO not configured -> GitHub as before; /auth/github always GitHub", async () => {
    expect(new URL((await app.fetch(req("/auth/login"), env({ SSO_PUBLIC_KEYS: undefined }))).headers.get("location")!).origin).toBe("https://github.com");
    expect(new URL((await app.fetch(req("/auth/github"), env())).headers.get("location")!).origin).toBe("https://github.com");
  });
});

describe("logout", () => {
  test("github/sso session: clears ours and hands back the auth.dev2 logout url", async () => {
    const e = env(); const { cookie, session } = await makeSession(e, "example-user", "github");
    const r = await app.fetch(req("/auth/logout", cookie.split(";")[0], { method: "POST", headers: { origin: ORIGIN, "x-csrf-token": session.csrf } }), e);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    const u = new URL(((await r.json()) as { ssoLogout: string }).ssoLogout);
    expect(u.origin + u.pathname).toBe("https://auth.internal.invalid/logout");
    expect(u.searchParams.get("return")).toBe(ORIGIN + "/?signedout=1");
  });
});
