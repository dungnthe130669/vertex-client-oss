import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { ChatEngine, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { d1Index, loadAutoShadow, saveAutoShadow } from "../src/index-d1";
import { usageReport } from "../src/usage";
import { MODELS_META } from "../src/models-meta";
import type { ModelProvider } from "../src/providers/types";

const migs = (upto?: string) => readdirSync(new URL("../migrations/", import.meta.url)).sort().filter((f) => !upto || f < upto);
function d1(files: string[]) {
  const db = new Database(":memory:");
  for (const f of files) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q) } as unknown as D1Database };
}
const U = { input_tokens: 10, output_tokens: 5 };
const R = { by: "auto" as const, model: "claude-haiku-5-5", reason: "shadow | rule 7: short, no cues | effort low (not sent)" };

describe("migration 0023 (additive, fresh DB)", () => {
  test("the whole migration set applies to an empty DB and adds the three nullable columns", () => {
    const { db } = d1(migs());
    const cols = (db.query(`PRAGMA table_info(usage)`).all() as any[]).filter((c) => c.name.startsWith("routed_"));
    expect(cols.map((c) => c.name).sort()).toEqual(["routed_by", "routed_model", "routed_reason"]);
    expect(cols.every((c) => c.notnull === 0 && c.dflt_value === null)).toBe(true);
  });
  test("it only adds columns (no DROP/RENAME/UPDATE/DELETE)", () => {
    const sql = readFileSync(new URL("../migrations/0023_usage_routing.sql", import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE)\b/i);
    expect(sql.match(/ALTER TABLE usage ADD COLUMN/g)).toHaveLength(3);
  });
  test("recordUsage writes the route; a row without one leaves the columns NULL", async () => {
    const { db, d1: D } = d1(migs());
    db.query(`INSERT INTO conversations (id, model, scope) VALUES ('c','m','main')`).run();
    const ix = d1Index(D);
    await ix.recordUsage({ conversationId: "c", model: "claude-sonnet-5-5", usage: U, costUsd: 0.01, routed: R });
    await ix.recordUsage({ conversationId: "c", model: "claude-sonnet-5-5", usage: U, costUsd: 0.01 });
    expect(db.query(`SELECT model, routed_by, routed_model, routed_reason FROM usage ORDER BY id`).all()).toEqual([
      { model: "claude-sonnet-5-5", routed_by: "auto", routed_model: "claude-haiku-5-5", routed_reason: R.reason },
      { model: "claude-sonnet-5-5", routed_by: null, routed_model: null, routed_reason: null },
    ]);
  });
  test("code deployed before the migration: the row is still written (route lost, nothing else)", async () => {
    const { db, d1: D } = d1(migs("0023"));
    db.query(`INSERT INTO conversations (id, model, scope) VALUES ('c','m','main')`).run();
    await d1Index(D).recordUsage({ conversationId: "c", model: "claude-sonnet-5-5", usage: U, costUsd: 0.01, routed: R });
    expect((db.query(`SELECT COUNT(*) AS n FROM usage`).get() as any).n).toBe(1);
  });
  test("/api/usage byRoute groups what ran vs what Auto would have picked; empty when the migration is absent", async () => {
    const { db, d1: D } = d1(migs());
    db.query(`INSERT INTO conversations (id, model, scope) VALUES ('c','m','main')`).run();
    const ix = d1Index(D);
    for (let n = 0; n < 2; n++) await ix.recordUsage({ conversationId: "c", model: "claude-sonnet-5-5", usage: U, costUsd: 0.01, routed: R });
    await ix.recordUsage({ conversationId: "c", model: "claude-sonnet-5-5", usage: U, costUsd: 0.01, routed: { ...R, model: "claude-sonnet-5-5" } });
    expect((await usageReport(D)).byRoute).toEqual([
      { model: "claude-sonnet-5-5", routedModel: "claude-haiku-5-5", routedBy: "auto", n: 2 }, { model: "claude-sonnet-5-5", routedModel: "claude-sonnet-5-5", routedBy: "auto", n: 1 }]);
    expect((await usageReport(d1(migs("0023")).d1)).byRoute).toEqual([]);
  });
});

describe("auto_shadow setting", () => {
  test("default OFF, per scope, round-trips", async () => {
    const { d1: D } = d1(migs());
    expect(await loadAutoShadow(D, "main")).toBe(false);
    await saveAutoShadow(D, "main", true);
    expect(await loadAutoShadow(D, "main")).toBe(true);
    expect(await loadAutoShadow(D, "e2e")).toBe(false);
    await saveAutoShadow(D, "main", false);
    expect(await loadAutoShadow(D, "main")).toBe(false);
  });
});

// ---- engine: shadow records, the model that runs never changes ----
const sse = (text: string) => {
  const evs: ServerEvent[] = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
  return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};
