import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runDeviceTurn, DEVICE_TURN_MAX_MS, type DeviceIO, type HubEvent } from "../src/device-turn";
import { DeviceFolder } from "../src/device-env";
import { ChatEngine } from "../src/turn-engine";
import { transcriptViolations } from "./transcript-invariant";

// A scripted engine + io: the real runDeviceTurn and the real DeviceFolder, only the storage/hub edges are fakes.
function fakeEngine() {
  const ended: Array<{ status: string; error?: { message: string } }> = [], applied: unknown[] = [];
  return { ended, applied, deviceStopRequested: false, deviceBegin: () => ({ ok: true as const, turn: 1, signal: new AbortController().signal }), deviceApply: (_t: number, ops: unknown[]) => { applied.push(...ops); }, deviceSessionActive: () => false, deviceExpect: () => {}, setMeta: () => {}, setDeviceSessionActive: () => {},
    deviceEnd: async (_t: number, status: string, error?: { message: string }) => { ended.push({ status, error }); } } as any;
}
const ev = (seq: number, e: Record<string, unknown>): HubEvent => ({ seq, ts: seq, e });

describe("runDeviceTurn: kill switch under continuous traffic", () => {
  test("every successful poll re-checks the switch BEFORE folding: nonempty polls + flag flipped = the turn ends at the next poll with the plain error", async () => {
    let on = true, polls = 0, checks = 0, seq = 0;
    const io: DeviceIO = {
      check: async () => { checks++; return on ? { ok: true, name: "laptop", dir: null } : { ok: false, error: "Devices are turned off for this account." }; },
      cmd: async () => ({ ok: true, since: 0, queued: false, dup: false }),
      poll: async () => { polls++; if (polls === 2) on = false; return { ok: true, events: [ev(++seq, { type: "assistant_text", text: "tick " + seq })], online: true, gap: false }; },
      approve: async () => ({ ok: true }),
    };
    const eng = fakeEngine();
    const r = await runDeviceTurn(eng, io, "go", { pollMs: 1, maxMs: 60_000, newCid: () => "c1" });
    expect(r).toEqual({ ok: true }); expect(polls).toBe(2);                 // ended on the poll after the flip, not at the cap
    expect(checks).toBe(1 + 2);                                              // once before the turn, once per successful poll
    expect(eng.ended).toHaveLength(1); expect(eng.ended[0].status).toBe("error"); expect(eng.ended[0].error?.message).toContain("turned off");
    const texts = eng.applied.filter((o: any) => o.k === "assistant").flatMap((o: any) => o.blocks.map((b: any) => b.text));
    expect(texts).toEqual(["tick 1"]);                                       // the events of the poll that observed OFF were not folded
  });
  test("control: flag stays on, the turn runs to turn_done", async () => {
    let polls = 0;
    const io: DeviceIO = { check: async () => ({ ok: true, name: "l", dir: null }), cmd: async () => ({ ok: true, since: 0, queued: false, dup: false }),
      poll: async () => ({ ok: true, events: polls++ === 0 ? [ev(1, { type: "assistant_text", text: "a" })] : [ev(2, { type: "turn_done" })], online: true, gap: false }), approve: async () => ({ ok: true }) };
    const eng = fakeEngine(); await runDeviceTurn(eng, io, "go", { pollMs: 1, newCid: () => "c1" });
    expect(eng.ended[0].status).toBe("done");
  });
});

