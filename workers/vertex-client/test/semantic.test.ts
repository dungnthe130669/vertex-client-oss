// Semantic chat search: fake AI + fake VECTORIZE bindings, real SQL (bun:sqlite + the real migrations), the REAL engine hook, the REAL HTTP handler and the REAL palette logic.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { ChatEngine, type ServerEvent } from "../src/turn-engine";
import { d1Index } from "../src/index-d1";
import { EXCHANGE_CAP, QUERY_CAP, backfillCron, backfillSlice, exchangeText, exchangesFromIndex, scopeKey, sweepVectorTombstones, vectorId, type VectorizeLike } from "../src/semantic";
import { parseScope, type Scope } from "../src/scope";
import { chatItem } from "../web/src/palette-logic";
import { chatMock } from "./do-mock";

const ORIGIN = "https://app.test";
const GA = parseScope("g:abcdefghijklmnopqrstuvwx")!;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
    _run: () => db.query(q).run(...(b as any)),
  });
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (l: any[]) => { const out: any[] = []; for (const s of l) { out.push(await s.run()); } return out; } } as unknown as D1Database };
}

// Bag-of-words embedding: texts sharing words are close. 24 dims, hashed.
const vec = (t: string) => { const v = new Array(24).fill(0); for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 24] += 1; } const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const fakeAI = (calls: string[][] = []) => ({ run: async (_m: string, i: Record<string, unknown>) => { const t = i.text as string[]; calls.push(t); return { shape: [t.length, 24], data: t.map(vec) }; } });
type Stored = { id: string; values: number[]; metadata?: Record<string, any> };
function fakeVectorize(opts: { honorFilter?: boolean } = {}) {
  const store = new Map<string, Stored>(); const deleted: string[] = [];
  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  const v: VectorizeLike & { store: Map<string, Stored>; deleted: string[]; fail?: boolean } = {
    store, deleted,
    upsert: async (vs) => { for (const x of vs) store.set(x.id, x as Stored); return {}; },
    query: async (q, o) => {
      let all = [...store.values()];
      if (o.filter && opts.honorFilter !== false) all = all.filter((s) => Object.entries(o.filter!).every(([k, val]) => s.metadata?.[k] === val));
      return { matches: all.map((s) => ({ id: s.id, score: cos(q, s.values), metadata: s.metadata })).sort((a, b) => b.score - a.score).slice(0, o.topK) };
    },
    deleteByIds: async (ids) => { if (v.fail) throw new Error("vectorize down"); for (const id of ids) { deleted.push(id); store.delete(id); } return {}; },
  };
  return v;
}
const mkEnv = (extra: Record<string, unknown> = {}) => {
  const x = d1();
  const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k",
    ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, _db: x.db, ...extra };
  e.CHAT = chatMock(() => e.FILES);
  for (const b of ["main", GA]) x.db.query(`INSERT INTO settings (name, value) VALUES (?, '1')`).run(`semantic_ready:${b}`); // the PO's readiness flag (docs/vclient-semantic-search.md)
  return e as Env & { _db: Database };
};
const app = createApp();
const who = async (env: Env) => { const { cookie, session } = await makeSession(env, "example-user", "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const call = async (env: Env, method: string, path: string, space: "biz" | "open" = "biz") => {
  const w = await who(env);
  const h = new Headers({ cookie: w.cookie, origin: ORIGIN, "x-vc-space": space }); if (method !== "GET") h.set("x-csrf-token", w.csrf);
  return app.fetch(new Request(ORIGIN + path, { method, headers: h }), env);
};
const seed = (env: { _db: Database }, id: string, scope: string, title: string) => env._db.query(`INSERT INTO conversations (id, model, scope, title) VALUES (?,?,?,?)`).run(id, "claude-sonnet-5-5", scope, title);
const idxMsg = (env: { _db: Database }, conv: string, seq: number, role: string, text: string) => env._db.query(`INSERT INTO messages_index (conversation_id, message_seq, chunk, role, text) VALUES (?,?,0,?,?)`).run(conv, seq, role, text);
const sem = (env: any, scope: Scope, conv: string, seq: number, user: string, assistant: string) => d1Index(env.DB, async () => scope, env).indexExchange!({ conversationId: conv, seq, userText: user, assistantText: assistant, ts: 1 });

describe("pure helpers", () => {
  test("exchangeText caps and keeps both halves", () => {
    const t = exchangeText("u".repeat(5000), "a".repeat(5000));
    expect(t.length).toBeLessThanOrEqual(EXCHANGE_CAP); expect(t).toContain("u"); expect(t).toContain("a");
    expect(exchangeText("", "only assistant")).toBe("only assistant");
  });
  test("vector id <= 64 bytes, deterministic, scope-distinct; long guest scopes are hashed", async () => {
    const c = uuid(1);
    const ids = await Promise.all((["main", "main~open", GA, `${GA}~open`] as Scope[]).map((s) => vectorId(s, c, 12345)));
    for (const id of ids) expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64);
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toBe(`main:${c}:12345`); expect(ids[1]).toBe(`main~open:${c}:12345`);
    expect(await vectorId(GA, c, 7)).toBe(await vectorId(GA, c, 7));
    expect(await scopeKey("main~open" as Scope)).toBe("main~open");
    expect((await scopeKey(`${GA}~open` as Scope)).length).toBeLessThanOrEqual(64);
  });
  test("exchangesFromIndex pairs user -> assistant and joins chunks", () => {
    expect(exchangesFromIndex([{ message_seq: 1, role: "user", text: "q1" }, { message_seq: 2, role: "assistant", text: "a" }, { message_seq: 2, role: "assistant", text: "b" }, { message_seq: 3, role: "assistant", text: "  " }]))
      .toEqual([{ seq: 2, user: "q1", assistant: "ab" }]);
  });
});

