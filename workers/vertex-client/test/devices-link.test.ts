// openDeviceLink against the mock hub, plus the repo's FakeApp (test/fake-daemon.ts) on the same hub as a cross-check of the seq rules.
import { describe, expect, test } from "bun:test";
import { openDeviceLink } from "../web/src/devices-ws";
import { FakeApp } from "./fake-daemon";
import { MockHub } from "./vcl-mock-hub";

const until = async (p: () => boolean, ms = 2000) => { const t = Date.now(); while (!p()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 2)); } };
const mk = (hub: MockHub, extra: Record<string, unknown> = {}) => {
  const got: number[] = [], states: string[] = [], frames: any[] = [], hellos: any[] = [];
  const link = openDeviceLink({ id: "d", WS: hub.WS, baseMs: 5, maxMs: 10, pingMs: 1e9, onEvent: (s: number) => got.push(s), onState: (s: string) => states.push(s), onFrame: (f: any) => frames.push(f), onHello: (f: any) => hellos.push(f), ...extra } as any);
  return { link, got, states, frames, hellos };
};

describe("openDeviceLink", () => {
  test("replays history, then live events, each once in order", async () => {
    const hub = new MockHub(); hub.emit({ type: "a" }); hub.emit({ type: "b" });
    const c = mk(hub); await until(() => c.got.length === 2);
    hub.emit({ type: "c" }); await until(() => c.got.length === 3);
    expect(c.got).toEqual([1, 2, 3]); expect(c.states).toContain("live"); c.link.stop();
  });
  test("a drop reconnects with since=<last applied>: no loss, no duplicate", async () => {
    const hub = new MockHub(); const c = mk(hub);
    await until(() => hub.socks.size === 1); hub.emit({ type: "a" }); hub.emit({ type: "b" }); await until(() => c.got.length === 2);
    hub.drop(); hub.emit({ type: "c" }); hub.emit({ type: "d" });          // events while the PWA is away
    await until(() => c.got.length === 4);
    expect(c.got).toEqual([1, 2, 3, 4]); expect(hub.opens).toEqual([0, 2]); expect(c.states).toContain("reconnecting"); c.link.stop();
  });
  test("comp1 manual reconnect(): connects again now, resumes from the last applied seq, no duplicate socket or event", async () => {
    const hub = new MockHub(); const c = mk(hub, { baseMs: 1e9, maxMs: 1e9 }); // backoff effectively never fires: only the manual button can reconnect
    await until(() => hub.socks.size === 1); hub.emit({ type: "a" }); hub.emit({ type: "b" }); await until(() => c.got.length === 2);
    c.link.reconnect(); await until(() => hub.opens.length === 2);
    hub.emit({ type: "c" }); await until(() => c.got.length === 3);
    expect(c.got).toEqual([1, 2, 3]); expect(hub.opens).toEqual([0, 2]); expect(hub.socks.size).toBe(1); c.link.stop();
  });
  test("comp1 reconnect() after the socket dropped (long backoff) reconnects immediately", async () => {
    const hub = new MockHub(); const c = mk(hub, { baseMs: 1e9, maxMs: 1e9 });
    await until(() => hub.socks.size === 1); hub.drop(); await until(() => c.states.includes("reconnecting")); expect(hub.opens).toHaveLength(1);
    c.link.reconnect(); await until(() => hub.opens.length === 2); await until(() => c.states.at(-1) === "live"); c.link.stop();
  });
  test("a 4003 (revoked) close is terminal: no reconnect loop, state revoked", async () => {
    const hub = new MockHub(); const c = mk(hub); await until(() => hub.socks.size === 1);
    [...hub.socks][0].close(4003, "revoked"); await until(() => c.states.includes("revoked"));
    await new Promise((r) => setTimeout(r, 60)); expect(hub.opens).toHaveLength(1); expect(c.states.at(-1)).toBe("revoked"); expect(c.states).not.toContain("reconnecting"); c.link.stop();
  });
  test("a duplicate frame is ignored; a gap forces a resumed reconnect", async () => {
    const hub = new MockHub(); const c = mk(hub); await until(() => hub.socks.size === 1);
    const s = [...hub.socks][0]; hub.emit({ type: "a" }); await until(() => c.got.length === 1);
    s.deliver({ t: "ev", seq: 1, ts: 0, e: { type: "a" } }); expect(c.got).toEqual([1]);
    s.deliver({ t: "ev", seq: 5, ts: 0, e: { type: "x" } });                 // gap: never applied
    await until(() => hub.opens.length === 2); expect(c.got).toEqual([1]); expect(hub.opens[1]).toBe(1); c.link.stop();
  });
  test("resync hello is surfaced and moves the cursor", async () => {
    const hub = new MockHub(); hub.emit({ type: "a" }); hub.emit({ type: "b" }); hub.resyncNext = true;
    const c = mk(hub); await until(() => c.hellos.length === 1);
    expect(c.hellos[0].resync).toBe(true); expect(c.got).toEqual([]); expect(c.link.last()).toBe(2); c.link.stop();
  });
  test("send needs an open socket; replies reach onFrame; stop closes", async () => {
    const hub = new MockHub(); const c = mk(hub);
    expect(c.link.send({ t: "ping" })).toBe(false);
    await until(() => hub.socks.size === 1);
    expect(c.link.send({ t: "cmd", cid: "x", kind: "stop" })).toBe(true); await until(() => c.frames.some((f) => f.t === "cmd_ack" && f.cid === "x"));
    c.link.stop(); expect(c.states.at(-1)).toBe("closed"); expect(c.link.send({ t: "ping" })).toBe(false);
  });
  test("FakeApp (reference client) sees the same stream on the same hub", async () => {
    const hub = new MockHub(); hub.emit({ type: "session_started" }); hub.emit({ type: "approval_request", rid: "r", tool: "Bash", preview: "ls", expires_at: 9e9, ttl_s: 300 });
    const app = new FakeApp(async (since) => hub.accept(since) as never); await app.connect();
    const c = mk(hub); await until(() => c.got.length === 2 && app.events.length === 2);
    app.send({ t: "approval_res", rid: "r", allow: true }); await until(() => c.got.length === 3);
    expect(app.errors).toEqual([]); expect(app.types()).toEqual(["session_started", "approval_request", "approval_resolved"]); expect(c.got).toEqual([1, 2, 3]); c.link.stop();
  });
});
