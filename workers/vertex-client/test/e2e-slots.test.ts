import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { SESSION_COOKIE, readSession, signSession, makeSession } from "../src/auth";
import { e2eLogin } from "../src/auth-e2e";
import { E2E_SLOT_SCOPES, e2eScopeOfSlot, e2eSlotOfUser, e2eUserOfSlot, isE2eBase, isGuestScope, mayUseErichOnlyModes, parseBase, parseE2eSlot, parseScope, scopeOfSession, turnCapFor, baseOf, type BaseScope } from "../src/scope";
import { featuresOf } from "../src/features";
import { scopeGetsGateway } from "../src/providers/registry";

const ORIGIN = "https://app.test";
const TOKEN = "t".repeat(64);
function d1() {
  const db = new Database(":memory:");
  for (const f of ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0009_usage_generation.sql", "0011_usage_dispatch.sql", "0012_scope_hardening.sql", "0018_projects.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as D1Database };
}
const CHAT = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ seq: 0, messages: [] }) }) } as unknown as DurableObjectNamespace;
const mkEnv = (over: Record<string, unknown> = {}) => { const dbx = d1(); return ({ SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", E2E_TOKEN: TOKEN, ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: dbx.d1, CHAT, _db: dbx.db, ...over }) as unknown as Env & { _db: Database }; };
const app = createApp();
const login = (env: Env, headers: Record<string, string>) => app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers }), env);
async function bot(env: Env, slot?: string | number) {
  const h: Record<string, string> = { "x-e2e-token": TOKEN }; if (slot !== undefined) h["x-e2e-slot"] = String(slot);
  const r = await login(env, h); expect(r.status).toBe(200);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json() as any;
  return { cookie, csrf: me.csrf as string, me };
}
const api = (env: Env, path: string, a: { cookie: string; csrf: string }, init: RequestInit = {}) => {
  const h = new Headers(init.headers); h.set("cookie", a.cookie); h.set("origin", ORIGIN);
  if (init.method && init.method !== "GET") h.set("x-csrf-token", a.csrf);
  return app.fetch(new Request(ORIGIN + path, { ...init, headers: h }), env);
};

describe("slot derivation and validation (pure)", () => {
  test("slot <-> user <-> scope maps are exact and closed", () => {
    expect([0, 1, 2, 3].map(e2eUserOfSlot)).toEqual(["e2e-bot", "e2e-bot-1", "e2e-bot-2", "e2e-bot-3"]);
    expect([0, 1, 2, 3].map(e2eScopeOfSlot)).toEqual(["e2e", "e2e:1", "e2e:2", "e2e:3"]);
    for (const n of [0, 1, 2, 3]) expect(e2eSlotOfUser(e2eUserOfSlot(n))).toBe(n);
  });
  test.each([-1, 4, 9999, 1.5, NaN])("slot %p is rejected", (n) => { expect(e2eUserOfSlot(n as number)).toBeNull(); expect(e2eScopeOfSlot(n as number)).toBeNull(); });
  test.each(["", " 1", "1 ", "01", "00", "+1", "-1", "0x1", "1e0", "4", "9999", "abc", "1;DROP TABLE conversations", "1\n", "１", "1,2", "[1]"])("header slot %p is rejected", (v) => { expect(parseE2eSlot(v)).toBeNull(); });
  test.each(["0", "1", "2", "3"])("header slot %p is accepted", (v) => { expect(parseE2eSlot(v)).toBe(Number(v)); });
  test.each(["e2e-bot-0", "e2e-bot-4", "e2e-bot-01", "e2e-bot-", "e2e-bot-1x", "E2E-BOT-1", "e2e-bot ", "e2e-bot-1\n", "example-user", "admin", "", "e2e-bot-１", "e2e-bot-10", undefined, null, 1])("user %p is not a fixture user", (u) => { expect(e2eSlotOfUser(u)).toBeNull(); });
  test("only the whitelisted scope strings parse as e2e bases; nothing else widens", () => {
    for (const s of ["e2e", "e2e:1", "e2e:2", "e2e:3"]) { expect(parseBase(s) as string).toBe(s); expect(parseScope(s) as string).toBe(s); expect(parseScope(s + "~open") as string).toBe(s + "~open"); expect(isE2eBase(baseOf(parseScope(s)!))).toBe(true); }
    for (const s of ["e2e:0", "e2e:4", "e2e:01", "e2e:", "e2e:1x", "e2e:1~biz", "e2e~", "e2e:1~open~open", "E2E:1", "main:1"]) expect(parseScope(s)).toBeNull();
  });
  test("a slot tenant is never a guest, never main, and has e2e's (not more) policy", () => {
    for (const s of E2E_SLOT_SCOPES) {
      expect(isGuestScope(s as BaseScope)).toBe(false); expect(s).not.toBe("main");
      expect(mayUseErichOnlyModes(s)).toBe(true); expect(scopeGetsGateway(s)).toBe(true); expect(turnCapFor(s)).toBe(turnCapFor("e2e"));
    }
  });
  test("scopeOfSession: e2e users map to their own scope; an unknown e2e user throws (never main)", () => {
    expect(scopeOfSession({ via: "e2e", u: "e2e-bot" })).toBe("e2e");
    expect(scopeOfSession({ via: "e2e", u: "e2e-bot-2" })).toBe("e2e:2");
    expect(scopeOfSession({ via: "e2e", u: "e2e-bot-2" }, "open")).toBe("e2e:2~open");
    for (const u of ["example-user", "e2e-bot-9", ""]) expect(() => scopeOfSession({ via: "e2e", u: u as string })).toThrow();
  });
  test("slot tenants get no features (shared Cloudflare account) exactly like e2e", async () => {
    for (const s of ["e2e", ...E2E_SLOT_SCOPES] as BaseScope[]) expect([...(await featuresOf({ prepare: () => { throw new Error("must not read D1"); } } as any, s))]).toEqual([]);
  });
});