describe("live indexing through the REAL engine hook", () => {
  const sse = (evs: ServerEvent[]) => { const enc = new TextEncoder(); let i = 0; return new Response(new ReadableStream({ pull(ctl) { if (i < evs.length) ctl.enqueue(enc.encode(`event: ${evs[i].type}\ndata: ${JSON.stringify(evs[i++])}\n\n`)); else ctl.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }); };
  const events = (text: string): ServerEvent[] => [{ type: "message_start", message: { id: "m", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 1 } } } as any,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any, { type: "content_block_stop", index: 0 } as any,
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } as any, { type: "message_stop" } as any];
  test("a finished turn upserts one vector with scope/conv/ts metadata + an embed usage row; tool results are never embedded", async () => {
    const env = mkEnv(); const vz = fakeVectorize(); const aiCalls: string[][] = [];
    (env as any).AI = fakeAI(aiCalls); (env as any).VECTORIZE = vz;
    seed(env, uuid(1), "main~open", "t");
    const doDb = new Database(":memory:");
    const engine = new ChatEngine({
      sql: { exec: (q, ...b) => { const st = doDb.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
      provider: { name: "stub", listModels: async () => [], messages: async (body: any) => body.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }) : sse(events("Use a cargo bike for tall pottery")) } as any,
      index: d1Index(env.DB, async () => "main~open" as Scope, env), sink: { broadcast: () => {} }, retryDelayMs: 1,
    });
    engine.setConvId(uuid(1));
    await engine.send("which bike carries ceramics", "claude-sonnet-5-5", [] as any);
    await Bun.sleep(50);
    expect(vz.store.size).toBe(1);
    const [v] = [...vz.store.values()];
    expect(v.id.startsWith(`main~open:${uuid(1)}:`)).toBe(true);
    expect(v.metadata).toMatchObject({ scope: "main~open", conv: uuid(1) }); expect(typeof v.metadata!.ts).toBe("number");
    expect(aiCalls[0][0]).toContain("which bike carries ceramics"); expect(aiCalls[0][0]).toContain("cargo bike");
    const u = env._db.query(`SELECT kind, units, scope, cost_usd FROM usage WHERE kind='embed'`).all() as any[];
    expect(u).toEqual([{ kind: "embed", units: 1, scope: "main~open", cost_usd: 0 }]);
  });
  test("an embedding failure never breaks the turn", async () => {
    const env = mkEnv(); (env as any).AI = { run: async () => { throw new Error("ai down"); } }; (env as any).VECTORIZE = fakeVectorize();
    seed(env, uuid(1), "main~open", "t");
    const doDb = new Database(":memory:"); const bc: any[] = [];
    const engine = new ChatEngine({
      sql: { exec: (q, ...b) => { const st = doDb.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
      provider: { name: "stub", listModels: async () => [], messages: async (body: any) => body.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }) : sse(events("fine")) } as any,
      index: d1Index(env.DB, async () => "main~open" as Scope, env), sink: { broadcast: (_s, _t, e) => bc.push(e) }, retryDelayMs: 1,
    });
    engine.setConvId(uuid(1)); await engine.send("hello", "claude-sonnet-5-5", [] as any); await Bun.sleep(50);
    expect(bc.some((e) => e.type === "assistant_saved")).toBe(true);
  });
  test("no bindings => the sink has no indexExchange and the engine still works", () => {
    expect(d1Index(mkEnv().DB, async () => "main" as Scope, {}).indexExchange).toBeUndefined();
  });
  test("the e2e tester never reaches Workers AI", async () => {
    const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    await sem(env, "e2e" as Scope, uuid(9), 2, "x", "y"); expect(vz.store.size).toBe(0);
  });
});

