// Groq provider (Open, user's own key): catalog rows + migration 0031, descriptor, request dialect, history trimming to the 8K tokens/minute budget, 429/413 handling,
// reasoning kept out of replay, /api/models fields. All fetches are mocked; nothing here talks to Groq.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { builtinPresetConfigs, parseConfig, type ProviderConfig } from "../src/providers/config";
import { SEED_COLUMNS, loadCatalog, seedCatalog, seedRowValues, chatRows } from "../src/providers/catalog";
import { GROQ_CHAT_SEED, SEED_MODELS } from "../src/providers/seed";
import { GROQ_DESCRIPTOR, DESCRIPTORS, discoveredKind, validateDescriptor } from "../src/providers/descriptor";
import { openaiCompatProvider, retryHintS, toChatRequest } from "../src/providers/openai-compat";
import { estimateTokens, fitToBudget, capImages, TRIM_NOTE } from "../src/providers/chat-budget";
import { buildRegistry } from "../src/providers/registry";
import { decorateModels, defaultModelId, isLimited } from "../src/models-api";
import { ProviderError } from "../src/providers/types";
import { SYSTEM_PROMPT_OPEN } from "../src/system-prompt";
import { cfToolDefs } from "../src/cf-tools";
import { ARTIFACT_TOOL_DEFS } from "../src/artifacts";
import type { LatencySample } from "../src/latency";

