// Provider standard P1: descriptor, DB catalog (provider_models), /api/models served from it. Behaviour for NVIDIA / Cloudflare stays identical.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { setOpenFlag } from "../src/open-space";
import { buildRegistry } from "../src/providers/registry";
import { PROVIDERS, nvidiaDefaultModels, parseConfig } from "../src/providers/config";
import { CLOUDFLARE_MODELS } from "../src/providers/cloudflare";
import { NVIDIA_IMAGE_MODELS, NVIDIA_VERIFIED, isChatId } from "../src/providers/presets";
import { SEED_COLUMNS, loadCatalog, priceOf, seedCatalog, seedRowValues } from "../src/providers/catalog";
import { NVIDIA_CHAT_SEED, NVIDIA_CHAT_SORT_BASE, NVIDIA_RETIRED_IDS, SEED_MODELS } from "../src/providers/seed";
import { CLOUDFLARE_DESCRIPTOR, DESCRIPTORS, GATEWAY_DESCRIPTOR, NVIDIA_DESCRIPTOR, discoveredKind, protocolOfKind, validateDescriptor, type ProviderDescriptor } from "../src/providers/descriptor";
import { NO_CAPABILITIES } from "../src/providers/types";

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }), run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; } } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as unknown as D1Database };
}
const gw = { name: "gw", messages: async () => new Response("{}"), listModels: async () => [{ id: "claude-sonnet-5-5", displayName: "S" }] };

