import { describe, expect, test } from "bun:test";
import { AUTO_IDS, cuesOf, routeAuto, tierOfModel, worstCaseUsd, type AutoCandidate, type AutoInput } from "../src/auto-route";
import { MODELS_META } from "../src/models-meta";
import { costOf } from "../src/pricing";

const cand = (id: string): AutoCandidate => ({ id, meta: MODELS_META[id] ?? null });
const TRIO = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"].map(cand);
// maxUsd 5 here so a row tests the TABLE; the default (no ceiling) and an explicit ceiling are tested on their own below.
const base = (o: Partial<AutoInput> = {}): AutoInput => ({ text: "hi", estPromptTokens: 2000, candidates: TRIO, historyTurns: 0, maxUsd: 5, ...o });
const TRACE = "Fix this:\n" + Array.from({ length: 30 }, (_, n) => `    at handler (/app/src/index.ts:${n + 10}:5)`).join("\n");
const VN = "Tôi cần thiết kế kiến trúc cho hệ thống đặt hàng, so sánh 3 phương án: monolith, microservices và serverless. " + "Ràng buộc: chi phí thấp, đội 3 người, cần mở rộng. ".repeat(10);

// One row per decision-table row (first match wins) plus the filters/stickiness around it.
const ROWS: Array<[string, Partial<AutoInput>, { model: string; rule: number; effort?: string }]> = [
  ["1 previous turn failed on sonnet -> opus", { text: "try again", lastModel: "claude-sonnet-5-5", historyTurns: 4, prevFailed: true }, { model: "claude-opus-5-5", rule: 1, effort: "high" }],
  ["1 previous turn failed on haiku -> sonnet", { text: "try again", lastModel: "claude-haiku-5-5", historyTurns: 2, prevFailed: true }, { model: "claude-sonnet-5-5", rule: 1 }],
  ["2 prompt over 150k -> opus", { estPromptTokens: 160_000 }, { model: "claude-opus-5-5", rule: 2, effort: "high" }],
  ["2 explicit cue 'ultrathink'", { text: "ultrathink: is this plan sound?" }, { model: "claude-opus-5-5", rule: 2 }],
  ["2 explicit cue 'think hard'", { text: "please think hard about this" }, { model: "claude-opus-5-5", rule: 2 }],
  ["2 explicit Vietnamese cue", { text: "hãy suy nghĩ kỹ về câu này" }, { model: "claude-opus-5-5", rule: 2 }],
  ["3 design/tradeoff, 600+ chars, Vietnamese", { text: VN }, { model: "claude-opus-5-5", rule: 3, effort: "high" }],
  ["3 proof cue, long, English", { text: "Prove that the algorithm terminates. " + "Consider the following invariants carefully. ".repeat(12) }, { model: "claude-opus-5-5", rule: 3 }],
  ["4 stack trace -> sonnet, high effort", { text: TRACE }, { model: "claude-sonnet-5-5", rule: 4, effort: "high" }],
  ["4 code fence", { text: "what does this do?\n```ts\nconst x = 1\n```" }, { model: "claude-sonnet-5-5", rule: 4, effort: "medium" }],
  ["4 file path", { text: "look at src/index.ts" }, { model: "claude-sonnet-5-5", rule: 4 }],
  ["4 artifact request", { text: "write a script that renames files" }, { model: "claude-sonnet-5-5", rule: 4 }],
  ["4 multi-step tools", { text: "ok", toolsNeeded: true, multiStepTools: true }, { model: "claude-sonnet-5-5", rule: 4 }],
  ["5 image attached", { text: "what is this", hasImage: true }, { model: "claude-sonnet-5-5", rule: 5 }],
  ["5 pdf attached", { text: "summarise", hasPdf: true }, { model: "claude-sonnet-5-5", rule: 5 }],
  ["6 reasoning cue, 200-4000 chars", { text: "Why does the cache miss happen after a model switch? " + "Details follow here. ".repeat(12) }, { model: "claude-sonnet-5-5", rule: 6, effort: "medium" }],
  ["7 'hi' -> haiku low", { text: "hi" }, { model: "claude-haiku-5-5", rule: 7, effort: "low" }],
  ["7 short Vietnamese", { text: "cảm ơn bạn" }, { model: "claude-haiku-5-5", rule: 7 }],
  ["7 single read-only tool lookup is not blocked from haiku? no: tools needed leaves rule 7", { text: "what time is it", toolsNeeded: true }, { model: "claude-sonnet-5-5", rule: 8 }],
  ["8 default: medium length, no cues", { text: "Tell me about the history of the bicycle and how it changed cities in the early twentieth century, briefly, in a friendly tone for a general audience, with a couple of concrete examples from different countries and a short closing thought about the future." }, { model: "claude-sonnet-5-5", rule: 8 }],
  ["8 short but long thread (history >= 10)", { text: "ok", historyTurns: 10 }, { model: "claude-sonnet-5-5", rule: 8 }],
  ["8 short but prompt >= 90k (haiku cliff)", { text: "hello", estPromptTokens: 95_000 }, { model: "claude-sonnet-5-5", rule: 8 }],
];

