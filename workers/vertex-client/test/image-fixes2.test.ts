import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { DATA_SCOPE_HEADER, E2E_TOOLS, headerScope, hostForScope } from "../src/auth-e2e";
import { destroyOrdered, genImageProblem, b64DecodedLen, GEN_CONCURRENCY, MAX_GEN_BODY_BYTES, MAX_GEN_IMAGE_B64, MAX_GEN_IMAGE_BYTES, MAX_GEN_TOTAL_BYTES, type FileStore } from "../src/files";
import { gatewayProvider } from "../src/providers/gateway";
import { slashItems } from "../src/slash";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { ChatEngine, type IndexSink } from "../src/turn-engine";
import type { ToolDef, ToolHost } from "../src/tools";
import type { ImageResult, ModelProvider } from "../src/providers/types";
import { STUB_PNG_B64 } from "../src/providers/stub-image";
import { chatMock } from "./do-mock";

const ORIGIN = "https://app.test";
const tool = (name: string): ToolDef => ({ name, description: "d", approval: false } as ToolDef);
const rawHost: ToolHost = { list: async () => ["search_notes", "save_note", "read_url", "list_projects"].map(tool), call: async () => ({ text: "", isError: false }) };

describe("item 1: slash catalog gets the caller's scope from the Worker", () => {
  test("headerScope only accepts main|e2e", () => {
    const h = (v?: string) => new Headers(v === undefined ? {} : { [DATA_SCOPE_HEADER]: v });
    expect(headerScope(h("main"))).toBe("main"); expect(headerScope(h("e2e"))).toBe("e2e");
    expect(headerScope(h("admin"))).toBeNull(); expect(headerScope(h(""))).toBeNull(); expect(headerScope(h())).toBeNull();
  });
  test("hostForScope: main -> full catalog, e2e -> only E2E_TOOLS, none -> null (caller falls back to the D1-resolved path)", async () => {
    const main = await hostForScope("main", rawHost)!.list();
    expect(main.map((t) => t.name)).toEqual(["search_notes", "save_note", "read_url", "list_projects"]);
    const e2e = await hostForScope("e2e", rawHost)!.list();
    expect(e2e.map((t) => t.name).every((n) => E2E_TOOLS.has(n))).toBe(true); expect(e2e.map((t) => t.name)).toEqual(["search_notes", "save_note"]);
    expect(hostForScope(null, rawHost)).toBeNull(); expect(hostForScope("main", null)).toBeNull();
  });

  const seen: Array<string | null> = [];
  const mkEnv = (): Env => ({ SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", E2E_TOKEN: "e".repeat(40), GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: {} as any,
    // the catalog DO as the real one behaves: honours the header via hostForScope (main full / e2e restricted)
    CHAT: { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => { const sc = headerScope(r.headers); seen.push(r.headers.get(DATA_SCOPE_HEADER)); const host = hostForScope(sc, rawHost); return Response.json({ tools: host ? (await host.list()).map((t) => ({ ...t, group: "personal-connector" })) : [] }); } }) } } as never);
  const slash = async (via: "github" | "e2e", extra: Record<string, string> = {}) => {
    const e = mkEnv(); const { cookie } = await makeSession(e, via === "e2e" ? "e2e-bot" : "example-user", via, via === "e2e" ? 900 : undefined);
    const r = await createApp().fetch(new Request(`${ORIGIN}/api/slash`, { headers: { origin: ORIGIN, cookie: cookie.split(";")[0], ...extra } }), e);
    return ((await r.json()) as { items: Array<{ kind: string; name: string }> }).items.filter((i) => i.kind === "tool").map((i) => i.name);
  };
  test("main caller -> Worker sends x-data-scope: main -> full classified catalog (not empty)", async () => {
    seen.length = 0; const names = await slash("github");
    expect(seen).toEqual(["main"]); expect(names).toContain("search_notes"); expect(names).toContain("read_url");
  });
  test("e2e caller -> x-data-scope: e2e -> only E2E_TOOLS", async () => {
    seen.length = 0; const names = await slash("e2e");
    expect(seen).toEqual(["e2e"]); expect(names.length).toBeGreaterThan(0); expect(names.every((n) => E2E_TOOLS.has(n))).toBe(true);
  });
  test("spoof: a client-supplied x-data-scope never reaches the DO (e2e caller claiming main still gets e2e)", async () => {
    seen.length = 0; const names = await slash("e2e", { [DATA_SCOPE_HEADER]: "main" });
    expect(seen).toEqual(["e2e"]); expect(names.every((n) => E2E_TOOLS.has(n))).toBe(true); expect(names).not.toContain("read_url");
  });
  test("no header (normal conversation call path) -> null -> D1 resolution stays in force; and slashItems of an empty catalog is builtins only", () => {
    expect(headerScope(new Headers())).toBeNull();
    expect(slashItems([]).every((i) => i.kind === "builtin")).toBe(true);
  });
});

