import { describe, expect, test } from "bun:test";
import { applyServer, emptyChat } from "../web/src/chat-state";
import { parseDelegateResult } from "../src/subagent-parse";

const ev = (seq: number, e: any) => ({ t: "ev" as const, seq, ts: seq, e });
describe("subagent stream events in the chat state", () => {
  test("running -> done keeps persona/model/task, takes the latest token counts, replay is idempotent", () => {
    let s = emptyChat();
    s = applyServer(s, ev(1, { type: "subagent", id: "t1", persona: "researcher", model: "claude-haiku-5-5", status: "running", task: "find X", rounds: 0, input_tokens: 0, output_tokens: 0 }));
    s = applyServer(s, ev(2, { type: "subagent", id: "t1", persona: "researcher", model: "claude-haiku-5-5", status: "running", rounds: 1, input_tokens: 120, output_tokens: 30 }));
    s = applyServer(s, ev(3, { type: "subagent", id: "t1", persona: "researcher", model: "claude-haiku-5-5", status: "done", rounds: 1, input_tokens: 120, output_tokens: 30, summary: "ok" }));
    expect(s.subagents.t1).toEqual({ persona: "researcher", model: "claude-haiku-5-5", status: "done", task: "find X", rounds: 1, input_tokens: 120, output_tokens: 30, summary: "ok" });
    expect(applyServer(s, ev(3, { type: "subagent", id: "", persona: "x", model: "m", status: "running" })).subagents).toEqual(s.subagents);   // no id: ignored
  });
  test("parseDelegateResult: only a well-formed delegate result", () => {
    const ok = JSON.stringify({ subagent: { persona: "p", model: "m", status: "ok", rounds: 1, input_tokens: 1, output_tokens: 2 }, summary: "s" });
    expect(parseDelegateResult("delegate", ok)?.summary).toBe("s");
    expect(parseDelegateResult("other", ok)).toBeNull(); expect(parseDelegateResult("delegate", "plain error text")).toBeNull(); expect(parseDelegateResult("delegate", "{}")).toBeNull();
  });
  test("parallel calls keep their OWN state per tool_use id: queued -> running -> done, independent token counts", () => {
    let s = emptyChat();
    s = applyServer(s, ev(1, { type: "subagent", id: "a", persona: "researcher", model: "m", status: "queued", task: "A", rounds: 0, input_tokens: 0, output_tokens: 0 }));
    s = applyServer(s, ev(2, { type: "subagent", id: "b", persona: "reviewer", model: "m", status: "queued", task: "B", rounds: 0, input_tokens: 0, output_tokens: 0 }));
    expect([s.subagents.a.status, s.subagents.b.status]).toEqual(["queued", "queued"]);
    s = applyServer(s, ev(3, { type: "subagent", id: "a", persona: "researcher", model: "m", status: "running", rounds: 1, input_tokens: 50, output_tokens: 5 }));
    s = applyServer(s, ev(4, { type: "subagent", id: "a", persona: "researcher", model: "m", status: "done", rounds: 1, input_tokens: 50, output_tokens: 5, summary: "x" }));
    expect(s.subagents.a).toMatchObject({ status: "done", task: "A", input_tokens: 50 }); expect(s.subagents.b).toMatchObject({ status: "queued", task: "B", input_tokens: 0 });
  });
});
