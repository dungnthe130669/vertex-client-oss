// Google AI Studio (Gemini API) provider: native adapter against a mocked fetch, catalog seed + migration 0030, registry/route wiring. No live calls.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { geminiError, geminiProvider, listGeminiModels, packCallId, retryHintS, sanitizeSchema, toGeminiContents, toGeminiRequest, trimToBudget, unpackCallId } from "../src/providers/gemini";
import { AISTUDIO_DESCRIPTOR, DESCRIPTORS, discoveredKind, validateDescriptor } from "../src/providers/descriptor";
import { SEED_MODELS, AISTUDIO_CHAT_SEED } from "../src/providers/seed";
import { chatRows, loadCatalog, seedCatalog, toConfigured, type Catalog } from "../src/providers/catalog";
import { buildRegistry } from "../src/providers/registry";
import { parseConfig, type ProviderConfig } from "../src/providers/config";
import { AISTUDIO_PRESET, PRESETS } from "../src/providers/presets";
import { decorateModels } from "../src/models-api";
import { ProviderError } from "../src/providers/types";
import { mkEnv, call, FAKE, gw, GA } from "./user-keys-harness";

const KEY = "AIzaFAKEKEY0123456789abcdefgh";
const cfgOf = (over: Partial<ProviderConfig> = {}, catalog: Catalog = seedCatalog()): ProviderConfig => ({ id: "aistudio", kind: "gemini", enabled: true, baseUrl: AISTUDIO_PRESET.baseUrl, authHeader: "x-goog-api-key", allowGuests: true,
  models: chatRows(catalog, "aistudio").map(toConfigured), resolveKey: async () => ({ kind: "key" as const, key: KEY }), ...over });
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const events = async (r: Response) => (await r.text()).split("\n\n").map((c) => c.split("\n").find((l) => l.startsWith("data:"))).filter(Boolean).map((l) => JSON.parse(l!.slice(5)));
const part = (parts: unknown[], extra: object = {}) => ({ candidates: [{ content: { role: "model", parts }, ...extra }] });
const user = (c: unknown) => ({ role: "user", content: c });
const reqBody = (extra: object = {}) => ({ model: "gemini-3.5-flash-lite", max_tokens: 1000, stream: true, system: [{ type: "text", text: "be brief" }], messages: [user("hi")], ...extra });
type Call = { url: string; init: any };
const mk = (f: (url: string, init: any, n: number) => Promise<Response>, cfg = cfgOf(), sleeps: number[] = []) => { const calls: Call[] = []; const p = geminiProvider(cfg, {}, (async (url: string, init: any) => { calls.push({ url, init }); return f(url, init, calls.length); }) as any, async (ms) => { sleeps.push(ms); }); return { p, calls, sleeps }; };

