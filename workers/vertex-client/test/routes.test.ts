import { PRESETS as __PRESETS } from "../src/providers/presets";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { SESSION_COOKIE, makeSession } from "../src/auth";
import { chunkText, ftsQuery } from "../src/index-d1";
import { chatMock } from "./do-mock";
// test-only: the fake "acme" provider's origin may receive its Worker secret (production allows the preset origin only)
if (!__PRESETS.some((x) => x.id === "acme")) __PRESETS.push({ key: "acme", label: "Acme", id: "acme", baseUrl: "https://llm.example.test/v1", authHeader: "bearer", secret: "PROVIDER_KEY_ACME", help: "" });

const ORIGIN = "https://app.test";
const ID = "11111111-2222-3333-4444-555555555555";

// D1 shim over bun:sqlite with the real migration, so route SQL and FTS5 are exercised for real.
function d1() {
  const db = new Database(":memory:");
  for (const f of ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0009_usage_generation.sql", "0011_usage_dispatch.sql", "0012_scope_hardening.sql", "0018_projects.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; },
    _q: q, _b: b,
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as D1Database };
}
const doCalls: Array<{ path: string; conv: string | null; upgrade: string | null }> = [];
const CHAT_BASE = (env: () => Env) => chatMock(() => (env() as any).FILES, (r) => { const u = new URL(r.url); doCalls.push({ path: u.pathname + u.search, conv: r.headers.get("x-conv-id"), upgrade: r.headers.get("upgrade") }); });

