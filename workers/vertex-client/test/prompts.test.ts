// Saved prompts: validation and /api/prompts (scope isolation, 403 for g:*, limit).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession, type Session } from "../src/auth";
import { scopeOfSession, type Scope, type GuestScope } from "../src/scope";
import { MAX_PROMPTS, MAX_PROMPT_TEXT, MAX_PROMPT_TITLE, validatePrompt } from "../src/prompts";

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


describe("validatePrompt", () => {
  test("create needs title and text; limits exact; control chars stripped; blank refused", () => {
    expect(validatePrompt({ title: "  T ", text: "a\nb\u0000" }, true)).toEqual({ ok: true, v: { title: "T", text: "a\nb" } });
    for (const b of [{}, { title: "t" }, { text: "x" }, { title: " ", text: "x" }, null, [], { title: 1, text: "x" }]) expect(validatePrompt(b, true).ok).toBe(false);
    expect(validatePrompt({ title: "x".repeat(MAX_PROMPT_TITLE), text: "y".repeat(MAX_PROMPT_TEXT) }, true).ok).toBe(true);
    expect(validatePrompt({ title: "x".repeat(MAX_PROMPT_TITLE + 1), text: "y" }, true).ok).toBe(false);
    expect(validatePrompt({ title: "x", text: "y".repeat(MAX_PROMPT_TEXT + 1) }, true).ok).toBe(false);
  });
  test("patch is partial; empty body or blank field rejected", () => {
    expect(validatePrompt({ text: "new" }, false)).toEqual({ ok: true, v: { text: "new" } });
    for (const b of [{}, { title: "" }, { text: "  " }]) expect(validatePrompt(b, false).ok).toBe(false);
  });
});

describe("/api/prompts", () => {
  test("CRUD for main; list sorted by title", async () => {
    const { env } = mkEnv(); const m = await login(env, "example-user");
    const b = await (await api(env, m, "POST", "/api/prompts", { title: "beta", text: "B {{date}}" })).json() as any;
    expect((await api(env, m, "POST", "/api/prompts", { title: "Alpha", text: "A" })).status).toBe(201);
    expect(((await (await api(env, m, "GET", "/api/prompts")).json()) as any).prompts.map((p: any) => p.title)).toEqual(["Alpha", "beta"]);
    expect((await api(env, m, "PATCH", `/api/prompts/${b.id}`, { text: "B2" })).status).toBe(200);
    expect(((await (await api(env, m, "GET", "/api/prompts")).json()) as any).prompts.find((p: any) => p.id === b.id)).toMatchObject({ title: "beta", text: "B2" });
    expect((await api(env, m, "POST", "/api/prompts", { title: "", text: "x" })).status).toBe(400);
    expect((await api(env, m, "DELETE", `/api/prompts/${b.id}`)).status).toBe(200);
    expect((await api(env, m, "DELETE", `/api/prompts/${b.id}`)).status).toBe(404);
    expect((await api(env, m, "PATCH", `/api/prompts/${uuid(1)}`, { text: "x" })).status).toBe(404);
    expect((await api(env, m, "PATCH", `/api/prompts/not-a-uuid`, { text: "x" })).status).toBe(404);
  });
  test("cross-scope: main and e2e cannot see, edit or delete each other's prompts; g:* gets 403 everywhere", async () => {
    const { env, db } = mkEnv(); const m = await login(env, "example-user"), t = await bot(env), g = await login(env, "guest-a");
    const pm = await (await api(env, m, "POST", "/api/prompts", { title: "Mine", text: "SECRET-M" })).json() as any;
    const pe = await (await api(env, t, "POST", "/api/prompts", { title: "Bot", text: "bot" })).json() as any;
    expect(((await (await api(env, t, "GET", "/api/prompts")).json()) as any).prompts.map((x: any) => x.id)).toEqual([pe.id]);
    expect(JSON.stringify(await (await api(env, t, "GET", "/api/prompts")).json())).not.toContain("SECRET-M");
    expect((await api(env, t, "PATCH", `/api/prompts/${pm.id}`, { text: "x" })).status).toBe(404);
    expect((await api(env, t, "DELETE", `/api/prompts/${pm.id}`)).status).toBe(404);
    expect(db.query(`SELECT text FROM saved_prompts WHERE id=?`).get(pm.id)).toEqual({ text: "SECRET-M" });
    // a g:* scope has its own rows: it sees none of main's / e2e's, and its writes to their ids are 404 (never 200, never a change)
    const gl = await (await api(env, g, "GET", "/api/prompts")).json() as any;
    expect(gl.prompts).toEqual([]);
    for (const id of [pm.id, pe.id]) for (const [method, body] of [["PATCH", { text: "x" }], ["PUT", { text: "x" }], ["DELETE", undefined]] as const)
      expect((await api(env, g, method, `/api/prompts/${id}`, body)).status).toBe(404);
    expect(db.query(`SELECT COUNT(*) AS n FROM saved_prompts`).get()).toEqual({ n: 2 });
    const pg = await (await api(env, g, "POST", "/api/prompts", { title: "Team", text: "SECRET-G" })).json() as any;
    expect(db.query(`SELECT scope FROM saved_prompts WHERE id=?`).get(pg.id)).toEqual({ scope: GA });
    expect((await api(env, g, "PUT", `/api/prompts/${pg.id}`, { title: "Team2" })).status).toBe(200);
    expect(((await (await api(env, g, "GET", "/api/prompts")).json()) as any).prompts.map((x: any) => x.title)).toEqual(["Team2"]);
    for (const w of [m, t]) { // main's / e2e's lists and counts are unchanged and never contain the guest's row
      const body = JSON.stringify(await (await api(env, w, "GET", "/api/prompts")).json()); expect(body).not.toContain("SECRET-G");
      expect((await api(env, w, "PUT", `/api/prompts/${pg.id}`, { text: "x" })).status).toBe(404);
      expect((await api(env, w, "DELETE", `/api/prompts/${pg.id}`)).status).toBe(404);
    }
    expect(db.query(`SELECT scope, COUNT(*) AS n FROM saved_prompts GROUP BY scope ORDER BY scope`).all()).toEqual([{ scope: "e2e", n: 1 }, { scope: GA, n: 1 }, { scope: "main", n: 1 }]);
    expect((await api(env, g, "DELETE", `/api/prompts/${pg.id}`)).status).toBe(200);
    expect(db.query(`SELECT COUNT(*) AS n FROM saved_prompts`).get()).toEqual({ n: 2 });
  });
  test(`at most ${MAX_PROMPTS} prompts per scope`, async () => {
    const { env } = mkEnv(); const m = await login(env, "example-user"), t = await bot(env);
    for (let i = 0; i < MAX_PROMPTS; i++) expect((await api(env, m, "POST", "/api/prompts", { title: `p${i}`, text: "x" })).status).toBe(201);
    expect((await api(env, m, "POST", "/api/prompts", { title: "one more", text: "x" })).status).toBe(409);
    expect((await api(env, t, "POST", "/api/prompts", { title: "other scope", text: "x" })).status).toBe(201); // the limit is per scope
  });
});
