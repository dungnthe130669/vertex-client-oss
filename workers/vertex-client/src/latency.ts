// Measured model latency + speed tier. Measured in the Worker around the provider call (providers/registry.ts router), so every provider (NIM, Cloudflare, Vertex, any later
// adapter) goes through the same code. NEVER stores message content: a sample is timings, token count, outcome, provider/model ids and the space. Writes are cheap, run in
// ctx.waitUntil, never block or break a turn, and fail silently. Aggregates (model_latency_stats) hold no user id; raw samples are bounded (SPEED.window per model+kind).
import type { ModelKind } from "./providers/types";

export type Outcome = "ok" | "error" | "timeout" | "cancel";
export interface LatencySample {
  providerId: string; modelId: string; kind: ModelKind; space: "open" | "biz"; startedAt: number;
  /** ms from start until the upstream answered (headers) */
  ttfbMs: number | null; /** first reasoning token (thinking) */ ttfrMs: number | null; /** first answer token (after thinking) */ ttfaMs: number | null;
  totalMs: number; outputTokens: number | null; outcome: Outcome;
}
export interface LatencySink { record(s: LatencySample): void }

/** Tunable in ONE place. Tier is judged on the p50 of the first answer token for chat (thinking time included: a slow thinker IS slow) and on the p50 total wall time for image/video.
 *  fastMs <= p50 -> fast; > slowMs -> slow; between -> medium; fewer than minSamples ok samples -> unknown. */
export const SPEED = {
  minSamples: 3, window: 200,
  tiers: { chat: { fastMs: 3_000, slowMs: 12_000 }, image: { fastMs: 8_000, slowMs: 30_000 }, video: { fastMs: 60_000, slowMs: 180_000 } } as Record<ModelKind, { fastMs: number; slowMs: number }>,
};
export type SpeedTier = "fast" | "medium" | "slow" | "unknown";
export interface SpeedStats { samples: number; ttfaP50: number | null; ttfaP90: number | null; totalP50: number | null; totalP90: number | null; tokensPerS: number | null }
export interface SpeedInfo { tier: SpeedTier; samples: number; firstAnswerMs: number | null; totalMs: number | null; tokensPerS: number | null }

