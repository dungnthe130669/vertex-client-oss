// SEED data for the provider model catalog (D1 `provider_models`, migration 0029). This file is the ONE place the NVIDIA / Cloudflare model facts live:
// migrations/0029_provider_standard.sql is generated from it (scripts/gen-provider-seed.ts, test-enforced to match) and it is also the in-memory fallback
// when the table is missing or has no rows for a provider (migration not applied yet), exactly like 0026. No imports from config.ts (import-order cycle).
// A capability here means "a live request of that kind succeeded" (see `ref`), never a guess; a price is null = UNKNOWN (never "free").
import type { Capabilities } from "./types";

export type SeedKind = "chat" | "image";
export interface SeedModel {
  provider: string; id: string; kind: SeedKind; name: string;
  /** declared capabilities that are TRUE (everything absent is false). chat rows always carry `text`; image rows `image-gen` */
  caps: Partial<Capabilities>;
  context?: number | null; maxTokens?: number; maxOutput?: number;
  /** estimated list price $/Mtok (+ where it came from). Absent = UNKNOWN, never "free". */
  price?: { input: number; output: number; cacheRead?: number; source: string };
  /** free-tier limits as the provider's dashboard states them (informational, never used to throttle; null/absent = not stated) */
  limits?: { rpm?: number; rpd?: number; tpm?: number; tpd?: number };
  /** pre-ticked on a fresh provider */
  suggested?: boolean;
  /** adapter-specific parameters (NVIDIA genai slug/steps) */
  extra?: Record<string, unknown>;
  /** where the capability facts come from */
  ref: string;
}

/** 4096 cut a reply mid-SVG (finish_reason length, 2026-10-26 probe); room for an answer after a reasoning preamble. */
export const NVIDIA_MAX_TOKENS = 16000;
/** All NVIDIA chat models answered 200 to max_tokens=16000 (live probe 2026-10-26; NIM publishes no cap, 3 of 4 also accepted 100000, nano-omni 503'd on capacity). 16000 = the largest value actually observed accepted. */
export const NVIDIA_MAX_OUTPUT = 16000;
const NV_TOOLS = "live 2026-10-26: request with a trivial tools array answered tool_calls";
const NV_VISION = "live 2026-10-26: 64x64 PNG answered the colour";
const nv = (id: string, name: string, caps: Partial<Capabilities>, o: { suggested?: boolean; ref?: string; extra?: Record<string, unknown> } = {}): SeedModel => ({
  provider: "nvidia", id, kind: "chat", name, caps: { text: true, ...caps }, context: null, maxTokens: NVIDIA_MAX_TOKENS, maxOutput: NVIDIA_MAX_OUTPUT,
  ...(o.extra ? { extra: o.extra } : {}), ...(o.suggested ? { suggested: true } : {}), ref: o.ref ?? ([caps.tools ? NV_TOOLS : "", caps.vision ? NV_VISION : ""].filter(Boolean).join("; ") || "listed free-preview model, text only"),
});
/** Order = display order, fastest/most reliable first (nim-speed.md, measured 2026-10-26; quality is inferred from names, not evaluated). Not tools-verified: nemotron-3-nano-omni (503 free-tier capacity, three times on 2026-10-26). Not vision-verified: ultra, lightning, bolt ("multimodal processing is not enabled").
 *  Migration 0032 sets their `sort` to NVIDIA_CHAT_SORT_BASE + position (after the Groq rows; sort is only compared within a provider). Removed from this list by 0032 (rows stay, enabled=0): see NVIDIA_RETIRED_IDS. */
