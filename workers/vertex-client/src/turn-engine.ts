// ChatEngine: the per-conversation state machine behind the ChatSession Durable Object. Deliberately free of
// `cloudflare:workers` so it runs under bun test against bun:sqlite and a stub provider.
//
// Persistence (SQLite in the DO): messages (source of truth, incl. thinking blocks WITH signatures), events (every
// stream event, monotonic seq — replayed on reconnect), meta. Nothing here talks to D1 directly; that goes through
// the IndexSink so a D1 failure can never break a turn.
import { hasLiveCue } from "./live-cues";
import { parseTextToolCall } from "./text-tool-call";
import { narratesToolCall, withoutNarration, NARRATION_NOTE, NARRATION_NOTE_AFTER_TOOL } from "./tool-narration";
import { ProviderError, ProviderNetworkError, type ModelProvider } from "./providers/types";
import { descriptorOf } from "./providers/descriptor";
import { providerOfModel } from "./providers/config";
import { costOf, totalTokens } from "./pricing";
import { DEFAULT_MODEL, GATEWAY_VISION_VERIFIED, MODELS_META, metaFromProviderModel, metaOf, noImageMessage, type ModelMeta } from "./models-meta";
import type { Usage } from "./reducer";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_AUTO_DELEGATE, SYSTEM_PROMPT_OPEN, SYSTEM_PROMPT_OPEN_AUTO_DELEGATE, SYSTEM_PROMPT_TEAM, SYSTEM_PROMPT_TEAM_AUTO_DELEGATE, SYSTEM_PROMPT_TEAM_OPEN, SYSTEM_PROMPT_TEAM_OPEN_AUTO_DELEGATE } from "./system-prompt";
import { profileSystemText } from "./profile";
import { projectSystemText } from "./projects";
import { CF_BROWSER_TOOL_NAMES, RUN_JS_TOOL_NAMES, classify, type ToolDef, type ToolHost } from "./tools";
import { webPolicy, isTainted, TRUSTED_RESULT_TOOLS } from "./web-taint";
import { AWAITING_TTL_MS, BYPASS_CONFIRM_VERSION, EXPIRED_TEXT, MAX_CHAT_GRANTS, bypassTool, bypassWeb, grantHost, hardAskReason, REDIRECT_CARD_REASON, webAuto, type ApprovalMode, type AutoSource } from "./approval";
import { byteLen, textForModel, wrapAttachment } from "./extract";
import { MAX_SKILL_EXPANDED, SKILL_NAME, expandSkill } from "./skills";
import { GenEngine, type GenCommand, type GenDispatch, type GenHost } from "./gen-engine";
import { MAIN_TURN_CAP } from "./scope";
import { routeAuto, hardFilter, escalateFrom, sendableEffort, tierOfModel, AUTO_MAX_USD_DEFAULT, type AutoCandidate, type AutoEffort, type AutoInput } from "./auto-route";
import { IMAGE_MIMES, MAX_FILES_PER_MESSAGE, imageCapFor, isGatewayCappedImageId, isGatewayGeminiId, imageTooLargeMessage, classifyFile, refBelongsTo, sidecarKey, toBase64, type FileRef, type FileStore } from "./files";
import { isModelIdSyntax } from "./model-id";
import type { Op as DeviceOp } from "./device-env";
import { BUDGET_RETRY_STATUSES, estimateInputTokens, isMaxTokensError, outputBudget, type AnswerLimit } from "./output-budget";
import { REASON, MAX_SWITCHES, RETRY_ABSENT_S, TTFB_MS, TTFB_REASONING_MS, classifyFailure, firstByteMsOf, parseRetryAfter, peekFirstContent, pickNext, type FailoverHook, type FoClass, type FoFailure } from "./failover";
import { TITLE_INSTRUCTION, TitleStream, inlineTitleEnabled, scrubBlock } from "./inline-title";

export interface Sql { exec(query: string, ...binds: unknown[]): { toArray(): any[] } }
export interface Sink { broadcast(seq: number, ts: number, ev: ServerEvent): void }
export interface IndexSink {
  indexMessage(m: { conversationId: string; seq: number; role: "user" | "assistant"; text: string }): Promise<void>;
  updateConversation(c: { id: string; model: string; costUsd: number; tokens: number; title?: string }): Promise<void>;
  /** Inline title (src/inline-title.ts): set the title only if the stored one is still empty (a user rename wins). Absent = updateConversation. */
  applyAutoTitle?(c: { id: string; title: string }): Promise<boolean>;
  /** How often the first reply carried a usable title marker ("ok") vs the existing title call had to run ("fallback"). Counter only, no content. Optional, failures logged. */
  countInlineTitle?(c: { outcome: "ok" | "fallback"; model: string }): Promise<void>;
  /** Semantic search (src/semantic.ts): one finished exchange = the user's text + this assistant's text (never tool results). Optional; failures are logged, never block the chat. */
  indexExchange?(e: { conversationId: string; seq: number; userText: string; assistantText: string; ts: number }): Promise<void>;
  recordUsage(u: { conversationId: string; model: string; usage: Usage; costUsd: number | null;
    /** Generation rows: kind ("image"), the pre-call estimate (kept when the final cost is unknown) and units (images). Chat rows omit all three. */
    kind?: string; estUsd?: number | null; units?: number;
    /** Generation rows: stable per-dispatch id; the insert is idempotent on it (ON CONFLICT DO NOTHING). */ dispatchId?: string;
    /** Subagent (`delegate`) call: persona name + the parent's turn number, written to optional columns (migration 0024). */
    sub?: { persona: string; turn: number };
    /** Auto shadow mode: what the router WOULD have picked. `model` above stays the model that actually ran. Written to optional columns (migration 0023). */
    routed?: RoutedInfo }): Promise<void>;
  /** Concurrency limit (max generating conversations). Absent = unlimited. Fail-open on infrastructure errors. */
  acquireSlot?(conversationId: string): Promise<boolean>;
  releaseSlot?(conversationId: string): Promise<void>;
}
/** Auto shadow record: `by` is "auto"; `model` the routed pick (null = router refused); `reason` starts with "shadow" because it was NOT applied. */
export interface RoutedInfo { by: "auto" | RouteBy; model: string | null; reason: string }
/** Model id of the opt-in Auto mode: the conversation stores it; the engine resolves it to a concrete model at every fresh user turn. */
export const AUTO_MODEL = "auto";
export const EFFORTS: readonly AutoEffort[] = ["low", "medium", "high"];
/** How an APPLIED route came about (usage `routed_by`; shadow rows keep "auto"). */
export type RouteBy = "auto-route" | "auto-fallback" | "manual-override" | "open-failover";
/** The concrete (model, effort) a turn actually ran on, stamped on its assistant messages. `effort` is what was SENT (null = nothing sent). */
export interface RouteInfo { by: RouteBy; model: string; effort: AutoEffort | null; reason: string; fallbackFrom?: string; /** open-failover: every model this turn already tried (a one-click continue never revisits them) */ tried?: string[] }
/** One-message override ("Retry with…"): runs that turn on a chosen concrete model/effort and never touches the conversation's model setting. */
export interface RouteOverride { model: string; effort?: AutoEffort | null }
export function parseOverride(o: unknown): RouteOverride | null {
  if (!o || typeof o !== "object") return null;
  const { model, effort } = o as { model?: unknown; effort?: unknown };
  if (!isModelIdSyntax(model) || model === AUTO_MODEL) return null;
  return { model, effort: typeof effort === "string" && (EFFORTS as readonly string[]).includes(effort) ? (effort as AutoEffort) : null };
}
class FoTimeout extends Error {}
export type ServerEvent = { type: string; [k: string]: any };
export type Block = Record<string, any>;

export const MAX_ITERATIONS = 25;           // loop guard: model calls per turn (tool loop, pause_turn). No $ caps — Erich's rule.
export const MAX_CONCURRENT_TURNS = MAIN_TURN_CAP; // conversations generating at once for main (per-scope caps: src/scope.ts)
export const CLEAR_AT = 0.5;                 // context ratio: clear old tool_result bodies
export const COMPACT_AT = 0.75;              // context ratio: haiku summary compaction
const STOPPED_MARK = "[reply stopped by the user]";
const STOPPED_NOTE = "[The user stopped your previous reply on purpose. Do not continue it or comment on it; answer only the message below.]";
const KEEP_USER_TURNS = 2;                  // compaction keeps the last N user messages verbatim
export const CLEARED_STUB = "[old tool result cleared to save context]";
/** Worst-case $ ceiling handed to the router in shadow mode: the same default as applied mode (none), so the record shows what Auto would really pick. */
export const SHADOW_MAX_USD = AUTO_MAX_USD_DEFAULT;
export const SUMMARY_MODEL = "claude-haiku-5-5";
export const MAX_USER_CHARS = 100_000;
const EVENT_TURNS_KEPT = 3;                  // events of older turns are pruned; a client further behind resyncs via HTTP
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
/** Same string as providers/gemini.ts. */
export const EMPTY_REPLY_MESSAGE = "The model returned an empty answer. Try again.";
/** 404/410 whose payload really says the model is missing: a normalized not_found_error / unknown_model type, or the Vertex "Publisher model ... was not found or your project does not have access" text. */
export function isModelGone(status: number, eb: { type?: unknown; message?: unknown } | null | undefined): boolean {
  if (status !== 404 && status !== 410) return false;
  return eb?.type === "not_found_error" || eb?.type === "unknown_model" || /publisher model[\s\S]*(not found|does not have access)|model[\s\S]*was not found or your project does not have access/i.test(String(eb?.message ?? ""));
}
export const MODEL_UNAVAILABLE_MESSAGE = "This model is not available right now.";
/** Same-model retries after an empty completed reply. Gateway Gemini (bare `gemini-*` id, the company Vertex route) returns 110-150 output tokens and no text on a large share of "make an image" turns
 *  (geminifix2: 11/16 on 3.8, 14/16 on 3.7 with no system prompt, ~3/16 with one), so one retry leaves most users with the error: allow three. Each failed call is ~130 output tokens, billed and recorded. Every other model keeps one. */
export const GEMINI_EMPTY_RETRIES = 3;
/** A BARE gateway Gemini id: no `provider:` prefix (so not `aistudio:gemini-...` nor a custom `gemini-proxy:gpt-4o`) and a `gemini-` name. */
/** Non-chat Gemini ids (media / embedding / realtime). The chat model list carries no catalog `kind` into the engine (ModelMeta has none), so the id decides. */
export class HistoryImageTooBig extends Error { constructor(cap: number) { super(`An earlier image in this chat exceeds this model's ${cap / 1024 / 1024} MB limit. Switch to a Claude model or start a new chat with a smaller image.`); } }
/** After a failed/slow catalog load, do not try again for this long (the fallback list decides meanwhile). */
const META_RETRY_MS = 30_000;
/** A successful catalog load is trusted for this long before an image send reloads it. */
const META_FRESH_MS = 60_000;
/** Catalog refresh state shared by every engine of the same RESOLVED scope (never a null scope): one in-flight deadline-bounded load, scope-owned freshness and failure timestamps. */
const SHARED_META_MAX = 256;
const sharedMeta = new Map<string, { inflight?: Promise<boolean>; loadedAt: number; failedAt: number }>();
/** Test hook: forget all shared refresh state. */
/** Bound the map like catalogMetas: drop the oldest SETTLED entries beyond the cap; an entry with an in-flight attempt is never evicted. */
const pruneSharedMeta = () => { for (const [k, v] of sharedMeta) { if (sharedMeta.size <= SHARED_META_MAX) break; if (!v.inflight) sharedMeta.delete(k); } };
export const __resetSharedMeta = () => sharedMeta.clear();
export const __sharedMetaSize = () => sharedMeta.size;
export const isGatewayGemini = (model: string): boolean => providerOfModel(model) === "gateway" && isGatewayGeminiId(model);
export const emptyRetryCap = (model: string): number => (isGatewayGemini(model) ? GEMINI_EMPTY_RETRIES : 1);
/** A normally finished reply (not tool_use, not truncated) with no tool call and no non-blank text; thinking blocks are not an answer. */
export function isEmptyReply(blocks: ReadonlyArray<any>, stop: string | null): boolean {
  if (stop !== null && stop !== "end_turn" && stop !== "stop" && stop !== "stop_sequence") return false;
  return !blocks.some((b) => b.type === "tool_use" || (b.type === "text" && String((b as { text?: unknown }).text ?? "").trim() !== ""));
}

// ---- block accumulation (assistant content from stream events) ----
export class BlockAccumulator {
  blocks: Block[] = [];
  private json: Record<number, string> = {};
  private started: Record<number, number> = {};
  feed(e: ServerEvent, ts: number) {
    if (e.type === "content_block_start") {
      const b = { ...e.content_block };
      if (b.type === "text") b.text = b.text ?? "";
      if (b.type === "thinking") { b.thinking = b.thinking ?? ""; this.started[e.index] = ts; }
      if (b.type === "tool_use") this.json[e.index] = "";
      this.blocks[e.index] = b;
    } else if (e.type === "content_block_delta") {
      const b = this.blocks[e.index]; const d = e.delta;
      if (!b) return;
      if (d.type === "text_delta") b.text = (b.text ?? "") + d.text;
      else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
      else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature;
      else if (d.type === "input_json_delta") this.json[e.index] = (this.json[e.index] ?? "") + d.partial_json;
      else if (d.type === "citations_delta") (b.citations ??= []).push(d.citation);
    } else if (e.type === "content_block_stop") {
      const b = this.blocks[e.index];
      if (!b) return;
      b._done = true;
      if (b.type === "thinking" && this.started[e.index] !== undefined) b._ms = ts - this.started[e.index];
      if (b.type === "tool_use") { try { b.input = this.json[e.index] ? JSON.parse(this.json[e.index]) : {}; } catch { b.input = undefined; } }
    }
  }
  /** Blocks worth persisting after a normal end. Incomplete tool_use is dropped (it can never run). */
  finished(): Block[] {
    return this.blocks.filter(Boolean).filter((b) => !(b.type === "tool_use" && !(b._done && b.input !== undefined))).map(({ _done, ...b }) => b);
  }
}

/** What we send back to the API for a stored assistant/user content array. Deterministic (cache prefix must be
 *  byte-stable across requests): drops empty/unsigned thinking blocks (sonnet-5-5 rejects resent empty ones with a
 *  400), empty text blocks, and internal `_` fields. redacted_thinking and signed non-empty thinking pass verbatim. */
export function toApiContent(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === "thinking" && (!b.thinking || !b.signature)) continue;
    if (b.type === "text" && !b.text) continue;
    if (b.type === "file_ref") continue; // expanded to image/document by expandFiles before this runs
    // A generated image is stored by ref only; Claude just gets a one-line note so a follow-up chat turn has the context.
    if (b.type === "gen_image") { out.push({ type: "text", text: `[An image was generated from this prompt: ${String(b.prompt ?? "").slice(0, 300)}]` }); continue; }
    if (b.type === "gen_video") { out.push({ type: "text", text: `[A ${Number(b.seconds) || "?"} s video was generated from this prompt: ${String(b.prompt ?? "").slice(0, 300)}]` }); continue; }
    const c: Block = {};
    for (const [k, v] of Object.entries(b)) if (!k.startsWith("_")) c[k] = v;
    out.push(c);
  }
  return out;
}

const TEXT_BUDGET_BYTES = 600 * 1024; // extracted attachment text inlined per request
const CACHEABLE = new Set(["text", "tool_use", "tool_result", "image", "document"]);

/** Two breakpoints: system (set in buildRequest) and the last assistant turn. cache_control can't sit on thinking
 *  blocks or empty text, so it goes on the last cacheable block of that message. */
export function markLastAssistant(messages: Array<{ role: string; content: Block[] }>) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const c = messages[i].content;
    for (let j = c.length - 1; j >= 0; j--) if (CACHEABLE.has(c[j].type)) { c[j] = { ...c[j], cache_control: { type: "ephemeral" } }; return; }
    return;
  }
}

/** Tools block: byte-stable (caller sorts), breakpoint on the last tool so tools+system are one cached prefix. */
export function toolsBlock(defs: ToolDef[]) {
  return defs.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.input_schema, ...(i === defs.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) }));
}

/** Open only: the LAST system block of every request (first replies included: the title marker goes before it), names only, of the tools actually sent in this request: the complete list, unique and sorted, so the same
 *  tool set is the same bytes. No cap and no prose beyond the label (the tools parameter carries descriptions and schemas). */
/** System nudge for a forced call on a `forceViaAuto` model (sent with tool_choice auto): the call itself, not a description of it. */
export const forceNudge = (names: string[]) => `For this reply, make a tool call now (${[...new Set(names)].sort().join(", ")}; web_read opens a page): the call itself, not a description of it in text.`;
/** Id prefix of a tool_use that came from the text fallback parser: runTools ALWAYS parks it behind an approval card (no Auto / Bypass / grant), only a click runs it. */
export const TEXT_CALL_ID_PREFIX = "toolu_txt_";
const TEXT_CALL_REASON = "The model wrote this tool call as plain text instead of calling it. Approve only if you asked for it.";
/** Open only, when the request offers no tools: stops a model from faking a call in prose. Sits before the first-turn title block and the tools line (which stays the last system block). */
/** Gateway Gemini (geminifix2): the empty-reply rate on "make an image" turns fell from ~69-88% (no system prompt) to 19% (generic) to 0/8 (this kind of line). Own system block, so the Claude base prompt stays byte-stable. */
export const GEMINI_VISIBLE_TEXT_LINE = "Always answer with visible text. If you cannot do what is asked (for example create or edit an image), say so plainly in words and offer an alternative.";
export const NO_TOOLS_LINE = "You have no tools in this chat; do not write tool calls, answer in plain text.";
export function toolsLine(names: string[]): string {
  const n = [...new Set(names)].sort();
  return n.length ? `Tools: ${n.join(", ")}` : "Tools: none";
}

