// Adapter for Google AI Studio (Gemini API), NATIVE protocol: POST <base>/models/<id>:streamGenerateContent?alt=sse, key in the x-goog-api-key header (never in the URL).
// The app speaks Anthropic Messages internally, so this maps the request (system / messages / tools / images) to Gemini `contents` and the SSE answer back to Anthropic stream events.
// Facts (live probe 2026-10-26, docs/vertex-client-aistudio.md): roles are user|model; system = top-level systemInstruction; a tool result is a user part `functionResponse{name,response}`;
// the model's `thoughtSignature` on a functionCall part MUST be echoed on the next turn (400 otherwise); thought summaries come as parts with `thought:true` (only with
// thinkingConfig.includeThoughts); usageMetadata is cumulative per chunk (last wins) and thoughtsTokenCount is NOT inside candidatesTokenCount; MAX_TOKENS can return `content:{}`;
// errors are `{error:{code,status,message,details[]}}` (a bad key is HTTP 400 API_KEY_INVALID, a 429 carries "retry in Ns" in the text and RetryInfo, no Retry-After header).
// Google Search grounding and code execution are NEVER sent: `tools` only ever holds functionDeclarations.
import { ProviderError, ProviderNetworkError, type ModelKind, type ModelProvider, type ProviderModel } from "./types";
import { authHeaders, keyOf, readCappedText } from "./openai-compat";
import { AISTUDIO_DESCRIPTOR, discoveredKind } from "./descriptor";
import type { ConfiguredModel, ProviderConfig } from "./config";

type Env = Record<string, unknown>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_LIST_BODY = 512 * 1024;
/** A rate-limit hint longer than this is not waited for in-turn: the user gets the plain message instead. One retry at most. */
const MAX_RETRY_WAIT_MS = 5000;
const isRedirect = (s: number) => s >= 300 && s < 400;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- tool schema -> Gemini function declaration (OpenAPI subset) ----
/** Gemini rejects JSON-Schema keywords outside its OpenAPI subset (additionalProperties, $ref, $schema, ...) and array-valued `type`: keep an allowlist, rewrite the near-equivalents
 *  (type ["x","null"] -> type x + nullable, oneOf -> anyOf, const -> enum), drop the rest. Pure and bounded (depth 12). */
