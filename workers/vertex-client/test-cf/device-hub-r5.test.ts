import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../server/worker";
import { makeSession } from "../src/auth";
import { FakeApp, FakeDaemon } from "../test/fake-daemon";
import { runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
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



// devv2s3s: the round-5 findings, through the real DeviceHub (workerd) + ChatSession. Each test is the review's scenario (red before the fix).
const stub = () => e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId));
const sess = (get: (s: any) => any) => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => get(JSON.parse((st.storage.sql.exec(`SELECT v FROM meta WHERE k='sess'`).toArray()[0] as any).v)));
const age = (ms: number) => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => {
  const s = JSON.parse((st.storage.sql.exec(`SELECT v FROM meta WHERE k='sess'`).toArray()[0] as any).v); if (s.holder) { s.holder.since -= ms; s.holder.lastActive -= ms; }
  st.storage.sql.exec(`UPDATE meta SET v=? WHERE k='sess'`, JSON.stringify(s)); });
const alarm = () => runInDurableObject(stub(), async (i: any) => { await i.alarm(); });
const getAlarm = () => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => st.storage.getAlarm());
const restart = async () => { await abortAllDurableObjects(); await sleep(20); };

describe("devv2s3s round-5 findings (hub level)", () => {
  it("F1 an offline reservation arms the expiry alarm, survives reconstruction with it armed, expires without socket activity, and never executes when reconnect wins the race", async () => {
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" });
    expect(await getAlarm()).not.toBeNull();                                           // armed by the bridge mutation itself
    await restart(); expect(await getAlarm()).not.toBeNull();                          // and after the DO was rebuilt
    await age(16 * 60_000); await alarm();
    expect(await sess((s) => s.holder)).toBeNull();
    expect((await cmd({ conv: B, cid: "qb", kind: "start", prompt: "B" })).status).toBe(200);
  });
  it("F1b reconnect wins the alarm race: an expired offline reservation is reconciled at hello, so its start is never delivered", async () => {
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await age(16 * 60_000);       // aged, alarm not yet run
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(120);
    expect(dm.processed.filter((c) => c.kind === "start")).toEqual([]);
    expect(await sess((s) => s.holder)).toBeNull();
  });
  it("F1c admission reconciles expiry synchronously: B's start is admitted over an expired offline reservation with no alarm having run", async () => {
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await age(16 * 60_000);
    expect((await cmd({ conv: B, cid: "qb", kind: "start", prompt: "B" })).status).toBe(200);
  });
  it("F2 disconnect before the cack keeps the acknowledged provisional events; hello.lastCseq confirms the start and they fold exactly once", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); dm.autoAck = false;
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1);
    dm.emit("session_started", {}); dm.emit("assistant_text", { text: "answer before cack" }); await sleep(50);
    dm.drop(); await sleep(60); await dm.connect(); await sleep(120);                            // hello carries lastCseq = the start
    const ev = (await events(A)).events;
    expect(ev.filter((x) => x.e.type === "assistant_text" && x.e.text === "answer before cack")).toHaveLength(1);
    expect(ev.filter((x) => x.e.type === "session_started")).toHaveLength(1);
    expect((await sess((s) => s.holder)).phase).toBe("active");
    expect((await cmd({ conv: A, cid: "sa", kind: "say", text: "go on" })).status).toBe(200);
  });
  it("F3 a cid-less approval before the start's cack is buffered with the session: after the cack the chat gets the card, can answer it (not 403) and it expires with the generation", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); dm.autoAck = false;
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1);
    dm.emit("session_started", {}); dm.emit("approval_request", { rid: "rp1", tool: "Bash", preview: "ls", ttl_s: 300 }); await sleep(60);
    expect(JSON.stringify((await events(A)).events)).not.toContain("rp1");                        // not attributable yet
    dm.send({ t: "cack", cseq: dm.processed[0].cseq }); await sleep(80);
    expect(JSON.stringify((await events(A)).events.filter((x) => x.e.type === "approval_request"))).toContain("rp1");
    expect((await post("/bridge/approval", { conv: A, rid: "rp1", allow: true })).status).toBe(200);
    dm.emit("approval_request", { rid: "rp2", tool: "Bash", preview: "pwd", ttl_s: 300 }); await sleep(50);
    dm.emit("session_ended", {}); await sleep(60);
    expect((await post("/bridge/approval", { conv: A, rid: "rp2", allow: true })).status).toBe(409);   // generation ended: expired, not answerable
  });
  it("F4 replacing a SENT reservation is refused busy and starts draining; old output never enters the replacement turn", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); dm.autoAck = false;
    await cmd({ conv: A, cid: "q1", kind: "start", prompt: "one" }); await dm.until(() => dm.processed.length === 1);
    const r = await cmd({ conv: A, cid: "q2", kind: "start", prompt: "two" }); expect(r.status).toBe(409);
    await dm.until(() => dm.processed.some((c) => c.kind === "stop"), "stop of the old generation");
    expect((await sess((s) => s.holder)).phase).toBe("draining");
    dm.emit("assistant_text", { text: "OLD ANSWER" }); dm.emit("turn_done", {}); await sleep(40);
    dm.send({ t: "cack", cseq: dm.processed[1].cseq }); dm.emit("session_stopped", {}); await sleep(80);
    expect(await sess((s) => s.holder)).toBeNull();
    const since = (await events(A)).events.at(-1)?.seq ?? 0;
    expect((await cmd({ conv: A, cid: "q3", kind: "start", prompt: "two" })).status).toBe(200);
    dm.autoAck = true; await dm.until(() => dm.processed.some((c) => c.cid === "q3")); dm.emit("session_started", { cid: "q3" }); dm.emit("assistant_text", { text: "NEW" }); await sleep(60);
    const after = JSON.stringify((await events(A, since)).events); expect(after).not.toContain("OLD ANSWER"); expect(after).toContain("NEW");
  });
  it("F5 a user Stop drains and releases on THAT Stop's cack, also after a daemon restart (cack without session_stopped)", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "qa" }); await sleep(50);
    expect((await cmd({ conv: A, cid: "xa", kind: "stop" })).status).toBe(200);
    await dm.until(() => dm.processed.some((c) => c.cid === "xa"), "stop delivered"); await sleep(60);   // the daemon "restarted": it cacks, emits no session_stopped
    expect(await sess((s) => s.holder)).toBeNull();
    expect((await cmd({ conv: B, cid: "qb", kind: "start", prompt: "B" })).status).toBe(200);
  });
  it("F5b the same for the device page's Stop", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); const app = await appOf();
    app.send({ t: "cmd", cid: "p1", kind: "start", prompt: "page" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "p1" }); await sleep(50);
    app.send({ t: "cmd", cid: "ps", kind: "stop" }); await dm.until(() => dm.processed.some((c) => c.cid === "ps"), "stop delivered"); await sleep(60);
    expect(await sess((s) => s.holder)).toBeNull();
    expect((await cmd({ conv: B, cid: "qb", kind: "start", prompt: "B" })).status).toBe(200); app.drop();
  });
  it("F7 an ACTIVE chat with no queued work is stopped when vcl_env turns off, by the periodic check alone (no further POST)", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "qa" }); await sleep(50);
    await setFlag("vcl_env:main", "0"); await alarm();
    await dm.until(() => dm.processed.some((c) => c.kind === "stop"), "cleanup stop"); await sleep(60);
    expect(await sess((s) => s.holder)).toBeNull();
  });
  it("F7b a page-only session is NOT touched by the environment switch check", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30); const app = await appOf();
    app.send({ t: "cmd", cid: "p1", kind: "start", prompt: "page" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", { cid: "p1" }); await sleep(50);
    await setFlag("vcl_env:main", "0"); await alarm(); await sleep(80);
    expect(dm.processed.some((c) => c.kind === "stop")).toBe(false); expect((await sess((s) => s.holder)).conv).toBe("page"); app.drop();
  });
});

