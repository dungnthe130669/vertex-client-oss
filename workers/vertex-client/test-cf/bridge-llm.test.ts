import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { DeviceHub } from "../src/device-hub";
import worker from "../server/worker";
import { makeSession } from "../src/auth";

// POST /bridge/llm/v1/messages in workerd: real D1, real DeviceHub DO (rate limiter + owner pin), GATEWAY replaced by a recording mock.
const e = env as any;
const ORIGIN = "https://app.test", GWKEY = "GW-KEY-SECRET-FAKE";
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
const settle = async () => { while (pending.length) await pending.shift(); await new Promise((r) => setTimeout(r, 20)); while (pending.length) await pending.shift(); };

type Seen = { url: string; headers: Record<string, string>; body: string; signal?: AbortSignal };
let seen: Seen[], gw: (s: Seen) => Response | Promise<Response>;
const mkGateway = () => ({ fetch: async (url: string, init: any) => { const s = { url, headers: { ...init.headers }, body: init.body, signal: init.signal } as Seen; seen.push(s); return gw(s); } });
const call = (req: Request, over: Record<string, unknown> = {}) => worker.fetch(req, { ...e, GATEWAY: mkGateway(), GATEWAY_KEY: GWKEY, ...over }, ctx);
const enable = (base = "main", v = "1") => e.DB.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`vcl:${base}`, v).run();
const cookieOf = async (user = "example-user") => { const s = await makeSession(e, user, "github"); return { cookie: s.cookie.split(";")[0], csrf: s.session.csrf }; };
async function pair(over: Record<string, unknown> = {}) {
  const me = await cookieOf();
  const p = await call(new Request(ORIGIN + "/api/devices/pair", { method: "POST", headers: { cookie: me.cookie, origin: ORIGIN, "x-csrf-token": me.csrf } }), over);
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

beforeEach(async () => {
  seen = []; gw = () => sse(); await enable();
  await e.DB.prepare(`DELETE FROM cloud_costs`).run(); await e.DB.prepare(`DELETE FROM settings WHERE name LIKE 'vcl_daily_usd:%'`).run();
  vi.restoreAllMocks();
});

describe("auth + flag", () => {
  it("valid token: streams the upstream bytes through unchanged, upstream sees only our key + allow-listed headers", async () => {
    const d = await pair(); const logs = vi.spyOn(console, "log"), errs = vi.spyOn(console, "error");
    const r = await llm(d.token, body({ stream: true }), { "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31", cookie: "x=y", "x-evil": "1" });
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(await r.text()).toBe(sseBody());
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://gateway.internal/v1/messages");
    expect(seen[0].headers).toEqual({ "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31", "x-api-key": GWKEY });
    expect(JSON.parse(seen[0].body).stream).toBe(true);
    const all = JSON.stringify([logs.mock.calls, errs.mock.calls]);
    expect(all).not.toContain(d.token); expect(all).not.toContain(GWKEY);
  });
  it("non-streaming: body forwarded without forcing stream, JSON returned", async () => {
    const d = await pair();
    gw = () => Response.json({ id: "m1", type: "message", content: [{ type: "text", text: "yo" }], usage: { input_tokens: 10, output_tokens: 5 } });
    const r = await llm(d.token);
    expect(r.status).toBe(200); expect(((await r.json()) as any).id).toBe("m1");
    expect(JSON.parse(seen[0].body).stream).toBeUndefined();
    await settle(); expect(await costRows()).toHaveLength(1);
  });
  it("bad, malformed, missing, revoked and other-device tokens are one uniform 401", async () => {
    const d = await pair(); const other = await pair();
    const flip = d.token.slice(0, -1) + (d.token.endsWith("A") ? "B" : "A");
    const bodies = new Set<string>();
    for (const t of [null, "junk", flip, "vcl_" + "0".repeat(32) + "." + "A".repeat(43)]) { const r = await llm(t); expect(r.status).toBe(401); bodies.add(await r.text()); }
    expect(bodies.size).toBe(1);
    expect((await llm(d.token)).status).toBe(200); await settle();
    // another user's device token cannot be replayed against this device's id
    const mixed = `vcl_${d.deviceId}.${other.token.split(".")[1]}`; expect((await llm(mixed)).status).toBe(401);
    const del = await call(new Request(`${ORIGIN}/api/devices/${d.deviceId}`, { method: "DELETE", headers: { cookie: d.me.cookie, origin: ORIGIN, "x-csrf-token": d.me.csrf } })); expect(del.status).toBe(200);
    const r = await llm(d.token); expect(r.status).toBe(401); expect(await r.text()).toBe([...bodies][0]);
    expect(seen).toHaveLength(1);
  });
  it("idle-expired token => 401", async () => {
    const d = await pair();
    await e.DB.prepare(`UPDATE devices SET last_seen=? WHERE id=?`).bind(Math.floor(Date.now() / 1000) - 31 * 24 * 3600, d.deviceId).run();
    expect((await llm(d.token)).status).toBe(401);
  });
  it("flag off (row '0' and no row) => plain 404, nothing forwarded; back on works", async () => {
    const d = await pair();
    await enable("main", "0"); expect((await llm(d.token)).status).toBe(404);
    await e.DB.prepare(`DELETE FROM settings WHERE name='vcl:main'`).run(); expect((await llm(d.token)).status).toBe(404);
    expect(seen).toHaveLength(0);
    await enable(); expect((await llm(d.token)).status).toBe(200);
  });
  it("other /bridge paths and methods are 404; no GATEWAY => 503", async () => {
    const d = await pair();
    expect((await call(new Request(ORIGIN + "/bridge/llm/v1/other", { method: "POST", headers: { authorization: `Bearer ${d.token}` } }))).status).toBe(404);
    expect((await call(new Request(ORIGIN + "/bridge/llm/v1/messages", { method: "GET" }))).status).toBe(404);
    expect((await llm(d.token, body(), {}, { GATEWAY: undefined })).status).toBe(503);
  });
});

describe("request policing", () => {
  it("model outside the allow-list => 400 (nothing upstream); allowed ids pass", async () => {
    const d = await pair();
    for (const m of ["claude-opus-4-1", "gpt-6.1-sol", "claude-sonnet-5-5-x"]) { const r = await llm(d.token, body({ model: m })); expect(r.status).toBe(400); }
    expect(seen).toHaveLength(0);
    for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) expect((await llm(d.token, body({ model: m }))).status).toBe(200);
    await settle();
  });
  it("max_tokens over the cap => 400; body over 4 MB => 413 (Content-Length and counted stream)", async () => {
    const d = await pair();
    expect((await llm(d.token, body({ max_tokens: 1_000_000 }))).status).toBe(400);
    const big = body({ pad: "x".repeat(4 * 1024 * 1024 + 10) });
    expect((await llm(d.token, big)).status).toBe(413);
    const chunked = new Request(ORIGIN + "/bridge/llm/v1/messages", { method: "POST", headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }), duplex: "half" } as any);
    expect((await call(chunked)).status).toBe(413);
    expect(seen).toHaveLength(0);
  });
  it("rate limit: the 61st request in a minute => 429 with retry-after; concurrency cap 4 => 429", async () => {
    const d = await pair(); gw = () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    for (let i = 0; i < 60; i++) expect((await llm(d.token)).status).toBe(200);
    const r = await llm(d.token); expect(r.status).toBe(429); expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    await settle();
    const d2 = await pair(); const held: Array<() => void> = [];
    gw = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n")); held.push(() => c.close()); } }), { headers: { "content-type": "text/event-stream" } });
    const open = await Promise.all([1, 2, 3, 4].map(() => llm(d2.token, body({ stream: true }))));
    expect(open.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect((await llm(d2.token, body({ stream: true }))).status).toBe(429);
    for (const h of held) h(); for (const o of open) await o.text(); await settle();
    expect((await llm(d2.token, body({ stream: true }))).status).toBe(200); held.forEach((h) => { try { h(); } catch { /* */ } });
  }, 60_000);
});

