// vclopen1 route tests (workerd)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { DeviceHub } from "../src/device-hub";
import worker from "../server/worker";
import { makeSession } from "../src/auth";
import { putUserKey } from "../src/user-keys";

// POST /bridge/llm/v1/messages in workerd: real D1, real DeviceHub DO (rate limiter + owner pin), GATEWAY replaced by a recording mock.
const e = env as any;
const ENC = "test-key-enc-secret-0123456789abcdef0123", ORIGIN = "https://app.test", GWKEY = "GW-KEY-SECRET-FAKE";
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
const settle = async () => { while (pending.length) await pending.shift(); await new Promise((r) => setTimeout(r, 20)); while (pending.length) await pending.shift(); };

type Seen = { url: string; headers: Record<string, string>; body: string; signal?: AbortSignal };
let seen: Seen[], gw: (s: Seen) => Response | Promise<Response>;
const mkGateway = () => ({ fetch: async (url: string, init: any) => { const s = { url, headers: { ...init.headers }, body: init.body, signal: init.signal } as Seen; seen.push(s); return gw(s); } });
const call = (req: Request, over: Record<string, unknown> = {}) => worker.fetch(req, { ...e, GATEWAY: mkGateway(), GATEWAY_KEY: GWKEY, KEY_ENC_SECRET: ENC, ...over }, ctx);
const enable = (base = "main", v = "1") => e.DB.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`vcl:${base}`, v).run();
const cookieOf = async (user = "example-user") => { const s = await makeSession(e, user, "github"); return { cookie: s.cookie.split(";")[0], csrf: s.session.csrf }; };
async function pair(over: Record<string, unknown> = {}, space: string | null = "open") { // vclspace1: these tests are about Open, so the device is minted in the open space (default for NEW devices is biz)
  const me = await cookieOf();
  const p = await call(new Request(ORIGIN + "/api/devices/pair", { method: "POST", headers: { cookie: me.cookie, origin: ORIGIN, "x-csrf-token": me.csrf, ...(space ? { "content-type": "application/json" } : {}) }, ...(space ? { body: JSON.stringify({ space }) } : {}) }), over);
  const { code } = (await p.json()) as { code: string };
  const r = await call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113." + Math.floor(Math.random() * 250) }, body: JSON.stringify({ code, name: "laptop" }) }));
  expect(r.status).toBe(201);
  return { ...((await r.json()) as { deviceId: string; token: string }), me };
}
const body = (o: object = {}) => JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...o });
const llm = (token: string | null, b: string = body(), headers: Record<string, string> = {}, over: Record<string, unknown> = {}) =>
  call(new Request(ORIGIN + "/bridge/llm/v1/messages?beta=true", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: b }), over);
const sseBody = (out = 42) => `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"output_tokens":1}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":${out}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
const sse = (t = sseBody()) => new Response(t, { headers: { "content-type": "text/event-stream" } });
const costRows = async () => (await e.DB.prepare(`SELECT run_id, executor, cost_usd, scope FROM cloud_costs WHERE executor='vcl'`).all()).results as any[];
// vclopen1: Open models through the device LLM bridge, flag `vcl_open:main`. Fake provider (global fetch stubbed), a FAKE user key stored through the real encrypted path. No real key, no network.
const KEY = "FAKE-USER-KEY-not-a-secret-123";
const setOpen = (v: string | null) => v === null ? e.DB.prepare(`DELETE FROM settings WHERE name='vcl_open:main'`).run() : e.DB.prepare(`INSERT INTO settings (name, value) VALUES ('vcl_open:main', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(v).run();
const MODEL = "groq:openai/gpt-oss-20b";
const sseChat = (usage: object | null = { prompt_tokens: 1000, completion_tokens: 50 }) => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
let provSeen: Array<{ url: string; auth: string | null; body: any }>, provReply: () => Response;
const stubProvider = () => vi.spyOn(globalThis, "fetch").mockImplementation((async (u: any, init: any) => { provSeen.push({ url: String(u), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "null")) }); return provReply(); }) as any);
const withKey = async (provider = "groq", origin = "https://api.groq.com") => { await e.DB.prepare(`DELETE FROM provider_user_keys`).run(); await putUserKey({ DB: e.DB, KEY_ENC_SECRET: ENC } as any, "main", provider, origin, KEY); };
const openBody = (o: object = {}) => body({ model: MODEL, stream: true, max_tokens: 1000, ...o });

beforeEach(async () => {
  vi.restoreAllMocks(); seen = []; gw = () => sse(); provSeen = []; provReply = () => sseChat(); await enable(); await setOpen(null);
  await e.DB.prepare(`DELETE FROM cloud_costs`).run(); await e.DB.prepare(`DELETE FROM settings WHERE name LIKE 'vcl_daily_usd:%'`).run();
});

