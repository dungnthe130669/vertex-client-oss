// Latency metrics + speed tier: measured around the router for every provider, no content stored, bounded, never breaks a turn.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { buildRegistry } from "../src/providers/registry";
import { ProviderError } from "../src/providers/types";
import { SPEED, computeStats, d1Sink, loadSpeedStats, percentile, speedInfo, tierOf, trackStream, type LatencySample, type LatencySink, type SpeedStats } from "../src/latency";

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }), run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; } } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as unknown as D1Database };
}
const enc = new TextEncoder();
const ev = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
const clock = () => { let t = 1000; return { now: () => t, set: (v: number) => { t = v; } }; };
/** An Anthropic SSE response whose chunks arrive at the given clock times. */
function timedSse(c: ReturnType<typeof clock>, steps: Array<[number, string]>, tail: "end" | "hang" = "end") {
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(ctl) { if (i < steps.length) { const [t, s] = steps[i++]!; c.set(t); ctl.enqueue(enc.encode(s)); } else if (tail === "end") ctl.close(); else return new Promise(() => {}); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
const rec = () => { const out: LatencySample[] = []; return { out, sink: { record: (s: LatencySample) => void out.push(s) } as LatencySink }; };
const base = { providerId: "nvidia", modelId: "m", kind: "chat" as const, space: "open" as const };
const drain = async (r: Response) => { const rd = r.body!.getReader(); let n = ""; for (;;) { const x = await rd.read(); if (x.done) return n; n += new TextDecoder().decode(x.value); } };

describe("percentile / stats / tier boundaries", () => {
  test("nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull(); expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5); expect(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 90)).toBe(9);
  });
  const st = (p50: number | null, samples = 5, total: number | null = p50): SpeedStats => ({ samples, ttfaP50: p50, ttfaP90: p50, totalP50: total, totalP90: total, tokensPerS: 40 });
  test("chat tier boundaries on the first-answer p50: <=fast is fast, >slow is slow, between medium", () => {
    const { fastMs, slowMs } = SPEED.tiers.chat;
    expect(tierOf("chat", st(fastMs))).toBe("fast"); expect(tierOf("chat", st(fastMs + 1))).toBe("medium");
    expect(tierOf("chat", st(slowMs))).toBe("medium"); expect(tierOf("chat", st(slowMs + 1))).toBe("slow");
  });
  test("per kind: image/video judge total wall time with their own thresholds", () => {
    expect(tierOf("image", st(null, 5, SPEED.tiers.image.fastMs))).toBe("fast"); expect(tierOf("image", st(null, 5, SPEED.tiers.image.slowMs + 1))).toBe("slow");
    expect(tierOf("video", st(null, 5, 100_000))).toBe("medium"); expect(tierOf("chat", st(null, 5, 100_000))).toBe("slow"); // chat with no first-answer data falls back to total
    expect(tierOf("image", st(1, 5, null))).toBe("unknown");
  });
  test("unknown with fewer than minSamples ok samples (and no timings leak), known at exactly minSamples", () => {
    expect(SPEED.minSamples).toBe(3);
    expect(tierOf("chat", st(100, 2))).toBe("unknown"); expect(tierOf("chat", st(100, 3))).toBe("fast"); expect(tierOf("chat", null)).toBe("unknown");
    expect(speedInfo("chat", st(100, 2))).toEqual({ tier: "unknown", samples: 2, firstAnswerMs: null, totalMs: null, tokensPerS: null });
    expect(speedInfo("chat", st(100, 3))).toMatchObject({ tier: "fast", firstAnswerMs: 100, totalMs: 100, tokensPerS: 40 });
  });
  test("only ok samples count; tokens/s from output tokens over wall time", () => {
    const s = computeStats([{ ttfaMs: 100, totalMs: 2000, outputTokens: 100, outcome: "ok" }, { ttfaMs: 900, totalMs: 9000, outputTokens: 10, outcome: "error" }, { ttfaMs: null, totalMs: 1000, outputTokens: null, outcome: "ok" }, { ttfaMs: 5, totalMs: 5, outputTokens: 5, outcome: "cancel" }]);
    expect(s).toMatchObject({ samples: 2, ttfaP50: 100, totalP50: 1000, tokensPerS: 50 });
  });
});

describe("trackStream", () => {
  test("times first reasoning token, first answer token (after thinking), output tokens; bytes pass through unchanged", async () => {
    const c = clock(); const { out, sink } = rec();
    const chunks: Array<[number, string]> = [[1100, ev({ type: "message_start" })], [1500, ev({ type: "content_block_start", content_block: { type: "thinking" } }) + ev({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } })],
      [4000, ev({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } })], [4200, ev({ type: "message_delta", usage: { output_tokens: 42 } }) + ev({ type: "message_stop" })]];
    const src = timedSse(c, chunks);
    const body = chunks.map((x) => x[1]).join("");
    const r = trackStream(src, { startedAt: 1000, ttfbMs: 50 }, base, sink, undefined, c.now);
    expect(await drain(r)).toBe(body);
    expect(out).toEqual([{ ...base, startedAt: 1000, ttfbMs: 50, ttfrMs: 500, ttfaMs: 3000, totalMs: 3200, outputTokens: 42, outcome: "ok" }]);
  });
  test("a sample holds timings/ids only: no message text anywhere in it", async () => {
    const c = clock(); const { out, sink } = rec();
    await drain(trackStream(timedSse(c, [[1100, ev({ type: "content_block_delta", delta: { type: "text_delta", text: "SECRET-USER-TEXT" } }) + ev({ type: "message_stop" })]]), { startedAt: 1000, ttfbMs: 1 }, base, sink, undefined, c.now));
    expect(JSON.stringify(out)).not.toContain("SECRET"); expect(Object.keys(out[0]!).sort()).toEqual(["kind", "modelId", "outcome", "outputTokens", "providerId", "space", "startedAt", "totalMs", "ttfaMs", "ttfbMs", "ttfrMs"]);
  });
  test("mid-stream error event -> error; ends without message_stop -> error; client cancel -> cancel; recorded exactly once", async () => {
    let c = clock(); let r1 = rec();
    await drain(trackStream(timedSse(c, [[1100, ev({ type: "error", error: { type: "api_error" } })]]), { startedAt: 1000, ttfbMs: 1 }, base, r1.sink, undefined, c.now)); expect(r1.out.map((s) => s.outcome)).toEqual(["error"]);
    c = clock(); r1 = rec();
    await drain(trackStream(timedSse(c, [[1100, ev({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } })]]), { startedAt: 1000, ttfbMs: 1 }, base, r1.sink, undefined, c.now)); expect(r1.out[0]).toMatchObject({ outcome: "error", ttfaMs: 100 });
    c = clock(); r1 = rec();
    const res = trackStream(timedSse(c, [[1100, ev({ type: "message_start" })]], "hang"), { startedAt: 1000, ttfbMs: 1 }, base, r1.sink, undefined, c.now);
    const rd = res.body!.getReader(); await rd.read(); await rd.cancel(); await rd.cancel().catch(() => {}); expect(r1.out.map((s) => s.outcome)).toEqual(["cancel"]);
  });
  test("a sink that throws never breaks the stream", async () => {
    const c = clock();
    const r = trackStream(timedSse(c, [[1100, ev({ type: "message_stop" })]]), { startedAt: 1000, ttfbMs: 1 }, base, { record: () => { throw new Error("boom"); } }, undefined, c.now);
    expect(await drain(r)).toContain("message_stop");
  });
  test("a non-ok response is recorded (timeout for 504) and returned as is", async () => {
    const { out, sink } = rec(); const res = new Response("x", { status: 504 });
    expect(trackStream(res, { startedAt: 1, ttfbMs: 2 }, base, sink, undefined, () => 10)).toBe(res); expect(out[0]).toMatchObject({ outcome: "timeout", totalMs: 9 });
  });
});