describe("upstream behaviour", () => {
  it("upstream 500 => clean 502, no upstream text/secret; 429 => 429 clean; 400 => 400 clean; throw => 502", async () => {
    const d = await pair();
    gw = () => new Response(JSON.stringify({ error: { message: `boom ${GWKEY} internal-stack` } }), { status: 500 });
    let r = await llm(d.token); let t = await r.text(); expect(r.status).toBe(502); expect(JSON.parse(t).error.type).toBe("api_error"); expect(t).not.toContain("boom"); expect(t).not.toContain(GWKEY);
    gw = () => new Response("secret upstream detail", { status: 429, headers: { "retry-after": "7" } });
    r = await llm(d.token); t = await r.text(); expect([r.status, r.headers.get("retry-after")]).toEqual([429, "7"]); expect(t).not.toContain("secret upstream");
    gw = () => new Response("upstream says: nope", { status: 400 });
    r = await llm(d.token); t = await r.text(); expect(r.status).toBe(400); expect(t).not.toContain("upstream says");
    gw = () => { throw new Error("connect failed " + GWKEY); };
    r = await llm(d.token); t = await r.text(); expect(r.status).toBe(502); expect(t).not.toContain(GWKEY);
    expect(await costRows()).toHaveLength(0);
  });
  it("client cancelling the stream aborts the upstream request; what streamed is billed once", async () => {
    const d = await pair(); let aborted = false;
    gw = (s) => { s.signal?.addEventListener("abort", () => { aborted = true; }); return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sseBody().split("event: content_block_delta")[0])); } }), { headers: { "content-type": "text/event-stream" } }); };
    const r = await llm(d.token, body({ stream: true }));
    const rd = r.body!.getReader(); await rd.read(); await rd.cancel(); await settle();
    expect(aborted).toBe(true);
    const rows = await costRows(); expect(rows).toHaveLength(1); expect(rows[0].cost_usd).toBeGreaterThan(0);
  });
  it("aborting the incoming request signal aborts the upstream fetch", async () => {
    const d = await pair(); let aborted = false, reached = false;
    gw = (s) => new Promise<Response>((_res, rej) => { reached = true; s.signal?.addEventListener("abort", () => { aborted = true; rej(new DOMException("aborted", "AbortError")); }); });
    const ac = new AbortController();
    const p = call(new Request(ORIGIN + "/bridge/llm/v1/messages", { method: "POST", signal: ac.signal, headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" }, body: body() }));
    for (let i = 0; i < 100 && !reached; i++) await new Promise((r) => setTimeout(r, 50)); // abort only once the upstream call is in flight (a fixed 100 ms flaked under suite load: the listener was attached after the abort fired)
    expect(reached).toBe(true); ac.abort();
    await Promise.race([p.catch(() => null), new Promise((r) => setTimeout(r, 500))]); await settle();
    expect(aborted).toBe(true);
  });
  it("revoking mid-stream ends the stream at the next re-check", async () => {
    const d = await pair(); let aborted = false; let push!: (s: string) => void;
    gw = (s) => { s.signal?.addEventListener("abort", () => { aborted = true; }); return new Response(new ReadableStream({ start(c) { push = (x) => c.enqueue(new TextEncoder().encode(x)); push("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n\n"); } }), { headers: { "content-type": "text/event-stream" } }); };
    const r = await llm(d.token, body({ stream: true })); const rd = r.body!.getReader(); await rd.read();
    await e.DB.prepare(`UPDATE devices SET revoked_at=? WHERE id=?`).bind(Math.floor(Date.now() / 1000), d.deviceId).run();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6000 });
    try { push("event: ping\ndata: {}\n\n"); await expect((async () => { for (;;) { const x = await rd.read(); if (x.done) return "done"; } })()).rejects.toThrow(); } finally { vi.useRealTimers(); }
    await settle(); expect(aborted).toBe(true);
  });
});

