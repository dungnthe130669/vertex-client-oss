// Auto model phase 2: applied routing (resolve, stickiness, escalation, effort, override, fallbacks) through the real engine with a stub provider.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, AUTO_MODEL, buildRequest, parseOverride, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { MODELS_META } from "../src/models-meta";
import { escalateFrom, sendableEffort } from "../src/auto-route";
import type { ModelProvider } from "../src/providers/types";
import type { ToolHost } from "../src/tools";
import { forkPrefix } from "../src/fork";

const U = { input_tokens: 10, output_tokens: 5 };
const sse = (text: string) => {
  const evs: ServerEvent[] = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
  return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const ALL = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "gemini-3-pro"];
const cands = (ids = ALL) => async () => ids.map((id) => ({ id, meta: MODELS_META[id] ?? null }));

function rig(o: { candidates?: () => Promise<any[]>; fail?: (model: string, n: number) => number | null; personas?: string[]; tools?: ToolHost; maxUsd?: number; mainScope?: boolean; clock?: { t: number; callMs: number } } = {}) {
  const db = new Database(":memory:");
  const bodies: any[] = [], usage: any[] = [], convs: any[] = [], events: ServerEvent[] = [];
  const hits: Record<string, number> = {};
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => {
    if (b.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: U });
    bodies.push(b);
    const n = (hits[b.model] = (hits[b.model] ?? 0) + 1);
    if (o.clock) o.clock.t += o.clock.callMs;
    const st = o.fail?.(b.model, n);
    return st ? Response.json({ error: { type: "overloaded_error", message: "busy" } }, { status: st }) : sse("ok");
  } };
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async (c) => { convs.push(c); }, recordUsage: async (u) => { usage.push(u); } };
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: o.clock ? 1500 : 1, ...(o.clock ? { now: () => o.clock!.t, sleep: async (ms: number) => { o.clock!.t += ms; } } : {}),
    autoCandidates: o.candidates ?? cands(), autoDefaultPlausible: () => o.mainScope !== false, autoMaxUsd: o.maxUsd === undefined ? undefined : () => o.maxUsd!, tools: o.tools, personaExists: o.personas ? async (n) => o.personas!.includes(n) : undefined,
  });
  engine.setConvId("conv-1");
  engine.setMeta("model", AUTO_MODEL);
  return { engine, bodies, usage, convs, events };
}
const say = async (e: ChatEngine, text: string, model?: string, override?: any) => { const r = await e.send(text, model, [], null, override); await Bun.sleep(30); return r; };
const streams = (bodies: any[]) => bodies.filter((b) => b.stream);
const lastAssistant = (e: ChatEngine) => [...e.messages()].reverse().find((m) => m.role === "assistant")!;

