// gateopt1: a self-hoster with NO Vertex gateway (GATEWAY / GATEWAY_KEY absent) boots, logs in, lists no Vertex models, gets a typed error for a Vertex
// request, and still chats through an Open provider with their own key. workerd test env has no GATEWAY service binding (vitest.config.ts strips it).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createApp, GATEWAY_ABSENT } from "../src/index";
import worker from "../server/worker";
import { makeSession } from "../src/auth";
import { putUserKey } from "../src/user-keys";

const e = { ...(env as any), ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY: undefined, GATEWAY_KEY: undefined };
const ORIGIN = "https://app.test", ENC = "test-key-enc-secret-0123456789abcdef0123";
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
async function api(space?: string) {
  const app = createApp();
  const { cookie, session } = await makeSession(e, "example-user", "github");
  return (method: string, path: string, body?: unknown) => app.fetch(new Request(ORIGIN + path, { method, headers: { cookie: cookie.split(";")[0], "x-csrf-token": session.csrf, origin: ORIGIN, "content-type": "application/json", ...(space ? { "x-vc-space": space } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), e, ctx);
}

describe("gateopt1: no GATEWAY binding", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("boots: /auth/config answers without the gateway", async () => {
    const r = await createApp().fetch(new Request(ORIGIN + "/auth/config"), e, ctx);
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ github: expect.any(Boolean) });
  });
  it("Business model list: no Vertex models, a typed 503 with a clear message (never a crash, never an empty picker without a reason)", async () => {
    const f = await api(); const r = await f("GET", "/api/models");
    expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: GATEWAY_ABSENT });
    const p = await f("GET", "/api/providers"); expect(p.status).toBe(200);
    expect(((await p.json()) as any).providers.some((x: any) => x.id === "gateway")).toBe(false);
  });
  it("Open model list: 200, no gateway model", async () => {
    const f = await api("open"); const r = await f("GET", "/api/models");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).models.some((m: any) => m.provider === "gateway")).toBe(false);
  });
  it("a Vertex request on the device bridge is a typed 503 'not configured'", async () => {
    await e.DB.prepare(`INSERT INTO settings (name, value) VALUES ('vcl:main','1') ON CONFLICT(name) DO UPDATE SET value='1'`).run();
    const me = await makeSession(e, "example-user", "github"); const hdr = { cookie: me.cookie.split(";")[0], origin: ORIGIN, "x-csrf-token": me.session.csrf };
    const pr = await worker.fetch(new Request(ORIGIN + "/api/devices/pair", { method: "POST", headers: { ...hdr, "content-type": "application/json" }, body: JSON.stringify({ space: "biz" }) }), e, ctx);
    const { code } = (await pr.json()) as { code: string };
    const dr = await worker.fetch(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" }, body: JSON.stringify({ code, name: "laptop" }) }), e, ctx);
    const { token } = (await dr.json()) as { token: string };
    const r = await worker.fetch(new Request(ORIGIN + "/bridge/llm/v1/messages", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }) }), e, ctx);
    expect(r.status).toBe(503); expect(JSON.stringify(await r.json())).toContain("model provider not configured");
  });
  it("Open provider chat with the user's own key still works with no gateway (stubbed provider, fake key)", async () => {
    await e.DB.prepare(`INSERT INTO settings (name, value) VALUES ('vcl:main','1') ON CONFLICT(name) DO UPDATE SET value='1'`).run();
    await e.DB.prepare(`INSERT INTO settings (name, value) VALUES ('vcl_open:main','1') ON CONFLICT(name) DO UPDATE SET value='1'`).run();
    await putUserKey({ DB: e.DB, KEY_ENC_SECRET: ENC } as any, "main", "groq", "https://api.groq.com", "FAKE-USER-KEY-not-a-secret-123");
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (u: any) => { seen.push(String(u)); return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }); }) as any);
    const me = await makeSession(e, "example-user", "github"); const hdr = { cookie: me.cookie.split(";")[0], origin: ORIGIN, "x-csrf-token": me.session.csrf };
    const pr = await worker.fetch(new Request(ORIGIN + "/api/devices/pair", { method: "POST", headers: { ...hdr, "content-type": "application/json" }, body: JSON.stringify({ space: "open" }) }), { ...e, KEY_ENC_SECRET: ENC }, ctx);
    const { code } = (await pr.json()) as { code: string };
    const dr = await worker.fetch(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.78" }, body: JSON.stringify({ code, name: "laptop2" }) }), e, ctx);
    const { token } = (await dr.json()) as { token: string };
    const r = await worker.fetch(new Request(ORIGIN + "/bridge/llm/v1/messages?beta=true", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "groq:openai/gpt-oss-20b", stream: true, max_tokens: 1000, messages: [{ role: "user", content: "hi" }] }) }), { ...e, KEY_ENC_SECRET: ENC }, ctx);
    expect(r.status).toBe(200); expect(await r.text()).toContain("hi"); expect(seen.some((u) => u.includes("api.groq.com"))).toBe(true);
  });
});
