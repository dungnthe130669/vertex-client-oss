import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../server/worker";
import { makeSession } from "../src/auth";
import { FakeDaemon } from "../test/fake-daemon";
import { expectValidTranscript } from "../test/transcript-invariant";

// Devices v2 step 3 end to end in workerd: Worker routes + D1 + ChatSession DO + DeviceHub DO + a fake daemon. The model gateway is never configured here: a device chat that ever reached the model would fail loudly.
const e = env as any;
const ORIGIN = "https://app.test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (req: Request) => worker.fetch(req, e, ctx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Me = { cookie: string; csrf: string };
const cookieOf = async (user = "example-user"): Promise<Me> => { const s = await makeSession(e, user, "github"); return { cookie: s.cookie.split(";")[0], csrf: s.session.csrf }; };
const api = (me: Me, method: string, path: string, body?: unknown) => call(new Request(ORIGIN + path, { method, headers: { cookie: me.cookie, origin: ORIGIN, "x-csrf-token": me.csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
const setFlag = (name: string, v = "1") => e.DB.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(name, v).run();
async function pair(me: Me, name = "laptop") {
  const p = await api(me, "POST", "/api/devices/pair"); const { code } = (await p.json()) as { code: string };
  const r = await call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ code, name }) }));
  return (await r.json()) as { deviceId: string; token: string };
}
const daemonOf = (token: string, info: Record<string, unknown> = {}) => { const d = new FakeDaemon(async () => { const r = await call(new Request(ORIGIN + "/device", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } })); expect(r.status).toBe(101); return (r as any).webSocket as WebSocket; }); Object.assign(d.info, info); return d; };
async function openChat(me: Me, id: string, since = 0) {
  const r = await call(new Request(`${ORIGIN}/api/conversations/${id}/ws?since=${since}`, { headers: { upgrade: "websocket", cookie: me.cookie, origin: ORIGIN } })); expect(r.status).toBe(101);
  const ws = (r as any).webSocket as WebSocket; ws.accept(); const frames: any[] = []; ws.addEventListener("message", (m: MessageEvent) => frames.push(JSON.parse(String(m.data))));
  const until = async (pred: () => boolean, what: string, ms = 6000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}; frames=${JSON.stringify(frames).slice(0, 1500)}`); await sleep(15); } };
  return { ws, frames, until, send: (o: unknown) => ws.send(JSON.stringify(o)), evs: (type: string) => frames.filter((f) => f.t === "ev" && f.e.type === type).map((f) => f.e) };
}
const stateOf = async (me: Me, id: string) => (await (await api(me, "GET", "/api/conversations/" + id)).json()) as any;
const mkChat = async (me: Me, deviceId: string, dir: string | null = "/work/app") => { const r = await api(me, "POST", "/api/conversations", { env: { kind: "device", device_id: deviceId, ...(dir ? { dir } : {}) } }); expect(r.status).toBe(201); return ((await r.json()) as any).id as string; };

let erich: Me, dev: { deviceId: string; token: string }, dm: FakeDaemon;
beforeEach(async () => {
  await setFlag("vcl:main"); await setFlag("vcl_env:main"); erich = await cookieOf(); dev = await pair(erich);
  dm = daemonOf(dev.token, { roots: [{ label: "work", path: "/work" }] }); await dm.connect(); await dm.waitFrame((f) => f.t === "welcome"); await sleep(40);
});

describe("create: flag, ownership, validation", () => {
  it("vcl_env off (device flag on) or vcl off => 404 and NO conversation row; cloud chats are unaffected", async () => {
    const before = ((await e.DB.prepare(`SELECT COUNT(*) AS n FROM conversations`).first()) as any).n;
    await setFlag("vcl_env:main", "0");
    expect((await api(erich, "POST", "/api/conversations", { env: { kind: "device", device_id: dev.deviceId } })).status).toBe(404);
    await setFlag("vcl_env:main", "1"); await setFlag("vcl:main", "0");
    expect((await api(erich, "POST", "/api/conversations", { env: { kind: "device", device_id: dev.deviceId } })).status).toBe(404);
    expect(((await e.DB.prepare(`SELECT COUNT(*) AS n FROM conversations`).first()) as any).n).toBe(before);
    const cloud = await api(erich, "POST", "/api/conversations", {}); expect(cloud.status).toBe(201); expect(((await cloud.json()) as any).env).toBeUndefined();
    const cid = ((await (await api(erich, "POST", "/api/conversations", { env: { kind: "cloud" } })).json()) as any).id; expect((await stateOf(erich, cid)).env).toBeUndefined();
  });
  it("another user's device, a revoked one, an unknown id, and garbage are refused (404 / 400); nothing is stored", async () => {
    await setFlag("vcl:e2e"); await setFlag("vcl_env:e2e");
    const r0 = await call(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": e.E2E_TOKEN, origin: ORIGIN } })); const ecookie = r0.headers.get("set-cookie")!.split(";")[0];
    const bot: Me = { cookie: ecookie, csrf: ((await (await call(new Request(ORIGIN + "/api/me", { headers: { cookie: ecookie } }))).json()) as any).csrf };
    const before = ((await e.DB.prepare(`SELECT COUNT(*) AS n FROM conversations`).first()) as any).n;
    expect((await api(bot, "POST", "/api/conversations", { env: { kind: "device", device_id: dev.deviceId } })).status).toBe(404);       // not the bot's device
    expect((await api(erich, "POST", "/api/conversations", { env: { kind: "device", device_id: "f".repeat(32) } })).status).toBe(404);     // unknown
    expect((await api(erich, "POST", "/api/conversations", { env: { kind: "device", device_id: "nope" } })).status).toBe(400);
    expect((await api(erich, "POST", "/api/conversations", { env: { kind: "device", device_id: dev.deviceId, dir: 5 } })).status).toBe(400);
    expect((await api(erich, "DELETE", "/api/devices/" + dev.deviceId)).status).toBe(200);
    expect((await api(erich, "POST", "/api/conversations", { env: { kind: "device", device_id: dev.deviceId } })).status).toBe(404);     // revoked
    expect(((await e.DB.prepare(`SELECT COUNT(*) AS n FROM conversations`).first()) as any).n).toBe(before);
  });
  it("the conversation carries the env and its derived state: ready with a live daemon, offline without, revoked after revoke, unavailable with the flag off", async () => {
    const id = await mkChat(erich, dev.deviceId);
    let s = await stateOf(erich, id); expect(s.env).toMatchObject({ kind: "device", device_id: dev.deviceId, dir: "/work/app", name: "laptop", state: "ready" });
    expect(JSON.stringify(s)).not.toContain(dev.token);
    dm.drop(); await sleep(150); s = await stateOf(erich, id); expect(s.env.state).toBe("offline");
    await setFlag("vcl_env:main", "0"); expect((await stateOf(erich, id)).env.state).toBe("unavailable"); await setFlag("vcl_env:main", "1");
    await api(erich, "DELETE", "/api/devices/" + dev.deviceId); expect((await stateOf(erich, id)).env.state).toBe("revoked");
  });
});

describe("a device chat turn", () => {
  it("start (with the chosen folder) -> text, tool call, result, text -> normal messages, title, status events; the next message is a say", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "list the files" });
    await dm.until(() => dm.processed.length === 1, "start delivered");
    expect(dm.processed[0]).toMatchObject({ kind: "start", prompt: "list the files", dir: "/work/app" });
    dm.emit("session_started", { dir: "/work/app", sandbox: "bwrap", bash: true });
    dm.emit("assistant_text", { text: "Let me look." });
    dm.emit("tool_use", { id: "t1", name: "Bash", input: { command: "ls" } });
    dm.emit("tool_result", { id: "t1", is_error: false, content: "a.txt b.txt" });
    dm.emit("assistant_text", { text: "Two files." });
    dm.emit("turn_done", { subtype: "success", is_error: false });
    await c.until(() => c.evs("turn_end").length === 1, "turn_end");
    const s = await stateOf(erich, id);
    expect(s.state.running).toBe(false); expect(s.state.error).toBeNull();
    const m = s.state.messages; expect(m.map((x: any) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(m[1].content.map((b: any) => b.type)).toEqual(["text", "tool_use"]); expect(m[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "a.txt b.txt" }); expect(m[3].content[0].text).toBe("Two files.");
    expect(s.state.title).toBe("list the files");
    expect(s.state.model).not.toBe("device"); // the chat's model setting is untouched
    const dv = c.evs("device_ev").map((x) => x.e.type); expect(dv).toContain("cmd_ack"); expect(dv).toContain("cmd_sent"); expect(dv).toContain("cmd_acked"); expect(dv).toContain("session_started"); expect(dv).toContain("turn_done");
    expect(JSON.stringify(c.evs("device_ev"))).not.toContain("Two files"); // status events carry no content
    // second message: the session is still open on the device -> say
    c.send({ t: "send", text: "thanks, now count them" });
    await dm.until(() => dm.processed.length === 2, "say delivered"); expect(dm.processed[1]).toMatchObject({ kind: "say", text: "thanks, now count them" });
    dm.emit("assistant_text", { text: "Two." }); dm.emit("turn_done", {});
    await c.until(() => c.evs("turn_end").length === 2, "second turn_end");
    // after the session ended the next one is a start again
    dm.emit("session_ended", {}); await sleep(60);
    c.send({ t: "send", text: "again" }); await dm.until(() => dm.processed.length === 3, "start again"); expect(dm.processed[2]).toMatchObject({ kind: "start", prompt: "again" });
    dm.emit("session_started", {}); dm.emit("turn_done", {}); await c.until(() => c.evs("turn_end").length === 3, "third turn_end");
  });
  it("a session_error ends the turn with the plain text, nothing is retried on the model", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "go" }); await dm.until(() => dm.processed.length === 1);
    dm.emit("session_error", { code: "dir_outside_roots" });
    await c.until(() => c.evs("turn_end").length === 1, "turn_end");
    const te = c.evs("turn_end")[0]; expect(te.status).toBe("error"); expect(te.error.message).toContain("not under a configured root"); expect(te.error.retryable).toBe(false);
    expect((await stateOf(erich, id)).state.messages.map((x: any) => x.role)).toEqual(["user"]);
  });
  it("device offline at send: the line reads queued, the command waits in the hub and runs when the daemon is back", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    dm.drop(); await sleep(150);
    c.send({ t: "send", text: "when you wake" });
    await c.until(() => c.evs("device_ev").some((x) => x.e.type === "cmd_ack"), "ack");
    expect(c.evs("device_ev").find((x) => x.e.type === "cmd_ack").e.queued).toBe(true);
    expect(dm.processed).toHaveLength(0);
    await dm.connect(); await dm.waitFrame((f) => f.t === "welcome"); await dm.until(() => dm.processed.length === 1, "replayed");
    dm.emit("session_started", {}); dm.emit("assistant_text", { text: "hi" }); dm.emit("turn_done", {});
    await c.until(() => c.evs("turn_end").length === 1, "turn_end");
  });
  it("Stop sends a stop command to the device and ends the turn as interrupted", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "long job" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {});
    await sleep(100); c.send({ t: "stop" });
    await dm.until(() => dm.processed.some((p) => p.kind === "stop"), "stop delivered");
    await c.until(() => c.evs("turn_end").length === 1, "turn_end"); expect(c.evs("turn_end")[0].status).toBe("interrupted");
  });
  it("the device is revoked while the turn runs: the turn ends with a plain error, history stays", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "x" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {}); dm.emit("assistant_text", { text: "working" }); await c.until(() => c.evs("content_block_delta").length > 0, "the turn has read the text (load-independent, instead of a fixed sleep)");
    await api(erich, "DELETE", "/api/devices/" + dev.deviceId);
    await c.until(() => c.evs("turn_end").length === 1, "turn_end");
    expect(c.evs("turn_end")[0].error.message).toContain("revoked");
    const s = await stateOf(erich, id); expect(s.state.messages.map((x: any) => x.role)).toEqual(["user", "assistant"]); expect(s.env.state).toBe("revoked");
  });
  it("the flag is turned off while the device is quiet: the turn ends within one poll with the reason, not at the 13 minute cap", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "x" }); await dm.until(() => dm.processed.length === 1); await sleep(150);
    await setFlag("vcl_env:main", "0");
    await c.until(() => c.evs("turn_end").length === 1, "turn_end", 15000);
    expect(c.evs("turn_end")[0].error.message).toContain("turned off"); expect(c.evs("turn_end")[0].status).toBe("error");
  }, 25000);
  it("flag turned off or device revoked BEFORE a send: refused with a reason, nothing stored, the model is never called, the daemon gets nothing", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    await setFlag("vcl_env:main", "0");
    c.send({ t: "send", text: "hello" }); await c.until(() => c.frames.some((f) => f.t === "rejected"), "rejected");
    expect(c.frames.find((f) => f.t === "rejected").error).toContain("turned off");
    await setFlag("vcl_env:main", "1"); await api(erich, "DELETE", "/api/devices/" + dev.deviceId); c.frames.length = 0;
    c.send({ t: "send", text: "hello again" }); await c.until(() => c.frames.some((f) => f.t === "rejected"), "rejected 2");
    expect(c.frames.find((f) => f.t === "rejected").error).toContain("no longer available");
    expect((await stateOf(erich, id)).state.messages).toEqual([]); expect(dm.processed).toHaveLength(0);
  });
  it("retry / generate / attachments are refused on a device chat (they would reach the model)", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "retry" }); c.send({ t: "generate", kind: "image", prompt: "x", model: "m" }); c.send({ t: "send", text: "x", files: [{ ref: "r", name: "a", mime: "text/plain", size: 1 }] });
    await c.until(() => c.frames.filter((f) => f.t === "rejected").length === 3, "3 rejections");
    expect(dm.processed).toHaveLength(0);
  });
});

describe("approvals in the chat", () => {
  it("the device asks, the card appears on the tool call, Allow reaches the device exactly once, the turn finishes", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "delete tmp" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {});
    dm.emit("tool_use", { id: "t1", name: "Bash", input: { command: "rm -rf tmp" } });
    dm.emit("approval_request", { rid: "r1", tool: "Bash", preview: "rm -rf tmp", ttl_s: 120 });
    await c.until(() => c.evs("approval_required").length === 1, "approval_required");
    const ar = c.evs("approval_required")[0]; expect(ar.calls).toHaveLength(1); expect(ar.calls[0]).toMatchObject({ id: "dv-r1", name: "Bash" });
    expect((await stateOf(erich, id)).state.awaiting.calls[0]).toMatchObject({ id: "dv-r1", decision: null }); // a reload shows the same card
    c.send({ t: "approve", id: "dv-r1", decision: "approve" });
    await dm.until(() => dm.processed.some((p) => p.kind === "approval"), "approval delivered");
    expect(dm.processed.filter((p) => p.kind === "approval")).toHaveLength(1); expect(dm.processed.find((p) => p.kind === "approval")).toMatchObject({ rid: "r1", allow: true });
    c.send({ t: "approve", id: "dv-r1", decision: "approve" }); await sleep(100); expect(c.frames.some((f) => f.t === "rejected")).toBe(true); expect(dm.processed.filter((p) => p.kind === "approval")).toHaveLength(1);
    dm.emit("tool_result", { id: "t1", content: "done" }); dm.emit("turn_done", {});
    await c.until(() => c.evs("turn_end").length === 1, "turn_end"); expect(c.evs("turn_end")[0].status).toBe("done");
    expect((await stateOf(erich, id)).state.awaiting).toBeNull();
  });
  it("Deny reaches the device as deny; an approval that expired on the hub is refused and the card goes away", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "x" }); await dm.until(() => dm.processed.length === 1);
    dm.emit("session_started", {}); dm.emit("tool_use", { id: "t1", name: "Write", input: {} }); dm.emit("approval_request", { rid: "r1", tool: "Write", preview: "w", ttl_s: 60 });
    await c.until(() => c.evs("approval_required").length === 1, "card");
    c.send({ t: "approve", id: "dv-r1", decision: "deny" });
    await dm.until(() => dm.processed.some((p) => p.kind === "approval"), "deny delivered"); expect(dm.processed.find((p) => p.kind === "approval")).toMatchObject({ rid: "r1", allow: false });
    dm.emit("tool_result", { id: "t1", is_error: true, content: "denied" }); dm.emit("turn_done", {}); await c.until(() => c.evs("turn_end").length === 1, "end");
  });
  it("the creator is pinned in the chat: a chat whose user is not the device's owner never reaches it, and a bound chat cannot be re-bound", async () => {
    const cloud = ((await (await api(erich, "POST", "/api/conversations", {})).json()) as any).id as string; // a normal chat, then pinned (as the Worker would) to a device that belongs to someone else
    const doStub = (id: string) => e.CHAT.get(e.CHAT.idFromName(id));
    const bind = (id: string, user: string) => doStub(id).fetch(new Request("https://do.internal/env", { method: "POST", headers: { "content-type": "application/json", "x-conv-id": id }, body: JSON.stringify({ device_id: dev.deviceId, dir: null, user }) }));
    expect((await bind(cloud, "mallory")).status).toBe(200);
    expect((await bind(cloud, "erich-again")).status).toBe(409); // once only
    const c = await openChat(erich, cloud);
    c.send({ t: "send", text: "x" }); await c.until(() => c.frames.some((f) => f.t === "rejected"), "rejected");
    expect(c.frames.find((f) => f.t === "rejected").error).toContain("no longer available"); expect(dm.processed).toHaveLength(0);
  });
});

describe("devv2s3c: approvals are bound to their own request", () => {
  it("two pending same-name requests: each card carries its own preview, approving one card resolves only that request", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "go" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {});
    dm.emit("tool_use", { id: "t1", name: "Bash", input: "echo harmless" }); dm.emit("tool_use", { id: "t2", name: "Bash", input: "rm -rf /" });
    dm.emit("approval_request", { rid: "r1", tool: "Bash", preview: "echo harmless", ttl_s: 120 }); dm.emit("approval_request", { rid: "r2", tool: "Bash", preview: "rm -rf /", ttl_s: 120 });
    await c.until(() => (c.evs("approval_required").at(-1)?.calls ?? []).length === 2, "two cards");
    const calls = c.evs("approval_required").at(-1).calls; expect(calls.map((x: any) => x.id).sort()).toEqual(["dv-r1", "dv-r2"]);
    const saved = (await stateOf(erich, id)).state.messages.flatMap((m: any) => m.role === "assistant" ? m.content : []).filter((b: any) => b.type === "tool_use" && b.id.startsWith("dv-"));
    expect(saved.map((b: any) => [b.id, b.input.preview])).toEqual([["dv-r1", "echo harmless"], ["dv-r2", "rm -rf /"]]);
    c.send({ t: "approve", id: "dv-r1", decision: "approve" });
    await dm.until(() => dm.processed.some((p) => p.kind === "approval"), "delivered");
    expect(dm.processed.filter((p) => p.kind === "approval").map((p: any) => [p.rid, p.allow])).toEqual([["r1", true]]);
    c.send({ t: "approve", id: "t1", decision: "approve" }); c.send({ t: "approve", id: "t2", decision: "approve" }); await sleep(120); // the raw tool ids are not approval cards
    expect(dm.processed.filter((p) => p.kind === "approval")).toHaveLength(1);
    dm.emit("turn_done", {}); await c.until(() => c.evs("turn_end").length === 1, "end");
  });
});

describe("devv2s3c: a device chat belongs to its owner, not to the scope", () => {
  const bobOf = async (): Promise<Me> => { e.ALLOWED_GITHUB_LOGINS = "example-user,bob"; return cookieOf("bob"); };
  it("another allowlisted user of the same scope gets 404 on state, WebSocket, rename, fork, files, delete; the owner and cloud chats are unchanged", async () => {
    const id = await mkChat(erich, dev.deviceId); const bob = await bobOf();
    const hits: string[] = []; const stub = e.CHAT.get.bind(e.CHAT); e.CHAT.get = (...a: any[]) => { hits.push("do"); return stub(...a); };
    try {
      expect((await api(bob, "GET", "/api/conversations/" + id)).status).toBe(404);
      expect((await call(new Request(`${ORIGIN}/api/conversations/${id}/ws?since=0`, { headers: { upgrade: "websocket", cookie: bob.cookie, origin: ORIGIN } }))).status).toBe(404);
      expect((await api(bob, "PATCH", "/api/conversations/" + id, { title: "pwned" })).status).toBe(404);
      expect((await api(bob, "POST", `/api/conversations/${id}/fork`, { message_id: 1 })).status).toBe(404);
      expect((await api(bob, "GET", `/api/conversations/${id}/files/x`)).status).toBe(404);
      expect((await api(bob, "DELETE", "/api/conversations/" + id)).status).toBe(404);
      expect(hits).toEqual([]); // no DO was reached for any of them
    } finally { e.CHAT.get = stub; }
    expect(await dm.processed.length).toBe(0);
    const s = await stateOf(erich, id); expect(s.env).toMatchObject({ kind: "device" }); expect(s.conversation.title).not.toBe("pwned");
    const c = await openChat(erich, id); c.send({ t: "send", text: "mine" }); await dm.until(() => dm.processed.length === 1, "owner can still send"); dm.emit("session_started", {}); dm.emit("turn_done", {}); await c.until(() => c.evs("turn_end").length === 1, "end");
    const cloud = ((await (await api(erich, "POST", "/api/conversations", {})).json()) as any).id as string;
    expect((await api(bob, "GET", "/api/conversations/" + cloud)).status).toBe(200); // cloud chats stay scope-visible exactly as before
  });
  it("still works when migration 0042 is not applied (no env_* columns): cloud chats open for everyone in scope", async () => {
    const cloud = ((await (await api(erich, "POST", "/api/conversations", {})).json()) as any).id as string; const bob = await bobOf();
    const row = (await e.DB.prepare(`SELECT * FROM conversations WHERE id=?`).bind(cloud).first()) as any; expect(row.env_kind ?? null).toBeNull();
    expect((await api(bob, "GET", "/api/conversations/" + cloud)).status).toBe(200); expect((await api(erich, "GET", "/api/conversations/" + cloud)).status).toBe(200);
  });
});

describe("devv2s3c: the environment switch gates every bridge POST", () => {
  const hubPost = (path: string, body: unknown) => e.DEVICES.get(e.DEVICES.idFromName(dev.deviceId)).fetch(new Request("https://do.internal" + path, { method: "POST", headers: { "content-type": "application/json", "x-vcl-device": dev.deviceId, "x-vcl-scope": "main", "x-vcl-user": "example-user" }, body: JSON.stringify(body) }));
  it("vcl_env off (vcl still on): /bridge/approval and /bridge/cmd are refused 404 and nothing reaches the device", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "go" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {});
    dm.emit("approval_request", { rid: "r1", tool: "Bash", preview: "x", ttl_s: 120 }); await c.until(() => c.evs("approval_required").length === 1, "card");
    await setFlag("vcl_env:main", "0");
    const a = await hubPost("/bridge/approval", { conv: id, rid: "r1", allow: true }); expect(a.status).toBe(404);
    const m = await hubPost("/bridge/cmd", { conv: id, cid: "zz-cmd-1", kind: "start", prompt: "evil" }); expect(m.status).toBe(404);
    const st = await hubPost("/bridge/cmd", { conv: id, cid: "zz-cmd-2", kind: "stop" }); expect(st.status).not.toBe(404); // devv2s3r: a STOP of the user's own session is cleanup, never refused as "disabled" (200 while draining; 409 once the hub's own stop already released the holder)
    await sleep(150); expect(dm.processed.filter((p) => (p.kind === "approval" && (p as any).allow === true) || p.cid === "zz-cmd-1")).toEqual([]);
    expect(dm.processed.some((p) => p.kind === "stop")).toBe(true);
    await setFlag("vcl_env:main", "1"); expect((await hubPost("/bridge/approval", { conv: id, rid: "r1", allow: true })).status).toBe(409); // devv2s3r: the switch-off ended that session's generation: its approval is closed for good, never answerable later
  });
});

// ---- devv2s3d: round-2 review findings, through the real routes / ChatSession / DeviceHub ----
const SECRET = "ZEBRA_SECRET_FROM_DEVICE_OUTPUT";
const bobOf2 = async (): Promise<Me> => { e.ALLOWED_GITHUB_LOGINS = "example-user,bob"; return cookieOf("bob"); };
const ids = (j: any) => (j.conversations as Array<{ id: string }>).map((x) => x.id);
const countConvs = async () => ((await e.DB.prepare(`SELECT COUNT(*) AS n FROM conversations`).first()) as any).n as number;
/** One finished device turn whose answer carries SECRET; returns the chat id. */
async function finishedDeviceChat(me: Me, text = "tell me") {
  const id = await mkChat(me, dev.deviceId); const c = await openChat(me, id);
  c.send({ t: "send", text }); await dm.until(() => dm.processed.length >= 1, "start");
  const n0 = dm.processed.length;
  dm.emit("session_started", {}); dm.emit("assistant_text", { text: `answer: ${SECRET}` }); dm.emit("turn_done", {});
  await c.until(() => c.evs("turn_end").length === 1, "turn_end"); c.ws.close(); await sleep(30);
  expect(n0).toBeGreaterThan(0);
  return id;
}

describe("devv2s3d: Edit-earlier (fork) of a device chat", () => {
  it("the owner gets 409 and NOTHING is created; another user of the scope gets 404 (original and any fork); a cloud chat still forks", async () => {
    const id = await finishedDeviceChat(erich); const bob = await bobOf2();
    const msgId = (await stateOf(erich, id)).state.messages[0].id as number;
    const before = await countConvs();
    const r = await api(erich, "POST", `/api/conversations/${id}/fork`, { message_id: msgId });
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: "Device conversation forks are unsupported." });
    expect(await countConvs()).toBe(before);
    expect((await api(bob, "POST", `/api/conversations/${id}/fork`, { message_id: msgId })).status).toBe(404);
    expect(await countConvs()).toBe(before);
    // no readable copy exists for Bob anywhere
    const all = ((await e.DB.prepare(`SELECT id FROM conversations`).all()) as any).results.map((x: any) => x.id as string);
    for (const cid of all) { const g = await api(bob, "GET", "/api/conversations/" + cid); if (cid === id) expect(g.status).toBe(404); else expect(JSON.stringify(await g.json())).not.toContain(SECRET); }
    // control: a cloud chat is not affected by the guard (404 for an unknown message, not the 409 text)
    const cloud = ((await (await api(erich, "POST", "/api/conversations", {})).json()) as any).id as string;
    const cr = await api(erich, "POST", `/api/conversations/${cloud}/fork`, { message_id: 1 });
    expect(cr.status).not.toBe(409);
  });
});

describe("devv2s3d: list, search, usage and library never show another user's device chat", () => {
  it("title list, keyword search (title + message text), project filter, usage top and library: Alice sees hers, Bob sees none of it, cloud chats stay scope-visible", async () => {
    const id = await finishedDeviceChat(erich, "ZEBRA question");
    await api(erich, "PATCH", "/api/conversations/" + id, { title: "ZEBRA_TITLE private" });
    const proj = await api(erich, "POST", "/api/projects", { name: "p1", instructions: "" }); const pid = proj.status === 201 ? ((await proj.json()) as any).id : null;
    if (pid) await api(erich, "PATCH", "/api/conversations/" + id, { project_id: pid });
    await e.DB.prepare(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cost_usd, scope) VALUES (?, 'device', 1, 1, 0.5, 'main')`).bind(id).run();
    const cloud = ((await (await api(erich, "POST", "/api/conversations", {})).json()) as any).id as string;
    await api(erich, "PATCH", "/api/conversations/" + cloud, { title: "ZEBRA_TITLE cloud" });
    const bob = await bobOf2();
    const list = async (me: Me, q = "") => ids(await (await api(me, "GET", "/api/conversations" + q)).json());
    // control: the owner sees it everywhere
    expect(await list(erich)).toContain(id); expect(await list(erich, "?q=ZEBRA_TITLE")).toContain(id);
    expect(await list(erich, "?q=" + encodeURIComponent(SECRET))).toContain(id);
    // Bob: not in any list/search shape, cloud chat still is
    for (const q of ["", "?q=ZEBRA_TITLE", "?q=" + encodeURIComponent(SECRET), "?q=ZEBRA", ...(pid ? ["?project=" + pid] : [])]) {
      const raw = JSON.stringify(await (await api(bob, "GET", "/api/conversations" + q)).json());
      expect(raw, q).not.toContain(id); expect(raw, q).not.toContain("private"); expect(raw, q).not.toContain(SECRET);
    }
    expect(await list(bob)).toContain(cloud); expect(await list(bob, "?q=ZEBRA_TITLE")).toContain(cloud);
    const uRaw = JSON.stringify(await (await api(bob, "GET", "/api/usage")).json()); expect(uRaw).not.toContain(id); expect(uRaw).not.toContain("ZEBRA_TITLE private");
    expect(JSON.stringify(await (await api(erich, "GET", "/api/usage")).json())).toContain(id);
    const lib = JSON.stringify(await (await api(bob, "GET", "/api/library")).json()); expect(lib).not.toContain(id);
  });
});

