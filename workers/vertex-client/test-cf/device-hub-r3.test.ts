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

describe("finding 1: one holder at a time, bound to the acknowledged start", () => {
  it("two chats queue starts while the device is offline: the second is refused 409 busy BEFORE queueing; the first keeps the session; B cannot say/stop/read", async () => {
    expect((await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A", dir: "/a" })).status).toBe(200);
    const b = await cmd({ conv: B, cid: "qb", kind: "start", prompt: "B", dir: "/b" });
    expect(b.status).toBe(409); expect(await b.json()).toMatchObject({ ok: false, error: "busy" });
    const dm = daemonOf(dev.token); await dm.connect(); await dm.until(() => dm.processed.length === 1, "A's start"); await sleep(30);
    expect(dm.processed.map((c) => c.cid)).toEqual(["qa"]);                                    // B's start never reached the daemon
    dm.emit("session_started", { cid: "qa", dir: "/a" }); await sleep(60);
    expect((await cmd({ conv: B, cid: "sb", kind: "say", text: "into A" })).status).toBe(409);
    expect((await cmd({ conv: B, cid: "xb", kind: "stop" })).status).toBe(409);
    expect((await cmd({ conv: A, cid: "sa", kind: "say", text: "mine" })).status).toBe(200);
    await dm.until(() => dm.processed.length === 2, "A's say"); expect(dm.processed[1]).toMatchObject({ kind: "say", text: "mine" });
    dm.emit("assistant_text", { text: "answer for A" }); dm.emit("approval_request", { rid: "ra", tool: "Bash", preview: "ls", ttl_s: 60 }); await sleep(80);
    expect(JSON.stringify((await events(A)).events)).toContain("answer for A");
    const eb = await events(B); expect(eb.events.filter((x) => x.e.type !== "device_online")).toEqual([]); expect(eb.mine).toBe(false);
    expect((await post("/bridge/approval", { conv: B, rid: "ra", allow: true })).status).toBe(403);   // B cannot answer A's card
    expect((await post("/bridge/approval", { conv: A, rid: "ra", allow: true })).status).toBe(200);
  });
  it("a session_started that is not the holder's start (another cid) promotes nothing; an old daemon (no cid) promotes only after the start was acked", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    dm.autoAck = false;
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1);
    dm.emit("session_started", { cid: "someone-else" }); await sleep(60);
    expect((await cmd({ conv: A, cid: "sa", kind: "say", text: "x" })).status).toBe(409);       // still only reserved
    dm.emit("session_started", {}); await sleep(60);                                           // no cid and NOT acked yet: not promoted either
    expect((await cmd({ conv: A, cid: "sa2", kind: "say", text: "x" })).status).toBe(409);
    dm.send({ t: "cack", cseq: dm.lastCseq }); await sleep(40);
    dm.emit("session_started", {}); await sleep(60);
    expect((await cmd({ conv: A, cid: "sa3", kind: "say", text: "x" })).status).toBe(200);
  });
  it("the device page and chats do not trample each other: a page start/say/stop is refused while a chat holds the device and a chat is refused while the page holds it", async () => {
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    const app = await appOf();
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "A" }); await dm.until(() => dm.processed.length === 1);
    for (const [cid, kind, body] of [["p1", "start", { prompt: "page" }], ["p2", "say", { text: "page" }], ["p3", "stop", {}]] as const) app.send({ t: "cmd", cid, kind, ...body });
    await app.until(() => app.frames.filter((f) => f.t === "err" && f.code === "busy").length === 3, "three busy refusals");
    expect(dm.processed).toHaveLength(1);
    dm.emit("session_started", { cid: "qa" }); dm.emit("session_ended", {}); await sleep(60);   // chat A's session over: the page may start
    app.send({ t: "cmd", cid: "p4", kind: "start", prompt: "page" }); await dm.until(() => dm.processed.some((c) => c.cid === "p4"), "page start");
    expect((await cmd({ conv: B, cid: "qb", kind: "start", prompt: "B" })).status).toBe(409);   // the page holds it now
    expect((await cmd({ conv: A, cid: "qa2", kind: "start", prompt: "A" })).status).toBe(409);
    dm.emit("session_started", { cid: "p4" }); dm.emit("assistant_text", { text: "page output" }); await sleep(60);
    expect(JSON.stringify((await events(A)).events)).not.toContain("page output");              // the page's output is never a chat's
    dm.emit("session_stopped", {}); await sleep(60);
    expect((await cmd({ conv: B, cid: "qb2", kind: "start", prompt: "B" })).status).toBe(200);
    app.drop();
  });
  it("the same chat starting again replaces its own stale unsent reservation; a stale reservation expires", async () => {
    await cmd({ conv: A, cid: "q1", kind: "start", prompt: "one" });
    expect((await cmd({ conv: A, cid: "q2", kind: "start", prompt: "two" })).status).toBe(200);
    const dm = daemonOf(dev.token); await dm.connect(); await dm.until(() => dm.processed.length >= 1); await sleep(30);
    expect(dm.processed.map((c) => c.cid)).toEqual(["q2"]);
  });
});

