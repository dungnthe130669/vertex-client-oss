import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BlockAccumulator, cleanTitle, looksLikeReasoning, fallbackTitle, ChatEngine, buildRequest, toApiContent, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { ProviderError, type ModelProvider } from "../src/providers/types";

const sse = (evs: ServerEvent[], opts: { hang?: boolean } = {}) => {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(new ReadableStream({
    async pull(ctl) {
      if (i < evs.length) { ctl.enqueue(enc.encode(`event: ${evs[i].type}\ndata: ${JSON.stringify(evs[i])}\n\n`)); i++; await Bun.sleep(1); }
      else if (opts.hang) await new Promise(() => {});
      else ctl.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
};

const turnEvents = (text: string, opts: { thinking?: boolean; stop?: string; usage?: any } = {}): ServerEvent[] => {
  const ev: ServerEvent[] = [{ type: "message_start", message: { id: "m", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 } } }];
  let idx = 0;
  if (opts.thinking) ev.push(
    { type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_delta", index: idx, delta: { type: "signature_delta", signature: "SIG1" } },
    { type: "content_block_stop", index: idx++ });
  ev.push({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
  for (const w of text.split(" ")) ev.push({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: w + " " } });
  ev.push({ type: "content_block_stop", index: idx },
    { type: "message_delta", delta: { stop_reason: opts.stop ?? "end_turn" }, usage: opts.usage ?? { output_tokens: 20 } },
    { type: "message_stop" });
  return ev;
};

function rig(handler: (body: any, n: number) => Response | Promise<Response>, maxIterations?: number) {
  const db = new Database(":memory:");
  const calls: any[] = [];
  const provider: ModelProvider = {
    name: "stub", listModels: async () => [],
    messages: async (body: any) => { calls.push(body); if (body.stream === false) return Response.json({ content: [{ type: "text", text: "A Title" }], usage: { input_tokens: 100, output_tokens: 8 } }); return handler(body, calls.filter((b) => b.stream).length); },
  };
  const broadcasts: Array<{ seq: number; e: ServerEvent }> = [];
  const idx = { msgs: [] as any[], convs: [] as any[], usage: [] as any[] };
  const index: IndexSink = {
    indexMessage: async (m) => { idx.msgs.push(m); }, updateConversation: async (c) => { idx.convs.push(c); }, recordUsage: async (u) => { idx.usage.push(u); },
  };
  const mk = () => new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: (seq, _ts, e) => broadcasts.push({ seq, e }) }, retryDelayMs: 1, maxIterations,
  });
  const engine = mk(); engine.setConvId("conv-1");
  return { engine, calls, broadcasts, idx, db, mk };
}

describe("title guards", () => {
  test("rejects reasoning leaks and falls back to the user's words", () => {
    expect(looksLikeReasoning("I need to provide a conversation title of at most 6 words based on the user's message")).toBe(true);
    expect(looksLikeReasoning("Bicycle balance physics")).toBe(false);
    expect(fallbackTitle("  How do bicycles stay upright\nwhile moving fast?")).toBe("How do bicycles stay upright while");
  });
});

describe("cleanTitle", () => {
  test("strips markdown/prompt artefacts but keeps a normal title", () => {
    expect(cleanTitle("# Conversation Title: How bicycles balance")).toBe("How bicycles balance");
    expect(cleanTitle('Title: "Fix the bug".')).toBe("Fix the bug");
    expect(cleanTitle("**Bike physics**")).toBe("Bike physics");
    expect(cleanTitle("A Title")).toBe("A Title");
  });
});

describe("Open chat titles", () => {
  test("titled by the chat's own non-gateway model, never haiku/Vertex; no assistant text once web-tainted", async () => {
    const r = rig(() => sse(turnEvents("Cats purr when relaxed", {})));
    r.engine.setMeta("model", "nvidia:some-model");
    await r.engine.send("tell me about cats");
    const t = r.calls.filter((b) => b.stream === false);
    expect(t).toHaveLength(1);
    expect(t[0].model).toBe("nvidia:some-model");
    expect(t[0].messages[0].content).toContain("Cats purr");
    expect(r.calls.some((b) => b.model === "claude-haiku-5-5")).toBe(false);
    expect(r.engine.state().title).toBe("A Title");
  });
  test("auto chat titles with the RESOLVED turn model, a mid-turn setting switch never sends it to Vertex, unknown cost stays null", async () => {
    const r = rig(() => sse(turnEvents("Cats purr", {})));
    r.engine.setMeta("model", "claude-sonnet-5-5");
    await r.engine.send("tell me about cats");
    r.calls.length = 0; r.idx.usage.length = 0; r.engine.setMeta("title", null as any);
    r.engine.setMeta("model", "auto"); // conversation setting stays "auto"; the turn resolved to an nvidia model
    await (r.engine as any).finishTurn(1, "nvidia:resolved-x", true);
    const t = r.calls.filter((b) => b.stream === false);
    expect(t.map((b) => b.model)).toEqual(["nvidia:resolved-x"]);
    expect(r.calls.some((b) => b.model === "claude-haiku-5-5")).toBe(false);
    const u = r.idx.usage.find((x) => x.model === "nvidia:resolved-x");
    expect(u).toBeTruthy(); expect(u.costUsd).toBeNull(); expect(u.usage.input_tokens).toBe(100);
  });
  test("Open setting but gateway turn model (mid-turn switch), or unresolved auto: no title call at all, deterministic title", async () => {
    for (const turnModel of ["claude-sonnet-5-5", "auto"]) {
      const r = rig(() => sse(turnEvents("ok", {})));
      r.engine.setMeta("model", "nvidia:chosen");
      await r.engine.send("how do kites fly in wind");
      r.calls.length = 0; r.engine.setMeta("title", null as any);
      await (r.engine as any).finishTurn(1, turnModel, true);
      expect(r.calls.filter((b) => b.stream === false)).toHaveLength(0);
      expect(r.engine.state().title).toBe("how do kites fly in wind");
    }
  });
  test("Business unchanged: gateway chat + gateway turn model titles with haiku; priced provider model records its cost", async () => {
    const r = rig(() => sse(turnEvents("Cats purr", {})));
    await r.engine.send("tell me about cats");
    expect(r.calls.filter((b) => b.stream === false).map((b) => b.model)).toEqual(["claude-haiku-5-5"]);
    const db = new Database(":memory:"); void db;
    const p: ModelProvider = { name: "s", listModels: async () => [{ id: "priced:m", displayName: "M", pricePerMTok: { input: 1, output: 2 } }],
      messages: async (b: any) => b.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }) : sse(turnEvents("ok", {})) };
    const rows: any[] = []; const d = new Database(":memory:");
    const e = new ChatEngine({ sql: { exec: (q, ...b) => { const st = d.query(q); const rr = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rr as any[] }; } },
      provider: p, index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async (u) => { rows.push(u); } }, sink: { broadcast: () => {} }, retryDelayMs: 1 });
    e.setConvId("c"); e.setMeta("model", "priced:m");
    await e.send("hello there friend");
    expect(rows.find((x) => x.model === "priced:m" && x.usage.input_tokens === 1_000_000)?.costUsd).toBeCloseTo(3, 6);
  });
  test("title call failing (500 / throw) keeps the deterministic first-words title", async () => {
    for (const mode of ["500", "throw"]) {
      const db = new Database(":memory:");
      const provider: ModelProvider = { name: "s", listModels: async () => [], messages: async (b: any) => {
        if (b.stream === false) { if (mode === "throw") throw new Error("boom"); return new Response("{}", { status: 500 }); }
        return sse(turnEvents("ok fine", {})); } };
      const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
        provider, index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} }, sink: { broadcast: () => {} }, retryDelayMs: 1 });
      engine.setConvId("c"); engine.setMeta("model", "nvidia:m");
      await engine.send("How do magnets work in motors today please");
      expect(engine.state().title).toBe("How do magnets work in motors");
    }
  });
});

