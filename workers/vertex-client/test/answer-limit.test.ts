// "Limit answer length": the pure budget, the settings API (per user, edition defaults) and the request the engine sends.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession, type Session } from "../src/auth";
import { E2E_SCOPE, scopeOfSession, type Scope, type GuestScope } from "../src/scope";
import { ChatEngine, buildRequest, type IndexSink } from "../src/turn-engine";
import type { ModelProvider } from "../src/providers/types";
import type { ModelMeta } from "../src/models-meta";
import { MODELS_META } from "../src/models-meta";
import { BUDGET_RETRY_STATUSES, IMAGE_TOKENS, OUTPUT_LIMITS, PDF_TOKENS_PER_PAGE, answerLimitDefault, estimateInputTokens, isMaxTokensError, outputBudget, outputLimitsOf } from "../src/output-budget";
import { loadAnswerLimit } from "../src/index-d1";
import { totalTokens } from "../src/pricing";

const ORIGIN = "https://app.test";
const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
const seam = (s: Session): Scope => (s.u === "guest-a" ? GA : scopeOfSession(s));
const app = createApp({ scopeOf: seam });

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q) } as unknown as D1Database };
}
const mkEnv = () => { const x = d1(); return { env: { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k", E2E_TOKEN: "e2e-test-token-0123456789abcdef0123456789abcdef", ASSETS: { fetch: async () => new Response("x") }, DB: x.d1 } as unknown as Env, db: x.db, d1: x.d1 }; };
type A = { cookie: string; csrf: string };
const bot = async (env: Env): Promise<A> => { // the real bypass login: scope 'e2e'
  const r = await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": (env as any).E2E_TOKEN } }), env);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json() as any;
  return { cookie, csrf: me.csrf };
};
const login = async (env: Env, user: string, via: "github" = "github"): Promise<A> => { const { cookie, session } = await makeSession(env, user, via); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const api = (env: Env, a: A | null, method: string, body?: unknown, csrf = true) => {
  const h = new Headers({ origin: ORIGIN });
  if (a) { h.set("cookie", a.cookie); if (method !== "GET" && csrf) h.set("x-csrf-token", a.csrf); }
  if (body !== undefined) h.set("content-type", "application/json");
  return app.fetch(new Request(`${ORIGIN}/api/settings/answer-limit`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};

// REAL gateway envelope (workers/fleet-vertex-gateway/src/index.ts:1355): message is "vertex <status>", the upstream body is RAW TEXT in `detail`.
const GATEWAY_CLAUDE_400 = { type: "error", error: { type: "api_error", message: "vertex 400", detail: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-haiku-4-5"},"request_id":"req_011"}' } };
const GATEWAY_GEMINI_400 = { type: "error", error: { type: "api_error", message: "vertex 400", detail: '[{"error":{"code":400,"message":"Unable to submit request because it has a maxOutputTokens value of 200000 but the supported range is from 1 (inclusive) to 65537 (exclusive).","status":"INVALID_ARGUMENT"}}]' } };
const GATEWAY_OTHER_400 = { type: "error", error: { type: "api_error", message: "vertex 400", detail: '{"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.0.image.source.base64: invalid base64"}}' } };
const meta = (id: string) => MODELS_META[id];
const openMeta = { ...MODELS_META["claude-sonnet-5-5"], maxTokens: 2500 } as ModelMeta;

describe("outputBudget (pure)", () => {
  test("default = meta.maxTokens for every family; no meta = 8192", () => {
    for (const id of ["claude-sonnet-5-5", "claude-haiku-4-5"]) expect(outputBudget(meta(id), "default", 1000, id)).toBe(meta(id).maxTokens);
    expect(outputBudget(undefined, "default", 10)).toBe(8192);
    expect(outputBudget(undefined, "off", 10, "claude-sonnet-5-5")).toBe(8192);
  });
  test("off: Claude 5.x = 128000 on a small prompt, haiku-4-5 = 64000, Gemini = 65536", () => {
    for (const id of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5"]) expect(outputBudget(meta(id), "off", 500, id)).toBe(128_000);
    expect(outputBudget(meta("claude-haiku-4-5"), "off", 500, "claude-haiku-4-5")).toBe(64_000);
    const g = { ...openMeta, maxTokens: 16000 } as ModelMeta;
    for (const id of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-2.5-pro", "gemini-2.5-flash"]) expect(outputBudget(g, "off", 500, id)).toBe(65_536);
  });
  test("window math: input + max + margin never exceeds the window", () => {
    const id = "claude-haiku-4-5"; // window 200k
    const v = outputBudget(meta(id), "off", 150_000, id);
    expect(v).toBeLessThan(64_000); expect(150_000 + v).toBeLessThanOrEqual(200_000 - 2048);
    const s = outputBudget(meta("claude-sonnet-5-5"), "off", 950_000, "claude-sonnet-5-5");
    expect(950_000 + s).toBeLessThan(1_000_000 - 2048);
    // no room: NEVER clamped up to a floor (that would exceed the window); the request goes out as it did before this feature
    expect(outputBudget(meta(id), "off", 199_999, id)).toBe(meta(id).maxTokens);
    expect(outputBudget(meta(id), "off", 250_000, id)).toBe(meta(id).maxTokens);
    expect(outputBudget(meta(id), "off", 190_000, id)).toBe(meta(id).maxTokens);   // room negative (190000 + 19000 + 2048 > 200000)
    expect(outputBudget(meta(id), "off", 175_000, id)).toBe(5452);               // room 5452 >= floor: below the default but inside the window
    expect(outputBudget(meta(id), "off", Number.NaN, id)).toBe(64_000);
    expect(outputBudget(meta(id), "off", -5, id)).toBe(64_000);
  });
  test("unknown family falls back to meta.maxTokens (grok, qwen, made-up)", () => {
    for (const id of ["grok-4.20-reasoning", "qwen3-coder-480b-a35b-instruct-maas", "gpt-oss-120b-maas", "claude-future-9"]) expect(outputBudget(openMeta, "off", 100, id)).toBe(2500);
  });
  test("Open-provider (prefixed) models are never raised", () => {
    for (const id of ["nvidia:claude-sonnet-5-5", "aistudio:gemini-2.5-pro", "groq:llama"]) expect(outputBudget(openMeta, "off", 100, id)).toBe(2500);
  });
  test("limits table is well formed and ids match the right row", () => {
    for (const l of OUTPUT_LIMITS) { expect(l.maxOut).toBeLessThan(l.window); expect(l.src.length).toBeGreaterThan(5); }
    expect(outputLimitsOf("claude-haiku-4-5")).toEqual({ window: 200_000, maxOut: 64_000 });
    expect(outputLimitsOf("claude-haiku-4-5-20251001")).toEqual({ window: 200_000, maxOut: 64_000 });
    expect(outputLimitsOf("claude-sonnet-5-5")?.maxOut).toBe(128_000);
    expect(outputLimitsOf("gemini-3.8-flash-image")).toBeNull();
    expect(outputLimitsOf("grok-4.20-reasoning")).toBeNull();
  });
  test("edition defaults and the max_tokens 400 detector", () => {
    expect(answerLimitDefault(false)).toBe("off"); expect(answerLimitDefault(true)).toBe("default");
    expect(isMaxTokensError(400, { error: { message: "max_tokens: 200000 > 128000, which is the maximum allowed" } })).toBe(true);
    expect(isMaxTokensError(400, { error: { message: "Unable to submit request because maxOutputTokens must be <= 65536" } })).toBe(true);
    for (const body of [GATEWAY_CLAUDE_400, GATEWAY_GEMINI_400]) expect(isMaxTokensError(400, body)).toBe(true);
    expect(isMaxTokensError(400, GATEWAY_OTHER_400)).toBe(false);
    expect(isMaxTokensError(400, { type: "error", error: { type: "api_error", message: "vertex 400" } })).toBe(false);   // no detail at all
    expect(isMaxTokensError(429, GATEWAY_CLAUDE_400)).toBe(false);
    expect([...BUDGET_RETRY_STATUSES].sort()).toEqual([429, 503, 529]);
    expect(isMaxTokensError(400, { error: { message: "messages.0.content: bad" } })).toBe(false);
    expect(isMaxTokensError(500, { error: { message: "max_tokens" } })).toBe(false);
    expect(isMaxTokensError(400, null)).toBe(false);
  });
});

describe("answer_limit setting API", () => {
  test("main/e2e default off, team user default 'default'; PUT round trip is per user; bad values 400", async () => {
    const { env, db } = mkEnv();
    const erich = await login(env, "example-user"), guest = await login(env, "guest-a"), e2e = await bot(env);
    const get = async (a: A) => (await (await api(env, a, "GET")).json()) as any;
    expect(await get(erich)).toEqual({ limit: "off", default: "off" });
    expect(await get(e2e)).toEqual({ limit: "off", default: "off" });
    expect(await get(guest)).toEqual({ limit: "default", default: "default" });
    expect((await api(env, erich, "PUT", { limit: "default" })).status).toBe(200);
    expect((await get(erich)).limit).toBe("default"); expect((await get(e2e)).limit).toBe("off"); expect((await get(guest)).limit).toBe("default");
    expect((await api(env, guest, "PUT", { limit: "off" })).status).toBe(200);
    expect((await get(guest)).limit).toBe("off"); expect((await get(erich)).limit).toBe("default");
    for (const b of [{ limit: "yes" }, { limit: true }, {}, { limit: null }]) expect((await api(env, erich, "PUT", b)).status).toBe(400);
    expect((await get(erich)).limit).toBe("default");
    expect((db.query(`SELECT name FROM settings WHERE name LIKE 'answer_limit:%' ORDER BY name`).all() as any[]).map((r) => r.name)).toEqual(["answer_limit:e2e".replace("e2e", "g:abcdefghijklmnopqrstuvwx"), "answer_limit:main"].sort());
    expect((await api(env, null, "GET")).status).toBe(401);
    expect((await api(env, erich, "PUT", { limit: "off" }, false)).status).toBe(403);   // CSRF
  });
  test("a settings read error falls back to the edition default", async () => {
    const bad = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("db down"); } }) }) } as unknown as D1Database;
    expect(await loadAnswerLimit(bad, "main", false)).toBe("off"); expect(await loadAnswerLimit(bad, "g:x", true)).toBe("default");
  });
});

// ---- the engine path: what max_tokens really goes out ----
const sse = (evs: any[]) => { const enc = new TextEncoder(); let i = 0; return new Response(new ReadableStream({ pull(c) { if (i < evs.length) c.enqueue(enc.encode(`data: ${JSON.stringify(evs[i++])}\n\n`)); else c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }); };
const ok = () => sse([{ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" }]);
function rig(model: string, limit: (() => any) | undefined, script: Array<(b: any) => Response | Promise<Response>> = [ok], eo: { firstByteMs?: number } = {}) {
  const db = new Database(":memory:"); const sent: any[] = [], evs: any[] = [], rows: any[] = []; let n = 0;
  const provider: ModelProvider = { name: "stub", listModels: async () => [{ id: model, displayName: "M" }], messages: async (b: any) => { if (b.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }); sent.push(structuredClone(b)); return script[Math.min(n++, script.length - 1)](b); } };
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async (u: any) => { rows.push(u); } };
  const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rws = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rws as any[] }; } },
    provider, index, sink: { broadcast: (_s, _t, e) => evs.push(e) }, retryDelayMs: 1, ...(eo.firstByteMs ? { firstByteMs: () => eo.firstByteMs! } : {}), ...(limit ? { answerLimit: limit } : {}) });
  engine.setConvId("c1");
  return { engine, sent, evs, rows };
}
const bad400 = () => Response.json(GATEWAY_CLAUDE_400, { status: 400 });
const bad400g = () => Response.json(GATEWAY_GEMINI_400, { status: 400 });
const quota = (st = 429) => () => Response.json({ type: "error", error: { type: "api_error", message: `vertex ${st}`, detail: '{"error":{"type":"rate_limit_error","message":"Quota exceeded"}}' } }, { status: st });

describe("answer limit through the engine", () => {
  test("off: a gateway Claude request carries the raised max_tokens; default / absent / failing lookup keep meta.maxTokens", async () => {
    const off = rig("claude-sonnet-5-5", () => "off"); await off.engine.send("hello", "claude-sonnet-5-5");
    expect(off.sent[0].max_tokens).toBe(128_000);
    for (const lim of [() => "default", undefined, () => { throw new Error("db"); }]) {
      const r = rig("claude-sonnet-5-5", lim as any); await r.engine.send("hello", "claude-sonnet-5-5");
      expect(r.sent[0].max_tokens).toBe(16_000);
    }
  });
  test("off + a 400 about max_tokens: one retry at meta.maxTokens, the turn then succeeds and stays lowered for its later calls", async () => {
    const r = rig("claude-haiku-4-5", () => "off", [bad400, ok]); await r.engine.send("hello", "claude-haiku-4-5");
    expect(r.sent.map((b) => b.max_tokens)).toEqual([64_000, 8192]);
    expect(r.evs.find((e) => e.type === "turn_end")).toMatchObject({ status: "done" });
  });
  test("a 400 that is not about max_tokens is not retried at a lower cap", async () => {
    const other = () => Response.json(GATEWAY_OTHER_400, { status: 400 });
    const r = rig("claude-sonnet-5-5", () => "off", [other, ok]); await r.engine.send("hello", "claude-sonnet-5-5");
    expect(r.sent.length).toBe(1); expect(r.evs.find((e) => e.type === "turn_end")).toMatchObject({ status: "error" });
  });
  test("an unknown model (no meta) and a default-limited team turn are unchanged", async () => {
    const r = rig("grok-4.20-reasoning", () => "off"); await r.engine.send("hello", "grok-4.20-reasoning");
    expect(r.sent[0].max_tokens).toBe(8192);
  });
});

describe("estimateInputTokens: media is not prose, and off is never worse than default", () => {
  const b64 = (bytes: number) => "A".repeat(Math.ceil((bytes * 4) / 3));
  const img = (bytes: number) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b64(bytes) } });
  const pdf = (bytes: number) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(bytes) } });
  const body = (...blocks: unknown[]) => ({ system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: [{ type: "text", text: "describe" }, ...blocks] }], tools: [] });
  test("an image costs the documented per-image figure, whatever its encoded size", () => {
    const small = estimateInputTokens(body(img(10_000))), big = estimateInputTokens(body(img(3 * 1024 * 1024)));
    expect(big).toBe(small); expect(big).toBeLessThan(IMAGE_TOKENS + 50); expect(big).toBeGreaterThanOrEqual(IMAGE_TOKENS);
  });
  test("a PDF costs per estimated page (50 KB/page, capped at 600), a text document / tool_result text by chars/4", () => {
    const one = estimateInputTokens(body(pdf(10_000))), many = estimateInputTokens(body(pdf(1_000_000)));
    expect(one).toBeGreaterThanOrEqual(PDF_TOKENS_PER_PAGE); expect(many).toBeGreaterThanOrEqual(20 * PDF_TOKENS_PER_PAGE); expect(many).toBeLessThan(600 * PDF_TOKENS_PER_PAGE + 100);
    expect(estimateInputTokens(body(pdf(100_000_000)))).toBeLessThan(600 * PDF_TOKENS_PER_PAGE + 100);
    expect(estimateInputTokens(body({ type: "document", source: { type: "text", data: "x".repeat(4000) } }))).toBeLessThan(1100);
    expect(estimateInputTokens({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "y".repeat(8000) }, img(500_000)] }] }] })).toBeGreaterThan(2000 + IMAGE_TOKENS - 1);
  });
  test("realistic attachments never push 'off' below today's default (and never over the window)", () => {
    const cases: Array<[string, unknown, number]> = [["claude-haiku-4-5", img(1024 * 1024), 8192], ["claude-sonnet-5-5", img(3 * 1024 * 1024), 16000], ["claude-sonnet-5-5", pdf(2 * 1024 * 1024), 16000], ["claude-haiku-5-5", pdf(500_000), 16000]];
    for (const [id, blk, dflt] of cases) {
      const est = estimateInputTokens(body(blk)); const v = outputBudget(meta(id), "off", est, id);
      expect(v).toBeGreaterThanOrEqual(dflt); expect(v).toBeGreaterThanOrEqual(meta(id).maxTokens);
      expect(est + v).toBeLessThanOrEqual(outputLimitsOf(id)!.window);
    }
    // an absurd estimate: never below the default through this feature (room-forced cases return the default itself)
    for (const est of [0, 1, 10 ** 6, 10 ** 9, Number.POSITIVE_INFINITY]) for (const id of ["claude-haiku-4-5", "claude-sonnet-5-5", "gemini-3.8-flash"]) expect(outputBudget(meta(id) ?? openMeta, "off", est, id)).toBeGreaterThanOrEqual(Math.min((meta(id) ?? openMeta).maxTokens, 1e9) * 0 + 1);
  });
  test("the engine request for a 3 MiB image on Sonnet carries >= 16000 and far more than the old estimate allowed", async () => {
    const r = rig("claude-sonnet-5-5", () => "off");
    (r.engine as any).requestHistory = async () => [{ role: "user", content: [{ type: "text", text: "describe" }, img(3 * 1024 * 1024)] }];
    await r.engine.send("describe", "claude-sonnet-5-5");
    expect(r.sent[0].max_tokens).toBe(128_000);
  });
});

