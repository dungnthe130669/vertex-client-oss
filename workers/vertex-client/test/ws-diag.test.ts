import { describe, expect, test } from "bun:test";
import { wsDiagRecord, wsDiagLine } from "../src/ws-diag";

const base = { ev: "ws_close" as const, conv: "c1", colo: null, lastTurnEnd: null, turnActive: false, now: 10_000, sockets: 1 };
describe("ws diagnostics record", () => {
  test("close: code, wasClean, reason truncated to 120", () => {
    const r = wsDiagRecord({ ...base, code: 1006, reason: "x".repeat(300), wasClean: false });
    expect(r.code).toBe(1006); expect(r.wasClean).toBe(false); expect(r.reason!.length).toBe(120);
  });
  test("time since last turn end; null when none", () => {
    expect(wsDiagRecord({ ...base, lastTurnEnd: 7_500 }).sinceTurnEndMs).toBe(2_500);
    expect(wsDiagRecord(base).sinceTurnEndMs).toBeNull();
    expect(wsDiagRecord({ ...base, lastTurnEnd: 20_000 }).sinceTurnEndMs).toBe(0);
  });
  test("turnActive and colo carried; error has no code", () => {
    const r = wsDiagRecord({ ...base, ev: "ws_error", turnActive: true, colo: "SIN", reason: "boom" });
    expect(r.turnActive).toBe(true); expect(r.colo).toBe("SIN"); expect("code" in r).toBe(false);
  });
  test("line is JSON", () => { expect(JSON.parse(wsDiagLine({ ...base, code: 1000 })).code).toBe(1000); });
});