const KEEP = new Set(["type", "format", "description", "nullable", "enum", "properties", "required", "items", "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "anyOf", "title"]);
/** Gemini accepts STRING enums only. All-string: kept. Numeric / boolean (or mixed): the enum constraint is dropped, the type kept, and the allowed values go in the description. */
function enumOf(v: unknown[], out: Record<string, unknown>) {
  const vals = v.filter((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean");
  if (!vals.length) return;
  if (vals.every((x) => typeof x === "string")) { out.enum = vals; return; }
  out.__enumNote = `Allowed values: ${vals.map((x) => JSON.stringify(x)).join(", ")}.`;
}
/** oneOf/anyOf branches -> ONE object schema: union of properties (first wins), required = intersection of the branches' required. */
function mergeBranches(branches: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const objs = branches.filter((b) => b.properties && typeof b.properties === "object");
  if (!objs.length) return undefined;
  const properties: Record<string, unknown> = {};
  for (const b of objs) for (const [k, v] of Object.entries(b.properties as object)) if (!(k in properties)) properties[k] = v;
  let req: string[] | null = null;
  for (const b of objs) { const r = Array.isArray(b.required) ? (b.required as string[]) : []; req = req === null ? [...r] : req.filter((x) => r.includes(x)); }
  return { type: "object", properties, ...(req && req.length ? { required: req } : {}) };
}
export function sanitizeSchema(s: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!s || typeof s !== "object" || Array.isArray(s) || depth > 12) return undefined;
  const src = s as Record<string, any>, out: Record<string, unknown> = {};
  let type = src.type;
  if (Array.isArray(type)) { const t = type.filter((x) => typeof x === "string" && x !== "null"); if (type.includes("null")) out.nullable = true; type = t[0]; }
  if (typeof type === "string") out.type = type.toLowerCase();
  if (src.const !== undefined && src.enum === undefined) enumOf([src.const], out);
  for (const [k, v] of Object.entries(src)) {
    if (!KEEP.has(k) || k === "type" || k === "title") continue;
    if (k === "properties" && v && typeof v === "object") { const p: Record<string, unknown> = {}; for (const [pk, pv] of Object.entries(v)) { const c = sanitizeSchema(pv, depth + 1); if (c) p[pk] = c; } out.properties = p; }
    else if (k === "items") { const c = sanitizeSchema(v, depth + 1); if (c) out.items = c; }
    else if (k === "anyOf" && Array.isArray(v)) { const a = v.map((x) => sanitizeSchema(x, depth + 1)).filter((x): x is Record<string, unknown> => !!x); if (a.length) out.anyOf = a; }
    else if (k === "required" && Array.isArray(v)) out.required = v.filter((x) => typeof x === "string");
    else if (k === "enum" && Array.isArray(v)) enumOf(v, out);
    else if (k === "nullable") { if (v === true) out.nullable = true; }
    else out[k] = v;
  }
  if (src.oneOf && Array.isArray(src.oneOf) && !out.anyOf) { const a = src.oneOf.map((x: unknown) => sanitizeSchema(x, depth + 1)).filter((x: unknown): x is Record<string, unknown> => !!x); if (a.length) out.anyOf = a; }
  if (out.__enumNote) { out.description = [typeof out.description === "string" ? out.description : "", out.__enumNote].filter(Boolean).join(" "); delete out.__enumNote; }
  if (out.type === undefined && out.properties) out.type = "object";
  // `required` may only name declared properties (Gemini 400s otherwise)
  if (Array.isArray(out.required) && out.properties) { const known = new Set(Object.keys(out.properties as object)); out.required = (out.required as string[]).filter((r) => known.has(r)); if (!(out.required as string[]).length) delete out.required; }
  return out;
}
const toDeclaration = (t: any) => {
  let params = sanitizeSchema(t?.input_schema);
  // a top-level oneOf/anyOf is merged into one object schema (Gemini wants an object with properties at the root)
  if (params && Array.isArray(params.anyOf) && !params.properties) { const m = mergeBranches(params.anyOf as Array<Record<string, unknown>>); if (m) { const { anyOf: _a, ...rest } = params; params = { ...rest, ...m }; } }
  // an object with no properties is a no-argument function: Gemini wants `parameters` omitted, not an empty object
  const hasProps = params && params.type === "object" && params.properties && Object.keys(params.properties as object).length > 0;
  return { name: String(t?.name ?? ""), description: String(t?.description ?? ""), ...(hasProps ? { parameters: params } : {}) };
};

// ---- thought signatures ride inside the tool_use id (stateless: the stored assistant turn carries them back to us) ----
const SIG_SEP = "__gsig_";
const toB64Url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64Url = (s: string) => { const b = s.replace(/-/g, "+").replace(/_/g, "/"); return b + "=".repeat((4 - (b.length % 4)) % 4); };
/** Tool-call id seen by the app: the provider's call id (or a counter) plus the signature, in the [A-Za-z0-9_-] alphabet every tool_use id must use. */
export const packCallId = (id: string, signature: string | undefined) => {
  let sig = ""; try { if (signature) sig = SIG_SEP + toB64Url(btoa(signature)); } catch { /* a non-latin1 signature cannot be carried: sent without (the API says so plainly) */ }
  return `${id.replace(/[^A-Za-z0-9_-]/g, "_")}${sig}`;
};
export const unpackCallId = (id: string): { id: string; signature?: string } => {
  const i = id.indexOf(SIG_SEP); if (i < 0) return { id };
  try { return { id: id.slice(0, i), signature: atob(fromB64Url(id.slice(i + SIG_SEP.length))) }; } catch { return { id: id.slice(0, i) }; }
};

// ---- request ----
const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");
interface Content { role: "user" | "model"; parts: any[] }
const isFnResponseOnly = (c: Content) => c.parts.length > 0 && c.parts.every((p) => p.functionResponse);

/** Anthropic Messages body -> Gemini `contents` + systemInstruction. Thinking blocks are NEVER sent back (reasoning is shown, not replayed). Adjacent same-role turns are merged
 *  (Gemini needs alternation); a tool_result becomes a functionResponse named after the tool_use it answers. */
export function toGeminiContents(body: any): { contents: Content[]; system: string } {
  const sys = Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? "").filter(Boolean).join("\n\n") : typeof body.system === "string" ? body.system : "";
  const contents: Content[] = [], names = new Map<string, string>();
  const push = (role: Content["role"], parts: any[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts: [...parts] });
  };
  for (const m of body.messages ?? []) {
    const blocks: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
    if (m.role === "assistant") {
      const parts: any[] = [];
      for (const b of blocks) if (b.type === "text" && b.text) parts.push({ text: b.text });
      for (const b of blocks) if (b.type === "tool_use") {
        const u = unpackCallId(String(b.id ?? "")); names.set(String(b.id ?? ""), String(b.name ?? ""));
        parts.push({ functionCall: { name: String(b.name ?? ""), args: b.input && typeof b.input === "object" ? b.input : {} }, ...(u.signature ? { thoughtSignature: u.signature } : {}) });
      }
      push("model", parts);
      continue;
    }
    const parts: any[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") parts.push({ functionResponse: { name: names.get(String(b.tool_use_id ?? "")) ?? "tool", response: b.is_error ? { error: textOf(b.content) || "error" } : { output: textOf(b.content) } } });
      else if (b.type === "text") { if (b.text) parts.push({ text: b.text }); }
      else if (b.type === "image" && b.source?.type === "base64") parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
    }
    push("user", parts);
  }
  return { contents, system: sys };
}

/** Rough input-token estimate for trimming (deliberately high: ~3 chars/token, a fixed ~1100 per image as measured on Gemini). */
export function estimateTokens(c: Content[], system = ""): number {
  let n = Math.ceil(system.length / 3);
  for (const x of c) for (const p of x.parts) n += p.text ? Math.ceil(p.text.length / 3) : p.inlineData ? 1100 : Math.ceil(JSON.stringify(p.functionCall ?? p.functionResponse ?? {}).length / 3);
  return n;
}
/** Drop the oldest turns until the estimate fits `budget` (input tokens). Keeps the newest turn whatever its size and never starts on a model turn or an orphaned tool result. */
export function trimToBudget(contents: Content[], system: string, budget: number): Content[] {
  const c = [...contents];
  while (c.length > 1 && estimateTokens(c, system) > budget) c.shift();
  while (c.length > 1 && (c[0]!.role !== "user" || isFnResponseOnly(c[0]!))) c.shift();
  return c;
}

export function toGeminiRequest(body: any, row: ConfiguredModel | undefined): Record<string, unknown> {
  let { contents, system } = toGeminiContents(body);
  const tpm = row?.limits?.tpm;
  // a model flagged short-context has a tiny per-minute INPUT limit: send only what fits (75% of it, a reply is not input)
  if (row?.extra?.shortContext === true && tpm) contents = trimToBudget(contents, system, Math.floor(tpm * 0.75));
  const decls = Array.isArray(body.tools) ? body.tools.map(toDeclaration).filter((d: { name: string }) => d.name) : [];
  const cap = row?.maxOutput;
  const max = typeof body.max_tokens === "number" ? (cap ? Math.min(body.max_tokens, cap) : body.max_tokens) : undefined;
  const gen: Record<string, unknown> = { ...(max ? { maxOutputTokens: max } : {}), ...(row?.extra?.thinking === true ? { thinkingConfig: { includeThoughts: true } } : {}) };
  return { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), ...(decls.length ? { tools: [{ functionDeclarations: decls }] } : {}), ...(Object.keys(gen).length ? { generationConfig: gen } : {}) };
}

