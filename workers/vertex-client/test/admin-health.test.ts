// feat4: GET /api/admin/health (owner-only, read-only). Same fake-team/D1 harness as admin-features.test.ts.
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
import { HEALTH_PROBE_TTL_MS, LATEST_MIGRATION } from "../src/admin-health";

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
const H = (env: Env, w: Who | null, q = "") => call(env, w, "GET", "/api/admin/health" + q);
const ownerTeam = (env: Env) => teamLogin(env, OWNER, "b".repeat(24));
const probeEnv = (extra: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const env = mkEnv({
    FILES: { head: async (k: string) => { calls.push("r2:" + k); return null; } },
    VECTORIZE: { describe: async () => { calls.push("vec"); return { secretish: "idx-123" }; } },
    AI: { run: async () => { calls.push("AI"); return {}; } },
    ...extra,
  });
  const origPrepare = env.DB.prepare.bind(env.DB);
  (env.DB as any).prepare = (q: string) => { if (/^SELECT 1 AS ok/.test(q)) calls.push("d1"); return origPrepare(q); };
  return { env, calls };
};

describe("feat4 admin health: who may call", () => {
  test("unauth 401; guest 403; e2e 403 (also with ?probe=1, and no probe runs)", async () => {
    const { env, calls } = probeEnv();
    expect((await H(env, null)).status).toBe(401);
    expect((await H(env, null, "?probe=1")).status).toBe(401);
    const g = await teamLogin(env, "ann@example.com", "a".repeat(24));
    const e = await e2e(env);
    for (const w of [g, e]) for (const q of ["", "?probe=1"]) expect((await H(env, w, q)).status).toBe(403);
    expect(calls).toEqual([]);
  });
  test("owner (team) and personal github main both 200; github removed from allowlist => 401", async () => {
    const env = mkEnv();
    expect((await H(env, await ownerTeam(env))).status).toBe(200);
    const gh = await github(env);
    expect((await H(env, gh)).status).toBe(200);
    expect((await H({ ...env, ALLOWED_GITHUB_LOGINS: "x" } as Env, gh)).status).toBe(401);
  });
  test("POST is not a route (read-only)", async () => {
    const env = mkEnv(); const o = await ownerTeam(env);
    expect([404, 405]).toContain((await call(env, o, "POST", "/api/admin/health", {})).status);
  });
});

describe("feat4 admin health: probes", () => {
  test("no ?probe=1 => NO probe runs; probes null", async () => {
    const { env, calls } = probeEnv(); const o = await ownerTeam(env);
    const j = (await (await H(env, o)).json()) as any;
    expect(j.probes).toBeNull();
    expect(calls).toEqual([]);
  });
  test("?probe=1 runs D1/R2/Vectorize/DO but NEVER AI; migrations up-to-date or unknown", async () => {
    const { env, calls } = probeEnv({ DEVICES: {} }); const o = await ownerTeam(env);
    const j = (await (await H(env, o, "?probe=1")).json()) as any;
    expect(j.probes).toMatchObject({ d1: "ok", r2: "ok", vectorize: "ok", durableObject: "ok", ai: "skipped (manual)" });
    expect(calls).toContain("d1"); expect(calls).toContain("r2:__health-probe__"); expect(calls).toContain("vec");
    expect(calls).not.toContain("AI");
    expect(j.probes.migrations.state).toBe("unknown"); // bun:sqlite harness has no d1_migrations table
    expect(j.probes.migrations.latest).toBe(LATEST_MIGRATION);
  });
  test("migrations: d1_migrations present => up-to-date / behind", async () => {
    const { env } = probeEnv(); const o = await ownerTeam(env);
    env._db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    env._db.exec(`INSERT INTO d1_migrations (name) VALUES ('0044_device_space.sql')`);
    expect(((await (await H(env, o, "?probe=1")).json()) as any).probes.migrations.state).toBe("behind");
    const { env: env2 } = probeEnv(); const o2 = await ownerTeam(env2);
    env2._db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    env2._db.exec(`INSERT INTO d1_migrations (name) VALUES ('${LATEST_MIGRATION}.sql')`);
    expect(((await (await H(env2, o2, "?probe=1")).json()) as any).probes.migrations.state).toBe("up-to-date");
  });
  test("LATEST_MIGRATION equals the highest file in migrations/", () => {
    const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.at(-1)!.replace(/\.sql$/, "")).toBe(LATEST_MIGRATION);
  });
  test("probe results cached 60 s per isolate; recomputed after", async () => {
    const { env, calls } = probeEnv(); const o = await ownerTeam(env);
    await H(env, o, "?probe=1"); const n = calls.length;
    const j2 = (await (await H(env, o, "?probe=1")).json()) as any;
    expect(j2.cached).toBe(true); expect(calls.length).toBe(n);
    const real = Date.now; Date.now = () => real() + HEALTH_PROBE_TTL_MS + 1;
    try { const j3 = (await (await H(env, o, "?probe=1")).json()) as any; expect(j3.cached).toBe(false); expect(calls.length).toBeGreaterThan(n); } finally { Date.now = real; }
  });
  test("failing / hanging binding => short fixed reason, no error text", async () => {
    const { env } = probeEnv({ FILES: { head: async () => { throw new Error("secret-account-id-999"); } }, VECTORIZE: {} }); const o = await ownerTeam(env);
    const txt = await (await H(env, o, "?probe=1")).text();
    expect(txt).not.toContain("secret-account-id-999");
    expect(JSON.parse(txt).probes).toMatchObject({ r2: "failed", vectorize: "failed" });
  });
});

