// imgpaste4: the image pre-flight's capability load is bounded (deadline) and abortable (Stop); a refusal leaves nothing stuck.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { applyCatalogListing, beginCatalogListing, metaFromProviderModel } from "../src/models-meta";
import type { ModelProvider } from "../src/providers/types";

const sse = () => {
  const evs: ServerEvent[] = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
  return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const PNG = { ref: "vertex-client/conv-1/a.png", name: "a.png", mime: "image/png", size: 1 };
let n = 0;
function rig(stall: boolean, preflightMs = 25) {
  const db = new Database(":memory:"); const bodies: any[] = []; const scope = `imgp4-${++n}`;
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => { if (b.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }); bodies.push(b); return sse(); } };
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: () => {} }, retryDelayMs: 1, files: { size: async () => null, get: async () => new Uint8Array([1]) }, metaScope: () => scope, preflightMs,
    loadMetas: async () => { if (stall) await gate; const t = beginCatalogListing(scope); applyCatalogListing(scope, t, new Map([["zz-vis", metaFromProviderModel("V", { text: true, vision: true, tools: false, "image-gen": false, "video-gen": false, reasoning: false }, null)]])); },
  });
  engine.setConvId("conv-1");
  return { engine, bodies, release };
}

describe("imgpaste4 bounded + abortable image pre-flight", () => {
  test("a stalled capability load times out with a clear error; nothing stored; next send works", async () => {
    const r = rig(true);
    const x = await r.engine.send("look", "zz-vis", [PNG]);
    expect(x).toEqual({ ok: false, error: "Could not load the model capabilities. Try again." });
    expect(r.engine.messages().length).toBe(0); expect(r.bodies.length).toBe(0);
    expect((await r.engine.send("hello", "claude-sonnet-5-5")).ok).toBe(true); // not busy, no stale stop
    await Bun.sleep(30);
    expect(r.bodies.length).toBe(1);
  });
  test("Stop during the wait ends it at once with 'Stopped.'; the next send works", async () => {
    const r = rig(true, 60_000); // deadline far away: only Stop can end it
    const p = r.engine.send("look", "zz-vis", [PNG]);
    await Bun.sleep(5); r.engine.stop();
    expect(await p).toEqual({ ok: false, error: "Stopped." });
    expect((await r.engine.send("hello", "claude-sonnet-5-5")).ok).toBe(true);
    await Bun.sleep(30);
    expect(r.bodies.length).toBe(1); expect(r.engine.messages().at(-1)!.status).not.toBe("interrupted");
  });
  test("a stop already pending before the wait is honoured without waiting", async () => {
    const r = rig(true, 60_000);
    r.engine.setMeta("pending", "1"); r.engine.stop(); // queued stop -> takePreStop sets stopRequested
    expect(await r.engine.send("look", "zz-vis", [PNG])).toEqual({ ok: false, error: "Stopped." });
  });
  test("a send during the stalled wait is 'busy', and works after the refusal", async () => {
    const r = rig(true);
    const p = r.engine.send("look", "zz-vis", [PNG]);
    expect(await r.engine.send("again", "claude-sonnet-5-5")).toEqual({ ok: false, error: "busy" });
    await p;
    expect((await r.engine.send("again", "claude-sonnet-5-5")).ok).toBe(true);
  });
  test("a normal image send to a vision model still works (load completes in time)", async () => {
    const r = rig(false, 60_000);
    expect((await r.engine.send("look", "zz-vis", [PNG])).ok).toBe(true);
    await Bun.sleep(30);
    expect(r.bodies[0].messages[0].content[0]).toMatchObject({ type: "image" });
  });
  test("no leaked timer or wake hook: after a successful load Stop is a plain stop (no stale hook), after a timeout nothing fires later", async () => {
    const r = rig(false, 40);
    await r.engine.send("look", "zz-vis", [PNG]); await Bun.sleep(30);
    expect((r.engine as any).preflightWake).toBeNull();
    const s = rig(true, 20); await s.engine.send("look", "zz-vis", [PNG]);
    expect((s.engine as any).preflightWake).toBeNull();
    s.release(); await Bun.sleep(60); // the abandoned load finishing later changes nothing
    expect(s.engine.messages().length).toBe(0);
  });
});
