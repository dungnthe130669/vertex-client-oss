// Generation cost estimator: pure, shared by the Worker (server-side confirm enforcement) and the web composer (live estimate).
// Principle (spec §5): inform and confirm, never cap. An estimate above the threshold needs one explicit confirm; an UNKNOWN
// model (no rate) forces the confirm regardless of size — unknown is not consent.
import type { GatewayPrice } from "./providers/types";
export type GenKind = "image" | "video";
export interface GenEstimate { usd: number; basis: string; certainty: "list-price" | "unknown"; price_verified: boolean }

/** Default confirm line (Erich: $1.00). A settings-row override (`gen_confirm_usd`) is read by the Worker; this is NOT a cap. */
export const GEN_CONFIRM_USD_DEFAULT = 1.0;
export const MAX_IMAGES_PER_REQUEST = 4;

// PRICE SOURCE: `price` is what the gateway CATALOG publishes for the model (GatewayPrice, from /v1/models). `undefined` = the model has NO catalog row (main-edition legacy
// listing): only then may the tables below apply. A catalog row with no price (`null`) or an unusable one (zero/negative/non-finite, no `free:true`) is UNKNOWN: confirm
// forced, the tables are never a silent fallback for it. No price anywhere => UNKNOWN, never a made-up number.
// Per-image list-price rates, keyed by the gateway id WITHOUT its "gemini-" prefix. All price_verified:false: they come from
// the media spec / list prices, not from billing (gateway returns the real cost after the call, which the UI then shows).
export const IMAGE_RATES: Record<string, { perImage: number; price_verified: boolean }> = {
  "3.1-flash-image": { perImage: 0.045, price_verified: false },
  "nano-banana-2.1": { perImage: 0.045, price_verified: false },
  "3-pro-image": { perImage: 0.136, price_verified: false },
  "3.1-flash-lite-image": { perImage: 0.034, price_verified: false },
  "2.5-flash-image": { perImage: 0.039, price_verified: false }, // team gateway default image model (list price ~1290 output tokens x $30/M)
};

/** Deterministic fake models served ONLY to the e2e user's scope (see providers/stub-image.ts). `e2e-stub-pro-image` is priced
 *  so that 3 images cross the $1 confirm line while 1 image does not. */
export const E2E_STUB_RATES: Record<string, { perImage: number; price_verified: boolean }> = {
  "e2e-stub-image": { perImage: 0.045, price_verified: false },
  "e2e-stub-pro-image": { perImage: 0.4, price_verified: false },
};

// Per-second video rates, keyed like IMAGE_RATES (no "gemini-" prefix). Omni (gemini-omni-1.1-flash-preview) is priced by output video
// tokens: gateway MEDIA_RATES = $17.5/M video tokens x {360p 1931, 720p 5792, 1080p 8688, 4k 17376} tokens/s = $0.034/0.101/0.152/0.304 per s,
// plus thought/prompt tokens. Smoke evidence (gateway media smoke report, 2026-10): 3 s / 360p cost $0.106 = $0.035/s incl. overhead.
// Kept CONSERVATIVE on purpose (+10% per second, +$0.015 per request for ~1500 thought tokens at $9/M): an estimate that is a little high
// asks for a confirm a little early; one that is low lets a >$1 clip through unconfirmed. price_verified:false (list/token price, not billing).
export const VIDEO_RATES: Record<string, { perSecond: Record<string, number>; perRequest: number; price_verified: boolean }> = {
  "omni-1.1-flash-preview": { perSecond: { "360p": 0.037, "720p": 0.112, "1080p": 0.168, "4k": 0.335 }, perRequest: 0.015, price_verified: false },
};
/** E2E-only video stubs (providers/stub-video.ts): `e2e-stub-pro-video` crosses the $1 confirm line at 8 s+, not at 3-5 s. */
export const E2E_STUB_VIDEO_RATES: Record<string, { perSecond: Record<string, number>; perRequest: number; price_verified: boolean }> = {
  "e2e-stub-video": { perSecond: { "360p": 0.035, "720p": 0.1 }, perRequest: 0, price_verified: false },
  "e2e-stub-pro-video": { perSecond: { "360p": 0.15, "720p": 0.3 }, perRequest: 0, price_verified: false },
};
/** Omni accepts 3..10 s; the UI offers 3/5/8/10 (or the gateway's own list). */
export const VIDEO_SECONDS_MIN = 3, VIDEO_SECONDS_MAX = 10;
export const VIDEO_DEFAULT_RESOLUTION = "360p";
export const validSeconds = (s: unknown): s is number => typeof s === "number" && Number.isInteger(s) && s >= VIDEO_SECONDS_MIN && s <= VIDEO_SECONDS_MAX;
const videoRateOf = (model: string) => VIDEO_RATES[model.replace(/^gemini-/, "")] ?? E2E_STUB_VIDEO_RATES[model];

export const normalizeCount = (n: unknown): number => {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_IMAGES_PER_REQUEST, Math.max(1, v)) : 1;
};
const rateOf = (model: string) => IMAGE_RATES[model.replace(/^gemini-/, "")] ?? E2E_STUB_RATES[model];
const fmt = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

