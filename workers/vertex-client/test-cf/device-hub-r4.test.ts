import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../server/worker";
import { makeSession } from "../src/auth";
import { FakeApp, FakeDaemon } from "../test/fake-daemon";
import { runInDurableObject } from "cloudflare:test";
import { bindDeviceEnv } from "../src/conv-env";
import type { ChatSession } from "../src/chat-session";

// devv2s3e (round-3 review findings 1, 2, 4): device reservation, kill switch at delivery, no scope-wide approval notification. Real DeviceHub DO + D1 in workerd.
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


// devv2s3r: the round-4 findings, through the real DeviceHub (reducer shell) + ChatSession in workerd.
const sess = (get: (s: any) => any) => runInDurableObject(e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId)), async (_i: unknown, st: DurableObjectState) => get(JSON.parse((st.storage.sql.exec(`SELECT v FROM meta WHERE k='sess'`).toArray()[0] as any).v)));
const age = (ms: number) => runInDurableObject(e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId)), async (_i: unknown, st: DurableObjectState) => {
  const s = JSON.parse((st.storage.sql.exec(`SELECT v FROM meta WHERE k='sess'`).toArray()[0] as any).v); if (s.holder) { s.holder.since -= ms; s.holder.lastActive -= ms; }
  st.storage.sql.exec(`UPDATE meta SET v=? WHERE k='sess'`, JSON.stringify(s)); });
const alarm = () => runInDurableObject(e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId)), async (i: any) => { await i.alarm(); });

