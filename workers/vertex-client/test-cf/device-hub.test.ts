import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../server/worker";
import { makeSession } from "../src/auth";
import { FakeApp, FakeDaemon } from "../test/fake-daemon";
import { runInDurableObject } from "cloudflare:test";
import { DeviceHub } from "../src/device-hub";

// The VCL bridge through server/worker.ts in workerd: real D1 (migrations applied per test), the real DeviceHub DO, real WebSockets.
const e = env as any;
// Parks only the `vcl:<base>` flag read (the one these races are about). Since wscaps1 the flag check also reads `cap:<class>:devices` first (caps.ts devicesOn): that row is answered at once (absent = not narrowed),
// otherwise it would consume pending[0]/[1] and the real vcl read would park behind it, never settled.
const parkedVclDb = (pending: Array<(v: string | null) => void>) => ({ prepare: () => ({ bind: (name: unknown) => ({ first: () => String(name).startsWith("vcl:") ? new Promise((res) => pending.push((v) => res(v === null ? null : { value: v }))) : Promise.resolve(null) }) }) }) as unknown as D1Database;
const ORIGIN = "https://app.test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (req: Request) => worker.fetch(req, e, ctx);
const cookieOf = async (user = "example-user") => { const s = await makeSession(e, user, "github"); return { cookie: s.cookie.split(";")[0], csrf: s.session.csrf }; };
const e2eCookie = async () => {
  const r = await call(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": e.E2E_TOKEN, origin: ORIGIN } })); expect(r.status).toBe(200);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return { cookie, csrf: ((await (await call(new Request(ORIGIN + "/api/me", { headers: { cookie } }))).json()) as any).csrf as string };
};
type Me = { cookie: string; csrf: string };
const api = (me: Me, method: string, path: string, body?: unknown) => call(new Request(ORIGIN + path, { method, headers: { cookie: me.cookie, origin: ORIGIN, "x-csrf-token": me.csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
const enable = (base = "main", v = "1") => e.DB.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`vcl:${base}`, v).run();

async function pair(me: Me, name = "laptop") {
  const p = await api(me, "POST", "/api/devices/pair"); expect(p.status).toBe(201);
  const { code } = (await p.json()) as { code: string };
  const r = await call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ code, name }) }));
  expect(r.status).toBe(201);
  return (await r.json()) as { deviceId: string; token: string };
}
const daemonOf = (token: string) => new FakeDaemon(async () => { const r = await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } })); expect(r.status).toBe(101); return r.webSocket!; });
const appOf = (me: Me, id: string) => new FakeApp(async (since) => { const r = await call(new Request(`${ORIGIN}/api/devices/${id}/session?since=${since}`, { headers: { upgrade: "websocket", cookie: me.cookie, origin: ORIGIN } })); expect(r.status).toBe(101); return r.webSocket!; });
const hubState = async (id: string, me = "example-user") => (await (e.DEVICES.get(e.DEVICES.idFromName(id)).fetch(new Request("https://do.internal/state", { headers: { "x-vcl-device": id, "x-vcl-scope": "main", "x-vcl-user": me } })))).json() as Promise<any>;

let erich: Me;
beforeEach(async () => { await enable(); erich = await cookieOf(); });