describe("search: real handler -> real palette logic", () => {
  // Semantic is Open-only: u1 + u3 are Open (indexed), u2 is Business (never indexed, found by keyword only).
  const setup = async () => {
    const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    seed(env, uuid(1), "main~open", "Open pottery logistics"); seed(env, uuid(2), "main", "Biz pottery notes"); seed(env, uuid(3), "main~open", "Unrelated taxes");
    idxMsg(env, uuid(1), 2, "assistant", "Ship ceramics in padded crates by sea freight");
    await sem(env, "main~open" as Scope, uuid(1), 2, "how do we move ceramics", "Ship ceramics in padded crates by sea freight");
    await sem(env, "main", uuid(2), 2, "how do we move ceramics", "Ship ceramics in padded crates by sea freight biz"); // no-op: Business
    await sem(env, "main~open" as Scope, uuid(3), 2, "income declaration", "File the annual tax form before March");
    return { env, vz };
  };
  test("semantic-only hit is returned (no shared keyword), with title + snippet, then reaches the palette item", async () => {
    const { env } = await setup();
    const r = (await (await call(env, "GET", "/api/conversations?q=" + encodeURIComponent("move ceramics"), "open")).json()) as any;
    expect(r.mode).toBe("semantic");
    const hit = r.conversations.find((c: any) => c.id === uuid(1));
    expect(hit.title).toBe("Open pottery logistics"); expect(hit.match).toBe("semantic"); expect(hit.snippet).toContain("padded crates");
    const item = chatItem(hit); expect(item).toMatchObject({ id: `c:${uuid(1)}`, label: "Open pottery logistics", path: `/c/${uuid(1)}`, hint: hit.snippet });
    expect(chatItem({ ...hit, match: undefined })).not.toHaveProperty("hint");
  });
  test("ISOLATION: Open never returns Business and Business never goes semantic", async () => {
    const { env, vz } = await setup();
    const open = (await (await call(env, "GET", "/api/conversations?q=move%20ceramics", "open")).json()) as any;
    expect(open.conversations.map((c: any) => c.id)).toEqual([uuid(1)]);
    const embedsBefore = vz.store.size;
    const biz = (await (await call(env, "GET", "/api/conversations?q=pottery", "biz")).json()) as any;
    expect(biz.mode).toBe("keyword"); expect(biz.conversations.map((c: any) => c.id)).toEqual([uuid(2)]);
    expect(vz.store.size).toBe(embedsBefore);
  });
  test("ISOLATION holds even if Vectorize ignored the filter (metadata re-check + D1 scope join)", async () => {
    const env = mkEnv(); const vz = fakeVectorize({ honorFilter: false }); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    seed(env, uuid(1), "main", "biz"); seed(env, uuid(2), "main~open", "open"); seed(env, uuid(4), `${GA}~open`, "guest open");
    await sem(env, "main", uuid(1), 2, "alpha topic", "alpha answer"); await sem(env, "main~open" as Scope, uuid(2), 2, "alpha topic", "alpha answer"); await sem(env, `${GA}~open` as Scope, uuid(4), 2, "alpha topic", "alpha answer");
    const r = (await (await call(env, "GET", "/api/conversations?q=alpha%20topic", "open")).json()) as any;
    expect(r.conversations.map((c: any) => c.id).sort()).toEqual([uuid(2)]);
    // a vector whose metadata CLAIMS main~open but whose conversation row belongs to another scope still cannot surface
    vz.store.set("evil", { id: "evil", values: vec("alpha topic"), metadata: { scope: "main~open", conv: uuid(1), msg: 2, ts: 1 } });
    const r2 = (await (await call(env, "GET", "/api/conversations?q=alpha%20topic", "open")).json()) as any;
    expect(r2.conversations.map((c: any) => c.id)).not.toContain(uuid(1));
  });
  test("falls back to FTS when VECTORIZE is absent: same rows, mode keyword, no error", async () => {
    const env = mkEnv(); seed(env, uuid(1), "main", "Pottery plan"); idxMsg(env, uuid(1), 2, "assistant", "kiln schedule");
    const r = await call(env, "GET", "/api/conversations?q=kiln"); expect(r.status).toBe(200);
    const j = (await r.json()) as any; expect(j.mode).toBe("keyword"); expect(j.conversations.map((c: any) => c.id)).toEqual([uuid(1)]);
  });
  test("embedding failure / rate limit => keyword result, still 200", async () => {
    const env = mkEnv(); (env as any).VECTORIZE = fakeVectorize(); (env as any).AI = { run: async () => { throw new Error("down"); } };
    seed(env, uuid(1), "main~open", "Pottery plan"); idxMsg(env, uuid(1), 2, "assistant", "kiln schedule");
    const r = await call(env, "GET", "/api/conversations?q=kiln", "open"); expect(r.status).toBe(200);
    expect(((await r.json()) as any).conversations.map((c: any) => c.id)).toEqual([uuid(1)]);
  });
  test("query embedding is capped and recorded as an embed usage unit; short queries skip semantic", async () => {
    const env = mkEnv(); const calls: string[][] = []; (env as any).AI = fakeAI(calls); (env as any).VECTORIZE = fakeVectorize();
    await call(env, "GET", "/api/conversations?q=" + "x".repeat(2000), "open");
    expect(calls[0][0].length).toBe(QUERY_CAP);
    expect((env._db.query(`SELECT COUNT(*) AS n FROM usage WHERE kind='embed' AND conversation_id IS NULL`).get() as any).n).toBe(1);
    await call(env, "GET", "/api/conversations?q=ab", "open"); expect(calls.length).toBe(1);
  });
});

