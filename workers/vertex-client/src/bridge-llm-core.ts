// VCL model proxy, pure helpers (routes: src/bridge-llm.ts). No D1, no bindings, no secrets: everything here is unit-testable and never sees a credential.
import type { Usage } from "./reducer";
import { MODELS_META } from "./models-meta";

export const LLM_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;
export const LLM_MAX_BODY = 4 * 1024 * 1024;     // request body cap
export const LLM_MAX_TOKENS = 128000;            // max_tokens ceiling (the Agent SDK asks for >32k itself: e2e-observed); spend is bounded by the daily cap, not by this
export const LLM_RATE_PER_MIN = 60;              // requests per device per rolling minute
export const LLM_MAX_CONCURRENT = 4;             // in-flight requests per device
export const LLM_MAX_RESPONSE = 8 * 1024 * 1024; // non-streaming upstream body cap
export const LLM_DAILY_USD_DEFAULT = 5;
export const LLM_REVOKE_CHECK_MS = 5000;         // an open stream re-checks the device row at most this often
export const LLM_LEASE_S = 600;                 // an admission is valid this long; the Worker aborts the upstream call before it runs out
export const LLM_BODY_DEADLINE_MS = 20_000;      // the request body must arrive within this, before any slot is taken
export const LLM_CHARS_PER_TOKEN = 3;            // interrupted streams: output tokens are estimated as ceil(generated chars / 3), deliberately above the usual ~4
// Same shape as providers/config splitModelId prefixes; kept here (pure module, no imports of provider code) and checked again by isOpenModelId.
const OPEN_MODEL_RE = /^[a-z0-9][a-z0-9-]{0,31}:[\w./:@+-]{1,120}$/;
const DEFAULT_VERSION = "2023-06-01";

export type LlmProblem = { status: 400 | 413; message: string };
export type LlmBody = { body: Record<string, unknown>; model: string; stream: boolean };

/** Parse + validate an Anthropic Messages request. Unknown fields pass through; only the fields the proxy has to police are checked. `stream` is never forced. */
export function checkLlmBody(raw: string, allowOpen = false): LlmBody | LlmProblem {
  if (raw.length > LLM_MAX_BODY) return { status: 413, message: "request body too large" };
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return { status: 400, message: "body must be JSON" }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { status: 400, message: "body must be a JSON object" };
  const b = j as Record<string, unknown>;
  // allowOpen (vclopen1, flag-gated by the caller): a `<provider>:<model>` Open id is also well-formed here; whether it may be USED is the route's decision.
  if (typeof b.model !== "string" || !((LLM_MODELS as readonly string[]).includes(b.model) || (allowOpen && OPEN_MODEL_RE.test(b.model)))) return { status: 400, message: `model not allowed (use ${LLM_MODELS.join(", ")})` };
  if (typeof b.max_tokens !== "number" || !Number.isInteger(b.max_tokens) || b.max_tokens < 1) return { status: 400, message: "max_tokens must be a positive integer" };
  if (b.max_tokens > LLM_MAX_TOKENS) return { status: 400, message: `max_tokens above the limit (${LLM_MAX_TOKENS})` };
  if (!Array.isArray(b.messages) || b.messages.length === 0) return { status: 400, message: "messages must be a non-empty array" };
  if (b.stream !== undefined && typeof b.stream !== "boolean") return { status: 400, message: "stream must be a boolean" };
  return { body: b, model: b.model, stream: b.stream === true };
}
export const isProblem = (v: LlmBody | LlmProblem): v is LlmProblem => "status" in v;

/** The only client headers that travel upstream, re-validated; the device token, cookies and every other header are dropped. */
export function upstreamHeaders(req: Headers): Record<string, string> {
  const v = req.get("anthropic-version") ?? "";
  const beta = (req.get("anthropic-beta") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s)).slice(0, 8);
  return { "content-type": "application/json", "anthropic-version": /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_VERSION, ...(beta.length ? { "anthropic-beta": beta.join(",") } : {}) };
}

/** Anthropic-shaped error body with a fixed message: never an upstream body. */
export const llmError = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

