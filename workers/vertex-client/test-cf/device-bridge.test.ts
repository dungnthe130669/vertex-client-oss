import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../server/worker";
import { makeSession } from "../src/auth";
import { FakeDaemon } from "../test/fake-daemon";
import { runInDurableObject } from "cloudflare:test";
import { DeviceHub } from "../src/device-hub";

// Devices v2 step 3, hub side: the chat bridge endpoints of DeviceHub (/bridge/cmd, /bridge/events, /bridge/approval), real DO + D1 in workerd.
const e = env as any;
const ORIGIN = "https://app.test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (req: Request) => worker.fetch(req, e, ctx);
const USER = "example-user";
const cookieOf = async () => { const s = await makeSession(e, USER, "github"); return { cookie: s.cookie.split(";")[0], csrf: s.session.csrf }; };
type Me = { cookie: string; csrf: string };
const api = (me: Me, method: string, path: string, body?: unknown) => call(new Request(ORIGIN + path, { method, headers: { cookie: me.cookie, origin: ORIGIN, "x-csrf-token": me.csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
const setFlag = (name: string, v = "1") => e.DB.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(name, v).run();
async function pair(me: Me) {
  const p = await api(me, "POST", "/api/devices/pair"); const { code } = (await p.json()) as { code: string };
  const r = await call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ code, name: "laptop" }) }));
  return (await r.json()) as { deviceId: string; token: string };
}
const daemonOf = (token: string) => new FakeDaemon(async () => { const r = await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } })); expect(r.status).toBe(101); return (r as any).webSocket as WebSocket; });
const hub = (id: string, path: string, init: RequestInit = {}, user = USER) => e.DEVICES.get(e.DEVICES.idFromName(id)).fetch(new Request("https://do.internal" + path, { ...init, headers: { "x-vcl-device": id, "x-vcl-scope": "main", "x-vcl-user": user, ...(init.body ? { "content-type": "application/json" } : {}) } }));
const post = (id: string, path: string, body: unknown, user = USER) => hub(id, path, { method: "POST", body: JSON.stringify(body) }, user);
const events = async (id: string, since: number, wait = 0) => (await (await hub(id, `/bridge/events?since=${since}&wait=${wait}&conv=${CONV}`)).json()) as { events: Array<{ seq: number; e: any }>; last: number; online: boolean; gap: boolean };
const CONV = "11111111-2222-3333-4444-555555555555", OTHER = "99999999-2222-3333-4444-555555555555";

let me: Me, dev: { deviceId: string; token: string }, dm: FakeDaemon;
beforeEach(async () => {
  await setFlag("vcl:main"); await setFlag("vcl_env:main"); me = await cookieOf(); dev = await pair(me);
  dm = daemonOf(dev.token); await dm.connect(); await dm.waitFrame((f) => f.t === "welcome");
  await dm.until(() => dm.pendingAcks === 0 && dm.frames.some((f) => f.t === "welcome"));
  await new Promise((r) => setTimeout(r, 30));
});

describe("chat bridge: commands and events", () => {
  it("cmd start reaches the daemon, answers a cursor, and the lifecycle events are readable after it", async () => {
    const r = await (await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "c1", kind: "start", prompt: "hi", dir: "/w" })).json() as any;
    expect(r).toMatchObject({ ok: true, dup: false, queued: false }); expect(typeof r.since).toBe("number");
    await dm.until(() => dm.processed.length === 1, "cmd delivered");
    expect(dm.processed[0]).toMatchObject({ kind: "start", cid: "c1", prompt: "hi", dir: "/w" });
    dm.emit("session_started", { dir: "/w" });
    await new Promise((r2) => setTimeout(r2, 50));
    const ev = await events(dev.deviceId, r.since);
    const types = ev.events.map((x) => x.e.type);
    expect(types).toContain("cmd_sent"); expect(types).toContain("cmd_acked"); expect(types).toContain("session_started");
    expect(ev.events.every((x) => x.seq > r.since)).toBe(true);
  });
  it("a duplicate cid is acknowledged, not run twice", async () => {
    await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "c1", kind: "start", prompt: "hi" });
    const r = await (await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "c1", kind: "start", prompt: "hi" })).json() as any;
    expect(r.dup).toBe(true); await new Promise((r2) => setTimeout(r2, 50)); expect(dm.processed).toHaveLength(1);
  });
  it("long poll returns as soon as the daemon emits, and times out empty otherwise", async () => {
    const since = (await events(dev.deviceId, 0)).last;
    const t0 = Date.now(); const empty = await events(dev.deviceId, since, 300); expect(empty.events).toEqual([]); expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "lp1", kind: "start", prompt: "hi" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {}); await new Promise((r2) => setTimeout(r2, 60));
    const since2 = (await events(dev.deviceId, 0)).last;
    const pending = events(dev.deviceId, since2, 5000);
    setTimeout(() => dm.emit("assistant_text", { text: "x" }), 100);
    const t1 = Date.now(); const got = await pending; expect(got.events.map((x) => x.e.type)).toEqual(["assistant_text"]); expect(Date.now() - t1).toBeLessThan(2500);
  });
  it("bad bodies are refused: no conv, bad cid, empty prompt, unknown kind", async () => {
    for (const b of [{ cid: "c", kind: "start", prompt: "x" }, { conv: CONV, cid: "bad cid!", kind: "start", prompt: "x" }, { conv: CONV, cid: "c", kind: "start", prompt: "" }, { conv: CONV, cid: "c", kind: "rm", prompt: "x" }, { conv: "../x", cid: "c", kind: "start", prompt: "x" }])
      expect((await post(dev.deviceId, "/bridge/cmd", b)).status).toBe(400);
    expect(dm.processed).toHaveLength(0);
  });
});