describe("devv2s3r round-4 findings (hub level)", () => {
  it("F1 older daemon (no cid): session_started BEFORE the cack still gives the chat its transcript and a working say", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); dm.autoAck = false;
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1);
    dm.emit("session_started", {}); dm.emit("assistant_text", { text: "hello from old daemon" }); await sleep(40);
    expect(JSON.stringify((await events(A)).events)).not.toContain("hello from old daemon");   // held until the ack proves it answers the start
    dm.send({ t: "cack", cseq: dm.processed[0].cseq }); await sleep(80);
    const ev = (await events(A)).events; expect(JSON.stringify(ev)).toContain("hello from old daemon"); expect(ev.some((x) => x.e.type === "session_started")).toBe(true);
    expect((await cmd({ conv: A, cid: "sa", kind: "say", text: "go on" })).status).toBe(200);
  });
  it("F2 an expired reservation never executes: A queued offline, aged past 15 min, B queued -> only B reaches the daemon", async () => {
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await age(16 * 60_000); await alarm();
    expect((await cmd({ conv: B, cid: "qb", kind: "start", prompt: "B" })).status).toBe(200);
    const dm = daemonOf(dev.token); await dm.connect(); await dm.until(() => dm.processed.length >= 1, "B's start"); await sleep(60);
    expect(dm.processed.map((c) => c.cid)).toEqual(["qb"]);
  });
  it("F2b an active session idle > 60 min is stopped (draining) before a replacement is admitted", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "qa" }); await sleep(50);
    await age(61 * 60_000); await alarm(); await dm.until(() => dm.processed.some((c) => c.kind === "stop"), "hub stop"); await sleep(60);
    expect((await sess((s) => s.holder))).toBeNull();                                           // the cack of the hub stop confirmed it
    expect((await cmd({ conv: B, cid: "qb", kind: "start", prompt: "B" })).status).toBe(200);
  });
  it("F3 a legacy page command's error neither releases nor refreshes the chat's reservation", async () => {
    const app = await appOf(); app.send({ t: "cmd", cid: "legacy1", kind: "say", text: "legacy" }); await app.until(() => app.frames.some((f) => f.t === "cmd_ack"), "legacy queued");
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" });
    const dm = daemonOf(dev.token); dm.autoAck = true; await dm.connect(); await dm.until(() => dm.processed.length === 2, "both delivered");
    dm.emit("session_error", { cid: "legacy1", code: "no_session" }); await sleep(60);
    expect((await sess((s) => s.holder)).conv).toBe(A);
    dm.emit("session_started", { cid: "qa" }); dm.emit("assistant_text", { text: "answer" }); await sleep(60);
    expect(JSON.stringify((await events(A)).events)).toContain("answer"); app.drop();
  });
  it("F7 a page start while a holder is ACTIVE is refused busy and the holder is untouched; a competing chat gets 409 before queueing", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); const app = await appOf();
    app.send({ t: "cmd", cid: "p1", kind: "start", prompt: "page" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "p1" }); await sleep(50);
    const before = await sess((s) => s.holder);
    app.send({ t: "cmd", cid: "p2", kind: "start", prompt: "again" }); await app.until(() => app.frames.some((f) => f.t === "err" && f.code === "busy" && f.cid === "p2"), "busy for p2");
    dm.emit("session_error", { cid: "p2", code: "busy" }); await sleep(50);
    expect(await sess((s) => s.holder)).toEqual(before); expect(dm.processed).toHaveLength(1);
    expect((await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" })).status).toBe(409); app.drop();
  });
  it("F8 an approval of an ended session cannot be answered by a later one (same conv or other): rejected, no allow frame reaches the daemon", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "qa" });
    dm.emit("approval_request", { rid: "ra", tool: "Bash", preview: "ls", ttl_s: 300 }); await sleep(60);
    dm.emit("session_ended", {}); await sleep(60);
    expect((await cmd({ conv: A, cid: "qa2", kind: "start", prompt: "A again" })).status).toBe(200); await dm.until(() => dm.processed.some((c) => c.cid === "qa2")); dm.emit("session_started", { cid: "qa2" }); await sleep(40);
    const r = await post("/bridge/approval", { conv: A, rid: "ra", allow: true }); expect(r.status).toBe(409);
    await sleep(60); expect(dm.processed.filter((c) => c.kind === "approval" && (c as any).allow === true)).toEqual([]);
  });
  it("F6 vcl_env off with an ACTIVE chat session: the hub stops it (cleanup), chat stop is not refused as disabled, queued work is cancelled, device frees on confirmation; chat delete releases too", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "qa" }); await sleep(50);
    await setFlag("vcl_env:main", "0");
    const st = await cmd({ conv: A, cid: "xa", kind: "stop" }); expect(st.status).not.toBe(404);
    expect((await cmd({ conv: A, cid: "sa", kind: "say", text: "late" })).status).toBe(404);
    await dm.until(() => dm.processed.some((c) => c.kind === "stop"), "stop reaches the daemon"); await sleep(60);
    expect(dm.processed.some((c) => c.kind === "say")).toBe(false);
    expect(await sess((s) => s.holder)).toBeNull();
    await setFlag("vcl_env:main", "1");
    await cmd({ conv: B, cid: "qb", kind: "start", prompt: "B" }); await dm.until(() => dm.processed.some((c) => c.cid === "qb")); dm.emit("session_started", { cid: "qb" }); await sleep(40);
    expect((await post("/bridge/release", { conv: B })).status).toBe(200);
    await dm.until(() => dm.processed.some((c) => c.cid === "hub-stop-2"), "release stops B"); await sleep(50);
    expect(await sess((s) => s.holder)).toBeNull();
  });
});

describe("devv2s3r: Stop during the environment guard produces zero dispatches", () => {
  it("pending stays set across envSetupIncomplete(): a Stop in that await is remembered and no start reaches the device", async () => {
    const me = await cookieOf(); const d = await pair(me); dev = d;
    const dm = daemonOf(d.token); await dm.connect(); await sleep(30);
    const r = await api(me, "POST", "/api/conversations", { env: { kind: "device", device_id: d.deviceId, dir: "/work" } }); const id = ((await r.json()) as any).id as string;
    const stub = e.CHAT.get(e.CHAT.idFromName(id));
    await runInDurableObject(stub, async (inst: ChatSession) => {
      inst.engine.setMeta("pending", JSON.stringify({ cmd: "device", text: "do not run" }));
      let release!: () => void; const gate = new Promise<boolean>((res) => { release = () => res(false); });
      (inst as any).envSetupIncomplete = () => gate;
      const p = inst.alarm();
      inst.engine.stop();                                   // the user's Stop lands while the guard awaits D1
      release(); await p;
    });
    await sleep(150); expect(dm.processed.filter((c) => c.kind === "start" || c.kind === "say")).toEqual([]);
  });
});
