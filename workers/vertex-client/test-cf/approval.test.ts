import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { sse, textEvents } from "../src/providers/stub";
import { clearEntitlementCache } from "../src/providers/team-gateway";
// Approval modes through the REAL ChatSession DO in workerd: the composer mode command, the admin kill switch, and the team user's system prompt / tool list
// (a team user must never be told about, or offered, the personal-connector tools).
const e = env as any;
const UID = "abcdef0123456789abcdef09";
const PERSONAL = ["save_note", "update_task", "assign_task", "delete_note", "delete_thread", "ask_vertex", "search_notes", "get_note", "list_projects", "check_tasks", "list_threads", "connector_usage", "fleet_status", "fleet_usage", "read_url"];
const bodies: any[] = [];
beforeAll(() => { e.TEAM_GATEWAY_URL = "https://tg.test"; e.VCLIENT_TEAM_CALLER_KEY = "CALLER-KEY-FAKE"; });
afterAll(() => { delete e.TEAM_GATEWAY_URL; delete e.VCLIENT_TEAM_CALLER_KEY; });
afterEach(() => { vi.unstubAllGlobals(); bodies.length = 0; clearEntitlementCache(); });
const stub = () => vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
  const u = new URL(String(input));
  if (u.pathname === "/v1/entitlements") return Response.json({ features: ["vclient_app", "chat"] });
  if (u.pathname === "/v1/messages") { try { bodies.push(JSON.parse(String(init.body))); } catch { /* not json */ } return sse(textEvents("claude-sonnet-5-5", "hi from team", { input_tokens: 3, output_tokens: 3 })); }
  return new Response("{}", { status: 404 });
});
async function socket(id: string) {
  const r = await e.CHAT.get(e.CHAT.idFromName(id)).fetch(new Request("https://do.internal/ws?since=0", { headers: { upgrade: "websocket", "x-conv-id": id } }));
  expect(r.status).toBe(101);
  const ws = r.webSocket!; ws.accept();
  const frames: any[] = [];
  ws.addEventListener("message", (m: MessageEvent) => frames.push(JSON.parse(String(m.data))));
  const until = async (pred: (f: any[]) => boolean, ms = 8000) => { const t0 = Date.now(); while (!pred(frames)) { if (Date.now() - t0 > ms) throw new Error("timeout; frames=" + JSON.stringify(frames.map((f) => f.e?.type ?? f.t))); await new Promise((r) => setTimeout(r, 20)); } };
  await until((f) => f.some((x) => x.t === "hello"));
  return { ws, frames, until };
}
const mk = async (id: string, scope: string) => { await e.DB.prepare(`INSERT INTO conversations (id, model, scope) VALUES (?,?,?)`).bind(id, "claude-sonnet-5-5", scope).run(); };
const state = async (id: string) => (await (await e.CHAT.get(e.CHAT.idFromName(id)).fetch(new Request("https://do.internal/state", { headers: { "x-conv-id": id } }))).json()) as any;