const KEY = "test-key-not-a-real-credential";
const groqCfg = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ ...builtinPresetConfigs("main").find((c) => c.id === "groq")!, resolveKey: async () => ({ kind: "key" as const, key: KEY }), ...extra });
const enc = new TextEncoder();
const sse = (chunks: unknown[]) => new Response(new ReadableStream({ start(c) { for (const j of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(j)}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const text = async (r: Response) => await r.text();
const sleepNever = async () => { throw new Error("must not sleep"); };

describe("catalog: Groq rows, migration 0031", () => {
  test("seed = three chat rows; whisper/orpheus/guard/safeguard/allam are NOT chat rows", () => {
    expect(GROQ_CHAT_SEED.map((m) => m.id)).toEqual(["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
    for (const m of GROQ_CHAT_SEED) expect(m.id).not.toMatch(/whisper|orpheus|guard|safeguard|allam/);
    expect(chatRows(seedCatalog(), "groq").length).toBe(3);
  });
  test("Open default order: Lightning wins when listed; falls through ultra, minimax, groq 120b, groq 20b, aistudio 3.1 flash-lite, aistudio 3.5 flash-lite (slowest, last); limited never; else first non-limited", () => {
    const L = (id: string, limited = false) => ({ id, limited });
    const all = ["aistudio:gemini-3.5-flash-lite", "aistudio:gemini-3.1-flash-lite", "groq:openai/gpt-oss-20b", "groq:openai/gpt-oss-120b", "nvidia:minimaxai/minimax-m3.1-flash", "nvidia:nvidia/nemotron-3-ultra-550b-a55b", "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b"];
    for (let i = all.length - 1; i >= 0; i--) expect(defaultModelId(all.slice(0, i + 1).map((id) => L(id)).reverse())).toBe(all[i]);
    expect(defaultModelId([L("nvidia:nvidia/nemotron-3.5-lightning-30b-a3b", true), L("x"), L("groq:openai/gpt-oss-20b")])).toBe("groq:openai/gpt-oss-20b");
    expect(defaultModelId([L("x"), L("y")])).toBe("x");
  });
  test("migration 0031 inserts exactly the Groq seed rows (no drift), nothing else", () => {
    const db = new Database(":memory:");
    for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    const rows = db.query(`SELECT ${SEED_COLUMNS.join(", ")} FROM provider_models WHERE provider_id='groq' ORDER BY sort`).all() as any[];
    expect(rows.length).toBe(3);
    for (const [i, m] of SEED_MODELS.entries()) if (m.provider === "groq") { const { sort: _a, ...a } = rows.find((r) => r.model_id === m.id); const { sort: _b, ...b } = seedRowValues(m, i); expect(a).toEqual(b); } // sort: the seed index shifted when 0032 retired NIM rows from the list
    const sql = readFileSync(new URL("../migrations/0031_provider_groq.sql", import.meta.url), "utf8");
    expect(sql.split("\n").filter((l) => /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/.test(l)).every((l) => l.startsWith("INSERT OR IGNORE INTO provider_models"))).toBe(true);
  });
  test("rows carry the dashboard free-tier limits, shortContext, an estimate price WITH a source, and the right per-model flags", async () => {
    const db = new Database(":memory:");
    for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    const d1 = { prepare: (q: string) => ({ all: async () => ({ results: db.query(q).all() as any[] }) }) } as unknown as D1Database;
    const rows = chatRows(await loadCatalog(d1), "groq");
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.limits).toEqual({ rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 });
      expect(r.extra).toMatchObject({ shortContext: true }); expect(r.price?.source).toMatch(/^seed:2026-10-26:/); expect(isLimited(r)).toBe(false);
    }
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["openai/gpt-oss-20b"]!.extra).toMatchObject({ parallelTools: false, reasoningEffort: "medium" }); expect(by["openai/gpt-oss-20b"]!.caps).toMatchObject({ tools: true, reasoning: true, vision: false });
    expect(by["qwen/qwen3.8-27b"]!.extra).toMatchObject({ parallelTools: true, maxImages: 3 }); expect(by["qwen/qwen3.8-27b"]!.caps).toMatchObject({ tools: true, vision: true });
    expect(by["openai/gpt-oss-120b"]!.price).toMatchObject({ input: 0.15, output: 0.6 });
  });
  test("a limited model (<=100 requests/day or extra.limited) is flagged and never the default", () => {
    const row = (limits: any, extra: any = null) => ({ limits, extra });
    expect(isLimited(row({ rpd: 20 }))).toBe(true); expect(isLimited(row({ rpd: 1000 }))).toBe(false); expect(isLimited(row(null, { limited: true }))).toBe(true); expect(isLimited(row(null))).toBe(false);
    expect(defaultModelId([{ id: "a", limited: true }, { id: "b", limited: false }])).toBe("b"); expect(defaultModelId([{ id: "a", limited: true }])).toBeNull(); expect(defaultModelId([])).toBeNull();
  });
});

describe("descriptor + preset", () => {
  test("lint-clean, Open only, user key only, no secret, neutral data-use notice that says it is unverified", () => {
    expect(validateDescriptor(GROQ_DESCRIPTOR)).toEqual([]); expect(DESCRIPTORS.groq).toBe(GROQ_DESCRIPTOR);
    expect(GROQ_DESCRIPTOR).toMatchObject({ space: "open", keyMode: "user", baseUrl: "https://api.groq.com/openai/v1", authStyle: "bearer", dialect: { maxTokensParam: "max_completion_tokens", builtinToolsNever: true } });
    expect(GROQ_DESCRIPTOR.dataUseNotice).toMatch(/not stated/i); expect(GROQ_DESCRIPTOR.dataUseNotice).toMatch(/unverified/i);
  });
  test("non-chat ids are skipped by discovery", () => {
    for (const id of ["whisper-large-v3", "whisper-large-v3-turbo", "canopylabs/orpheus-v1-english", "meta-llama/llama-prompt-guard-2-22m", "openai/gpt-oss-safeguard-20b", "allam-2-7b"]) expect(discoveredKind(GROQ_DESCRIPTOR, id)).toBe("skip");
    for (const id of ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]) expect(discoveredKind(GROQ_DESCRIPTOR, id)).toBe("chat");
  });
  test("main gets NO Worker-secret binding for Groq (own key only); a team base is allowed guests; models come from the catalog", () => {
    expect(builtinPresetConfigs("main").find((c) => c.id === "groq")!.keyBinding).toBeUndefined();
    expect(builtinPresetConfigs("main").find((c) => c.id === "nvidia")!.keyBinding).toBe("PROVIDER_KEY_NVIDIA");
    const g = builtinPresetConfigs("g:u1" as any).find((c) => c.id === "groq")!; expect(g.allowGuests).toBe(true); expect(g.models.length).toBe(3);
    expect(g.models.find((m) => m.id === "openai/gpt-oss-20b")).toMatchObject({ limits: { tpm: 8000 }, extra: { shortContext: true } });
  });
  test("a stored groq row never replaces the built-in (locked preset): only on/off; the built-in keeps catalog capabilities at the preset origin", () => {
    const row = (base: string) => ({ id: "groq", kind: "openai-compat", base_url: base, enabled: 1, models_json: JSON.stringify([{ id: "openai/gpt-oss-20b", capabilities: { tools: true } }]) });
    for (const base of ["https://api.groq.com/openai/v1", "https://evil.example/v1"]) expect(parseConfig(row(base))).toEqual({ id: "groq", kind: "openai-compat", enabled: true, models: [] });
    const ok = builtinPresetConfigs("main").find((c) => c.id === "groq")!.models.find((m) => m.id === "openai/gpt-oss-20b")!; expect(ok.capabilities).toMatchObject({ tools: true, reasoning: true }); expect(ok.extra).toMatchObject({ shortContext: true });
  });
});

describe("request dialect", () => {
  const body = { system: "S", max_tokens: 500, messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }], tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }] };
  test("max_completion_tokens (never max_tokens), parallel_tool_calls:false, reasoning_effort, denied params gone, text flattened to a string", () => {
    const r: any = toChatRequest(body, "openai/gpt-oss-20b", { maxTokensParam: "max_completion_tokens", flattenText: true, noParallelTools: true, reasoningEffort: "medium", deny: ["logprobs", "n"] });
    expect(r.max_completion_tokens).toBe(500); expect(r).not.toHaveProperty("max_tokens"); expect(r.parallel_tool_calls).toBe(false); expect(r.reasoning_effort).toBe("medium");
    expect(r).not.toHaveProperty("logprobs"); expect(r).not.toHaveProperty("n"); expect(r.messages[1].content).toBe("a\nb");
    expect(r.tools.every((t: any) => t.type === "function")).toBe(true); expect(JSON.stringify(r)).not.toMatch(/browser_search|code_interpreter|code_execution/);
  });
  test("no tools -> no parallel_tool_calls; no opts -> the old shape (max_tokens)", () => {
    expect(toChatRequest({ ...body, tools: undefined }, "m", { noParallelTools: true })).not.toHaveProperty("parallel_tool_calls");
    const r: any = toChatRequest(body, "m"); expect(r.max_tokens).toBe(500); expect(r).not.toHaveProperty("reasoning_effort");
  });
  test("reasoning (thinking blocks) is never replayed to the provider", () => {
    const r: any = toChatRequest({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-CHAIN" }, { type: "text", text: "answer" }] }, { role: "user", content: "next" }] }, "m");
    expect(JSON.stringify(r)).not.toContain("SECRET-CHAIN");
  });
  test("the adapter sends the dialect for the groq model rows (gpt-oss: effort + no parallel; qwen: parallel allowed, no effort)", async () => {
    const sent: any[] = [];
    const f = async (_u: string, i?: RequestInit) => { sent.push(JSON.parse(String(i!.body))); return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]); };
    const p = openaiCompatProvider(groqCfg(), {}, f as never, sleepNever);
    await text(await p.messages({ ...body, model: "openai/gpt-oss-20b" })); await text(await p.messages({ ...body, model: "qwen/qwen3.8-27b" }));
    expect(sent[0]).toMatchObject({ reasoning_effort: "medium", parallel_tool_calls: false }); expect(sent[0]).not.toHaveProperty("max_tokens"); expect(typeof sent[0].max_completion_tokens).toBe("number");
    expect(sent[1]).not.toHaveProperty("reasoning_effort"); expect(sent[1]).not.toHaveProperty("parallel_tool_calls"); expect(sent[1].max_completion_tokens).toBeGreaterThan(0);
  });
});

