import type { ModelMeta } from "./models-meta";

/** Settings -> "Limit answer length". "default" = the model's meta.maxTokens (today's behaviour); "off" = the largest safe request for Vertex-gateway models. */
export type AnswerLimit = "off" | "default";
export const isAnswerLimit = (v: unknown): v is AnswerLimit => v === "off" || v === "default";
/** Per edition: the personal/main instance (and the e2e bot, a main-edition user) defaults to no limit; a team user (g:<uid>) keeps today's behaviour. */
export const answerLimitDefault = (guest: boolean): AnswerLimit => (guest ? "default" : "off");

/** Real limits per model family, from the vendors' public docs (2026-11-01; URLs in docs/reports/outlimit1.md). NOT probed live (the e2e hub caps max_tokens): a 400 on max_tokens is
 *  retried once at meta.maxTokens by the engine. Families not listed (grok, qwen, gpt-oss, anything unknown) keep meta.maxTokens: no verified maximum, no guess. */
export const OUTPUT_LIMITS: ReadonlyArray<{ re: RegExp; window: number; maxOut: number; src: string }> = [
  { re: /^claude-(?:fable|opus|sonnet|haiku)-5(?:-\d+)?$/, window: 1_000_000, maxOut: 128_000, src: "platform.claude.com/docs/en/models/overview" },
  { re: /^claude-haiku-4-5(?:-\d+)?$/, window: 200_000, maxOut: 64_000, src: "platform.claude.com/docs/en/models/haiku-4-5/overview" },
  { re: /^gemini-(?:3(?:\.\d+)?|2\.5)-(?:pro|flash)(?:-lite)?(?:-preview)?$/, window: 1_048_576, maxOut: 65_536, src: "docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/*" },
];
/** Room kept for the input estimate being low and for the provider's own overhead. */
export const BUDGET_MARGIN_TOKENS = 2048;
const MARGIN_FRACTION = 0.1;
/** Below this much room an "off" request is not worth raising (and is never clamped UP to it: that would exceed the window). */
const FLOOR = 1024;

/** Model-visible media cost, NOT encoded length (base64 bytes are never counted as text). Anthropic vision doc (platform.claude.com/docs/en/build-with-claude/vision, fetched 2026-11-01):
 *  an image costs ceil(w/28)*ceil(h/28) tokens, capped at 4,784 (Claude 4.7+ "high-resolution" tier; 1,568 on the standard tier), so 4,784 is a safe upper bound per image when the size is unknown.
 *  PDF doc (.../pdf-support): each page ~1,500-3,000 text tokens PLUS the page as an image, max 600 pages (100 under a 1M window). Page count is unknown without parsing, so it is estimated
 *  from the byte size at one page per 50 KB (an assumption, capped at 600) and priced at 3,000 + 4,784 per page: an upper-bound-leaning guess, not a count. */
export const IMAGE_TOKENS = 4_784;
export const PDF_TOKENS_PER_PAGE = 3_000 + IMAGE_TOKENS;
export const PDF_BYTES_PER_PAGE = 50_000;
export const PDF_MAX_PAGES = 600;
const b64Bytes = (data: unknown): number => (typeof data === "string" ? Math.floor((data.length * 3) / 4) : 0);

/** Input tokens of a request body: text, tool definitions and tool results by chars/4; image/document blocks by the media figures above (never the base64 payload). */
export function estimateInputTokens(body: { system?: unknown; messages?: unknown; tools?: unknown }): number {
  let chars = 0, media = 0;
  const walk = (n: unknown): void => {
    if (typeof n === "string") { chars += n.length; return; }
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (o.type === "image") { media += IMAGE_TOKENS; return; }
    if (o.type === "document") {
      const src = (o.source ?? {}) as Record<string, unknown>;
      if (src.type === "base64") media += Math.min(PDF_MAX_PAGES, Math.max(1, Math.ceil(b64Bytes(src.data) / PDF_BYTES_PER_PAGE))) * PDF_TOKENS_PER_PAGE;
      else if (src.type === "text" || src.type === "content") walk(src.data ?? src.content);
      else media += PDF_TOKENS_PER_PAGE; // url / file reference: size unknown, one page's worth
      return;
    }
    for (const [k, v] of Object.entries(o)) { chars += k.length; walk(v); }
  };
  walk(body.system); walk(body.messages); walk(body.tools);
  return Math.ceil(chars / 4) + media;
}

export function outputLimitsOf(modelId: string): { window: number; maxOut: number } | null {
  const r = OUTPUT_LIMITS.find((l) => l.re.test(modelId));
  return r ? { window: r.window, maxOut: r.maxOut } : null;
}

/** max_tokens for a chat request. Pure. `modelId` is the bare gateway id; a prefixed id (`<provider>:<model>`, the Open providers) is never touched.
 *  off, known family: room = window - input - margin; result = max(min(maxOut, room), min(meta.maxTokens, room)), so "off" is never lower than today's default unless the window itself forces it.
 *  Room below the floor (or negative): we do NOT clamp up to a floor (that would exceed the window) and do not invent a number; the request goes out exactly as before this feature
 *  (meta.maxTokens), through the existing path that already handles an over-full context. Unknown family / absent meta: meta.maxTokens (8192 with no meta, the engine's old default). */
export function outputBudget(meta: ModelMeta | undefined, setting: AnswerLimit, estimatedInputTokens: number, modelId = ""): number {
  const base = meta?.maxTokens ?? 8192;
  if (setting !== "off" || !meta || modelId.includes(":")) return base;
  const l = outputLimitsOf(modelId);
  if (!l) return base;
  const input = Number.isFinite(estimatedInputTokens) && estimatedInputTokens > 0 ? Math.ceil(estimatedInputTokens) : 0;
  const room = l.window - input - BUDGET_MARGIN_TOKENS - Math.ceil(input * MARGIN_FRACTION);
  if (room < FLOOR) return base;
  return Math.max(Math.min(l.maxOut, room), Math.min(base, room));
}

/** The gateway's real error envelope (workers/fleet-vertex-gateway/src/index.ts:1355, :1156): `{type:"error", error:{type:"api_error", message:"vertex 400", detail:"<upstream body text, <=800 chars>"}}`.
 *  The upstream complaint is in `detail` as RAW text: Claude `{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: ..."}}`, Gemini `[{"error":{"code":400,"message":"... maxOutputTokens ...","status":"INVALID_ARGUMENT"}}]`.
 *  So message AND detail (and a plain string error / top-level message) are all searched. */
export const isMaxTokensError = (status: number, body: unknown): boolean => {
  if (status !== 400) return false;
  const b = body as { message?: unknown; error?: unknown } | null;
  const e = (b?.error && typeof b.error === "object" ? b.error : null) as { message?: unknown; detail?: unknown } | null;
  const text = [b?.message, typeof b?.error === "string" ? b.error : undefined, e?.message, e?.detail].filter((v): v is string => typeof v === "string").join(" ");
  return /max_tokens|max_output|maxOutputTokens|output tokens|maximum.*tokens/i.test(text);
};
/** Pre-content statuses that a raised budget can cause (quota / overload reserved against max_tokens): one retry at the model's own cap before the normal retry / Auto logic. */
export const BUDGET_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503, 529]);