describe("engine", () => {
  test("stream relay, persistence, cost, title, index", async () => {
    const r = rig(() => sse(turnEvents("hello there world", { thinking: true, usage: { output_tokens: 20 } })));
    await r.engine.send("hi");
    const types = r.broadcasts.map((b) => b.e.type);
    expect(types[0]).toBe("user_message");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("turn_end");
    expect(r.broadcasts.map((b) => b.seq)).toEqual([...r.broadcasts.map((b) => b.seq)].sort((a, b) => a - b));
    const msgs = r.engine.messages();
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const a = msgs[1];
    expect(a.status).toBe("complete");
    expect(a.content[0]).toMatchObject({ type: "thinking", thinking: "hmm", signature: "SIG1" });
    expect(a.content[1]).toEqual({ type: "text", text: "hello there world " });
    expect(a.usage?.output_tokens).toBe(20);
    expect(a.costUsd).not.toBeNull();
    expect(r.engine.state().title).toBe("A Title");
    expect(r.idx.msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r.idx.convs.at(-1).title).toBe("A Title");
    expect(r.idx.usage.length).toBeGreaterThan(0);
    // The header chip (conversation totals) must equal the Usage screen (sum of every usage row), title call included.
    const sumUsd = r.idx.usage.reduce((n: number, u: any) => n + (u.costUsd ?? 0), 0);
    expect(r.idx.usage.find((u: any) => u.model === "claude-haiku-5-5").costUsd).toBeGreaterThan(0);
    expect(r.idx.usage.some((u: any) => u.model === "claude-haiku-5-5")).toBe(true);
    expect(r.engine.state().costUsd).toBeCloseTo(sumUsd, 10);
    expect(r.idx.convs.at(-1).costUsd).toBeCloseTo(sumUsd, 10);
    expect(r.engine.running).toBe(false);
  });

  test("thinking signature round-trips; empty thinking is dropped; cache breakpoints", async () => {
    const r = rig((_b, n) => sse(turnEvents("answer " + n, { thinking: n === 1 })));
    await r.engine.send("one"); await r.engine.send("two");
    const second = r.calls.filter((c) => c.stream)[1];
    const asst = second.messages[1];
    expect(asst.role).toBe("assistant");
    expect(asst.content[0]).toMatchObject({ type: "thinking", signature: "SIG1" });
    expect(asst.content[0].cache_control).toBeUndefined();
    expect(asst.content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(second.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(second.thinking).toEqual({ type: "adaptive" });
    expect(JSON.stringify(second)).not.toContain("_ms");
    expect(toApiContent([{ type: "thinking", thinking: "", signature: "x" }, { type: "thinking", thinking: "a" }, { type: "text", text: "" }, { type: "redacted_thinking", data: "d" }, { type: "text", text: "ok" }]))
      .toEqual([{ type: "redacted_thinking", data: "d" }, { type: "text", text: "ok" }]);
    // system prompt bytes stable between calls
    expect(JSON.stringify(r.calls[0].system)).toBe(JSON.stringify(second.system));
  });

  test("haiku 5.5 gets adaptive thinking and no sampling params / budget_tokens", () => {
    const r: any = buildRequest("claude-haiku-5-5", [{ role: "user", content: [{ type: "text", text: "x" }] }]);
    expect(r.thinking).toEqual({ type: "adaptive" });
    for (const k of ["temperature", "top_p", "top_k"]) expect(r[k]).toBeUndefined();
  });

  test("haiku 4.5 gets no thinking param", () => {
    expect(buildRequest("claude-haiku-4-5", [{ role: "user", content: [{ type: "text", text: "x" }] }]).thinking).toBeUndefined();
  });

  test("resume: events since seq replay, and canReplayFrom", async () => {
    const r = rig(() => sse(turnEvents("a b c d")));
    await r.engine.send("hi");
    const mid = r.broadcasts[5].seq;
    const rest = r.engine.eventsSince(mid);
    expect(rest.map((e) => e.seq)).toEqual(r.broadcasts.filter((b) => b.seq > mid).map((b) => b.seq));
    expect(r.engine.canReplayFrom(mid)).toBe(true);
    expect(r.engine.canReplayFrom(r.engine.lastSeq() + 5)).toBe(false);
  });

  test("stop mid-stream keeps the partial and reports interrupted", async () => {
    const r = rig(() => sse(turnEvents("one two three four five six").slice(0, 8), { hang: true }));
    const p = r.engine.send("hi");
    await Bun.sleep(40);
    expect(r.engine.running).toBe(true);
    expect(await r.engine.send("again")).toEqual({ ok: false, error: "busy" });
    r.engine.stop();
    await p;
    expect(r.engine.running).toBe(false);
    const a = r.engine.messages().find((m) => m.role === "assistant")!;
    expect(a.status).toBe("interrupted");
    expect(a.content[0].text).toContain("one");
    const types = r.broadcasts.map((b) => b.e.type);
    expect(types).toContain("client_interrupt");
    expect(r.broadcasts.at(-1)!.e).toMatchObject({ type: "turn_end", status: "interrupted" });
  });

  test("a stopped turn is replayed with a neutral marker and the next user message says so", async () => {
    let n = 0;
    const r = rig(() => (++n === 1 ? sse(turnEvents("one two three four five six").slice(0, 8), { hang: true }) : sse(turnEvents("pong"))));
    const p = r.engine.send("essay");
    await Bun.sleep(40);
    r.engine.stop();
    await p;
    await r.engine.send("say pong");
    const body = r.calls.filter((c) => c.stream).at(-1);
    const flat = JSON.stringify(body.messages);
    expect(flat).toContain("[reply stopped by the user]");
    expect(body.messages.at(-1).content[0].text).toContain("stopped your previous reply on purpose");
    expect(body.messages.at(-1).content.at(-1).text).toBe("say pong");
  });

  test("gateway 5xx: one auto retry, then visible error and retry button works", async () => {
    let fail = true;
    const r = rig(() => fail ? new Response(JSON.stringify({ error: { type: "api_error", message: "boom" } }), { status: 503 }) : sse(turnEvents("recovered")));
    await r.engine.send("hi");
    const types = r.broadcasts.map((b) => b.e.type);
    expect(types.filter((t) => t === "attempt").length).toBe(2);
    expect(types).toContain("http_error");
    const st = r.engine.state();
    expect(st.running).toBe(false);
    expect(st.error).toMatchObject({ status: 503, retryable: true });
    fail = false;
    expect(await r.engine.retry()).toEqual({ ok: true });
    const msgs = r.engine.messages();
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r.engine.state().error).toBeNull();
  });

  test("429 then success within a turn retries transparently", async () => {
    let n = 0;
    const r = rig(() => (n++ === 0 ? new Response("{}", { status: 429 }) : sse(turnEvents("fine"))));
    await r.engine.send("hi");
    expect(r.engine.messages().at(-1)!.status).toBe("complete");
  });

  test("non-retryable 400 is not retried", async () => {
    const r = rig(() => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad" } }), { status: 400 }));
    await r.engine.send("hi");
    expect(r.broadcasts.filter((b) => b.e.type === "attempt").length).toBe(1);
    expect(r.engine.state().error).toMatchObject({ status: 400 });
  });

  test("provider retryable:false (AI Studio location error) is emitted without a Retry offer, one attempt", async () => {
    const r = rig(() => { throw new ProviderError("Google blocks AI Studio from the region this chat runs in (\"User location is not supported\").", 400, { type: "invalid_request_error", retryable: false }); });
    await r.engine.send("hi", "aistudio:gemini-3.5-flash-lite");
    expect(r.broadcasts.filter((b) => b.e.type === "attempt").length).toBe(1);
    expect(r.engine.state().error).toMatchObject({ status: 400, retryable: false });
    expect(String(r.engine.state().error?.message)).toMatch(/User location is not supported/);
  });

  test("mid-stream error event persists partial + error", async () => {
    const ev = turnEvents("partial text here").slice(0, 6);
    const r = rig(() => sse([...ev, { type: "error", error: { type: "overloaded_error", message: "overloaded" } }]));
    await r.engine.send("hi");
    const a = r.engine.messages().find((m) => m.role === "assistant")!;
    expect(a.status).toBe("error");
    expect(r.engine.state().error).toMatchObject({ type: "overloaded_error" });
  });

  test("iteration cap (pause_turn loop) stops at the guard", async () => {
    const r = rig(() => sse(turnEvents("still going", { stop: "pause_turn" })), 4);
    await r.engine.send("hi");
    expect(r.calls.filter((c) => c.stream).length).toBe(4);
    expect(r.engine.state().error).toMatchObject({ type: "loop_guard", retryable: false });
  });

  test("restart reconcile: stale running turn is closed with its partial", async () => {
    const r = rig(() => sse(turnEvents("x y z w v u t s r q p").slice(0, 7), { hang: true }));
    void r.engine.send("hi");
    await Bun.sleep(40);
    // simulate DO eviction: new engine over same sqlite, old one abandoned
    r.engine.stop();
    const e2 = r.mk();
    // the abandoned engine's own stop already closed things; force the stale state as after a hard kill
    e2.setMeta("running", "1");
    await e2.init();
    const st = e2.state();
    expect(st.running).toBe(false);
    expect(st.error).toMatchObject({ type: "interrupted" });
  });

  test("validation", async () => {
    const r = rig(() => sse(turnEvents("x")));
    expect((await r.engine.send("   ")).ok).toBe(false);
    expect((await r.engine.send("x".repeat(100_001))).ok).toBe(false);
    expect((await r.engine.send("hi", "bad model!")).ok).toBe(false);
    expect((await r.engine.retry()).ok).toBe(false);
  });

  test("accumulator drops incomplete tool_use and parses json", () => {
    const a = new BlockAccumulator();
    a.feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "n", input: {} } }, 0);
    a.feed({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } }, 1);
    expect(a.finished()).toEqual([]);
    a.feed({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } }, 2);
    a.feed({ type: "content_block_stop", index: 0 }, 3);
    expect(a.finished()[0]).toMatchObject({ type: "tool_use", input: { a: 1 } });
  });
});

