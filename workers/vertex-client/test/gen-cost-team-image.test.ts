import { describe, expect, test } from "bun:test";
import { estimate, needsConfirm } from "../src/gen-cost";

describe("team gateway default image model is priced", () => {
  test("gemini-2.5-flash-image has a list price and does not need a confirm for one image", () => {
    const e = estimate("image", "gemini-2.5-flash-image", { n: 1 });
    expect(e.certainty).toBe("list-price");
    expect(e.usd).toBeCloseTo(0.039, 3);
    expect(needsConfirm(e)).toBe(false);
  });
  test("an unlisted model is still unknown and still blocked", () => {
    expect(needsConfirm(estimate("image", "gemini-9-made-up", { n: 1 }))).toBe(true);
  });
});