describe("delete cleanup", () => {
  test("deleting a conversation deletes exactly its vectors (not a sibling scope's) and clears the tombstone", async () => {
    const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    seed(env, uuid(1), "main~open", "a"); idxMsg(env, uuid(1), 2, "assistant", "x"); idxMsg(env, uuid(1), 4, "assistant", "y");
    await sem(env, "main~open" as Scope, uuid(1), 2, "q", "x"); await sem(env, "main~open" as Scope, uuid(1), 4, "q2", "y");
    vz.store.set(`main:${uuid(1)}:2`, { id: `main:${uuid(1)}:2`, values: vec("q"), metadata: { scope: "main" } }); // same conv id + seq in ANOTHER scope: must survive
    const r = await call(env, "DELETE", `/api/conversations/${uuid(1)}`, "open"); expect(r.status).toBe(200);
    expect([...vz.store.keys()]).toEqual([`main:${uuid(1)}:2`]);
    expect((env._db.query(`SELECT COUNT(*) AS n FROM vec_pending_delete`).get() as any).n).toBe(0);
  });
  test("a failing Vectorize delete leaves a tombstone; the cron slice retries it", async () => {
    const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    seed(env, uuid(1), "main~open", "a"); idxMsg(env, uuid(1), 2, "assistant", "x"); await sem(env, "main~open" as Scope, uuid(1), 2, "q", "x");
    vz.fail = true;
    expect((await call(env, "DELETE", `/api/conversations/${uuid(1)}`, "open")).status).toBe(200); // the delete itself never fails because of Vectorize
    expect(vz.store.size).toBe(1); expect((env._db.query(`SELECT COUNT(*) AS n FROM vec_pending_delete`).get() as any).n).toBe(1);
    vz.fail = false; expect(await sweepVectorTombstones(env, env.DB)).toBe(1);
    expect(vz.store.size).toBe(0); expect((env._db.query(`SELECT COUNT(*) AS n FROM vec_pending_delete`).get() as any).n).toBe(0);
  });
  test("no VECTORIZE binding: delete works unchanged", async () => {
    const env = mkEnv(); seed(env, uuid(1), "main", "a"); expect((await call(env, "DELETE", `/api/conversations/${uuid(1)}`)).status).toBe(200);
  });
});