describe("devv2s3d: a device turn produces no scope-wide notification or push", () => {
  const notifs = async (me: Me) => ((await (await api(me, "GET", "/api/notifications")).json()) as any).items as Array<{ body?: string; title?: string }>;
  it("done and error: no stored notification for anyone (Bob cannot read the preview), the in-app turn state still updates", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id); const bob = await bobOf2();
    c.send({ t: "send", text: "go" }); await dm.until(() => dm.processed.length === 1);
    dm.emit("session_started", {}); dm.emit("assistant_text", { text: SECRET }); dm.emit("turn_done", {});
    await c.until(() => c.evs("turn_end").length === 1, "turn_end"); await sleep(150);
    expect((await stateOf(erich, id)).state.running).toBe(false);
    c.send({ t: "send", text: "again" }); await dm.until(() => dm.processed.length === 2);
    dm.emit("session_error", { code: "dir_outside_roots" }); await c.until(() => c.evs("turn_end").length === 2, "error end"); await sleep(150);
    expect((await stateOf(erich, id)).state.running).toBe(false);
    c.ws.close(); await sleep(50); // with NO watching socket the old code went on to push as well
    expect(JSON.stringify(await notifs(bob))).not.toContain(SECRET); expect(await notifs(bob)).toEqual([]); expect(await notifs(erich)).toEqual([]);
    expect(((await e.DB.prepare(`SELECT COUNT(*) AS n FROM notifications`).first()) as any).n).toBe(0);
  });
  it("control: a cloud chat turn that fails still stores a notification (the shared hook is only silenced for device chats)", async () => {
    const cid = ((await (await api(erich, "POST", "/api/conversations", {})).json()) as any).id as string; const c = await openChat(erich, cid);
    c.send({ t: "send", text: "hello cloud" }); await c.until(() => c.evs("turn_end").length === 1, "cloud turn_end", 20000); await sleep(200);
    expect((await notifs(erich)).length).toBeGreaterThan(0);
  }, 30000);
});

