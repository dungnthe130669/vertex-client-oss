// Desktop sign-in through the system browser: server side (src/auth-app.ts, migrations/0040_app_handoff.sql). docs/vertex-client-desktop-app.md section 9.6.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { SESSION_COOKIE, makeSession, readSession, signSession } from "../src/auth";
import { APPROVE_PER_USER_WINDOW, EXCHANGE_FAIL_PER_IP, HANDOFF_TTL_S, MAX_OPEN_CODES, challengeOf } from "../src/auth-app";
import { E2E_TTL_S } from "../src/auth-e2e";
import { withSecurityHeaders } from "../src/headers";

const ORIGIN = "https://app.test";
const E2E_TOKEN = "e".repeat(40);
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const rnd = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const newVerifier = () => rnd(32);                         // 43 chars, what the app generates
const stateOf = () => rnd(16);                             // 22 chars
function d1() {
  const db = new Database(":memory:");
  for (const f of ["0001_init.sql", "0022_team_users.sql", "0040_app_handoff.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as D1Database };
}
const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const PUB = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))));
async function mintSso(sub = "example-user") {
  const now = Math.floor(Date.now() / 1000), j = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = j({ alg: "EdDSA", typ: "JWT", kid: "k1" }), p = j({ iss: "auth.internal.invalid", aud: "dev2", sub, iat: now, exp: now + 3600 });
  return `${h}.${p}.${Buffer.from(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(`${h}.${p}`))).toString("base64url")}`;
}
type TestEnv = Env & { _db: Database };
const mkEnv = (over: Record<string, unknown> = {}, flag: string | null = "1"): TestEnv => {
  const x = d1();
  if (flag !== null) x.db.query(`INSERT INTO settings (name, value) VALUES ('desktop_login:main', ?)`).run(flag);
  return {
    SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", E2E_TOKEN,
    SSO_PUBLIC_KEYS: JSON.stringify({ k1: PUB }), SSO_ISSUER: "auth.internal.invalid", SSO_AUDIENCE: "dev2", SSO_AUTH_ORIGIN: "https://auth.internal.invalid", SSO_ALLOWED_LOGINS: "example-user",
    ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, CHAT: {} as never, _db: x.db, ...over,
  } as unknown as TestEnv;
};
const app = createApp();
const cookieOf = (r: Response) => /(__Host-vc_session=[^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
async function ghSession(env: Env, user = "example-user") { const { cookie, session } = await makeSession(env, user, "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; }
async function botSession(env: Env) { const { cookie, session } = await makeSession(env, "e2e-bot", "e2e", E2E_TTL_S); return { cookie: cookie.split(";")[0], csrf: session.csrf }; }
const startUrl = (c: string, st: string, extra = "") => `/auth/app/start?c=${c}&st=${st}${extra}`;
const get = (env: Env, path: string, headers: Record<string, string> = {}) => app.fetch(new Request(ORIGIN + path, { headers }), env);
const NAV = { "sec-fetch-site": "none" };   // a top-level load the app / the OS / the user typed: what the completion page is for
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const approve = (env: Env, a: { cookie?: string; csrf?: string }, fields: Record<string, string>, over: { origin?: string | null } = {}) => {
  const h: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (a.cookie) h.cookie = a.cookie;
  if (over.origin !== null) h.origin = over.origin ?? ORIGIN;
  return app.fetch(new Request(ORIGIN + "/auth/app/approve", { method: "POST", headers: h, body: form({ ...(a.csrf !== undefined ? { csrf: a.csrf } : {}), ...fields }) }), env);
};
const exchange = (env: Env, body: unknown, over: { origin?: string | null; ip?: string } = {}) => {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (over.origin !== null) h.origin = over.origin ?? ORIGIN;
  if (over.ip) h["cf-connecting-ip"] = over.ip;
  return app.fetch(new Request(ORIGIN + "/auth/app/exchange", { method: "POST", headers: h, body: JSON.stringify(body) }), env);
};
const codeFrom = async (r: Response) => { const m = /vertexclient:\/\/auth\/callback\?code=([A-Za-z0-9_-]{43})&amp;st=([A-Za-z0-9_-]{22})/.exec(await r.text()); return m ? { code: m[1], st: m[2] } : null; };
/** Full happy path to a code: returns the code and the verifier the app would hold. */
async function mintCode(env: Env, a: { cookie: string; csrf: string }) {
  const verifier = newVerifier(), c = await challengeOf(verifier), st = stateOf();
  const r = await approve(env, a, { c, st });
  expect(r.status).toBe(200);
  const got = await codeFrom(r);
  expect(got).not.toBeNull();
  return { code: got!.code, st: got!.st, verifier, c };
}

const realLog = console.log, realErr = console.error;
beforeAll(() => { console.log = () => {}; console.error = () => {}; });   // the routes log outcomes; the hygiene test captures them itself
afterAll(() => { console.log = realLog; console.error = realErr; });
let realNow = Date.now;
afterEach(() => { Date.now = realNow; });
const advance = (s: number) => { const base = realNow(); Date.now = () => base + s * 1000; };

describe("PKCE reference vector", () => {
  test("RFC 7636 appendix B: the verifier and challenge the Rust core must reproduce", async () => {
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  test("end to end with the appendix B pair (a 43-char verifier / challenge is exactly the accepted shape)", async () => {
    const env = mkEnv(), a = await ghSession(env);
    const r = await approve(env, a, { c: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", st: stateOf() });
    const { code } = (await codeFrom(r))!;
    expect((await exchange(env, { code, verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" })).status).toBe(200);
  });
});

describe("feature flag", () => {
  test("row absent, '0', or anything but '1': all four routes are a plain 404 (same as an unknown /auth path)", async () => {
    for (const flag of [null, "0", "true", ""]) {
      const env = mkEnv({}, flag), a = await ghSession(env);
      const c = await challengeOf(newVerifier());
      const res = [
        await get(env, startUrl(c, stateOf()), { cookie: a.cookie }),
        await approve(env, a, { c, st: stateOf() }),
        await exchange(env, { code: rnd(32), verifier: newVerifier() }),
        await get(env, "/auth/app/complete"), await get(env, "/auth/app/complete.js"),
      ];
      expect([flag, res.map((r) => r.status)]).toEqual([flag, [404, 404, 404, 404, 404]]);
      expect(await res[0].json()).toEqual({ error: "not found" });
      expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: 0 });
    }
  });
  test("a D1 error reads as OFF", async () => {
    const env = mkEnv(); (env as any).DB = { prepare: () => { throw new Error("boom"); } };
    expect((await get(env, startUrl(await challengeOf(newVerifier()), stateOf()))).status).toBe(404);
  });
  test("turning the row off again closes it without a deploy; the other /auth routes are untouched", async () => {
    const env = mkEnv();
    expect((await get(env, "/auth/app/complete", NAV)).status).toBe(200);
    env._db.query(`UPDATE settings SET value='0' WHERE name='desktop_login:main'`).run();
    expect((await get(env, "/auth/app/complete")).status).toBe(404);
    expect((await get(env, "/auth/config")).status).toBe(200);
  });
});

describe("GET /auth/app/start", () => {
  test("bad challenge / state shape -> 400 plain page, nothing minted", async () => {
    const env = mkEnv(), a = await ghSession(env), c = await challengeOf(newVerifier());
    for (const q of [`c=${c}`, `st=${stateOf()}`, `c=short&st=${stateOf()}`, `c=${c}&st=short`, `c=${c}x&st=${stateOf()}`, `c=${c.slice(0, 42)}!&st=${stateOf()}`, `c=${c}&st=${stateOf()}x`]) {
      const r = await get(env, `/auth/app/start?${q}`, { cookie: a.cookie });
      expect([q, r.status]).toEqual([q, 400]);
    }
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: 0 });
  });
  test("session cookie: consent page naming the user, hidden c/st/csrf, no inline script, no store, no referrer; writes nothing", async () => {
    const env = mkEnv(), a = await ghSession(env), c = await challengeOf(newVerifier()), st = stateOf();
    const r = await get(env, startUrl(c, st), { cookie: a.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const wrapped = withSecurityHeaders(r.clone(), new Request(ORIGIN + startUrl(c, st)));
    expect(wrapped.headers.get("x-frame-options")).toBe("DENY");
    // NOT no-referrer: under that policy the browser sends `Origin: null` on a FORM POST (not on a default-mode fetch) and approve's sameOrigin() would refuse the consent page's own Allow (found by e2e)
    expect(wrapped.headers.get("referrer-policy")).toBe("same-origin");   // global header, added by the production wrapper
    const html = await r.text();
    expect(html).toContain("example-user"); expect(html).toContain(`name="c" value="${c}"`); expect(html).toContain(`name="st" value="${st}"`); expect(html).toContain(`name="csrf" value="${a.csrf}"`);
    expect(html).toContain('action="/auth/app/approve"'); expect(html).not.toContain("<script");
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: 0 });
  });
  test("SSO cookie, no session: ssoExchange sets the session and the same consent page is shown (csrf matches the new session)", async () => {
    const env = mkEnv(), c = await challengeOf(newVerifier()), st = stateOf();
    const r = await get(env, startUrl(c, st), { cookie: `sso=${await mintSso()}` });
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toContain("__Host-vc_session="); expect(sc).toContain("HttpOnly"); expect(sc).toContain("Secure"); expect(sc).toContain("SameSite=Strict");
    const csrf = /name="csrf" value="([0-9a-f]{32})"/.exec(await r.text())![1];
    const s = await readSession(new Request(ORIGIN, { headers: { cookie: cookieOf(r)! } }), env);
    expect(s?.csrf).toBe(csrf);
  });
  test("no session, no SSO: first visit bounces to auth.dev2 with return = this same URL + sso=1 (c and st intact, nothing else added)", async () => {
    const env = mkEnv(), c = await challengeOf(newVerifier()), st = stateOf();
    const r = await get(env, startUrl(c, st));
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin).toBe("https://auth.internal.invalid");
    const back = new URL(loc.searchParams.get("return")!);
    expect(back.origin).toBe(ORIGIN); expect(back.pathname).toBe("/auth/app/start");
    expect(back.searchParams.get("c")).toBe(c); expect(back.searchParams.get("st")).toBe(st); expect(back.searchParams.get("sso")).toBe("1");
    expect([...back.searchParams.keys()].sort()).toEqual(["c", "sso", "st"]);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
  test("came back with sso=1 and still nothing: 401 page, no GitHub fallback, no second bounce", async () => {
    const env = mkEnv(), r = await get(env, startUrl(await challengeOf(newVerifier()), stateOf(), "&sso=1"));
    expect(r.status).toBe(401); expect(r.headers.get("location")).toBeNull();
    expect(await r.text()).toContain("Sign-in did not complete");
  });
  test("SSO cookie for someone not allowlisted: no consent, falls to the bounce / dead end", async () => {
    const env = mkEnv(), r = await get(env, startUrl(await challengeOf(newVerifier()), stateOf(), "&sso=1"), { cookie: `sso=${await mintSso("someone-else")}` });
    expect(r.status).toBe(401);
  });
  test("team session: 403, no consent page", async () => {
    const env = mkEnv({ TEAM_GATEWAY_URL: "https://gw.test" });
    const { cookie } = await makeSession(env, "a@b.co", "team", 3600, "a".repeat(20));
    const r = await get(env, startUrl(await challengeOf(newVerifier()), stateOf()), { cookie: cookie.split(";")[0] });
    expect(r.status).toBe(403); expect(await r.text()).not.toContain('action="/auth/app/approve"');
  });
});

describe("POST /auth/app/approve", () => {
  test("happy path: 200 page with the vertexclient:// link, no-store, no-referrer; the row holds only hashes", async () => {
    const env = mkEnv(), a = await ghSession(env), verifier = newVerifier(), c = await challengeOf(verifier), st = stateOf();
    const r = await approve(env, a, { c, st });
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store"); expect(r.headers.get("location")).toBeNull();
    expect(withSecurityHeaders(r.clone(), new Request(ORIGIN + "/auth/app/approve", { method: "POST" })).headers.get("referrer-policy")).toBe("no-referrer");   // the page carrying the code
    const html = await r.text();
    const { code, st: st2 } = (await codeFrom(new Response(html)))!;
    expect(st2).toBe(st); expect(html).not.toContain("<script");
    const rows = env._db.query(`SELECT * FROM app_handoffs`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows[0]);
    expect(dump).not.toContain(code); expect(dump).not.toContain(verifier);
    expect(rows[0]).toMatchObject({ challenge: c, user: "example-user", via: "github", used_at: null });
    expect(String(rows[0].code_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect((rows[0].expires_at as number) - (rows[0].created_at as number)).toBe(HANDOFF_TTL_S);
  });
  test("each missing requirement is refused and mints nothing: no session 401, no/other/wrong csrf 403, no/other Origin 403, bad shapes 400", async () => {
    const env = mkEnv(), a = await ghSession(env), c = await challengeOf(newVerifier()), st = stateOf();
    const cases: [string, Response, number][] = [
      ["no session", await approve(env, { csrf: a.csrf }, { c, st }), 401],
      ["tampered session", await approve(env, { cookie: a.cookie + "x", csrf: a.csrf }, { c, st }), 401],
      ["no csrf field", await approve(env, { cookie: a.cookie }, { c, st }), 403],
      ["wrong csrf", await approve(env, { cookie: a.cookie, csrf: "0".repeat(32) }, { c, st }), 403],
      ["another session's csrf", await approve(env, { cookie: a.cookie, csrf: (await ghSession(env)).csrf }, { c, st }), 403],
      ["no Origin", await approve(env, a, { c, st }, { origin: null }), 403],
      ["other origin", await approve(env, a, { c, st }, { origin: "https://evil.test" }), 403],
      ["bad challenge", await approve(env, a, { c: "short", st }), 400],
      ["bad state", await approve(env, a, { c, st: "short" }), 400],
      ["missing challenge", await approve(env, a, { st }), 400],
    ];
    for (const [name, r, want] of cases) expect([name, r.status]).toEqual([name, want]);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: 0 });
  });
  test("a GET (or JSON body) on approve is not a mint", async () => {
    const env = mkEnv(), a = await ghSession(env);
    expect((await app.fetch(new Request(ORIGIN + "/auth/app/approve", { headers: { cookie: a.cookie } }), env)).status).toBe(404);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: 0 });
  });
  test("team session: 403 not available, nothing minted (flag on)", async () => {
    const env = mkEnv({ TEAM_GATEWAY_URL: "https://gw.test" });
    const { cookie, session } = await makeSession(env, "a@b.co", "team", 3600, "a".repeat(20));
    const r = await approve(env, { cookie: cookie.split(";")[0], csrf: session.csrf }, { c: await challengeOf(newVerifier()), st: stateOf() });
    expect(r.status).toBe(403); expect(await r.text()).toContain("not available");
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: 0 });
  });
  test("an allowlist-removed user cannot approve (readSession re-checks)", async () => {
    const env = mkEnv(), a = await ghSession(env);
    expect((await approve({ ...env, ALLOWED_GITHUB_LOGINS: "someone-else" } as Env, a, { c: await challengeOf(newVerifier()), st: stateOf() })).status).toBe(401);
  });
  test("cap: at most MAX_OPEN_CODES unused codes per user at once (429), per-user window cap, other users unaffected", async () => {
    const env = mkEnv(), a = await ghSession(env), b = await botSession(env);
    const mk = () => approve(env, a, { c: "A".repeat(43), st: stateOf() });
    for (let i = 0; i < MAX_OPEN_CODES; i++) expect((await mk()).status).toBe(200);
    const r = await mk(); expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await approve(env, b, { c: "A".repeat(43), st: stateOf() })).status).toBe(200);
    // used codes free the open slots but not the window: 5 per user per 10 min
    env._db.query(`UPDATE app_handoffs SET used_at=1`).run();
    for (let i = MAX_OPEN_CODES; i < APPROVE_PER_USER_WINDOW; i++) { expect((await mk()).status).toBe(200); env._db.query(`UPDATE app_handoffs SET used_at=1`).run(); }
    expect((await mk()).status).toBe(429);
    advance(601);   // window passed
    expect((await mk()).status).toBe(200);
  });
  test("e2e-bot is exempt from the 10 min window cap only (many codes per run), never from the open-codes cap", async () => {
    const env = mkEnv(), b = await botSession(env);
    const mk = () => approve(env, b, { c: "A".repeat(43), st: stateOf() });
    for (let i = 0; i < APPROVE_PER_USER_WINDOW + 3; i++) { expect((await mk()).status).toBe(200); env._db.query(`UPDATE app_handoffs SET used_at=1`).run(); }
    for (let i = 0; i < MAX_OPEN_CODES; i++) expect((await mk()).status).toBe(200);
    expect((await mk()).status).toBe(429);
  });
  test("every write sweeps long-dead rows", async () => {
    const env = mkEnv(), a = await ghSession(env);
    env._db.query(`INSERT INTO app_handoffs (code_hash, challenge, user, via, created_at, expires_at, auth_expires_at) VALUES ('old','c','u','github',1,2,2)`).run();
    await approve(env, a, { c: "A".repeat(43), st: stateOf() });
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs WHERE code_hash='old'`).get()).toEqual({ n: 0 });
  });
});

describe("POST /auth/app/exchange", () => {
  test("happy path: 200 {ok:true} + __Host- cookie (HttpOnly; Secure; SameSite=Strict; Path=/); session user = the approving user; csrf works on /api/me", async () => {
    const env = mkEnv(), a = await ghSession(env), m = await mintCode(env, a);
    const r = await exchange(env, { code: m.code, verifier: m.verifier });
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true }); expect(r.headers.get("cache-control")).toBe("no-store");
    const sc = r.headers.get("set-cookie")!;
    expect(sc.startsWith("__Host-vc_session=")).toBe(true);
    for (const f of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(sc).toContain(f);
    expect(sc).not.toContain("Domain=");
    const me = await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: cookieOf(r)! } }), env);
    expect(me.status).toBe(200);
    const j = (await me.json()) as { user: string; via: string; csrf: string };
    expect(j.user).toBe("example-user"); expect(j.via).toBe("github"); expect(j.csrf).toMatch(/^[0-9a-f]{32}$/);
    expect(env._db.query(`SELECT used_at FROM app_handoffs`).get()).not.toEqual({ used_at: null });
  });
  test("the user comes from the row, never the request: extra body fields and a different caller cookie change nothing", async () => {
    const env = mkEnv({ ALLOWED_GITHUB_LOGINS: "example-user,other" }), a = await ghSession(env), m = await mintCode(env, a);
    const other = await ghSession(env, "other");
    const r = await app.fetch(new Request(ORIGIN + "/auth/app/exchange", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: other.cookie }, body: JSON.stringify({ code: m.code, verifier: m.verifier, user: "other", via: "e2e" }) }), env);
    expect(r.status).toBe(200);
    const s = await readSession(new Request(ORIGIN, { headers: { cookie: cookieOf(r)! } }), env);
    expect(s).toMatchObject({ u: "example-user", via: "github" });
  });
  test("single use: the second exchange of the same code is 400", async () => {
    const env = mkEnv(), m = await mintCode(env, await ghSession(env));
    expect((await exchange(env, { code: m.code, verifier: m.verifier })).status).toBe(200);
    expect((await exchange(env, { code: m.code, verifier: m.verifier })).status).toBe(400);
  });
  test("two concurrent exchanges of one code: exactly one 200, one 400, and exactly one cookie", async () => {
    for (let i = 0; i < 10; i++) {
      const env = mkEnv(), m = await mintCode(env, await ghSession(env));
      const rs = await Promise.all([exchange(env, { code: m.code, verifier: m.verifier }), exchange(env, { code: m.code, verifier: m.verifier })]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(rs.filter((r) => r.headers.get("set-cookie")).length).toBe(1);
    }
  });
  test("wrong verifier -> 400 AND the code is burned: the correct verifier afterwards is also 400", async () => {
    const env = mkEnv(), m = await mintCode(env, await ghSession(env));
    expect((await exchange(env, { code: m.code, verifier: newVerifier() })).status).toBe(400);
    expect((await exchange(env, { code: m.code, verifier: m.verifier })).status).toBe(400);
  });
  test("uniform 400: unknown, wrong verifier, used, expired, malformed all give the identical status, headers and body; none sets a cookie", async () => {
    const env = mkEnv(), a = await ghSession(env);
    const used = await mintCode(env, a); await exchange(env, { code: used.code, verifier: used.verifier });
    const wrong = await mintCode(env, a);
    const expired = await mintCode(env, a);
    env._db.query(`UPDATE app_handoffs SET expires_at=created_at WHERE code_hash IN (SELECT code_hash FROM app_handoffs WHERE used_at IS NULL ORDER BY rowid DESC LIMIT 1)`).run();
    const rs = [
      await exchange(env, { code: rnd(32), verifier: newVerifier() }),
      await exchange(env, { code: wrong.code, verifier: newVerifier() }),
      await exchange(env, { code: used.code, verifier: used.verifier }),
      await exchange(env, { code: expired.code, verifier: expired.verifier }),
      await exchange(env, { code: "short", verifier: "short" }),
      await exchange(env, {}),
      await exchange(env, { code: 1, verifier: 2 }),
    ];
    const bodies = await Promise.all(rs.map((r) => r.text()));
    expect(rs.map((r) => r.status)).toEqual(Array(rs.length).fill(400));
    expect(new Set(bodies).size).toBe(1); expect(bodies[0]).toBe('{"error":"invalid or expired code"}');
    expect(new Set(rs.map((r) => r.headers.get("content-type"))).size).toBe(1);
    for (const r of rs) expect(r.headers.get("set-cookie")).toBeNull();
  });
  test("TTL: 59 s after approval ok, 61 s refused (fake clock)", async () => {
    const env = mkEnv(), a = await ghSession(env);
    const m1 = await mintCode(env, a); advance(59);
    expect((await exchange(env, { code: m1.code, verifier: m1.verifier })).status).toBe(200);
    Date.now = realNow;
    const m2 = await mintCode(env, a); advance(61);
    expect((await exchange(env, { code: m2.code, verifier: m2.verifier })).status).toBe(400);
  });
  test("no Origin / another Origin: refused (403) before the code is even looked at, so the code survives", async () => {
    const env = mkEnv(), m = await mintCode(env, await ghSession(env));
    expect((await exchange(env, { code: m.code, verifier: m.verifier }, { origin: null })).status).toBe(403);
    expect((await exchange(env, { code: m.code, verifier: m.verifier }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await exchange(env, { code: m.code, verifier: m.verifier })).status).toBe(200);
  });
  test("failure throttle: per hashed address after EXCHANGE_FAIL_PER_IP misses -> 429 even for a valid code; another address is unaffected; window expiry resets", async () => {
    const env = mkEnv(), m = await mintCode(env, await ghSession(env));
    for (let i = 0; i < EXCHANGE_FAIL_PER_IP; i++) expect((await exchange(env, { code: rnd(32), verifier: newVerifier() }, { ip: "203.0.113.9" })).status).toBe(400);
    const r = await exchange(env, { code: m.code, verifier: m.verifier }, { ip: "203.0.113.9" });
    expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await exchange(env, { code: m.code, verifier: m.verifier }, { ip: "203.0.113.10" })).status).toBe(200);
    advance(601);
    expect((await exchange(env, { code: rnd(32), verifier: newVerifier() }, { ip: "203.0.113.9" })).status).toBe(400);
  });
  test("misses against the e2e-bot's own codes do not feed the throttle (its suite repeats them); the same misses against a github user's codes do", async () => {
    const env = mkEnv(), gh = await ghSession(env), bot = await botSession(env);
    for (let i = 0; i < EXCHANGE_FAIL_PER_IP + 4; i++) {
      const m = await mintCode(env, bot);
      expect((await exchange(env, { code: m.code, verifier: newVerifier() }, { ip: "203.0.113.20" })).status).toBe(400);   // wrong verifier
      expect((await exchange(env, { code: m.code, verifier: m.verifier }, { ip: "203.0.113.20" })).status).toBe(400);      // reuse of a burned code
    }
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoff_fails`).get()).toEqual({ n: 0 });
    for (let i = 0; i < EXCHANGE_FAIL_PER_IP; i++) {
      const m = await mintCode(env, gh);
      expect((await exchange(env, { code: m.code, verifier: newVerifier() }, { ip: "203.0.113.21" })).status).toBe(400);
      env._db.query(`DELETE FROM app_handoffs`).run();   // free the github user's open-code slots for the loop
    }
    const m = await mintCode(env, gh);
    expect((await exchange(env, { code: m.code, verifier: m.verifier }, { ip: "203.0.113.21" })).status).toBe(429);
  });
  test("failure throttle: global ceiling across many addresses", async () => {
    const env = mkEnv();
    const t = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 60; i++) env._db.query(`INSERT INTO app_handoff_fails (ip_hash, at) VALUES (?, ?)`).run("h" + i, t);
    expect((await exchange(env, { code: rnd(32), verifier: newVerifier() }, { ip: "198.51.100.1" })).status).toBe(429);
  });
  // The e2e-bot session is "15 minutes, never refreshed": a handed-off one must expire no later than the session that approved it (absolute expiry, not just a 900 s span).
  const expOf = async (r: Response, env: Env) => (await readSession(new Request(ORIGIN, { headers: { cookie: cookieOf(r)! } }), env))!;
  const botWith = async (env: Env, ttl: number) => { const { cookie, session } = await makeSession(env, "e2e-bot", "e2e", ttl); return { a: { cookie: cookie.split(";")[0], csrf: session.csrf }, exp: session.exp }; };
  test("e2e handoff session: absolute expiry = min(15 min from now, the approving session's expiry); never later than the approver", async () => {
    const env = mkEnv(), { a, exp } = await botWith(env, E2E_TTL_S), m = await mintCode(env, a);
    const r = await exchange(env, { code: m.code, verifier: m.verifier });
    expect(r.status).toBe(200);
    const s = await expOf(r, env);
    expect(s).toMatchObject({ u: "e2e-bot", via: "e2e" });
    expect(s.exp).toBeLessThanOrEqual(exp); expect(s.exp).toBeGreaterThanOrEqual(exp - 2);   // same minute: it IS the approver's expiry (the 15 min cap is never exceeded)
    expect(s.exp - s.iat).toBeLessThanOrEqual(E2E_TTL_S);
  });
  test("delayed exchange (50 s after a 900 s approver): the new session still ends at the approver's expiry, not 15 min after the exchange", async () => {
    const env = mkEnv(), { a, exp } = await botWith(env, E2E_TTL_S), m = await mintCode(env, a);
    advance(50);
    const r = await exchange(env, { code: m.code, verifier: m.verifier });
    expect(r.status).toBe(200);
    const s = await expOf(r, env);
    expect(s.exp).toBeLessThanOrEqual(exp); expect(s.exp - s.iat).toBeLessThanOrEqual(E2E_TTL_S - 49);
  });
  test("chained handoffs cannot renew the e2e session: handoff -> handoff -> handoff, every expiry <= the original approver's", async () => {
    const env = mkEnv(), { a, exp: original } = await botWith(env, 300);
    let cur = a; const exps: number[] = [];
    for (let i = 0; i < 4; i++) {
      advance(20 * (i + 1));
      const m = await mintCode(env, cur);
      const r = await exchange(env, { code: m.code, verifier: m.verifier });
      expect(r.status).toBe(200);
      const s = await expOf(r, env); exps.push(s.exp);
      cur = { cookie: cookieOf(r)!, csrf: s.csrf };
    }
    for (const e of exps) expect(e).toBeLessThanOrEqual(original);
    expect(Math.max(...exps)).toBe(Math.min(...exps));   // every link in the chain ends at the same instant: the original
  });
  test("the approving session expires while its code is still live (30 s session, 40 s later, code ttl 60 s): refused, uniform 400, no cookie, outcome-only log", async () => {
    const env = mkEnv(), { a } = await botWith(env, 30), m = await mintCode(env, a);
    advance(40);
    const lines: string[] = [], ol = console.log; console.log = (...x: unknown[]) => { lines.push(x.map(String).join(" ")); };
    let r: Response; try { r = await exchange(env, { code: m.code, verifier: m.verifier }); } finally { console.log = ol; }
    expect(r.status).toBe(400); expect(await r.text()).toBe('{"error":"invalid or expired code"}'); expect(r.headers.get("set-cookie")).toBeNull();
    expect(lines.join("\n")).toContain("expired-session");
  });
  // Clock edge: the clock advances INSIDE the claim UPDATE (between the exchange's first reading and the minting). Time is a controllable offset here, cumulative across calls.
  const withClockStep = (env: Env, stepS: number, clock: { off: number }) => { const real = env.DB; (env as any).DB = { prepare: (q: string) => { const st = real.prepare(q); return !q.includes("UPDATE app_handoffs SET used_at") ? st : { bind: (...v: unknown[]) => { const b = st.bind(...v); return { run: async () => { const r = await b.run(); clock.off += stepS; return r; } }; } }; } }; return env; };
  const useClock = (clock: { off: number }) => { Date.now = () => realNow() + clock.off * 1000; };
  test("clock advancing 2 s inside the claim does not extend the e2e session past the approver (single exchange, started 10 s before the approver's expiry)", async () => {
    const clock = { off: 0 }, env = withClockStep(mkEnv(), 2, clock), { a, exp } = await botWith(env, 300);
    clock.off = 300 - 10; useClock(clock);   // approve with 10 s of approver life left (the code itself lives 60 s); the claim then eats 2 s
    const m = await mintCode(env, a);
    const r = await exchange(env, { code: m.code, verifier: m.verifier });
    expect(r.status).toBe(200);
    const s = await expOf(r, env);
    expect(s.exp).toBe(exp); expect(s.exp).toBeLessThanOrEqual(exp);
    expect(r.headers.get("set-cookie")).toContain(`Max-Age=${s.exp - s.iat}`);
  });
  test("reviewer's repro: exchange starts 1 s before the approver's expiry and the claim advances 2 s => uniform 400, no cookie (old code minted exp+1)", async () => {
    const clock = { off: 0 }, env = withClockStep(mkEnv(), 2, clock), { a } = await botWith(env, 300);
    clock.off = 300 - 1; useClock(clock);   // approve 1 s before the approver ends
    const m = await mintCode(env, a);
    const r = await exchange(env, { code: m.code, verifier: m.verifier });
    expect(r.status).toBe(400); expect(await r.text()).toBe('{"error":"invalid or expired code"}'); expect(r.headers.get("set-cookie")).toBeNull();
  });
  test("5 chained exchanges, each with a 2 s clock advance inside the claim: the final expiry never exceeds the original approver's", async () => {
    const clock = { off: 0 }, env = withClockStep(mkEnv(), 2, clock), { a, exp: original } = await botWith(env, 300);
    useClock(clock);
    let cur = a; const exps: number[] = [];
    for (let i = 0; i < 5; i++) {
      clock.off += 2;   // the delay between links
      const m = await mintCode(env, cur);
      const r = await exchange(env, { code: m.code, verifier: m.verifier });
      expect(r.status).toBe(200);
      const s = await expOf(r, env); exps.push(s.exp);
      cur = { cookie: cookieOf(r)!, csrf: s.csrf };
    }
    for (const e of exps) expect(e).toBeLessThanOrEqual(original);
    expect(new Set(exps)).toEqual(new Set([original]));
  });
  test("github session keeps the normal 30 day life", async () => {
    const env = mkEnv(), m = await mintCode(env, await ghSession(env));
    const s = await readSession(new Request(ORIGIN, { headers: { cookie: cookieOf(await exchange(env, { code: m.code, verifier: m.verifier }))! } }), env);
    expect(s!.exp - s!.iat).toBe(30 * 24 * 3600);
  });
  test("a login removed from the allowlist between approve and exchange gets nothing; and after exchange the session dies on removal (readSession)", async () => {
    const env = mkEnv(), a = await ghSession(env), m = await mintCode(env, a);
    expect((await exchange({ ...env, ALLOWED_GITHUB_LOGINS: "other" } as Env, { code: m.code, verifier: m.verifier })).status).toBe(400);
    const m2 = await mintCode(env, a);
    const r = await exchange(env, { code: m2.code, verifier: m2.verifier });
    const ck = cookieOf(r)!;
    const probe = (e: Env) => app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: ck } }), e);
    expect((await probe(env)).status).toBe(200);
    expect((await probe({ ...env, ALLOWED_GITHUB_LOGINS: "other" } as Env)).status).toBe(401);
  });
  test("e2e switch removed between approve and exchange: refused", async () => {
    const env = mkEnv(), m = await mintCode(env, await botSession(env));
    expect((await exchange({ ...env, E2E_TOKEN: undefined } as Env, { code: m.code, verifier: m.verifier })).status).toBe(400);
  });
  test("a code approved for challenge A cannot be redeemed with the verifier of B (login-CSRF / foreign code)", async () => {
    const env = mkEnv(), a = await ghSession(env), mine = await mintCode(env, a), foreign = newVerifier();
    expect((await exchange(env, { code: mine.code, verifier: foreign })).status).toBe(400);
  });
  test("a missing table (migration not applied) fails closed: never a session", async () => {
    const env = mkEnv(), m = await mintCode(env, await ghSession(env));
    env._db.exec(`DROP TABLE app_handoff_fails`);
    const r = await exchange(env, { code: m.code, verifier: m.verifier });
    expect(r.status).toBe(503); expect(r.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /auth/app/complete", () => {
  test("static page + script from 'self': no inline script, no secret in either, script under the CSP, no-store", async () => {
    const env = mkEnv(), req0 = new Request(ORIGIN + "/auth/app/complete", { headers: NAV }), r = withSecurityHeaders(await app.fetch(req0, env), req0);   // the production worker wraps every response like this
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<script src="/auth/app/complete.js"></script>'); expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'"); expect(r.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(r.headers.get("cache-control")).toBe("no-store"); expect(r.headers.get("referrer-policy")).toBe("same-origin");   // NOT no-referrer: a default-mode fetch() would still send its real origin, but the policy buys nothing there (see auth-app.ts)
    const jsReq = new Request(ORIGIN + "/auth/app/complete.js", { headers: { "sec-fetch-site": "same-origin" } }), js = withSecurityHeaders(await app.fetch(jsReq, env), jsReq);
    expect(js.status).toBe(200); expect(js.headers.get("content-type")).toContain("javascript"); expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    const src = await js.text();
    expect(src).toContain("replaceState"); expect(src).toContain("/auth/app/exchange"); expect(src).toContain('credentials: "same-origin"');
    expect(src.indexOf("replaceState")).toBeLessThan(src.indexOf("fetch("));   // the fragment is scrubbed before anything is sent
    expect(src).not.toMatch(/localStorage|sessionStorage|console\./);
  });
  test("the fragment is read, scrubbed and exchanged by the shipped script (run against a fake window)", async () => {
    const env = mkEnv(), src = await (await get(env, "/auth/app/complete.js", NAV)).text();
    const calls: any = { replaced: [] as string[], fetched: [] as any[], msg: "", loc: "" };
    const mk = (hash: string, ok: boolean) => {
      calls.replaced = []; calls.fetched = []; calls.msg = ""; calls.loc = "";
      const win: any = {
        location: { hash, pathname: "/auth/app/complete", replace: (u: string) => { calls.loc = u; } },
        history: { replaceState: (_a: unknown, _b: unknown, u: string) => calls.replaced.push(u) },
        document: { getElementById: () => ({ set textContent(v: string) { calls.msg = v; } }) },
        fetch: async (u: string, init: any) => { calls.fetched.push([u, JSON.parse(init.body)]); return { ok }; },
        URLSearchParams,
      };
      new Function(...Object.keys(win), src)(...Object.values(win));
    };
    mk("#code=CODE123&v=VERIFY456", true); await Bun.sleep(0);
    expect(calls.replaced).toEqual(["/auth/app/complete"]); expect(calls.fetched).toEqual([["/auth/app/exchange", { code: "CODE123", verifier: "VERIFY456" }]]); expect(calls.loc).toBe("/");
    mk("#code=CODE123&v=VERIFY456", false); await Bun.sleep(0);
    expect(calls.loc).toBe(""); expect(calls.msg).toContain("did not complete");
    mk("", true); await Bun.sleep(0);
    expect(calls.fetched).toEqual([]); expect(calls.msg).toContain("incomplete");
  });
});

describe("completion page: Fetch Metadata guard (login-CSRF through a foreign navigation)", () => {
  test("only Sec-Fetch-Site none / same-origin get the page and the script; cross-site, same-site (another origin of ours) and a MISSING header are refused 403 (fail closed)", async () => {
    const env = mkEnv();
    for (const path of ["/auth/app/complete", "/auth/app/complete.js"]) {
      for (const site of ["none", "same-origin"]) expect([path, site, (await get(env, path, { "sec-fetch-site": site })).status]).toEqual([path, site, 200]);
      for (const site of ["cross-site", "same-site", "bogus", ""]) {
        const r = await get(env, path, { "sec-fetch-site": site });
        expect([path, site, r.status]).toEqual([path, site, 403]);
        const body = await r.text();
        expect(JSON.parse(body)).toEqual({ error: "untrusted navigation" }); expect(body).not.toContain("<script");
      }
      expect([path, "absent", (await get(env, path)).status]).toEqual([path, "absent", 403]);
    }
  });
  test("a refused navigation spends nothing and changes nothing (no row touched, no cookie)", async () => {
    const env = mkEnv(), m = await mintCode(env, await ghSession(env));
    const r = await get(env, "/auth/app/complete", { "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403); expect(r.headers.get("set-cookie")).toBeNull();
    expect(env._db.query(`SELECT used_at FROM app_handoffs`).get()).toEqual({ used_at: null });
    expect((await exchange(env, { code: m.code, verifier: m.verifier })).status).toBe(200);
  });
  test("exchange (defence in depth): an explicit none / same-site / cross-site is refused and does not spend the code; same-origin and an absent header (non-browser) work", async () => {
    const env = mkEnv(), m = await mintCode(env, await ghSession(env));
    const post = (site: string | null) => app.fetch(new Request(ORIGIN + "/auth/app/exchange", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...(site !== null ? { "sec-fetch-site": site } : {}) }, body: JSON.stringify({ code: m.code, verifier: m.verifier }) }), env);
    for (const site of ["cross-site", "same-site", "none"]) expect([site, (await post(site)).status]).toEqual([site, 403]);
    expect((await post("same-origin")).status).toBe(200);
    const m2 = await mintCode(env, await ghSession(env));
    expect((await exchange(env, { code: m2.code, verifier: m2.verifier })).status).toBe(200);   // no Sec-Fetch-Site at all
  });
  test("speculative loads (Sec-Purpose / legacy Purpose: prefetch, prerender) are refused even with Sec-Fetch-Site: none, for page and script; Vary is set on the served page", async () => {
    const env = mkEnv();
    for (const path of ["/auth/app/complete", "/auth/app/complete.js"]) for (const h of [{ "sec-purpose": "prefetch" }, { "sec-purpose": "prefetch;prerender" }, { "sec-purpose": "prerender" }, { purpose: "prefetch" }, { "sec-purpose": "Prefetch" }] as Record<string, string>[]) {
      for (const site of ["none", "same-origin"]) {
        const r = await get(env, path, { "sec-fetch-site": site, ...h });
        const body = await r.text();
        expect([path, site, JSON.stringify(h), r.status]).toEqual([path, site, JSON.stringify(h), 403]);
        expect(body).not.toContain("<script"); expect(JSON.parse(body)).toEqual({ error: "untrusted navigation" });
      }
    }
    const ok = await get(env, "/auth/app/complete", NAV);
    expect(ok.status).toBe(200); expect(ok.headers.get("vary")).toContain("Sec-Purpose"); expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await get(env, "/auth/app/complete", { ...NAV, "sec-purpose": "" })).status).toBe(200);   // an empty header is not speculation
  });
  test("log line of a refusal carries the outcome only", async () => {
    const lines: string[] = [], ol = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try { await get(mkEnv(), "/auth/app/complete", { "sec-fetch-site": "cross-site" }); } finally { console.log = ol; }
    expect(lines).toEqual([JSON.stringify({ evt: "app_handoff", step: "complete", ok: false, why: "untrusted-navigation" })]);
  });
});

