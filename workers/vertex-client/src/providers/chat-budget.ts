// Fit a chat request into a provider's per-minute token budget (Groq free: 8K tokens/minute per model, shared by the org). Pure, no I/O.
// The provider counts prompt + the requested output (max_completion_tokens) against the minute; a single request over the budget is a 413 that retrying never fixes,
// so a model flagged `shortContext` gets its history trimmed (oldest whole turns first) and its output cap lowered BEFORE the call. Token counts here are ESTIMATES
// (no tokenizer in a Worker): chars/3 is deliberately pessimistic for JSON/code-heavy prompts; an image counts a fixed cost (Groq: ~1.3K tokens each, measured).
import { ProviderError } from "./types";

export const CHARS_PER_TOKEN = 3;
export const DEFAULT_IMAGE_TOKENS = 1300;
/** Keep this share of the minute budget free for estimation error (the provider's own count differs from ours). */
export const BUDGET_SAFETY = 0.92;
/** A reasoning model needs room for its thinking plus an answer: below this output budget the request is not worth sending. */
export const MIN_OUTPUT_TOKENS = 700;
export const TRIM_NOTE = "Note: earlier messages of this conversation were left out to fit this model's per-minute token limit.";

const len = (v: unknown): number => (v == null ? 0 : typeof v === "string" ? v.length : JSON.stringify(v).length);
const blocksOf = (m: any): any[] => (typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : []);

export function estimateTokens(body: any, imageTokens = DEFAULT_IMAGE_TOKENS): number {
  let chars = 0, images = 0;
  const sys = Array.isArray(body?.system) ? body.system.map((b: any) => b?.text ?? "").join("\n\n") : typeof body?.system === "string" ? body.system : "";
  chars += sys.length;
  for (const t of body?.tools ?? []) chars += len({ name: t.name, description: t.description, parameters: t.input_schema });
  for (const m of body?.messages ?? []) {
    chars += 16; // role / framing
    for (const b of blocksOf(m)) {
      if (b?.type === "image") images++;
      else if (b?.type === "text") chars += len(b.text);
      else if (b?.type === "tool_use") chars += len(b.name) + len(b.input) + 24;
      else if (b?.type === "tool_result") chars += len(typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n") : b.content) + 24;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * imageTokens;
}

/** Indices where a conversation turn starts: a user message with NO tool_result block (a mixed tool_result + text message belongs to the tool-call group before it).
 *  Cutting history there keeps every tool_use together with its tool_result, and never leaves a tool_result without its tool_use. */
const turnStarts = (messages: any[]): number[] => messages.flatMap((m, i) => (m?.role === "user" && blocksOf(m).length > 0 && !blocksOf(m).some((b) => b?.type === "tool_result") ? [i] : []));
const withNote = (b: any): any => ({ ...b, system: [...(Array.isArray(b.system) ? b.system : b.system ? [{ type: "text", text: String(b.system) }] : []), { type: "text", text: TRIM_NOTE }] });

export interface FitResult { body: any; trimmed: boolean; maxOutput: number; promptTokens: number }
/** Make `body` (Anthropic Messages shape) fit `tpm`. Drops the oldest turns until prompt + the output cap fit; lowers the output cap to what is left (never above `wantOut`).
 *  Throws a 413 ProviderError (never retryable) when even the current turn alone does not fit. */
export function fitToBudget(body: any, o: { tpm: number; wantOut: number; imageTokens?: number; tooLargeMessage: string }): FitResult {
  const budget = Math.floor(o.tpm * BUDGET_SAFETY), img = o.imageTokens ?? DEFAULT_IMAGE_TOKENS;
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const starts = turnStarts(messages);
  // the trim note is part of what is sent, so it counts toward the budget when choosing the cut point
  const cut = (from: number) => { const b = { ...body, messages: messages.slice(from) }; return from > 0 ? withNote(b) : b; };
  const tooLarge = () => new ProviderError(o.tooLargeMessage, 413, { type: "invalid_request_error", retryable: false });
  const needed = (b: any) => estimateTokens(b, img) + Math.min(o.wantOut, MIN_OUTPUT_TOKENS);
  // earliest cut point (keep as much history as possible) whose prompt + minimum output fits; the last turn start is the floor
  const candidates = [0, ...starts.filter((i) => i > 0)];
  const lastStart = starts.length ? starts[starts.length - 1]! : 0;
  let from = -1;
  for (const c of candidates) if (c <= lastStart && needed(cut(c)) <= budget) { from = c; break; }
  if (from < 0) throw tooLarge();
  const out = cut(from);
  const trimmed = from > 0;
  const promptTokens = estimateTokens(out, img);
  const maxOutput = Math.max(MIN_OUTPUT_TOKENS, Math.min(o.wantOut, budget - promptTokens));
  if (promptTokens + Math.min(maxOutput, MIN_OUTPUT_TOKENS) > budget) throw tooLarge();
  return { body: out, trimmed, maxOutput: Math.min(maxOutput, o.wantOut), promptTokens };
}

/** Keep only the `max` most recent images; older ones become a short text marker (a provider may cap images per request). */
export function capImages(body: any, max: number): any {
  let total = 0; for (const m of body?.messages ?? []) for (const b of blocksOf(m)) if (b?.type === "image") total++;
  if (total <= max) return body;
  let drop = total - max;
  const messages = (body.messages as any[]).map((m) => {
    if (drop <= 0 || !Array.isArray(m?.content)) return m;
    return { ...m, content: m.content.map((b: any) => (b?.type === "image" && drop > 0 ? (drop--, { type: "text", text: "[earlier image omitted: this model accepts a limited number of images per request]" }) : b)) };
  });
  return { ...body, messages };
}
