import type { Capabilities, PricePerMTok } from "./providers/types";
// Client-side metadata joined onto the gateway registry (which returns only id + name). Prices are $/Mtok from the
// gateway's MODEL_RATES; models without a known rate show tokens only. Context windows are left null until M0
// verifies them from Vertex docs. Anything not listed here is served with meta: null (UI shows "unrated").
/** $/Mtok. `cacheWrite` is the 5m write rate, `cacheWrite1h` the 1h one (absent = billed at the 5m rate). `highTier` replaces every rate
 *  once the prompt (input + cache read + cache write tokens) exceeds `aboveTokens`. */
export interface PriceRates { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }
export interface ModelPrice extends PriceRates { highTier?: PriceRates & { aboveTokens: number } }
export interface ModelMeta {
  label: string;
  vendor: "anthropic" | "google" | "xai" | "qwen" | "openai-oss" | "other";
  tier: "fast" | "balanced" | "flagship";
  price: ModelPrice | null;
  caps: { images: boolean; caching: boolean; thinking: boolean; tools: boolean };
  contextWindow: number | null;
  /** Claude 4.6+: send thinking:{type:"adaptive"} (the model decides when to think). */
  adaptiveThinking: boolean;
  maxTokens: number;
  /** Accepts `output_config.effort` next to adaptive thinking (probe-verified, docs/reports/effort-probe.md). Absent = never send effort (haiku-5-5 is NOT probed). */
  acceptsEffort?: boolean;
  /** false/absent = contextWindow and maxTokens are hardcoded guesses, not read from Vertex docs (A0 probe pending). Auto's guard treats them as such. */
  limitsVerified?: boolean;
  /** Catalog `extra.forceViaAuto`: this model answers `tool_choice:"required"` with the call as TEXT (NIM nemotron-3-ultra, docs/reports/nim-textcall-diag.md), so a forced first call is sent as `auto` + web tools only + a system nudge. */
  forceViaAuto?: boolean;
}

const claude = (label: string, tier: ModelMeta["tier"], price: ModelMeta["price"], adaptiveThinking = true, maxTokens = 16000): ModelMeta =>
  ({ label, vendor: "anthropic", tier, price, caps: { images: true, caching: true, thinking: true, tools: true }, contextWindow: 200_000, adaptiveThinking, maxTokens, limitsVerified: false });
// 1h cache write = 2x the input rate (Anthropic list); haiku-5-5's >100k tier is gateway model-rates.ts (0.5/2.5), its cache rates scale 5x with it (unverified).


const withEffort = (m: ModelMeta): ModelMeta => ({ ...m, acceptsEffort: true });

export const MODELS_META: Record<string, ModelMeta> = {
  "claude-sonnet-5-5": withEffort(claude("Claude Sonnet 5.5", "balanced", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 })),
  "claude-sonnet-5": claude("Claude Sonnet 5", "balanced", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 }),
  "claude-opus-5-5": withEffort(claude("Claude Opus 5.5", "flagship", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 })),
  "claude-haiku-5-5": claude("Claude Haiku 5.5", "fast", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2,
    highTier: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 } }),
  "claude-haiku-4-5": claude("Claude Haiku 4.5", "fast", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 }, false, 8192),
};

export const DEFAULT_MODEL = "claude-sonnet-5-5";

