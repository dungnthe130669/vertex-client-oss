import { describe, expect, test } from "bun:test";
import { DeviceFolder, envBody, hubEventDev, type Op } from "../src/device-env";
import { transcriptViolations } from "./transcript-invariant";

const run = (evs: Array<Record<string, unknown>>, cid = "c1") => { const f = new DeviceFolder(cid); const ops: Op[] = []; evs.forEach((e, i) => ops.push(...f.feed(i + 1, e))); return { f, ops }; };
const kinds = (ops: Op[]) => ops.map((o) => o.k);

describe("envBody (create-chat body)", () => {
  test("absent / cloud = no env; device needs a 32-hex id; dir is optional and bounded", () => {
    expect(envBody(undefined)).toEqual({ ok: true, env: null });
    expect(envBody(null)).toEqual({ ok: true, env: null });
    expect(envBody({ kind: "cloud" })).toEqual({ ok: true, env: null });
    expect(envBody({ kind: "device", device_id: "a".repeat(32), dir: "/w/x" })).toEqual({ ok: true, env: { device_id: "a".repeat(32), dir: "/w/x" } });
    expect(envBody({ kind: "device", device_id: "a".repeat(32) })).toEqual({ ok: true, env: { device_id: "a".repeat(32), dir: null } });
  });
  test("garbage is refused, never guessed", () => {
    for (const v of [{ kind: "device" }, { kind: "device", device_id: "xyz" }, { kind: "device", device_id: "A".repeat(32) }, { kind: "device", device_id: "a".repeat(32), dir: 5 }, { kind: "device", device_id: "a".repeat(32), dir: "x".repeat(1025) },
      { kind: "device", device_id: "a".repeat(32), dir: "a\u0000b" }, { kind: "weird" }, "device", 7, []]) expect(envBody(v).ok).toBe(false);
  });
});

