import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../server/worker";
import { makeSession, sessionCookie, signSession } from "../src/auth";
import { FakeApp, FakeDaemon } from "../test/fake-daemon";
import { runInDurableObject } from "cloudflare:test";

// vclterm3: the device terminal relay through the real DeviceHub DO in workerd: fake device WS (a FakeDaemon sending raw term_* frames), fake app WS. Contract: docs/vcl-term-hub-api.md
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
let dev: { deviceId: string; token: string };
const daemonOf = (caps: string[] = ["hb", "term"]) => { const d = new FakeDaemon(async () => { const r = await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${dev.token}` } })); expect(r.status).toBe(101); return (r as any).webSocket as WebSocket; }); d.info = { name: "fake", version: "0", roots: [{ label: "proj", path: "/home/x/proj" }], caps }; return d; };
const stub = () => e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId));
const hub = (path: string, init: RequestInit = {}, user = USER) => stub().fetch(new Request("https://do.internal" + path, { ...init, headers: { "x-vcl-device": dev.deviceId, "x-vcl-scope": "main", "x-vcl-user": user, ...(init.headers as object) } }));
const nowS = () => Math.floor(Date.now() / 1000);
/** An app socket as the Worker would hand it over: `x-vcl-lat` = the login time of the signed cookie. lat null = an old cookie without one. */
async function appOf(lat: number | null = nowS()) {
  const app = new FakeApp(async (since) => { const r = await hub(`/ws/app?since=${since}`, { headers: { upgrade: "websocket", ...(lat !== null ? { "x-vcl-lat": String(lat) } : {}) } }); return (r as any).webSocket as WebSocket; });
  await app.connect(); return app;
}
const has = (f: { frames: any[] }, t: string, pred: (x: any) => boolean = () => true) => f.frames.some((x) => x.t === t && pred(x));
const alarm = () => runInDurableObject(stub(), async (i: any) => { await i.alarm(); });
const metaSet = (k: string, f: (v: any) => any) => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => { const r = st.storage.sql.exec(`SELECT v FROM meta WHERE k=?`, k).toArray()[0] as any; const v = f(r ? JSON.parse(r.v) : null); st.storage.sql.exec(`UPDATE meta SET v=? WHERE k=?`, JSON.stringify(v), k); });
const metaGet = (k: string) => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => (st.storage.sql.exec(`SELECT v FROM meta WHERE k=?`, k).toArray()[0] as any)?.v ?? null);
const dump = () => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => JSON.stringify({ e: st.storage.sql.exec(`SELECT * FROM events`).toArray(), o: st.storage.sql.exec(`SELECT * FROM outbox`).toArray(), m: st.storage.sql.exec(`SELECT * FROM meta`).toArray(), s: st.storage.sql.exec(`SELECT * FROM seen_cids`).toArray() }));
const evCount = () => runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => (st.storage.sql.exec(`SELECT COUNT(*) AS n, COALESCE(MAX(seq),0) AS m FROM events`).toArray()[0] as any));
const b64 = (s: string) => btoa(s);

/** Daemon + app up, term flag on, session open and ready: returns the handles. */
async function ready(opts: { caps?: string[]; lat?: number } = {}) {
  const dm = daemonOf(opts.caps); await dm.connect(); await sleep(40);
  const app = await appOf(opts.lat);
  app.send({ t: "term_open", cid: "o1", root: "/home/x/proj", cols: 80, rows: 24 });
  await dm.waitFrame((f) => f.t === "term_open", "term_open at device");
  dm.send({ t: "term_ready", cid: "o1", sid: "S1", mode: "landlock" });
  await app.waitFrame((f) => f.t === "term_ready", "term_ready at app");
  return { dm, app };
}

beforeEach(async () => { await setFlag("vcl:main"); await setFlag("vcl_term:main"); const me = await cookieOf(); dev = await pair(me); });

describe("vclterm3: flag off is the old behaviour", () => {
  it("no vcl_term row: welcome has no term cap, term_open is ignored (no reply, nothing reaches the device), normal commands still work", async () => {
    await e.DB.prepare(`DELETE FROM settings WHERE name='vcl_term:main'`).run();
    const dm = daemonOf(); await dm.connect(); await sleep(40);
    expect((dm.frames.find((f) => f.t === "welcome") as any).caps).toEqual(["hb"]);
    const app = await appOf();
    app.send({ t: "term_open", cid: "o1", root: "/home/x/proj", cols: 80, rows: 24 }); await sleep(120);
    expect(has(dm, "term_open")).toBe(false);
    expect(app.frames.filter((f) => f.t !== "hello" && f.t !== "ev")).toEqual([]);
    app.send({ t: "cmd", cid: "k1", kind: "say", text: "hi" }); await app.waitFrame((f) => f.t === "cmd_ack" || f.t === "err", "cmd path alive");
  });
  it("vcl_term=1 but vcl off: still ignored (the term flag never enables the bridge)", async () => {
    await setFlag("vcl:main", "0");
    const dm = daemonOf(); await dm.connect().catch(() => undefined); await sleep(40);
    expect(has(dm, "term_open")).toBe(false);
  });
  it("flag on: welcome announces the term cap", async () => {
    const dm = daemonOf(); await dm.connect(); await sleep(40);
    expect((dm.frames.find((f) => f.t === "welcome") as any).caps).toEqual(["hb", "term"]);
  });
});

describe("vclterm5: the app learns whether the Terminal tab may show", () => {
  it("hello.term is true only with flag on + device cap + device online; term_caps follows a device hello", async () => {
    const app0 = await appOf(); expect((app0.frames.find((f) => f.t === "hello") as any).term).toBe(false); // no device yet
    const dm = daemonOf(["hb", "term"]); await dm.connect(); await sleep(60);
    expect(has(app0, "term_caps", (x) => x.on === true)).toBe(true);
    const app1 = await appOf(); expect((app1.frames.find((f) => f.t === "hello") as any).term).toBe(true);
  });
  it("comp2: hello and term_caps carry the device's os / termState (whitelisted); an old device sends none", async () => {
    const app0 = await appOf();
    const dm = daemonOf(["hb"]); dm.info = { ...dm.info, os: "linux", arch: "x64", termState: "off_switch", termWhy: "ignored: only for unsupported" }; await dm.connect(); await sleep(60);
    expect(has(app0, "term_caps", (x) => x.os === "linux" && x.termState === "off_switch" && x.termWhy === undefined)).toBe(true);
    const h1 = (await appOf()).frames.find((f) => f.t === "hello") as any; expect([h1.os, h1.arch, h1.termState, h1.term]).toEqual(["linux", "x64", "off_switch", false]);
    const dm2 = daemonOf(["hb"]); dm2.info = { name: "old", version: "0" }; await dm2.connect(); await sleep(60);
    const h2 = (await appOf()).frames.find((f) => f.t === "hello") as any; expect([h2.os, h2.termState]).toEqual([undefined, undefined]);
  });
  it("no cap on the device, or flag off: false", async () => {
    const dm = daemonOf(["hb"]); await dm.connect(); await sleep(40);
    const app = await appOf(); expect((app.frames.find((f) => f.t === "hello") as any).term).toBe(false);
    await e.DB.prepare(`DELETE FROM settings WHERE name='vcl_term:main'`).run();
    const app2 = await appOf(); expect((app2.frames.find((f) => f.t === "hello") as any).term).toBe(false);
  });
});

describe("vclterm3: live relay", () => {
  it("open -> ready -> in/out/resize/ack -> close -> exit, ordered, and the slot is free again", async () => {
    const { dm, app } = await ready();
    expect(dm.frames.find((f) => f.t === "term_open")).toMatchObject({ cid: "o1", root: "/home/x/proj", cols: 80, rows: 24 });
    expect(app.frames.find((f) => f.t === "term_ready")).toMatchObject({ cid: "o1", sid: "S1", mode: "landlock" });
    for (let i = 0; i < 20; i++) app.send({ t: "term_in", sid: "S1", data: b64("k" + i) });
    await dm.until(() => dm.frames.filter((f) => f.t === "term_in").length === 20, "20 inputs");
    expect(dm.frames.filter((f) => f.t === "term_in").map((f) => atob(f.data))).toEqual(Array.from({ length: 20 }, (_, i) => "k" + i));   // typed order kept
    for (let i = 0; i < 5; i++) dm.send({ t: "term_out", sid: "S1", seq: i * 10, data: b64("out" + i) });
    await app.until(() => app.frames.filter((f) => f.t === "term_out").length === 5, "5 outputs");
    expect(app.frames.filter((f) => f.t === "term_out").map((f) => f.seq)).toEqual([0, 10, 20, 30, 40]);
    app.send({ t: "term_resize", sid: "S1", cols: 120, rows: 40 }); app.send({ t: "term_ack", sid: "S1", seq: 40 }); app.send({ t: "term_attach", sid: "S1", lastSeq: 30 });
    await dm.until(() => has(dm, "term_resize") && has(dm, "term_ack") && has(dm, "term_attach"), "resize/ack/attach");
    dm.send({ t: "term_gap", sid: "S1", from: 30 }); await app.waitFrame((f) => f.t === "term_gap", "gap relayed");
    app.send({ t: "term_close", sid: "S1" }); await dm.waitFrame((f) => f.t === "term_close", "close at device");
    dm.send({ t: "term_exit", sid: "S1", code: null, signal: "SIGHUP" }); await app.waitFrame((f) => f.t === "term_exit", "exit at app");
    expect(await metaGet("term")).toBeNull();
    app.send({ t: "term_open", cid: "o2", root: "/home/x/proj", cols: 80, rows: 24 }); await dm.until(() => dm.frames.filter((f) => f.t === "term_open").length === 2, "second open allowed");
  });
  it("only the socket that opened or attached gets terminal frames", async () => {
    const { dm, app } = await ready(); const other = await appOf();
    dm.send({ t: "term_out", sid: "S1", seq: 0, data: b64("secret-out") }); await app.waitFrame((f) => f.t === "term_out"); await sleep(60);
    expect(has(other, "term_out")).toBe(false);
    other.send({ t: "term_attach", sid: "S1", lastSeq: 0 }); await dm.waitFrame((f) => f.t === "term_attach");   // attach from a second owner tab: now it follows
    await sleep(30); dm.send({ t: "term_out", sid: "S1", seq: 1, data: b64("more") }); await other.waitFrame((f) => f.t === "term_out", "attached tab gets output");
  });
  it("a frame for another sid, a forged sid from the device and stray device frames are ignored", async () => {
    const { dm, app } = await ready();
    app.send({ t: "term_in", sid: "NOPE", data: b64("x") }); await sleep(60); expect(has(dm, "term_in")).toBe(false);
    dm.send({ t: "term_out", sid: "OTHER", seq: 0, data: b64("x") }); dm.send({ t: "term_exit", sid: "OTHER", code: 0, signal: null }); await sleep(60);
    expect(has(app, "term_out")).toBe(false); expect(has(app, "term_exit")).toBe(false); expect(await metaGet("term")).not.toBeNull();
  });
});

describe("vclterm3: admission", () => {
  it("login older than 12 h, or a cookie without a login time, is refused with login_required and nothing reaches the device", async () => {
    const dm = daemonOf(); await dm.connect(); await sleep(40);
    for (const lat of [nowS() - 13 * 3600, null]) {
      const app = await appOf(lat); app.send({ t: "term_open", cid: "o1", root: "/home/x/proj", cols: 80, rows: 24 });
      await app.waitFrame((f) => f.t === "term_error" && f.error === "login_required", "login_required");
    }
    expect(has(dm, "term_open")).toBe(false);
  });
  it("device without the term cap, or offline: refused", async () => {
    const dm = daemonOf(["hb"]); await dm.connect(); await sleep(40);
    const app = await appOf(); app.send({ t: "term_open", cid: "o1", root: "/r", cols: 80, rows: 24 });
    await app.waitFrame((f) => f.t === "term_error" && f.error === "no_cap", "no_cap");
    dm.drop(); await sleep(80);
    app.send({ t: "term_open", cid: "o2", root: "/r", cols: 80, rows: 24 }); await app.waitFrame((f) => f.t === "term_error" && f.cid === "o2" && f.error === "offline", "offline");
  });
  it("one session per device: a second open (even pending) is refused with limit", async () => {
    const dm = daemonOf(); await dm.connect(); await sleep(40);
    const app = await appOf(); app.send({ t: "term_open", cid: "o1", root: "/r", cols: 80, rows: 24 }); await dm.waitFrame((f) => f.t === "term_open");
    app.send({ t: "term_open", cid: "o2", root: "/r", cols: 80, rows: 24 }); await app.waitFrame((f) => f.t === "term_error" && f.cid === "o2" && f.error === "limit", "limit");
    expect(dm.frames.filter((f) => f.t === "term_open").length).toBe(1);
  });
  it("a device-side refusal (root not allowed) comes back as term_error with the cid and frees the slot", async () => {
    const dm = daemonOf(); await dm.connect(); await sleep(40);
    const app = await appOf(); app.send({ t: "term_open", cid: "o1", root: "/etc", cols: 80, rows: 24 }); await dm.waitFrame((f) => f.t === "term_open");
    dm.send({ t: "term_error", cid: "o1", error: "root_not_allowed" }); await app.waitFrame((f) => f.t === "term_error" && f.error === "root_not_allowed", "error relayed");
    expect(await metaGet("term")).toBeNull();
  });
  it("non-owner: the Worker route answers 404 for another user's device session socket, and a hub call from another user is a plain 404", async () => {
    const other = await cookieOf("someone-else");
    const r = await call(new Request(`${ORIGIN}/api/devices/${dev.deviceId}/session`, { headers: { upgrade: "websocket", cookie: other.cookie, origin: ORIGIN } }));
    expect([401, 403, 404]).toContain(r.status);
    await appOf();                                                                      // the owner's first contact pins the DO to them
    const h = await hub("/ws/app?since=0", { headers: { upgrade: "websocket", "x-vcl-lat": String(nowS()) } }, "someone-else");
    expect(h.status).toBe(404);
  });
  it("an open that the device never answers times out (term_error open_timeout); a late ready is told to close", async () => {
    const dm = daemonOf(); await dm.connect(); await sleep(40);
    const app = await appOf(); app.send({ t: "term_open", cid: "o1", root: "/r", cols: 80, rows: 24 }); await dm.waitFrame((f) => f.t === "term_open");
    await metaSet("term", (s) => ({ ...s, openedAt: s.openedAt - 60_000 })); await alarm();
    await app.waitFrame((f) => f.t === "term_error" && f.error === "open_timeout", "open_timeout");
    dm.send({ t: "term_ready", cid: "o1", sid: "LATE" }); await dm.waitFrame((f) => f.t === "term_close" && f.sid === "LATE", "late shell closed");
  });
});

describe("vclterm3: limits, idle, loss", () => {
  it("oversize frames are refused: app term_in over 64 KB and over the frame cap, device term_out over the frame cap", async () => {
    const { dm, app } = await ready();
    app.send({ t: "term_in", sid: "S1", data: "A".repeat(100_000) }); await app.waitFrame((f) => f.t === "err" && f.code === "bad_frame", "bad_frame 100k");
    app.frames.length = 0; app.send({ t: "term_in", sid: "S1", data: "A".repeat(300_000) }); await app.waitFrame((f) => f.t === "err" && f.code === "bad_frame", "bad_frame 300k");
    dm.send({ t: "term_out", sid: "S1", seq: 0, data: "A".repeat(300_000) }); await dm.waitFrame((f) => f.t === "err" && f.code === "bad_frame", "device oversize refused");
    await sleep(60); expect(has(dm, "term_in")).toBe(false); expect(has(app, "term_out")).toBe(false);
  });
  it("output over 2 MB/s is dropped, the app is told once (term_gap rate_limit), the session survives", async () => {
    const { dm, app } = await ready(); const chunk = "A".repeat(200_000);   // ~150 KB decoded each
    for (let i = 0; i < 16; i++) dm.send({ t: "term_out", sid: "S1", seq: i, data: chunk });
    await app.waitFrame((f) => f.t === "term_gap" && f.reason === "rate_limit", "rate gap"); await sleep(150);
    const got = app.frames.filter((f) => f.t === "term_out").length;
    expect(got).toBeGreaterThan(5); expect(got).toBeLessThan(16);
    expect(app.frames.filter((f) => f.t === "term_gap").length).toBe(1);
    expect(await metaGet("term")).not.toBeNull();
  });
  it("input over 2 MB/s is refused with term_error rate_limit", async () => {
    const { dm, app } = await ready(); const chunk = "A".repeat(64 * 1024);
    for (let i = 0; i < 70; i++) app.send({ t: "term_in", sid: "S1", data: chunk });
    await app.waitFrame((f) => f.t === "term_error" && f.error === "rate_limit", "input rate limit"); await sleep(150);
    expect(dm.frames.filter((f) => f.t === "term_in").length).toBeLessThan(70);
  });
  it("idle: 30 min without input closes the session (device told, app told, slot free); input resets the clock", async () => {
    const { dm, app } = await ready();
    await metaSet("term", (s) => ({ ...s, lastIn: s.lastIn - 29 * 60_000 })); await alarm(); expect(await metaGet("term")).not.toBeNull();
    app.send({ t: "term_in", sid: "S1", data: b64("x") }); await dm.waitFrame((f) => f.t === "term_in");
    await alarm(); expect(await metaGet("term")).not.toBeNull();                       // the keystroke reset the clock
    await metaSet("term", (s) => ({ ...s, lastIn: s.lastIn - 31 * 60_000 })); await alarm();
    await dm.waitFrame((f) => f.t === "term_close" && f.sid === "S1", "term_close at device");
    await app.waitFrame((f) => f.t === "term_exit" && f.signal === "idle", "term_exit idle at app");
    expect(await metaGet("term")).toBeNull();
  });
  it("device socket drops: the app gets term_exit device_lost at once and the slot is cleared", async () => {
    const { dm, app } = await ready(); dm.drop();
    await app.waitFrame((f) => f.t === "term_exit" && f.signal === "device_lost", "device_lost"); expect(await metaGet("term")).toBeNull();
  });
  it("heartbeat timeout (half-open socket): the alarm reaps the device and ends the session", async () => {
    const { app } = await ready();
    await runInDurableObject(stub(), async (_i: unknown, st: DurableObjectState) => { st.storage.sql.exec(`UPDATE meta SET v=? WHERE k='dev_last_ms'`, String(Date.now() - 200_000)); });
    await alarm(); await app.waitFrame((f) => f.t === "term_exit" && f.signal === "device_lost", "device_lost after hb timeout"); expect(await metaGet("term")).toBeNull();
  });
  it("a replaced device connection also ends the session", async () => {
    const { app } = await ready(); const dm2 = daemonOf(); await dm2.connect();
    await app.waitFrame((f) => f.t === "term_exit" && f.signal === "device_lost", "device_lost on replace");
  });
  it("the term flag turned off mid-session ends it with `disabled` on the next frame / alarm", async () => {
    const { dm, app } = await ready(); await setFlag("vcl_term:main", "0");
    await alarm(); await dm.waitFrame((f) => f.t === "term_close", "device told to close"); await app.waitFrame((f) => f.t === "term_exit" && f.signal === "disabled", "disabled at app");
  });
  it("revoking the device ends the session", async () => {
    const { app } = await ready(); const me = await cookieOf(); await api(me, "DELETE", `/api/devices/${dev.deviceId}`);
    await sleep(60); expect(app.closed?.code ?? 0).toBeGreaterThan(0);
  });
});

describe("vclterm3: payload is never stored", () => {
  it("terminal input and output leave no trace in the DO tables, the event log is untouched, and D1 audit rows hold no content", async () => {
    const { dm, app } = await ready(); const before = await evCount();
    const SECRET = "TOPSECRET-PAYLOAD-4711";
    for (let i = 0; i < 30; i++) { app.send({ t: "term_in", sid: "S1", data: b64(SECRET + "-in" + i) }); dm.send({ t: "term_out", sid: "S1", seq: i, data: b64(SECRET + "-out" + i) }); }
    await app.until(() => app.frames.filter((f) => f.t === "term_out").length === 30, "all out relayed"); await dm.until(() => dm.frames.filter((f) => f.t === "term_in").length === 30, "all in relayed");
    const after = await evCount(); expect(after).toEqual(before);                      // EVENT_RETENTION not consumed: not one event added
    const all = await dump(); for (const needle of [SECRET, b64(SECRET + "-in0"), b64(SECRET + "-out0")]) expect(all).not.toContain(needle);
    app.send({ t: "term_close", sid: "S1" }); await dm.waitFrame((f) => f.t === "term_close"); dm.send({ t: "term_exit", sid: "S1", code: 0, signal: null }); await app.waitFrame((f) => f.t === "term_exit");
    await sleep(100);
    const rows = (await e.DB.prepare(`SELECT * FROM term_audit WHERE device_id=? ORDER BY id`).bind(dev.deviceId).all()).results as any[];
    expect(rows.map((r) => r.event)).toEqual(["open", "close"]);
    expect(rows[0]).toMatchObject({ scope: "main", user: USER, root: "/home/x/proj", mode: "landlock", sid: "S1" });
    expect(rows[1]).toMatchObject({ reason: "exit", mode: "landlock" }); expect(rows[1].duration_s).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
  it("the device's own exit reason (vclterm2: idle|closed|disconnect|daemon_exit) is relayed and audited", async () => {
    const { dm, app } = await ready(); dm.send({ t: "term_audit", sid: "S1", ev: "open", root: "/home/x/proj", mode: "sandbox" }); await sleep(30);
    dm.send({ t: "term_exit", sid: "S1", code: null, signal: "SIGHUP", reason: "idle" });
    await app.waitFrame((f) => f.t === "term_exit" && f.reason === "idle", "reason relayed"); await sleep(100);
    const rows = (await e.DB.prepare(`SELECT event, reason, mode FROM term_audit WHERE device_id=? ORDER BY id`).bind(dev.deviceId).all()).results as any[];
    expect(rows[1]).toMatchObject({ event: "close", reason: "idle", mode: "sandbox" });
  });
  it("a hub-side close writes the reason into the audit row", async () => {
    const { dm, app } = await ready(); dm.drop(); await app.waitFrame((f) => f.t === "term_exit"); await sleep(100);
    const rows = (await e.DB.prepare(`SELECT event, reason FROM term_audit WHERE device_id=? ORDER BY id`).bind(dev.deviceId).all()).results as any[];
    expect(rows).toEqual([{ event: "open", reason: null }, { event: "close", reason: "device_lost" }]);
  });
});

describe("vclterm3: through the Worker route (login time comes from the signed cookie)", () => {
  async function viaWorker(cookie: string) {
    const r = await call(new Request(`${ORIGIN}/api/devices/${dev.deviceId}/session`, { headers: { upgrade: "websocket", cookie, origin: ORIGIN } })); expect(r.status).toBe(101);
    const ws = (r as any).webSocket as WebSocket; ws.accept(); const frames: any[] = []; ws.addEventListener("message", (m: MessageEvent) => frames.push(JSON.parse(String(m.data)))); return { ws, frames };
  }
  it("a fresh cookie opens; a cookie whose login (lat) is 13 h old, or has none, gets login_required", async () => {
    const dm = daemonOf(); await dm.connect(); await sleep(40);
    const fresh = await cookieOf();
    const a = await viaWorker(fresh.cookie); a.ws.send(JSON.stringify({ t: "term_open", cid: "w1", root: "/home/x/proj", cols: 80, rows: 24 })); await dm.waitFrame((f) => f.t === "term_open" && f.cid === "w1", "fresh cookie reaches the device");
    dm.send({ t: "term_error", cid: "w1", error: "x" }); await sleep(40);
    const mk = async (patch: Record<string, unknown>) => { const m = await makeSession(e, USER, "github"); const s = { ...m.session, ...patch } as any; if (patch.lat === undefined) delete s.lat; return sessionCookie(await signSession(e, s)).split(";")[0]; };
    for (const patch of [{ lat: nowS() - 13 * 3600 }, { lat: undefined }]) {
      const b = await viaWorker(await mk(patch)); b.ws.send(JSON.stringify({ t: "term_open", cid: "w2", root: "/r", cols: 80, rows: 24 }));
      const t0 = Date.now(); while (!b.frames.some((f) => f.t === "term_error" && f.error === "login_required")) { if (Date.now() - t0 > 4000) throw new Error("no login_required: " + JSON.stringify(b.frames)); await sleep(10); }
    }
    expect(dm.frames.filter((f) => f.t === "term_open").length).toBe(1);
  });
});

describe("vclterm10 B1: a dead page leaves a session; the next page re-attaches (term_state)", () => {
  it("no session: no term_state. Session running: a new app socket of the owner gets term_state right after hello, and its term_attach reaches the device", async () => {
    const dm0 = daemonOf(); await dm0.connect(); await sleep(40);
    const none = await appOf(); await sleep(60); expect(has(none, "term_state")).toBe(false);
    none.drop(); dm0.drop(); await sleep(60);
    const { dm, app } = await ready();
    app.send({ t: "term_resize", sid: "S1", cols: 120, rows: 40 }); await dm.waitFrame((f) => f.t === "term_resize");
    app.drop(); await sleep(60);                                           // the page died without Stop
    const fresh = await appOf();
    const st = await fresh.waitFrame((f) => f.t === "term_state", "term_state after hello");
    expect(st).toMatchObject({ t: "term_state", sid: "S1", mode: "landlock", root: "/home/x/proj", cols: 120, rows: 40 });
    expect(typeof st.since).toBe("number");
    expect(fresh.frames.findIndex((f) => f.t === "hello")).toBeLessThan(fresh.frames.findIndex((f) => f.t === "term_state"));
    fresh.send({ t: "term_attach", sid: "S1", lastSeq: 0 }); await dm.waitFrame((f) => f.t === "term_attach" && f.sid === "S1" && f.lastSeq === 0, "attach at device");
    dm.send({ t: "term_out", sid: "S1", seq: 0, data: b64("hi") }); await fresh.waitFrame((f) => f.t === "term_out", "output follows the re-attached socket");
    expect(JSON.stringify(await dump())).not.toContain("aGk=");           // payload still never stored
  });
  it("a second term_open while a session exists attaches (term_state), no term_error, nothing new at the device", async () => {
    const { dm, app } = await ready();
    app.send({ t: "term_open", cid: "o2", root: "/home/x/proj", cols: 80, rows: 24 });
    await app.waitFrame((f) => f.t === "term_state" && f.sid === "S1", "term_state instead of limit");
    await sleep(60);
    expect(has(app, "term_error")).toBe(false);
    expect(dm.frames.filter((f) => f.t === "term_open").length).toBe(1);
  });
  it("vclterm11: S1 exits after term_state but before the attach is processed -> the owner's attach is answered with term_exit gone; a non-owner/flag-off stays silent", async () => {
    const { dm, app } = await ready();
    app.drop(); await sleep(60);
    const fresh = await appOf(); await fresh.waitFrame((f) => f.t === "term_state" && f.sid === "S1", "term_state");
    dm.send({ t: "term_exit", sid: "S1", code: 0, signal: null, reason: "closed" }); await sleep(80);   // S1 gone before the attach arrives
    fresh.frames.length = 0;
    fresh.send({ t: "term_attach", sid: "S1", lastSeq: 0 });
    const x = await fresh.waitFrame((f) => f.t === "term_exit" && f.sid === "S1", "explicit gone");
    expect(x).toMatchObject({ t: "term_exit", sid: "S1", code: null, signal: "gone" });
    expect(has(dm, "term_attach")).toBe(false);
  });
  it("a pending open (no sid yet) still answers limit", async () => {
    const dm = daemonOf(); await dm.connect(); await sleep(40);
    const app = await appOf(); app.send({ t: "term_open", cid: "o1", root: "/home/x/proj", cols: 80, rows: 24 }); await dm.waitFrame((f) => f.t === "term_open");
    app.send({ t: "term_open", cid: "o2", root: "/home/x/proj", cols: 80, rows: 24 });
    await app.waitFrame((f) => f.t === "term_error" && f.cid === "o2" && f.error === "limit", "limit while pending");
    dm.send({ t: "term_ready", cid: "o1", sid: "S1", mode: "landlock" }); await app.waitFrame((f) => f.t === "term_ready");
  });
});
