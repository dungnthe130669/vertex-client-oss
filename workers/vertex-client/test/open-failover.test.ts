// Open-space automatic failover (src/failover.ts + the engine's callModel): every trigger class, the non-triggers, partial text, capability filtering, the 2-switch cap,
// no loop, the breaker, Business unchanged, the AI Studio last-resort rule, and the accounting. Fake providers only.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { ProviderError, ProviderNetworkError, type ModelProvider } from "../src/providers/types";
import { defaultModelId } from "../src/models-api";
import { FAILOVER_AI_STUDIO, Breaker, BREAKER, buildCandidates, classifyFailure, parseRetryAfter, pickNext, type FoCandidate, type FailoverHook } from "../src/failover";
import { healthOf, resetHealthCache, HEALTH } from "../src/provider-health";
import { loadOpenFailover, loadOpenFailoverAistudio } from "../src/index-d1";
import { readFileSync } from "node:fs";
import { peekFirstContent } from "../src/failover";
import { openaiCompatProvider, toChatRequest } from "../src/providers/openai-compat";
import { builtinPresetConfigs } from "../src/providers/config";

// the AI Studio rules below are exercised with the v1 constant flipped ON; the R6 block asserts the shipped default (OFF)
FAILOVER_AI_STUDIO.enabled = true;
const A = "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b", B = "nvidia:nvidia/nemotron-3-ultra-550b-a55b", C = "nvidia:minimaxai/minimax-m3.1-flash", G = "groq:openai/gpt-oss-120b", S = "aistudio:gemini-3.1-flash-lite";
const sse = (evs: ServerEvent[]) => { const enc = new TextEncoder(); let i = 0; return new Response(new ReadableStream({ pull(c) { if (i < evs.length) c.enqueue(enc.encode(`event: ${evs[i].type}\ndata: ${JSON.stringify(evs[i++])}\n\n`)); else c.close(); } }), { status: 200 }); };
const start: ServerEvent = { type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } };
const textEvs = (words: string[]): ServerEvent[] => [start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, ...words.map((w) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } })), { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }, { type: "message_stop" }];
const ok = () => sse(textEvs(["hello ", "there"]));
const cand = (id: string, o: Partial<FoCandidate> = {}): FoCandidate => ({ id, tools: true, vision: true, maxPrompt: null, ...o });
const ALL = [A, B, C, G].map((id) => cand(id));

function rig(handler: (model: string, n: number, body?: any) => Response | Promise<Response>, o: { cands?: FoCandidate[]; open?: boolean; on?: boolean; hook?: boolean; breaker?: Breaker; firstByteMs?: number; enabled?: () => boolean | Promise<boolean>; refresh?: () => Promise<void>; tools?: any } = {}) {
  const db = new Database(":memory:"), calls: string[] = [], bodies: any[] = [], signals: AbortSignal[] = [], sleeps: number[] = [], br = o.breaker ?? new Breaker();
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (body: any, sig?: AbortSignal) => { if (body.stream !== false && sig) signals.push(sig); if (body.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }); calls.push(body.model); bodies.push(body); return handler(body.model, calls.length, body); } };
  const idx = { usage: [] as any[] };
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async (u) => { idx.usage.push(u); } };
  const hook: FailoverHook = { enabled: o.enabled ?? (() => o.on ?? true), refresh: o.refresh, candidates: async () => o.cands ?? ALL, breaker: () => br, firstByteMs: () => o.firstByteMs ?? 30 };
  const events: ServerEvent[] = [];
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: 1, sleep: async (ms) => { sleeps.push(ms); },
    ...(o.tools ? { tools: o.tools, metaScope: () => OPEN_SCOPE } : {}), ...(o.hook === false ? {} : { failover: hook }), ...(o.open === false ? {} : { openSpace: () => true }),
  });
  engine.setConvId("c1");
  const assistant = () => engine.messages().filter((m: any) => m.role === "assistant") as any[];
  return { engine, calls, bodies, events, idx, br, assistant, signals, sleeps };
}
const err = (status: number, extra: object = {}) => new ProviderError("x", status, { type: "api_error", ...extra });
const fail = (f: () => Promise<Response> | Response) => (m: string) => (m === A ? f() : ok());