/** `price` = what the gateway catalog published for this model (preferred over the fallback tables). */
const MAX_EST_USD = 1e6;
const usable = (v: unknown, free: boolean): v is number => typeof v === "number" && Number.isFinite(v) && (v > 0 || (v === 0 && free)) && v <= MAX_EST_USD;
export function estimate(kind: GenKind, model: string, params: { n?: unknown; seconds?: unknown; resolution?: unknown } = {}, price?: GatewayPrice | null): GenEstimate {
  if (kind === "video") return estimateVideo(String(model ?? ""), params.seconds, params.resolution, price);
  const n = normalizeCount(params.n);
  const inCatalog = price !== undefined; // null / object = a catalog row exists: its price (or the lack of one) is the only source
  const gp = price && usable(price.unitEstimateUsd, price.free === true) ? price.unitEstimateUsd : undefined;
  const r = gp !== undefined ? { perImage: gp, price_verified: price!.verified === true } : inCatalog ? undefined : rateOf(String(model ?? ""));
  if (!r) return { usd: 0, basis: `no known price for ${model || "this model"}`, certainty: "unknown", price_verified: false };
  const usd = Math.round(r.perImage * n * 1e6) / 1e6;
  if (!Number.isFinite(usd) || usd > MAX_EST_USD) return { usd: 0, basis: `no known price for ${model || "this model"}`, certainty: "unknown", price_verified: false };
  return { usd, basis: `${fmt(r.perImage)} × ${n} image${n === 1 ? "" : "s"}`, certainty: "list-price", price_verified: r.price_verified };
}

/** Per-second USD and per-request overhead a gateway video price implies, or null when it does not state enough. Token billing is padded like the fallback table
 *  (+10% per second; ~1500 thought tokens at the text rate per request): a slightly high estimate asks for a confirm early, a low one lets a >$1 clip through. */
function gatewayVideoRate(price: GatewayPrice | null | undefined, res: string): { perSecond: number; perRequest: number; verified: boolean } | null {
  if (!price) return null;
  const free = price.free === true;
  if (usable(price.perSecond, free)) return { perSecond: price.perSecond, perRequest: 0, verified: price.verified === true };
  const tps = price.videoTokensPerSecond && Object.prototype.hasOwnProperty.call(price.videoTokensPerSecond, res) ? price.videoTokensPerSecond[res] : undefined;
  if (!usable(price.outVideoPerMTok, free) || !usable(tps, free)) return null;
  const perSecond = (tps * price.outVideoPerMTok * 1.1) / 1e6, perRequest = usable(price.outTextPerMTok, free) ? (1500 * price.outTextPerMTok) / 1e6 : 0;
  return Number.isFinite(perSecond) && Number.isFinite(perRequest) && perSecond <= MAX_EST_USD ? { perSecond, perRequest, verified: price.verified === true } : null;
}

/** One clip: rate(resolution) x seconds + per-request overhead. Unknown model, unknown resolution or a duration outside 3..10 = unknown. */
function estimateVideo(model: string, seconds: unknown, resolution: unknown, price?: GatewayPrice | null): GenEstimate {
  const res = typeof resolution === "string" && resolution ? resolution : VIDEO_DEFAULT_RESOLUTION;
  const g = gatewayVideoRate(price, res);
  const t = price === undefined ? videoRateOf(model) : undefined; // tables only for ids with no catalog row at all
  const tp = t && Object.prototype.hasOwnProperty.call(t.perSecond, res) ? t.perSecond[res] : undefined;
  const r = g ?? (tp !== undefined ? { perSecond: tp, perRequest: t!.perRequest, verified: t!.price_verified } : null);
  if (!r || !validSeconds(seconds))
    return { usd: 0, basis: !r ? (t || price ? `no known price for ${res}` : `no known price for ${model || "this model"}`) : "bad duration", certainty: "unknown", price_verified: false };
  const usd = Math.round((r.perSecond * seconds + r.perRequest) * 1e6) / 1e6;
  if (!Number.isFinite(usd) || usd > MAX_EST_USD) return { usd: 0, basis: `no known price for ${res}`, certainty: "unknown", price_verified: false };
  return { usd, basis: `${fmt(r.perSecond)}/s × ${seconds} s (${res})${r.perRequest ? ` + ${fmt(r.perRequest)}` : ""}`, certainty: "list-price", price_verified: r.verified };
}

/** Unknown = no consent: the confirm step is forced. Otherwise only an estimate STRICTLY above the threshold needs it. */
export const needsConfirm = (e: GenEstimate, thresholdUsd = GEN_CONFIRM_USD_DEFAULT) => e.certainty === "unknown" || e.usd > thresholdUsd;

/** Server-side check of a generate command's confirmation (the client modal alone is never trusted). null = ok. */
export function confirmError(e: GenEstimate, c: { confirmed?: unknown; est_usd?: unknown }, thresholdUsd = GEN_CONFIRM_USD_DEFAULT): string | null {
  if (!needsConfirm(e, thresholdUsd)) return null;
  const why = e.certainty === "unknown" ? "this model has no known price" : `the estimate ${fmt(e.usd)} is above ${fmt(thresholdUsd)}`;
  if (c.confirmed !== true) return `confirmation required: ${why}`;
  const sent = Number(c.est_usd);
  if (!Number.isFinite(sent) || sent < 0 || sent + 1e-9 < e.usd) return `confirmation does not cover the estimate (${fmt(e.usd)})`;
  return null;
}

export const fmtEstimate = (e: GenEstimate, n: number) => e.certainty === "unknown" ? "price unknown" : `≈ ${fmt(e.usd)} · ${n} image${n === 1 ? "" : "s"}`;
export const fmtVideoEstimate = (e: GenEstimate, seconds: number) => e.certainty === "unknown" ? "price unknown" : `≈ ${fmt(e.usd)} · ${seconds} s video`;