describe("flag + isolation", () => {
  it("flag off (no row, and row '0') => every route is a plain 404, daemon dial-in too", async () => {
    await e.DB.prepare(`DELETE FROM settings WHERE name='vcl:main'`).run();
    for (const [m, p] of [["POST", "/api/devices/pair"], ["GET", "/api/devices"], ["DELETE", "/api/devices/" + "a".repeat(32)]] as const) expect((await api(erich, m, p)).status).toBe(404);
    expect((await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: "Bearer x" } }))).status).toBe(401); // no valid token to look up, so no row, no scope: unauthenticated, not 404
    await enable("main", "0");
    expect((await api(erich, "GET", "/api/devices")).status).toBe(404);
  });
  it("a device paired while on stops dialling in (404) when the flag goes off, and works again when it is back on", async () => {
    const d = await pair(erich);
    await enable("main", "0");
    expect((await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${d.token}` } }))).status).toBe(404);
    expect((await api(erich, "GET", "/api/devices/" + d.deviceId + "/session")).status).toBe(404);
    await enable();
    const dm = daemonOf(d.token); await dm.connect(); await dm.waitFrame((f) => f.t === "welcome");
  });
  it("a user only sees and reaches their own devices: another user gets 404 on list, session and delete", async () => {
    await enable("e2e");
    const d = await pair(erich);
    const bot = await e2eCookie();
    const lr = await api(bot, "GET", "/api/devices"); expect([lr.status, ((await lr.json()) as any).devices]).toEqual([200, []]);
    expect((await call(new Request(`${ORIGIN}/api/devices/${d.deviceId}/session`, { headers: { upgrade: "websocket", cookie: bot.cookie, origin: ORIGIN } }))).status).toBe(404);
    expect((await api(bot, "DELETE", "/api/devices/" + d.deviceId)).status).toBe(404);
    expect(((await (await api(erich, "GET", "/api/devices")).json()) as any).devices.map((x: any) => x.id)).toEqual([d.deviceId]);
  });
  it("the DO itself refuses a request for a device from another scope/user (defence in depth behind the Worker)", async () => {
    const d = await pair(erich);
    const dm = daemonOf(d.token); await dm.connect(); await dm.waitFrame((f) => f.t === "welcome");
    const stub = e.DEVICES.get(e.DEVICES.idFromName(d.deviceId));
    for (const h of [{ "x-vcl-scope": "e2e", "x-vcl-user": "example-user" }, { "x-vcl-scope": "main", "x-vcl-user": "someone-else" }])
      expect((await stub.fetch(new Request("https://do.internal/ws/app", { headers: { upgrade: "websocket", "x-vcl-device": d.deviceId, ...h } }))).status).toBe(404);
  });
  it("PWA socket from another origin is refused (cross-site WebSocket hijack)", async () => {
    const d = await pair(erich);
    for (const origin of ["https://evil.test", undefined]) {
      const r = await call(new Request(`${ORIGIN}/api/devices/${d.deviceId}/session`, { headers: { upgrade: "websocket", cookie: erich.cookie, ...(origin ? { origin } : {}) } }));
      expect(r.status).toBe(403);
    }
  });
});

describe("device roots (folders the daemon allows)", () => {
  const list = async (me: Me) => ((await (await api(me, "GET", "/api/devices")).json()) as any).devices as any[];
  const connect = async (d: { deviceId: string; token: string }, roots?: unknown) => { const dm = daemonOf(d.token); if (roots !== undefined) dm.info = { ...dm.info, roots }; await dm.connect(); await appOf(erich, d.deviceId).connect(); return dm; };
  it("stored from the hello and returned in the device list; older vcl (no roots) => field absent, not empty", async () => {
    const d = await pair(erich);
    expect((await list(erich))[0].roots).toBeUndefined();
    await connect(d, [{ label: "Projects", path: "/Users/x/Projects" }, { label: "Docs", path: "/Users/x/Docs" }]);
    expect((await list(erich))[0].roots).toEqual([{ label: "Projects", path: "/Users/x/Projects" }, { label: "Docs", path: "/Users/x/Docs" }]);
    expect((await hubState(d.deviceId)).roots).toHaveLength(2);
    await connect(d, []);                                       // reported, none added yet
    expect((await list(erich))[0].roots).toEqual([]);
    await connect(d);                                           // the Mac downgraded to an older vcl: unknown again
    expect((await list(erich))[0].roots).toBeUndefined();
  });
  it("sanitised again server-side: caps, types, control chars, duplicates; unknown info fields ignored", async () => {
    const d = await pair(erich);
    const junk: unknown[] = [null, 5, "x", { label: 1, path: "/a" }, { label: "a", path: "" }, { label: "ctl", path: "/a/b\u0000c" }, { label: "nl", path: "/a/b\nc" }, { label: "long", path: "/" + "p".repeat(300) }, { label: "ok", path: "/ok" }, { label: "ok2", path: "/ok" }];
    for (let i = 0; i < 30; i++) junk.push({ label: `d${i}`, path: `/d/${i}` });
    const dm = daemonOf(d.token); dm.info = { name: "x", version: "9", roots: junk, secret: "nope" }; await dm.connect();
    const r = (await list(erich))[0];
    expect(r.roots).toHaveLength(20); expect(r.roots[0]).toEqual({ label: "ok", path: "/ok" });
    expect(JSON.stringify(r)).not.toContain("nope");
    const dm2 = daemonOf(d.token); dm2.info = { roots: "not-an-array" }; await dm2.connect();
    expect((await list(erich))[0].roots).toBeUndefined();
  });
  it("only the owner sees them: another user's list is empty and the DO refuses their headers", async () => {
    await enable("e2e");
    const d = await pair(erich); await connect(d, [{ label: "Secret", path: "/Users/x/Secret" }]);
    const bot = await e2eCookie();
    expect(JSON.stringify(await list(bot))).not.toContain("Secret");
    const r = await e.DEVICES.get(e.DEVICES.idFromName(d.deviceId)).fetch(new Request("https://do.internal/state", { headers: { "x-vcl-device": d.deviceId, "x-vcl-scope": "e2e", "x-vcl-user": "mallory" } }));
    expect(r.status).toBeGreaterThanOrEqual(400); expect(await r.text()).not.toContain("Secret");
  });
});

describe("resume without loss or duplication", () => {
  it("daemon events reach the app in order; an app that drops mid-stream replays from its cursor, exactly once", async () => {
    const d = await pair(erich); const dm = daemonOf(d.token); await dm.connect();
    const app = appOf(erich, d.deviceId); await app.connect();
    await dm.until(() => dm.frames.some((f) => f.t === "welcome")); await app.until(() => app.types().includes("device_online"));
    for (let i = 1; i <= 5; i++) dm.emit("text", { n: i });
    await app.until(() => app.events.filter((x) => x.e.type === "text").length === 5);
    app.drop();
    for (let i = 6; i <= 10; i++) dm.emit("text", { n: i });     // arrive while no app is attached
    await dm.until(() => dm.pendingAcks === 0);
    await app.connect();                                           // resumes from app.seq
    await app.until(() => app.events.filter((x) => x.e.type === "text").length === 10);
    expect(app.events.filter((x) => x.e.type === "text").map((x) => x.e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(app.errors).toEqual([]);
  });
  it("a fresh app (since=0) gets the whole retained log; an app that was ahead of a hub restart sees no duplicate", async () => {
    const d = await pair(erich); const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    dm.emit("text", { n: 1 }); dm.emit("text", { n: 2 }); await dm.until(() => dm.pendingAcks === 0);
    const a1 = appOf(erich, d.deviceId); await a1.connect(); await a1.until(() => a1.types().filter((t) => t === "text").length === 2);
    const a2 = appOf(erich, d.deviceId); a2.seq = a1.seq; await a2.connect(); await new Promise((r) => setTimeout(r, 50));
    expect(a2.events).toEqual([]); expect(a2.errors).toEqual([]);
  });
  it("daemon drops and reconnects: events sent before the drop that were never acked are resent and applied once; a duplicate resend is acked and ignored", async () => {
    const d = await pair(erich); const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    const app = appOf(erich, d.deviceId); await app.connect();
    dm.emit("text", { n: 1 }); await dm.until(() => dm.pendingAcks === 0);
    dm.drop(); await dm.until(() => dm.closed !== null);
    dm.emit("text", { n: 2 }); dm.emit("text", { n: 3 });         // written while offline: stay unacked
    await dm.connect();                                            // welcome(lastDseq=1) -> hello -> resend 2,3
    await dm.until(() => dm.pendingAcks === 0);
    const acks = dm.frames.filter((f) => f.t === "ack").length;
    dm.resend(3); dm.resend(2);                                    // a client that cannot tell what arrived re-sends: must not duplicate
    await dm.until(() => dm.frames.filter((f) => f.t === "ack").length >= acks + 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(app.events.filter((x) => x.e.type === "text").map((x) => x.e.n)).toEqual([1, 2, 3]);
    expect(app.types()).toContain("device_offline"); expect(app.errors).toEqual([]);
    expect((await hubState(d.deviceId)).lastDseq).toBe(3);
  });
  it("a gap in dseq is refused with resync, and the resend fills it in order", async () => {
    const d = await pair(erich); const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    const app = appOf(erich, d.deviceId); await app.connect();
    dm.send({ t: "ev", dseq: 3, e: { type: "text", n: 3 } });      // 1 and 2 were "lost"
    await dm.waitFrame((f) => f.t === "resync" && f.expect === 1);
    expect(app.events.filter((x) => x.e.type === "text")).toEqual([]);
  });
  it("commands queued while the daemon is offline are delivered once on reconnect, and ones it already processed are not redelivered", async () => {
    const d = await pair(erich); const dm = daemonOf(d.token); const app = appOf(erich, d.deviceId); await app.connect();
    app.send({ t: "cmd", cid: "c1", kind: "say", text: "hello" }); app.send({ t: "cmd", cid: "c2", kind: "stop" });
    await app.until(() => app.frames.filter((f) => f.t === "cmd_ack").length === 2);
    app.send({ t: "cmd", cid: "c1", kind: "say", text: "hello" });        // PWA retry of the same command id
    await app.until(() => app.frames.some((f) => f.t === "cmd_ack" && f.cid === "c1" && f.dup === true));
    await dm.connect(); await dm.until(() => dm.processed.length === 2);
    expect(dm.processed.map((c) => [c.cseq, c.kind])).toEqual([[1, "say"], [2, "stop"]]);
    dm.drop(); await dm.until(() => dm.closed !== null); await dm.connect();   // hello(lastCseq=2): nothing resent
    await new Promise((r) => setTimeout(r, 80));
    expect(dm.processed.length).toBe(2); expect(dm.duplicatesSkipped).toBe(0);
    app.send({ t: "cmd", cid: "c3", kind: "start", prompt: "go", dir: "/tmp/x" });
    await dm.until(() => dm.processed.length === 3); expect(dm.processed[2]).toMatchObject({ cseq: 4, kind: "start", prompt: "go" }); expect(dm.barriers.map((b) => b.cseq)).toEqual([3]);   // cseq 3 = the replay barrier the hello after the drop opened (devv2s3v)
  });
  it("a command the daemon got but never acked is redelivered after a drop (at-least-once) and the daemon skips it by cseq", async () => {
    const d = await pair(erich); const dm = daemonOf(d.token); dm.autoAck = false; await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    const app = appOf(erich, d.deviceId); await app.connect();
    app.send({ t: "cmd", cid: "c1", kind: "say", text: "x" }); await dm.until(() => dm.processed.length === 1);
    dm.lastCseq = 0; // the daemon crashed before persisting its position: it now reports lastCseq 0 on hello
    dm.drop(); await dm.until(() => dm.closed !== null); await dm.connect();
    await dm.until(() => dm.processed.length === 2);
    expect(dm.processed.map((c) => c.cseq)).toEqual([1, 1]);
  });
});

describe("approvals", () => {
  const request = async (dm: FakeDaemon, app: FakeApp, rid: string, ttl_s?: number) => { dm.emit("approval_request", { rid, tool: "Bash", preview: "rm -rf build", ...(ttl_s ? { ttl_s } : {}) }); await app.until(() => app.events.some((x) => x.e.type === "approval_request" && x.e.rid === rid), "approval_request"); };
  async function setup() { const d = await pair(erich); const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome")); const app = appOf(erich, d.deviceId); await app.connect(); return { d, dm, app }; }

  it("request -> response is forwarded to the daemon as an approval command, bound to the request id; the app sees it resolved", async () => {
    const { dm, app } = await setup(); await request(dm, app, "r1");
    const req = app.events.find((x) => x.e.type === "approval_request")!.e; expect(req).toMatchObject({ tool: "Bash", preview: "rm -rf build", ttl_s: 300 }); expect(req.expires_at).toBeGreaterThan(Date.now() / 1000);
    app.send({ t: "approval_res", rid: "r1", allow: true });
    await dm.until(() => dm.processed.some((c) => c.kind === "approval"));
    expect(dm.processed.find((c) => c.kind === "approval")).toMatchObject({ rid: "r1", allow: true });
    await app.until(() => app.events.some((x) => x.e.type === "approval_resolved" && x.e.state === "allowed"));
  });
  it("duplicate / conflicting second response: first wins, the second is an error and is NOT forwarded", async () => {
    const { dm, app } = await setup(); await request(dm, app, "r1");
    app.send({ t: "approval_res", rid: "r1", allow: false }); app.send({ t: "approval_res", rid: "r1", allow: true }); app.send({ t: "approval_res", rid: "r1", allow: false });
    await app.until(() => app.frames.filter((f) => f.t === "err" && f.code === "already_resolved").length === 2);
    await new Promise((r) => setTimeout(r, 50));
    const approvals = dm.processed.filter((c) => c.kind === "approval");
    expect(approvals.length).toBe(1); expect(approvals[0]).toMatchObject({ rid: "r1", allow: false });
  });
  it("devv2s3v: after a reconnect a request that arrives before the barrier cack (however late) is never offered and is denied; one after the cack is offered", async () => {
    const { dm, app } = await setup(); dm.drop(); await dm.until(() => dm.closed !== null); dm.autoAck = false; await dm.connect();
    await dm.until(() => dm.barriers.length === 1, "barrier received (sent after the hello)");
    await new Promise((r) => setTimeout(r, 1200));                                         // no clock decides: still closed
    dm.emit("approval_request", { rid: "late", tool: "Bash", preview: "x" });
    await dm.until(() => dm.processed.some((c) => c.kind === "approval" && (c as any).rid === "late" && (c as any).allow === false), "hub deny");
    expect(app.events.some((x) => x.e.type === "approval_request" && x.e.rid === "late")).toBe(false);
    dm.send({ t: "cack", cseq: dm.barriers[0].cseq }); await new Promise((r) => setTimeout(r, 100));
    await request(dm, app, "fresh");
  });
  it("an unknown request id is refused (a response cannot be invented for a request the device never made)", async () => {
    const { dm, app } = await setup();
    app.send({ t: "approval_res", rid: "nope", allow: true }); await app.waitFrame((f) => f.t === "err" && f.code === "unknown_request");
    expect(dm.processed).toEqual([]);
  });
  it("an expired request cannot be approved: a late response is refused, and the daemon is told deny/expired", async () => {
    const { d, dm, app } = await setup(); await request(dm, app, "r1", 1);
    await new Promise((r) => setTimeout(r, 2200));
    app.send({ t: "approval_res", rid: "r1", allow: true });
    await app.waitFrame((f) => f.t === "err" && f.code === "expired");
    await dm.until(() => dm.processed.some((c) => c.kind === "approval"));
    expect(dm.processed.filter((c) => c.kind === "approval")).toEqual([expect.objectContaining({ rid: "r1", allow: false, reason: "expired" })]);
    expect(app.events.some((x) => x.e.type === "approval_resolved" && x.e.state === "expired")).toBe(true);
    expect((await hubState(d.deviceId)).approvals).toEqual([expect.objectContaining({ rid: "r1", state: "expired" })]);
  }, 15000);
  it("the alarm expires a request nobody answered (no response needed), and a reconnecting app never sees it as live", async () => {
    const { dm, app } = await setup(); await request(dm, app, "r1", 1);
    await app.until(() => app.events.some((x) => x.e.type === "approval_resolved" && x.e.state === "expired"), "alarm expiry", 8000);
    await dm.until(() => dm.processed.some((c) => c.kind === "approval" && c.allow === false));
  }, 15000);
  it("the response is bound to the owning user: a session of another user cannot reach the device at all, and a forged same-DO frame from another user is forbidden", async () => {
    const { d, dm, app } = await setup(); await request(dm, app, "r1");
    // Another user's PWA socket straight into the DO with matching device/scope headers but a different user is refused at fetch (owner pinned).
    const stub = e.DEVICES.get(e.DEVICES.idFromName(d.deviceId));
    const r = await stub.fetch(new Request("https://do.internal/ws/app", { headers: { upgrade: "websocket", "x-vcl-device": d.deviceId, "x-vcl-scope": "main", "x-vcl-user": "mallory" } }));
    expect(r.status).toBe(404);
    expect(dm.processed).toEqual([]);
  });
  it("the daemon cannot forge hub-owned event types", async () => {
    const { dm, app } = await setup();
    dm.emit("approval_resolved", { rid: "r1", state: "allowed", by: "me" }); dm.emit("device_online");
    await dm.until(() => dm.frames.filter((f) => f.t === "err" && f.code === "reserved_type").length === 2);
    expect(app.events.filter((x) => x.e.type === "approval_resolved")).toEqual([]);
  });
});

describe("stop, disconnect, revoke", () => {
  it("Stop reaches the daemon as a command; Disconnect closes only the daemon socket (4001), keeps the device paired, and the daemon can dial in again", async () => {
    const d = await pair(erich); const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    const app = appOf(erich, d.deviceId); await app.connect();
    app.send({ t: "cmd", cid: "s1", kind: "stop" }); await dm.until(() => dm.processed.some((c) => c.kind === "stop"));
    app.send({ t: "disconnect" }); await dm.until(() => dm.closed !== null);
    expect(dm.closed!.code).toBe(4001);
    await app.until(() => app.types().includes("device_offline"));
    expect(((await (await api(erich, "GET", "/api/devices")).json()) as any).devices).toHaveLength(1);
    const again = daemonOf(d.token); await again.connect(); await again.waitFrame((f) => f.t === "welcome");
  });
  it("revoke: the live daemon and app sockets are closed 4003, the device vanishes from the list, the token and the session endpoint stop working, the token hash is wiped", async () => {
    const d = await pair(erich); const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    const app = appOf(erich, d.deviceId); await app.connect();
    const r = await api(erich, "DELETE", "/api/devices/" + d.deviceId); expect(r.status).toBe(200); expect(((await r.json()) as any).closed).toBe(true);
    await dm.until(() => dm.closed !== null); await app.until(() => app.closed !== null);
    expect(dm.closed!.code).toBe(4003); expect(app.closed!.code).toBe(4003);
    expect(((await (await api(erich, "GET", "/api/devices")).json()) as any).devices).toEqual([]);
    expect((await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${d.token}` } }))).status).toBe(401);
    expect((await call(new Request(`${ORIGIN}/api/devices/${d.deviceId}/session`, { headers: { upgrade: "websocket", cookie: erich.cookie, origin: ORIGIN } }))).status).toBe(404);
    expect((await api(erich, "DELETE", "/api/devices/" + d.deviceId)).status).toBe(404);
    const row = await e.DB.prepare(`SELECT token_hash, revoked_at FROM devices WHERE id=?`).bind(d.deviceId).first();
    expect(row.token_hash).toBeNull(); expect(row.revoked_at).toBeGreaterThan(0);
    // The DO tombstone: even a direct hit with the right headers never serves again.
    const stub = e.DEVICES.get(e.DEVICES.idFromName(d.deviceId));
    expect((await stub.fetch(new Request("https://do.internal/ws/device", { headers: { upgrade: "websocket", "x-vcl-device": d.deviceId, "x-vcl-scope": "main", "x-vcl-user": "example-user" } }))).status).toBe(410);
  });
  it("revoke when the DO call is lost: D1 alone revokes, and the DO alarm closes the live socket on its next re-check", async () => {
    const d = await pair(erich); const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    await e.DB.prepare(`UPDATE devices SET revoked_at=?, token_hash=NULL WHERE id=?`).bind(Math.floor(Date.now() / 1000), d.deviceId).run(); // as if /revoke never arrived
    const stub = e.DEVICES.get(e.DEVICES.idFromName(d.deviceId));
    await (await import("cloudflare:test")).runDurableObjectAlarm(stub);
    await dm.until(() => dm.closed !== null); expect(dm.closed!.code).toBe(4003);
  });
});