export const NVIDIA_CHAT_SORT_BASE = 37;
export const NVIDIA_CHAT_SEED: SeedModel[] = [
  nv("nvidia/nemotron-3.5-lightning-30b-a3b", "Nemotron 3.5 Lightning 30B", { tools: true }, { suggested: true }),
  nv("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra 550B", { tools: true }, { suggested: true, extra: { forceViaAuto: true } }), // `required` returns the call as text (nim-textcall-diag.md): forced calls go as auto
  nv("minimaxai/minimax-m3.1-flash", "MiniMax M3.1 Flash", { tools: true, vision: true }),
  nv("nvidia/nemotron-3.5-bolt-e4b", "Nemotron 3.5 Bolt E4B", { tools: true }),
  nv("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "Nemotron 3 Nano Omni 30B", { vision: true }),
  nv("z-ai/glm-5.3-flash", "GLM 5.3 Flash", { tools: true, vision: true }),
];
/** NIM ids measured dead/unusable on the free tier (nim-speed.md 2026-10-26): disabled (never deleted) by migration 0032. Not offered by the seed fallback either. */
export const NVIDIA_RETIRED_IDS = [
  "nvidia/nemotron-3-super-120b-a12b", // 404: no function deployed for this account
  "openai/gpt-oss-120b", // 410: end of life 2026-09-03
  "qwen/qwen3.8-27b", // 404
  "openai/gpt-oss-20b", // read timeouts (90 s)
  "deepseek-ai/deepseek-v4.1-flash", // read timeouts
  "meta/llama-3.2-11b-vision-instruct", // read timeouts
  "meta/muse-glimmer-30b", // 20-78 s
  "poolside/laguna-xs-2.1", // 200 with an empty reply
];

/** Text-to-image NIMs verified live 2026-10-26 (flux.1-schnell timed out at 150 s twice, kontext needs an input image: neither is listed): POST https://ai.api.nvidia.com/v1/genai/black-forest-labs/<slug> (same Bearer key)
 *  {prompt,width,height,seed,steps} -> {artifacts:[{base64 (JPEG),finishReason,seed}]}. Price not reported: none is claimed. Not in /v1/models, so they are listed from here. */
export const NVIDIA_GENAI_BASE = "https://ai.api.nvidia.com/v1/genai/black-forest-labs";
const nvImg = (id: string, name: string, slug: string, steps: number): SeedModel => ({ provider: "nvidia", id, kind: "image", name, caps: { "image-gen": true }, extra: { slug, steps }, ref: "live 2026-10-26: text-to-image returned a JPEG" });
export const NVIDIA_IMAGE_SEED: SeedModel[] = [
  nvImg("black-forest-labs/flux.2-klein-4b", "FLUX.2 klein 4B", "flux.2-klein-4b", 4),
  nvImg("black-forest-labs/flux-3-image-klein", "FLUX.3 image klein", "flux-3-image-klein", 4),
  nvImg("black-forest-labs/flux.1-dev", "FLUX.1 dev", "flux.1-dev", 5), // 422 below 5 steps; width/height must be one of 768..1344 step 64
];

const CF_REF = "developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)";
const cfChat = (id: string, name: string, context: number | null, caps: Partial<Capabilities> = {}): SeedModel => ({ provider: "cloudflare", id, kind: "chat", name, caps: { text: true, ...caps }, context, ref: CF_REF });
const cfImg = (id: string, name: string): SeedModel => ({ provider: "cloudflare", id, kind: "image", name, caps: { "image-gen": true }, context: null, ref: CF_REF });
/** Names/context/capabilities from the Workers AI model pages. `tools` only where the page says function calling is supported (gemma-4, glm-4.7-flash, gpt-oss-120b); `vision` only for vision models. Context null where the docs do not state it. */
export const CLOUDFLARE_CHAT_SEED: SeedModel[] = [
  cfChat("@cf/openai/gpt-oss-120b", "gpt-oss 120B", 128_000, { tools: true, reasoning: true }),
  cfChat("@cf/openai/gpt-oss-20b", "gpt-oss 20B", 128_000, { reasoning: true }),
  cfChat("@cf/google/gemma-4-26b-a4b-it", "Gemma 4 26B", 256_000, { tools: true, vision: true }),
  cfChat("@cf/zai-org/glm-4.7-flash", "GLM 4.7 Flash", 131_072, { tools: true }),
  cfChat("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "Llama 3.3 70B", null),
  cfChat("@cf/meta/llama-4-scout-17b-16e-instruct", "Llama 4 Scout 17B", null, { vision: true }),
  cfChat("@cf/meta/llama-3.1-8b-instruct-fp8", "Llama 3.1 8B", null),
  cfChat("@cf/qwen/qwen3-30b-a3b-fp8", "Qwen3 30B A3B", null, { reasoning: true }),
  cfChat("@cf/mistralai/mistral-small-3.1-24b-instruct", "Mistral Small 3.1 24B", 128_000, { vision: true }),
];
/** Text-to-image models that take `{prompt}` and return one image (the multi-reference flux-2 models need multipart and are left out). */
export const CLOUDFLARE_IMAGE_SEED: SeedModel[] = [
  cfImg("@cf/black-forest-labs/flux-1-schnell", "FLUX.1 schnell"),
  cfImg("@cf/bytedance/stable-diffusion-xl-lightning", "SDXL Lightning"),
  cfImg("@cf/stabilityai/stable-diffusion-xl-base-1.0", "SDXL base 1.0"),
  cfImg("@cf/lykon/dreamshaper-8-lcm", "DreamShaper 8 LCM"),
];

/** Google AI Studio (native Gemini API), migration 0030. Free-tier limits copied from Erich's dashboard (docs/reference/free-tier-limits-2026-10-26.md in the PO repo; per project, can change without notice).
 *  Only chat models with a non-zero free quota are seeded: 0-quota models (2.5 Pro, 3.1 Pro, 4 Argon, 2 Flash...), image/video/music, TTS, live, embeddings and classifiers are NOT offered as chat models.
 *  Prices are NULL = unknown on purpose: the list prices on the pricing page are PAID-tier, and the Open user's key is the free tier, so a $ figure would misstate their spend.
 *  extra: `limited` = very small daily quota (flagged, never the default); `shortContext` = tiny per-minute INPUT token limit, so history is trimmed to fit; `thinking` = ask for thought summaries. */
const AI_REF = "model list 2026-10-26 (GET /v1beta/models)";
const AI_PROBE = "live 2026-10-26: native streamGenerateContent";
const aiCtx = { context: 1_048_576, maxTokens: 16_000, maxOutput: 65_536 };
const ai = (id: string, name: string, caps: Partial<Capabilities>, o: { suggested?: boolean; limits: SeedModel["limits"]; extra?: Record<string, unknown>; ref: string; ctx?: Pick<SeedModel, "context" | "maxTokens" | "maxOutput"> }): SeedModel => ({
  provider: "aistudio", id, kind: "chat", name, caps: { text: true, ...caps }, ...(o.ctx ?? aiCtx), limits: o.limits, extra: o.extra ?? { thinking: true }, ...(o.suggested ? { suggested: true } : {}), ref: o.ref,
});
const FREE = { rpm: 15, rpd: 500, tpm: 250_000 };
const SMALL = { tpm: 250_000 };
const gemmaCtx = { context: 262_144, maxTokens: 8_192, maxOutput: 32_768 };
export const AISTUDIO_CHAT_SEED: SeedModel[] = [
  ai("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", { tools: true, vision: true }, { suggested: true, limits: FREE, ref: `${AI_PROBE}: tools round trip with thoughtSignature echo + 32x32 PNG answered "Red"; no thought parts seen (not a thinking model by default)` }),
  ai("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", { tools: true, vision: true }, { limits: FREE, extra: { thinking: true, note: "shuts down 2027-05-07" }, ref: `${AI_PROBE}: tools round trip + 32x32 PNG answered (probe report 2026-10-26)` }),
  ai("gemma-4-31b-it", "Gemma 4 31B", { tools: true, reasoning: true }, { limits: { rpm: 30, rpd: 14_400, tpm: 16_000 }, extra: { shortContext: true }, ctx: gemmaCtx, ref: `${AI_PROBE}: one tools request answered functionCall (46 s); vision NOT verified (503 on the probe); plain request answered 500 once (free-tier capacity)` }),
  ai("gemma-4-26b-a4b-it", "Gemma 4 26B", { reasoning: true }, { limits: { rpm: 30, rpd: 14_400, tpm: 16_000 }, extra: { shortContext: true }, ctx: gemmaCtx, ref: `${AI_PROBE}: plain request answered with thought parts; tools/vision NOT probed, text only` }),
  ai("gemini-3.6-flash", "Gemini 3.6 Flash", { tools: true, vision: true, reasoning: true }, { limits: { rpm: 5, rpd: 20, ...SMALL }, extra: { thinking: true, limited: true }, ref: `${AI_PROBE}: tools round trip + 32x32 PNG + thought summaries (probe report 2026-10-26)` }),
  ai("gemini-3.8-flash", "Gemini 3.8 Flash", { reasoning: true }, { limits: { rpm: 5, rpd: 20, ...SMALL }, extra: { thinking: true, limited: true }, ref: `${AI_REF}; same limits as 3.6 Flash; tools/vision not probed` }),
  ai("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite", {}, { limits: { rpm: 10, rpd: 20, ...SMALL }, extra: { thinking: true, limited: true }, ref: `${AI_REF}; tools/vision not probed` }),
];

/** Every seed row in display order (provider, then chat before image, then list order). Migration 0029 carries BASE_SEED_MODELS, 0030 the AI Studio rows, 0031 the Groq rows (sort = the index in this list). */
export const BASE_SEED_MODELS: SeedModel[] = [...NVIDIA_CHAT_SEED, ...NVIDIA_IMAGE_SEED, ...CLOUDFLARE_CHAT_SEED, ...CLOUDFLARE_IMAGE_SEED];

/** Groq (Open only, user's own key). Facts: groq-probe.md (live 2026-10-26: /models, streaming, tools, vision, errors) + docs/reference/free-tier-limits-2026-10-26.md (free-tier dashboard, per model per ORG).
 *  Not offered as chat on purpose: whisper (speech-to-text, later), orpheus (TTS), llama-prompt-guard (classifier), gpt-oss-safeguard (classifier, 2K TPM), allam-2-7b (4K context).
 *  8K tokens/minute is the binding free limit, so every row is `shortContext` (history is trimmed to fit, see chat-budget.ts). maxTokens is a request cap that leaves room for a prompt inside 8K
 *  (reasoning tokens count against it); maxOutput stays well under the 8K minute budget. */
export const GROQ_FREE_LIMITS = { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 };
const GROQ_REF = "groq-probe 2026-10-26 (live /models + chat) + free-tier dashboard 2026-10-26";
const GROQ_PRICE_SRC = "seed:2026-10-26:console.groq.com/docs/models (identical in live GET /models pricing); list price, estimate only";
const gq = (id: string, name: string, caps: Partial<Capabilities>, extra: Record<string, unknown>, price: SeedModel["price"], o: { suggested?: boolean; ref?: string } = {}): SeedModel => ({
  provider: "groq", id, kind: "chat", name, caps: { text: true, ...caps }, context: 131_072, maxTokens: 2500, maxOutput: 4000, price, limits: GROQ_FREE_LIMITS,
  extra: { shortContext: true, ...extra }, ...(o.suggested ? { suggested: true } : {}), ref: o.ref ?? GROQ_REF,
});
/** gpt-oss: tools + reasoning (`delta.reasoning`, effort low|medium|high), one tool call per turn (parallel_tools=false), text only. qwen3.8-27b: tools (parallel ok), vision (max 3 images, ~1.3K tokens each), reasoning only on request. Order = display order; gpt-oss-20b is the default. */
export const GROQ_CHAT_SEED: SeedModel[] = [
  gq("openai/gpt-oss-20b", "GPT-OSS 20B (Groq)", { tools: true, reasoning: true }, { parallelTools: false, reasoningEffort: "medium" }, { input: 0.075, output: 0.3, cacheRead: 0.0375, source: GROQ_PRICE_SRC }, { suggested: true }),
  gq("openai/gpt-oss-120b", "GPT-OSS 120B (Groq)", { tools: true, reasoning: true }, { parallelTools: false, reasoningEffort: "medium" }, { input: 0.15, output: 0.6, cacheRead: 0.075, source: GROQ_PRICE_SRC }, { suggested: true }),
  gq("qwen/qwen3.8-27b", "Qwen3.8 27B (Groq)", { tools: true, vision: true }, { parallelTools: true, maxImages: 3, imageTokens: 1300 }, { input: 0.8, output: 4, cacheRead: 0.4, source: GROQ_PRICE_SRC }, { suggested: true, ref: `${GROQ_REF}; vision: live 32x32 PNG answered "Red"; parallel tool calls: live 2 calls in one message` }),
];

export const SEED_MODELS: SeedModel[] = [...BASE_SEED_MODELS, ...AISTUDIO_CHAT_SEED, ...GROQ_CHAT_SEED];
export const SEED_VERSION = "2026-10-26";
