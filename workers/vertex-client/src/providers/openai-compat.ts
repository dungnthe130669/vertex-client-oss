// Adapter for any OpenAI chat-completions style endpoint. The app speaks Anthropic Messages internally, so this maps the request
// (system/messages/tools) to chat-completions and the SSE answer back to Anthropic stream events. Key + base URL come from a config:
// the key is read from env[config.keyBinding] at call time and is only ever placed in the Authorization header (never logged/returned).
import { NO_CAPABILITIES, ProviderError, ProviderNetworkError, type ImageRequest, type ImageResult, type ModelKind, type ModelProvider, type ProviderModel } from "./types";
import { NVIDIA_GENAI_BASE, NVIDIA_IMAGE_DIMS, NVIDIA_IMAGE_MODELS } from "./presets";
import { workerKeyAllowed, isNvidiaPresetBase, isPresetBase, type ProviderConfig } from "./config";
import { descriptorOf, type ChatDialect } from "./descriptor";
import { capImages, fitToBudget } from "./chat-budget";
import { TITLE_OPEN, TITLE_CLOSE, MAX_HOLD } from "../inline-title";

const MAX_RETRY_WAIT_MS = 2000;

type Env = Record<string, unknown>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_ERR_BODY = 64 * 1024;

/** Output cap for a model row that states no maxOutput (the Agent SDK asks for 128000, which most providers 400). */
export const DEFAULT_MAX_OUTPUT = 32768;
/** The output cap a 400 attributes to max_tokens / max_completion_tokens / output tokens ("max_tokens must be <= 8192", "supports at most 4096 completion tokens",
 *  vLLM "maximum context length is 8192 tokens ... prompt contains 3000"), or null unless it is a positive integer in [256, sent). A number tied to anything else
 *  ("Invalid max_tokens; rate limit is 1000") is not a cap and never triggers a retry. */
export function capFromError(body: any, sent: number): number | null {
  const m = typeof body?.error?.message === "string" ? body.error.message : typeof body?.message === "string" ? body.message : "";
  const g = (re: RegExp) => /^\d+$/.test(re.exec(m)?.[1] ?? "") ? Number(re.exec(m)![1]) : null;
  let n = g(/max(?:_completion)?_tokens[^.;:\d]{0,40}?(?:<=|≤|at most|less than or equal to|no more than|maximum(?: value)? (?:is|of)|up to)\s*:?\s*(\d+)/i)
    ?? g(/(?:at most|no more than|up to|maximum of)\s+(\d+)\s+(?:completion|output|max)[ _]?tokens/i)
    ?? g(/maximum (?:number of )?(?:output|completion) tokens(?: allowed)?(?: is| of)?\s*:?\s*(\d+)/i);
  if (n === null) { // context-length phrasing: the room left for output is the context window minus the prompt
    const ctx = g(/maximum context length is\s+(\d+)\s+tokens/i), prompt = g(/(\d+)\s+in the messages/i) ?? g(/prompt (?:contains|has|is)\s+(\d+)\s+tokens/i) ?? g(/your messages? resulted in\s+(\d+)\s+tokens/i);
    if (ctx !== null && prompt !== null) n = ctx - prompt;
  }
  return n !== null && Number.isInteger(n) && n >= 256 && n < sent ? n : null;
}

/** "Please try again in 37.7925s" / "14m23.5s" / "877ms" in a provider's error text -> whole seconds (rounded up), or undefined. */
export function retryHintS(message: unknown): number | undefined {
  const m = /try again in\s+((?:\d+(?:\.\d+)?h)?(?:\d+(?:\.\d+)?m(?!s))?(?:\d+(?:\.\d+)?s)?(?:\d+(?:\.\d+)?ms)?)/i.exec(typeof message === "string" ? message : "");
  if (!m?.[1]) return undefined;
  const g = (re: RegExp) => Number(re.exec(m[1]!)?.[1] ?? 0);
  const sec = g(/(\d+(?:\.\d+)?)h/) * 3600 + g(/(\d+(?:\.\d+)?)m(?!s)/) * 60 + g(/(\d+(?:\.\d+)?)s/) + g(/(\d+(?:\.\d+)?)ms/) / 1000;
  return sec > 0 ? Math.ceil(sec) : undefined;
}