function rig(o: { shadow?: () => boolean | Promise<boolean>; candidates?: () => Promise<any[]> }) {
  const db = new Database(":memory:");
  const bodies: any[] = [], usage: any[] = [];
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => { bodies.push(b); return b.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: U }) : sse("ok"); } };
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async (u) => { usage.push(u); } };
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: () => {} }, retryDelayMs: 1, autoShadow: o.shadow, autoCandidates: o.candidates,
  });
  engine.setConvId("conv-1");
  return { engine, bodies, usage };
}
const cands = async () => ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "gemini-3-pro"].map((id) => ({ id, meta: MODELS_META[id] ?? null }));
const send = async (e: ChatEngine, text: string, model = "claude-opus-5-5") => { const r = await e.send(text, model); await Bun.sleep(30); return r; };

describe("engine shadow mode", () => {
  test("ON: the chosen model still runs, and the usage row carries routed_by/model/reason", async () => {
    const { engine, bodies, usage } = rig({ shadow: () => true, candidates: cands });
    await send(engine, "hi");
    expect(bodies.filter((b) => b.stream)[0].model).toBe("claude-opus-5-5");           // unchanged
    const row = usage.find((u) => u.routed);
    expect(row.model).toBe("claude-opus-5-5");                                          // the actual model is what is billed
    expect(row.routed).toMatchObject({ by: "auto", model: "claude-haiku-5-5" });         // what Auto would have picked
    expect(row.routed.reason).toMatch(/^shadow \| rule 7/);
  });
  test("ON: a code message routes to sonnet in the record; the request is untouched", async () => {
    const { engine, bodies, usage } = rig({ shadow: () => true, candidates: cands });
    await send(engine, "fix src/index.ts", "claude-haiku-5-5");
    expect(bodies.filter((b) => b.stream)[0].model).toBe("claude-haiku-5-5");
    expect(usage.find((u) => u.routed).routed).toMatchObject({ model: "claude-sonnet-5-5" });
  });
  test("ON: shadow follows the applied default (no ceiling): an explicit cue is recorded as opus, a 60k prompt is not refused", async () => {
    const { engine, usage } = rig({ shadow: () => true, candidates: cands });
    await send(engine, "think hard about this", "claude-sonnet-5-5");
    expect(usage.find((u) => u.routed).routed).toMatchObject({ model: "claude-opus-5-5" });
  });
  test("the request body is identical with shadow on and off (only the usage row differs)", async () => {
    const on = rig({ shadow: () => true, candidates: cands }), off = rig({});
    await send(on.engine, "hello there"); await send(off.engine, "hello there");
    expect(on.bodies.filter((b) => b.stream)).toEqual(off.bodies.filter((b) => b.stream));
  });
  test("OFF (default / no hook): no route recorded", async () => {
    for (const o of [{}, { shadow: () => false, candidates: cands }]) {
      const { engine, usage } = rig(o);
      await send(engine, "hi");
      expect(usage.some((u) => u.routed)).toBe(false);
      expect(usage.length).toBeGreaterThan(0);
    }
  });
  test("a failing scope lookup or setting lookup never breaks the turn and records nothing (unknown is not consent)", async () => {
    for (const o of [{ shadow: () => true, candidates: async () => { throw new Error("gateway down"); } }, { shadow: async () => { throw new Error("db down"); }, candidates: cands }]) {
      const { engine, bodies, usage } = rig(o);
      const r = await send(engine, "hi");
      expect(r.ok).toBe(true);
      expect(bodies.filter((b) => b.stream)).toHaveLength(1);
      expect(usage.some((u) => u.routed)).toBe(false);
    }
  });
  test("a scope with no routable model records a refusal (model null), the turn still runs", async () => {
    const { engine, bodies, usage } = rig({ shadow: () => true, candidates: async () => [{ id: "gemini-3-pro", meta: null }] });
    await send(engine, "hi");
    expect(bodies.filter((b) => b.stream)).toHaveLength(1);
    expect(usage.find((u) => u.routed).routed.model).toBeNull();
  });
  test("second message sees the thread: stickiness is relative to the model that actually ran", async () => {
    const { engine, usage } = rig({ shadow: () => true, candidates: cands });
    await send(engine, "hi", "claude-sonnet-5-5");
    await send(engine, "thanks", "claude-sonnet-5-5");
    const rows = usage.filter((u) => u.routed);
    expect(rows).toHaveLength(2);
    expect(rows[1].routed).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(rows[1].routed.reason).toContain("sticky(claude-sonnet-5-5)");
  });
  test("a turn is stamped once per assistant row and the stamp does not leak into the next turn when the setting flips off", async () => {
    let on = true;
    const { engine, usage } = rig({ shadow: () => on, candidates: cands });
    await send(engine, "hi"); on = false; await send(engine, "hi again");
    expect(usage.filter((u) => u.routed)).toHaveLength(1);
  });
});
