import { describe, expect, test } from "bun:test";
import { wrapIndex } from "../web/src/dialog-focus";

describe("wrapIndex (modal Tab trap)", () => {
  test("Tab wraps last -> first, Shift+Tab wraps first -> last", () => {
    expect(wrapIndex(2, 3, 1)).toBe(0);
    expect(wrapIndex(0, 3, -1)).toBe(2);
  });
  test("moves one step inside the list", () => {
    expect(wrapIndex(0, 3, 1)).toBe(1);
    expect(wrapIndex(2, 3, -1)).toBe(1);
  });
  test("focus outside the dialog (-1) enters at the right end", () => {
    expect(wrapIndex(-1, 3, 1)).toBe(0);
    expect(wrapIndex(-1, 3, -1)).toBe(2);
  });
  test("no focusables -> -1 (never a bogus index)", () => {
    expect(wrapIndex(-1, 0, 1)).toBe(-1);
    expect(wrapIndex(0, 0, -1)).toBe(-1);
  });
  test("single focusable stays put", () => {
    expect(wrapIndex(0, 1, 1)).toBe(0);
    expect(wrapIndex(0, 1, -1)).toBe(0);
  });
});