describe("devv2s3d: migration 0042 NOT applied (the env_* columns really dropped)", () => {
  it("device create => 503 and nothing created; cloud chats open, list (title, FTS, project), fork, usage and library all keep working", async () => {
    for (const col of ["env_kind", "env_device_id", "env_dir", "env_user"]) await e.DB.prepare(`ALTER TABLE conversations DROP COLUMN ${col}`).run();
    expect(((await e.DB.prepare(`SELECT name FROM pragma_table_info('conversations') WHERE name LIKE 'env_%'`).all()) as any).results).toEqual([]);
    const before = await countConvs();
    expect((await api(erich, "POST", "/api/conversations", { env: { kind: "device", device_id: dev.deviceId } })).status).toBe(503);
    expect(await countConvs()).toBe(before);
    const cloud = ((await (await api(erich, "POST", "/api/conversations", {})).json()) as any).id as string; const bob = await bobOf2();
    await api(erich, "PATCH", "/api/conversations/" + cloud, { title: "ZEBRA cloud title" });
    expect((await api(bob, "GET", "/api/conversations/" + cloud)).status).toBe(200);          // owned() SELECT * is tolerant
    expect((await stateOf(erich, cloud)).env).toBeUndefined();
    for (const me of [erich, bob]) for (const q of ["", "?q=ZEBRA", "?q=" + encodeURIComponent("cloud title")]) {
      const r = await api(me, "GET", "/api/conversations" + q); expect(r.status, q).toBe(200); expect(ids(await r.json()), q).toContain(cloud);
    }
    expect((await api(erich, "GET", "/api/usage")).status).toBe(200); expect((await api(erich, "GET", "/api/library")).status).toBe(200);
    const fk = await api(erich, "POST", `/api/conversations/${cloud}/fork`, { message_id: 1 }); expect(fk.status).not.toBe(500); expect(fk.status).not.toBe(409);
    // the dropped-column fallback is ONLY for "no such column env_*": an unrelated D1 failure still fails loudly, never open
    const { withDevVisibility } = await import("../src/dev-visibility");
    await expect(withDevVisibility("c", "u", async () => { throw new Error("D1_ERROR: database is locked"); })).rejects.toThrow("locked");
  });
});

