import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { SESSION_COOKIE, makeSession } from "../src/auth";
import { d1Index } from "../src/index-d1";
import { usageReport } from "../src/usage";
import { STUB_PNG_B64 } from "../src/providers/stub-image";
import { stubVideoModels, STUB_MP4_B64 } from "../src/providers/stub-video";
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
  const gets: Array<{ k: string; range?: { offset: number; length: number } }> = [];
  const b = { get: async (k: string, o?: { range?: { offset: number; length: number } }) => { gets.push({ k, range: o?.range }); const e = m.get(k); if (!e) return null;
      const buf = o?.range ? e.buf.slice(o.range.offset, o.range.offset + o.range.length) : e.buf;
      return { arrayBuffer: async () => buf, body: new Response(buf).body, httpMetadata: { contentType: e.ct }, size: e.buf.byteLength }; },
    head: async (k: string) => { const e = m.get(k); return e ? { size: e.buf.byteLength, httpMetadata: { contentType: e.ct } } : null; },
    put: async (k: string, v: ArrayBuffer, o?: any) => { m.set(k, { buf: v, ct: o?.httpMetadata?.contentType }); },
    delete: async (ks: string | string[]) => { for (const k of ([] as string[]).concat(ks)) m.delete(k); },
    list: async (o?: any) => ({ objects: [...m.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((key) => ({ key })), truncated: false }) } as unknown as R2Bucket;
  return { m, b, gets };
};
const CHAT = { idFromName: (n: string) => ({ toString: () => n }), get: () => ({ fetch: async () => Response.json({ seq: 0, messages: [] }) }) } as unknown as DurableObjectNamespace;
const OMNI = "gemini-omni-1.1-flash-preview";
const vparams = { allowed: ["duration_seconds", "resolution", "aspect_ratio"], defaults: { duration_seconds: 3, resolution: "360p" }, values: { duration_seconds: "3..10", resolution: ["360p", "720p"], aspect_ratio: ["16:9", "9:16"] } };
let listFails = false;
const provider: ModelProvider = {
  name: "t", messages: async () => new Response("{}"),
  listModels: async (kind) => { if (listFails) throw new Error("gateway down");
    return kind === "video" ? [{ id: OMNI, displayName: "Omni", kind: "video", params: vparams }, { id: "gemini-3.1-flash-image", displayName: "NB2", kind: "image" }]
    : kind === "image" ? [{ id: "gemini-3.1-flash-image", displayName: "NB2", kind: "image" }]
    : [{ id: "claude-sonnet-5-5", displayName: "Sonnet" }, { id: OMNI, displayName: "leaked video", kind: "video" }, { id: "gemini-3.1-flash-image", displayName: "leaked", kind: "image" }]; },
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
const mp4 = () => Uint8Array.from(atob(STUB_MP4_B64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
const png = () => Uint8Array.from(atob(STUB_PNG_B64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
const newConv = async (env: Env, a: any) => ((await (await call(env, "/api/conversations", { method: "POST", body: "{}" }, a)).json()) as any).id as string;


const UUID = "0b9f8c1e-1111-4222-8333-444455556666";
describe("video model lists", () => {
  test("/api/gen/models?kind=video: only video models, with params, priced flag and the confirm line; /api/models never lists a video model", async () => {
    listFails = false;
    const { env } = mk(); const a = await login(env);
    const v = await (await call(env, "/api/gen/models?kind=video", {}, a)).json() as any;
    expect(v).toEqual({ kind: "video", confirmUsd: 1, models: [{ id: OMNI, name: "Omni", params: vparams, priced: true, priceVerified: false }] });
    const chat = await (await call(env, "/api/models", {}, a)).json() as any;
    expect(chat.models.map((m: any) => m.id)).toEqual(["claude-sonnet-5-5"]);
    const img = await (await call(env, "/api/gen/models?kind=image", {}, a)).json() as any;
    expect(img.models.map((m: any) => m.id)).toEqual(["gemini-3.1-flash-image"]);
    expect((await call(env, "/api/gen/models?kind=video")).status).toBe(401);
  });
  test("the e2e user gets the stub video models (Erich never does); a gateway failure is an error status (the UI falls back)", async () => {
    const { env } = mk(); const e2e = await login(env, "e2e"); const main = await login(env);
    const ids = (j: any) => j.models.map((m: any) => m.id);
    expect(ids(await (await call(env, "/api/gen/models?kind=video", {}, e2e)).json())).toEqual(stubVideoModels().map((m) => m.id));
    expect(ids(await (await call(env, "/api/gen/models?kind=video", {}, main)).json())).not.toContain("e2e-stub-video");
    listFails = true;
    try { expect((await call(env, "/api/gen/models?kind=video", {}, main)).status).toBe(502); } finally { listFails = false; }
  });
});

describe("generated video endpoint (Range, authed, per conversation)", () => {
  test("200 full body with Accept-Ranges / Content-Length / video/mp4; 206 for bytes=0-1 (the iOS probe) and for an open range; 416 past the end", async () => {
    const { env, bk } = mk(); const a = await login(env);
    const c = await newConv(env, a);
    const key = `vertex-client/${c}/gen/${UUID}.mp4`, size = mp4().byteLength;
    bk.m.set(key, { buf: mp4(), ct: "video/mp4" });
    const url = `/api/conversations/${c}/files/gen/${UUID}.mp4`;
    const full = await call(env, url, {}, a);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe(String(size));
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await full.arrayBuffer()).byteLength).toBe(size);
    const probe = await call(env, url, { headers: { range: "bytes=0-1" } }, a);
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
    expect(probe.headers.get("content-length")).toBe("2");
    expect([...new Uint8Array(await probe.arrayBuffer())]).toEqual([...new Uint8Array(mp4().slice(0, 2))]);
    expect(bk.gets.at(-1)).toEqual({ k: key, range: { offset: 0, length: 2 } }); // only the slice is read from R2
    const open = await call(env, url, { headers: { range: "bytes=100-" } }, a);
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe(`bytes 100-${size - 1}/${size}`);
    expect((await open.arrayBuffer()).byteLength).toBe(size - 100);
    const bad = await call(env, url, { headers: { range: `bytes=${size}-` } }, a);
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${size}`);
  });
  test("404: another conversation, another scope (e2e user), missing object, non-video object with an .mp4 name; 401 without a session", async () => {
    const { env, bk } = mk(); const a = await login(env); const e2e = await login(env, "e2e");
    const c1 = await newConv(env, a), c2 = await newConv(env, a);
    const key = `vertex-client/${c1}/gen/${UUID}.mp4`;
    bk.m.set(key, { buf: mp4(), ct: "video/mp4" });
    const tail = `gen/${UUID}.mp4`;
    expect((await call(env, `/api/conversations/${c1}/files/${tail}`, { headers: { range: "bytes=0-1" } })).status).toBe(401);
    expect((await call(env, `/api/conversations/${c2}/files/${tail}`, {}, a)).status).toBe(404);
    expect((await call(env, `/api/conversations/${c2}/files/${encodeURIComponent(key)}`, { headers: { range: "bytes=0-1" } }, a)).status).toBe(404);
    expect((await call(env, `/api/conversations/${c1}/files/${tail}`, { headers: { range: "bytes=0-1" } }, e2e)).status).toBe(404);
    expect((await call(env, `/api/conversations/${c1}/files/gen/aaaaaaaa-1111-4222-8333-444455556666.mp4`, {}, a)).status).toBe(404);
    bk.m.set(`vertex-client/${c1}/gen/bbbbbbbb-1111-4222-8333-444455556666.mp4`, { buf: png(), ct: "text/html" });
    expect((await call(env, `/api/conversations/${c1}/files/gen/bbbbbbbb-1111-4222-8333-444455556666.mp4`, {}, a)).status).toBe(404);
  });
  test("deleting the conversation removes its video (then the endpoint 404s)", async () => {
    const { env, bk } = mk(); const a = await login(env);
    const c = await newConv(env, a);
    bk.m.set(`vertex-client/${c}/gen/${UUID}.mp4`, { buf: mp4(), ct: "video/mp4" });
    expect((await call(env, `/api/conversations/${c}`, { method: "DELETE" }, a)).status).toBe(200);
    expect(bk.m.size).toBe(0);
  });
});

describe("usage row (D1) for a video", () => {
  test("kind=video, units=seconds, est_usd kept; the report's Generation split shows it under 'video · <model>'", async () => {
    const { db, d1: D } = d1();
    db.query(`INSERT INTO conversations (id, model, scope) VALUES ('c1','m','main')`).run();
    const idx = d1Index(D);
    await idx.recordUsage({ conversationId: "c1", model: OMNI, usage: { input_tokens: 9, output_tokens: 5800 }, costUsd: 0.106, kind: "video", estUsd: 0.126, units: 3 });
    await idx.recordUsage({ conversationId: "c1", model: OMNI, usage: {}, costUsd: null, kind: "video", estUsd: 0.385, units: 0 });
    expect(db.query(`SELECT kind, units, est_usd, cost_usd, scope FROM usage ORDER BY id`).all()).toEqual([
      { kind: "video", units: 3, est_usd: 0.126, cost_usd: 0.106, scope: "main" }, { kind: "video", units: 0, est_usd: 0.385, cost_usd: null, scope: "main" }]);
    const rep = await usageReport(D, Date.now(), 0, "main");
    expect(rep.today.gen).toEqual([expect.objectContaining({ key: `video · ${OMNI}`, units: 3, calls: 2, unratedCalls: 1 })]);
  });
});