/** HTTP failure -> ProviderError with a user-safe message (never echoes the upstream body beyond a short `message`). */
export function openaiError(status: number, body: any, retryAfter?: string | null): ProviderError {
  const e = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error : {};
  const msg = typeof e.message === "string" ? e.message.slice(0, 200) : "";
  const ra = Number(retryAfter) > 0 ? Number(retryAfter) : retryHintS(e.message);
  if (status === 413) return new ProviderError("This request is too large for the provider's limit.", 413, { type: "invalid_request_error", retryable: false });
  if (status === 429) return new ProviderError(`The provider is rate limited${ra ? `. Try again in about ${ra}s` : ""}.`, 429, { type: "rate_limit_error", retryable: true, retryAfterS: ra });
  if (status === 401 || status === 403) return new ProviderError("The provider rejected this app's credentials.", 502, { type: "authentication_error" });
  if (status === 410) return new ProviderError("That model is no longer available from this provider (end of life).", 410, { type: "not_found_error" });
  if (status === 404) return new ProviderError(`That model is not available from this provider${msg ? `: ${msg}` : "."}`, 404, { type: "not_found_error" });
  if (status === 408 || status === 504) return new ProviderError("The provider timed out.", status, { type: "upstream_timeout", retryable: true });
  if (status >= 500) return new ProviderError(`The provider failed (${status}).`, status, { type: "api_error", retryable: true });
  return new ProviderError(`The provider rejected the request${msg ? `: ${msg}` : ` (${status}).`}`, 400, { type: "invalid_request_error" });
}

/** JSON-Schema meta keys strict providers reject in tool parameters. */
const SCHEMA_META = new Set(["$schema", "$id", "$comment", "$anchor", "$dynamicRef", "$dynamicAnchor", "$vocabulary"]);
/** Keywords whose value is a map name -> schema (names are user data: keep them, clean only the values). */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
/** Keywords whose value is literal data, never a schema. */
const LITERAL_KEYS = new Set(["default", "const", "enum", "examples", "dependentRequired"]);
export function cleanSchema(v: any): any {
  if (Array.isArray(v)) return v.map(cleanSchema);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (SCHEMA_META.has(k)) continue;
      if (LITERAL_KEYS.has(k)) o[k] = x;
      else if (SCHEMA_MAPS.has(k) && x && typeof x === "object" && !Array.isArray(x)) o[k] = Object.fromEntries(Object.entries(x).map(([n, sch]) => [n, cleanSchema(sch)]));
      else o[k] = cleanSchema(x);
    }
    return o;
  }
  return v;
}
const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");

/** Anthropic Messages request body -> chat-completions body. cache_control / thinking are dropped (no such concept here). */
export interface ChatRequestOpts {
  /** `max_tokens` (default) or `max_completion_tokens` */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** send text-only content as one string (text-only models reject array content) */
  flattenText?: boolean;
  /** never allow parallel tool calls (`parallel_tool_calls:false`, only sent with tools) */
  noParallelTools?: boolean;
  /** `reasoning_effort` (only for a model that reasons) */
  reasoningEffort?: string;
  /** request fields the provider rejects */
  deny?: string[];
}
export function toChatRequest(body: any, model: string, o: ChatRequestOpts = {}): Record<string, unknown> {
  const messages: any[] = [];
  const sys = Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? "").filter(Boolean).join("\n\n") : typeof body.system === "string" ? body.system : "";
  if (sys) messages.push({ role: "system", content: sys });
  // mid-conversation role:"system" messages (Agent SDK beta) are folded into a neighbouring user message, never sent as their own turn
  let pendingSys: string[] = [];
  const addToUser = (msg: any, texts: string[]) => { const t = texts.join("\n"); if (typeof msg.content === "string") msg.content = `${msg.content}\n${t}`; else msg.content = [...msg.content, { type: "text", text: t }]; };
  const flushSys = () => { if (pendingSys.length) { messages.push({ role: "user", content: pendingSys.join("\n") }); pendingSys = []; } };
  for (const m of body.messages ?? []) {
    const blocks: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
    if (m.role === "system") {
      const t = textOf(m.content); if (!t) continue;
      const last = messages[messages.length - 1];
      if (last?.role === "user" && !pendingSys.length) addToUser(last, [t]); else pendingSys.push(t);
      continue;
    }
    if (m.role === "assistant") {
      flushSys();
      const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (t || calls.length) messages.push({ role: "assistant", content: t || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const parts: any[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") { messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: textOf(b.content) || (b.is_error ? "error" : "") }); continue; }
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image" && b.source?.type === "base64") parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
    if (pendingSys.length) { parts.unshift({ type: "text", text: pendingSys.join("\n") }); pendingSys = []; }
    if (parts.length) {
      const content = parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : o.flattenText && !parts.some((p) => p.type === "image_url") ? parts.map((p) => p.text).join("\n") : parts;
      const last = messages[messages.length - 1];
      if (last?.role === "user") { // consecutive user turns merge (some providers reject them); images and text are kept, in order
        if (typeof last.content === "string" && typeof content === "string") last.content = `${last.content}\n${content}`;
        else last.content = [...(typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content), ...parts];
      }
      else messages.push({ role: "user", content });
    }
  }
  flushSys();
  const tools = Array.isArray(body.tools) && body.tools.length
    ? body.tools.map((t: any) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: cleanSchema(t.input_schema) ?? { type: "object", properties: {} } } })) : undefined;
  // Anthropic tool_choice -> chat-completions (only with tools): any -> "required", tool -> a named function, auto/none as is. Anything else is not sent.
  const tc = body.tool_choice?.type, toolChoice = !tools ? undefined : tc === "any" ? "required" : tc === "auto" ? "auto" : tc === "none" ? "none" : tc === "tool" && typeof body.tool_choice.name === "string" ? { type: "function", function: { name: body.tool_choice.name } } : undefined;
  const req: Record<string, unknown> = { model, messages, stream: true, stream_options: { include_usage: true }, ...(body.max_tokens ? { [o.maxTokensParam ?? "max_tokens"]: body.max_tokens } : {}), ...(tools ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}), ...(o.noParallelTools ? { parallel_tool_calls: false } : {}) } : {}), ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}) };
  for (const k of o.deny ?? []) delete req[k];
  return req;
}

const STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };

/** Head of a reply (whitespace trimmed to <= THINK_WS by the caller): "more" = undecided, "text" = not a leading think tag, else the think tag found at `at` and the text
 *  to emit first (`pre`: a leading title marker passes through untouched; whitespace before a bare tag is dropped). One leading <vc-title> marker is transparent. */
function decideHead(h: string): "more" | "text" | { pre: string; close: string; at: number } {
  let i = /^\s*/.exec(h)![0].length, pre = "";
  const startsAt = (s: string, k: number) => h.startsWith(s, k);
  const rest = h.slice(i);
  if (startsAt(TITLE_OPEN, i)) {
    const c = rest.indexOf(TITLE_CLOSE);
    if (c < 0) return rest.length < MAX_HOLD + TITLE_CLOSE.length ? "more" : "text";
    if (c > MAX_HOLD) return "text";
    i += c + TITLE_CLOSE.length; pre = h.slice(0, i);
    const g = /^\s*/.exec(h.slice(i))![0].length;
    if (g > THINK_WS) return "text";
    i += g;
  } else if (rest && TITLE_OPEN.startsWith(rest)) return "more";
  const tail = h.slice(i), m = /^<(think|thinking)>/.exec(tail);
  if (m) return { pre, close: `</${m[1]}>`, at: i + m[0].length };
  if (pre && !tail) return "more";
  return tail.length <= THINK_HEAD && THINK_TAGS.some((x) => x.startsWith(tail)) ? "more" : "text";
}
const THINK_TAGS = ["<think>", "<thinking>"], THINK_HEAD = 12, THINK_WS = 64;