describe("router timing (same path for every provider)", () => {
  const sse = (c: ReturnType<typeof clock>) => timedSse(c, [[1300, ev({ type: "content_block_delta", delta: { type: "text_delta", text: "a" } })], [1900, ev({ type: "message_delta", usage: { output_tokens: 7 } }) + ev({ type: "message_stop" })]]);
  const mk = (gw: any, latency: LatencySink, c: ReturnType<typeof clock>, scope: any = "main") => buildRegistry({ scope, gateway: gw, env: { PROVIDER_KEY_NVIDIA: "k" }, latency, now: c.now, fetchImpl: (async () => sse(c)) as any });
  test("Vertex (gateway, Business): one chat sample with the bare model id and space biz", async () => {
    const c = clock(); const { out, sink } = rec();
    const gw = { name: "gw", listModels: async () => [], messages: async () => { c.set(1100); return sse(c); } };
    await drain(await mk(gw, sink, c).router.messages({ model: "claude-sonnet-5-5", stream: true, messages: [] }));
    expect(out).toEqual([{ providerId: "gateway", modelId: "claude-sonnet-5-5", kind: "chat", space: "biz", startedAt: 1000, ttfbMs: 100, ttfrMs: null, ttfaMs: 300, totalMs: 900, outputTokens: 7, outcome: "ok" }]);
  });
  test("an Open provider (prefixed id): provider id and bare model recorded, space open", async () => {
    const c = clock(); const { out, sink } = rec();
    const reg = mk({ name: "gw", listModels: async () => [], messages: async () => new Response("") }, sink, c, "main~open");
    await drain(await reg.router.messages({ model: "nvidia:openai/gpt-oss-20b", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(out[0]).toMatchObject({ providerId: "nvidia", modelId: "openai/gpt-oss-20b", space: "open", outcome: "ok" });
  });
  test("timeout / error / cancel classification when the call throws before a stream exists", async () => {
    const c = clock(); const { out, sink } = rec();
    let err: unknown = new ProviderError("t", 504, { type: "upstream_timeout" });
    const gw = { name: "gw", listModels: async () => [], messages: async () => { throw err; } };
    const r = mk(gw, sink, c);
    await expect(r.router.messages({ model: "claude-x" })).rejects.toBe(err);
    err = new ProviderError("bad", 502); await expect(r.router.messages({ model: "claude-x" })).rejects.toBe(err);
    const ac = new AbortController(); ac.abort(); err = new DOMException("aborted", "AbortError"); await expect(r.router.messages({ model: "claude-x" }, ac.signal)).rejects.toBe(err);
    expect(out.map((s) => s.outcome)).toEqual(["timeout", "error", "cancel"]);
  });
  test("image calls are timed with kind image; a provider that is not available records nothing", async () => {
    const c = clock(); const { out, sink } = rec();
    const gw = { name: "gw", listModels: async () => [], messages: async () => new Response(""), image: async () => { c.set(1700); return { model: "i", images: [], text: null, finish_reason: "STOP" }; } };
    const r = mk(gw, sink, c);
    await r.router.image!({ model: "imagen-x", prompt: "p" }); expect(out[0]).toMatchObject({ kind: "image", providerId: "gateway", modelId: "imagen-x", totalMs: 700, outcome: "ok" });
    await expect(r.router.messages({ model: "nope:model" })).rejects.toBeInstanceOf(ProviderError); expect(out.length).toBe(1);
  });
  test("no sink = no change (call passes straight through)", async () => {
    const c = clock(); const gw = { name: "gw", listModels: async () => [], messages: async () => new Response("same") };
    const reg = buildRegistry({ scope: "main", gateway: gw, env: {}, now: c.now });
    expect(await (await reg.router.messages({ model: "claude-x" })).text()).toBe("same");
  });
});

describe("d1Sink: bounded, aggregated, silent on failure", () => {
  const sample = (i: number, o: Partial<LatencySample> = {}): LatencySample => ({ providerId: "nvidia", modelId: "m1", kind: "chat", space: "open", startedAt: 1000 + i, ttfbMs: 10, ttfrMs: null, ttfaMs: 100 + i, totalMs: 1000 + i, outputTokens: 50, outcome: "ok", ...o });
  const run = async (db: D1Database, ss: LatencySample[]) => { const ps: Promise<unknown>[] = []; const sink = d1Sink(db, (p) => ps.push(p)); for (const s of ss) { sink.record(s); await Promise.all(ps); } };
  test("raw samples are pruned to the window; the aggregate row follows; tier is unknown until minSamples", async () => {
    const { db, d1: dd } = d1();
    await run(dd, [sample(0), sample(1)]);
    let st = (await loadSpeedStats(dd)).get(`nvidia\u0000chat\u0000m1`)!; expect(st.samples).toBe(2); expect(tierOf("chat", st)).toBe("unknown");
    await run(dd, Array.from({ length: SPEED.window + 50 }, (_, i) => sample(10 + i)));
    expect((db.query(`SELECT COUNT(*) n FROM model_latency_samples`).get() as any).n).toBe(SPEED.window);
    expect((db.query(`SELECT MIN(started_at) m FROM model_latency_samples`).get() as any).m).toBe(1000 + 10 + 50); // the OLDEST were dropped
    st = (await loadSpeedStats(dd)).get(`nvidia\u0000chat\u0000m1`)!; expect(st.samples).toBe(SPEED.window); expect(tierOf("chat", st)).toBe("fast");
    expect((db.query(`SELECT COUNT(*) n FROM model_latency_stats`).get() as any).n).toBe(1);
  });
  test("bounds are per provider+model+kind; errors are stored but do not feed the aggregate", async () => {
    const { db, d1: dd } = d1();
    await run(dd, [sample(0, { outcome: "error", ttfaMs: null }), sample(1, { modelId: "m2" }), sample(2, { kind: "image", ttfaMs: null })]);
    const all = await loadSpeedStats(dd);
    expect(all.get(`nvidia\u0000chat\u0000m1`)!.samples).toBe(0); expect(all.get(`nvidia\u0000chat\u0000m2`)!.samples).toBe(1); expect(all.get(`nvidia\u0000image\u0000m1`)!.samples).toBe(1);
    expect((db.query(`SELECT COUNT(*) n FROM model_latency_samples`).get() as any).n).toBe(3);
  });
  test("no content and no user id in either table (column audit)", () => {
    const { db } = d1();
    const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
    for (const t of ["model_latency_samples", "model_latency_stats"]) for (const c of cols(t)) expect(c).not.toMatch(/text|content|prompt|message|body|user|scope|email|session|conversation/i);
    expect(cols("model_latency_stats")).not.toContain("space");
  });
  test("D1 failure never throws and never reaches the caller (batch down, whole DB down, no DB)", async () => {
    const { d1: dd } = d1();
    for (const bad of [{ ...dd, batch: async () => { throw new Error("D1 down"); } } as any, { prepare: () => { throw new Error("D1 down"); } } as any, undefined]) {
      const ps: Promise<unknown>[] = []; const sink = d1Sink(bad, (p) => ps.push(p));
      expect(() => sink.record(sample(0))).not.toThrow(); await expect(Promise.all(ps)).resolves.toBeDefined();
    }
    expect((await loadSpeedStats({ prepare: () => { throw new Error("D1 down"); } } as any)).size).toBe(0);
    const throwingWait = d1Sink(dd, () => { throw new Error("no ctx"); }); expect(() => throwingWait.record(sample(0))).not.toThrow();
  });
  test("waitUntil throwing does not run the work twice (one sample, not two)", async () => {
    const { db, d1: dd } = d1(); const sink = d1Sink(dd, () => { throw new Error("no ctx"); });
    sink.record(sample(0)); await new Promise((r) => setTimeout(r, 50));
    expect((db.query(`SELECT COUNT(*) n FROM model_latency_samples`).get() as any).n).toBe(1);
  });
  test("a turn survives a D1 outage end to end (router -> sink -> broken D1)", async () => {
    const c = clock(); const ps: Promise<unknown>[] = [];
    const sink = d1Sink({ prepare: () => { throw new Error("D1 down"); }, batch: async () => { throw new Error("D1 down"); } } as any, (p) => ps.push(p));
    const gw = { name: "gw", listModels: async () => [], messages: async () => timedSse(c, [[1100, ev({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }) + ev({ type: "message_stop" })]]) };
    const reg = buildRegistry({ scope: "main", gateway: gw, env: {}, latency: sink, now: c.now });
    expect(await drain(await reg.router.messages({ model: "claude-x" }))).toContain("message_stop"); await Promise.all(ps);
  });
});

describe("/api/models speed tier from the stored aggregates", () => {
  const app = createApp({ scopeOf: () => "main", provider: () => ({ name: "gw", messages: async () => new Response("{}"), listModels: async () => [{ id: "claude-sonnet-5-5", displayName: "S" }] }) });
  test("tier + typical timings only with enough samples; per kind keyed; hidden (unknown) otherwise", async () => {
    const x = d1(); const env: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", AI: {}, PROVIDER_KEY_NVIDIA: "nvapi-test-0123456789", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1 };
    const put = (p: string, m: string, k: string, n: number, ttfa: number, total: number) => x.db.query(`INSERT INTO model_latency_stats (provider_id, model_id, kind, samples, ttfa_p50_ms, ttfa_p90_ms, total_p50_ms, total_p90_ms, tokens_per_s, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(p, m, k, n, ttfa, ttfa * 2, total, total * 2, 33.3, 1);
    put("nvidia", "nvidia/nemotron-3-ultra-550b-a55b", "chat", 12, 900, 4000);
    put("nvidia", "minimaxai/minimax-m3.1-flash", "chat", 30, 45_000, 90_000);
    put("nvidia", "nvidia/nemotron-3.5-bolt-e4b", "chat", 2, 100, 200);
    put("nvidia", "z-ai/glm-5.3-flash", "image", 50, 1, 1); // another kind: must not leak into the chat model
    const m = await makeSession(env, "example-user", "github");
    const j = await (await app.fetch(new Request("https://app.test/api/models", { headers: { cookie: m.cookie.split(";")[0]!, "x-vc-space": "open" } }), env)).json() as any;
    const by = (id: string) => j.models.find((x: any) => x.id === `nvidia:${id}`).speed;
    expect(by("nvidia/nemotron-3-ultra-550b-a55b")).toEqual({ tier: "fast", samples: 12, firstAnswerMs: 900, totalMs: 4000, tokensPerS: 33.3 });
    expect(by("minimaxai/minimax-m3.1-flash")).toMatchObject({ tier: "slow", firstAnswerMs: 45_000 });
    expect(by("nvidia/nemotron-3.5-bolt-e4b")).toEqual({ tier: "unknown", samples: 2, firstAnswerMs: null, totalMs: null, tokensPerS: null });
    expect(by("z-ai/glm-5.3-flash").tier).toBe("unknown");
  });
});
