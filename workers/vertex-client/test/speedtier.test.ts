// Speed tier follow-ups: every Open provider call is sampled (AI Studio incl.), first-token time counts from the SUCCESSFUL attempt, retries are exposed, wait notes.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, type ServerEvent } from "../src/turn-engine";
import { buildRegistry } from "../src/providers/registry";
import { seedCatalog } from "../src/providers/catalog";
import { type LatencySample } from "../src/latency";
import { providerName, retryNote, turnRetryNote, waitNote } from "../web/src/model-speed";
import type { ModelProvider } from "../src/providers/types";

const enc = new TextEncoder();
const ev = (o: ServerEvent) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;

describe("AI Studio / Groq calls are sampled through the router (provider id + bare model, no content)", () => {
  const userKeys = { ids: new Map([["aistudio", "https://x"], ["groq", "https://x"]]), get: async () => ({ kind: "key", key: "AIzaFAKEKEY0123456789abcdefgh" }) } as any;
  const mkReg = (f: typeof fetch, out: LatencySample[]) => buildRegistry({ scope: "main~open" as any, gateway: null, env: {}, catalog: seedCatalog(), fetchImpl: f, userKeys, latency: { record: (s) => void out.push(s) } });
  test("aistudio (native Gemini SSE) records one ok chat sample with ttfa/tokens", async () => {
    const out: LatencySample[] = [];
    const g = { candidates: [{ content: { role: "model", parts: [{ text: "secret answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 } };
    const reg = mkReg((async () => new Response(`data: ${JSON.stringify(g)}\r\n\r\n`, { status: 200, headers: { "content-type": "text/event-stream" } })) as any, out);
    await (await reg.router.messages({ model: "aistudio:gemini-3.5-flash-lite", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] })).text();
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ providerId: "aistudio", modelId: "gemini-3.5-flash-lite", kind: "chat", space: "open", outcome: "ok", outputTokens: 6 });
    expect(out[0]!.ttfaMs).not.toBeNull(); expect(out[0]!.ttfbMs).not.toBeNull();
    expect(JSON.stringify(out[0])).not.toContain("secret answer");
  });
  test("a failing aistudio call (503) records an error sample and still throws to the caller", async () => {
    const out: LatencySample[] = [];
    const reg = mkReg((async () => new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 })) as any, out);
    await expect(reg.router.messages({ model: "aistudio:gemini-3.5-flash-lite", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] })).rejects.toBeTruthy();
    expect(out.length).toBe(1); expect(out[0]).toMatchObject({ providerId: "aistudio", outcome: "error" });
  });
});

describe("turn engine: first token counts from the successful attempt", () => {
  function rig(handler: (n: number, clock: { t: number }) => Response) {
    const db = new Database(":memory:"); const clock = { t: 1_000_000 }; let n = 0;
    const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => (b.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }) : handler(++n, clock)) };
    const events: ServerEvent[] = [];
    const engine = new ChatEngine({
      sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
      provider, index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} }, sink: { broadcast: (_s, _t, e) => events.push(e) },
      now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, retryDelayMs: 1500, openSpace: () => true });
    engine.setConvId("c"); engine.setMeta("model", "aistudio:gemini-3.5-flash-lite");
    return { engine, events, clock };
  }
  const okStream = (clock: { t: number }, waitMs: number) => new Response(new ReadableStream({ start(c) {
    clock.t += waitMs;
    for (const e of [{ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" }] as ServerEvent[]) c.enqueue(enc.encode(ev(e)));
    c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const saved = (events: ServerEvent[]) => (events.filter((e) => e.type === "assistant_saved").at(-1) as any).message;

  test("503 after 12 s, 1.5 s sleep, then a 0.7 s attempt: ttft = 700 ms (not ~14 s), retries = 1, total keeps the wall time", async () => {
    const r = rig((n, clock) => { if (n === 1) { clock.t += 12_000; return new Response(JSON.stringify({ error: { type: "api_error", message: "busy" } }), { status: 503 }); } return okStream(clock, 700); });
    await r.engine.send("question");
    const m = saved(r.events);
    expect(m.ttftMs).toBe(700); expect(m.retries).toBe(1); expect(m.totalMs).toBe(12_000 + 1500 + 700);
    expect(r.events.filter((e) => e.type === "attempt").map((e: any) => e.n)).toEqual([1, 2]);
  });
  test("no retry: retries = 0 and ttft is the plain wait", async () => {
    const r = rig((_n, clock) => okStream(clock, 900));
    await r.engine.send("question");
    const m = saved(r.events); expect(m.ttftMs).toBe(900); expect(m.retries).toBe(0);
  });
});

describe("wait / retry notes", () => {
  test("provider names by model prefix; unknown prefix = generic", () => {
    expect(providerName("aistudio:gemini-3.5-flash-lite")).toBe("Google"); expect(providerName("claude-sonnet-5-5")).toBeNull();
  });
  test("live: retry in progress shows 'Google busy, retrying (attempt 2)'; a slow first attempt shows 'still waiting' only after 10 s; fast = nothing", () => {
    expect(waitNote(2, 1000, "aistudio:m")).toBe("Google busy, retrying (attempt 2)");
    expect(waitNote(1, 9_999, "aistudio:m")).toBeNull(); expect(waitNote(1, 10_000, "aistudio:m")).toBe("still waiting for the provider");
    expect(waitNote(1, 2000, "aistudio:m")).toBeNull(); expect(waitNote(0, 0, null)).toBeNull();
  });
  test("details chip: only when retried", () => {
    expect(retryNote(1, "aistudio:m")).toBe("Google busy, retried 1x"); expect(retryNote(0, "aistudio:m")).toBeNull(); expect(retryNote(null, null)).toBeNull(); expect(retryNote(2, "x")).toBe("Provider busy, retried 2x");
    expect(turnRetryNote([{ retries: 0, model: "a" }, { retries: 1, model: "aistudio:m" }, { retries: 2, model: "aistudio:m" }])).toBe("Google busy, retried 3x"); // multi-step turn: summed, not just the first retried step
    expect(turnRetryNote([{ retries: null }, { retries: 0 }])).toBeNull();
  });
});