describe("races and malformed bodies", () => {
  test("concurrent approvals cannot exceed the open-code cap (10 at once => exactly MAX_OPEN_CODES x 200, the rest 429)", async () => {
    const env = mkEnv(), a = await ghSession(env);
    const rs = await Promise.all(Array.from({ length: 10 }, () => approve(env, a, { c: "A".repeat(43), st: stateOf() })));
    expect(rs.filter((r) => r.status === 200).length).toBe(MAX_OPEN_CODES); expect(rs.filter((r) => r.status === 429).length).toBe(10 - MAX_OPEN_CODES);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: MAX_OPEN_CODES });
  });
  test("concurrent approvals cannot exceed the window cap either (codes used as they go, 12 concurrent rounds of 3)", async () => {
    const env = mkEnv(), a = await ghSession(env); let ok = 0;
    for (let i = 0; i < 12; i++) { const rs = await Promise.all([1, 2, 3].map(() => approve(env, a, { c: "A".repeat(43), st: stateOf() }))); ok += rs.filter((r) => r.status === 200).length; env._db.query(`UPDATE app_handoffs SET used_at=1`).run(); }
    expect(ok).toBe(APPROVE_PER_USER_WINDOW); expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: APPROVE_PER_USER_WINDOW });
  });
  test("e2e-bot concurrent approvals: still no window cap, still the open cap", async () => {
    const env = mkEnv(), b = await botSession(env);
    const rs = await Promise.all(Array.from({ length: 8 }, () => approve(env, b, { c: "A".repeat(43), st: stateOf() })));
    expect(rs.filter((r) => r.status === 200).length).toBe(MAX_OPEN_CODES);
  });
  test("100 concurrent unknown-code exchanges from one address record at most EXCHANGE_FAIL_PER_IP failures; the rest are 429 (not 100 x 400)", async () => {
    const env = mkEnv();
    const rs = await Promise.all(Array.from({ length: 100 }, () => exchange(env, { code: rnd(32), verifier: newVerifier() }, { ip: "203.0.113.9" })));
    const by = (n: number) => rs.filter((r) => r.status === n).length;
    expect(by(400)).toBe(EXCHANGE_FAIL_PER_IP); expect(by(429)).toBe(100 - EXCHANGE_FAIL_PER_IP);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoff_fails`).get()).toEqual({ n: EXCHANGE_FAIL_PER_IP });
  });
  test("the global failure budget holds under concurrency across many addresses", async () => {
    const env = mkEnv();
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => exchange(env, { code: rnd(32), verifier: newVerifier() }, { ip: `198.51.100.${i}` })));
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoff_fails`).get()).toEqual({ n: 60 }); expect(rs.filter((r) => r.status === 400).length).toBe(60);
  });
  test("null / array / scalar / empty / non-JSON bodies: the uniform 400, counted toward the throttle, never a cookie or a 500", async () => {
    const env = mkEnv();
    let n = 0;   // a distinct address each, so the 8-per-address budget does not turn the 9th into a 429
    const send = (raw: string) => app.fetch(new Request(ORIGIN + "/auth/app/exchange", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": `192.0.2.${++n}` }, body: raw }), env);
    const bodies = ["null", "[]", "[1,2]", "7", '"x"', "true", "", "{not json", "{}"];
    for (const raw of bodies) {
      const r = await send(raw);
      expect([raw, r.status, await r.text()]).toEqual([raw, 400, '{"error":"invalid or expired code"}']);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoff_fails`).get()).toEqual({ n: bodies.length });
  });
  test("approve with a JSON null / non-form body is refused cleanly (403 csrf), never a 500", async () => {
    const env = mkEnv(), a = await ghSession(env);
    for (const raw of ["null", "[]", ""]) {
      const r = await app.fetch(new Request(ORIGIN + "/auth/app/approve", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: a.cookie }, body: raw }), env);
      expect([raw, r.status]).toEqual([raw, 403]);
    }
  });
});

describe("body limit and failure-write errors", () => {
  const BIG = 4096;
  const rawPost = (env: Env, path: string, body: string, headers: Record<string, string> = {}) => app.fetch(new Request(ORIGIN + path, { method: "POST", headers: { origin: ORIGIN, ...headers }, body }), env);
  const jsonBody = (n: number) => { const base = JSON.stringify({ code: "x", pad: "" }); return JSON.stringify({ code: "x", pad: "a".repeat(n - base.length) }); };
  test("exchange: over the limit => 413 with and without Content-Length (and with a lying small one); exactly at the limit is parsed (uniform 400, counted)", async () => {
    const env = mkEnv(); const j = { "content-type": "application/json" };
    const big = jsonBody(BIG + 1), at = jsonBody(BIG);
    expect(new TextEncoder().encode(big).length).toBe(BIG + 1); expect(new TextEncoder().encode(at).length).toBe(BIG);
    for (const [name, h] of [["no content-length", {}], ["honest content-length", { "content-length": String(BIG + 1) }], ["lying content-length", { "content-length": "10" }]] as const) {
      const r = await rawPost(env, "/auth/app/exchange", big, { ...j, ...h });
      expect([name, r.status, await r.text()]).toEqual([name, 413, '{"error":"request too large"}']);
    }
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoff_fails`).get()).toEqual({ n: 0 });   // refused before any parsing or counting
    const r = await rawPost(env, "/auth/app/exchange", at, j);
    expect(r.status).toBe(400); expect(await r.text()).toBe('{"error":"invalid or expired code"}');
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoff_fails`).get()).toEqual({ n: 1 });   // a counted failure still happens under the limit
  });
  test("an oversized chunked/streamed body with no length at all is cut off too", async () => {
    const env = mkEnv();
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(1024).fill(97)); c.close(); } });
    const r = await app.fetch(new Request(ORIGIN + "/auth/app/exchange", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit), env);
    expect(r.status).toBe(413);
  });
  test("approve: over the limit => 413 (with/without Content-Length), exactly at the limit still works", async () => {
    const env = mkEnv(), a = await ghSession(env), c = await challengeOf(newVerifier()), st = stateOf();
    const mk = (n: number) => { const base = form({ csrf: a.csrf, c, st, pad: "" }); return base + "a".repeat(n - base.length); };
    const h = { "content-type": "application/x-www-form-urlencoded", cookie: a.cookie };
    expect((await rawPost(env, "/auth/app/approve", mk(BIG + 1), h)).status).toBe(413);
    expect((await rawPost(env, "/auth/app/approve", mk(BIG + 1), { ...h, "content-length": String(BIG + 1) })).status).toBe(413);
    expect((await rawPost(env, "/auth/app/approve", mk(BIG + 1), { ...h, "content-length": "10" })).status).toBe(413);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: 0 });
    expect((await rawPost(env, "/auth/app/approve", mk(BIG), h)).status).toBe(200);
  });
  test("a body stream that errors (AbortError) mid-read: controlled non-cacheable 400 `invalid request body`, no cookie, outcome-only log (no error text), both endpoints", async () => {
    const env = mkEnv(), a = await ghSession(env);
    const failing = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{")); c.error(new DOMException("SECRET-ABORT-TEXT", "AbortError")); } });
    const lines: string[] = [], ol = console.log, oe = console.error;
    console.log = (...x: unknown[]) => { lines.push(x.map(String).join(" ")); }; console.error = (...x: unknown[]) => { lines.push(x.map(String).join(" ")); };
    const rs: Response[] = [];
    try {
      rs.push(await app.fetch(new Request(ORIGIN + "/auth/app/exchange", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: failing(), duplex: "half" } as RequestInit), env));
      rs.push(await app.fetch(new Request(ORIGIN + "/auth/app/approve", { method: "POST", headers: { origin: ORIGIN, cookie: a.cookie, "content-type": "application/x-www-form-urlencoded" }, body: failing(), duplex: "half" } as RequestInit), env));
    } finally { console.log = ol; console.error = oe; }
    for (const r of rs) { expect(r.status).toBe(400); expect(await r.text()).toBe('{"error":"invalid request body"}'); expect(r.headers.get("cache-control")).toBe("no-store"); expect(r.headers.get("set-cookie")).toBeNull(); }
    expect(lines.length).toBe(2); for (const l of lines) expect(JSON.parse(l)).toMatchObject({ evt: "app_handoff", ok: false, why: "body-read" });
    expect(lines.join("\n")).not.toContain("SECRET-ABORT-TEXT");
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: 0 });
  });
  test("flag off: an oversized body is still a plain 404 (the limit sits inside the enabled-route gate)", async () => {
    const env = mkEnv({}, null);
    expect((await rawPost(env, "/auth/app/exchange", jsonBody(BIG + 1), { "content-type": "application/json" })).status).toBe(404);
    expect((await rawPost(env, "/auth/app/approve", "a".repeat(BIG + 1), { "content-type": "application/x-www-form-urlencoded" })).status).toBe(404);
  });
  test("a failing failure-INSERT (and only it) gives the controlled non-cacheable 503 on every counted-miss branch, never a 500", async () => {
    const mkBroken = () => { const env = mkEnv(); const real = env.DB; (env as any).DB = { prepare: (q: string) => (q.includes("INSERT INTO app_handoff_fails") ? { bind: () => ({ run: async () => { throw new Error("D1 down"); } }) } : real.prepare(q)) }; return env; };
    const check = (name: string, r: Response) => { expect([name, r.status]).toEqual([name, 503]); expect(r.headers.get("cache-control")).toBe("no-store"); expect(r.headers.get("set-cookie")).toBeNull(); };
    let env = mkBroken();
    check("shape", await exchange(env, { code: "x", verifier: "y" }));
    check("unknown", await exchange(env, { code: rnd(32), verifier: newVerifier() }));
    env = mkBroken(); let m = await mintCode(env, await ghSession(env));
    check("verifier", await exchange(env, { code: m.code, verifier: newVerifier() }));
    env = mkBroken(); m = await mintCode(env, await ghSession(env)); env._db.query(`UPDATE app_handoffs SET expires_at=created_at`).run();
    check("dead", await exchange(env, { code: m.code, verifier: m.verifier }));
    env = mkBroken(); m = await mintCode(env, await ghSession(env));
    check("revoked", await exchange({ ...env, ALLOWED_GITHUB_LOGINS: "other" } as Env, { code: m.code, verifier: m.verifier }));
    env = mkBroken(); m = await mintCode(env, await ghSession(env));
    const rs = await Promise.all([exchange(env, { code: m.code, verifier: m.verifier }), exchange(env, { code: m.code, verifier: m.verifier })]);   // the loser hits the "claimed" branch
    expect(rs.map((r) => r.status).sort()).toEqual([200, 503]);
    check("claimed", rs.find((r) => r.status === 503)!);
  });
});

describe("hygiene and routing", () => {
  test("log lines of the new routes never contain a code, verifier, csrf or session value", async () => {
    const lines: string[] = [], ol = console.log, oe = console.error;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); }; console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    let m: Awaited<ReturnType<typeof mintCode>>, a: { cookie: string; csrf: string };
    try {
      const env = mkEnv(); a = await ghSession(env); m = await mintCode(env, a);
      await exchange(env, { code: m.code, verifier: newVerifier() });           // miss
      const m2 = await mintCode(env, a);
      await exchange(env, { code: m2.code, verifier: m2.verifier });            // hit
      await get(env, startUrl(m.c, m.st), { cookie: a.cookie });
      expect(lines.some((l) => l.includes("app_handoff"))).toBe(true);
      const all = lines.join("\n");
      for (const s of [m.code, m.verifier, m2.code, m2.verifier, a.csrf, a.cookie.split("=")[1]]) expect(all).not.toContain(s);
    } finally { console.log = ol; console.error = oe; }
  });
  test("the routes sit before the /auth/* 404: with the flag on the paths are not 404; other unknown /auth paths still are", async () => {
    const env = mkEnv();
    expect((await get(env, "/auth/app/nope")).status).toBe(404);
    expect((await get(env, "/auth/app/complete", NAV)).status).toBe(200);
    expect((await get(env, "/auth/whatever")).status).toBe(404);
  });
  test("migration 0040 is additive and idempotent, and was the next number after 0039", async () => {
    const sql = readFileSync(new URL("../migrations/0040_app_handoff.sql", import.meta.url), "utf8");
    expect(sql.replace(/^--.*$/gm, "")).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i);
    for (const m of sql.matchAll(/CREATE (TABLE|INDEX)\s+(?!IF NOT EXISTS)/g)) throw new Error("not idempotent: " + m[0]);
    const db = new Database(":memory:"); db.exec(sql); db.exec(sql);
    const { readdirSync } = await import("node:fs");
    const nums = readdirSync(new URL("../migrations/", import.meta.url)).map((f) => Number(f.slice(0, 4)));
    expect(Math.max(...nums)).toBe(45); // feat2 2026-11-06: was 44; 0045_feature_audit.sql is an additive new table (no code writes it yet). Earlier: Correction 2026-11-05: was 43; 0044_device_space.sql (per-device space, vclspace1) is additive ALTER ADD COLUMN, covered by test-cf/vclspace1.test.ts. Earlier 2026-11-04: was 42; 0043_term_audit.sql (device terminal audit, vclterm3) is an additive new table with its own tests in device-term.test.ts. Earlier: 2026-11-03: was 42: was 41 (and 40 before that); 0042_conversation_env.sql (devices v2 step 3) is additive ALTER ADD COLUMN on conversations, checked by its own test in device-env.test.ts. Earlier note: 0041 was 0041_device_identity.sql (devices v2 step 2) is the next one and is additive ALTER ADD COLUMN, checked by its own test in devices-core.test.ts
  });
  test("SESSION_COOKIE name unchanged", () => { expect(SESSION_COOKIE).toBe("__Host-vc_session"); });
});

// conv5 (b-merge): Desktop/Remote sign-in for an owner team session (own === true, email in OWNER_EMAILS); every other team session stays refused.
describe("conv5 owner on desktop sign-in", () => {
  const OWNER = "boss@team.co", UID = "a".repeat(20);
  const tenv = (over: Record<string, unknown> = {}) => {
    const env = mkEnv({ TEAM_GATEWAY_URL: "https://gw.test", OWNER_EMAILS: OWNER, ...over });
    env._db.query(`INSERT INTO team_users (uid, gateway_uid, email, status, created_at, last_login_at) VALUES (?,?,?,'active',1,1)`).run(UID, "g1", OWNER);
    return env;
  };
  const teamSess = async (env: Env, email = OWNER, own = true) => { const { cookie, session } = await makeSession(env, email, "team", 3600, UID, own); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
  const startAs = async (env: Env, a: { cookie: string }) => get(env, startUrl(await challengeOf(newVerifier()), stateOf()), { cookie: a.cookie });
  test("owner: consent page; guest (no own): 403; email not listed: dead session, bounce to sign-in (302)", async () => {
    const env = tenv();
    const r = await startAs(env, await teamSess(env)); expect(r.status).toBe(200); expect(await r.text()).toContain('action="/auth/app/approve"');
    const g = await startAs(env, await teamSess(env, "guest@team.co", false)); expect(g.status).toBe(403);
    const gg = await startAs(env, await teamSess(env, OWNER, false)); expect(gg.status).toBe(403);   // same email but no own flag
    const gone = await startAs({ ...env, OWNER_EMAILS: "other@team.co" } as Env, await teamSess(env)); expect(gone.status).toBe(302);
  });
  test("forged own flag (cookie not signed by us) is refused", async () => {
    const env = tenv(), a = await teamSess(env), [b, sig] = a.cookie.split("=")[1].split(".");
    const forged = JSON.parse(Buffer.from(b, "base64url").toString()); forged.u = "guest@team.co";
    const fc = `__Host-vc_session=${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    expect((await startAs(env, { cookie: fc })).status).toBe(302);
  });
  test("full flow: approve -> exchange mints a team owner session (uid from team_users) that reads as owner", async () => {
    const env = tenv(), a = await teamSess(env), { code, verifier } = await mintCode(env, a);
    const r = await exchange(env, { code, verifier }); expect(r.status).toBe(200);
    const ck = cookieOf(r)!; expect(ck).toBeTruthy();
    const s = await readSession(new Request(ORIGIN + "/api/me", { headers: { cookie: ck } }), env);
    expect(s).toMatchObject({ u: OWNER, via: "team", uid: UID, own: true });
  });
  test("exchange re-checks: email removed from OWNER_EMAILS / team user disabled / not team-configured => 400, nothing minted", async () => {
    for (const mut of [(e: any) => ({ ...e, OWNER_EMAILS: "other@team.co" }), (e: any) => { e._db.query(`UPDATE team_users SET status='disabled'`).run(); return e; }, (e: any) => ({ ...e, TEAM_GATEWAY_URL: undefined })]) {
      const env = tenv(), a = await teamSess(env), { code, verifier } = await mintCode(env, a);
      const r = await exchange(mut(env) as Env, { code, verifier }); expect(r.status).toBe(400); expect(cookieOf(r)).toBeUndefined();
    }
  });
  test("guest approve still refused (403, no row); forged row via=team for a non-owner email gets nothing", async () => {
    const env = tenv(), g = await teamSess(env, "guest@team.co", false);
    expect((await approve(env, g, { c: await challengeOf(newVerifier()), st: stateOf() })).status).toBe(403);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM app_handoffs`).get()).toEqual({ n: 0 });
    env._db.query(`INSERT INTO team_users (uid, gateway_uid, email, status, created_at, last_login_at) VALUES (?,?,?,'active',1,1)`).run("b".repeat(20), "g2", "guest@team.co");
    const v = newVerifier(), code = rnd(32), codeHash = async (c: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`vcl-app-handoff:${c}`))).toString("hex");
    {
      env._db.query(`INSERT INTO app_handoffs (code_hash, challenge, user, via, created_at, expires_at, auth_expires_at) VALUES (?,?,?,?,?,?,?)`).run(await codeHash(code), await challengeOf(v), "guest@team.co", "team", Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 60, Math.floor(Date.now() / 1000) + 600);
      expect((await exchange(env, { code, verifier: v })).status).toBe(400);
    }
  });
  test("personal edition unchanged: no TEAM_GATEWAY_URL => an own team cookie is dead; github still works", async () => {
    const env = tenv(), a = await teamSess(env);
    expect((await startAs({ ...env, TEAM_GATEWAY_URL: undefined } as Env, a)).status).toBe(302);
    const gh = await ghSession(env), { code, verifier } = await mintCode(env, gh);
    const r = await exchange(env, { code, verifier }); expect(r.status).toBe(200);
    expect(await readSession(new Request(ORIGIN + "/x", { headers: { cookie: cookieOf(r)! } }), env)).toMatchObject({ via: "github" });
  });
  // conv5fix: a handoff keeps the approver's ORIGINAL login time and never outlives the approving session.
  const aged = async (env: Env, latAgo: number, expIn: number) => {
    const now = Math.floor(Date.now() / 1000), session = { u: OWNER, csrf: "c".repeat(32), iat: now, lat: now - latAgo, exp: now + expIn, via: "team" as const, uid: UID, own: true as const };
    return { cookie: `__Host-vc_session=${await signSession(env, session)}`, csrf: session.csrf, session };
  };
  const hop = async (env: Env, a: { cookie: string; csrf: string }) => { const m = await mintCode(env, a), r = await exchange(env, { code: m.code, verifier: m.verifier }); return { r, ck: cookieOf(r) }; };
  const readS = (env: Env, ck: string) => readSession(new Request(ORIGIN + "/x", { headers: { cookie: ck } }), env);
  test("day-old approver: handed-off session keeps lat (not refreshed), fresh csrf, exp <= approver exp", async () => {
    const env = tenv(), a = await aged(env, 86400, 3000), { r, ck } = await hop(env, a); expect(r.status).toBe(200);
    const s = (await readS(env, ck!))!;
    expect(s.lat).toBe(a.session.lat); expect(s.csrf).not.toBe(a.csrf); expect(s.exp).toBeLessThanOrEqual(a.session.exp); expect(s).toMatchObject({ u: OWNER, via: "team", uid: UID, own: true });
    expect(Math.floor(Date.now() / 1000) - s.lat!).toBeGreaterThanOrEqual(86400);   // the terminal's 12 h freshness check still refuses it
  });
  test("chained handoff keeps the original lat and cannot outlive the first approver", async () => {
    const env = tenv(), a = await aged(env, 43200, 600), h1 = await hop(env, a), s1 = (await readS(env, h1.ck!))!;
    const h2 = await hop(env, { cookie: h1.ck!, csrf: s1.csrf }), s2 = (await readS(env, h2.ck!))!;
    expect(h2.r.status).toBe(200); expect(s2.lat).toBe(a.session.lat); expect(s2.exp).toBeLessThanOrEqual(a.session.exp);
  });
  test("expired approver: exchange refused (400), no cookie", async () => {
    const env = tenv(), a = await aged(env, 100, 3600), m = await mintCode(env, a);
    env._db.query(`UPDATE app_handoffs SET auth_expires_at=?`).run(Math.floor(Date.now() / 1000) - 1);
    const r = await exchange(env, { code: m.code, verifier: m.verifier }); expect(r.status).toBe(400); expect(cookieOf(r)).toBeUndefined();
  });
  test("legacy row via='team' (no lat) => lat 0 (not fresh); personal github handoff row still via='github'", async () => {
    const env = tenv(), a = await teamSess(env), m = await mintCode(env, a);
    env._db.query(`UPDATE app_handoffs SET via='team'`).run();
    expect((await readS(env, cookieOf(await exchange(env, { code: m.code, verifier: m.verifier }))!))!.lat).toBe(0);
    const gh = await ghSession(env); await mintCode(env, gh);
    expect(env._db.query(`SELECT via FROM app_handoffs WHERE user='example-user'`).get()).toEqual({ via: "github" });
  });
});