/** chat-completions SSE -> Anthropic SSE. Text is block 0; each tool call gets its own tool_use block in arrival order. */
export function toAnthropicStream(upstream: ReadableStream<Uint8Array>, model: string, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder(), dec = new TextDecoder();
  return new ReadableStream({
    async start(ctl) {
      const send = (ev: unknown) => ctl.enqueue(enc.encode(`event: ${(ev as any).type}\ndata: ${JSON.stringify(ev)}\n\n`));
      const reader = upstream.getReader();
      let idx = -1, textIdx = -1, thinkIdx = -1, started = false, failed = false, stop: string | null = null, usage: any = null;
      const tools = new Map<number, number>(); // upstream tool_call index -> our block index
      const opened: number[] = []; // every block is stopped at the end; deltas carry their own index, so interleaving is fine
      const start = () => { if (!started) { started = true; send({ type: "message_start", message: { id: `msg_${model}`, model, usage: { input_tokens: 0, output_tokens: 0 } } }); } };
      const onAbort = () => void reader.cancel().catch(() => {});
      signal?.addEventListener("abort", onAbort, { once: true });
      const thinkDelta = (t: string) => {
        if (!t) return;
        if (thinkIdx < 0) { thinkIdx = ++idx; opened.push(thinkIdx); send({ type: "content_block_start", index: thinkIdx, content_block: { type: "thinking", thinking: "" } }); }
        send({ type: "content_block_delta", index: thinkIdx, delta: { type: "thinking_delta", thinking: t } });
      };
      const textDelta = (t: string) => {
        if (!t) return;
        if (textIdx < 0) { textIdx = ++idx; opened.push(textIdx); send({ type: "content_block_start", index: textIdx, content_block: { type: "text", text: "" } }); }
        send({ type: "content_block_delta", index: textIdx, delta: { type: "text_delta", text: t } });
      };
      // A reply that STARTS (after whitespace) with <think>/<thinking> is reasoning the model wrote into `content`: it goes to the thinking block up to the matching
      // close tag, the rest is text. Only the head of the response is looked at (<= THINK_HEAD chars held to decide); a later "<think>" in a real answer is untouched.
      // hold = the undecided head (leading whitespace, at most ONE <vc-title>…</vc-title> marker, whitespace, the start of a think tag), see decideHead. Leading whitespace
      // beyond THINK_WS is released as text (oldest first) and detection continues, so memory stays bounded and the result never depends on how the stream was chunked.
      // csep = the separator after a close tag still to consume (1: spaces/tabs then ONE newline; 2: a lone CR was seen, a following LF belongs to it).
      let cmode: "head" | "think" | "text" = "head", hold = "", cclose = "", cheld = "", csep = 0;
      const content = (t: string) => {
        for (;;) {
          if (cmode === "text") {
            if (csep === 2) { csep = 0; if (t.startsWith("\n")) t = t.slice(1); else textDelta("\r"); }
            else if (csep === 1) {
              t = t.replace(/^[ \t]+/, ""); if (!t) return;
              csep = 0;
              if (t === "\r") { csep = 2; return; }
              t = t.replace(/^\r?\n/, "");
            }
            textDelta(t); return;
          }
          if (cmode === "head") {
            hold += t; t = "";
            const w = /^\s*/.exec(hold)![0].length;
            if (w > THINK_WS) { textDelta(hold.slice(0, w - THINK_WS)); hold = hold.slice(w - THINK_WS); }
            const r = decideHead(hold);
            if (r === "more") return;
            if (r === "text") { cmode = "text"; t = hold; hold = ""; continue; }
            textDelta(r.pre); cmode = "think"; cclose = r.close; t = hold.slice(r.at); hold = ""; continue;
          }
          // think: emit up to the close tag, hold a tail that may be the start of it
          const s = cheld + t; cheld = "";
          const at = s.indexOf(cclose);
          if (at >= 0) { thinkDelta(s.slice(0, at)); cmode = "text"; csep = 1; t = s.slice(at + cclose.length); if (!t) return; continue; }
          let keep = 0; for (let k = Math.min(cclose.length - 1, s.length); k > 0; k--) if (cclose.startsWith(s.slice(s.length - k))) { keep = k; break; }
          thinkDelta(s.slice(0, s.length - keep)); cheld = s.slice(s.length - keep); return;
        }
      };
      /** end of the content stream (finish, tool call, end of body): whatever is still held is released where it belongs */
      const endContent = () => {
        if (cmode === "head") { const h = hold; hold = ""; cmode = "text"; textDelta(h); }
        else if (cmode === "think" && cheld) { const h = cheld; cheld = ""; thinkDelta(h); }
      };
      let buf = "";
      const handle = (data: string) => {
        if (data === "[DONE]") return;
        let j: any; try { j = JSON.parse(data); } catch { return; }
        if (j.error) { failed = true; start(); endContent(); /* a held head is partial visible text: it goes out before the error */ send({ type: "error", error: { type: "api_error", message: String(j.error.message ?? "provider error").slice(0, 200) } }); return; }
        start();
        if (j.usage) usage = j.usage; else if (j.x_groq?.usage && !usage) usage = j.x_groq.usage;
        const ch = j.choices?.[0]; if (!ch) return;
        const d = ch.delta ?? {};
        // reasoning models stream their thinking as reasoning_content (NVIDIA/DeepSeek) or reasoning (others): keep it as a thinking block, never drop it
        const rs = typeof d.reasoning_content === "string" && d.reasoning_content ? d.reasoning_content : typeof d.reasoning === "string" ? d.reasoning : "";
        if (rs) {
          if (cmode === "head") endContent(); // structured reasoning exists: content is the answer as-is, never tag-inferred
          if (thinkIdx < 0) { thinkIdx = ++idx; opened.push(thinkIdx); send({ type: "content_block_start", index: thinkIdx, content_block: { type: "thinking", thinking: "" } }); }
          send({ type: "content_block_delta", index: thinkIdx, delta: { type: "thinking_delta", thinking: rs } });
        }
        if (typeof d.content === "string" && d.content) content(d.content);
        if (d.tool_calls?.length) endContent(); // a held head must not land after the tool block
        for (const tc of d.tool_calls ?? []) {
          const k = Number(tc.index ?? 0);
          if (!tools.has(k)) { const i = ++idx; tools.set(k, i); opened.push(i); send({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: tc.id ?? `call_${k}`, name: tc.function?.name ?? "", input: {} } }); }
          if (tc.function?.arguments) send({ type: "content_block_delta", index: tools.get(k)!, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
        }
        if (ch.finish_reason) endContent();
        if (ch.finish_reason) stop = STOP[ch.finish_reason] ?? "end_turn";
      };
      try {
        for (;;) {
          const { done, value } = await reader.read().catch((e) => { throw new ProviderNetworkError(`stream read failed: ${e instanceof Error ? e.message : String(e)}`); }); // an upstream body failure is a connection failure (marked here, by the adapter)
          if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); const l = c.split("\n").find((x) => x.startsWith("data:")); if (l) handle(l.slice(5).trim()); }
        }
        start();
        if (failed) return;
        endContent();
        for (const i of opened) send({ type: "content_block_stop", index: i });
        const cached = Number(usage?.prompt_tokens_details?.cached_tokens ?? 0) || 0;
        send({ type: "message_delta", delta: { stop_reason: stop ?? "end_turn" }, usage: { input_tokens: Math.max(0, Number(usage?.prompt_tokens ?? 0) - cached), output_tokens: Number(usage?.completion_tokens ?? 0), cache_read_input_tokens: cached, ...(usage?.estimated ? { usage_estimated: true } : {}) } });
        send({ type: "message_stop" });
      } catch (e) {
        try { start(); endContent(); } catch { /* the stream is already closed */ } // a held head is partial visible text: it goes out before the error
        if (!signal?.aborted) { start(); send({ type: "error", error: { type: e instanceof ProviderNetworkError ? "network_error" : "api_error", message: `stream dropped: ${e instanceof Error ? e.message : String(e)}` } }); }
      } finally { signal?.removeEventListener("abort", onAbort); ctl.close(); }
    },
  });
}

