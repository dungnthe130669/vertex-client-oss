import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
// P0: the REAL ChatSession DO in workerd resolves its scope from D1 and fails closed. A g:* conversation (row inserted directly: no login mints
// that scope yet) must never get Erich's gateway credential or the connector; an unknown scope must not default to main.
const e = env as any;
const GA = "g:abcdefghijklmnopqrstuvwx";
async function socket(id: string) {
  const r = await e.CHAT.get(e.CHAT.idFromName(id)).fetch(new Request("https://do.internal/ws?since=0", { headers: { upgrade: "websocket", "x-conv-id": id } }));
  expect(r.status).toBe(101);
  const ws = r.webSocket!; ws.accept();
  const frames: any[] = [];
  ws.addEventListener("message", (m: MessageEvent) => frames.push(JSON.parse(String(m.data))));
  const until = async (pred: (f: any[]) => boolean, ms = 8000) => { const t0 = Date.now(); while (!pred(frames)) { if (Date.now() - t0 > ms) throw new Error("timeout; frames=" + JSON.stringify(frames.map((f) => f.e?.type ?? f.t))); await new Promise((res) => setTimeout(res, 25)); } };
  await until((f) => f.some((x) => x.t === "hello"));
  return { ws, frames, until };
}
const mk = async (id: string, scope: string) => { await e.DB.prepare(`INSERT INTO conversations (id, model, scope) VALUES (?,?,?)`).bind(id, "claude-sonnet-5-5", scope).run(); };
const turnErr = (f: any[]) => f.find((x) => x.e?.type === "turn_end" && x.e.status === "error")?.e;

describe("ChatSession DO: scope fail-closed", () => {
  for (const [name, scope, id] of [["g:* has no provider", GA, "00000000-0000-4000-8000-0000000000a1"], ["unknown scope", "g:short", "00000000-0000-4000-8000-0000000000a2"], ["junk scope", "admin", "00000000-0000-4000-8000-0000000000a3"]] as const) {
    it(`${name}: a chat turn errors and nothing is billed or sent`, async () => {
      await mk(id, scope);
      const s = await socket(id);
      s.ws.send(JSON.stringify({ t: "send", text: "hello", model: "claude-sonnet-5-5" }));
      await s.until((f) => f.some((x) => x.e?.type === "turn_end"));
      const err = turnErr(s.frames);
      expect(err).toBeTruthy(); // unresolvable scope is refused at slot acquisition (reported with the generic busy text), g:* reaches the provider and is refused there
      expect(String(err.error?.message ?? "")).toMatch(/no provider for scope|conversation scope unavailable|Too many conversations/);
      expect(((await e.DB.prepare(`SELECT COUNT(*) AS n FROM usage WHERE conversation_id=?`).bind(id).first()) as any).n).toBe(0);
      expect(((await e.DB.prepare(`SELECT COUNT(*) AS n FROM active_turns WHERE conversation_id=?`).bind(id).first()) as any).n).toBe(0);
    });
  }
  it("slash-catalog DO: a g:* scope header yields no tools; junk header yields no tools", async () => {
    for (const h of [GA, "root"]) {
      const r = await e.CHAT.get(e.CHAT.idFromName("slash-catalog")).fetch(new Request("https://do.internal/tools", { headers: { "x-data-scope": h } }));
      expect(((await r.json()) as any).tools).toEqual([]);
    }
  });
});