describe("chat bridge: session ownership (a `say` only goes to the chat that started the session)", () => {
  it("say before any start, or after the session ended, is refused with not_your_session; during the session it is delivered", async () => {
    expect((await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "s0", kind: "say", text: "x" })).status).toBe(409);
    await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "c1", kind: "start", prompt: "hi" });
    await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {});
    await new Promise((r) => setTimeout(r, 50));
    expect((await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "s1", kind: "say", text: "more" })).status).toBe(200);
    await dm.until(() => dm.processed.length === 2); expect(dm.processed[1]).toMatchObject({ kind: "say", text: "more" });
    expect((await post(dev.deviceId, "/bridge/cmd", { conv: OTHER, cid: "s2", kind: "say", text: "intruder" })).status).toBe(409); // another chat cannot talk into this session
    dm.emit("session_ended", {}); await new Promise((r) => setTimeout(r, 50));
    expect((await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "s3", kind: "say", text: "late" })).status).toBe(409);
  });
  it("a busy refusal does not end the owner's session", async () => {
    await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "c1", kind: "start", prompt: "hi" });
    await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {}); await new Promise((r) => setTimeout(r, 50));
    await post(dev.deviceId, "/bridge/cmd", { conv: OTHER, cid: "c2", kind: "start", prompt: "me too" });
    dm.emit("session_error", { code: "busy" }); await new Promise((r) => setTimeout(r, 50));
    expect((await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "s1", kind: "say", text: "still mine" })).status).toBe(200);
  });
});

describe("chat bridge: approvals", () => {
  it("allow is delivered to the daemon once; a second answer and a stranger are refused", async () => {
    await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "c1", kind: "start", prompt: "hi" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {}); await new Promise((r) => setTimeout(r, 50));
    dm.emit("approval_request", { rid: "r1", tool: "Bash", preview: "ls", ttl_s: 60 }); await new Promise((r) => setTimeout(r, 80)); // raised by the chat's own session => tagged with it
    const ok = await post(dev.deviceId, "/bridge/approval", { conv: CONV, rid: "r1", allow: true }); expect(ok.status).toBe(200); expect(await ok.json()).toMatchObject({ ok: true, state: "allowed" });
    await dm.until(() => dm.processed.some((c) => c.kind === "approval"), "approval cmd"); expect(dm.processed.find((c) => c.kind === "approval")).toMatchObject({ rid: "r1", allow: true });
    const again = await post(dev.deviceId, "/bridge/approval", { conv: CONV, rid: "r1", allow: false }); expect(again.status).toBe(409); expect(await again.json()).toMatchObject({ error: "already_resolved" });
    expect((await post(dev.deviceId, "/bridge/approval", { conv: CONV, rid: "r1", allow: true }, "someone-else")).status).toBe(404); // owner pinned: another user does not even reach the hub's logic
    expect((await post(dev.deviceId, "/bridge/approval", { conv: CONV, rid: "nope", allow: true })).status).toBe(409);
    expect((await post(dev.deviceId, "/bridge/approval", { conv: CONV, rid: 5, allow: true })).status).toBe(400);
  });
});

describe("chat bridge: flag and revoke", () => {
  it("flag off => cmd/approval 404 and nothing reaches the daemon", async () => {
    await setFlag("vcl:main", "0");
    expect((await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "c1", kind: "start", prompt: "hi" })).status).toBe(404);
    await new Promise((r) => setTimeout(r, 50)); expect(dm.processed).toHaveLength(0);
  });
  it("revoke answers 410 to a poll that is already waiting, and to every later bridge call", async () => {
    const since = (await events(dev.deviceId, 0)).last;
    const waiting = hub(dev.deviceId, `/bridge/events?since=${since}&wait=10000&conv=${CONV}`);
    await new Promise((r) => setTimeout(r, 100));
    expect((await api(me, "DELETE", "/api/devices/" + dev.deviceId)).status).toBe(200);
    expect((await waiting).status).toBe(410);
    expect((await hub(dev.deviceId, `/bridge/events?since=0&wait=0&conv=${CONV}`)).status).toBe(410);
    expect((await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "c9", kind: "start", prompt: "x" })).status).toBe(410);
  });
});

