// First turn of a NEW chat: the DO has no scope and no registry metas yet, so the model used to read as "no tools" (offeredTools [], not forced).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import "../src/providers/config";
import { cfToolsHost, withCfTools } from "../src/cf-tools";
import { ChatEngine } from "../src/turn-engine";
import { scopeFor } from "../src/scope";
import { openaiCompatProvider } from "../src/providers/openai-compat";
import { metaFromProviderModel, registerModelMeta } from "../src/models-meta";

const OPEN = scopeFor("main", "open");
const sseOf = (delta: any, fin: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
const answer = () => new Response(sseOf({ role: "assistant", content: "Hà Nội 30°C." }) + sseOf({}, "stop") + "data: [DONE]\n\n");

// `cold`: metaScope is null and the model's meta is unknown until loadMetas has run, like a fresh ChatSession (scopeCache null, registry not built).
async function firstTurn(id: string, cold: boolean) {
  const browser = { quickAction: async () => Response.json({ success: true, result: "x" }) };
  const cf = cfToolsHost({ shared: async () => true, browser, image: null, db: {} as any, scope: OPEN, files: null, index: { recordUsage: async () => {} } as any, conv: () => "c1" });
  const host = withCfTools({ list: async () => [], call: async () => ({ text: "", isError: true }) }, cf);
  const db = new Database(":memory:"), sent: any[] = [];
  const caps: any = { text: true, vision: false, tools: true, "image-gen": false, "video-gen": false, reasoning: false };
  let scope: string | null = cold ? null : OPEN, loads = 0;
  const load = () => { scope = OPEN; registerModelMeta(`nvidia:${id}`, metaFromProviderModel("t", caps, null, null, 16384, { forceViaAuto: true })); };
  if (!cold) load();
  const cfg: any = { id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", keyBinding: "K", models: [] };
  const real = openaiCompatProvider(cfg, { K: "k" }, async (_u, init) => { const body = JSON.parse(String(init?.body)); if (body.tools) sent.push(body); return answer(); });
  const provider: any = { name: "p", listModels: async () => [], messages: (b: any) => real.messages({ ...b, model: b.model.replace(/^nvidia:/, "") }) };
  const index = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
  const engine = new ChatEngine({ sql: { exec: (q: string, ...b: any[]) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: () => {} }, retryDelayMs: 1, tools: host, openSpace: () => true, forceToolCues: () => true, personalTools: () => true,
    metaScope: () => scope, loadMetas: async () => { loads++; load(); } } as any);
  engine.setConvId("c1");
  await engine.send("thời tiết Hà Nội hôm nay thế nào?", `nvidia:${id}`);
  return { sent, loads };
}

describe("first turn of a fresh chat", () => {
  test("cold scope/metas: tools are offered and the call is forced (via auto for a forceViaAuto model)", async () => {
    const { sent, loads } = await firstTurn("cold-model-a", true);
    expect(loads).toBe(1);
    const b = sent[0];
    expect(b.tools.map((t: any) => t.function?.name ?? t.name)).toContain("web_read");
    expect(b.tool_choice).toBe("auto"); // forceViaAuto: forced in intent, sent as auto + nudge
    expect(JSON.stringify(b.messages)).toContain("make a tool call now");
  });
  test("warm: unchanged, the loader is not called", async () => {
    const { sent, loads } = await firstTurn("warm-model-b", false);
    expect(loads).toBe(0);
    expect(sent[0].tools.length).toBeGreaterThan(0);
  });
});
