import { MAX_GEN_BODY_BYTES, MAX_GEN_IMAGE_BYTES, MAX_GEN_VIDEO_BODY_BYTES, b64DecodedLen, MAX_GEN_IMAGES_PER_RESPONSE, genImageProblem, genVideoProblem } from "../files";
import { ProviderError, type GatewayPrice, type ImageRequest, type ImageResult, type ModelKind, type ModelProvider, type ProviderModel, type VideoRequest, type VideoResult } from "./types";

type ListedPrice = { free?: boolean; unit_estimate_usd?: number; verified?: boolean; per_second?: number; out_video_per_mtok?: number; out_text_per_mtok?: number; video_tokens_per_second?: Record<string, number>; in_per_mtok?: number; out_per_mtok?: number };
type ListedCaps = { tools?: boolean; images_in?: boolean; thinking?: boolean; messages_api?: boolean; max_output?: number };
type Perms = { chat?: boolean; image?: boolean; audio?: boolean; video?: boolean };
type Listed = { id?: string; display_name?: string; kind?: string; permissions?: Perms | null; price?: ListedPrice | null; capabilities?: ListedCaps | null; params?: { allowed?: string[]; defaults?: Record<string, unknown>; values?: Record<string, unknown> } };

/** User-safe message for a gateway `/v1/images` or `/v1/videos` failure (spec §4). Never echoes an upstream body beyond the gateway's own scrubbed `message`. */
export function mediaError(status: number, body: any, retryAfterHeader: string | null | undefined, noun: "image" | "video"): ProviderError {
  const e = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error : {};
  const type = typeof e.type === "string" ? e.type : undefined;
  const msg = typeof e.message === "string" ? e.message.slice(0, 300) : "";
  const cost = typeof e.cost?.usd === "number" && Number.isFinite(e.cost.usd) && e.cost.usd >= 0 ? e.cost.usd : null;
  const u = e.usage && typeof e.usage === "object" ? e.usage : null;
  const tok = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const usage = u ? { input_tokens: tok(u.input_tokens), output_tokens: tok(u.output_tokens) } : undefined;
  const info = { type, usage, retryable: e.retryable === true, finishReason: typeof e.finish_reason === "string" ? e.finish_reason : undefined,
    requestId: typeof e.request_id === "string" ? e.request_id : undefined, costUsd: cost,
    retryAfterS: Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) : undefined };
  const Noun = noun === "image" ? "Image" : "Video";
  const hint = info.retryable ? " Try rephrasing or being more specific." : "";
  if (status === 422 || type === "generation_blocked")
    return new ProviderError(`The model declined to generate this ${noun}${info.finishReason ? ` (${info.finishReason})` : ""}.${hint}`, 422, { ...info, type: "generation_blocked" });
  if (type === "empty_result") return new ProviderError(`The model returned no ${noun}.`, status, { ...info, retryable: true });
  if (status === 429) { const s = info.retryAfterS ?? 30; return new ProviderError(`${Noun} generation is rate limited. Try again in about ${s}s.`, 429, { ...info, type: "rate_limit_error", retryAfterS: s, retryable: true }); }
  // A timeout is never retried here or by the engine: the upstream call may have run to completion and billed (a retry could bill twice).
  if (status === 504 || type === "upstream_timeout")
    return new ProviderError(noun === "video" ? "Video generation timed out (the service gives up after 150 s). It may still have been billed, so it was not retried." : "Image generation timed out. It may still have been billed.", 504, { ...info, type: "upstream_timeout" });
  if (status === 401) return new ProviderError(`The ${noun} service rejected this app's credentials.`, 502, info);
  if (status === 404 || type === "unknown_model") return new ProviderError(`That ${noun} model is not available${msg ? `: ${msg}` : "."}`, 404, info);
  if (status === 413 || type === "request_too_large") return new ProviderError(noun === "image" ? "The reference images are too large." : "The video request is too large.", 413, info);
  if (type === "result_too_large") return new ProviderError(`The ${noun} is too large to deliver. Try a shorter duration or a lower resolution.`, 502, info);
  if (status === 400 || (status >= 400 && status < 500)) return new ProviderError(`The ${noun} request was rejected${msg ? `: ${msg}` : "."}`, 400, info);
  return new ProviderError(`The ${noun} service failed (${status}).`, status >= 500 ? 502 : status, info);
}
export const imageError = (status: number, body: any, retryAfterHeader?: string | null) => mediaError(status, body, retryAfterHeader, "image");

/** Read a response body with a hard byte limit (Content-Length is only a hint: the stream is counted). Throws ProviderError 502 when exceeded. */
export async function readBoundedJson(res: Response, max: number, noun: "image" | "video" = "image"): Promise<unknown> {
  const tooBig = () => new ProviderError(`The ${noun} service returned a response that is too large.`, 502, { type: "api_error" });
  const cl = Number(res.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > max) { void res.body?.cancel().catch(() => {}); throw tooBig(); }
  if (!res.body) return null;
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { void reader.cancel().catch(() => {}); throw tooBig(); }
    chunks.push(value);
  }
  const all = new Uint8Array(n); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  chunks.length = 0; // free the chunk copies before the decode below
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { return null; }
}