describe("feat4 admin health: report content", () => {
  test("absent bindings => 'needs binding X' + wrangler text; secrets say wrangler secret put", async () => {
    const env = mkEnv(); const o = await ownerTeam(env); // mkEnv has no AI / BROWSER / LOADER / VECTORIZE / VAPID / DEVICES
    const j = (await (await H(env, o)).json()) as any;
    const f = (id: string) => j.features.find((x: any) => x.id === id);
    expect(f("workers-ai")).toMatchObject({ ready: false, reason: "needs binding AI, BROWSER" });
    expect(f("workers-ai").missing[0].add).toContain(`"ai": { "binding": "AI" }`);
    expect(f("run-js").missing[0].add).toContain("worker_loaders");
    expect(f("semantic-search").missing.map((m: any) => m.name)).toEqual(["VECTORIZE", "AI"]);
    expect(f("push").missing.map((m: any) => m.kind)).toEqual(["secret", "secret"]);
    expect(f("push").missing[0].add).toBe("set the secret: npx wrangler secret put VAPID_PUBLIC_KEY");
    expect(f("chat")).toMatchObject({ ready: true, reason: "ok", missing: [] });
    expect(j.bindings.DB).toBe(true); expect(j.bindings.AI).toBe(false);
  });
  test("no value / id / secret leaks (secret values, db ids, session secret, owner email) in either mode", async () => {
    const { env } = probeEnv({ KEY_ENC_SECRET: "VALUE-kes-77777", VAPID_PRIVATE_KEY: "VALUE-vapid-88888", VAPID_PUBLIC_KEY: "VALUE-pub-99999" }); const o = await ownerTeam(env);
    for (const q of ["", "?probe=1"]) {
      const t = await (await H(env, o, q)).text();
      for (const s of ["VALUE-", "test-secret-0123456789", OWNER, "idx-123", "example-user", "GATEWAY_KEY\":\"K"]) expect(t).not.toContain(s);
    }
  });
  test("does not write anything (settings + audit unchanged)", async () => {
    const { env } = probeEnv(); const o = await ownerTeam(env);
    const before = JSON.stringify(env._db.query("SELECT * FROM settings").all());
    await H(env, o, "?probe=1");
    expect(JSON.stringify(env._db.query("SELECT * FROM settings").all())).toBe(before);
    expect(env._db.query("SELECT COUNT(*) n FROM feature_audit").get()).toEqual({ n: 0 });
  });
});
