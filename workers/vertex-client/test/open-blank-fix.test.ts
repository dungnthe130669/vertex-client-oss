// Review fixes for the open-blank change: unsigned reasoning blocks never leave the app, per-model output caps, per-turn usage, svg-safe on hostile input.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, buildRequest, toApiContent, type IndexSink } from "../src/turn-engine";
import { toAnthropicStream, toChatRequest, capFromError, openaiCompatProvider } from "../src/providers/openai-compat";
import { nvidiaDefaultModels, NVIDIA_MAX_OUTPUT, parseConfig } from "../src/providers/config";
import { registerModelMeta, MODELS_META, metaFromProviderModel, DEFAULT_PROVIDER_MAX_TOKENS } from "../src/models-meta";
import { transcriptParts } from "../src/transcript";
import { exportMarkdown } from "../web/src/library-logic";
import { asCodeBlock } from "../web/src/svg-safe";
import type { ModelProvider } from "../src/providers/types";

const SECRET = "ZEBRA-REASONING-7731";
const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ delta, finish_reason: finish }] });
const sseOf = (chunks: unknown[]) => new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(`data: ${JSON.stringify(x)}\n\n`)); c.enqueue(e.encode("data: [DONE]\n\n")); c.close(); } });
/** What NVIDIA streams: reasoning_content first, then the answer, then the usage chunk. */
const nimReply = (answer: string, usage: { prompt_tokens: number; completion_tokens: number }, finish = "stop") => new Response(toAnthropicStream(sseOf([chunk({ reasoning_content: SECRET }), chunk({ content: answer }), chunk({}, finish), { choices: [], usage }]), "m"), { status: 200, headers: { "content-type": "text/event-stream" } });

function rig(handler: (body: any, n: number) => Response) {
  const db = new Database(":memory:");
  const calls: any[] = [];
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (body: any) => { calls.push(body); if (body.stream === false) return Response.json({ content: [{ type: "text", text: "A Title" }], usage: { input_tokens: 5, output_tokens: 3 } }); return handler(body, calls.filter((b) => b.stream).length); } };
  const idx = { msgs: [] as any[], exch: [] as any[], usage: [] as any[] };
  const index: IndexSink = { indexMessage: async (m) => { idx.msgs.push(m); }, updateConversation: async () => {}, recordUsage: async (u) => { idx.usage.push(u); }, indexExchange: async (x: any) => { idx.exch.push(x); } } as IndexSink;
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: () => {} }, retryDelayMs: 1,
  });
  engine.setConvId("conv-1");
  return { engine, calls, idx };
}
const isTitle = (u: any) => u.usage.input_tokens === 5 && u.usage.output_tokens === 3; // the rig's stream:false title reply
const wait = () => new Promise((r) => setTimeout(r, 20));

describe("reasoning_content stays local: stored as unsigned thinking, never replayed or indexed", () => {
  test("toApiContent drops an unsigned thinking block, keeps the answer", () => {
    const out = toApiContent([{ type: "thinking", thinking: SECRET }, { type: "text", text: "hi" }]);
    expect(out).toEqual([{ type: "text", text: "hi" }]);
  });
  test("buildRequest for every model family (gateway claude, prefixed provider) carries no thinking block or its text", () => {
    registerModelMeta("nvidia:x", metaFromProviderModel("X", { text: true, vision: false, tools: false, "image-gen": false, "video-gen": false, reasoning: true }, null, null, 16000));
    const history = [{ role: "user", content: [{ type: "text", text: "q" }] }, { role: "assistant", content: [{ type: "thinking", thinking: SECRET }, { type: "text", text: "a" }] }, { role: "user", content: [{ type: "text", text: "q2" }] }];
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "nvidia:x", "nvidia/not-registered"]) {
      const body = buildRequest(model, history);
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(JSON.stringify(body.messages)).not.toContain('"thinking"');
    }
  });
  test("openai-compat request mapping never sends thinking", () => {
    const req = toChatRequest({ model: "m", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: SECRET }, { type: "text", text: "a" }] }, { role: "user", content: "q" }] }, "m");
    expect(JSON.stringify(req)).not.toContain(SECRET);
  });
  test("end to end: NVIDIA reply (thinking stored), then the chat switches to Claude: nothing replayed; title, index, compaction, transcript, export never see it", async () => {
    const r = rig((_b, n) => (n === 1 ? nimReply("The answer", { prompt_tokens: 20, completion_tokens: 50 }) : nimReply("Second", { prompt_tokens: 30, completion_tokens: 5 })));
    r.engine.setMeta("model", "nvidia:chosen");
    await r.engine.send("first question here");
    await wait();
    const stored = r.engine.state().messages.find((m: any) => m.role === "assistant")!;
    expect(stored.content.some((b: any) => b.type === "thinking" && b.thinking === SECRET && !b.signature)).toBe(true); // kept for display
    // switch provider mid-conversation
    r.engine.setMeta("model", "claude-sonnet-5-5");
    await r.engine.send("second question here");
    await wait();
    const streamCalls = r.calls.filter((b) => b.stream);
    expect(streamCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of streamCalls) expect(JSON.stringify(c)).not.toContain(SECRET);
    // titles (stream:false), search/FTS + semantic index, usage rows
    for (const c of r.calls.filter((b) => b.stream === false)) expect(JSON.stringify(c)).not.toContain(SECRET);
    expect(JSON.stringify(r.idx.msgs)).not.toContain(SECRET);
    expect(JSON.stringify(r.idx.exch)).not.toContain(SECRET);
    expect(JSON.stringify(r.idx.usage)).not.toContain(SECRET);
    // compaction / summary input
    const msgs = r.engine.state().messages as any[];
    r.calls.length = 0;
    await (r.engine as any).compact(1, msgs, msgs.length - 1, 1000).catch(() => {});
    expect(r.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.calls)).not.toContain(SECRET);
    // advisor transcript and Markdown export
    expect(transcriptParts(msgs as any).join("\n")).not.toContain(SECRET);
    expect(exportMarkdown("t", msgs as any)).not.toContain(SECRET);
  });
});

