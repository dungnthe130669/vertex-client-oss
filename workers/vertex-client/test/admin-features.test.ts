// Team instance (`vertex-client-team`): login via a gateway-signed assertion, g:<uid> scope, act-as provider, entitlement cache (fail closed), and the
// isolation matrix run with REAL team sessions (minted through /auth/team/callback, not through the P0 test seam). FAKE keys only: every Ed25519 pair is
// generated here. Real SQL (bun:sqlite + the real migrations incl. 0022) behind a D1 shim; the "gateway" is a recording fake fetch.
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession, readSession, SESSION_COOKIE, signSession, TEAM_SESSION_TTL_S } from "../src/auth";
import { d1Index } from "../src/index-d1";
import { GUEST_CEILING, scopeOfSession, turnCapFor, type GuestScope } from "../src/scope";
import { setOpenFlag } from "../src/open-space";
import { TEAM_STATE_COOKIE, teamUidFor, verifyAssertion } from "../src/team-auth";
import { ENTITLEMENT_TTL_MS, clearEntitlementCache, teamFeatures, teamGatewayProvider } from "../src/providers/team-gateway";
import { ProviderError } from "../src/providers/types";
import { chatMock } from "./do-mock";

const ORIGIN = "https://app.test";
const GW = "https://tg.test";
const b64u = (b: ArrayBuffer | Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const now = () => Math.floor(Date.now() / 1000);

async function keypair(kid: string) {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const x = ((await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey).x!;
  return { kid, priv: kp.privateKey, jwks: JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid, x, alg: "EdDSA", use: "sig" }] }) };
}
const KEY = await keypair("k1");
const OTHER = await keypair("k1"); // same kid, different key: a forged signature
const JTI = (() => { let n = 0; return () => `jti-${Date.now()}-${++n}-abcdef`; })();
async function assertion(over: Record<string, unknown> = {}, o: { key?: typeof KEY; header?: Record<string, unknown> } = {}) {
  const t = now();
  const claims = { iss: "vertex-team-gateway", aud: ORIGIN, sub: "ann@example.com", uid: "gw-user-ann", features: ["vclient_app", "chat", "image_gen"], jti: JTI(), iat: t, exp: t + 60, ...over };
  const h = b64u(JSON.stringify({ alg: "EdDSA", kid: (o.key ?? KEY).kid, typ: "JWT", ...o.header })), p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, (o.key ?? KEY).priv, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as unknown as D1Database };
}

const gw = { features: {} as Record<string, string[]> };
const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const u = new URL(String(input)); const h = new Headers(init.headers); const who = h.get("x-act-as") ?? "";
  if (u.pathname === "/v1/entitlements") return gw.features[who] ? Response.json({ features: gw.features[who] }) : new Response("{}", { status: 403 });
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;
const app = createApp({ fetchImpl: fakeFetch });
const OWNER = "boss@example.com";
const mkEnv = (extra: Record<string, unknown> = {}) => {
  const x = d1();
  const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "K", E2E_TOKEN: "e".repeat(40), OWNER_EMAILS: OWNER,
    TEAM_GATEWAY_URL: GW, TEAM_ORIGIN: ORIGIN, TEAM_JWKS: KEY.jwks, VCLIENT_TEAM_CALLER_KEY: "C",
    ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => Response.json({ data: [] }) }, FILES: {}, DB: x.d1, _db: x.db, ...extra };
  e.CHAT = chatMock(() => e.FILES, () => {});
  return e as Env & { _db: Database };
};
type Who = { cookie: string; csrf: string };
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]!).find((c) => c.startsWith(name + "="));
async function teamLogin(env: Env, sub: string, uid: string): Promise<Who> {
  gw.features[sub] = ["vclient_app", "chat"];
  const state = "s".repeat(32);
  const r = await app.fetch(new Request(`${ORIGIN}/auth/team/callback?assertion=${encodeURIComponent(await assertion({ sub, uid, features: ["vclient_app", "chat"] }))}&state=${state}`, { headers: { cookie: `${TEAM_STATE_COOKIE}=${state}` } }), env);
  if (r.status !== 302) throw new Error("login " + r.status);
  const cookie = cookieOf(r, SESSION_COOKIE)!;
  const me = (await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json()) as any;
  return { cookie, csrf: me.csrf };
}
const github = async (env: Env, user = "example-user"): Promise<Who> => { const { cookie, session } = await makeSession(env, user, "github"); return { cookie: cookie.split(";")[0]!, csrf: session.csrf }; };
const e2e = async (env: Env): Promise<Who> => { const { cookie, session } = await makeSession(env, "e2e-bot", "e2e", 600); return { cookie: cookie.split(";")[0]!, csrf: session.csrf }; };
const call = (env: Env, w: Who | null, method: string, path: string, body?: unknown, o: { csrf?: string | null; origin?: string | null } = {}) => {
  const h = new Headers();
  if (w) h.set("cookie", w.cookie);
  if (o.origin !== null) h.set("origin", o.origin ?? ORIGIN);
  if (method !== "GET") { const c = o.csrf === undefined ? w?.csrf : o.csrf; if (c) h.set("x-csrf-token", c); h.set("content-type", "application/json"); }
  return app.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env);
};
const P = (env: Env, w: Who | null, body: unknown, o?: Parameters<typeof call>[5]) => call(env, w, "POST", "/api/admin/features", body, o);
const rows = (env: { _db: Database }, like = "unlock:%") => env._db.query(`SELECT name, value FROM settings WHERE name LIKE ? ORDER BY name`).all(like) as Array<{ name: string; value: string }>;
const audit = (env: { _db: Database }) => env._db.query(`SELECT * FROM feature_audit ORDER BY id`).all() as any[];
const U = { class: "g", feature: "devices", unlocked: true };
const ownerTeam = (env: Env) => teamLogin(env, OWNER, "b".repeat(24));