describe("DeviceFolder: hub events -> ops", () => {
  test("a plain answer: status events, text, turn_done = one assistant message then end done", () => {
    const { ops } = run([{ type: "cmd_sent", cid: "c1", cseq: 1 }, { type: "cmd_acked", cid: "c1", cseq: 1 }, { type: "session_started", dir: "/w" }, { type: "assistant_text", text: "hello" }, { type: "turn_done", is_error: false }]);
    expect(kinds(ops).filter((k) => k !== "dev" && k !== "live")).toEqual(["assistant", "end"]);
    const a = ops.find((o) => o.k === "assistant") as Extract<Op, { k: "assistant" }>;
    expect(a.blocks).toEqual([{ type: "text", text: "hello" }]); expect(a.stop).toBe("end_turn");
    expect(ops.at(-1)).toEqual({ k: "end", status: "done" });
  });
  test("other commands' lifecycle events never touch this turn's status", () => {
    const { ops } = run([{ type: "cmd_sent", cid: "other", cseq: 9 }, { type: "cmd_acked", cid: "other", cseq: 9 }]);
    expect(ops).toEqual([]);
  });
  test("text + tool_use + tool_result + text: the tool call and its result sit between two assistant messages", () => {
    const { ops } = run([{ type: "assistant_text", text: "let me look" }, { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }, { type: "tool_result", id: "t1", is_error: false, content: "a b" }, { type: "assistant_text", text: "two files" }, { type: "turn_done" }]);
    expect(kinds(ops).filter((k) => k === "assistant" || k === "results" || k === "end")).toEqual(["assistant", "results", "assistant", "end"]);
    const [a1, r, a2] = ops.filter((o) => o.k === "assistant" || o.k === "results") as any[];
    expect(a1.blocks.map((b: any) => b.type)).toEqual(["text", "tool_use"]); expect(a1.stop).toBe("tool_use"); expect(a1.blocks[1]).toEqual({ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } });
    expect(r.blocks).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "a b" }]);
    expect(a2.blocks).toEqual([{ type: "text", text: "two files" }]); expect(a2.stop).toBe("end_turn");
  });
  test("parallel tool calls share one assistant message and one results message; an error result is marked", () => {
    const { ops } = run([{ type: "tool_use", id: "t1", name: "Read", input: {} }, { type: "tool_use", id: "t2", name: "Read", input: {} }, { type: "tool_result", id: "t1", content: "x" }, { type: "tool_result", id: "t2", is_error: true, content: "boom" }, { type: "turn_done" }]);
    const msgs = ops.filter((o) => o.k === "assistant" || o.k === "results") as any[];
    expect(msgs.map((m) => m.k)).toEqual(["assistant", "results"]);
    expect(msgs[0].blocks).toHaveLength(2);
    expect(msgs[1].blocks).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }]);
  });
  test("a result for a call we never saw is dropped (no dangling tool_result)", () => {
    const { ops } = run([{ type: "tool_result", id: "ghost", content: "x" }, { type: "turn_done" }]);
    expect(ops.some((o) => o.k === "results")).toBe(false);
  });
  test("every approval_request gets its OWN card dv-<rid> carrying that request's preview, even when a same-name tool_use is open", () => {
    const { ops } = run([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm x" } }, { type: "approval_request", rid: "r1", tool: "Bash", preview: "rm x", expires_at: 100, ttl_s: 60 }]);
    expect(kinds(ops).filter((k) => k !== "live" && k !== "dev")).toEqual(["assistant", "approval"]);
    expect(ops.find((o) => o.k === "approval")).toEqual({ k: "approval", id: "dv-r1", rid: "r1", tool: "Bash", preview: "rm x", expires_at: 100 });
    const a = ops.find((o) => o.k === "assistant") as any;
    expect(a.blocks.map((b: any) => b.id)).toEqual(["t1", "dv-r1"]); expect(a.blocks[1].input).toEqual({ preview: "rm x" });
  });
  test("two pending same-name requests: each card id maps to its own rid (approving one can never resolve the other)", () => {
    const { ops } = run([{ type: "tool_use", id: "t1", name: "Bash", input: "echo harmless" }, { type: "tool_use", id: "t2", name: "Bash", input: "rm -rf /" },
      { type: "approval_request", rid: "r1", tool: "Bash", preview: "echo harmless", expires_at: 100 }, { type: "approval_request", rid: "r2", tool: "Bash", preview: "rm -rf /", expires_at: 100 }]);
    const ap = ops.filter((o) => o.k === "approval") as any[];
    expect(ap.map((x) => [x.id, x.rid, x.preview])).toEqual([["dv-r1", "r1", "echo harmless"], ["dv-r2", "r2", "rm -rf /"]]);
    expect(new Set(ap.map((x) => x.id)).size).toBe(2);
    const cards = (ops.filter((o) => o.k === "assistant") as any[]).flatMap((o) => o.blocks).filter((b) => b.id.startsWith("dv-"));
    expect(cards.map((b) => [b.id, b.input.preview])).toEqual([["dv-r1", "echo harmless"], ["dv-r2", "rm -rf /"]]);
  });
  test("daemon string-valued tool input is kept as a readable preview, not dropped to {}; the approval card still shows the preview", () => {
    const { ops } = run([{ type: "tool_use", id: "t1", name: "Bash", input: "ls -la" }, { type: "approval_request", rid: "r1", tool: "Bash", preview: "ls -la", expires_at: 1 }]);
    const a = ops.find((o) => o.k === "assistant") as any;
    expect(a.blocks[0].input).toEqual({ preview: "ls -la" });
    expect(a.blocks[1]).toMatchObject({ id: "dv-r1", input: { preview: "ls -la" } });
  });
  test("the preview is truncated to 4000 and a replayed/stale request never makes a second card", () => {
    const { ops } = run([{ type: "approval_request", rid: "r1", tool: "Bash", preview: "x".repeat(9000), expires_at: 1 }, { type: "approval_request", rid: "r1", tool: "Bash", preview: "other", expires_at: 1 }]);
    expect(ops.filter((o) => o.k === "approval")).toHaveLength(1);
    expect((ops.find((o) => o.k === "approval") as any).preview.length).toBe(4000);
  });
  test("a tool_result for a call that has an approval card folds normally; the card is a separate call", () => {
    const { ops } = run([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }, { type: "approval_request", rid: "r1", tool: "Bash", preview: "ls", expires_at: 1 }, { type: "approval_resolved", rid: "r1", state: "allowed" }, { type: "tool_result", id: "t1", content: "a" }, { type: "turn_done" }]);
    const res = ops.filter((o) => o.k === "results") as any[];
    expect(res.flatMap((r) => r.blocks.map((b: any) => [b.tool_use_id, b.content]))).toEqual([["dv-r1", "Allowed."], ["t1", "a"]]);
    expect(ops.at(-1)).toEqual({ k: "end", status: "done" });
  });
  test("approval_request with no matching tool_use synthesises a visible call (never an approval nobody can see)", () => {
    const { ops } = run([{ type: "approval_request", rid: "r9", tool: "Write", preview: "write f", expires_at: 5, ttl_s: 5 }]);
    const a = ops.find((o) => o.k === "assistant") as any, p = ops.find((o) => o.k === "approval") as any;
    expect(a.blocks[0]).toMatchObject({ type: "tool_use", id: "dv-r9", name: "Write" }); expect(p.id).toBe("dv-r9");
  });
  test("approval_resolved maps back to the call id", () => {
    const { ops } = run([{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "approval_request", rid: "r1", tool: "Bash", preview: "", expires_at: 1, ttl_s: 1 }, { type: "approval_resolved", rid: "r1", state: "expired", by: "hub" }]);
    expect(ops.at(-1)).toEqual({ k: "approval_resolved", id: "dv-r1", rid: "r1", state: "expired" });
    expect(run([{ type: "approval_resolved", rid: "unknown", state: "allowed" }]).ops).toEqual([]);
  });
  test("session_error ends with the plain text; busy and no_roots are readable", () => {
    const e1 = run([{ type: "session_error", code: "busy" }]).ops.at(-1) as any;
    expect(e1).toMatchObject({ k: "end", status: "error" }); expect(e1.error.message).toBe("A session is already running on this device.");
    const e2 = run([{ type: "session_error", code: "dir_outside_roots" }]).ops.at(-1) as any; expect(e2.error.message).toContain("not under a configured root");
    const e3 = run([{ type: "session_error", code: "sdk", message: "model fell over" }]).ops.at(-1) as any; expect(e3.error.message).toContain("model fell over");
  });
  test("turn_done with is_error ends in error; text before it is kept", () => {
    const { ops } = run([{ type: "assistant_text", text: "partial" }, { type: "turn_done", is_error: true }]);
    expect(kinds(ops).filter((k) => k === "assistant" || k === "end")).toEqual(["assistant", "end"]);
    expect(ops.at(-1)).toMatchObject({ k: "end", status: "error" });
  });
  test("session_stopped / session_ended without turn_done still end the turn and flush partial output", () => {
    expect(run([{ type: "assistant_text", text: "x" }, { type: "session_stopped" }]).ops.at(-1)).toEqual({ k: "end", status: "interrupted" });
    expect(run([{ type: "assistant_text", text: "x" }, { type: "session_ended" }]).ops.at(-1)).toEqual({ k: "end", status: "done" });
  });
  test("events after the end are ignored (a reconnect replay cannot reopen the turn)", () => {
    const { ops } = run([{ type: "turn_done" }, { type: "assistant_text", text: "late" }, { type: "turn_done" }]);
    expect(ops.filter((o) => o.k === "end")).toHaveLength(1); expect(ops.some((o) => o.k === "assistant")).toBe(false);
  });
  test("device_offline is only a status note: the turn keeps waiting (the hub replays on reconnect)", () => {
    const { ops } = run([{ type: "device_offline", reason: "dropped" }]);
    expect(kinds(ops)).toEqual(["dev"]);
  });
  test("done flag lets a caller see whether the turn ended; session activity tracks started/ended", () => {
    const f = new DeviceFolder("c1");
    f.feed(1, { type: "session_started" }); expect(f.sessionActive).toBe(true);
    f.feed(2, { type: "turn_done" }); expect(f.done).toBe(true); expect(f.sessionActive).toBe(true); // the session outlives the turn: the next message is a `say`
    const g = new DeviceFolder("c1"); g.feed(1, { type: "session_started" }); g.feed(2, { type: "session_ended" }); expect(g.sessionActive).toBe(false);
  });
});