describe("POST /auth/e2e slot parameter", () => {
  test("no slot header = classic e2e-bot (unchanged contract)", async () => {
    const a = await bot(mkEnv()); expect(a.me.user).toBe("e2e-bot"); expect(a.me.via).toBe("e2e");
  });
  test.each([[0, "e2e-bot"], [1, "e2e-bot-1"], [2, "e2e-bot-2"], [3, "e2e-bot-3"]])("slot %p logs in as %p, 15-minute e2e session", async (slot, user) => {
    const env = mkEnv(); const logs: any[] = [];
    const r = await e2eLogin(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": TOKEN, "x-e2e-slot": String(slot) } }), env, (o) => logs.push(o));
    expect(r.status).toBe(200); expect((await r.json() as any).user).toBe(user);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=900"); expect(logs[0].slot).toBe(slot); expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect((await bot(env, slot)).me.user).toBe(user);
  });
  test.each(["4", "-1", "9999", "abc", "", "01", "1;drop"])("bad slot %p => 400, no cookie", async (v) => {
    const r = await login(mkEnv(), { "x-e2e-token": TOKEN, "x-e2e-slot": v });
    expect(r.status).toBe(400); expect(r.headers.get("set-cookie")).toBeNull();
  });
  test("the slot header never bypasses the token (wrong/missing token => 401 before the slot is looked at); disabled endpoint stays 404", async () => {
    expect((await login(mkEnv(), { "x-e2e-slot": "1" })).status).toBe(401);
    expect((await login(mkEnv(), { "x-e2e-token": "u".repeat(64), "x-e2e-slot": "1" })).status).toBe(401);
    expect((await login(mkEnv({ E2E_TOKEN: undefined }), { "x-e2e-token": TOKEN, "x-e2e-slot": "1" })).status).toBe(404);
    expect((await login(mkEnv({ E2E_TOKEN: "short" }), { "x-e2e-token": "short", "x-e2e-slot": "1" })).status).toBe(404);
  });
  test("session claims: only fixture users are accepted as via=e2e; a revoked secret kills slot sessions; >15 min is rejected", async () => {
    const env = mkEnv(); const now = Math.floor(Date.now() / 1000);
    const req = async (s: any) => new Request(ORIGIN + "/api/me", { headers: { cookie: `${SESSION_COOKIE}=${await signSession(env, s)}` } });
    for (const u of ["e2e-bot-1", "e2e-bot-3"]) expect(await readSession(await req({ u, csrf: "c", iat: now, exp: now + 600, via: "e2e" }), env)).not.toBeNull();
    for (const u of ["e2e-bot-4", "e2e-bot-0", "example-user", "e2e-bot-1;", "admin"]) expect(await readSession(await req({ u, csrf: "c", iat: now, exp: now + 600, via: "e2e" }), env)).toBeNull();
    expect(await readSession(await req({ u: "e2e-bot-1", csrf: "c", iat: now, exp: now + 3600, via: "e2e" }), env)).toBeNull();
    expect(await readSession(await req({ u: "e2e-bot-1", csrf: "c", iat: now, exp: now + 600, via: "e2e" }), { ...env, E2E_TOKEN: undefined } as any)).toBeNull();
    // a github session can never claim an e2e user
    expect(await readSession(await req({ u: "e2e-bot-1", csrf: "c", iat: now, exp: now + 600, via: "github" }), env)).toBeNull();
  });
  test("a slot user cannot reach Erich-only data via /api/me flags: same restrictions as e2e (push closed)", async () => {
    const env = mkEnv(); const b = await bot(env, 2);
    expect((await api(env, "/api/push/subscribe", b, { method: "POST", body: "{}" })).status).toBe(403);
    expect(await (await api(env, "/api/push/config", b)).json()).toEqual({ publicKey: null, subscriptions: 0 });
  });
});

describe("isolation between slots", () => {
  test("each slot sees only its own conversations/search/usage; direct access and DELETE across slots are 404; slot-1 'delete all' leaves slot 2 and classic e2e intact", async () => {
    const env = mkEnv();
    const A = { s0: await bot(env), s1: await bot(env, 1), s2: await bot(env, 2), s3: await bot(env, 3) };
    const mk = async (a: typeof A.s0) => (await (await api(env, "/api/conversations", a, { method: "POST", body: "{}" })).json() as any).id as string;
    const id = { s0: await mk(A.s0), s1: await mk(A.s1), s2: await mk(A.s2), s3: await mk(A.s3) };
    const rows = Object.fromEntries((env._db.query(`SELECT id, scope FROM conversations`).all() as any[]).map((r) => [r.id, r.scope]));
    expect(rows[id.s0]).toBe("e2e"); expect(rows[id.s1]).toBe("e2e:1"); expect(rows[id.s2]).toBe("e2e:2"); expect(rows[id.s3]).toBe("e2e:3");
    for (const [k, v] of Object.entries(id)) env._db.query(`INSERT INTO messages_index (conversation_id, message_seq, chunk, role, text) VALUES (?,1,0,'user',?)`).run(v, `needle-${k}`);
    const ins = (conv: string, cost: number, scope: string) => env._db.query(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cost_usd, scope) VALUES (?, 'm', 1, 1, ?, ?)`).run(conv, cost, scope);
    ins(id.s1, 1, "e2e:1"); ins(id.s2, 2, "e2e:2"); ins(id.s0, 4, "e2e");
    const ids = async (a: typeof A.s0, q = "") => ((await (await api(env, "/api/conversations" + q, a)).json()) as any).conversations.map((c: any) => c.id);
    expect(await ids(A.s1)).toEqual([id.s1]); expect(await ids(A.s2)).toEqual([id.s2]); expect(await ids(A.s0)).toEqual([id.s0]);
    expect(await ids(A.s1, "?q=needle-s2")).toEqual([]); expect(await ids(A.s1, "?q=needle-s1")).toEqual([id.s1]);
    expect((await api(env, `/api/conversations/${id.s2}`, A.s1)).status).toBe(404);
    expect((await api(env, `/api/conversations/${id.s2}`, A.s1, { method: "PATCH", body: JSON.stringify({ title: "pwn" }) })).status).toBe(404);
    expect((await api(env, `/api/conversations/${id.s2}`, A.s1, { method: "DELETE" })).status).toBe(404);
    expect((await api(env, `/api/conversations/${id.s1}`, A.s0)).status).toBe(404);
    const u1 = await (await api(env, "/api/usage", A.s1)).json() as any, u2 = await (await api(env, "/api/usage", A.s2)).json() as any, u0 = await (await api(env, "/api/usage", A.s0)).json() as any;
    expect(u1.month.total.costUsd).toBeCloseTo(1); expect(u2.month.total.costUsd).toBeCloseTo(2); expect(u0.month.total.costUsd).toBeCloseTo(4);
    // the fixture's own cleanup: slot 1 deletes everything it can list ...
    for (const c of await ids(A.s1)) expect((await api(env, `/api/conversations/${c}`, A.s1, { method: "DELETE" })).status).toBe(200);
    // ... and nobody else lost a thing
    expect(await ids(A.s1)).toEqual([]); expect(await ids(A.s2)).toEqual([id.s2]); expect(await ids(A.s3)).toEqual([id.s3]); expect(await ids(A.s0)).toEqual([id.s0]);
    expect(env._db.query(`SELECT COUNT(*) n FROM conversations WHERE scope IN ('e2e','e2e:2','e2e:3')`).get()).toEqual({ n: 3 });
  });
  test("Erich's main scope and the slots never see each other", async () => {
    const env = mkEnv(); const { cookie, session } = await makeSession(env, "example-user", "github"); const erich = { cookie: cookie.split(";")[0], csrf: session.csrf };
    const s1 = await bot(env, 1);
    const eId = (await (await api(env, "/api/conversations", erich, { method: "POST", body: "{}" })).json() as any).id;
    const sId = (await (await api(env, "/api/conversations", s1, { method: "POST", body: "{}" })).json() as any).id;
    expect((await api(env, `/api/conversations/${eId}`, s1)).status).toBe(404); expect((await api(env, `/api/conversations/${sId}`, erich)).status).toBe(404);
    expect(((await (await api(env, "/api/conversations", erich)).json()) as any).conversations.map((c: any) => c.id)).toEqual([eId]);
  });
  test("remote: every e2e slot tenant gets the synthetic fixtures, never the real hub", async () => {
    const env = mkEnv({ REMOTE: { fetch: async () => { throw new Error("REAL HUB TOUCHED"); } } }); const s2 = await bot(env, 2);
    const r = await api(env, "/api/remote/sessions", s2); expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain("e2e-host");
  });
});