describe("feat3 admin features: who may call", () => {
  test("unauthenticated => 401 on GET and POST", async () => {
    const env = mkEnv();
    expect((await call(env, null, "GET", "/api/admin/features")).status).toBe(401);
    expect((await P(env, null, U)).status).toBe(401);
    expect(rows(env)).toEqual([]);
  });
  test("team guest => 403 on GET and POST; e2e => 403; nothing written", async () => {
    const env = mkEnv();
    const g = await teamLogin(env, "ann@example.com", "a".repeat(24));
    const e = await e2e(env);
    for (const w of [g, e]) { expect((await call(env, w, "GET", "/api/admin/features")).status).toBe(403); expect((await P(env, w, U)).status).toBe(403); }
    expect(rows(env)).toEqual([]); expect(audit(env)).toEqual([]);
  });
  test("forged own flag on a guest cookie is rejected by the HMAC; own=true with a non-owner email is rejected", async () => {
    const env = mkEnv();
    const g = await teamLogin(env, "ann@example.com", "a".repeat(24));
    const [body, sig] = g.cookie.split("=")[1]!.split(".");
    const forged = b64u(JSON.stringify({ ...JSON.parse(atob(body!.replace(/-/g, "+").replace(/_/g, "/"))), own: true }));
    expect((await P(env, { cookie: `${SESSION_COOKIE}=${forged}.${sig}`, csrf: g.csrf }, U)).status).toBe(401);
    const { session } = await makeSession(env, "ann@example.com", "team", TEAM_SESSION_TTL_S, "a".repeat(24));
    const c2 = `${SESSION_COOKIE}=${await signSession(env, { ...session, own: true } as never)}`;
    expect((await P(env, { cookie: c2, csrf: session.csrf }, U)).status).toBe(401);
    expect(rows(env)).toEqual([]);
  });
  test("owner removed from OWNER_EMAILS loses access at once (and a github login removed from the allowlist)", async () => {
    const env = mkEnv();
    const o = await ownerTeam(env); const gh = await github(env);
    expect((await call(env, o, "GET", "/api/admin/features")).status).toBe(200);
    for (const w of [o, gh]) {
      expect((await P({ ...env, OWNER_EMAILS: "", ALLOWED_GITHUB_LOGINS: "someone" } as Env, w, U)).status).toBe(401);
    }
    expect(rows(env)).toEqual([]);
  });
  test("team owner and personal-edition main github session both work", async () => {
    const env = mkEnv({ DEVICES: {} });
    const o = await ownerTeam(env); const gh = await github(env);
    expect((await P(env, o, U)).status).toBe(200);
    const env2 = mkEnv({ TEAM_GATEWAY_URL: undefined });
    expect((await call(env2, await github(env2), "GET", "/api/admin/features")).status).toBe(200);
    expect((await P(env, gh, { class: "o", feature: "devices", unlocked: true })).status).toBe(200);
  });
  test("a github login that is not allow-listed gets 401, not access", async () => {
    const env = mkEnv();
    const bad = await github(env, "intruder");
    expect((await call(env, bad, "GET", "/api/admin/features")).status).toBe(401);
  });
});

