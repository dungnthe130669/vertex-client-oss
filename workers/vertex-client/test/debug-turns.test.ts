// debug_turns:<base> diagnostics: one `DBGTURN {json}` console line per model call, OFF by default.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import "../src/providers/config";
import { buildRegistry } from "../src/providers/registry";
import { seedCatalog } from "../src/providers/catalog";
import { cfToolsHost, withCfTools } from "../src/cf-tools";
import { ChatEngine } from "../src/turn-engine";
import { scopeFor } from "../src/scope";
import { openaiCompatProvider } from "../src/providers/openai-compat";
import { loadDebugTurns } from "../src/index-d1";

const OPEN = scopeFor("main", "open");
const NV = "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b";
const sseOf = (delta: any, fin: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
const textStream = (t: string) => () => new Response(sseOf({ role: "assistant", content: t }) + sseOf({}, "stop") + "data: [DONE]\n\n");

async function run(debug: boolean | "absent", streams: Array<() => Response>) {
  buildRegistry({ scope: OPEN, gateway: null, env: { PROVIDER_KEY_NVIDIA: "k" }, catalog: seedCatalog() } as any);
  const browser = { quickAction: async () => Response.json({ success: true, result: "x" }) };
  const cf = cfToolsHost({ shared: async () => true, browser, image: null, db: {} as any, scope: OPEN, files: null, index: { recordUsage: async () => {} } as any, conv: () => "c1" });
  const host = withCfTools({ list: async () => [], call: async () => ({ text: "", isError: true }) }, cf);
  const db = new Database(":memory:"); let n = 0;
  const cfg: any = { id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", keyBinding: "K", models: [{ id: "nvidia/nemotron-3.5-lightning-30b-a3b", displayName: "x", capabilities: { tools: true }, maxOutput: 16384 }] };
  const real = openaiCompatProvider(cfg, { K: "k" }, async (_u, init) => { const body = JSON.parse(String(init?.body)); return body.tools ? (streams[n++] ?? textStream("ok"))() : textStream("ok")(); });
  const provider: any = { name: "p", listModels: async () => [], messages: (b: any) => real.messages({ ...b, model: b.model.replace(/^nvidia:/, "") }) };
  const index = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
  const engine = new ChatEngine({ sql: { exec: (q: string, ...b: any[]) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: () => {} }, retryDelayMs: 1, tools: host, openSpace: () => true, forceToolCues: () => true, personalTools: () => true, metaScope: () => OPEN,
    ...(debug === "absent" ? {} : { debugTurns: () => debug }) } as any);
  engine.setConvId("c1");
  const lines: string[] = [], orig = console.log;
  console.log = (...a: any[]) => { lines.push(a.map(String).join(" ")); };
  try { await engine.send("thời tiết Hà Nội hôm nay thế nào?", NV); } finally { console.log = orig; }
  return lines;
}

describe("debug_turns", () => {
  test("off by default and when the hook is false: no console output", async () => {
    expect((await run("absent", [textStream("Hà Nội 30°C.")])).filter((l) => l.includes("DBGTURN")).length).toBe(0);
    expect((await run(false, [textStream("Hà Nội 30°C.")])).filter((l) => l.includes("DBGTURN")).length).toBe(0);
  });
  test("on: one DBGTURN JSON line per model call with the expected fields", async () => {
    const lines = (await run(true, [textStream('I\'ll check.\n{"tool":"web_read","url":"https://x.vn/"}')])).filter((l) => l.startsWith("DBGTURN "));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const j = JSON.parse(lines[0].slice(8));
    for (const k of ["turn", "model", "forced", "forceViaAuto", "cueForcesTool", "forceToolCuesFlag", "toolChoice", "offeredTools", "narrationNames", "systemBlocks", "systemChars", "lastSystemHead", "lastMsgRole", "stop", "finishTypes", "text", "toolUseNames", "parseTextToolCall", "narratesToolCall", "openForPrompt", "narrationRetryStarts", "retries"]) expect(k in j).toBe(true);
    expect(j.model).toBe(NV);
    expect(j.cueForcesTool).toBe(true);
    expect(j.lastMsgRole).toBe("user");
    expect(j.offeredTools).toContain("web_read");
    expect(j.lastSystemHead.length).toBeLessThanOrEqual(120);
  });
  test("loadDebugTurns: only '1' is on; lookup error = off", async () => {
    const mk = (v: string | null, boom = false) => ({ prepare: () => ({ bind: () => ({ first: async () => { if (boom) throw new Error("x"); return v === null ? null : { value: v }; } }) }) }) as any;
    expect(await loadDebugTurns(mk("1"), "main")).toBe(true);
    expect(await loadDebugTurns(mk("0"), "main")).toBe(false);
    expect(await loadDebugTurns(mk(null), "main")).toBe(false);
    expect(await loadDebugTurns(mk("1", true), "main")).toBe(false);
  });
});
