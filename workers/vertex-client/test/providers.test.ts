// Multi-provider framework: openai-compat adapter against a fake fetch, registry routing + scope rules, config validation, routes.
import { setOpenFlag } from "../src/open-space";
import { PRESETS as __PRESETS } from "../src/providers/presets";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { openaiCompatProvider, openaiError, toChatRequest } from "../src/providers/openai-compat";
import { buildRegistry } from "../src/providers/registry";
import { PROVIDERS, KEY_BINDING, loadProviderConfigs, parseConfig, providerOfModel, splitModelId, type ProviderConfig } from "../src/providers/config";
import { ProviderError, NO_CAPABILITIES, type ModelProvider } from "../src/providers/types";
import { MODELS_META, metaFromProviderModel, registerModelMeta } from "../src/models-meta";
import { buildRequest } from "../src/turn-engine";
import { chatMock } from "./do-mock";
import { providerFor, type GuestScope } from "../src/scope";
// test-only: the fake "acme" provider's origin may receive its Worker secret (production allows the preset origin only)
if (!__PRESETS.some((x) => x.id === "acme")) __PRESETS.push({ key: "acme", label: "Acme", id: "acme", baseUrl: "https://llm.example.test/v1", authHeader: "bearer", secret: "PROVIDER_KEY_ACME", help: "" });

const CFG: ProviderConfig = { id: "acme", kind: "openai-compat", enabled: true, baseUrl: "https://llm.example.test/v1", keyBinding: "PROVIDER_KEY_ACME",
  models: [{ id: "m1", displayName: "Acme One", capabilities: { ...NO_CAPABILITIES, text: true, tools: true }, pricePerMTok: { input: 1, output: 2 } },
    { id: "m2", displayName: "Acme Two", capabilities: { ...NO_CAPABILITIES, text: true }, pricePerMTok: null }] };
const ENV = { PROVIDER_KEY_ACME: "fake-key-123" };
const sseBody = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const events = async (r: Response) => (await r.text()).split("\n\n").map((c) => c.split("\n").find((l) => l.startsWith("data:"))).filter(Boolean).map((l) => JSON.parse(l!.slice(5)));
const mk = (f: (url: string, init: RequestInit) => Promise<Response>, cfg = CFG, env: Record<string, unknown> = ENV) => openaiCompatProvider(cfg, env, f as any);
const body = (extra: object = {}) => ({ model: "m1", max_tokens: 100, stream: true, system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...extra });

