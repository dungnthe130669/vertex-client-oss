import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { SESSION_COOKIE, makeSession } from "../src/auth";
import { d1Index } from "../src/index-d1";
import { usageReport } from "../src/usage";
import { stubImageModels, STUB_PNG_B64 } from "../src/providers/stub-image";
import type { ModelProvider } from "../src/providers/types";

const ORIGIN = "https://app.test";
const MIGS = ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0009_usage_generation.sql", "0011_usage_dispatch.sql", "0012_scope_hardening.sql", "0018_projects.sql"];
function d1() {
  const db = new Database(":memory:");
  for (const f of MIGS) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as D1Database };
}
const bucket = () => {
  const m = new Map<string, { buf: ArrayBuffer; ct?: string }>();
  const b = { get: async (k: string) => { const e = m.get(k); return e ? { arrayBuffer: async () => e.buf, body: new Response(e.buf).body, httpMetadata: { contentType: e.ct }, size: e.buf.byteLength } : null; },
    put: async (k: string, v: ArrayBuffer, o?: any) => { m.set(k, { buf: v, ct: o?.httpMetadata?.contentType }); },
    delete: async (ks: string | string[]) => { for (const k of ([] as string[]).concat(ks)) m.delete(k); },
    list: async (o?: any) => ({ objects: [...m.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((key) => ({ key })), truncated: false }) } as unknown as R2Bucket;
  return { m, b };
};
const CHAT = { idFromName: (n: string) => ({ toString: () => n }), get: () => ({ fetch: async () => Response.json({ seq: 0, messages: [] }) }) } as unknown as DurableObjectNamespace;
const provider: ModelProvider = {
  name: "t", messages: async () => new Response("{}"),
  listModels: async (kind) => kind === "image"
    ? [{ id: "gemini-3.1-flash-image", displayName: "NB2", kind: "image" }, { id: "gemini-9-mystery", displayName: "Mystery", kind: "image" }]
    : [{ id: "claude-sonnet-5-5", displayName: "Sonnet" }, { id: "gemini-3.1-flash-image", displayName: "leaked", kind: "image" }],
};
const app = createApp({ provider: () => provider });
import { chatMock } from "./do-mock";
const mk = () => { const dbx = d1(), bk = bucket(); const env: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", E2E_TOKEN: "e".repeat(40), GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: dbx.d1, FILES: bk.b } as unknown as Env; env.CHAT = chatMock(() => env.FILES); return { env, db: dbx.db, bk }; };
const login = async (env: Env, via: "github" | "e2e" = "github") => { const { cookie, session } = await makeSession(env, via === "e2e" ? "e2e-bot" : "example-user", via, via === "e2e" ? 900 : undefined); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const call = (env: Env, path: string, init: RequestInit = {}, a?: { cookie: string; csrf: string }) => {
  const h = new Headers(init.headers); h.set("origin", ORIGIN);
  if (a) { h.set("cookie", a.cookie); if (init.method && init.method !== "GET") h.set("x-csrf-token", a.csrf); }
  return app.fetch(new Request(ORIGIN + path, { ...init, headers: h }), env);
};
const png = () => Uint8Array.from(atob(STUB_PNG_B64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
const newConv = async (env: Env, a: any) => ((await (await call(env, "/api/conversations", { method: "POST", body: "{}" }, a)).json()) as any).id as string;

describe("generated image file endpoint (authed, per conversation)", () => {
  test("serves gen/<uuid>.png with the right type via both the full key and the tail; 401 without a session; foreign conversation 404", async () => {
    const { env, bk } = mk(); const a = await login(env);
    const c1 = await newConv(env, a), c2 = await newConv(env, a);
    const key = `vertex-client/${c1}/gen/0b9f8c1e-1111-4222-8333-444455556666.png`;
    bk.m.set(key, { buf: png(), ct: "image/png" });
    const tail = "gen/0b9f8c1e-1111-4222-8333-444455556666.png";
    for (const ref of [tail, encodeURIComponent(tail), key]) {
      const r = await call(env, `/api/conversations/${c1}/files/${ref}`, {}, a);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await r.arrayBuffer()).length).toBe(png().byteLength);
    }
    expect((await call(env, `/api/conversations/${c1}/files/${tail}`)).status).toBe(401);
    expect((await call(env, `/api/conversations/${c2}/files/${tail}`, {}, a)).status).toBe(404);   // same tail under another conversation: no such object
    expect((await call(env, `/api/conversations/${c2}/files/${encodeURIComponent(key)}`, {}, a)).status).toBe(404); // full foreign key: refBelongsTo refuses
    expect((await call(env, `/api/conversations/${c1}/files/gen/..%2F..%2Fx.png`, {}, a)).status).toBe(404);
  });
  test("the e2e user cannot read Erich's generated image (scope)", async () => {
    const { env, bk } = mk(); const main = await login(env); const e2e = await login(env, "e2e");
    const c = await newConv(env, main);
    bk.m.set(`vertex-client/${c}/gen/aaaaaaaa-1111-4222-8333-444455556666.png`, { buf: png(), ct: "image/png" });
    expect((await call(env, `/api/conversations/${c}/files/gen/aaaaaaaa-1111-4222-8333-444455556666.png`, {}, e2e)).status).toBe(404);
  });
  test("deleting the conversation removes its generated objects (and only its own)", async () => {
    const { env, bk } = mk(); const a = await login(env);
    const c1 = await newConv(env, a), c2 = await newConv(env, a);
    bk.m.set(`vertex-client/${c1}/gen/a1.png`, { buf: png(), ct: "image/png" });
    bk.m.set(`vertex-client/${c1}/gen/a2.jpg`, { buf: png(), ct: "image/jpeg" });
    bk.m.set(`vertex-client/${c2}/gen/b1.png`, { buf: png(), ct: "image/png" });
    expect((await call(env, `/api/conversations/${c1}`, { method: "DELETE" }, a)).status).toBe(200);
    expect([...bk.m.keys()]).toEqual([`vertex-client/${c2}/gen/b1.png`]);
  });
});

describe("model lists never mix chat and image", () => {
  test("/api/models drops image models; /api/gen/models returns only image models with the per-image price and the confirm line", async () => {
    const { env } = mk(); const a = await login(env);
    const chat = await (await call(env, "/api/models", {}, a)).json() as any;
    expect(chat.models.map((m: any) => m.id)).toEqual(["claude-sonnet-5-5"]);
    const gen = await (await call(env, "/api/gen/models?kind=image", {}, a)).json() as any;
    expect(gen.confirmUsd).toBe(1);
    expect(gen.models).toEqual([{ id: "gemini-3.1-flash-image", name: "NB2", perImage: 0.045, priceVerified: false, params: null }, { id: "gemini-9-mystery", name: "Mystery", perImage: null, priceVerified: false, params: null }]);
    expect((await call(env, "/api/gen/models?kind=audio", {}, a)).status).toBe(400); // video is a kind now (test/video-*.test.ts)
    expect((await call(env, "/api/gen/models")).status).toBe(401);
  });
  test("the confirm line follows the settings row gen_confirm_usd (junk falls back to 1.00)", async () => {
    const { env, db } = mk(); const a = await login(env);
    db.query(`INSERT INTO settings (name, value) VALUES ('gen_confirm_usd','2.5')`).run();
    expect(((await (await call(env, "/api/gen/models", {}, a)).json()) as any).confirmUsd).toBe(2.5);
    db.query(`UPDATE settings SET value='abc' WHERE name='gen_confirm_usd'`).run();
    expect(((await (await call(env, "/api/gen/models", {}, a)).json()) as any).confirmUsd).toBe(1);
  });
  test("the e2e user is served the stub models (and Erich never is)", async () => {
    const { env } = mk(); const e2e = await login(env, "e2e"); const main = await login(env);
    const ids = (j: any) => j.models.map((m: any) => m.id);
    expect(ids(await (await call(env, "/api/gen/models", {}, e2e)).json())).toEqual(stubImageModels().map((m) => m.id));
    expect(ids(await (await call(env, "/api/gen/models", {}, main)).json())).not.toContain("e2e-stub-image");
  });
});

describe("usage rows for generation (migration 0009)", () => {
  test("recordUsage kind=image stores kind/est/units with the conversation's scope; chat rows keep the old insert; the report splits Generation by kind/model", async () => {
    const { env, db } = mk();
    const idx = d1Index(env.DB);
    db.query(`INSERT INTO conversations (id, model, scope) VALUES ('c1','m','main'),('c2','m','e2e')`).run();
    await idx.recordUsage({ conversationId: "c1", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.01 });
    await idx.recordUsage({ conversationId: "c1", model: "gemini-3.1-flash-image", usage: { input_tokens: 7, output_tokens: 1120 }, costUsd: 0.0423, kind: "image", estUsd: 0.045, units: 1 });
    await idx.recordUsage({ conversationId: "c1", model: "gemini-3.1-flash-image", usage: {}, costUsd: null, kind: "image", estUsd: 0.09, units: 0 });
    await idx.recordUsage({ conversationId: "c2", model: "e2e-stub-image", usage: {}, costUsd: 0.045, kind: "image", estUsd: 0.045, units: 1 });
    const rows = db.query(`SELECT kind, model, cost_usd, est_usd, units, scope FROM usage ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { kind: "chat", model: "claude-sonnet-5-5", cost_usd: 0.01, est_usd: null, units: null, scope: "main" },
      { kind: "image", model: "gemini-3.1-flash-image", cost_usd: 0.0423, est_usd: 0.045, units: 1, scope: "main" },
      { kind: "image", model: "gemini-3.1-flash-image", cost_usd: null, est_usd: 0.09, units: 0, scope: "main" },
      { kind: "image", model: "e2e-stub-image", cost_usd: 0.045, est_usd: 0.045, units: 1, scope: "e2e" },
    ]);
    const rep = await usageReport(env.DB, Date.now(), 0, "main");
    expect(rep.today.gen).toHaveLength(1);
    expect(rep.today.gen[0]).toMatchObject({ key: "image · gemini-3.1-flash-image", calls: 2, units: 1, unratedCalls: 1 });
    expect(rep.today.gen[0].costUsd).toBeCloseTo(0.0423, 6);
    expect(rep.today.byMode.map((g) => g.key).sort()).toEqual(["chat", "gen"]);
    expect(rep.today.total.calls).toBe(3);
    const e = await usageReport(env.DB, Date.now(), 0, "e2e");
    expect(e.today.gen.map((g) => g.key)).toEqual(["image · e2e-stub-image"]); // scoped
  });
});

describe("/api/gen/models price key (priced -> number, catalog row without price -> null, legacy listing -> absent)", () => {
  const listing = (video: any[], image: any[]): ModelProvider => ({ name: "t", messages: async () => new Response("{}"), listModels: async (k) => (k === "video" ? video : k === "image" ? image : []) });
  const get = async (p: ModelProvider, kind: string, via: "github" | "e2e" = "github") => {
    const { env } = mk(); const a = await login(env, via);
    const r = await createApp({ provider: () => p }).fetch(new Request(`${ORIGIN}/api/gen/models?kind=${kind}`, { headers: { origin: ORIGIN, cookie: a.cookie } }), env);
    return (await r.json()) as any;
  };
  const priced = { unitEstimateUsd: 0.2, verified: true };
  test("video: priced row keeps its price object, price:null row stays null (unknown), legacy row has no price key and the rates table still applies", async () => {
    const j = await get(listing([
      { id: "v-priced", displayName: "P", kind: "video", price: { perSecond: 0.05, verified: true } },
      { id: "v-unpriced", displayName: "U", kind: "video", price: null },
      { id: "e2e-stub-video", displayName: "Legacy", kind: "video" },
    ], []), "video");
    const by = Object.fromEntries(j.models.map((m: any) => [m.id, m]));
    expect(by["v-priced"].price).toEqual({ perSecond: 0.05, verified: true });
    expect(by["v-priced"].priced).toBe(true);
    expect(by["v-unpriced"].price).toBeNull();
    expect(by["v-unpriced"].priced).toBe(false);
    expect("price" in by["e2e-stub-video"]).toBe(false); // JSON must not carry null for a legacy listing: the UI would read "catalog row, no price" = unknown
    expect(by["e2e-stub-video"].priced).toBe(true);
  });
  test("the e2e user's stub video models (no price key) are not 'unknown' in the UI", async () => {
    const j = await get(listing([], []), "video", "e2e");
    expect(j.models.length).toBeGreaterThan(0);
    for (const m of j.models) { expect("price" in m).toBe(false); expect(m.priced).toBe(true); }
  });
  test("image: same three cases", async () => {
    const j = await get(listing([], [
      { id: "i-priced", displayName: "P", kind: "image", price: priced },
      { id: "i-unpriced", displayName: "U", kind: "image", price: null },
      { id: "gemini-3.1-flash-image", displayName: "Legacy", kind: "image" },
    ]), "image");
    const by = Object.fromEntries(j.models.map((m: any) => [m.id, m]));
    expect(by["i-priced"].price).toEqual(priced); expect(by["i-priced"].perImage).toBe(0.2);
    expect(by["i-unpriced"].price).toBeNull(); expect(by["i-unpriced"].perImage).toBeNull();
    expect("price" in by["gemini-3.1-flash-image"]).toBe(false); expect(by["gemini-3.1-flash-image"].perImage).toBe(0.045);
  });
});
