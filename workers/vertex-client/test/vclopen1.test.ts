// vclopen1: what the REAL Agent SDK sends (test/fixtures/vclopen1-sdk-requests.json, captured by scripts/vclopen1/capture.mjs from claude-agent-sdk 0.3.296 against a local mock)
// pushed through the REAL openai-compat adapter with a fake fetch. Fake providers only: no key, no network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openaiCompatProvider, toChatRequest } from "../src/providers/openai-compat";
import { OPEN_FALLBACK_PRICE, isOpenModelId, openPriceOf, openReserveUsd, openUsage } from "../src/bridge-llm-open";
import { SseUsage, checkLlmBody, isProblem, reserveUsd } from "../src/bridge-llm-core";
import { costOf } from "../src/pricing";

const fx = JSON.parse(readFileSync(new URL("./fixtures/vclopen1-sdk-requests.json", import.meta.url), "utf8")) as { requests: Array<{ body: any; anthropic_beta: string }> };
const [first, second] = fx.requests.map((r) => r.body);
const cfg = (models: any[] = [{ id: "meta/llama-3.3-70b-instruct", displayName: "Llama", capabilities: { text: true, tools: true } }]): any => ({ id: "nvidia", kind: "openai-compat", enabled: true, baseUrl: "https://integrate.api.nvidia.com/v1", keyBinding: "K", models });
const sse = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
const chatReply = (extra: any = {}, usage: any = { prompt_tokens: 100, completion_tokens: 5 }) => () => new Response(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage, ...extra }) + "data: [DONE]\n\n");
async function through(body: any, reply = chatReply(), c = cfg()) {
  const sent: any[] = [];
  const p = openaiCompatProvider(c, { K: "fake-key" }, async (_u, init) => { sent.push(JSON.parse(String(init?.body))); return reply(); });
  const res = await p.messages({ ...body, model: "meta/llama-3.3-70b-instruct" });
  const events = (await res.text()).split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data:"))!.slice(5)));
  return { sent: sent[0], events };
}

describe("what the SDK sends (captured)", () => {
  test("shape facts the adapter has to cope with", () => {
    expect(first.stream).toBe(true); expect(first.max_tokens).toBe(128000);
    expect(first.thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(first.context_management).toBeDefined(); expect(first.output_config).toEqual({ effort: "medium" });
    expect(Array.isArray(first.system) && first.system.some((s: any) => s.cache_control)).toBe(true);
    expect(first.tools.map((t: any) => t.name).sort()).toEqual(["Edit", "Glob", "Grep", "Read", "Write"]);
    expect(second.messages.map((m: any) => m.role)).toEqual(["user", "system", "assistant", "user", "system"]); // mid-conversation `system` ROLE messages (beta mid-conversation-system)
    expect(fx.requests[0]!.anthropic_beta).toContain("mid-conversation-system");
  });
});

describe("registry/adapter path on the captured requests", () => {
  test("first request: system array joined, thinking/context_management/output_config/metadata/cache_control dropped, tools translated", async () => {
    const { sent } = await through(first);
    expect(sent.messages[0].role).toBe("system"); expect(typeof sent.messages[0].content).toBe("string");
    for (const k of ["thinking", "context_management", "output_config", "metadata", "betas"]) expect(sent[k]).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("cache_control");
    expect(sent.tools.map((t: any) => t.function.name).sort()).toEqual(["Edit", "Glob", "Grep", "Read", "Write"]);
    expect(sent.stream).toBe(true); expect(sent.max_tokens).toBe(32768); // vclopen2: unknown model => default cap
  });
  test("`$schema` is stripped from tool parameters (vclopen2)", async () => {
    const { sent } = await through(first);
    expect(JSON.stringify(sent.tools[0].function.parameters)).not.toContain("$schema");
  });
  test("second request: tool_result becomes a `tool` message; mid-conversation system-role messages are NOT system messages upstream (GAP: they become user turns)", async () => {
    const { sent } = await through(second);
    const roles = sent.messages.map((m: any) => m.role);
    expect(roles).toContain("tool");
    expect(sent.messages.filter((m: any) => m.role === "system")).toHaveLength(1); // only the top-level system prompt
    // the two mid-conversation `system` messages arrive as user messages
    expect(roles.filter((r: string) => r === "user").length).toBeGreaterThanOrEqual(2);
    const tool = sent.messages.find((m: any) => m.role === "tool"); expect(tool.tool_call_id).toBe("toolu_01");
  });
  test("a tool call in the reply streams back as Anthropic tool_use with input_json_delta", async () => {
    const reply = () => new Response(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":" } }] } }] }) + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"/x\"}" } }] } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 9 } }) + "data: [DONE]\n\n");
    const { events } = await through(first, reply);
    expect(events.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use")?.content_block).toMatchObject({ id: "call_1", name: "Read" });
    expect(events.filter((e) => e.type === "content_block_delta").map((e) => e.delta.partial_json).join("")).toBe('{"file_path":"/x"}');
    expect(events.find((e) => e.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 50, output_tokens: 9 } });
  });
  test("stream always comes back as SSE even if the client asked stream:false (GAP: the bridge refuses non-stream Open requests)", async () => {
    const { events } = await through({ ...first, stream: false });
    expect(events[0].type).toBe("message_start");
  });
  test("toChatRequest drops an unknown role's cache_control and keeps only text/tool_result/image", () => {
    const r: any = toChatRequest({ messages: [{ role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }, { type: "document", source: {} }] }] }, "m");
    expect(JSON.stringify(r)).not.toContain("document");
  });
});