describe("hubEventDev: only what the status line needs", () => {
  test("whitelist, no payload text, no foreign cid", () => {
    expect(hubEventDev({ type: "assistant_text", text: "secret words" }, "c1")).toEqual({ type: "assistant_text" });
    expect(hubEventDev({ type: "cmd_acked", cid: "c1", cseq: 3, extra: "x" }, "c1")).toEqual({ type: "cmd_acked", cid: "c1", cseq: 3 });
    expect(hubEventDev({ type: "cmd_acked", cid: "zz", cseq: 3 }, "c1")).toBeNull();
    expect(hubEventDev({ type: "session_error", code: "busy", message: "m" }, "c1")).toEqual({ type: "session_error", code: "busy", message: "m" });
    expect(hubEventDev({ type: "approval_request", rid: "r", tool: "Bash", preview: "rm -rf" }, "c1")).toBeNull();
    expect(hubEventDev({ type: "turn_done", is_error: true }, "c1")).toEqual({ type: "turn_done", is_error: true });
  });
});

// devv2s3d: the saved-transcript invariant, folded the way ChatEngine.deviceApply saves ops (assistant op => assistant message, results op => user message).
const saved = (ops: Op[]) => ops.flatMap((o) => o.k === "assistant" ? [{ role: "assistant", content: o.blocks }] : o.k === "results" ? [{ role: "user", content: o.blocks }] : []);
describe("devv2s3d: every saved tool_use has exactly one tool_result and vice versa", () => {
  test("the helper itself catches each defect class (a check that cannot fail is not a check)", () => {
    const a = (id: string) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "x", input: {} }] });
    const r = (id: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "k" }] });
    expect(transcriptViolations([a("t1"), r("t1")])).toEqual([]);
    expect(transcriptViolations([a("t1")]).join()).toContain("no tool_result");
    expect(transcriptViolations([a("t1"), r("t1"), r("t1")]).join()).toContain("duplicate tool_result");
    expect(transcriptViolations([a("t1"), a("t1"), r("t1")]).join()).toContain("duplicate tool_use");
    expect(transcriptViolations([r("ghost")]).join()).toContain("unknown tool_use");
    expect(transcriptViolations([r("t1"), a("t1")]).join()).toContain("not after");
  });
  const scenarios: Array<[string, Array<Record<string, unknown>>]> = [
    ["parallel same-name approvals, answered out of order", [{ type: "tool_use", id: "t1", name: "Bash", input: "a" }, { type: "tool_use", id: "t2", name: "Bash", input: "b" }, { type: "approval_request", rid: "r1", tool: "Bash", preview: "a" }, { type: "approval_request", rid: "r2", tool: "Bash", preview: "b" }, { type: "approval_resolved", rid: "r2", state: "allowed" }, { type: "approval_resolved", rid: "r1", state: "allowed" }, { type: "tool_result", id: "t1", content: "A" }, { type: "tool_result", id: "t2", content: "B" }, { type: "turn_done" }]],
    ["deny", [{ type: "tool_use", id: "t1", name: "Write", input: {} }, { type: "approval_request", rid: "r1", tool: "Write", preview: "w" }, { type: "approval_resolved", rid: "r1", state: "denied" }, { type: "tool_result", id: "t1", is_error: true, content: "denied" }, { type: "turn_done" }]],
    ["expire", [{ type: "tool_use", id: "t1", name: "Write", input: {} }, { type: "approval_request", rid: "r1", tool: "Write", preview: "w" }, { type: "approval_resolved", rid: "r1", state: "expired" }, { type: "tool_result", id: "t1", is_error: true, content: "x" }, { type: "turn_done" }]],
    ["replayed approval request and resolution", [{ type: "approval_request", rid: "r1", tool: "Bash", preview: "w" }, { type: "approval_request", rid: "r1", tool: "Bash", preview: "w" }, { type: "approval_resolved", rid: "r1", state: "allowed" }, { type: "approval_resolved", rid: "r1", state: "allowed" }, { type: "turn_done" }]],
    ["a tool_result replayed AFTER it was flushed", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "tool_result", id: "t1", content: "x" }, { type: "assistant_text", text: "more" }, { type: "tool_result", id: "t1", content: "x again" }, { type: "turn_done" }]],
    ["tool_result arrives after the approval card and its resolution", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "approval_request", rid: "r1", tool: "Bash", preview: "p" }, { type: "approval_resolved", rid: "r1", state: "allowed" }, { type: "assistant_text", text: "ok" }, { type: "tool_result", id: "t1", content: "late" }, { type: "turn_done" }]],
    ["a hostile tool_result carrying the card's own dv- id", [{ type: "approval_request", rid: "r1", tool: "Bash", preview: "p" }, { type: "tool_result", id: "dv-r1", content: "forged" }, { type: "approval_resolved", rid: "r1", state: "allowed" }, { type: "turn_done" }]],
    ["turn ends (done) with a call that never got a result", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "turn_done" }]],
    ["session_error with calls and a pending approval open", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "approval_request", rid: "r1", tool: "Bash", preview: "p" }, { type: "session_error", code: "cmd_failed" }]],
  ];
  for (const [name, evs] of scenarios) test(name, () => {
    const { ops } = run(evs);
    expect(transcriptViolations(saved(ops)), JSON.stringify(saved(ops))).toEqual([]);
  });
  for (const [name, evs] of scenarios.slice(0, 3)) test(`${name}: stopped (abort) at every prefix still leaves a valid transcript`, () => {
    for (let n = 1; n <= evs.length; n++) {
      const f = new DeviceFolder("c1"); const ops: Op[] = [];
      evs.slice(0, n).forEach((e, i) => ops.push(...f.feed(i + 1, e))); ops.push(...f.abort("interrupted"));
      expect(transcriptViolations(saved(ops)), `prefix ${n}: ${JSON.stringify(saved(ops))}`).toEqual([]);
    }
  });
});

