import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../server/worker";
import { makeSession } from "../src/auth";
import { FakeApp, FakeDaemon } from "../test/fake-daemon";
import { runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { bindDeviceEnv } from "../src/conv-env";
import type { ChatSession } from "../src/chat-session";

// devv2s3t: the six round-6 findings + the crash-window model, through the real DeviceHub DO + ChatSession in workerd. Each test is the review's scenario (red before the fix).
const e = env as any;
const ORIGIN = "https://app.test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (req: Request) => worker.fetch(req, e, ctx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = "example-user";
type Me = { cookie: string; csrf: string };
const cookieOf = async (user = USER): Promise<Me> => { const s = await makeSession(e, user, "github"); return { cookie: s.cookie.split(";")[0], csrf: s.session.csrf }; };
const api = (me: Me, method: string, path: string, body?: unknown) => call(new Request(ORIGIN + path, { method, headers: { cookie: me.cookie, origin: ORIGIN, "x-csrf-token": me.csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
const setFlag = (name: string, v = "1") => e.DB.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(name, v).run();
async function pair(me: Me) {
  const p = await api(me, "POST", "/api/devices/pair"); const { code } = (await p.json()) as { code: string };
  const r = await call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ code, name: "laptop" }) }));
  return (await r.json()) as { deviceId: string; token: string };
}
const daemonOf = (token: string) => new FakeDaemon(async () => { const r = await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } })); expect(r.status).toBe(101); return (r as any).webSocket as WebSocket; });
let dev: { deviceId: string; token: string };
const hub = (path: string, init: RequestInit = {}, user = USER) => e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId)).fetch(new Request("https://do.internal" + path, { ...init, headers: { "x-vcl-device": dev.deviceId, "x-vcl-scope": "main", "x-vcl-user": user, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as object) } }));
const post = (path: string, body: unknown) => hub(path, { method: "POST", body: JSON.stringify(body) });
const cmd = (body: Record<string, unknown>) => post("/bridge/cmd", body);
const events = async (conv: string, since = 0) => (await (await hub(`/bridge/events?since=${since}&wait=0&conv=${conv}`)).json()) as { events: Array<{ seq: number; e: any }>; mine: boolean };
const A = "aaaaaaaa-2222-3333-4444-555555555555", B = "bbbbbbbb-2222-3333-4444-555555555555";
const appOf = async () => { const app = new FakeApp(async (since) => { const r = await hub(`/ws/app?since=${since}`, { headers: { upgrade: "websocket" } }); return (r as any).webSocket as WebSocket; }); await app.connect(); return app; };

beforeEach(async () => { await setFlag("vcl:main"); await setFlag("vcl_env:main"); const me = await cookieOf(); dev = await pair(me); });