describe("request mapping", () => {
  test("native URL, key only in x-goog-api-key, systemInstruction, roles user/model, no built-in tools", async () => {
    const { p, calls } = mk(async () => sse([part([{ text: "ok" }], { finishReason: "STOP" })]));
    await p.messages(reqBody({ messages: [user("hi"), { role: "assistant", content: "yo" }, user("again")], tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } }] }));
    const c = calls[0]!, b = JSON.parse(c.init.body);
    expect(c.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse");
    expect(c.url).not.toContain(KEY); expect(c.init.body).not.toContain(KEY);
    expect(c.init.headers["x-goog-api-key"]).toBe(KEY); expect(c.init.headers.authorization).toBeUndefined();
    expect(b.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    expect(b.contents.map((x: any) => x.role)).toEqual(["user", "model", "user"]);
    expect(b.tools).toHaveLength(1); expect(Object.keys(b.tools[0])).toEqual(["functionDeclarations"]); // never googleSearch / codeExecution
    expect(JSON.stringify(b)).not.toMatch(/googleSearch|codeExecution|google_search|code_execution/);
    expect(b.generationConfig).toEqual({ maxOutputTokens: 1000, thinkingConfig: { includeThoughts: true } });
  });
  test("maxOutputTokens never exceeds the model cap; Gemma sends no thinkingConfig", async () => {
    const { p, calls } = mk(async () => sse([part([{ text: "ok" }], { finishReason: "STOP" })]));
    await p.messages(reqBody({ max_tokens: 999_999 })); expect(JSON.parse(calls[0]!.init.body).generationConfig.maxOutputTokens).toBe(65_536);
    await p.messages(reqBody({ model: "gemma-4-26b-a4b-it", max_tokens: 100 })); expect(JSON.parse(calls[1]!.init.body).generationConfig).toEqual({ maxOutputTokens: 100 });
  });
  test("a model that is not in the catalog (0-quota, TTS, unknown, path tricks) never reaches Google", async () => {
    const { p, calls } = mk(async () => sse([]));
    for (const m of ["gemini-2.5-pro", "gemini-3.8-flash-tts", "nope", "../x", "gemini-3.5-flash-lite/../../x"]) { const e = await p.messages(reqBody({ model: m })).catch((x) => x); expect(e).toBeInstanceOf(ProviderError); expect(e.status).toBe(404); }
    expect(calls).toHaveLength(0);
  });
  test("no key -> plain 503, and the key is never sent without one", async () => {
    const { p, calls } = mk(async () => sse([]), cfgOf({ resolveKey: async () => ({ kind: "none" as const }) }));
    expect((await p.messages(reqBody()).catch((x) => x)).status).toBe(503); expect(calls).toHaveLength(0);
  });
  test("tool turn: the thoughtSignature rides in the tool_use id and is echoed; the result is a functionResponse named after the tool; thinking is NEVER replayed", () => {
    const id = packCallId("call_abc", "sig+/=XYZ");
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/); expect(unpackCallId(id)).toEqual({ id: "call_abc", signature: "sig+/=XYZ" }); expect(unpackCallId("toolu_1")).toEqual({ id: "toolu_1" });
    const { contents } = toGeminiContents({ messages: [user("w?"),
      { role: "assistant", content: [{ type: "thinking", thinking: "SECRET REASONING", signature: "x" }, { type: "text", text: "checking" }, { type: "tool_use", id, name: "get_weather", input: { city: "Hanoi" } }] },
      user([{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "31C" }] }])] });
    expect(JSON.stringify(contents)).not.toContain("SECRET REASONING");
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "checking" }, { functionCall: { name: "get_weather", args: { city: "Hanoi" } }, thoughtSignature: "sig+/=XYZ" }] });
    expect(contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "get_weather", response: { output: "31C" } } }] });
  });
  test("images become inlineData; an error tool result is {error}", () => {
    const { contents } = toGeminiContents({ messages: [user([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "what" }]),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] }, user([{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }])] });
    expect(contents[0]!.parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: "AAAA" } });
    expect(contents[2]!.parts[0]).toEqual({ functionResponse: { name: "f", response: { error: "boom" } } });
  });
  test("tool schema sanitizer: strips additionalProperties/$ref/$schema/$defs, array type -> nullable, oneOf -> anyOf, const -> enum, no-arg tool omits parameters", () => {
    const s = sanitizeSchema({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false, $defs: { x: {} }, required: ["a", "ghost"],
      properties: { a: { type: ["string", "null"], description: "d", default: "z" }, b: { $ref: "#/$defs/x" }, c: { const: "k" }, d: { oneOf: [{ type: "number" }, { type: "string" }] }, e: { type: "array", items: { type: "object", additionalProperties: true, properties: { n: { type: "integer" } } } } } })!;
    expect(JSON.stringify(s)).not.toMatch(/additionalProperties|\$ref|\$schema|\$defs|"default"/);
    expect(s).toMatchObject({ type: "object", required: ["a"], properties: { a: { type: "string", nullable: true, description: "d" }, c: { enum: ["k"] }, d: { anyOf: [{ type: "number" }, { type: "string" }] }, e: { type: "array", items: { type: "object", properties: { n: { type: "integer" } } } } } });
    const r: any = toGeminiRequest({ messages: [user("x")], tools: [{ name: "noargs", description: "n", input_schema: { type: "object", properties: {}, additionalProperties: false } }] }, undefined);
    expect(r.tools[0].functionDeclarations[0]).toEqual({ name: "noargs", description: "n" });
  });
  test("short-context model: history is trimmed to the per-minute token limit, newest turn kept, never starts on a model turn", () => {
    const big = "x".repeat(9000); // ~3000 tokens each
    const contents: any[] = []; for (let i = 0; i < 12; i++) contents.push({ role: i % 2 ? "model" : "user", parts: [{ text: big }] });
    const t = trimToBudget(contents, "", 12_000);
    expect(t.length).toBeLessThan(contents.length); expect(t[0]!.role).toBe("user"); expect(t[t.length - 1]).toBe(contents[11]);
    const msgs = contents.map((c) => ({ role: c.role === "user" ? "user" : "assistant", content: c.parts[0].text }));
    const row = cfgOf().models.find((m) => m.id === "gemma-4-31b-it")!;
    expect(row.extra?.shortContext).toBe(true); expect(row.limits?.tpm).toBe(16_000);
    expect((toGeminiRequest({ messages: msgs }, row) as any).contents.length).toBeLessThan(12);
    const flash = cfgOf().models.find((m) => m.id === "gemini-3.5-flash-lite")!;
    expect((toGeminiRequest({ messages: msgs }, flash) as any).contents.length).toBe(1 + 11 - 5 + 5); // untouched (merged same-role turns aside, alternation kept)
  });
});

