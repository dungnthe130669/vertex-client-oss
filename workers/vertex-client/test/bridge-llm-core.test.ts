import { describe, expect, it } from "bun:test";
import { LLM_MAX_BODY, LLM_MAX_TOKENS, SseUsage, effectiveUsage, reserveUsd, checkLlmBody, dailyCapUsd, isProblem, mapUpstream, upstreamHeaders, usageOfJson } from "../src/bridge-llm-core";

const ok = (o: object = {}) => JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...o });
describe("checkLlmBody", () => {
  it("accepts an allowed model and passes unknown fields through; stream is never forced", () => {
    const r = checkLlmBody(ok({ thinking: { type: "adaptive" }, tools: [] }));
    expect(isProblem(r)).toBe(false);
    if (!isProblem(r)) { expect(r.stream).toBe(false); expect(r.body.thinking).toEqual({ type: "adaptive" }); expect(r.body.stream).toBeUndefined(); }
    const s = checkLlmBody(ok({ stream: true })); expect(!isProblem(s) && s.stream).toBe(true);
  });
  it("rejects other models, bad max_tokens, bad shapes", () => {
    for (const m of ["claude-opus-4-1", "gpt-6", "claude-sonnet-5-5-20260101", "", 5]) expect(checkLlmBody(ok({ model: m }))).toMatchObject({ status: 400 });
    expect(checkLlmBody(ok({ max_tokens: LLM_MAX_TOKENS + 1 }))).toMatchObject({ status: 400 });
    expect(checkLlmBody(ok({ max_tokens: 0 }))).toMatchObject({ status: 400 });
    expect(checkLlmBody(ok({ max_tokens: 1.5 }))).toMatchObject({ status: 400 });
    expect(checkLlmBody(ok({ messages: [] }))).toMatchObject({ status: 400 });
    expect(checkLlmBody(ok({ stream: "yes" }))).toMatchObject({ status: 400 });
    expect(checkLlmBody("[]")).toMatchObject({ status: 400 });
    expect(checkLlmBody("{nope")).toMatchObject({ status: 400 });
    expect(checkLlmBody("x".repeat(LLM_MAX_BODY + 1))).toMatchObject({ status: 413 });
  });
});
describe("upstreamHeaders", () => {
  it("forwards only version + sane beta tokens; never the token, cookies or arbitrary headers", () => {
    const h = upstreamHeaders(new Headers({ authorization: "Bearer vcl_x", cookie: "a=b", "x-api-key": "k", "anthropic-version": "2023-06-01", "anthropic-beta": "interleaved-thinking-2025-05-14, BAD TOKEN!, prompt-caching-2024-07-31", "x-forwarded-for": "1.2.3.4" }));
    expect(h).toEqual({ "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "interleaved-thinking-2025-05-14,prompt-caching-2024-07-31" });
    expect(upstreamHeaders(new Headers({ "anthropic-version": "evil value" }))["anthropic-version"]).toBe("2023-06-01");
  });
});
describe("usage + errors", () => {
  it("SseUsage merges message_start and message_delta across arbitrary chunk splits", () => {
    const u = new SseUsage();
    const s = `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":2,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n`;
    for (let i = 0; i < s.length; i += 7) u.feed(s.slice(i, i + 7));
    expect(u.usage).toEqual({ input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 42 });
  });
  it("usageOfJson reads a non-streaming body, tolerates junk", () => {
    expect(usageOfJson({ usage: { input_tokens: 3, output_tokens: 4 } })).toEqual({ input_tokens: 3, output_tokens: 4 });
    expect(usageOfJson(null)).toEqual({});
  });
  it("mapUpstream keeps the class and never carries text from upstream", () => {
    expect(mapUpstream(500).status).toBe(502); expect(mapUpstream(503).status).toBe(502); expect(mapUpstream(401).status).toBe(502); expect(mapUpstream(429).status).toBe(429); expect(mapUpstream(400).status).toBe(400); expect(mapUpstream(413).status).toBe(413);
  });
  it("dailyCapUsd: default 5, garbage => default, negative => 0", () => {
    expect(dailyCapUsd(null)).toBe(5); expect(dailyCapUsd("abc")).toBe(5); expect(dailyCapUsd("2.5")).toBe(2.5); expect(dailyCapUsd("-1")).toBe(0); expect(dailyCapUsd("0")).toBe(0);
  });
});

describe("interrupted streams are billed conservatively", () => {
  const start = `data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n`;
  const delta = (k: string, v: string) => `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: k + "_delta", [k]: v } })}\n\n`;
  it("no final usage: output = max(provisional, ceil(chars/3)) over text, thinking and tool-input deltas; input stays from message_start", () => {
    const u = new SseUsage(); u.feed(start); u.feed(delta("text", "a".repeat(300))); u.feed(delta("thinking", "b".repeat(299))); u.feed(delta("partial_json", "{}"));
    expect(u.final).toBe(false); expect(u.chars).toBe(601);
    expect(effectiveUsage(u)).toEqual({ input_tokens: 100, output_tokens: Math.ceil(601 / 3) });
    expect(u.usage.output_tokens).toBe(1); // the raw provisional value is still 1: this is what used to be billed
  });
  it("no content seen: provisional value kept; final usage present: exact, estimate ignored", () => {
    const a = new SseUsage(); a.feed(start); expect(effectiveUsage(a).output_tokens).toBe(1);
    const b = new SseUsage(); b.feed(start); b.feed(delta("text", "x".repeat(30000))); b.feed(`data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n`);
    expect(b.final).toBe(true); expect(effectiveUsage(b).output_tokens).toBe(7);
  });
  it("reserveUsd: worst case = input estimate at the dearest input rate + max_tokens at the output rate; unpriced model => null", () => {
    expect(reserveUsd("claude-opus-5-5", 3000, 1000)).toBeCloseTo((1000 * 8 + 1000 * 20) / 1e6, 8);
    expect(reserveUsd("claude-sonnet-5-5", 0, 64000)).toBeCloseTo(0.64, 6);
    expect(reserveUsd("nope", 1, 1)).toBeNull();
  });
});