describe("feat3 admin features: CSRF / origin / validation", () => {
  test("missing, wrong CSRF and cross-origin / missing Origin => 403, nothing written", async () => {
    const env = mkEnv(); const o = await ownerTeam(env);
    expect((await P(env, o, U, { csrf: null })).status).toBe(403);
    expect((await P(env, o, U, { csrf: "0".repeat(32) })).status).toBe(403);
    expect((await P(env, o, U, { origin: "https://evil.test" })).status).toBe(403);
    expect((await P(env, o, U, { origin: null })).status).toBe(403);
    expect(rows(env)).toEqual([]); expect(audit(env)).toEqual([]);
  });
  test("bad class / feature / types / extra fields / non-json / arrays => 400, nothing written", async () => {
    const env = mkEnv(); const o = await ownerTeam(env);
    const bad: unknown[] = [
      { class: "x", feature: "devices", unlocked: true }, { class: "G", feature: "devices", unlocked: true }, { class: ["g"], feature: "devices", unlocked: true }, { feature: "devices", unlocked: true },
      { class: "g", feature: "nope", unlocked: true }, { class: "g", feature: "devices%", unlocked: true }, { class: "g", feature: 5, unlocked: true }, { class: "g", unlocked: true },
      { class: "g", feature: "devices", unlocked: "true" }, { class: "g", feature: "devices", unlocked: 1 }, { class: "g", feature: "devices" }, { class: "g", feature: "devices", unlocked: null },
      { ...U, name: "cap:g:devices" }, { ...U, value: "0" }, [], null, "{not json", "7",
    ];
    for (const b of bad) expect((await P(env, o, b)).status).toBe(400);
    // connectors only applies to class m
    expect((await P(env, o, { class: "g", feature: "connectors", unlocked: true })).status).toBe(400);
    expect(rows(env, "%")).toEqual([]); expect(audit(env)).toEqual([]);
  });
  test("unlock without its binding => 409 and nothing written; lock of a stale row without binding is allowed", async () => {
    const env = mkEnv(); const o = await ownerTeam(env);
    expect((await P(env, o, { class: "g", feature: "devices", unlocked: true })).status).toBe(409); // no DEVICES binding
    expect(rows(env)).toEqual([]); expect(audit(env)).toEqual([]);
    env._db.query(`INSERT INTO settings (name, value) VALUES ('unlock:g:devices','1')`).run();
    expect((await P(env, o, { class: "g", feature: "devices", unlocked: false })).status).toBe(200);
    expect(rows(env)).toEqual([]); expect(audit(env).length).toBe(1);
  });
});