// The OLD constants, copied here as an independent oracle (src no longer holds them as data).
// Working NIM ids in display order after migration 0032 (nim-speed.md: the dead ones are disabled, not deleted).
const OLD_NVIDIA = ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b", "minimaxai/minimax-m3.1-flash", "nvidia/nemotron-3.5-bolt-e4b", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "z-ai/glm-5.3-flash"];
const RETIRED = ["nvidia/nemotron-3-super-120b-a12b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b", "deepseek-ai/deepseek-v4.1-flash", "meta/llama-3.2-11b-vision-instruct", "meta/muse-glimmer-30b", "poolside/laguna-xs-2.1"];
const OLD_TOOLS = ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning-30b-a3b", "minimaxai/minimax-m3.1-flash", "z-ai/glm-5.3-flash", "nvidia/nemotron-3.5-bolt-e4b"];
const OLD_VISION = ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "minimaxai/minimax-m3.1-flash", "z-ai/glm-5.3-flash"];
const OLD_LABELS: Record<string, string> = { "nvidia/nemotron-3-ultra-550b-a55b": "Nemotron 3 Ultra 550B", "nvidia/nemotron-3.5-lightning-30b-a3b": "Nemotron 3.5 Lightning 30B", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": "Nemotron 3 Nano Omni 30B", "minimaxai/minimax-m3.1-flash": "MiniMax M3.1 Flash", "openai/gpt-oss-20b": "GPT-OSS 20B", "deepseek-ai/deepseek-v4.1-flash": "DeepSeek V4.1 Flash", "z-ai/glm-5.3-flash": "GLM 5.3 Flash", "meta/muse-glimmer-30b": "Muse Glimmer 30B", "nvidia/nemotron-3.5-bolt-e4b": "Nemotron 3.5 Bolt E4B", "meta/llama-3.2-11b-vision-instruct": "Llama 3.2 11B Vision", "poolside/laguna-xs-2.1": "Laguna XS 2.1" };
const OLD_NOT_CHAT = /embed|rerank|reward|guard|safety|retriev|parse|ocr|clip|-vlm-?encoder|riva|tts|asr|translate|segment|diffusion|flux|sdxl/i;

describe("migrations 0029 + 0030 seed == src seed (no drift)", () => {
  test("every seed model is a provider_models row with exactly the generated values (sort aside); the retired NIM rows stay, disabled; nothing else extra", () => {
    const { db } = d1();
    const rows = db.query(`SELECT ${SEED_COLUMNS.join(", ")} FROM provider_models ORDER BY provider_id, sort`).all() as any[];
    expect(SEED_MODELS.length).toBe(32); expect(rows.length).toBe(27 + 7 + 3); // 27 NVIDIA/Cloudflare rows (0029) + 7 AI Studio rows (0030) + 3 Groq rows (0031); 0032 adds none
    expect(rows.length).toBe(SEED_MODELS.length + RETIRED.filter((id) => rows.some((r) => r.provider_id === "nvidia" && r.model_id === id)).length);
    for (const [i, m] of SEED_MODELS.entries()) { const r = rows.find((x) => x.provider_id === m.provider && x.model_id === m.id); const { sort: _a, ...a } = r; const { sort: _b, ...b } = seedRowValues(m, i); expect(a).toEqual(b); }
    for (const r of rows.filter((x) => x.provider_id === "nvidia" && RETIRED.includes(x.model_id))) expect(r.enabled).toBe(0);
  });
  test("0032: NIM chat sort = NVIDIA_CHAT_SORT_BASE + seed position (after Groq); every other provider keeps its seed order", () => {
    const { db } = d1();
    const sorted = (p: string, k: string) => (db.query(`SELECT model_id FROM provider_models WHERE provider_id=? AND kind=? AND enabled=1 ORDER BY sort`).all(p, k) as any[]).map((r) => r.model_id);
    expect(sorted("nvidia", "chat")).toEqual(OLD_NVIDIA);
    expect(NVIDIA_CHAT_SEED.map((m) => m.id)).toEqual(OLD_NVIDIA);
    const sorts = (db.query(`SELECT sort FROM provider_models WHERE provider_id='nvidia' AND enabled=1 AND kind='chat' ORDER BY sort`).all() as any[]).map((r) => r.sort);
    expect(sorts).toEqual(OLD_NVIDIA.map((_, i) => NVIDIA_CHAT_SORT_BASE + i)); expect(sorts[0]).toBeGreaterThan(Math.max(...(db.query(`SELECT sort FROM provider_models WHERE provider_id='groq'`).all() as any[]).map((r) => r.sort)));
    for (const p of ["cloudflare", "aistudio", "groq"]) for (const k of ["chat", "image"]) expect(sorted(p, k)).toEqual(SEED_MODELS.filter((m) => m.provider === p && m.kind === k).map((m) => m.id));
    expect(new Set(NVIDIA_RETIRED_IDS)).toEqual(new Set(RETIRED));
  });
  test("0032 is idempotent and keeps an admin disable / an admin rename / a missing row untouched", () => {
    const { db } = d1(); const sql = readFileSync(new URL("../migrations/0032_nim_catalog.sql", import.meta.url), "utf8");
    db.query(`UPDATE provider_models SET enabled=0, display_name='Mine' WHERE model_id='z-ai/glm-5.3-flash'`).run();
    const snap = () => JSON.stringify(db.query(`SELECT * FROM provider_models ORDER BY provider_id, model_id`).all()); const before = snap();
    db.exec(sql); expect(snap()).toBe(before);
    expect(db.query(`SELECT enabled, display_name FROM provider_models WHERE model_id='z-ai/glm-5.3-flash'`).get()).toEqual({ enabled: 0, display_name: "Mine" });
    expect((db.query(`SELECT COUNT(*) AS n FROM provider_models WHERE provider_id='nvidia' AND model_id IN ('openai/gpt-oss-120b','qwen/qwen3.8-27b','nvidia/nemotron-3-super-120b-a12b')`).get() as any).n).toBe(0); // not inserted
  });
  test("no seed row has a price except Groq's, which carries a source (unknown stays null, never free) and `tools` only where a live/doc reference is recorded", () => {
    const { db } = d1();
    for (const r of db.query(`SELECT * FROM provider_models`).all() as any[]) { if (r.provider_id === "groq") expect(JSON.parse(r.price_json).source).toMatch(/^seed:2026-10-26:/); else expect(r.price_json).toBeNull(); if (JSON.parse(r.capabilities_json).tools) expect(String(r.seed_ref)).toMatch(/live 2026-10-26|developers\.cloudflare\.com|groq-probe 2026-10-26/); }
  });
});

describe("snapshot: the DB catalog serves what the old constants served", () => {
  test("NVIDIA chat list: same ids in the same order, same labels, same tools/vision sets, same token caps, nothing else", async () => {
    const { d1: db } = d1(); const cat = await loadCatalog(db);
    for (const models of [nvidiaDefaultModels(cat), nvidiaDefaultModels(), nvidiaDefaultModels(seedCatalog())]) {
      expect(models.map((m) => m.id)).toEqual(OLD_NVIDIA);
      for (const m of models) {
        expect(m.displayName).toBe(OLD_LABELS[m.id]);
        expect(m.capabilities).toEqual({ ...NO_CAPABILITIES, text: true, tools: OLD_TOOLS.includes(m.id), vision: OLD_VISION.includes(m.id) });
        expect(m).toMatchObject({ pricePerMTok: null, contextWindow: null, maxTokens: 16000, maxOutput: 16000 });
      }
    }
    expect(NVIDIA_VERIFIED).toEqual(OLD_NVIDIA);
  });
  test("NVIDIA image models (slug + steps) and the Cloudflare chat+image lists are unchanged", async () => {
    expect(NVIDIA_IMAGE_MODELS).toEqual([{ id: "black-forest-labs/flux.2-klein-4b", label: "FLUX.2 klein 4B", slug: "flux.2-klein-4b", steps: 4 }, { id: "black-forest-labs/flux-3-image-klein", label: "FLUX.3 image klein", slug: "flux-3-image-klein", steps: 4 }, { id: "black-forest-labs/flux.1-dev", label: "FLUX.1 dev", slug: "flux.1-dev", steps: 5 }]);
    expect(CLOUDFLARE_MODELS.map((m) => m.id)).toEqual(["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b", "@cf/google/gemma-4-26b-a4b-it", "@cf/zai-org/glm-4.7-flash", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/meta/llama-3.1-8b-instruct-fp8", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/black-forest-labs/flux-1-schnell", "@cf/bytedance/stable-diffusion-xl-lightning", "@cf/stabilityai/stable-diffusion-xl-base-1.0", "@cf/lykon/dreamshaper-8-lcm"]);
    const { d1: db } = d1(); const cat = await loadCatalog(db);
    const reg = buildRegistry({ scope: "main~open" as any, gateway: gw, env: { AI: {} }, catalog: cat });
    const regOld = buildRegistry({ scope: "main~open" as any, gateway: gw, env: { AI: {} } });
    const a = (await reg.models()).filter((m) => m.provider === "cloudflare"), b = (await regOld.models()).filter((m) => m.provider === "cloudflare");
    expect(a).toEqual(b); expect(a.length).toBe(9);
    expect(a.find((m) => m.id === "cloudflare:@cf/openai/gpt-oss-120b")!.capabilities).toEqual({ ...NO_CAPABILITIES, text: true, tools: true, reasoning: true });
    expect((await reg.router.listModels("image")).filter((m) => m.id.startsWith("cloudflare:")).length).toBe(4);
  });
  test("discovery rules == the old NOT_CHAT regex over a corpus", () => {
    const corpus = ["nvidia/nv-embedqa-e5-v5", "nvidia/llama-3.2-nv-rerankqa-1b-v2", "nvidia/nemoguard-8b", "meta/llama-guard-4-12b", "nvidia/nemotron-3-super-120b-a12b", "meta/llama-3.1-8b-instruct", "nvidia/nemotron-parse", "baidu/paddleocr", "nvidia/nv-clip", "nvidia/nemotron-vlm-encoder", "nvidia/vlmencoder", "nvidia/riva-translate-4b", "nvidia/parakeet-asr", "x/tts-1", "stabilityai/stable-diffusion-xl", "black-forest-labs/FLUX.1-dev", "nvidia/SDXL-turbo", "nvidia/segment-anything", "openai/gpt-oss-20b", "NVIDIA/Retriever-X", "deepseek-ai/deepseek-v4.1-flash", "nvidia/reward-model", "nvidia/safety-guard"];
    for (const id of corpus) expect(isChatId(id)).toBe(!OLD_NOT_CHAT.test(id));
    expect(discoveredKind(NVIDIA_DESCRIPTOR, "x/EMBED-1")).toBe("skip");
  });
});

describe("loadCatalog", () => {
  test("DB rows are authoritative: a rename, a disabled model and a priced model show; a provider whose rows were all deleted lists nothing (no seed re-enable)", async () => {
    const { db, d1: dd } = d1();
    db.query(`UPDATE provider_models SET display_name='Renamed', enabled=1 WHERE model_id='nvidia/nemotron-3.5-bolt-e4b'`).run();
    db.query(`UPDATE provider_models SET enabled=0 WHERE model_id='nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'`).run();
    db.query(`UPDATE provider_models SET price_json=? WHERE model_id='z-ai/glm-5.3-flash'`).run(JSON.stringify({ input: 0.1, output: 0.4, source: "admin" }));
    db.query(`DELETE FROM provider_models WHERE provider_id='cloudflare'`).run();
    const cat = await loadCatalog(dd); const m = nvidiaDefaultModels(cat);
    expect(m.find((x) => x.id === "nvidia/nemotron-3.5-bolt-e4b")!.displayName).toBe("Renamed");
    expect(m.some((x) => x.id === "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")).toBe(false); expect(m.length).toBe(5);
    expect(m.find((x) => x.id === "z-ai/glm-5.3-flash")!.pricePerMTok).toEqual({ input: 0.1, output: 0.4 });
    expect(cat.get("cloudflare") ?? []).toEqual([]); // table has rows: authoritative, nothing re-enabled from the seed
  });
  test("no DB / missing table / empty table = seed; any other D1 error = last good, else empty (never throw, never re-enable)", async () => {
    const seed = [...seedCatalog().keys()].sort();
    expect([...(await loadCatalog(undefined)).keys()].sort()).toEqual(seed);
    const bad = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    expect((await loadCatalog(bad)).size).toBe(0); // other D1 error, no last good: fail closed
    const noTable = new Database(":memory:"); const nd = { prepare: (q: string) => ({ all: async () => ({ results: noTable.query(q).all() }) }) } as unknown as D1Database;
    expect((await loadCatalog(nd)).get("nvidia")!.length).toBe(9);
    const { db, d1: dd } = d1(); db.query(`DELETE FROM provider_models`).run();
    expect((await loadCatalog(dd)).get("nvidia")!.length).toBe(9); // never written
  });
  test("a D1 error after a good read serves the last good catalog: an admin-disabled model stays off", async () => {
    const { db, d1: dd } = d1(); db.query(`UPDATE provider_models SET enabled=0 WHERE model_id='nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'`).run();
    const ok = await loadCatalog(dd); expect(nvidiaDefaultModels(ok).some((x) => x.id === "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")).toBe(false);
    const flaky = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    const wrap = new Proxy(dd, { get: (t, k) => (k === "prepare" ? flaky.prepare : (t as any)[k]) });
    expect(await loadCatalog(wrap)).toBeInstanceOf(Map); // a different handle has no cache: closed
    expect((await loadCatalog(wrap)).size).toBe(0);
    let fail = false; const sw = { prepare: (q: string) => (fail ? flaky.prepare(q) : dd.prepare(q)) } as unknown as D1Database;
    await loadCatalog(sw); fail = true;
    const again = await loadCatalog(sw);
    expect(nvidiaDefaultModels(again).length).toBe(5); expect(nvidiaDefaultModels(again).some((x) => x.id === "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")).toBe(false);
  });
  test("a price needs a source and finite non-negative numbers; unknown stays null, never 0", () => {
    expect(priceOf(null)).toBeNull(); expect(priceOf(JSON.stringify({ input: 1, output: 2 }))).toBeNull(); expect(priceOf(JSON.stringify({ input: 1, source: "admin" }))).toBeNull();
    expect(priceOf(JSON.stringify({ input: -1, output: 2, source: "admin" }))).toBeNull(); expect(priceOf("not json")).toBeNull();
    expect(priceOf(JSON.stringify({ input: 0.5, output: 1.5, source: "seed:2026-10-26:https://x" }))).toMatchObject({ input: 0.5, output: 1.5 });
  });
  test("a stored nvidia row at the preset origin is raised from the catalog; moved elsewhere it is text-only (rule unchanged)", async () => {
    const { db, d1: dd } = d1(); db.query(`UPDATE provider_models SET capabilities_json='{"text":true}' WHERE model_id='nvidia/nemotron-3.5-bolt-e4b'`).run();
    const cat = await loadCatalog(dd);
    const row = (base: string) => ({ id: "nvidia", kind: "openai-compat", base_url: base, enabled: 1, models_json: JSON.stringify([{ id: "nvidia/nemotron-3.5-bolt-e4b", capabilities: { text: true, tools: true, vision: false } }]) });
    expect(parseConfig(row("https://integrate.api.nvidia.com/v1"), cat)!.models[0]!.capabilities.tools).toBe(false); // catalog says text-only: the catalog row wins over stale stored caps
    expect(parseConfig(row("https://evil.example.com/v1"), cat)!.models[0]!.capabilities.tools).toBe(false);
  });
  test("a stored nvidia model the admin disabled / broke is not callable; live ones take limits+caps from the catalog row", async () => {
    const { db, d1: dd } = d1();
    db.query(`UPDATE provider_models SET enabled=0 WHERE model_id='nvidia/nemotron-3.5-bolt-e4b'`).run();
    db.query(`UPDATE provider_models SET broken=1 WHERE model_id='z-ai/glm-5.3-flash'`).run();
    db.query(`UPDATE provider_models SET limits_json='{"maxTokens":1234,"maxOutput":999}' WHERE model_id='minimaxai/minimax-m3.1-flash'`).run();
    const cat = await loadCatalog(dd);
    const stored = ["nvidia/nemotron-3.5-bolt-e4b", "z-ai/glm-5.3-flash", "minimaxai/minimax-m3.1-flash"].map((id) => ({ id, maxTokens: 99999, maxOutput: 99999, capabilities: { text: true, tools: true, vision: true } }));
    const c = parseConfig({ id: "nvidia", kind: "openai-compat", base_url: "https://integrate.api.nvidia.com/v1", enabled: 1, models_json: JSON.stringify(stored) }, cat)!;
    expect(c.models.map((m) => m.id)).toEqual(["minimaxai/minimax-m3.1-flash"]);
    expect(c.models[0]).toMatchObject({ maxTokens: 1234, maxOutput: 999 });
  });
  test("cloudflare routes chat vs image by the catalog row kind, not the image-gen capability", async () => {
    const { cloudflareProvider } = await import("../src/providers/cloudflare");
    const m = (id: string, kind: "chat" | "image", img: boolean) => ({ id, kind, displayName: id, capabilities: { ...NO_CAPABILITIES, text: kind === "chat", "image-gen": img }, pricePerMTok: null });
    const p = cloudflareProvider({ id: "cloudflare", kind: "cloudflare", enabled: true, models: [m("c1", "chat", true), m("i1", "image", false)] }, {} as any);
    expect((await p.listModels("chat")).map((x) => x.id)).toEqual(["c1"]);
    expect((await p.listModels("image")).map((x) => x.id)).toEqual(["i1"]);
  });
});

describe("/api/models from the DB catalog", () => {
  const GA = "g:abcdefghijklmnopqrstuvwx";
  const app = createApp({ scopeOf: () => "main", provider: () => gw });
  const mkEnv = () => { const x = d1(); const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", AI: {}, PROVIDER_KEY_NVIDIA: "nvapi-test-0123456789", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, _db: x.db }; return e as Env & { _db: Database }; };
  const get = async (env: any, path: string) => { const m = await makeSession(env, "example-user", "github"); return app.fetch(new Request("https://app.test" + path, { headers: { cookie: m.cookie.split(";")[0]!, "x-vc-space": "open" } }), env); };
  test("lists NVIDIA + Cloudflare from the rows with flags, no price, speed unknown; edits in D1 show up; picker shape intact", async () => {
    const env = mkEnv();
    const j = await (await get(env, "/api/models")).json() as any;
    const nv = j.models.filter((m: any) => m.provider === "nvidia");
    expect(nv.map((m: any) => m.id)).toEqual(OLD_NVIDIA.map((x) => `nvidia:${x}`));
    expect(j.default).toBe("nvidia:nvidia/nemotron-3.5-lightning-30b-a3b"); // Open default is Lightning (OPEN_DEFAULT_ORDER), no longer just the first listed model
    const ultra = nv[1]; expect(ultra).toMatchObject({ name: "Nemotron 3 Ultra 550B", kind: "chat", flags: { vision: false, tools: true, image: false }, priceEstimate: null, speed: { tier: "unknown", samples: 0, firstAnswerMs: null, totalMs: null } });
    expect(ultra.capabilities.tools).toBe(true); expect(ultra).toHaveProperty("meta");
    expect(nv.find((m: any) => m.id === "nvidia:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning").flags).toEqual({ vision: true, tools: false, image: false });
    expect(j.models.filter((m: any) => m.provider === "cloudflare").length).toBe(9);
    env._db.query(`UPDATE provider_models SET enabled=0 WHERE model_id='minimaxai/minimax-m3.1-flash'`).run();
    env._db.query(`UPDATE provider_models SET display_name='Ultra!', price_json=? WHERE model_id='nvidia/nemotron-3-ultra-550b-a55b'`).run(JSON.stringify({ input: 1.25, output: 5, source: "admin" }));
    env._db.query(`UPDATE provider_models SET price_json=? WHERE model_id='nvidia/nemotron-3.5-bolt-e4b'`).run(JSON.stringify({ input: 0, output: 0 })); // no source: ignored, never "free"
    const k = await (await get(env, "/api/models")).json() as any;
    const nv2 = k.models.filter((m: any) => m.provider === "nvidia");
    expect(nv2.some((m: any) => m.id === "nvidia:minimaxai/minimax-m3.1-flash")).toBe(false);
    expect(nv2[1]).toMatchObject({ name: "Ultra!", priceEstimate: { inputPerMTok: 1.25, outputPerMTok: 5, source: "admin", estimate: true } });
    expect(nv2.find((m: any) => m.id === "nvidia:nvidia/nemotron-3.5-bolt-e4b").priceEstimate).toBeNull();
  });
  test("0032: /api/models offers exactly the working NIM chat models (no dead ids, no duplicates, display order), with unknown price and untested flags false", async () => {
    const env = mkEnv(); const j = await (await get(env, "/api/models")).json() as any;
    const ids = j.models.map((m: any) => m.id); expect(new Set(ids).size).toBe(ids.length);
    const nv = j.models.filter((m: any) => m.provider === "nvidia" && m.kind === "chat");
    expect(nv.map((m: any) => m.id)).toEqual(OLD_NVIDIA.map((x) => `nvidia:${x}`));
    for (const d of RETIRED) expect(ids).not.toContain(`nvidia:${d}`);
    for (const id of ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3.5-bolt-e4b", "minimaxai/minimax-m3.1-flash", "nvidia/nemotron-3-ultra-550b-a55b"]) { const m = nv.find((x: any) => x.id === `nvidia:${id}`); expect(m.priceEstimate).toBeNull(); }
    expect(nv.find((m: any) => m.id === "nvidia:nvidia/nemotron-3-ultra-550b-a55b").flags.image).toBe(false);
  });
  test("without migration 0029 (table missing) the picker still lists the same models from the seed", async () => {
    const env = mkEnv(); env._db.exec("DROP TABLE provider_models; DROP TABLE model_latency_stats;");
    const j = await (await get(env, "/api/models")).json() as any;
    expect(j.models.filter((m: any) => m.provider === "nvidia").map((m: any) => m.id)).toEqual(OLD_NVIDIA.map((x) => `nvidia:${x}`));
    expect(j.models.find((m: any) => m.provider === "nvidia").speed.tier).toBe("unknown");
  });
  test("Business (Vertex) models get the same decoration and no price estimate", async () => {
    const env = mkEnv(); const m = await makeSession(env, "example-user", "github");
    const j = await (await app.fetch(new Request("https://app.test/api/models", { headers: { cookie: m.cookie.split(";")[0]! } }), env)).json() as any;
    expect(j.models[0]).toMatchObject({ provider: "gateway", priceEstimate: null, speed: { tier: "unknown" } });
  });
});

describe("descriptor", () => {
  test("built-in descriptors validate; protocol back-fill: openai-compat -> openai", () => {
    for (const d of Object.values(DESCRIPTORS)) expect(validateDescriptor(d)).toEqual([]);
    expect(protocolOfKind("openai-compat")).toBe("openai"); expect(protocolOfKind("cloudflare")).toBe("cloudflare-binding"); expect(protocolOfKind("nope")).toBeNull();
    expect(NVIDIA_DESCRIPTOR).toMatchObject({ protocol: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", authStyle: "bearer", keyMode: "user-or-worker", space: "open" });
    expect(GATEWAY_DESCRIPTOR.space).toBe("biz"); expect(CLOUDFLARE_DESCRIPTOR.keyMode).toBe("none");
  });
  test("the NVIDIA descriptor matches the preset the app really uses", async () => {
    const { PRESETS } = await import("../src/providers/presets");
    expect(PRESETS[0]!.baseUrl).toBe(NVIDIA_DESCRIPTOR.baseUrl!); expect(PRESETS[0]!.authHeader).toBe(NVIDIA_DESCRIPTOR.authStyle);
    expect(PROVIDERS.some((p) => p.id === "cloudflare" && p.kind === "cloudflare")).toBe(true);
  });
  test("a Groq-shaped descriptor is expressible (reasoning policy, deny-list, max_completion_tokens, parallel tools, non-chat filter) and valid", () => {
    const groq: ProviderDescriptor = {
      id: "groq", label: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", authStyle: "bearer", keyMode: "user", space: "open",
      capabilities: { text: true }, limits: { rpm: 30, rpd: 14400, note: "tier dependent" }, kinds: ["chat"],
      dialect: { maxTokensParam: "max_completion_tokens", paramDenylist: ["logprobs", "logit_bias", "top_logprobs", "messages[].name", "n!=1"], parallelTools: false, builtinToolsNever: true,
        reasoning: { control: "effort", effortValues: ["low", "medium", "high"], field: "reasoning", formatParam: { name: "reasoning_format", value: "parsed" } } },
      discovery: ["whisper", "orpheus", "prompt-guard", "safeguard"].map((contains) => ({ contains, kind: "skip" as const })),
    };
    expect(validateDescriptor(groq)).toEqual([]);
    expect(discoveredKind(groq, "whisper-large-v3")).toBe("skip"); expect(discoveredKind(groq, "nvidia/nemotron-3.5-bolt-e4b")).toBe("chat");
  });
  test("validation refuses http, userinfo, a reserved auth header, biz for a non-gateway provider, a secret-looking value, an unbounded rule list", () => {
    const ok: ProviderDescriptor = { ...NVIDIA_DESCRIPTOR, id: "acme" };
    expect(validateDescriptor({ ...ok, baseUrl: "http://x.example.com/v1" }).length).toBe(1);
    expect(validateDescriptor({ ...ok, baseUrl: "https://u:p@x.example.com/v1" }).length).toBeGreaterThan(0);
    expect(validateDescriptor({ ...ok, authStyle: "custom:cookie" })).toContain("authStyle names a reserved header");
    expect(validateDescriptor({ ...ok, space: "biz" })).toContain("only the Vertex gateway may be space=biz");
    expect(validateDescriptor({ ...ok, label: "nvapi-abcdefghijklmnop" })).toContain("looks like a secret");
    expect(validateDescriptor({ ...ok, discovery: Array.from({ length: 101 }, () => ({ contains: "x", kind: "skip" as const })) }).length).toBe(1);
    expect(validateDescriptor({ ...ok, id: "Bad Id" })).toContain("id");
  });
});
