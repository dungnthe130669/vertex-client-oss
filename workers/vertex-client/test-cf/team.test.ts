import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { sse, textEvents } from "../src/providers/stub";
import { clearEntitlementCache } from "../src/providers/team-gateway";
// Team scope through the REAL ChatSession DO in workerd: a g:<uid> conversation acts as its team_users email through the team gateway (fake fetch here, FAKE keys),
// never with Erich's GATEWAY_KEY; no row / disabled user / denied feature / gateway down => the turn errors and NOTHING is sent or billed. Same isolate as the DO, so
// stubbing globalThis.fetch is what the DO's act-as fetcher sees (no service binding in the test config).
const e = env as any;
const UID = "abcdef0123456789abcdef01";
const EMAIL = "ann@example.com";
const seen: Array<{ path: string; auth: string | null; actAs: string | null; apiKey: string | null }> = [];
let features: string[] | "down" | "garbage" = ["vclient_app", "chat"];
const stub = () => vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
  const u = new URL(String(input)); const h = new Headers(init.headers);
  seen.push({ path: u.pathname, auth: h.get("authorization"), actAs: h.get("x-act-as"), apiKey: h.get("x-api-key") });
  if (features === "down") throw new Error("down");
  if (u.pathname === "/v1/entitlements") return features === "garbage" ? new Response("<html>") : Response.json({ features });
  if (u.pathname === "/v1/messages") return sse(textEvents("claude-sonnet-5-5", "hi from team", { input_tokens: 3, output_tokens: 3 }));
  return new Response("{}", { status: 404 });
});
// The shared test env has NO team config (Erich's-instance parity, e.g. test-cf/gate.test.ts expects /auth/config without team); this file turns it on for itself only.
beforeAll(() => { e.TEAM_GATEWAY_URL = "https://tg.test"; e.VCLIENT_TEAM_CALLER_KEY = "CALLER-KEY-FAKE"; });
afterAll(() => { delete e.TEAM_GATEWAY_URL; delete e.VCLIENT_TEAM_CALLER_KEY; });
afterEach(() => { vi.unstubAllGlobals(); seen.length = 0; features = ["vclient_app", "chat"]; clearEntitlementCache(); });

async function socket(id: string) {
  const r = await e.CHAT.get(e.CHAT.idFromName(id)).fetch(new Request("https://do.internal/ws?since=0", { headers: { upgrade: "websocket", "x-conv-id": id } }));
  expect(r.status).toBe(101);
  const ws = r.webSocket!; ws.accept();
  const frames: any[] = [];
  ws.addEventListener("message", (m: MessageEvent) => frames.push(JSON.parse(String(m.data))));
  const until = async (pred: (f: any[]) => boolean, ms = 8000) => { const t0 = Date.now(); while (!pred(frames)) { if (Date.now() - t0 > ms) throw new Error("timeout; frames=" + JSON.stringify(frames.map((f) => f.e?.type ?? f.t))); await new Promise((r) => setTimeout(r, 25)); } };
  await until((f) => f.some((x) => x.t === "hello"));
  return { ws, frames, until };
}
const mk = async (id: string, scope: string) => { await e.DB.prepare(`INSERT INTO conversations (id, model, scope) VALUES (?,?,?)`).bind(id, "claude-sonnet-5-5", scope).run(); };
const user = async (uid: string, email: string, status = "active") => { await e.DB.prepare(`INSERT INTO team_users (uid, gateway_uid, email, status, created_at, last_login_at) VALUES (?,?,?,?,1,1)`).bind(uid, "gw-" + uid, email, status).run(); };
const turn = async (id: string) => { const s = await socket(id); s.ws.send(JSON.stringify({ t: "send", text: "hello", model: "claude-sonnet-5-5" })); await s.until((f) => f.some((x) => x.e?.type === "turn_end")); return s.frames.find((x) => x.e?.type === "turn_end").e; };
const usageRows = async (id: string) => ((await e.DB.prepare(`SELECT COUNT(*) AS n FROM usage WHERE conversation_id=?`).bind(id).first()) as any).n;

describe("ChatSession DO: team act-as", () => {
  it("happy path: the turn runs, calls carry ONLY caller key + x-act-as (session user's email), usage lands in g:<uid>", async () => {
    stub(); await user(UID, EMAIL); const id = "00000000-0000-4000-8000-0000000000b1"; await mk(id, `g:${UID}`);
    const end = await turn(id);
    expect(end.status).toBe("done");
    const msg = seen.filter((c) => c.path === "/v1/messages"); expect(msg.length).toBeGreaterThanOrEqual(1); // the reply (+ the title call)
    for (const c of seen) { expect(c.auth).toBe("Bearer CALLER-KEY-FAKE"); expect(c.actAs).toBe(EMAIL); expect(c.apiKey).toBeNull(); }
    expect(await usageRows(id)).toBe(1);
    expect(((await e.DB.prepare(`SELECT scope FROM usage WHERE conversation_id=?`).bind(id).first()) as any).scope).toBe(`g:${UID}`);
  });
  const refused = (name: string, setup: () => Promise<void> | void, id: string, scope: string, msg: RegExp) =>
    it(`${name}: errors, no /v1/messages, nothing billed, no slot left`, async () => {
      stub(); await setup(); await mk(id, scope);
      const end = await turn(id);
      expect(end.status).toBe("error"); expect(String(end.error?.message ?? "")).toMatch(msg);
      expect(seen.some((c) => c.path === "/v1/messages")).toBe(false);
      expect(await usageRows(id)).toBe(0);
      expect(((await e.DB.prepare(`SELECT COUNT(*) AS n FROM active_turns WHERE conversation_id=?`).bind(id).first()) as any).n).toBe(0);
    });
  refused("no team_users row", () => {}, "00000000-0000-4000-8000-0000000000b2", "g:" + "b".repeat(24), /no provider for scope/);
  refused("disabled team user", () => user("c".repeat(24), "dis@example.com", "disabled"), "00000000-0000-4000-8000-0000000000b3", "g:" + "c".repeat(24), /no provider for scope/);
  refused("chat feature revoked", () => { features = ["vclient_app"]; return user("d".repeat(24), "nochat@example.com"); }, "00000000-0000-4000-8000-0000000000b4", "g:" + "d".repeat(24), /does not have access/);
  refused("gateway down (fail closed)", () => { features = "down"; return user("e".repeat(24), "down@example.com"); }, "00000000-0000-4000-8000-0000000000b5", "g:" + "e".repeat(24), /unavailable/);
  refused("gateway answers garbage (fail closed)", () => { features = "garbage"; return user("f".repeat(24), "garb@example.com"); }, "00000000-0000-4000-8000-0000000000b6", "g:" + "f".repeat(24), /unavailable/);
  it("a user cannot borrow another user's email: two conversations act as their own owners", async () => {
    stub(); await user("1".repeat(24), "one@example.com"); await user("2".repeat(24), "two@example.com");
    const a = "00000000-0000-4000-8000-0000000000b7", b = "00000000-0000-4000-8000-0000000000b8"; await mk(a, "g:" + "1".repeat(24)); await mk(b, "g:" + "2".repeat(24));
    await turn(a); await turn(b);
    expect([...new Set(seen.filter((c) => c.path === "/v1/messages").map((c) => c.actAs))]).toEqual(["one@example.com", "two@example.com"]);
  });
});