describe("accounting + daily cap", () => {
  it("one cloud_costs row per request under the owner's scope, executor 'vcl', priced by costOf", async () => {
    const d = await pair();
    const r = await llm(d.token, body({ stream: true })); await r.text(); await settle();
    const rows = await costRows(); expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("main"); expect(rows[0].run_id).toMatch(new RegExp(`^vcl:${d.deviceId}:`));
    expect(rows[0].cost_usd).toBeCloseTo((1000 * 2 + 42 * 10) / 1e6, 6); // sonnet-5-5 price in MODELS_META
  });
  it("daily soft cap: over => 429 with a clear message; a raised cap lets it through; other devices unaffected", async () => {
    const d = await pair(), other = await pair();
    await e.DB.prepare(`INSERT INTO cloud_costs (run_id, executor, cost_usd, scope) VALUES (?, 'vcl', 5.5, 'main')`).bind(`vcl:${d.deviceId}:seed`).run();
    const r = await llm(d.token); expect(r.status).toBe(429); expect(((await r.json()) as any).error.message).toMatch(/daily budget/); expect(seen).toHaveLength(0);
    expect((await llm(other.token)).status).toBe(200);
    await e.DB.prepare(`INSERT INTO settings (name, value) VALUES ('vcl_daily_usd:main','10')`).run();
    expect((await llm(d.token)).status).toBe(200); await settle();
    await e.DB.prepare(`INSERT OR REPLACE INTO settings (name, value) VALUES ('vcl_daily_usd:main','0')`).run();
    expect((await llm(d.token)).status).toBe(429);
  });
  it("yesterday's spend does not count", async () => {
    const d = await pair();
    await e.DB.prepare(`INSERT INTO cloud_costs (run_id, executor, cost_usd, scope, created_at) VALUES (?, 'vcl', 50, 'main', datetime('now','-2 days'))`).bind(`vcl:${d.deviceId}:old`).run();
    expect((await llm(d.token)).status).toBe(200); await settle();
  });
});

