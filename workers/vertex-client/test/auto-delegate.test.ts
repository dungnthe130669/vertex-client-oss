import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { AUTO_DELEGATE_PARAGRAPH, SYSTEM_PROMPT, SYSTEM_PROMPT_AUTO_DELEGATE } from "../src/system-prompt";
import { ChatEngine, buildRequest, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { loadAutoDelegate, saveAutoDelegate } from "../src/index-d1";
import { DELEGATE_TOOL, subagentHost, withDelegate } from "../src/subagent";
import { delegationTotals } from "../src/subagent-parse";
import type { Persona } from "../src/personas";
import type { ModelProvider, ProviderModel } from "../src/providers/types";
import type { ToolDef } from "../src/tools";

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q) } as unknown as D1Database };
}

describe("auto_delegate setting", () => {
  test("default OFF; per-scope rows; on/off round trip", async () => {
    const { db, d1: D } = d1();
    expect(await loadAutoDelegate(D, "main")).toBe(false);
    await saveAutoDelegate(D, "main", true);
    expect(await loadAutoDelegate(D, "main")).toBe(true);
    expect(await loadAutoDelegate(D, "g:abc")).toBe(false);          // another scope is untouched
    expect(await loadAutoDelegate(D, "e2e")).toBe(false);
    await saveAutoDelegate(D, "g:abc", true); await saveAutoDelegate(D, "main", false);
    expect(await loadAutoDelegate(D, "main")).toBe(false); expect(await loadAutoDelegate(D, "g:abc")).toBe(true);
    expect((db.query(`SELECT name FROM settings WHERE name LIKE 'auto_delegate:%' ORDER BY name`).all() as any[]).map((r) => r.name)).toEqual(["auto_delegate:g:abc", "auto_delegate:main"]);
  });
  test("a settings read error counts as OFF", async () => {
    const bad = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("db down"); } }) }) } as unknown as D1Database;
    expect(await loadAutoDelegate(bad, "main")).toBe(false);
  });
});

