import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { SESSION_COOKIE, readSession, signSession, makeSession } from "../src/auth";
import { e2eLogin, e2eToolGuard } from "../src/auth-e2e";
import { usageReport } from "../src/usage";
import type { ToolHost } from "../src/tools";

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
const mkEnv = (over: Record<string, unknown> = {}, dbx = d1()) => ({
  SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", E2E_TOKEN: TOKEN,
  ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: dbx.d1, CHAT, _db: dbx.db, ...over,
}) as unknown as Env & { _db: Database };
const app = createApp();
const login = (env: Env, headers: Record<string, string> = {}, method = "POST") => app.fetch(new Request(ORIGIN + "/auth/e2e", { method, headers }), env);
async function bot(env: Env) {
  const r = await login(env, { "x-e2e-token": TOKEN });
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json() as any;
  return { cookie, csrf: me.csrf as string };
}
const api = (env: Env, path: string, a: { cookie: string; csrf: string }, init: RequestInit = {}) => {
  const h = new Headers(init.headers); h.set("cookie", a.cookie); h.set("origin", ORIGIN);
  if (init.method && init.method !== "GET") h.set("x-csrf-token", a.csrf);
  return app.fetch(new Request(ORIGIN + path, { ...init, headers: h }), env);
};

describe("POST /auth/e2e", () => {
  test("secret unset => 404 like any unknown route, even with a token", async () => {
    const env = mkEnv({ E2E_TOKEN: undefined });
    expect((await login(env, { "x-e2e-token": TOKEN })).status).toBe(404);
    expect((await login(mkEnv({ E2E_TOKEN: "short" }), { "x-e2e-token": "short" })).status).toBe(404); // too short to be a real secret
  });
  test("no token 401, wrong token 401, same-length wrong token 401; no cookie set", async () => {
    const env = mkEnv();
    for (const h of [{} as Record<string, string>, { "x-e2e-token": "nope" }, { "x-e2e-token": "u".repeat(64) }, { "x-e2e-token": TOKEN + "x" }]) {
      const r = await login(env, h); expect(r.status).toBe(401); expect(r.headers.get("set-cookie")).toBeNull();
    }
  });
  test("GET is not the login route", async () => { expect((await login(mkEnv(), { "x-e2e-token": TOKEN }, "GET")).status).toBe(404); });
  test("right token: 200, 15-minute cookie for e2e-bot, scope e2e; every attempt is logged without the token", async () => {
    const env = mkEnv(); const logs: any[] = [];
    await e2eLogin(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": "x".repeat(64) } }), env, (o) => logs.push(o));
    const r = await e2eLogin(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": TOKEN, "cf-connecting-ip": "1.2.3.4" } }), env, (o) => logs.push(o));
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toContain("Max-Age=900"); expect(sc).toContain("HttpOnly"); expect(sc).toContain("Secure");
    expect(logs.map((l) => l.ok)).toEqual([false, true]);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    const a = await bot(env);
    const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: a.cookie } }), env)).json() as any;
    expect(me.user).toBe("e2e-bot"); expect(me.via).toBe("e2e");
  });
  test("expiry: an expired session, one claiming >15 min, a wrong user, and a revoked secret are all rejected", async () => {
    const env = mkEnv(); const now = Math.floor(Date.now() / 1000);
    const cookieOf = async (s: any) => new Request(ORIGIN + "/api/me", { headers: { cookie: `${SESSION_COOKIE}=${await signSession(env, s)}` } });
    expect(await readSession(await cookieOf({ u: "e2e-bot", csrf: "c", iat: now - 1000, exp: now - 100, via: "e2e" }), env)).toBeNull();
    expect(await readSession(await cookieOf({ u: "e2e-bot", csrf: "c", iat: now, exp: now + 3600, via: "e2e" }), env)).toBeNull();
    expect(await readSession(await cookieOf({ u: "example-user", csrf: "c", iat: now, exp: now + 600, via: "e2e" }), env)).toBeNull();
    const ok = await cookieOf({ u: "e2e-bot", csrf: "c", iat: now, exp: now + 600, via: "e2e" });
    expect(await readSession(ok, env)).not.toBeNull();
    expect(await readSession(ok, { ...env, E2E_TOKEN: undefined } as any)).toBeNull();
  });
  test("an e2e session is not refreshed (no sliding extension)", async () => {
    const env = mkEnv(); const now = Math.floor(Date.now() / 1000);
    const c = `${SESSION_COOKIE}=${await signSession(env, { u: "e2e-bot", csrf: "c", iat: now - 800, exp: now + 100, via: "e2e" })}`;
    const r = await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: c } }), env);
    expect(r.status).toBe(200); expect(r.headers.get("set-cookie")).toBeNull();
  });
  test("github sessions still work and a forged via is not accepted", async () => {
    const env = mkEnv(); const { cookie } = await makeSession(env, "example-user", "github");
    expect((await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: cookie.split(";")[0] } }), env)).status).toBe(200);
    expect((await app.fetch(new Request(ORIGIN + "/api/me"), env)).status).toBe(401);
  });
});

