import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { openAllowed, setOpenFlag } from "../src/open-space";
import { parseBase, type BaseScope, type Scope } from "../src/scope";

const ORIGIN = "https://app.test";
const G = parseBase("g:abcdefghijklmnop1234") as BaseScope;
const MIGS = ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0009_usage_generation.sql", "0011_usage_dispatch.sql", "0012_scope_hardening.sql", "0018_projects.sql"];
function d1(failSettings = false) {
  const db = new Database(":memory:");
  for (const f of MIGS) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => { if (failSettings && q.includes("settings")) throw new Error("d1 down"); return (db.query(q).get(...(b as any)) as any) ?? null; },
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as D1Database };
}
const gets: unknown[] = [];
const mk = (extra: Record<string, unknown> = {}, failSettings = false) => {
  const dbx = d1(failSettings);
  const env: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", E2E_TOKEN: "e".repeat(40), GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: dbx.d1, ...extra };
  env.CHAT = { idFromName: (n: string) => ({ toString: () => n }), get: (_id: unknown, opts?: unknown) => { gets.push(opts); return { fetch: async (r: Request) => (new URL(r.url).pathname === "/state" ? Response.json({ seq: 0, running: false, model: "m", messages: [{ id: 1, role: "user", content: [{ type: "text", text: "hi" }] }] }) : new URL(r.url).pathname === "/destroy" ? Response.json({ ok: true }) : Response.json({ ok: true, seq: 0, messages: [] })) }; } } as unknown as DurableObjectNamespace;
  return { env: env as Env, db: dbx.db };
};
const cookieOf = async (env: Env, via: "github" | "e2e" = "github") => (await makeSession(env, via === "e2e" ? "e2e-bot" : "example-user", via, via === "e2e" ? 900 : undefined)).cookie.split(";")[0];
// `seam` = the test-only scopeOf: lets a github session stand in for a team user (g:*) without the team gateway.
const req = async (env: Env, path: string, o: { headers?: Record<string, string>; via?: "github" | "e2e"; seam?: Scope } = {}) => {
  const app = createApp(o.seam ? { scopeOf: () => o.seam! } : {});
  return app.request(`${ORIGIN}${path}`, { headers: { cookie: await cookieOf(env, o.via), origin: ORIGIN, ...(o.headers ?? {}) } }, env);
};

const ID = "11111111-1111-4111-8111-111111111111";
const seed = (db: Database, scope: string) => db.query(`INSERT INTO conversations (id, title, model, scope) VALUES (?,?,?,?)`).run(ID, "t", "m", scope);
describe("DO locationHint: Open space only", () => {
  test("Open conversation: first DO touch passes {locationHint:'wnam'}", async () => {
    const { env, db } = mk(); gets.length = 0; seed(db, "main~open");
    const r = await req(env, `/api/conversations/${ID}`, { headers: { "x-vc-space": "open" } });
    expect(r.status).toBe(200); expect(gets).toEqual([{ locationHint: "wnam" }]);
  });
  test("Business conversation: no hint (default nearest-colo placement)", async () => {
    const { env, db } = mk(); gets.length = 0; seed(db, "main");
    const r = await req(env, `/api/conversations/${ID}`);
    expect(r.status).toBe(200); expect(gets).toEqual([undefined]);
  });
});

const mut = async (env: Env, method: string, path: string, space: "open" | "biz", body?: unknown) => {
  const { cookie, session } = await makeSession(env, "example-user", "github");
  const h: Record<string, string> = { cookie: cookie.split(";")[0], origin: ORIGIN, "x-csrf-token": session.csrf, "content-type": "application/json", ...(space === "open" ? { "x-vc-space": "open" } : {}) };
  return createApp().request(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }, env);
};
describe("DO locationHint: every first-touch route", () => {
  for (const [space, scope, want] of [["open", "main~open", { locationHint: "wnam" }], ["biz", "main", undefined]] as const) {
    test(`fresh D1 row (what POST writes; the DO is untouched) -> WS first touch (${space})`, async () => {
      const { env, db } = mk(); gets.length = 0; seed(db, scope); // an Open POST needs a configured model; the route only inserts the row and never touches the DO
      const ws = await createApp().request(`${ORIGIN}/api/conversations/${ID}/ws`, { headers: { upgrade: "websocket", cookie: (await makeSession(env, "example-user", "github")).cookie.split(";")[0], origin: ORIGIN, ...(space === "open" ? { "x-vc-space": "open" } : {}) } }, env);
      expect(ws.status).toBeLessThan(500); expect(gets).toEqual([want]);
    });
  }
  test("fork /seed (Open) is hinted for the new id; Business is not", async () => {
    for (const [space, scope, want] of [["open", "main~open", { locationHint: "wnam" }], ["biz", "main", undefined]] as const) {
      const { env, db } = mk(); gets.length = 0; seed(db, scope);
      const r = await mut(env, "POST", `/api/conversations/${ID}/fork`, space, { message_id: 1 });
      expect(r.status).toBe(201); expect(gets.length).toBe(2); expect(gets.every((g) => JSON.stringify(g) === JSON.stringify(want))).toBe(true);
    }
  });
  test("delete-first (Open) is hinted; Business is not", async () => {
    for (const [space, scope, want] of [["open", "main~open", { locationHint: "wnam" }], ["biz", "main", undefined]] as const) {
      const { env, db } = mk(); gets.length = 0; seed(db, scope);
      const r = await mut(env, "DELETE", `/api/conversations/${ID}`, space);
      expect(r.status).toBeLessThan(500); expect(gets).toEqual([want]);
    }
  });
});