describe("trigger classes switch transparently to the next model", () => {
  const cases: Array<[string, (m: string) => Response | Promise<Response>]> = [
    ["connection error", fail(() => { throw new ProviderNetworkError(); })],
    ["timeout waiting for the first byte", fail(() => new Promise<Response>(() => {}))],
    ["HTTP 5xx", fail(() => new Response("{}", { status: 503 }))],
    ["404 model gone", fail(() => { throw err(404); })],
    ["410 model gone", fail(() => { throw err(410); })],
    ["429 with a long retry-after", fail(() => { throw err(429, { type: "rate_limit_error", retryAfterS: 30 }); })],
    ["413 too large", fail(() => { throw err(413, { type: "invalid_request_error", retryable: false }); })],
    ["200 with an empty body", fail(() => sse([start, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" }]))],
    ["200 that never sends content", fail(() => { const enc = new TextEncoder(); return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify(start)}\n\n`)); } }), { status: 200 }); })],
    ["transient error event before content", fail(() => sse([start, { type: "error", error: { type: "overloaded_error", message: "busy" } }]))],
  ];
  for (const [name, h] of cases) test(name, async () => {
    const r = rig((m) => h(m));
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, B]);
    const a = r.assistant();
    expect(a.length).toBe(1); expect(a[0].model).toBe(B); expect(a[0].status).toBe("complete");
    expect(a[0].route.by).toBe("open-failover"); expect(a[0].route.reason).toContain("Switched to nvidia/nemotron-3-ultra-550b-a55b");
    expect(a[0].retries).toBeGreaterThanOrEqual(1);
    expect(r.events.some((e) => e.type === "failover" && e.from === A && e.to === B)).toBe(true);
    const base = rig(() => ok()); await base.engine.send("hi", A);
    expect(r.idx.usage.filter((u) => u.model !== A).length).toBe(base.idx.usage.length); // the successful attempt is recorded exactly once
    expect(r.idx.usage.filter((u) => u.model === A).every((u) => /failed attempt/.test(u.routed?.reason ?? ""))).toBe(true); // a failed attempt only ever appears as a flagged row (MED7)
  });
  test("404 says the model is gone and to pick another", async () => {
    const r = rig(fail(() => { throw err(404); }));
    await r.engine.send("hi", A);
    expect(r.assistant()[0].route.reason).toContain("no longer available");
  });
  test("the next turn is the user's own selection again (only this turn switched)", async () => {
    const r = rig(fail(() => { throw err(503); }));
    await r.engine.send("hi", A); await r.engine.send("again", A);
    expect(r.calls.filter((m) => m === A).length).toBe(2);
  });
});

describe("non-triggers", () => {
  for (const s of [400, 401, 403]) test(`${s} is surfaced, never switched`, async () => {
    const r = rig(() => { throw err(s, { type: "invalid_request_error", retryable: false }); });
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A]);
    expect(r.engine.state().error?.status).toBe(s);
  });
  test("a 429 with a short retry-after that the adapter has not retried yet is not a trigger", () => {
    expect(classifyFailure({ status: 429, retryAfterS: 2 })).toBeNull(); expect(classifyFailure({ status: 429 })).toBeNull(); // absent hint: one short retry first
    expect(classifyFailure({ status: 429, retryAfterS: 2, retriesUsed: true })).toBe("rate");
    expect(classifyFailure({ status: 429, retryAfterS: 30 })).toBe("rate");
    expect(classifyFailure({ status: 400 })).toBeNull(); expect(classifyFailure({ status: 401 })).toBeNull(); expect(classifyFailure({ status: 403 })).toBeNull();
  });
  test("user cancel mid-wait is not a failure and does not switch", async () => {
    const r = rig(fail(() => new Promise<Response>(() => {})), { firstByteMs: 5_000 });
    const p = r.engine.send("hi", A);
    await Bun.sleep(20); await r.engine.stop(); await p;
    expect(r.calls).toEqual([A]);
  });
  test("after partial text a failing stream is NOT spliced: the error offers continueWith the next model", async () => {
    const r = rig(fail(() => sse([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial " } }, { type: "error", error: { type: "overloaded_error", message: "dropped" } }])));
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A]);
    const e = r.engine.state().error as any;
    expect(e.continueWith).toBe(B);
    expect(r.assistant()[0].status).toBe("error"); // the partial answer stays
  });
});

describe("limits", () => {
  test("at most 2 switches per turn, and a model is never picked twice", async () => {
    const r = rig(() => { throw err(503); });
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, B, C]); // G was eligible but the cap is 2 switches; after a switch no same-model retry (nothing is called twice)
    expect(r.engine.state().error?.status).toBe(503);
  });
  test("no loop back to a tried model when nothing else is left", async () => {
    const r = rig(() => { throw err(503); }, { cands: [cand(A), cand(B)] });
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, B]); // B is not retried and A is never revisited
  });
  test("toggle off: the old retry path, no switch", async () => {
    const r = rig(() => { throw err(503); }, { on: false });
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, A]);
  });
  test("Business (no Open space / no hook) is unchanged: same-model retry, no switch", async () => {
    for (const o of [{ open: false }, { hook: false }]) {
      const r = rig((m, n) => (n === 1 ? new Response("{}", { status: 503 }) : ok()), o);
      await r.engine.send("hi", "claude-sonnet-5-5");
      expect(r.calls).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
      expect(r.assistant()[0].route ?? null).toBeNull();
    }
  });
});

describe("next-model selection", () => {
  const need = { tools: false, vision: false, promptTokens: 1000 };
  const now = 1_000_000;
  test("ordered preference, skips tried", () => { expect(pickNext(ALL, [A], need, null, now)?.id).toBe(B); expect(pickNext(ALL, [A, B], need, null, now)?.id).toBe(C); });
  test("capability: tools / vision", () => {
    const cs = [cand(B, { tools: false }), cand(C, { vision: false }), cand(G)];
    expect(pickNext(cs, [A], { ...need, tools: true }, null, now)?.id).toBe(C);
    expect(pickNext(cs, [A], { ...need, vision: true }, null, now)?.id).toBe(B);
    expect(pickNext(cs, [A], { tools: true, vision: true, promptTokens: 1 }, null, now)?.id).toBe(G);
  });
  test("prompt must fit (context window / Groq short-context budget); limited models never", () => {
    const cs = [cand(B, { maxPrompt: 500 }), cand(C, { limited: true }), cand(G, { maxPrompt: 4000 })];
    expect(pickNext(cs, [A], need, null, now)?.id).toBe(G);
    expect(pickNext(cs, [A], { ...need, promptTokens: 9000 }, null, now)).toBeNull();
  });
  test("a model that is not listed (no key / disabled) is never picked", () => { expect(pickNext([cand(G)], [A], need, null, now)?.id).toBe(G); expect(pickNext([], [A], need, null, now)).toBeNull(); });
  test("AI Studio is the last resort and only with the user's own key", () => {
    const only = (own: boolean) => [cand(S, { ownKeyOnly: true, ownKey: own, notice: "Google may read this." })];
    expect(pickNext(only(false), [A], need, null, now)).toBeNull();
    expect(pickNext([...ALL, ...only(true)], [A], need, null, now)?.id).toBe(B); // never before the others
    expect(pickNext([...ALL, ...only(true)], [A, B, C, G], need, null, now)?.id).toBe(S);
  });
  test("engine: AI Studio switch carries the data-use notice", async () => {
    const r = rig(fail(() => { throw err(503); }), { cands: [cand(A), cand(S, { ownKeyOnly: true, ownKey: true, notice: "Google may read this." })] });
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, S]); expect(r.assistant()[0].route.reason).toContain("Google may read this.");
  });
});

describe("circuit breaker", () => {
  test("3 failures in 5 min open it for 10 min, then half-open, a success resets", () => {
    const b = new Breaker(); const t = 1_000_000;
    b.fail(A, t); b.fail(A, t + 1000); expect(b.unhealthy(A, t + 2000)).toBe(false);
    b.fail(A, t + 2000); expect(b.unhealthy(A, t + 3000)).toBe(true);
    expect(b.unhealthy(A, t + 2000 + BREAKER.openMs - 1)).toBe(true);
    const half = t + 2000 + BREAKER.openMs; expect(b.unhealthy(A, half)).toBe(false);
    b.fail(A, half); expect(b.unhealthy(A, half + 1)).toBe(true); // the probe failed: re-opened at once
    b.ok(A); expect(b.unhealthy(A, half + 2)).toBe(false);
  });
  test("failures older than the window do not count", () => {
    const b = new Breaker(); b.fail(A, 0); b.fail(A, 1); b.fail(A, BREAKER.windowMs + 10); expect(b.unhealthy(A, BREAKER.windowMs + 11)).toBe(false);
  });
  test("bounded", () => { const b = new Breaker({ ...BREAKER, maxKeys: 3 }); for (let i = 0; i < 10; i++) b.fail(`m${i}`, 0); expect((b as any).m.size).toBe(3); });
  test("an unhealthy model is skipped in selection", () => {
    const b = new Breaker(); for (let i = 0; i < 3; i++) b.fail(B, 5); expect(pickNext(ALL, [A], { tools: false, vision: false, promptTokens: 1 }, b, 6)?.id).toBe(C);
  });
  test("engine: failures feed the breaker, a success resets it", async () => {
    const br = new Breaker();
    const r = rig(fail(() => { throw err(503); }), { breaker: br });
    for (let i = 0; i < 3; i++) await r.engine.send(`q${i}`, A);
    expect(br.unhealthy(A, Date.now())).toBe(true);
    const r2 = rig(() => ok(), { breaker: br }); br.fail(B, Date.now());
    await r2.engine.send("fine", B); expect(br.unhealthy(B, Date.now())).toBe(false);
  });
});

describe("default pick", () => {
  const ms = [A, B, G].map((id) => ({ id, limited: false }));
  test("an unhealthy model is skipped by the default pick; all unhealthy falls back to the plain rule", () => {
    expect(defaultModelId(ms)).toBe(A);
    expect(defaultModelId(ms, (id) => id === A)).toBe(B);
    expect(defaultModelId(ms, () => true)).toBe(A);
  });
});

// ---- fix round 1 ----
const resp429 = (headers: Record<string, string> = {}) => new Response("{}", { status: 429, headers });
// minimal in-memory D1 over bun:sqlite (prepare/bind/run/all/first/batch)
function fakeD1(fail?: () => boolean) {
  const db = new Database(":memory:"); db.run(readFileSync(new URL("../migrations/0033_provider_health.sql", import.meta.url), "utf8")); db.run("CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT)");
  const log: string[] = [];
  const stmt = (q: string, v: unknown[] = []) => ({ bind: (...b: unknown[]) => stmt(q, b), run: async () => { if (fail?.()) throw new Error("D1 down"); log.push(q); const r = db.query(q).run(...(v as any)); return { meta: { changes: r.changes } }; }, all: async () => { if (fail?.()) throw new Error("D1 down"); log.push(q); return { results: db.query(q).all(...(v as any)) }; }, first: async () => { if (fail?.()) throw new Error("D1 down"); return db.query(q).get(...(v as any)); } });
  return { db, log, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const x of ss) await x.run(); return []; } } as unknown as D1Database };
}

describe("HIGH1: AI Studio is never an automatic target without its own opt-in", () => {
  const models = [A, S].map((id) => ({ id, displayName: id, capabilities: { text: true, vision: true, tools: true, "image-gen": false, "video-gen": false, reasoning: false } })) as any;
  test("not a candidate at all when the opt-in is off; a candidate (own key) when on", () => {
    expect(buildCandidates(models, new Map() as any, () => true, () => "n", { aistudioAllowed: false }).map((c) => c.id)).toEqual([A]);
    expect(buildCandidates(models, new Map() as any, () => true, () => "n", { aistudioAllowed: true }).map((c) => c.id)).toEqual([A, S]);
  });
  test("the opt-in defaults OFF, and a read error is OFF", async () => {
    const f = fakeD1();
    expect(await loadOpenFailoverAistudio(f.d1, "main~open")).toBe(false);
    f.db.run("INSERT INTO settings VALUES ('open_failover_aistudio:main~open','1')");
    expect(await loadOpenFailoverAistudio(f.d1, "main~open")).toBe(true);
    expect(await loadOpenFailoverAistudio(fakeD1(() => true).d1, "x")).toBe(false);
  });
});

describe("HIGH2: failover fails closed", () => {
  test("D1 read error = off; stored 0 wins; no row = on", async () => {
    expect(await loadOpenFailover(fakeD1(() => true).d1, "s")).toBe(false);
    const f = fakeD1();
    expect(await loadOpenFailover(f.d1, "s")).toBe(true);
    f.db.run("INSERT INTO settings VALUES ('open_failover:s','0')");
    expect(await loadOpenFailover(f.d1, "s")).toBe(false);
  });
  test("engine: a throwing toggle lookup = old behaviour (same-model retry, then error)", async () => {
    const r = rig(() => { throw err(503); }, { enabled: () => { throw new Error("d1"); } });
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, A]);
  });
});

describe("HIGH3: stop aborts the attempt on every exit path", () => {
  test("stop landing while the hooks are read: nothing is sent, or whatever was is aborted", async () => {
    let eng: ChatEngine | null = null;
    const r = rig(() => ok(), { enabled: () => { void eng!.stop(); return true; } });
    eng = r.engine;
    await r.engine.send("hi", A);
    expect(r.signals.every((x) => x.aborted)).toBe(true);
    expect(r.calls.length).toBe(0);
  });
  test("stop while waiting for the first byte aborts that request", async () => {
    const r = rig(fail(() => new Promise<Response>(() => {})), { firstByteMs: 5_000 });
    const p = r.engine.send("hi", A); await Bun.sleep(20); await r.engine.stop(); await p;
    expect(r.signals.length).toBe(1); expect(r.signals[0].aborted).toBe(true);
  });
  test("a failed / timed-out attempt's request is aborted too", async () => {
    const r = rig(fail(() => new Promise<Response>(() => {})));
    await r.engine.send("hi", A);
    expect(r.signals[0].aborted).toBe(true); expect(r.signals[1].aborted).toBe(false); // the answering attempt stays open
  });
});

describe("HIGH4: only typed provider/network errors trigger failover", () => {
  test("an unknown exception (bug / key problem) surfaces with no switch and no retry", async () => {
    const r = rig(fail(() => { throw new Error("adapter exploded"); }));
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A]); expect(r.engine.state().error?.message).toContain("adapter exploded");
  });
  test("a bare TypeError / ECONNRESET-looking error from our own code is NOT a trigger (only the adapter's ProviderNetworkError is)", async () => {
    for (const e of [new TypeError("x is not a function"), new TypeError("fetch failed"), Object.assign(new Error("reset"), { code: "ECONNRESET" })]) {
      const r = rig(fail(() => { throw e; }));
      await r.engine.send("hi", A);
      expect(r.calls).toEqual([A]);
    }
  });
  test("a ProviderNetworkError (adapter's rejected fetch) switches", async () => {
    const r = rig(fail(() => { throw new ProviderNetworkError(); }));
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, B]);
  });
  test("the real adapters wrap a rejected fetch (and only that) as ProviderNetworkError", async () => {
    const cfg: any = { ...builtinPresetConfigs("main").find((c) => c.id === "groq")!, resolveKey: async () => ({ kind: "key", key: "k" }) };
    const rejecting = openaiCompatProvider(cfg, {}, (() => Promise.reject(new TypeError("fetch failed"))) as any);
    await expect(rejecting.messages({ model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "x" }], stream: true })).rejects.toBeInstanceOf(ProviderNetworkError);
    // a bug on our side (here: an unserialisable body) is not dressed up as a network failure
    const circular: any = { model: "openai/gpt-oss-20b", stream: true, messages: [] }; circular.self = circular; circular.messages.push({ role: "user", content: circular });
    const bug = await openaiCompatProvider(cfg, {}, (() => Promise.reject(new Error("never"))) as any).messages(circular).catch((e) => e);
    expect(bug instanceof ProviderNetworkError).toBe(false);
  });
});

describe("MED5: the breaker is shared through D1 (migration 0033)", () => {
  const now = 5_000_000; const waits: Promise<unknown>[] = [];
  const mk = (f = fakeD1(), t = () => now) => ({ f, h: healthOf(f.d1, (p) => waits.push(p), "s1", t) });
  test("3 failures open it; another isolate (fresh cache) sees it after refresh; ok deletes the row", async () => {
    resetHealthCache(); const { f, h } = mk();
    for (let i = 0; i < 3; i++) h.fail(A, now + i); await Promise.all(waits);
    const row = f.db.query("SELECT * FROM provider_health").all() as any[];
    expect(row.length).toBe(1); expect(row[0].fails).toBe(3); expect(row[0].open_until).toBe(now + 2 + BREAKER.openMs);
    resetHealthCache(); const other = healthOf(f.d1, (p) => waits.push(p), "s1", () => now + 10);
    expect(other.unhealthy(A, now + 10)).toBe(false); await other.refresh();
    expect(other.unhealthy(A, now + 10)).toBe(true); expect(other.unhealthy(B, now + 10)).toBe(false);
    other.ok(A); await Promise.all(waits);
    expect((f.db.query("SELECT * FROM provider_health").all() as any[]).length).toBe(0);
  });
  test("scopes are separate; the window restarts the count; a failed half-open probe re-opens", async () => {
    resetHealthCache(); const f = fakeD1();
    const a = healthOf(f.d1, (p) => waits.push(p), "s1", () => now), b = healthOf(f.d1, (p) => waits.push(p), "s2", () => now);
    for (let i = 0; i < 3; i++) a.fail(A, now + i); await Promise.all(waits);
    resetHealthCache(); await b.refresh(); expect(b.unhealthy(A, now + 5)).toBe(false);
    f.db.run("DELETE FROM provider_health");
    const h = healthOf(f.d1, (p) => waits.push(p), "s1", () => now);
    h.fail(A, now); h.fail(A, now + BREAKER.windowMs + 1); await Promise.all(waits);
    expect((f.db.query("SELECT fails FROM provider_health").get() as any).fails).toBe(1);
    for (let i = 0; i < 2; i++) h.fail(A, now + BREAKER.windowMs + 2 + i); await Promise.all(waits);
    const t0 = now + BREAKER.windowMs + 3, reopen = t0 + BREAKER.openMs + 1;
    h.fail(A, reopen); await Promise.all(waits);
    expect((f.db.query("SELECT open_until FROM provider_health").get() as any).open_until).toBe(reopen + BREAKER.openMs);
  });
  test("bounded rows and TTL pruned on write; reads cached; every D1 error swallowed", async () => {
    resetHealthCache(); const f = fakeD1(); const t = { v: now };
    const h = healthOf(f.d1, (p) => waits.push(p), "s1", () => t.v);
    for (let i = 0; i < HEALTH.maxRows + 30; i++) { t.v = now + i; h.fail(`p:m${i}`, t.v); await Promise.all(waits); }
    expect((f.db.query("SELECT count(*) c FROM provider_health").get() as any).c).toBeLessThanOrEqual(HEALTH.maxRows);
    t.v = now + HEALTH.ttlMs + 1000; h.fail("p:fresh", t.v); await Promise.all(waits);
    expect((f.db.query("SELECT count(*) c FROM provider_health").get() as any).c).toBe(1);
    resetHealthCache(); f.log.length = 0; await h.refresh(); await h.refresh();
    expect(f.log.filter((q) => /SELECT/.test(q)).length).toBe(1); // cached ~10 s
    let down = true; const bad = fakeD1(() => down); resetHealthCache();
    const hb = healthOf(bad.d1, (p) => waits.push(p), "s1", () => now);
    hb.fail(A, now); hb.ok(A); await hb.refresh(); await Promise.all(waits); down = false; // nothing threw
    expect(hb.unhealthy(A, now)).toBe(false);
  });
});

describe("MED6: the per-user broken list filters candidates", () => {
  test("a broken model is not a candidate", () => {
    const ms = [A, B, G].map((id) => ({ id, displayName: id, capabilities: { text: true, vision: false, tools: true } })) as any;
    expect(buildCandidates(ms, new Map() as any, () => false, () => undefined, { aistudioAllowed: false, broken: { nvidia: ["nvidia/nemotron-3-ultra-550b-a55b"] } }).map((c) => c.id)).toEqual([A, G]);
  });
});

describe("MED7: tokens a failed attempt reported are recorded once, flagged", () => {
  test("message_start usage then an empty stream", async () => {
    const r = rig(fail(() => sse([{ type: "message_start", message: { id: "m", usage: { input_tokens: 77, output_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" }])));
    await r.engine.send("hi", A);
    const failed = r.idx.usage.filter((u) => u.model === A);
    expect(failed.length).toBe(1); expect(failed[0].usage.input_tokens).toBe(77); expect(failed[0].routed.reason).toContain("failed attempt");
    expect(r.idx.usage.filter((u) => u.model === B).every((u) => u.usage.input_tokens !== 77)).toBe(true);
  });
  test("the failed attempt's tokens are also in the turn totals (once)", async () => {
    const r = rig(fail(() => sse([{ type: "message_start", message: { id: "m", usage: { input_tokens: 77, output_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" }])));
    await r.engine.send("hi", A);
    const base = rig(() => ok()); await base.engine.send("hi", A);
    expect(r.engine.totals().tokens).toBe(base.engine.totals().tokens + r.idx.usage.filter((u) => u.model === A).reduce((n, u) => n + (u.usage.input_tokens ?? 0) + (u.usage.output_tokens ?? 0), 0)); // = the idx row, which is 77 tokens
  });
  test("a failure that reported nothing records nothing", async () => {
    const r = rig(fail(() => { throw err(503); })); await r.engine.send("hi", A);
    expect(r.idx.usage.some((u) => u.model === A)).toBe(false);
  });
});

describe("MED8: Continue with X keeps the turn's tried set", () => {
  test("A failed, B streamed then died: continue goes to C; when C fails the next pick is G, never A or B", async () => {
    const partial = () => sse([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "part " } }, { type: "error", error: { type: "overloaded_error", message: "x" } }]);
    let phase = 1;
    const r = rig((m) => { if (phase === 1) return m === A ? new Response("{}", { status: 503 }) : partial(); return m === C ? new Response("{}", { status: 503 }) : ok(); });
    await r.engine.send("hi", A);
    const e = r.engine.state().error as any; expect(e.continueWith).toBe(C);
    expect(JSON.parse(r.engine.meta("fo_continue")!).tried).toEqual([A, B]);
    expect(r.assistant()[0].route.tried).toEqual([A, B]);
    phase = 2; r.calls.length = 0;
    const sr = await r.engine.send("hi", undefined, [], undefined, { model: C } as any); expect(sr).toEqual({ ok: true });
    expect(r.calls).toEqual([C, G]);
  });
});

describe("MED9: Retry-After parsing and the short retry", () => {
  test("seconds, HTTP-date, absent, garbage", () => {
    const t = Date.parse("2026-10-26T12:00:00Z");
    expect(parseRetryAfter("30", t)).toBe(30); expect(parseRetryAfter("Mon, 26 Oct 2026 12:01:00 GMT", t)).toBe(60);
    expect(parseRetryAfter("Mon, 26 Oct 2026 11:00:00 GMT", t)).toBeUndefined(); expect(parseRetryAfter(null, t)).toBeUndefined(); expect(parseRetryAfter("soon", t)).toBeUndefined();
  });
  test("absent: ONE 2 s same-model retry, then switch", async () => {
    const r = rig((m) => (m === A ? resp429() : ok()));
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, A, B]); expect(r.sleeps).toContain(2000);
  });
  test("> 5 s (seconds or HTTP-date): switch at once; <= 5 s: short retry first", async () => {
    for (const h of ["30", new Date(Date.now() + 60_000).toUTCString()]) { const r = rig((m) => (m === A ? resp429({ "retry-after": h }) : ok())); await r.engine.send("hi", A); expect(r.calls).toEqual([A, B]); }
    const r = rig((m) => (m === A ? resp429({ "retry-after": "3" }) : ok())); await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, A, B]); expect(r.sleeps).toContain(2000);
  });
});

// ---- fix round 2 ----
describe("R2: user stop during the first-content wait is not a failure", () => {
  test("the upstream stream errors on abort: no switch, no breaker write, no fallback usage", async () => {
    const r = rig(fail(() => { const sig = r.signals[r.signals.length - 1]; return new Response(new ReadableStream({ start(c) { sig.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))); } }), { status: 200 }); }), { firstByteMs: 5_000 });
    const p = r.engine.send("hi", A); await Bun.sleep(20); await r.engine.stop(); await p;
    expect(r.calls).toEqual([A]);
    expect(r.br.unhealthy(A, Date.now())).toBe(false); expect((r.br as any).m.size).toBe(0);
    expect(r.events.some((e) => e.type === "failover")).toBe(false);
    expect(r.idx.usage.some((u) => /failed attempt/.test(u.routed?.reason ?? ""))).toBe(false);
  });
});

describe("R2: a final failed attempt that reported tokens is accounted even with no other model", () => {
  test("no candidate left: both attempts' reported tokens are recorded, flagged, and the error surfaces", async () => {
    const empty = () => sse([{ type: "message_start", message: { id: "m", usage: { input_tokens: 55, output_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" }]);
    const r = rig(() => empty(), { cands: [cand(A)] });
    await r.engine.send("hi", A);
    const rows = r.idx.usage.filter((u) => u.model === A && /failed attempt/.test(u.routed?.reason ?? ""));
    expect(r.calls).toEqual([A, A]); expect(rows.length).toBe(2); expect(rows.every((u) => u.usage.input_tokens === 55)).toBe(true);
    expect(r.engine.state().error).toBeTruthy();
  });
});

describe("R2/R3: global expiry of dormant scopes", () => {
  const seed = (f: ReturnType<typeof fakeD1>, n: number, old: number) => { for (let i = 0; i < n; i++) f.db.run(`INSERT INTO provider_health VALUES ('dormant${i}','p','m',1,${old},0,${old})`); };
  const left = (f: ReturnType<typeof fakeD1>) => (f.db.query("SELECT count(*) c FROM provider_health WHERE scope LIKE 'dormant%'").get() as any).c;
  test("batches until the 500-row cap, hard TTL 24 h, at most once per interval", async () => {
    resetHealthCache(); const f = fakeD1(); const now = 90_000_000, waits: Promise<unknown>[] = [];
    seed(f, 650, now - HEALTH.globalTtlMs - 1);
    f.db.run(`INSERT INTO provider_health VALUES ('young','p','m',1,${now},0,${now - HEALTH.globalTtlMs + 60_000})`); // inside the TTL: kept
    const h = healthOf(f.d1, (p) => waits.push(p), "live", () => now);
    h.fail("p:m", now); await Promise.all(waits);
    expect(left(f)).toBe(650 - HEALTH.sweepCap); // 10 batches of 50 = the cap
    expect((f.db.query("SELECT count(*) c FROM provider_health WHERE scope='young'").get() as any).c).toBe(1);
    h.fail("p:m2", now + 1000); await Promise.all(waits);
    expect(left(f)).toBe(650 - HEALTH.sweepCap); // not again within the interval
    h.fail("p:m3", now + HEALTH.sweepEveryMs + 1); await Promise.all(waits);
    expect(left(f)).toBe(0);
  });
  test("the time budget stops the loop after at least one batch", async () => {
    resetHealthCache(); const f = fakeD1(); const now = 90_000_000, waits: Promise<unknown>[] = [], was = HEALTH.sweepBudgetMs;
    seed(f, 300, now - HEALTH.globalTtlMs - 1); HEALTH.sweepBudgetMs = 0;
    try { healthOf(f.d1, (p) => waits.push(p), "live", () => now).fail("p:m", now); await Promise.all(waits); } finally { HEALTH.sweepBudgetMs = was; }
    expect(left(f)).toBe(300 - HEALTH.sweepBatch);
  });
  test("0033 has an updated_at-leading index", () => {
    expect(readFileSync(new URL("../migrations/0033_provider_health.sql", import.meta.url), "utf8")).toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON provider_health \(updated_at\)/);
  });
});

describe("R2: half-open probe is a compare-and-set lease", () => {
  test("two isolates race: exactly one probes, the other keeps the model unhealthy", async () => {
    resetHealthCache(); const f = fakeD1(); const t0 = 200_000_000, waits: Promise<unknown>[] = [];
    const opened = t0 - BREAKER.openMs - 1;
    f.db.run(`INSERT INTO provider_health VALUES ('s','nvidia','x',3,${opened - 100},${t0 - 1},${opened})`); // open window ended 1 ms ago
    const c1: any = new Map(), c2: any = new Map();
    const a = healthOf(f.d1, (p) => waits.push(p), "s", () => t0, c1), b = healthOf(f.d1, (p) => waits.push(p), "s", () => t0, c2);
    await Promise.all([a.refresh(), b.refresh()]);
    const key = "nvidia:x", ua = a.unhealthy(key, t0), ub = b.unhealthy(key, t0);
    expect([ua, ub].filter((x) => x === false).length).toBe(1); // one winner
    expect((f.db.query("SELECT open_until FROM provider_health").get() as any).open_until).toBe(t0 + HEALTH.probeMs);
    // the winner's probe fails: re-opened for the full window at once; success instead would delete the row
    (ua ? b : a).fail(key, t0 + 5); await Promise.all(waits);
    expect((f.db.query("SELECT open_until FROM provider_health").get() as any).open_until).toBe(t0 + 5 + BREAKER.openMs);
  });
  test("an unleased half-open model is not selectable before the claim", async () => {
    resetHealthCache(); const f = fakeD1(); const t0 = 300_000_000;
    f.db.run(`INSERT INTO provider_health VALUES ('s','nvidia','x',3,${t0 - BREAKER.openMs - 50},${t0 - 1},${t0 - BREAKER.openMs})`);
    const a = healthOf(f.d1, () => {}, "s", () => t0, new Map() as any);
    await a.refresh(); expect(a.unhealthy("nvidia:x", t0)).toBe(false); // won the lease
  });
});

describe("R2: a stored continue is re-validated at use and lives one user turn", () => {
  const partial = () => sse([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "part " } }, { type: "error", error: { type: "overloaded_error", message: "x" } }]);
  async function afterPartial(o: Parameters<typeof rig>[1] = {}) {
    const state = { cands: ALL, on: true };
    const r = rig((m) => (m === A ? partial() : ok()), { ...o, cands: undefined, enabled: () => state.on });
    (r as any).state = state;
    // candidates come from `state` so a test can change the world between the failure and the click
    (r.engine as any).failover.candidates = async () => state.cands;
    await r.engine.send("hi", A);
    expect((r.engine.state().error as any).continueWith).toBe(B);
    return { r, state };
  }
  test("valid: runs; the stored value is consumed", async () => {
    const { r } = await afterPartial(); r.calls.length = 0;
    expect(await r.engine.send("hi", undefined, [], undefined, { model: B } as any)).toEqual({ ok: true });
    expect(r.calls[0]).toBe(B); expect(r.engine.meta("fo_continue")).toBeNull();
  });
  test("the model left the candidate list / is unhealthy / failover is now OFF: refused and cleared", async () => {
    for (const mutate of [(s: any, r: any) => { s.cands = ALL.filter((c) => c.id !== B); }, (s: any, r: any) => { for (let i = 0; i < 3; i++) r.br.fail(B, Date.now()); }, (s: any) => { s.on = false; }]) {
      const { r, state } = await afterPartial(); r.calls.length = 0; mutate(state, r);
      const res = await r.engine.send("hi", undefined, [], undefined, { model: B } as any);
      expect(res.ok).toBe(false); expect(r.engine.meta("fo_continue")).toBeNull(); expect(r.calls.length).toBe(0);
    }
  });
  test("one user turn: an ordinary message clears it, so a later override of that model is refused", async () => {
    const { r } = await afterPartial();
    await r.engine.send("something else", C);
    expect(r.engine.meta("fo_continue")).toBeNull();
    expect((await r.engine.send("again", undefined, [], undefined, { model: B } as any)).ok).toBe(false);
  });
});

// ---- fix round 3 ----
describe("R3 HIGH: the privacy text, provider naming, AI Studio gating", () => {
  test("every automatic switch notice names the new provider", async () => {
    const r = rig(fail(() => { throw err(503); }));
    await r.engine.send("hi", A);
    expect(r.assistant()[0].route.reason).toContain("(NVIDIA NIM)");
    const g = rig((m) => (m === B ? ok() : (() => { throw err(503); })()), { cands: [cand(B), cand(G)].reverse() });
    await g.engine.send("hi", G);
    expect(g.assistant()[0].route.reason).toContain("NVIDIA NIM");
  });
  test("the setting copy and the Open banner say the chat may go to another Open provider", () => {
    const settings = readFileSync(new URL("../web/src/settings.tsx", import.meta.url), "utf8"), banner = readFileSync(new URL("../web/src/space-ui.tsx", import.meta.url), "utf8");
    expect(settings).toContain("If a model fails, this chat (including its history) may be sent to another Open provider (NVIDIA, Groq...). Each provider has its own data policy.");
    expect(settings).toContain("open-failover-notices"); // the per-provider notices of the Open banner are listed under it
    expect(settings.indexOf("FAILOVER_PRIVACY}")).toBeGreaterThan(0);
    expect(banner).toContain("may be sent to another Open provider");
  });
  test("AI Studio can never be a candidate with the opt-in OFF: not from candidates(), not via a stored continue", async () => {
    const ms = [A, S].map((id) => ({ id, displayName: id, capabilities: { text: true, vision: true, tools: true } })) as any;
    expect(buildCandidates(ms, new Map() as any, () => true, () => "n", { aistudioAllowed: false }).some((c) => c.id === S)).toBe(false);
    const r = rig(() => ok(), { cands: [cand(A), cand(B)] });
    r.engine.setMeta("fo_continue", JSON.stringify({ model: S, tried: [A], need: { tools: false, vision: false, promptTokens: 10 } }));
    expect((await r.engine.send("hi", undefined, [], undefined, { model: S } as any)).ok).toBe(false);
    expect(r.calls.length).toBe(0); expect(r.engine.meta("fo_continue")).toBeNull();
  });
});

describe("R3 MED1: our own timeout abort is authoritative", () => {
  test("fetch rejects with AbortError the instant WE abort: still a timeout, still fails over", async () => {
    const r = rig(fail(() => new Promise<Response>((_res, rej) => { const sig = r.signals[r.signals.length - 1]; sig.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); })));
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, B]); expect(r.assistant()[0].route.reason).toContain("no answer in time");
  });
});

describe("R3 MED2: body socket failures before content are connection failures", () => {
  const dead = (e: unknown) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(start)}\n\n`)); }, pull() { throw e; } }), { status: 200 });
  test("peek: ProviderNetworkError = network failure; a bare error stays unknown", async () => {
    const a = await peekFirstContent(dead(new ProviderNetworkError()), 500, () => {}); expect(a.ok).toBe(false); expect(classifyFailure((a as any).failure)).toBe("network");
    const b = await peekFirstContent(dead(new TypeError("bug")), 500, () => {}); expect((b as any).failure.unknown).toBe(true);
  });
  test("the real adapter marks an upstream body failure (network_error event) and the engine switches", async () => {
    const cfg: any = { ...builtinPresetConfigs("main").find((c) => c.id === "groq")!, resolveKey: async () => ({ kind: "key", key: "k" }) };
    const body = () => new Response(new ReadableStream({ pull() { throw new TypeError("terminated"); } }), { status: 200 });
    const res = await openaiCompatProvider(cfg, {}, (() => Promise.resolve(body())) as any).messages({ model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "x" }], stream: true });
    expect(await res.text()).toContain("network_error");
    const r = rig(fail(() => { throw new ProviderNetworkError(); })); // engine side of the same class
    await r.engine.send("hi", A); expect(r.calls).toEqual([A, B]);
    const pk = await peekFirstContent(await openaiCompatProvider(cfg, {}, (() => Promise.resolve(body())) as any).messages({ model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "x" }], stream: true }), 500, () => {});
    expect(classifyFailure((pk as any).failure)).toBe("network");
  });
});

