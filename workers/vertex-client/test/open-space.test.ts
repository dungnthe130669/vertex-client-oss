import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { openAllowed, setOpenFlag } from "../src/open-space";
import { parseBase, type BaseScope, type Scope } from "../src/scope";
import { chatMock } from "./do-mock";

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
const mk = (extra: Record<string, unknown> = {}, failSettings = false) => {
  const dbx = d1(failSettings);
  const env: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", E2E_TOKEN: "e".repeat(40), GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: dbx.d1, ...extra };
  env.CHAT = chatMock(() => env.FILES);
  return { env: env as Env, db: dbx.db };
};
const cookieOf = async (env: Env, via: "github" | "e2e" = "github") => (await makeSession(env, via === "e2e" ? "e2e-bot" : "example-user", via, via === "e2e" ? 900 : undefined)).cookie.split(";")[0];
// `seam` = the test-only scopeOf: lets a github session stand in for a team user (g:*) without the team gateway.
const req = async (env: Env, path: string, o: { headers?: Record<string, string>; via?: "github" | "e2e"; seam?: Scope } = {}) => {
  const app = createApp(o.seam ? { scopeOf: () => o.seam! } : {});
  return app.request(`${ORIGIN}${path}`, { headers: { cookie: await cookieOf(env, o.via), origin: ORIGIN, ...(o.headers ?? {}) } }, env);
};
const insertConv = (db: Database, id: string, scope: string, title: string) => db.query(`INSERT INTO conversations (id, title, model, scope) VALUES (?,?,?,?)`).run(id, title, "m", scope);
const ids = async (r: Response) => ((await r.json()) as any).conversations.map((c: any) => c.title).sort();

describe("space resolution middleware", () => {
  test("no selector = Business: lists only Business rows, /api/me reports biz", async () => {
    const { env, db } = mk();
    insertConv(db, "11111111-1111-4111-8111-111111111111", "main", "biz-chat"); insertConv(db, "22222222-2222-4222-8222-222222222222", "main~open", "open-chat");
    expect(await ids(await req(env, "/api/conversations"))).toEqual(["biz-chat"]);
    const me = (await (await req(env, "/api/me")).json()) as any;
    expect(me.spaces).toEqual(["biz", "open"]); expect(me.space).toBe("biz"); expect(me.erichOnly).toBe(true);
  });
  test("x-vc-space: biz explicit = same as none", async () => {
    const { env, db } = mk();
    insertConv(db, "11111111-1111-4111-8111-111111111111", "main", "biz-chat"); insertConv(db, "22222222-2222-4222-8222-222222222222", "main~open", "open-chat");
    expect(await ids(await req(env, "/api/conversations", { headers: { "x-vc-space": "biz" } }))).toEqual(["biz-chat"]);
  });
  test("x-vc-space: open (header) and ?space=open (query) select the Open scope only", async () => {
    const { env, db } = mk();
    insertConv(db, "11111111-1111-4111-8111-111111111111", "main", "biz-chat"); insertConv(db, "22222222-2222-4222-8222-222222222222", "main~open", "open-chat");
    expect(await ids(await req(env, "/api/conversations", { headers: { "x-vc-space": "open" } }))).toEqual(["open-chat"]);
    expect(await ids(await req(env, "/api/conversations?space=open"))).toEqual(["open-chat"]);
    const me = (await (await req(env, "/api/me", { headers: { "x-vc-space": "open" } })).json()) as any;
    expect(me.space).toBe("open"); expect(me.erichOnly).toBe(false); // the client reconciles on this field; Erich-only modes are Business only
  });
  test("header wins over query", async () => {
    const { env, db } = mk();
    insertConv(db, "11111111-1111-4111-8111-111111111111", "main", "biz-chat"); insertConv(db, "22222222-2222-4222-8222-222222222222", "main~open", "open-chat");
    expect(await ids(await req(env, "/api/conversations?space=open", { headers: { "x-vc-space": "biz" } }))).toEqual(["biz-chat"]);
    expect(await ids(await req(env, "/api/conversations?space=biz", { headers: { "x-vc-space": "open" } }))).toEqual(["open-chat"]);
  });
  test("a bad value is 400 (header or query), never a silent fallback", async () => {
    const { env } = mk();
    for (const v of ["OPEN", "Biz", "main~open", "g:x", "open,biz", "", " open", "open ", "x".repeat(300)]) {
      if (v === v.trim()) { // fetch trims header whitespace itself, so only the query form can carry it
        const h = await req(env, "/api/conversations", { headers: { "x-vc-space": v } });
        expect([v, h.status, ((await h.json()) as any).error]).toEqual([v, 400, "bad space"]);
      }
      const q = await req(env, `/api/conversations?space=${encodeURIComponent(v)}`);
      expect([v, q.status]).toEqual([v, 400]);
    }
    // a bad header is rejected even when the query is valid
    expect((await req(env, "/api/conversations?space=open", { headers: { "x-vc-space": "nope" } })).status).toBe(400);
  });
  test("Open not allowed -> 403 with one body, for header and query", async () => {
    const { env } = mk({ OPEN_SPACE: "off" });
    for (const r of [await req(env, "/api/conversations", { headers: { "x-vc-space": "open" } }), await req(env, "/api/conversations?space=open")]) {
      expect(r.status).toBe(403); expect(await r.json()).toEqual({ error: "space unavailable" });
    }
    expect(((await (await req(env, "/api/me")).json()) as any).spaces).toEqual(["biz"]);
    expect((await req(env, "/api/conversations", { headers: { "x-vc-space": "biz" } })).status).toBe(200); // Business still works
  });
  test("team user: default ON with no row; row \"0\" is the kill switch (403 space unavailable); row \"1\" is on", async () => {
    for (const mode of [undefined, "per-user", "on"]) {
      const { env, db } = mk(mode ? { OPEN_SPACE: mode } : {});
      insertConv(db, "11111111-1111-4111-8111-111111111111", G, "g-biz"); insertConv(db, "22222222-2222-4222-8222-222222222222", `${G}~open`, "g-open");
      const open = { headers: { "x-vc-space": "open" }, seam: G as Scope };
      expect(await ids(await req(env, "/api/conversations", open))).toEqual(["g-open"]); // no row
      expect(((await (await req(env, "/api/me", { seam: G as Scope })).json()) as any).spaces).toEqual(["biz", "open"]);
      expect(await ids(await req(env, "/api/conversations", { seam: G as Scope }))).toEqual(["g-biz"]); // Business untouched
      await setOpenFlag(env.DB, G, false);
      const off = await req(env, "/api/conversations", open);
      expect(off.status).toBe(403); expect(await off.json()).toEqual({ error: "space unavailable" });
      expect(((await (await req(env, "/api/me", { seam: G as Scope })).json()) as any).spaces).toEqual(["biz"]);
      await setOpenFlag(env.DB, G, true);
      expect((await req(env, "/api/conversations", open)).status).toBe(200);
    }
  });
  test("team user: D1 error = off (fail closed), OPEN_SPACE=off = off even with a \"1\" row", async () => {
    const bad = mk({}, true);
    expect((await req(bad.env, "/api/conversations", { headers: { "x-vc-space": "open" }, seam: G as Scope })).status).toBe(403);
    const { env } = mk({ OPEN_SPACE: "off" }); await setOpenFlag(env.DB, G, true);
    expect((await req(env, "/api/conversations", { headers: { "x-vc-space": "open" }, seam: G as Scope })).status).toBe(403);
  });
  test("a team user's kill switch never closes another user's Open", async () => {
    const { env } = mk({});
    const other = parseBase("g:zzzzzzzzzzzzzzzzzzzz") as BaseScope;
    await setOpenFlag(env.DB, G, false);
    expect((await req(env, "/api/conversations", { headers: { "x-vc-space": "open" }, seam: G as Scope })).status).toBe(403);
    expect((await req(env, "/api/conversations", { headers: { "x-vc-space": "open" }, seam: other as Scope })).status).toBe(200);
  });
  test("e2e: Open only when the edition says per-user/on", async () => {
    expect((await req(mk({}).env, "/api/conversations", { via: "e2e", headers: { "x-vc-space": "open" } })).status).toBe(403);
    expect((await req(mk({ OPEN_SPACE: "per-user" }).env, "/api/conversations", { via: "e2e", headers: { "x-vc-space": "open" } })).status).toBe(200);
  });
  test("a conversation of the other space is 404 on the WS route, same as a missing id", async () => {
    const { env, db } = mk();
    insertConv(db, "22222222-2222-4222-8222-222222222222", "main~open", "open-chat");
    const ws = { upgrade: "websocket" };
    expect((await req(env, "/api/conversations/22222222-2222-4222-8222-222222222222/ws", { headers: ws })).status).toBe(404); // Business
    expect((await req(env, "/api/conversations/33333333-3333-4333-8333-333333333333/ws?space=open", { headers: ws })).status).toBe(404); // missing
  });
  test("media/file GET: ?space= is honoured by the same middleware (bad value 400)", async () => {
    const { env } = mk();
    expect((await req(env, "/api/conversations/22222222-2222-4222-8222-222222222222/files/x?space=bogus")).status).toBe(400);
  });
});