describe("response stream", () => {
  test("text + usage (cumulative, last wins); signature-only empty part ignored; output = candidates + thoughts", async () => {
    const { p } = mk(async () => sse([
      { ...part([{ text: "Hel" }]), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 5 } },
      { ...part([{ text: "lo" }, { text: "", thoughtSignature: "S" }], { finishReason: "STOP" }), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 7, cachedContentTokenCount: 4 } }]));
    const ev = await events(await p.messages(reqBody()));
    expect(ev.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("")).toBe("Hello");
    const md = ev.find((e) => e.type === "message_delta");
    expect(md.delta.stop_reason).toBe("end_turn"); expect(md.usage).toEqual({ input_tokens: 6, output_tokens: 9, cache_read_input_tokens: 4 });
  });
  test("thought summaries are a thinking block, never text", async () => {
    const { p } = mk(async () => sse([part([{ text: "weighing", thought: true }]), part([{ text: "Answer" }], { finishReason: "STOP" })]));
    const ev = await events(await p.messages(reqBody()));
    expect(ev.find((e) => e.type === "content_block_start" && e.content_block.type === "thinking")).toBeTruthy();
    expect(ev.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("")).toBe("Answer");
    expect(ev.filter((e) => e.delta?.type === "thinking_delta").map((e) => e.delta.thinking).join("")).toBe("weighing");
  });
  test("functionCall -> tool_use with the signature in the id, args as JSON, stop_reason tool_use", async () => {
    const { p } = mk(async () => sse([part([{ functionCall: { name: "get_weather", args: { city: "Hanoi" }, id: "call_9" }, thoughtSignature: "SIG/1+" }], { finishReason: "STOP" })]));
    const ev = await events(await p.messages(reqBody()));
    const start = ev.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use").content_block;
    expect(start.name).toBe("get_weather"); expect(unpackCallId(start.id)).toEqual({ id: "call_9", signature: "SIG/1+" });
    expect(ev.find((e) => e.delta?.type === "input_json_delta").delta.partial_json).toBe('{"city":"Hanoi"}');
    expect(ev.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
  });
  test("MAX_TOKENS with content:{} is a plain error, an empty STOP too, a safety stop is a refusal", async () => {
    const empty = await events(await mk(async () => sse([{ candidates: [{ content: {}, finishReason: "MAX_TOKENS" }] }])).p.messages(reqBody()));
    expect(empty.find((e) => e.type === "error").error.message).toMatch(/output budget/);
    const none = await events(await mk(async () => sse([part([], { finishReason: "STOP" })])).p.messages(reqBody()));
    expect(none.find((e) => e.type === "error").error.message).toMatch(/empty answer/);
    const safe = await events(await mk(async () => sse([part([{ text: "I can't" }], { finishReason: "SAFETY" })])).p.messages(reqBody()));
    expect(safe.find((e) => e.type === "message_delta").delta.stop_reason).toBe("refusal");
    const blocked = await events(await mk(async () => sse([{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }])).p.messages(reqBody()));
    expect(blocked.find((e) => e.type === "message_delta").delta.stop_reason).toBe("refusal");
  });
  test("an in-stream error object becomes an error event", async () => {
    const ev = await events(await mk(async () => sse([{ error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } }])).p.messages(reqBody()));
    expect(ev.find((e) => e.type === "error").error.message).toBe("overloaded");
  });
});