describe("round 2: interrupted-stream billing", () => {
  const chunk = (n: number) => `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${"x".repeat(n)}"}}\n\n`;
  const head = `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n`;
  it("cancel after N generated chars: the row is at least the estimate (not the provisional ~$0.00042 of the review)", async () => {
    const d = await pair();
    gw = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(head + chunk(30000))); } }), { headers: { "content-type": "text/event-stream" } });
    const r = await llm(d.token, body({ model: "claude-opus-5-5", stream: true })); const rd = r.body!.getReader();
    let got = 0; while (got < 30000) { const x = await rd.read(); if (x.done) break; got += x.value.length; }
    await rd.cancel(); await settle();
    const rows = await costRows(); expect(rows).toHaveLength(1);
    const est = (100 * 5 + Math.ceil(30000 / 3) * 20) / 1e6; // opus-5-5: input 4 (cacheWrite 5 not used: no cache tokens) -> 100 * 4
    expect(rows[0].cost_usd).toBeGreaterThanOrEqual((100 * 4 + 10000 * 20) / 1e6 - 1e-9); expect(rows[0].cost_usd).toBeGreaterThan(est * 0.9);
    expect(rows[0].cost_usd).toBeGreaterThan(0.00042 * 100);
  });
  it("final usage present: billed exactly from it", async () => {
    const d = await pair();
    gw = () => sse(head + chunk(30000) + `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n`);
    await (await llm(d.token, body({ model: "claude-opus-5-5", stream: true }))).text(); await settle();
    expect((await costRows())[0].cost_usd).toBeCloseTo((100 * 4 + 7 * 20) / 1e6, 9);
  });
});