async function openChat(me: Me, id: string, since = 0) {
  const r = await call(new Request(`${ORIGIN}/api/conversations/${id}/ws?since=${since}`, { headers: { upgrade: "websocket", cookie: me.cookie, origin: ORIGIN } })); expect(r.status).toBe(101);
  const ws = (r as any).webSocket as WebSocket; ws.accept(); const frames: any[] = []; ws.addEventListener("message", (m: MessageEvent) => frames.push(JSON.parse(String(m.data))));
  const until = async (pred: () => boolean, what: string, ms = 6000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}; frames=${JSON.stringify(frames).slice(0, 1500)}`); await sleep(15); } };
  return { ws, frames, until, send: (o: unknown) => ws.send(JSON.stringify(o)), evs: (type: string) => frames.filter((f) => f.t === "ev" && f.e.type === type).map((f) => f.e) };
}
const stub = () => e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId));
const sess = (get: (s: any) => any) => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => get(JSON.parse((st.storage.sql.exec(`SELECT v FROM meta WHERE k='sess'`).toArray()[0] as any).v)));
const age = (ms: number) => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => {
  const s = JSON.parse((st.storage.sql.exec(`SELECT v FROM meta WHERE k='sess'`).toArray()[0] as any).v); if (s.holder) { s.holder.since -= ms; s.holder.lastActive -= ms; }
  st.storage.sql.exec(`UPDATE meta SET v=? WHERE k='sess'`, JSON.stringify(s)); });
const alarm = () => runInDurableObject(stub(), async (i: any) => { await i.alarm(); });
/** Wait until the hub has persisted the daemon event with this dseq (a fixed sleep is too short when the full suite loads the host). */
const settle = async (dseq: number, ms = 8000) => { const t0 = Date.now(); while ((await lastDseq()) < dseq) { if (Date.now() - t0 > ms) throw new Error(`hub never persisted dseq ${dseq}`); await sleep(10); } };
const restart = async () => { await abortAllDurableObjects(); await sleep(20); };
const lastDseq = () => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => Number((st.storage.sql.exec(`SELECT v FROM meta WHERE k='last_dseq'`).toArray()[0] as any)?.v ?? 0));
/** A offline drain expiry frees the device with A's stop unconfirmed; B queues a start behind it. */
async function handoff(dm: FakeDaemon) {
  await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1);
  await settle(dm.emit("session_started", { cid: "a1" }));
  dm.drop(); await sleep(80);
  await post("/bridge/release", { conv: A });                                          // A's chat is deleted while the device is away: stop queued, draining
  await age(3 * 60_000); await alarm();
  expect(await sess((s) => s.holder)).toBeNull(); expect(await sess((s) => s.fence)).not.toBeNull();
}

describe("devv2s3t F1: reconnect handoff fence", () => {
  it("A's offline text + approval + turn_done replayed after B's start never enter or finish B; the stop goes first; B's own answer works", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    await handoff(dm);
    expect((await cmd({ conv: B, cid: "b1", kind: "start", prompt: "B" })).status).toBe(200);
    dm.emit("assistant_text", { text: "PRIVATE OLD A OUTPUT" }); dm.emit("approval_request", { rid: "oldA", tool: "Bash", preview: "rm -rf old", ttl_s: 300 }); dm.emit("turn_done", {});
    await dm.connect(); await dm.until(() => dm.processed.some((c) => c.cid === "b1"), "B's start after the fence"); await sleep(80);
    const order = dm.processed.map((c) => c.kind); expect(order.indexOf("stop")).toBeGreaterThan(-1); expect(order.indexOf("stop")).toBeLessThan(order.indexOf("start", order.indexOf("start") + 1));
    expect(await sess((s) => s.fence ?? null)).toBeNull();
    const bEvents = JSON.stringify((await events(B)).events); expect(bEvents).not.toContain("PRIVATE OLD A OUTPUT"); expect(bEvents).not.toContain("oldA"); expect(bEvents).not.toContain("turn_done");
    expect((await post("/bridge/approval", { conv: B, rid: "oldA", allow: true })).status).not.toBe(200);
    dm.emit("session_started", { cid: "b1" }); dm.emit("assistant_text", { cid: "b1", text: "B OWN ANSWER" }); await sleep(80);
    const after = JSON.stringify((await events(B)).events); expect(after).toContain("B OWN ANSWER"); expect(after).not.toContain("PRIVATE OLD A OUTPUT");
    await runInDurableObject(stub(), async (i: any) => { const s = JSON.parse(i.meta("sess")); s.replayUntil = 0; i.setMeta("sess", JSON.stringify(s)); });   // devv2s3u: B's own request is raised AFTER the replay window that follows a reconnect (a request inside it is denied by design)
    dm.emit("approval_request", { cid: "b1", rid: "newB", tool: "Bash", preview: "ls", ttl_s: 300 }); await sleep(60);
    expect((await post("/bridge/approval", { conv: B, rid: "newB", allow: true })).status).toBe(200);
  });
  it("the REAL ChatSession of B does not finish on A's replayed turn_done and its transcript has none of A's output", async () => {
    const me = await cookieOf(); const d = await pair(me); dev = d;
    const dm = daemonOf(d.token); await dm.connect(); await sleep(30);
    await handoff(dm);
    const r = await api(me, "POST", "/api/conversations", { env: { kind: "device", device_id: d.deviceId } }); const id = ((await r.json()) as any).id as string;
    const c = await openChat(me, id); c.send({ t: "send", text: "B QUESTION" });
    await c.until(() => c.evs("turn_start").length === 1, "B's turn started"); await sleep(100);
    dm.emit("assistant_text", { text: "A OLD ANSWER" }); dm.emit("turn_done", {});
    await dm.connect(); await dm.until(() => dm.processed.filter((x) => x.kind === "start").length === 2, "B's start delivered after the stop"); await sleep(100);
    expect(c.evs("turn_end")).toEqual([]);                                                                // A's turn_done did not complete B
    const b = dm.processed.filter((x) => x.kind === "start")[1];
    dm.emit("session_started", { cid: b.cid }); dm.emit("assistant_text", { cid: b.cid, text: "B REAL ANSWER" }); dm.emit("turn_done", { cid: b.cid });
    await c.until(() => c.evs("turn_end").length === 1, "B's own turn_end");
    const body = JSON.stringify(((await (await api(me, "GET", "/api/conversations/" + id)).json()) as any).state.messages);
    expect(body).toContain("B REAL ANSWER"); expect(body).not.toContain("A OLD ANSWER"); c.ws.close();
  });
});

describe("devv2s3t F2/F3/F5: provisional buffer bounds", () => {
  it("F2 the buffer cap fails the generation to its OWNER (no page-answerable approval): the page's allow is not forwarded", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); dm.autoAck = false; const app = await appOf();
    await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1);
    for (let n = 0; n < 100; n++) dm.emit("assistant_text", { text: `provisional-${n}` });
    dm.emit("approval_request", { rid: "overflow", tool: "Bash", preview: "private command", ttl_s: 300 }); await dm.until(() => dm.pendingAcks === 0, "all 101 events acked", 20_000);
    expect(await sess((s) => s.appr.some((a: any) => a.conv === null && a.state === "pending"))).toBe(false);
    expect((await sess((s) => s.holder)).phase).toBe("draining");
    app.send({ t: "approval_res", rid: "overflow", allow: true }); await sleep(120);
    expect(dm.processed.some((c) => c.kind === "approval" && c.allow === true)).toBe(false);
    expect(JSON.stringify((await events(A)).events)).toContain("provisional_overflow"); app.drop();
  }, 60_000);
  it("F3 twelve max-sized valid approvals never exceed the persisted-state limit, every one is acknowledged only after it persisted", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); dm.autoAck = false;
    await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1);
    const res = await runInDurableObject(stub(), async (i: any, st: DurableObjectState) => {
      const ws = st.getWebSockets("device")[0]; let threw = ""; const sent: any[] = []; const orig = ws.send.bind(ws);
      (ws as any).send = (m: string) => { sent.push(JSON.parse(m)); try { orig(m); } catch { /* */ } };
      for (let n = 1; n <= 20; n++) { try { await i.webSocketMessage(ws, JSON.stringify({ t: "ev", dseq: n, e: { type: "approval_request", rid: `large-${n}`, tool: "Bash", preview: "x".repeat(190_000), ttl_s: 300 } })); } catch (x) { threw = String(x); break; } }
      return { threw, sent, size: (st.storage.sql.exec(`SELECT length(v) AS n FROM meta WHERE k='sess'`).toArray()[0] as any).n, last: Number((st.storage.sql.exec(`SELECT v FROM meta WHERE k='last_dseq'`).toArray()[0] as any).v) };
    });
    expect(res.threw).toBe(""); expect(res.size).toBeLessThan(600 * 1024);
    const acked = res.sent.filter((f: any) => f.t === "ack").map((f: any) => f.dseq); expect(Math.max(...acked)).toBe(res.last);          // the frontier equals the last acknowledged event
    expect(res.sent.filter((f: any) => f.t === "err" && f.code === "persist_failed")).toEqual([]);
  });
  it("F3 a failed persist does not advance the frontier and is not acknowledged; the retry applies it once", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); await settle(dm.emit("session_started", { cid: "a1" }));
    const before = await lastDseq();
    const out = await runInDurableObject(stub(), async (i: any, st: DurableObjectState) => {
      const ws = st.getWebSockets("device")[0]; const sent: any[] = []; (ws as any).send = (m: string) => { sent.push(JSON.parse(m)); };
      const orig = i.setMeta.bind(i); i.setMeta = (k: string, v: unknown) => { if (k === "sess") throw new Error("SQLITE_TOOBIG injected"); return orig(k, v); };
      const reset = i.resetDevice.bind(i); let resets = 0; i.resetDevice = () => { resets++; };   // devv2s3w: a failed persist now resets the connection (covered in device-hub-r7); here only the frontier / ack contract of the attempt is under test
      await i.webSocketMessage(ws, JSON.stringify({ t: "ev", dseq: before + 1, e: { type: "assistant_text", cid: "a1", text: "ONCE" } }));
      i.setMeta = orig; i.resetDevice = reset; if (resets !== 1) throw new Error("persist failure did not request a connection reset");
      const lastAfterFail = Number((st.storage.sql.exec(`SELECT v FROM meta WHERE k='last_dseq'`).toArray()[0] as any).v);
      await i.webSocketMessage(ws, JSON.stringify({ t: "ev", dseq: before + 1, e: { type: "assistant_text", cid: "a1", text: "ONCE" } }));
      return { sent, lastAfterFail, lastAfterRetry: Number((st.storage.sql.exec(`SELECT v FROM meta WHERE k='last_dseq'`).toArray()[0] as any).v) };
    });
    expect(out.lastAfterFail).toBe(before); expect(out.sent[0]).toMatchObject({ t: "err", code: "persist_failed" }); expect(out.sent.some((f: any) => f.t === "ack" && f.dseq === before + 1)).toBe(true);
    expect(out.sent.findIndex((f: any) => f.t === "ack")).toBeGreaterThan(0); expect(out.lastAfterRetry).toBe(before + 1);
    expect((await events(A)).events.filter((x) => x.e.text === "ONCE")).toHaveLength(1);
  });
});

describe("devv2s3t F4: Stop during the socket guard on the CLOUD path (device flags OFF)", () => {
  it("a Stop that lands while the guard awaits cancels that cloud send; a later send still runs", async () => {
    await setFlag("vcl:main", "0"); await setFlag("vcl_env:main", "0");
    const me = await cookieOf(); const r = await api(me, "POST", "/api/conversations", {}); const id = ((await r.json()) as any).id as string;
    const cs = e.CHAT.get(e.CHAT.idFromName(id)); await cs.fetch(new Request("https://chat.internal/state", { headers: { "x-conv-id": id } }));
    const out = await runInDurableObject(cs, async (inst: any) => {
      const ws = { send() {} } as unknown as WebSocket; let invoked = 0, stopped = false;
      inst.engine.send = async () => { invoked++; stopped = inst.engine.meta("stop_pending") === "1"; return { ok: true }; };
      let release!: () => void; const gate = new Promise<boolean>((res) => { release = () => res(false); }); inst.envSetupIncomplete = () => gate;
      const p = inst.webSocketMessage(ws, JSON.stringify({ t: "send", text: "do not run cloud" }));
      await inst.webSocketMessage(ws, JSON.stringify({ t: "stop" })); release(); await p; await inst.alarm();
      const afterStop = invoked;
      inst.envSetupIncomplete = async () => false;
      await inst.webSocketMessage(ws, JSON.stringify({ t: "send", text: "later" })); await inst.alarm();
      return { afterStop, afterLater: invoked, stopped };
    });
    expect(out).toEqual({ afterStop: 0, afterLater: 1, stopped: false });
  });
  it("stopfix1: the cancelled send is ANSWERED (a rejected frame), so the client is not left waiting for an event", async () => {
    await setFlag("vcl:main", "0"); await setFlag("vcl_env:main", "0");
    const me = await cookieOf(); const r = await api(me, "POST", "/api/conversations", {}); const id = ((await r.json()) as any).id as string;
    const cs = e.CHAT.get(e.CHAT.idFromName(id)); await cs.fetch(new Request("https://chat.internal/state", { headers: { "x-conv-id": id } }));
    const frames = await runInDurableObject(cs, async (inst: any) => {
      const sent: any[] = []; const ws = { send(m: string) { sent.push(JSON.parse(m)); } } as unknown as WebSocket;
      inst.engine.send = async () => ({ ok: true });
      let release!: () => void; const gate = new Promise<boolean>((res) => { release = () => res(false); }); inst.envSetupIncomplete = () => gate;
      const p = inst.webSocketMessage(ws, JSON.stringify({ t: "send", text: "cancelled" }));
      await inst.webSocketMessage(ws, JSON.stringify({ t: "stop" })); release(); await p;
      return sent;
    });
    expect(frames).toHaveLength(1); expect(frames[0]).toMatchObject({ t: "rejected", code: "stopped" });
  });
});

describe("devv2s3t F5: a disconnect denies the provisional approvals", () => {
  it("a provisional approval buffered at disconnect cannot become pending or accept allow after reconnect; provisional text survives", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); dm.autoAck = false;
    await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1);
    dm.emit("session_started", {}); dm.emit("assistant_text", { text: "kept text" }); dm.emit("approval_request", { rid: "gone", tool: "Bash", preview: "ls", ttl_s: 300 }); await dm.until(() => dm.pendingAcks === 0);
    dm.drop(); await sleep(80); dm.autoAck = true; await dm.connect(); await sleep(150);
    expect(await sess((s) => s.appr.find((a: any) => a.rid === "gone")?.state ?? "none")).not.toBe("pending");
    expect((await post("/bridge/approval", { conv: A, rid: "gone", allow: true })).status).not.toBe(200);
    expect((await events(A)).events.filter((x) => x.e.text === "kept text")).toHaveLength(1);
  });
});

// ---- crash-window model: for every shell step, a crash/reconstruction between the persisted state and EACH effect ----
// The step is [persist state] -> [effect 1 .. effect n] -> [frontier]. A fault is injected at effect k (k = 1..n) (a throw: the same observable as the DO dying there), the DO is rebuilt, and the same input is applied again
// (a daemon re-sends an unacknowledged event; a user retries a command by cid; hello re-delivers). Required: (1) nothing of the failed attempt is observable (state, outbox, approvals, log, frontier, frames), (2) after the retry the
// observable state is IDENTICAL to a run with no fault (so: no duplicate stop/start, no lost approval resolution, no second event).
type Snap = unknown;
let ipN = 10;
async function pairFresh(me: Me) {
  await e.DB.prepare(`DELETE FROM devices`).run(); await e.DB.prepare(`DELETE FROM device_pairings`).run();     // MAX_DEVICES / pairing codes per user: every model run is a brand-new device
  const p = await api(me, "POST", "/api/devices/pair"); const { code } = (await p.json()) as { code: string };
  const r = await call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${++ipN}` }, body: JSON.stringify({ code, name: "laptop" }) }));
  return (await r.json()) as { deviceId: string; token: string };
}
const norm = (x: string) => x.replace(/(\\*"(?:since|lastActive|replayUntil|expiresAt|ts|created_at|expires_at|resolved_at)\\*"):\d+/g, '$1:0');
const snap = (): Promise<Snap> => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => {
  const q = (s: string) => st.storage.sql.exec(s).toArray();
  return JSON.parse(norm(JSON.stringify({ sess: JSON.parse((q(`SELECT v FROM meta WHERE k='sess'`)[0] as any)?.v ?? "null"), last: (q(`SELECT v FROM meta WHERE k='last_dseq'`)[0] as any)?.v ?? null,
    outbox: q(`SELECT cseq, cid, frame, src, conv FROM outbox ORDER BY cseq`), approvals: q(`SELECT rid, state, conv FROM approvals ORDER BY rid`), events: q(`SELECT e, conv FROM events ORDER BY seq`) })));
});
type Scenario = { name: string; setup: (dm: FakeDaemon) => Promise<void>; act: (i: any, ws: any, st: DurableObjectState) => Promise<unknown> | unknown };
const SCENARIOS: Scenario[] = [
  { name: "daemon text of the active holder", setup: async (dm) => { await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); await settle(dm.emit("session_started", { cid: "a1" })); },
    act: async (i, ws) => i.webSocketMessage(ws, JSON.stringify({ t: "ev", dseq: 2, e: { type: "assistant_text", cid: "a1", text: "hello" } })) },
  { name: "daemon approval request of the active holder", setup: async (dm) => { await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); await settle(dm.emit("session_started", { cid: "a1" })); },
    act: async (i, ws) => i.webSocketMessage(ws, JSON.stringify({ t: "ev", dseq: 2, e: { type: "approval_request", cid: "a1", rid: "r1", tool: "Bash", preview: "ls", ttl_s: 300 } })) },
  { name: "session_ended with a pending approval (emit + expire + deny enqueue + release)", setup: async (dm) => { await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "a1" }); await settle(dm.emit("approval_request", { cid: "a1", rid: "r1", tool: "Bash", preview: "ls", ttl_s: 300 })); },
    act: async (i, ws) => i.webSocketMessage(ws, JSON.stringify({ t: "ev", dseq: 3, e: { type: "session_ended", cid: "a1" } })) },
  { name: "the owner answers an approval (state change + allow enqueue)", setup: async (dm) => { await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "a1" }); await settle(dm.emit("approval_request", { cid: "a1", rid: "r1", tool: "Bash", preview: "ls", ttl_s: 300 })); },
    act: async (i) => i.resolveApproval("r1", true, USER, A) },
  { name: "user Stop (stop enqueue + draining)", setup: async (dm) => { await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); await settle(dm.emit("session_started", { cid: "a1" })); },
    act: async (i) => i.submit({ k: "chat", conv: A }, "x1", "stop", {}) },
  { name: "a start queued while the daemon is offline, then delivered (send effect)", setup: async (dm) => { dm.drop(); await sleep(80); await cmd({ conv: A, cid: "a1", kind: "start", prompt: "A" }); },
    act: async (i) => { i.apply({ t: "hello", lastCseq: 0, envOn: true }); } },
  { name: "a cack that releases the holder and lifts the fence", setup: async (dm) => { await handoff(dm); await cmd({ conv: B, cid: "b1", kind: "start", prompt: "B" }); },
    act: async (i) => i.apply({ t: "hello", lastCseq: 0, envOn: true }) },
];
describe("devv2s3t crash-window model: a fault between persist and each effect", () => {
  for (const sc of SCENARIOS) it(sc.name, async () => {
    const run = async (inject: number | null) => {
      dev = await pairFresh(await cookieOf()); const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); await sc.setup(dm);
      const before = await snap(); let calls = 0, faulted = false;
      const attempt = async (faultAt: number | null) => runInDurableObject(stub(), async (i: any, st: DurableObjectState) => {
        const sent: string[] = []; const real = st.getWebSockets("device")[0] as any;
        const ws = real ?? { deserializeAttachment: () => ({ role: "device", user: USER }), serializeAttachment() {}, close() {}, send() {} };   // after a rebuild there is no socket: the same frames, a stand-in connection
        const origSend = ws.send.bind(ws); ws.send = (m: string) => { sent.push(m); origSend(m); };
        const resetDev = i.resetDevice.bind(i); i.resetDevice = () => { /* devv2s3w: the connection reset after a failed persist is covered in device-hub-r7; this model checks transaction atomicity only */ };
        const orig = i.exec.bind(i); i.exec = (f: unknown) => { calls++; if (faultAt !== null && calls === faultAt) { faulted = true; throw new Error("injected crash at effect " + faultAt); } return orig(f); };
        let err = ""; try { await sc.act(i, ws, st); } catch (x) { err = String(x); } finally { i.exec = orig; i.resetDevice = resetDev; ws.send = origSend; }
        return { err, frames: sent };
      });
      if (inject !== null) {
        const first = await attempt(inject); expect(faulted).toBe(true);
        expect(await snap()).toEqual(before);                                                       // (1) nothing of the failed attempt is observable
        expect(first.frames.filter((m: string) => /"t":"ack"/.test(m))).toEqual([]);                  // not acknowledged
        await restart();                                                                            // the DO dies and is rebuilt
        calls = 0; faulted = false;
      }
      const ok = await attempt(null); return { after: await snap(), n: calls, ok, dm };
    };
    const ref = await run(null); expect(ref.n).toBeGreaterThan(0);
    for (let k = 1; k <= ref.n; k++) { const r = await run(k); const ra = JSON.stringify(r.after, null, 1).split('\n'), rb = JSON.stringify(ref.after, null, 1).split('\n'); const dif = ra.map((l, ix) => (l !== rb[ix] ? `${ix}: got ${l.trim()} | want ${(rb[ix] ?? '').trim()}` : '')).filter(Boolean); expect(dif, `retry after a fault at effect ${k}/${ref.n}`).toEqual([]); }   // (2) idempotent / re-derivable
  }, 120_000);
});