// v1 is Claude-first: Claude models first (flagship-last within tier order), everything else after.
export function sortModels<T extends { id: string; meta: ModelMeta | null }>(ms: T[]): T[] {
  const rank = (m: T) => (m.meta?.vendor === "anthropic" ? 0 : 1);
  return [...ms].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/** FALLBACK ONLY: the gateway catalog's `capabilities.images_in` decides for bare ids whenever it states it (registry.ts); this list applies only to a catalog that omits the field (older gateway, team edition).
 *  Gateway chat ids that SEE images, proven live 2026-11-03 (docs/reports/imgpaste2.md: a 400x200 PNG "BANANA42" answered correctly). The gateway catalog does not
 *  declare `images_in` for these, so without this override they were gated as text-only. Gemini ids here (3.8-flash, 3.1-pro-preview, 2.5-pro) proven live 2026-11-03 after gateway deploy c6234d47 (docs/reports/gemprobe1.md); an 8.8 MB PNG was silently NOT seen, so keep MAX_IMAGE_BYTES (5 MB) below that. gemprobe2 added 8 more (2.5-flash, 2.5-flash-lite, 3-flash-preview, 3.1-flash-lite, 3.5-flash, 3.5-flash-lite, 3.6-flash, 3.7-flash). The gateway silently drops Gemini images above ~5 MB decoded, hence GEMINI_IMAGE_MAX_BYTES (files.ts). Other gemini ids and grok are NOT here. */
export const GATEWAY_VISION_VERIFIED: ReadonlySet<string> = new Set(["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-haiku-5-5", "claude-haiku-4-5", "gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash"]);
/** Why an image cannot go to this model (shown to the user BEFORE the turn; never forwarded to the model as a note). */
export function noImageMessage(modelId: string): string {
  if (/^(gemini-|grok-)/.test(modelId)) return `${/^gemini-/.test(modelId) ? "Gemini" : "Grok"} via the company gateway cannot read images yet; use a Claude model.`;
  return "This model can't read images. Pick a Claude model (or another model marked for images), then send again.";
}

/** Capabilities of a chat model as the UI/engine see them. Unknown model => text only (matches the old behaviour: no tools, no images). */
export function capabilitiesOfMeta(meta: ModelMeta | null | undefined): Capabilities {
  return { text: true, vision: !!meta?.caps.images, tools: !!meta?.caps.tools, "image-gen": false, "video-gen": false, reasoning: !!meta?.caps.thinking };
}

/** Meta for a model a config-driven provider declared (id already `<provider>:<model>`). Unpriced models keep price null (tokens only). */
/** Request size for a configured model with no declared maxTokens: the pre-2026-10-26 conservative value (no model is known to reject it). */
export const DEFAULT_PROVIDER_MAX_TOKENS = 4096;
/** Gemini 2.5+/3.x think before answering and the hidden thinking tokens count against maxOutputTokens (the gateway forwards max_tokens as maxOutputTokens, no thinking control): at 4096 a ~2.3k-token answer
 *  intermittently ended MAX_TOKENS with no text (geminifix1). 16000 = what the AI Studio Gemini rows declare (they support 65536). Used when the gateway catalog states no maxTokens for a `gemini-*` model. */
export const GEMINI_GATEWAY_MAX_TOKENS = 16000;
export function metaFromProviderModel(label: string, c: Capabilities, price: PricePerMTok | null | undefined, contextWindow?: number | null, maxTokens?: number, extra?: Record<string, unknown> | null): ModelMeta {
  return { label, vendor: "other", tier: "balanced",
    price: price ? { input: price.input, output: price.output, cacheRead: price.cacheRead ?? price.input, cacheWrite: price.cacheWrite ?? price.input } : null,
    caps: { images: c.vision, caching: false, thinking: c.reasoning, tools: c.tools }, contextWindow: contextWindow ?? null, adaptiveThinking: false, maxTokens: maxTokens ?? DEFAULT_PROVIDER_MAX_TOKENS, ...(extra?.forceViaAuto === true ? { forceViaAuto: true } : {}) };
}
/** Make a prefixed provider model known to the engine (turn-engine looks metas up by id). Prefixed ids contain ":" so they can never replace a gateway entry. */
export function registerModelMeta(id: string, meta: ModelMeta): void { if (id.includes(":")) MODELS_META[id] = meta; }
// Catalog-registered metas are per (scope, id): a listing for one scope can only ever replace or drop THAT scope's entries, so one user's catalog (a different
// price/capabilities for the same id) can never overwrite or delete another's. Curated MODELS_META is never touched. Lookups are scope-aware: metaOf(scope, id).
const CURATED = new Set(Object.keys(MODELS_META));
const MAX_CATALOG_SCOPES = 256; // isolate memory bound: least-recently-listed scope is evicted (its models read as unrated until its next listing = fail toward "unknown")
const catalogMetas = new Map<string, Map<string, ModelMeta>>();
const listingSeq = new Map<string, { issued: number; applied: number }>();
/** Call BEFORE fetching a scope's catalog; hand the ticket to applyCatalogListing. A listing that started earlier than one already applied is stale. */
export function beginCatalogListing(scope: string): number {
  const s = listingSeq.get(scope) ?? { issued: 0, applied: 0 };
  s.issued += 1; listingSeq.set(scope, s);
  return s.issued;
}
/** Replace the scope's whole catalog meta set with `entries` (ids without a usable catalog price/caps are simply absent). A stale ticket (an older listing finishing after a newer one) is discarded. */
export function applyCatalogListing(scope: string, ticket: number, entries: Map<string, ModelMeta>): boolean {
  const s = listingSeq.get(scope);
  if (!s || ticket < s.applied) return false;
  s.applied = ticket;
  const next = new Map<string, ModelMeta>();
  for (const [id, m] of entries) if (!id.includes(":") && !CURATED.has(id)) next.set(id, m);
  catalogMetas.delete(scope); catalogMetas.set(scope, next); // re-insert = most recent
  while (catalogMetas.size > MAX_CATALOG_SCOPES) { const old = catalogMetas.keys().next().value as string; catalogMetas.delete(old); listingSeq.delete(old); }
  return true;
}
/** Meta of `id` for `scope`: curated entry first, else this scope's own catalog entry (never another scope's). */
export function metaOf(scope: string | null | undefined, id: string): ModelMeta | undefined {
  return MODELS_META[id] ?? (scope ? catalogMetas.get(scope)?.get(id) : undefined);
}
