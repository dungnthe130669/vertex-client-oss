// prov2: Cloudflare Workers AI provider + NVIDIA NIM preset (auth header option, key at rest, load models, 404 mark-broken, 429 handling).
import { setOpenFlag } from "../src/open-space";
import type { GuestScope } from "../src/scope";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { CLOUDFLARE_CHAT, CLOUDFLARE_IMAGE, CLOUDFLARE_MODELS, cloudflareError, cloudflareProvider, normaliseWorkersAiStream } from "../src/providers/cloudflare";
import { authHeaders, openaiCompatProvider, readCappedText, listUpstreamModels } from "../src/providers/openai-compat";
import { buildRegistry } from "../src/providers/registry";
import { PROVIDERS, loadProviderConfigs, ttlLoader, parseAuthHeader, parseConfig, safeBaseUrl, type ProviderConfig } from "../src/providers/config";
import { NVIDIA_PRESET, NVIDIA_VERIFIED, isChatId, preselect, verified } from "../src/providers/presets";
import { routeAuto } from "../src/auto-route";
import { chatMock } from "./do-mock";

const sse = (chunks: unknown[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(`data: ${typeof x === "string" ? x : JSON.stringify(x)}\n\n`)); c.close(); } });
const events = async (r: Response) => (await r.text()).split("\n\n").map((c) => c.split("\n").find((l) => l.startsWith("data:"))).filter(Boolean).map((l) => JSON.parse(l!.slice(5)));
const body = (model: string, extra: object = {}) => ({ model, max_tokens: 50, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hello there" }] }], ...extra });
const gw = { name: "gw", messages: async () => new Response("{}"), listModels: async () => [{ id: "claude-sonnet-5-5", displayName: "S" }] };
const CF = { ...PROVIDERS.find((p) => p.id === "cloudflare")!, sharedAllowed: async () => true };

describe("cloudflare: curated list", () => {
  test("shape: every chat id is @cf/<vendor>/<name> with a context or null, no price, tools/vision only where declared; images are kind image", async () => {
    for (const m of CLOUDFLARE_MODELS) { expect(m.id).toMatch(/^@cf\/[a-z0-9.-]+\/[a-z0-9._-]+$/); expect(m.pricePerMTok).toBeNull(); }
    expect(CLOUDFLARE_CHAT.filter((m) => m.capabilities.tools).map((m) => m.id).sort()).toEqual(["@cf/google/gemma-4-26b-a4b-it", "@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-4.7-flash"]);
    expect(CLOUDFLARE_CHAT.filter((m) => m.capabilities.vision).map((m) => m.id)).toContain("@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(CLOUDFLARE_CHAT.some((m) => m.capabilities["image-gen"])).toBe(false);
    const p = cloudflareProvider(CF, { AI: {} });
    expect((await p.listModels()).map((m) => m.id)).toEqual(CLOUDFLARE_CHAT.map((m) => m.id));
    const img = await p.listModels("image"); expect(img.map((m) => m.id)).toEqual(CLOUDFLARE_IMAGE.map((m) => m.id)); expect(img.every((m) => m.kind === "image")).toBe(true);
    expect(await p.listModels("video")).toEqual([]);
  });
});

describe("cloudflare: stream normaliser", () => {
  const run = async (chunks: unknown[], promptChars = 30) => events(new Response(await (async () => { const { toAnthropicStream } = await import("../src/providers/openai-compat"); return toAnthropicStream(normaliseWorkersAiStream(sse(chunks), promptChars), "m"); })()));
  test("legacy {response} chunks -> text deltas; no usage chunk -> estimated and flagged", async () => {
    const ev = await run([{ response: "Hel" }, { response: "lo" }, "[DONE]"]);
    expect(ev.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("")).toBe("Hello");
    const md = ev.find((e) => e.type === "message_delta");
    expect(md.delta.stop_reason).toBe("end_turn"); expect(md.usage.usage_estimated).toBe(true); expect(md.usage.input_tokens).toBe(10); expect(md.usage.output_tokens).toBe(2);
    expect(ev.at(-1).type).toBe("message_stop");
  });
  test("OpenAI-style chunks with a final usage chunk -> real usage, not flagged", async () => {
    const ev = await run([{ choices: [{ delta: { content: "A" } }] }, { choices: [{ delta: { content: "B" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }, "[DONE]"]);
    expect(ev.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("")).toBe("AB");
    const md = ev.find((e) => e.type === "message_delta"); expect(md.usage).toEqual({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0 });
  });
  test("legacy chunk carrying usage keeps it; OpenAI tool_calls pass through; split chunks across reads are reassembled", async () => {
    const ev = await run([{ response: "x", usage: { prompt_tokens: 5, completion_tokens: 1 } }, "[DONE]"]);
    expect(ev.find((e) => e.type === "message_delta").usage.input_tokens).toBe(5);
    const t = await run([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }, "[DONE]"]);
    expect(t.find((e) => e.type === "content_block_start").content_block).toMatchObject({ type: "tool_use", name: "f" }); expect(t.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
    const enc = new TextEncoder(), whole = `data: {"response":"split"}\n\ndata: [DONE]\n\n`;
    const parts = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(whole.slice(0, 9))); c.enqueue(enc.encode(whole.slice(9, 25))); c.enqueue(enc.encode(whole.slice(25))); c.close(); } });
    const { toAnthropicStream } = await import("../src/providers/openai-compat");
    const sp = await events(new Response(toAnthropicStream(normaliseWorkersAiStream(parts, 3), "m")));
    expect(sp.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("")).toBe("split");
  });
  test("provider: AI.run called with messages + stream + max_tokens (no base URL anywhere); plain text answer also works", async () => {
    let seen: any;
    const p = cloudflareProvider(CF, { AI: { run: async (m: string, i: any) => { seen = { m, i }; return sse([{ response: "ok" }, "[DONE]"]); } } });
    const ev = await events(await p.messages(body("@cf/openai/gpt-oss-120b", { baseUrl: "https://evil.test" })));
    expect(seen.m).toBe("@cf/openai/gpt-oss-120b"); expect(seen.i.stream).toBe(true); expect(seen.i.max_tokens).toBe(50); expect(JSON.stringify(seen.i)).not.toContain("evil.test");
    expect(ev.some((e) => e.type === "message_stop")).toBe(true);
    const p2 = cloudflareProvider(CF, { AI: { run: async () => ({ response: "whole" }) } });
    expect((await events(await p2.messages(body("@cf/openai/gpt-oss-120b")))).filter((e) => e.type === "content_block_delta")[0].delta.text).toBe("whole");
  });
  test("errors map to plain messages; an unlisted model is refused before any call; missing binding -> 503; abort propagates", async () => {
    expect(cloudflareError(new Error("3036: account neuron limit exceeded")).status).toBe(429);
    expect(cloudflareError(new Error("5007: No such model")).status).toBe(404);
    expect(cloudflareError(new Error("boom with secret-ish text")).message).toBe("Workers AI failed.");
    let called = 0;
    const p = cloudflareProvider(CF, { AI: { run: async () => { called++; throw new Error("daily free allowance exceeded"); } } });
    await expect(p.messages(body("@cf/not/listed"))).rejects.toMatchObject({ status: 404 }); expect(called).toBe(0);
    await expect(p.messages(body("@cf/openai/gpt-oss-120b"))).rejects.toMatchObject({ status: 429, message: expect.stringContaining("free daily allowance") });
    await expect(cloudflareProvider(CF, {}).messages(body("@cf/openai/gpt-oss-120b"))).rejects.toMatchObject({ status: 503 });
    const ac = new AbortController(); ac.abort();
    const pa = cloudflareProvider(CF, { AI: { run: async () => { throw new DOMException("aborted", "AbortError"); } } });
    await expect(pa.messages(body("@cf/openai/gpt-oss-120b"), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  test("image: {image: b64} and raw bytes both become an ImagePayload; no price (usd null)", async () => {
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3));
    const a = await cloudflareProvider(CF, { AI: { run: async () => ({ image: "/9j/AAAA" }) } }).image!({ model: "@cf/black-forest-labs/flux-1-schnell", prompt: "p" });
    expect(a.images[0]).toEqual({ mime_type: "image/jpeg", data: "/9j/AAAA" }); expect(a.cost?.usd).toBeNull();
    const b = await cloudflareProvider(CF, { AI: { run: async () => new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])).body } }).image!({ model: "@cf/stabilityai/stable-diffusion-xl-base-1.0", prompt: "p" });
    expect(b.images[0]).toEqual({ mime_type: "image/png", data: png });
    await expect(cloudflareProvider(CF, { AI: { run: async () => ({}) } }).image!({ model: "@cf/openai/gpt-oss-120b", prompt: "p" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("cloudflare: scope gating", () => {
  const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
  const mk = (scope: any, env: any) => buildRegistry({ scope, gateway: gw, env });
  test("Business never lists Workers AI (Vertex only); it lives in Open", () => {
    for (const sc of ["main", "e2e", GA]) expect(mk(sc, { AI: {}, PROVIDER_CF_TEAM: "true" }).list().find((p) => p.id === "cloudflare"), String(sc)).toBeUndefined();
  });
  test("main: on when the AI binding exists; off without it", async () => {
    expect((await mk("main~open", { AI: {} }).models()).some((m) => m.id.startsWith("cloudflare:@cf/"))).toBe(true);
    expect(mk("main~open", {}).list().find((p) => p.id === "cloudflare")!.status).toBe("off");
    expect((await mk("main~open", {}).models()).some((m) => m.provider === "cloudflare")).toBe(false);
  });
  test("team (guest) scope: hidden by default, only with PROVIDER_CF_TEAM; e2e never", async () => {
    const GO = `${GA as string}~open`;
    expect(mk(GO, { AI: {} }).list().find((p) => p.id === "cloudflare")).toBeUndefined();
    await expect(mk(GO, { AI: {} }).router.messages(body("cloudflare:@cf/openai/gpt-oss-120b"))).rejects.toMatchObject({ status: 400, message: "model not available in this space" });
    expect(mk(GO, { AI: {}, PROVIDER_CF_TEAM: "false" }).list().find((p) => p.id === "cloudflare")).toBeUndefined();
    expect(mk(GO, { AI: {}, PROVIDER_CF_TEAM: "true" }).list().find((p) => p.id === "cloudflare")!.status).toBe("enabled");
    expect(mk("e2e~open", { AI: {}, PROVIDER_CF_TEAM: "true" }).list().map((p) => p.id)).toEqual(["stub"]); // offline stub only, never cloudflare
  });
  test("routing: prefix stripped, image through the registry; Auto candidates exclude non-Claude providers", async () => {
    let seen = "";
    const reg = mk("main~open", { AI: { run: async (m: string) => { seen = m; return sse([{ response: "r" }, "[DONE]"]); } } });
    await reg.router.messages(body("cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast")); expect(seen).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect((await reg.router.listModels("image")).map((m) => m.id)).toContain("cloudflare:@cf/black-forest-labs/flux-1-schnell");
    const all = await reg.models();
    const d = routeAuto({ text: "hello", estPromptTokens: 100, candidates: all.map((m) => ({ id: m.id, meta: m.meta })) as any });
    expect(JSON.stringify(d)).not.toContain("cloudflare");
  });
});

describe("NVIDIA NIM: auth header, preset, key, 404, 429", () => {
  const KEYENV = { PROVIDER_KEY_NVIDIA: "nvapi-secret-123" };
  const CFG: ProviderConfig = { id: "nvidia", kind: "openai-compat", enabled: true, baseUrl: "https://integrate.api.nvidia.com/v1", keyBinding: "PROVIDER_KEY_NVIDIA",
    models: [{ id: "nvidia/nemotron-3.5-lightning-30b-a3b", displayName: "nemotron", capabilities: { text: true, vision: false, tools: false, "image-gen": false, "video-gen": false, reasoning: false }, pricePerMTok: null }] };
  test("auth header option: bearer default, x-api-key, custom name; reserved/invalid names refused", () => {
    expect(authHeaders({}, "k")).toEqual({ authorization: "Bearer k" });
    expect(authHeaders({ authHeader: "x-api-key" }, "k")).toEqual({ "x-api-key": "k" });
    expect(authHeaders({ authHeader: "api-key" }, "k")).toEqual({ "api-key": "k" });
    expect(parseAuthHeader(undefined)).toBe("bearer"); expect(parseAuthHeader("X-API-Key")).toBe("x-api-key"); expect(parseAuthHeader("Api-Key")).toBe("api-key");
    for (const bad of ["Authorization", "cookie", "host", "cf-foo", "a b", "x\r\ny", 5, "-x"]) expect(parseAuthHeader(bad as any)).toBeNull();
  });
  test("preset defaults and URL safety (SSRF): https public hosts only", () => {
    expect(NVIDIA_PRESET).toMatchObject({ id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", authHeader: "bearer" }) /* live-tested: Bearer works, X-API-Key is 401 */;
    expect(NVIDIA_PRESET.help).toMatch(/build\.nvidia\.com/); expect(NVIDIA_PRESET.help).toMatch(/40 requests/);
    expect(safeBaseUrl(NVIDIA_PRESET.baseUrl)).toBe(NVIDIA_PRESET.baseUrl);
    for (const bad of ["http://x.example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://10.0.0.5/v1", "https://[::1]/v1", "https://box.internal/v1", "https://u:p@x.example.com/v1", "https://x.example.com/v1?k=1", "https://intranet/v1", "https://2130706433/"]) expect(safeBaseUrl(bad), bad).toBeNull();
    expect(parseConfig({ id: "x", kind: "openai-compat", base_url: "https://127.0.0.1/v1" })).toBeNull();
    expect(parseConfig({ id: "x", kind: "openai-compat", base_url: "https://a.example.com/v1", auth_header: "cookie" })).toBeNull();
  });
  test("pre-tick list: known-good free-preview chat models only; embeddings/rerankers not offered", () => {
    expect(NVIDIA_VERIFIED).toEqual(["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b", "minimaxai/minimax-m3.1-flash", "nvidia/nemotron-3.5-bolt-e4b", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "z-ai/glm-5.3-flash"]); // 0032: dead NIM ids removed
    expect(NVIDIA_VERIFIED.every(isChatId)).toBe(true); expect(NVIDIA_VERIFIED.every(verified)).toBe(true);
    expect(["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b"].every(preselect)).toBe(true); // pre-ticked: lightning + ultra only
    for (const id of ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "minimaxai/minimax-m3.1-flash", "nvidia/nemotron-3-super-120b-a12b", "meta/llama-3.1-8b-instruct", "nvidia/nemotron-embed-1b"]) expect(preselect(id), id).toBe(false);
    expect(verified("nvidia/nemotron-3-super-120b-a12b")).toBe(false); // 404 for our account
    expect(isChatId("nvidia/nv-embedqa-e5-v5")).toBe(false);
  });
  test("request carries the key as Authorization: Bearer (the NIM default) and nowhere else, text-only: tools stripped by capability, key not in the body", async () => {
    let seen: any;
    const f = async (url: string, init: any) => { seen = { url, init }; return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200 }); };
    const ev = await events(await openaiCompatProvider(CFG, KEYENV, f as any).messages(body("nvidia/nemotron-3.5-lightning-30b-a3b")));
    expect(ev.some((e) => e.type === "message_stop")).toBe(true);
    expect(seen.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(seen.init.headers.authorization).toBe("Bearer nvapi-secret-123"); expect(seen.init.headers["x-api-key"]).toBeUndefined(); expect(seen.init.redirect).toBe("manual");
    expect(String(seen.init.body)).not.toContain("nvapi-secret");
  });
  test("404 -> not-found, onBroken called once, the model disappears from the list", async () => {
    const broken: string[] = []; const cfg = { ...CFG, onBroken: (m: string) => { broken.push(m); (cfg.broken ??= []).push(m); } } as ProviderConfig;
    const p = openaiCompatProvider(cfg, KEYENV, (async () => new Response(JSON.stringify({ error: { message: "Function not found" } }), { status: 404 })) as any);
    await expect(p.messages(body("nvidia/nemotron-3.5-lightning-30b-a3b"))).rejects.toMatchObject({ status: 404 });
    expect(broken).toEqual(["nvidia/nemotron-3.5-lightning-30b-a3b"]); expect(await p.listModels()).toEqual([]);
  });
  test("429: exactly ONE retry after min(Retry-After, 2s), then a clear message with the free-tier hint; success on the retry streams normally", async () => {
    let calls = 0; const waits: number[] = [];
    const always = async () => { calls++; return new Response("{}", { status: 429, headers: { "retry-after": "30" } }); };
    const p = openaiCompatProvider(CFG, KEYENV, always as any, async (ms) => { waits.push(ms); });
    await expect(p.messages(body("nvidia/nemotron-3.5-lightning-30b-a3b"))).rejects.toMatchObject({ status: 429, message: expect.stringContaining("40 requests per minute") });
    expect(calls).toBe(2); expect(waits).toEqual([2000]);
    let n = 0; waits.length = 0;
    const once = async () => (++n === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200 }));
    const ev = await events(await openaiCompatProvider(CFG, KEYENV, once as any, async (ms) => { waits.push(ms); }).messages(body("nvidia/nemotron-3.5-lightning-30b-a3b")));
    expect(n).toBe(2); expect(waits).toEqual([1000]); expect(ev.some((e) => e.type === "message_stop")).toBe(true);
  });
  test("Auto routing never picks a non-Claude provider model", async () => {
    const reg = buildRegistry({ scope: "main~open" as any, gateway: gw, extra: [CFG], env: KEYENV });
    const all = await reg.models(); expect(all.some((m) => m.id.startsWith("nvidia:"))).toBe(true);
    const d = routeAuto({ text: "hello", estPromptTokens: 100, candidates: all.map((m) => ({ id: m.id, meta: m.meta })) as any });
    expect(JSON.stringify(d)).not.toContain("nvidia");
  });
});

describe("provider routes: no key in the app (presence only), main only", () => {
  function d1(skip: string[] = []) {
    const db = new Database(":memory:");
    for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort().filter((f) => !skip.some((k) => f.startsWith(k)))) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
      all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }), run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; } } as any);
    return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as unknown as D1Database };
  }
  const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
  const upstream: string[] = [];
  const fetchImpl = (async (url: string, init: any) => { upstream.push(`${url} ${JSON.stringify(init.headers)}`);
    return new Response(JSON.stringify({ data: [{ id: "nvidia/nemotron-3.5-lightning-30b-a3b" }, { id: "nvidia/nv-embedqa-e5-v5" }, { id: "meta/llama-3.1-8b-instruct" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const app = createApp({ fetchImpl, scopeOf: (s) => (s.u === "guest-a" ? GA : s.via === "e2e" ? "e2e" : "main"), provider: () => gw });
  const mkEnv = (skip: string[] = []) => { const x = d1(skip); const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k", AI: {}, E2E_TOKEN: "e2e-test-token-0123456789abcdef0123456789abcdef", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, _db: x.db }; e.CHAT = chatMock(() => e.FILES, () => {}); return e as Env & { _db: Database }; };
  const call = async (env: Env, user: string, method: string, path: string, b?: unknown, space?: "open") => {
    let cookie: string, csrf: string;
    if (user === "e2e") { const r = await app.fetch(new Request("https://app.test/auth/e2e", { method: "POST", headers: { "x-e2e-token": (env as any).E2E_TOKEN } }), env); cookie = r.headers.get("set-cookie")!.split(";")[0]!; csrf = ((await (await app.fetch(new Request("https://app.test/api/me", { headers: { cookie } }), env)).json()) as any).csrf; }
    else { const m = await makeSession(env, user, "github"); cookie = m.cookie.split(";")[0]!; csrf = m.session.csrf; }
    const session = { csrf }; return app.fetch(new Request("https://app.test" + path, { method, headers: { cookie, origin: "https://app.test", "x-csrf-token": session.csrf, "content-type": "application/json", ...(space ? { "x-vc-space": space } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }), env); };
  const KEY = "nvapi-super-secret-key";
  const withKey = (env: any) => { env.PROVIDER_KEY_NVIDIA = KEY; return env; };

  test("preset row: created without any key, binding named PROVIDER_KEY_NVIDIA; status 'needs-key' until the secret exists, then enabled; the value is never returned", async () => {
    const env = mkEnv();
    const r = await call(env, "example-user", "PUT", "/api/providers/nvidia", {}); expect(r.status).toBe(200);
    expect((await r.json() as any).provider).toMatchObject({ id: "nvidia", keySet: false, authHeader: "bearer", host: "integrate.api.nvidia.com" });
    const row = env._db.query(`SELECT key_binding, base_url, auth_header FROM provider_configs WHERE id='nvidia'`).get() as any;
    expect(row).toEqual({ key_binding: "PROVIDER_KEY_NVIDIA", base_url: "https://integrate.api.nvidia.com/v1", auth_header: "bearer" });
    expect(Object.keys(env._db.query(`SELECT * FROM provider_configs LIMIT 1`).get() as any)).not.toContain("key_enc");
    const l0 = await (await call(env, "example-user", "GET", "/api/providers", undefined, "open")).json() as any; expect(l0.providers.find((p: any) => p.id === "nvidia")).toMatchObject({ status: "needs-key", keySet: false, editable: true });
    withKey(env);
    for (const path of ["/api/providers", "/api/providers/configured", "/api/providers/presets"]) { const x = await (await call(env, "example-user", "GET", path, undefined, "open")).text(); expect(x, path).not.toContain(KEY); }
    const l1 = await (await call(env, "example-user", "GET", "/api/providers", undefined, "open")).json() as any; expect(l1.providers.find((p: any) => p.id === "nvidia")).toMatchObject({ status: "enabled", keySet: true });
    const pr = await (await call(env, "example-user", "GET", "/api/providers/presets")).json() as any; expect(pr.presets[0]).toMatchObject({ id: "nvidia", secret: "PROVIDER_KEY_NVIDIA" });
    await setOpenFlag(env.DB!, GA as never, false); // Open is default-on for team users; kill switch
    for (const u of ["guest-a", "e2e"]) { expect((await call(env, u, "PUT", "/api/providers/nvidia", {})).status, u).toBe(403); expect((await call(env, u, "POST", "/api/providers/nvidia/models")).status, u).toBe(403); expect((await call(env, u, "DELETE", "/api/providers/nvidia")).status, u).toBe(403); }
    expect((await call(env, "guest-a", "GET", "/api/providers")).status).toBe(403);
  });
  test("a client cannot smuggle a key or a binding name: apiKey / keyBinding in the body are ignored, the binding is always derived from the id", async () => {
    const env = mkEnv();
    await call(env, "example-user", "PUT", "/api/providers/nvidia", { apiKey: "should-be-ignored-12345", keyBinding: "SESSION_SECRET", key_binding: "GATEWAY_KEY" });
    expect((env._db.query(`SELECT key_binding FROM provider_configs WHERE id='nvidia'`).get() as any).key_binding).toBe("PROVIDER_KEY_NVIDIA");
    expect(JSON.stringify(env._db.query(`SELECT * FROM provider_configs`).all())).not.toContain("should-be-ignored");
  });
  test("validation: reserved ids, http/private URLs, bad header, bad model list", async () => {
    const env = mkEnv();
    for (const id of ["gateway", "cloudflare", "stub"]) expect((await call(env, "example-user", "PUT", `/api/providers/${id}`, {})).status, id).toBe(400);
    for (const b of [{ baseUrl: "http://x.example.com/v1" }, { baseUrl: "https://127.0.0.1/v1" }, { authHeader: "Authorization" }, { models: "x" }, { models: ["a b"] }])
      expect((await call(env, "example-user", "PUT", "/api/providers/nvidia", b)).status, JSON.stringify(b)).toBe(400);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_configs`).get()).toEqual({ n: 0 });
  });
  test("load models: GET <base>/models with Bearer from the Worker secret, chat ids only, known-good suggested, nothing probed; enable -> /api/models prefixed text-only", async () => {
    const env = withKey(mkEnv()); upstream.length = 0;
    await call(env, "example-user", "PUT", "/api/providers/nvidia", {});
    const r = await call(env, "example-user", "POST", "/api/providers/nvidia/models"); expect(r.status).toBe(200);
    const j = await r.json() as any; const t = JSON.stringify(j);
    expect(j.models.map((m: any) => m.id)).toEqual(["nvidia/nemotron-3.5-lightning-30b-a3b", "meta/llama-3.1-8b-instruct"]);
    expect(j.models[0]).toMatchObject({ suggested: true, verified: true, enabled: true }); expect(j.models[1]).toMatchObject({ suggested: false, verified: false });
    expect(upstream).toHaveLength(1); expect(upstream[0]).toContain("/v1/models"); expect(upstream[0]).toContain("Bearer"); expect(t).not.toContain(KEY);
    await call(env, "example-user", "PUT", "/api/providers/nvidia", { models: ["nvidia/nemotron-3.5-lightning-30b-a3b"] });
    const ms = (await (await call(env, "example-user", "GET", "/api/models", undefined, "open")).json() as any).models;
    expect(ms.find((m: any) => m.id === "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b")).toMatchObject({ provider: "nvidia", capabilities: { text: true, tools: true, vision: false } });
    expect(ms.some((m: any) => m.id.startsWith("cloudflare:"))).toBe(true);
    expect(((await (await call(env, "example-user", "GET", "/api/models")).json()) as any).models.some((m: any) => m.provider === "nvidia" || m.provider === "cloudflare")).toBe(false); // Business never lists them
  });
  test("no secret provisioned: load models -> 503 and nothing fetched; models of a needs-key provider are not offered; unknown provider 404", async () => {
    const env = mkEnv(); upstream.length = 0;
    expect((await call(env, "example-user", "POST", "/api/providers/nope/models")).status).toBe(404);
    await call(env, "example-user", "PUT", "/api/providers/nvidia", { models: ["a/x"] });
    expect((await call(env, "example-user", "POST", "/api/providers/nvidia/models")).status).toBe(503); expect(upstream).toHaveLength(0);
    expect(((await (await call(env, "example-user", "GET", "/api/models", undefined, "open")).json()) as any).models.some((m: any) => m.provider === "nvidia")).toBe(false);
  });
  test("mark-broken persists, hides the model; re-ticking clears it; delete removes the row", async () => {
    const env = withKey(mkEnv());
    await call(env, "example-user", "PUT", "/api/providers/nvidia", { models: ["a/x", "a/y"] });
    const { markBroken } = await import("../src/provider-routes");
    await markBroken(env.DB, "nvidia", "a/x", "main");
    // per-user list (never the shared provider_configs row)
    let cfgs = await loadProviderConfigs(env.DB, "main"); expect(cfgs[0]!.broken).toEqual([]);
    const ids = ((await (await call(env, "example-user", "GET", "/api/models", undefined, "open")).json()) as any).models.map((m: any) => m.id); expect(ids).toContain("nvidia:a/y"); expect(ids).not.toContain("nvidia:a/x");
    await call(env, "example-user", "PUT", "/api/providers/nvidia", { models: ["a/y"] }); await call(env, "example-user", "PUT", "/api/providers/nvidia", { models: ["a/x", "a/y"] });
    cfgs = await loadProviderConfigs(env.DB, "main"); expect(cfgs[0]!.broken).toEqual([]);
    expect(await (await import("../src/provider-routes")).loadUserBroken(env.DB, "main")).toEqual({ nvidia: [] });
    expect((await call(env, "example-user", "DELETE", "/api/providers/nvidia")).status).toBe(200);
    expect(await loadProviderConfigs(env.DB, "main")).toEqual([]);
  });
  test("upsert rewrites key_binding with base_url/auth: a stale binding cannot send another provider's secret to a new host", async () => {
    const env = mkEnv();
    env._db.query(`INSERT INTO provider_configs (id, scope, kind, base_url, key_binding, enabled, models_json) VALUES ('nvidia','main','openai-compat','https://old.example.com/v1','GATEWAY_KEY_X',1,'[]')`).run();
    env._db.query(`UPDATE provider_configs SET key_binding='PROVIDER_KEY_ACME' WHERE id='nvidia'`).run();
    expect((await call(env, "example-user", "PUT", "/api/providers/nvidia", { baseUrl: "https://integrate.api.nvidia.com/v1" })).status).toBe(200);
    expect(env._db.query(`SELECT key_binding, base_url, auth_header FROM provider_configs WHERE id='nvidia'`).get()).toEqual({ key_binding: "PROVIDER_KEY_NVIDIA", base_url: "https://integrate.api.nvidia.com/v1", auth_header: "bearer" });
  });
  test("before migration 0026: provider writes answer a controlled 409 'migration required', nothing is written; reads still work", async () => {
    const env = mkEnv(["0026"]);
    const r = await call(env, "example-user", "PUT", "/api/providers/nvidia", {}); expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toMatch(/migration required.*0026/);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_configs`).get()).toEqual({ n: 0 });
    expect((await call(env, "example-user", "GET", "/api/providers")).status).toBe(200);
    expect((await call(env, "example-user", "GET", "/api/models")).status).toBe(200);
  });
  test("image models list through /api/gen/models for main Open (cloudflare), not for e2e", async () => {
    const env = mkEnv();
    const j = await (await call(env, "example-user", "GET", "/api/gen/models?kind=image", undefined, "open")).json() as any;
    expect(((await (await call(env, "example-user", "GET", "/api/gen/models?kind=image")).json()) as any).models.some((m: any) => m.id.startsWith("cloudflare:"))).toBe(false); // Business: Vertex only
    expect(j.models.map((m: any) => m.id)).toContain("cloudflare:@cf/black-forest-labs/flux-1-schnell");
    expect(j.models.find((m: any) => m.id.startsWith("cloudflare:")).perImage).toBeNull();
    const e = await (await call(env, "e2e", "GET", "/api/gen/models?kind=image")).json() as any;
    expect(e.models.some((m: any) => m.id.startsWith("cloudflare:"))).toBe(false);
  });
});

describe("prov2 review fixes", () => {
  const KEYENV = { PROVIDER_KEY_NVIDIA: "nvapi-secret-123" };
  const CFG: ProviderConfig = { id: "nvidia", kind: "openai-compat", enabled: true, baseUrl: "https://integrate.api.nvidia.com/v1", keyBinding: "PROVIDER_KEY_NVIDIA",
    models: [{ id: "a/x", displayName: "x", capabilities: { text: true, vision: false, tools: false, "image-gen": false, "video-gen": false, reasoning: false }, pricePerMTok: null }] };
  test("404 AND 410 mark the model broken (410 = end of life, own message)", async () => {
    for (const status of [404, 410]) {
      const gone: string[] = []; const cfg = { ...CFG, onBroken: (m: string) => gone.push(m) } as ProviderConfig;
      await expect(openaiCompatProvider(cfg, KEYENV, (async () => new Response("{}", { status })) as any).messages(body("a/x"))).rejects.toMatchObject({ status });
      expect(gone, String(status)).toEqual(["a/x"]);
    }
    await expect(openaiCompatProvider(CFG, KEYENV, (async () => new Response("{}", { status: 410 })) as any).messages(body("a/x"))).rejects.toMatchObject({ message: expect.stringContaining("no longer available") });
  });
  test("redirects are never followed: redirect:manual on chat and listing, a 3xx is an error, the key goes to no other origin", async () => {
    const seen: any[] = [];
    const f = (async (url: string, init: any) => { seen.push({ url, init }); return new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }); }) as any;
    await expect(openaiCompatProvider(CFG, KEYENV, f).messages(body("a/x"))).rejects.toMatchObject({ status: 502, message: expect.stringContaining("redirect") });
    await expect(listUpstreamModels(CFG, KEYENV, f)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("redirect") });
    expect(seen.map((x) => x.init.redirect)).toEqual(["manual", "manual"]); expect(seen.every((x) => x.url.startsWith("https://integrate.api.nvidia.com/"))).toBe(true);
  });
  test("bounded reads: an error body and a 429 body are read through the stream, capped at 64 KB, then cancelled", async () => {
    let pulled = 0, cancelled = false;
    const big = () => new Response(new ReadableStream<Uint8Array>({ pull(c) { pulled += 16384; c.enqueue(new Uint8Array(16384).fill(65)); }, cancel() { cancelled = true; } }), { status: 500 });
    const t = await readCappedText(big()); expect(t.length).toBe(64 * 1024); expect(cancelled).toBe(true); expect(pulled).toBeLessThanOrEqual(64 * 1024 + 32768);
    pulled = 0; cancelled = false;
    await expect(openaiCompatProvider(CFG, KEYENV, (async () => big()) as any).messages(body("a/x"))).rejects.toMatchObject({ status: 500 });
    expect(cancelled).toBe(true); expect(pulled).toBeLessThan(1024 * 1024);
    pulled = 0; cancelled = false; let calls = 0;
    const r429 = (async () => { calls++; return calls === 1 ? new Response(new ReadableStream<Uint8Array>({ pull(c) { pulled += 16384; c.enqueue(new Uint8Array(16384)); }, cancel() { cancelled = true; } }), { status: 429, headers: { "retry-after": "0" } }) : new Response("{}", { status: 500 }); }) as any;
    await expect(openaiCompatProvider(CFG, KEYENV, r429, async () => {}).messages(body("a/x"))).rejects.toMatchObject({ status: 500 });
    expect(cancelled).toBe(true); expect(pulled).toBeLessThan(1024 * 1024);
  });
  test("ttlLoader: a removed provider disappears within the TTL; a failed reload keeps the last list", async () => {
    let t = 0, rows = [1, 2], fail = false;
    const l = ttlLoader(async (_: string) => { if (fail) throw new Error("db down"); return [...rows]; }, [] as number[], 15_000, () => t);
    l.set([1, 2]);
    rows = [1]; t = 14_000; expect(await l.refresh("main")).toEqual([1, 2]); // still cached
    t = 15_000; expect(await l.refresh("main")).toEqual([1]); expect(l.value).toEqual([1]);
    rows = []; fail = true; t = 40_000; expect(await l.refresh("main")).toEqual([1]); // reload failed: keep last good
    fail = false; t = 60_000; expect(await l.refresh("main")).toEqual([]);
  });
});