describe("R3 MED3: a stored continue is validated with the needs of the failed turn", () => {
  const partial = () => sse([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "part " } }, { type: "error", error: { type: "overloaded_error", message: "x" } }]);
  test("the need is stored, and a target that cannot take the recorded prompt size / tools is refused", async () => {
    for (const weak of [{ maxPrompt: 5 }, { tools: false }]) {
      const state = { cands: ALL };
      const r = rig((m) => (m === A ? partial() : ok()), { enabled: () => true });
      (r.engine as any).failover.candidates = async () => state.cands;
      r.engine.setMeta("fo_continue", JSON.stringify({ model: B, tried: [A], need: { tools: "tools" in weak, vision: false, promptTokens: 1000 } }));
      state.cands = ALL.map((c) => (c.id === B ? { ...c, ...weak } : c));
      expect((await r.engine.send("hi", undefined, [], undefined, { model: B } as any)).ok).toBe(false);
    }
  });
  test("the failure records the real need (tools offered, prompt size)", async () => {
    const r = rig((m) => (m === A ? partial() : ok()));
    await r.engine.send("hi", A);
    const n = JSON.parse(r.engine.meta("fo_continue")!).need; expect(n.tools).toBe(false); expect(n.promptTokens).toBeGreaterThan(0);
  });
  test("a stored continue without a recorded need is refused", async () => {
    const r = rig(() => ok());
    r.engine.setMeta("fo_continue", JSON.stringify({ model: B, tried: [A] }));
    expect((await r.engine.send("hi", undefined, [], undefined, { model: B } as any)).ok).toBe(false);
  });
});

