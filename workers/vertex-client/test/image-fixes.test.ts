import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolveScope } from "../src/auth-e2e";
import { gatewayProvider, readBoundedJson } from "../src/providers/gateway";
import { chatMock } from "./do-mock";
import { deletePrefix, b64DecodedLen, genImageProblem, MAX_GEN_IMAGE_B64, MAX_GEN_BODY_BYTES, type FileStore } from "../src/files";
import { ChatEngine, type IndexSink } from "../src/turn-engine";
import { ProviderError, type ImageRequest, type ImageResult, type ModelProvider } from "../src/providers/types";
import { STUB_PNG_B64 } from "../src/providers/stub-image";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";

const db1 = (row: unknown, boom = false) => ({ prepare: () => ({ bind: () => ({ first: async () => { if (boom) throw new Error("d1 down"); return row as any; } }) }) });

describe("finding 1: scope fails closed", () => {
  test("scope-main/e2e rows resolve", async () => {
    expect(await resolveScope(db1({ scope: "main" }), "c")).toBe("main");
    expect(await resolveScope(db1({ scope: "e2e" }), "c")).toBe("e2e");
  });
  test("scope-missing-row, scope-unknown-value, scope-d1-error, scope-no-id all throw (never default to main)", async () => {
    await expect(resolveScope(db1(null), "c")).rejects.toThrow();
    await expect(resolveScope(db1({ scope: "weird" }), "c")).rejects.toThrow();
    await expect(resolveScope(db1(null, true), "c")).rejects.toThrow("d1 down");
    await expect(resolveScope(db1({ scope: "main" }), "")).rejects.toThrow();
  });
});

const body = (n: number, chunk = 1024 * 1024) => { let left = n; return new Response(new ReadableStream({ pull(c) { if (left <= 0) return c.close(); const k = Math.min(chunk, left); c.enqueue(new Uint8Array(k).fill(32)); left -= k; } })); };
const fetcher = (mk: () => Response) => ({ fetch: async () => mk() } as unknown as Fetcher);
const img = (data: string) => ({ mime_type: "image/png", data });
const okBody = (images: unknown[]) => JSON.stringify({ id: "i", model: "m", images, text: null, finish_reason: "STOP", cost: { usd: 0.04 } });

describe("finding 2: gateway output bounds", () => {
  test("bounds-body-stream: a body without Content-Length is cut off at the byte limit before JSON parse", async () => {
    await expect(readBoundedJson(body(3000), 1000)).rejects.toMatchObject({ status: 502 });
    const g = gatewayProvider(fetcher(() => body(MAX_GEN_BODY_BYTES + 1024 * 1024)), "k");
    await expect(g.image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 502 });
  });
  test("bounds-content-length: an oversized declared length is refused without reading", async () => {
    const g = gatewayProvider(fetcher(() => new Response("{}", { headers: { "content-length": String(MAX_GEN_BODY_BYTES + 1) } })), "k");
    await expect(g.image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 502 });
  });
  test("bounds-count: more than 2 images per response -> 502", async () => {
    const g = gatewayProvider(fetcher(() => new Response(okBody([img("QUJD"), img("QUJD"), img("QUJD")]))), "k");
    await expect(g.image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 502 });
  });
  test("bounds-per-image: base64 over ceil(5MiB/3)*4 or decoded over 5MiB -> 502; boundary passes", async () => {
    const big = "A".repeat(MAX_GEN_IMAGE_B64 + 4);
    const g = gatewayProvider(fetcher(() => new Response(okBody([img(big)]))), "k");
    await expect(g.image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 502 });
    expect(genImageProblem("A".repeat(MAX_GEN_IMAGE_B64))).toBe("image too large"); // 5MiB+1 byte decoded (ceil rounding)
    expect(genImageProblem("QUJD")).toBeNull();
    expect(genImageProblem("QUJ")).toBe("malformed image data");
    expect(b64DecodedLen("QQ==")).toBe(1);
  });
  test("bounds-ok: a normal response still parses", async () => {
    const g = gatewayProvider(fetcher(() => new Response(okBody([img("QUJD")]))), "k");
    expect((await g.image!({ model: "m", prompt: "p" })).images).toHaveLength(1);
  });
});

