import { describe, expect, test } from "bun:test";
import { busyCount, clearSendPending, markSendPending, settlesSend, withBusy } from "../web/src/busy";

describe("withBusy", () => {
  test("held for the whole transaction, released after", async () => {
    let during = -1;
    await withBusy("t", async () => { during = busyCount(); });
    expect(during).toBe(1); expect(busyCount()).toBe(0);
  });
  test("released even when the transaction throws", async () => {
    await expect(withBusy("t", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(busyCount()).toBe(0);
  });
  test("concurrent transactions do not release each other", async () => {
    let r1!: () => void; const a = withBusy("a", () => new Promise<void>((r) => { r1 = r; }));
    await withBusy("b", async () => {});
    expect(busyCount()).toBe(1); r1(); await a; expect(busyCount()).toBe(0);
  });
});

describe("pending send", () => {
  test("busy synchronously at send, cleared by acceptance / rejection / state frames", () => {
    for (const f of [{ t: "ev", e: { type: "turn_start" } }, { t: "ev", e: { type: "user_message" } }, { t: "rejected" }, { t: "hello" }]) {
      markSendPending(); expect(busyCount()).toBe(1);
      expect(settlesSend(f)).toBe(true); clearSendPending(); expect(busyCount()).toBe(0);
    }
  });
  test("unrelated frames (pong, deltas, previous turn_end) do not settle", () => {
    for (const f of [{ t: "pong" }, { t: "ev", e: { type: "text_delta" } }, { t: "ev", e: { type: "turn_end" } }]) expect(settlesSend(f)).toBe(false);
  });
  test("safety timeout releases a lost frame", async () => {
    markSendPending(20); expect(busyCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 50)); expect(busyCount()).toBe(0);
  });
});