// Adapter for fleet-vertex-gateway, reached through a Workers service binding. The gateway authenticates by caller
// key (a service binding carries no identity), so `key` is the dedicated caller `vertex-client`.
const fin = (v: unknown, free = false): number | undefined => (typeof v === "number" && Number.isFinite(v) && (v > 0 || (v === 0 && free)) ? v : undefined);
/** Only finite POSITIVE numbers survive (zero counts only when the price carries the admin-set free:true); anything else is "not stated". Never a default of 0. */
export function parseListedPrice(p: ListedPrice | null | undefined): GatewayPrice | undefined {
  if (!p || typeof p !== "object") return undefined;
  const free = p.free === true, f = (v: unknown) => fin(v, free);
  const tps = p.video_tokens_per_second && typeof p.video_tokens_per_second === "object"
    ? Object.fromEntries(Object.entries(p.video_tokens_per_second).filter(([, v]) => fin(v) !== undefined)) as Record<string, number> : undefined;
  const o: GatewayPrice = { unitEstimateUsd: f(p.unit_estimate_usd), verified: p.verified === true, ...(free ? { free: true } : {}), perSecond: f(p.per_second), outVideoPerMTok: f(p.out_video_per_mtok), outTextPerMTok: f(p.out_text_per_mtok),
    ...(tps && Object.keys(tps).length ? { videoTokensPerSecond: tps } : {}) };
  return o;
}