describe("item 2: R2 cleanup happens BEFORE the DO storage clear and the D1 deletes", () => {
  const bucket = (failDelete = false) => { const set = new Set<string>(); return { set, b: { list: async (o: any) => ({ objects: [...set].filter((k) => k.startsWith(o.prefix)).slice(0, o.limit ?? 1000).map((key) => ({ key })), truncated: false }), delete: async (ks: string | string[]) => { if (failDelete) throw new Error("r2 delete failed"); for (const k of [].concat(ks as never)) set.delete(k); } } as unknown as R2Bucket }; };
  test("destroyOrdered: R2 sweep failure -> clear() never runs; retry succeeds and clears after the sweep", async () => {
    const order: string[] = []; const bad = bucket(true); bad.set.add("vertex-client/c1/gen/a.png");
    const r1 = await destroyOrdered(bad.b, "c1", async () => { order.push("clear"); });
    expect(r1).toMatchObject({ ok: false, status: 500 }); expect(order).toEqual([]); expect(bad.set.size).toBe(1);
    const good = bucket(); good.set.add("vertex-client/c1/gen/a.png"); good.set.add("vertex-client/c2/gen/b.png");
    const r2 = await destroyOrdered({ list: good.b.list, delete: async (k) => { order.push("sweep"); return good.b.delete(k); } }, "c1", async () => { order.push("clear"); });
    expect(r2.ok).toBe(true); expect(order).toEqual(["sweep", "clear"]); expect([...good.set]).toEqual(["vertex-client/c2/gen/b.png"]);
    expect((await destroyOrdered(good.b, null, async () => { order.push("x"); })).ok).toBe(false); // R2 configured but no conversation id: refuse
  });
  test("route fault injection: failing R2 -> 500, DO storage NOT cleared, D1 row + messages_index still there; retry -> 200 and everything gone", async () => {
    const db = new Database(":memory:"); for (const f of ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0009_usage_generation.sql", "0011_usage_dispatch.sql", "0012_scope_hardening.sql", "0018_projects.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    const stmt = (q: string, b: unknown[] = []): any => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null, all: async () => ({ results: db.query(q).all(...(b as any)), success: true, meta: {} }), run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; } });
    const bk = bucket(true); const cleared: string[] = [];
    const env: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } }, FILES: bk.b };
    env.CHAT = chatMock(() => env.FILES, undefined, cleared);
    const { cookie, session } = await makeSession(env, "example-user", "github");
    const h = () => new Headers({ origin: ORIGIN, cookie: cookie.split(";")[0], "x-csrf-token": session.csrf });
    const app = createApp();
    const { id } = (await (await app.fetch(new Request(`${ORIGIN}/api/conversations`, { method: "POST", body: "{}", headers: h() }), env)).json()) as any;
    db.query("INSERT INTO messages_index (conversation_id, message_seq, role, text) VALUES (?,?,?,?)").run(id, 1, "user", "hello");
    bk.set.add(`vertex-client/${id}/gen/a.png`);
    const del = () => app.fetch(new Request(`${ORIGIN}/api/conversations/${id}`, { method: "DELETE", headers: h() }), env);
    expect((await del()).status).toBe(500);
    expect(cleared).toEqual([]); // DO storage (the transcript) untouched
    expect((db.query("SELECT count(*) AS n FROM conversations WHERE id=?").get(id) as any).n).toBe(1);
    expect((db.query("SELECT count(*) AS n FROM messages_index WHERE conversation_id=?").get(id) as any).n).toBe(1);
    expect(bk.set.size).toBe(1);
    const ok = bucket(); ok.set.add(`vertex-client/${id}/gen/a.png`); env.FILES = ok.b; // R2 healthy again
    expect((await del()).status).toBe(200);
    expect(cleared).toEqual([id]); expect(ok.set.size).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM conversations WHERE id=?").get(id) as any).n).toBe(0);
  });
});