describe("devv2s3s F6: Stop during the SOCKET-level environment guard produces zero dispatches", () => {
  it("a Stop that lands while the socket handler awaits the guard cancels that send; a LATER send is not cancelled", async () => {
    const me = await cookieOf(); const d = await pair(me); dev = d;
    const dm = daemonOf(d.token); await dm.connect(); await sleep(30);
    const r = await api(me, "POST", "/api/conversations", { env: { kind: "device", device_id: d.deviceId, dir: "/work" } }); const id = ((await r.json()) as any).id as string;
    const cs = e.CHAT.get(e.CHAT.idFromName(id));
    const fakeWs = { send() {} } as unknown as WebSocket;
    await runInDurableObject(cs, async (inst: ChatSession) => {
      let release!: () => void; const gate = new Promise<boolean>((res) => { release = () => res(false); });
      (inst as any).envSetupIncomplete = () => gate;
      const p = inst.webSocketMessage(fakeWs, JSON.stringify({ t: "send", text: "do not run" }));
      await inst.webSocketMessage(fakeWs, JSON.stringify({ t: "stop" }));              // Stop while the guard awaits
      release(); await p;
      (inst as any).envSetupIncomplete = async () => false;
    });
    await sleep(200); expect(dm.processed.filter((c) => c.kind === "start" || c.kind === "say")).toEqual([]);
    await runInDurableObject(cs, async (inst: ChatSession) => { await inst.webSocketMessage(fakeWs, JSON.stringify({ t: "send", text: "later" })); });
    await dm.until(() => dm.processed.some((c) => c.kind === "start"), "a later send still runs");
  });
});