describe("backfill", () => {
  const mk = () => { const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    for (let i = 1; i <= 5; i++) { seed(env, uuid(i), "main~open", `c${i}`); idxMsg(env, uuid(i), 1, "user", `question ${i}`); idxMsg(env, uuid(i), 2, "assistant", `answer ${i}`); }
    seed(env, uuid(8), "main", "biz"); idxMsg(env, uuid(8), 1, "user", "bq"); idxMsg(env, uuid(8), 2, "assistant", "ba");
    return { env, vz }; };
  const O = "main~open" as Scope;
  const flag = (env: { _db: Database }, scope: string) => env._db.query(`INSERT INTO settings (name, value) VALUES (?, '1')`).run(`semantic_backfill:${scope}`);
  test("off by default: nothing runs, endpoint answers 409", async () => {
    const { env, vz } = mk();
    expect((await backfillSlice(env, env.DB, O)).ran).toBe(false); expect(vz.store.size).toBe(0);
    expect((await call(env, "POST", "/api/semantic/backfill", "open")).status).toBe(409);
    expect(((await (await call(env, "GET", "/api/semantic", "open")).json()) as any)).toEqual({ available: true, backfill: { on: false, done: false } });
  });
  test("bounded, resumable, scope-exact; finishes and reports done", async () => {
    const { env, vz } = mk(); flag(env, O);
    const a = await backfillSlice(env, env.DB, O); expect(a).toMatchObject({ ran: true, conversations: 3, vectors: 3, done: false });
    const b = await backfillSlice(env, env.DB, O); expect(b).toMatchObject({ conversations: 2, vectors: 2, done: true });
    expect((await backfillSlice(env, env.DB, O)).ran).toBe(false);
    expect(vz.store.size).toBe(5); for (const s of vz.store.values()) expect(s.metadata!.scope).toBe("main~open"); // Business conversation untouched
    const again = (await call(env, "GET", "/api/semantic", "open")).json(); expect(((await again) as any).backfill).toEqual({ on: true, done: true });
  });
  test("HTTP endpoint runs one slice for the caller's scope only; Business answers 409 even with its flag on", async () => {
    const { env, vz } = mk(); flag(env, "main~open"); flag(env, "main");
    expect((await call(env, "POST", "/api/semantic/backfill", "biz")).status).toBe(409);
    const r = (await (await call(env, "POST", "/api/semantic/backfill", "open")).json()) as any;
    expect(r).toMatchObject({ vectors: 3, done: false }); for (const s of vz.store.values()) expect(s.metadata!.scope).toBe("main~open");
  });
  test("no bindings: endpoint 503, status says unavailable", async () => {
    const env = mkEnv(); expect((await call(env, "POST", "/api/semantic/backfill", "open")).status).toBe(503);
    expect(((await (await call(env, "GET", "/api/semantic", "open")).json()) as any).available).toBe(false);
  });
});

