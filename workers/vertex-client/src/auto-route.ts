// Auto model router (phase 1): a PURE, deterministic function. No network, no clock, no classifier call. Design: docs/vertex-client-auto-model.md.
// It never returns an id outside scope ∩ capability ∩ cost cap; "unknown is not consent" (an unpriced or unlisted model is never picked).
// Effort: `routeAuto` returns the intended effort; the engine sends it only through `sendableEffort` (adaptive thinking + output_config.effort, models that accept it).
import { MODELS_META, type ModelMeta } from "./models-meta";
import { costOf } from "./pricing";

export type AutoTier = "haiku" | "sonnet" | "opus";
export type AutoEffort = "low" | "medium" | "high";
const TIERS: AutoTier[] = ["haiku", "sonnet", "opus"];
/** Only these ids can ever be picked. Order = preference inside a tier (newest first). Gemini, media and partner models are absent on purpose. */
export const AUTO_IDS: Record<AutoTier, string[]> = { haiku: ["claude-haiku-5-5", "claude-haiku-4-5"], sonnet: ["claude-sonnet-5-5", "claude-sonnet-5"], opus: ["claude-opus-5-5"] };
export const tierOfModel = (id: string | null | undefined): number => (id ? TIERS.findIndex((t) => AUTO_IDS[t].includes(id)) : -1);

/** No dollar ceiling by default (the app has no $ caps): cost-awareness lives in the tier table. `maxUsd` is an OPTIONAL per-message worst-case ceiling (setting `auto_max_usd:<scope>`). */
export const AUTO_MAX_USD_DEFAULT = Infinity;
export const HAIKU_CLIFF_TOKENS = 90_000;   // est prompt above this never picks haiku-5-5 (price steps 5x at 100k)
export const OPUS_PROMPT_TOKENS = 150_000;  // rule 2
export const FIT_RATIO = 0.8;               // est prompt must fit in 80% of the window
export const SHORT_CHARS = 200;
export const LONG_CHARS = 4000;
export const DESIGN_CHARS = 400;
export const PASTE_CHARS = 1000;            // a paragraph this long is pasted material: cues inside it are ignored
export const SHORT_HISTORY_TURNS = 10;
export const ESCALATE_EVERY_TURNS = 3;

export interface AutoCandidate { id: string; meta: ModelMeta | null; /** Gateway kind: absent/"chat" = chat. Anything else is excluded. */ kind?: string }
export interface AutoInput {
  /** Latest user text only. */
  text: string;
  hasImage?: boolean; hasPdf?: boolean;
  /** Tools are available this turn and the message is expected to use them. */
  toolsNeeded?: boolean;
  /** ...and 2+ steps are expected (rule 4). A single read-only lookup stays eligible for haiku. */
  multiStepTools?: boolean;
  estPromptTokens: number;
  /** Messages already in the thread (0 = first message). */
  historyTurns?: number;
  /** The thread's current/last model; null on the first message. */
  lastModel?: string | null;
  /** Previous turn failed: max_tokens, error row, tool error, user regenerate. */
  prevFailed?: boolean;
  /** Turns since Auto last escalated this thread (undefined = never). */
  turnsSinceEscalation?: number;
  /** The models the scope can use (already scope-filtered by the caller; kind/capabilities are re-checked here). */
  candidates: AutoCandidate[];
  maxTier?: AutoTier;
  maxUsd?: number;
}
export interface AutoRoute {
  /** null = refused (nothing eligible under the cost cap). */
  model: string | null;
  effort: AutoEffort;
  /** Decision table row (1-8) that matched before stickiness/filters. */
  rule: number;
  /** Plain-text why, e.g. "rule 4: code cue; sticky(claude-sonnet-5-5)". */
  reason: string;
  sticky: boolean;
  capped: boolean;
  refused?: string;
}