describe("openai-compat adapter", () => {
  test("text stream -> Anthropic events; usage mapped; key only in Authorization; request mapped", async () => {
    let seen: any;
    const p = mk(async (url, init) => { seen = { url, init, body: JSON.parse(String(init.body)) };
      return sseBody([{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } } }, "[DONE]"]); });
    const ev = await events(await p.messages(body()));
    expect(ev.map((e) => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(ev.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("")).toBe("Hello");
    const md = ev.find((e) => e.type === "message_delta");
    expect(md.delta.stop_reason).toBe("end_turn"); expect(md.usage).toEqual({ input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 8 });
    expect(seen.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(seen.init.headers.authorization).toBe("Bearer fake-key-123");
    expect(JSON.stringify(seen.body)).not.toContain("fake-key-123");
    expect(seen.body.messages[0]).toEqual({ role: "system", content: "sys" }); expect(seen.body.stream_options).toEqual({ include_usage: true });
    expect(JSON.stringify(seen.body)).not.toContain("cache_control");
  });
  test("tool call round trip: tool_use block out, tool_result + assistant tool_calls mapped back in", async () => {
    const p = mk(async () => sseBody([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_time", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"tz\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"UTC\"}" } }] }, finish_reason: "tool_calls" }] }, "[DONE]"]));
    const ev = await events(await p.messages(body()));
    const start = ev.find((e) => e.type === "content_block_start"); expect(start.content_block).toMatchObject({ type: "tool_use", id: "call_1", name: "get_time" });
    expect(ev.filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("")).toBe('{"tz":"UTC"}');
    expect(ev.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
    const req: any = toChatRequest({ model: "m1", tools: [{ name: "get_time", description: "d", input_schema: { type: "object" } }], messages: [
      { role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "call_1", name: "get_time", input: { tz: "UTC" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "12:00" }] }] }] }, "m1");
    expect(req.tools[0]).toEqual({ type: "function", function: { name: "get_time", description: "d", parameters: { type: "object" } } });
    expect(req.messages[1]).toEqual({ role: "assistant", content: "ok", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } }] });
    expect(req.messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "12:00" });
  });
  test("image blocks become image_url data URLs", () => {
    const r: any = toChatRequest({ messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } }] }] }, "m1");
    expect(r.messages[0].content).toEqual([{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } }]);
  });
  test("429 / 5xx / 401 / 4xx map to ProviderError (retryable flags, user-safe text)", async () => {
    const mkErr = (status: number, hdr: Record<string, string> = {}) => mk(async () => new Response(JSON.stringify({ error: { message: "boom detail" } }), { status, headers: hdr })).messages(body());
    const e429 = await mkErr(429, { "retry-after": "7" }).catch((e) => e); expect(e429).toBeInstanceOf(ProviderError); expect(e429.status).toBe(429); expect(e429.info).toMatchObject({ type: "rate_limit_error", retryable: true, retryAfterS: 7 });
    for (const s of [500, 502, 503]) { const e = await mkErr(s).catch((x) => x); expect(e).toBeInstanceOf(ProviderError); expect(e.status).toBe(s); expect(e.info.retryable).toBe(true); expect(e.message).not.toContain("boom"); }
    const e401 = await mkErr(401).catch((e) => e); expect(e401.status).toBe(502); expect(e401.info.type).toBe("authentication_error");
    const e400 = await mkErr(400).catch((e) => e); expect(e400.status).toBe(400); expect(e400.message).toContain("boom detail"); expect(openaiError(404, null).status).toBe(404);
  });
  test("network failure -> retryable 502; abort propagates untouched; stream drop -> error event", async () => {
    const e = await mk(async () => { throw new Error("ECONNRESET"); }).messages(body()).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError); expect(e.status).toBe(502); expect(e.message).not.toContain("ECONNRESET");
    const ac = new AbortController(); ac.abort();
    const abortErr = await mk(async (_u, init) => { if (init.signal?.aborted) throw new DOMException("aborted", "AbortError"); return sseBody([]); }).messages(body(), ac.signal).catch((x) => x);
    expect(abortErr).not.toBeInstanceOf(ProviderError); expect(abortErr.name).toBe("AbortError");
    const dropped = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')); c.error(new Error("reset")); } }));
    const ev = await events(await mk(async () => dropped).messages(body()));
    expect(ev.at(-1)).toMatchObject({ type: "error" });
  });
  test("a body that is not an upstream error but carries `error` mid-stream ends with an error event and no message_stop", async () => {
    const ev = await events(await mk(async () => sseBody([{ choices: [{ delta: { content: "x" } }] }, { error: { message: "overloaded" } }])).messages(body()));
    expect(ev.some((e) => e.type === "error")).toBe(true); expect(ev.some((e) => e.type === "message_stop")).toBe(false);
  });
  test("no key bound -> 503, and nothing is fetched", async () => {
    let called = false;
    const e = await mk(async () => { called = true; return sseBody([]); }, CFG, {}).messages(body()).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError); expect(e.status).toBe(503); expect(called).toBe(false);
  });
  test("listModels returns the configured models with capabilities and price (null = tokens only)", async () => {
    const ms = await mk(async () => sseBody([])).listModels();
    expect(ms.map((m) => [m.id, m.pricePerMTok])).toEqual([["m1", { input: 1, output: 2 }], ["m2", null]]);
    expect(await mk(async () => sseBody([])).listModels("image")).toEqual([]);
  });
});