function rig(image: (req: ImageRequest, n: number) => Promise<ImageResult> | ImageResult, opts: { put?: FileStore["put"]; conf?: number } = {}) {
  const db = new Database(":memory:");
  const calls: ImageRequest[] = [];
  const provider: ModelProvider = { name: "s", listModels: async () => [], messages: async () => Response.json({}), image: async (req) => { calls.push(req); return image(req, calls.length); } };
  const store = new Map<string, Uint8Array>();
  const files: FileStore = { size: async () => null, get: async (k) => store.get(k) ?? null, put: opts.put ?? (async (k, b) => { store.set(k, b); }), delete: async (ks) => { for (const k of ks) store.delete(k); } };
  const events: any[] = []; const usage: any[] = [];
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async (u) => { usage.push(u); } };
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, files, genConfirmUsd: () => 100, sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: 1,
  });
  engine.setConvId("conv-1");
  return { engine, store, events, usage };
}
const cmd = (o: Record<string, unknown> = {}) => ({ kind: "image", prompt: "a cube", model: "gemini-3.1-flash-image", ...o });
const tick = () => new Promise((r) => setTimeout(r, 10));
const okImg = (o: Partial<ImageResult> = {}): ImageResult => ({ model: "m", images: [{ mime_type: "image/png", data: STUB_PNG_B64 }], text: null, finish_reason: "STOP", usage: { input_tokens: 7, output_tokens: 1120 }, cost: { usd: 0.0423 }, ...o });
const errEvent = (r: ReturnType<typeof rig>) => r.events.find((e) => e.type === "error" || e.error)?.error ?? r.events.find((e) => e.type === "error");

