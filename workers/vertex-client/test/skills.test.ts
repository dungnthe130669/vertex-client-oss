import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { SEED, expandSkill, listSkills, MAX_SKILLS, MAX_TEMPLATE, MAX_DESCRIPTION, MAX_INPUT_MARKERS, skillTemplate, validateSkill } from "../src/skills";
import { ChatEngine, type IndexSink, type ServerEvent } from "../src/turn-engine";
import type { ModelProvider } from "../src/providers/types";
import type { SlashItem } from "../src/slash";

const ORIGIN = "https://app.test";
const MIGS = ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0009_usage_generation.sql", "0011_usage_dispatch.sql", "0012_scope_hardening.sql", "0018_projects.sql", "0010_skills.sql"];
function d1() {
  const db = new Database(":memory:");
  for (const f of MIGS) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as D1Database };
}
const CHAT = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ tools: [] }) }) } as unknown as DurableObjectNamespace;
const mkEnv = (dbx = d1()) => ({ SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", E2E_TOKEN: TOKEN, ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: dbx.d1, CHAT, _db: dbx.db }) as unknown as Env & { _db: Database };
const app = createApp();
type A = { cookie: string; csrf: string };
const main = async (env: Env): Promise<A> => { const { cookie, session } = await makeSession(env, "example-user", "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const TOKEN = "t".repeat(64);
const bot = async (env: Env): Promise<A> => { // the real bypass login: scope 'e2e'
  const r = await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": TOKEN } }), env);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json() as any;
  return { cookie, csrf: me.csrf };
};
const api = (env: Env, path: string, a?: A, method = "GET", body?: unknown) => {
  const h = new Headers({ origin: ORIGIN });
  if (a) { h.set("cookie", a.cookie); if (method !== "GET") h.set("x-csrf-token", a.csrf); }
  if (body !== undefined) h.set("content-type", "application/json");
  return app.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};
const make = (env: Env, a: A, name: string, extra: Record<string, unknown> = {}) => api(env, "/api/skills", a, "POST", { name, template: "T {{input}}", ...extra });

describe("validateSkill {{input}} marker limit", () => {
  test("more than 5 markers rejected at create and update (400); exactly 5 ok", async () => {
    expect(validateSkill({ name: "ab", template: "{{input}}".repeat(5) }, false).ok).toBe(true);
    const bad = validateSkill({ name: "ab", template: "{{input}}".repeat(6) }, false);
    expect(bad.ok).toBe(false);
    expect(validateSkill({ template: "{{input}}".repeat(6) }, true).ok).toBe(false);
    const env = mkEnv(); const a = await main(env);
    expect((await make(env, a, "six-markers", { template: "{{input}}".repeat(6) })).status).toBe(400);
  });
});

describe("validateSkill", () => {
  const ok = (b: any, partial = false) => validateSkill(b, partial);
  test("name format", () => {
    for (const n of ["a", "A-b", "has space", "under_score", "x".repeat(33), "", 5, null]) expect(ok({ name: n, template: "t" }).ok).toBe(false);
    for (const n of ["ab", "a-1", "x".repeat(32)]) expect(ok({ name: n, template: "t" }).ok).toBe(true);
  });
  test("collides with built-ins and tool names", () => {
    for (const n of ["model", "clear", "compact", "image", "video"]) expect(ok({ name: n, template: "t" })).toMatchObject({ ok: false });
  });
  test("limits", () => {
    expect(ok({ name: "ab", template: "x".repeat(MAX_TEMPLATE) }).ok).toBe(true);
    expect(ok({ name: "ab", template: "x".repeat(MAX_TEMPLATE + 1) }).ok).toBe(false);
    expect(ok({ name: "ab", template: "t", description: "d".repeat(MAX_DESCRIPTION + 1) }).ok).toBe(false);
    expect(ok({ name: "ab", template: "  " }).ok).toBe(false);
    expect(ok({ name: "ab" }).ok).toBe(false);
    expect(ok({ description: "x" }, true).ok).toBe(true); // partial update
    expect(ok({ name: "ab", template: "t", tools: ["a b"] }).ok).toBe(false);
  });
});

describe("/api/skills", () => {
  test("401 unauthenticated on every verb", async () => {
    const env = mkEnv();
    for (const [m, p] of [["GET", "/api/skills"], ["POST", "/api/skills"], ["PATCH", "/api/skills/x"], ["DELETE", "/api/skills/x"]] as const) expect((await api(env, p, undefined, m, {})).status).toBe(401);
  });
  test("main: first list seeds the 4 starters once; deleting them all does not re-seed", async () => {
    const env = mkEnv(); const a = await main(env);
    const l1 = (await (await api(env, "/api/skills", a)).json() as any).skills;
    expect(l1.map((s: any) => s.name).sort()).toEqual(["code-review", "explain-simple", "summarize", "translate-vi-en"]);
    expect(l1.every((s: any) => s.template.includes("{{input}}"))).toBe(true);
    expect((await (await api(env, "/api/skills", a)).json() as any).skills.length).toBe(4); // idempotent
    for (const s of l1) expect((await api(env, `/api/skills/${s.id}`, a, "DELETE", {})).status).toBe(200);
    expect((await (await api(env, "/api/skills", a)).json() as any).skills).toEqual([]);
    expect(SEED.length).toBe(4);
  });
  test("create / list / update / delete round trip", async () => {
    const env = mkEnv(); const a = await main(env);
    const r = await make(env, a, "my-skill", { description: "d", tools: ["search_notes"] });
    expect(r.status).toBe(201);
    const s = (await r.json() as any).skill;
    expect(s).toMatchObject({ name: "my-skill", description: "d", template: "T {{input}}", tools: ["search_notes"] });
    const u = await api(env, `/api/skills/${s.id}`, a, "PATCH", { template: "new {{input}}", name: "my-skill2" });
    expect(u.status).toBe(200);
    expect((await u.json() as any).skill).toMatchObject({ name: "my-skill2", template: "new {{input}}", description: "d", tools: ["search_notes"] });
    expect((await api(env, `/api/skills/${s.id}`, a, "DELETE", {})).status).toBe(200);
    expect((await api(env, `/api/skills/${s.id}`, a, "DELETE", {})).status).toBe(404);
    expect((await api(env, `/api/skills/${s.id}`, a, "PATCH", { description: "x" })).status).toBe(404);
  });
  test("validation + collisions over HTTP", async () => {
    const env = mkEnv(); const a = await main(env);
    expect((await make(env, a, "BAD NAME")).status).toBe(400);
    expect((await make(env, a, "model")).status).toBe(400);
    expect((await make(env, a, "ok-name", { template: "x".repeat(MAX_TEMPLATE + 1) })).status).toBe(400);
    expect((await make(env, a, "summarize")).status).toBe(409); // seeded name
    expect((await make(env, a, "dup-one")).status).toBe(201);
    expect((await make(env, a, "dup-one")).status).toBe(409);
    const other = (await (await make(env, a, "other-one")).json() as any).skill;
    expect((await api(env, `/api/skills/${other.id}`, a, "PATCH", { name: "dup-one" })).status).toBe(409);
    expect((await api(env, `/api/skills/${other.id}`, a, "PATCH", { name: "clear" })).status).toBe(400);
  });
  test(`at most ${MAX_SKILLS} skills per scope`, async () => {
    const env = mkEnv(); const a = await bot(env);
    for (let i = 0; i < MAX_SKILLS; i++) env._db.query(`INSERT INTO skills (id, name, template, scope) VALUES (?,?,?,'e2e')`).run(`i${i}`, `s-${i}`, "t");
    expect((await make(env, a, "one-too-many")).status).toBe(409);
    const m = await main(env); // another scope is unaffected
    expect((await make(env, m, "one-too-many")).status).toBe(201);
  });
  test("scope isolation: e2e and main never see or touch each other's skills, even with the same name", async () => {
    const env = mkEnv(); const m = await main(env), e = await bot(env);
    const ms = (await (await make(env, m, "shared-name")).json() as any).skill;
    expect((await (await api(env, "/api/skills", e)).json() as any).skills).toEqual([]); // e2e is not seeded and sees no main skill
    expect((await make(env, e, "shared-name", { template: "E2E {{input}}" })).status).toBe(201); // no cross-scope collision / existence leak
    const es = (await (await api(env, "/api/skills", e)).json() as any).skills;
    expect(es.length).toBe(1);
    expect((await api(env, `/api/skills/${ms.id}`, e, "PATCH", { description: "hax" })).status).toBe(404);
    expect((await api(env, `/api/skills/${ms.id}`, e, "DELETE", {})).status).toBe(404);
    expect((await api(env, `/api/skills/${es[0].id}`, m, "DELETE", {})).status).toBe(404);
    const mainList = (await (await api(env, "/api/skills", m)).json() as any).skills;
    expect(mainList.find((s: any) => s.id === ms.id).description).toBe("");
    expect(await skillTemplate(env.DB, "e2e", "shared-name")).toBe("E2E {{input}}");
    expect(await skillTemplate(env.DB, "main", "shared-name")).toBe("T {{input}}");
  });
  test("listSkills(main) seeds only when the flag is unset and no main rows exist", async () => {
    const env = mkEnv();
    env._db.query(`INSERT INTO skills (id, name, template, scope) VALUES ('x','mine','t','main')`).run();
    expect((await listSkills(env.DB, "main")).map((s) => s.name)).toEqual(["mine"]); // table not empty -> no seed
    expect((await listSkills(env.DB, "main")).length).toBe(1);
  });
});

describe("GET /api/slash includes skills", () => {
  test("scope-correct, group Skills, kind skill", async () => {
    const env = mkEnv(); const m = await main(env), e = await bot(env);
    await make(env, e, "e2e-only", { description: "from e2e" });
    const mi = (await (await api(env, "/api/slash", m)).json() as any).items as SlashItem[];
    expect(mi.filter((i) => i.kind === "skill").map((i) => i.name).sort()).toEqual(["code-review", "explain-simple", "summarize", "translate-vi-en"]);
    expect(mi.find((i) => i.name === "summarize")).toEqual({ kind: "skill", name: "summarize", description: SEED[0].description, group: "Skills" });
    expect(mi.some((i) => i.name === "e2e-only")).toBe(false);
    const ei = (await (await api(env, "/api/slash", e)).json() as any).items as SlashItem[];
    expect(ei.filter((i) => i.kind === "skill")).toEqual([{ kind: "skill", name: "e2e-only", description: "from e2e", group: "Skills" }]);
  });
  test("401 unauth", async () => { expect((await api(mkEnv(), "/api/slash")).status).toBe(401); });
});

describe("expandSkill", () => {
  test("placeholder replaced (all occurrences, $ safe); /name token removed", () => {
    expect(expandSkill("A {{input}} B {{input}}", "sum", "/sum hello $& world")).toBe("A hello $& world B hello $& world");
  });
  test("no placeholder: template then user text; no text: template alone", () => {
    expect(expandSkill("Do it.", "sum", "/sum hi")).toBe("Do it.\n\nhi");
    expect(expandSkill("Do it.", "sum", "/sum")).toBe("Do it.");
  });
  test("token in the middle / not a prefix match", () => {
    expect(expandSkill("[{{input}}]", "sum", "see /sum this")).toBe("[see this]");
    expect(expandSkill("[{{input}}]", "sum", "/summary x")).toBe("[/summary x]");
  });
});

describe("turn engine skill expansion", () => {
  const sse = (evs: ServerEvent[]) => { const enc = new TextEncoder(); let i = 0; return new Response(new ReadableStream({ pull(c) { if (i < evs.length) c.enqueue(enc.encode(`data: ${JSON.stringify(evs[i++])}\n\n`)); else c.close(); } }), { status: 200 }); };
  const done = (): ServerEvent[] => [{ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
  function rig(templates: Record<string, string>, fail = false) {
    const db = new Database(":memory:"); const calls: any[] = []; const looked: string[] = [];
    const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => { calls.push(b); return b.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }) : sse(done()); } };
    const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
    const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } }, provider, index, sink: { broadcast: () => {} }, retryDelayMs: 1, skills: async (n) => { looked.push(n); if (fail) throw new Error("d1 down"); return templates[n] ?? null; } });
    engine.setConvId("conv-1");
    return { engine, calls: () => calls.filter((c) => c.stream), looked };
  }
  const textsOf = (m: any) => m.content.filter((b: any) => b.type === "text").map((b: any) => b.text);
  test("model sees the expanded template; stored message keeps the user's text; replay is stable", async () => {
    const r = rig({ sum: "Summarize:\n{{input}}" });
    await r.engine.send("/sum the cat sat", undefined, [], { kind: "skill", name: "sum" });
    expect(textsOf(r.calls()[0].messages[0])).toEqual(["Summarize:\nthe cat sat"]);
    expect(r.engine.messages()[0].content).toEqual([{ type: "text", text: "/sum the cat sat" }]);
    await r.engine.send("thanks");
    expect(textsOf(r.calls()[1].messages[0])).toEqual(["Summarize:\nthe cat sat"]);
    expect(textsOf(r.calls()[1].messages.at(-1))).toEqual(["thanks"]);
    expect(r.calls()[0].tool_choice).toBeUndefined();
  });
  test("no placeholder: template then user text", async () => {
    const r = rig({ tpl: "Always be brief." });
    await r.engine.send("/tpl why is the sky blue", undefined, [], { kind: "skill", name: "tpl" });
    expect(textsOf(r.calls()[0].messages[0])).toEqual(["Always be brief.\n\nwhy is the sky blue"]);
  });
  test("unknown skill, bad name and non-skill kinds -> plain message, no error", async () => {
    for (const [slash, fail] of [[{ kind: "skill", name: "nope" }, false], [{ kind: "skill", name: "Bad_Name" }, false], [{ kind: "builtin", name: "sum" }, false], [{ kind: "skill", name: 5 }, false]] as const) {
      const r = rig({ sum: "X {{input}}" }, fail);
      const res = await r.engine.send("/sum hello", undefined, [], slash as any);
      expect(res).toEqual({ ok: true });
      expect(textsOf(r.calls()[0].messages[0])).toEqual(["/sum hello"]);
    }
  });
  test("lookup ERROR fails closed: user-visible error, nothing stored, no provider call; engine usable afterwards", async () => {
    const r = rig({ sum: "X {{input}}" }, true);
    const res = await r.engine.send("/sum hello", undefined, [], { kind: "skill", name: "sum" });
    expect(res).toEqual({ ok: false, error: "Skill lookup failed, try again" });
    expect(r.calls().length).toBe(0);
    expect(r.engine.messages()).toEqual([]);
    expect(await r.engine.send("plain")).toEqual({ ok: true }); // not stuck busy
    expect(textsOf(r.calls()[0].messages[0])).toEqual(["plain"]);
  });
  test("expanded text over the hard cap -> error, nothing stored, no provider call", async () => {
    const r = rig({ big: "{{input}}".repeat(MAX_INPUT_MARKERS) });
    const res = await r.engine.send("/big " + "a".repeat(50_000), undefined, [], { kind: "skill", name: "big" });
    expect(res.ok).toBe(false);
    expect(r.calls().length).toBe(0);
    expect(r.engine.messages()).toEqual([]);
    const ok = await r.engine.send("/big " + "a".repeat(30_000), undefined, [], { kind: "skill", name: "big" });
    expect(ok).toEqual({ ok: true });
    expect(MAX_INPUT_MARKERS * 100_000).toBeLessThan(1_000_000); // worst case bounded (5 x MAX_USER_CHARS)
  });
  test("a send without slash never looks anything up", async () => {
    const r = rig({ sum: "X" });
    await r.engine.send("/sum hello");
    expect(r.looked).toEqual([]);
  });
});
