// Time-to-first-byte timeout for a turn WITHOUT failover (Business, Open with the toggle off): a stalled stream is aborted, retried as a retryable failure, and a clear error ends
// the turn when the retries run out. Fake providers, short real timers (the deadline is injected via the engine's firstByteMs option).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, type IndexSink, type ServerEvent } from "../src/turn-engine";
import type { ModelProvider } from "../src/providers/types";
import type { FailoverHook } from "../src/failover";
import { Breaker } from "../src/failover";
import { TTFB_MS, TTFB_REASONING_MS } from "../src/failover";

const M = "claude-sonnet-5-5";
const FA = "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b", FB = "nvidia:nvidia/nemotron-3-ultra-550b-a55b";
const start: ServerEvent = { type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } };
const enc = new TextEncoder();
const frame = (e: ServerEvent) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
const sse = (evs: ServerEvent[]) => { let i = 0; return new Response(new ReadableStream({ pull(c) { if (i < evs.length) c.enqueue(frame(evs[i++])); else c.close(); } }), { status: 200 }); };
const textEvs = (t: string): ServerEvent[] => [start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }, { type: "message_stop" }];
const ok = () => sse(textEvs("hello"));
const toolFirst = () => sse([start, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "echo", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }, { type: "message_stop" }]);
/** 200 whose body sends nothing until the request is aborted (then errors, like a real fetch body). */
const stalled = (sigOf: () => AbortSignal) => new Response(new ReadableStream({ start(c) { sigOf().addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))); } }), { status: 200 });
/** reasoning model: first frame (thinking) at `firstMs`, the answer only at `answerMs` — both later than a short deadline would allow for the ANSWER, never for the first frame */
const slowReasoner = (firstMs: number, answerMs: number) => new Response(new ReadableStream({
  async start(c) { await Bun.sleep(firstMs); c.enqueue(frame(start)); c.enqueue(frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })); c.enqueue(frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })); await Bun.sleep(answerMs); for (const e of textEvs("late").slice(0)) if (e.type !== "message_start") c.enqueue(frame(e)); c.close(); },
}), { status: 200 });

function rig(handler: (n: number, body: any, sig: () => AbortSignal) => Response | Promise<Response>, o: { ms?: number; tools?: any; fo?: boolean } = {}) {
  const db = new Database(":memory:"), calls: any[] = [], signals: AbortSignal[] = [];
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (body: any, sig?: AbortSignal) => { if (body.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }); signals.push(sig!); calls.push(body); const k = signals.length - 1; return handler(calls.length, body, () => signals[k]); } };
  const idx = { usage: [] as any[] };
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async (u) => { idx.usage.push(u); } };
  const events: ServerEvent[] = [];
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: 1, sleep: async () => {}, firstByteMs: () => o.ms ?? 40,
    ...(o.tools ? { tools: o.tools } : {}),
    ...(o.fo ? { openSpace: () => true, failover: { enabled: () => true, candidates: async () => [FA, FB].map((id) => ({ id, tools: true, vision: true, maxPrompt: null })), breaker: () => new Breaker(), firstByteMs: () => o.ms ?? 40 } as FailoverHook } : {}),
  });
  engine.setConvId("c1");
  return { engine, calls, signals, events, idx, ends: () => events.filter((e) => e.type === "turn_end") as any[], attempts: () => events.filter((e) => e.type === "attempt").map((e) => e.n) };
}

/** every setTimeout armed while `fn` runs is either fired or cleared by the time it returns (no leaked timers in a Durable Object) */
async function noLeakedTimers(fn: () => Promise<void>) {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout, live = new Set<unknown>();
  (globalThis as any).setTimeout = (cb: any, ms?: number, ...a: any[]) => { const t: any = set((...x: any[]) => { live.delete(t); cb(...x); }, ms, ...a); live.add(t); return t; };
  (globalThis as any).clearTimeout = (t: any) => { live.delete(t); clear(t); };
  try { await fn(); await Bun.sleep(5); } finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear; }
  return live.size;
}