describe("the system-prompt paragraph", () => {
  const tools: ToolDef[] = [{ name: DELEGATE_TOOL, description: "d", input_schema: { type: "object", properties: {} }, approval: false }];
  const text = (b: any) => b.system[0].text as string;
  test("OFF: the base prompt exactly (no paragraph), tool untouched", () => {
    expect(text(buildRequest("claude-sonnet-5-5", [], tools, null, null, false))).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toContain("delegate");
  });
  test("ON + delegate offered: base prompt + the paragraph inside the Capabilities list, before Safety", () => {
    const t = text(buildRequest("claude-sonnet-5-5", [], tools, null, null, true));
    expect(t).toBe(SYSTEM_PROMPT_AUTO_DELEGATE);
    expect(t).toContain(AUTO_DELEGATE_PARAGRAPH);
    expect(t.indexOf(AUTO_DELEGATE_PARAGRAPH)).toBeLessThan(t.indexOf("## Safety and privacy"));
    expect(t.indexOf(AUTO_DELEGATE_PARAGRAPH)).toBeGreaterThan(t.indexOf("## Capabilities"));
    expect(t.replace(AUTO_DELEGATE_PARAGRAPH + "\n", "")).toBe(SYSTEM_PROMPT);       // nothing else changed
    for (const k of ["SAME assistant message", "parallel", "at most 4", "at most 8 per turn", "trivial", "self-contained", "synthesise"]) expect(t).toContain(k);
  });
  test("ON but delegate NOT offered (no personas / no tools): no paragraph", () => {
    expect(text(buildRequest("claude-sonnet-5-5", [], [], null, null, true))).toBe(SYSTEM_PROMPT);
    expect(text(buildRequest("claude-sonnet-5-5", [], [{ ...tools[0], name: "other" }], null, null, true))).toBe(SYSTEM_PROMPT);
  });
  test("cache-stable: identical bytes on every call, no per-request data in it", () => {
    const a = text(buildRequest("claude-sonnet-5-5", [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools, null, null, true));
    const b = text(buildRequest("claude-haiku-5-5", [{ role: "user", content: [{ type: "text", text: "other" }] }], tools, "profile", { name: "p", text: "t" }, true));
    expect(a).toBe(b);
    expect(AUTO_DELEGATE_PARAGRAPH).not.toMatch(/\d{4}-\d{2}-\d{2}|\$\{|[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

// ---- the full engine path with a stub provider ----
const persona = (name: string, description: string): Persona => ({ id: name, name, description, prompt: `You are ${name}.`, model: "claude-haiku-5-5", tools: [], maxTokens: 2048, effort: null, contextMode: "task", autoUse: true, createdAt: "", updatedAt: "" });
const MODELS: ProviderModel[] = [{ id: "claude-haiku-5-5", displayName: "H" }, { id: "claude-sonnet-5-5", displayName: "S" }];
const sse = (evs: ServerEvent[]) => { const enc = new TextEncoder(); let i = 0; return new Response(new ReadableStream({ pull(c) { if (i < evs.length) c.enqueue(enc.encode(`data: ${JSON.stringify(evs[i++])}\n\n`)); else c.close(); } }), { status: 200 }); };
const toolUseTurn = (calls: Array<{ id: string; input: any }>): ServerEvent[] => [
  { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  ...calls.flatMap((c, i): ServerEvent[] => [{ type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: DELEGATE_TOOL, input: {} } }, { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } }, { type: "content_block_stop", index: i }]),
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }, { type: "message_stop" }];
const textTurn = (t: string): ServerEvent[] => [{ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];

function rig(auto: boolean | (() => boolean), turnsScript: Array<() => ServerEvent[]>, childMs: (task: string) => number = () => 5) {
  const db = new Database(":memory:"); const parent: any[] = [], child: string[] = [], evs: ServerEvent[] = [], finishOrder: string[] = [];
  let n = 0;
  const provider: ModelProvider = { name: "stub", listModels: async () => MODELS, messages: async (b: any) => {
    if (b.stream === false && String(b.system?.[0]?.text ?? "").includes("You are a subagent")) {
      const task = String(b.messages[0].content); child.push(task); await Bun.sleep(childMs(task)); finishOrder.push(task);
      return Response.json({ content: [{ type: "text", text: `S(${task})` }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 } });
    }
    if (b.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    parent.push(b); return sse(turnsScript[Math.min(n++, turnsScript.length - 1)]());
  } };
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
  const personas = [persona("researcher", "Looks things up"), persona("reviewer", "Reviews drafts")];
  const sub = subagentHost({ provider, personas: async () => personas, models: async () => MODELS, tools: async () => ({ list: async () => [], call: async () => ({ text: "", isError: false }) }), index, conv: () => "c1" });
  const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: (_s, _t, e) => evs.push(e) }, retryDelayMs: 1, tools: withDelegate({ list: async () => [], call: async () => ({ text: "n/a", isError: true }) }, sub),
    autoDelegate: typeof auto === "function" ? auto : () => auto });
  engine.setConvId("c1");
  return { engine, parent, child, evs, finishOrder };
}
const sysText = (b: any) => b.system[0].text as string;

describe("auto-delegate through the engine", () => {
  test("OFF: tool still offered, no paragraph; ON: paragraph on every model call of the turn and on later turns, same bytes", async () => {
    const off = rig(false, [() => textTurn("hi")]); await off.engine.send("hello");
    expect(off.parent[0].tools.map((t: any) => t.name)).toEqual([DELEGATE_TOOL]); expect(sysText(off.parent[0])).toBe(SYSTEM_PROMPT);
    const on = rig(true, [() => toolUseTurn([{ id: "t1", input: { persona: "researcher", task: "a" } }]), () => textTurn("done"), () => textTurn("second")]);
    await on.engine.send("go"); await on.engine.send("again");
    expect(on.parent.length).toBe(3);
    expect(on.parent.map(sysText)).toEqual([SYSTEM_PROMPT_AUTO_DELEGATE, SYSTEM_PROMPT_AUTO_DELEGATE, SYSTEM_PROMPT_AUTO_DELEGATE]);
    expect(on.parent[0].tools).toEqual(on.parent[2].tools);                    // tool block stable too
  });
  test("the setting is read once per turn: flipping mid-turn does not change that turn's later calls", async () => {
    let v = true;
    const r = rig(() => v, [() => { v = false; return toolUseTurn([{ id: "t1", input: { persona: "researcher", task: "a" } }]); }, () => textTurn("done"), () => textTurn("next turn")]);
    await r.engine.send("go");
    expect(r.parent.map(sysText)).toEqual([SYSTEM_PROMPT_AUTO_DELEGATE, SYSTEM_PROMPT_AUTO_DELEGATE]);
    await r.engine.send("again");
    expect(sysText(r.parent[2])).toBe(SYSTEM_PROMPT);                        // next turn picks the change up
  });
  test("a failing setting lookup = OFF, the turn still runs", async () => {
    const r = rig(() => { throw new Error("db"); }, [() => textTurn("hi")]); await r.engine.send("x");
    expect(sysText(r.parent[0])).toBe(SYSTEM_PROMPT); expect(r.evs.find((e) => e.type === "turn_end")).toMatchObject({ status: "done" });
  });
  test("parallel dispatch: 3 delegate blocks in ONE message start together (no queued: free slots), results return in call order even when they finish out of order", async () => {
    const dur: Record<string, number> = { slow: 40, mid: 20, fast: 2 };
    const r = rig(true, [() => toolUseTurn([{ id: "t1", input: { persona: "researcher", task: "slow" } }, { id: "t2", input: { persona: "reviewer", task: "mid" } }, { id: "t3", input: { persona: "researcher", task: "fast" } }]), () => textTurn("synth")], (t) => dur[t] ?? 5);
    await r.engine.send("do three things");
    expect(r.child.slice().sort()).toEqual(["fast", "mid", "slow"]);
    expect(r.finishOrder).toEqual(["fast", "mid", "slow"]);                  // really concurrent: the fast one finished first
    const results = r.parent[1].messages.at(-1).content;
    expect(results.map((b: any) => b.tool_use_id)).toEqual(["t1", "t2", "t3"]);   // ...yet results are in tool_use order
    const sub = r.evs.filter((e) => e.type === "subagent") as any[];
    for (const id of ["t1", "t2", "t3"]) { const st = sub.filter((e) => e.id === id).map((e) => e.status); expect(st).not.toContain("queued"); expect(st[0]).toBe("running"); expect(st.at(-1)).toBe("done"); }
    expect(sub.slice(0, sub.findIndex((e) => e.status === "done")).filter((e) => e.status === "running").map((e) => e.id).slice(0, 3).sort()).toEqual(["t1", "t2", "t3"]);   // all three started before any finished
    expect(r.evs.find((e) => e.type === "turn_end")).toMatchObject({ status: "done" });
  });
  test("cap: at most 4 run at once, the rest show 'queued' until a slot frees; the 9th call in a turn is refused", async () => {
    const calls = Array.from({ length: 9 }, (_, i) => ({ id: `t${i + 1}`, input: { persona: "researcher", task: `k${i + 1}` } }));
    const r = rig(true, [() => toolUseTurn(calls), () => textTurn("ok")], () => 15);
    await r.engine.send("many");
    const results = r.parent[1].messages.at(-1).content as any[];
    expect(results.length).toBe(9);
    const sub = r.evs.filter((e) => e.type === "subagent") as any[];
    const firstDone = sub.findIndex((e) => e.status === "done");
    const runningBeforeFirstDone = new Set(sub.slice(0, firstDone).filter((e) => e.status === "running").map((e) => e.id));
    expect(runningBeforeFirstDone.size).toBe(4);                              // the cap: only 4 had started when the first finished
    expect(sub.slice(0, firstDone).filter((e) => e.status === "queued").map((e) => e.id)).toEqual(["t5", "t6", "t7", "t8"]);  // only the calls that had to wait were announced as queued
    expect(results.slice(0, 8).every((b) => !b.is_error)).toBe(true);
    expect(results[8].is_error).toBe(true); expect(String(results[8].content)).toContain("At most 8");
  });
});

describe("delegationTotals (conversation info + turn footer)", () => {
  const body = (i: unknown, o: unknown, status = "ok") => JSON.stringify({ subagent: { persona: "p", model: "m", status, rounds: 1, input_tokens: i, output_tokens: o }, summary: "s" });
  const use = (id: string, name = DELEGATE_TOOL) => ({ type: "tool_use", id, name, input: {} });
  const res = (id: string, content: unknown) => ({ type: "tool_result", tool_use_id: id, content });
  test("counts only results of delegate tool_uses and sums tokens (no cost field exists)", () => {
    const t = delegationTotals([{ content: [{ type: "text", text: "hi" }, use("a"), use("b")] }, { content: [res("a", body(100, 10)), res("b", body(50, 5, "error")), res("zz", "plain"), res("a2", [])] }]);
    expect(t).toEqual({ count: 2, input: 150, output: 15 });
    expect(delegationTotals([])).toEqual({ count: 0, input: 0, output: 0 });
  });
  test("an unrelated tool's result shaped like delegate JSON is NOT counted (id must belong to a delegate tool_use)", () => {
    expect(delegationTotals([{ content: [use("n1", "search_notes"), use("d1")] }, { content: [res("n1", body(999, 999)), res("ghost", body(5, 5)), res("d1", body(7, 3))] }])).toEqual({ count: 1, input: 7, output: 3 });
  });
  test("a duplicated stored result counts once", () => {
    expect(delegationTotals([{ content: [use("d1")] }, { content: [res("d1", body(10, 2))] }, { content: [res("d1", body(10, 2))] }])).toEqual({ count: 1, input: 10, output: 2 });
  });
  test("token fields must be finite non-negative integers; anything else adds 0", () => {
    const evil = (v: unknown) => res("d1", body(v, v));
    for (const v of [-5, 1.5, "7", null, Infinity, NaN]) expect(delegationTotals([{ content: [use("d1")] }, { content: [evil(v)] }]), String(v)).toEqual({ count: 1, input: 0, output: 0 });
    expect(delegationTotals([{ content: [use("d1")] }, { content: [res("d1", '{"subagent":{"persona":"p","model":"m","status":"ok","rounds":1,"input_tokens":1e999,"output_tokens":-1},"summary":"s"}')] }])).toEqual({ count: 1, input: 0, output: 0 });
  });
});
