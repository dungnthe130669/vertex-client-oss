// Open-space automatic model failover. Pure rules + circuit breaker + first-content peek; the turn engine (turn-engine.ts callModel) is the only caller.
// Business / Auto is NOT touched: the engine only calls in here when the `failover` hook exists (Open conversations) and the user's toggle is on.
//
// RULES (docs/open-failover.md has the same table)
//  1. SWITCH (transparent, only BEFORE any text/thinking/tool delta was streamed): connection error / dropped stream, no first content within the
//     provider's first-byte timeout (NIM/Groq 20 s, AI Studio 25 s), HTTP 5xx (incl. 408), 404/410 (model gone), 429 when retry-after > 5 s or the
//     adapter's own retry is used up, 413 (Groq "too large": pick a model that fits), HTTP 200 whose stream ends with no content.
//  2. NO SWITCH: 400 / other 4xx (our bug: surfaced), 401 / 403 (key problem: surfaced), user cancel. A fail-open of the old behaviour: with no eligible next model the
//     engine keeps its normal retry-then-error path.
//  3. After partial content was streamed and the stream then fails: never splice. The error carries `continueWith` (the next eligible model) for a one-click re-run.
//  4. NEXT MODEL: first eligible entry of OPEN_DEFAULT_ORDER that is listed (usable key, enabled), not yet tried this turn, not unhealthy in the breaker, has the capabilities this
//     turn needs (tools if tools are sent, vision if the history has images), fits the prompt (context window / Groq short-context budget), not `limited`. Never leaves Open.
//     AI Studio (Google free tier: content is read by Google) only with the user's OWN AI Studio key, and the notice says so.
//  5. At most MAX_SWITCHES (2) per turn; a model already tried this turn is never picked again (no loop).
//  6. BREAKER per (provider, model): BREAKER.failures failures within BREAKER.windowMs => unhealthy for BREAKER.openMs (skipped by selection and by the default pick); after that one
//     half-open try: a success resets it, a failure re-opens at once. In-memory per isolate, per scope, bounded: a soft hint, never a shared catalog write, no table.
import { OPEN_DEFAULT_ORDER } from "./models-api";
import type { Usage } from "./reducer";
import { ProviderNetworkError, type ProviderModel } from "./providers/types";
import type { Catalog } from "./providers/catalog";
import { splitModelId } from "./providers/config";

/** v1: Google AI Studio is NOT an automatic failover target at all (slow 8-34 s, 503s, data-use warning, no consent UI). Flip `enabled` when a consent UI exists. While false it is
 *  removed from candidates everywhere (selection, stored continue, any list); the separate opt-in setting stays in code and is hidden. An object so tests can flip it. */
export const FAILOVER_AI_STUDIO = { enabled: false };
export const MAX_SWITCHES = 2;
export const RETRY_AFTER_SWITCH_S = 5;
export const RETRY_ABSENT_S = 2;
/** Retry-After: delta-seconds or an HTTP-date (relative to `nowMs`); undefined = absent / unparseable. */
export function parseRetryAfter(v: string | null | undefined, nowMs: number): number | undefined {
  if (!v) return undefined; const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) > 0 ? Number(t) : undefined;
  const d = Date.parse(t);
  return Number.isFinite(d) ? Math.max(0, Math.ceil((d - nowMs) / 1000)) || undefined : undefined;
}
export const FIRST_BYTE_MS: Record<string, number> = { nvidia: 20_000, groq: 20_000, aistudio: 25_000 };
export const DEFAULT_FIRST_BYTE_MS = 25_000;
/** Time-to-first-byte for a turn WITHOUT failover (Business, Open with the toggle off): no stream event at all within this = a retryable stall. Models flagged reasoning get the larger allowance. */
export const TTFB_MS = 60_000;
export const TTFB_REASONING_MS = 120_000;
export const BREAKER = { failures: 3, windowMs: 5 * 60_000, openMs: 10 * 60_000, maxKeys: 200 };