// ---- cues (latest user text only, outside code fences, pasted blocks ignored) ----
const FENCE = /```[\s\S]*?(?:```|$)/g;
const DEEP = /think (?:very )?hard(?:er)?|think deep(?:ly)?|deep think|ultra-?think|suy nghĩ (?:thật )?kỹ|nghĩ kỹ|suy nghĩ sâu/i;
const STRONG = /\b(?:prove|proof|derive|architecture|design|trade-?offs?|compare)\b|chứng minh|thiết kế|kiến trúc|so sánh/i;
const WEAK = /\b(?:why|plan|analy[sz]e|explain|reasoning)\b|tại sao|phân tích|lý do|giải thích|kế hoạch/i;
const CODE = new RegExp([
  "```", "\\b(?:function|def)\\s+\\w+\\s*\\(", "\\bclass\\s+\\w+\\s*[({:]", "\\bSELECT\\b[\\s\\S]{0,60}\\bFROM\\b", "\\b(?:const|let|var)\\s+\\w+\\s*=",
  "\\bimport\\s+[\\w{*][^\\n]*\\bfrom\\b", "\\binterface\\s+\\w+\\s*\\{", "^\\s*(?:diff --git|@@ .* @@|[-+]{3} [ab]/)",
  "(?:^|[\\s\"'`(])(?:\\.{0,2}/)?(?:[\\w.-]+/)+[\\w.-]+\\.(?:tsx?|jsx?|py|go|rs|sql|json|md|css|html|sh|ya?ml)\\b",
].join("|"), "im");
const TRACE = /Traceback \(most recent|\n\s+at [^\n]*:\d+|\bstack ?trace\b|\bexception\b|\bdebug\b|\bsegfault\b|\bpanic\b/i;
const ARTIFACT = /\b(?:write|create|make|build|generate|draw)\b[^.\n]{0,40}\b(?:script|document|page|svg|app|component|website|file|report|essay|diagram)\b|\bviết\b[^.\n]{0,30}\b(?:script|tài liệu|trang|file|báo cáo|bài)\b/i;

export interface Cues { chars: number; deep: boolean; strong: boolean; weak: boolean; code: boolean; trace: boolean; artifact: boolean }
export function cuesOf(text: string): Cues {
  const prose = text.replace(FENCE, " ").split(/\n{2,}/).filter((p) => p.length <= PASTE_CHARS).join("\n\n");
  const trace = TRACE.test(text);
  return { chars: prose.trim().length, deep: DEEP.test(prose), strong: STRONG.test(prose), weak: WEAK.test(prose), code: CODE.test(text) || trace, trace, artifact: ARTIFACT.test(prose) };
}

interface Want { tier: number; effort: AutoEffort; rule: number; why: string }
/** The decision table, first match wins. Tiers: 0 haiku, 1 sonnet, 2 opus. */
export function tableRule(i: AutoInput, c: Cues): Want {
  const lastTier = tierOfModel(i.lastModel);
  if (i.prevFailed && lastTier >= 0 && lastTier < 2) return { tier: lastTier + 1, effort: "high", rule: 1, why: "previous turn failed, one tier up" };
  if (i.estPromptTokens > OPUS_PROMPT_TOKENS) return { tier: 2, effort: "high", rule: 2, why: "prompt over 150k tokens" };
  if (c.deep) return { tier: 2, effort: "high", rule: 2, why: "explicit deep-thinking cue" };
  if (c.strong && c.chars > DESIGN_CHARS) return { tier: 2, effort: "high", rule: 3, why: "design/proof/tradeoff cue, long message" };
  if (c.code || c.artifact || (i.toolsNeeded && i.multiStepTools)) return { tier: 1, effort: c.trace ? "high" : "medium", rule: 4, why: c.code ? "code cue" : c.artifact ? "artifact request" : "multi-step tools" };
  if (i.hasImage || i.hasPdf) return { tier: 1, effort: "medium", rule: 5, why: "attachment" };
  if ((c.strong || c.weak) && c.chars >= SHORT_CHARS && c.chars <= LONG_CHARS) return { tier: 1, effort: "medium", rule: 6, why: "reasoning cue" };
  if (c.chars < SHORT_CHARS && !c.strong && !c.weak && !i.toolsNeeded && i.estPromptTokens < HAIKU_CLIFF_TOKENS && (i.historyTurns ?? 0) < SHORT_HISTORY_TURNS)
    return { tier: 0, effort: "low", rule: 7, why: "short, no cues" };
  return { tier: 1, effort: "medium", rule: 8, why: "default" };
}

/** Worst case for one message: the whole estimated prompt as 1h cache writes (the dearest input rate; high tier if it applies) + max_tokens at the output rate. null = unpriced. */
export function worstCaseUsd(meta: ModelMeta, estPromptTokens: number): number | null {
  const n = Math.max(0, Math.round(estPromptTokens));
  return costOf({ cache_creation_input_tokens: n, cache_creation: { ephemeral_1h_input_tokens: n }, output_tokens: meta.maxTokens }, meta.price);
}

/** Hard filters (scope ∩ capability ∩ fit): a model failing any of these can never be picked, whatever the tier. Value = worst-case $ for this turn. */
export function hardFilter(i: AutoInput): Map<string, { id: string; cost: number }> {
  const needsVision = !!(i.hasImage || i.hasPdf), needsTools = !!i.toolsNeeded;
  const hard = new Map<string, { id: string; cost: number }>();
  for (const cand of i.candidates) {
    const m = cand.meta;
    if (tierOfModel(cand.id) < 0 || (cand.kind && cand.kind !== "chat") || !m || m.vendor !== "anthropic" || !m.price) continue;
    if (needsVision && !m.caps.images) continue;
    if (needsTools && !m.caps.tools) continue;
    if (m.contextWindow && i.estPromptTokens > m.contextWindow * FIT_RATIO) continue;
    if (cand.id === "claude-haiku-5-5" && i.estPromptTokens > HAIKU_CLIFF_TOKENS) continue;
    const cost = worstCaseUsd(m, i.estPromptTokens);
    if (cost === null) continue;
    hard.set(cand.id, { id: cand.id, cost });
  }
  return hard;
}

/** Escalation after a retryable upstream failure: the cheapest eligible model of the next tier above `from` that is within the max tier and the worst-case cap, or null.
 *  Same hard filters as routeAuto (never outside scope/capability/fit), and never a downgrade. */
export function escalateFrom(i: AutoInput, from: string): string | null {
  const t = tierOfModel(from);
  if (t < 0) return null;
  const maxTier = Math.max(0, TIERS.indexOf(i.maxTier ?? "opus")), maxUsd = i.maxUsd ?? AUTO_MAX_USD_DEFAULT;
  const hard = hardFilter(i);
  for (let up = t + 1; up <= maxTier && up < TIERS.length; up++) {
    const pick = AUTO_IDS[TIERS[up]].map((id) => hard.get(id)).find((m) => m && m.cost <= maxUsd);
    if (pick) return pick.id;
  }
  return null;
}

/** The effort to actually SEND for `model`: only models probe-verified to accept it (sonnet-5-5, opus-5-5); haiku and anything else get none. */
export function sendableEffort(model: string, effort: AutoEffort | null | undefined): AutoEffort | null {
  const m = MODELS_META[model];
  return effort && m?.acceptsEffort && m.adaptiveThinking ? effort : null;
}

export function routeAuto(i: AutoInput): AutoRoute {
  const c = cuesOf(i.text);
  const want = tableRule(i, c);
  const maxTier = Math.max(0, TIERS.indexOf(i.maxTier ?? "opus"));
  const maxUsd = i.maxUsd ?? AUTO_MAX_USD_DEFAULT;
  const lastTier = tierOfModel(i.lastModel);
  const needsTools = !!i.toolsNeeded;
  const parts = [`rule ${want.rule}: ${want.why}`];

  const hard = hardFilter(i);
  const inTier = (t: number, capOk: boolean) => AUTO_IDS[TIERS[t]].map((id) => hard.get(id)).find((m) => m && (!capOk || m.cost <= maxUsd));

  // Stickiness: never auto-downgrade mid-thread (the cache prefix is per model). Escalate only on failure, deep/design cues (max one per
  // 3 turns), tools needed on haiku, or when the current model cannot take the turn (it is then absent from `hard`, so no stickiness).
  let tier = want.tier, sticky = false;
  if (lastTier >= 0 && (i.historyTurns ?? 0) > 0 && i.lastModel && hard.has(i.lastModel)) {
    const mayEscalate = want.rule === 1 || (want.rule <= 3 && (i.turnsSinceEscalation === undefined || i.turnsSinceEscalation >= ESCALATE_EVERY_TURNS));
    if (want.tier <= lastTier) { tier = lastTier; sticky = want.tier < lastTier; }
    else if (mayEscalate) tier = want.tier;
    else if (lastTier === 0 && needsTools) { tier = 1; parts.push("tools needed on haiku"); }
    else { tier = lastTier; sticky = true; }
    if (sticky) parts.push(`sticky(${i.lastModel})`);
  }

  let capped = false;
  if (tier > maxTier) { tier = maxTier; capped = true; parts.push("capped by max tier"); }

  // Pick: desired tier, then cheaper tiers, then dearer ones (up to the max tier). Each must be eligible and under the optional worst-case ceiling.
  const order = [tier, ...[...Array(tier).keys()].reverse(), ...Array.from({ length: maxTier - tier }, (_, k) => tier + 1 + k)];
  let pick: ReturnType<typeof inTier>;
  for (const t of order) {
    pick = inTier(t, true);
    if (!pick) continue;
    if (t !== tier) { parts.push(`${TIERS[tier]} unavailable, using ${TIERS[t]}`); if (inTier(tier, false)) { capped = true; parts.push("capped by cost"); } }
    break;
  }
  if (!pick && hard.size) {
    // An explicit ceiling with everything over it never refuses the message: take the cheapest eligible model (within the max tier if any) and say so.
    const all = [...hard.values()].sort((a, b) => a.cost - b.cost);
    pick = all.find((m) => tierOfModel(m.id) <= maxTier) ?? all[0];
    capped = true; parts.push("over your ceiling");
  }
  if (!pick) {
    const why = "no eligible model for this turn";
    return { model: null, effort: want.effort, rule: want.rule, reason: `${parts.join("; ")}; refused: ${why}`, sticky, capped, refused: why };
  }
  return { model: pick.id, effort: want.effort, rule: want.rule, reason: parts.join("; "), sticky, capped };
}