describe("first-byte timeout without failover", () => {
  test("defaults: 60 s, larger allowance for reasoning models", () => { expect(TTFB_MS).toBe(60_000); expect(TTFB_REASONING_MS).toBeGreaterThan(TTFB_MS); });

  test("a stream with no frames is aborted at the deadline and retried once (retryable), the retry answers", async () => {
    const r = rig((n, _b, sig) => (n === 1 ? stalled(sig) : ok()));
    const t0 = Date.now(); await r.engine.send("hi", M);
    expect(r.calls.length).toBe(2); expect(r.signals[0].aborted).toBe(true); expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.attempts()).toEqual([1, 2]); // the existing live "retrying" note keeps counting
    const te = r.ends().at(-1)!; expect(te.status ?? te.stop ?? "complete").not.toBe("error");
    expect(r.engine.messages().filter((m: any) => m.role === "assistant").at(-1)?.retries).toBe(1);
  });

  test("a header-phase stall (the request never answers) is the same failure", async () => {
    let n = 0; const r = rig(() => (++n === 1 ? new Promise<Response>(() => {}) : ok()));
    await r.engine.send("hi", M);
    expect(r.calls.length).toBe(2); expect(r.signals[0].aborted).toBe(true);
  });

  test("retries exhausted: a clear error, never a silent hang", async () => {
    const r = rig((_n, _b, sig) => stalled(sig), { ms: 1000 });
    await r.engine.send("hi", M);
    expect(r.calls.length).toBe(2);
    const te = r.ends().at(-1)!; expect(te.status).toBe("error");
    expect(te.error.message).toBe("model did not respond in 1 s");
    expect(r.signals.every((s) => s.aborted)).toBe(true);
  }, 10_000);

  test("slow but streaming (reasoning deltas are the first byte): NOT aborted after the first frame", async () => {
    const r = rig(() => slowReasoner(5, 120), { ms: 40 }); // answer arrives 3x after the deadline, but the thinking frame was early
    await r.engine.send("hi", M);
    expect(r.calls.length).toBe(1); expect(r.signals[0].aborted).toBe(false);
    expect(r.engine.messages().filter((m: any) => m.role === "assistant").at(-1)?.status).toBe("complete");
  });

  test("a user Stop before the deadline wins: no retry, no error", async () => {
    const r = rig((_n, _b, sig) => stalled(sig), { ms: 500 });
    const p = r.engine.send("hi", M); await Bun.sleep(20); await r.engine.stop(); await p;
    expect(r.calls.length).toBe(1); expect(r.signals[0].aborted).toBe(true);
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    await Bun.sleep(600); expect(r.calls.length).toBe(1); // the deadline never fires a late retry
  });

  test("timers are cleared on every exit path: success, stall+retry, stop", async () => {
    expect(await noLeakedTimers(async () => { const r = rig(() => ok(), { ms: 5000 }); await r.engine.send("hi", M); })).toBe(0);
    expect(await noLeakedTimers(async () => { const r = rig((n, _b, s) => (n === 1 ? stalled(s) : ok()), { ms: 30 }); await r.engine.send("hi", M); })).toBe(0);
    expect(await noLeakedTimers(async () => { const r = rig((_n, _b, s) => stalled(s), { ms: 5000 }); const p = r.engine.send("hi", M); await Bun.sleep(10); await r.engine.stop(); await p; })).toBe(0);
  });

  test("a stall AFTER a tool ran: the retry is synthesis-only (tool_choice none), the tool runs once", async () => {
    const callsOf: string[] = [];
    const tools = { list: async () => [{ name: "echo", description: "d", inputSchema: { type: "object", properties: {} } }], call: async (n: string) => { callsOf.push(n); return { text: "pong", isError: false }; } };
    const r = rig((n, b, sig) => (n === 1 ? toolFirst() : n === 2 ? stalled(sig) : b?.tool_choice?.type === "none" || !b?.tools?.length ? ok() : toolFirst()), { tools });
    await r.engine.send("hi", M); r.engine.decide("t1", "approve"); await r.engine.resume();
    expect(r.calls.length).toBe(3); expect(r.calls[1].tools?.length).toBeGreaterThan(0); expect(r.calls[2].tool_choice).toEqual({ type: "none" }); // gateway models keep the definitions but may not call (other providers get none at all: smallfix round 3)
    expect(callsOf).toEqual(["echo"]);
  });

  const afterTool = async (second: (sig: () => AbortSignal) => Response, opts: { open?: boolean } = {}) => {
    const callsOf: string[] = [];
    const tools = { list: async () => [{ name: "echo", description: "d", inputSchema: { type: "object", properties: {} } }], call: async (n: string) => { callsOf.push(n); return { text: "pong", isError: false }; } };
    let k = 0; const r = rig((n, b, sig) => (n === 1 ? toolFirst() : n === 2 && k++ === 0 ? second(sig) : b?.tool_choice?.type === "none" || !b?.tools?.length ? ok() : toolFirst()), { tools });
    await r.engine.send("hi", M); r.engine.decide("t1", "approve"); await r.engine.resume();
    return { r, callsOf };
  };
  const eof = () => new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
  test("zero-frame EOF after a tool ran: synthesis-only retry, tool runs once, nothing duplicated", async () => {
    const { r, callsOf } = await afterTool(eof);
    expect(r.calls.length).toBe(3); expect(r.calls[2].tool_choice).toEqual({ type: "none" }); expect(callsOf).toEqual(["echo"]);
    expect(r.engine.messages().filter((m: any) => m.role === "assistant").at(-1)?.status).toBe("complete");
  });
  test("ping-only then EOF after a tool ran: same", async () => {
    const { r, callsOf } = await afterTool(() => new Response(new ReadableStream({ start(c) { c.enqueue(frame({ type: "ping" })); c.close(); } }), { status: 200 }));
    expect(r.calls[2]?.tool_choice).toEqual({ type: "none" }); expect(callsOf).toEqual(["echo"]);
  });
  test("read error before any frame after a tool ran: same", async () => {
    const { r, callsOf } = await afterTool(() => new Response(new ReadableStream({ start(c) { c.error(new Error("reset")); } }), { status: 200 }));
    expect(r.calls[2]?.tool_choice).toEqual({ type: "none" }); expect(callsOf).toEqual(["echo"]);
  });
  test("zero-frame EOF with no tool run yet: plain bounded retry (tools still offered, 2 attempts)", async () => {
    let n = 0; const r = rig(() => (++n === 1 ? eof() : ok()));
    await r.engine.send("hi", M);
    expect(r.calls.length).toBe(2); expect(r.calls[1].tool_choice).toBeUndefined();
    let m = 0; const r2 = rig(() => { m++; return eof(); });
    await r2.engine.send("hi", M); expect(m).toBe(2); expect(r2.ends().at(-1)!.status).toBe("error");
  });

  /** 503 whose body never finishes (until aborted) */
  const stalledBody503 = (sig: () => AbortSignal) => new Response(new ReadableStream({ start(c) { sig().addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))); } }), { status: 503, headers: { "content-type": "application/json" } });
  test("503 whose JSON body stalls (Business): timeout at the deadline, retry answers, within budget", async () => {
    const r = rig((n, _b, sig) => (n === 1 ? stalledBody503(sig) : ok()), { ms: 40 });
    const t0 = Date.now(); await r.engine.send("hi", M);
    expect(Date.now() - t0).toBeLessThan(2000); expect(r.calls.length).toBe(2); expect(r.signals[0].aborted).toBe(true);
    expect(r.engine.messages().filter((m: any) => m.role === "assistant").at(-1)?.status).toBe("complete");
  });
  test("503 body stalls on every attempt (Business): ends in the clear timeout error, never hangs", async () => {
    const r = rig((_n, _b, sig) => stalledBody503(sig), { ms: 40 });
    await r.engine.send("hi", M);
    expect(r.calls.length).toBe(2); expect(r.ends().at(-1)!.status).toBe("error"); expect(r.ends().at(-1)!.error.message).toMatch(/^model did not respond in/);
  });
  test("503 whose body stalls with Open failover ON: failover switches to the next model", async () => {
    const r = rig((n, _b, sig) => (n === 1 ? stalledBody503(sig) : ok()), { ms: 40, fo: true });
    await r.engine.send("hi", FA);
    expect(r.calls.length).toBe(2); expect(r.calls[1].model).toBe(FB); expect(r.events.some((e) => e.type === "failover")).toBe(true);
  });
  test("Stop wins during a stalled error body: no retry, no error, timers cleaned", async () => {
    expect(await noLeakedTimers(async () => {
      const r = rig((_n, _b, sig) => stalledBody503(sig), { ms: 5000 });
      const p = r.engine.send("hi", M); await Bun.sleep(20); await r.engine.stop(); await p;
      expect(r.calls.length).toBe(1); expect(r.events.some((e) => e.type === "error")).toBe(false);
    })).toBe(0);
  });
  test("timers cleaned after a stalled error body timeout", async () => {
    expect(await noLeakedTimers(async () => { const r = rig((n, _b, s) => (n === 1 ? stalledBody503(s) : ok()), { ms: 30 }); await r.engine.send("hi", M); })).toBe(0);
  });
});