describe("R3 MED4: failed-attempt usage is awaited", () => {
  test("a slow recordUsage has landed by the time the turn is over", async () => {
    const r = rig(fail(() => sse([{ type: "message_start", message: { id: "m", usage: { input_tokens: 9, output_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" }])));
    const orig = (r.engine as any).index.recordUsage;
    (r.engine as any).index.recordUsage = async (u: any) => { if (/failed attempt/.test(u.routed?.reason ?? "")) await Bun.sleep(40); return orig(u); };
    await r.engine.send("hi", A);
    expect(r.idx.usage.filter((u) => /failed attempt/.test(u.routed?.reason ?? "")).length).toBe(1);
  });
});

// ---- fix round 4 ----
describe("R4 HIGH: the always-visible Open composer line", () => {
  test("it is rendered in the chat composer, and the default lives in one named place", () => {
    expect(readFileSync(new URL("../web/src/chat.tsx", import.meta.url), "utf8")).toContain("<FailoverNote />");
    expect(readFileSync(new URL("../src/index-d1.ts", import.meta.url), "utf8")).toContain("export const OPEN_FAILOVER_DEFAULT_ON = true");
  });
  test("no stored row = the default; a stored choice wins", async () => {
    const f = fakeD1();
    expect(await loadOpenFailover(f.d1, "s")).toBe(true);
    f.db.run("INSERT INTO settings VALUES ('open_failover:s','0')"); expect(await loadOpenFailover(f.d1, "s")).toBe(false);
    f.db.run("UPDATE settings SET value='1'"); expect(await loadOpenFailover(f.d1, "s")).toBe(true);
  });
});

describe("R4 MED: a stop during the awaited failed-attempt accounting ends the turn", () => {
  test("no breaker write, no switch notice, no next provider call", async () => {
    let eng: ChatEngine | null = null;
    const r = rig(fail(() => sse([{ type: "message_start", message: { id: "m", usage: { input_tokens: 9, output_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" }])));
    eng = r.engine;
    const orig = (eng as any).index.recordUsage;
    (eng as any).index.recordUsage = async (u: any) => { if (/failed attempt/.test(u.routed?.reason ?? "")) { void eng!.stop(); await Bun.sleep(10); } return orig(u); };
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A]);
    expect((r.br as any).m.size).toBe(0);
    expect(r.events.some((e) => e.type === "failover")).toBe(false);
  });
});

describe("R4 MED: a continue is validated with the prompt size of NOW", () => {
  test("a stale small recorded size does not let an oversized re-send through", async () => {
    const mk = () => { const state = { cands: ALL.map((c) => (c.id === B ? { ...c, maxPrompt: 2000 } : c)) }; const r = rig(() => ok()); (r.engine as any).failover.candidates = async () => state.cands; r.engine.setMeta("fo_continue", JSON.stringify({ model: B, tried: [A], need: { tools: false, vision: false, promptTokens: 10 } })); return r; };
    const big = mk(); // history is small, but the new message is ~30k chars (~10k tokens) > B's 2000
    expect((await big.engine.send("x".repeat(30_000), undefined, [], undefined, { model: B } as any)).ok).toBe(false);
    const small = mk();
    expect(await small.engine.send("short", undefined, [], undefined, { model: B } as any)).toEqual({ ok: true });
  });
  test("non-image attachments count by size; images count for vision", async () => {
    const mk = (vision: boolean) => { const r = rig(() => ok()); (r.engine as any).failover.candidates = async () => [cand(A), cand(B, { maxPrompt: 2000, vision })]; r.engine.setMeta("fo_continue", JSON.stringify({ model: B, tried: [A], need: { tools: false, vision: false, promptTokens: 10 } })); return r; };
    const pdf = { ref: "vertex-client/c1/a1.pdf", name: "a.pdf", mime: "application/pdf", size: 60_000 };
    const res: any = await mk(true).engine.send("hi", undefined, [pdf as any], undefined, { model: B } as any);
    expect(res.ok).toBe(false); expect(String(res.error)).toContain("not available for this chat any more");
  });
});

describe("R5 HIGH: the composer line fails visible and follows the settings", () => {
  const load = async () => { const m = await import("../web/src/failover-state"); m.resetFailoverState(); return m; };
  const got = (enabled: boolean | "fail" | "http500") => async () => { if (enabled === "fail") throw new Error("offline"); if (enabled === "http500") return { status: 500, data: null }; return { status: 200, data: { enabled } }; };
  test("first render (nothing known yet) shows the line", async () => {
    const m = await load();
    expect(m.failoverBanner(m.failoverState().failover, m.failoverState().aistudio)).toBe(m.FAILOVER_BANNER);
    expect(m.FAILOVER_BANNER).toBe("If a model fails, this chat may be sent to another Open provider (NVIDIA, Groq). Policies: Settings.");
  });
  test("a failed fetch keeps it shown and never overwrites a known value", async () => {
    const m = await load();
    await m.refreshFailover({ failover: got("fail"), aistudio: got("http500") });
    expect(m.failoverBanner(m.failoverState().failover, m.failoverState().aistudio)).toBe(m.FAILOVER_BANNER);
    await m.refreshFailover({ failover: got(true), aistudio: got(false) });
    await m.refreshFailover({ failover: got("fail"), aistudio: got("fail") });
    expect(m.failoverState()).toEqual({ failover: true, aistudio: false });
  });
  test("hidden ONLY after the server confirmed failover OFF", async () => {
    const m = await load();
    await m.refreshFailover({ failover: got(false), aistudio: got("fail") });
    expect(m.failoverBanner(m.failoverState().failover, m.failoverState().aistudio)).toBe("");
  });
  test("a Settings toggle change updates subscribers at once, without a reload", async () => {
    const m = await load(); const seen: string[] = [];
    const un = m.subscribeFailover((s) => seen.push(m.failoverBanner(s.failover, s.aistudio)));
    m.setFailoverState({ failover: false }); m.setFailoverState({ failover: true }); un(); m.setFailoverState({ failover: false });
    expect(seen).toEqual(["", m.FAILOVER_BANNER]);
  });
  test("the AI Studio sentence only when that fallback is confirmed ON (unknown / OFF = base line only)", async () => {
    const m = await load();
    expect(m.failoverBanner(true, null)).toBe(m.FAILOVER_BANNER); expect(m.failoverBanner(true, false)).toBe(m.FAILOVER_BANNER);
    expect(m.failoverBanner(true, true)).toBe(`${m.FAILOVER_BANNER} ${m.AISTUDIO_BANNER}`); expect(m.AISTUDIO_BANNER).toContain("Google AI Studio may be used (Google may use your conversation to improve its products)");
    expect(m.failoverBanner(false, true)).toBe("");
  });
  test("wiring: the note subscribes, refreshes on focus; both Settings toggles push their value", () => {
    const ui = readFileSync(new URL("../web/src/space-ui.tsx", import.meta.url), "utf8"), st = readFileSync(new URL("../web/src/settings.tsx", import.meta.url), "utf8");
    expect(ui).toContain("subscribeFailover(setSt)"); expect(ui).toContain('addEventListener("focus", load)');
    expect(st).toContain("setFailoverState({ failover: next })"); expect(st).toContain("setFailoverState({ aistudio: next })");
  });
});

// ---- fix round 6 ----
const withAiStudio = async (on: boolean, f: () => Promise<void> | void) => { const was = FAILOVER_AI_STUDIO.enabled; FAILOVER_AI_STUDIO.enabled = on; try { await f(); } finally { FAILOVER_AI_STUDIO.enabled = was; } };

describe("R6: Google AI Studio is not an automatic failover target in v1", () => {
  test("the shipped default is OFF (source) and removes it from selection, candidates and a stored continue", async () => {
    expect(readFileSync(new URL("../src/failover.ts", import.meta.url), "utf8")).toContain("export const FAILOVER_AI_STUDIO = { enabled: false };");
    await withAiStudio(false, async () => {
      const own = [cand(S, { ownKeyOnly: true, ownKey: true })];
      expect(pickNext([...ALL, ...own], [A, B, C, G], { tools: false, vision: false, promptTokens: 1 }, null, 1)).toBeNull(); // even with the key, the opt-in and nothing else left
      const ms = [A, S].map((id) => ({ id, displayName: id, capabilities: { text: true, vision: true, tools: true } })) as any;
      expect(buildCandidates(ms, new Map() as any, () => true, () => "n", { aistudioAllowed: true }).map((c) => c.id)).toEqual([A]); // opt-in ON does not matter
      const r = rig(() => ok(), { cands: [cand(A), cand(S, { ownKeyOnly: true, ownKey: true })] });
      r.engine.setMeta("fo_continue", JSON.stringify({ model: S, tried: [A], need: { tools: false, vision: false, promptTokens: 10 } }));
      expect((await r.engine.send("hi", undefined, [], undefined, { model: S } as any)).ok).toBe(false);
      const f = rig(fail(() => { throw err(503); }), { cands: [cand(A), cand(S, { ownKeyOnly: true, ownKey: true })] });
      await f.engine.send("hi", A); expect(f.calls).toEqual([A, A]); // no switch to AI Studio: the old single retry, then the error
    });
  });
  test("the opt-in setting is hidden while the constant is false (server says available:false; UI shows it only when true)", () => {
    expect(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")).toContain("available: FAILOVER_AI_STUDIO.enabled");
    expect(readFileSync(new URL("../web/src/settings.tsx", import.meta.url), "utf8")).toContain("r.data.available === true");
  });
  test("the code path still works behind the constant", async () => {
    await withAiStudio(true, async () => {
      const f = rig(fail(() => { throw err(503); }), { cands: [cand(A), cand(S, { ownKeyOnly: true, ownKey: true })] });
      await f.engine.send("hi", A); expect(f.calls).toEqual([A, S]);
    });
  });
});

describe("R6 MED: a stop during candidate selection records nothing and emits no switch", () => {
  test("stop lands while candidates() is awaited", async () => {
    let eng: ChatEngine | null = null;
    const r = rig(fail(() => { throw err(503); }));
    eng = r.engine;
    (eng as any).failover.candidates = async () => { void eng!.stop(); await Bun.sleep(10); return ALL; };
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A]); expect((r.br as any).m.size).toBe(0);
    expect(r.events.some((e) => e.type === "failover" || e.type === "route")).toBe(false);
  });
});

describe("R6 MED: the half-open lease belongs to ONE caller in an isolate", () => {
  const setup = async () => {
    resetHealthCache(); const f = fakeD1(); const t0 = 400_000_000;
    f.db.run(`INSERT INTO provider_health VALUES ('s','nvidia','x',3,${t0 - BREAKER.openMs - 50},${t0 - 1},${t0 - BREAKER.openMs})`);
    const h = healthOf(f.d1, () => {}, "s", () => t0, new Map() as any); await h.refresh();
    return { h, f, t0, key: "nvidia:x" };
  };
  test("two concurrent callers: exactly one takes the probe; the other still sees half-open-not-yours", async () => {
    const { h, t0, key } = await setup();
    expect(h.unhealthy(key, t0)).toBe(false); // lease free: selectable
    const got = [h.take!(key), h.take!(key)];
    expect(got).toEqual([true, false]);
    expect(h.unhealthy(key, t0)).toBe(true); // everyone else: not yours, until the result is written
  });
  test("the probe's result releases it: a failure re-opens, a success clears", async () => {
    const a = await setup(); a.h.take!(a.key); a.h.fail(a.key, a.t0 + 1);
    expect(a.h.unhealthy(a.key, a.t0 + 2)).toBe(true);
    const b = await setup(); b.h.take!(b.key); b.h.ok(b.key);
    expect(b.h.unhealthy(b.key, b.t0)).toBe(false); expect(b.h.take!(b.key)).toBe(true); // closed again: anyone may use it
  });
  test("engine: a pick whose lease another caller already took is skipped for the next model", async () => {
    const r = rig(fail(() => { throw err(503); }));
    const real = r.br; const taken = new Set<string>([B]);
    (r.engine as any).failover.breaker = () => ({ fail: real.fail.bind(real), ok: real.ok.bind(real), unhealthy: real.unhealthy.bind(real), take: (k: string) => !taken.has(k) });
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, C]); // B's probe belongs to someone else
  });
});

// ---- empty reply (A1) and unavailable model (A2) -----------------------------------------------------------------------------
import "../src/providers/config";
import { buildRegistry } from "../src/providers/registry";
import { seedCatalog } from "../src/providers/catalog";
import { scopeFor } from "../src/scope";
const OPEN_SCOPE = scopeFor("main", "open");
buildRegistry({ scope: OPEN_SCOPE, gateway: null, env: { PROVIDER_KEY_NVIDIA: "k" }, catalog: seedCatalog() } as any); // gives the nvidia models their tool capability meta
import { isModelGone, isEmptyReply, EMPTY_REPLY_MESSAGE, MODEL_UNAVAILABLE_MESSAGE, GEMINI_EMPTY_RETRIES, emptyRetryCap, isGatewayGemini, GEMINI_VISIBLE_TEXT_LINE, buildRequest } from "../src/turn-engine";
const blk = (cb: any, deltas: any[] = [], stop = "end_turn"): ServerEvent[] => [start, { type: "content_block_start", index: 0, content_block: cb }, ...deltas.map((d) => ({ type: "content_block_delta", index: 0, delta: d })), { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: "message_stop" }];
const thinkOnly = () => sse(blk({ type: "thinking", thinking: "" }, [{ type: "thinking_delta", thinking: "hmm" }]));
const emptyText = () => sse(blk({ type: "text", text: "" }, [{ type: "text_delta", text: "" }]));
const blankText = () => sse(blk({ type: "text", text: "" }, [{ type: "text_delta", text: " \n\t " }]));
const toolUse = () => sse([start, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "web_read", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }, { type: "message_stop" }]);
const lastTurnEnd = (r: { events: ServerEvent[] }) => r.events.filter((e) => e.type === "turn_end").at(-1) as any;

describe("isEmptyReply", () => {
  test("reasoning-only, whitespace and no blocks are empty; text and tool_use are not; truncation is not", () => {
    expect(isEmptyReply([{ type: "thinking" }], "end_turn")).toBe(true);
    expect(isEmptyReply([{ type: "text", text: " \n" }], "end_turn")).toBe(true);
    expect(isEmptyReply([], null)).toBe(true);
    expect(isEmptyReply([{ type: "text", text: "hi" }], "end_turn")).toBe(false);
    expect(isEmptyReply([{ type: "tool_use" }], "tool_use")).toBe(false);
    expect(isEmptyReply([{ type: "thinking" }], "max_tokens")).toBe(false);
  });
});
describe("empty completed reply is a retryable failure", () => {
  test("Open + failover: reasoning-only reply switches to the next model, nothing empty is saved", async () => {
    const r = rig((m) => (m === A ? thinkOnly() : ok()));
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, B]);
    const a = r.assistant(); expect(a.length).toBe(1); expect(a[0].model).toBe(B); expect(a[0].status).toBe("complete");
    expect(r.events.some((e) => e.type === "failover" && e.from === A && e.to === B && (e as any).reason === "empty")).toBe(true);
    expect(r.idx.usage.some((u) => u.model === A)).toBe(true); // the failed call was billed
  });
  test("whitespace-only text also fails over", async () => {
    const r = rig((m) => (m === A ? blankText() : ok()));
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, B]); expect(r.assistant()[0].model).toBe(B);
  });
  test("no failover (Business): one same-model retry, then a visible error and no saved empty message", async () => {
    const r = rig(() => thinkOnly(), { open: false, hook: false });
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, A]); // retry cap: exactly one retry
    expect(r.assistant().length).toBe(0);
    const te = lastTurnEnd(r); expect(te.status).toBe("error"); expect(te.error.message).toBe(EMPTY_REPLY_MESSAGE); expect(te.error.retryable).toBe(true);
  });
  test("no failover: the retry can succeed", async () => {
    let n = 0; const r = rig(() => (++n === 1 ? emptyText() : ok()), { open: false, hook: false });
    await r.engine.send("hi", A);
    expect(r.calls.length).toBe(2); expect(r.assistant()[0].status).toBe("complete");
  });
  test("every model empty: bounded (2 switches + one retry), then the visible error", async () => {
    const r = rig(() => thinkOnly());
    await r.engine.send("hi", A);
    expect(r.calls.length).toBeLessThanOrEqual(4); expect(r.calls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(r.calls.slice(0, 3)).size).toBe(3);
    expect(r.assistant().length).toBe(0); expect(lastTurnEnd(r).error.message).toBe(EMPTY_REPLY_MESSAGE);
  });
  test("a tool_use turn is not empty (no retry, tool call saved)", async () => {
    let n = 0; const r = rig(() => (++n === 1 ? toolUse() : ok()), { open: false, hook: false });
    await r.engine.send("hi", A);
    expect(r.assistant()[0].content.some((b: any) => b.type === "tool_use")).toBe(true);
    expect(r.events.some((e) => e.type === "failover")).toBe(false);
  });
  test("empty text after tool results is empty too (same rule, retried once, then the error)", async () => {
    const tools = { list: async () => [{ name: "echo", description: "d", inputSchema: { type: "object", properties: {} } }], call: async () => ({ text: "pong", isError: false }) };
    const toolFirst = () => sse([start, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "echo", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }, { type: "message_stop" }]);
    let n = 0; const r = rig(() => (++n === 1 ? toolFirst() : emptyText()), { open: false, hook: false, tools });
    await r.engine.send("hi", A);
    expect(r.engine.decide("t1", "approve").ok).toBe(true); await r.engine.resume();
    expect(n).toBe(3); // tool call, empty reply, its single retry
    expect(lastTurnEnd(r).error.message).toBe(EMPTY_REPLY_MESSAGE);
    expect(r.assistant().every((m: any) => m.content.some((b: any) => b.type === "tool_use"))).toBe(true); // only the tool turn was saved
  });
});
describe("404 model not found / no access", () => {
  const vertex404 = () => new Response(JSON.stringify({ error: { type: "http_error", message: "Publisher model projects/1/locations/asia-south2/publishers/qwen/models/x was not found or your project does not have access to it" } }), { status: 404 });
  test("Business (no failover): non-retryable model_unavailable with the clear message, one call", async () => {
    const r = rig(() => vertex404(), { open: false, hook: false });
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A]);
    const te = lastTurnEnd(r); expect(te.error.type).toBe("model_unavailable"); expect(te.error.message).toBe(MODEL_UNAVAILABLE_MESSAGE); expect(te.error.retryable).toBe(false);
  });
  test("Open: the gateway-style 404 fails over to the next capable model", async () => {
    const r = rig((m) => (m === A ? vertex404() : ok()));
    await r.engine.send("hi", A);
    expect(r.calls).toEqual([A, B]); expect(r.assistant()[0].model).toBe(B);
    expect(r.events.some((e) => e.type === "failover" && (e as any).reason === "gone")).toBe(true);
  });
  test("Open with nothing to switch to: same clear non-retryable message", async () => {
    const r = rig(() => vertex404(), { cands: [cand(A)] });
    await r.engine.send("hi", A);
    const te = lastTurnEnd(r); expect(te.error.type).toBe("model_unavailable"); expect(te.error.retryable).toBe(false);
  });
  test("classification: 404 is the gone class, not retried by the engine's plain path", () => { expect(classifyFailure({ status: 404 })).toBe("gone"); });
});