describe("Business is Vertex-only: Workers AI / Vectorize are never touched", () => {
  const spied = () => { const env = mkEnv(); const aiCalls: string[][] = []; const vz = fakeVectorize(); let vcalls = 0;
    const wrap = <T extends object>(o: T) => new Proxy(o, { get: (t: any, k) => (typeof t[k] === "function" ? (...a: any[]) => { vcalls++; return t[k](...a); } : t[k]) });
    (env as any).AI = fakeAI(aiCalls); (env as any).VECTORIZE = wrap(vz);
    return { env, aiCalls, vz, vcalls: () => vcalls }; };
  test("index-after-turn, search, backfill (endpoint + helper + cron): 0 AI.run, 0 VECTORIZE calls, nothing indexed", async () => {
    const { env, aiCalls, vz, vcalls } = spied();
    for (const sc of ["main", GA, "e2e"] as Scope[]) expect(await sem(env, sc, uuid(1), 2, "alpha topic", "alpha answer")).toBeUndefined();
    seed(env, uuid(1), "main", "Alpha plan"); idxMsg(env, uuid(1), 2, "assistant", "alpha answer");
    const r = (await (await call(env, "GET", "/api/conversations?q=alpha", "biz")).json()) as any;
    expect(r.mode).toBe("keyword"); expect(r.conversations.map((c: any) => c.id)).toEqual([uuid(1)]); // FTS fallback still finds it
    env._db.query(`INSERT INTO settings (name, value) VALUES ('semantic_backfill:main', '1')`).run();
    expect((await call(env, "POST", "/api/semantic/backfill", "biz")).status).toBe(409);
    expect(((await (await call(env, "GET", "/api/semantic", "biz")).json()) as any).available).toBe(false);
    expect(await backfillSlice(env, env.DB, "main")).toMatchObject({ ran: false, vectors: 0 });
    expect(await backfillCron(env, env.DB)).toBe(0);
    expect(aiCalls.length).toBe(0); expect(vcalls()).toBe(0); expect(vz.store.size).toBe(0);
    expect((env._db.query(`SELECT COUNT(*) AS n FROM usage WHERE kind='embed'`).get() as any).n).toBe(0);
    expect(env._db.query(`SELECT value FROM settings WHERE name LIKE 'semantic_cursor:%'`).all()).toEqual([]);
  });
  test("delete cleanup still removes vectors for a Business conversation that may have legacy ones", async () => {
    const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    seed(env, uuid(1), "main", "a"); idxMsg(env, uuid(1), 2, "assistant", "x");
    vz.store.set(`main:${uuid(1)}:2`, { id: `main:${uuid(1)}:2`, values: vec("x"), metadata: { scope: "main" } });
    expect((await call(env, "DELETE", `/api/conversations/${uuid(1)}`, "biz")).status).toBe(200);
    expect(vz.store.size).toBe(0);
  });
});