describe("round 2: persisted admissions, body before slot, reservations", () => {
  const openStream = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
  const stubOf = (id: string) => e.DEVICES.get(e.DEVICES.idFromName(id));
  const hdr = (d: { deviceId: string }) => ({ "x-vcl-device": d.deviceId, "x-vcl-scope": "main", "x-vcl-user": "example-user" });
  const acquire = (fresh: DeviceHub | { fetch(r: Request): Promise<Response> }, d: { deviceId: string }, id: string, cap = 5, reserve = 0.01) =>
    fresh.fetch(new Request(`https://do.internal/llm/acquire?id=${id}&cap=${cap}&reserve=${reserve}`, { method: "POST", headers: hdr(d) })).then((r) => r.json() as Promise<any>);

  it("admissions survive DO reconstruction: a fresh DeviceHub over the same storage still counts the 4 open requests, and a release frees one", async () => {
    const d = await pair(); gw = () => openStream();
    const open = await Promise.all([1, 2, 3, 4].map(() => llm(d.token, body({ stream: true })))); expect(open.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    const seenByFresh = await runInDurableObject(stubOf(d.deviceId), async (_inst: DeviceHub, state: DurableObjectState) => {
      const fresh = new DeviceHub(state, e); // what a hibernated DO becomes: same storage, empty memory
      return acquire(fresh, d, "fresh-request-0001");
    });
    expect(seenByFresh).toMatchObject({ ok: false, reason: "concurrent" });
    expect((await llm(d.token, body({ stream: true }))).status).toBe(429);
    for (const o of open) await o.body!.cancel(); await settle();
    expect((await llm(d.token, body({ stream: true }))).status).toBe(200);
  });
  it("a lease that lapsed (request crashed) frees its slot; one that has not does not", async () => {
    const d = await pair();
    await runInDurableObject(stubOf(d.deviceId), async (_inst: DeviceHub, state: DurableObjectState) => {
      const fresh = new DeviceHub(state, e);
      for (let i = 0; i < 4; i++) expect((await acquire(fresh, d, "lease-test-000" + i)).ok).toBe(true);
      expect((await acquire(fresh, d, "lease-test-0009")).ok).toBe(false);
      state.storage.sql.exec(`UPDATE llm_open SET lease_until = ? WHERE id = 'lease-test-0000'`, Date.now() - 1);
      expect((await acquire(fresh, d, "lease-test-0010")).ok).toBe(true);
      expect((await acquire(fresh, d, "lease-test-0011")).ok).toBe(false);
    });
  });
  it("the rate window is persisted too: a reconstructed DO still has the 60 hits", async () => {
    const d = await pair();
    await runInDurableObject(stubOf(d.deviceId), async (_inst: DeviceHub, state: DurableObjectState) => {
      const f1 = new DeviceHub(state, e);
      for (let i = 0; i < 60; i++) { const a = await acquire(f1, d, "rate-test-" + String(i).padStart(4, "0")); expect(a.ok).toBe(true); await f1.fetch(new Request(`https://do.internal/llm/release?id=rate-test-${String(i).padStart(4, "0")}`, { method: "POST", headers: hdr(d) })); }
      expect(await acquire(new DeviceHub(state, e), d, "rate-test-9999")).toMatchObject({ ok: false, reason: "rate" });
    });
  });
  it("slow / half-sent bodies hold no slot: 5 stalled bodies, then a normal request still gets in; a body that never finishes is 408", async () => {
    const d = await pair(); gw = () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    const stalled = [1, 2, 3, 4, 5].map(() => call(new Request(ORIGIN + "/bridge/llm/v1/messages", { method: "POST", headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"model":"claude-sonnet-5-5",')); } }), duplex: "half" } as any)));
    await new Promise((r) => setTimeout(r, 300));
    expect((await llm(d.token)).status).toBe(200);
    const states = await runInDurableObject(stubOf(d.deviceId), async (_i: DeviceHub, state: DurableObjectState) => state.storage.sql.exec(`SELECT COUNT(*) AS n FROM llm_open`).toArray()[0] as any);
    await settle(); expect(states.n).toBeLessThanOrEqual(1);
    const statuses = await Promise.all(stalled); expect(statuses.map((x) => x.status)).toEqual([408, 408, 408, 408, 408]);
  }, 60_000);
  it("reservations: with a small cap a lone big request is admitted, but a second concurrent one is refused until the first ends; N concurrent calls cannot share one unspent balance", async () => {
    const d = await pair(); gw = () => openStream();
    await e.DB.prepare(`INSERT OR REPLACE INTO settings (name, value) VALUES ('vcl_daily_usd:main','1')`).run();
    const big = body({ stream: true, max_tokens: 64000 }); // sonnet: ~$0.64 reserved each
    const first = await llm(d.token, big); expect(first.status).toBe(200);
    const second = await llm(d.token, big); expect(second.status).toBe(429); expect(((await second.json()) as any).error.message).toMatch(/daily budget/);
    expect(seen).toHaveLength(1);
    await first.body!.cancel(); await settle();
    expect((await llm(d.token, big)).status).toBe(200); // the reservation was released and replaced by the (tiny) actual cost
    const tiny = await Promise.all([1, 2, 3].map(() => llm(d.token, body({ stream: true, max_tokens: 100 })))); // reserve ~0.001 each: all fit
    expect(tiny.map((x) => x.status)).toEqual([200, 200, 200]);
  });
  it("DO error on admission fails closed (503), nothing forwarded", async () => {
    const d = await pair(); const before = seen.length;
    const r = await llm(d.token, body(), {}, { DEVICES: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }) } });
    expect(r.status).toBe(503); expect(seen.length).toBe(before);
  });
});