describe("devv2s3d: the saved transcript of a real device turn is valid (workerd, real ChatSession + hub + daemon)", () => {
  it("two same-name approvals, one denied, then Stop mid-turn with the other pending: every saved call has exactly one result", async () => {
    const id = await mkChat(erich, dev.deviceId); const c = await openChat(erich, id);
    c.send({ t: "send", text: "go" }); await dm.until(() => dm.processed.length === 1); dm.emit("session_started", {});
    dm.emit("tool_use", { id: "t1", name: "Bash", input: "a" }); dm.emit("tool_use", { id: "t2", name: "Bash", input: "b" });
    dm.emit("approval_request", { rid: "r1", tool: "Bash", preview: "a", ttl_s: 120 }); dm.emit("approval_request", { rid: "r2", tool: "Bash", preview: "b", ttl_s: 120 });
    await c.until(() => (c.evs("approval_required").at(-1)?.calls ?? []).length === 2, "two cards");
    c.send({ t: "approve", id: "dv-r1", decision: "deny" }); await dm.until(() => dm.processed.some((p) => p.kind === "approval"), "deny delivered");
    dm.emit("approval_resolved", { rid: "r1", state: "denied", by: "u" }); dm.emit("tool_result", { id: "t1", is_error: true, content: "denied" }); dm.emit("tool_result", { id: "t1", is_error: true, content: "denied twice" });
    await sleep(150); c.send({ t: "stop" });
    await c.until(() => c.evs("turn_end").length === 1, "turn_end"); expect(c.evs("turn_end")[0].status).toBe("interrupted");
    const s = await stateOf(erich, id); expectValidTranscript(s.state.messages); expect(s.state.running).toBe(false); expect(s.state.awaiting).toBeNull();
  });
});