describe("finding 3: exactly one usage row on every exit path once dispatched", () => {
  test("usage-once-success", async () => {
    const r = rig(() => okImg()); await r.engine.generate(cmd()); await tick();
    expect(r.usage).toHaveLength(1); expect(r.usage[0]).toMatchObject({ kind: "image", costUsd: 0.0423, units: 1 });
  });
  test("usage-once-malformed-base64: keeps gateway cost, one row, units 0, error says billing may be uncertain only when cost unknown", async () => {
    const r = rig(() => okImg({ images: [{ mime_type: "image/png", data: "@@@@" }] })); await r.engine.generate(cmd()); await tick();
    expect(r.usage).toHaveLength(1); expect(r.usage[0]).toMatchObject({ costUsd: 0.0423, units: 0, estUsd: 0.045 });
    expect(r.store.size).toBe(0);
  });
  test("usage-once-oversized: refused before decode, null cost + estimate when gateway cost unknown, message flags uncertainty", async () => {
    const r = rig(() => okImg({ cost: {}, images: [{ mime_type: "image/png", data: "A".repeat(MAX_GEN_IMAGE_B64 + 4) }] })); await r.engine.generate(cmd()); await tick();
    expect(r.usage).toHaveLength(1); expect(r.usage[0]).toMatchObject({ costUsd: null, units: 0, estUsd: 0.045 });
    expect(JSON.stringify(r.events)).toContain("Billing may be uncertain");
    expect(r.store.size).toBe(0);
  });
  test("usage-once-r2-failure: put writes to the rig's store, fails on the 2nd write -> 1st key was written, then removed by the engine's delete()", async () => {
    let k = 0, firstKey = "", firstPresentAtFailure = false; let rr!: ReturnType<typeof rig>;
    rr = rig(() => okImg(), { put: async (key, bytes) => { if (++k === 2) { firstPresentAtFailure = rr.store.has(firstKey); throw new Error("r2 down"); } firstKey = key; rr.store.set(key, bytes); } });
    await rr.engine.generate(cmd({ n: 2 })); await tick();
    expect(k).toBe(2); expect(firstKey).toMatch(/^vertex-client\/conv-1\/gen\//);
    expect(firstPresentAtFailure).toBe(true); // really written before the failure
    expect(rr.store.has(firstKey)).toBe(false); // ...and rolled back by the engine's delete()
    expect(rr.store.size).toBe(0);
    expect(rr.usage).toHaveLength(1); expect(rr.usage[0]).toMatchObject({ costUsd: 0.0846, units: 0 });
  });
  test("usage-once-too-many-images", async () => {
    const r = rig(() => okImg({ images: [0, 1, 2].map(() => ({ mime_type: "image/png", data: STUB_PNG_B64 })) })); await r.engine.generate(cmd()); await tick();
    expect(r.usage).toHaveLength(1); expect(r.store.size).toBe(0);
  });
  test("usage-once-abort: abort mid-request still records exactly one row", async () => {
    let started!: () => void; const s = new Promise<void>((res) => (started = res));
    const r = rig(() => { started(); return new Promise<ImageResult>((_, rej) => setTimeout(() => rej(new ProviderError("x", 502)), 30)); });
    const p = r.engine.generate(cmd()); await s; r.engine.stop(); await p; await tick();
    expect(r.usage).toHaveLength(1); expect(r.usage[0]).toMatchObject({ costUsd: null });
  });
  test("usage-once-all-failed", async () => {
    const r = rig(() => { throw new ProviderError("down", 502); }); await r.engine.generate(cmd()); await tick();
    expect(r.usage).toHaveLength(1); expect(r.usage[0]).toMatchObject({ costUsd: null, units: 0 });
  });
  test("usage-none-before-dispatch: a missing reference image fails before any request -> no usage row", async () => {
    const r = rig(() => okImg());
    await r.engine.generate(cmd({ files: [{ ref: "vertex-client/conv-1/nope", name: "a", mime: "image/png", size: 1 }] })); await tick();
    expect(r.usage).toHaveLength(0);
  });
});

describe("finding 4: conversation delete cleanup", () => {
  const paged = (keys: string[], opts: { stuck?: boolean; failDelete?: boolean } = {}) => {
    const set = new Set(keys); let calls = 0;
    return { set, b: { list: async (o: any) => { calls++; const all = [...set].filter((k) => k.startsWith(o.prefix)); const page = all.slice(0, o.limit ?? 1000); return { objects: page.map((key) => ({ key })), truncated: all.length > page.length }; },
      delete: async (ks: string[]) => { if (opts.failDelete) throw new Error("r2 delete failed"); if (!opts.stuck) for (const k of ks) set.delete(k); } } as any, calls: () => calls };
  };
  test("delete-prefix-loop: more than 1000 objects are all removed (looped until empty)", async () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `vertex-client/c/gen/${i}.png`); const p = paged([...keys, "vertex-client/other/x"]);
    expect(await deletePrefix(p.b, "vertex-client/c/")).toBe(2500);
    expect([...p.set]).toEqual(["vertex-client/other/x"]);
  });
  test("delete-prefix-no-progress: objects that never go away throw instead of spinning", async () => {
    const p = paged(["vertex-client/c/a"], { stuck: true });
    await expect(deletePrefix(p.b, "vertex-client/c/")).rejects.toThrow("no progress");
  });
  test("delete-route-fails: a failing R2 delete -> 500, conversation row kept; healthy -> 200 and empty", async () => {
    const mkApp = (bk: any) => {
      const db = new Database(":memory:"); for (const f of ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0009_usage_generation.sql", "0011_usage_dispatch.sql", "0012_scope_hardening.sql", "0018_projects.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
      const stmt = (q: string, b: unknown[] = []): any => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null, all: async () => ({ results: db.query(q).all(...(b as any)), success: true, meta: {} }), run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; } });
      const env = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") },
        DB: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } }, FILES: bk,
        CHAT: chatMock(() => bk) } as unknown as Env;
      return { env, db };
    };
    const app = createApp({ provider: () => ({ name: "t", messages: async () => new Response("{}"), listModels: async () => [] }) });
    const run = async (bk: any) => {
      const { env, db } = mkApp(bk);
      const { cookie, session } = await makeSession(env, "example-user", "github");
      const h = (m?: string) => { const x = new Headers({ origin: "https://app.test", cookie }); if (m) x.set("x-csrf-token", (session as any).csrf); return x; };
      const cr = await app.fetch(new Request("https://app.test/api/conversations", { method: "POST", body: "{}", headers: h("p") }), env);
      const { id } = (await cr.json()) as any;
      bk.__seed?.(id);
      const del = await app.fetch(new Request(`https://app.test/api/conversations/${id}`, { method: "DELETE", headers: h("p") }), env);
      return { del, left: db.query("SELECT count(*) AS n FROM conversations WHERE id=?").get(id) as any };
    };
    const bad = paged([], { failDelete: true }); (bad.b as any).__seed = (id: string) => bad.set.add(`vertex-client/${id}/a`);
    const r1 = await run(bad.b); expect(r1.del.status).toBe(500); expect(r1.left.n).toBe(1);
    const good = paged([]); (good.b as any).__seed = (id: string) => { for (let i = 0; i < 1200; i++) good.set.add(`vertex-client/${id}/gen/${i}.png`); };
    const r2 = await run(good.b); expect(r2.del.status).toBe(200); expect(r2.left.n).toBe(0); expect(good.set.size).toBe(0);
  });
});