// ---- response stream -> Anthropic SSE ----
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "LANGUAGE"]);
export function toAnthropicStream(upstream: ReadableStream<Uint8Array>, model: string, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder(), dec = new TextDecoder();
  return new ReadableStream({
    async start(ctl) {
      const send = (ev: unknown) => ctl.enqueue(enc.encode(`event: ${(ev as any).type}\ndata: ${JSON.stringify(ev)}\n\n`));
      const reader = upstream.getReader();
      let idx = -1, textIdx = -1, thinkIdx = -1, started = false, failed = false, calls = 0, callTag = Math.random().toString(36).slice(2, 8), finish: string | null = null, blocked: string | null = null, usage: any = null, produced = false;
      const opened: number[] = [];
      const start = () => { if (!started) { started = true; send({ type: "message_start", message: { id: `msg_${model}`, model, usage: { input_tokens: 0, output_tokens: 0 } } }); } };
      const fail = (message: string, type = "api_error") => { failed = true; start(); send({ type: "error", error: { type, message: message.slice(0, 300) } }); };
      const onAbort = () => void reader.cancel().catch(() => {});
      signal?.addEventListener("abort", onAbort, { once: true });
      let buf = "";
      const handle = (data: string) => {
        let j: any; try { j = JSON.parse(data); } catch { return; }
        if (j?.error) { fail(String(j.error.message ?? "provider error"), j.error.status === "RESOURCE_EXHAUSTED" ? "rate_limit_error" : "api_error"); return; }
        start();
        if (j.usageMetadata) usage = j.usageMetadata; // cumulative: the last chunk wins, never summed
        if (j.promptFeedback?.blockReason) blocked = String(j.promptFeedback.blockReason);
        const cand = j.candidates?.[0]; if (!cand) return;
        for (const p of cand.content?.parts ?? []) {
          if (p?.functionCall) {
            produced = true;
            const i = ++idx; opened.push(i);
            send({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: packCallId(String(p.functionCall.id ?? `call_${callTag}_${calls}`), typeof p.thoughtSignature === "string" ? p.thoughtSignature : undefined), name: String(p.functionCall.name ?? ""), input: {} } });
            send({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(p.functionCall.args ?? {}) } });
            calls++; continue;
          }
          if (typeof p?.text !== "string" || !p.text) continue; // an empty text part (it only carries the signature) is not content
          if (p.thought === true) {
            if (thinkIdx < 0) { thinkIdx = ++idx; opened.push(thinkIdx); send({ type: "content_block_start", index: thinkIdx, content_block: { type: "thinking", thinking: "" } }); }
            send({ type: "content_block_delta", index: thinkIdx, delta: { type: "thinking_delta", thinking: p.text } });
          } else {
            produced = true;
            if (textIdx < 0) { textIdx = ++idx; opened.push(textIdx); send({ type: "content_block_start", index: textIdx, content_block: { type: "text", text: "" } }); }
            send({ type: "content_block_delta", index: textIdx, delta: { type: "text_delta", text: p.text } });
          }
        }
        if (typeof cand.finishReason === "string" && cand.finishReason !== "FINISH_REASON_UNSPECIFIED") finish = cand.finishReason;
      };
      try {
        for (;;) {
          const { done, value } = await reader.read().catch((e) => { throw new ProviderNetworkError(`stream read failed: ${e instanceof Error ? e.message : String(e)}`); }); // an upstream body failure is a connection failure (marked here, by the adapter)
          if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); const l = c.split("\n").find((x) => x.startsWith("data:")); if (l) handle(l.slice(5).trim()); }
        }
        const tail = buf.split("\n").find((x) => x.startsWith("data:")); if (tail) handle(tail.slice(5).trim());
        start();
        if (failed) return;
        if (finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL") { fail("The model produced an invalid tool call. Try again."); return; }
        // MAX_TOKENS can arrive with NO content at all (thinking spent the whole output budget): say so plainly instead of an empty answer
        if (!produced && finish === "MAX_TOKENS") { fail("The model used its whole output budget on thinking and gave no answer. Try again or ask for something shorter."); return; }
        if (!produced && !blocked && !(finish && BLOCKED.has(finish))) { fail("The model returned an empty answer. Try again."); return; }
        for (const i of opened) send({ type: "content_block_stop", index: i });
        const stop = blocked || (finish && BLOCKED.has(finish)) ? "refusal" : finish === "MAX_TOKENS" ? "max_tokens" : calls > 0 ? "tool_use" : "end_turn";
        const cached = Number(usage?.cachedContentTokenCount ?? 0) || 0;
        // output = answer + thought tokens (thoughts are billed as output and are reported separately)
        send({ type: "message_delta", delta: { stop_reason: stop }, usage: { input_tokens: Math.max(0, Number(usage?.promptTokenCount ?? 0) - cached), output_tokens: (Number(usage?.candidatesTokenCount ?? 0) || 0) + (Number(usage?.thoughtsTokenCount ?? 0) || 0), cache_read_input_tokens: cached } });
        send({ type: "message_stop" });
      } catch (e) {
        if (!signal?.aborted) { start(); send({ type: "error", error: { type: e instanceof ProviderNetworkError ? "network_error" : "api_error", message: `stream dropped: ${e instanceof Error ? e.message : String(e)}` } }); }
      } finally { signal?.removeEventListener("abort", onAbort); ctl.close(); }
    },
  });
}