describe("finding 2: the kill switch gates outbox DELIVERY", () => {
  it("chat start/say/approval queued offline, vcl_env turned OFF, daemon connects: none delivered, entries deleted; a legacy page command queued offline still is", async () => {
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "go", dir: "/a" });
    const app = await appOf(); app.send({ t: "cmd", cid: "legacy-stop", kind: "stop" });   // legacy, not a holder command: passes while a chat holds? (refused busy) -> use a second device command via approval below
    await sleep(60);
    await setFlag("vcl_env:main", "0");
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(250);
    expect(dm.processed.some((c) => c.cid === "qa")).toBe(false);
    const st = (await (await hub("/state")).json()) as any; expect(st.pendingCmds).toBe(0);
    // the switch back ON does not resurrect it
    await setFlag("vcl_env:main", "1"); dm.drop(); await sleep(60); const dm2 = daemonOf(dev.token); await dm2.connect(); await sleep(200);
    expect(dm2.processed.some((c) => c.cid === "qa")).toBe(false);
    app.drop();
  });
  it("DO reconstruction: the pending chat start survives an eviction in storage and is still cancelled at delivery when the switch is OFF", async () => {
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "go" });
    await setFlag("vcl_env:main", "0");
    const stub = e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId));
    await runInDurableObject(stub, async (_i: unknown, st: DurableObjectState) => { try { st.abort("evict"); } catch { /* the reset is the point */ } }).catch(() => undefined);
    await sleep(100);
    const rows = await runInDurableObject(e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId)), async (_i: unknown, st: DurableObjectState) => st.storage.sql.exec(`SELECT cid, src, conv FROM outbox`).toArray());
    expect(rows).toEqual([{ cid: "qa", src: "chat", conv: A }]);                                  // provenance is persisted, not held in memory
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(250);
    expect(dm.processed.some((c) => c.cid === "qa")).toBe(false);
  });
  it("control: with the switch ON the queued chat start IS delivered on connect; legacy page commands are independent of vcl_env", async () => {
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "go" });
    const dm = daemonOf(dev.token); await dm.connect(); await dm.until(() => dm.processed.some((c) => c.cid === "qa"), "delivered");
    dm.emit("session_started", { cid: "qa" }); dm.emit("session_ended", {}); await sleep(60);
    await setFlag("vcl_env:main", "0");
    const app = await appOf(); app.send({ t: "cmd", cid: "pg", kind: "start", prompt: "page start" });
    await dm.until(() => dm.processed.some((c) => c.cid === "pg"), "legacy command with env OFF");
    app.drop();
  });
  it("a legacy page command queued before a chat start, then OFF, then connect: the legacy command is delivered, the chat start is not", async () => {
    const app = await appOf();
    app.send({ t: "cmd", cid: "pg-say", kind: "say", text: "page text" }); await sleep(60);       // no holder: a page say passes as before
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "go" });
    await setFlag("vcl_env:main", "0");
    const dm = daemonOf(dev.token); await dm.connect(); await dm.until(() => dm.processed.some((c) => c.cid === "pg-say"), "legacy delivered"); await sleep(150);
    expect(dm.processed.some((c) => c.cid === "qa")).toBe(false);
    app.drop();
  });
});

