// Notifications center: migration 0039, store/list/read/prune, user isolation over the real routes, payload hygiene, and the device-approval hook.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession, type Session } from "../src/auth";
import { scopeOfSession, type Scope } from "../src/scope";
import { KEEP_PER_USER, listNotifications, markRead, parseNotifCursor, parseReadBody, recordNotification, safeUrl } from "../src/notifications";
import { pushApprovalRequest } from "../src/device-push";

const ORIGIN = "https://app.test";
const GA = "g:abcdefghijklmnopqrstuvwx" as Scope;
const app = createApp({ scopeOf: (s: Session): Scope => (s.u === "other-user" ? GA : scopeOfSession(s)) });
function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q) } as unknown as D1Database };
}
const mkEnv = () => { const x = d1(); return { env: { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,other-user", GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, DB: x.d1 } as unknown as Env, db: x.db, d1: x.d1 }; };
type A = { cookie: string; csrf: string };
const login = async (env: Env, user: string): Promise<A> => { const { cookie, session } = await makeSession(env, user, "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const api = (env: Env, a: A | null, method: string, path: string, body?: unknown) => {
  const h = new Headers({ origin: ORIGIN });
  if (a) { h.set("cookie", a.cookie); if (method !== "GET") h.set("x-csrf-token", a.csrf); }
  if (body !== undefined) h.set("content-type", "application/json");
  return app.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};
const N = { kind: "turn" as const, title: "My chat", body: "Reply ready", url: "/c/abc" };

describe("migration 0039", () => {
  test("applies on top of the whole set, idempotently, with the (user_id, ts) index", () => {
    const { db } = d1();
    db.exec(readFileSync(new URL("../migrations/0039_notifications.sql", import.meta.url), "utf8")); // re-run
    expect((db.query(`SELECT name FROM sqlite_master WHERE name IN ('notifications','notifications_user_ts')`).all() as any[]).length).toBe(2);
    expect((db.query(`PRAGMA table_info(notifications)`).all() as any[]).map((c) => c.name)).toEqual(["id", "user_id", "ts", "kind", "title", "body", "url", "read_at"]);
  });
});

describe("recordNotification / list / read", () => {
  test("stores, lists newest first, counts unread, pages by ts cursor", async () => {
    const { d1: db } = d1();
    for (let i = 1; i <= 5; i++) await recordNotification(db, "main", { ...N, title: `t${i}` }, 1000 + i);
    const p1 = await listNotifications(db, "main", { limit: 2 });
    expect(p1.items.map((x) => x.title)).toEqual(["t5", "t4"]); expect(p1.unread).toBe(5); expect(p1.next).toMatch(/^1004~/);
    const p2 = await listNotifications(db, "main", { limit: 2, before: parseNotifCursor(p1.next)! });
    expect(p2.items.map((x) => x.title)).toEqual(["t3", "t2"]);
    expect((await listNotifications(db, "main", { limit: 2, before: parseNotifCursor("1002")! })).next).toBeNull();
  });
  test("paging with timestamp ties returns every row exactly once (composite cursor), for page sizes 1-4; old numeric cursor still works", async () => {
    const { d1: db } = d1();
    const ids: string[] = [];
    for (const ts of [5, 5, 5, 5, 3, 3, 1]) ids.push((await recordNotification(db, "main", N, ts))!.id);
    for (const limit of [1, 2, 3, 4]) {
      const got: string[] = []; let cur: string | null | undefined;
      for (let i = 0; i < 20; i++) { const p = await listNotifications(db, "main", { limit, before: parseNotifCursor(cur ?? undefined) ?? undefined }); got.push(...p.items.map((x) => x.id)); cur = p.next; if (!cur) break; }
      expect([...got].sort(), `limit ${limit}`).toEqual([...ids].sort()); expect(new Set(got).size).toBe(ids.length);
    }
    expect((await listNotifications(db, "main", { before: parseNotifCursor("5")! })).items.map((x) => x.ts)).toEqual([3, 3, 1]); // bare ts = strictly older
    expect(parseNotifCursor("5~a-b")).toEqual({ ts: 5, id: "a-b" }); expect(parseNotifCursor("")).toBeUndefined();
    for (const bad of ["x", "5~", "5~a b", "-1", "5~" + "a".repeat(65)]) expect(parseNotifCursor(bad), bad).toBeNull();
  });
  test("mark read by ids and all; another user's ids match nothing", async () => {
    const { d1: db } = d1();
    const a = (await recordNotification(db, "main", N, 1))!, b = (await recordNotification(db, "main", N, 2))!, other = (await recordNotification(db, GA, N, 3))!;
    expect(await markRead(db, "main", [a.id, other.id])).toBe(1);
    expect((await listNotifications(db, "main", {})).unread).toBe(1);
    expect((await listNotifications(db, GA, {})).unread).toBe(1); // untouched
    expect(await markRead(db, "main", "all")).toBe(1);
    expect((await listNotifications(db, "main", {})).items.every((x) => x.read)).toBe(true);
    expect(b.id).not.toBe(a.id);
  });
  test(`pruned to the newest ${KEEP_PER_USER} per user on insert; other users keep theirs`, async () => {
    const { d1: db, db: raw } = d1();
    await recordNotification(db, GA, N, 1);
    for (let i = 1; i <= KEEP_PER_USER + 5; i++) await recordNotification(db, "main", { ...N, title: `t${i}` }, 100 + i);
    expect((raw.query(`SELECT COUNT(*) n FROM notifications WHERE user_id='main'`).get() as any).n).toBe(KEEP_PER_USER);
    expect((raw.query(`SELECT MIN(ts) m FROM notifications WHERE user_id='main'`).get() as any).m).toBe(100 + 6);
    expect((raw.query(`SELECT COUNT(*) n FROM notifications WHERE user_id LIKE 'g:%'`).get() as any).n).toBe(1);
  });
  test("payload hygiene: control chars and over-long text clipped, only in-app urls kept", async () => {
    const { d1: db } = d1();
    const r = (await recordNotification(db, "main", { kind: "turn", title: "x".repeat(300), body: "a\nb\u0000c " + "y".repeat(400), url: "https://evil.example/x" }))!;
    expect(r.title.length).toBe(80); expect(r.body.length).toBe(140); expect(r.body.startsWith("a b c ")).toBe(true); expect(r.url).toBe("/");
    expect(safeUrl("/c/1?x=1#h")).toBe("/c/1?x=1#h"); expect(safeUrl("//evil")).toBe("/"); expect(safeUrl("javascript:1")).toBe("/"); expect(safeUrl("/a\\b")).toBe("/");
  });
  test("never throws: a missing table / missing DB returns null", async () => {
    expect(await recordNotification(undefined, "main", N)).toBeNull();
    expect(await recordNotification({ prepare: () => { throw new Error("no such table"); } } as unknown as D1Database, "main", N)).toBeNull();
  });
  test("parseReadBody", () => {
    expect(parseReadBody({ all: true })).toEqual({ ok: true, which: "all" });
    expect(parseReadBody({ ids: ["a"] })).toEqual({ ok: true, which: ["a"] });
    for (const bad of [null, [], {}, { ids: [] }, { ids: [1] }, { ids: Array(101).fill("a") }, { all: "yes" }]) expect(parseReadBody(bad).ok).toBe(false);
  });
});

describe("routes", () => {
  test("auth required; a user sees and marks only their own rows", async () => {
    const { env, d1: db } = mkEnv();
    const erich = await login(env, "example-user"), other = await login(env, "other-user");
    expect((await api(env, null, "GET", "/api/notifications")).status).toBe(401);
    expect((await api(env, null, "POST", "/api/notifications/read", { all: true })).status).toBe(401);
    const mine = (await recordNotification(db, "main", N))!;
    await recordNotification(db, GA, { ...N, title: "theirs" });
    const e = await (await api(env, erich, "GET", "/api/notifications")).json() as any;
    expect(e.items.map((x: any) => x.id)).toEqual([mine.id]); expect(e.unread).toBe(1);
    const o = await (await api(env, other, "GET", "/api/notifications")).json() as any;
    expect(o.items.map((x: any) => x.title)).toEqual(["theirs"]); expect(o.unread).toBe(1); // never Erich's row
    expect(((await (await api(env, other, "POST", "/api/notifications/read", { ids: [mine.id] })).json()) as any).changed).toBe(0);
    expect(((await (await api(env, erich, "GET", "/api/notifications")).json()) as any).unread).toBe(1);
    expect(((await (await api(env, erich, "POST", "/api/notifications/read", { ids: [mine.id] })).json()) as any).changed).toBe(1);
    expect(((await (await api(env, erich, "GET", "/api/notifications")).json()) as any).unread).toBe(0);
  });
  test("validation: bad limit / cursor / body = 400; missing CSRF = rejected", async () => {
    const { env } = mkEnv(); const a = await login(env, "example-user");
    expect((await api(env, a, "GET", "/api/notifications?limit=abc")).status).toBe(400);
    expect((await api(env, a, "GET", "/api/notifications?before=-1")).status).toBe(400);
    expect((await api(env, a, "POST", "/api/notifications/read", {})).status).toBe(400);
    const h = new Headers({ origin: ORIGIN, cookie: a.cookie, "content-type": "application/json" });
    expect((await app.fetch(new Request(ORIGIN + "/api/notifications/read", { method: "POST", headers: h, body: '{"all":true}' }), env)).status).toBeGreaterThanOrEqual(400);
  });
  test("paging over HTTP with ties: composite next cursor round-trips; garbage cursor = 400", async () => {
    const { env, d1: db } = mkEnv(); const a = await login(env, "example-user");
    for (let i = 0; i < 5; i++) await recordNotification(db, "main", { ...N, title: `t${i}` }, 777);
    const seen: string[] = []; let next: string | null = null;
    for (let i = 0; i < 10; i++) { const r = await (await api(env, a, "GET", `/api/notifications?limit=2${next ? `&before=${encodeURIComponent(next)}` : ""}`)).json() as any; seen.push(...r.items.map((x: any) => x.id)); next = r.next; if (!next) break; }
    expect(new Set(seen).size).toBe(5); expect(seen.length).toBe(5);
    expect((await api(env, a, "GET", "/api/notifications?before=zzz")).status).toBe(400);
  });
  test("a missing table (migration not applied yet) reads as an empty list, not a 500", async () => {
    const { env, db } = mkEnv(); const a = await login(env, "example-user");
    db.exec("DROP TABLE notifications");
    const r = await api(env, a, "GET", "/api/notifications");
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ items: [], next: null, unread: 0 });
  });
});

describe("device approval hook", () => {
  const base = { scope: "main", deviceId: "d1", rid: "r1", tool: "Write", preview: "/w/a/secret.env\nKEY=hunter2", expiresAt: 2_000_000, nowMs: 1_000_000_000, watching: false, lastPushMs: 0 };
  const mk = (over: Partial<typeof base> = {}) => {
    const rec: any[] = [], sent: any[] = [];
    const deps = { flagOn: async () => true, deviceName: async () => "Box", pending: () => true, push: async (p: any) => { sent.push(p); return { sent: 1, failed: 0, errors: [] as string[] }; }, record: async (p: any) => { rec.push(p); } };
    return { rec, sent, run: () => pushApprovalRequest({ ...base, ...over }, deps) };
  };
  test("recorded AND pushed when nobody watches; payload is the privacy-minimal push payload", async () => {
    const t = mk(); await t.run();
    expect(t.rec).toEqual([{ title: "Approval needed", body: "Box: Write (secret.env)", url: "/dv/d1", tag: "r1" }]); expect(t.sent).toHaveLength(1);
    expect(JSON.stringify(t.rec)).not.toContain("hunter2");
  });
  test("recorded but NOT pushed while a visible PWA watches, when debounced, and for the e2e user", async () => {
    for (const over of [{ watching: true }, { lastPushMs: 999_999_999 }, { scope: "e2e" }]) { const t = mk(over); expect(await t.run()).toBe(false); expect(t.rec).toHaveLength(1); expect(t.sent).toHaveLength(0); }
  });
  test("an approval answered while the record is being written is not pushed", async () => {
    let pending = true; const sent: any[] = [];
    const ok = await pushApprovalRequest({ ...base }, { flagOn: async () => true, deviceName: async () => "Box", pending: () => pending, push: async (p) => { sent.push(p); return { sent: 1, failed: 0, errors: [] }; }, record: async () => { pending = false; } });
    expect(ok).toBe(false); expect(sent).toHaveLength(0);
  });
  test("neither when the request already expired / flag off; a throwing recorder never blocks the push", async () => {
    const t = mk({ expiresAt: 1 }); await t.run(); expect(t.rec).toHaveLength(0); expect(t.sent).toHaveLength(0);
    const rec: any[] = []; const sent: any[] = [];
    const ok = await pushApprovalRequest({ ...base }, { flagOn: async () => true, deviceName: async () => "Box", pending: () => true, push: async (p) => { sent.push(p); return { sent: 1, failed: 0, errors: [] }; }, record: async () => { throw new Error("db down"); } });
    expect(ok).toBe(true); expect(sent).toHaveLength(1); expect(rec).toHaveLength(0);
  });
});