// ---- errors ----
/** Seconds to wait before retrying a 429: RetryInfo.retryDelay ("39s", "39.2s"), else the "retry in 39.2s" text, else Retry-After. undefined = no hint. */
export function retryHintS(body: any, retryAfter?: string | null): number | undefined {
  const details: any[] = Array.isArray(body?.error?.details) ? body.error.details : [];
  const ri = details.find((d) => typeof d?.retryDelay === "string")?.retryDelay as string | undefined;
  const raw = ri ?? /retry in ([\d.]+)\s*s/i.exec(String(body?.error?.message ?? ""))?.[1] ?? retryAfter ?? "";
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}
const quotaOf = (body: any): string => JSON.stringify(body?.error?.details ?? "") + String(body?.error?.message ?? "");
const hintOf = (row?: ConfiguredModel) => { const l = row?.limits; return l?.rpm || l?.rpd ? ` Free tier for this model: about ${[l.rpm ? `${l.rpm}/min` : "", l.rpd ? `${l.rpd}/day` : ""].filter(Boolean).join(", ")}.` : ""; };
/** HTTP failure -> ProviderError with a user-safe message (a short `message` only, never the key or the request). */
export function geminiError(status: number, body: any, retryAfter?: string | null, row?: ConfiguredModel): ProviderError {
  const e = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error : {};
  const msg = typeof e.message === "string" ? e.message.slice(0, 200) : "";
  const reasons = JSON.stringify(e.details ?? "");
  if (status === 429) {
    const ra = retryHintS(body, retryAfter), daily = /PerDay|per_day|RequestsPerDay/i.test(quotaOf(body));
    const when = daily ? " The daily free quota is used up (it resets at midnight Pacific time)." : ra ? ` Try again in about ${ra}s.` : " Wait a moment and send again.";
    return new ProviderError(`Google AI Studio rate limit reached.${when}${hintOf(row)}`, 429, { type: "rate_limit_error", retryable: !daily, retryAfterS: daily ? undefined : ra });
  }
  if (status === 413) return new ProviderError("The conversation or attachment is too large for this model on the free tier. Start a new chat, shorten it, or remove the attachment.", 413, { type: "invalid_request_error" });
  if (status === 401 || status === 403 || (status === 400 && /API_KEY_INVALID|API key not valid/i.test(reasons + msg))) return new ProviderError("Google AI Studio rejected your API key: check or re-enter it in Settings > Providers.", 502, { type: "authentication_error" });
  if (status === 400 && /location is not supported/i.test(msg)) return new ProviderError("Google blocks AI Studio from the region this chat runs in (\"User location is not supported\"). Pick a model from another provider, or start a new chat and try again.", 400, { type: "invalid_request_error", retryable: false });
  if (status === 410) return new ProviderError("That model is no longer available from Google AI Studio (end of life).", 410, { type: "not_found_error" });
  if (status === 404) return new ProviderError(`That model is not available from Google AI Studio${msg ? `: ${msg}` : "."}`, 404, { type: "not_found_error" });
  if (status === 408 || status === 504) return new ProviderError("Google AI Studio timed out.", status, { type: "upstream_timeout", retryable: true });
  if (status >= 500) return new ProviderError(`Google AI Studio failed (${status}).`, status, { type: "api_error", retryable: true });
  return new ProviderError(`Google AI Studio rejected the request${msg ? `: ${msg}` : ` (${status}).`}`, 400, { type: "invalid_request_error" });
}
const parse = (t: string): unknown => { try { return JSON.parse(t); } catch { return null; } };