describe("Auto: resolve to a concrete (model, effort) per fresh turn", () => {
  test("short chat -> haiku, no effort sent; label data stamped on the message and the usage row", async () => {
    const { engine, bodies, usage, convs } = rig();
    await say(engine, "hi");
    const b = streams(bodies)[0];
    expect(b.model).toBe("claude-haiku-5-5");
    expect(b.output_config).toBeUndefined();                       // haiku-5-5 was not probed: never send effort
    expect(lastAssistant(engine).route).toMatchObject({ by: "auto-route", model: "claude-haiku-5-5", effort: null });
    expect(lastAssistant(engine).route!.reason).toMatch(/rule 7/);
    const row = usage.find((u) => u.routed && u.model === "claude-haiku-5-5");
    expect(row.routed).toMatchObject({ by: "auto-route", model: "claude-haiku-5-5" });
    expect(row.routed.reason).not.toMatch(/^shadow/);
    expect(engine.meta("model")).toBe(AUTO_MODEL);                  // the conversation keeps Auto, in the DO state and in the D1 index
    expect(convs.every((c) => c.model === AUTO_MODEL)).toBe(true);
    expect(engine.state().model).toBe(AUTO_MODEL);
  });
  test("code -> sonnet, medium effort: adaptive thinking + output_config.effort, never budget_tokens", async () => {
    const { engine, bodies } = rig();
    await say(engine, "fix src/index.ts please");
    const b = streams(bodies)[0];
    expect(b.model).toBe("claude-sonnet-5-5");
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(b.output_config).toEqual({ effort: "medium" });
    expect(JSON.stringify(b)).not.toMatch(/budget_tokens|"enabled"/);
    expect(lastAssistant(engine).route).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
  });
  test("a stack trace -> sonnet high; 'think hard' -> opus high", async () => {
    const a = rig({ maxUsd: 2 }); await say(a.engine, "why does this crash?\nTraceback (most recent call last):\n  File x.py, line 3");
    expect(streams(a.bodies)[0]).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "high" } });
    const b = rig({ maxUsd: 2 }); await say(b.engine, "think hard about whether this is sound");
    expect(streams(b.bodies)[0]).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high" } });
  });
  test("stickiness: the next short message stays on the thread's concrete model (no downgrade)", async () => {
    const { engine, bodies } = rig();
    await say(engine, "fix src/index.ts please");
    await say(engine, "ok thanks");
    expect(streams(bodies).map((b) => b.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
    expect(lastAssistant(engine).route!.reason).toMatch(/sticky/);
  });
  test("default (no ceiling): an explicit deep-thinking cue reaches Opus", async () => {
    const { engine, bodies } = rig();
    await say(engine, "think hard about whether this is sound");
    expect(streams(bodies)[0].model).toBe("claude-opus-5-5");
    expect(lastAssistant(engine).route!.reason).not.toMatch(/ceiling|capped by cost/);
  });
  test("an explicit ceiling ($0.25 row): the desired tier is over it, so a cheaper one runs, labelled capped; the turn is never refused", async () => {
    const { engine, bodies } = rig({ maxUsd: 0.25 });
    await say(engine, "think hard about whether this is sound");
    expect(streams(bodies)[0].model).toBe("claude-sonnet-5-5");
    expect(lastAssistant(engine).route!.reason).toMatch(/capped by cost/);
  });
  test("an image attachment never goes to a model without vision; Gemini is never picked", async () => {
    const { engine, bodies } = rig({ candidates: cands(["gemini-3-pro", "claude-haiku-5-5"]) });
    await say(engine, "hello");
    expect(streams(bodies)[0].model).toBe("claude-haiku-5-5");
  });
});

describe("Auto: safety", () => {
  test("a model outside the scope list is never picked (team list without opus: 'think hard' -> sonnet at most)", async () => {
    const { engine, bodies } = rig({ candidates: cands(["claude-haiku-5-5", "claude-sonnet-5-5"]), maxUsd: 2 });
    await say(engine, "think hard about this design");
    expect(streams(bodies)[0].model).toBe("claude-sonnet-5-5");
  });
  test("router refusal (nothing eligible) ends the turn with a plain error and makes no model call", async () => {
    const { engine, bodies, events } = rig({ candidates: cands(["gemini-3-pro"]) });
    await say(engine, "hi");
    expect(streams(bodies)).toHaveLength(0);
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ status: "error", error: { type: "auto_refused", retryable: false } });
    expect(engine.running).toBe(false);
  });
  test("a very long thread respects the haiku cliff and never refuses for cost: sonnet runs (default and with a tiny ceiling, which only adds the label)", async () => {
    for (const maxUsd of [undefined, 0.01]) {
      const { engine, bodies, events } = rig({ maxUsd });
      const big = "lorem ipsum dolor ".repeat(5500); // ~99k chars
      for (let n = 0; n < 3; n++) await say(engine, big, "claude-sonnet-5-5"); // manual turns build the history (~100k est. tokens with replies)
      engine.setMeta("model", AUTO_MODEL);
      const before = streams(bodies).length;
      await say(engine, "ok");
      const ran = streams(bodies).slice(before);
      expect(ran.length).toBeGreaterThan(0);
      expect(ran.some((b) => b.model === "claude-haiku-5-5")).toBe(false);
      expect(events.filter((e) => e.type === "turn_end").at(-1)).toMatchObject({ status: "done" });
      if (maxUsd) expect(lastAssistant(engine).route!.reason).toMatch(/over your ceiling/);
    }
  });
  test("a routing error (scope lookup throws) falls back to the last concrete model, never failing the turn", async () => {
    const broken = rig({ candidates: async () => { throw new Error("gateway down"); } });
    const r = await say(broken.engine, "hello");                          // no history: scope default
    expect(r.ok).toBe(true);
    expect(streams(broken.bodies)[0].model).toBe("claude-sonnet-5-5");
    expect(lastAssistant(broken.engine).route).toMatchObject({ by: "auto-fallback", fallbackFrom: AUTO_MODEL });
  });
  test("a fresh conversation with a manual-model history falls back to that model when routing throws", async () => {
    let boom = false;
    const { engine, bodies } = rig({ candidates: async () => { if (boom) throw new Error("down"); return cands()(); } });
    await say(engine, "x", "claude-opus-5-5");                            // manual turn on opus (conversation switched to opus)
    engine.setMeta("model", AUTO_MODEL); boom = true;
    await say(engine, "hello again");
    expect(streams(bodies).at(-1).model).toBe("claude-opus-5-5");
  });
  test("a manual conversation is untouched: no route, no effort, request byte-identical to before", async () => {
    const { engine, bodies, usage } = rig();
    engine.setMeta("model", "claude-sonnet-5-5");
    await say(engine, "fix src/index.ts please");
    const b = streams(bodies)[0];
    expect(b.model).toBe("claude-sonnet-5-5"); expect(b.output_config).toBeUndefined();
    expect(b).toEqual(buildRequest("claude-sonnet-5-5", [{ role: "user", content: [{ type: "text", text: "fix src/index.ts please" }] }], []));
    expect(lastAssistant(engine).route).toBeNull();
    expect(usage.some((u) => u.routed)).toBe(false);
  });
  test("Auto + @persona: the parent runs on a concrete tool-capable model (sonnet floor) and still gets the delegate tool", async () => {
    const tools: ToolHost = { list: async () => [{ name: "delegate", description: "d", input_schema: { type: "object" }, approval: false }], call: async () => ({ text: "", isError: false }) };
    const { engine, bodies } = rig({ personas: ["reviewer"], tools });
    await say(engine, "@reviewer look at this");
    const b = streams(bodies)[0];
    expect(b.model).toBe("claude-sonnet-5-5");
    expect(b.tools?.some((t: any) => t.name === "delegate")).toBe(true);
  });
});