export type FoClass = "network" | "timeout" | "server" | "gone" | "rate" | "too-large" | "empty";
/** What went wrong with one attempt. `status` absent = no HTTP answer (network / timeout / stream). */
export interface FoFailure { status?: number; timedOut?: boolean; empty?: boolean; /** an exception that is not a typed provider/network error: never a trigger */ unknown?: boolean; /** tokens the attempt reported / the provider billed before it failed */ usage?: Usage; retryAfterS?: number; /** the adapter already retried (or the engine's own attempt count is used up) */ retriesUsed?: boolean }

/** The trigger class of a failure, or null = not a trigger (surface it). */
export function classifyFailure(f: FoFailure): FoClass | null {
  if (f.unknown) return null;
  if (f.timedOut) return "timeout";
  if (f.empty) return "empty";
  const s = f.status;
  if (s === undefined) return "network";
  if (s === 404 || s === 410) return "gone";
  if (s === 413) return "too-large";
  // a hint over 5 s switches at once; an absent / short hint gets ONE short same-provider retry first (the engine waits RETRY_ABSENT_S), then switches
  if (s === 429) return (f.retryAfterS !== undefined && f.retryAfterS > RETRY_AFTER_SWITCH_S) || f.retriesUsed ? "rate" : null;
  if (s === 408) return "timeout";
  if (s >= 500) return "server";
  return null; // 400 / 401 / 403 / 409 / ...: our bug, a key problem, or the old retry path
}
export const REASON: Record<FoClass, string> = {
  network: "connection failed", timeout: "no answer in time", server: "the provider had an error", gone: "that model is no longer available",
  rate: "rate limited", "too-large": "the chat is too large for it", empty: "it returned an empty reply",
};

export interface FoCandidate {
  /** prefixed id, e.g. `nvidia:nvidia/nemotron-3.5-lightning-30b-a3b` */
  id: string; tools: boolean; vision: boolean;
  /** largest prompt (tokens) it takes: the context window, or the per-minute budget of a short-context model; null = unknown (assume fits) */
  maxPrompt: number | null;
  /** a very small daily quota: never a failover target */
  limited?: boolean;
  /** AI Studio: usable here only with the user's own key (the data-use notice applies) */
  ownKeyOnly?: boolean; ownKey?: boolean;
  /** appended to the notice when this model is used */
  notice?: string;
}
export interface FoNeed { tools: boolean; vision: boolean; promptTokens: number }

/** What selection and the engine need from a breaker (the in-memory Breaker, or the D1-backed one in provider-health.ts). */
export interface BreakerLike { fail(key: string, now: number): void; ok(key: string): void; unhealthy(key: string, now: number): boolean;
  /** a model chosen by selection takes its half-open probe: true for exactly ONE caller while the lease is free (always true for a model that is not half-open) */
  take?(key: string): boolean }
/** Circuit breaker logic (rule 6); provider-health.ts persists it. */
export class Breaker implements BreakerLike {
  private m = new Map<string, { fails: number[]; openedAt: number | null }>();
  constructor(private cfg = BREAKER) {}
  fail(key: string, now: number) {
    const e = this.m.get(key) ?? { fails: [], openedAt: null };
    e.fails = [...e.fails.filter((t) => now - t < this.cfg.windowMs), now];
    if (e.openedAt !== null && now - e.openedAt >= this.cfg.openMs) e.openedAt = now; // half-open probe failed: re-open at once
    else if (e.openedAt === null && e.fails.length >= this.cfg.failures) e.openedAt = now;
    this.m.delete(key); this.m.set(key, e);
    while (this.m.size > this.cfg.maxKeys) this.m.delete(this.m.keys().next().value as string);
  }
  ok(key: string) { this.m.delete(key); }
  /** Restore one persisted entry (fails within the window since windowStart; open until openUntil, 0 = closed). */
  load(key: string, fails: number, windowStart: number, openUntil: number) { this.m.set(key, { fails: Array(Math.max(0, Math.min(fails, 50))).fill(windowStart), openedAt: openUntil > 0 ? openUntil - this.cfg.openMs : null }); }
  has(key: string) { return this.m.has(key); }
  /** open window over (a probe is due) and not yet re-failed / reset */
  halfOpen(key: string, now: number): boolean { const e = this.m.get(key); return !!e && e.openedAt !== null && now - e.openedAt >= this.cfg.openMs; }
  halfOpenKeys(now: number): string[] { return [...this.m.keys()].filter((k) => this.halfOpen(k, now)); }
  get openMs() { return this.cfg.openMs; }
  /** true = skip it. After openMs it is half-open (one more try is allowed; the next fail re-opens). */
  unhealthy(key: string, now: number): boolean { const e = this.m.get(key); return !!e && e.openedAt !== null && now - e.openedAt < this.cfg.openMs; }
}