describe("finding 4: no scope-wide notification or push for a device approval", () => {
  const notifs = async (me: Me) => ((await (await api(me, "GET", "/api/notifications")).json()) as any).items as Array<{ body?: string; title?: string; url?: string }>;
  for (const watched of [false, true]) it(`Bob (same scope) never sees Alice's approval in /api/notifications (${watched ? "watched" : "unwatched"})`, async () => {
    e.ALLOWED_GITHUB_LOGINS = "example-user,bob";
    const bob = await cookieOf("bob"), alice = await cookieOf();
    const dm = daemonOf(dev.token); await dm.connect(); await sleep(30);
    const app = watched ? await appOf() : null;
    await cmd({ conv: A, cid: "qa", kind: "start", prompt: "go" }); await dm.until(() => dm.processed.length === 1);
    dm.emit("session_started", { cid: "qa" });
    dm.emit("approval_request", { rid: "pr", tool: "Write", preview: "/private-project/CONFIDENTIAL_CLIENT.txt\nsecret", ttl_s: 120 });
    // deterministic: the hub has processed the approval once the owning chat's event feed shows it (replaces a fixed 300 ms sleep); the notification path runs in the same processing step
    for (const t0 = Date.now(); !JSON.stringify((await events(A)).events).includes("approval_request"); await sleep(5)) if (Date.now() - t0 > 5000) throw new Error("timeout waiting for the approval_request event");
    for (const me of [bob, alice]) { const n = JSON.stringify(await notifs(me)); expect(n).not.toContain("CONFIDENTIAL_CLIENT"); expect(n).not.toContain(dev.deviceId); }
    expect(((await e.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind='device'`).first()) as any).n).toBe(0);
    expect(JSON.stringify((await events(A)).events)).toContain("approval_request");                // the approval itself is still delivered to the chat that owns it
    app?.drop();
  });
});

describe("finding 3: a device row without its pin never runs on the cloud engine", () => {
  const rawChat = async (id: string, msg: Record<string, unknown>) => {
    const stub = e.CHAT.get(e.CHAT.idFromName(id));
    await runInDurableObject(stub, async (inst: ChatSession) => { (inst.engine as any).send = async () => { inst.engine.setMeta("cloud_called", "1"); return { ok: true }; }; });
    const r = await stub.fetch(new Request("https://do.internal/ws", { headers: { "x-conv-id": id, upgrade: "websocket" } }));
    const ws = (r as any).webSocket as WebSocket; ws.accept(); const frames: any[] = []; ws.addEventListener("message", (m: MessageEvent) => frames.push(JSON.parse(String(m.data))));
    ws.send(JSON.stringify(msg));
    // deterministic (replaces a fixed 500 ms sleep): done once the DO either rejected the message or reached the (stubbed) cloud engine
    for (const t0 = Date.now(); ; await sleep(5)) {
      if (frames.some((f) => f.t === "rejected") || (await runInDurableObject(stub, async (inst: ChatSession) => inst.engine.meta("cloud_called") === "1"))) break;
      if (Date.now() - t0 > 5000) throw new Error("timeout waiting for rejected frame or cloud call");
    }
    ws.close();
    return { stub, frames };
  };
  const orphan = async (cleanupFails: boolean) => {
    const id = crypto.randomUUID(); const errs: string[] = []; const orig = console.error; console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
    try {
      await e.DB.prepare("UPDATE devices SET name=name WHERE id=?").bind(dev.deviceId).run();
      const r = await bindDeviceEnv(e, "main", USER, { device_id: dev.deviceId, dir: "/private-project" },
        async (cols) => { await e.DB.prepare("INSERT INTO conversations (id,model,scope,env_kind,env_device_id,env_dir,env_user) VALUES (?,'claude-sonnet-5-5','main',?,?,?,?)").bind(id, cols.env_kind, cols.env_device_id, cols.env_dir, cols.env_user).run(); },
        async () => new Response("pin unavailable", { status: 503 }),
        async () => { if (cleanupFails) throw new Error("D1 cleanup unavailable"); await e.DB.prepare("DELETE FROM conversations WHERE id=?").bind(id).run(); });
      expect(r.ok).toBe(false);
    } finally { console.error = orig; }
    return { id, errs };
  };
  it("pin fails AND the cleanup DELETE fails: the failure is logged, and reopen + send is rejected 'Environment setup incomplete.' without reaching engine.send or storing the prompt", async () => {
    const { id, errs } = await orphan(true);
    expect(errs.join("\n")).toContain("env undo FAILED");
    const { stub, frames } = await rawChat(id, { t: "send", text: "private project prompt" });
    expect(frames).toContainEqual({ t: "rejected", error: "Environment setup incomplete." });
    await runInDurableObject(stub, async (inst: ChatSession) => { expect(inst.engine.meta("cloud_called")).toBeNull(); expect(inst.engine.messages()).toEqual([]); expect(inst.engine.meta("pending")).toBeNull(); });
  });
  it("the same for a queued dispatch already in `pending` (alarm path), and for generate/retry", async () => {
    const { id } = await orphan(true);
    const stub = e.CHAT.get(e.CHAT.idFromName(id));
    await runInDurableObject(stub, async (inst: ChatSession) => { (inst.engine as any).send = async () => { inst.engine.setMeta("cloud_called", "1"); return { ok: true }; }; inst.engine.setMeta("conv", id); inst.engine.setMeta("pending", JSON.stringify({ cmd: "send", text: "x" })); });
    await runInDurableObject(stub, async (inst: ChatSession) => { await inst.alarm(); expect(inst.engine.meta("cloud_called")).toBeNull(); expect(inst.engine.messages()).toEqual([]); });
    for (const t of ["generate", "retry"]) { const r = await rawChat(id, { t, kind: "image", prompt: "p" }); expect(r.frames).toContainEqual({ t: "rejected", error: "Environment setup incomplete." }); }
  });
  it("control: a cleanly cleaned-up failure leaves no row, and a normal cloud chat still reaches the cloud engine", async () => {
    const { id } = await orphan(false); expect(await e.DB.prepare("SELECT 1 FROM conversations WHERE id=?").bind(id).first()).toBeNull();
    const cloud = crypto.randomUUID(); await e.DB.prepare("INSERT INTO conversations (id,model,scope) VALUES (?,'claude-sonnet-5-5','main')").bind(cloud).run();
    const { stub } = await rawChat(cloud, { t: "send", text: "hello" });
    await runInDurableObject(stub, async (inst: ChatSession) => { expect(inst.engine.meta("cloud_called")).toBe("1"); });
  });
});
