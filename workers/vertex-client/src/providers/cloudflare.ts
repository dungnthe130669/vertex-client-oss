// Cloudflare Workers AI through the Worker's own `AI` binding: no key, no base URL (a client can never point this at another host).
// Chat: env.AI.run(model, { messages, stream: true, max_tokens }) -> SSE ({response} chunks on older models, OpenAI-style chunks on newer ones;
// both are handled) -> Anthropic stream events. Image models ride the existing Image mode (base64 out). Tokens only, no $ price: Workers AI bills
// "neurons" against the account that owns the binding (see docs/providers.md). The model list is CURATED, not the whole catalog.
import type { ConfiguredModel, ProviderConfig } from "./config";
import { toAnthropicStream, toChatRequest } from "./openai-compat";
import { CF_OWN_MAX_RESPONSE, CF_OWN_MAX_TOKENS, LINK_BROKEN, cfFetch, decodeCreds, type CfCreds } from "../cf-account";
import { NO_CAPABILITIES, ProviderError, ProviderNetworkError, type Capabilities, type ImageRequest, type ImageResult, type ModelKind, type ModelProvider, type ProviderModel } from "./types";

type Env = Record<string, unknown>;
type AiBinding = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

import { CLOUDFLARE_CHAT_SEED, CLOUDFLARE_IMAGE_SEED, type SeedModel } from "./seed";

/** Views of providers/seed.ts (the seed behind D1 `provider_models`): the built-in fallback list. The registry serves the DB catalog through `cfg.models` when it has one. */
const fromSeed = (m: SeedModel): ConfiguredModel => ({ id: m.id, kind: m.kind, displayName: m.name, capabilities: { ...NO_CAPABILITIES, ...m.caps }, pricePerMTok: null, contextWindow: m.context ?? null });
/** Chat models. Names/context/capabilities from developers.cloudflare.com/workers-ai/models (checked 2026-10-23); see seed.ts. */
export const CLOUDFLARE_CHAT: ConfiguredModel[] = CLOUDFLARE_CHAT_SEED.map(fromSeed);
/** Text-to-image models that take `{prompt}` and return one image. */
export const CLOUDFLARE_IMAGE: ConfiguredModel[] = CLOUDFLARE_IMAGE_SEED.map(fromSeed);
export const CLOUDFLARE_MODELS: ConfiguredModel[] = [...CLOUDFLARE_CHAT, ...CLOUDFLARE_IMAGE];

/** Team edition: Workers AI bills the owner's account, so guests get it only when this flag is explicitly on. Default off. */
export const cfTeamEnabled = (env: Env) => env.PROVIDER_CF_TEAM === "true" || env.PROVIDER_CF_TEAM === "1" || env.PROVIDER_CF_TEAM === true;

export const SHARED_OFF = "Workers AI on the shared account is switched off for you. Link your own Cloudflare account in Settings > Cloudflare to use it.";

/** Binding failure -> user-safe ProviderError (never the raw upstream text). */
export function cloudflareError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const m = e instanceof Error ? e.message : String(e);
  if (/neuron|quota|daily|allowance|exceed|too many|rate.?limit|capacity|429|4006/i.test(m)) return new ProviderError("Workers AI has no capacity left right now (the free daily allowance or a rate limit is used up). Try again later or pick another model.", 429, { type: "rate_limit_error", retryable: false });
  if (/no such model|unknown model|not found|does not exist|5007|3040|deprecat/i.test(m)) return new ProviderError("That Workers AI model is not available.", 404, { type: "not_found_error" });
  if (/timeout|timed out|504|408/i.test(m)) return new ProviderError("Workers AI timed out.", 504, { type: "upstream_timeout", retryable: true });
  if (/invalid|bad request|400|schema|validation/i.test(m)) return new ProviderError("Workers AI rejected the request.", 400, { type: "invalid_request_error" });
  return new ProviderError("Workers AI failed.", 502, { type: "api_error", retryable: true });
}