/** `instructions` = Erich's profile text (scope main only, resolved by the caller); it rides in a second system block so the base prompt stays byte-stable. */
export function buildRequest(model: string, history: Array<{ role: string; content: Block[] }>, tools: ToolDef[] = [], instructions: string | null = null, project: { name: string; text: string } | null = null, autoDelegate = false, effort: AutoEffort | null = null, open = false, metaIn?: ModelMeta, inlineTitle = false, noPersonal = false) {
  const meta = metaIn ?? MODELS_META[model];
  const eff = sendableEffort(model, effort); // adaptive thinking + output_config.effort only; NEVER budget_tokens / thinking.type=enabled (400 on sonnet-5-5)
  // A title marker is never replayed to a model: stripped from every assistant text block (a dropped-empty block is removed by toApiContent).
  const messages = history.map((m) => ({ role: m.role, content: toApiContent(m.role === "assistant" ? m.content.map((b) => scrubBlock(b)) : m.content) })).filter((m) => m.content.length);
  markLastAssistant(messages);
  return {
    model, max_tokens: meta?.maxTokens ?? 8192, stream: true,
    ...(meta?.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
    ...(eff ? { output_config: { effort: eff } } : {}),
    ...(tools.length && meta?.caps.tools ? { tools: toolsBlock(tools) } : {}),
    system: [{ type: "text", text: autoDelegate && tools.length && meta?.caps.tools && tools.some((t) => t.name === "delegate") ? (noPersonal ? (open ? SYSTEM_PROMPT_TEAM_OPEN_AUTO_DELEGATE : SYSTEM_PROMPT_TEAM_AUTO_DELEGATE) : open ? SYSTEM_PROMPT_OPEN_AUTO_DELEGATE : SYSTEM_PROMPT_AUTO_DELEGATE) : noPersonal ? (open ? SYSTEM_PROMPT_TEAM_OPEN : SYSTEM_PROMPT_TEAM) : open ? SYSTEM_PROMPT_OPEN : SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }, ...(instructions ? [{ type: "text", text: profileSystemText(instructions) }] : []), ...(project ? [{ type: "text", text: projectSystemText(project.name, project.text) }] : []), ...(open && !(tools.length && meta?.caps.tools) ? [{ type: "text", text: NO_TOOLS_LINE }] : []), ...(!open && isGatewayGemini(model) && !(instructions ?? "").includes(GEMINI_VISIBLE_TEXT_LINE) && !(project?.text ?? "").includes(GEMINI_VISIBLE_TEXT_LINE) ? [{ type: "text", text: GEMINI_VISIBLE_TEXT_LINE }] : []), ...(inlineTitle ? [{ type: "text", text: TITLE_INSTRUCTION }] : []), ...(open ? [{ type: "text", text: toolsLine(tools.length && meta?.caps.tools ? tools.map((t) => t.name) : []) }] : [])],
    messages,
  };
}

const isUserText = (m: { role: string; content: Block[] }) => m.role === "user" && m.content.some((b) => b.type === "text" || b.type === "file_ref");
const toolUses = (m: { content: Block[] }) => m.content.filter((b) => b.type === "tool_use");

export type SlashHint = { kind?: unknown; name?: unknown };
/** The system-side line for a slash pick, or null. Only classified tools qualify (unknown = no consent); a slash never forces a call
 *  and never skips approval - the model still calls the tool through the normal loop. */
export function slashHint(s: SlashHint | null | undefined): string | null {
  if (!s || s.kind !== "tool" || typeof s.name !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(s.name) || !classify(s.name)) return null;
  return `[Client note, not typed by the user: the user asks you to use tool \`${s.name}\` for this message.]`;
}

/** `@persona task` at the start of a message -> the persona name, else null. */
export function atPersona(text: string): string | null {
  const m = /^@([a-z0-9-]{2,32})(?:\s|$)/.exec(text.trimStart());
  return m ? m[1] : null;
}
/** The system-side line for an `@persona` message: the model is asked to use the normal `delegate` tool (same card, same usage trail). */
export function personaHint(name: string): string {
  return `[Client note, not typed by the user: the message starts with @${name}, the user's subagent persona. Call the delegate tool with persona "${name}" and the text after @${name} as the task (add a short context only if the user referred to earlier messages), then answer using its summary.]`;
}

export type EngineOpts = {
  sql: Sql; provider: ModelProvider; sink: Sink; index: IndexSink;
  /** The conversation's data scope when already known (sync; null = not resolved yet => curated metas only, a catalog-only model reads as unrated). Absent = curated only. */
  metaScope?: () => string | null;
  /** Resolves the scope when metaScope() is still null (a cold session): ensureMeta uses it, inside its own deadline, BEFORE choosing the shared refresh state. */
  resolveMetaScope?: () => Promise<string | null>;
  /** Resolve the scope and load its catalog/provider metas (a fresh DO has neither): awaited before a turn uses a model whose meta is not known yet. */
  loadMetas?: () => Promise<void>;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  /** Deadline for the image pre-flight's capability load (default 8000 ms); injectable so tests need no real wait. */
  preflightMs?: number;
  retryDelayMs?: number; maxIterations?: number;
  /** Time-to-first-byte (ms) for a model call WITHOUT failover. Default 60 s (120 s for reasoning-flagged models); a failover turn uses the hook's own value. */
  firstByteMs?: (modelId: string) => number;
  tools?: ToolHost | null; files?: FileStore | null;
  /** Template of the slash skill `name` in the caller's scope, or null (definitively unknown -> plain text); a lookup error must throw (the send fails closed). */
  skills?: (name: string) => Promise<string | null>;
  /** True when `name` is one of the caller's subagent personas (for `@persona` messages; a lookup error counts as no). Absent = `@` is plain text. */
  personaExists?: (name: string) => Promise<boolean>;
  /** Profile instructions appended to the system prompt (scope main only; null = none). A lookup error must throw (the turn ends in an error rather than silently dropping them). */
  instructions?: () => Promise<string | null>;
  /** The conversation's project instructions (main scope, active project; null = none). Looked up once per turn (pinned: an edit applies from the next turn on). A lookup error fails the turn closed. */
  project?: () => Promise<{ name: string; text: string } | null>;
  /** Overrides the model's context window (tests; also lets a deployment pin one). */
  contextWindow?: number;
  /** Image-generation confirm line in USD (the `gen_confirm_usd` settings row; default 1.00). Not a cap. */
  genConfirmUsd?: () => number | Promise<number>;
  /** Auto model, SHADOW mode (setting `auto_shadow`, default off): when true the engine computes the route for each turn and records it
   *  on the turn's usage rows without changing the model that runs. Absent = off. A lookup error counts as off. */
  autoShadow?: () => boolean | Promise<boolean>;
  /** Setting `auto_delegate` (default off): when true AND the `delegate` tool is offered, the system prompt carries a paragraph telling the model to delegate by itself.
   *  Looked up once per turn (stable across the turn's model calls). Absent / lookup error = off. */
  autoDelegate?: () => boolean | Promise<boolean>;
  /** Setting `answer_limit:<base>`: "off" = a Vertex-gateway model gets the largest safe max_tokens (src/output-budget.ts) instead of meta.maxTokens. Read once per turn; absent / lookup error = "default" (today's behaviour). */
  answerLimit?: () => AnswerLimit | Promise<AnswerLimit>;
  /** Setting `open_force_tool_cues` (default ON; '0' = off): an Open NIM turn whose user message has a live-data cue (src/live-cues.ts) makes its FIRST model call with a tool call required. Absent / lookup error = off. */
  forceToolCues?: () => boolean | Promise<boolean>;
  /** Setting `debug_turns:<base>` = '1': one `DBGTURN {json}` console line per model call (diagnostics, OFF by default). Read once per turn; absent / error = off. */
  debugTurns?: () => boolean | Promise<boolean>;
  /** Models the scope may use, for the router (provider list for this scope). Absent = shadow records nothing. */
  autoCandidates?: () => Promise<AutoCandidate[]>;
  /** Optional worst-case $ ceiling for APPLIED Auto routing (setting row `auto_max_usd:<scope>`). Absent/invalid = no ceiling; with one set and everything over it Auto picks the cheapest eligible model ("over your ceiling"), never refuses. */
  autoMaxUsd?: () => number | Promise<number>;
  /** True when the default model is a plausible fallback for this scope (main/e2e). Absent = false: with no model list and no last model, Auto reports "no model available" instead of guessing. */
  autoDefaultPlausible?: () => boolean | Promise<boolean>;
  /** false = this conversation's space has no Auto (Open): an `auto` model is refused with a plain error. Absent = allowed. */
  autoAllowed?: () => boolean | Promise<boolean>;
  /** true = this conversation is in Open: the system prompt is the Open variant (no personal-connector / Vertex claims). Absent = Business text; a lookup error = Open text (fail closed). */
  openSpace?: () => boolean | Promise<boolean>;
  /** Open-space automatic model failover (src/failover.ts). Absent = off (Business never has it). */
  failover?: FailoverHook;
  /** Approval modes (src/approval.ts). Every member is optional and every failure FAILS CLOSED to "ask": absent hook = no persistent grants, no Auto, no audit.
   *  `autoOn` = the admin switch (settings `approval_auto:<base>`); `userHosts` = the user's persistent host grants (already empty when the switch is off);
   *  `audit` is awaited BEFORE an auto-approved call runs and a throw turns the call back into a card; `saveUserGrant` stores one persistent host grant. */
  approvals?: {
    autoOn(): Promise<boolean>; userHosts(): Promise<ReadonlySet<string>>;
    audit(e: { conversationId: string; tool: string; subject: string; source: AutoSource; mode: ApprovalMode }): Promise<void>;
    saveUserGrant(tool: string, host: string): Promise<boolean>;
    /** Granted-host calls only: does the address answer without any redirect? Absent = the check passes (tests). */
    noRedirect?(url: string, host: string): Promise<boolean>;
    /** Arm a wake-up at this epoch ms so a parked card expires without anyone opening the chat (the DO alarm). */
    scheduleExpiry?(at: number): void;
  };
  /** false = this conversation's owner has no personal connector at all (a team user): the system prompt then carries no connector/notes/tasks text. Absent = true. Lookup error = false. */
  personalTools?: () => boolean | Promise<boolean>;
  /** Called when a turn ends done/error/awaiting (fire-and-forget; never allowed to affect the turn). Used for Web Push. */
  onTurnEnd?: (n: TurnEndInfo) => void | Promise<void>;
};
/** Strip the artefacts a model adds around an auto-title ("# Conversation Title: X", quotes, bold, trailing dot). */
export function cleanTitle(raw: string): string {
  return raw.trim().replace(/^(?:#+\s*)?(?:(?:conversation\s+)?title\s*:\s*)?/i, "").replace(/^["'“”*]+|["'“”.*]+$/g, "").trim().slice(0, 80);
}

/** The title model sometimes answers with its own reasoning ("I need to provide a title…") instead of a title. */
export function looksLikeReasoning(t: string): boolean {
  return t.split(/\s+/).length > 12 || /^(?:i\s+(?:need|should|will|'ll|must|want)|let me|the user|okay|ok,|sure|here(?:'s| is)|this (?:is|conversation)|based on|to (?:write|create|provide))\b/i.test(t);
}

/** Last-resort title: the first words of the user's message, trimmed to <=6 words. */
export function fallbackTitle(userText: string): string {
  const w = userText.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6).join(" ");
  return cleanTitle(w).slice(0, 60);
}

export type TurnEndInfo = { conversationId: string; status: "done" | "error" | "awaiting"; title: string; preview: string; /** a generation that finished (push "Video ready") */ media?: "video" };

export type StoredMessage = {
  id: number; role: "user" | "assistant"; content: Block[]; model: string | null; usage: Usage | null; costUsd: number | null;
  stopReason: string | null; status: string; ttftMs: number | null; totalMs: number | null; createdAt: number;
  /** failed provider attempts before the successful one (ttftMs counts from the successful attempt's start, not from the first try) */
  retries?: number | null;
  /** Auto / override: the concrete model + effort this message ran on (null = a plain manual-model message). */
  route?: RouteInfo | null;
};

export class ChatEngine {
  private sql: Sql; private provider: ModelProvider; private sink: Sink; private index: IndexSink;
  private metaScope?: () => string | null; private resolveMetaScope?: () => Promise<string | null>;
  private loadMetas?: () => Promise<void>;
  private preflightMs = 8000; private preflightWake: (() => void) | null = null;
  private now: () => number; private sleep: (ms: number) => Promise<void>;
  private retryDelayMs: number; private maxIterations: number; private ttfbOf: (modelId: string) => number;
  private tools: ToolHost | null; private files: FileStore | null; private contextWindow: number | undefined;
  private abort: AbortController | null = null;
  private gen: GenEngine;
  private stopRequested = false;
  private _running = false;
  get running() { return this._running; }

  private onTurnEnd?: EngineOpts["onTurnEnd"];
  private notifyEnd(status: TurnEndInfo["status"], media?: TurnEndInfo["media"]) {
    if (!this.onTurnEnd || !this.convId) return;
    try {
      const a = [...this.messages()].reverse().find((m) => m.role === "assistant");
      void Promise.resolve(this.onTurnEnd({ conversationId: this.convId, status, title: this.meta("title") ?? "", preview: a ? this.textOf(a.content) : "", ...(media ? { media } : {}) })).catch((e) => console.error("onTurnEnd", String(e)));
    } catch (e) { console.error("onTurnEnd", String(e)); }
  }

  private personaLookup: ((name: string) => Promise<boolean>) | null = null;
  private skillLookup: ((name: string) => Promise<string | null>) | null = null;
  private instructionsLookup: (() => Promise<string | null>) | null = null;
  private projectLookup: (() => Promise<{ name: string; text: string } | null>) | null = null;
  private autoShadowOn: (() => boolean | Promise<boolean>) | null = null;
  private autoDelegateOn: (() => boolean | Promise<boolean>) | null = null;
  private forceToolCuesOn: (() => boolean | Promise<boolean>) | null = null;
  private debugTurnsOn: (() => boolean | Promise<boolean>) | null = null;
  private pinnedDebug: { turn: number; v: boolean } | null = null;
  private pinnedAutoDelegate: { turn: number; v: boolean } | null = null;
  private answerLimitOn: (() => AnswerLimit | Promise<AnswerLimit>) | null = null;
  private pinnedAnswerLimit: { turn: number; v: AnswerLimit } | null = null;
  /** Models whose raised max_tokens a provider rejected with a 400 in this turn: they stay at meta.maxTokens until the turn ends. */
  private budgetRejected: { turn: number; models: Set<string> } | null = null;
  private autoCandidatesLookup: (() => Promise<AutoCandidate[]>) | null = null;
  private autoMaxUsdLookup: (() => number | Promise<number>) | null = null;
  private autoDefaultPlausibleLookup: (() => boolean | Promise<boolean>) | null = null;
  private openSpaceLookup: (() => boolean | Promise<boolean>) | null = null;
  private failover: FailoverHook | undefined;
  private autoAllowedLookup: (() => boolean | Promise<boolean>) | null = null;
  private approvals: EngineOpts["approvals"] | null = null;
  private redirectDemoted = new Set<string>(); // tool_use ids whose grant was refused because the address redirects (card shows why)
  private personalToolsLookup: (() => boolean | Promise<boolean>) | null = null;
  /** Shadow route of the turn in flight; stamped on that turn's assistant usage rows. Never read by anything that picks the model. */
  private shadow: RoutedInfo | null = null;
  /** Applied route of the turn in flight (Auto resolution, fallback escalation or a one-message override); null for a plain manual-model turn. */
  private turnRoute: RouteInfo | null = null;
  /** Router input of the turn in flight, kept for the escalation after a retryable failure. */
  private routeInput: AutoInput | null = null;
  private escalated = false;
  /** Inline title (src/inline-title.ts): the turn that asked for a marker, and the first valid title its reply carried. */
  private titleTurn: number | null = null;
  private inlineTitle: string | null = null;
  /** The marker instruction goes out on the FIRST model call of the conversation only; set once that call was built (a tool-only reply then falls back to the title call). */
  private titleAsked = false;
  private narrationRetryTurn = -1; // the turn that already used its one forced narration retry (at most one per turn, across all model iterations)
  private pinnedProject: { turn: number; v: { name: string; text: string } | null } | null = null;
  constructor(o: EngineOpts) {
    this.sql = o.sql; this.provider = o.provider; this.sink = o.sink; this.index = o.index; this.metaScope = o.metaScope; this.resolveMetaScope = o.resolveMetaScope; this.loadMetas = o.loadMetas;
    this.preflightMs = o.preflightMs ?? 8000; this.now = o.now ?? Date.now; this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ttfbOf = o.firstByteMs ?? ((m) => (this.metaFor(m)?.caps.thinking ? TTFB_REASONING_MS : TTFB_MS));
    this.retryDelayMs = o.retryDelayMs ?? 1500; this.maxIterations = o.maxIterations ?? MAX_ITERATIONS;
    this.onTurnEnd = o.onTurnEnd; this.tools = o.tools ?? null; this.files = o.files ?? null; this.contextWindow = o.contextWindow; this.skillLookup = o.skills ?? null; this.personaLookup = o.personaExists ?? null; this.instructionsLookup = o.instructions ?? null; this.projectLookup = o.project ?? null;
    this.failover = o.failover; this.openSpaceLookup = o.openSpace ?? null; this.autoShadowOn = o.autoShadow ?? null; this.autoDelegateOn = o.autoDelegate ?? null; this.answerLimitOn = o.answerLimit ?? null; this.forceToolCuesOn = o.forceToolCues ?? null; this.debugTurnsOn = o.debugTurns ?? null; this.autoCandidatesLookup = o.autoCandidates ?? null; this.autoMaxUsdLookup = o.autoMaxUsd ?? null; this.autoDefaultPlausibleLookup = o.autoDefaultPlausible ?? null; this.autoAllowedLookup = o.autoAllowed ?? null; this.approvals = o.approvals ?? null; this.personalToolsLookup = o.personalTools ?? null;
    this.gen = new GenEngine({ host: this.genHost(), provider: this.provider, files: this.files, index: this.index, confirmUsd: o.genConfirmUsd });
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL,
      model TEXT, usage TEXT, cost_usd REAL, stop_reason TEXT, status TEXT NOT NULL DEFAULT 'complete', ttft_ms INTEGER, total_ms INTEGER, created_at INTEGER NOT NULL)`);
    if (!this.sql.exec(`SELECT name FROM pragma_table_info('messages') WHERE name='retries'`).toArray().length) this.sql.exec(`ALTER TABLE messages ADD COLUMN retries INTEGER`); // additive
    if (!this.sql.exec(`SELECT name FROM pragma_table_info('messages') WHERE name='route'`).toArray().length) this.sql.exec(`ALTER TABLE messages ADD COLUMN route TEXT`); // additive, per-conversation (Durable Object) store
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, turn INTEGER NOT NULL, data TEXT NOT NULL)`);
  }

  // ---- meta helpers ----
  meta(k: string): string | null { return (this.sql.exec(`SELECT v FROM meta WHERE k=?`, k).toArray()[0] as any)?.v ?? null; }
  setMeta(k: string, v: string | null) {
    if (v === null) this.sql.exec(`DELETE FROM meta WHERE k=?`, k);
    else this.sql.exec(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v);
  }
  get convId(): string { return this.meta("conv") ?? ""; }
  setConvId(id: string) { if (!this.meta("conv")) this.setMeta("conv", id); }

  /** Call once after construction (inside blockConcurrencyWhile): a turn still marked running belonged to a previous
   *  instance that was evicted/redeployed — rebuild its partial from the persisted events and close it. */
  async init() {
    // A generation request was dispatched and its usage row never written (evicted mid-call): record it now, cost unknown + estimate.
    const disp = this.meta("gen_dispatched");
    let lostGen: GenDispatch | null = null;
    if (disp) {
      try { lostGen = JSON.parse(disp) as GenDispatch; } catch { lostGen = null; }
      if (!lostGen || !this.convId) this.setMeta("gen_dispatched", null); // unreadable / nothing to attribute it to
      else {
        // Idempotent on the dispatch id: if the original insert did land before eviction this is a no-op. The marker is cleared only after
        // success; on failure it stays and the next init() retries (same id, so never two rows).
        try {
          await this.index.recordUsage({ conversationId: this.convId, model: String(lostGen.model), usage: { input_tokens: 0, output_tokens: 0 }, costUsd: null, kind: lostGen.kind, estUsd: Number(lostGen.est_usd) || 0, units: 0, dispatchId: lostGen.id });
          this.setMeta("gen_dispatched", null);
        } catch (e) { console.error("usage (recovered)", String(e)); }
      }
    }
    if (this.meta("running") !== "1") return;
    const turn0 = Number(this.meta("turn") ?? 0);
    if (this.meta("gen_turn") === String(turn0)) {
      // A generation cannot be resumed or safely retried (a retry could bill twice): close it as a non-retryable error.
      const what = this.meta("gen_kind") === "video" ? "video" : "image";
      const msg = `The server restarted while the ${what} was generating.${lostGen ? ` The request was already sent: billing uncertain (estimated $${Number(lostGen.est_usd).toFixed(Number(lostGen.est_usd) < 0.1 ? 3 : 2)}).` : ""}`;
      this.emit(turn0, { type: "error", error: { type: "interrupted", message: msg } });
      this.endTurn(turn0, "error", { type: "interrupted", message: msg, retryable: false });
      return;
    }
    if (this.meta("dev_turn") === String(turn0)) { this.recoverDeviceTurn(turn0); return; } // a device turn is NEVER recovered through the generic (cloud) path
    const turn = Number(this.meta("turn") ?? 0);
    const from = Number(this.meta("msg_start_seq") ?? 0);
    const acc = new BlockAccumulator();
    if (from) for (const r of this.sql.exec(`SELECT seq, ts, data FROM events WHERE seq>=? AND turn=? ORDER BY seq`, from, turn).toArray()) {
      const e = JSON.parse(r.data); if (e.type.startsWith("content_block")) acc.feed(e, r.ts);
    }
    const partial = from ? this.finishedForPartial(acc) : [];
    let usage: Usage | null = null;
    let model = this.meta("model") ?? DEFAULT_MODEL;
    if (model === AUTO_MODEL) { const tr = this.storedRoute(); model = tr?.model ?? this.lastConcreteModel() ?? DEFAULT_MODEL; if (tr) this.turnRoute = tr; }
    if (partial.length) this.saveAssistant(turn, model, partial, usage, null, "interrupted", null, null);
    this.emit(turn, { type: "error", error: { type: "interrupted", message: "The server restarted during this turn." } });
    this.endTurn(turn, "error", { type: "interrupted", message: "The server restarted during this turn.", retryable: true });
  }

  /** Restart recovery of an interrupted device turn. The fold's own state is not persisted, but everything it produced is: saved messages (cards and calls are saved before they show) and the live events emitted since the last saved
   *  assistant message (`dev_saved_seq`). Rebuild the unsaved tail from those, then do what DeviceFolder.abort() does: persist it, give every saved call without a result exactly one, withdraw the approval cards and end the turn
   *  interrupted. Never redispatched, never retryable: the device may have done anything meanwhile. `dev_session` is left as persisted (the next message says, and falls back to a fresh start if the session is gone). */
  private recoverDeviceTurn(turn: number) {
    const acc = new BlockAccumulator();
    const from = Number(this.meta("dev_saved_seq") ?? this.meta("turn_start_seq") ?? 0);
    for (const r of this.sql.exec(`SELECT seq, ts, data FROM events WHERE seq>? AND turn=? ORDER BY seq`, from, turn).toArray()) {
      let e: any; try { e = JSON.parse(r.data); } catch { continue; }
      if (typeof e?.type === "string" && e.type.startsWith("content_block")) acc.feed(e, r.ts);
    }
    const partial = this.finishedForPartial(acc);
    if (partial.length) this.saveAssistant(turn, "device", partial, null, null, "interrupted", null, null);
    const umsg = Number(this.meta("dev_umsg") ?? 0);
    const calls = new Set<string>(), answered = new Set<string>();
    for (const m of this.messages()) {
      if (m.id <= umsg || !Array.isArray(m.content)) continue;
      for (const b of m.content as Block[]) { if (b?.type === "tool_use") calls.add(String(b.id)); else if (b?.type === "tool_result") answered.add(String(b.tool_use_id)); }
    }
    const open = [...calls].filter((id) => !answered.has(id));
    if (open.length) this.saveToolResults(turn, open.map((id) => ({ type: "tool_result", tool_use_id: id, content: "Stopped before this finished.", is_error: true })));
    if (this.devAwaiting().length) { this.setMeta("dev_awaiting", null); this.emit(turn, { type: "approval_cancelled" }); }
    const msg = "The server restarted during this turn. The device may still be working; send another message to continue.";
    this.emit(turn, { type: "error", error: { type: "interrupted", message: msg } });
    this.endTurn(turn, "interrupted", { type: "interrupted", message: msg, retryable: false });
  }

  // ---- events ----
  private emit(turn: number, ev: ServerEvent): number {
    const ts = this.now();
    const seq = (this.sql.exec(`INSERT INTO events (ts, turn, data) VALUES (?,?,?) RETURNING seq`, ts, turn, JSON.stringify(ev)).toArray()[0] as any).seq as number;
    try { this.sink.broadcast(seq, ts, ev); } catch { /* a dead socket must never break a turn */ }
    return seq;
  }
  lastSeq(): number { return (this.sql.exec(`SELECT COALESCE(MAX(seq),0) AS s FROM events`).toArray()[0] as any).s; }
  minSeq(): number { return (this.sql.exec(`SELECT COALESCE(MIN(seq),0) AS s FROM events`).toArray()[0] as any).s; }
  eventsSince(since: number): Array<{ seq: number; ts: number; e: ServerEvent }> {
    return this.sql.exec(`SELECT seq, ts, data FROM events WHERE seq>? ORDER BY seq`, since).toArray().map((r: any) => ({ seq: r.seq, ts: r.ts, e: JSON.parse(r.data) }));
  }
  /** true when a client at `since` can be caught up from stored events (else it must reload state over HTTP) */
  canReplayFrom(since: number): boolean {
    const min = this.minSeq(), last = this.lastSeq();
    return since <= last && (min === 0 || since >= min - 1);
  }

  // ---- messages ----
  private rowToMsg(r: any): StoredMessage {
    return { id: r.id, role: r.role, content: JSON.parse(r.content), model: r.model, usage: r.usage ? JSON.parse(r.usage) : null, costUsd: r.cost_usd,
      stopReason: r.stop_reason, status: r.status, ttftMs: r.ttft_ms, totalMs: r.total_ms, createdAt: r.created_at, retries: r.retries ?? null,
      route: r.route ? (() => { try { return JSON.parse(r.route) as RouteInfo; } catch { return null; } })() : null };
  }
  messages(): StoredMessage[] { return this.sql.exec(`SELECT * FROM messages ORDER BY id`).toArray().map((r) => this.rowToMsg(r)); }

  /** Fork target only: copies an earlier conversation's prefix into an EMPTY transcript. No usage/cost rows (the original keeps its spend),
   *  no index rows (the fork's own text is indexed as it grows). Refuses to touch a conversation that already has messages. */
  seedHistory(model: string, title: string, msgs: Array<{ role: "user" | "assistant"; content: Block[]; model?: string | null }>, tainted = false): boolean {
    if (this.messages().length || this._running) return false;
    if (tainted || isTainted(msgs as any) || msgs.some((m) => m.content.some((b) => b.type === "tool_result"))) this.markTainted(); // a fork inherits taint (fail closed on any tool result)
    else this.setMeta("webtaint", "0"); // explicitly clean: only a conversation that STARTED clean may have a missing flag read as clean (see webTainted)
    // Each copied answer keeps the concrete model it ran on (an Auto conversation's `model` is "auto"), so the fork's first Auto turn is sticky on it.
    // A legacy/copied answer with no usable model never gets `auto`: it takes the conversation's last concrete model, else none (no stickiness from it).
    const concrete = (x: unknown): x is string => typeof x === "string" && !!x && x !== AUTO_MODEL;
    const lastConcrete = [...msgs].reverse().find((m) => m.role === "assistant" && concrete(m.model))?.model ?? (concrete(model) ? model : null);
    for (const m of msgs) this.sql.exec(`INSERT INTO messages (role, content, model, status, created_at) VALUES (?,?,?, 'complete', ?)`, m.role, JSON.stringify(m.content), m.role === "assistant" ? (concrete(m.model) ? m.model : lastConcrete) : null, this.now());
    this.setMeta("model", model);
    if (title) this.setMeta("title", title);
    return true;
  }

  private saveUser(text: string, files: FileRef[] = []): StoredMessage {
    try { if (this.meta("webtaint") === null && !this.sql.exec(`SELECT 1 FROM messages LIMIT 1`).toArray().length) this.setMeta("webtaint", "0"); } catch { /* unreadable => webTainted() fails closed */ } // a brand-new conversation starts clean
    if (files.length) this.markTainted(); // attachments: single choke point for user-supplied file text/images (could carry injected instructions)
    const content: Block[] = [...files.map((f) => ({ type: "file_ref", ref: f.ref, name: f.name, mime: f.mime, size: f.size })), ...(text ? [{ type: "text", text }] : [])];
    const r = this.sql.exec(`INSERT INTO messages (role, content, created_at) VALUES ('user', ?, ?) RETURNING *`, JSON.stringify(content), this.now()).toArray()[0];
    return this.rowToMsg(r);
  }
  private saveToolResults(turn: number, results: Block[]): StoredMessage {
    const r = this.sql.exec(`INSERT INTO messages (role, content, created_at) VALUES ('user', ?, ?) RETURNING *`, JSON.stringify(results), this.now()).toArray()[0];
    const m = this.rowToMsg(r);
    this.emit(turn, { type: "tool_results", message: m });
    return m;
  }
  private saveAssistant(turn: number, model: string, content: Block[], usage: Usage | null, stop: string | null, status: string, ttftMs: number | null, totalMs: number | null, retries: number | null = null): StoredMessage {
    const cost = usage ? costOf(usage, this.metaFor(model)?.price) : null;
    content = content.map((b) => scrubBlock(b)); // belt and braces: a duplicated/late marker never reaches storage
    const r = this.sql.exec(`INSERT INTO messages (role, content, model, usage, cost_usd, stop_reason, status, ttft_ms, total_ms, created_at, route, retries) VALUES ('assistant',?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      JSON.stringify(content), model, usage ? JSON.stringify(usage) : null, cost, stop, status, ttftMs, totalMs, this.now(), this.turnRoute && this.turnRoute.model === model ? JSON.stringify(this.turnRoute) : null, retries).toArray()[0];
    const m = this.rowToMsg(r);
    this.emit(turn, { type: "assistant_saved", message: m });
    this.afterAssistantSaved(m, model);
    return m;
  }
  private textOf(content: Block[]) { return content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n"); }
  private afterAssistantSaved(m: StoredMessage, model: string) {
    const conv = this.convId;
    if (!conv) return;
    const text = this.textOf(m.content);
    void this.index.indexMessage({ conversationId: conv, seq: m.id, role: "assistant", text }).catch((e) => console.error("index", String(e)));
    // Semantic index: only a finished answer (complete, no pending tool call, some text) pairs with the user's own text that started it.
    if (this.index.indexExchange && m.status === "complete" && text.trim() && !m.content.some((b) => b.type === "tool_use")) {
      try {
        let userText = "";
        for (const r of this.sql.exec(`SELECT content FROM messages WHERE role='user' AND id<? ORDER BY id DESC LIMIT 20`, m.id).toArray()) {
          const blocks = JSON.parse(String(r.content)) as Block[];
          if (blocks.some((b) => b.type === "tool_result")) continue; // a tool-result message is untrusted content, not the user's words
          userText = this.textOf(blocks); break;
        }
        void this.index.indexExchange({ conversationId: conv, seq: m.id, userText, assistantText: text, ts: m.createdAt }).catch((e) => console.error("semantic index", e instanceof Error ? e.message : "error"));
      } catch (e) { console.error("semantic index", e instanceof Error ? e.message : "error"); }
    }
    if (m.usage) void this.index.recordUsage({ conversationId: conv, model, usage: m.usage, costUsd: m.costUsd, ...(this.turnRoute && this.turnRoute.model === model ? { routed: this.routedOf(this.turnRoute) } : this.shadow ? { routed: this.shadow } : {}) }).catch((e) => console.error("usage", String(e)));
  }

  // ---- Auto (applied): resolve `auto` to a concrete (model, effort) once per fresh user turn ----
  private routedOf(r: RouteInfo): RoutedInfo { return { by: r.by, model: r.model, reason: `${r.reason}${r.effort ? ` | effort ${r.effort}` : ""}` }; }
  /** The route of the user turn in flight. Not keyed by the turn counter: an approval resume or a restart recovery bumps/reuses it, but the route belongs to the user message
   *  and is cleared when the next fresh turn starts. */
  private storedRoute(): RouteInfo | null {
    try { const j = JSON.parse(this.meta("turn_route") ?? "null"); return j && typeof j.model === "string" ? (j.route as RouteInfo) : null; } catch { return null; }
  }
  /** The conversation's last concrete model: what Auto last ran (overrides do not count), else the last assistant message's own model. */
  private lastConcreteModel(): string | null {
    const a = this.meta("auto_last");
    if (a && a !== AUTO_MODEL) return a;
    const prev = [...this.messages()].reverse().find((m) => m.role === "assistant" && m.model && m.model !== AUTO_MODEL && this.metaFor(m.model));
    return prev?.model ?? null;
  }
  private setRoute(turn: number, route: RouteInfo) {
    this.turnRoute = route;
    this.setMeta("turn_route", JSON.stringify({ turn, model: route.model, route }));
    this.emit(turn, { type: "route", route });
  }

  /** Decide the concrete model for this turn and set `turnRoute`. A one-message override wins; `auto` is routed (any routing error falls back to the
   *  conversation's last concrete model or the default, never failing the turn); any other id runs as is. Returns null when the router REFUSED
   *  (cost guard / nothing eligible): the turn was ended with a plain error. */
  private async applyRoute(turn: number, model: string, resumed: boolean, override: RouteOverride | null, userMsgId: number | null): Promise<string | null> {
    if (resumed) { // after an approval: the same turn keeps the model it started on
      const r = this.storedRoute();
      if (r) { this.turnRoute = r; return r.model; }
      this.turnRoute = null;
      if (model !== AUTO_MODEL) return model;
      const fb = await this.fallbackModel();
      if (!fb) return this.noModel(turn);
      this.setRoute(turn, { by: "auto-fallback", model: fb.id, effort: null, reason: `route lost, using ${fb.id}${fb.listUnavailable ? "; list unavailable" : ""}`, fallbackFrom: AUTO_MODEL });
      return fb.id;
    }
    this.turnRoute = null; this.routeInput = null; this.escalated = false; this.setMeta("turn_route", null);
    { let keep = false; try { keep = !!override && JSON.parse(this.meta("fo_continue") ?? "null")?.model === override.model; } catch { /* none */ } if (!keep) this.setMeta("fo_continue", null); } // a stored continue lives for ONE user turn
    const failedBefore = this.meta("auto_failed") === "1"; this.setMeta("auto_failed", null);
    if (override) {
      const route: RouteInfo = { by: "manual-override", model: override.model, effort: sendableEffort(override.model, override.effort), reason: "chosen on this message with Retry with…" };
      this.setRoute(turn, route);
      return route.model;
    }
    if (model !== AUTO_MODEL) return model;
    if (this.autoAllowedLookup && !(await (async () => this.autoAllowedLookup!())().catch(() => false))) { // fail closed: no answer = no Auto
      const err = { type: "invalid_request_error", message: "model not available in this space", retryable: false };
      this.emit(turn, { type: "error", error: err });
      this.endTurn(turn, "error", err);
      return null;
    }
    try {
      const i = await this.autoInput(userMsgId, failedBefore);
      const r = routeAuto(i);
      if (!r.model) {
        const err = { type: "auto_refused", message: `Auto could not pick a model: ${r.refused ?? "none eligible"}. Choose a model yourself, or shorten the conversation.`, retryable: false };
        this.emit(turn, { type: "error", error: err });
        this.endTurn(turn, "error", err);
        return null;
      }
      const effort = sendableEffort(r.model, r.effort);
      this.routeInput = i;
      this.setRoute(turn, { by: "auto-route", model: r.model, effort, reason: r.reason + (r.effort && !effort ? `; effort ${r.effort} not sent (model does not take it)` : "") });
      if (i.lastModel && tierOfModel(r.model) > tierOfModel(i.lastModel)) this.setMeta("auto_esc", String(turn));
      this.setMeta("auto_last", r.model);
      return r.model;
    } catch (e) {
      console.error("auto route", String(e));
      const fb = await this.fallbackModel();
      if (!fb) return this.noModel(turn);
      this.setRoute(turn, { by: "auto-fallback", model: fb.id, effort: null, reason: `routing failed, using ${fb.id}${fb.listUnavailable ? "; list unavailable" : ""}`, fallbackFrom: AUTO_MODEL });
      return fb.id;
    }
  }

  private noModel(turn: number): null {
    const err = { type: "no_model", message: "No model is available for Auto right now. Choose a model yourself, or try again.", retryable: true };
    this.emit(turn, { type: "error", error: err });
    this.endTurn(turn, "error", err);
    return null;
  }
  /** A model this conversation already ran successfully (a complete assistant answer in its own history), newest first. */
  private lastUsedModel(): string | null {
    const prev = [...this.messages()].reverse().find((m) => m.role === "assistant" && m.status === "complete" && m.model && m.model !== AUTO_MODEL && this.metaFor(m.model));
    return prev?.model ?? null;
  }
  /** The turn's own facts for the hard filters (last user message with text/files; same estimate as autoInput). */
  private turnFacts(): { text: string; hasImage: boolean; hasPdf: boolean; estPromptTokens: number } {
    const msgs = this.messages();
    let li = msgs.length - 1;
    while (li >= 0 && !(msgs[li].role === "user" && msgs[li].content.some((b) => b.type === "text" || b.type === "file_ref"))) li--;
    const files = li >= 0 ? msgs[li].content.filter((b) => b.type === "file_ref") : [];
    const chars = SYSTEM_PROMPT.length + msgs.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
    return { text: li >= 0 ? msgs[li].content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n") : "",
      hasImage: files.some((b) => IMAGE_MIMES.has(b.mime)), hasPdf: files.some((b) => b.mime === "application/pdf"), estPromptTokens: Math.ceil(chars / 3) };
  }
  /** A model Auto may fall back to when routing itself failed, ALWAYS inside the scope AND passing this turn's hard filters (vision/pdf, context fit, haiku cliff):
   *  the last concrete model while it is listed and passes, else the default (if it passes) or the cheapest passing Claude chat model; none passing = null.
   *  If the list cannot be read the filters cannot run: the last concrete model ONLY if this conversation already used it successfully, else the default only
   *  where that is plausible (main); otherwise null (the turn ends with a plain "no model available" error). Residual risk of the unreadable-list branch: the
   *  model could be out of scope; the gateway/provider then rejects it with a clean error. */
  private async fallbackModel(): Promise<{ id: string; listUnavailable: boolean } | null> {
    let list: AutoCandidate[] | null = null;
    try { list = this.autoCandidatesLookup ? await this.autoCandidatesLookup() : null; } catch { list = null; }
    if (list) {
      const last = this.lastConcreteModel();
      const ok = hardFilter({ ...this.turnFacts(), candidates: list });
      if (last && ok.has(last)) return { id: last, listUnavailable: false };
      if (ok.has(DEFAULT_MODEL)) return { id: DEFAULT_MODEL, listUnavailable: false };
      const price = (id: string) => list!.find((c) => c.id === id)?.meta?.price?.input ?? Infinity;
      const cheapest = [...ok.keys()].sort((x, y) => price(x) - price(y))[0];
      return cheapest ? { id: cheapest, listUnavailable: false } : null;
    }
    const used = this.lastUsedModel();
    if (used) return { id: used, listUnavailable: true };
    try { return (await this.autoDefaultPlausibleLookup?.()) ? { id: DEFAULT_MODEL, listUnavailable: true } : null; } catch { return null; }
  }
  /** Why an override cannot run (null = fine): scope list, Claude chat only, never auto, capability/context for this turn. */
  private async overrideError(text: string, files: FileRef[], o: RouteOverride): Promise<string | null> {
    if (o.model === AUTO_MODEL) return "bad override";
    // Open failover's "Continue with X": the one model the failed turn named (meta fo_continue) may run as an override in an Open chat; Claude-only Retry-with stays Business-only.
    try {
      const c = JSON.parse(this.meta("fo_continue") ?? "null");
      if (c?.model === o.model && this.failover && (await this.openForPrompt())) {
        // re-validated now with the selection filter (listed, key, broken list, capability, fit, breaker, failover still ON): a stale or no-longer-valid continue is dropped and refused
        if (await this.continueStillValid(o.model, text, files)) return null;
        this.setMeta("fo_continue", null);
        return `${o.model} is not available for this chat any more. Pick another model.`;
      }
    } catch { /* not a continue */ }
    if (!this.autoCandidatesLookup) return "Retry with… is not available here";
    let candidates: AutoCandidate[];
    try { candidates = await this.autoCandidatesLookup(); } catch { return "Could not check the model list, try again"; }
    const chars = SYSTEM_PROMPT.length + text.length + this.messages().reduce((n, m) => n + JSON.stringify(m.content).length, 0);
    const ok = hardFilter({ text, hasImage: files.some((f) => IMAGE_MIMES.has(f.mime)), hasPdf: files.some((f) => f.mime === "application/pdf"), estPromptTokens: Math.ceil(chars / 3), candidates });
    return ok.has(o.model) ? null : `${o.model} is not available for this chat`;
  }

  /** Router input for a fresh Auto turn (same estimate as the shadow mode; `toolsNeeded` only when the user explicitly asked for a tool/@persona). */
  private async autoInput(userMsgId: number | null, failedBefore = false): Promise<AutoInput> {
    if (!this.autoCandidatesLookup) throw new Error("no model list for this scope");
    const msgs = this.messages();
    let li = msgs.length - 1;
    while (li >= 0 && !(msgs[li].role === "user" && msgs[li].content.some((b) => b.type === "text" || b.type === "file_ref"))) li--;
    if (li < 0) throw new Error("no user message");
    const user = msgs[li], before = msgs.slice(0, li);
    const prevA = [...before].reverse().find((m) => m.role === "assistant");
    const files = user.content.filter((b) => b.type === "file_ref");
    const chars = SYSTEM_PROMPT.length + msgs.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
    const asked = !!this.slashHints()[userMsgId ?? user.id];
    const lastModel = before.length || failedBefore ? this.lastConcreteModel() : null; // a failed first attempt still escalates on retry
    const esc = Number(this.meta("auto_esc") ?? NaN);
    const turn = Number(this.meta("turn") ?? 0);
    return {
      text: user.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n"),
      hasImage: files.some((b) => IMAGE_MIMES.has(b.mime)), hasPdf: files.some((b) => b.mime === "application/pdf"),
      toolsNeeded: asked, multiStepTools: asked,
      estPromptTokens: Math.ceil(chars / 3), historyTurns: before.length, lastModel,
      prevFailed: failedBefore || (!!prevA && (prevA.stopReason === "max_tokens" || prevA.status === "error")) || msgs.slice(li + 1).some((m) => m.role === "assistant" && (m.status === "error" || m.stopReason === "max_tokens")),
      turnsSinceEscalation: Number.isFinite(esc) ? turn - esc : undefined,
      candidates: await this.autoCandidatesLookup(), maxUsd: await this.autoMaxUsd(),
    };
  }

  private async autoMaxUsd(): Promise<number> {
    try { const v = Number(await this.autoMaxUsdLookup?.()); return Number.isFinite(v) && v > 0 ? v : AUTO_MAX_USD_DEFAULT; } catch { return AUTO_MAX_USD_DEFAULT; }
  }

  /** One retry on the next-up candidate after a retryable upstream failure of an Auto-routed call (never a downgrade, never outside scope/capability/cost cap). */
  private escalateRoute(turn: number, model: string): string | null {
    if (this.escalated || !this.routeInput || !this.turnRoute || (this.turnRoute.by !== "auto-route" && this.turnRoute.by !== "auto-fallback")) return null;
    let next: string | null = null;
    try { next = escalateFrom(this.routeInput, model); } catch { next = null; }
    if (!next) return null;
    this.escalated = true;
    this.emit(turn, { type: "auto_fallback", from: model, to: next });
    this.setRoute(turn, { by: "auto-fallback", model: next, effort: sendableEffort(next, this.turnRoute.effort ?? "medium"), reason: `${this.turnRoute.reason}; ${model} failed upstream, retried on ${next}`, fallbackFrom: model });
    this.setMeta("auto_last", next);
    return next;
  }

  /** Auto SHADOW mode: compute what the router would pick for this turn and remember it for the turn's usage rows. Pure observation: it never
   *  changes `model`, never calls a provider, and any failure (setting lookup, scope list) just means nothing is recorded. */
  private async computeShadow(model: string, tools: ToolDef[]): Promise<void> {
    this.shadow = null;
    try {
      if (!this.autoShadowOn || !this.autoCandidatesLookup || !(await this.autoShadowOn())) return;
      const msgs = this.messages();
      let li = msgs.length - 1;
      while (li >= 0 && !(msgs[li].role === "user" && msgs[li].content.some((b) => b.type === "text" || b.type === "file_ref"))) li--;
      if (li < 0) return;
      const user = msgs[li], before = msgs.slice(0, li);
      const prevA = [...before].reverse().find((m) => m.role === "assistant");
      const files = user.content.filter((b) => b.type === "file_ref");
      const chars = SYSTEM_PROMPT.length + msgs.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
      const r = routeAuto({
        text: user.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n"),
        hasImage: files.some((b) => IMAGE_MIMES.has(b.mime)), hasPdf: files.some((b) => b.mime === "application/pdf"),
        toolsNeeded: tools.length > 0, multiStepTools: false, // whether tools will be used, and how many steps, is unknowable before the call
        estPromptTokens: Math.ceil(chars / 3), historyTurns: before.length, lastModel: before.length ? model : null,
        prevFailed: !!prevA && (prevA.stopReason === "max_tokens" || prevA.status === "error"),
        candidates: await this.autoCandidatesLookup(), maxUsd: SHADOW_MAX_USD,
      });
      this.shadow = { by: "auto", model: r.model, reason: `shadow | ${r.reason}${r.effort ? ` | effort ${r.effort} (not sent)` : ""}` };
      this.setMeta("last_route", JSON.stringify(this.shadow));
    } catch (e) { console.error("auto shadow", String(e)); this.shadow = null; }
  }

  totals() {
    const r = this.sql.exec(`SELECT COALESCE(SUM(cost_usd),0) AS c, COUNT(cost_usd) AS n FROM messages WHERE role='assistant'`).toArray()[0] as any;
    let tokens = 0;
    for (const m of this.sql.exec(`SELECT usage FROM messages WHERE usage IS NOT NULL`).toArray()) tokens += totalTokens(JSON.parse((m as any).usage));
    // Side calls (auto-title, compaction summary) are real spend recorded in `usage`; count them here too so the chat header
    // chip and the Usage screen agree.
    return { costUsd: (r.c as number) + Number(this.meta("aux_cost") ?? 0), tokens: tokens + Number(this.meta("aux_tokens") ?? 0) };
  }
  private addAux(usage: Usage, costUsd: number | null) {
    this.setMeta("aux_cost", String(Number(this.meta("aux_cost") ?? 0) + (costUsd ?? 0)));
    this.setMeta("aux_tokens", String(Number(this.meta("aux_tokens") ?? 0) + totalTokens(usage)));
  }

  state() {
    this.sweepExpired(); // a parked card past its 30 minutes is closed before anyone reads it
    const turn = Number(this.meta("turn") ?? 0);
    const startSeq = Number(this.meta("turn_start_seq") ?? 0);
    return {
      seq: this.lastSeq(), minSeq: this.minSeq(), running: this._running,
      inflight: this._running ? { fromSeq: startSeq } : null,
      model: this.meta("model"), title: this.meta("title") ?? "", turn, webTainted: this.webTainted(), generating: this._running && this.meta("gen_turn") === String(turn),
      ...(this._running && this.meta("gen_turn") === String(turn) ? { genKind: this.meta("gen_kind") ?? "image", genStartedAt: Number(this.meta("gen_started")) || null } : {}),
      error: this._running ? null : JSON.parse(this.meta("error") ?? "null"),
      awaiting: this.awaitingView() ?? this.devAwaitingView(), compactions: JSON.parse(this.meta("compactions") ?? "[]"),
      approvalMode: this.approvalMode(), webGrants: this.chatGrants(), autoLog: this.autoLog(),
      ...this.totals(), messages: this.messages(),
    };
  }

  // ---- commands ----
  stop() {
    if (this._running) { this.stopRequested = true; this.abort?.abort(); this.preflightWake?.(); }
    // A stop that lands after the send was accepted but before the alarm started the turn: remember it, the turn begins already stopped.
    else if (this.meta("pending") || this.devPre) this.setMeta("stop_pending", "1");
  }
  /** A device turn is between the alarm taking its command and deviceBegin() claiming the turn (the async device check): a Stop landing here must still apply to it. */
  private devPre = false;
  deviceExpect(on: boolean) { this.devPre = on; }
  /** ensureMeta (which owns the one deadline) plus Stop interception (no AbortController exists yet in pre-flight, so stop() wakes this wait). `fresh` = an image send: a cached catalog entry older than META_FRESH_MS is reloaded. */
  private async boundedEnsureMeta(model: string, fresh = false): Promise<"ok" | "timeout" | "stopped"> {
    if (this.stopRequested) return "stopped";
    try {
      const stop = new Promise<"stopped">((res) => { this.preflightWake = () => res("stopped"); });
      return await Promise.race([this.ensureMeta(model, fresh).then((ok) => (ok ? "ok" as const : "timeout" as const)), stop]);
    } finally { this.preflightWake = null; }
  }
  /** A pre-flight refusal AFTER takePreStop(): release the claim and drop the stop that was consumed for this send, so it cannot interrupt the next turn. */
  private refuseSend(error: string): { ok: false; error: string } { this._running = false; this.stopRequested = false; return { ok: false, error }; }
  /** Consumed right after a turn claims `_running`: applies a stop that arrived while the command was still queued. */
  private takePreStop() {
    if (this.meta("stop_pending")) { this.setMeta("stop_pending", null); this.stopRequested = true; }
  }

  /** Cheap synchronous validation, so the socket handler can reject before the turn is handed to an alarm. */
  precheck(text: string, model?: string, files: FileRef[] = [], override?: unknown): string | null {
    if (this._running || this.meta("pending")) return "busy";
    if (override != null && model !== undefined) return "override cannot be combined with a model"; // an override send never changes the conversation's model
    if (!Array.isArray(files) || files.length > MAX_FILES_PER_MESSAGE) return `too many files (max ${MAX_FILES_PER_MESSAGE})`;
    for (const f of files) if (!refBelongsTo(f?.ref, this.convId)) return "bad file reference";
    if (!String(text ?? "").trim() && !files.length) return "empty message";
    if (String(text).length > MAX_USER_CHARS) return `message too long (max ${MAX_USER_CHARS} characters)`;
    if (model !== undefined && !isModelIdSyntax(model)) return "bad model id";
    return null;
  }

  async send(text: string, model?: string, files: FileRef[] = [], slash?: SlashHint | null, override?: RouteOverride | null): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this._running) return { ok: false, error: "busy" };
    text = (text ?? "").toString();
    const bad = this.precheck(text, model, files, override);
    if (bad && bad !== "busy") return { ok: false, error: bad };
    this._running = true; // claim synchronously: two racing sends must not both pass the busy check
    this.takePreStop();
    // A /skill pick: the model sees the expanded template, the stored/visible message keeps the user's own text.
    // Resolved BEFORE anything is stored or billed so a failure is a plain pre-flight error (nothing stored, no provider call).
    // Only a definitively absent skill (null) is sent as a normal message; a lookup error fails closed.
    let expanded: string | null = null;
    if (slash && slash.kind === "skill" && typeof slash.name === "string" && SKILL_NAME.test(slash.name) && slash.name !== "advisor" /* builtin wins over a same-named user skill */ && this.skillLookup) {
      try {
        const tpl = await this.skillLookup(slash.name);
        if (tpl) expanded = expandSkill(tpl, slash.name, text);
      } catch (e) { console.error("skill lookup", String(e)); return this.refuseSend("Skill lookup failed, try again"); }
      if (expanded !== null && expanded.length > MAX_SKILL_EXPANDED) return this.refuseSend(`Skill expansion too long (max ${MAX_SKILL_EXPANDED} characters)`);
    }
    // "Retry with…": the model must be a concrete Claude chat model of THIS scope that can take the turn. Checked before anything is stored or billed.
    if (override) {
      const why = await this.overrideError(text, files, override);
      if (why) return this.refuseSend(why);
    }
    // Pre-flight: an image for a model that cannot see images is refused HERE with a clear message, before anything is stored or billed. (expandFiles would
    // otherwise swap it for a note and the model would reply "I can't see images".) "auto" picks a vision model itself, so it is not judged here.
    // The model that actually receives the request: a validated override wins over the conversation model.
    const effModel = override?.model ?? model ?? this.meta("model") ?? DEFAULT_MODEL;
    if (effModel !== AUTO_MODEL && files.some((f) => IMAGE_MIMES.has(String(f?.mime ?? "").toLowerCase()))) {
      const got = await this.boundedEnsureMeta(effModel, true); // cold instance: catalog/Open-provider metas are not loaded yet (same call the turn makes)
      // A catalog that failed or is slow must not block the send: a bare id on the live-proven fallback list is judged by that list (the catalog's images_in wins whenever it loaded).
      const fb = !effModel.includes(":") && GATEWAY_VISION_VERIFIED.has(effModel);
      if (got === "timeout" && !fb && !this.metaFor(effModel)) return this.refuseSend("Could not load the model capabilities. Try again.");
      if (got === "stopped") return this.refuseSend("Stopped.");
      if (!(this.metaFor(effModel)?.caps.images ?? fb)) return this.refuseSend(noImageMessage(effModel));
      const cap = imageCapFor(effModel);
      if (files.some((f) => IMAGE_MIMES.has(String(f?.mime ?? "").toLowerCase()) && Number(f.size) > cap)) return this.refuseSend(imageTooLargeMessage(effModel));
    }
    this.cancelAwaiting();
    const turn = Number(this.meta("turn") ?? 0) + 1;
    this.setMeta("turn", String(turn));
    const m = override ? this.meta("model") ?? DEFAULT_MODEL : model ?? this.meta("model") ?? DEFAULT_MODEL;
    this.setMeta("model", m);
    files = files.map((f) => ({ ref: f.ref, name: String(f.name ?? "file").slice(0, 120), mime: f.mime, size: Number(f.size) || 0 }));
    const um = this.saveUser(text, files);
    let hint = slashHint(slash);
    const at = !hint && !slash && this.personaLookup ? atPersona(text) : null;
    if (at && (await this.personaLookup!(at).catch(() => false))) hint = personaHint(at);
    if (hint) this.setMeta("slash_hints", JSON.stringify({ ...this.slashHints(), [um.id]: hint }));
    if (expanded !== null) this.setMeta("slash_skills", JSON.stringify({ ...this.slashSkills(), [um.id]: expanded }));
    const useq = this.emit(turn, { type: "user_message", message: um });
    void this.index.indexMessage({ conversationId: this.convId, seq: um.id, role: "user", text }).catch((e) => console.error("index", String(e)));
    this.setMeta("turn_start_seq", String(useq));
    await this.runTurn(turn, m, true, false, override ?? null, um.id);
    return { ok: true };
  }

  // ---- device environment (Devices v2 step 3; src/device-env.ts folds, src/device-turn.ts drives): the same message log, event seq and busy flag, a different executor ----
  private devAwaiting(): Array<{ id: string; rid: string; name: string; preview: string; expiresAt: number; decision: "approve" | "deny" | null }> {
    try { return JSON.parse(this.meta("dev_awaiting") ?? "[]"); } catch { return []; }
  }
  private setDevAwaiting(a: ReturnType<ChatEngine["devAwaiting"]>) { this.setMeta("dev_awaiting", a.length ? JSON.stringify(a) : null); }
  /** The approval cards of a running device turn, shaped like awaitingView() so a reload shows the same buttons. Only while the turn runs (a dead turn never shows a live card). */
  private devAwaitingView() {
    if (!this._running) return null;
    const a = this.devAwaiting();
    return a.length ? { expiresAt: Math.min(...a.map((x) => x.expiresAt)) || null, calls: a.map((x) => ({ id: x.id, name: x.name, input: { preview: x.preview }, decision: x.decision, host: null, canAlways: false, reason: null })) } : null;
  }
  private emitDevAwaiting(turn: number) {
    const a = this.devAwaiting().filter((x) => !x.decision);
    this.emit(turn, a.length ? { type: "approval_required", expiresAt: Math.min(...a.map((x) => x.expiresAt)) || null, calls: a.map((x) => ({ id: x.id, name: x.name, input: { preview: x.preview }, host: null, canAlways: false, reason: null })) } : { type: "approval_cancelled" });
  }
  /** Is this chat's own session open on the device (so the next message is a `say`)? Set by the turn driver from the hub's session events. */
  deviceSessionActive(): boolean { return this.meta("dev_session") === "1"; }
  setDeviceSessionActive(on: boolean) { this.setMeta("dev_session", on ? "1" : null); }
  get deviceStopRequested() { return this.stopRequested; }
  /** Claim the turn and store the user's message (same steps as send(), without any model call). */
  deviceBegin(text: string): { ok: true; turn: number; signal: AbortSignal } | { ok: false; error: string } {
    if (this._running) return { ok: false, error: "busy" };
    text = (text ?? "").toString();
    const bad = this.precheck(text);
    if (bad && bad !== "busy") return { ok: false, error: bad };
    this._running = true; this.takePreStop();
    this.cancelAwaiting(); this.setMeta("dev_awaiting", null);
    const turn = Number(this.meta("turn") ?? 0) + 1;
    this.setMeta("turn", String(turn));
    const um = this.saveUser(text);
    const useq = this.emit(turn, { type: "user_message", message: um });
    void this.index.indexMessage({ conversationId: this.convId, seq: um.id, role: "user", text }).catch((e) => console.error("index", String(e)));
    this.setMeta("turn_start_seq", String(useq));
    this.setMeta("dev_turn", String(turn)); this.setMeta("dev_umsg", String(um.id)); this.setMeta("dev_saved_seq", String(useq)); // restart recovery (recoverDeviceTurn)
    this.setMeta("running", "1"); this.setMeta("error", null);
    this.emit(turn, { type: "turn_start", turn }); // no `model`: a device turn must not change the chat's model setting
    this.abort = new AbortController();
    return { ok: true, turn, signal: this.abort.signal };
  }
  /** Run the folder's operations: persist messages, emit live/status/approval events. */
  deviceApply(turn: number, ops: DeviceOp[]) {
    for (const op of ops) {
      if (op.k === "live") this.emit(turn, op.e as ServerEvent);
      else if (op.k === "dev") this.emit(turn, { type: "device_ev", e: op.e });
      else if (op.k === "assistant") { this.saveAssistant(turn, "device", op.blocks, null, op.stop, "complete", null, null); this.setMeta("dev_saved_seq", String(this.lastSeq())); }
      else if (op.k === "results") {
        this.saveToolResults(turn, op.blocks);
        const done = new Set(op.blocks.map((b) => String(b.tool_use_id)));
        const left = this.devAwaiting().filter((x) => !done.has(x.id));
        if (left.length !== this.devAwaiting().length) { this.setDevAwaiting(left); if (left.some((x) => !x.decision)) this.emitDevAwaiting(turn); } // tool_results clears the page's cards: put the still-open ones back
      } else if (op.k === "approval") {
        const a = this.devAwaiting().filter((x) => x.rid !== op.rid);
        a.push({ id: op.id, rid: op.rid, name: op.tool, preview: op.preview, expiresAt: op.expires_at * 1000, decision: null });
        this.setDevAwaiting(a); this.emitDevAwaiting(turn);
      } else if (op.k === "approval_resolved") {
        const before = this.devAwaiting();
        if (!before.some((x) => x.rid === op.rid)) continue;
        this.setDevAwaiting(before.filter((x) => x.rid !== op.rid)); this.emitDevAwaiting(turn);
      }
    }
  }
  /** The user's answer on a device approval card: marks it and returns the hub request id to answer. The card stays until the hub confirms (approval_resolved) or the tool result arrives. */
  deviceDecide(id: string, decision: "approve" | "deny"): { ok: true; rid: string } | { ok: false; error: string } {
    if (!this._running) return { ok: false, error: "nothing awaiting approval" };
    const a = this.devAwaiting(), c = a.find((x) => x.id === id);
    if (!c) return { ok: false, error: "unknown tool call" };
    if (c.decision) return { ok: false, error: "already decided" };
    if (c.expiresAt && c.expiresAt <= this.now()) return { ok: false, error: "This approval expired; ask again." };
    c.decision = decision; this.setDevAwaiting(a);
    this.emit(Number(this.meta("turn") ?? 0), { type: "approval_decision", id, decision });
    return { ok: true, rid: c.rid };
  }
  /** A decision the hub refused (expired / already answered): put the card back so the user is not left looking at a button that did nothing. */
  deviceUndecide(id: string) {
    const a = this.devAwaiting(), c = a.find((x) => x.id === id); if (!c) return;
    c.decision = null; this.setDevAwaiting(a); this.emitDevAwaiting(Number(this.meta("turn") ?? 0));
  }
  /** End the turn: leftover approval cards are withdrawn, a stop with nothing produced leaves the "Stopped" row, the first finished turn gets the deterministic title. */
  async deviceEnd(turn: number, status: "done" | "error" | "interrupted", error?: { type: string; message: string; retryable: boolean }, firstUserText?: string) {
    if (this.devAwaiting().length) { this.setMeta("dev_awaiting", null); this.emit(turn, { type: "approval_cancelled" }); }
    if (status === "interrupted") this.saveStoppedEmpty(turn, "device");
    this.endTurn(turn, status, error ? { ...error } : undefined);
    const conv = this.convId;
    if (status !== "done" || !conv) return;
    const t = this.totals();
    await this.index.updateConversation({ id: conv, model: this.meta("model") ?? DEFAULT_MODEL, costUsd: t.costUsd, tokens: t.tokens }).catch((e) => console.error("index", String(e)));
    if (!this.meta("title") && firstUserText) {
      const title = fallbackTitle(firstUserText);
      if (title && (this.index.applyAutoTitle ? await this.index.applyAutoTitle({ id: conv, title }).catch(() => false) : false)) { this.setMeta("title", title); this.emit(turn, { type: "title", title, costUsd: t.costUsd, tokens: t.tokens }); }
    }
    this.notifyEnd("done");
  }

  // ---- image generation (src/gen-engine.ts): same message log / event seq / busy flag, different protocol ----
  /** Validation + server-side confirm gate for a `generate` command (socket handler, before arming the alarm). */
  genPlan(cmd: GenCommand) { return this.gen.plan(cmd); }
  generate(cmd: GenCommand) { return this.gen.run(cmd); }
  private genHost(): GenHost {
    const self = this;
    return {
      get convId() { return self.convId; },
      busy: () => self._running || !!self.meta("pending"),
      begin: () => {
        self.cancelAwaiting();
        const turn = Number(self.meta("turn") ?? 0) + 1;
        self._running = true; // claim synchronously, like send()
        self.setMeta("turn", String(turn));
        self.setMeta("running", "1");
        self.setMeta("error", null);
        self.stopRequested = false;
        self.abort = new AbortController();
        return { turn, signal: self.abort.signal };
      },
      open: (turn, model, text, files, kind = "image") => {
        const um = self.saveUser(text, files);
        const useq = self.emit(turn, { type: "user_message", message: um });
        void self.index.indexMessage({ conversationId: self.convId, seq: um.id, role: "user", text }).catch((e) => console.error("index", String(e)));
        self.setMeta("turn_start_seq", String(useq));
        self.setMeta("gen_turn", String(turn));
        self.setMeta("gen_kind", kind);
        self.setMeta("gen_started", String(self.now()));
        self.emit(turn, { type: "turn_start", turn, model, kind });
        return um;
      },
      markDispatched: (d) => self.setMeta("gen_dispatched", d ? JSON.stringify(d) : null),
      // Not saveAssistant(): that records a token-usage row; the generation records its own (kind 'image' | 'video') row.
      saveAssistant: (turn, model, content, costUsd, stop, status) => {
        const r = self.sql.exec(`INSERT INTO messages (role, content, model, usage, cost_usd, stop_reason, status, ttft_ms, total_ms, created_at) VALUES ('assistant',?,?,NULL,?,?,?,NULL,NULL,?) RETURNING *`,
          JSON.stringify(content), model, costUsd, stop, status, self.now()).toArray()[0];
        const m = self.rowToMsg(r);
        self.emit(turn, { type: "assistant_saved", message: m });
        return m;
      },
      finish: async (turn, status, error, notify) => {
        self.endTurn(turn, status, error);
        const conv = self.convId;
        if (!conv) return;
        try { await indexAndTitle(turn, conv); } finally { if (notify && status === "done") self.notifyEnd("done", notify); } // push after the title exists
      },
    };
    async function indexAndTitle(turn: number, conv: string) {
        const model = self.meta("model") ?? DEFAULT_MODEL; // the CHAT model: generating never changes it
        const t = self.totals();
        await self.index.updateConversation({ id: conv, model, costUsd: t.costUsd, tokens: t.tokens }).catch((e) => console.error("index", String(e)));
        if (!self.meta("title")) { // no Claude call just to title an image prompt: its first words
          const u = self.messages().find((m) => m.role === "user");
          const title = u ? fallbackTitle(self.textOf(u.content)) : "";
          if (title) {
            self.setMeta("title", title);
            self.emit(turn, { type: "title", title, costUsd: t.costUsd, tokens: t.tokens });
            await self.index.updateConversation({ id: conv, model, costUsd: t.costUsd, tokens: t.tokens, title }).catch((e) => console.error("index", String(e)));
          }
        }
    }
  }

  /** Re-run the turn whose user message is last (after an error / interruption). Never adds a user message. */
  async retry(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this._running) return { ok: false, error: "busy" };
    this.cancelAwaiting();
    const last = this.messages().at(-1);
    if (last?.role === "assistant" && toolUses(last).length) this.repairDangling();
    const msgs = this.messages();
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return { ok: false, error: "nothing to retry" };
    const turn = Number(this.meta("turn") ?? 0) + 1;
    this._running = true;
    this.setMeta("turn", String(turn));
    this.setMeta("turn_start_seq", String(this.lastSeq() + 1));
    this.takePreStop();
    await this.runTurn(turn, this.meta("model") ?? DEFAULT_MODEL, false);
    return { ok: true };
  }

  private endTurn(turn: number, status: "done" | "error" | "interrupted" | "awaiting", error?: ServerEvent) {
    if (this.convId) void this.index.releaseSlot?.(this.convId).catch(() => {});
    this._running = false; this.abort = null; this.stopRequested = false;
    this.setMeta("running", null);
    this.setMeta("error", error ? JSON.stringify(error) : null);
    // An Auto-routed turn that ended in an error counts as a failed attempt: the next routing (retry, or the next send) escalates one tier (rule 1).
    if (status === "error" && this.turnRoute && (this.turnRoute.by === "auto-route" || this.turnRoute.by === "auto-fallback")) this.setMeta("auto_failed", "1");
    const t = this.totals();
    this.emit(turn, { type: "turn_end", status, error: error ?? null, costUsd: t.costUsd, tokens: t.tokens });
    this.prune(turn);
    if (status === "error" || status === "awaiting") this.notifyEnd(status);
  }
  private prune(turn: number) {
    this.sql.exec(`DELETE FROM events WHERE turn <= ?`, turn - EVENT_TURNS_KEPT);
  }

  private async runTurn(turn: number, model: string, fresh: boolean, resumed = false, override: RouteOverride | null = null, userMsgId: number | null = null) {
    this.setMeta("running", "1");
    this.setMeta("error", null);
    // stopRequested is NOT reset here: a stop that arrived during send()'s awaits must survive into the turn (endTurn resets it).
    this.emit(turn, { type: "turn_start", turn, model, ...(resumed ? { resumed: true } : {}) });
    const t0 = this.now();
    let firstTurnUser = fresh && this.messages().filter((m) => m.role === "user").length === 1;
    try {
      if (this.index.acquireSlot && this.convId && !(await this.index.acquireSlot(this.convId).catch(() => true))) {
        const err = { type: "busy", message: `Too many conversations are generating at once (max ${MAX_CONCURRENT_TURNS}). Try again in a moment.`, retryable: true };
        this.emit(turn, { type: "error", error: err });
        this.endTurn(turn, "error", err);
        return;
      }
      if (resumed) await this.executeAwaiting(turn);
      await this.ensureMeta(model);
      const concrete = await this.applyRoute(turn, model, resumed, override, userMsgId);
      if (concrete === null) return; // the router refused: the turn already ended with a plain error
      model = concrete;
      await this.ensureMeta(model); // the routed model may be one the scope has not listed yet
      this.inlineTitle = null; this.titleTurn = null; this.titleAsked = false;
      if (firstTurnUser && !this.meta("title") && inlineTitleEnabled((await this.openForPrompt()) ? "open" : "biz")) this.titleTurn = turn;
      const tools = this.tools && this.metaFor(model)?.caps.tools ? await this.tools.list().catch((e) => { console.error("tools", String(e)); return [] as ToolDef[]; }) : [];
      if (!resumed && !this.turnRoute) await this.computeShadow(model, tools);
      for (let iter = 0; iter < this.maxIterations; iter++) {
        if (this.stopRequested) { this.saveStoppedEmpty(turn, model); return this.endTurn(turn, "interrupted"); }
        await this.manageContext(turn, model);
        const r = await this.callModel(turn, model, t0, tools);
        if (this.turnRoute) model = this.turnRoute.model; // an escalation inside callModel changes the model for the rest of the turn
        if (r === "stopped") { this.saveStoppedEmpty(turn, model); return this.endTurn(turn, "interrupted"); }
        if (r === "error") return; // endTurn already called with the error
        if (r === "pause_turn") continue; // resend to continue (no user action)
        if (r === "tool_use") {
          const next = await this.runTools(turn);
          if (next === "awaiting") return this.endTurn(turn, "awaiting");
          continue;
        }
        await this.finishTurn(turn, model, firstTurnUser);
        return;
      }
      const err = { type: "loop_guard", message: `Stopped after ${this.maxIterations} model calls in one turn.`, retryable: false };
      this.emit(turn, { type: "error", error: err });
      this.endTurn(turn, "error", err);
    } catch (e) {
      const err = { type: "internal_error", message: e instanceof Error ? e.message : String(e), retryable: true };
      console.error("turn crashed", err.message);
      this.emit(turn, { type: "error", error: err });
      this.endTurn(turn, "error", err);
    }
  }

  /** A stop before the model produced anything still leaves a visible "Stopped" row (replayed with the neutral marker). */
  private saveStoppedEmpty(turn: number, model: string) {
    if (this.messages().at(-1)?.role === "user") this.saveAssistant(turn, model, [], null, null, "interrupted", null, null);
  }

  private async finishTurn(turn: number, model: string, firstTurn: boolean) {
    const t = this.totals();
    const conv = this.convId;
    const turnModel = model; // the concrete model resolved for THIS turn (never "auto"); the title is routed by it, not by the chat setting
    let title: string | undefined;
    this.endTurn(turn, "done");
    if (conv) {
      model = this.meta("model") ?? DEFAULT_MODEL; // the conversation's own setting ("auto" stays "auto"), never the turn's concrete model
      await this.index.updateConversation({ id: conv, model, costUsd: t.costUsd, tokens: t.tokens }).catch((e) => console.error("index", String(e)));
      const inline = this.titleTurn === turn ? this.inlineTitle : null;
      /** Set the title only while the stored one is still empty (a rename made meanwhile wins); the event goes out only once a row really changed. */
      const applyTitle = async (t: string): Promise<boolean> => {
        const t2 = this.totals();
        if (!this.index.applyAutoTitle) { // a sink without the conditional write: the old unconditional update
          const ok = await this.index.updateConversation({ id: conv, model, costUsd: t2.costUsd, tokens: t2.tokens, title: t }).then(() => true, (e) => { console.error("index", String(e)); return false; });
          if (!ok) return false;
        } else {
          await this.index.updateConversation({ id: conv, model, costUsd: t2.costUsd, tokens: t2.tokens }).catch((e) => console.error("index", String(e)));
          const changed = await this.index.applyAutoTitle({ id: conv, title: t }).catch((e) => { console.error("index", String(e)); return false; });
          if (!changed) return false;
        }
        this.setMeta("title", t);
        this.emit(turn, { type: "title", title: t, costUsd: t2.costUsd, tokens: t2.tokens });
        return true;
      };
      if (firstTurn && !this.meta("title") && inline) { // the first reply carried a usable marker: no separate title call
        if (await applyTitle(inline)) title = inline;
        void this.index.countInlineTitle?.({ outcome: "ok", model: turnModel })?.catch((e) => console.error("index", String(e)));
      } else if (firstTurn && !this.meta("title")) {
        if (this.titleTurn === turn) void this.index.countInlineTitle?.({ outcome: "fallback", model: turnModel })?.catch((e) => console.error("index", String(e)));
        const made = await this.makeTitle(turnModel).catch((e) => { console.error("title", String(e)); return undefined; });
        if (made && await applyTitle(made)) title = made;
      }
    }
    this.notifyEnd("done");
  }

  /** `turnModel` = the concrete model resolved for the turn. Open (a non-gateway provider) titles with THAT model, never the Vertex haiku, and any failure keeps the
   *  deterministic title. An unknown/`auto` turn model, or a gateway turn model in a chat whose setting is Open (mid-turn switch), never leaves the engine: fallback title. */
  private async makeTitle(turnModel: string): Promise<string | undefined> {
    const msgs = this.messages();
    const u = msgs.find((m) => m.role === "user"), a = msgs.find((m) => m.role === "assistant");
    if (!u) return;
    const fb = () => fallbackTitle(this.textOf(u.content)) || undefined;
    if (!turnModel || turnModel === AUTO_MODEL || !isModelIdSyntax(turnModel)) return fb();
    const setting = this.meta("model");
    const settingOpen = !!setting && setting !== AUTO_MODEL && providerOfModel(setting) !== "gateway";
    const open = providerOfModel(turnModel) !== "gateway";
    if (!open && settingOpen) return fb();
    if (open) {
      try { return (await this.requestTitle(turnModel, u, a)) ?? fb(); }
      catch (e) { console.error("title", String(e)); return fb(); }
    }
    return this.requestTitle("claude-haiku-5-5", u, a, true);
  }

  /** Price of a model for aux calls: static meta, else the provider's own declared price; null = unknown (tokens recorded, cost unknown). */
  private async priceOf(model: string): Promise<ModelMeta["price"] | null> {
    const known = this.metaFor(model);
    if (known) return known.price;
    try {
      const m = (await this.provider.listModels("chat")).find((x) => x.id === model);
      return m?.pricePerMTok ? metaFromProviderModel(m.displayName, m.capabilities ?? { text: true, vision: false, tools: false, "image-gen": false, "video-gen": false, reasoning: false }, m.pricePerMTok).price : null;
    } catch { return null; }
  }

  /** Text blocks only (never tool results/web content); the assistant reply is left out entirely once the conversation is web-tainted. */
  private async requestTitle(titleModel: string, u: StoredMessage, a: StoredMessage | undefined, gateway = false): Promise<string | undefined> {
    const body = {
      model: titleModel, max_tokens: 60, stream: false,
      system: "Write a conversation title of at most 6 words, in the same language as the user's message. Output only the title itself (e.g. `Bicycle balance physics`): no quotes, no trailing punctuation, no explanation, never describe what you are doing.",
      messages: [{ role: "user", content: `User: ${this.textOf(u.content).slice(0, 800)}\n\nAssistant: ${a && !(!gateway && this.webTainted()) ? this.textOf(a.content).slice(0, 800) : ""}` }],
    };
    const res = await this.provider.messages(body);
    if (!res.ok) return;
    const j = (await res.json().catch(() => null)) as { content?: Array<{ type: string; text?: string }>; usage?: Usage; stop_reason?: string } | null;
    const t = j?.content?.find((c) => c.type === "text")?.text?.trim();
    if (j?.usage && this.convId) {
      const cost = costOf(j.usage, await this.priceOf(titleModel));
      this.addAux(j.usage, cost);
      void this.index.recordUsage({ conversationId: this.convId, model: titleModel, usage: j.usage, costUsd: cost }).catch(() => {});
    }
    const clean = t ? cleanTitle(t) : "";
    if (clean && !looksLikeReasoning(clean) && j?.stop_reason !== "max_tokens") return clean;
    return fallbackTitle(this.textOf(u.content)) || undefined;
  }

  // ---- tools ----
  private awaitingState(): { at?: number; calls: Array<{ id: string; name: string; input: unknown; approval: boolean; decision: "approve" | "deny" | null; result: { text: string; isError: boolean } | null; host?: string | null; canAlways?: boolean; reason?: string | null }> } | null {
    const raw = this.meta("awaiting");
    return raw ? JSON.parse(raw) : null;
  }
  /** What the UI needs: the approval calls and whether each was decided (never the other calls' result bodies). */
  private awaitingView() {
    const a = this.awaitingState();
    return a ? { expiresAt: typeof a.at === "number" ? a.at + AWAITING_TTL_MS : null, calls: a.calls.filter((c) => c.approval).map((c) => ({ id: c.id, name: c.name, input: c.input, decision: c.decision, host: c.host ?? null, canAlways: c.canAlways === true, reason: c.reason ?? null })) } : null;
  }
  private toolResultBlock(id: string, r: { text: string; isError: boolean }): Block {
    return { type: "tool_result", tool_use_id: id, content: r.text, ...(r.isError ? { is_error: true } : {}) };
  }
  private emitResult(turn: number, id: string, name: string, r: { text: string; isError: boolean }) {
    this.emit(turn, { type: "tool_result", id, name, isError: r.isError, preview: r.text.slice(0, 600) });
  }
  /** Persistent taint flag (meta `webtaint`): set when untrusted content enters, never cleared. Fails CLOSED: an unreadable meta row counts as tainted. */
  webTainted(): boolean {
    if (this._taintLatch) return true; // in-memory latch for this DO lifetime: a failed meta write can never read back as clean
    try { const f = this.meta("webtaint"); if (f === "1") return true; if (f === "0") return false; return this.messages().length > 0; } catch { return true; } // no flag + existing history (legacy conversation) => tainted
  }
  private _taintLatch = false;
  private markTainted() { this._taintLatch = true; try { if (this.meta("webtaint") !== "1") this.setMeta("webtaint", "1"); } catch (e) { console.error("webtaint", String(e)); } }
  private async callTool(id: string, name: string, input: unknown, turn: number): Promise<{ text: string; isError: boolean }> {
    if (!TRUSTED_RESULT_TOOLS.has(name)) this.markTainted(); // set BEFORE the call: whatever it returns (or throws) is untrusted
    if (!this.tools) return { text: "tools are not available", isError: true };
    let msg: number | undefined; // stable id of the user prompt being answered (run_js budget key); only looked up for the tools that use it
    if (RUN_JS_TOOL_NAMES.has(name)) { const ms = this.messages(); for (let i = ms.length - 1; i >= 0; i--) if (ms[i]!.role === "user" && !ms[i]!.content.some((b) => b.type === "tool_result")) { msg = ms[i]!.id; break; } }
    try { return await this.tools.call(name, input, { turn, msg, id, signal: this.abort?.signal, emit: (ev) => this.emit(turn, ev), addAux: (u, c) => this.addAux(u, c) }); }
    catch (e) { return { text: `tool call failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }; }
  }

  // ---- approval modes (src/approval.ts) ----
  /** Chat-level host grants ("Allow this domain in this chat"): meta `webgrants`. Lives in THIS conversation's DO only: a fork starts with none (seedHistory never copies it). */
  chatGrants(): string[] {
    try { const v = JSON.parse(this.meta("webgrants") ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_CHAT_GRANTS) : []; } catch { return []; }
  }
  /** The chat's mode. A persisted Bypass whose recorded confirmation version is missing or not the current one is stale consent (the dialog text changed since): it is dropped to Ask
   *  here, persistently, and the client is told (approval_mode event). Every path (DO wake, reconnect, turn start, /state) reads the mode through this, so none can skip the check. */
  approvalMode(): ApprovalMode {
    const m = this.meta("approval_mode");
    if (m === "bypass" && this.meta("bypass_version") !== String(BYPASS_CONFIRM_VERSION)) {
      this.setMeta("approval_mode", null); this.setMeta("bypass_version", null);
      this.emit(Number(this.meta("turn") ?? 0), { type: "approval_mode", mode: "ask" });
      return "ask";
    }
    return m === "auto" || m === "bypass" ? m : "ask";
  }
  /** Switch the conversation's mode (a user WebSocket command only: no model output or tool result can reach this). Refused while a turn runs. */
  setApprovalMode(mode: ApprovalMode): { ok: true } | { ok: false; error: string } {
    if (this._running || this.meta("pending")) return { ok: false, error: "busy" };
    if (this.approvalMode() === mode) return { ok: true };
    this.setMeta("approval_mode", mode === "ask" ? null : mode);
    this.setMeta("bypass_version", mode === "bypass" ? String(BYPASS_CONFIRM_VERSION) : null); // the confirmation text version this consent was given under
    this.emit(Number(this.meta("turn") ?? 0), { type: "approval_mode", mode });
    return { ok: true };
  }
  revokeChatGrant(host: string): boolean {
    const cur = this.chatGrants(); const next = cur.filter((h) => h !== host);
    if (next.length === cur.length) return false;
    this.setMeta("webgrants", JSON.stringify(next));
    this.emit(Number(this.meta("turn") ?? 0), { type: "approval_grants", hosts: next });
    return true;
  }
  private autoLog(): Record<string, { name: string; subject: string; source: AutoSource }> {
    try { const v = JSON.parse(this.meta("auto_log") ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
  }
  /** One policy snapshot per batch, taken BEFORE anything in the batch runs: a grant created by approving a sibling applies to LATER batches only. Every failure = ask. */
  private async approvalSnapshot() {
    const chat = new Set(this.chatGrants());
    const a = this.approvals;
    if (!a) return { chat, user: new Set<string>() as ReadonlySet<string>, auto: false, bypass: false, mode: "ask" as ApprovalMode, userOk: false };
    let adminOn = false; try { adminOn = (await a.autoOn()) === true; } catch { adminOn = false; }
    let user: ReadonlySet<string> = new Set<string>();
    if (adminOn) { try { user = await a.userHosts(); } catch { user = new Set<string>(); } }
    const mode: ApprovalMode = adminOn ? this.approvalMode() : "ask"; // the admin switch turns Auto AND Bypass off
    return { chat, user, auto: mode === "auto", bypass: mode === "bypass", mode, userOk: adminOn };
  }
  /** A grant / Auto / Bypass decision for a call that would otherwise show a card. Browse calls: grant or Auto (webAuto), else Bypass (any ordinary public address, floor in bypassWeb).
   *  Other tools: Bypass only, through bypassTool (never delete / outward sends / risky names / writes after untrusted content). Redirect check first (grants and Bypass; Auto never had one),
   *  then the audit row with the mode that approved; either failing = the card stays. */
  private async tryAutoApprove(turn: number, id: string, name: string, input: unknown, snap: Awaited<ReturnType<ChatEngine["approvalSnapshot"]>>, o: { web: boolean; tainted: boolean }): Promise<boolean> {
    if (!this.approvals) return false;
    let w: { source: AutoSource; subject: string } | null = null;
    if (o.web) {
      const a = webAuto(name, input, snap);
      if (a.kind === "auto") w = { source: a.source, subject: a.subject };
      else if (snap.bypass) { const b = bypassWeb(name, input); if (b) w = { source: "mode-bypass", subject: b.host }; }
    } else if (snap.bypass && bypassTool(name, { tainted: o.tainted })) w = { source: "mode-bypass", subject: name };
    if (!w) return false;
    try {
      const url = String((input as { url?: unknown })?.url ?? "");
      if (o.web && w.source !== "mode-auto" && this.approvals.noRedirect && !(await this.approvals.noRedirect(url, w.subject))) { this.redirectDemoted.add(id); return false; }
      await this.approvals.audit({ conversationId: this.convId, tool: name, subject: w.subject, source: w.source, mode: snap.mode });
    } catch (e) { console.error("approval audit", e instanceof Error ? e.message : String(e)); return false; } // fail closed: no audit row, no auto-approval
    try { const log = this.autoLog(); log[id] = { name, subject: w.subject, source: w.source }; const keys = Object.keys(log); for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete log[k]; this.setMeta("auto_log", JSON.stringify(log)); } catch { /* the D1 row is the record; the chat line is best effort */ }
    this.emit(turn, { type: "approval_auto", id, name, subject: w.subject, source: w.source });
    return true;
  }
  private awaitingExpired(a: NonNullable<ReturnType<ChatEngine["awaitingState"]>>): boolean {
    if (a.calls.every((x) => !x.approval || x.decision)) return false; // every card answered: the resume is already on its way
    return typeof a.at !== "number" || this.now() - a.at > AWAITING_TTL_MS; // a card parked before this field existed counts as expired
  }
  /** The wall-clock moment the parked cards expire (null = nothing parked). */
  awaitingExpiresAt(): number | null { const a = this.awaitingState(); return a && typeof a.at === "number" ? a.at + AWAITING_TTL_MS : null; }
  /** Close a parked approval whose 30 minutes ran out: deny-equivalent (the model is told plainly in the tool result), nothing is run, the turn ends cleanly. True when it expired. */
  sweepExpired(): boolean {
    if (this._running) return false;
    let a: ReturnType<ChatEngine["awaitingState"]>; try { a = this.awaitingState(); } catch { return false; }
    if (!a || !this.awaitingExpired(a)) return false;
    const turn = Number(this.meta("turn") ?? 0);
    this.saveToolResults(turn, a.calls.map((c) => this.toolResultBlock(c.id, c.result ?? { text: EXPIRED_TEXT, isError: true })));
    this.setMeta("awaiting", null);
    this.emit(turn, { type: "approval_expired" });
    return true;
  }

  /** After a tool_use stop: run READ tools now (in parallel), park APPROVAL tools until decided. */
  private async runTools(turn: number): Promise<"continue" | "awaiting"> {
    const last = this.messages().at(-1);
    const uses = last && last.role === "assistant" ? toolUses(last) : [];
    if (!uses.length) return "continue";
    const msgs = this.messages();
    const snap = await this.approvalSnapshot();
    const calls: Array<{ id: string; name: string; input: unknown; approval: boolean; decision: "approve" | "deny" | null; result: { text: string; isError: boolean } | null; host: string | null; canAlways: boolean; reason: string | null }> = [];
    let defs = new Map<string, ToolDef>(); try { defs = new Map((await (this.tools?.list() ?? Promise.resolve([] as ToolDef[]))).map((d) => [d.name, d])); } catch { /* no defs: only the static tiers apply */ }
    const batchTaints = (i: number) => uses.some((o, j) => j !== i && !TRUSTED_RESULT_TOOLS.has(o.name as string)); // a sibling runs in parallel and may put untrusted content in the chat
    for (const [i, u] of uses.entries()) { // browse tools: once the conversation holds any web result ("tainted") every model-initiated call needs approval unless the user just typed that URL, a grant covers the host, or Auto is on (src/web-taint.ts, src/approval.ts)
      const wp = webPolicy(u.name, u.input, msgs, this.webTainted());
      const tier = classify(u.name), web = tier === "auto" && CF_BROWSER_TOOL_NAMES.has(u.name as string);
      const gated = web && wp.kind === "approval"; // the ONLY approval a grant or Auto may answer; every other card is hard-ask (Bypass alone may answer the others, bypassTool)
      const readAsk = tier === "auto" && !web && defs.get(u.name as string)?.approval === true; // a read tool the user set to Ask in Settings > Connectors
      const fromText = String(u.id).startsWith(TEXT_CALL_ID_PREFIX); // written as text by the model: always a card, never auto-run, no grant / Auto / Bypass
      let approval = fromText || tier !== "auto" || wp.kind === "approval" || readAsk;
      if (!fromText && approval && (gated || snap.bypass) && (await this.tryAutoApprove(turn, u.id as string, u.name as string, u.input, snap, { web: gated, tainted: this.webTainted() || batchTaints(i) }))) approval = false;
      const rawUrl = (u.input as { url?: unknown } | null)?.url;
      const hard = gated && approval && !fromText ? hardAskReason(rawUrl) : null;
      const host = gated && approval && !hard && !fromText ? grantHost(rawUrl) : null;
      const reason = fromText ? TEXT_CALL_REASON : hard ?? (gated && approval && this.redirectDemoted.has(u.id as string) ? REDIRECT_CARD_REASON : null);
      calls.push({ id: u.id as string, name: u.name as string, input: u.input ?? {}, approval, decision: null, result: null, host, reason, canAlways: host !== null && snap.userOk && !!this.approvals });
    }
    await Promise.all(calls.filter((c) => !c.approval).map(async (c) => {
      c.result ??= await this.callTool(c.id, c.name, c.input, turn);
      this.emitResult(turn, c.id, c.name, c.result);
    }));
    const pending = calls.filter((c) => c.approval);
    if (!pending.length) { this.saveToolResults(turn, calls.map((c) => this.toolResultBlock(c.id, c.result!))); return "continue"; }
    const at = this.now();
    this.setMeta("awaiting", JSON.stringify({ at, calls }));
    try { this.approvals?.scheduleExpiry?.(at + AWAITING_TTL_MS + 1000); } catch { /* the lazy sweep still closes it */ }
    this.emit(turn, { type: "approval_required", expiresAt: at + AWAITING_TTL_MS, calls: pending.map((c) => ({ id: c.id, name: c.name, input: c.input, host: c.host, canAlways: c.canAlways, reason: c.reason })) });
    return "awaiting";
  }

  /** Record one decision. ready=true once every approval call has one (caller then arms the resume). `grant` widens an APPROVE of a browse call: "chat" remembers its exact host
   *  for this conversation (stored here), "user" asks the caller to persist it (returned as `userGrant`). The host always comes from the PARKED call's own input, never from the client. */
  decide(id: string, decision: "approve" | "deny", grant: "once" | "chat" | "user" = "once"): { ok: true; ready: boolean; userGrant?: { tool: string; host: string } } | { ok: false; error: string } {
    if (this.sweepExpired()) return { ok: false, error: "This approval expired; ask again." };
    const a = this.awaitingState();
    if (!a || this._running || this.meta("pending")) return { ok: false, error: "nothing awaiting approval" };
    const c = a.calls.find((x) => x.id === id && x.approval);
    if (!c) return { ok: false, error: "unknown tool call" };
    if (c.decision) return { ok: false, error: "already decided" };
    c.decision = decision === "approve" ? "approve" : "deny";
    this.setMeta("awaiting", JSON.stringify(a));
    this.emit(Number(this.meta("turn") ?? 0), { type: "approval_decision", id, decision: c.decision });
    let userGrant: { tool: string; host: string } | undefined;
    if (c.decision === "approve" && (grant === "chat" || grant === "user") && c.host && grantHost((c.input as { url?: unknown } | null)?.url) === c.host) {
      const cur = this.chatGrants(); // a persistent grant also covers the rest of this chat at once (no wait for the D1 write)
      if (!cur.includes(c.host) && cur.length < MAX_CHAT_GRANTS) { cur.push(c.host); this.setMeta("webgrants", JSON.stringify(cur)); this.emit(Number(this.meta("turn") ?? 0), { type: "approval_grants", hosts: cur }); }
      if (grant === "user" && c.canAlways) userGrant = { tool: c.name, host: c.host };
    }
    return { ok: true, ready: a.calls.every((x) => !x.approval || x.decision), ...(userGrant ? { userGrant } : {}) };
  }

  /** Alarm entry after all decisions are in: execute approved calls, deny the rest, continue the turn. */
  async resume(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this._running) return { ok: false, error: "busy" };
    const a = this.awaitingState();
    if (!a || !a.calls.every((x) => !x.approval || x.decision)) return { ok: false, error: "nothing to resume" };
    const turn = Number(this.meta("turn") ?? 0) + 1;
    this._running = true;
    this.setMeta("turn", String(turn));
    this.setMeta("turn_start_seq", String(this.lastSeq() + 1));
    await this.runTurn(turn, this.meta("model") ?? DEFAULT_MODEL, false, true);
    return { ok: true };
  }

  private async executeAwaiting(turn: number) {
    const a = this.awaitingState();
    if (!a) return;
    await Promise.all(a.calls.filter((c) => c.approval).map(async (c) => {
      c.result = c.decision === "approve" ? await this.callTool(c.id, c.name, c.input, turn) : { text: "The user denied this action. Do not retry it; ask what they want instead.", isError: true };
      this.emitResult(turn, c.id, c.name, c.result);
    }));
    this.saveToolResults(turn, a.calls.map((c) => this.toolResultBlock(c.id, c.result ?? { text: "not executed", isError: true })));
    this.setMeta("awaiting", null);
  }

  /** Abandon an approval that was never answered (user typed something else instead): deny it all. */
  private cancelAwaiting() {
    const a = this.awaitingState();
    if (!a) return;
    const turn = Number(this.meta("turn") ?? 0);
    this.saveToolResults(turn, a.calls.map((c) => this.toolResultBlock(c.id, c.result ?? { text: "The user moved on without approving this action; it was not run.", isError: true })));
    this.setMeta("awaiting", null);
    this.emit(turn, { type: "approval_cancelled" });
  }

  /** An assistant tool_use with no following tool_result (crash between the two) would make the API reject every
   *  later request: close it with an error result. */
  private repairDangling() {
    const msgs = this.messages();
    const last = msgs.at(-1);
    if (!last || last.role !== "assistant") return;
    const uses = toolUses(last);
    if (!uses.length) return;
    this.saveToolResults(Number(this.meta("turn") ?? 0), uses.map((u) => this.toolResultBlock(u.id, { text: "This tool call was interrupted and did not run.", isError: true })));
  }

  // ---- context ----
  private windowFor(model: string): number | null { return this.contextWindow ?? this.metaFor(model)?.contextWindow ?? null; }
  /** Meta of a model for THIS conversation's scope (curated first, then the scope's own catalog entry). */
  /** A cold DO has no scope and no metas yet, so the first turn would see no tool support (no tools, no forced call). Load them once before the model is used. */
  /** Owns the deadline (preflightMs: a slow catalog never holds a turn). State is shared per RESOLVED scope (module map `sharedMeta`): concurrent engines join ONE in-flight load, a failed/slow load is not retried
   *  for META_RETRY_MS, a successful one stays fresh for META_FRESH_MS (any engine's load counts). No scope yet => engine-local state, never a shared null key.
   *  Known ids skip the load unless `fresh` and the scope's last load is stale (a catalog flipping images_in is picked up without a restart). Returns false when a needed load did not succeed. */
  private localMeta = { loadedAt: 0, failedAt: 0 } as { inflight?: Promise<boolean>; loadedAt: number; failedAt: number };
  private async ensureMeta(model: string, fresh = false): Promise<boolean> {
    if (!this.loadMetas) return true;
    const started = this.now();
    let scope = this.metaScope?.() ?? null;
    if (!scope && this.resolveMetaScope) { // resolve BEFORE picking the state, inside the same deadline (a resolve failure/timeout falls back to engine-local state)
      let t: ReturnType<typeof setTimeout> | undefined;
      try { scope = await Promise.race([this.resolveMetaScope(), new Promise<null>((res) => { t = setTimeout(() => res(null), this.preflightMs); })]); } catch { scope = null; } finally { if (t) clearTimeout(t); }
    }
    let st = scope ? sharedMeta.get(scope) : undefined;
    if (scope && !st) { st = { loadedAt: 0, failedAt: 0 }; sharedMeta.set(scope, st); }
    st ??= this.localMeta;
    if (this.metaFor(model) && !(fresh && (!st.loadedAt || this.now() - st.loadedAt >= META_FRESH_MS))) return true;
    if (st.inflight) return st.inflight;
    if (st.failedAt && this.now() - st.failedAt < META_RETRY_MS) return false;
    const load = this.loadMetas, budget = Math.max(0, this.preflightMs - (this.now() - started));
    const attempt = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ok = await Promise.race([load().then(() => true), new Promise<boolean>((res) => { timer = setTimeout(() => res(false), budget); })]);
        if (ok) { st!.failedAt = 0; st!.loadedAt = this.now(); } else st!.failedAt = this.now();
        return ok;
      } catch (e) { console.error("loadMetas", String(e)); st!.failedAt = this.now(); return false; } finally {
        if (timer) clearTimeout(timer); st!.inflight = undefined;
        // The scope may only have resolved inside loadMetas(): move engine-local results under it so the failure/freshness is not lost to the next call (runTurn).
        const now = this.metaScope?.() ?? null;
        if (st === this.localMeta && now) { const sh = sharedMeta.get(now) ?? { loadedAt: 0, failedAt: 0 }; sh.loadedAt = Math.max(sh.loadedAt, st.loadedAt); sh.failedAt = Math.max(sh.failedAt, st.failedAt); sharedMeta.set(now, sh); }
        pruneSharedMeta();
      }
    })();
    st.inflight = attempt;
    pruneSharedMeta();
    return attempt;
  }
  private metaFor(model: string): ModelMeta | undefined { return metaOf(this.metaScope?.(), model); }

  /** Rebuild what the API sees: messages after the last compaction point (summary prepended), files expanded. */
  /** Tool catalogue for the slash menu (already filtered by classify() in the host). */
  async listTools(): Promise<ToolDef[]> { return this.tools ? this.tools.list() : []; }

  private slashSkills(): Record<number, string> {
    try { return JSON.parse(this.meta("slash_skills") ?? "{}"); } catch { return {}; }
  }

  private slashHints(): Record<number, string> {
    try { return JSON.parse(this.meta("slash_hints") ?? "{}"); } catch { return {}; }
  }

  private async requestHistory(model: string): Promise<Array<{ role: string; content: Block[] }>> {
    const upto = Number(this.meta("summary_upto") ?? 0);
    const summary = this.meta("summary");
    const stored = this.messages().filter((m) => m.id >= upto);
    // A turn the user stopped is replayed with a neutral marker, and the next user message says so, so the model neither
    // continues the cut-off reply nor comments on it (r3 finding C: "ping" for a "pong" request after Stop).
    const hints = this.slashHints();
    const skills = this.slashSkills();
    let msgs = stored.map((m, i) => {
      // A /tool pick adds one system-side line to the API request only; the stored message keeps the visible text. It rides on
      // the same message every time it is replayed, so the prefix stays byte-stable for the prompt cache.
      // A /skill pick replaces the user's text block with the expanded template (attachments stay); replayed identically every turn.
      if (m.role === "user" && skills[m.id]) return { role: m.role as string, content: [{ type: "text", text: skills[m.id] } as Block, ...m.content.filter((b) => b.type !== "text")] };
      if (m.role === "user" && hints[m.id]) return { role: m.role as string, content: [{ type: "text", text: hints[m.id] } as Block, ...m.content] };
      if (m.role === "assistant" && m.status === "interrupted") return { role: m.role as string, content: [...m.content, { type: "text", text: STOPPED_MARK } as Block] };
      if (m.role === "user" && stored[i - 1]?.status === "interrupted" && m.content.some((b) => b.type === "text"))
        return { role: m.role as string, content: [{ type: "text", text: STOPPED_NOTE } as Block, ...m.content] };
      return { role: m.role as string, content: m.content };
    });
    if (summary && msgs.length && msgs[0].role === "user") {
      msgs[0] = { role: "user", content: [{ type: "text", text: `[Summary of the earlier part of this conversation, compacted to save context]\n${summary}` }, ...msgs[0].content] };
    }
    return this.expandFiles(model, msgs);
  }

  private async expandFiles(model: string, msgs: Array<{ role: string; content: Block[] }>) {
    const meta = this.metaFor(model);
    let budget = 24 * 1024 * 1024; // raw bytes held in memory per request (Worker has 128 MB)
    let textBudget = TEXT_BUDGET_BYTES; // extracted text inlined per request, separate from the base64 budget (text is cheap in memory, dear in tokens)
    const out = msgs.map((m) => ({ role: m.role, content: [...m.content] }));
    for (let i = out.length - 1; i >= 0; i--) {
      const c = out[i].content;
      for (let j = c.length - 1; j >= 0; j--) {
        const b = c[j];
        if (b.type !== "file_ref") continue;
        const kind = classifyFile(b.mime, b.name)?.kind;
        const isImg = kind === "image" || IMAGE_MIMES.has(b.mime);
        const note = (why: string): Block => ({ type: "text", text: `[attached ${isImg ? "image" : "file"} "${b.name}" — ${why}]` });
        if (kind === "text" || kind === "office") {
          if (!this.files) { c[j] = note("file storage unavailable"); continue; }
          if (!refBelongsTo(b.ref, this.convId)) { c[j] = note("file reference is not part of this conversation"); continue; } // defence in depth: stored refs are re-checked at expansion
          const data = await this.files.get(kind === "office" ? sidecarKey(b.ref) : b.ref).catch(() => null);
          if (!data) { c[j] = note("file no longer available"); continue; }
          let body: string;
          try { body = kind === "office" ? new TextDecoder().decode(data) : textForModel(data, b.mime, b.name); } catch { c[j] = note("could not be read as text"); continue; }
          const n = byteLen(body);
          if (n > textBudget) { c[j] = note("omitted, too much attached text in context"); continue; }
          textBudget -= n;
          c[j] = { type: "text", text: wrapAttachment(b.name, b.mime, body) };
          continue;
        }
        if (isImg && !(meta?.caps.images ?? (!model.includes(":") && GATEWAY_VISION_VERIFIED.has(model)))) { c[j] = note("this model cannot see images, so the image was not sent"); continue; }
        if (!isImg && meta?.vendor !== "anthropic") { c[j] = note("this model cannot read PDFs"); continue; }
        const gem = isImg && isGatewayCappedImageId(model); // only bare gateway Gemini has the history-size rule (Claude keeps its master behaviour: no extra reads)
        if (!this.files) { c[j] = note("file storage unavailable"); continue; }
        if (!gem && b.size > budget) { c[j] = note("omitted, too much attached data in context"); continue; }
        if (!refBelongsTo(b.ref, this.convId)) { c[j] = note("file reference is not part of this conversation"); continue; }
        if (gem) {
          // fail closed on an over-cap earlier image WITHOUT downloading it, and BEFORE the budget omission can hide it
          const sz = await this.files.size(b.ref); // a rejection propagates to the turn's error handler (visible error, no request); null only means the object is missing
          if (sz !== null && sz > imageCapFor(model)) throw new HistoryImageTooBig(imageCapFor(model));
          if (sz === null) { c[j] = note("file no longer available"); continue; }
          if (sz > budget) { c[j] = note("omitted, too much attached data in context"); continue; }
        }
        const data = await this.files.get(b.ref).catch(() => null);
        if (!data) { c[j] = note("file no longer available"); continue; }
        if (gem && data.length > imageCapFor(model)) throw new HistoryImageTooBig(imageCapFor(model)); // defence: the head size was unavailable or wrong
        if (gem && data.length > budget) { c[j] = note("omitted, too much attached data in context"); continue; } // Claude keeps master's behaviour exactly (declared size only)
        budget -= data.length;
        c[j] = { type: isImg ? "image" : "document", source: { type: "base64", media_type: b.mime, data: toBase64(data) } };
      }
    }
    return out;
  }

  /** Before each model call: past CLEAR_AT of the window, blank old tool_result bodies; past COMPACT_AT, summarise
   *  everything before the last few user turns with haiku. Both are persistent and only judged on a prompt size measured
   *  AFTER the previous adjustment (otherwise a stale usage number would re-trigger every call). */
  private async manageContext(turn: number, model: string) {
    const win = this.windowFor(model);
    if (!win) return;
    const msgs = this.messages();
    const lastA = [...msgs].reverse().find((m) => m.role === "assistant" && m.usage);
    if (!lastA || lastA.id <= Number(this.meta("ctx_adjusted_at") ?? 0)) return;
    const u = lastA.usage!;
    const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    const ratio = used / win;
    if (ratio < CLEAR_AT) return;
    const upto = Number(this.meta("summary_upto") ?? 0);
    const live = msgs.filter((m) => m.id >= upto);
    const userIdx = live.map((m, i) => (isUserText(m) ? i : -1)).filter((i) => i >= 0);
    const cut = userIdx.length > KEEP_USER_TURNS ? userIdx[userIdx.length - KEEP_USER_TURNS] : -1;
    if (ratio >= COMPACT_AT && cut > 0) {
      if (await this.compact(turn, live, cut, used)) { this.setMeta("ctx_adjusted_at", String(msgs.at(-1)!.id)); return; }
    }
    // clear tool_result bodies before the last KEEP_USER_TURNS user turns (or all but the newest results if no cut)
    const clearBefore = cut > 0 ? cut : Math.max(0, live.length - 2);
    let cleared = 0;
    for (const m of live.slice(0, clearBefore)) {
      if (m.role !== "user" || !m.content.some((b) => b.type === "tool_result" && b.content !== CLEARED_STUB)) continue;
      const c = m.content.map((b) => (b.type === "tool_result" ? { ...b, content: CLEARED_STUB } : b));
      this.sql.exec(`UPDATE messages SET content=? WHERE id=?`, JSON.stringify(c), m.id);
      cleared++;
    }
    if (cleared) { this.emit(turn, { type: "context_cleared", messages: cleared, ratio: Math.round(ratio * 100) / 100 }); }
    this.setMeta("ctx_adjusted_at", String(msgs.at(-1)!.id));
  }

  private async compact(turn: number, live: StoredMessage[], cut: number, used: number): Promise<boolean> {
    const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);
    const lines: string[] = [];
    const prev = this.meta("summary");
    if (prev) lines.push(`[Earlier summary]\n${prev}\n`);
    for (const m of live.slice(0, cut)) {
      for (const b of m.content) {
        if (b.type === "text") lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${clip(b.text, 3000)}`);
        else if (b.type === "tool_use") lines.push(`Assistant called ${b.name}(${clip(JSON.stringify(b.input), 300)})`);
        else if (b.type === "tool_result") lines.push(`Tool result: ${clip(String(b.content), 500)}`);
        else if (b.type === "file_ref") lines.push(`User attached ${b.name}`);
      }
    }
    const body = {
      model: SUMMARY_MODEL, max_tokens: 2000, stream: false,
      system: "Summarise this conversation so it can continue with the summary in place of the original messages. Keep: decisions made, facts and identifiers (ids, names, paths, numbers), open questions, what was done with tools and the outcome, and Erich's preferences. Write in the language of the conversation. Output only the summary, at most 600 words.",
      messages: [{ role: "user", content: clip(lines.join("\n"), 150_000) }],
    };
    try {
      const res = await this.provider.messages(body);
      if (!res.ok) return false;
      const j = (await res.json().catch(() => null)) as { content?: Array<{ type: string; text?: string }>; usage?: Usage } | null;
      const text = j?.content?.find((c) => c.type === "text")?.text?.trim();
      if (!text) return false;
      if (j?.usage && this.convId) this.addAux(j.usage, costOf(j.usage, MODELS_META[SUMMARY_MODEL]?.price));
      if (j?.usage && this.convId) void this.index.recordUsage({ conversationId: this.convId, model: SUMMARY_MODEL, usage: j.usage, costUsd: costOf(j.usage, MODELS_META[SUMMARY_MODEL]?.price) }).catch(() => {});
      const upto = live[cut].id;
      this.setMeta("summary", text); this.setMeta("summary_upto", String(upto));
      const list = JSON.parse(this.meta("compactions") ?? "[]"); list.push({ upto, ts: this.now(), tokensBefore: used });
      this.setMeta("compactions", JSON.stringify(list));
      this.emit(turn, { type: "compaction", upto, tokensBefore: used });
      return true;
    } catch (e) { console.error("compact", String(e)); return false; }
  }

  /** One model call. Returns the stop reason ("end_turn", "pause_turn", …) | "stopped" | "error". */
  /** Open-space system prompt? Fail closed: when the space lookup throws (scope unresolvable) the OPEN prompt is used - it claims fewer tools than the Business one, so a lookup failure can never advertise personal-connector/Vertex tools in an Open conversation. An absent lookup (no scope concept) stays Business. */
  private async openForPrompt(): Promise<boolean> {
    if (!this.openSpaceLookup) return false;
    try { return (await this.openSpaceLookup()) === true; } catch { return true; }
  }
  /** Open + the switch on + the conversation ends with the user's own text carrying a live-data cue: only then is the model call forced. Fail closed (any lookup error = off). */
  /** Debug logging for this turn (read once per turn, fail closed). */
  private async debugOn(turn: number): Promise<boolean> {
    if (this.pinnedDebug?.turn !== turn) { let v = false; try { v = !!this.debugTurnsOn && (await this.debugTurnsOn()) === true; } catch { v = false; } this.pinnedDebug = { turn, v }; }
    return this.pinnedDebug.v;
  }
  private dbgLine(o: Record<string, unknown>): void { try { console.log("DBGTURN " + JSON.stringify(o)); } catch { /* never break a turn for a log line */ } }
  private dbgLog_escalate(pre: Record<string, unknown>, from: string, to: string, status: number | null, retries: number): void { this.dbgLine({ ...pre, event: "escalate", from, to, status, retries }); }
  private async cueForcesTool(): Promise<boolean> {
    try {
      const last = this.messages().at(-1);
      if (!last || !isUserText(last)) return false;
      if (!hasLiveCue(last.content.filter((b) => b.type === "text").map((b: any) => b.text as string).join("\n"))) return false; // cheap pure test first: the settings row is read only for a cue
      return (await this.openForPrompt()) && !!this.forceToolCuesOn && (await this.forceToolCuesOn()) === true;
    } catch { return false; }
  }
  /** Team user (no personal connector): the prompt must not describe notes / tasks / read_url tools they never get. Fail closed: a lookup error picks the variant that claims fewer tools. */
  private async noPersonalForPrompt(): Promise<boolean> {
    if (!this.personalToolsLookup) return false;
    try { return (await this.personalToolsLookup()) !== true; } catch { return true; }
  }
  /** Failover is on for this call: an Open conversation (hook present) and the user's toggle (default ON; a lookup error = off). */
  private async failoverOn(h: FailoverHook): Promise<boolean> {
    try { if (!((await this.openForPrompt()) && (await h.enabled()) === true)) return false; } catch { return false; } // fail closed: any lookup error = off for this turn
    try { await h.refresh?.(); } catch { /* health is a hint */ }
    return true;
  }
  /** What this turn needs from the next model (rule 4): tools if tools are sent, vision if the history has images, and the prompt size. */
  private foNeed(body: any, tools: ToolDef[]) {
    const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
    const vision = msgs.some((m) => Array.isArray(m?.content) && m.content.some((b: any) => b?.type === "image" || (b?.type === "tool_result" && Array.isArray(b.content) && b.content.some((x: any) => x?.type === "image"))));
    return { tools: tools.length > 0, vision, promptTokens: Math.ceil((JSON.stringify(msgs).length + JSON.stringify(body?.system ?? "").length) / 3) };
  }
  /** The next model for a failed attempt, or null (no switch left / none eligible). Sets the turn's route (the inline notice + Details chip read it). */
  /** Selection only (no side effects but the half-open lease): the next eligible model, or null. The model that takes a half-open lease is the only one that probes; a caller that
   *  loses it picks the next one. */
  private async foPick(fo: { tried: string[]; switches: number }, body: any, tools: ToolDef[], h: FailoverHook) {
    if (fo.switches >= MAX_SWITCHES) return null;
    try {
      const cands = await h.candidates(), need = this.foNeed(body, tools), skip = [...fo.tried];
      for (let i = 0; i < 6; i++) {
        const c = pickNext(cands, skip, need, h.breaker(), this.now());
        if (!c) return null;
        if (h.breaker().take?.(c.id) ?? true) return c;
        skip.push(c.id);
      }
    } catch { /* selection failed: no switch */ }
    return null;
  }
  /** Commit a pick: tried set, the switch event and the route (inline notice + Details chip). Called only after the stop state was re-checked. */
  private foApply(turn: number, model: string, cls: FoClass, fo: { tried: string[]; switches: number }, next: { id: string; notice?: string }): string {
    fo.tried.push(next.id); fo.switches++;
    const bare = (id: string) => id.replace(/^[^:]+:/, "");
    const provider = (id: string) => { const p = id.split(":")[0]!; return descriptorOf(p)?.label ?? p; };
    const reason = `Switched to ${bare(next.id)} (${provider(next.id)}): ${REASON[cls]}${cls === "gone" ? ` (${bare(model)} - pick another model in the list for your next message)` : ""}${next.notice ? `. ${next.notice}` : ""}`;
    this.emit(turn, { type: "failover", from: model, to: next.id, reason: cls });
    this.setRoute(turn, { by: "open-failover", model: next.id, effort: null, reason, fallbackFrom: model, tried: [...fo.tried] });
    return next.id;
  }
  /** After text was already streamed and the stream failed: never splice; name the model a one-click re-run would use (null = none / off). */
  private async continueWith(model: string, tried: string[], body: any, tools: ToolDef[], h: FailoverHook | undefined): Promise<string | null> {
    if (!h || !(await this.failoverOn(h))) return null;
    try {
      h.breaker().fail(model, this.now());
      const next = pickNext(await h.candidates(), tried, this.foNeed(body, tools), h.breaker(), this.now())?.id ?? null;
      if (next) this.setMeta("fo_continue", JSON.stringify({ model: next, tried: [...tried], need: this.foNeed(body, tools) })); // the one-click re-run starts with this tried set and is validated against THIS turn's needs
      return next;
    } catch { return null; }
  }
  /** The model a stored continue names still passes the same filter failover selection uses (and failover is still ON). */
  private async continueStillValid(model: string, text: string, files: FileRef[]): Promise<boolean> {
    const h = this.failover; if (!h) return false;
    try {
      const c = JSON.parse(this.meta("fo_continue") ?? "null"), n = c?.need;
      if (!n || typeof n.promptTokens !== "number") return false;
      if (!(await this.failoverOn(h))) return false;
      // the SAME selection function. Tools come from the failed turn; vision and the prompt size are recomputed NOW from the current history, the new user message and the attachments
      // (images count for vision, every other attachment by its size), never taken from the failed attempt.
      const hist = this.messages();
      const chars = SYSTEM_PROMPT.length + hist.reduce((k, m) => k + JSON.stringify(m.content).length, 0) + text.length + files.filter((f) => !IMAGE_MIMES.has(f.mime)).reduce((k, f) => k + (f.size || 0), 0);
      const vision = files.some((f) => IMAGE_MIMES.has(f.mime)) || hist.some((m) => m.content.some((b: any) => b?.type === "file_ref" && IMAGE_MIMES.has(b.mime)));
      const need = { tools: n.tools === true, vision, promptTokens: Math.ceil(chars / 3) };
      const cand = (await h.candidates()).find((x) => x.id === model);
      return !!cand && pickNext([cand], [], need, h.breaker(), this.now())?.id === model;
    } catch { return false; }
  }
  /** Tried set a "Continue with X" re-run starts from (consumed once, only when the model matches). */
  private takeContinue(model: string): string[] | null {
    try { const j = JSON.parse(this.meta("fo_continue") ?? "null"); if (!j) return null; this.setMeta("fo_continue", null); return j.model === model && Array.isArray(j.tried) ? j.tried.filter((x: unknown) => typeof x === "string") : null; } catch { return null; }
  }
  /** A failed attempt that still reported/billed tokens: one usage row (flagged), never the successful attempt's tokens again (MED7). */
  private async recordFailedAttempt(model: string, cls: FoClass | "error", u: Usage | undefined) {
    if (!u || totalTokens(u) <= 0 || !this.convId) return;
    this.addAux(u, costOf(u, this.metaFor(model)?.price)); // billed, and no saved message carries it: it counts in the chat/turn totals exactly once
    await this.index.recordUsage({ conversationId: this.convId, model, usage: u, costUsd: costOf(u, this.metaFor(model)?.price), routed: { by: "open-failover", model, reason: `failed attempt (${cls}): tokens the attempt reported` } }).catch((e) => console.error("usage", String(e)));
  }

  /** A tool already ran in this turn: a tool_result follows the last user text. */
  private toolRanThisTurn(): boolean {
    const hist = this.messages(), lastUser = hist.map((m, i) => (m.role === "user" && isUserText(m) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    return hist.slice(lastUser + 1).some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_result"));
  }

  private async callModel(turn: number, model: string, turnStart: number, tools: ToolDef[] = [], carry?: { retries: number; tReq: number; fo?: { tried: string[]; switches: number }; forceTool?: boolean; lead?: Block[]; emptyRetries?: number; synth?: boolean }): Promise<string> {
    // Synthesis-only call (an empty reply after a tool already ran): Anthropic-style gateway keeps the tool DEFINITIONS (tool_use / tool_result in the history need them: a 400 otherwise) and forbids calling with tool_choice none;
    // OpenAI-compatible and Cloudflare / Gemini adapters get no tools at all (they accept tool messages in the history without definitions, and only the openai-compat mapping carries tool_choice).
    const synth = carry?.synth === true;
    if (synth && providerOfModel(model) !== "gateway") tools = [];
    let instructions: string | null = null;
    try { instructions = (await this.instructionsLookup?.()) ?? null; }
    catch (e) {
      this.emit(turn, { type: "error", error: { type: "api_error", message: "could not load your profile instructions" } });
      this.endTurn(turn, "error", { type: "api_error", message: `could not load profile instructions: ${e instanceof Error ? e.message : String(e)}`, retryable: true });
      return "error";
    }
    let project: { name: string; text: string } | null = null;
    try {
      if (this.pinnedProject?.turn !== turn) this.pinnedProject = { turn, v: (await this.projectLookup?.()) ?? null };
      project = this.pinnedProject.v;
    } catch (e) {
      this.emit(turn, { type: "error", error: { type: "api_error", message: "could not load the project instructions" } });
      this.endTurn(turn, "error", { type: "api_error", message: `could not load project instructions: ${e instanceof Error ? e.message : String(e)}`, retryable: true });
      return "error";
    }
    if (this.pinnedAutoDelegate?.turn !== turn) { let v = false; try { v = !!(await this.autoDelegateOn?.()); } catch { v = false; } this.pinnedAutoDelegate = { turn, v }; }
    const askTitle = this.titleTurn === turn && !this.titleAsked;
    let history: Array<{ role: string; content: Block[] }>;
    try { history = await this.requestHistory(model); }
    catch (e) {
      if (!(e instanceof HistoryImageTooBig)) throw e;
      const err = { type: "invalid_request_error", message: e.message, retryable: false };
      this.emit(turn, { type: "error", error: err });
      this.endTurn(turn, "error", err);
      return "error";
    }
    const body = buildRequest(model, history, tools, instructions, project, this.pinnedAutoDelegate.v, this.turnRoute?.model === model ? this.turnRoute.effort : null, await this.openForPrompt(), this.metaFor(model), askTitle, await this.noPersonalForPrompt());
    if (this.titleTurn === turn) this.titleAsked = true;
    // "Limit answer length" off: a Vertex-gateway model asks for the largest safe output (min(real max, window - input - margin)); a model that already got a 400 for it this turn stays at its own cap.
    if (this.pinnedAnswerLimit?.turn !== turn) { let v: AnswerLimit = "default"; try { v = (await this.answerLimitOn?.()) ?? "default"; } catch { v = "default"; } this.pinnedAnswerLimit = { turn, v }; }
    if (this.budgetRejected?.turn !== turn) this.budgetRejected = { turn, models: new Set() };
    let raisedBudget = false;
    if (this.pinnedAnswerLimit.v === "off" && !this.budgetRejected.models.has(model)) {
      const est = estimateInputTokens({ system: body.system, messages: body.messages, tools: (body as any).tools });
      const mt = outputBudget(this.metaFor(model), "off", est, model);
      raisedBudget = mt > body.max_tokens; body.max_tokens = mt;
    }
    if (synth && (body as any).tools?.length) (body as any).tool_choice = { type: "none" };
    // A forced call ("required" permits ANY offered tool) is only ever made with the live-web tools offered, so it can never pick generate_image / create_artifact / delegate.
    const forceWith = (): boolean => { const web = ((body as any).tools ?? []).filter((t: any) => CF_BROWSER_TOOL_NAMES.has(t.name)); if (!web.length) return false; (body as any).tools = web;
      if (this.metaFor(model)?.forceViaAuto) { // this model answers `required` with the call as TEXT: `auto` + web tools only + a nudge placed BEFORE the last system block (the tools-names line stays last)
        (body as any).tool_choice = { type: "auto" };
        const sys = (body as any).system as Array<{ type: string; text: string }>;
        sys.splice(Math.max(0, sys.length - 1), 0, { type: "text", text: forceNudge(web.map((t: any) => t.name as string)) });
      } else (body as any).tool_choice = { type: "any" };
      return true; };
    let forced = false; // a forced call (cue or narration retry) really went out on this request: only then may text be read as a tool call
    if (carry?.forceTool) { // the one narration retry: the same request minus the announcement that just ended the turn, with a (web) tool call required
      const last = body.messages.at(-1);
      if (last?.role === "assistant") body.messages.pop();
      forced = forceWith();
    }
    else if (tools.length && model.startsWith("nvidia:") && (await this.cueForcesTool())) forced = forceWith(); // live-data question: the first call of the turn must be a web tool call (later iterations: the last message is a tool result, so auto)
    const dbg = await this.debugOn(turn);
    let dbgPre: Record<string, unknown> = {};
    if (dbg) {
      const sys = ((body as any).system ?? []) as Array<{ text?: string }>;
      const lastSys = sys.length ? String(sys[sys.length - 1]?.text ?? "") : "";
      let cue: unknown = null, flag: unknown = null;
      try { cue = await this.cueForcesTool(); } catch { cue = "error"; }
      try { flag = this.forceToolCuesOn ? await this.forceToolCuesOn() : "absent"; } catch { flag = "error"; }
      dbgPre = { turn, model, forced, forceViaAuto: !!this.metaFor(model)?.forceViaAuto, cueForcesTool: cue, forceToolCuesFlag: flag, toolChoice: (body as any).tool_choice ?? null,
        offeredTools: (((body as any).tools ?? []) as ToolDef[]).map((t) => t.name), narrationNames: tools.map((t) => t.name),
        systemBlocks: sys.length, systemChars: sys.reduce((n, b) => n + String(b?.text ?? "").length, 0), lastSystemHead: lastSys.slice(0, 120),
        lastMsgRole: body.messages.at(-1)?.role ?? null, narrationRetryCall: !!carry?.forceTool, route: this.turnRoute ? { by: this.turnRoute.by, model: this.turnRoute.model } : null };
    }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    if (this.stopRequested) return "stopped"; // stop landed while the request was being prepared: never open the upstream call
    let res: Response | null = null, lastHttp: { status: number; body: any } | null = null, lastNet: string | null = null;
    const tReq = carry?.tReq ?? this.now(); // a route fallback keeps the ORIGINAL wall-clock start, so totalMs includes earlier failed attempts + sleeps
    const priorRetries = carry?.retries ?? 0;
    let tAttempt = this.now(), retries = priorRetries; // first-token time counts from the SUCCESSFUL attempt's start; failed attempts + the retry sleep are reported as `retries`
    let providerNoRetry = false; // a provider adapter said retryable:false: the final error must not offer Retry either
    const hook = this.failover, foOn = !!hook && (await this.failoverOn(hook));
    if (!foOn && !carry) this.setMeta("fo_continue", null); // failover off now: a stored continue is dropped, never reused
    const fo = carry?.fo ?? { tried: foOn ? this.takeContinue(model) ?? [model] : [model], switches: 0 }; if (!fo.tried.includes(model)) fo.tried.push(model);
    if (signal.aborted || this.stopRequested) return "stopped"; // a stop that landed while the failover hooks were being read
    // After a switch the model gets ONE attempt: a same-model retry would call a model twice in a turn, and the switch is already the retry. Without a switch the old single retry stays.
    const maxAttempts = foOn && fo.switches > 0 ? 1 : 2;
    let budgetExtra = 0; // physical requests spent on raised-budget fallbacks: they do not use up the ordinary attempts, but each one is a request of its own (fresh deadline, next attempt number)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reqNo = attempt + budgetExtra;
      this.emit(turn, { type: "attempt", n: priorRetries + reqNo }); // continues across a route fallback so the live retry note keeps counting
      if (reqNo > 1) { tAttempt = this.now(); retries = priorRetries + reqNo - 1; }
      let foFail: FoFailure | null = null;
      // Failover: each attempt gets its own abort (the first-byte deadline cancels only that attempt) and a deadline for the first content.
      const ctl = new AbortController(), ms = foOn ? hook!.firstByteMs?.(model) ?? firstByteMsOf(model) : this.ttfbOf(model);
      const link = () => ctl.abort(); signal.addEventListener("abort", link, { once: true }); if (signal.aborted) ctl.abort(); // never leave a request running after a stop
      let timer: ReturnType<typeof setTimeout> | undefined, weAborted = false, preFrame = false; // preFrame: the attempt failed before ANY frame (stall / empty EOF / read error): nothing was shown, nothing ran // weAborted: OUR deadline fired (authoritative: the AbortError it causes is a timeout, whichever promise settles first)
      try {
        const call = this.provider.messages(body, ctl.signal);
        call.catch(() => {});
        const t = await Promise.race([call, new Promise<"t">((x) => { timer = setTimeout(() => { weAborted = true; ctl.abort(); x("t"); }, ms); }), new Promise<"a">((x) => { if (signal.aborted) x("a"); else signal.addEventListener("abort", () => x("a"), { once: true }); })]);
        if (t === "t") throw new FoTimeout();
        if (t === "a") return "stopped"; // the user's stop while waiting for the first byte: not a failure
        const r: Response = t;
        if (r.ok && r.body) {
          clearTimeout(timer); // the stream is under the peek's own deadline; every other branch keeps THIS timer armed until the response is fully handled (finally clears it)
          const pk = await peekFirstContent(r, ms - (this.now() - tAttempt), () => { weAborted = true; ctl.abort(); }, signal, !foOn);
          if (pk.ok) { res = pk.res; break; }
          if (pk.stopped) return "stopped"; // user stop during the first-content wait: no breaker write, no switch, no usage
          if (weAborted) pk.failure = { ...pk.failure, timedOut: true, unknown: false }; // our deadline aborted the read: a timeout, whatever error the aborted body threw
          preFrame = true; foFail = pk.failure; lastNet = pk.failure.timedOut ? `model did not respond in ${Math.round(ms / 1000)} s` : pk.message; res = null;
        } else {
          // the error body is read under the same deadline: a body that never finishes must not hang the turn (raced against the attempt's abort, as a body not tied to the signal would ignore it)
          const eb: any = await Promise.race([r.json().catch(() => null), new Promise<null>((x) => { if (ctl.signal.aborted) x(null); else ctl.signal.addEventListener("abort", () => x(null), { once: true }); })]);
          if (signal.aborted || this.stopRequested) return "stopped";
          if (weAborted) throw new FoTimeout(); // our deadline fired during the body read: a timeout, retried like any other
          lastHttp = { status: r.status, body: eb ?? { error: { type: "http_error", message: `gateway returned ${r.status}` } } };
          res = null;
          if (raisedBudget && (isMaxTokensError(r.status, eb) || BUDGET_RETRY_STATUSES.has(r.status))) { // the raised max_tokens was refused (400) or may have tripped quota/overload (429/503/529): once, same model at its own cap (kept for the rest of the turn), before any retry / Auto escalation, without using up an attempt
            if (signal.aborted || this.stopRequested) return "stopped"; // never launch the fallback request after a stop
            raisedBudget = false; lastHttp = null; lastNet = null; /* the discarded raised-budget rejection must not be the final error nor drive Auto escalation; the ONLY place failure state is dropped */ this.budgetRejected!.models.add(model); body.max_tokens = this.metaFor(model)?.maxTokens ?? 8192; budgetExtra++; attempt--; continue; // (an HTTP error response carries no usage: nothing to record)
          }
          const ra = parseRetryAfter(r.headers?.get?.("retry-after"), this.now()); foFail = { status: r.status, ...(ra !== undefined ? { retryAfterS: ra } : {}), retriesUsed: attempt >= 2 };
          if (!foOn && !RETRYABLE.has(lastHttp.status)) break;
          if (foOn && !RETRYABLE.has(lastHttp.status) && !classifyFailure(foFail)) break;
        }
      } catch (e) {
        if (signal.aborted || this.stopRequested) return "stopped";
        if (e instanceof FoTimeout || weAborted) { preFrame = true; foFail = { timedOut: true }; lastNet = `model did not respond in ${Math.round(ms / 1000)} s`; res = null; }
        // A provider adapter's own mapped failure (429/5xx/auth...) is an HTTP-style error with its status, retried like one.
        else if (e instanceof ProviderError && providerOfModel(model) !== "gateway") {
          lastHttp = { status: e.status, body: { error: { type: e.info.type ?? "api_error", message: e.message } } }; res = null;
          foFail = e instanceof ProviderNetworkError ? {} : { status: e.status, ...(e.info.retryAfterS ? { retryAfterS: e.info.retryAfterS } : {}), ...(e.info.usage ? { usage: e.info.usage } : {}), retriesUsed: true }; // a rejected adapter fetch = connection failure; anything else keeps its HTTP status // the adapter already waited + retried a 429 once
          if (e.info.retryable === false) providerNoRetry = true;
          if (!(e.info.retryable ?? RETRYABLE.has(e.status)) && !(foOn && classifyFailure(foFail))) break;
        } else if (foOn) { lastNet = e instanceof Error ? e.message : String(e); res = null; foFail = { unknown: true }; break; } // a bug / key problem: surfaced, no switch, no retry
        else { lastNet = e instanceof Error ? e.message : String(e); res = null; foFail = {}; } // failover off: the old behaviour (retry once)
      } finally { clearTimeout(timer); if (!res) { ctl.abort(); signal.removeEventListener("abort", link); } } // success keeps the link to the user abort; any other exit aborts this attempt and drops the listener // every exit path without a usable stream aborts this attempt (stop, timeout, failure); on success the link to the user abort stays
      if (res) break;
      if (signal.aborted || this.stopRequested) return "stopped"; // a stop is never a model failure
      if (foOn && foFail) {
        const cls = classifyFailure(foFail);
        if (foFail.usage) await this.recordFailedAttempt(model, cls ?? "error", foFail.usage); // awaited: it must land before the turn can end
        if (signal.aborted || this.stopRequested) return "stopped"; // a stop during that await: no breaker write, no notice, no next provider call // billed tokens count whether or not another model takes over
        if (cls) {
          const pick = await this.foPick(fo, body, tools, hook!);
          if (signal.aborted || this.stopRequested) return "stopped"; // a stop during candidate selection: no breaker write, no switch route, no notice
          hook!.breaker().fail(model, this.now());
          const next = pick ? this.foApply(turn, model, cls, fo, pick) : null;
          if (next) { if (dbg) this.dbgLine({ ...dbgPre, event: "failover", cls, from: model, to: next, status: foFail.status ?? null, retries }); return this.callModel(turn, next, turnStart, tools, { retries: retries + 1, tReq, fo, ...(synth || ((foFail.empty || foFail.timedOut || preFrame) && this.toolRanThisTurn()) ? { synth: true } : {}) }); } // this failed attempt counts as a retry; an empty stream after a tool ran is synthesis-only too
          if (foFail.empty && this.toolRanThisTurn()) break; // no switch left: never re-send the same tool-offering request for an empty reply after a tool ran
        }
      }
      if (preFrame && !synth && this.toolRanThisTurn()) return this.callModel(turn, model, turnStart, tools, { retries: retries + 1, tReq, synth: true, fo, ...(carry?.lead ? { lead: carry.lead } : {}) }); // any zero-frame failure (stall, empty EOF, read error) after a tool ran: the retry is synthesis-only, nothing can run twice
      if (attempt < maxAttempts) await this.sleep(foOn && foFail?.status === 429 ? Math.min(foFail.retryAfterS ?? RETRY_ABSENT_S, RETRY_ABSENT_S) * 1000 : this.retryDelayMs); // 429 under failover: one short wait, then the next attempt switches
      if (signal.aborted || this.stopRequested) return "stopped";
    }
    if (!res && lastHttp && RETRYABLE.has(lastHttp.status)) {
      const next = this.escalateRoute(turn, model);
      if (next) { if (dbg) this.dbgLog_escalate(dbgPre, model, next, lastHttp?.status ?? null, retries); return this.callModel(turn, next, turnStart, tools, { retries: retries + 1, tReq, ...(synth ? { synth: true } : {}) }); } // the final failed attempt of this route counts too
    }
    if (!res) {
      const timedOut = !lastHttp && /^model did not respond/.test(lastNet ?? "");
      if (lastHttp) this.emit(turn, { type: "http_error", status: lastHttp.status, body: lastHttp.body });
      else this.emit(turn, { type: "error", error: { type: "api_error", message: timedOut ? `${lastNet}` : `could not reach the model gateway: ${lastNet}` } });
      const eb = lastHttp ? (Array.isArray(lastHttp.body) ? lastHttp.body[0]?.error : lastHttp.body?.error) : null;
      // 404 / 410 whose payload says the model was not found / no access will not change on a retry: a plain non-retryable message instead of the upstream text. Any other 404 (e.g. the gateway route) keeps its classification.
      if (lastHttp && isModelGone(lastHttp.status, eb)) { this.endTurn(turn, "error", { status: lastHttp.status, type: "model_unavailable", message: MODEL_UNAVAILABLE_MESSAGE, retryable: false }); return "error"; }
      this.endTurn(turn, "error", { status: lastHttp?.status, type: eb?.type ?? "api_error", message: eb?.message ?? lastNet ?? "model call failed", retryable: !providerNoRetry });
      return "error";
    }

    const acc = new BlockAccumulator();
    let usage: Usage = {}, stop: string | null = null, started = false, ttft: number | null = null, streamErr: ServerEvent | null = null, ended = false;
    // every response of an inline-title space is scrubbed live (a later-turn marker never streams); only the first response (askTitle) may yield a title
    const titles = new TitleStream(this.titleTurn === turn || inlineTitleEnabled((await this.openForPrompt()) ? "open" : "biz"), askTitle);
    const handle = (ev: ServerEvent) => {
      const ts = this.now();
      if (ev.type === "ping") return;
      if (ev.type === "message_start") { started = true; usage = { ...ev.message?.usage }; }
      else if (ev.type === "message_delta") { usage = { ...usage, ...ev.usage }; stop = ev.delta?.stop_reason ?? stop; }
      else if (ev.type === "message_stop") ended = true;
      else if (ev.type === "error") streamErr = ev;
      // The title marker is removed HERE, before the accumulator, the event log and the socket: nothing downstream (live view, replay, saved message) ever holds it.
      for (const out of titles.feed(ev)) {
        acc.feed(out, ts);
        if (ttft === null && out.type === "content_block_delta" && (out.delta?.type === "text_delta" || out.delta?.type === "thinking_delta")) ttft = ts - tAttempt;
        const seq = this.emit(turn, out);
        if (out.type === "message_start") this.setMeta("msg_start_seq", String(seq));
      }
    };

    const reader = res.body!.getReader();
    const aborted = new Promise<{ done: true; value: undefined }>((r) => {
      if (signal.aborted) r({ done: true, value: undefined }); else signal.addEventListener("abort", () => r({ done: true, value: undefined }), { once: true });
    });
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        // race the read against abort: a provider that doesn't tie its body to the signal must not hang a stop
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev: ServerEvent;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          handle(ev);
        }
      }
    } catch (e) {
      if (!(signal.aborted || this.stopRequested)) {
        streamErr = { type: "error", error: { type: "api_error", message: `stream dropped: ${e instanceof Error ? e.message : String(e)}` } };
        this.emit(turn, streamErr);
      }
    }
    reader.cancel().catch(() => {});
    if (askTitle && titles.title && this.inlineTitle === null) this.inlineTitle = titles.title;
    const total = this.now() - tReq;
    const partialStatus = this.stopRequested || signal.aborted ? "interrupted" : "error";

    if (streamErr) {
      const p = this.finishedForPartial(acc);
      if (p.length) this.saveAssistant(turn, model, p, started ? usage : null, stop, "error", ttft, total, retries);
      const er = (streamErr as any).error ?? {};
      const cw = p.length && foOn ? await this.continueWith(model, fo.tried, body, tools, hook) : null; // rule 3: partial text is kept, never spliced
      this.endTurn(turn, "error", { type: er.type ?? "api_error", message: er.message ?? "stream error", retryable: true, ...(cw ? { continueWith: cw } : {}) });
      return "error";
    }
    if (!ended) { // aborted by the user, or the stream just ended early
      const p = this.finishedForPartial(acc);
      if (p.length) this.saveAssistant(turn, model, p, started ? usage : null, stop, partialStatus, ttft, total, retries);
      if (partialStatus === "interrupted") {
        this.emit(turn, { type: "client_interrupt" });
        return "stopped";
      }
      const cw = p.length && foOn ? await this.continueWith(model, fo.tried, body, tools, hook) : null;
      const er = { type: "api_error", message: "the model stream ended unexpectedly", retryable: true, ...(cw ? { continueWith: cw } : {}) };
      this.emit(turn, { type: "error", error: er });
      this.endTurn(turn, "error", er);
      return "error";
    }
    let finished = acc.finished();
    // Open + NVIDIA safety net: a reply with NO tool call whose text is one clean JSON tool call (offered tool, schema-valid arguments, short lead-in at most) becomes a normal tool_use,
    // so the usual approval cards / web rules / taint apply. Only the model's own reply to the user's message counts (never a tool result), anything ambiguous stays as it is.
    if (forced && (stop === "end_turn" || stop === null) && tools.length && !!this.metaFor(model)?.caps.tools && model.startsWith("nvidia:") && !finished.some((b) => b.type === "tool_use")) {
      const lastMsg = this.messages().at(-1);
      const offeredDefs = (((body as any).tools ?? []) as ToolDef[]); // the tools ACTUALLY sent on this request (the web-only filtered list), never the full host list
      const tc = lastMsg && isUserText(lastMsg) ? parseTextToolCall(finished.filter((b) => b.type === "text").map((b: any) => b.text as string).join("\n"), offeredDefs) : null;
      if (tc && (await this.openForPrompt())) {
        const keep = finished.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
        finished = [...keep, ...(tc.lead ? [{ type: "text", text: tc.lead } as Block] : []), { type: "tool_use", id: `${TEXT_CALL_ID_PREFIX}${turn}_${this.now().toString(36)}`, name: tc.name, input: tc.input } as Block];
        stop = "tool_use";
      }
    }
    // Open + NVIDIA: a reply that only ANNOUNCES an offered tool ("(web_read đang thực hiện...)") with no call is retried ONCE with a call required (carry.forceTool
    // marks the retry, `retries` counts it in usage). If the retry narrates again the announcement is replaced by a note: nothing may look like it is still running.
    const names = tools.map((t) => t.name);
    const narrated = (stop === "end_turn" || stop === null) && !!this.metaFor(model)?.caps.tools && model.startsWith("nvidia:") && narratesToolCall(finished, names, (((body as any).tools ?? []) as ToolDef[])) && (await this.openForPrompt());
    const withLead = (c: Block[]): Block[] => { // a dropped narration's text rides in the retry's own message: never an empty or a second consecutive assistant message
      const lead = carry?.lead ?? [];
      if (!lead.length) return c;
      const k = c.findIndex((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      const at = k < 0 ? c.length : k;
      return [...c.slice(0, at), ...lead, ...c.slice(at)];
    };
    if (dbg) {
      const txt = finished.filter((b) => b.type === "text").map((b: any) => String(b.text ?? "")).join("\n");
      let ptc: string | null = null; try { ptc = parseTextToolCall(txt, (((body as any).tools ?? []) as ToolDef[]))?.name ?? null; } catch { ptc = "error"; }
      let nar: unknown = null; try { nar = narratesToolCall(finished, names, (((body as any).tools ?? []) as ToolDef[])); } catch { nar = "error"; }
      let op: unknown = null; try { op = await this.openForPrompt(); } catch { op = "error"; }
      this.dbgLine({ ...dbgPre, event: "done", stop, finishTypes: finished.map((b) => b.type), text: txt.slice(0, 600), toolUseNames: finished.filter((b) => b.type === "tool_use").map((b: any) => b.name),
        parseTextToolCall: ptc, narratesToolCall: nar, openForPrompt: op, narrationRetryStarts: narrated && this.narrationRetryTurn !== turn && !this.stopRequested && !signal.aborted, retries });
    }
    if (narrated) {
      const retry = this.narrationRetryTurn !== turn && !this.stopRequested && !signal.aborted && !synth && !this.toolRanThisTurn(); // never after a tool ran this turn: the retry re-offers tools, so a side-effect tool could run twice (the note path below keeps the turn honest)
      const kept = withoutNarration(finished, names, retry ? undefined : (this.toolRanThisTurn() ? NARRATION_NOTE_AFTER_TOOL : NARRATION_NOTE), (((body as any).tools ?? []) as ToolDef[]));
      if (retry) {
        this.narrationRetryTurn = turn;
        if (usage && totalTokens(usage) > 0) this.addAux(usage, costOf(usage, this.metaFor(model)?.price)); // billed, discarded attempt: counts in the chat/turn totals once
        if (usage && this.convId) void this.index.recordUsage({ conversationId: this.convId, model, usage, costUsd: costOf(usage, this.metaFor(model)?.price) }).catch((e) => console.error("usage", String(e))); // the call is billed even though its text is not saved on its own
        if (foOn) hook!.breaker().ok(model);
        return this.callModel(turn, model, turnStart, tools, { retries: retries + 1, tReq, forceTool: true, lead: [...(carry?.lead ?? []), ...kept], ...(carry?.fo ? { fo: carry.fo } : {}), ...(synth ? { synth: true } : {}) });
      }
      this.saveAssistant(turn, model, withLead(kept), usage, stop, "complete", ttft, total, retries);
      if (foOn) hook!.breaker().ok(model);
      return stop ?? "end_turn";
    }
    // A reply that ended normally with no tool call and no visible text (thinking does not count) is a failed call, never a saved "complete" empty message: failover where it
    // exists, else ONE same-model retry (carry.emptyRetries caps it: 1, or 3 for gemini-*), else a visible error. The failed call is billed, so its tokens are recorded.
    const synthCalledTool = synth && finished.some((b) => b.type === "tool_use"); // engine guarantee: a synthesis-only call never executes a tool, whatever the provider returned
    if (synthCalledTool || isEmptyReply(withLead(finished), stop)) {
      if (usage && totalTokens(usage) > 0) { const c = costOf(usage, this.metaFor(model)?.price); this.addAux(usage, c); // the discarded call is billed: it counts in the chat/turn totals exactly once (no saved message carries it)
        if (this.convId) void this.index.recordUsage({ conversationId: this.convId, model, usage, costUsd: c }).catch((e) => console.error("usage", String(e))); }
      // a tool already ran in this turn (a tool_result follows the last user text): the retry / failover is synthesis-only, no tools offered, so nothing can run twice
      const toolsRan = this.toolRanThisTurn();
      const rtools: ToolDef[] = toolsRan || synth ? [] : tools, rsynth = toolsRan || synth; // rtools only sizes the failover need; the retry itself carries `synth`
      if (!(signal.aborted || this.stopRequested)) {
        if (foOn) {
          const pick = await this.foPick(fo, body, rtools, hook!);
          if (signal.aborted || this.stopRequested) return "stopped";
          hook!.breaker().fail(model, this.now());
          const next = pick ? this.foApply(turn, model, "empty", fo, pick) : null;
          if (next) return this.callModel(turn, next, turnStart, tools, { retries: retries + 1, tReq, fo, ...(rsynth ? { synth: true } : {}), ...(carry?.lead ? { lead: carry.lead } : {}) });
        }
        if ((carry?.emptyRetries ?? 0) < emptyRetryCap(model)) {
          await this.sleep(this.retryDelayMs);
          if (!(signal.aborted || this.stopRequested)) return this.callModel(turn, model, turnStart, tools, { retries: retries + 1, tReq, emptyRetries: (carry?.emptyRetries ?? 0) + 1, ...(rsynth ? { synth: true } : {}), fo, ...(carry?.lead ? { lead: carry.lead } : {}) });
        }
      }
      if (signal.aborted || this.stopRequested) return "stopped";
      const er = { type: "empty_response", message: EMPTY_REPLY_MESSAGE, retryable: true };
      this.emit(turn, { type: "error", error: er });
      this.endTurn(turn, "error", er);
      return "error";
    }
    this.saveAssistant(turn, model, withLead(finished), usage, stop, "complete", ttft, total, retries);
    if (foOn) hook!.breaker().ok(model); // a success resets the breaker
    void turnStart;
    return stop ?? "end_turn";
  }

  /** Partial content after an abort/error: completed blocks + any text seen so far; unsigned thinking and
   *  incomplete tool calls are dropped (they could never be replayed to the API anyway). */
  private finishedForPartial(acc: BlockAccumulator): Block[] {
    return acc.blocks.filter(Boolean).flatMap((b) => {
      if (b.type === "text") return b.text ? [{ type: "text", text: b.text }] : [];
      if (b.type === "thinking") return b._done && b.signature ? [{ type: "thinking", thinking: b.thinking, signature: b.signature, ...(b._ms !== undefined ? { _ms: b._ms } : {}) }] : [];
      if (b.type === "redacted_thinking") return [b];
      return [];
    });
  }
}