describe("bridge helpers: ids, body check, money (fail closed)", () => {
  test("isOpenModelId: provider-prefixed only, never claude ids, never the gateway prefix", () => {
    for (const ok of ["nvidia:meta/llama-3.3-70b-instruct", "groq:llama-3.3-70b-versatile", "aistudio:gemini-3-flash"]) expect(isOpenModelId(ok)).toBe(true);
    for (const bad of ["claude-sonnet-5-5", "gateway:claude-sonnet-5-5", "nvidia:", ":x", "NVIDIA:x", "a b:c", 5, "nvidia:x y"]) expect(isOpenModelId(bad)).toBe(false);
  });
  test("checkLlmBody: Open ids only with allowOpen (default off = the Claude-only proxy, byte for byte)", () => {
    const b = JSON.stringify({ model: "nvidia:meta/llama-3.3-70b-instruct", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(checkLlmBody(b)).toMatchObject({ status: 400 });
    expect(isProblem(checkLlmBody(b, true))).toBe(false);
    expect(checkLlmBody(JSON.stringify({ model: "gpt-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }), true)).toMatchObject({ status: 400 });
  });
  test("unpriced model: reserve and cost use the fallback (cap cannot be bypassed); a priced model uses its own price", () => {
    expect(openPriceOf(null)).toBe(OPEN_FALLBACK_PRICE);
    expect(reserveUsd("nvidia:x", 3000, 1000)).toBeNull(); // the Claude path would reserve nothing for this id
    const r = openReserveUsd(null, 3000, 1000); expect(r).toBeCloseTo((1000 * 4 + 1000 * 20) / 1e6, 9); expect(r).toBeGreaterThan(0);
    const cheap: any = { price: { input: 0.1, output: 0.2, cacheRead: 0.1, cacheWrite: 0.1 } };
    expect(openReserveUsd(cheap, 3000, 1000)).toBeLessThan(r);
    expect(costOf({ input_tokens: 1000, output_tokens: 100 }, openPriceOf(null))).toBeCloseTo((1000 * 4 + 100 * 20) / 1e6, 9);
  });
  test("provider that reports no usage: input estimated from the request size, output from the generated characters (never $0)", () => {
    const s = new SseUsage(); s.feed(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "x".repeat(300) } })}\n`);
    s.feed(`data: ${JSON.stringify({ type: "message_delta", usage: { input_tokens: 0, output_tokens: 0 } })}\n`);
    const u = openUsage(s, 9000); expect(u.input_tokens).toBe(3000); expect(u.output_tokens).toBe(100);
    expect(costOf(u, openPriceOf(null))!).toBeGreaterThan(0);
    const t = new SseUsage(); t.feed(`data: ${JSON.stringify({ type: "message_delta", usage: { input_tokens: 700, output_tokens: 40, cache_read_input_tokens: 0 } })}\n`);
    expect(openUsage(t, 9000)).toMatchObject({ input_tokens: 700, output_tokens: 40 }); // a reported usage wins
  });
});
