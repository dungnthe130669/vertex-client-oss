import { describe, expect, test } from "bun:test";
import { splitRemoteRows } from "../web/src/remote-logic";

const rows = (live: number, stale: number) => [...Array.from({ length: stale }, (_, i) => ({ id: `s${i}`, stale: true })), ...Array.from({ length: live }, (_, i) => ({ id: `l${i}`, stale: false }))];
describe("remote list: live first, older collapsed", () => {
  test("live sessions come first even when the hub lists stale ones before them; stale history is cut at 20", () => {
    const { shown, hidden } = splitRemoteRows(rows(3, 97), false);
    expect(shown).toHaveLength(20); expect(hidden).toBe(80);
    expect(shown.slice(0, 3).map((r) => r.id)).toEqual(["l0", "l1", "l2"]); expect(shown.slice(3).every((r) => r.stale)).toBe(true);
  });
  test("expanding shows everything, nothing hidden", () => {
    const { shown, hidden } = splitRemoteRows(rows(3, 97), true);
    expect(shown).toHaveLength(100); expect(hidden).toBe(0);
  });
  test("a short list is shown whole; more than 20 live ones are never hidden", () => {
    expect(splitRemoteRows(rows(2, 5), false)).toMatchObject({ hidden: 0 });
    const { shown, hidden } = splitRemoteRows(rows(25, 10), false);
    expect(shown).toHaveLength(25); expect(hidden).toBe(10); expect(shown.every((r) => !r.stale)).toBe(true);
  });
});