const enc = new TextEncoder(), dec = new TextDecoder();
const sse = (j: unknown) => enc.encode(`data: ${typeof j === "string" ? j : JSON.stringify(j)}\n\n`);

/** Workers AI SSE -> chat-completions SSE (so one Anthropic normaliser serves both). `{response}` chunks become delta.content; OpenAI-style chunks pass through.
 *  If the stream never carried usage, a final usage chunk is estimated (chars/3) and flagged `estimated`. */
export function normaliseWorkersAiStream(upstream: ReadableStream<Uint8Array>, promptChars: number): ReadableStream<Uint8Array> {
  let buf = "", outChars = 0, sawUsage = false, finished = false;
  const handle = (ctl: TransformStreamDefaultController<Uint8Array>, data: string) => {
    if (data === "[DONE]") return;
    let j: any; try { j = JSON.parse(data); } catch { return; }
    if (j && typeof j === "object" && !Array.isArray(j) && j.error) { ctl.enqueue(sse({ error: { message: String(j.error?.message ?? j.error).slice(0, 200) } })); return; }
    if (j?.usage) sawUsage = true;
    if (Array.isArray(j?.choices)) {
      const d = j.choices[0]?.delta?.content; if (typeof d === "string") outChars += d.length;
      if (j.choices[0]?.finish_reason) finished = true;
      ctl.enqueue(sse(j)); return;
    }
    if (typeof j?.response === "string") { outChars += j.response.length; if (j.response) ctl.enqueue(sse({ choices: [{ delta: { content: j.response } }] })); }
    else if (j?.response != null && typeof j.response !== "string") { /* tool-call objects in the legacy shape are not supported: ignore */ }
    if (j?.usage) ctl.enqueue(sse({ choices: [], usage: j.usage }));
  };
  const lines = (ctl: TransformStreamDefaultController<Uint8Array>, flush: boolean) => {
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); const l = c.split("\n").find((x) => x.startsWith("data:")); if (l) handle(ctl, l.slice(5).trim()); }
    if (flush && buf.trim()) { const l = buf.split("\n").find((x) => x.startsWith("data:")); buf = ""; if (l) handle(ctl, l.slice(5).trim()); }
  };
  return upstream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) { buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n"); lines(ctl, false); },
    flush(ctl) {
      lines(ctl, true);
      if (!finished) ctl.enqueue(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      if (!sawUsage) ctl.enqueue(sse({ choices: [], usage: { prompt_tokens: Math.ceil(promptChars / 3), completion_tokens: Math.ceil(outChars / 3), estimated: true } }));
      ctl.enqueue(sse("[DONE]"));
    },
  }));
}

const b64Of = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const mimeOfB64 = (b: string) => (b.startsWith("/9j/") ? "image/jpeg" : b.startsWith("UklGR") ? "image/webp" : "image/png");

/** Status of a REST call to the user's OWN account -> user-safe ProviderError (never the response body: it could echo request text). */
function restError(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("Your linked Cloudflare token was rejected (revoked, expired, or missing the Workers AI Read + Edit permission). Check Settings > Cloudflare.", 502, { type: "api_error" });
  if (status === 429) return new ProviderError("Your Cloudflare account has no Workers AI capacity left right now (daily allowance or rate limit). Try again later.", 429, { type: "rate_limit_error", retryable: false });
  if (status === 404) return new ProviderError("That Workers AI model is not available on your Cloudflare account.", 404, { type: "not_found_error" });
  if (status === 408 || status === 504) return new ProviderError("Workers AI timed out.", 504, { type: "upstream_timeout", retryable: true });
  if (status === 400 || status === 422) return new ProviderError("Workers AI rejected the request.", 400, { type: "invalid_request_error" });
  return new ProviderError("Workers AI failed on your Cloudflare account.", 502, { type: "api_error", retryable: status >= 500 });
}
/** Byte-counting limiter for a streamed answer from the user's own account: errors the stream (and cancels the source) once more than `max` bytes have passed. */
export function capStream(src: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let n = 0;
  return src.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      n += chunk.byteLength;
      if (n > max) { ctl.error(new ProviderError("Workers AI returned too much data.", 502, { type: "api_error" })); return; }
      ctl.enqueue(chunk);
    },
  }));
}
/** `env.AI`-shaped binding over the Cloudflare REST API of a linked account: POST /accounts/<id>/ai/run/<model>. Streaming bodies are returned as the raw SSE stream;
 *  JSON answers as their `result`; image bodies as bytes. max_tokens is clamped (per-request sanity cap: the shared daily caps do not apply to a user's own account). */