describe("feat3 admin features: write + audit semantics", () => {
  const withB = () => mkEnv({ DEVICES: {}, AI: {}, BROWSER: {} });
  test("unlock writes exactly one row '1' + one audit row; lock deletes the row + audits; no-op writes nothing", async () => {
    const env = withB(); const o = await ownerTeam(env);
    expect(await (await P(env, o, U)).json()).toEqual({ ok: true, changed: true, enforced: false });
    expect(rows(env)).toEqual([{ name: "unlock:g:devices", value: "1" }]);
    let a = audit(env); expect(a.length).toBe(1);
    expect(a[0]).toMatchObject({ class: "g", feature: "devices", old: null, new: "1" });
    expect(a[0].actor).toMatch(/^a_[0-9a-f]{16}$/); expect(JSON.stringify(a)).not.toContain(OWNER); expect(typeof a[0].ts).toBe("number");
    expect((await (await P(env, o, U)).json() as any).changed).toBe(false); expect(audit(env).length).toBe(1);
    expect((await P(env, o, { ...U, unlocked: false })).status).toBe(200);
    expect(rows(env)).toEqual([]); a = audit(env); expect(a.length).toBe(2); expect(a[1]).toMatchObject({ old: "1", new: null });
  });
  test("never touches narrowing rows or any other settings row", async () => {
    const env = withB(); const o = await ownerTeam(env);
    for (const [n, v] of [["cap:g:devices", "0"], ["feat:main:workers-ai", "0"], ["open_space:main", "0"], ["vcl:main", "1"], ["unlock:g:files", "garbage"]]) env._db.query(`INSERT INTO settings (name, value) VALUES (?,?)`).run(n, v);
    const before = rows(env, "%");
    await P(env, o, U); await P(env, o, { ...U, unlocked: false }); await P(env, o, { class: "g", feature: "files", unlocked: false });
    expect(rows(env, "%").filter((r) => r.name !== "unlock:g:files")).toEqual(before.filter((r) => r.name !== "unlock:g:files"));
    expect(rows(env, "cap:%")).toEqual([{ name: "cap:g:devices", value: "0" }]);
  });
  test("atomic: audit and row write go in ONE db.batch; a failing batch leaves neither", async () => {
    const env = withB(); const o = await ownerTeam(env);
    const real = env.DB; let batches = 0;
    (env as any).DB = { prepare: real.prepare.bind(real), batch: async (ss: any[]) => { batches++; expect(ss.length).toBe(2); throw new Error("boom"); } };
    expect((await P(env, o, U)).status).toBe(500);
    expect(batches).toBe(1); expect(rows(env)).toEqual([]); expect(audit(env)).toEqual([]);
  });
  test("append-only: the admin module/migration has no UPDATE/DELETE on feature_audit; no other src file writes unlock rows", () => {
    const src = readFileSync(new URL("../src/admin-features.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/(UPDATE|DELETE FROM)\s+feature_audit/i);
    const out: string[] = [];
    for (const f of readdirSync(new URL("../src/", import.meta.url), { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f) || f === "admin-features.ts") continue;
      const t = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      if (/(INSERT|UPDATE|DELETE)[^;`]*(feature_audit)/i.test(t) || /unlock:\$\{[^}]*\}:\$\{[^}]*\}[^]{0,200}(INSERT|UPDATE|DELETE)/i.test(t)) out.push(f);
    }
    expect(out).toEqual([]);
  });
  test("30 writes/min per actor, 31st => 429; another actor is unaffected; window expires", async () => {
    const env = withB(); const o = await ownerTeam(env); const gh = await github(env);
    for (let i = 0; i < 30; i++) expect((await P(env, o, { ...U, unlocked: i % 2 === 0 })).status).toBe(200);
    expect(audit(env).length).toBe(30);
    expect((await P(env, o, { ...U, unlocked: true })).status).toBe(429);
    expect(audit(env).length).toBe(30);
    expect((await P(env, gh, U)).status).toBe(200); // different actor id
    env._db.query(`UPDATE feature_audit SET ts = ts - 61000`).run(); // test-only aging of the window
    expect((await P(env, o, { ...U, unlocked: false })).status).toBe(200);
  });
});

describe("feat3 admin features: GET", () => {
  test("matrix shape, binding status, unlock state; audit last 20; no emails/logins/uids leak", async () => {
    const env = mkEnv({ DEVICES: {} }); const o = await ownerTeam(env); const gh = await github(env);
    await teamLogin(env, "ann@example.com", "a".repeat(24)); // another user's data exists in D1
    for (let i = 0; i < 25; i++) { await P(env, i % 2 ? gh : o, { class: "g", feature: "devices", unlocked: i % 2 === 0 }); }
    const r = await call(env, o, "GET", "/api/admin/features"); expect(r.status).toBe(200);
    const raw = await r.text(); const j = JSON.parse(raw);
    expect(j.enforced).toBe(false); expect(j.classes).toEqual(["m", "g", "o"]);
    expect(Object.keys(j.matrix).length).toBe(19);
    const cell = j.matrix.devices.g; expect(cell).toMatchObject({ applicable: true, binding: "present" }); expect(["1", null]).toContain(cell.unlock);
    expect(j.matrix.files.m.on).toBe(true);
    expect(j.matrix.files.g).toMatchObject({ binding: "present", on: true, reason: "ok" });
    expect(j.matrix["workers-ai"].g).toMatchObject({ binding: "missing", on: false, reason: "no-binding" });
    expect(j.matrix.connectors.g.applicable).toBe(false);
    expect(j.audit.length).toBe(20); expect(j.audit[0].id).toBeGreaterThan(j.audit[19].id);
    for (const a of j.audit) expect(a.actor).toMatch(/^a_[0-9a-f]{16}$/);
    for (const leak of [OWNER, "ann@example.com", "example-user", "a".repeat(24), "b".repeat(24), "test-secret"]) expect(raw).not.toContain(leak);
  });
  test("an unlock row shows in the matrix for g but the real guest /api/me is unchanged (no enforcement)", async () => {
    const env = mkEnv({ DEVICES: {} }); const o = await ownerTeam(env);
    const g = await teamLogin(env, "ann@example.com", "a".repeat(24));
    const me = async () => ((await (await call(env, g, "GET", "/api/me")).json()) as any).features;
    const before = await me();
    expect((await P(env, o, U)).status).toBe(200);
    const m = await (await call(env, o, "GET", "/api/admin/features")).json() as any;
    expect(m.matrix.devices.g.unlock).toBe("1");
    expect(await me()).toEqual({ ...before, devices: true }); // resolver view (/api/me only displays); route gates are untouched (step 5)
  });
});