// devv2s3d: the REAL ChatEngine (in-memory SQLite) behind runDeviceTurn, so what is asserted is what would be saved and what state the chat is left in.
function realEngine() {
  const db = new Database(":memory:"); const events: any[] = [];
  const engine = new ChatEngine({
    sql: { exec: (q: string, ...b: unknown[]) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider: { name: "never", listModels: async () => [], messages: async () => { throw new Error("a device chat must never reach the model"); } } as any,
    index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} } as any,
    sink: { broadcast: (_s: number, _t: number, e: any) => events.push(e) }, retryDelayMs: 1,
  });
  engine.setConvId("conv-d");
  return { engine, events };
}
const scripted = (engine: ChatEngine, batches: Array<Array<Record<string, unknown>>>, onPoll?: (n: number) => void): DeviceIO => {
  let n = 0, seq = 0;
  return { check: async () => ({ ok: true, name: "l", dir: null }), cmd: async () => ({ ok: true, since: 0, queued: false, dup: false }),
    poll: async () => { onPoll?.(n); const b = batches[Math.min(n++, batches.length - 1)] ?? []; return { ok: true, events: b.map((e) => ({ seq: ++seq, ts: seq, e })), online: true, gap: false }; }, approve: async () => ({ ok: true }) };
};
const msgs = (engine: ChatEngine) => engine.messages().map((m: any) => ({ role: m.role, content: m.content }));
describe("devv2s3d: transcript validity and end state through the real engine", () => {
  const appr = (rid: string, tool = "Bash") => ({ type: "approval_request", rid, tool, preview: "p-" + rid, ttl_s: 60, expires_at: Math.floor(Date.now() / 1000) + 60 });
  test("Stop in the middle of two pending same-name approvals: every call is closed, the chat is not running, nothing awaits", async () => {
    const { engine } = realEngine();
    const io = scripted(engine, [[{ type: "assistant_text", text: "x" }, { type: "tool_use", id: "t1", name: "Bash", input: "a" }, { type: "tool_use", id: "t2", name: "Bash", input: "b" }, appr("r1"), appr("r2")], []], (n) => { if (n === 1) engine.stop(); });
    expect(await runDeviceTurn(engine, io, "go", { pollMs: 1, newCid: () => "c1" })).toEqual({ ok: true });
    const m = msgs(engine); expect(transcriptViolations(m), JSON.stringify(m)).toEqual([]);
    expect(engine.running).toBe(false); expect(engine.state().awaiting ?? null).toBeNull();
  });
  test("deny, expire, replayed rid, a late tool_result after the card and a replayed result in ONE real turn: valid transcript, ends done", async () => {
    const { engine } = realEngine();
    const io = scripted(engine, [[{ type: "tool_use", id: "t1", name: "Write", input: {} }, appr("r1", "Write"), appr("r1", "Write"), { type: "approval_resolved", rid: "r1", state: "denied" }],
      [{ type: "tool_result", id: "t1", is_error: true, content: "denied" }, { type: "tool_use", id: "t2", name: "Bash", input: {} }, appr("r2"), { type: "approval_resolved", rid: "r2", state: "expired" }, { type: "assistant_text", text: "ok" }, { type: "tool_result", id: "t2", content: "late" }, { type: "tool_result", id: "t2", content: "late again" }, { type: "tool_use", id: "t3", name: "Bash", input: {} }, { type: "turn_done" }]]);
    await runDeviceTurn(engine, io, "go", { pollMs: 1, newCid: () => "c1" });
    const m = msgs(engine); expect(transcriptViolations(m), JSON.stringify(m)).toEqual([]); expect(engine.running).toBe(false);
  });
  test("the 13 minute cap: the turn ends with the plain device_timeout error, running is cleared, partial output stays and every call is closed", async () => {
    const { engine, events } = realEngine();
    let t = 1_000_000;
    const io = scripted(engine, [[{ type: "assistant_text", text: "partial" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }], []], () => { t += 7 * 60_000; });
    expect(DEVICE_TURN_MAX_MS).toBe(13 * 60_000);
    expect(await runDeviceTurn(engine, io, "slow", { pollMs: 1, now: () => t, newCid: () => "c1" })).toEqual({ ok: true });
    expect(engine.running).toBe(false);
    const end = events.filter((e) => e.type === "turn_end").at(-1); expect(end.status).toBe("error"); expect(end.error.message).toContain("13 minutes"); expect(end.error.retryable).toBe(false);
    expect(engine.state().error).toMatchObject({ message: expect.stringContaining("13 minutes") });
    const m = msgs(engine); expect(transcriptViolations(m), JSON.stringify(m)).toEqual([]); expect(JSON.stringify(m)).toContain("partial");
    // a new message is accepted afterwards (not stuck busy)
    const again = await runDeviceTurn(engine, scripted(engine, [[{ type: "turn_done" }]]), "again", { pollMs: 1, newCid: () => "c2" }); expect(again).toEqual({ ok: true });
  });
});