describe("devv2s3d: an observed vcl_env OFF invalidates every bridge request that is still in flight", () => {
  // A deterministic gate in front of D1: every settings read (except the `cap:*` narrowing rows added by wscaps1, answered at once as absent) parks until the test releases it, and answers with the flag values AT RELEASE time.
  const gatedDb = (flags: Record<string, string>) => {
    const parked: Array<() => void> = [];
    const db = { prepare: (sql: string) => ({ bind: (...b: unknown[]) => ({ first: () => String(b[0]).startsWith("cap:") ? Promise.resolve(null) : new Promise((res) => parked.push(() => { const v = flags[String(b[0])]; res(v === undefined ? null : { value: v }); })) }) }) } as unknown as D1Database;
    const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
    const release = async () => { const q = parked.splice(0); q.forEach((f) => f()); await tick(); };
    const drain = async (done: () => boolean) => { for (let i = 0; i < 20 && !done(); i++) { await release(); await new Promise((r) => setTimeout(r, 0)); } };
    const releaseAfterFirst = async () => { const q = parked.splice(1); q.forEach((f) => f()); await tick(); };
    return { db, release, drain, releaseAfterFirst, parked: () => parked.length, tick };
  };
  const reqs: Array<[string, string, Record<string, unknown>]> = [
    ["start", "/bridge/cmd", { conv: CONV, cid: "race-start", kind: "start", prompt: "evil" }],
    ["stop", "/bridge/cmd", { conv: CONV, cid: "race-stop", kind: "stop" }],
    ["approval", "/bridge/approval", { conv: CONV, rid: "race-rid", allow: true }],
  ];
  for (const [name, path, body] of reqs) it(`${name}: A read ON and paused, B observed OFF, A resumes => 404 disabled, no outbox row, approval untouched`, async () => {
    const flags: Record<string, string> = { "vcl:main": "1", "vcl_env:main": "1" };
    const g = gatedDb(flags);
    await runInDurableObject(e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId)), async (_i: DeviceHub, st: DurableObjectState) => {
      st.storage.sql.exec(`INSERT INTO approvals (rid, tool, state, created_at, expires_at, conv) VALUES ('race-rid','Bash','pending',?,?,'11111111-2222-3333-4444-555555555555')`, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 600);
      const hub = new DeviceHub(st, { ...e, DB: g.db });
      const h = { "content-type": "application/json", "x-vcl-device": dev.deviceId, "x-vcl-scope": "main", "x-vcl-user": USER };
      const mk = (b: unknown) => hub.fetch(new Request("https://do.internal" + path, { method: "POST", headers: h, body: JSON.stringify(b) }));
      const outbox = () => (st.storage.sql.exec(`SELECT COUNT(*) AS n FROM outbox WHERE cid IN ('race-start','race-stop') OR cid='approval:race-rid'`).toArray()[0] as any).n as number;
      const waitParked = async (n: number) => { for (let i = 0; i < 400 && g.parked() < n; i++) await new Promise((r) => setTimeout(r, 5)); expect(g.parked()).toBe(n); };
      const A = mk(body);
      await waitParked(1); await g.release();   // A: vcl read ON
      await waitParked(1); await g.release();   // A: vcl_env read ON
      await waitParked(1);                      // A is now parked inside its own flagOn() read (the one that used to be unguarded against vcl_env)
      flags["vcl_env:main"] = "0";
      const B = mk({ conv: CONV, cid: "race-b", kind: "start", prompt: "b" }); // the OFF observer (a stop would be allowed as cleanup)
      await waitParked(2); await g.releaseAfterFirst();   // B: vcl read ON (A's read stays parked)
      await waitParked(2); await g.releaseAfterFirst();   // B: vcl_env read OFF => 404
      const rb = await B;
      expect(rb.status).toBe(404);
      await g.release(); // A's vcl read finally settles ON
      const ra = await A;
      expect(ra.status).toBe(404); expect(await ra.json()).toEqual({ ok: false, error: "disabled" });
      expect(outbox()).toBe(0);
      expect((st.storage.sql.exec(`SELECT state FROM approvals WHERE rid='race-rid'`).toArray()[0] as any).state).toBe("pending");
    });
  });
  it("control: nothing observed OFF => the same three requests succeed", async () => {
    await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "ok-start", kind: "start", prompt: "hi" });
    await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "ok-stop", kind: "stop" });
    expect((await post(dev.deviceId, "/bridge/cmd", { conv: CONV, cid: "ok-stop2", kind: "stop" })).status).toBe(200);
  });
});