describe("vclopen1: flag OFF (default)", () => {
  it("an Open id is refused like any other non-Claude model; the provider is never called", async () => {
    const d = await pair(); const f = stubProvider(); await withKey();
    const r = await llm(d.token, openBody());
    expect(r.status).toBe(400); expect(provSeen).toHaveLength(0); expect(seen).toHaveLength(0); f.mockRestore();
  });
  it("model list: Claude only, no Open ids", async () => {
    const d = await pair(); await withKey();
    const r = await call(new Request(ORIGIN + "/bridge/llm/v1/models", { headers: { authorization: `Bearer ${d.token}` } }));
    expect(r.status).toBe(200); expect(((await r.json()) as any).data.map((m: any) => m.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  });
});

describe("vclopen1: flag ON", () => {
  it("served by the user's own key (decrypted per call), gateway untouched, GATEWAY not required, notice header, cost row counted toward the cap", async () => {
    await setOpen("1"); const d = await pair(); await withKey(); stubProvider();
    const r = await llm(d.token, openBody(), {}, { GATEWAY: undefined, GATEWAY_KEY: undefined });
    expect(r.status).toBe(200); expect(r.headers.get("x-vcl-model-space")).toBe("open"); expect(r.headers.get("x-vcl-data-use-notice") ?? "").toContain("Groq");
    const text = await r.text(); expect(text).toContain("message_start"); expect(text).toContain("hi");
    await settle();
    expect(seen).toHaveLength(0); expect(provSeen).toHaveLength(1);
    expect(provSeen[0].url).toBe("https://api.groq.com/openai/v1/chat/completions"); expect(provSeen[0].auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(provSeen[0].body)).not.toContain("claude-"); expect(provSeen[0].body.model).toBe("openai/gpt-oss-20b");
    const rows = await costRows(); expect(rows).toHaveLength(1); expect(rows[0].executor).toBe("vcl"); expect(rows[0].cost_usd).toBeGreaterThan(0); // priced from the catalog or the fallback, never skipped
  });
  it("no user key => refused (a Worker secret is never used), provider never called", async () => {
    await setOpen("1"); const d = await pair(); await e.DB.prepare(`DELETE FROM provider_user_keys`).run(); stubProvider();
    const r = await llm(d.token, openBody(), {}, { PROVIDER_KEY_GROQ: "WORKER-SECRET-MUST-NOT-BE-USED" });
    expect(r.status).toBe(400); expect(provSeen).toHaveLength(0);
  });
  it("a model that is not in the provider's enabled list is refused", async () => {
    await setOpen("1"); const d = await pair(); await withKey(); stubProvider();
    expect((await llm(d.token, openBody({ model: "groq:not-a-listed-model" }))).status).toBe(400); expect(provSeen).toHaveLength(0);
  });
  it("non-stream Open request is refused (the adapter only streams)", async () => {
    await setOpen("1"); const d = await pair(); await withKey(); stubProvider();
    expect((await llm(d.token, openBody({ stream: false }))).status).toBe(400); expect(provSeen).toHaveLength(0);
  });
  it("Claude ids still go to the gateway exactly as before", async () => {
    await setOpen("1"); const d = await pair(); await withKey(); stubProvider();
    const r = await llm(d.token, body({ stream: true })); expect(r.status).toBe(200); await r.text(); await settle();
    expect(seen).toHaveLength(1); expect(provSeen).toHaveLength(0);
  });
  it("daily cap is fail-closed for Open: usage-less provider still costs money; an exhausted cap blocks before the provider is called", async () => {
    await setOpen("1"); const d = await pair(); await withKey(); stubProvider();
    provReply = () => sseChat(null); // provider reports NO usage
    const r = await llm(d.token, openBody()); await r.text(); await settle();
    const rows = await costRows(); expect(rows).toHaveLength(1); expect(rows[0].cost_usd).toBeGreaterThan(0);
    await e.DB.prepare(`INSERT INTO settings (name, value) VALUES ('vcl_daily_usd:main', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(String(rows[0].cost_usd / 2)).run();
    provSeen = []; const r2 = await llm(d.token, openBody()); expect(r2.status).toBe(429); expect(provSeen).toHaveLength(0);
  });
  it("provider errors map to our own fixed messages (no upstream text, no key)", async () => {
    await setOpen("1"); const d = await pair(); await withKey(); stubProvider();
    provReply = () => new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 401 });
    const r = await llm(d.token, openBody()); const t = await r.text();
    expect(r.status).toBe(502); expect(t).not.toContain(KEY);
  });
  it("model list: Claude three + the Open models usable with the user's key, each with tools flag and notice", async () => {
    await setOpen("1"); const d = await pair(); await withKey();
    const r = await call(new Request(ORIGIN + "/bridge/llm/v1/models", { headers: { authorization: `Bearer ${d.token}` } }));
    const j = (await r.json()) as any; expect(r.status).toBe(200);
    expect(j.data.slice(0, 3).map((m: any) => m.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    const open = j.data.slice(3); expect(open.length).toBeGreaterThan(0);
    for (const m of open) { expect(m.id).toMatch(/^groq:/); expect(typeof m.tools).toBe("boolean"); expect(m.data_use_notice).toContain("Groq"); }
    expect(JSON.stringify(j)).not.toContain(KEY);
    expect((await call(new Request(ORIGIN + "/bridge/llm/v1/models", { headers: { authorization: "Bearer vcl_bad" } }))).status).toBe(401);
  });
});