describe("routeAuto decision table", () => {
  for (const [name, o, want] of ROWS) test(name, () => {
    const r = routeAuto(base(o));
    expect({ model: r.model, rule: r.rule }).toEqual({ model: want.model, rule: want.rule });
    if (want.effort) expect(r.effort as string).toBe(want.effort);
    expect(r.reason).toContain(`rule ${want.rule}`);
  });
  test("every decision-table row 1..8 is covered above", () => {
    const covered = new Set(ROWS.map(([, , w]) => w.rule));
    expect([...covered].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test("a pasted block over 1k chars is not a reasoning cue", () => {
    const pasted = "prove design compare architecture ".repeat(60); // one 2k paragraph
    expect(cuesOf(pasted)).toMatchObject({ strong: false, weak: false });
    expect(routeAuto(base({ text: "summarise:\n\n" + pasted })).rule).not.toBe(3);
  });
  test("cues inside a code fence are ignored for prose cues", () => {
    expect(cuesOf("```\nprove it\n```").strong).toBe(false);
  });
  test("deterministic: same input, same output", () => {
    const i = base({ text: TRACE });
    expect(routeAuto(i)).toEqual(routeAuto(JSON.parse(JSON.stringify({ ...i, candidates: i.candidates })) && { ...i }));
  });
});

describe("routeAuto filters", () => {
  test("est prompt 95k, short message: never haiku-5-5 (price cliff)", () => expect(routeAuto(base({ estPromptTokens: 95_000 })).model).toBe("claude-sonnet-5-5"));
  test("est prompt 190k: window filter removes everything (80% of 200k); refuse, never an out-of-window model", () => {
    const r = routeAuto(base({ estPromptTokens: 190_000 }));
    expect(r.model).toBeNull();
    expect(r.refused).toBeTruthy();
  });
  test("default = no ceiling: est prompt 155k with rule 2 reaches opus (no refusal)", () => {
    const r = routeAuto({ ...base({ estPromptTokens: 155_000 }), maxUsd: undefined });
    expect(r).toMatchObject({ rule: 2, model: "claude-opus-5-5", capped: false });
  });
  test("default = no ceiling: opus is reachable on an explicit cue", () => {
    const r = routeAuto({ ...base({ text: "ultrathink about this" }), maxUsd: undefined });
    expect(r).toMatchObject({ model: "claude-opus-5-5", rule: 2, capped: false });
    expect(r.reason).not.toContain("ceiling");
  });
  test("default = no ceiling: sonnet stays sonnet at 20k, 60k and 150k prompt tokens (no drop to haiku, no refusal)", () => {
    for (const est of [20_000, 60_000, 150_000]) expect(routeAuto({ ...base({ text: TRACE, estPromptTokens: est }), maxUsd: undefined }).model).toBe("claude-sonnet-5-5");
    for (const est of [60_000, 150_000]) expect(routeAuto({ ...base({ text: "explain how this works", estPromptTokens: est }), maxUsd: undefined }).model).toBe("claude-sonnet-5-5"); // default row 8
  });
  test("the haiku cliff and context fit are unchanged without a ceiling: 95k short message -> sonnet; 190k -> refused for context only", () => {
    expect(routeAuto({ ...base({ estPromptTokens: 95_000 }), maxUsd: undefined }).model).toBe("claude-sonnet-5-5");
    expect(routeAuto({ ...base({ estPromptTokens: 190_000 }), maxUsd: undefined }).refused).toBe("no eligible model for this turn");
  });
  test("explicit ceiling, desired tier over it but a cheaper one fits -> that one, flagged capped (as before)", () => {
    expect(routeAuto(base({ estPromptTokens: 155_000, maxUsd: 0.9 }))).toMatchObject({ rule: 2, model: "claude-sonnet-5-5", capped: true });
  });
  test("explicit ceiling, EVERYTHING over it -> cheapest eligible model labelled 'over your ceiling', never a refusal", () => {
    const r = routeAuto(base({ maxUsd: 0.0001 }));
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.refused).toBeUndefined();
    expect(r.capped).toBe(true);
    expect(r.reason).toContain("over your ceiling");
    const big = routeAuto(base({ text: TRACE, estPromptTokens: 60_000, maxUsd: 0.01 }));   // haiku is out above 90k only; at 60k it is the cheapest
    expect(big.model).toBe("claude-haiku-5-5");
    const huge = routeAuto(base({ text: "hi", estPromptTokens: 120_000, maxUsd: 0.01 }));  // haiku-5-5 excluded by the cliff -> cheapest left is sonnet
    expect(huge).toMatchObject({ model: "claude-sonnet-5-5" }); expect(huge.reason).toContain("over your ceiling");
  });
  test("a ceiling never refuses for cost even when context-fit leaves one model: still refuses only when none can take the turn", () => {
    expect(routeAuto(base({ estPromptTokens: 190_000, maxUsd: 0.0001 })).refused).toBe("no eligible model for this turn");
  });
  test("max tier sonnet + rule 2 -> sonnet, capped", () => {
    const r = routeAuto(base({ text: "ultrathink about this", maxTier: "sonnet" }));
    expect(r).toMatchObject({ model: "claude-sonnet-5-5", capped: true, rule: 2 });
  });
  test("max tier haiku never returns above haiku", () => expect(routeAuto(base({ text: TRACE, maxTier: "haiku" })).model).toBe("claude-haiku-5-5"));
  test("team scope with only claude ids: never gemini / embedding / image", () => {
    const list: AutoCandidate[] = [cand("claude-sonnet-5-5"), { id: "gemini-3-pro", meta: null }, { id: "gemini-3.1-flash-image", meta: null, kind: "image" }, { id: "text-embedding-005", meta: null, kind: "embedding" }];
    for (const text of ["hi", TRACE, "ultrathink", VN]) expect(routeAuto(base({ text, candidates: list })).model).toBe("claude-sonnet-5-5");
  });
  test("a gemini-only scope has nothing to route to", () => expect(routeAuto(base({ candidates: [{ id: "gemini-3-pro", meta: null }] })).model).toBeNull());
  test("an unknown/unpriced model in scope is never picked", () => {
    const unpriced: AutoCandidate = { id: "claude-sonnet-5-5", meta: { ...MODELS_META["claude-sonnet-5-5"], price: null } };
    expect(routeAuto(base({ candidates: [unpriced, cand("claude-haiku-5-5")], text: TRACE })).model).toBe("claude-haiku-5-5");
    expect(routeAuto(base({ candidates: [{ id: "claude-future-9", meta: MODELS_META["claude-sonnet-5-5"] }] })).model).toBeNull();
  });
  test("a model without vision is never picked for an attachment", () => {
    const novis: AutoCandidate = { id: "claude-haiku-5-5", meta: { ...MODELS_META["claude-haiku-5-5"], caps: { ...MODELS_META["claude-haiku-5-5"].caps, images: false } } };
    expect(routeAuto(base({ hasImage: true, candidates: [novis, cand("claude-sonnet-5-5")] })).model).toBe("claude-sonnet-5-5");
    expect(routeAuto(base({ hasImage: true, candidates: [novis] })).model).toBeNull();
  });
  test("a tier missing from scope falls to the nearest cheaper, then dearer", () => {
    expect(routeAuto(base({ text: TRACE, candidates: [cand("claude-haiku-5-5")] })).model).toBe("claude-haiku-5-5");
    expect(routeAuto(base({ text: "hi", candidates: [cand("claude-sonnet-5-5")] })).model).toBe("claude-sonnet-5-5");
  });
  test("property: the result is always inside scope ∩ capability ∩ context fit; over a set ceiling only with the 'over your ceiling' label", () => {
    const texts = ["hi", TRACE, VN, "ultrathink", "why? " + "x".repeat(300), "write a script"];
    const scopes = [TRIO, TRIO.slice(0, 2), TRIO.slice(1), [cand("claude-haiku-4-5")], []];
    for (const t of texts) for (const sc of scopes) for (const est of [100, 50_000, 95_000, 155_000, 190_000]) for (const hasImage of [false, true]) for (const maxUsd of [0.01, 0.25, 5]) {
      const r = routeAuto(base({ text: t, candidates: sc, estPromptTokens: est, hasImage, maxUsd }));
      if (r.model === null) continue;
      const c = sc.find((x) => x.id === r.model)!;
      expect(c).toBeTruthy();
      expect(c.meta!.caps.images || !hasImage).toBe(true);
      expect(worstCaseUsd(c.meta!, est)! <= maxUsd || r.reason.includes("over your ceiling")).toBe(true);
      expect(est).toBeLessThanOrEqual(c.meta!.contextWindow! * 0.8);
    }
  });
});

describe("routeAuto stickiness", () => {
  test("thread on sonnet, 'ok thanks' stays sonnet (never auto-downgrade)", () => {
    const r = routeAuto(base({ text: "ok thanks", lastModel: "claude-sonnet-5-5", historyTurns: 4 }));
    expect(r).toMatchObject({ model: "claude-sonnet-5-5", rule: 7, sticky: true });
    expect(r.reason).toContain("sticky(claude-sonnet-5-5)");
  });
  test("thread on opus stays opus", () => expect(routeAuto(base({ text: "thanks", lastModel: "claude-opus-5-5", historyTurns: 6, maxUsd: 5 })).model).toBe("claude-opus-5-5"));
  test("thread on haiku, message needs tools -> sonnet", () => expect(routeAuto(base({ text: "what time is it", toolsNeeded: true, lastModel: "claude-haiku-5-5", historyTurns: 2 })).model).toBe("claude-sonnet-5-5"));
  test("thread on haiku, a code cue does NOT escalate (only failure/deep/tools do)", () =>
    expect(routeAuto(base({ text: "look at src/a.ts", lastModel: "claude-haiku-5-5", historyTurns: 2 })).model).toBe("claude-haiku-5-5"));
  test("deep cue escalates a sonnet thread to opus, but only once per 3 turns", () => {
    const i = base({ text: "ultrathink", lastModel: "claude-sonnet-5-5", historyTurns: 4, maxUsd: 5 });
    expect(routeAuto(i).model).toBe("claude-opus-5-5");
    expect(routeAuto({ ...i, turnsSinceEscalation: 1 }).model).toBe("claude-sonnet-5-5");
    expect(routeAuto({ ...i, turnsSinceEscalation: 3 }).model).toBe("claude-opus-5-5");
  });
  test("failure escalates even right after an escalation", () => expect(routeAuto(base({ text: "again", lastModel: "claude-sonnet-5-5", historyTurns: 4, prevFailed: true, turnsSinceEscalation: 0, maxUsd: 5 })).model).toBe("claude-opus-5-5"));
  test("failure on opus has nowhere to go: falls through the table, stays opus", () => expect(routeAuto(base({ text: "again", lastModel: "claude-opus-5-5", historyTurns: 4, prevFailed: true, maxUsd: 5 })).model).toBe("claude-opus-5-5"));
  test("current model no longer fits (attachment, no vision): stickiness is dropped", () => {
    const novis: AutoCandidate = { id: "claude-haiku-5-5", meta: { ...MODELS_META["claude-haiku-5-5"], caps: { ...MODELS_META["claude-haiku-5-5"].caps, images: false } } };
    expect(routeAuto(base({ hasImage: true, lastModel: "claude-haiku-5-5", historyTurns: 2, candidates: [novis, cand("claude-sonnet-5-5")] })).model).toBe("claude-sonnet-5-5");
  });
});

describe("price table (A1)", () => {
  test("tier mapping", () => { expect(AUTO_IDS.haiku.map(tierOfModel)).toEqual([0, 0]); expect(tierOfModel("gemini-3-pro")).toBe(-1); expect(tierOfModel(null)).toBe(-1); });
  test("sonnet-5-5 cache read is 0.1", () => expect(MODELS_META["claude-sonnet-5-5"].price!.cacheRead).toBe(0.1));
  test("context/max tokens are marked unverified on every claude entry", () => {
    for (const [id, m] of Object.entries(MODELS_META)) if (m.vendor === "anthropic" && !id.includes(":")) expect(m.limitsVerified).toBe(false);
  });
  test("haiku 5.5: 0.1/0.5 up to 100k prompt tokens", () => expect(costOf({ input_tokens: 100_000, output_tokens: 1_000_000 }, MODELS_META["claude-haiku-5-5"].price)).toBeCloseTo(0.1 * 0.1 + 0.5, 9));
  test("haiku 5.5: 0.5/2.5 above 100k prompt tokens (output too)", () => expect(costOf({ input_tokens: 100_001, output_tokens: 1_000_000 }, MODELS_META["claude-haiku-5-5"].price)).toBeCloseTo(100_001 * 0.5 / 1e6 + 2.5, 9));
  test("the tier counts cache read + write toward the prompt", () => {
    const c = costOf({ input_tokens: 1000, cache_read_input_tokens: 99_500, output_tokens: 0 }, MODELS_META["claude-haiku-5-5"].price)!;
    expect(c).toBeCloseTo((1000 * 0.5 + 99_500 * 0.05) / 1e6, 9);
  });
  test("other models have no tier", () => expect(costOf({ input_tokens: 500_000 }, MODELS_META["claude-sonnet-5-5"].price)).toBeCloseTo(1, 9));
  test("1h cache writes bill at the 1h rate, the rest at 5m", () => {
    const p = MODELS_META["claude-sonnet-5-5"].price;
    const u = { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 400_000, ephemeral_5m_input_tokens: 600_000 } };
    expect(costOf(u, p)).toBeCloseTo(0.6 * 2.5 + 0.4 * 4, 9);
  });
  test("no 1h split reported -> all at the 5m rate (unchanged behaviour)", () => expect(costOf({ cache_creation_input_tokens: 1_000_000 }, MODELS_META["claude-sonnet-5-5"].price)).toBeCloseTo(2.5, 9));
  test("a 1h figure larger than total writes is clamped", () => expect(costOf({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 5000 } }, MODELS_META["claude-sonnet-5-5"].price)).toBeCloseTo(100 * 4 / 1e6, 12));
  test("no price -> null", () => expect(costOf({ input_tokens: 5 }, null)).toBeNull());
});