/** First eligible next model (rule 4/5), or null. */
export function pickNext(cands: FoCandidate[], tried: string[], need: FoNeed, br: BreakerLike | null, now: number): FoCandidate | null {
  for (const id of OPEN_DEFAULT_ORDER) {
    const c = cands.find((x) => x.id === id);
    if (!c || tried.includes(id) || c.limited) continue;
    if (!FAILOVER_AI_STUDIO.enabled && id.startsWith("aistudio:")) continue; // v1: never an automatic target
    if (c.ownKeyOnly && !c.ownKey) continue;
    if (need.tools && !c.tools) continue;
    if (need.vision && !c.vision) continue;
    if (c.maxPrompt !== null && need.promptTokens > c.maxPrompt) continue;
    if (br?.unhealthy(id, now)) continue;
    return c;
  }
  return null;
}

/** The hook the engine takes (Open only). */
export interface FailoverHook {
  /** the user's toggle (default ON); a lookup error counts as off */
  enabled: () => boolean | Promise<boolean>;
  candidates: () => Promise<FoCandidate[]>;
  breaker: () => BreakerLike;
  /** reload shared health (D1, cached ~10 s per isolate); errors are swallowed by the caller */
  refresh?: () => Promise<void>;
  /** first-byte timeout in ms for a prefixed model id */
  firstByteMs?: (modelId: string) => number;
}
export const firstByteMsOf = (modelId: string) => FIRST_BYTE_MS[splitModelId(modelId).provider] ?? DEFAULT_FIRST_BYTE_MS;

/** Candidates from the router's chat listing + the catalog rows (short-context budget, limited flag). */
export function buildCandidates(models: ProviderModel[], catalog: Catalog, hasOwnKey: (provider: string) => boolean, notices: (provider: string) => string | undefined, o: { /** the separate opt-in "Allow Google AI Studio as an automatic fallback" */ aistudioAllowed: boolean; /** the user's own broken-model lists (bare ids per provider) */ broken?: Record<string, string[]> }): FoCandidate[] {
  return models.filter((m) => (!m.kind || m.kind === "chat") && !(o.broken?.[splitModelId(m.id).provider] ?? []).includes(splitModelId(m.id).model) && (splitModelId(m.id).provider !== "aistudio" || (FAILOVER_AI_STUDIO.enabled && o.aistudioAllowed))).map((m) => {
    const { provider, model: bare } = splitModelId(m.id);
    const row = (catalog.get(provider) ?? []).find((r) => r.id === bare && r.kind === "chat");
    const tpm = row?.extra?.shortContext === true ? row.limits?.tpm : undefined;
    const maxPrompt = tpm ? Math.floor(tpm * 0.6) : m.contextWindow ? Math.floor(m.contextWindow * 0.9) : null;
    const limited = !!row && (row.extra?.limited === true || (row.limits?.rpd !== undefined && row.limits.rpd <= 100));
    return { id: m.id, tools: !!m.capabilities?.tools, vision: !!m.capabilities?.vision, maxPrompt, limited, ...(provider === "aistudio" ? { ownKeyOnly: true, ownKey: hasOwnKey("aistudio") } : {}), notice: notices(provider) };
  });
}