const mkEnv = (dbx = d1()): Env & { _db: Database } => { const e: any = {
  SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k",
  ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: dbx.d1, _db: dbx.db,
}; e.CHAT = CHAT_BASE(() => e); return e as never; };
const app = createApp();
async function auth(env: Env) { const { cookie, session } = await makeSession(env, "example-user", "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; }
const call = (env: Env, path: string, init: RequestInit = {}, a?: { cookie: string; csrf: string }, origin = true) => {
  const h = new Headers(init.headers);
  if (a) { h.set("cookie", a.cookie); if (init.method && init.method !== "GET") h.set("x-csrf-token", a.csrf); }
  if (origin) h.set("origin", ORIGIN);
  return app.fetch(new Request(ORIGIN + path, { ...init, headers: h }), env);
};

describe("conversation routes", () => {
  test("create, list, search via FTS, rename, delete", async () => {
    const env = mkEnv(); const a = await auth(env);
    const r = await call(env, "/api/conversations", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5-5" }) }, a);
    expect(r.status).toBe(201);
    const { id } = await r.json() as { id: string };
    env._db.query(`INSERT INTO messages_index (conversation_id, message_seq, chunk, role, text) VALUES (?,1,0,'assistant','Cấu hình nginx reverse proxy cho tunnel')`).run(id);
    const l = await (await call(env, "/api/conversations", {}, a)).json() as any;
    expect(l.conversations.length).toBe(1);
    const s1 = await (await call(env, "/api/conversations?q=nginx", {}, a)).json() as any;
    expect(s1.conversations.map((c: any) => c.id)).toEqual([id]);
    const s2 = await (await call(env, "/api/conversations?q=" + encodeURIComponent("revers"), {}, a)).json() as any;
    expect(s2.conversations.length).toBe(1);   // prefix
    const s3 = await (await call(env, "/api/conversations?q=zzzz", {}, a)).json() as any;
    expect(s3.conversations.length).toBe(0);
    const evil = await call(env, "/api/conversations?q=" + encodeURIComponent('"*) OR 1=1 --'), {}, a);
    expect(evil.status).toBe(200);
    expect((await call(env, `/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title: "Nginx" }) }, a)).status).toBe(200);
    const t = await (await call(env, "/api/conversations?q=nginx", {}, a)).json() as any;
    expect(t.conversations[0].title).toBe("Nginx");
    expect((await call(env, `/api/conversations/${id}`, { method: "DELETE" }, a)).status).toBe(200);
    expect((await call(env, `/api/conversations/${id}`, {}, a)).status).toBe(404);
    expect(env._db.query(`SELECT count(*) c FROM messages_index`).get()).toEqual({ c: 0 });
  });
  test("mutations need CSRF", async () => {
    const env = mkEnv(); const a = await auth(env);
    const r = await call(env, "/api/conversations", { method: "POST", headers: {} }, { cookie: a.cookie, csrf: "" });
    expect(r.status).toBe(403);
  });
});

describe("chat management + search", () => {
  test("pin orders the list (also inside search), LIKE wildcards are literal, search is capped at 50", async () => {
    const env = mkEnv(); const a = await auth(env);
    const ins = env._db.query(`INSERT INTO conversations (id, model, title, scope, updated_at) VALUES (?,?,?,?,?)`);
    const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
    for (let i = 1; i <= 60; i++) ins.run(id(i), "m", `report ${i}`, "main", `2026-01-01 00:${String(i % 60).padStart(2, "0")}:00`);
    ins.run(id(100), "m", "100% done_x", "main", "2026-01-01 00:00:00");
    ins.run(id(101), "m", "100 percent doneXx", "main", "2026-01-01 00:00:01");
    const titles = async (q: string) => ((await (await call(env, "/api/conversations?q=" + encodeURIComponent(q), {}, a)).json()) as any).conversations as Array<{ id: string; title: string; pinned: number }>;
    expect((await titles("report")).length).toBe(50);
    expect((await titles("0% done_x")).map((c) => c.title)).toEqual(["100% done_x"]); // % and _ do not act as wildcards
    expect((await call(env, `/api/conversations/${id(1)}`, { method: "PATCH", body: JSON.stringify({ pinned: true }) }, a)).status).toBe(200);
    const s = await titles("report"); expect(s[0]).toMatchObject({ id: id(1), pinned: 1 });
    const all = (await (await call(env, "/api/conversations", {}, a)).json() as any).conversations; expect(all[0].id).toBe(id(1));
    expect((await call(env, `/api/conversations/${id(1)}`, { method: "PATCH", body: JSON.stringify({ pinned: false }) }, a)).status).toBe(200);
    expect((await titles("report"))[0].pinned).toBe(0);
  });
});
describe("websocket auth", () => {
  const up = { headers: { upgrade: "websocket" } };
  test("401 without session", async () => {
    const env = mkEnv(); expect((await call(env, `/api/conversations/${ID}/ws`, up)).status).toBe(401);
  });
  test("403 without/with foreign Origin", async () => {
    const env = mkEnv(); const a = await auth(env);
    expect((await call(env, `/api/conversations/${ID}/ws`, up, a, false)).status).toBe(403);
    const r = await app.fetch(new Request(ORIGIN + `/api/conversations/${ID}/ws`, { headers: { upgrade: "websocket", cookie: a.cookie, origin: "https://evil.example" } }), env);
    expect(r.status).toBe(403);
  });
  test("404 unknown or malformed conversation", async () => {
    const env = mkEnv(); const a = await auth(env);
    expect((await call(env, `/api/conversations/${ID}/ws`, up, a)).status).toBe(404);
    expect((await call(env, `/api/conversations/nope/ws`, up, a)).status).toBe(404);
  });
  test("426 when not an upgrade; forwards to the DO with conv id + since when authed", async () => {
    const env = mkEnv(); const a = await auth(env);
    env._db.query(`INSERT INTO conversations (id, model) VALUES (?, 'm')`).run(ID);
    expect((await call(env, `/api/conversations/${ID}/ws`, {}, a)).status).toBe(426);
    doCalls.length = 0;
    await call(env, `/api/conversations/${ID}/ws?since=7`, up, a);
    expect(doCalls[0]).toEqual({ path: "/ws?since=7", conv: ID, upgrade: "websocket" });
  });
});

describe("helpers", () => {
  test("ftsQuery sanitises", () => {
    expect(ftsQuery('a "b" *)')).toBe('"a" "b"*');
    expect(ftsQuery("!!!")).toBeNull();
  });
  test("chunkText", () => { expect(chunkText("x".repeat(20001)).length).toBe(3); expect(chunkText("")).toEqual([]); });
});

describe("file upload route", () => {
  const bucket = () => { const m = new Map<string, { buf: ArrayBuffer; ct?: string }>(); return { m, b: { get: async (k: string) => { const e = m.get(k); return e ? { arrayBuffer: async () => e.buf, body: new Response(e.buf).body, httpMetadata: { contentType: e.ct }, size: e.buf.byteLength } : null; }, put: async (k: string, v: ArrayBuffer, o?: any) => { m.set(k, { buf: typeof v === "string" ? new TextEncoder().encode(v).buffer as ArrayBuffer : v, ct: o?.httpMetadata?.contentType }); }, delete: async (ks: string | string[]) => { for (const k of [].concat(ks as never)) m.delete(k); }, list: async (o?: any) => ({ objects: [...m.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((key) => ({ key })), truncated: false }) } as R2Bucket }; };
  test("stores under vertex-client/<conv>/, enforces type and size, needs a session", async () => {
    const env = mkEnv(); const a = await auth(env); const bk = bucket(); (env as any).FILES = bk.b;
    const { id } = await (await call(env, "/api/conversations", { method: "POST", body: "{}" }, a)).json() as any;
    const up = (mime: string, body: BodyInit, extra: Record<string, string> = {}) => call(env, `/api/conversations/${id}/files?name=${encodeURIComponent("my pic.png")}`, { method: "POST", headers: { "content-type": mime, ...extra }, body }, a);
    const ok = await up("image/png", new Uint8Array([1, 2, 3]));
    expect(ok.status).toBe(201);
    const j = await ok.json() as any;
    expect(j.ref.startsWith(`vertex-client/${id}/`)).toBe(true);
    expect(j).toMatchObject({ mime: "image/png", size: 3, name: "my_pic.png" });
    expect(bk.m.get(j.ref)!.ct).toBe("image/png");
    expect((await up("text/html", "<b>x</b>")).status).toBe(415);
    expect((await up("image/png", new Uint8Array(0))).status).toBe(400);
    expect((await up("application/pdf", "x", { "content-length": String(21 * 1024 * 1024) })).status).toBe(413);
    expect((await up("image/png", new Uint8Array(6 * 1024 * 1024))).status).toBe(413);
    expect((await call(env, `/api/conversations/${id}/files`, { method: "POST", headers: { "content-type": "image/png" }, body: "x" })).status).toBe(401);
    expect((await call(env, `/api/conversations/${id}`, { method: "DELETE" }, a)).status).toBe(200);
    expect(bk.m.size).toBe(0); // uploads removed with the conversation
  });
});

describe("attachment routes (text/office/preview)", () => {
  const bucket = () => { const m = new Map<string, { buf: ArrayBuffer; ct?: string }>(); return { m, b: { get: async (k: string) => { const e = m.get(k); return e ? { arrayBuffer: async () => e.buf, body: new Response(e.buf).body, httpMetadata: { contentType: e.ct }, size: e.buf.byteLength } : null; }, put: async (k: string, v: ArrayBuffer | string, o?: any) => { m.set(k, { buf: typeof v === "string" ? new TextEncoder().encode(v).buffer as ArrayBuffer : v, ct: o?.httpMetadata?.contentType }); }, delete: async () => {}, list: async () => ({ objects: [], truncated: false }) } as unknown as R2Bucket }; };
  const fx = (n: string) => new Uint8Array(require("node:fs").readFileSync(new URL(`../fixtures/attach/${n}`, import.meta.url)));
  const setup = async () => {
    const env = mkEnv(); const a = await auth(env); const bk = bucket(); (env as any).FILES = bk.b;
    const mk = async () => (await (await call(env, "/api/conversations", { method: "POST", body: "{}" }, a)).json() as any).id as string;
    const id = await mk();
    const up = (cid: string, name: string, mime: string, body: BodyInit) => call(env, `/api/conversations/${cid}/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": mime }, body }, a);
    return { env, a, bk, id, mk, up };
  };

  test("text/code: ext fallback for vague mimes, canonical mime stored, tokens returned, binary + html + audio refused", async () => {
    const { bk, id, up } = await setup();
    const r = await up(id, "main.py", "application/octet-stream", "print('hi')\n");
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j).toMatchObject({ name: "main.py", mime: "text/x-python", kind: "text", size: 12, tokens: 3 });
    expect(bk.m.get(j.ref)!.ct).toBe("text/x-python");
    expect(bk.m.has(`${j.ref}.txt`)).toBe(false); // text needs no sidecar
    expect((await up(id, "d.csv", "", "a,b\n1,2\n")).status).toBe(201);
    const bin = await up(id, "fake.txt", "text/plain", fx("binary-disguised.txt"));
    expect(bin.status).toBe(415);
    expect((await bin.json() as any).error).toContain("binary");
    expect((await up(id, "x.html", "text/html", "<b>")).status).toBe(415);
    const au = await up(id, "a.mp3", "audio/mpeg", "x");
    expect(au.status).toBe(415);
    expect((await au.json() as any).error).toContain("no audio, video or zip");
    expect((await up(id, "big.txt", "text/plain", new Uint8Array(2 * 1024 * 1024 + 1).fill(97))).status).toBe(413);
    expect((await up(id, "big.csv", "text/csv", "a\n".repeat(1024 * 1024 + 1))).status).toBe(201); // 2 MB+ is fine for CSV (limit 10 MB)
  });

  test("office: extracted at upload into a <ref>.txt sidecar; bad/hostile files refused and nothing stored", async () => {
    const { bk, id, up } = await setup();
    const r = await up(id, "r.docx", "application/octet-stream", fx("tiny.docx"));
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j).toMatchObject({ kind: "office", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(j.tokens).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bk.m.get(`${j.ref}.txt`)!.buf)).toContain("ZEBRA & co");
    const before = bk.m.size;
    const bad = await up(id, "fake.xlsx", "application/octet-stream", "not a zip at all");
    expect(bad.status).toBe(415);
    expect(bk.m.size).toBe(before);
  });

  test("preview: auth + ownership, 404 cross-conversation, text served as utf-8 text/plain, office as extracted text", async () => {
    const { env, a, id, mk, up } = await setup();
    const other = await mk();
    const t = await (await up(id, "n.txt", "text/plain", fx("latin1.txt"))).json() as any;
    const o = await (await up(id, "r.docx", "", fx("tiny.docx"))).json() as any;
    const png = await (await up(id, "p.png", "image/png", new Uint8Array([1, 2, 3]))).json() as any;
    const tail = (ref: string) => ref.split("/").slice(2).join("/");
    const get = (cid: string, r: string, auth = a) => call(env, `/api/conversations/${cid}/files/${r}`, {}, auth);
    const res = await get(id, encodeURIComponent(tail(t.ref)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("café naïve\n");
    expect((await get(id, t.ref)).status).toBe(200); // the full key works too
    const od = await get(id, tail(o.ref));
    expect(await od.text()).toContain("Quarterly report");
    const im = await get(id, tail(png.ref));
    expect(im.headers.get("content-type")).toBe("image/png");
    expect(im.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get(other, t.ref)).status).toBe(404); // ref of conversation A asked through conversation B
    expect((await get(other, tail(t.ref))).status).toBe(404); // tail resolved inside B: no such object
    expect((await get(id, "vertex-client/" + other + "/x.txt")).status).toBe(404);
    expect((await get(id, `vertex-client/${id}/../${other}/x`)).status).toBe(404);
    expect((await call(env, `/api/conversations/${id}/files/${tail(t.ref)}`)).status).toBe(401);
  });
});

describe("push + usage routes", () => {
  const good = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } };
  test("subscribe requires session+csrf; validates endpoint host and keys; upserts; unsubscribe deletes", async () => {
    const env = mkEnv(); const a = await auth(env);
    expect((await call(env, "/api/push/subscribe", { method: "POST", body: JSON.stringify(good) })).status).toBe(401);
    expect((await call(env, "/api/push/subscribe", { method: "POST", body: JSON.stringify(good) }, { cookie: a.cookie, csrf: "wrong" })).status).toBe(403);
    expect((await call(env, "/api/push/subscribe", { method: "POST", body: JSON.stringify({ ...good, endpoint: "https://evil.example/x" }) }, a)).status).toBe(400);
    expect((await call(env, "/api/push/subscribe", { method: "POST", body: JSON.stringify({ ...good, keys: { p256dh: "x", auth: "y" } }) }, a)).status).toBe(400);
    expect((await call(env, "/api/push/subscribe", { method: "POST", body: JSON.stringify(good) }, a)).status).toBe(201);
    expect((await call(env, "/api/push/subscribe", { method: "POST", body: JSON.stringify(good) }, a)).status).toBe(201); // idempotent
    expect((env._db.query(`SELECT COUNT(*) AS n FROM push_subscriptions`).get() as any).n).toBe(1);
    expect(((await (await call(env, "/api/push/config", {}, a)).json()) as any)).toEqual({ publicKey: null, subscriptions: 1 });
    expect((await call(env, "/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: good.endpoint }) }, a)).status).toBe(200);
    expect((env._db.query(`SELECT COUNT(*) AS n FROM push_subscriptions`).get() as any).n).toBe(0);
  });
  test("test-push without VAPID configured reports 503, never pretends success", async () => {
    const env = mkEnv(); const a = await auth(env);
    const r = await call(env, "/api/push/test", { method: "POST", body: "{}" }, a);
    expect(r.status).toBe(503); expect(((await r.json()) as any).configured).toBe(false);
  });
  test("usage endpoint needs a session and returns roll-up shape", async () => {
    const env = mkEnv(); const a = await auth(env);
    expect((await call(env, "/api/usage")).status).toBe(401);
    const j = await (await call(env, "/api/usage?tz=420", {}, a)).json() as any;
    expect(j.today.total.calls).toBe(0); expect(j.month.byModel).toEqual([]); expect(j.tz).toBe(420);
  });
});