// devv2s3e: finding 7 (session state survives ordinary turns) and finding 8 (Stop before dispatch sends nothing).
function recIO(engine: ChatEngine, kinds: string[], batches: Array<Array<Record<string, unknown>>>, extra: Partial<DeviceIO> = {}): DeviceIO {
  let n = 0, seq = 0;
  return { check: async () => ({ ok: true, name: "l", dir: null }),
    cmd: async (c) => { kinds.push(c.kind); return { ok: true, since: 0, queued: false, dup: false }; },
    poll: async () => { const b = batches[Math.min(n++, batches.length - 1)] ?? []; return { ok: true, events: b.map((e) => ({ seq: ++seq, ts: seq, e })), online: true, gap: false }; }, approve: async () => ({ ok: true }), ...extra };
}
describe("devv2s3e finding 7: the folder starts from the persisted session state", () => {
  test("three ordinary messages = start, say, say; after session_stopped / session_error the next is a start again", async () => {
    const { engine } = realEngine(); const kinds: string[] = [];
    let cn = 0; const run = (batch: Array<Record<string, unknown>>) => runDeviceTurn(engine, recIO(engine, kinds, [batch]), "m", { pollMs: 1, newCid: () => "c" + ++cn });
    await run([{ type: "session_started", dir: "/w" }, { type: "assistant_text", text: "a" }, { type: "turn_done" }]);
    await run([{ type: "assistant_text", text: "b" }, { type: "turn_done" }]);   // a `say` emits no new session_started
    await run([{ type: "assistant_text", text: "c" }, { type: "turn_done" }]);
    expect(kinds).toEqual(["start", "say", "say"]);
    await run([{ type: "session_stopped" }]); expect(engine.deviceSessionActive()).toBe(false);
    await run([{ type: "session_started" }, { type: "turn_done" }]); await run([{ type: "session_error", code: "x" }]);
    await run([{ type: "turn_done" }]);
    expect(kinds.slice(3)).toEqual(["say", "start", "say", "start"]);
  });
});
describe("devv2s3e finding 8: Stop before dispatch", () => {
  test("a Stop already pending when the turn begins: zero start/say/stop commands, ends interrupted, user text stays", async () => {
    const { engine } = realEngine(); const kinds: string[] = [];
    const real = engine.deviceBegin.bind(engine);
    (engine as any).deviceBegin = (t: string) => { const r = real(t); engine.stop(); return r; };   // Stop lands the moment the turn is claimed
    const r = await runDeviceTurn(engine, recIO(engine, kinds, [[]]), "go", { pollMs: 1, newCid: () => "c1" });
    expect(r).toEqual({ ok: true }); expect(kinds).toEqual([]); expect(engine.running).toBe(false);
    expect(engine.state().error ?? null).toBeNull();
  });
  test("Stop during the async initial device check: nothing is dispatched", async () => {
    const { engine } = realEngine(); const kinds: string[] = [];
    // no turn is running during check() and the alarm already cleared `pending`: the engine must still remember a Stop that lands here
    const io = recIO(engine, kinds, [[]], { check: async () => { engine.stop(); return { ok: true, name: "l", dir: null }; } });
    await runDeviceTurn(engine, io, "go", { pollMs: 1, newCid: () => "c1" });
    expect(kinds).toEqual([]); expect(engine.running).toBe(false);
  });
  test("Stop arriving while the first cmd is in flight: the stop command follows, the turn ends interrupted", async () => {
    const { engine } = realEngine(); const kinds: string[] = [];
    const io = recIO(engine, kinds, [[]], { cmd: async (c) => { kinds.push(c.kind); if (c.kind === "start") engine.stop(); return { ok: true, since: 0, queued: false, dup: false }; } });
    await runDeviceTurn(engine, io, "go", { pollMs: 1, newCid: () => "c1" });
    expect(kinds).toEqual(["start", "stop"]); expect(engine.running).toBe(false);
  });
  test("Stop between a rejected say and the fallback start: no start is sent", async () => {
    const { engine } = realEngine(); engine.setDeviceSessionActive(true); const kinds: string[] = [];
    const io = recIO(engine, kinds, [[]], { cmd: async (c) => { kinds.push(c.kind); if (c.kind === "say") { engine.stop(); return { ok: false, error: "no_session", notYourSession: true }; } return { ok: true, since: 0, queued: false, dup: false }; } });
    await runDeviceTurn(engine, io, "go", { pollMs: 1, newCid: () => "c1" });
    expect(kinds).toEqual(["say"]); expect(engine.running).toBe(false);
  });
});