describe("stream: reasoning + usage", () => {
  test("delta.reasoning becomes a thinking block (separate from the answer); usage from the final chunk (top-level or x_groq)", async () => {
    const f = async () => sse([{ choices: [{ delta: { role: "assistant", content: "" } }], x_groq: { id: "x" } }, { choices: [{ delta: { reasoning: "think ", channel: "analysis" } }] }, { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], x_groq: { usage: { prompt_tokens: 40, completion_tokens: 9 } } }]);
    const out = await text(await openaiCompatProvider(groqCfg(), {}, f as never, sleepNever).messages({ model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }));
    expect(out).toContain('"type":"thinking"'); expect(out).toContain('"thinking_delta"'); expect(out).toContain('"text_delta"'); expect(out).toContain('"input_tokens":40'); expect(out).toContain('"output_tokens":9');
  });
});

describe("rate limits: 429 / 413", () => {
  const err = (status: number, message: string, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { message, type: "tokens", code: "rate_limit_exceeded" } }), { status, headers: { "content-type": "application/json", ...headers } });
  const req = { model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
  test("429 with a long hint: NO retry, plain message with the wait, org id never shown", async () => {
    let n = 0; const f = async () => { n++; return err(429, "Rate limit reached for model `openai/gpt-oss-20b` in organization `org_SECRETORG` on tokens per minute (TPM): Limit 8000, Used 6443, Requested 6596. Please try again in 37.7925s.", { "retry-after": "38" }); };
    const e: any = await openaiCompatProvider(groqCfg(), {}, f as never, sleepNever).messages(req).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError); expect(e.status).toBe(429); expect(n).toBe(1);
    expect(e.message).toMatch(/tokens per minute/); expect(e.message).toMatch(/38s/); expect(e.message).not.toMatch(/org_/); expect(e.info).toMatchObject({ retryable: true, retryAfterS: 38 });
  });
  test("429 with a short hint (body only, 877ms): exactly ONE retry after the hint, then success", async () => {
    let n = 0, slept = 0; const f = async () => (++n === 1 ? err(429, "Please try again in 877ms.") : sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]));
    const r = await openaiCompatProvider(groqCfg(), {}, f as never, async (ms) => { slept = ms; }).messages(req); expect(n).toBe(2); expect(slept).toBe(1000); expect(await text(r)).toContain("ok");
  });
  test("a second 429 after the one retry is surfaced (no loop)", async () => {
    let n = 0; const f = async () => { n++; return err(429, "tokens per minute (TPM). Please try again in 2s.", { "retry-after": "2" }); };
    const e: any = await openaiCompatProvider(groqCfg(), {}, f as never, async () => {}).messages(req).catch((x) => x); expect(n).toBe(2); expect(e.status).toBe(429);
  });
  test("429 on the DAILY limit names it; a 1h+ hint is shown, not waited for", async () => {
    const f = async () => err(429, "Rate limit reached ... on tokens per day (TPD): Limit 200000. Please try again in 14m23.5s.");
    const e: any = await openaiCompatProvider(groqCfg(), {}, f as never, sleepNever).messages(req).catch((x) => x); expect(e.message).toMatch(/daily/); expect(e.message).toMatch(/15 min/);
  });
  test("413: one call, not retryable, 'too large for this model's per-minute limit', the misleading retry-after is ignored", async () => {
    let n = 0; const f = async () => { n++; return err(413, "Request too large for model `x` in organization `org_SECRETORG` on tokens per minute (TPM): Limit 8000, Requested 12596", { "retry-after": "36" }); };
    const e: any = await openaiCompatProvider(groqCfg(), {}, f as never, sleepNever).messages(req).catch((x) => x);
    expect(n).toBe(1); expect(e.status).toBe(413); expect(e.message).toMatch(/too large for this model's per-minute limit/); expect(e.message).not.toMatch(/org_/); expect(e.info.retryable).toBe(false); expect(e.info.retryAfterS).toBeUndefined();
  });
  test("401 is the app's credential error; an unknown model 404 still marks the model broken", async () => {
    let broken = ""; const cfg = groqCfg({ onBroken: (m) => { broken = m; } });
    const e1: any = await openaiCompatProvider(cfg, {}, (async () => new Response(JSON.stringify({ error: { message: "Invalid API Key", code: "invalid_api_key" } }), { status: 401 })) as never).messages(req).catch((x) => x); expect(e1.message).toMatch(/rejected/);
    await openaiCompatProvider(cfg, {}, (async () => new Response(JSON.stringify({ error: { message: "nope", code: "model_not_found" } }), { status: 404 })) as never).messages(req).catch(() => {}); expect(broken).toBe("openai/gpt-oss-20b");
  });
  test("retryHintS parses s, ms and m+s", () => {
    expect(retryHintS("Please try again in 37.7925s.")).toBe(38); expect(retryHintS("try again in 877ms")).toBe(1); expect(retryHintS("try again in 14m23.5s")).toBe(864); expect(retryHintS("nothing here")).toBeUndefined(); expect(retryHintS(undefined)).toBeUndefined();
  });
});