/** Map an upstream status to what the device sees. The class survives, the text is ours. */
export function mapUpstream(status: number): { status: number; type: string; message: string } {
  if (status === 429) return { status: 429, type: "rate_limit_error", message: "model provider is rate limited, retry shortly" };
  if (status === 413) return { status: 413, type: "request_too_large", message: "request too large for the model provider" };
  if (status === 400 || status === 422) return { status: 400, type: "invalid_request_error", message: "the model provider rejected the request" };
  return { status: 502, type: "api_error", message: "model provider unavailable" };
}

/** Incremental SSE usage reader: feed decoded text, read `usage` after. message_start carries input/cache, message_delta carries cumulative output. */
export class SseUsage {
  usage: Usage = {};
  /** generated characters seen (text / thinking / tool-input JSON deltas): the floor for output tokens when the stream is cut before its final usage */
  chars = 0;
  /** a message_delta carrying usage arrived: the provider's own output_tokens are final and win over any estimate */
  final = false;
  private buf = "";
  feed(text: string) {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) { const line = this.buf.slice(0, i).replace(/\r$/, ""); this.buf = this.buf.slice(i + 1); this.line(line); }
    if (this.buf.length > 1_000_000) this.buf = ""; // a single enormous line is not usage data
  }
  private line(l: string) {
    if (!l.startsWith("data:")) return;
    let d: any; try { d = JSON.parse(l.slice(5)); } catch { return; }
    if (d?.type === "message_start") this.merge(d.message?.usage);
    else if (d?.type === "message_delta") { this.merge(d.usage); if (d.usage && typeof d.usage.output_tokens === "number") this.final = true; }
    else if (d?.type === "content_block_delta" && d.delta && typeof d.delta === "object") {
      for (const k of ["text", "thinking", "partial_json"]) if (typeof d.delta[k] === "string") this.chars += d.delta[k].length;
    }
  }
  private merge(u: any) {
    if (!u || typeof u !== "object") return;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) { const x = n(u[k]); if (x !== undefined) this.usage[k] = x; }
    const h = n(u.cache_creation?.ephemeral_1h_input_tokens);
    if (h !== undefined) this.usage.cache_creation = { ...(this.usage.cache_creation ?? {}), ephemeral_1h_input_tokens: h } as Usage["cache_creation"];
  }
}

/** Usage to bill: the provider's when the stream finished its accounting, else output = max(provisional message_start value, ceil(chars/3)). Input tokens always come from message_start. */
export function effectiveUsage(s: SseUsage): Usage {
  if (s.final || s.chars === 0) return { ...s.usage };
  return { ...s.usage, output_tokens: Math.max(s.usage.output_tokens ?? 0, Math.ceil(s.chars / LLM_CHARS_PER_TOKEN)) };
}

/** Worst-case $ of one request, reserved at admission: input estimated from the body size (1 token per 3 chars, billed at the dearest input-side rate) + max_tokens at the output rate; the high-prompt tier when it would apply. null = unpriced model (never reserved, never billed). */
export function reserveUsd(model: string, bodyChars: number, maxTokens: number): number | null {
  const p = MODELS_META[model]?.price; if (!p) return null;
  const inTok = Math.ceil(bodyChars / LLM_CHARS_PER_TOKEN), r = p.highTier && inTok > p.highTier.aboveTokens ? p.highTier : p;
  return (inTok * Math.max(r.input, r.cacheWrite, r.cacheWrite1h ?? 0) + maxTokens * r.output) / 1e6;
}

export function usageOfJson(j: unknown): Usage {
  const s = new SseUsage();
  const u = (j as any)?.usage;
  s.feed(`data: ${JSON.stringify({ type: "message_delta", usage: u })}\n`);
  return s.usage;
}

/** Soft daily cap in USD from the settings value: missing/garbage => default; negative => 0 (blocks). */
export const dailyCapUsd = (v: string | null | undefined) => { const n = v === null || v === undefined || v === "" ? NaN : Number(v); return Number.isFinite(n) ? Math.max(0, n) : LLM_DAILY_USD_DEFAULT; };