// ---- first-content peek -------------------------------------------------------------------------------------------------
export type Peek =
  | { ok: true; res: Response }
  | { ok: false; failure: FoFailure; message: string; stopped?: boolean };
const TRANSIENT_STREAM_ERR = new Set(["overloaded_error", "api_error", "rate_limit_error", "timeout_error", "network_error"]);
const hasContent = (j: any): boolean => j?.type === "content_block_delta" ? !!(j.delta?.text || j.delta?.thinking || j.delta?.partial_json) : j?.type === "content_block_start" && j.content_block?.type !== "text" && j.content_block?.type !== "thinking";

/** Read the upstream SSE just far enough to know the attempt is real: first content delta (ok), a transient stream error / early end (failure, nothing was shown), or a
 *  deadline (timeout). The bytes read are replayed in front of the rest, so the engine's own reader sees an untouched stream. A NON-transient error event is passed on as is. */
export async function peekFirstContent(res: Response, deadlineMs: number, abortAttempt: () => void, signal?: AbortSignal, anyEvent = false): Promise<Peek> {
  const reader = res.body!.getReader(), dec = new TextDecoder(), held: Uint8Array[] = [];
  let buf = "", usage: Usage | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"t">((r) => { timer = setTimeout(() => r("t"), Math.max(1, deadlineMs)); });
  const aborted = new Promise<"a">((r) => { if (signal?.aborted) r("a"); else signal?.addEventListener("abort", () => r("a"), { once: true }); });
  const rebuilt = () => new Response(new ReadableStream<Uint8Array>({
    start(c) { for (const h of held) c.enqueue(h); },
    async pull(c) { try { const r = await reader.read(); if (r.done) c.close(); else c.enqueue(r.value); } catch (e) { c.error(e); } },
    cancel(why) { return reader.cancel(why); },
  }), { status: res.status, headers: res.headers });
  const fail = (failure: FoFailure, message: string): Peek => { reader.cancel().catch(() => {}); return { ok: false, failure: usage ? { ...failure, usage } : failure, message }; };
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), deadline, aborted]);
      if (r === "t") { abortAttempt(); return fail({ timedOut: true }, "no first content before the deadline"); }
      if (r === "a") return { ok: true, res: rebuilt() }; // user stop: the engine's loop handles it
      if (r.done) return fail({ empty: true }, "the stream ended with no content");
      held.push(r.value); buf += dec.decode(r.value, { stream: true }).replace(/\r\n/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:")); buf = buf.slice(i + 2);
        if (!line) continue;
        let j: any; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (j.type === "message_start" && j.message?.usage) usage = { ...j.message.usage }; else if (j.type === "message_delta" && j.usage) usage = { ...usage, ...j.usage };
        if (hasContent(j) || (anyEvent && j.type !== "ping")) return { ok: true, res: rebuilt() }; // anyEvent (no-failover turns): the first real frame proves the model is alive; classification stays with the stream loop
        if (j.type === "error") return TRANSIENT_STREAM_ERR.has(j.error?.type) ? fail(j.error?.type === "network_error" ? {} : { status: j.error?.type === "rate_limit_error" ? 429 : 503, retriesUsed: true }, String(j.error?.message ?? "stream error")) : { ok: true, res: rebuilt() };
        if (j.type === "message_stop" || (j.type === "message_delta" && j.delta?.stop_reason)) return fail({ empty: true }, "the reply was empty");
      }
    }
  } catch (e) {
    if (signal?.aborted) return { ok: false, failure: {}, message: "stopped", stopped: true }; // the user's stop: not a failure of the model
    return fail(e instanceof ProviderNetworkError ? {} : { unknown: true }, `stream failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally { clearTimeout(timer); }
}