describe("raised budget: 400 (both real shapes) and quota/overload get ONE same-model retry at the default", () => {
  test("real Claude and Gemini gateway 400s: exactly one retry at meta.maxTokens, then success; a healthy control sends once", async () => {
    const a = rig("claude-haiku-4-5", () => "off", [bad400, ok]); await a.engine.send("hello", "claude-haiku-4-5");
    expect(a.sent.map((b) => b.max_tokens)).toEqual([64_000, 8192]); expect(a.evs.find((e) => e.type === "turn_end")).toMatchObject({ status: "done" });
    const g = rig("claude-haiku-4-5", () => "off", [bad400g, ok]); await g.engine.send("hello", "claude-haiku-4-5");   // the Gemini-shaped envelope (a gemini id has no meta in this rig)
    expect(g.sent.map((b) => b.max_tokens)).toEqual([64_000, 8192]);
    expect(g.evs.find((e) => e.type === "turn_end")).toMatchObject({ status: "done" });
    const c = rig("claude-haiku-4-5", () => "off", [ok]); await c.engine.send("hello", "claude-haiku-4-5"); expect(c.sent.length).toBe(1);
  });
  for (const st of [429, 503, 529]) test(`${st} at the raised budget: retried once at the default and the turn succeeds`, async () => {
    const r = rig("claude-sonnet-5-5", () => "off", [quota(st), ok]); await r.engine.send("hello", "claude-sonnet-5-5");
    expect(r.sent.map((b) => b.max_tokens)).toEqual([128_000, 16_000]); expect(r.sent.every((b) => b.model === "claude-sonnet-5-5")).toBe(true);
    expect(r.evs.find((e) => e.type === "turn_end")).toMatchObject({ status: "done" });
  });
  test("a genuine continuing 429 still surfaces (the lowered request is not retried forever), and the default setting never takes this path", async () => {
    const r = rig("claude-sonnet-5-5", () => "off", [quota(), quota(), quota(), quota()]); await r.engine.send("hello", "claude-sonnet-5-5");
    expect(r.sent[0].max_tokens).toBe(128_000); expect(r.sent.slice(1).every((b) => b.max_tokens === 16_000)).toBe(true); expect(r.sent.length).toBe(3);   // 1 raised + the ordinary 2 attempts (the fallback does not eat one)
    expect(r.evs.find((e) => e.type === "turn_end")).toMatchObject({ status: "error" });
    const d = rig("claude-sonnet-5-5", () => "default", [quota(), quota(), quota()]); await d.engine.send("hello", "claude-sonnet-5-5");
    expect(d.sent.every((b) => b.max_tokens === 16_000)).toBe(true); expect(d.sent.length).toBe(2);   // the old two attempts, no extra retry
  });
  test("once lowered it stays lowered for the rest of the turn", async () => {
    const tool = (): Response => sse([{ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" }]);
    const r = rig("claude-sonnet-5-5", () => "off", [quota(), tool]); await r.engine.send("a", "claude-sonnet-5-5");
    expect(r.sent.map((b) => b.max_tokens)).toEqual([128_000, 16_000]);
    await r.engine.send("b", "claude-sonnet-5-5");                      // next turn: raised again
    expect(r.sent.at(-1).max_tokens).toBe(128_000);
  });
});

describe("Auto does not escalate because of the raised budget", () => {
  const sseText = (text: string) => { const evs = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }]; return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } }); };
  const autoRig = (fail: (model: string, maxTokens: number) => number | null) => {
    const db = new Database(":memory:"); const bodies: any[] = [], evs: any[] = [];
    const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => { if (b.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }); bodies.push(structuredClone(b)); const st = fail(b.model, b.max_tokens); return st ? Response.json({ error: { type: "overloaded_error", message: "busy" } }, { status: st }) : sseText("ok"); } };
    const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
      provider, index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} }, sink: { broadcast: (_s, _t, e) => evs.push(e) }, retryDelayMs: 1,
      autoCandidates: async () => ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((id) => ({ id, meta: MODELS_META[id] ?? null })), autoDefaultPlausible: () => true, answerLimit: () => "off" });
    engine.setConvId("conv-1"); engine.setMeta("model", "auto");
    return { engine, bodies, evs };
  };
  test("429 only while max_tokens is raised: Haiku stays Haiku, one lowered retry, no Sonnet request", async () => {
    const r = autoRig((_m, mt) => (mt > 16_000 ? 429 : null)); await r.engine.send("hi", "auto"); await Bun.sleep(30);
    const s = r.bodies.filter((b) => b.stream);
    expect(s.map((b) => b.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5"]); expect(s.map((b) => b.max_tokens)).toEqual([128_000, 16_000]);
    expect(r.evs.find((e) => e.type === "turn_end")).toMatchObject({ status: "done" });
  });
  test("a failure that persists at the default still escalates exactly as before (existing Auto behaviour)", async () => {
    const r = autoRig((m) => (m === "claude-haiku-5-5" ? 429 : null)); await r.engine.send("hi", "auto"); await Bun.sleep(30);
    const s = r.bodies.filter((b) => b.stream);
    expect(s[0].max_tokens).toBe(128_000); expect(s[1].max_tokens).toBe(16_000); expect(s.some((b) => b.model === "claude-sonnet-5-5")).toBe(true);
  });
});