/** Request headers for a config: the key goes in exactly one header, styled by cfg.authHeader (bearer default | x-api-key | custom name). */
export function authHeaders(cfg: Pick<ProviderConfig, "authHeader">, key: string): Record<string, string> {
  const a = cfg.authHeader ?? "bearer";
  return a === "bearer" ? { authorization: `Bearer ${key}` } : { [a]: key };
}
/** The base's own stored key (decrypted for this call only) wins; else the Worker secret the config names. */
export const keyOf = async (cfg: ProviderConfig, env: Env): Promise<string | null> => {
  const u = await (cfg.resolveKey?.() ?? Promise.resolve({ kind: "none" as const })).catch(() => ({ kind: "error" as const }));
  if (u.kind === "key") return u.key;
  // a row exists but cannot be used for this call: never send another credential in its place
  if (u.kind === "stale") throw new ProviderError("This provider's URL changed since your key was saved: re-enter the key in Settings > Providers.", 409, { type: "authentication_error" });
  if (u.kind === "error") throw new ProviderError("Your stored key for this provider could not be read: re-enter it in Settings > Providers.", 500, { type: "api_error" });
  const k = cfg.keyBinding ? env[cfg.keyBinding] : undefined;
  if (typeof k !== "string" || !k) return null;
  // the shared Worker secret goes only to the preset's own origin; anywhere else (edited baseUrl, custom provider) it is never sent
  if (!workerKeyAllowed(cfg)) throw new ProviderError("Provider URL changed: re-enter the key in Settings > Providers.", 409, { type: "authentication_error" });
  return k;
};
/** Read at most `cap` bytes of a body through its stream, then cancel the rest (a hostile/huge error page never gets buffered whole). */
export async function readCappedText(res: Response, cap = MAX_ERR_BODY): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader(), dec = new TextDecoder(); let out = "", n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.byteLength; out += dec.decode(value.byteLength > cap - (n - value.byteLength) ? value.subarray(0, Math.max(0, cap - (n - value.byteLength))) : value, { stream: true });
      if (n >= cap) break;
    }
  } catch { /* partial body is fine */ } finally { await reader.cancel().catch(() => {}); }
  return out;
}
const MAX_IMAGE_BODY = 12 * 1024 * 1024; // one base64 image (the app re-checks the decoded size)
const MAX_LIST_BODY = 256 * 1024; // a model listing is legitimately larger than an error page
const isRedirect = (s: number) => s >= 300 && s < 400;
const redirectError = () => new ProviderError("The provider tried to redirect the request, which is not followed.", 502, { type: "api_error" });
/** 404 (unknown model) and 410 (end of life) both mean: stop offering this model. */
const modelGone = (s: number) => s === 404 || s === 410;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GET <baseUrl>/models with the config's key: the raw ids the provider lists (OpenAI shape `{data:[{id}]}`). Throws ProviderError; nothing is probed per model. */
export async function listUpstreamModels(cfg: ProviderConfig, env: Env, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<string[]> {
  const key = await keyOf(cfg, env);
  if (!cfg.baseUrl || !key) throw new ProviderError("This provider has no key configured.", 503, { type: "api_error" });
  let res: Response;
  try { res = await fetchImpl(`${cfg.baseUrl}/models`, { method: "GET", redirect: "manual", headers: { accept: "application/json", ...authHeaders(cfg, key) } }); }
  catch { throw new ProviderError("Could not reach the provider.", 502, { type: "api_error", retryable: true }); }
  if (isRedirect(res.status)) { await res.body?.cancel().catch(() => {}); throw redirectError(); }
  if (!res.ok) { const t = await readCappedText(res); let j: unknown = null; try { j = JSON.parse(t); } catch { /* not json */ } throw rateHint(cfg, openaiError(res.status, j, res.headers.get("retry-after"))); }
  let j: any; try { j = JSON.parse(await readCappedText(res, MAX_LIST_BODY)); } catch { throw new ProviderError("The provider returned an unreadable model list.", 502, { type: "api_error" }); }
  const ids = (Array.isArray(j?.data) ? j.data : []).map((m: any) => m?.id).filter((x: unknown): x is string => typeof x === "string" && !!x && x.length <= 120 && !/\s/.test(x));
  return [...new Set<string>(ids)].slice(0, 1000);
}
/** NVIDIA's free tier is ~40 requests/min: say so on a 429 so the message is actionable. */
const rateHint = (cfg: ProviderConfig, e: ProviderError) => (e.status === 429 && cfg.id === "nvidia" ? new ProviderError(`${e.message} The free tier allows about 40 requests per minute: wait a moment and send again.`, 429, e.info) : e);

/** A 413 is "too large for this model's per-minute limit" (never retryable: the provider's retry-after on it is misleading). A 429 says which limit and when to retry (the provider's text carries the org id: only the number is used). */
function limitError(cfg: ProviderConfig, status: number, body: any, hintS?: number): ProviderError {
  const rl = descriptorOf(cfg.id)?.dialect?.rateLimit;
  if (status === 413) return new ProviderError(rl?.tooLarge ?? "This request is too large for the provider's limit.", 413, { type: "invalid_request_error", retryable: false });
  const msg = String(body?.error?.message ?? ""), ra = hintS ?? retryHintS(msg);
  const which = /per day|\(TPD\)|\(RPD\)|requests per day|tokens per day/i.test(msg) ? "daily" : /\(RPM\)|requests per minute/i.test(msg) ? "requests per minute" : "tokens per minute";
  return new ProviderError(`${rl?.limited ?? "The provider's rate limit was reached"} (${which}).${ra ? ` Try again in about ${ra >= 120 ? `${Math.ceil(ra / 60)} min` : `${ra}s`}.` : ""}`, 429, { type: "rate_limit_error", retryable: true, ...(ra ? { retryAfterS: ra } : {}) });
}
const MAX_IMAGE_BYTES = 9 * 1024 * 1024; // decoded cap for one generated image
/** The only slugs ever put into the genai URL (a security guard, not a model list: a catalog row naming any other slug is refused). */
const NVIDIA_IMAGE_SLUGS: readonly string[] = ["flux.2-klein-4b", "flux-3-image-klein", "flux.1-dev"];
/** Strict base64 (standard alphabet, optional padding, no whitespace): null when it is not exactly that. */
function decodeBase64Strict(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; } catch { return null; }
}
/** Magic bytes only: JPEG, PNG or WebP; anything else is null (never defaulted). */
function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
/** One text-to-image call: POST <genai>/<slug> {prompt,width,height,seed,steps} -> {artifacts:[{base64 (JPEG),finishReason}]}. Price is not reported: NO cost is claimed (usd null = unknown; never 0, never "free"). */
async function nvidiaImage(cfg: ProviderConfig, env: Env, req: ImageRequest, signal: AbortSignal | undefined, fetchImpl: FetchLike): Promise<ImageResult> {
  const m = (cfg.mediaModels ?? NVIDIA_IMAGE_MODELS).find((x) => x.id === req.model);
  if (!m || !NVIDIA_IMAGE_SLUGS.includes(m.slug)) throw new ProviderError("That NVIDIA image model is not available.", 404, { type: "not_found_error" });
  const key = await keyOf(cfg, env);
  if (!key) throw new ProviderError("This provider has no key configured.", 503, { type: "api_error" });
  const [width, height] = NVIDIA_IMAGE_DIMS[req.aspect_ratio ?? "1:1"] ?? NVIDIA_IMAGE_DIMS["1:1"]!;
  let res: Response;
  try { res = await fetchImpl(`${NVIDIA_GENAI_BASE}/${m.slug}`, { method: "POST", redirect: "manual", signal, headers: { "content-type": "application/json", accept: "application/json", ...authHeaders(cfg, key) }, body: JSON.stringify({ prompt: req.prompt, width, height, seed: 0, steps: m.steps }) }); }
  catch (e) { if (signal?.aborted) throw e; throw new ProviderError("Could not reach the provider.", 502, { type: "api_error", retryable: true }); }
  if (isRedirect(res.status)) { await res.body?.cancel().catch(() => {}); throw redirectError(); }
  if (!res.ok) { const t = await readCappedText(res); let j: unknown = null; try { j = JSON.parse(t); } catch { /* not json */ } throw rateHint(cfg, openaiError(res.status, j, res.headers.get("retry-after"))); }
  let j: any; try { j = JSON.parse(await readCappedText(res, MAX_IMAGE_BODY)); } catch { throw new ProviderError("The provider returned an unreadable image response.", 502, { type: "api_error" }); }
  const a = Array.isArray(j?.artifacts) ? j.artifacts[0] : null;
  const cost = { usd: null, basis: "price not reported" };
  const fin = typeof a?.finishReason === "string" ? a.finishReason : null;
  if (fin && fin !== "SUCCESS" && fin !== "STOP") return { model: req.model, images: [], text: null, finish_reason: fin, cost };
  const data = typeof a?.base64 === "string" ? a.base64 : "";
  if (!data) return { model: req.model, images: [], text: null, finish_reason: fin ?? "empty", cost };
  const bytes = decodeBase64Strict(data);
  if (!bytes) throw new ProviderError("The provider returned an invalid image.", 502, { type: "api_error" });
  if (bytes.length > MAX_IMAGE_BYTES) throw new ProviderError("The provider returned an image that is too large.", 502, { type: "api_error" });
  const mime = sniffImageMime(bytes);
  if (!mime) throw new ProviderError("The provider returned an image in an unsupported format.", 502, { type: "api_error" });
  return { model: req.model, images: [{ mime_type: mime, data }], text: null, finish_reason: "STOP", cost };
}

