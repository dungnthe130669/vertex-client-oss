// Provider adapter boundary: core code depends only on this interface. Our fleet gateway is one adapter
// (providers/gateway.ts); another provider (direct Anthropic API, OpenAI-compatible endpoint, ...) is another file.
export type ModelKind = "chat" | "image" | "video";

/** What a model can do. The engine and the UI hide/disable anything a model lacks (no tools -> no tool defs sent; no vision -> image
 *  attachments refused with a plain message). Absent key = false. */
export interface Capabilities { text: boolean; vision: boolean; tools: boolean; "image-gen": boolean; "video-gen": boolean; reasoning: boolean }
export const NO_CAPABILITIES: Capabilities = { text: false, vision: false, tools: false, "image-gen": false, "video-gen": false, reasoning: false };
export const CAPABILITY_KEYS = Object.keys(NO_CAPABILITIES) as Array<keyof Capabilities>;
/** $ per million tokens. A model's `pricePerMTok` of null/absent = unpriced: usage shows tokens only. */
export interface PricePerMTok { input: number; output: number; cacheRead?: number; cacheWrite?: number }

/** Media price as the gateway catalog states it. Every field optional: a missing field means "the gateway did not say", never zero. */
export interface GatewayPrice {
  unitEstimateUsd?: number; verified?: boolean;
  /** Admin-set explicit "this model is free": the only way a zero rate/estimate counts as known. Absent/false => zero means unknown. */
  free?: boolean;
  /** Per-second billing (e.g. Veo-style). */
  perSecond?: number;
  /** Token billing for video: $/M output video tokens, tokens per second by resolution, and the text/thought rate for the per-request overhead. */
  outVideoPerMTok?: number; outTextPerMTok?: number; videoTokensPerSecond?: Record<string, number>;
}

export interface ProviderModel {
  id: string; displayName: string;
  /** Provider-declared capabilities (config-driven providers); the gateway's come from models-meta. */
  capabilities?: Capabilities;
  /** The gateway catalog's own `capabilities.images_in` when it states one (boolean). Absent = older gateway / team catalog without the field. */
  imagesIn?: boolean;
  pricePerMTok?: PricePerMTok | null;
  contextWindow?: number | null; maxTokens?: number;
  /** Hard per-model output cap (a request above it can 400). Absent = unknown: only the conservative default applies. */
  maxOutput?: number;
  /** Present for media models (`/v1/models?kind=image|video`); absent = chat. */
  kind?: ModelKind;
  /** Price the GATEWAY catalog published for this model. `null` = a catalog row that states no price (UNKNOWN, confirm required). Absent (undefined) = no catalog row at all
   *  (main-edition legacy listing): only then may gen-cost.ts's tables apply. */
  price?: GatewayPrice | null;
  params?: { allowed?: string[]; defaults?: Record<string, unknown>; values?: Record<string, unknown> };
}

/** One image in or out of the gateway: base64 payload + its mime. */
export interface ImagePayload { mime_type: string; data: string }
export interface ImageRequest {
  model: string; prompt: string;
  /** Optional reference images (0-4, each <= 7 MB decoded, png/jpeg/webp). */
  images?: ImagePayload[];
  aspect_ratio?: string; image_size?: string;
}
export interface ImageResult {
  id?: string; model: string;
  images: ImagePayload[];
  text: string | null;
  finish_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; image_tokens?: number; text_tokens?: number; thought_tokens?: number };
  /** `usd` null/absent = the gateway could not price it (billing uncertain). */
  cost?: { usd?: number | null; basis?: string; estimate_usd?: number; price_verified?: boolean };
  warnings?: string[];
}

/** POST /v1/videos (Omni, sync). One clip per call; the gateway rejects unknown keys. */
export interface VideoRequest { model: string; prompt: string; duration_seconds?: number; resolution?: string; aspect_ratio?: string }
export interface VideoResult {
  id?: string; model: string;
  /** null = the call succeeded but carried no usable clip. */
  video: { mime_type: string; data: string; duration_seconds?: number; resolution?: string; has_audio?: boolean } | null;
  finish_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; video_tokens?: number; text_tokens?: number; thought_tokens?: number };
  cost?: { usd?: number | null; basis?: string; estimate_usd?: number; price_verified?: boolean };
}

export interface ModelProvider {
  readonly name: string;
  /** Registry id (`gateway`, `openai-compat` instances use their config id). Absent = name. */
  readonly id?: string;
  /** No kind (or "chat") = the chat registry; "image" = media models. */
  listModels(kind?: ModelKind): Promise<ProviderModel[]>;
  /** POST an Anthropic Messages request body; returns the raw Response (SSE when body.stream is true). */
  messages(body: unknown, signal?: AbortSignal): Promise<Response>;
  /** Image generation (optional: providers without it simply do not offer Image mode). Throws ProviderError. */
  image?(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
  /** Video generation (optional, same contract as image()). Throws ProviderError. */
  video?(req: VideoRequest, signal?: AbortSignal): Promise<VideoResult>;
}

/** Gateway error envelope fields worth keeping (spec §4). */
export interface ProviderErrorInfo {
  /** `error.type`: generation_blocked, empty_result, rate_limit_error, invalid_request_error, upstream_timeout, ... */
  type?: string; retryable?: boolean; finishReason?: string; requestId?: string;
  /** Cost the gateway says was incurred even though the call failed. */
  costUsd?: number | null; retryAfterS?: number;
  /** Tokens the gateway reports for a call that returned no image (the provider may still bill them). */
  usage?: { input_tokens: number; output_tokens: number };
}
export class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly info: ProviderErrorInfo = {}) { super(message); }
}
/** The adapter's own fetch() was rejected (network / DNS / TLS / connection reset): the ONLY exception type Open failover treats as a connection failure. A bare TypeError from our own code is a bug and is never a trigger. */
export class ProviderNetworkError extends ProviderError {
  constructor(message = "Could not reach the provider.") { super(message, 502, { type: "api_error", retryable: true }); }
}