describe("stop before the first token", () => {
  const lastEnd = (b: Array<{ e: ServerEvent }>) => b.filter((x) => x.e.type === "turn_end").at(-1)?.e as any;
  test("a stop while the upstream request is still pending ends the turn Stopped, charging nothing", async () => {
    let seen: AbortSignal | undefined;
    const { engine, broadcasts, idx } = rig(() => new Response(null)); // replaced below
    (engine as any).provider.messages = (_b: any, signal?: AbortSignal) => { seen = signal; return new Promise((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted")))); };
    const p = engine.send("hello");
    await Bun.sleep(5);
    engine.stop();
    await p;
    expect(seen?.aborted).toBe(true);
    expect(lastEnd(broadcasts).status).toBe("interrupted");
    const msgs = engine.messages();
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", status: "interrupted", content: [] });
    expect(msgs.at(-1)!.usage).toBeNull();
    expect(idx.usage.length).toBe(0);
    expect(engine.running).toBe(false);
  });
  test("a stop queued before the turn starts (pending command) is applied: the provider is never called", async () => {
    const { engine, calls, broadcasts } = rig(() => sse(turnEvents("never shown")));
    engine.setMeta("pending", JSON.stringify({ cmd: "send" }));
    engine.stop(); // alarm has not run yet
    engine.setMeta("pending", null);
    await engine.send("hello");
    expect(calls.filter((c) => c.stream).length).toBe(0);
    expect(lastEnd(broadcasts).status).toBe("interrupted");
    expect(engine.messages().at(-1)).toMatchObject({ role: "assistant", status: "interrupted" });
    // the next send is not affected by the consumed stop
    await engine.send("again");
    expect(lastEnd(broadcasts).status).toBe("done");
  });
  test("a stop with nothing running or queued is ignored", async () => {
    const { engine, broadcasts } = rig(() => sse(turnEvents("fine")));
    engine.stop();
    await engine.send("hello");
    expect(lastEnd(broadcasts).status).toBe("done");
  });
});