describe("errors", () => {
  const err = (status: number, error: object, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "text/event-stream", ...headers } });
  const rl = (secs: number, extra: object = {}) => err(429, { code: 429, status: "RESOURCE_EXHAUSTED", message: `Quota exceeded. Please retry in ${secs}.2s`, details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generate_content_free_tier_requests" }] }], ...extra });
  test("429 with a short hint: ONE retry after the hinted wait, then success", async () => {
    const { p, calls, sleeps } = mk(async (_u, _i, n) => (n === 1 ? rl(3) : sse([part([{ text: "ok" }], { finishReason: "STOP" })])));
    expect((await events(await p.messages(reqBody()))).some((e) => e.type === "message_stop")).toBe(true);
    expect(calls).toHaveLength(2); expect(sleeps).toEqual([4000]);
  });
  test("429 twice: the second one is a plain user-facing error with the retry hint and the model's limits, no third call", async () => {
    const { p, calls } = mk(async () => rl(2));
    const e = await p.messages(reqBody()).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError); expect(e.status).toBe(429); expect(e.info.retryAfterS).toBe(3);
    expect(e.message).toMatch(/rate limit/i); expect(e.message).toMatch(/3s/); expect(e.message).toMatch(/15\/min, 500\/day/); expect(calls).toHaveLength(2);
  });
  test("429 with a long hint (39s) or the daily quota: no in-turn retry at all", async () => {
    const a = mk(async () => rl(39)); const e1 = await a.p.messages(reqBody()).catch((x) => x);
    expect(e1.status).toBe(429); expect(a.calls).toHaveLength(1); expect(e1.message).toMatch(/40s/);
    const b = mk(async () => err(429, { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric generate_content_free_tier_requests PerDayPerProjectPerModel, limit: 20" }));
    const e2 = await b.p.messages(reqBody()).catch((x) => x);
    expect(e2.status).toBe(429); expect(b.calls).toHaveLength(1); expect(e2.message).toMatch(/daily free quota/); expect(e2.info.retryable).toBe(false);
  });
  test("retry hint parsing: RetryInfo, message text, Retry-After header, none", () => {
    expect(retryHintS({ error: { details: [{ retryDelay: "39s" }] } })).toBe(39);
    expect(retryHintS({ error: { message: "x Please retry in 39.2s." } })).toBe(40);
    expect(retryHintS({ error: { message: "x" } }, "7")).toBe(7);
    expect(retryHintS({ error: { message: "x" } })).toBeUndefined();
  });
  test("413 is a plain error and is not retried; 400 API_KEY_INVALID is an auth error; 5xx retryable; unreadable body still works", async () => {
    const a = mk(async () => new Response("too big", { status: 413 })); const e = await a.p.messages(reqBody()).catch((x) => x);
    expect(e.status).toBe(413); expect(e.message).toMatch(/too large/); expect(a.calls).toHaveLength(1);
    const k = await mk(async () => err(400, { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] })).p.messages(reqBody()).catch((x) => x);
    expect(k.info.type).toBe("authentication_error"); expect(k.message).not.toContain(KEY);
    expect((await mk(async () => err(503, { code: 503, status: "UNAVAILABLE", message: "busy" })).p.messages(reqBody()).catch((x) => x)).info.retryable).toBe(true);
    expect(geminiError(400, null).status).toBe(400);
  });
  test("400 'User location is not supported' is a clear, non-retried region message", async () => {
    const a = mk(async () => err(400, { code: 400, status: "FAILED_PRECONDITION", message: "User location is not supported for the API use." }));
    const e = await a.p.messages(reqBody()).catch((x) => x);
    expect(e.status).toBe(400); expect(e.message).toMatch(/blocks AI Studio from the region/); expect(e.info.retryable).toBe(false); expect(a.calls).toHaveLength(1);
  });
  test("404 / 410 marks the model broken once and hides it; a redirect is refused", async () => {
    const broken: string[] = [];
    const cfg = cfgOf({ onBroken: (m) => { broken.push(m); (cfg.broken ??= []).push(m); } });
    const { p } = mk(async () => err(404, { code: 404, status: "NOT_FOUND", message: "models/x is no longer available to new users" }), cfg);
    expect((await p.messages(reqBody()).catch((x) => x)).status).toBe(404);
    expect(broken).toEqual(["gemini-3.5-flash-lite"]);
    expect((await p.listModels()).map((m) => m.id)).not.toContain("gemini-3.5-flash-lite");
    expect((await p.messages(reqBody()).catch((x) => x)).status).toBe(404); // now refused locally
    expect((await mk(async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } })).p.messages(reqBody()).catch((x) => x)).status).toBe(502);
  });
});