describe("short-context budget (8K tokens/minute)", () => {
  const turn = (t: string, n: number) => [{ role: "user", content: `${t} ${"x".repeat(n)}` }, { role: "assistant", content: [{ type: "text", text: `a-${t} ${"y".repeat(n)}` }] }];
  test("history is trimmed from the oldest turn, the current turn stays, the request fits, the model is told history was cut", () => {
    const messages = [...turn("t1", 6000), ...turn("t2", 6000), ...turn("t3", 6000), { role: "user", content: "CURRENT question" }];
    const r = fitToBudget({ system: [{ type: "text", text: "S".repeat(3000) }], messages }, { tpm: 8000, wantOut: 2500, tooLargeMessage: "too big" });
    expect(r.trimmed).toBe(true); expect(r.body.messages.at(-1).content).toBe("CURRENT question"); expect(r.body.messages[0].role).toBe("user"); expect(r.body.messages.length).toBeLessThan(messages.length);
    expect(r.promptTokens + r.maxOutput).toBeLessThanOrEqual(8000); expect(JSON.stringify(r.body.system)).toMatch(/left out/);
    expect(JSON.stringify(r.body.messages)).not.toContain("t1 x");
  });
  test("a chat that already fits is untouched; the output cap is lowered to what is left", () => {
    const small = { system: "S", messages: [{ role: "user", content: "hi" }] };
    const a = fitToBudget(small, { tpm: 8000, wantOut: 2500, tooLargeMessage: "x" }); expect(a.trimmed).toBe(false); expect(a.body.messages).toEqual(small.messages); expect(a.maxOutput).toBe(2500);
    const b = fitToBudget({ system: "S".repeat(15000), messages: [{ role: "user", content: "hi" }] }, { tpm: 8000, wantOut: 2500, tooLargeMessage: "x" }); expect(b.maxOutput).toBeLessThan(2500); expect(b.maxOutput).toBeGreaterThanOrEqual(700);
  });
  test("tool_use/tool_result pairs of the current turn are never split; cuts happen only at turn starts", () => {
    const messages = [...turn("old", 14000), { role: "user", content: "now do it" }, { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: { a: 1 } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "result" }] }];
    const r = fitToBudget({ system: "S", messages }, { tpm: 8000, wantOut: 2500, tooLargeMessage: "x" });
    expect(r.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]); expect(r.body.messages[0].content).toBe("now do it");
  });
  test("a mixed tool_result + text user message is not a cut point: its tool_use is never dropped from under it", () => {
    const tp = (id: string, n: number) => [{ role: "assistant", content: [{ type: "tool_use", id, name: "t", input: { p: "i".repeat(n) } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "r" }, { type: "text", text: "and then?" }] }];
    const messages = [{ role: "user", content: "start" }, ...tp("c1", 12000), ...tp("c2", 12000), { role: "user", content: "CURRENT" }];
    const r = fitToBudget({ system: "S", messages }, { tpm: 8000, wantOut: 2500, tooLargeMessage: "x" });
    const ids = (k: string) => r.body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === k).map((b: any) => b.tool_use_id ?? b.id));
    expect(ids("tool_result")).toEqual(ids("tool_use")); expect(r.body.messages[0].role).toBe("user"); expect(r.body.messages[0].content).toBe("CURRENT");
  });
  test("tool pairs inside kept history stay whole when the cut lands between two turns", () => {
    const pair = (id: string) => [{ role: "assistant", content: [{ type: "tool_use", id, name: "t", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "r" }] }];
    const messages = [{ role: "user", content: "old " + "x".repeat(21000) }, ...pair("c0"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: "mid" }, ...pair("c1"), { role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "user", content: "CURRENT" }];
    const r = fitToBudget({ system: "S", messages }, { tpm: 8000, wantOut: 2500, tooLargeMessage: "x" });
    expect(r.trimmed).toBe(true); expect(r.body.messages[0].content).toBe("mid"); expect(JSON.stringify(r.body.messages)).toContain("c1"); expect(JSON.stringify(r.body.messages)).not.toContain("c0");
  });
  test("the trim note counts toward the budget when choosing the cut point", () => {
    const messages = [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "text", text: "b" }] }, { role: "user", content: "CURRENT" }];
    const noteTok = estimateTokens({ system: [{ type: "text", text: TRIM_NOTE }], messages: [] });
    const want = 700, base = estimateTokens({ system: "", messages: messages.slice(2) });
    // tpm sized so the cut history fits only WITHOUT the note: must be refused instead of exceeding the budget by the note
    const tpm = Math.ceil((base + want + noteTok / 2) / 0.92);
    let r: any; try { r = fitToBudget({ system: "", messages }, { tpm, wantOut: want, tooLargeMessage: "x" }); } catch (e) { r = e; }
    if (r instanceof Error) expect((r as any).status).toBe(413); else expect(r.promptTokens + 700).toBeLessThanOrEqual(Math.floor(tpm * 0.92));
  });
  test("a single message larger than the minute budget is refused locally as 413 (no call is made)", async () => {
    let n = 0; const f = async () => { n++; return new Response("{}"); };
    const e: any = await openaiCompatProvider(groqCfg(), {}, f as never, sleepNever).messages({ model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "z".repeat(40_000) }], max_tokens: 2500 }).catch((x) => x);
    expect(n).toBe(0); expect(e).toBeInstanceOf(ProviderError); expect(e.status).toBe(413); expect(e.message).toMatch(/too large for this model's per-minute limit/);
  });
  test("through the adapter: a long history is trimmed before the request, and what is sent fits the estimate", async () => {
    let sent: any; const f = async (_u: string, i?: RequestInit) => { sent = JSON.parse(String(i!.body)); return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]); };
    const messages = [...turn("a", 7000), ...turn("b", 7000), { role: "user", content: "last" }];
    await text(await openaiCompatProvider(groqCfg(), {}, f as never, sleepNever).messages({ model: "openai/gpt-oss-20b", system: "S", messages, max_tokens: 2500 }));
    expect(sent.messages.at(-1).content).toBe("last"); expect(sent.messages.length).toBeLessThan(messages.length + 1);
    expect(Math.ceil(JSON.stringify(sent.messages).length / 3) + sent.max_completion_tokens).toBeLessThanOrEqual(8000);
  });
  test("vision: at most 3 images per request (older ones become a text marker); each image counts ~1.3K tokens", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const b = { messages: [{ role: "user", content: [img, img, img, img, { type: "text", text: "what" }] }] };
    const c = capImages(b, 3); expect(JSON.stringify(c)).toContain("earlier image omitted"); expect(c.messages[0].content.filter((x: any) => x.type === "image").length).toBe(3);
    expect(capImages({ messages: [{ role: "user", content: [img, { type: "text", text: "x" }] }] }, 3).messages[0].content[0].type).toBe("image");
    expect(estimateTokens({ messages: [{ role: "user", content: [img, img, img] }] })).toBeGreaterThanOrEqual(3900);
  });
  test("the real Open prompt + tool definitions leave room for a conversation inside 8K (measured size, see descriptor comment)", () => {
    const tools = [...cfToolDefs({ browser: true, image: true }), ...ARTIFACT_TOOL_DEFS].map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
    const prefix = estimateTokens({ system: [{ type: "text", text: SYSTEM_PROMPT_OPEN }], tools, messages: [] });
    expect(prefix).toBeGreaterThan(1500); expect(prefix).toBeLessThan(3500); // our pessimistic estimate (chars/3); the real count is lower: see docs/provider-groq.md
    const r = fitToBudget({ system: [{ type: "text", text: SYSTEM_PROMPT_OPEN }], tools, messages: [{ role: "user", content: "hello" }] }, { tpm: 8000, wantOut: 2500, tooLargeMessage: "x" });
    expect(r.maxOutput).toBe(2500);
  });
});

