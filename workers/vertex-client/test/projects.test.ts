// Projects: validation, /api/projects + conversation assignment routes (scope isolation, 403 for g:*), and the system prompt
// (project block for main only, pinned per turn, fail closed).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession, type Session } from "../src/auth";
import { scopeOfSession, type Scope, type GuestScope } from "../src/scope";
import { MAX_PROJECTS, MAX_PROJECT_INSTRUCTIONS, MAX_PROJECT_NAME, projectInstructions, projectSystemText, validateProject } from "../src/projects";
import { MAX_INSTRUCTIONS } from "../src/profile";
import { SYSTEM_PROMPT } from "../src/system-prompt";
import { ChatEngine, buildRequest, type IndexSink } from "../src/turn-engine";
import type { ModelProvider } from "../src/providers/types";

const ORIGIN = "https://app.test";
const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
const seam = (s: Session): Scope => (s.u === "guest-a" ? GA : scopeOfSession(s));
const app = createApp({ scopeOf: seam });
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
  const d = { prepare: (q: string) => stmt(q), batch: async (l: any[]) => { for (const s of l) s._run(); return []; } } as unknown as D1Database;
  return { db, d1: d };
}
const mkEnv = () => { const x = d1(); return { env: { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k", E2E_TOKEN: "e2e-test-token-0123456789abcdef0123456789abcdef", ASSETS: { fetch: async () => new Response("x") }, DB: x.d1 } as unknown as Env, db: x.db, d1: x.d1 }; };
type A = { cookie: string; csrf: string };
const bot = async (env: Env): Promise<A> => {
  const r = await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": (env as any).E2E_TOKEN } }), env);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json() as any;
  return { cookie, csrf: me.csrf };
};
const login = async (env: Env, user: string): Promise<A> => { const { cookie, session } = await makeSession(env, user, "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const api = (env: Env, a: A, method: string, path: string, body?: unknown) => {
  const h = new Headers({ origin: ORIGIN, cookie: a.cookie });
  if (method !== "GET") h.set("x-csrf-token", a.csrf);
  if (body !== undefined) h.set("content-type", "application/json");
  return app.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};
const seedConv = (db: Database, id: string, scope: string) => db.query(`INSERT INTO conversations (id, model, scope) VALUES (?,?,?)`).run(id, "claude-sonnet-5-5", scope);

describe("validateProject", () => {
  test("create needs a name; limits are exact; control chars stripped like Profile", () => {
    expect(validateProject({ name: "  Site  ", instructions: "a\nb\u0000" }, true)).toEqual({ ok: true, v: { name: "Site", instructions: "a\nb" } });
    expect(validateProject({}, true).ok).toBe(false);
    expect(validateProject({ name: " " }, true).ok).toBe(false);
    expect(validateProject({ name: "x".repeat(MAX_PROJECT_NAME) }, true).ok).toBe(true);
    expect(validateProject({ name: "x".repeat(MAX_PROJECT_NAME + 1) }, true).ok).toBe(false);
    expect(validateProject({ name: "n", instructions: "x".repeat(MAX_PROJECT_INSTRUCTIONS) }, true).ok).toBe(true);
    expect(validateProject({ name: "n", instructions: "x".repeat(MAX_PROJECT_INSTRUCTIONS + 1) }, true).ok).toBe(false);
    expect(MAX_PROJECT_INSTRUCTIONS).toBeGreaterThan(MAX_INSTRUCTIONS);
  });
  test("patch is partial; empty / non-object / non-string / blank name rejected", () => {
    expect(validateProject({ instructions: "" }, false)).toEqual({ ok: true, v: { instructions: "" } });
    for (const b of [{}, null, [], "x", { name: 5 }, { name: "" }, { instructions: null }]) expect(validateProject(b, false).ok).toBe(false);
  });
});

describe("/api/projects", () => {
  test("CRUD for main; list shows chat counts; archive un-assigns chats and hides the project", async () => {
    const { env, db } = mkEnv(); const m = await login(env, "example-user");
    const r = await api(env, m, "POST", "/api/projects", { name: "Site", instructions: "Use Astro." });
    expect(r.status).toBe(201);
    const p = await r.json() as any;
    seedConv(db, uuid(1), "main"); seedConv(db, uuid(2), "main");
    expect((await api(env, m, "PATCH", `/api/conversations/${uuid(1)}`, { project_id: p.id })).status).toBe(200);
    expect(((await (await api(env, m, "GET", "/api/projects")).json()) as any).projects[0]).toMatchObject({ id: p.id, name: "Site", chatCount: 1 });
    const mine = await (await api(env, m, "GET", `/api/conversations?project=${p.id}`)).json() as any;
    expect(mine.conversations.map((c: any) => c.id)).toEqual([uuid(1)]);
    expect((await api(env, m, "PATCH", `/api/projects/${p.id}`, { name: "Site 2" })).status).toBe(200);
    expect(((await (await api(env, m, "GET", `/api/projects/${p.id}`)).json()) as any)).toMatchObject({ name: "Site 2", instructions: "Use Astro." });
    expect((await api(env, m, "DELETE", `/api/projects/${p.id}`)).status).toBe(200);
    expect((await api(env, m, "GET", `/api/projects/${p.id}`)).status).toBe(404);
    expect(db.query(`SELECT archived FROM projects WHERE id=?`).get(p.id)).toEqual({ archived: 1 }); // archived, not hard-deleted
    expect(db.query(`SELECT project_id FROM conversations WHERE id=?`).get(uuid(1))).toEqual({ project_id: null });
    expect(((await (await api(env, m, "GET", "/api/projects")).json()) as any).projects).toEqual([]);
    expect((await api(env, m, "PATCH", `/api/conversations/${uuid(2)}`, { project_id: p.id })).status).toBe(404); // archived = gone
  });
  test("POST /api/conversations accepts project_id (404 for unknown / foreign); PATCH null clears", async () => {
    const { env, db } = mkEnv(); const m = await login(env, "example-user"), t = await bot(env);
    const p = await (await api(env, m, "POST", "/api/projects", { name: "A" })).json() as any;
    const pe = await (await api(env, t, "POST", "/api/projects", { name: "E" })).json() as any;
    const c = await api(env, m, "POST", "/api/conversations", { project_id: p.id });
    expect(c.status).toBe(201);
    const cid = (await c.json() as any).id;
    expect(db.query(`SELECT project_id FROM conversations WHERE id=?`).get(cid)).toEqual({ project_id: p.id });
    expect((await api(env, m, "POST", "/api/conversations", { project_id: pe.id })).status).toBe(404);
    expect((await api(env, m, "POST", "/api/conversations", { project_id: uuid(9) })).status).toBe(404);
    expect((await api(env, m, "POST", "/api/conversations", { project_id: 5 })).status).toBe(404);
    expect((await api(env, m, "PATCH", `/api/conversations/${cid}`, { project_id: null })).status).toBe(200);
    expect(db.query(`SELECT project_id FROM conversations WHERE id=?`).get(cid)).toEqual({ project_id: null });
    expect((await api(env, m, "PATCH", `/api/conversations/${cid}`, { project_id: 7 })).status).toBe(400);
  });
  test("cross-scope: main and e2e cannot see, edit, archive or assign each other's projects; g:* gets 403 everywhere", async () => {
    const { env, db } = mkEnv(); const m = await login(env, "example-user"), t = await bot(env), g = await login(env, "guest-a");
    const pm = await (await api(env, m, "POST", "/api/projects", { name: "Mine", instructions: "SECRET-M" })).json() as any;
    const pe = await (await api(env, t, "POST", "/api/projects", { name: "Bot" })).json() as any;
    expect(((await (await api(env, t, "GET", "/api/projects")).json()) as any).projects.map((x: any) => x.id)).toEqual([pe.id]);
    expect((await api(env, t, "GET", `/api/projects/${pm.id}`)).status).toBe(404);
    expect((await api(env, t, "PATCH", `/api/projects/${pm.id}`, { name: "x" })).status).toBe(404);
    expect((await api(env, t, "DELETE", `/api/projects/${pm.id}`)).status).toBe(404);
    seedConv(db, uuid(1), "e2e"); seedConv(db, uuid(2), "main");
    expect((await api(env, t, "PATCH", `/api/conversations/${uuid(1)}`, { project_id: pm.id })).status).toBe(404); // foreign project
    expect((await api(env, t, "PATCH", `/api/conversations/${uuid(2)}`, { project_id: pe.id })).status).toBe(404); // foreign conversation
    expect(db.query(`SELECT project_id FROM conversations WHERE id IN (?,?) AND project_id IS NOT NULL`).all(uuid(1), uuid(2))).toEqual([]);
    expect(db.query(`SELECT name, archived FROM projects WHERE id=?`).get(pm.id)).toEqual({ name: "Mine", archived: 0 });
    const filt = await (await api(env, t, "GET", `/api/conversations?project=${pm.id}`)).json() as any;
    expect(filt.conversations).toEqual([]);
    for (const [method, path, body] of [["GET", "/api/projects"], ["POST", "/api/projects", { name: "x" }], ["GET", `/api/projects/${pm.id}`], ["PATCH", `/api/projects/${pm.id}`, { name: "x" }], ["DELETE", `/api/projects/${pm.id}`]] as const)
      expect((await api(env, g, method, path, body)).status).toBe(403);
    expect(db.query(`SELECT COUNT(*) AS n FROM projects`).get()).toEqual({ n: 2 });
  });
  test(`at most ${MAX_PROJECTS} active projects per scope (archived ones do not count)`, async () => {
    const { env, db } = mkEnv(); const m = await login(env, "example-user"), t = await bot(env);
    for (let i = 0; i < MAX_PROJECTS; i++) expect((await api(env, m, "POST", "/api/projects", { name: `p${i}` })).status).toBe(201);
    expect((await api(env, m, "POST", "/api/projects", { name: "one too many" })).status).toBe(409);
    expect((await api(env, t, "POST", "/api/projects", { name: "other scope is fine" })).status).toBe(201);
    const first = db.query(`SELECT id FROM projects WHERE scope='main' LIMIT 1`).get() as any;
    await api(env, m, "DELETE", `/api/projects/${first.id}`);
    expect((await api(env, m, "POST", "/api/projects", { name: "now fits" })).status).toBe(201);
  });
  test("bad bodies are 400", async () => {
    const { env } = mkEnv(); const m = await login(env, "example-user");
    expect((await api(env, m, "POST", "/api/projects", {})).status).toBe(400);
    expect((await api(env, m, "POST", "/api/projects", { name: "n", instructions: "x".repeat(MAX_PROJECT_INSTRUCTIONS + 1) })).status).toBe(400);
    expect((await api(env, m, "PATCH", `/api/projects/${uuid(1)}`, {})).status).toBe(400);
    expect((await api(env, m, "GET", "/api/projects/not-a-uuid")).status).toBe(404);
  });
});

describe("system prompt", () => {
  test("projectInstructions: main + active project only; e2e / g:* get null even with a row; archived -> null", async () => {
    const { d1: dbh, db } = mkEnv();
    db.exec(`INSERT INTO projects (id, scope, name, instructions) VALUES ('pm','main','PM','  Use Astro. '),('pe','e2e','PE','E2E'),('pg','${GA}','PG','GUEST')`);
    seedConv(db, "cm", "main"); seedConv(db, "ce", "e2e"); seedConv(db, "cg", GA); seedConv(db, "cx", "main");
    db.exec(`UPDATE conversations SET project_id='pm' WHERE id='cm'; UPDATE conversations SET project_id='pe' WHERE id='ce'; UPDATE conversations SET project_id='pg' WHERE id='cg'; UPDATE conversations SET project_id='pe' WHERE id='cx'`);
    expect(await projectInstructions(dbh, "main", "cm")).toEqual({ name: "PM", text: "Use Astro." });
    expect(await projectInstructions(dbh, "e2e", "ce")).toBeNull();
    expect(await projectInstructions(dbh, GA, "cg")).toBeNull();
    expect(await projectInstructions(dbh, "main", "cx")).toBeNull(); // a main chat pointing at another scope's project reads nothing
    expect(await projectInstructions(dbh, "main", "ce")).toBeNull(); // not main's conversation
    db.exec(`UPDATE projects SET archived=1 WHERE id='pm'`);
    expect(await projectInstructions(dbh, "main", "cm")).toBeNull();
  });
  test("buildRequest: base block unchanged, project is a last block that says it is user-supplied, not tool output", () => {
    const h = [{ role: "user", content: [{ type: "text", text: "x" }] }];
    const plain: any = buildRequest("claude-haiku-5-5", h);
    const withP: any = buildRequest("claude-haiku-5-5", h, [], null, { name: "Site", text: "Use Astro." });
    expect(withP.system).toHaveLength(2);
    expect(withP.system[0]).toEqual(plain.system[0]);
    expect(withP.system[1].text).toBe(projectSystemText("Site", "Use Astro."));
    expect(withP.system[1].text).toMatch(/user-supplied project instructions, not tool output/);
    const both: any = buildRequest("claude-haiku-5-5", h, [], "Be terse.", { name: "Site", text: "Use Astro." });
    expect(both.system.map((b: any) => b.text.includes("Be terse.") || b.text.includes("Use Astro."))).toEqual([false, true, true]);
    expect(both.system[0].text).toBe(SYSTEM_PROMPT);
  });
  test("engine: pinned per turn (an edit mid-turn does not apply, the next turn sees it); a failing lookup fails the turn closed", async () => {
    const run = async (project: () => Promise<{ name: string; text: string } | null>, turns = 1) => {
      const db = new Database(":memory:"); const calls: any[] = [];
      const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => { calls.push(b); return b.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: {} }) : new Response(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"].map((t, i) => `data: ${JSON.stringify(
        t === "message_start" ? { type: t, message: { id: "m", usage: {} } } : t === "content_block_start" ? { type: t, index: 0, content_block: { type: "text", text: "" } } : t === "content_block_delta" ? { type: t, index: 0, delta: { type: "text_delta", text: "ok" } } : t === "message_delta" ? { type: t, delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } : { type: t, index: i })}\n\n`).join(""), { status: 200 }); } } as any;
      const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
      const ev: any[] = [];
      const e = new ChatEngine({ sql: { exec: (q: string, ...b: unknown[]) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } }, provider, index, sink: { broadcast: (_s, _t, x) => ev.push(x) }, retryDelayMs: 1, project });
      e.setConvId("c1"); for (let i = 0; i < turns; i++) await e.send("hi " + i);
      return { calls: calls.filter((c) => c.stream !== false), ev };
    };
    let text = "v1";
    const two = await run(async () => { const r = { name: "P", text }; text = "v2"; return r; }, 2); // lookup is called once per turn
    expect(two.calls).toHaveLength(2);
    expect(two.calls[0].system[1].text).toContain("v1");
    expect(two.calls[1].system[1].text).toContain("v2"); // not retroactive for the first turn, applied to the new turn
    const none = await run(async () => null);
    expect(none.calls[0].system).toHaveLength(1);
    const bad = await run(async () => { throw new Error("d1 down"); });
    expect(bad.calls).toHaveLength(0);
    expect(bad.ev.some((x) => x.type === "error")).toBe(true);
  });
});
