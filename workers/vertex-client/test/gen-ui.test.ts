import { describe, expect, test } from "bun:test";
import { initial, reduce, replay, type Event } from "../src/reducer";
import { applyServer, emptyChat, fromServer, genCostLabel, type ChatState, type Frame, type Msg } from "../web/src/chat-state";
import { fileUrl } from "../web/src/api";

const genBlock = { type: "gen_image", ref: "vertex-client/c1/gen/0b9f8c1e-1111-4222-8333-444455556666.png", mime: "image/png", prompt: "a red cube", model: "gemini-3.1-flash-image", cost_usd: 0.0423, est_usd: 0.045 };
const ev = (seq: number, e: any): Frame => ({ t: "ev", seq, ts: seq * 10, e });
const asst = (content: any[]): Msg => ({ id: 2, role: "assistant", content, model: "gemini-3.1-flash-image", usage: null, costUsd: 0.0423, stopReason: "gen_image", status: "complete", ttftMs: null, totalMs: null, createdAt: 0 });

describe("reducer: gen_image block", () => {
  test("a stored message with a gen_image block folds into a complete gen_image render block (refs only)", () => {
    const events: Event[] = [{ type: "non_stream_message", message: { id: "m", model: "x", content: [genBlock, { type: "text", text: "Here you go." }], stop_reason: "end_turn", usage: {} } }];
    const s = replay(events);
    expect(s.phase).toBe("done");
    expect(s.blocks.map((b) => b.kind)).toEqual(["gen_image", "text"]);
    expect(s.blocks[0]).toMatchObject({ kind: "gen_image", ref: genBlock.ref, mime: "image/png", prompt: "a red cube", model: "gemini-3.1-flash-image", costUsd: 0.0423, estUsd: 0.045, complete: true });
    expect(JSON.stringify(s)).not.toContain("base64");
  });
  test("missing cost fields become null (rendered as the estimate, billing uncertain)", () => {
    const s = reduce(reduce(initial(), { type: "message_start", message: {} }), { type: "content_block_start", index: 0, content_block: { type: "gen_image", ref: "r", mime: "image/webp", prompt: "p", model: "m" } });
    expect(s.blocks[0]).toMatchObject({ kind: "gen_image", costUsd: null, estUsd: null });
    const stopped = reduce(s, { type: "content_block_stop", index: 0 });
    expect(stopped.blocks[0]).toEqual(s.blocks[0]); // stop leaves it untouched
  });
  test("an interrupt does not corrupt a gen_image block", () => {
    const s0 = reduce(reduce(initial(), { type: "message_start", message: {} }), { type: "content_block_start", index: 0, content_block: genBlock });
    expect(reduce(s0, { type: "client_interrupt" }).blocks[0]).toMatchObject({ kind: "gen_image" });
  });
});

describe("chat-state: generation turn", () => {
  test("turn_start kind=image sets generating and keeps the chat model; assistant_saved with the block survives; turn_end clears generating", () => {
    let s: ChatState = { ...emptyChat(), model: "claude-sonnet-5-5" };
    s = applyServer(s, ev(1, { type: "turn_start", turn: 1, model: "gemini-3.1-flash-image", kind: "image" }));
    expect(s.running).toBe(true); expect(s.generating).toBe(true); expect(s.model).toBe("claude-sonnet-5-5");
    s = applyServer(s, ev(2, { type: "assistant_saved", message: asst([genBlock]) }));
    expect(s.messages[0].content[0]).toEqual(genBlock);
    s = applyServer(s, ev(3, { type: "turn_end", status: "done", error: null, costUsd: 0.0423, tokens: 0 }));
    expect(s.running).toBe(false); expect(s.generating).toBe(false); expect(s.costUsd).toBe(0.0423);
  });
  test("an ordinary Claude turn_start is not 'generating'", () => {
    expect(applyServer(emptyChat(), ev(1, { type: "turn_start", turn: 1, model: "claude-sonnet-5-5" })).generating).toBe(false);
  });
  test("reload: the image block comes back from the server state (history stores refs only); generating restored while running", () => {
    const st = { seq: 5, running: true, inflight: { fromSeq: 3 }, model: "claude-sonnet-5-5", title: "t", error: null, costUsd: 0.0423, tokens: 0, generating: true, messages: [asst([genBlock])] };
    const s = fromServer(st as any);
    expect(s.messages[0].content[0].ref).toBe(genBlock.ref); expect(s.generating).toBe(true);
    expect(fromServer({ ...st, running: false } as any).generating).toBe(false);
  });
  test("a typed rejection keeps its message", () => {
    expect(applyServer(emptyChat(), { t: "rejected", error: "confirmation required: the estimate $1.20 is above $1.00", code: "confirm_required", est_usd: 1.2 }).rejected).toContain("confirmation required");
  });
  test("media caption never shows a dollar amount", () => {
    for (const b of [genBlock, { ...genBlock, cost_usd: 0.0021 }, { ...genBlock, cost_usd: null }, { type: "gen_image" }]) expect(genCostLabel(b as never)).not.toMatch(/\$/);
  });
  test("fileUrl keeps the gen/ path readable and encodes each segment", () => {
    expect(fileUrl("c1", genBlock.ref.replace("c1", "c1"))).toBe("/api/conversations/c1/files/gen/0b9f8c1e-1111-4222-8333-444455556666.png");
    expect(fileUrl("c1", "vertex-client/c1/uuid-my_pic.png")).toBe("/api/conversations/c1/files/uuid-my_pic.png");
  });
});