describe("round 2: synthesis-only retry, totals, narrow 404", () => {
  const mkTools = () => { const calls: string[] = []; return { calls, host: { list: async () => [{ name: "echo", description: "d", inputSchema: { type: "object", properties: {} } }], call: async (n: string) => { calls.push(n); return { text: "pong", isError: false }; } } }; };
  const toolFirst = () => sse([start, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "echo", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }, { type: "message_stop" }]);
  test("empty after a tool ran: the same-model retry offers NO tools and the tool is never run twice", async () => {
    const t = mkTools(); let n = 0;
    const r = rig((_m, _n, b) => (++n === 1 ? toolFirst() : n === 2 ? emptyText() : (b?.tools?.length ? toolFirst() : ok())), { open: false, hook: false, tools: t.host });
    await r.engine.send("hi", A); r.engine.decide("t1", "approve"); await r.engine.resume();
    expect(n).toBe(3); expect(r.bodies[0].tools?.length).toBeGreaterThan(0);
    expect(r.bodies[1].tools?.length ?? 0).toBeGreaterThan(0); // the call after the tool result is a normal call
    expect(r.bodies[2].tools?.length ?? 0).toBe(0); expect(r.bodies[2].tool_choice).toBeUndefined();
    expect(t.calls).toEqual(["echo"]);
  });
  test("empty after a tool ran, Open failover: the switched model gets no tools either, tool run once", async () => {
    const t = mkTools(); let n = 0;
    const r = rig((m, _n, b) => (++n === 1 ? toolFirst() : m === A ? thinkOnly() : (b?.tools?.length ? toolFirst() : ok())), { tools: t.host });
    await r.engine.send("hi", A); r.engine.decide("t1", "approve"); await r.engine.resume();
    expect(r.calls.at(-1)).toBe(B); expect(r.bodies.at(-1).tools?.length ?? 0).toBe(0);
    expect(t.calls).toEqual(["echo"]);
  });
  test("the FIRST call of a turn (no tool ran yet) may still offer tools on the retry", async () => {
    const t = mkTools(); let n = 0;
    const r = rig(() => (++n === 1 ? emptyText() : ok()), { open: false, hook: false, tools: t.host });
    await r.engine.send("hi", A);
    expect(r.bodies[1].tools?.length).toBeGreaterThan(0);
  });
  test("two billed empty attempts are in the totals exactly once (turn_end and state), also when a retry succeeds", async () => {
    const r = rig(() => thinkOnly(), { open: false, hook: false });
    await r.engine.send("hi", A);
    const te = lastTurnEnd(r); expect(te.tokens).toBe(2 * 15); expect(r.engine.totals().tokens).toBe(30); expect(r.engine.state().tokens).toBe(30);
    expect(r.idx.usage.length).toBe(2);
    let k = 0; const r2 = rig(() => (++k === 1 ? thinkOnly() : ok()), { open: false, hook: false });
    await r2.engine.send("hi", A);
    const base = rig(() => ok(), { open: false, hook: false }); await base.engine.send("hi", A);
    expect(r2.engine.totals().tokens).toBe(base.engine.totals().tokens + 15); // the answer alone + the empty attempt (10+5), once
  });
  test("isModelGone: payload must say the model is missing", () => {
    expect(isModelGone(404, { type: "http_error", message: "Publisher model projects/1/x was not found or your project does not have access to it" })).toBe(true);
    expect(isModelGone(410, { type: "not_found_error" })).toBe(true);
    expect(isModelGone(404, { type: "unknown_model" })).toBe(true);
    expect(isModelGone(404, { type: "http_error", message: "gateway returned 404" })).toBe(false);
    expect(isModelGone(500, { type: "not_found_error" })).toBe(false);
  });
  test("a plain gateway-route 404 keeps its old classification (upstream message, retryable true)", async () => {
    const r = rig(() => new Response(JSON.stringify({ error: { type: "http_error", message: "Cannot POST /v1/messages" } }), { status: 404 }), { open: false, hook: false });
    await r.engine.send("hi", A);
    const te = lastTurnEnd(r); expect(te.error.type).toBe("http_error"); expect(te.error.message).toBe("Cannot POST /v1/messages"); expect(te.error.retryable).toBe(true);
  });
});

