// Regression guard for "Open chat stopped using web tools" (docs/reports/notool-diag.md): for an Open scope + the default NIM model, the request the
// engine sends to the provider must carry web_read / web_links / web_screenshot in `tools` AND the Open prompt must tell the model when to use them.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import "../src/providers/config";
import { buildRegistry } from "../src/providers/registry";
import { seedCatalog } from "../src/providers/catalog";
import { cfToolsHost, withCfTools } from "../src/cf-tools";
import { ChatEngine, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { scopeFor } from "../src/scope";
import { metaOf } from "../src/models-meta";
import type { ModelProvider } from "../src/providers/types";
import type { ToolHost } from "../src/tools";

const OPEN = scopeFor("main", "open");
const MODEL = "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b";
const sse = (evs: ServerEvent[]) => { const enc = new TextEncoder(); return new Response(new ReadableStream({ start(c) { for (const e of evs) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } }); };
const textMsg = (t: string): ServerEvent[] => [{ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }, { type: "message_stop" }];

describe("Open scope + NIM lightning: web tools are offered", () => {
  test("the request body carries web_links/web_read/web_screenshot and the Open prompt says when to use them", async () => {
    // Real registry for the Open scope (registers the catalog metas the engine reads `caps.tools` from), real cf host, real engine.
    buildRegistry({ scope: OPEN, gateway: null, env: { PROVIDER_KEY_NVIDIA: "k" }, catalog: seedCatalog() } as any);
    expect(metaOf(OPEN, MODEL)?.caps.tools).toBe(true);
    const browser = { quickAction: async () => Response.json({ success: true, result: "x" }) };
    const cf = cfToolsHost({ shared: async () => true, browser, image: null, db: {} as any, scope: OPEN, files: null, index: { recordUsage: async () => {} } as any, conv: () => "c1" });
    const host: ToolHost = withCfTools({ list: async () => [], call: async () => ({ text: "", isError: true }) }, cf);
    const db = new Database(":memory:"), calls: any[] = [];
    const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (body: any) => { calls.push(body); return body.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }) : sse(textMsg("ok")); } };
    const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
    const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
      provider, index, sink: { broadcast: () => {} }, retryDelayMs: 1, tools: host, openSpace: () => true, personalTools: () => true, metaScope: () => OPEN });
    engine.setConvId("c1");
    await engine.send("Thời tiết hà nội hôm nay thế nào", MODEL);
    const body = calls.find((b) => b.stream);
    const names = (body.tools ?? []).map((t: any) => t.name);
    for (const n of ["web_read", "web_screenshot", "web_links"]) expect(names).toContain(n);
    const sys: string = body.system[0].text;
    expect(sys).toContain("Open space");
    // the model must be told the web tools exist and WHEN to reach for them (live / time-sensitive questions), not only that "often none" exist
    expect(sys).toMatch(/web_read/);
    expect(sys).toMatch(/weather|news|current|time-sensitive|live/i);
  });
});
