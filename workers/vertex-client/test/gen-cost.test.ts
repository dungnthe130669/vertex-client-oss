import { describe, expect, test } from "bun:test";
import { E2E_STUB_RATES, GEN_CONFIRM_USD_DEFAULT, IMAGE_RATES, confirmError, estimate, fmtEstimate, needsConfirm, normalizeCount } from "../src/gen-cost";

describe("gen-cost estimate", () => {
  test("every listed image model has a per-image list price, unverified", () => {
    for (const [id, per] of [["gemini-3.1-flash-image", 0.045], ["gemini-nano-banana-2.1", 0.045], ["gemini-3-pro-image", 0.136], ["gemini-3.1-flash-lite-image", 0.034]] as const) {
      const e = estimate("image", id, { n: 1 });
      expect(e).toMatchObject({ usd: per, certainty: "list-price", price_verified: false });
      expect(estimate("image", id, { n: 3 }).usd).toBeCloseTo(per * 3, 6);
    }
    expect(Object.values(IMAGE_RATES).every((r) => r.price_verified === false)).toBe(true);
  });
  test("the id works with or without the gemini- prefix", () => expect(estimate("image", "3-pro-image").usd).toBe(0.136));
  test("count is clamped to 1..4 and junk becomes 1", () => {
    expect([0, -3, 99, "2", "x", undefined, 2.9].map(normalizeCount)).toEqual([1, 1, 4, 2, 1, 1, 2]);
    expect(estimate("image", "gemini-3-pro-image", { n: 99 }).usd).toBeCloseTo(0.136 * 4, 6);
  });
  test("basis is human readable", () => {
    expect(estimate("image", "gemini-3.1-flash-image", { n: 2 }).basis).toBe("$0.045 × 2 images");
    expect(fmtEstimate(estimate("image", "gemini-3.1-flash-image", { n: 1 }), 1)).toBe("≈ $0.045 · 1 image");
  });
  test("unknown model (and video, not built yet) => certainty unknown", () => {
    expect(estimate("image", "gemini-9-ultra-image")).toMatchObject({ certainty: "unknown", usd: 0 });
    expect(estimate("video", "gemini-omni-1.1-flash-preview")).toMatchObject({ certainty: "unknown" });
    expect(fmtEstimate(estimate("image", "nope"), 1)).toBe("price unknown");
  });
});

describe("confirm gate", () => {
  const pro3 = estimate("image", "e2e-stub-pro-image", { n: 3 }); // 1.20
  const pro2 = estimate("image", "e2e-stub-pro-image", { n: 2 }); // 0.80
  test("threshold is strictly 'above $1.00'; default constant", () => {
    expect(GEN_CONFIRM_USD_DEFAULT).toBe(1);
    expect(needsConfirm(pro2)).toBe(false);
    expect(needsConfirm(pro3)).toBe(true);
    expect(needsConfirm({ usd: 1, basis: "", certainty: "list-price", price_verified: false })).toBe(false);
    expect(needsConfirm(pro3, 5)).toBe(false); // the settings row can raise the line
  });
  test("unknown model FORCES confirm even at $0", () => {
    const u = estimate("image", "mystery");
    expect(needsConfirm(u)).toBe(true);
    expect(confirmError(u, {})).toContain("no known price");
    expect(confirmError(u, { confirmed: true, est_usd: 0 })).toBeNull();
  });
  test("over threshold: needs confirmed:true AND est_usd >= server estimate", () => {
    expect(confirmError(pro3, {})).toContain("confirmation required");
    expect(confirmError(pro3, { confirmed: "yes", est_usd: 9 })).toContain("confirmation required"); // truthy is not true
    expect(confirmError(pro3, { confirmed: true })).toContain("does not cover");
    expect(confirmError(pro3, { confirmed: true, est_usd: 0.5 })).toContain("does not cover");
    expect(confirmError(pro3, { confirmed: true, est_usd: 1.2 })).toBeNull();
    expect(confirmError(pro3, { confirmed: true, est_usd: 5 })).toBeNull();
    expect(confirmError(pro2, {})).toBeNull();
  });
  test("e2e stub models: 1 image is under the line, 3 are over", () => {
    expect(E2E_STUB_RATES["e2e-stub-pro-image"].perImage).toBe(0.4);
    expect(needsConfirm(estimate("image", "e2e-stub-pro-image", { n: 1 }))).toBe(false);
    expect(needsConfirm(estimate("image", "e2e-stub-image", { n: 4 }))).toBe(false);
  });
});
