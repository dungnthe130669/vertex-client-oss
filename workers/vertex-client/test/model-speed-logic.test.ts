import { describe, expect, test } from "bun:test";
import { priceHint, speedHint } from "../web/src/model-speed";

describe("picker speed hint", () => {
  test("unknown tier = neutral \"Not measured yet\" (never nothing); hidden only without a speed field or without timings", () => {
    expect(speedHint(null)).toBeNull(); expect(speedHint(undefined)).toBeNull();
    expect(speedHint({ tier: "unknown", samples: 0, firstAnswerMs: null, totalMs: null, tokensPerS: null })).toMatchObject({ tier: "unknown", label: "Not measured yet" });
    expect(speedHint({ tier: "unknown", samples: 2, firstAnswerMs: null, totalMs: null, tokensPerS: null })!.text).toContain("2 measured so far");
    expect(speedHint({ tier: "fast", samples: 9, firstAnswerMs: null, totalMs: null, tokensPerS: null })).toBeNull();
  });
  test("tier label + wording says typical, estimated, measured on recent use", () => {
    expect(speedHint({ tier: "fast", samples: 9, firstAnswerMs: 900, totalMs: 4200, tokensPerS: 50 })).toEqual({ tier: "fast", label: "Fast", text: "typically ~0.9s to first answer, ~4.2s total (measured on recent use)" });
    expect(speedHint({ tier: "slow", samples: 9, firstAnswerMs: 45_000, totalMs: 90_000, tokensPerS: null })!.text).toBe("typically ~45s to first answer, ~90s total (measured on recent use)");
    expect(speedHint({ tier: "medium", samples: 9, firstAnswerMs: null, totalMs: 12_000, tokensPerS: null })!.text).toBe("typically ~12s total (measured on recent use)");
  });
  test("price: only a known estimate is shown, labelled est.; null shows nothing (never free)", () => {
    expect(priceHint(null)).toBeNull(); expect(priceHint(undefined)).toBeNull();
    expect(priceHint({ inputPerMTok: 1.25, outputPerMTok: 5, source: "admin", estimate: true })).toBe("est. $1.25/5 per M tokens");
  });
});