export function gatewayProvider(fetcher: Fetcher, key: string, classify?: (m: Listed) => Listed | null): ModelProvider {
  return {
    name: "fleet-vertex-gateway",
    async listModels(kind?: ModelKind): Promise<ProviderModel[]> {
      if (!key) throw new ProviderError("gateway key not configured", 503);
      const q = kind === "image" || kind === "video" ? `?kind=${kind}` : "";
      const res = await fetcher.fetch(`https://gateway.internal/v1/models${q}`, { headers: { "x-api-key": key } });
      if (!res.ok) throw new ProviderError(`gateway /v1/models returned ${res.status}`, 502);
      const body = (await res.json().catch(() => null)) as { data?: Listed[] } | null;
      if (!body || !Array.isArray(body.data)) throw new ProviderError("gateway /v1/models returned an unreadable body", 502);
      const want = kind === "image" || kind === "video" ? kind : "chat";
      // A gateway that omits kind/display_name (the team gateway) supplies a classifier; null = exclude the model everywhere.
      const list = classify ? body.data.map((m) => classify(m)).filter((m): m is Listed => m !== null) : body.data;
      // Defence in depth: whatever the gateway sends, a chat list never carries media models, an image list no video models, and so on.
      // Permission flags (gateway catalog): an entry whose own-kind permission is explicitly false is dropped even if listed; absent flags (older gateway) mean allowed.
      const denied = (m: Listed) => { const k = m.kind === "image" || m.kind === "video" || m.kind === "audio" ? m.kind : "chat"; return !!m.permissions && typeof m.permissions === "object" && m.permissions[k] === false; };
      return list.filter((m) => typeof m.id === "string" && !denied(m) && ((m.kind ?? "chat") === want || (want === "chat" && m.kind === undefined)))
        .map((m) => ({ id: m.id!, displayName: m.display_name ?? m.id!,
          ...(m.kind === "image" || m.kind === "video" ? { kind: m.kind as "image" | "video" } : {}),
          // `price` key present (object or null) = a catalog row; null/unusable = UNKNOWN. Key absent (legacy list without the field) = no catalog row.
          ...(m.price ? { price: parseListedPrice(m.price) ?? null } : m.price === null ? { price: null } : {}),
          // Chat entries: the catalog's own token price and capability flags (curated MODELS_META still wins where it exists).
          ...(want === "chat" && fin(m.price?.in_per_mtok, m.price?.free === true) !== undefined && fin(m.price?.out_per_mtok, m.price?.free === true) !== undefined ? { pricePerMTok: { input: m.price!.in_per_mtok!, output: m.price!.out_per_mtok! } } : {}),
          ...(want === "chat" && m.capabilities && typeof m.capabilities === "object" ? { capabilities: { text: true, vision: m.capabilities.images_in === true, tools: m.capabilities.tools === true, "image-gen": false, "video-gen": false, reasoning: m.capabilities.thinking === true } } : {}),
          ...(want === "chat" && m.capabilities && typeof m.capabilities === "object" && typeof m.capabilities.images_in === "boolean" ? { imagesIn: m.capabilities.images_in } : {}),
          ...(m.params ? { params: m.params } : {}) }));
    },
    async messages(body: unknown, signal?: AbortSignal): Promise<Response> {
      if (!key) throw new ProviderError("gateway key not configured", 503);
      return fetcher.fetch("https://gateway.internal/v1/messages", {
        method: "POST", signal, body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
    },
    async image(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
      if (!key) throw new ProviderError("gateway key not configured", 503);
      let res: Response;
      try {
        res = await fetcher.fetch("https://gateway.internal/v1/images", { method: "POST", signal, body: JSON.stringify(req), headers: { "content-type": "application/json", "x-api-key": key } });
      } catch (e) {
        if (signal?.aborted) throw e; // the caller's own abort, not a gateway failure
        throw new ProviderError("Could not reach the image service.", 502, { type: "api_error" });
      }
      // Error bodies are small; a success body may carry images but is still capped before it is parsed.
      const body = (await readBoundedJson(res, res.ok ? MAX_GEN_BODY_BYTES : 64 * 1024).catch((e) => { if (res.ok) throw e; return null; })) as any;
      if (!res.ok) throw imageError(res.status, body, res.headers.get("retry-after"));
      // Tolerate both the documented shape (`images[{mime_type,data}]`) and the OpenAI-style one the first team gateway emitted (`data[{b64_json,mime_type}]`).
      if (body && typeof body === "object" && !Array.isArray(body.images) && Array.isArray(body.data))
        body.images = body.data.map((i: any) => (i && typeof i === "object" ? { mime_type: i.mime_type ?? i.mimeType, data: i.data ?? i.b64_json } : null));
      if (!body || typeof body !== "object" || !Array.isArray(body.images)) throw new ProviderError("The image service returned an unreadable response.", 502, { type: "api_error" });
      if (body.usage && typeof body.usage === "object") { // Gemini usageMetadata passed through verbatim by the first gateway
        const u = body.usage;
        body.usage = { input_tokens: u.input_tokens ?? u.promptTokenCount, output_tokens: u.output_tokens ?? u.candidatesTokenCount };
      }
      if (body.images.length > MAX_GEN_IMAGES_PER_RESPONSE) throw new ProviderError("The image service returned too many images.", 502, { type: "api_error" });
      for (const i of body.images) if (i && typeof i.data === "string" && genImageProblem(i.data)) throw new ProviderError("The image service returned an invalid or oversized image.", 502, { type: "api_error" });
      if (body.images.reduce((t: number, i: any) => t + (i && typeof i.data === "string" ? b64DecodedLen(i.data) : 0), 0) > MAX_GEN_IMAGE_BYTES) throw new ProviderError("The image service returned an invalid or oversized image.", 502, { type: "api_error" });
      const images = body.images.filter((i: any) => i && typeof i.data === "string" && i.data && typeof i.mime_type === "string").map((i: any) => ({ mime_type: i.mime_type, data: i.data }));
      return { id: body.id, model: String(body.model ?? req.model), images, text: typeof body.text === "string" && body.text ? body.text : null,
        finish_reason: typeof body.finish_reason === "string" ? body.finish_reason : null, usage: body.usage, cost: body.cost, warnings: Array.isArray(body.warnings) ? body.warnings : undefined };
    },
    async video(req: VideoRequest, signal?: AbortSignal): Promise<VideoResult> {
      if (!key) throw new ProviderError("gateway key not configured", 503);
      let res: Response;
      try {
        res = await fetcher.fetch("https://gateway.internal/v1/videos", { method: "POST", signal, body: JSON.stringify(req), headers: { "content-type": "application/json", "x-api-key": key } });
      } catch (e) {
        if (signal?.aborted) throw e;
        // The request may have reached the gateway (and Vertex) before the connection died: never retried, billing uncertain.
        throw new ProviderError("Lost the connection to the video service.", 502, { type: "api_error" });
      }
      const body = (await readBoundedJson(res, res.ok ? MAX_GEN_VIDEO_BODY_BYTES : 64 * 1024, "video").catch((e) => { if (res.ok) throw e; return null; })) as any;
      if (!res.ok) throw mediaError(res.status, body, res.headers.get("retry-after"), "video");
      if (!body || typeof body !== "object") throw new ProviderError("The video service returned an unreadable response.", 502, { type: "api_error" });
      const v = body.video && typeof body.video === "object" ? body.video : null;
      if (v && typeof v.data === "string" && v.data && genVideoProblem(v.data)) throw new ProviderError("The video service returned an invalid or oversized video.", 502, { type: "api_error" });
      const video = v && typeof v.data === "string" && v.data && typeof v.mime_type === "string"
        ? { mime_type: v.mime_type, data: v.data, duration_seconds: typeof v.duration_seconds === "number" ? v.duration_seconds : undefined,
          resolution: typeof v.resolution === "string" ? v.resolution : undefined, has_audio: typeof v.has_audio === "boolean" ? v.has_audio : undefined }
        : null;
      return { id: body.id, model: String(body.model ?? req.model), video, finish_reason: typeof body.finish_reason === "string" ? body.finish_reason : null, usage: body.usage, cost: body.cost };
    },
  };
}