describe("/api/models fields + registry", () => {
  const gw = { name: "gw", messages: async () => new Response("{}"), listModels: async () => [] };
  test("Open registry lists the three Groq models with limits, shortContext, price ESTIMATE and no limited flag; provider carries the data-use notice", async () => {
    const reg = buildRegistry({ scope: "main~open" as any, gateway: gw, env: {}, catalog: seedCatalog(), userKeys: { ids: new Map([["groq", "https://api.groq.com"]]), get: async () => ({ kind: "key", key: KEY }) } as any });
    const info = reg.list().find((p) => p.id === "groq")!; expect(info.dataUseNotice).toMatch(/not stated/i); expect(info.status).toBe("enabled");
    const dec = decorateModels((await reg.models()).filter((m) => m.provider === "groq"), seedCatalog(), new Map());
    expect(dec.map((m) => m.id)).toEqual(["groq:openai/gpt-oss-20b", "groq:openai/gpt-oss-120b", "groq:qwen/qwen3.8-27b"]);
    for (const m of dec) { expect(m).toMatchObject({ shortContext: true, limited: false, limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 } }); expect(m.priceEstimate).toMatchObject({ estimate: true }); expect(m.priceEstimate!.source).toMatch(/^seed:/); }
    expect(dec[2]!.flags.vision).toBe(true); expect(dec[0]!.flags.vision).toBe(false); expect(defaultModelId(dec)).toBe("groq:openai/gpt-oss-120b"); // Groq-only list: OPEN_DEFAULT_ORDER puts 120b before 20b
  });
  test("without a key Groq is needs-key and lists nothing; Business never lists it", async () => {
    const open = buildRegistry({ scope: "main~open" as any, gateway: gw, env: {}, catalog: seedCatalog() });
    expect(open.list().find((p) => p.id === "groq")!.status).toBe("needs-key"); expect((await open.models()).filter((m) => m.provider === "groq")).toEqual([]);
    expect(buildRegistry({ scope: "main" as any, gateway: gw, env: {}, catalog: seedCatalog() }).list().some((p) => p.id === "groq")).toBe(false);
  });
  test("a Groq call goes through the latency sink (provider, model, open space; never content)", async () => {
    const out: LatencySample[] = [];
    const f = async () => sse([{ choices: [{ delta: { content: "hello secret text" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }]);
    const reg = buildRegistry({ scope: "main~open" as any, gateway: gw, env: {}, catalog: seedCatalog(), fetchImpl: f as never, latency: { record: (s) => void out.push(s) },
      userKeys: { ids: new Map([["groq", "https://api.groq.com"]]), get: async () => ({ kind: "key", key: KEY }) } as any });
    await text(await reg.router.messages({ model: "groq:openai/gpt-oss-20b", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }));
    expect(out.length).toBe(1); expect(out[0]).toMatchObject({ providerId: "groq", modelId: "openai/gpt-oss-20b", kind: "chat", space: "open", outcome: "ok" }); expect(JSON.stringify(out[0])).not.toContain("secret text");
  });
});