describe("openAllowed", () => {
  const { env } = mk();
  test("team base: no row / garbage mode / per-user = on; D1 error or no DB = off (fail closed)", async () => {
    expect(await openAllowed({ DB: env.DB }, G)).toBe(true);
    expect(await openAllowed({ DB: env.DB, OPEN_SPACE: "garbage" }, G)).toBe(true);
    expect(await openAllowed({ DB: env.DB, OPEN_SPACE: "per-user" }, G)).toBe(true);
    expect(await openAllowed({}, G)).toBe(false); // no DB
    expect(await openAllowed({ DB: mk({}, true).env.DB, OPEN_SPACE: "per-user" }, G)).toBe(false); // D1 error
    expect(await openAllowed({ DB: mk({}, true).env.DB }, G)).toBe(false);
  });
  test("kill switch row \"0\" = off; \"1\" = on; OPEN_SPACE=off beats both", async () => {
    const { env: e2 } = mk();
    await setOpenFlag(e2.DB, G, false); expect(await openAllowed({ DB: e2.DB }, G)).toBe(false);
    await setOpenFlag(e2.DB, G, true); expect(await openAllowed({ DB: e2.DB }, G)).toBe(true);
    expect(await openAllowed({ DB: e2.DB, OPEN_SPACE: "off" }, G)).toBe(false);
  });
  test("modes", async () => {
    expect(await openAllowed({ OPEN_SPACE: "on" }, G)).toBe(false); // no DB: a team base cannot be read, fail closed even under "on"
    expect(await openAllowed({ OPEN_SPACE: "on" }, "main")).toBe(true);
    expect(await openAllowed({ OPEN_SPACE: "on" }, "e2e")).toBe(true);
    expect(await openAllowed({ OPEN_SPACE: "off" }, "main")).toBe(false);
    expect(await openAllowed({}, "main")).toBe(true); // Erich on the main edition: default available
    expect(await openAllowed({ OPEN_SPACE: "per-user" }, "main")).toBe(true);
  });
});