describe("round 3: synthesis-only request shape per provider family, and the engine never runs a tool in it", () => {
  const BIZ = "claude-sonnet-5-5";
  const mkTools = () => { const calls: string[] = []; return { calls, host: { list: async () => [{ name: "echo", description: "d", inputSchema: { type: "object", properties: {} } }], call: async (n: string) => { calls.push(n); return { text: "pong", isError: false }; } } }; };
  const toolFirst = () => sse([start, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "echo", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }, { type: "message_stop" }]);
  test("Anthropic-style (gateway / Business): tools definitions kept, tool_choice none", async () => {
    const t = mkTools(); let n = 0;
    const r = rig(() => (++n === 1 ? toolFirst() : n === 2 ? emptyText() : ok()), { open: false, hook: false, tools: t.host });
    await r.engine.send("hi", BIZ); r.engine.decide("t1", "approve"); await r.engine.resume();
    expect(n).toBe(3);
    expect(r.bodies[1].tool_choice).toBeUndefined();
    expect(r.bodies[2].tools.map((x: any) => x.name)).toContain("echo"); expect(r.bodies[2].tool_choice).toEqual({ type: "none" });
    expect(t.calls).toEqual(["echo"]);
  });
  test("Anthropic-style: the retry returns a tool_use anyway -> not executed, error shown, tool ran once", async () => {
    const t = mkTools(); let n = 0;
    const r = rig(() => (++n === 1 ? toolFirst() : n === 2 ? emptyText() : toolFirst()), { open: false, hook: false, tools: t.host });
    await r.engine.send("hi", BIZ); r.engine.decide("t1", "approve"); await r.engine.resume();
    expect(t.calls).toEqual(["echo"]); expect(n).toBe(3);
    expect(lastTurnEnd(r).status).toBe("error"); expect(lastTurnEnd(r).error.message).toBe(EMPTY_REPLY_MESSAGE);
    expect(r.assistant().filter((m: any) => m.content.some((b: any) => b.type === "tool_use")).length).toBe(1); // only the first tool turn was saved
  });
  test("Open (OpenAI-compatible nvidia): tools dropped; a tool_use returned anyway is not executed", async () => {
    const t = mkTools(); let n = 0;
    const r = rig((m, _n, b) => (++n === 1 ? toolFirst() : n === 2 ? emptyText() : (m === A ? toolFirst() : toolFirst())), { tools: t.host });
    await r.engine.send("hi", A); r.engine.decide("t1", "approve"); await r.engine.resume();
    expect(r.bodies[2].tools?.length ?? 0).toBe(0);
    expect(t.calls).toEqual(["echo"]);
    expect(r.assistant().filter((m: any) => m.content.some((b: any) => b.type === "tool_use")).length).toBe(1);
  });
  test("openai-compat mapping: tools + tool_choice none -> \"none\"; no tools -> no tool_choice at all", () => {
    const tools = [{ name: "echo", description: "d", input_schema: { type: "object", properties: {} } }];
    const msgs = [{ role: "user", content: "x" }];
    expect((toChatRequest({ messages: msgs, tools, tool_choice: { type: "none" } }, "m") as any).tool_choice).toBe("none");
    const bare = toChatRequest({ messages: msgs, tool_choice: { type: "none" } }, "m") as any; expect(bare.tools).toBeUndefined(); expect(bare.tool_choice).toBeUndefined();
  });
});
describe("gateway Gemini empty reply: up to 3 same-model retries (geminifix2)", () => {
  const GM = "gemini-3.8-flash";
  test("empty, empty, then text: 3 calls, saved complete, both empty calls billed", async () => {
    let n = 0; const r = rig(() => (++n <= 2 ? emptyText() : ok()), { open: false, hook: false });
    await r.engine.send("hi", GM);
    expect(r.calls).toEqual([GM, GM, GM]); expect(r.assistant()[0].status).toBe("complete");
  });
  test("always empty: exactly 4 calls (1 + 3 retries), then the visible error, nothing saved", async () => {
    const r = rig(() => emptyText(), { open: false, hook: false });
    await r.engine.send("hi", GM);
    expect(r.calls.length).toBe(1 + GEMINI_EMPTY_RETRIES); expect(r.assistant().length).toBe(0);
    expect(lastTurnEnd(r).error.message).toBe(EMPTY_REPLY_MESSAGE);
  });
  test("non-gemini models keep a single retry", () => {
    expect(emptyRetryCap(A)).toBe(1); expect(emptyRetryCap(GM)).toBe(3);
  });
  test("cap: prefixed forms and non-gemini gateway models stay at 1", () => {
    expect(emptyRetryCap("gemini-proxy:gpt-4o")).toBe(1); expect(emptyRetryCap("aistudio:gemini-3.1-flash-lite")).toBe(1);
    expect(emptyRetryCap("claude-sonnet-5-5")).toBe(1); expect(emptyRetryCap("gemini-3.8-flash")).toBe(3);
    expect(isGatewayGemini("gemini-proxy:gpt-4o")).toBe(false);
  });
  test("media/non-chat gemini ids: no instruction, cap 1; chat ids keep both", () => {
    for (const id of ["gemini-3-pro-image", "gemini-omni-1.1-flash-preview", "gemini-3.1-flash-tts", "gemini-embedding-001", "gemini-live-2.5-flash", "gemini-2.5-flash-native-audio"]) {
      expect(emptyRetryCap(id)).toBe(1); expect(isGatewayGemini(id)).toBe(false); expect(sys(id)).not.toContain(GEMINI_VISIBLE_TEXT_LINE);
    }
    for (const id of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-2.5-pro"]) { expect(emptyRetryCap(id)).toBe(3); expect(sys(id)).toContain(GEMINI_VISIBLE_TEXT_LINE); }
  });
  test("line occurs once when supplied via project text, profile, or neither", () => {
    const count = (ins: string | null, proj: { name: string; text: string } | null) => (buildRequest("gemini-3.8-flash", [{ role: "user", content: [{ type: "text", text: "hi" }] }], [], ins, proj) as any).system.map((b: any) => b.text).join("\n").split(GEMINI_VISIBLE_TEXT_LINE).length - 1;
    expect(count(null, null)).toBe(1); expect(count(GEMINI_VISIBLE_TEXT_LINE, null)).toBe(1); expect(count(null, { name: "p", text: GEMINI_VISIBLE_TEXT_LINE })).toBe(1);
  });
  test("always-empty custom-provider id: 2 calls, not 4", async () => {
    const r = rig(() => emptyText(), { open: false, hook: false });
    await r.engine.send("hi", "gemini-proxy:gpt-4o");
    expect(r.calls.length).toBe(2);
  });
  const sys = (m: string, open = false, ins: string | null = null) => (buildRequest(m, [{ role: "user", content: [{ type: "text", text: "hi" }] }], [], ins, null, false, null, open) as any).system.map((b: any) => b.text);
  test("visible-text line: only bare gateway gemini, not Open/prefixed/claude, never duplicated", () => {
    expect(sys("gemini-3.8-flash")).toContain(GEMINI_VISIBLE_TEXT_LINE);
    expect(sys("gemini-3.8-flash").filter((t: string) => t === GEMINI_VISIBLE_TEXT_LINE).length).toBe(1);
    expect(sys("gemini-3.8-flash", true)).not.toContain(GEMINI_VISIBLE_TEXT_LINE);
    expect(sys("aistudio:gemini-3.1-flash-lite")).not.toContain(GEMINI_VISIBLE_TEXT_LINE);
    expect(sys("gemini-proxy:gpt-4o")).not.toContain(GEMINI_VISIBLE_TEXT_LINE);
    expect(sys("claude-sonnet-5-5")).not.toContain(GEMINI_VISIBLE_TEXT_LINE);
    expect(sys("gemini-3.8-flash", false, `x ${GEMINI_VISIBLE_TEXT_LINE}`).some((t: string) => t === GEMINI_VISIBLE_TEXT_LINE)).toBe(false);
  });
});