describe("config + registry", () => {
  const gw: ModelProvider = { name: "gw", messages: async (b: any) => new Response(JSON.stringify({ got: b.model })), listModels: async () => [{ id: "claude-sonnet-5-5", displayName: "S" }] };
  const reg = (scope: any, extra: ProviderConfig[] = [CFG], env: any = ENV) => buildRegistry({ scope, gateway: gw, extra, env });
  test("prefix convention: no prefix = gateway, `<provider>:<model>` routes and the prefix is stripped", async () => {
    expect(splitModelId("claude-sonnet-5-5")).toEqual({ provider: "gateway", model: "claude-sonnet-5-5" });
    expect(splitModelId("acme:m1")).toEqual({ provider: "acme", model: "m1" }); expect(providerOfModel("x/y:z")).toBe("gateway");
    const r = reg("main");
    expect(await (await r.router.messages({ model: "claude-sonnet-5-5" })).json()).toEqual({ got: "claude-sonnet-5-5" });
    const err = await r.router.messages({ model: "nope:m" }).catch((e) => e); expect(err).toBeInstanceOf(ProviderError); expect(err.status).toBe(400);
    const o = reg("main~open"); // Open: the provider prefix routes and is stripped; an unprefixed (gateway) id is not in this space
    const gerr = await o.router.messages({ model: "claude-sonnet-5-5" }).catch((e) => e); expect(gerr.status).toBe(400); expect(gerr.message).toBe("model not available in this space");
  });
  test("models merge: gateway first (unprefixed), others prefixed with provider + capabilities; unusable providers are not listed", async () => {
    expect((await reg("main").models()).map((m) => m.id)).toEqual(["claude-sonnet-5-5"]); // Business: Vertex only, configs are never listed
    const ms = await reg("main~open").models();
    expect(ms.map((m) => m.id)).toEqual(["acme:m1", "acme:m2"]); // Open: never the gateway
    expect(ms[0]).toMatchObject({ provider: "acme", capabilities: { text: true, tools: true, vision: false } }); expect(ms[0]!.meta!.price).toMatchObject({ input: 1, output: 2 }); expect(ms[1]!.meta!.price).toBeNull();
    expect((await reg("main~open", [CFG], {}).models()).map((m) => m.id)).toEqual([]); // needs-key
    expect((await reg("main~open", [{ ...CFG, enabled: false }]).models()).map((m) => m.id)).toEqual([]); // off
  });
  test("status: Enabled / Off / Needs key binding; list() carries no key material", () => {
    expect(reg("main", [CFG]).list().map((p) => p.id)).toEqual(["gateway"]); // Business lists only the Vertex gateway
    const l = reg("main~open", [CFG, { ...CFG, id: "off", enabled: false }, { ...CFG, id: "nokey", keyBinding: undefined }]).list();
    expect(l.map((p) => [p.id, p.status])).toEqual([["cloudflare", "off"] /* no AI binding in ENV */, ["stub", "off"], ["acme", "enabled"], ["off", "off"], ["nokey", "needs-key"], ["nvidia", "needs-key"] /* built-in preset, no row needed */, ["aistudio", "needs-key"] /* built-in preset: the user's own key only */, ["groq", "needs-key"]]);
    expect(JSON.stringify(l)).not.toMatch(/fake-key|PROVIDER_KEY|https:\/\/llm|keyBinding|baseUrl/);
  });
  test("scopes: main all; e2e only offline stubs (no gateway key leak to real providers); guest none unless allowGuests", async () => {
    expect(reg("e2e").list().map((p) => p.id)).toEqual(["gateway"]); expect((await reg("e2e").models()).map((m) => m.id)).toEqual(["claude-sonnet-5-5"]);
    expect(reg("e2e~open").list().map((p) => [p.id, p.status])).toEqual([["stub", "enabled"]]); expect((await reg("e2e~open", [CFG]).models()).map((m) => m.id)).toEqual(["stub:echo"]); // built-in offline stub, never acme
    const G = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
    expect(reg(G).list()).toEqual([]);
    expect(() => providerFor(G, () => "erich", () => (reg(G).list().length ? "x" : null))).toThrow("no provider for scope");
    const g = buildRegistry({ scope: `${G as string}~open` as any, gateway: gw, extra: [{ ...CFG, allowGuests: true }], env: ENV });
    expect(g.list().map((p) => p.id)).toEqual(["acme", "nvidia", "aistudio", "groq"]); // + the built-in presets (NVIDIA, AI Studio, Groq: each needs its own key)
    expect((await g.models()).map((m) => m.id)).toEqual([]); // never the gateway; and a team base never reaches a Worker secret, so a keyed-by-secret config has no models for it
    expect((await g.router.messages({ model: "claude-sonnet-5-5" }).catch((e) => e)).status).toBe(400);
  });
  test("parseConfig: an nvidia row on a non-preset origin loses tools; the preset origin keeps them", () => {
    const row = (base: string) => ({ id: "nvidia", kind: "openai-compat", base_url: base, key_binding: "PROVIDER_KEY_NVIDIA", enabled: 1, models_json: JSON.stringify([{ id: "nvidia/nemotron-3-ultra-550b-a55b", capabilities: { tools: true } }]) });
    expect(parseConfig(row("https://integrate.api.nvidia.com/v1"))!.models[0]!.capabilities.tools).toBe(true);
    expect(parseConfig(row("https://evil.example/v1"))!.models[0]!.capabilities).toEqual({ ...NO_CAPABILITIES, text: true });
    expect(parseConfig(row("https://integrate.api.nvidia.com.evil.example/v1"))!.models[0]!.capabilities.tools).toBe(false);
  });
  test("parseConfig: https only, key binding must be PROVIDER_KEY_*, gateway id reserved, bad rows dropped", () => {
    const row = (o: object = {}) => ({ id: "acme", kind: "openai-compat", base_url: "https://x.test/v1/", key_binding: "PROVIDER_KEY_X", enabled: 1, models_json: JSON.stringify([{ id: "a", capabilities: { tools: true, bogus: true } }, { nope: 1 }]), ...o });
    const c = parseConfig(row())!; expect(c.baseUrl).toBe("https://x.test/v1"); expect(c.models.length).toBe(1); expect(c.models[0]!.capabilities).toEqual({ ...NO_CAPABILITIES, text: true, tools: true }); expect(c.enabled).toBe(true);
    expect(parseConfig(row({ base_url: "http://x.test" }))).toBeNull(); expect(parseConfig(row({ base_url: "https://u:p@x.test" }))).toBeNull();
    expect(parseConfig(row({ id: "gateway" }))).toBeNull(); expect(parseConfig(row({ kind: "gateway" }))).toBeNull();
    expect(parseConfig(row({ key_binding: "SESSION_SECRET" }))!.keyBinding).toBeUndefined(); // can never name a core secret
    expect(KEY_BINDING.test("GATEWAY_KEY")).toBe(false);
  });
  test("built-in PROVIDERS enables nothing real", () => { expect(PROVIDERS.filter((p) => p.enabled).map((p) => p.id)).toEqual(["gateway", "cloudflare"]); /* cloudflare: binding-only, no key; main edition only */ });
  test("stub provider end to end: echo stream through the registry", async () => {
    const r = buildRegistry({ scope: "main~open" as any, gateway: gw, extra: [], env: {} });
    expect(r.list().find((p) => p.id === "stub")!.status).toBe("off");
    const on = buildRegistry({ scope: "main~open" as any, gateway: gw, extra: [{ id: "stub2", kind: "stub", enabled: true, models: [{ id: "echo", displayName: "E", capabilities: { ...NO_CAPABILITIES, text: true }, pricePerMTok: null }] }], env: {} });
    const ev = await events(await on.router.messages({ model: "stub2:echo", messages: [{ role: "user", content: "ping" }] }));
    expect(ev.find((e) => e.type === "content_block_delta").delta.text).toBe("echo: ping");
  });
});