describe("data isolation between Erich and e2e-bot", () => {
  test("conversations, search, usage, direct access, mutation and push are all scoped", async () => {
    const env = mkEnv();
    const erich = await (async () => { const { cookie, session } = await makeSession(env, "example-user", "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; })();
    const b = await bot(env);
    const mk = async (a: typeof b) => (await (await api(env, "/api/conversations", a, { method: "POST", body: "{}" })).json() as any).id as string;
    const eId = await mk(erich), bId = await mk(b);
    env._db.query(`UPDATE conversations SET title='SECRETPLAN' WHERE id=?`).run(eId);
    env._db.query(`UPDATE conversations SET title='botchat' WHERE id=?`).run(bId);
    env._db.query(`INSERT INTO messages_index (conversation_id, message_seq, chunk, role, text) VALUES (?,1,0,'user','SECRETPLAN launch codes')`).run(eId);
    env._db.query(`INSERT INTO messages_index (conversation_id, message_seq, chunk, role, text) VALUES (?,1,0,'user','botchat hello')`).run(bId);
    const ins = (conv: string, cost: number, scope: string) => env._db.query(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cost_usd, scope) VALUES (?, 'claude-haiku-4-5', 10, 10, ?, ?)`).run(conv, cost, scope);
    ins(eId, 5, "main"); ins(bId, 0.25, "e2e");
    env._db.query(`INSERT INTO settings (name,value) VALUES ('gateway_reconcile','{"drift":{"calls":9}}')`).run();

    const ids = async (a: typeof b, q = "") => ((await (await api(env, "/api/conversations" + q, a)).json()) as any).conversations.map((c: any) => c.id);
    expect(await ids(b)).toEqual([bId]); expect(await ids(erich)).toEqual([eId]);
    expect(await ids(b, "?q=SECRETPLAN")).toEqual([]); expect(await ids(b, "?q=launch")).toEqual([]);
    expect(await ids(b, "?q=botchat")).toEqual([bId]); expect(await ids(erich, "?q=botchat")).toEqual([]);
    // direct object access across scopes = 404 for every verb, and nothing changed
    expect((await api(env, `/api/conversations/${eId}`, b)).status).toBe(404);
    expect((await api(env, `/api/conversations/${eId}`, b, { method: "PATCH", body: JSON.stringify({ title: "pwn" }) })).status).toBe(404);
    expect((await api(env, `/api/conversations/${eId}`, b, { method: "DELETE" })).status).toBe(404);
    expect((await api(env, `/api/conversations/${eId}/files?name=a.png`, b, { method: "POST", headers: { "content-type": "image/png" }, body: "x" })).status).toBe(404);
    expect((await api(env, `/api/conversations/${eId}/ws`, b, { headers: { upgrade: "websocket" } })).status).toBe(404);
    expect((await api(env, `/api/conversations/${bId}`, erich)).status).toBe(404);
    expect((env._db.query(`SELECT title FROM conversations WHERE id=?`).get(eId) as any).title).toBe("SECRETPLAN");
    // usage
    const ub = await (await api(env, "/api/usage", b)).json() as any, ue = await (await api(env, "/api/usage", erich)).json() as any;
    expect(ub.month.total.costUsd).toBeCloseTo(0.25); expect(ue.month.total.costUsd).toBeCloseTo(5);
    expect(ub.topConversations.map((x: any) => x.id)).toEqual([bId]);
    expect(ub.reconcile).toBeNull(); expect(ue.reconcile).not.toBeNull();
    expect((await usageReport(env.DB, Date.now(), 0)).month.total.costUsd).toBeCloseTo(5); // default scope stays main
    // push is closed to the bot, open to Erich
    for (const [m, p] of [["POST", "/api/push/test"], ["POST", "/api/push/subscribe"], ["POST", "/api/push/unsubscribe"]] as const)
      expect((await api(env, p, b, { method: m, body: m === "POST" ? "{}" : undefined })).status).toBe(403);
    expect(await (await api(env, "/api/push/config", b)).json()).toEqual({ publicKey: null, subscriptions: 0 }); // probe answers "not configured", not 403
    expect((await api(env, "/api/push/config", erich)).status).toBe(200);
    // bot cleanup only touches bot data
    expect((await api(env, `/api/conversations/${bId}`, b, { method: "DELETE" })).status).toBe(200);
    expect(await ids(erich)).toEqual([eId]);
  });
  test("recordUsage stamps the conversation's scope", async () => {
    const dbx = d1(); const { d1Index } = await import("../src/index-d1");
    dbx.db.query(`INSERT INTO conversations (id, model, scope) VALUES ('a','m','e2e'),('b','m','main')`).run();
    const ix = d1Index(dbx.d1);
    await ix.recordUsage({ conversationId: "a", model: "m", usage: { input_tokens: 1, output_tokens: 1 } as any, costUsd: 1 });
    await ix.recordUsage({ conversationId: "b", model: "m", usage: { input_tokens: 1, output_tokens: 1 } as any, costUsd: 1 });
    expect(dbx.db.query(`SELECT conversation_id c, scope s FROM usage ORDER BY id`).all()).toEqual([{ c: "a", s: "e2e" }, { c: "b", s: "main" }]);
  });
});

describe("e2e tool guard (keeps the bot away from Erich's real notes)", () => {
  const calls: Array<[string, any]> = [];
  const inner: ToolHost = {
    list: async () => ["search_notes", "save_note", "delete_note", "get_note", "assign_task", "read_url", "connector_usage"].map((name) => ({ name, description: "", input_schema: {}, approval: false })),
    call: async (n, a) => { calls.push([n, a]); return n === "get_note" ? { text: JSON.stringify({ title: (a as any).id === 1 ? "E2ENOTE x" : "Real private note" }), isError: false } : { text: "ok", isError: false }; },
  };
  const g = e2eToolGuard(inner);
  test("only the four allowed tools are offered", async () => { expect((await g.list()).map((t) => t.name).sort()).toEqual(["connector_usage", "delete_note", "save_note", "search_notes"]); });
  test("search must mention E2E; save must be titled E2E and cannot overwrite; delete only E2E-titled notes", async () => {
    expect((await g.call("search_notes", { query: "passwords" })).isError).toBe(true);
    expect((await g.call("search_notes", { query: "" })).isError).toBe(true);
    expect((await g.call("search_notes", { query: "E2ENOTE-abc" })).isError).toBe(false);
    expect((await g.call("save_note", { title: "My diary", body: "x" })).isError).toBe(true);
    expect((await g.call("save_note", { title: "E2ENOTE z", body: "x", id: 5 })).isError).toBe(true);
    expect((await g.call("save_note", { title: "E2ENOTE z", body: "x" })).isError).toBe(false);
    expect((await g.call("delete_note", { id: 2 })).isError).toBe(true);
    expect((await g.call("delete_note", { id: "1" as any })).isError).toBe(true);
    expect((await g.call("delete_note", { id: 1 })).isError).toBe(false);
    expect((await g.call("assign_task", {})).isError).toBe(true);
    expect((await g.call("read_url", { url: "http://x" })).isError).toBe(true);
    expect(calls.some(([n, a]) => n === "delete_note" && a.id === 2)).toBe(false);
  });
});