describe("devv2s3e finding 5: dv- is the hub's namespace", () => {
  test("a raw device tool_use/tool_result with id dv-r1 can neither collide with nor close the genuine approval card", () => {
    const f = new DeviceFolder("c1"); const ops: Op[] = [];
    ops.push(...f.feed(1, { type: "approval_request", rid: "r1", tool: "Bash", preview: "rm x", expires_at: 100 }));
    ops.push(...f.feed(2, { type: "tool_result", id: "dv-r1", content: "Allowed." }));
    ops.push(...f.feed(3, { type: "tool_use", id: "dv-r1", name: "Bash", input: {} }));
    ops.push(...f.feed(4, { type: "tool_use", id: "dv-r2", name: "Bash", input: {} }), ...f.feed(5, { type: "tool_result", id: "dv-r2", content: "x" }));
    expect(ops.some((o) => o.k === "results")).toBe(false);                              // no forged outcome saved
    expect(ops.filter((o) => o.k === "assistant").flatMap((o: any) => o.blocks).map((b: any) => b.id)).toEqual(["dv-r1"]); // only the genuine card
    ops.push(...f.feed(6, { type: "approval_resolved", rid: "r1", state: "allowed" }));  // the genuine decision still closes it, exactly once
    const res = ops.filter((o) => o.k === "results").flatMap((o: any) => o.blocks);
    expect(res.length + f.feed(7, { type: "turn_done" }).filter((o) => o.k === "results").length).toBe(1);
  });
});