describe("item 3: generated-output bound and bounded memory", () => {
  test("numbers: 20 MiB decoded per image, body cap ~26.7 MiB, one body in memory at a time", () => {
    expect(MAX_GEN_IMAGE_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_GEN_IMAGE_B64).toBe(27_962_028);
    expect(MAX_GEN_BODY_BYTES).toBe(MAX_GEN_IMAGE_B64 + 64 * 1024);
    expect(GEN_CONCURRENCY).toBe(1);
    // worst case buffered at once: concurrency x (body bytes + decoded text + atob string + Uint8Array), must sit well under the DO's 128 MB
    const worst = GEN_CONCURRENCY * (2 * MAX_GEN_BODY_BYTES + 2 * MAX_GEN_IMAGE_BYTES);
    expect(worst).toBeLessThan(110 * 1024 * 1024);
    expect(MAX_GEN_TOTAL_BYTES).toBe(4 * MAX_GEN_IMAGE_BYTES);
  });
  test("a 20 MiB image passes the check, 20 MiB + 1 byte does not", () => {
    const exact = "A".repeat(MAX_GEN_IMAGE_B64 - 1) + "=";
    expect(b64DecodedLen(exact)).toBe(MAX_GEN_IMAGE_BYTES); expect(genImageProblem(exact)).toBeNull();
    expect(genImageProblem("A".repeat(MAX_GEN_IMAGE_B64 + 4))).toBe("image too large");
  });
  test("gateway: images in one response are summed against the same bound", async () => {
    const half = "A".repeat(Math.ceil(MAX_GEN_IMAGE_B64 * 0.75 / 4) * 4); // ~15 MiB each: fine alone, 2x > 20 MiB
    const mk = (n: number) => gatewayProvider({ fetch: async () => new Response(JSON.stringify({ id: "i", model: "m", images: Array.from({ length: n }, () => ({ mime_type: "image/png", data: half })), text: null })) } as unknown as Fetcher, "k");
    expect((await mk(1).image!({ model: "m", prompt: "p" })).images).toHaveLength(1);
    await expect(mk(2).image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 502 });
  });
  test("engine: n=4 runs at most GEN_CONCURRENCY calls at once, writes each result before the next call, and drops the base64", async () => {
    let inflight = 0, peak = 0; const order: string[] = []; const results: ImageResult[] = [];
    const provider: ModelProvider = { name: "s", listModels: async () => [], messages: async () => Response.json({}), image: async () => { order.push("call"); inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; const r: ImageResult = { model: "m", images: [{ mime_type: "image/png", data: STUB_PNG_B64 }], text: null, finish_reason: "STOP", usage: { input_tokens: 1, output_tokens: 1 }, cost: { usd: 0.01 } }; results.push(r); return r; } };
    const store = new Map<string, Uint8Array>();
    const files: FileStore = { size: async () => null, get: async (k) => store.get(k) ?? null, put: async (k, b) => { order.push("put"); store.set(k, b); }, delete: async () => {} };
    const dbx = new Database(":memory:"); const events: any[] = [];
    const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
    const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = dbx.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } }, provider, index, files, genConfirmUsd: () => 100, sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: 1 });
    engine.setConvId("conv-1");
    await engine.generate({ kind: "image", prompt: "a cube", model: "gemini-3.1-flash-image", n: 4 }); await new Promise((r) => setTimeout(r, 30));
    expect(peak).toBeLessThanOrEqual(GEN_CONCURRENCY);
    expect(order).toEqual(["call", "put", "call", "put", "call", "put", "call", "put"]);
    expect(store.size).toBe(4); expect(results.every((r) => r.images.length === 0)).toBe(true);
  });
});