/** Nearest-rank percentile of an unsorted list; null for an empty one. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
/** Stats over the OK samples of one model+kind (errors / timeouts / cancels say nothing about speed). */
export function computeStats(samples: Array<Pick<LatencySample, "ttfaMs" | "totalMs" | "outputTokens" | "outcome">>): SpeedStats {
  const ok = samples.filter((s) => s.outcome === "ok");
  const ttfa = ok.map((s) => s.ttfaMs).filter((x): x is number => x !== null);
  const tps = ok.filter((s) => s.outputTokens && s.outputTokens > 0 && s.totalMs > 0).map((s) => s.outputTokens! / (s.totalMs / 1000));
  return { samples: ok.length, ttfaP50: percentile(ttfa, 50), ttfaP90: percentile(ttfa, 90), totalP50: percentile(ok.map((s) => s.totalMs), 50), totalP90: percentile(ok.map((s) => s.totalMs), 90),
    tokensPerS: tps.length ? Math.round((tps.reduce((a, b) => a + b, 0) / tps.length) * 10) / 10 : null };
}
export function tierOf(kind: ModelKind, st: SpeedStats | null | undefined): SpeedTier {
  if (!st || st.samples < SPEED.minSamples) return "unknown";
  const metric = kind === "chat" ? st.ttfaP50 ?? st.totalP50 : st.totalP50;
  if (metric === null) return "unknown";
  const t = SPEED.tiers[kind] ?? SPEED.tiers.chat;
  return metric <= t.fastMs ? "fast" : metric > t.slowMs ? "slow" : "medium";
}
export const speedInfo = (kind: ModelKind, st: SpeedStats | null | undefined): SpeedInfo => {
  const tier = tierOf(kind, st);
  return tier === "unknown" || !st ? { tier, samples: st?.samples ?? 0, firstAnswerMs: null, totalMs: null, tokensPerS: null } : { tier, samples: st.samples, firstAnswerMs: st.ttfaP50, totalMs: st.totalP50, tokensPerS: st.tokensPerS };
};

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
/** Persist one sample, prune to the window, refresh the aggregate. Every error is swallowed: a D1 problem must never reach a turn. */
export function d1Sink(db: D1Database | undefined, waitUntil: (p: Promise<unknown>) => void): LatencySink {
  return {
    record(s) {
      if (!db) return;
      const run = async () => {
        const { providerId: p, modelId: m, kind: k } = s;
        await db.batch([
          db.prepare(`INSERT INTO model_latency_samples (provider_id, model_id, kind, space, started_at, ttfb_ms, ttfr_ms, ttfa_ms, total_ms, output_tokens, outcome) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(p, m, k, s.space, int(s.startedAt) ?? 0, int(s.ttfbMs), int(s.ttfrMs), int(s.ttfaMs), int(s.totalMs) ?? 0, int(s.outputTokens), s.outcome),
          db.prepare(`DELETE FROM model_latency_samples WHERE provider_id=?1 AND model_id=?2 AND kind=?3 AND id NOT IN (SELECT id FROM model_latency_samples WHERE provider_id=?1 AND model_id=?2 AND kind=?3 ORDER BY id DESC LIMIT ?4)`).bind(p, m, k, SPEED.window),
        ]);
        const rows = await db.prepare(`SELECT ttfa_ms, total_ms, output_tokens, outcome FROM model_latency_samples WHERE provider_id=? AND model_id=? AND kind=? ORDER BY id DESC LIMIT ?`).bind(p, m, k, SPEED.window).all<any>();
        const st = computeStats((rows.results ?? []).map((r) => ({ ttfaMs: r.ttfa_ms ?? null, totalMs: r.total_ms, outputTokens: r.output_tokens ?? null, outcome: r.outcome as Outcome })));
        await db.prepare(`INSERT INTO model_latency_stats (provider_id, model_id, kind, samples, ttfa_p50_ms, ttfa_p90_ms, total_p50_ms, total_p90_ms, tokens_per_s, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(provider_id, model_id, kind) DO UPDATE SET samples=excluded.samples, ttfa_p50_ms=excluded.ttfa_p50_ms, ttfa_p90_ms=excluded.ttfa_p90_ms, total_p50_ms=excluded.total_p50_ms, total_p90_ms=excluded.total_p90_ms, tokens_per_s=excluded.tokens_per_s, updated_at=excluded.updated_at`)
          .bind(p, m, k, st.samples, st.ttfaP50, st.ttfaP90, st.totalP50, st.totalP90, st.tokensPerS, Date.now()).run();
      };
      const p = run().catch(() => {}); // started once; if waitUntil throws the work still runs, never a second time
      try { waitUntil(p); } catch { /* already running */ }
    },
  };
}

export const speedKey = (provider: string, model: string, kind: ModelKind) => `${provider}\u0000${kind}\u0000${model}`;
/** All aggregates (one query). Missing table / failure = empty (every tier unknown). */
export async function loadSpeedStats(db: D1Database | undefined): Promise<Map<string, SpeedStats>> {
  const out = new Map<string, SpeedStats>();
  if (!db) return out;
  try {
    const r = await db.prepare(`SELECT provider_id, model_id, kind, samples, ttfa_p50_ms, ttfa_p90_ms, total_p50_ms, total_p90_ms, tokens_per_s FROM model_latency_stats LIMIT 2000`).all<any>();
    for (const x of r.results ?? []) out.set(speedKey(x.provider_id, x.model_id, x.kind), { samples: x.samples, ttfaP50: x.ttfa_p50_ms ?? null, ttfaP90: x.ttfa_p90_ms ?? null, totalP50: x.total_p50_ms ?? null, totalP90: x.total_p90_ms ?? null, tokensPerS: x.tokens_per_s ?? null });
  } catch { /* migration 0029 not applied */ }
  return out;
}

export interface CallTimer { startedAt: number; ttfbMs: number | null }
/** Outcome of a call that threw before any stream existed. */
export function outcomeOfError(e: unknown, signal?: AbortSignal): Outcome {
  if (signal?.aborted) return "cancel";
  const x = e as { status?: number; info?: { type?: string } } | null;
  return x?.info?.type === "upstream_timeout" || x?.status === 408 || x?.status === 504 ? "timeout" : "error";
}

/** Pass an Anthropic-SSE response through unchanged while timing it: first reasoning token, first answer token, output tokens, how it ended. Only event TYPES / timings are read; the text is not kept. */
export function trackStream(res: Response, t: CallTimer, base: Omit<LatencySample, "startedAt" | "ttfbMs" | "ttfrMs" | "ttfaMs" | "totalMs" | "outputTokens" | "outcome">, sink: LatencySink, signal?: AbortSignal, now: () => number = Date.now): Response {
  if (!res.body || !res.ok) {
    sink.record({ ...base, startedAt: t.startedAt, ttfbMs: t.ttfbMs, ttfrMs: null, ttfaMs: null, totalMs: now() - t.startedAt, outputTokens: null, outcome: res.ok ? "ok" : res.status === 408 || res.status === 504 ? "timeout" : "error" });
    return res;
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", ttfr: number | null = null, tta: number | null = null, tokens: number | null = null, stop = false, err = false, done = false;
  const finish = (o: Outcome) => { if (done) return; done = true; try { sink.record({ ...base, startedAt: t.startedAt, ttfbMs: t.ttfbMs, ttfrMs: ttfr, ttfaMs: tta, totalMs: now() - t.startedAt, outputTokens: tokens, outcome: o }); } catch { /* never breaks a turn */ } };
  const line = (l: string) => {
    if (!l.startsWith("data:") || l.length > 65_536) return;
    let j: any; try { j = JSON.parse(l.slice(5)); } catch { return; }
    const at = now() - t.startedAt;
    if (j.type === "content_block_start" && j.content_block?.type === "thinking" && ttfr === null) ttfr = at;
    else if (j.type === "content_block_delta") {
      if (j.delta?.type === "thinking_delta" && ttfr === null) ttfr = at;
      else if (j.delta?.type === "text_delta" && typeof j.delta.text === "string" && j.delta.text && tta === null) tta = at;
    } else if (j.type === "message_delta" && typeof j.usage?.output_tokens === "number") tokens = j.usage.output_tokens;
    else if (j.type === "message_stop") stop = true;
    else if (j.type === "error") err = true;
  };
  const scan = (chunk: Uint8Array) => { buf += dec.decode(chunk, { stream: true }); let i: number; while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); } if (buf.length > 131_072) buf = ""; };
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const r = await reader.read();
        if (r.done) { if (buf) line(buf.replace(/\r$/, "")); finish(err ? "error" : stop ? "ok" : signal?.aborted ? "cancel" : "error"); c.close(); return; }
        try { scan(r.value); } catch { /* timing only */ }
        c.enqueue(r.value);
      } catch (e) { finish(signal?.aborted ? "cancel" : "error"); c.error(e); }
    },
    cancel(reason) { finish("cancel"); return reader.cancel(reason); },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