describe("capabilities in the engine request", () => {
  test("a model without tools never gets tool defs; one with tools does", () => {
    registerModelMeta("acme:m1", metaFromProviderModel("A1", { ...NO_CAPABILITIES, text: true, tools: true }, null));
    registerModelMeta("acme:m2", metaFromProviderModel("A2", { ...NO_CAPABILITIES, text: true }, null));
    const defs = [{ name: "t", description: "d", input_schema: { type: "object" } }] as any;
    const h = [{ role: "user", content: [{ type: "text", text: "x" }] }] as any;
    expect((buildRequest("acme:m1", h, defs) as any).tools?.length).toBe(1);
    expect((buildRequest("acme:m2", h, defs) as any).tools).toBeUndefined();
    expect((buildRequest("acme:m2", h) as any).thinking).toBeUndefined();
    expect(MODELS_META["claude-sonnet-5-5"]).toBeDefined(); // gateway ids untouched
  });
});

describe("routes", () => {
  function d1() {
    const db = new Database(":memory:");
    for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
      all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }), run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; } } as any);
    return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as unknown as D1Database };
  }
  const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
  const app = createApp({ scopeOf: (s) => (s.u === "guest-a" ? GA : s.via === "e2e" ? "e2e" : "main"), provider: () => ({ name: "gw", messages: async () => new Response("{}"), listModels: async () => [{ id: "claude-sonnet-5-5", displayName: "S" }] }) });
  const mkEnv = () => { const x = d1(); const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, _db: x.db, PROVIDER_KEY_ACME: "fake-key-123" }; e.CHAT = chatMock(() => e.FILES, () => {}); return e as Env & { _db: Database }; };
  const get = async (env: Env, user: string, path: string) => { const { cookie } = await makeSession(env, user, "github"); return app.fetch(new Request("https://app.test" + path, { headers: { cookie: cookie.split(";")[0] } }), env); };
  const getO = async (env: Env, user: string, path: string) => { const { cookie } = await makeSession(env, user, "github"); return app.fetch(new Request("https://app.test" + path, { headers: { cookie: cookie.split(";")[0], "x-vc-space": "open" } }), env); };
  test("GET /api/providers: main 200 with no key fields; guest 403", async () => {
    const env = mkEnv();
    const r = await get(env, "example-user", "/api/providers"); expect(r.status).toBe(200);
    const t = await r.text(); const j = JSON.parse(t);
    expect(j.providers.map((p: any) => p.id)).toEqual(["gateway"]); expect(j.providers[0]).toMatchObject({ kind: "gateway", enabled: true, status: "enabled", modelCount: 1 }); // Business: Vertex only
    expect(((await (await getO(env, "example-user", "/api/providers")).json()) as any).providers.map((p: any) => p.id)).toEqual(["cloudflare", "stub", "nvidia", "aistudio", "groq", "acme"]); // Open: configs (+ the built-in presets), no gateway
    expect(t).not.toMatch(/fake-key|PROVIDER_KEY|keyBinding|baseUrl|base_url/);
    await setOpenFlag(env.DB, GA as never, false); // team users have Open by default; the kill switch row is what makes it 403
    expect((await get(env, "guest-a", "/api/providers")).status).toBe(403);
    expect((await getO(env, "guest-a", "/api/providers")).status).toBe(403);
  });
  test("a D1 provider_configs row shows up in /api/providers and its models in /api/models (prefixed, with capabilities); gateway ids stay unprefixed", async () => {
    const env = mkEnv();
    env._db.query(`INSERT INTO provider_configs (id, scope, kind, base_url, key_binding, enabled, models_json) VALUES ('acme','main','openai-compat','https://llm.example.test/v1','PROVIDER_KEY_ACME',1,?)`)
      .run(JSON.stringify([{ id: "m1", displayName: "Acme One", capabilities: { tools: true }, pricePerMTok: { input: 1, output: 2 } }, { id: "m2", displayName: "Acme Two" }]));
    const p = await (await getO(env, "example-user", "/api/providers")).json() as any;
    expect(p.providers.find((x: any) => x.id === "acme")).toMatchObject({ id: "acme", kind: "openai-compat", enabled: true, status: "enabled", modelCount: 2, editable: true, keySet: true });
    expect(((await (await get(env, "example-user", "/api/providers")).json()) as any).providers.map((x: any) => x.id)).toEqual(["gateway"]); // Business never lists it
    const m = await (await getO(env, "example-user", "/api/models")).json() as any;
    expect(m.models.map((x: any) => x.id)).toEqual(["acme:m1", "acme:m2"]); expect(m.default).toBe("acme:m1");
    expect(((await (await get(env, "example-user", "/api/models")).json()) as any).models.map((x: any) => x.id)).toEqual(["claude-sonnet-5-5"]);
    expect(m.models[0]).toMatchObject({ provider: "acme", capabilities: { text: true, tools: true, vision: false } }); expect(m.models[1].meta.price).toBeNull();
    expect((await loadProviderConfigs(env.DB, "e2e")).length).toBe(0); expect((await loadProviderConfigs(env.DB, "main")).length).toBe(1);
    // missing key binding => listed in /api/providers as needs-key and absent from /api/models
    delete (env as any).PROVIDER_KEY_ACME;
    const p2 = await (await getO(env, "example-user", "/api/providers")).json() as any; expect(p2.providers.find((x: any) => x.id === "acme").status).toBe("needs-key");
    const m2 = await (await getO(env, "example-user", "/api/models")).json() as any; expect(m2.models).toEqual([]); expect(m2.default).toBeNull();
  });
  test("migration 0020 is additive and there is no write route for providers", async () => {
    const env = mkEnv(); const { cookie, session } = await makeSession(env, "example-user", "github");
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) { const r = await app.fetch(new Request("https://app.test/api/providers", { method: m, headers: { cookie: cookie.split(";")[0], origin: "https://app.test", "x-csrf-token": session.csrf, "content-type": "application/json" }, body: m === "DELETE" ? undefined : JSON.stringify({ id: "x", key: "k" }) }), env); expect([404, 405]).toContain(r.status); }
  });
});