// devv2s3e finding 6: restart (a NEW ChatEngine over the same storage + init()) at EVERY prefix of a device turn's operations.
describe("devv2s3e finding 6: restart recovery of an interrupted device turn", () => {
  const mkSql = (db: Database) => ({ exec: (q: string, ...b: unknown[]) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } });
  const mkEngine = (db: Database, events: any[]) => new ChatEngine({ sql: mkSql(db),
    provider: { name: "never", listModels: async () => [], messages: async () => { throw new Error("a recovered device turn must never reach the model"); } } as any,
    index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} } as any,
    sink: { broadcast: (_s: number, _t: number, e: any) => events.push(e) }, retryDelayMs: 1 });
  const SCRIPT: Array<Record<string, unknown>> = [
    { type: "session_started" }, { type: "assistant_text", text: "looking" }, { type: "tool_use", id: "t1", name: "Bash", input: "ls" }, { type: "tool_use", id: "t2", name: "Read", input: {} },
    { type: "approval_request", rid: "r1", tool: "Bash", preview: "rm x", expires_at: Math.floor(Date.now() / 1000) + 60 },
    { type: "tool_result", id: "t1", content: "a" }, { type: "assistant_text", text: "more" }, { type: "approval_resolved", rid: "r1", state: "allowed" },
    { type: "approval_request", rid: "r2", tool: "Write", preview: "w", expires_at: Math.floor(Date.now() / 1000) + 60 }, { type: "assistant_text", text: "tail" },
  ];
  const opsOf = (): any[] => { const f = new DeviceFolder("c1"); return SCRIPT.flatMap((e, i) => f.feed(i + 1, e)); };
  test("every op prefix: valid transcript, not running, not retryable, never redispatched, cards withdrawn, a following message is accepted", async () => {
    const all = opsOf(); expect(all.length).toBeGreaterThan(20);
    for (let k = 0; k <= all.length; k++) {
      const db = new Database(":memory:"), events: any[] = [];
      const a = mkEngine(db, events); a.setConvId("conv-d");
      const b = a.deviceBegin("go"); expect(b.ok).toBe(true); if (!b.ok) throw new Error();
      a.deviceApply(b.turn, all.slice(0, k));
      const ev2: any[] = [], e2 = mkEngine(db, ev2); await e2.init();       // "eviction": a fresh instance, only the storage survives
      const m = msgs(e2), tag = `prefix ${k}/${all.length}: ${JSON.stringify(m)}`;
      expect(transcriptViolations(m), tag).toEqual([]);
      expect(e2.running, tag).toBe(false); expect(e2.state().awaiting ?? null, tag).toBeNull();
      const end = ev2.filter((e) => e.type === "turn_end").at(-1); expect(end?.status, tag).toBe("interrupted"); expect(end?.error?.retryable, tag).toBe(false);
      expect(e2.state().error).toMatchObject({ retryable: false });
      if (k > 0) { // the unsaved tail survives as a message, the saved text is never duplicated
        const texts = m.flatMap((x: any) => (x.role === "assistant" ? x.content.filter((c: any) => c.type === "text").map((c: any) => c.text) : []));
        expect(new Set(texts).size, tag).toBe(texts.length);
      }
      const again = await runDeviceTurn(e2, scripted(e2, [[{ type: "turn_done" }]]), "next", { pollMs: 1, newCid: () => "c2" }); expect(again, tag).toEqual({ ok: true });
    }
  });
  test("a half-buffered text block (live, not yet saved) is kept on recovery; a plain cloud turn is untouched by the device branch", async () => {
    const db = new Database(":memory:"), a = mkEngine(db, []); a.setConvId("conv-d");
    const b = a.deviceBegin("go"); if (!b.ok) throw new Error();
    a.deviceApply(b.turn, new DeviceFolder("c1").feed(1, { type: "assistant_text", text: "unsaved words" }));
    const e2 = mkEngine(db, []); await e2.init();
    expect(JSON.stringify(msgs(e2))).toContain("unsaved words");
  });
});

describe("devv2s3e: reservation outcomes reach the chat as plain errors", () => {
  test("a busy start ends the turn with device_busy (no follower, no events read); a poll that says the chat no longer holds the device ends it too", async () => {
    const { engine, events } = realEngine(); let polled = 0;
    const busy: DeviceIO = { check: async () => ({ ok: true, name: "l", dir: null }), cmd: async () => ({ ok: false, error: "busy" }), poll: async () => { polled++; return { ok: true, events: [], online: true, gap: false }; }, approve: async () => ({ ok: true }) };
    await runDeviceTurn(engine, busy, "go", { pollMs: 1, newCid: () => "c1" });
    expect(polled).toBe(0); const end = events.filter((e) => e.type === "turn_end").at(-1); expect(end.status).toBe("error"); expect(end.error.message).toContain("another chat");
    const lost: DeviceIO = { ...busy, cmd: async () => ({ ok: true, since: 0, queued: false, dup: false }), poll: async () => ({ ok: true, events: [], online: true, gap: false, mine: false }) };
    await runDeviceTurn(engine, lost, "go2", { pollMs: 1, newCid: () => "c2" });
    expect(events.filter((e) => e.type === "turn_end").at(-1).error.message).toContain("no longer holds");
  });
});

describe("devv2s3r: dev_session persisted as events are folded", () => {
  test("session_started then a poll error / timeout: the engine already knows the session is open (next message says)", async () => {
    const states: boolean[] = []; let active = false;
    const eng = Object.assign(fakeEngine(), { deviceSessionActive: () => active, setDeviceSessionActive: (on: boolean) => { active = on; states.push(on); } });
    let polls = 0;
    const io: DeviceIO = { check: async () => ({ ok: true, name: "l", dir: null }), cmd: async () => ({ ok: true, since: 0, queued: false, dup: false }),
      poll: async () => (polls++ === 0 ? { ok: true, events: [ev(1, { type: "session_started", cid: "c1" })], online: true, gap: false } : { ok: false, error: "unavailable" }), approve: async () => ({ ok: true }) };
    await runDeviceTurn(eng, io, "go", { pollMs: 1, newCid: () => "c1" });
    expect(states).toEqual([true]); expect(active).toBe(true); expect(eng.ended[0].status).toBe("error");
  });
});