describe("review fixes (cfmem-fix2)", () => {
  const O = "main~open" as Scope;
  const spy = (env: any, vz = fakeVectorize()) => { const calls = { ai: 0, v: 0 };
    env.AI = { run: async (m: string, i: any) => { calls.ai++; return fakeAI().run(m, i); } };
    env.VECTORIZE = new Proxy(vz, { get: (t: any, k) => (typeof t[k] === "function" ? (...a: any[]) => { calls.v++; return t[k](...a); } : t[k]) });
    return { calls, vz }; };
  test("2 race: a tombstoned or deleted conversation is never indexed", async () => {
    const env = mkEnv(); const { calls, vz } = spy(env);
    expect(await sem(env, O, uuid(1), 2, "q", "a")).toBeUndefined(); // no conversation row
    seed(env, uuid(1), "main~open", "t"); env._db.query(`INSERT INTO vec_pending_delete (conversation_id, scope, max_seq) VALUES (?,?,2)`).run(uuid(1), "main~open");
    await sem(env, O, uuid(1), 2, "q", "a");
    expect(calls.ai).toBe(0); expect(vz.store.size).toBe(0);
  });
  test("2 race: deleted while embedding -> no upsert; deleted during upsert -> the vector written is removed", async () => {
    const env = mkEnv(); const vz = fakeVectorize(); seed(env, uuid(1), "main~open", "t"); (env as any).VECTORIZE = vz;
    (env as any).AI = { run: async (m: string, i: any) => { env._db.query(`DELETE FROM conversations WHERE id=?`).run(uuid(1)); return fakeAI().run(m, i); } };
    await sem(env, O, uuid(1), 2, "q", "a"); expect(vz.store.size).toBe(0);
    const env2 = mkEnv(); const vz2 = fakeVectorize(); seed(env2, uuid(1), "main~open", "t"); (env2 as any).AI = fakeAI();
    (env2 as any).VECTORIZE = { ...vz2, upsert: async (v: any) => { await vz2.upsert(v); env2._db.query(`DELETE FROM conversations WHERE id=?`).run(uuid(1)); return {}; }, deleteByIds: vz2.deleteByIds, query: vz2.query };
    await sem(env2, O, uuid(1), 2, "q", "a"); expect(vz2.store.size).toBe(0); expect(vz2.deleted).toEqual([`main~open:${uuid(1)}:2`]);
  });
  test("3 cleanup beyond 5000 seqs: tombstone survives with a lowered cursor until nothing remains", async () => {
    const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    seed(env, uuid(1), "main~open", "t"); idxMsg(env, uuid(1), 50000, "assistant", "x");
    const id = (n: number) => `main~open:${uuid(1)}:${n}`;
    for (const n of [1, 4999, 5001, 49999, 50000]) vz.store.set(id(n), { id: id(n), values: vec("x"), metadata: { scope: "main~open" } });
    expect((await call(env, "DELETE", `/api/conversations/${uuid(1)}`, "open")).status).toBe(200);
    const row = env._db.query(`SELECT max_seq FROM vec_pending_delete`).get() as any;
    expect(row.max_seq).toBeLessThan(50000); expect(row.max_seq).toBeGreaterThan(0); // out of per-run budget: kept, not cleared
    expect(vz.store.has(id(50000))).toBe(false);
    let guard = 0; while ((env._db.query(`SELECT COUNT(*) AS n FROM vec_pending_delete`).get() as any).n && guard++ < 100) await sweepVectorTombstones(env, env.DB);
    expect(vz.store.size).toBe(0); expect(guard).toBeGreaterThan(0);
  });
  test("3 a mid-way failure keeps the tombstone at the remaining cursor", async () => {
    const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    seed(env, uuid(1), "main~open", "t"); idxMsg(env, uuid(1), 250, "assistant", "x");
    let n = 0; const orig = vz.deleteByIds; vz.deleteByIds = async (ids) => { if (++n === 2) throw new Error("down"); return orig(ids); };
    await call(env, "DELETE", `/api/conversations/${uuid(1)}`, "open");
    expect((env._db.query(`SELECT max_seq FROM vec_pending_delete`).get() as any).max_seq).toBe(150);
    vz.deleteByIds = orig; expect(await sweepVectorTombstones(env, env.DB)).toBe(1);
  });
  test("4 readiness: binding alone is not enough (no flag / flag off / migration 0028 missing => 0 AI.run, 0 VECTORIZE, FTS only, backfill 409)", async () => {
    for (const mode of ["noflag", "off", "nomigration"]) {
      const env = mkEnv(); const { calls, vz } = spy(env);
      if (mode === "noflag") env._db.query(`DELETE FROM settings WHERE name LIKE 'semantic_ready:%'`).run();
      if (mode === "off") env._db.query(`UPDATE settings SET value='0' WHERE name LIKE 'semantic_ready:%'`).run();
      if (mode === "nomigration") env._db.query(`DROP TABLE vec_pending_delete`).run();
      seed(env, uuid(1), "main~open", "Alpha plan"); idxMsg(env, uuid(1), 2, "assistant", "alpha answer");
      await sem(env, O, uuid(1), 2, "alpha", "alpha answer");
      const r = (await (await call(env, "GET", "/api/conversations?q=alpha", "open")).json()) as any;
      expect(r.mode).toBe("keyword"); expect(r.conversations.map((c: any) => c.id)).toEqual([uuid(1)]);
      env._db.query(`INSERT INTO settings (name, value) VALUES ('semantic_backfill:main~open', '1')`).run();
      expect((await call(env, "POST", "/api/semantic/backfill", "open")).status).toBe(409);
      expect(await backfillCron(env, env.DB)).toBe(0);
      expect(((await (await call(env, "GET", "/api/semantic", "open")).json()) as any).available).toBe(false);
      expect(calls.ai).toBe(0); expect(calls.v).toBe(0); expect(vz.store.size).toBe(0);
    }
  });
  test("1 every removal path tombstones: failed-fork rollback and delete both go through removeConversationRows", async () => {
    const { removeConversationRows } = await import("../src/index");
    const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    seed(env, uuid(1), "main~open", "t"); idxMsg(env, uuid(1), 2, "assistant", "x"); await sem(env, O, uuid(1), 2, "q", "x");
    expect(vz.store.size).toBe(1);
    await removeConversationRows(env, uuid(1), O, async (p) => { await p; });
    expect(vz.store.size).toBe(0); expect(env._db.query(`SELECT 1 FROM conversations WHERE id=?`).get(uuid(1))).toBeNull();
    expect((env._db.query(`SELECT COUNT(*) AS n FROM vec_pending_delete`).get() as any).n).toBe(0);
  });
  test("5 cron: finished scopes do not starve others; the window rotates", async () => {
    const env = mkEnv(); const vz = fakeVectorize(); (env as any).AI = fakeAI(); (env as any).VECTORIZE = vz;
    const bases = Array.from({ length: 7 }, (_, i) => `g:${String.fromCharCode(97 + i).repeat(24)}`);
    for (const b of bases) { env._db.query(`INSERT INTO settings (name, value) VALUES (?, '1')`).run(`semantic_ready:${b}`); env._db.query(`INSERT INTO settings (name, value) VALUES (?, '1')`).run(`semantic_backfill:${b}~open`);
      seed(env, uuid(100 + bases.indexOf(b)), `${b}~open`, "c"); idxMsg(env, uuid(100 + bases.indexOf(b)), 1, "user", "q"); idxMsg(env, uuid(100 + bases.indexOf(b)), 2, "assistant", "a"); }
    for (const b of bases.slice(0, 5)) env._db.query(`INSERT INTO settings (name, value) VALUES (?, '~')`).run(`semantic_cursor:${b}~open`); // five finished scopes sort first
    expect(await backfillCron(env, env.DB)).toBe(2); // the two unfinished ones still run
    expect(vz.store.size).toBe(2);
    // rotation: 7 unfinished scopes, 5 per run -> the second run reaches the other 2
    const env2 = mkEnv(); const vz2 = fakeVectorize(); (env2 as any).AI = fakeAI(); (env2 as any).VECTORIZE = vz2;
    for (const b of bases) { env2._db.query(`INSERT INTO settings (name, value) VALUES (?, '1')`).run(`semantic_ready:${b}`); env2._db.query(`INSERT INTO settings (name, value) VALUES (?, '1')`).run(`semantic_backfill:${b}~open`);
      const i = bases.indexOf(b); for (let k = 0; k < 4; k++) { const id = uuid(200 + i * 10 + k); seed(env2, id, `${b}~open`, "c"); idxMsg(env2, id, 1, "user", "q"); idxMsg(env2, id, 2, "assistant", "a"); } }
    await backfillCron(env2, env2.DB); await backfillCron(env2, env2.DB);
    const touched = new Set([...vz2.store.values()].map((v) => v.metadata!.scope)); expect(touched.size).toBe(7);
  });
});