export function openaiCompatProvider(cfg: ProviderConfig, env: Env, fetchImpl: FetchLike = (u, i) => fetch(u, i), sleep: (ms: number) => Promise<void> = defaultSleep): ModelProvider {
  const broken = () => new Set(cfg.broken ?? []);
  const models = (): ProviderModel[] => cfg.models.filter((m) => !broken().has(m.id)).map((m) => ({ id: m.id, displayName: m.displayName, capabilities: m.capabilities, pricePerMTok: m.pricePerMTok, contextWindow: m.contextWindow, maxTokens: m.maxTokens, maxOutput: m.maxOutput }));
  // NVIDIA's text-to-image NIMs live on another host (ai.api.nvidia.com/v1/genai) and are not in /v1/models: offered only to the preset provider at its own origin.
  const imageOk = cfg.id === "nvidia" && workerKeyAllowed(cfg) && isNvidiaPresetBase(cfg.baseUrl);
  const imageModels = (): ProviderModel[] => (imageOk ? (cfg.mediaModels ?? NVIDIA_IMAGE_MODELS).map((m) => ({ id: m.id, displayName: m.label, capabilities: { ...NO_CAPABILITIES, "image-gen": true }, pricePerMTok: null, kind: "image" as const })) : []);
  return {
    name: cfg.id, id: cfg.id,
    async listModels(kind?: ModelKind) { return !kind || kind === "chat" ? models() : kind === "image" ? imageModels() : []; },
    ...(imageOk ? { async image(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> { return nvidiaImage(cfg, env, req, signal, fetchImpl); } } : {}),
    async messages(body: any, signal?: AbortSignal): Promise<Response> {
      const key = await keyOf(cfg, env);
      if (!cfg.baseUrl || !key) throw new ProviderError("This provider has no key configured.", 503, { type: "api_error" });
      // The dialect only applies at the preset's own origin (a custom provider is plain OpenAI chat-completions, as before).
      const dia: ChatDialect | undefined = isPresetBase(cfg.id, cfg.baseUrl) ? descriptorOf(cfg.id)?.dialect : undefined;
      const row = cfg.models.find((m) => m.id === body?.model);
      const ex = row?.extra ?? {};
      // never ask for more than the model's declared output cap (min(maxTokens, maxOutput)); an unknown model keeps what the caller asked for
      const cap = row?.maxOutput ?? DEFAULT_MAX_OUTPUT;
      let maxTokens: number | undefined = typeof body?.max_tokens === "number" ? (cap ? Math.min(body.max_tokens, cap) : body.max_tokens) : undefined;
      // short-context model (Groq free: ~8K tokens/minute): cap images, trim history, lower the output cap so the request fits the minute budget. Never sent over budget.
      let sendBody = body;
      if (ex.shortContext === true && row?.limits?.tpm) {
        if (typeof ex.maxImages === "number") sendBody = capImages(sendBody, ex.maxImages);
        const fit = fitToBudget(sendBody, { tpm: row.limits.tpm, wantOut: maxTokens ?? row.maxTokens ?? 2500, imageTokens: typeof ex.imageTokens === "number" ? ex.imageTokens : undefined, tooLargeMessage: dia?.rateLimit?.tooLarge ?? "This chat is too large for this model's per-minute limit." });
        sendBody = fit.body; maxTokens = fit.maxOutput;
      }
      const opts: ChatRequestOpts = dia ? { maxTokensParam: dia.maxTokensParam, flattenText: dia.flattenTextContent && !row?.capabilities.vision, deny: dia.paramDenylist,
        noParallelTools: dia.parallelTools === false || ex.parallelTools === false,
        ...(row?.capabilities.reasoning && typeof ex.reasoningEffort === "string" && dia.reasoning.effortValues?.includes(ex.reasoningEffort) ? { reasoningEffort: ex.reasoningEffort } : {}) } : {};
      const send = async () => { const payload = JSON.stringify(toChatRequest({ ...sendBody, max_tokens: maxTokens }, String(body?.model ?? ""), opts)); /* built per call (the 400 retry lowers max_tokens), outside the fetch guard: a bug here is not a network failure */ try { return await fetchImpl(`${cfg.baseUrl}/chat/completions`, { method: "POST", redirect: "manual", signal, body: payload, headers: { "content-type": "application/json", ...authHeaders(cfg, key) } }); } catch (e) { if (signal?.aborted) throw e; throw new ProviderNetworkError(); } };
      let res: Response;
      try {
        res = await send();
        // Rate limit: ONE retry, never a loop. Legacy: after Retry-After capped at 2 s. A dialect with rateLimit retries only when the provider's own hint (header or body) is short; a long one is shown to the user.
        if (res.status === 429) {
          const t = await readCappedText(res); let j: any = null; try { j = JSON.parse(t); } catch { /* not json */ }
          const hintS = Number(res.headers.get("retry-after")) > 0 ? Number(res.headers.get("retry-after")) : retryHintS(j?.error?.message);
          if (dia?.rateLimit) {
            if (!hintS || hintS * 1000 > dia.rateLimit.maxInlineWaitMs) throw limitError(cfg, 429, j, hintS);
            await sleep(hintS * 1000);
          } else await sleep(Math.min(hintS && hintS > 0 ? hintS * 1000 : MAX_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS));
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          res = await send();
        }
      } catch (e) {
        throw e; // a rejected fetch is already a ProviderNetworkError (send); anything else is surfaced as it is
      }
      if (isRedirect(res.status)) { await res.body?.cancel().catch(() => {}); throw redirectError(); }
      if (res.status === 400 && maxTokens) {
        // a 400 that names a smaller max_tokens: retry ONCE with that value; any other 400 (or an unparseable one) is surfaced as is
        const t = await readCappedText(res); let j: unknown = null; try { j = JSON.parse(t); } catch { /* not json */ }
        const smaller = capFromError(j, maxTokens);
        if (!smaller) throw rateHint(cfg, openaiError(400, j, null));
        maxTokens = smaller;
        res = await send();
        if (isRedirect(res.status)) { await res.body?.cancel().catch(() => {}); throw redirectError(); }
      }
      if (!res.ok) {
        const t = await readCappedText(res); let j: unknown = null; try { j = JSON.parse(t); } catch { /* not json */ }
        // a model the catalog lists but the endpoint 404s/410s: remember it so the picker stops offering it
        if (modelGone(res.status) && body?.model) { try { cfg.onBroken?.(String(body.model)); } catch { /* best effort */ } }
        if (dia?.rateLimit && (res.status === 413 || res.status === 429)) throw limitError(cfg, res.status, j, Number(res.headers.get("retry-after")) > 0 ? Number(res.headers.get("retry-after")) : undefined);
        throw rateHint(cfg, openaiError(res.status, j, res.headers.get("retry-after")));
      }
      if (!res.body) throw new ProviderError("The provider returned an empty response.", 502, { type: "api_error" });
      return new Response(toAnthropicStream(res.body, String(body?.model ?? ""), signal), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  };
}
