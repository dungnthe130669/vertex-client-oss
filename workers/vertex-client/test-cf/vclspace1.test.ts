// vclspace1: per-device space for Open (workerd). Same fixtures as bridge-llm-open.test.ts.
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
const KEY = "FAKE-USER-KEY-not-a-secret-123", MODEL = "groq:openai/gpt-oss-20b";
const setOpen = (v: string | null) => v === null ? e.DB.prepare(`DELETE FROM settings WHERE name='vcl_open:main'`).run() : e.DB.prepare(`INSERT INTO settings (name, value) VALUES ('vcl_open:main', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(v).run();
const sseChat = () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 50 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
let provSeen: unknown[];
const stubProvider = () => vi.spyOn(globalThis, "fetch").mockImplementation((async (u: any, init: any) => { provSeen.push({ url: String(u), body: init?.body }); return sseChat(); }) as any);
const withKey = async () => { await e.DB.prepare(`DELETE FROM provider_user_keys`).run(); await putUserKey({ DB: e.DB, KEY_ENC_SECRET: ENC } as any, "main", "groq", "https://api.groq.com", KEY); };
const openBody = (o: object = {}) => body({ model: MODEL, stream: true, max_tokens: 1000, ...o });
const models = async (token: string) => ((await (await call(new Request(ORIGIN + "/bridge/llm/v1/models", { headers: { authorization: `Bearer ${token}` } }))).json()) as any).data.map((m: any) => m.id) as string[];
/** Legacy = a device row paired before the column existed: space NULL. */
const legacy = async (id: string) => e.DB.prepare(`UPDATE devices SET space=NULL WHERE id=?`).bind(id).run();
const spaceOf = async (id: string) => (await e.DB.prepare(`SELECT space FROM devices WHERE id=?`).bind(id).first())?.space;

beforeEach(async () => { vi.restoreAllMocks(); seen = []; gw = () => sse(); provSeen = []; await enable(); await setOpen("1"); await withKey(); await e.DB.prepare(`DELETE FROM cloud_costs`).run(); });

describe("vclspace1: device space", () => {
  it("pairing records the space: default biz, explicit open, junk refused", async () => {
    const dflt = await pair({}, null); expect(await spaceOf(dflt.deviceId)).toBe("biz");
    const op = await pair({}, "open"); expect(await spaceOf(op.deviceId)).toBe("open");
    const me = await cookieOf();
    const bad = await call(new Request(ORIGIN + "/api/devices/pair", { method: "POST", headers: { cookie: me.cookie, origin: ORIGIN, "x-csrf-token": me.csrf, "content-type": "application/json" }, body: JSON.stringify({ space: "OPEN" }) }));
    expect(bad.status).toBe(400);
  });
  it("biz device: flag on and a usable key, still denied Open (provider never called) and the model list has Claude only; Claude still works", async () => {
    const d = await pair({}, "biz"); stubProvider();
    const r = await llm(d.token, openBody());
    expect(r.status).toBe(400); expect(provSeen).toHaveLength(0);
    expect(await models(d.token)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    expect((await llm(d.token)).status).toBe(200); expect(seen).toHaveLength(1);
  });
  it("open device: served by the user's key, and sees the Open models", async () => {
    const d = await pair({}, "open"); stubProvider();
    expect((await llm(d.token, openBody())).status).toBe(200); await settle(); expect(provSeen).toHaveLength(1);
    expect((await models(d.token)).some((m) => m.startsWith("groq:"))).toBe(true);
  });
  it("cross-space denial: a biz and an open device of the same owner, same key, same flag: only the open one reaches the key", async () => {
    const biz = await pair({}, "biz"), op = await pair({}, "open"); stubProvider();
    expect((await llm(biz.token, openBody())).status).toBe(400); expect(provSeen).toHaveLength(0);
    expect((await llm(op.token, openBody())).status).toBe(200); await settle(); expect(provSeen).toHaveLength(1);
  });
  it("existing device (space NULL) keeps the vclopen1 behaviour: flag decides", async () => {
    const d = await pair({}, "biz"); await legacy(d.deviceId); stubProvider();
    expect(await spaceOf(d.deviceId)).toBeNull();
    expect((await llm(d.token, openBody())).status).toBe(200); await settle(); expect(provSeen).toHaveLength(1);
    await setOpen(null); expect((await llm(d.token, openBody())).status).toBe(400); // flag off still the master switch
  });
  it("flag off: an open device gets nothing (master switch)", async () => {
    const d = await pair({}, "open"); await setOpen(null); stubProvider();
    expect((await llm(d.token, openBody())).status).toBe(400); expect(provSeen).toHaveLength(0);
    expect(await models(d.token)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  });
  it("corrupt space value or missing row is denied (fail closed)", async () => {
    const d = await pair({}, "open"); await e.DB.prepare(`UPDATE devices SET space='open ' WHERE id=?`).bind(d.deviceId).run(); stubProvider();
    expect((await llm(d.token, openBody())).status).toBe(400); expect(provSeen).toHaveLength(0);
  });
});