describe("composer mode over the real DO", () => {
  it("Ask is the default; the user can switch to Auto and back; the state carries it and the admin flag", async () => {
    const id = "00000000-0000-4000-8000-0000000000c1"; await mk(id, "main");
    expect(await state(id)).toMatchObject({ approvalMode: "ask", approvalAuto: true, webGrants: [], autoLog: {} });
    const s = await socket(id);
    s.ws.send(JSON.stringify({ t: "mode", mode: "auto" })); await s.until((f) => f.some((x) => x.e?.type === "approval_mode" && x.e.mode === "auto"));
    expect((await state(id)).approvalMode).toBe("auto");
    s.ws.send(JSON.stringify({ t: "mode", mode: "ask" })); await s.until((f) => f.some((x) => x.e?.type === "approval_mode" && x.e.mode === "ask"));
    expect((await state(id)).approvalMode).toBe("ask");
    s.ws.send(JSON.stringify({ t: "mode", mode: "yolo" })); await s.until((f) => f.some((x) => x.t === "rejected" && x.error === "bad mode"));
  });
  it("Bypass: switch on and back over the socket, stored per chat, a different chat is still Ask", async () => {
    const id = "00000000-0000-4000-8000-0000000000c5", other = "00000000-0000-4000-8000-0000000000c6"; await mk(id, "main"); await mk(other, "main");
    const s = await socket(id);
    s.ws.send(JSON.stringify({ t: "mode", mode: "bypass", confirmed: true, confirmVersion: 1 })); await s.until((f) => f.some((x) => x.e?.type === "approval_mode" && x.e.mode === "bypass"));
    expect((await state(id)).approvalMode).toBe("bypass"); expect((await state(other)).approvalMode).toBe("ask");
    const rec = await e.DB.prepare(`SELECT value FROM settings WHERE name LIKE 'bypass_confirm:%' AND substr(name, -36) = ?`).bind(id).first(); expect(JSON.parse(rec.value)).toMatchObject({ conversationId: id, version: 1 }); // who/when/chat recorded
    s.ws.send(JSON.stringify({ t: "mode", mode: "ask" })); await s.until((f) => f.some((x) => x.e?.type === "approval_mode" && x.e.mode === "ask"));
  });
  it("a bare Bypass command (no confirmation, wrong version, confirmed not literally true) is rejected with a clear error; Ask/Auto need none", async () => {
    const id = "00000000-0000-4000-8000-0000000000c8"; await mk(id, "main");
    const s = await socket(id);
    for (const extra of [{}, { confirmed: true }, { confirmVersion: 1 }, { confirmed: "true", confirmVersion: 1 }, { confirmed: true, confirmVersion: 0 }, { confirmed: true, confirmVersion: 99 }]) {
      const n0 = s.frames.length; s.ws.send(JSON.stringify({ t: "mode", mode: "bypass", ...extra }));
      await s.until((f) => f.slice(n0).some((x) => x.t === "rejected" && /explicit confirmation/.test(x.error)));
    }
    expect((await state(id)).approvalMode).toBe("ask");
    expect(await e.DB.prepare(`SELECT COUNT(*) AS n FROM settings WHERE name LIKE 'bypass_confirm:%' AND substr(name, -36) = ?`).bind(id).first("n")).toBe(0);
    s.ws.send(JSON.stringify({ t: "mode", mode: "auto" })); await s.until((f) => f.some((x) => x.e?.type === "approval_mode" && x.e.mode === "auto"));
  });
  it("admin kill switch also refuses Bypass", async () => {
    const id = "00000000-0000-4000-8000-0000000000c7"; await mk(id, "e2e");
    await e.DB.prepare(`INSERT INTO settings (name, value) VALUES ('approval_auto:e2e','0') ON CONFLICT(name) DO UPDATE SET value='0'`).run();
    try {
      const s = await socket(id);
      for (const extra of [{}, { confirmed: true, confirmVersion: 1 }]) { // off for both a bare and a confirmed command
        const n0 = s.frames.length; s.ws.send(JSON.stringify({ t: "mode", mode: "bypass", ...extra })); await s.until((f) => f.slice(n0).some((x) => x.t === "rejected" && /Bypass approval is turned off/.test(x.error)));
      }
      expect((await state(id)).approvalMode).toBe("ask");
    } finally { await e.DB.prepare(`DELETE FROM settings WHERE name='approval_auto:e2e'`).run(); }
  });
  it("admin kill switch (settings approval_auto:<base> = 0): Auto is refused and the state says so", async () => {
    const id = "00000000-0000-4000-8000-0000000000c2"; await mk(id, "e2e");
    await e.DB.prepare(`INSERT INTO settings (name, value) VALUES ('approval_auto:e2e','0') ON CONFLICT(name) DO UPDATE SET value='0'`).run();
    try {
      const s = await socket(id);
      s.ws.send(JSON.stringify({ t: "mode", mode: "auto" })); await s.until((f) => f.some((x) => x.t === "rejected" && /turned off/.test(x.error)));
      expect(await state(id)).toMatchObject({ approvalMode: "ask", approvalAuto: false });
    } finally { await e.DB.prepare(`DELETE FROM settings WHERE name='approval_auto:e2e'`).run(); }
  });
});

describe("team user: no personal-connector text or tools reach the model", () => {
  it("the request a team conversation sends carries no personal-connector tool name, no tools from it, and no connector wording", async () => {
    stub(); const id = "00000000-0000-4000-8000-0000000000c3";
    await e.DB.prepare(`INSERT INTO team_users (uid, gateway_uid, email, status, created_at, last_login_at) VALUES (?,?,?,?,1,1)`).bind(UID, "gw-" + UID, "ann@example.com", "active").run();
    await mk(id, `g:${UID}`);
    const s = await socket(id); s.ws.send(JSON.stringify({ t: "send", text: "hello", model: "claude-sonnet-5-5" })); await s.until((f) => f.some((x) => x.e?.type === "turn_end"));
    const chat = bodies.find((b) => b.stream); expect(chat).toBeTruthy();
    const sys = JSON.stringify(chat.system); const tools = JSON.stringify(chat.tools ?? []);
    for (const n of PERSONAL) { expect(sys).not.toContain(n); expect(tools).not.toContain(n); }
    expect(sys).not.toMatch(/personal connector|approval card/i);
    expect(sys).toContain("create_artifact"); // the rest of the prompt is intact
  });
});