describe("catalog (seed + migration 0030)", () => {
  const rows = () => chatRows(seedCatalog(), "aistudio");
  test("default = Gemini 3.5 Flash Lite, first and the only suggested; tools/vision where a live request said so", () => {
    expect(rows()[0]!.id).toBe("gemini-3.5-flash-lite"); expect(rows().filter((r) => r.suggested).map((r) => r.id)).toEqual(["gemini-3.5-flash-lite"]);
    const by = Object.fromEntries(rows().map((r) => [r.id, r]));
    expect(by["gemini-3.5-flash-lite"]!.caps).toMatchObject({ text: true, tools: true, vision: true });
    expect(by["gemma-4-26b-a4b-it"]!.caps).toMatchObject({ tools: false, vision: false }); // text only until probed
    expect(by["gemma-4-31b-it"]!.caps.vision).toBe(false);
  });
  test("limits_json from the dashboard table; 5 RPM / 20 RPD Flash models are `limited`; 0-quota and non-chat models are not seeded", () => {
    const by = Object.fromEntries(rows().map((r) => [r.id, r]));
    expect(by["gemini-3.5-flash-lite"]!.limits).toEqual({ rpm: 15, rpd: 500, tpm: 250_000 });
    expect(by["gemma-4-31b-it"]!.limits).toEqual({ rpm: 30, rpd: 14_400, tpm: 16_000 }); expect(by["gemma-4-31b-it"]!.extra).toMatchObject({ shortContext: true });
    for (const id of ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-2.5-flash-lite"]) { expect(by[id]!.extra).toMatchObject({ limited: true }); expect(by[id]!.limits!.rpd).toBe(20); }
    expect(rows().filter((r) => r.extra?.limited).map((r) => r.id)).not.toContain("gemini-3.5-flash-lite");
    for (const r of rows()) { expect(r.limits!.rpm).toBeGreaterThan(0); expect(r.limits!.rpd).toBeGreaterThan(0); expect(r.id).not.toMatch(/tts|image|veo|lyria|embed|live|robotics|transcribe|2\.5-pro|3\.1-pro|argon|gemini-2-/); }
  });
  test("no price is invented: every AI Studio row's price is unknown (null), never 0", () => { for (const r of rows()) expect(r.price).toBeNull(); expect(AISTUDIO_CHAT_SEED.every((m) => m.provider === "aistudio" && m.kind === "chat")).toBe(true); });
  test("migration 0030 loads through loadCatalog with the same rows as the seed (limits, flags, order)", async () => {
    const db = new Database(":memory:");
    for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    const d1 = { prepare: (q: string) => ({ all: async () => ({ results: db.query(q).all() as any[] }) }) } as unknown as D1Database;
    const got = chatRows(await loadCatalog(d1), "aistudio"), want = rows();
    expect(got.map((r) => r.id)).toEqual(want.map((r) => r.id));
    for (const [i, r] of got.entries()) expect({ limits: r.limits, extra: r.extra, caps: r.caps, context: r.context, maxOutput: r.maxOutput }).toEqual({ limits: want[i]!.limits, extra: want[i]!.extra, caps: want[i]!.caps, context: want[i]!.context, maxOutput: want[i]!.maxOutput });
    expect(SEED_MODELS.filter((m) => m.provider === "aistudio")).toHaveLength(got.length);
  });
});

describe("descriptor, discovery, presets", () => {
  test("descriptor is valid, native, x-goog-api-key, user key, open only, has the vi + en data warning", () => {
    expect(validateDescriptor(AISTUDIO_DESCRIPTOR)).toEqual([]); expect(DESCRIPTORS.aistudio).toBe(AISTUDIO_DESCRIPTOR);
    expect(AISTUDIO_DESCRIPTOR).toMatchObject({ protocol: "gemini-native", authStyle: "x-goog-api-key", keyMode: "user", space: "open" });
    expect(AISTUDIO_DESCRIPTOR.dialect?.builtinToolsNever).toBe(true);
    expect(AISTUDIO_DESCRIPTOR.dataWarning!.vi).toMatch(/Google/); expect(AISTUDIO_DESCRIPTOR.dataWarning!.en).toMatch(/Google may read/);
    expect(AISTUDIO_PRESET.warning).toEqual(AISTUDIO_DESCRIPTOR.dataWarning); expect(PRESETS.map((p) => p.id).slice(0, 2)).toEqual(["nvidia", "aistudio"]); // (another test file may append a fake preset)
  });
  test("/models discovery: chat-capable only (generateContent, not tts/image/live/embedding/robotics...), paged, key in the header only", async () => {
    const urls: string[] = [], hdr: any[] = [];
    const page1 = { models: [{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] }, { name: "models/text-embedding-9", supportedGenerationMethods: ["embedContent"] }, { name: "models/gemini-3.1-flash-lite-image", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "T2" };
    const page2 = { models: [{ name: "models/gemma-4-31b-it", supportedGenerationMethods: ["generateContent", "countTokens"] }, { name: "models/gemini-robotics-er-2-preview", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-live-3", supportedGenerationMethods: ["bidiGenerateContent"] }] };
    const ids = await listGeminiModels(cfgOf(), {}, (async (u: string, i: any) => { urls.push(u); hdr.push(i.headers); return Response.json(urls.length === 1 ? page1 : page2); }) as any);
    expect(ids).toEqual(["gemini-3.5-flash-lite", "gemma-4-31b-it"]);
    expect(urls[1]).toContain("pageToken=T2"); expect(urls.join()).not.toContain(KEY); expect(hdr[0]["x-goog-api-key"]).toBe(KEY);
    expect(discoveredKind(AISTUDIO_DESCRIPTOR, "gemini-3.5-flash-lite")).toBe("chat");
    expect((await listGeminiModels(cfgOf(), {}, (async () => err404()) as any).catch((e) => e)).status).toBe(404);
  });
  test("a stored provider_configs row can never replace the built-in AI Studio provider", () => {
    // only the on/off switch survives: no origin, models, key binding or auth header
    expect(parseConfig({ id: "aistudio", kind: "openai-compat", base_url: "https://evil.example.com/v1", key_binding: "PROVIDER_KEY_X", enabled: 1 })).toEqual({ id: "aistudio", kind: "gemini", enabled: true, models: [] });
  });
});
const err404 = () => new Response(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message: "nope" } }), { status: 404 });

describe("registry + routes", () => {
  const ENV = {};
  const reg = (scope: any, over: Record<string, unknown> = {}, lat?: any[]) => buildRegistry({ scope, gateway: gw as any, env: ENV, ...(lat ? { latency: { record: (s: any) => lat.push(s) } } : {}), ...over } as any);
  const uk = (has: boolean) => ({ ids: new Map(has ? [["aistudio", "https://generativelanguage.googleapis.com"]] : []), get: async () => (has ? { kind: "key" as const, key: KEY } : { kind: "none" as const }) });
  test("Open lists AI Studio for main and a team base: needs-key without the user's key, enabled with it; Business never sees it; e2e never", async () => {
    expect(reg("main~open").list().find((p) => p.id === "aistudio")).toMatchObject({ status: "needs-key", kind: "gemini", catalogOnly: true });
    expect((await reg("main~open").models()).filter((m) => m.provider === "aistudio")).toEqual([]);
    const withKey = reg("main~open", { userKeys: uk(true) });
    const info = withKey.list().find((p) => p.id === "aistudio")!;
    expect(info).toMatchObject({ status: "enabled", keySet: true, key_source: "user", host: "generativelanguage.googleapis.com", catalogOnly: true });
    expect(info.dataWarning!.en).toMatch(/Google may read/); expect(JSON.stringify(info)).not.toContain(KEY);
    const models = (await withKey.models()).filter((m) => m.provider === "aistudio");
    expect(models.map((m) => m.id)[0]).toBe("aistudio:gemini-3.5-flash-lite"); expect(models).toHaveLength(7);
    const guest = reg(`${GA as string}~open`, { userKeys: uk(true) });
    expect(guest.list().find((p) => p.id === "aistudio")).toMatchObject({ status: "enabled", presetOnly: true });
    expect(reg("main").list().map((p) => p.id)).toEqual(["gateway"]); expect(reg("e2e~open").list().map((p) => p.id)).toEqual(["stub"]);
  });
  test("a call routes by prefix, uses the user's key in the header only, and is timed by the latency sink (never content)", async () => {
    const lat: any[] = []; let seen: any = null;
    const r = reg("main~open", { userKeys: uk(true), fetchImpl: (async (u: string, i: any) => { seen = { u, h: i.headers }; return sse([part([{ text: "hi there" }]), { ...part([], { finishReason: "STOP" }), usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }]); }) as any }, lat);
    const res = await r.router.messages(reqBody({ model: "aistudio:gemini-3.5-flash-lite" }));
    await res.text();
    expect(seen.u).toContain("/models/gemini-3.5-flash-lite:streamGenerateContent"); expect(seen.h["x-goog-api-key"]).toBe(KEY);
    expect(lat).toHaveLength(1); expect(lat[0]).toMatchObject({ providerId: "aistudio", modelId: "gemini-3.5-flash-lite", kind: "chat", space: "open", outcome: "ok", outputTokens: 2 });
    expect(JSON.stringify(lat)).not.toMatch(/hi there|be brief/);
  });
  test("/api/models decoration: limits hint, limited flag, shortContext, data warning, no invented price; default skips a limited model", async () => {
    const r = reg("main~open", { userKeys: uk(true) }); const all = await r.models();
    const dm = decorateModels(all.filter((m) => m.provider === "aistudio"), seedCatalog(), new Map());
    const by = Object.fromEntries(dm.map((m) => [m.id, m]));
    expect(by["aistudio:gemini-3.5-flash-lite"]).toMatchObject({ limited: false, shortContext: false, limits: { rpm: 15, rpd: 500, tpm: 250_000 }, priceEstimate: null, flags: { tools: true, vision: true } });
    expect(by["aistudio:gemini-3.6-flash"]!.limited).toBe(true); expect(by["aistudio:gemma-4-31b-it"]!.shortContext).toBe(true);
    expect(dm.every((m) => m.dataWarning?.vi && m.dataWarning?.en && m.priceEstimate === null)).toBe(true);
    const first = [by["aistudio:gemini-3.6-flash"]!, by["aistudio:gemini-3.5-flash-lite"]!];
    expect((first.find((m) => !m.limited) ?? first[0])!.id).toBe("aistudio:gemini-3.5-flash-lite");
  });
  test("routes: the built-in provider cannot be created/edited as a row; only its key can be stored (team user too); the key is never returned; /presets carries the warning", async () => {
    const env = mkEnv();
    const put = await call(env, "example-user", "PUT", "/api/providers/aistudio", { baseUrl: "https://evil.example.com/v1" });
    expect(put.status).toBe(400); expect(await put.text()).toMatch(/built in/);
    const k = await call(env, "example-user", "PUT", "/api/providers/aistudio/key", { key: FAKE }); expect(k.status).toBe(200);
    const kb = JSON.stringify(await k.json()); expect(kb).toContain('"user"'); expect(kb).not.toContain(FAKE);
    const list = await (await call(env, "example-user", "GET", "/api/providers", undefined, "open")).json() as any;
    const a = list.providers.find((p: any) => p.id === "aistudio"); expect(a).toMatchObject({ status: "enabled", key_source: "user", catalogOnly: true }); expect(JSON.stringify(list)).not.toContain(FAKE);
    const pre = await (await call(env, "example-user", "GET", "/api/providers/presets")).json() as any;
    expect(pre.presets.find((p: any) => p.id === "aistudio").warning.vi).toMatch(/Google/);
    const miss = await call(env, "example-user", "POST", "/api/providers/aistudio/models");
    expect([200, 502, 503]).toContain(miss.status);
  });
});

describe("AI Studio fix round", () => {
  const tool = (input_schema: any) => toGeminiRequest({ messages: [user("x")], tools: [{ name: "t", description: "d", input_schema }] }, undefined) as any;
  test("M1b: a base containing % or _ never loads another tenant's broken rows", async () => {
    const { markBroken, loadUserBroken } = await import("../src/provider-routes");
    const env: any = mkEnv();
    await markBroken(env.DB, "aistudio", "victim-model", "g:victimXY");
    await markBroken(env.DB, "aistudio", "upper-model", "g:VICTIMXY");
    for (const evil of ["g:%", "g:victim_Y", "g:victim%", "g:_ictimXY", "g:%%"]) expect(await loadUserBroken(env.DB, evil)).toEqual({});
    expect(await loadUserBroken(env.DB, "g:victimXY")).toEqual({ aistudio: ["victim-model"] });
    expect(await loadUserBroken(env.DB, "g:VICTIMXY")).toEqual({ aistudio: ["upper-model"] });
    await markBroken(env.DB, "aistudio", "own-model", "g:a_c");
    expect(await loadUserBroken(env.DB, "g:a_c")).toEqual({ aistudio: ["own-model"] });
    expect(await loadUserBroken(env.DB, "g:abc")).toEqual({});
  });
  test("M1: a 404 is recorded in THIS user's own list only; the shared catalog row is never written", async () => {
    const { markBroken, loadUserBroken } = await import("../src/provider-routes");
    const env: any = mkEnv(); const before = JSON.stringify(await env.DB.prepare("SELECT model_id, broken FROM provider_models ORDER BY provider_id, model_id").all());
    await markBroken(env.DB, "aistudio", "gemini-3.5-flash-lite", "g:userAAAA"); await markBroken(env.DB, "aistudio", "gemini-3.5-flash-lite", "g:userAAAA");
    expect(await loadUserBroken(env.DB, "g:userAAAA")).toEqual({ aistudio: ["gemini-3.5-flash-lite"] });
    expect(await loadUserBroken(env.DB, "g:userBBBB")).toEqual({});
    expect(JSON.stringify(await env.DB.prepare("SELECT model_id, broken FROM provider_models ORDER BY provider_id, model_id").all())).toBe(before);
    // the registry hides it for the marked user and keeps it for another
    const mine = buildRegistry({ scope: "main~open", gateway: gw as any, env: {}, userKeys: { ids: new Map([["aistudio", "https://generativelanguage.googleapis.com"]]), get: async () => ({ kind: "key" as const, key: KEY }) } as any, userBroken: { aistudio: ["gemini-3.5-flash-lite"] } } as any);
    expect((await mine.models()).map((m) => m.id)).not.toContain("aistudio:gemini-3.5-flash-lite");
    const other = buildRegistry({ scope: "main~open", gateway: gw as any, env: {}, userKeys: { ids: new Map([["aistudio", "https://generativelanguage.googleapis.com"]]), get: async () => ({ kind: "key" as const, key: KEY }) } as any } as any);
    expect((await other.models()).map((m) => m.id)).toContain("aistudio:gemini-3.5-flash-lite");
  });
  test("M2: numeric / boolean enums keep their type, drop the enum and list the values in the description; string enums stay", () => {
    const s: any = sanitizeSchema({ type: "object", properties: { n: { type: "integer", enum: [1, 2, 3], description: "level" }, b: { type: "boolean", enum: [true] }, s: { type: "string", enum: ["a", "b"] }, k: { const: 5, type: "number" } } });
    expect(s.properties.n).toEqual({ type: "integer", description: "level Allowed values: 1, 2, 3." });
    expect(s.properties.b).toEqual({ type: "boolean", description: "Allowed values: true." });
    expect(s.properties.s).toEqual({ type: "string", enum: ["a", "b"] });
    expect(s.properties.k).toEqual({ type: "number", description: "Allowed values: 5." });
  });
  test("M2: a top-level oneOf / anyOf is merged into one object (union of properties, required = intersection)", () => {
    for (const key of ["oneOf", "anyOf"]) {
      const p = tool({ [key]: [{ type: "object", properties: { id: { type: "string" }, a: { type: "number" } }, required: ["id", "a"] }, { type: "object", properties: { id: { type: "string" }, b: { type: "string" } }, required: ["id"] }] }).tools[0].functionDeclarations[0].parameters;
      expect(p).toEqual({ type: "object", properties: { id: { type: "string" }, a: { type: "number" }, b: { type: "string" } }, required: ["id"] });
    }
  });
  test("M3: tool-call ids without a provider id are unique across two sequential tool turns and replay stably with the signature", async () => {
    const turn = async (sig: string) => { const { p } = mk(async () => sse([part([{ functionCall: { name: "get_weather", args: { c: 1 } }, thoughtSignature: sig }], { finishReason: "STOP" })])); const ev = await events(await p.messages(reqBody())); return ev.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use").content_block.id as string; };
    const id1 = await turn("S1"), id2 = await turn("S2");
    expect(id1).not.toBe(id2); expect(id1).toMatch(/^call_[a-z0-9]+_0__gsig_/); expect(unpackCallId(id1).signature).toBe("S1"); expect(unpackCallId(id2).signature).toBe("S2");
    const { contents } = toGeminiContents({ messages: [user("q"),
      { role: "assistant", content: [{ type: "tool_use", id: id1, name: "get_weather", input: { c: 1 } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: id1, content: "r1" }] },
      { role: "assistant", content: [{ type: "tool_use", id: id2, name: "get_time", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: id2, content: "r2" }] }] });
    const calls = contents.flatMap((c) => c.parts).filter((x: any) => x.functionCall || x.functionResponse);
    expect(calls.map((x: any) => x.functionCall?.name ?? x.functionResponse.name)).toEqual(["get_weather", "get_weather", "get_time", "get_time"]);
    expect(calls.filter((x: any) => x.thoughtSignature).map((x: any) => x.thoughtSignature)).toEqual(["S1", "S2"]);
  });
  test("L: the aistudio provider exposes a data-use notice for the generic providerNotices banner (banner itself arrives with the Groq branch)", async () => {
    expect(AISTUDIO_DESCRIPTOR.dataUseNotice).toMatch(/Google may read/);
    const env: any = mkEnv(); await call(env, "example-user", "PUT", "/api/providers/aistudio/key", { key: FAKE });
    const r = await call(env, "example-user", "GET", "/api/models", undefined, "open"); const j: any = await r.json();
    expect(j.providerNotices?.aistudio).toBe(AISTUDIO_DESCRIPTOR.dataUseNotice);
  });
});