describe("Auto: escalation on a retryable upstream failure", () => {
  test("haiku overloaded twice -> one retry on sonnet, labelled auto-fallback; the conversation stays Auto", async () => {
    const { engine, bodies, usage, events } = rig({ fail: (m) => (m === "claude-haiku-5-5" ? 529 : null) });
    await say(engine, "hi");
    expect(streams(bodies).map((b) => b.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(lastAssistant(engine).route).toMatchObject({ by: "auto-fallback", model: "claude-sonnet-5-5", fallbackFrom: "claude-haiku-5-5" });
    expect(lastAssistant(engine).model).toBe("claude-sonnet-5-5");
    expect(usage.find((u) => u.model === "claude-sonnet-5-5" && u.routed).routed.by).toBe("auto-fallback");
    expect(events.some((e) => e.type === "auto_fallback")).toBe(true);
    expect(engine.meta("model")).toBe(AUTO_MODEL);
    expect(events.filter((e) => e.type === "turn_end").at(-1)).toMatchObject({ status: "done" });
  });
  test("a route fallback after a retry keeps the retries and the original wall-clock start (total covers failed attempts + sleep; 2 failed attempts counted)", async () => {
    const clock = { t: 5_000_000, callMs: 1000 };
    const { engine, events } = rig({ clock, fail: (m) => (m === "claude-haiku-5-5" ? 529 : null) });
    await say(engine, "hi");
    const m = (events.filter((e) => e.type === "assistant_saved").at(-1) as any).message;
    expect(m.model).toBe("claude-sonnet-5-5");
    expect(events.filter((e) => e.type === "attempt").map((e: any) => e.n)).toEqual([1, 2, 3]); // attempt numbers keep counting across the fallback
    expect(m.retries).toBe(2);                                     // haiku attempt 1 + haiku attempt 2 failed before the sonnet success
    expect(m.totalMs).toBe(1000 + 1500 + 1000 + 1000);              // haiku, sleep, haiku, sonnet (stub advances the clock 1 s per call)
  });
  test("only ONE escalation per turn: sonnet failing too ends the turn with the upstream error", async () => {
    const { engine, bodies, events } = rig({ fail: (m) => (m !== "claude-opus-5-5" ? 529 : null), maxUsd: 2 });
    await say(engine, "hi");
    expect(new Set(streams(bodies).map((b) => b.model))).toEqual(new Set(["claude-haiku-5-5", "claude-sonnet-5-5"]));
    expect(events.filter((e) => e.type === "turn_end").at(-1)).toMatchObject({ status: "error" });
  });
  test("never a downgrade: the top tier failing just errors; a manual model never escalates", async () => {
    const a = rig({ fail: () => 529, candidates: cands(["claude-opus-5-5"]), maxUsd: 2 });
    await say(a.engine, "hi");
    expect(new Set(streams(a.bodies).map((b) => b.model))).toEqual(new Set(["claude-opus-5-5"]));
    const m = rig({ fail: () => 529 });
    m.engine.setMeta("model", "claude-haiku-5-5");
    await say(m.engine, "hi");
    expect(new Set(streams(m.bodies).map((b) => b.model))).toEqual(new Set(["claude-haiku-5-5"]));
  });
  test("a non-retryable error (400) does not escalate", async () => {
    const { engine, bodies } = rig({ fail: () => 400 });
    await say(engine, "hi");
    expect(streams(bodies)).toHaveLength(1);
  });
  test("escalateFrom respects scope, max tier and an explicit ceiling (none by default)", () => {
    const base = { text: "", estPromptTokens: 1000, candidates: ALL.map((id) => ({ id, meta: MODELS_META[id] ?? null })) };
    expect(escalateFrom(base, "claude-haiku-5-5")).toBe("claude-sonnet-5-5");
    expect(escalateFrom(base, "claude-sonnet-5-5")).toBe("claude-opus-5-5");           // no ceiling by default
    expect(escalateFrom({ ...base, maxUsd: 0.25 }, "claude-sonnet-5-5")).toBeNull();   // explicit ceiling: opus is over it
    const rich = { ...base, maxUsd: 2 };
    expect(escalateFrom(rich, "claude-sonnet-5-5")).toBe("claude-opus-5-5");
    expect(escalateFrom(rich, "claude-opus-5-5")).toBeNull();
    expect(escalateFrom({ ...rich, maxTier: "sonnet" }, "claude-sonnet-5-5")).toBeNull();
    expect(escalateFrom({ ...rich, candidates: base.candidates.filter((c) => c.id !== "claude-sonnet-5-5") }, "claude-haiku-5-5")).toBe("claude-opus-5-5");
    expect(escalateFrom({ ...base, maxUsd: 0.001 }, "claude-haiku-5-5")).toBeNull();
    expect(escalateFrom(base, "gemini-3-pro")).toBeNull();
  });
});

describe("effort mapping + request body", () => {
  const hist = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  test("sonnet-5-5 and opus-5-5 carry adaptive thinking + output_config.effort; haiku and unknown models never do", () => {
    for (const m of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
      const b = buildRequest(m, hist, [], null, null, false, "high");
      expect(b.thinking).toEqual({ type: "adaptive" }); expect((b as any).output_config).toEqual({ effort: "high" });
    }
    for (const m of ["claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-5", "mystery-model"]) expect((buildRequest(m, hist, [], null, null, false, "high") as any).output_config).toBeUndefined();
    expect((buildRequest("claude-sonnet-5-5", hist) as any).output_config).toBeUndefined();            // no effort asked = unchanged request
  });
  test("no budget_tokens / thinking.type=enabled anywhere, for any model/effort", () => {
    for (const m of Object.keys(MODELS_META)) for (const e of ["low", "medium", "high", null] as const)
      expect(JSON.stringify(buildRequest(m, hist, [], null, null, false, e))).not.toMatch(/budget_tokens|"enabled"/);
  });
  test("sendableEffort only for models that accept it", () => {
    expect(sendableEffort("claude-sonnet-5-5", "low")).toBe("low");
    expect(sendableEffort("claude-opus-5-5", null)).toBeNull();
    expect(sendableEffort("claude-haiku-5-5", "high")).toBeNull();
  });
});

describe("override: Retry with… on one message", () => {
  test("runs on the chosen model/effort, labelled manual-override; the conversation stays Auto and stickiness is untouched", async () => {
    const { engine, bodies, usage } = rig();
    await say(engine, "fix src/index.ts please");                                        // auto -> sonnet
    await say(engine, "fix src/index.ts please", undefined, { model: "claude-opus-5-5", effort: "high" });
    const b = streams(bodies)[1];
    expect(b).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high" }, thinking: { type: "adaptive" } });
    expect(lastAssistant(engine).route).toMatchObject({ by: "manual-override", model: "claude-opus-5-5", effort: "high" });
    expect(usage.find((u) => u.model === "claude-opus-5-5" && u.routed).routed.by).toBe("manual-override");
    expect(engine.meta("model")).toBe(AUTO_MODEL);
    await say(engine, "ok thanks");                                                      // next Auto turn is sticky on sonnet, not opus
    expect(streams(bodies)[2].model).toBe("claude-sonnet-5-5");
  });
  test("override on haiku sends no effort even if one was requested", async () => {
    const { engine, bodies } = rig();
    await say(engine, "hi", undefined, { model: "claude-haiku-5-5", effort: "high" });
    expect(streams(bodies)[0].output_config).toBeUndefined();
    expect(lastAssistant(engine).route).toMatchObject({ model: "claude-haiku-5-5", effort: null });
  });
  test("parseOverride rejects garbage and Auto itself; an invalid effort is dropped, not trusted", () => {
    expect(parseOverride({ model: "claude-opus-5-5", effort: "high" })).toEqual({ model: "claude-opus-5-5", effort: "high" });
    expect(parseOverride({ model: "claude-opus-5-5", effort: "max" })).toEqual({ model: "claude-opus-5-5", effort: null });
    for (const bad of [null, undefined, "x", {}, { model: "" }, { model: "a b" }, { model: AUTO_MODEL }, { model: 5 }]) expect(parseOverride(bad)).toBeNull();
  });
});

describe("an engine restarted over an existing transcript", () => {
  test("the additive messages.route column is created once and old rows read as route null", async () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, usage TEXT, cost_usd REAL, stop_reason TEXT, status TEXT NOT NULL DEFAULT 'complete', ttft_ms INTEGER, total_ms INTEGER, created_at INTEGER NOT NULL)`);
    db.exec(`INSERT INTO messages (role, content, model, created_at) VALUES ('assistant','[]','claude-sonnet-5-5',1)`);
    const mk = () => new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
      provider: { name: "s", listModels: async () => [], messages: async () => new Response("") }, index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} }, sink: { broadcast: () => {} } });
    expect(mk().messages()[0].route).toBeNull();
    expect(() => mk()).not.toThrow();                                                    // second start: the column exists, no duplicate ALTER
  });
});

describe("Auto across an approval pause", () => {
  test("the resumed turn keeps the model it started on (no re-route, no second route row)", async () => {
    const tool = [...(await import("../src/tools")).APPROVAL_TOOLS][0] as string;
    const host: ToolHost = { list: async () => [{ name: tool, description: "d", input_schema: { type: "object" }, approval: true }], call: async () => ({ text: "done", isError: false }) };
    const db = new Database(":memory:");
    const bodies: any[] = [];
    let n = 0;
    const toolUse = () => {
      const evs: ServerEvent[] = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: tool, input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
      return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const provider: ModelProvider = { name: "s", listModels: async () => [], messages: async (b: any) => { if (b.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: U }); bodies.push(b); return n++ === 0 ? toolUse() : sse("finished"); } };
    const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
      provider, index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} }, sink: { broadcast: () => {} }, retryDelayMs: 1, tools: host, autoCandidates: cands() });
    engine.setConvId("c"); engine.setMeta("model", AUTO_MODEL);
    await say(engine, "fix src/index.ts please");
    expect(engine.state().awaiting).toBeTruthy();
    const d = engine.decide("tu1", "approve");
    expect(d.ok && d.ready).toBe(true);
    await engine.resume(); await Bun.sleep(30);
    expect(bodies.map((b) => b.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
    expect(bodies[1].output_config).toEqual({ effort: "medium" });
    expect(engine.messages().filter((m) => m.role === "assistant").every((m) => m.route?.model === "claude-sonnet-5-5")).toBe(true);
  });
});

const errEnd = (events: ServerEvent[]) => events.filter((e) => e.type === "turn_end").at(-1);

describe("review fix 1: the override is validated server-side against the scope", () => {
  const TEAM = cands(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  test("a model outside the scope list (opus on a team scope without it, gemini, media, auto) is rejected: nothing stored, no provider call", async () => {
    for (const model of ["claude-opus-5-5", "gemini-3-pro", "gemini-3.1-flash-image", "text-embedding-005", "not-a-model", "auto"]) {
      const { engine, bodies } = rig({ candidates: TEAM });
      const r = await engine.send("hello", undefined, [], null, { model, effort: "high" });
      expect(r.ok).toBe(false);
      expect(streams(bodies)).toHaveLength(0);
      expect(engine.messages()).toHaveLength(0);
      expect(engine.running).toBe(false);
      expect(engine.meta("model")).toBe(AUTO_MODEL);
    }
  });
  test("a listed Claude chat model runs; a non-chat entry with a Claude id is not accepted", async () => {
    const ok = rig({ candidates: TEAM });
    expect((await say(ok.engine, "hello", undefined, { model: "claude-sonnet-5-5", effort: "high" })).ok).toBe(true);
    expect(streams(ok.bodies)[0]).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "high" } });
    const kind = rig({ candidates: async () => [{ id: "claude-sonnet-5-5", meta: MODELS_META["claude-sonnet-5-5"], kind: "image" }] });
    expect((await kind.engine.send("hi", undefined, [], null, { model: "claude-sonnet-5-5" })).ok).toBe(false);
  });
  test("capability/context filters apply to the override: haiku-5-5 above the 90k price cliff is refused for that turn", async () => {
    const { engine, bodies } = rig();
    const big = "lorem ipsum dolor ".repeat(5500);
    for (let n = 0; n < 3; n++) await say(engine, big, "claude-sonnet-5-5");
    engine.setMeta("model", AUTO_MODEL);
    const before = streams(bodies).length;
    const r = await engine.send("ok", undefined, [], null, { model: "claude-haiku-5-5" });
    expect(r.ok).toBe(false);
    expect(streams(bodies)).toHaveLength(before);
  });
  test("the scope list cannot be read: the override is refused (unknown is not consent)", async () => {
    const { engine, bodies } = rig({ candidates: async () => { throw new Error("down"); } });
    expect((await engine.send("hello", undefined, [], null, { model: "claude-sonnet-5-5" })).ok).toBe(false);
    expect(streams(bodies)).toHaveLength(0);
  });
  test("effort is only sent for models that accept it, and only allowed values survive", async () => {
    const { engine, bodies } = rig();
    await say(engine, "hi", undefined, { model: "claude-haiku-5-5", effort: "high" });
    expect(streams(bodies)[0].output_config).toBeUndefined();
    expect(parseOverride({ model: "claude-sonnet-5-5", effort: "extreme" })?.effort).toBeNull();
  });
});

describe("review fix 2: a routing error never turns into a model outside the scope", () => {
  const flaky = (second: () => any[] | Promise<any[]>) => { let n = 0; return async () => { if (n++ === 0) throw new Error("boom"); return second(); }; };
  const metas = (ids: string[]) => ids.map((id) => ({ id, meta: MODELS_META[id] ?? null }));
  test("scope lists only haiku: a routing failure falls back to haiku, not the default sonnet", async () => {
    const { engine, bodies } = rig({ candidates: flaky(() => metas(["claude-haiku-5-5"])), mainScope: false });
    await say(engine, "fix src/index.ts please");
    expect(streams(bodies).map((b) => b.model)).toEqual(["claude-haiku-5-5"]);
    expect(lastAssistant(engine).route).toMatchObject({ by: "auto-fallback", model: "claude-haiku-5-5" });
  });
  test("the last concrete model is kept only while it is still listed; otherwise the default/cheapest listed one", async () => {
    const keep = rig({ candidates: flaky(() => metas(ALL)) });
    keep.engine.setMeta("auto_last", "claude-opus-5-5");
    await say(keep.engine, "hello");
    expect(streams(keep.bodies)[0].model).toBe("claude-opus-5-5");
    const gone = rig({ candidates: flaky(() => metas(["claude-haiku-5-5", "claude-sonnet-5-5"])) });
    gone.engine.setMeta("auto_last", "claude-opus-5-5");
    await say(gone.engine, "hello");
    expect(streams(gone.bodies)[0].model).toBe("claude-sonnet-5-5");              // opus gone: the default, which IS listed
    const cheap = rig({ candidates: flaky(() => metas(["claude-haiku-5-5", "claude-opus-5-5"])) });
    await say(cheap.engine, "hello");
    expect(streams(cheap.bodies)[0].model).toBe("claude-haiku-5-5");              // default not listed: cheapest listed
  });
  test("the list cannot be read at all: last concrete model if any; else the default only on main; else a plain 'no model available' error and NO provider call", async () => {
    const down = async () => { throw new Error("down"); };
    const withLast = rig({ candidates: down, mainScope: false });
    withLast.engine.setMeta("auto_last", "claude-haiku-5-5");               // set but never actually used in this conversation: NOT trusted
    await say(withLast.engine, "hello");
    expect(streams(withLast.bodies)).toHaveLength(0);
    const main = rig({ candidates: down });
    await say(main.engine, "hello");
    expect(streams(main.bodies)[0].model).toBe("claude-sonnet-5-5");
    const team = rig({ candidates: down, mainScope: false });
    await say(team.engine, "hello");
    expect(streams(team.bodies)).toHaveLength(0);
    expect(errEnd(team.events)).toMatchObject({ status: "error", error: { type: "no_model" } });
    expect(team.engine.running).toBe(false);
  });
  test("nothing eligible in the list at all (no Claude chat model): plain error, no provider call", async () => {
    const { engine, bodies, events } = rig({ candidates: flaky(() => metas(["gemini-3-pro"])), mainScope: false });
    await say(engine, "hello");
    expect(streams(bodies)).toHaveLength(0);
    expect(errEnd(events)).toMatchObject({ error: { type: "no_model" } });
  });
});

describe("review fix 3: model + override in one frame", () => {
  test("rejected by precheck and by send; the stored model never changes and nothing is stored or billed", async () => {
    const { engine, bodies } = rig();
    engine.setMeta("model", "claude-haiku-5-5");
    expect(engine.precheck("hi", "claude-haiku-5-5", [], { model: "claude-opus-5-5" })).toMatch(/cannot be combined/);
    const r = await engine.send("hi", "claude-sonnet-5-5", [], null, { model: "claude-opus-5-5" });
    expect(r).toEqual({ ok: false, error: "override cannot be combined with a model" });
    expect(engine.meta("model")).toBe("claude-haiku-5-5");
    expect(engine.messages()).toHaveLength(0);
    expect(streams(bodies)).toHaveLength(0);
    expect(engine.running).toBe(false);
  });
  test("an override-only send on a manual-model conversation runs the override and leaves the stored model alone", async () => {
    const { engine, bodies } = rig();
    engine.setMeta("model", "claude-haiku-5-5");
    await say(engine, "hi", undefined, { model: "claude-opus-5-5" });
    expect(streams(bodies)[0].model).toBe("claude-opus-5-5");
    expect(engine.meta("model")).toBe("claude-haiku-5-5");
  });
});

describe("review fix 4: retry / regenerate / fork keep Auto's routing contract (design: escalate only after a failure, never downgrade, resume keeps the route)", () => {
  test("retry after a FAILED attempt re-routes one tier up (rule 1), once; the failure marker is then cleared so the next message is sticky, not escalated again", async () => {
    let failHaiku = true;
    const { engine, bodies } = rig({ fail: (m) => (m === "claude-haiku-5-5" && failHaiku ? 400 : null), maxUsd: undefined });
    await say(engine, "hi");                                                    // haiku -> 400 -> error turn, nothing answered
    expect(engine.messages().at(-1)!.role).toBe("user");
    failHaiku = false;
    const r = await engine.retry(); await Bun.sleep(30);
    expect(r.ok).toBe(true);
    expect(streams(bodies).map((b) => b.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(lastAssistant(engine).route).toMatchObject({ by: "auto-route", model: "claude-sonnet-5-5" });
    expect(lastAssistant(engine).route!.reason).toMatch(/rule 1/);
    await say(engine, "ok thanks");
    expect(streams(bodies).at(-1).model).toBe("claude-sonnet-5-5");              // sticky, no second escalation
    expect(lastAssistant(engine).route!.reason).not.toMatch(/rule 1/);
  });
  test("a retry with no failed attempt before it does not escalate (a fresh turn on the same text routes the same way)", async () => {
    const { engine, bodies } = rig();
    await say(engine, "hi");
    await say(engine, "hi");                                                    // regenerate = same text again
    expect(streams(bodies).map((b) => b.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5"]);
  });
  test("regenerate keeps stickiness and never downgrades: opus stays opus for the same and for a trivial text", async () => {
    const { engine, bodies } = rig();
    await say(engine, "think hard about whether this is sound");               // opus (no ceiling)
    await say(engine, "think hard about whether this is sound");               // regenerate
    await say(engine, "hi");
    expect(streams(bodies).map((b) => b.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
  });
  test("a turn that ended max_tokens makes the next (regenerated) turn escalate one tier, once", async () => {
    const { engine, bodies } = rig();
    await say(engine, "fix src/index.ts please");                              // sonnet
    const a = engine.messages().at(-1)!;
    (engine as any).sql.exec(`UPDATE messages SET stop_reason='max_tokens' WHERE id=?`, a.id);
    await say(engine, "fix src/index.ts please");
    await say(engine, "fix src/index.ts please");
    expect(streams(bodies).map((b) => b.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
  });
  test("fork: the copy keeps conversation model 'auto' and each answer's concrete model, so its first Auto turn is sticky on it", async () => {
    const src = rig();
    await say(src.engine, "fix src/index.ts please");                          // sonnet
    await say(src.engine, "and again");
    const msgs = src.engine.messages();
    const u2 = msgs.filter((m) => m.role === "user")[1];
    const fp = forkPrefix(msgs as any, u2.id, false);
    expect(fp.ok).toBe(true);
    if (!fp.ok) return;
    const dst = rig();
    dst.engine.setMeta("model", "");                                            // a new conversation row
    expect(dst.engine.seedHistory(AUTO_MODEL, "t", fp.messages)).toBe(true);
    expect(dst.engine.meta("model")).toBe(AUTO_MODEL);
    expect(dst.engine.messages().filter((m) => m.role === "assistant").map((m) => m.model)).toEqual(["claude-sonnet-5-5"]);
    await say(dst.engine, "ok thanks");
    expect(streams(dst.bodies)[0].model).toBe("claude-sonnet-5-5");              // sticky from the copied answer, not haiku by rule 7
  });
});

describe("round 3: fallback filters, unreadable list, legacy fork rows", () => {
  const metas = (ids: string[]) => ids.map((id) => ({ id, meta: MODELS_META[id] ?? null }));
  const flaky = (second: () => any[]) => { let n = 0; return async () => { if (n++ === 0) throw new Error("boom"); return second(); }; };
  test("fallback applies the hard filters: a >90k thread never falls back to haiku (cheapest listed), sonnet is chosen", async () => {
    const big = "lorem ipsum dolor ".repeat(5500);
    const { engine, bodies } = rig({ candidates: flaky(() => metas(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"])) });
    // history of manual turns (candidates call #1 is consumed by the first Auto turn below, so build history on a manual model)
    for (let n = 0; n < 3; n++) await say(engine, big, "claude-sonnet-5-5");
    engine.setMeta("model", AUTO_MODEL);
    engine.setMeta("auto_last", "claude-haiku-5-5");
    const before = streams(bodies).length;
    await say(engine, "ok");
    const ran = streams(bodies).slice(before).map((b) => b.model);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran).not.toContain("claude-haiku-5-5");
  });
  test("fallback with an image: a listed model without vision is skipped; none passing = plain no_model error, no provider call", async () => {
    const noVision = (id: string) => ({ id, meta: { ...MODELS_META[id], caps: { ...MODELS_META[id].caps, images: false } } });
    const png = [{ ref: "vertex-client/conv-1/a.png", name: "a.png", mime: "image/png", size: 10 }];
    const e1 = rig({ candidates: flaky(() => [noVision("claude-haiku-5-5"), ...metas(["claude-opus-5-5"])]) });
    await e1.engine.send("look", undefined, png as any); await Bun.sleep(30);
    expect(streams(e1.bodies).map((b) => b.model)).toEqual(["claude-opus-5-5"]);
    const e2 = rig({ candidates: flaky(() => [noVision("claude-haiku-5-5"), noVision("claude-sonnet-5-5")]) });
    await e2.engine.send("look", undefined, png as any); await Bun.sleep(30);
    expect(streams(e2.bodies)).toHaveLength(0);
    expect(errEnd(e2.events)).toMatchObject({ status: "error", error: { type: "no_model" } });
  });
  test("unreadable list: last concrete model only if used successfully in this conversation, labelled 'list unavailable'", async () => {
    let down = false;
    const { engine, bodies } = rig({ candidates: async () => { if (down) throw new Error("down"); return metas(ALL); }, mainScope: false });
    await say(engine, "fix src/index.ts please");                                 // sonnet, really used
    down = true;
    await say(engine, "ok thanks");
    expect(streams(bodies).map((b) => b.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
    expect(lastAssistant(engine).route).toMatchObject({ by: "auto-fallback" });
    expect(lastAssistant(engine).route!.reason).toMatch(/list unavailable/);
  });
  test("fork with legacy/null-model assistant rows never stores 'auto'", () => {
    const { engine } = rig();
    engine.setMeta("model", "");
    const text = (t: string) => [{ type: "text", text: t }] as any;
    expect(engine.seedHistory(AUTO_MODEL, "t", [
      { role: "user", content: text("a") }, { role: "assistant", content: text("b"), model: null },
      { role: "user", content: text("c") }, { role: "assistant", content: text("d"), model: "claude-opus-5-5" },
      { role: "user", content: text("e") }, { role: "assistant", content: text("f"), model: AUTO_MODEL },
    ])).toBe(true);
    expect(engine.messages().filter((m) => m.role === "assistant").map((m) => m.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
    const none = rig(); none.engine.setMeta("model", "");
    expect(none.engine.seedHistory(AUTO_MODEL, "t", [{ role: "user", content: text("a") }, { role: "assistant", content: text("b") }])).toBe(true);
    expect(none.engine.messages().filter((m) => m.role === "assistant").map((m) => m.model)).toEqual([null]);
  });
});