// ---- model discovery ----
/** GET <base>/models: the ids that can chat (generateContent + not a TTS / image / live / embedding / robotics / ... name). Ids only: nothing is called. A listed id can still 404 (retired). */
export async function listGeminiModels(cfg: ProviderConfig, env: Env, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<string[]> {
  const key = await keyOf(cfg, env);
  if (!cfg.baseUrl || !key) throw new ProviderError("This provider has no key configured.", 503, { type: "api_error" });
  const ids: string[] = []; let page = "";
  for (let n = 0; n < 5; n++) {
    let res: Response;
    try { res = await fetchImpl(`${cfg.baseUrl}/models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { method: "GET", redirect: "manual", headers: { accept: "application/json", ...authHeaders(cfg, key) } }); }
    catch { throw new ProviderError("Could not reach the provider.", 502, { type: "api_error", retryable: true }); }
    if (isRedirect(res.status)) { await res.body?.cancel().catch(() => {}); throw new ProviderError("The provider tried to redirect the request, which is not followed.", 502, { type: "api_error" }); }
    if (!res.ok) throw geminiError(res.status, parse(await readCappedText(res)), res.headers.get("retry-after"));
    const j: any = parse(await readCappedText(res, MAX_LIST_BODY));
    if (!j || typeof j !== "object") throw new ProviderError("The provider returned an unreadable model list.", 502, { type: "api_error" });
    for (const m of Array.isArray(j.models) ? j.models : []) {
      const id = typeof m?.name === "string" ? m.name.replace(/^models\//, "") : "";
      if (!id || id.length > 120 || /\s/.test(id) || !Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes("generateContent")) continue;
      if (discoveredKind(AISTUDIO_DESCRIPTOR, id) === "skip") continue;
      ids.push(id);
    }
    page = typeof j.nextPageToken === "string" ? j.nextPageToken : ""; if (!page) break;
  }
  return [...new Set(ids)].slice(0, 500);
}

export function geminiProvider(cfg: ProviderConfig, env: Env, fetchImpl: FetchLike = (u, i) => fetch(u, i), sleep: (ms: number) => Promise<void> = defaultSleep): ModelProvider {
  const broken = () => new Set(cfg.broken ?? []);
  const models = (): ProviderModel[] => cfg.models.filter((m) => !broken().has(m.id)).map((m) => ({ id: m.id, displayName: m.displayName, capabilities: m.capabilities, pricePerMTok: m.pricePerMTok, contextWindow: m.contextWindow, maxTokens: m.maxTokens, maxOutput: m.maxOutput }));
  return {
    name: cfg.id, id: cfg.id,
    async listModels(kind?: ModelKind) { return !kind || kind === "chat" ? models() : []; },
    async messages(body: any, signal?: AbortSignal): Promise<Response> {
      const id = String(body?.model ?? "");
      // only a catalog model is ever put into the URL (a listed-but-unoffered id, e.g. a 0-quota model, never reaches Google)
      const row = cfg.models.find((m) => m.id === id);
      if (!row || broken().has(id)) throw new ProviderError("That model is not available from Google AI Studio.", 404, { type: "not_found_error" });
      const key = await keyOf(cfg, env);
      if (!cfg.baseUrl || !key) throw new ProviderError("This provider has no key configured.", 503, { type: "api_error" });
      const payload = JSON.stringify(toGeminiRequest(body, row));
      const send = async () => { try { return await fetchImpl(`${cfg.baseUrl}/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`, { method: "POST", redirect: "manual", signal, body: payload, headers: { "content-type": "application/json", ...authHeaders(cfg, key) } }); } catch (e) { if (signal?.aborted) throw e; throw new ProviderNetworkError(); } };
      let res: Response;
      try {
        res = await send();
        // Rate limit: ONE short retry, only when Google says a few seconds (never for the daily quota), never a loop.
        if (res.status === 429) {
          const t = await readCappedText(res), j = parse(t), ra = retryHintS(j, res.headers.get("retry-after"));
          if (/PerDay|per_day|RequestsPerDay/i.test(quotaOf(j)) || (ra ?? 2) * 1000 > MAX_RETRY_WAIT_MS) throw geminiError(429, j, res.headers.get("retry-after"), row);
          await sleep((ra ?? 2) * 1000); if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          res = await send();
        }
      } catch (e) {
        throw e; // a rejected fetch is already a ProviderNetworkError (send)
      }
      if (isRedirect(res.status)) { await res.body?.cancel().catch(() => {}); throw new ProviderError("The provider tried to redirect the request, which is not followed.", 502, { type: "api_error" }); }
      if (!res.ok) {
        // errors arrive as a plain JSON body whatever the content type
        const j = parse(await readCappedText(res));
        if ((res.status === 404 || res.status === 410) && id) { try { cfg.onBroken?.(id); } catch { /* best effort */ } }
        throw geminiError(res.status, j, res.headers.get("retry-after"), row);
      }
      if (!res.body) throw new ProviderError("The provider returned an empty response.", 502, { type: "api_error" });
      return new Response(toAnthropicStream(res.body, id, signal), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  };
}
