import { describe, expect, test } from "bun:test";
import { applyServer, emptyChat, fromServer, type Frame, type Msg } from "../web/src/chat-state";

const ev = (seq: number, e: any, ts = seq * 10): Frame => ({ t: "ev", seq, ts, e });
const msg = (id: number, role: "user" | "assistant", text: string): Msg => ({ id, role, content: [{ type: "text", text }], model: null, usage: null, costUsd: null, stopReason: null, status: "complete", ttftMs: null, totalMs: null, createdAt: 0 });
const stream = [
  ev(2, { type: "turn_start", turn: 1, model: "m" }),
  ev(3, { type: "message_start", message: { id: "x", usage: { input_tokens: 5 } } }),
  ev(4, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ev(5, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
  ev(6, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
];
const fold = (fs: Frame[], s = emptyChat()) => fs.reduce(applyServer, s);

describe("chat-state", () => {
  test("live text accumulates and finishes into a saved message + cost", () => {
    let s = fold([ev(1, { type: "user_message", message: msg(1, "user", "hi") }), ...stream]);
    expect(s.running).toBe(true);
    expect((s.live!.blocks[0] as any).text).toBe("Hello");
    s = fold([ev(7, { type: "assistant_saved", message: msg(2, "assistant", "Hello") }), ev(8, { type: "turn_end", status: "done", error: null, costUsd: 0.012, tokens: 100 }), ev(9, { type: "title", title: "T" })], s);
    expect(s.running).toBe(false); expect(s.live).toBeNull();
    expect(s.messages.map((m) => m.id)).toEqual([1, 2]);
    expect([s.costUsd, s.tokens, s.title]).toEqual([0.012, 100, "T"]);
  });
  test("replay overlap is idempotent (duplicate seq and duplicate message id)", () => {
    const all = [ev(1, { type: "user_message", message: msg(1, "user", "hi") }), ...stream];
    const once = fold(all); const twice = fold(all, once);
    expect(twice).toEqual(once);
    const again = applyServer({ ...once, lastSeq: 0 }, all[0]);
    expect(again.messages.length).toBe(1);
  });
  test("reconnect mid-stream: state seeded from inflight replays to the same live text", () => {
    const seeded = fromServer({ seq: 6, running: true, inflight: { fromSeq: 2 }, model: "m", title: "", error: null, costUsd: 0, tokens: 0, messages: [msg(1, "user", "hi")] });
    expect(seeded.lastSeq).toBe(1);
    const s = fold([ev(1, { type: "user_message", message: msg(1, "user", "hi") }), ...stream], seeded);
    expect((s.live!.blocks[0] as any).text).toBe("Hello");
    expect(s.messages.length).toBe(1);
  });
  test("error turn surfaces error state, retry-able", () => {
    const s = fold([ev(1, { type: "turn_start", turn: 1 }), ev(2, { type: "http_error", status: 503, body: {} }), ev(3, { type: "turn_end", status: "error", error: { status: 503, message: "boom", retryable: true }, costUsd: 0, tokens: 0 })]);
    expect(s.running).toBe(false); expect(s.error).toMatchObject({ status: 503, retryable: true });
  });
  test("busy rejection is cleared when the turn ends; other rejections stay", () => {
    const run = (r: string) => fold([ev(1, { type: "turn_start", turn: 1 }), { t: "rejected", error: r } as never, ev(2, { type: "turn_end", status: "done", costUsd: 0, tokens: 0 })]);
    expect(run("busy").rejected).toBeNull();
    expect(run("message too long").rejected).toBe("message too long");
  });
  test("hello resync flag and rejected", () => {
    expect(applyServer(emptyChat(), { t: "hello", seq: 9, minSeq: 5, running: false, now: 0, resync: true }).needResync).toBe(true);
    expect(applyServer(emptyChat(), { t: "rejected", error: "busy" }).rejected).toBe("busy");
  });
});


import { fitWithin } from "../web/src/upload";
describe("M3 client state", () => {
  const ev = (seq: number, e: any) => ({ t: "ev" as const, seq, ts: 1, e });
  test("approval lifecycle + compaction divider", () => {
    let s = emptyChat();
    s = applyServer(s, ev(1, { type: "approval_required", calls: [{ id: "a", name: "save_note", input: { t: 1 } }] }));
    expect(s.awaiting!.calls[0]).toMatchObject({ id: "a", decision: null });
    s = applyServer(s, ev(2, { type: "approval_decision", id: "a", decision: "approve" }));
    expect(s.awaiting!.calls[0].decision).toBe("approve");
    s = applyServer(s, ev(3, { type: "tool_results", message: { id: 5, role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] } }));
    expect(s.awaiting).toBeNull();
    expect(s.messages.length).toBe(1);
    s = applyServer(s, ev(4, { type: "compaction", upto: 5 }));
    expect(s.compactions[0].upto).toBe(5);
  });
  test("images are fitted to 1568px long edge", () => {
    expect(fitWithin(4000, 3000)).toEqual({ w: 1568, h: 1176 });
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
  });
});

describe("stopfix1b: a send cancelled by the user's Stop", () => {
  test("rejected code 'stopped' sets NO error banner and is counted so the send-wait can settle", () => {
    const a = fold([{ t: "rejected", error: "Stopped before it started.", code: "stopped" } as Frame]);
    expect(a.rejected).toBeNull(); expect(a.stopped).toBe(1);
    expect(fold([{ t: "rejected", error: "x", code: "stopped" } as Frame], a).stopped).toBe(2);
  });
  test("any other rejection still shows its banner and does not count as stopped", () => {
    const a = fold([{ t: "rejected", error: "message too long" } as Frame]);
    expect(a.rejected).toBe("message too long"); expect(a.stopped ?? 0).toBe(0);
  });
});