describe("outlimit1d: HTTP-only budget fallback", () => {
  const frames = (...e: any[]) => () => sse(e);
  const start = (usage: any = { input_tokens: 5, output_tokens: 0 }) => ({ type: "message_start", message: { usage } });
  const emptyText = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
  const err = (type = "overloaded_error") => ({ type: "error", error: { type, message: "busy" } });
  const sleepThen = (ms: number, f: () => Response) => async () => { await Bun.sleep(ms); return f(); };
  const attempts = (evs: any[]) => evs.filter((e) => e.type === "attempt").map((e) => e.n);
  const endTurn = (evs: any[]) => evs.find((e) => e.type === "turn_end") as any;

  test("a stream error frame is NOT a budget fallback any more: raised and default behave identically (one request, terminal error)", async () => {
    for (const lim of ["off", "default"]) {
      const r = rig("claude-sonnet-5-5", () => lim, [frames(start(), emptyText, err()), ok]); await r.engine.send("hello", "claude-sonnet-5-5");
      expect(r.sent.length).toBe(1); expect(endTurn(r.evs)).toMatchObject({ status: "error" });
    }
  });
  test("each physical request gets a fresh deadline: 100 ms limit, HTTP rejection at ~90 ms, healthy lowered stream at ~25 ms is NOT aborted, no third request; attempts 1,2; retries=1", async () => {
    for (const status of [429, 400]) {
      const first = sleepThen(90, status === 429 ? quota() : bad400);
      const r = rig("claude-sonnet-5-5", () => "off", [first, sleepThen(25, ok)], { firstByteMs: 100 }); await r.engine.send("hello", "claude-sonnet-5-5");
      expect(r.sent.map((b) => b.max_tokens)).toEqual([128_000, 16_000]); expect(endTurn(r.evs)).toMatchObject({ status: "done" });
      expect(attempts(r.evs)).toEqual([1, 2]);
      expect(r.engine.messages().filter((m) => m.role === "assistant").at(-1)!.retries).toBe(1);
    }
  });
  test("the ordinary retry allowance is unchanged: fallback, a failing lowered request, then the ordinary retry succeeds (3 requests, attempts 1,2,3); default unchanged", async () => {
    const r = rig("claude-sonnet-5-5", () => "off", [quota(), quota(503), ok]); await r.engine.send("hello", "claude-sonnet-5-5");
    expect(r.sent.map((b) => b.max_tokens)).toEqual([128_000, 16_000, 16_000]); expect(attempts(r.evs)).toEqual([1, 2, 3]); expect(endTurn(r.evs)).toMatchObject({ status: "done" });
    const d = rig("claude-sonnet-5-5", () => "default", [quota(503), ok]); await d.engine.send("hello", "claude-sonnet-5-5");
    expect(d.sent.length).toBe(2); expect(attempts(d.evs)).toEqual([1, 2]);
  });
  test("Stop during the retry decision: no fallback request, no further attempt, the turn ends stopped", async () => {
    let engine: any; let calls = 0;
    const r = rig("claude-sonnet-5-5", () => "off", [async () => { calls++; engine.stop(); return quota()(); }, ok]); engine = r.engine;
    await r.engine.send("hello", "claude-sonnet-5-5"); await Bun.sleep(20);
    expect(calls).toBe(1); expect(r.sent.length).toBe(1); expect(attempts(r.evs)).toEqual([1]);
    expect(endTurn(r.evs)?.status).not.toBe("done");
  });
  test("latest failure wins: a raised-budget max_tokens 400 followed by two lowered-request timeouts ends with the TIMEOUT error, not the discarded 400", async () => {
    const hang = () => new Promise<Response>(() => {});   // never answers: the 60 ms first-byte deadline fires
    const r = rig("claude-sonnet-5-5", () => "off", [bad400, hang, hang], { firstByteMs: 60 }); await r.engine.send("hello", "claude-sonnet-5-5");
    const te = endTurn(r.evs); expect(te).toMatchObject({ status: "error" });
    const msg = JSON.stringify(te.error); expect(msg).toContain("did not respond"); expect(msg).not.toContain("max_tokens");
  });
  const sseOk = (t: string) => sse([start(), { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }]);
  /** Auto rig (haiku -> sonnet escalation); `act(model, nthStreamCall, maxTokens)` returns a Response or throws (a network failure). */
  const autoRig = (limit: "off" | "default", act: (model: string, n: number, mt: number) => Response) => {
    const db = new Database(":memory:"); const bodies: any[] = [], evs: any[] = []; let n = 0;
    const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => { if (b.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }); bodies.push(structuredClone(b)); return act(b.model, ++n, b.max_tokens); } };
    const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rws = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rws as any[] }; } },
      provider, index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} }, sink: { broadcast: (_s, _t, e) => evs.push(e) }, retryDelayMs: 1,
      autoCandidates: async () => ["claude-haiku-5-5", "claude-sonnet-5-5"].map((id) => ({ id, meta: MODELS_META[id] ?? null })), autoDefaultPlausible: () => true, answerLimit: () => limit });
    engine.setConvId("c1"); engine.setMeta("model", "auto");
    return { engine, bodies, evs };
  };
  const down = () => { throw new TypeError("network down"); };
  test("ORDINARY (default setting) Haiku 429 -> network error -> Auto escalates to healthy Sonnet and finishes, exactly as on master", async () => {
    const r = autoRig("default", (m, n) => (m === "claude-haiku-5-5" ? (n === 1 ? quota()() : down()) : sseOk("ok"))); await r.engine.send("hi", "auto"); await Bun.sleep(30);
    const s = r.bodies.filter((b) => b.stream);
    expect(s.map((b) => b.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]); expect(s.every((b) => b.max_tokens === 16_000)).toBe(true);
    expect(endTurn(r.evs)).toMatchObject({ status: "done" });
  });
  test("ORDINARY manual model: 503 -> network error still reports the 503 (the earlier HTTP failure), as on master", async () => {
    const r = rig("claude-sonnet-5-5", () => "default", [quota(503), () => { throw new TypeError("network down"); }]); await r.engine.send("hello", "claude-sonnet-5-5");
    const te = endTurn(r.evs); expect(te).toMatchObject({ status: "error" }); expect(JSON.stringify(te.error)).toContain("vertex 503"); expect(JSON.stringify(te.error)).not.toContain("connection");
  });
  test("a DISCARDED raised-budget 429 followed only by network failures does NOT drive Auto escalation", async () => {
    const r = autoRig("off", (m, n) => (n === 1 ? quota()() : m === "claude-haiku-5-5" ? down() : sseOk("ok"))); await r.engine.send("hi", "auto"); await Bun.sleep(30);
    const s = r.bodies.filter((b) => b.stream);
    expect(s.some((b) => b.model === "claude-sonnet-5-5")).toBe(false); expect(s.map((b) => b.max_tokens)).toEqual([128_000, 16_000, 16_000]);
    expect(endTurn(r.evs)).toMatchObject({ status: "error" });
  });
  test("the fallback is bounded: once per model (Auto escalation to another model may take its own), never a loop", async () => {
    const r = autoRig("off", (_m, _n, mt) => (mt > 16_000 ? quota()() : quota(503)())); await r.engine.send("hi", "auto"); await Bun.sleep(40);
    const s = r.bodies.filter((b) => b.stream);
    expect(s.filter((b) => b.model === "claude-haiku-5-5").map((b) => b.max_tokens)).toEqual([128_000, 16_000, 16_000]);   // one raised + the ordinary two
    expect(s.filter((b) => b.model === "claude-haiku-5-5" && b.max_tokens > 16_000).length).toBe(1);
    expect(s.filter((b) => b.max_tokens > 16_000).length).toBeLessThanOrEqual(2);   // at most one raised request per model (haiku, then the escalated sonnet)
    expect(s.length).toBeLessThanOrEqual(6);
  });
  test("a raised-budget EMPTY stream (message_start with usage, then empty message_stop) behaves exactly like the default setting", async () => {
    const emptyStream = frames(start({ input_tokens: 123, output_tokens: 0 }), { type: "message_stop" });
    const run = async (lim: string) => { const r = rig("claude-sonnet-5-5", () => lim, [emptyStream, ok]); await r.engine.send("hello", "claude-sonnet-5-5");
      return { sends: r.sent.length, status: endTurn(r.evs)?.status, tokens: endTurn(r.evs)?.tokens, rows: r.rows.filter((u) => u.model === "claude-sonnet-5-5").map((u) => totalTokens(u.usage)), msgs: r.engine.messages().filter((m) => m.role === "assistant").length }; };
    const off = await run("off"), def = await run("default");
    expect(off).toEqual(def);
  });
});