export function restAiBinding(creds: CfCreds, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): AiBinding {
  return {
    async run(model, input) {
      const inp = { ...input } as Record<string, unknown>;
      if (typeof inp.max_tokens === "number") inp.max_tokens = Math.max(1, Math.min(Math.floor(inp.max_tokens), CF_OWN_MAX_TOKENS));
      let r: Response;
      try { r = await cfFetch(creds, `ai/run/${model}`, { method: "POST", body: JSON.stringify(inp), signal }, fetchImpl); }
      catch (e) { if (signal?.aborted) throw e; throw new ProviderNetworkError("Could not reach your Cloudflare account."); }
      if (!r.ok) { void r.body?.cancel().catch(() => {}); throw restError(r.status); }
      const ct = r.headers.get("content-type") ?? "";
      if (inp.stream === true && r.body && ct.includes("event-stream")) return capStream(r.body, CF_OWN_MAX_RESPONSE);
      const declared = Number(r.headers.get("content-length") ?? 0);
      if (declared > CF_OWN_MAX_RESPONSE) { void r.body?.cancel().catch(() => {}); throw new ProviderError("Workers AI returned too much data.", 502, { type: "api_error" }); }
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > CF_OWN_MAX_RESPONSE) throw new ProviderError("Workers AI returned too much data.", 502, { type: "api_error" });
      if (ct.includes("json")) {
        let j: any; try { j = JSON.parse(new TextDecoder().decode(buf)); } catch { throw new ProviderError("Workers AI returned an unreadable answer.", 502, { type: "api_error" }); }
        if (j && j.success === false) throw new ProviderError("Workers AI rejected the request.", 400, { type: "invalid_request_error" });
        return j && typeof j === "object" && "result" in j ? j.result : j;
      }
      return buf;
    },
  };
}