describe("per-model output cap", () => {
  test("all verified NIM models declare maxOutput; meta request size is min(maxTokens, maxOutput); unknown models stay at the conservative default", () => {
    for (const m of nvidiaDefaultModels()) { expect(m.maxOutput).toBe(NVIDIA_MAX_OUTPUT); expect(m.maxTokens!).toBeLessThanOrEqual(m.maxOutput!); }
    expect(metaFromProviderModel("U", { text: true, vision: false, tools: false, "image-gen": false, "video-gen": false, reasoning: false }, null).maxTokens).toBe(DEFAULT_PROVIDER_MAX_TOKENS);
    expect(DEFAULT_PROVIDER_MAX_TOKENS).toBeLessThanOrEqual(4096);
    void MODELS_META;
  });
  const cfg = (maxOutput?: number): any => ({ id: "nvidia", kind: "openai-compat", baseUrl: "https://integrate.api.nvidia.com/v1", keyBinding: "PROVIDER_KEY_NVIDIA", enabled: true, models: [{ id: "m", displayName: "M", capabilities: { text: true }, pricePerMTok: null, ...(maxOutput ? { maxOutput } : {}) }] });
  const okStream = () => new Response(sseOf([chunk({ content: "ok" }, "stop")]), { status: 200 });
  const provider = (c: any, f: (b: any) => Response, sent: any[]) => openaiCompatProvider(c, { PROVIDER_KEY_NVIDIA: "k" }, async (_u, init) => { const b = JSON.parse(String(init?.body)); sent.push(b.max_tokens); return f(b); }, async () => {});
  test("request is clamped to the model's maxOutput", async () => {
    const sent: any[] = [];
    await provider(cfg(8000), () => okStream(), sent).messages({ model: "m", max_tokens: 16000, messages: [{ role: "user", content: "hi" }] });
    expect(sent).toEqual([8000]);
    const sent2: any[] = [];
    await provider(cfg(), () => okStream(), sent2).messages({ model: "m", max_tokens: 16000, messages: [{ role: "user", content: "hi" }] });
    expect(sent2).toEqual([16000]);
  });
  test("a 400 naming a smaller max_tokens is retried ONCE with that value", async () => {
    const sent: any[] = [];
    const p = provider(cfg(), (b) => (b.max_tokens > 4096 ? Response.json({ error: { message: "max_tokens must be less than or equal to 4096" } }, { status: 400 }) : okStream()), sent);
    const res = await p.messages({ model: "m", max_tokens: 16000, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(sent).toEqual([16000, 4096]);
  });
  test("a second 400, an unparseable 400, or an unrelated 400 is surfaced; never more than one retry", async () => {
    const msgs = ["max_tokens must be <= 4096", "max_tokens is too large", "messages: invalid role"];
    for (const [i, message] of msgs.entries()) {
      const sent: any[] = [];
      const p = provider(cfg(), () => Response.json({ error: { message } }, { status: 400 }), sent);
      await expect(p.messages({ model: "m", max_tokens: 16000, messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ status: 400 });
      expect(sent.length).toBe(i === 0 ? 2 : 1);
    }
  });
  test("capFromError only accepts a smaller, plausible number", () => {
    expect(capFromError({ error: { message: "max_tokens must be <= 8192" } }, 16000)).toBe(8192);
    expect(capFromError({ error: { message: "This model supports at most 4096 completion tokens" } }, 16000)).toBe(4096);
    expect(capFromError({ error: { message: "max_tokens must be <= 32000" } }, 16000)).toBeNull();
    expect(capFromError({ error: { message: "bad role" } }, 16000)).toBeNull();
    expect(capFromError(null, 16000)).toBeNull();
  });
  test("capFromError ties the number to a max_tokens / output-token phrase", () => {
    const c = (message: string, sent = 100000) => capFromError({ error: { message } }, sent);
    expect(c("max_tokens is too large: 100000. This model supports at most 16384 completion tokens, whereas you provided 100000.")).toBe(16384);
    expect(c("'max_completion_tokens' must be less than or equal to 8192")).toBe(8192);
    expect(c("This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (6000 in the messages, 3000 in the completion).")).toBe(2192);
    // the number is not a cap
    expect(c("Invalid max_tokens; rate limit is 1000")).toBeNull();
    expect(c("max_tokens must be a positive integer; at most 3 requests per minute: 1000")).toBeNull();
    expect(c("Request limit is 5000 per day")).toBeNull();
    expect(c("maximum context length is 8192 tokens")).toBeNull();
    expect(c("max_tokens must be <= 100")).toBeNull(); // below the 256 floor
    expect(c("max_tokens must be <= 20000", 16000)).toBeNull(); // not smaller than sent
    expect(c("max_tokens must be <= -5")).toBeNull();
  });
});

describe("usage belongs to the turn that produced it (the identical 1.7k/4.1k /mcp symptom)", () => {
  test("two turns truncated at the cap give two usage rows from their own responses; identical numbers = identical truncation, not reuse", async () => {
    const same = { prompt_tokens: 1700, completion_tokens: 4096 };
    const r = rig((_b, n) => (n <= 2 ? nimReply("cut off", same, "length") : nimReply("done", { prompt_tokens: 40, completion_tokens: 7 })));
    r.engine.setMeta("model", "nvidia:chosen");
    await r.engine.send("draw it"); await wait();
    await r.engine.send("again"); await wait();
    const turnRows = () => r.idx.usage.filter((u) => u.model === "nvidia:chosen" && !isTitle(u));
    expect(turnRows().length).toBe(2); // one row per model call, not merged
    expect(turnRows().map((u) => [u.usage.input_tokens, u.usage.output_tokens])).toEqual([[1700, 4096], [1700, 4096]]);
    const a = r.engine.state().messages.filter((m: any) => m.role === "assistant");
    expect(a.map((m: any) => m.stopReason)).toEqual(["max_tokens", "max_tokens"]);
    // a later turn with different numbers must not inherit the stale 1700/4096
    await r.engine.send("third"); await wait();
    const last = turnRows().at(-1)!;
    expect([last.usage.input_tokens, last.usage.output_tokens]).toEqual([40, 7]);
    expect(turnRows().length).toBe(3);
  });
  test("a turn whose response carries no usage records none; it never borrows the previous turn's", async () => {
    const r = rig((_b, n) => (n === 1 ? nimReply("a", { prompt_tokens: 1700, completion_tokens: 4096 }, "length") : new Response(toAnthropicStream(sseOf([chunk({ content: "b" }, "stop")]), "m"), { status: 200 })));
    r.engine.setMeta("model", "nvidia:chosen");
    await r.engine.send("one"); await wait();
    await r.engine.send("two"); await wait();
    const rows = r.idx.usage.filter((u) => u.model === "nvidia:chosen" && !isTitle(u));
    expect(rows.length).toBe(2);
    expect(rows[1].usage.input_tokens ?? 0).toBe(0);
    expect(rows[1].usage.output_tokens ?? 0).toBe(0);
  });
});

describe("asCodeBlock on hostile input", () => {
  test("200k separate backtick runs do not throw (no argument spreading); fence is longer than the longest run", () => {
    const hostile = "`a".repeat(200_000) + "`````x";
    const out = asCodeBlock(hostile, "xml");
    expect(out.startsWith("``````xml\n")).toBe(true); // longest run is 5 -> fence 6
    expect(out.endsWith("``````")).toBe(true);
  });
  test("normal input unchanged: fence is 3 when there is no backtick", () => expect(asCodeBlock("x")).toBe("```\nx\n```"));
});

describe("model maxOutput config validation", () => {
  const out = (v: unknown) => parseConfig({ id: "nvidia", kind: "openai-compat", base_url: "https://integrate.api.nvidia.com/v1", enabled: 1, models_json: JSON.stringify([{ id: "m", maxOutput: v }]) })!.models[0].maxOutput;
  test("only an integer in [256, 1_000_000] is kept", () => {
    for (const bad of [-5, 0, 1.5, "100", NaN, 2e9, 255, null]) expect(out(bad)).toBeUndefined();
    expect(out(16000)).toBe(16000);
    expect(out(256)).toBe(256);
    expect(out(1_000_000)).toBe(1_000_000);
  });
});