describe("pairing", () => {
  it("the token is returned once and only its hash is stored; the pairing code is stored hashed too", async () => {
    const d = await pair(erich);
    const row = await e.DB.prepare(`SELECT * FROM devices WHERE id=?`).bind(d.deviceId).first();
    expect(JSON.stringify(row)).not.toContain(d.token.split(".")[1]);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const pr = await e.DB.prepare(`SELECT * FROM device_pairings`).all();
    for (const p of pr.results) expect(p.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(((await (await api(erich, "GET", "/api/devices")).json()) as any))).not.toContain(d.token);
  });
  it("a code is single use, and an expired code is refused", async () => {
    const p = await (await api(erich, "POST", "/api/devices/pair")).json() as { code: string };
    const redeem = (code: string, ip = "198.51.100.1") => call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ code, name: "x" }) }));
    expect((await redeem(p.code.toLowerCase())).status).toBe(201);
    expect((await redeem(p.code)).status).toBe(400);
    const q = await (await api(erich, "POST", "/api/devices/pair")).json() as { code: string };
    await e.DB.prepare(`UPDATE device_pairings SET expires_at=? WHERE used_at IS NULL`).bind(Math.floor(Date.now() / 1000) - 1).run();
    expect((await redeem(q.code)).status).toBe(400);
  });
  it("two simultaneous redeems of one code produce exactly one device", async () => {
    const p = await (await api(erich, "POST", "/api/devices/pair")).json() as { code: string };
    const rs = await Promise.all([1, 2, 3, 4].map((i) => call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100." + i }, body: JSON.stringify({ code: p.code, name: "race" + i }) }))));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 400, 400, 400]);
    expect((await e.DB.prepare(`SELECT COUNT(*) AS n FROM devices`).first()).n).toBe(1);
  });
  it("rate limits: wrong guesses lock the client address out (429) even when the next guess would be right; minting codes is capped per user", async () => {
    const good = await (await api(erich, "POST", "/api/devices/pair")).json() as { code: string };
    const redeem = (code: string, ip: string) => call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ code, name: "x" }) }));
    for (let i = 0; i < 8; i++) expect((await redeem("AAAAAAAA", "192.0.2.9")).status).toBe(400);
    expect((await redeem(good.code, "192.0.2.9")).status).toBe(429);
    expect((await redeem(good.code, "192.0.2.10")).status).toBe(201);           // another address is not affected
    let last = 201; for (let i = 0; i < 6 && last === 201; i++) last = (await api(erich, "POST", "/api/devices/pair")).status;
    expect(last).toBe(429);
  });
  it("garbage tokens and bodies are rejected without a 5xx", async () => {
    for (const t of ["", "vcl_", "vcl_" + "a".repeat(32) + ".short", "Bearer"]) expect((await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${t}` } }))).status).toBe(401);
    expect((await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket" } }))).status).toBe(401);
    expect((await call(new Request(ORIGIN + "/device/pair", { method: "POST", body: "{nope" }))).status).toBe(400);
    const d = await pair(erich);
    const wrong = d.token.slice(0, -1) + (d.token.endsWith("A") ? "B" : "A");
    expect((await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${wrong}` } }))).status).toBe(401);
    expect((await call(new Request(ORIGIN + "/device", { headers: { authorization: `Bearer ${d.token}` } }))).status).toBe(426);
  });
  it("an expired token (30 days idle) is refused", async () => {
    const d = await pair(erich);
    await e.DB.prepare(`UPDATE devices SET last_seen=? WHERE id=?`).bind(Math.floor(Date.now() / 1000) - 31 * 86400, d.deviceId).run();
    expect((await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${d.token}` } }))).status).toBe(401);
  });
});

describe("kill switch: vcl:main OFF stops established sockets", () => {
  const stubOf = (id: string) => e.DEVICES.get(e.DEVICES.idFromName(id));
  async function setup() {
    const d = await pair(erich); const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    const app = appOf(erich, d.deviceId); await app.connect();
    dm.emit("approval_request", { rid: "k1", tool: "Bash", preview: "ls" }); await app.until(() => app.events.some((x) => x.e.type === "approval_request" && x.e.rid === "k1"), "approval_request");
    return { d, dm, app };
  }
  const state = async (id: string) => (await hubState(id)).approvals.find((a: any) => a.rid === "k1").state;

  it("flag OFF (TTL elapsed on the live instance): the approval is not forwarded, the command is dropped, both sockets close 4005; ON again => the device works", async () => {
    const { d, dm, app } = await setup();
    await enable("main", "0");
    await runInDurableObject(stubOf(d.deviceId), async (inst: DeviceHub) => { (inst as any).flagAt = 0; }); // the 10 s cache has expired
    app.send({ t: "approval_res", rid: "k1", allow: true });
    await app.until(() => app.closed !== null); await dm.until(() => dm.closed !== null);
    expect([app.closed!.code, dm.closed!.code]).toEqual([4005, 4005]);
    expect(dm.processed).toEqual([]); expect(await state(d.deviceId)).toBe("pending");
    await enable();
    const again = daemonOf(d.token); await again.connect(); await again.waitFrame((f) => f.t === "welcome");
    const app2 = appOf(erich, d.deviceId); await app2.connect(); app2.send({ t: "approval_res", rid: "k1", allow: true });
    await again.until(() => again.processed.some((c) => c.kind === "approval"));
  });
  it("after DO reconstruction (empty memory, same storage and sockets): a command and an approval are dropped and both sockets close", async () => {
    const { d, dm, app } = await setup();
    await enable("main", "0");
    await runInDurableObject(stubOf(d.deviceId), async (_i: DeviceHub, st: DurableObjectState) => {
      const fresh = new DeviceHub(st, e), sock = st.getWebSockets("app")[0];
      await fresh.webSocketMessage(sock, JSON.stringify({ t: "cmd", cid: "c1", kind: "stop" }));
      await fresh.webSocketMessage(sock, JSON.stringify({ t: "approval_res", rid: "k1", allow: true }));
    });
    await app.until(() => app.closed !== null); await dm.until(() => dm.closed !== null);
    expect([app.closed!.code, dm.closed!.code]).toEqual([4005, 4005]);
    expect(dm.processed).toEqual([]); expect(await state(d.deviceId)).toBe("pending");
  });
  it("a daemon event after flag OFF is not forwarded to the app, and the sockets close", async () => {
    const { d, dm, app } = await setup();
    await enable("main", "0");
    await runInDurableObject(stubOf(d.deviceId), async (inst: DeviceHub) => { (inst as any).flagAt = 0; });
    const before = app.events.length; dm.emit("text", { n: 1 });
    await app.until(() => app.closed !== null); await dm.until(() => dm.closed !== null);
    expect(app.events.length).toBe(before); expect(dm.closed!.code).toBe(4005);
  });
  it("the alarm closes both sockets when the flag is OFF, without any frame", async () => {
    const { d, dm, app } = await setup();
    await enable("main", "0");
    await (await import("cloudflare:test")).runDurableObjectAlarm(stubOf(d.deviceId));
    await app.until(() => app.closed !== null); await dm.until(() => dm.closed !== null);
    expect([app.closed!.code, dm.closed!.code]).toEqual([4005, 4005]);
  });
  it("race: a flag read that started before an OFF was observed cannot let its approval through nor re-cache ON", async () => {
    const { d, dm, app } = await setup();
    const pending: Array<(v: string | null) => void> = [];
    const fakeDb = parkedVclDb(pending);
    await runInDurableObject(stubOf(d.deviceId), async (_i: DeviceHub, st: DurableObjectState) => {
      const hub = new DeviceHub(st, { ...e, DB: fakeDb }), sock = st.getWebSockets("app")[0];
      const a = hub.webSocketMessage(sock, JSON.stringify({ t: "approval_res", rid: "k1", allow: true })); // A: read #1 in flight
      const b = hub.webSocketMessage(sock, JSON.stringify({ t: "cmd", cid: "c2", kind: "stop" }));        // B: read #2 in flight
      for (let i = 0; i < 50 && pending.length < 2; i++) await Promise.resolve(); expect(pending.length).toBe(2); // both vcl reads parked (the cap:* read before each takes a few microtasks)
      pending[1]("0"); await b;                                  // the flag flipped OFF: B observes it and closes both sockets
      expect((hub as any).flagAt).toBe(0);
      pending[0]("1"); await a;                                  // A's ON read was issued before the OFF: stale
      expect((hub as any).flagVal).toBe(false); expect((hub as any).flagAt).toBe(0); // cache stays OFF-observed
    });
    await app.until(() => app.closed !== null); await dm.until(() => dm.closed !== null);
    expect([app.closed!.code, dm.closed!.code]).toEqual([4005, 4005]);
    expect(await state(d.deviceId)).toBe("pending"); expect(dm.processed).toEqual([]);
  });
  it("race (caller side): A's read resolved ON first but its continuation resumes after B observed OFF => A's approval is dropped", async () => {
    const { d, dm, app } = await setup();
    const pending: Array<(v: string | null) => void> = [];
    const fakeDb = parkedVclDb(pending);
    await runInDurableObject(stubOf(d.deviceId), async (_i: DeviceHub, st: DurableObjectState) => {
      const hub = new DeviceHub(st, { ...e, DB: fakeDb }), sock = st.getWebSockets("app")[0];
      const a = hub.webSocketMessage(sock, JSON.stringify({ t: "approval_res", rid: "k1", allow: true }));
      const b = hub.webSocketMessage(sock, JSON.stringify({ t: "cmd", cid: "c3", kind: "stop" }));
      for (let i = 0; i < 50 && pending.length < 2; i++) await Promise.resolve(); expect(pending.length).toBe(2); // both vcl reads parked (the cap:* read before each takes a few microtasks)
      pending[0]("1"); pending[1]("0");   // both settle in the same tick: A's flagOn() already returned true before B's OFF is processed
      await Promise.all([a, b]);
      expect((hub as any).flagVal).toBe(false); expect((hub as any).flagAt).toBe(0);
      expect(st.storage.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).toArray()[0]).toEqual({ n: 0 });
    });
    await app.until(() => app.closed !== null); await dm.until(() => dm.closed !== null);
    expect([app.closed!.code, dm.closed!.code]).toEqual([4005, 4005]);
    expect(await state(d.deviceId)).toBe("pending"); expect(dm.processed).toEqual([]);
    await enable();
    const again = daemonOf(d.token); await again.connect(); await again.waitFrame((f) => f.t === "welcome");
    const app2 = appOf(erich, d.deviceId); await app2.connect(); app2.send({ t: "approval_res", rid: "k1", allow: true });
    await again.until(() => again.processed.some((c) => c.kind === "approval"));
  });
  // A resolves ON, B resolves OFF k microtasks later (k = 0..4 sweeps every await boundary between A's read settling and A's handler dispatch).
  // Invariant, whatever the interleaving: a frame is never dispatched (persisted/forwarded) after an OFF was observed. For a k where A legitimately dispatched before the OFF, nothing is asserted about its effect.
  for (const k of [0, 1, 2, 3, 4]) it(`race (A ON, B OFF ${k} microtasks later): no dispatch ever happens after the OFF was observed`, async () => {
    const { d, dm, app } = await setup();
    const pending: Array<(v: string | null) => void> = [];
    const fakeDb = parkedVclDb(pending);
    let dispatchedAfterOff = 0, dispatched = 0;
    await runInDurableObject(stubOf(d.deviceId), async (_i: DeviceHub, st: DurableObjectState) => {
      const hub = new DeviceHub(st, { ...e, DB: fakeDb }), sock = st.getWebSockets("app")[0], h = hub as any;
      const orig = h.onApp.bind(h); h.onApp = (...x: unknown[]) => { dispatched++; if (h.offEpoch > 0) dispatchedAfterOff++; return orig(...x); };
      const a = hub.webSocketMessage(sock, JSON.stringify({ t: "approval_res", rid: "k1", allow: true }));
      const b = hub.webSocketMessage(sock, JSON.stringify({ t: "cmd", cid: "c4", kind: "stop" }));
      for (let i = 0; i < 50 && pending.length < 2; i++) await Promise.resolve(); expect(pending.length).toBe(2); // both vcl reads parked (the cap:* read before each takes a few microtasks)
      pending[0]("1");
      for (let i = 0; i < k; i++) await Promise.resolve();
      pending[1]("0");
      await Promise.all([a, b]);
      expect(h.flagVal).toBe(false); expect(h.flagAt).toBe(0);
    });
    expect(dispatchedAfterOff).toBe(0);
    await app.until(() => app.closed !== null); await dm.until(() => dm.closed !== null);
    expect([app.closed!.code, dm.closed!.code]).toEqual([4005, 4005]);
    if (dispatched === 0) expect(await state(d.deviceId)).toBe("pending");
  });
  it("a read that starts after the OFF and sees ON (flag flipped back) is honoured and cached", async () => {
    const { d } = await setup();
    await runInDurableObject(stubOf(d.deviceId), async (_i: DeviceHub, st: DurableObjectState) => {
      const hub = new DeviceHub(st, e); (hub as any).flagAt = 0;
      await enable("main", "0"); expect(await (hub as any).flagOn()).toBe(false);
      await enable(); expect(await (hub as any).flagOn()).toBe(true); expect((hub as any).flagAt).toBeGreaterThan(0);
    });
  });
  it("the idle recheck alarm is armed at most 15 s out while a socket is open, and closes an idle pair within it once the flag is OFF", async () => {
    const { d, dm, app } = await setup();
    const at = await runInDurableObject(stubOf(d.deviceId), async (_i: DeviceHub, st: DurableObjectState) => st.storage.getAlarm());
    expect(at).not.toBeNull(); expect(at! - Date.now()).toBeLessThanOrEqual(15_000 + 500);
    await enable("main", "0");
    await (await import("cloudflare:test")).runDurableObjectAlarm(stubOf(d.deviceId));
    await app.until(() => app.closed !== null); await dm.until(() => dm.closed !== null);
    expect([app.closed!.code, dm.closed!.code]).toEqual([4005, 4005]);
  });
});

describe("device turn status events + liveness (devices-v2 step 1)", () => {
  const stubOf = (id: string) => e.DEVICES.get(e.DEVICES.idFromName(id));
  async function setup(info: Record<string, unknown> = { caps: ["hb"] }) {
    const d = await pair(erich); const dm = daemonOf(d.token); dm.info = { name: "fake", version: "0.10.0", ...info }; await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    const app = appOf(erich, d.deviceId); await app.connect(); await app.until(() => app.events.some((x) => x.e.type === "device_online"), "device_online");
    return { d, dm, app };
  }
  const types = (app: FakeApp, t: string) => app.events.filter((x) => x.e.type === t).map((x) => x.e);
  it("welcome announces hb; a live daemon gets cmd_sent when the frame is written, cmd_acked on its cack; both carry the cid", async () => {
    const { dm, app } = await setup(); expect(dm.frames.find((f) => f.t === "welcome")!.caps).toEqual(["hb"]);
    dm.autoAck = false;
    app.send({ t: "cmd", cid: "turn-1", kind: "start", prompt: "hi" });
    await app.until(() => types(app, "cmd_sent").length === 1, "cmd_sent"); expect(types(app, "cmd_sent")[0]).toMatchObject({ type: "cmd_sent", cid: "turn-1", cseq: expect.any(Number) });
    await dm.until(() => dm.processed.length === 1); expect(types(app, "cmd_acked")).toHaveLength(0);
    dm.send({ t: "cack", cseq: dm.lastCseq });
    await app.until(() => types(app, "cmd_acked").length === 1, "cmd_acked"); expect(types(app, "cmd_acked")[0]).toMatchObject({ type: "cmd_acked", cid: "turn-1", cseq: expect.any(Number) });
  });
  it("offline at send: cmd_ack queued:true and NO cmd_sent; on reconnect the replay emits cmd_sent then cmd_acked (an old daemon, which only sends cack, works too)", async () => {
    const d = await pair(erich); const app = appOf(erich, d.deviceId); await app.connect();
    app.send({ t: "cmd", cid: "off-1", kind: "say", text: "x" });
    await app.until(() => app.frames.some((f) => f.t === "cmd_ack" && f.cid === "off-1"), "cmd_ack"); expect(app.frames.find((f) => f.t === "cmd_ack")!.queued).toBe(true);
    expect(types(app, "cmd_sent")).toHaveLength(0);
    const dm = daemonOf(d.token); dm.info = { name: "old", version: "0.9.0" }; await dm.connect();   // old daemon: no caps in hello
    await app.until(() => types(app, "cmd_acked").length === 1, "cmd_acked after reconnect");
    expect(app.events.map((x) => x.e.type).filter((t) => t.startsWith("cmd_"))).toEqual(["cmd_sent", "cmd_acked"]);
  });
  it("approval answers ride the outbox but never produce cmd_sent/cmd_acked (they are not turns)", async () => {
    const { dm, app } = await setup(); dm.emit("approval_request", { rid: "r1", tool: "Bash", preview: "ls" });
    await app.until(() => app.events.some((x) => x.e.type === "approval_request"), "req");
    app.send({ t: "approval_res", rid: "r1", allow: true }); await dm.until(() => dm.processed.some((c) => c.kind === "approval"));
    await new Promise((r) => setTimeout(r, 50)); expect(app.events.filter((x) => x.e.type.startsWith("cmd_"))).toHaveLength(0);
  });
  it("the daemon cannot forge cmd_* events (reserved like device_/approval_)", async () => {
    const { dm, app } = await setup(); dm.emit("cmd_acked", { cid: "forged" }); dm.emit("text", { n: 1 });
    await app.until(() => app.events.some((x) => x.e.type === "text"), "text"); expect(types(app, "cmd_acked")).toHaveLength(0);
  });
  const age = (id: string, ms: number) => runInDurableObject(stubOf(id), async (inst: DeviceHub) => { (inst as any).setMeta("dev_last_ms", Date.now() - ms); });
  const stamp = (id: string) => runInDurableObject(stubOf(id), async (inst: DeviceHub) => Number((inst as any).meta("dev_last_ms")));
  const alarm = async (id: string) => (await import("cloudflare:test")).runDurableObjectAlarm(stubOf(id));
  it("hb: a daemon that announced hb and has been silent > 75 s is closed 4006 and shown offline (reason timeout); 74 s is left alone; any frame (hb) resets the clock", async () => {
    const { d, dm, app } = await setup();
    await age(d.deviceId, 74_000); await alarm(d.deviceId); expect(dm.closed).toBeNull(); expect((await hubState(d.deviceId)).online).toBe(true);
    await age(d.deviceId, 70_000); const before = await stamp(d.deviceId); expect(Date.now() - before).toBeGreaterThan(60_000);
    dm.send({ t: "hb" }); await new Promise((r) => setTimeout(r, 50));
    expect(Date.now() - await stamp(d.deviceId)).toBeLessThan(5_000);   // the hb itself refreshed the liveness stamp (nothing here rewrites it)
    await alarm(d.deviceId); expect(dm.closed).toBeNull();
    await age(d.deviceId, 76_000); await alarm(d.deviceId);
    await dm.until(() => dm.closed !== null, "close"); expect(dm.closed!.code).toBe(4006);
    await app.until(() => types(app, "device_offline").length === 1, "device_offline"); expect(types(app, "device_offline")[0].reason).toBe("timeout");
    expect((await hubState(d.deviceId)).online).toBe(false);
  });
  it("hb alone resets a nearly expired clock: 74 s old + hb + 2 s later the alarm leaves it alone only because hb refreshed the stamp", async () => {
    const { d, dm } = await setup();
    await age(d.deviceId, 76_000);                                          // would be reaped by the next alarm...
    dm.send({ t: "hb" }); await new Promise((r) => setTimeout(r, 50));      // ...but the daemon is alive
    await alarm(d.deviceId); expect(dm.closed).toBeNull(); expect((await hubState(d.deviceId)).online).toBe(true);
  });
  it("kill switch with hb: an hb frame is not flag-checked (nothing closes on it), but the alarm closes BOTH sockets 4005 once the flag is OFF", async () => {
    const { d, dm, app } = await setup();
    await enable("main", "0");
    dm.send({ t: "hb" }); await new Promise((r) => setTimeout(r, 50));
    expect(dm.closed).toBeNull(); expect(app.closed).toBeNull();            // exempt from the per-frame read
    await alarm(d.deviceId);
    await dm.until(() => dm.closed !== null, "dm closed"); await app.until(() => app.closed !== null, "app closed");
    expect([dm.closed!.code, app.closed!.code]).toEqual([4005, 4005]);
  });
  it("COMPAT: a daemon that never announced hb (old vcl) is never closed for silence, however long", async () => {
    const { d, dm } = await setup({}); await age(d.deviceId, 10 * 60_000); await alarm(d.deviceId);
    expect(dm.closed).toBeNull(); expect((await hubState(d.deviceId)).online).toBe(true);
  });
  it("a reconnect is judged afresh: a stale last-frame stamp from the previous socket cannot kill the new one (before or after its hello)", async () => {
    const { d, dm } = await setup(); await age(d.deviceId, 5 * 60_000);
    const dm2 = daemonOf(d.token); dm2.info = { name: "fake", version: "0.10.0", caps: ["hb"] }; await dm2.connect(); await dm2.until(() => dm2.frames.some((f) => f.t === "welcome"));
    await alarm(d.deviceId); expect(dm2.closed).toBeNull();            // between welcome and hello: not judged yet
    await dm2.until(() => dm.closed !== null); await new Promise((r) => setTimeout(r, 50)); await alarm(d.deviceId);
    expect(dm2.closed).toBeNull(); expect((await hubState(d.deviceId)).online).toBe(true);   // hello stamped a fresh last-frame time
  });
  it("a cack lost before a reconnect: hello.lastCseq covers the command, the hub emits cmd_acked (cid+cseq) so the page leaves 'offline/queued'", async () => {
    const { d, dm, app } = await setup(); dm.autoAck = false;
    app.send({ t: "cmd", cid: "lost-1", kind: "say", text: "x" }); await dm.until(() => dm.processed.length === 1);
    expect(types(app, "cmd_acked")).toHaveLength(0);
    dm.drop(); await app.until(() => types(app, "device_offline").length === 1, "offline");
    const dm2 = daemonOf(d.token); dm2.lastCseq = dm.lastCseq; dm2.info = { name: "fake", version: "0.10.0", caps: ["hb"] }; await dm2.connect();
    await app.until(() => types(app, "cmd_acked").length === 1, "cmd_acked after reconnect");
    expect(types(app, "cmd_acked")[0]).toMatchObject({ cid: "lost-1", cseq: dm.lastCseq }); expect(types(app, "cmd_sent")[0]).toMatchObject({ cid: "lost-1", cseq: dm.lastCseq });
  });
  describe("pending approvals die with the daemon connection", () => {
    const pendingThen = async (how: "hb" | "drop" | "replace") => {
      const { d, dm, app } = await setup(); dm.emit("approval_request", { rid: "p1", tool: "Bash", preview: "ls" });
      await app.until(() => app.events.some((x) => x.e.type === "approval_request"), "req");
      if (how === "hb") { await age(d.deviceId, 76_000); await alarm(d.deviceId); }
      else if (how === "drop") { dm.drop(); }
      else { const dm2 = daemonOf(d.token); dm2.info = { name: "fake", version: "0.10.0", caps: ["hb"] }; await dm2.connect(); }
      await app.until(() => app.events.some((x) => x.e.type === "approval_resolved" && x.e.state === "expired"), "expired");
      app.send({ t: "approval_res", rid: "p1", allow: true }); await app.until(() => app.frames.some((f) => f.t === "err" && f.rid === "p1"), "refused");
      expect(app.frames.find((f) => f.t === "err" && f.rid === "p1")!.code).toBe("expired");
    };
    it("heartbeat timeout", () => pendingThen("hb"));
    it("normal socket drop", () => pendingThen("drop"));
    it("replaced by a newer connection", () => pendingThen("replace"));
  });
});

describe("device list/state liveness fields (devfix1c)", () => {
  const listOf = async (me: Me, id: string) => ((await (await api(me, "GET", "/api/devices")).json()) as any).devices.find((x: any) => x.id === id);
  it("hb daemon online: last_heard_at (recent ms) + hb:true; old daemon online: hb:false; offline: neither field", async () => {
    const d1 = await pair(erich, "new"); const dm1 = daemonOf(d1.token); dm1.info = { name: "n", version: "0.10.0", caps: ["hb"] }; await dm1.connect(); await dm1.until(() => dm1.frames.some((f) => f.t === "welcome"));
    const d2 = await pair(erich, "old"); const dm2 = daemonOf(d2.token); dm2.info = { name: "o", version: "0.9.0" }; await dm2.connect(); await dm2.until(() => dm2.frames.some((f) => f.t === "welcome"));
    const d3 = await pair(erich, "off");
    await new Promise((r) => setTimeout(r, 100));
    const a = await listOf(erich, d1.deviceId), b = await listOf(erich, d2.deviceId), c = await listOf(erich, d3.deviceId);
    expect([a.online, a.hb, Date.now() - a.last_heard_at < 10_000]).toEqual([true, true, true]);
    expect([b.online, b.hb, typeof b.last_heard_at]).toEqual([true, false, "number"]);
    expect([c.online, "hb" in c, "last_heard_at" in c]).toEqual([false, false, false]);
  });
  it("the list carries server_now (hub clock, ms) so the page can correct its own clock", async () => {
    const t0 = Date.now(); const j = (await (await api(erich, "GET", "/api/devices")).json()) as any;
    expect(typeof j.server_now).toBe("number"); expect(Math.abs(j.server_now - t0)).toBeLessThan(10_000);
  });
});

describe("device identity: install_id, this_install, last_online_at (devv2s2)", () => {
  const INSTALL = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const OTHER = "ffffffffffffffffffffffffffffffff";
  const pairWith = async (me: Me, name: string, installId?: unknown) => {
    const p = await api(me, "POST", "/api/devices/pair", installId === undefined ? undefined : { install_id: installId }); expect(p.status).toBe(201);
    const { code } = (await p.json()) as { code: string };
    const r = await call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ code, name }) })); expect(r.status).toBe(201);
    return (await r.json()) as { deviceId: string; token: string };
  };
  const listAs = async (me: Me, install?: string) => ((await (await call(new Request(ORIGIN + "/api/devices", { headers: { cookie: me.cookie, ...(install ? { "x-vc-install": install } : {}) } }))).json()) as any).devices as any[];
  const col = (id: string, c: string) => e.DB.prepare(`SELECT ${c} AS v FROM devices WHERE id=?`).bind(id).first().then((r: any) => r.v);

  it("install_id minted with the pairing code lands on the device row at redeem and is never in the list payload", async () => {
    const d = await pairWith(erich, "mac", INSTALL);
    expect(await col(d.deviceId, "install_id")).toBe(INSTALL);
    expect(JSON.stringify(await listAs(erich, INSTALL))).not.toContain(INSTALL);
  });
  it("no install_id, or a malformed one, is stored as NULL (never guessed, never an error)", async () => {
    const a = await pairWith(erich, "cli"), b = await pairWith(erich, "bad", "x y; DROP"), c = await pairWith(erich, "num", 12345);
    for (const d of [a, b, c]) expect(await col(d.deviceId, "install_id")).toBeNull();
  });
  it("this_install is true only for the row whose install_id equals the x-vc-install header", async () => {
    const mine = await pairWith(erich, "mac", INSTALL), cli = await pairWith(erich, "cli"), other = await pairWith(erich, "dev-mac", OTHER);
    const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r.this_install]));
    expect(byId(await listAs(erich, INSTALL))).toEqual({ [mine.deviceId]: true, [cli.deviceId]: false, [other.deviceId]: false });
    expect(Object.values(byId(await listAs(erich))).every((v) => v === false)).toBe(true);            // no header: no badge anywhere
    expect(Object.values(byId(await listAs(erich, "not-valid!"))).every((v) => v === false)).toBe(true); // malformed header: no badge
  });
  it("a NULL install_id never matches, even when the header is empty/garbled", async () => {
    await pairWith(erich, "cli");
    expect((await listAs(erich, "")).every((r) => r.this_install === false)).toBe(true);
  });
  it("a forged header can never match another user's row (the list is scoped to the caller)", async () => {
    await enable("e2e");
    await pairWith(erich, "mac", INSTALL);
    const bot = await e2eCookie();
    expect(await listAs(bot, INSTALL)).toEqual([]);
  });
  it("two live rows from one install: only the newest is this_install (the older one is a stale re-pair)", async () => {
    const old = await pairWith(erich, "mac", INSTALL);
    await e.DB.prepare(`UPDATE devices SET created_at=created_at-100 WHERE id=?`).bind(old.deviceId).run();
    const fresh = await pairWith(erich, "mac", INSTALL);
    const rows = await listAs(erich, INSTALL);
    expect(rows.find((r) => r.id === fresh.deviceId).this_install).toBe(true);
    expect(rows.find((r) => r.id === old.deviceId).this_install).toBe(false);
  });
  describe("claim: bind this app install to an existing NULL row (devv2s2c)", () => {
    const claim = (me: Me, id: string, body: unknown = { install_id: INSTALL }, extra: Record<string, string> = {}) =>
      call(new Request(ORIGIN + `/api/devices/${id}/claim`, { method: "POST", headers: { cookie: me.cookie, origin: ORIGIN, "x-csrf-token": me.csrf, "content-type": "application/json", ...extra }, body: JSON.stringify(body) }));
    it("sets install_id on the caller's own NULL row; the list then marks it; second call is idempotent", async () => {
      const d = await pairWith(erich, "mac");
      const r = await claim(erich, d.deviceId); expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true });
      expect(await col(d.deviceId, "install_id")).toBe(INSTALL);
      expect((await listAs(erich, INSTALL)).find((x) => x.id === d.deviceId).this_install).toBe(true);
      const again = await claim(erich, d.deviceId); expect(again.status).toBe(200); expect(((await again.json()) as any).already).toBe(true);
    });
    it("list exposes only a boolean `linked` (never the id) so the app can offer the action on unlinked rows", async () => {
      const a = await pairWith(erich, "a", OTHER), b = await pairWith(erich, "b");
      const rows = await listAs(erich); expect(rows.find((r) => r.id === a.deviceId).linked).toBe(true); expect(rows.find((r) => r.id === b.deviceId).linked).toBe(false);
      expect(JSON.stringify(rows)).not.toContain(OTHER);
    });
    it("another user's row (and a forged x-vc-install / x-vcl-* header) is a 404 and nothing changes", async () => {
      await enable("e2e");
      const d = await pairWith(erich, "mac"); const bot = await e2eCookie();
      expect((await claim(bot, d.deviceId, { install_id: INSTALL }, { "x-vcl-user": "example-user", "x-vcl-scope": "main", "x-vc-install": INSTALL })).status).toBe(404);
      expect(await col(d.deviceId, "install_id")).toBeNull();
    });
    it("a revoked row is a 404 and stays NULL", async () => {
      const d = await pairWith(erich, "mac"); expect((await api(erich, "DELETE", "/api/devices/" + d.deviceId)).status).toBe(200);
      expect((await claim(erich, d.deviceId)).status).toBe(404); expect(await col(d.deviceId, "install_id")).toBeNull();
    });
    it("never overwrites a different install id (409), and the same install id cannot sit on a second live row (409)", async () => {
      const a = await pairWith(erich, "a", OTHER), b = await pairWith(erich, "b"), c = await pairWith(erich, "c");
      expect((await claim(erich, a.deviceId)).status).toBe(409); expect(await col(a.deviceId, "install_id")).toBe(OTHER);
      expect((await claim(erich, b.deviceId)).status).toBe(200);
      expect((await claim(erich, c.deviceId)).status).toBe(409); expect(await col(c.deviceId, "install_id")).toBeNull();
    });
    it("two concurrent IDENTICAL claims both succeed (the loser of the race is already linked to the requested device)", async () => {
      for (let i = 0; i < 2; i++) { // few rounds: claims are rate-limited per user (20 / 10 min)
        const d = await pairWith(erich, "mac" + i, undefined); const inst = "race-ident-" + String(i).padStart(10, "0");
        const rs = await Promise.all([claim(erich, d.deviceId, { install_id: inst }), claim(erich, d.deviceId, { install_id: inst })]);
        expect(rs.map((r) => r.status)).toEqual([200, 200]); expect(await col(d.deviceId, "install_id")).toBe(inst);
      }
    });
    it("concurrent claims of the same install id for DIFFERENT rows: exactly one 200, one 409, one row bound", async () => {
      const a = await pairWith(erich, "a"), b = await pairWith(erich, "b"); const inst = "race-diff-0000000001";
      const rs = await Promise.all([claim(erich, a.deviceId, { install_id: inst }), claim(erich, b.deviceId, { install_id: inst })]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      const bound = [await col(a.deviceId, "install_id"), await col(b.deviceId, "install_id")].filter((x) => x === inst); expect(bound.length).toBe(1);
    });
    it("a revoked row stays a 404 for concurrent claims too", async () => {
      const d = await pairWith(erich, "mac"); await api(erich, "DELETE", "/api/devices/" + d.deviceId);
      const rs = await Promise.all([claim(erich, d.deviceId), claim(erich, d.deviceId)]);
      expect(rs.map((r) => r.status)).toEqual([404, 404]);
    });
    it("a revoked row holding the install id does not block a new claim", async () => {
      const old = await pairWith(erich, "old", INSTALL); await api(erich, "DELETE", "/api/devices/" + old.deviceId);
      const d = await pairWith(erich, "mac"); expect((await claim(erich, d.deviceId)).status).toBe(200);
    });
    it("missing / malformed install_id, malformed device id, wrong type: 400/404, nothing stored", async () => {
      const d = await pairWith(erich, "mac");
      for (const body of [{}, { install_id: "x y" }, { install_id: 5 }, { install_id: "short" }]) expect((await claim(erich, d.deviceId, body)).status).toBe(400);
      expect((await claim(erich, "not-an-id")).status).toBe(404);
      expect(await col(d.deviceId, "install_id")).toBeNull();
    });
    it("no session => 401; cross-site Origin => 403; flag off => 404", async () => {
      const d = await pairWith(erich, "mac");
      expect((await call(new Request(ORIGIN + `/api/devices/${d.deviceId}/claim`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ install_id: INSTALL }) }))).status).toBe(401);
      expect((await call(new Request(ORIGIN + `/api/devices/${d.deviceId}/claim`, { method: "POST", headers: { cookie: erich.cookie, origin: "https://evil.test", "x-csrf-token": erich.csrf, "content-type": "application/json" }, body: JSON.stringify({ install_id: INSTALL }) }))).status).toBeGreaterThanOrEqual(403);
      await enable("main", "0"); expect((await claim(erich, d.deviceId)).status).toBe(404);
    });
    it("rate limited per user: the 21st attempt in the window is 429 (own user, so other tests' calls do not count)", async () => {
      await enable("e2e"); const bot = await e2eCookie();
      const d = await pairWith(bot, "mac", OTHER);
      const codes: number[] = []; for (let i = 0; i < 22; i++) codes.push((await claim(bot, d.deviceId)).status);
      const first = codes.indexOf(429); // the e2e user may already have made a call in an earlier test of this isolate
      expect(first).toBeGreaterThanOrEqual(19); expect(first).toBeLessThanOrEqual(20);
      expect(codes.slice(0, first).every((x) => x === 409)).toBe(true); expect(codes.slice(first).every((x) => x === 429)).toBe(true);
    });
  });
  it("last_online_at: NULL until the daemon says hello, set at hello, advanced at close; list returns it in seconds", async () => {
    const d = await pairWith(erich, "mac", INSTALL);
    expect((await listAs(erich))[0].last_online_at).toBeNull();
    const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    await new Promise((r) => setTimeout(r, 150));
    const t1 = await col(d.deviceId, "last_online_at");
    expect(Math.abs(t1 - Math.floor(Date.now() / 1000))).toBeLessThan(10);
    await e.DB.prepare(`UPDATE devices SET last_online_at=1000 WHERE id=?`).bind(d.deviceId).run();
    dm.drop();
    await new Promise((r) => setTimeout(r, 300));
    expect(await col(d.deviceId, "last_online_at")).toBeGreaterThan(1000);
    expect((await listAs(erich))[0].last_online_at).toBeGreaterThan(1000);
  });
  it("two pairings in the same second: only the later insertion is this_install, stable across reads", async () => {
    const a = await pairWith(erich, "mac", INSTALL), b = await pairWith(erich, "mac", INSTALL);
    await e.DB.prepare(`UPDATE devices SET created_at=1700000000 WHERE id IN (?,?)`).bind(a.deviceId, b.deviceId).run();
    for (let i = 0; i < 3; i++) {
      const rows = await listAs(erich, INSTALL);
      expect(rows.find((r) => r.id === b.deviceId).this_install).toBe(true);
      expect(rows.find((r) => r.id === a.deviceId).this_install).toBe(false);
    }
  });
  it("replacing an online socket advances last_online_at even if the replacement never says hello; the old socket's late close does not take the new one offline", async () => {
    const d = await pairWith(erich, "mac", INSTALL);
    const d1 = daemonOf(d.token); await d1.connect(); await d1.until(() => d1.frames.some((f) => f.t === "welcome"));
    await new Promise((r) => setTimeout(r, 200));
    await e.DB.prepare(`UPDATE devices SET last_online_at=1000 WHERE id=?`).bind(d.deviceId).run();
    const d2 = daemonOf(d.token); (d2 as any).onFrame = () => {}; await d2.connect(); // the replacement never says hello
    await new Promise((r) => setTimeout(r, 300));
    expect(await col(d.deviceId, "last_online_at")).toBeGreaterThan(1000);
    expect((await hubState(d.deviceId)).online).toBe(true);
  });
  it("last_online_at never moves backwards (a stale write loses to a greater stored value)", async () => {
    const d = await pairWith(erich, "mac", INSTALL);
    const FUTURE = Math.floor(Date.now() / 1000) + 100000;
    await e.DB.prepare(`UPDATE devices SET last_online_at=? WHERE id=?`).bind(FUTURE, d.deviceId).run();
    const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    await new Promise((r) => setTimeout(r, 200));
    dm.drop();
    await new Promise((r) => setTimeout(r, 300));
    expect(await col(d.deviceId, "last_online_at")).toBe(FUTURE);
  });
  it("revoked rows are not resurrected by a late last_online_at write", async () => {
    const d = await pairWith(erich, "mac", INSTALL);
    const dm = daemonOf(d.token); await dm.connect(); await dm.until(() => dm.frames.some((f) => f.t === "welcome"));
    expect((await api(erich, "DELETE", "/api/devices/" + d.deviceId)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(await col(d.deviceId, "token_hash")).toBeNull();
    expect(await col(d.deviceId, "revoked_at")).not.toBeNull();
  });
});

describe("comp2: device os / arch / termState", () => {
  const list = async (me: Me) => ((await (await api(me, "GET", "/api/devices")).json()) as any).devices as any[];
  it("stored from the hello, returned in /api/devices (os, arch), validated; old vcl => absent", async () => {
    const d = await pair(erich);
    expect((await list(erich))[0].os).toBeUndefined();
    const go = async (extra: Record<string, unknown>) => { const dm = daemonOf(d.token); dm.info = { ...dm.info, ...extra }; await dm.connect(); await appOf(erich, d.deviceId).connect(); };
    await go({ os: "win32", arch: "arm64", termState: "unsupported", termWhy: "needs Bun" });
    const r = (await list(erich))[0]; expect([r.os, r.arch]).toEqual(["win32", "arm64"]);
    expect(await hubState(d.deviceId)).toMatchObject({ os: "win32", arch: "arm64", termState: "unsupported", termWhy: "needs Bun" });
    await go({ os: "<script>", arch: "z".repeat(500), termState: "weird" });
    expect((await list(erich))[0].os).toBeUndefined(); expect((await hubState(d.deviceId)).termState).toBeUndefined();
    await go({ os: "linux" }); expect((await list(erich))[0].os).toBe("linux");
    await go({}); expect((await list(erich))[0].os).toBeUndefined();   // downgrade to an older vcl: unknown again
  });
});