export function cloudflareProvider(cfg: ProviderConfig, env: Env, fetchImpl?: typeof fetch): ModelProvider {
  /** The shared binding, or the user's own account when one is linked (cfg.resolveKey). A linked row that cannot be read FAILS CLOSED: it never falls back to the shared account. */
  const pick = async (signal?: AbortSignal): Promise<AiBinding> => {
    const k = await (cfg.resolveKey?.() ?? Promise.resolve({ kind: "none" as const })).catch(() => ({ kind: "error" as const }));
    if (k.kind === "key") { const c = decodeCreds(k.key); if (!c) throw new ProviderError(LINK_BROKEN, 502, { type: "api_error" }); return restAiBinding(c, fetchImpl, signal); }
    if (k.kind !== "none") throw new ProviderError(LINK_BROKEN, 502, { type: "api_error" });
    // No linked account: the operator's shared account, only while THIS base's feature flag allows it (decided now, not by any cache). Absent callback / throw = no.
    if (!(await (cfg.sharedAllowed?.() ?? Promise.resolve(false)).catch(() => false))) throw new ProviderError(SHARED_OFF, 403, { type: "permission_error" });
    const b = env.AI as AiBinding | undefined; if (!b) throw new ProviderError("Workers AI is not available here.", 503, { type: "api_error" });
    return b;
  };
  // The list is the config's own models (DB catalog via the registry; the built-in config carries the seed), split by kind (an empty list = every model switched off).
  const all = cfg.models;
  const isImage = (m: ConfiguredModel) => (m.kind ? m.kind === "image" : !!m.capabilities["image-gen"]); // catalog kind decides; the capability flag only for kind-less (built-in) entries
  const CHAT = all.filter((m) => !isImage(m)), IMAGE = all.filter(isImage);
  const IMAGE_IDS = new Set(IMAGE.map((m) => m.id));
  const chatModels: ProviderModel[] = CHAT.map((m) => ({ id: m.id, displayName: m.displayName, capabilities: m.capabilities, pricePerMTok: null, contextWindow: m.contextWindow, kind: "chat" }));
  const imageModels: ProviderModel[] = IMAGE.map((m) => ({ id: m.id, displayName: m.displayName, capabilities: m.capabilities, pricePerMTok: null, kind: "image" }));
  return {
    name: cfg.id, id: cfg.id,
    async listModels(kind?: ModelKind) { return !kind || kind === "chat" ? chatModels.map(({ kind: _k, ...m }) => m) : kind === "image" ? imageModels : []; },
    async messages(body: any, signal?: AbortSignal): Promise<Response> {
      const model = String(body?.model ?? "");
      if (!chatModels.some((m) => m.id === model)) throw new ProviderError("That Workers AI model is not available.", 404, { type: "not_found_error" });
      const binding = await pick(signal);
      const req = toChatRequest(body, model) as { messages: unknown[]; tools?: unknown; max_tokens?: number };
      const promptChars = JSON.stringify(req.messages).length;
      let out: unknown;
      try { out = await binding.run(model, { messages: req.messages, stream: true, ...(req.max_tokens ? { max_tokens: req.max_tokens } : {}), ...(req.tools ? { tools: req.tools } : {}) }); }
      catch (e) { if (signal?.aborted) throw e; throw cloudflareError(e); }
      let stream: ReadableStream<Uint8Array>;
      if (out instanceof ReadableStream) stream = out as ReadableStream<Uint8Array>;
      else if (out && typeof out === "object" && typeof (out as any).response === "string") stream = new ReadableStream({ start(c) { c.enqueue(sse({ response: (out as any).response, ...((out as any).usage ? { usage: (out as any).usage } : {}) })); c.enqueue(sse("[DONE]")); c.close(); } });
      else throw new ProviderError("Workers AI returned an empty response.", 502, { type: "api_error" });
      return new Response(toAnthropicStream(normaliseWorkersAiStream(stream, promptChars), model, signal), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    async image(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
      if (!IMAGE_IDS.has(req.model)) throw new ProviderError("That Workers AI image model is not available.", 404, { type: "not_found_error" });
      const binding = await pick(signal);
      let out: unknown;
      try { out = await binding.run(req.model, { prompt: req.prompt }); } catch (e) { if (signal?.aborted) throw e; throw cloudflareError(e); }
      let data = "";
      try {
        if (out && typeof out === "object" && typeof (out as any).image === "string") data = (out as any).image;
        else if (out instanceof ReadableStream) data = b64Of(new Uint8Array(await new Response(out).arrayBuffer()));
        else if (out instanceof ArrayBuffer) data = b64Of(new Uint8Array(out));
        else if (out instanceof Uint8Array) data = b64Of(out);
      } catch { throw new ProviderError("Workers AI returned an unreadable image.", 502, { type: "api_error" }); }
      if (!data) return { model: req.model, images: [], text: null, finish_reason: "empty", cost: { usd: null, basis: "workers-ai neurons (not priced)" } };
      return { model: req.model, images: [{ mime_type: mimeOfB64(data), data }], text: null, finish_reason: "STOP", cost: { usd: null, basis: "workers-ai neurons (not priced)" } };
    },
  };
}
