import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { scopeOfSession, type Scope, type GuestScope } from "../src/scope";
import type { Session } from "../src/auth";
import { forkPrefix, forkTitle } from "../src/fork";
import { starterCards, nextStick, msgMarkdown, msgPlain, fmtWhen } from "../web/src/depth-logic";

const ORIGIN = "https://app.test";
const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
const seam = (s: Session): Scope => (s.u === "guest-a" ? GA : scopeOfSession(s));
const app = createApp({ scopeOf: seam });
const T = (text: string) => ({ type: "text", text });
const M = (id: number, role: "user" | "assistant", ...content: any[]) => ({ id, role, content });

describe("forkPrefix", () => {
  const msgs = [M(1, "user", T("a")), M(2, "assistant", T("A")), M(3, "user", T("b")), M(4, "assistant", T("B"))];
  test("copies everything before the chosen user message", () => {
    const r = forkPrefix(msgs, 3, false);
    expect(r).toEqual({ ok: true, messages: [{ role: "user", content: [T("a")] }, { role: "assistant", content: [T("A")] }] });
  });
  test("first message forks into an empty prefix", () => { expect(forkPrefix(msgs, 1, false)).toEqual({ ok: true, messages: [] }); });
  test("refuses while running, unknown ids, assistant messages and tool results", () => {
    expect(forkPrefix(msgs, 3, true)).toMatchObject({ ok: false, status: 409 });
    expect(forkPrefix(msgs, 99, false)).toMatchObject({ ok: false, status: 404 });
    expect(forkPrefix(msgs, 2, false)).toMatchObject({ ok: false, status: 400 });
    expect(forkPrefix([M(1, "user", { type: "tool_result", tool_use_id: "x", content: "r" })], 1, false)).toMatchObject({ ok: false, status: 400 });
  });
  test("an unanswered tool call in the copied part blocks the fork", () => {
    const m = [M(1, "user", T("a")), M(2, "assistant", { type: "tool_use", id: "t1", name: "n", input: {} }), M(3, "user", T("b"))];
    expect(forkPrefix(m, 3, false)).toMatchObject({ ok: false, status: 409 });
  });
  test("attachments become plain text (their files stay with the original)", () => {
    const m = [M(1, "user", { type: "file_ref", ref: "files/c/1", name: "a.pdf", mime: "application/pdf", size: 1 }, T("see")), M(2, "assistant", T("ok")), M(3, "user", T("x"))];
    const r = forkPrefix(m, 3, false) as any;
    expect(r.messages[0].content).toEqual([T("[Attachment: a.pdf]"), T("see")]);
  });
  test("title is marked and stays within 120 chars", () => {
    expect(forkTitle("Hello")).toBe("Hello (edited)");
    expect(forkTitle("x".repeat(300)).length).toBeLessThanOrEqual(120);
    expect(forkTitle("")).toBe("New chat (edited)");
  });
});

describe("depth-logic", () => {
  test("starter cards: four, short, varied; saved prompts offered separately", () => {
    const c = starterCards();
    expect(c.length).toBe(4);
    expect(new Set(c.map((x) => x.title)).size).toBe(4);
    for (const x of c) { expect(x.title.length).toBeLessThanOrEqual(24); expect(x.text.length).toBeGreaterThan(10); }
  });
  test("scroll pin: re-pins at the bottom, unpins on scroll-up, growth under a reader changes nothing", () => {
    const at = { scrollHeight: 1000, scrollTop: 900, clientHeight: 100 };
    expect(nextStick(false, at, 800)).toBe(true);
    expect(nextStick(true, { scrollHeight: 1000, scrollTop: 700, clientHeight: 100 }, 900)).toBe(false); // user scrolled up
    expect(nextStick(false, { scrollHeight: 2000, scrollTop: 700, clientHeight: 100 }, 700)).toBe(false); // content grew, reader stayed
    expect(nextStick(true, { scrollHeight: 2000, scrollTop: 700, clientHeight: 100 }, 700)).toBe(true); // pinned: the effect scrolls it
  });
  test("plain text drops fences; dates parse D1 UTC", () => {
    expect(msgPlain({ content: [T("a\n```js\nx\n```")] } as any)).toBe("a\nx");
    expect(fmtWhen("2026-10-21 09:15:00", "en-US")).toContain("2026");
    expect(fmtWhen(undefined)).toBe("—");
  });
  test("copy as markdown keeps text blocks and drops tool/thinking noise", () => {
    const m: any = { content: [{ type: "thinking", thinking: "x" }, T("# Hi"), { type: "tool_use", id: "1", name: "n", input: {} }, T("```js\n1\n```")] };
    expect(msgMarkdown(m)).toBe("# Hi\n\n```js\n1\n```");
  });
});

// ---- fork route: scope isolation, original untouched ----
function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as unknown as D1Database };
}
const mkEnv = (state: any) => {
  const x = d1(); const seeds: Array<{ conv: string | null; body: any }> = [];
  const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k",
    ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, _db: x.db, _seeds: seeds };
  e.CHAT = { idFromName: (n: string) => ({ toString: () => n }), get: () => ({ fetch: async (r: Request) => {
    const p = new URL(r.url).pathname;
    if (p === "/state") return Response.json(state);
    if (p === "/seed") { seeds.push({ conv: r.headers.get("x-conv-id"), body: await r.json() }); return Response.json({ ok: true }); }
    return Response.json({ ok: true });
  } }) };
  return e as Env & { _db: Database; _seeds: typeof seeds };
};
const as = async (env: Env, user: string) => { const { cookie, session } = await makeSession(env, user, "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const post = (env: Env, w: { cookie: string; csrf: string }, path: string, body: unknown) =>
  app.fetch(new Request(ORIGIN + path, { method: "POST", headers: { cookie: w.cookie, origin: ORIGIN, "x-csrf-token": w.csrf, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
const CONV = "11111111-2222-3333-4444-555555555555";
const STATE = { running: false, model: "claude-sonnet-5-5", messages: [M(1, "user", T("a")), M(2, "assistant", T("A")), M(3, "user", T("b")), M(4, "assistant", T("B"))] };

describe("POST /api/conversations/:id/fork", () => {
  test("creates a new conversation in the same scope/project with the prefix; original row untouched", async () => {
    const env = mkEnv(STATE); const w = await as(env, "example-user");
    env._db.query(`INSERT INTO conversations (id, model, scope, title) VALUES (?,?,?,?)`).run(CONV, "claude-sonnet-5-5", "main", "Plan");
    const r = await post(env, w, `/api/conversations/${CONV}/fork`, { message_id: 3 });
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.id).not.toBe(CONV);
    expect(j.title).toBe("Plan (edited)");
    expect(env._seeds[0].conv).toBe(j.id);
    expect(env._seeds[0].body.messages.length).toBe(2);
    expect(env._db.query(`SELECT scope, title FROM conversations WHERE id=?`).get(j.id)).toEqual({ scope: "main", title: "Plan (edited)" });
    expect(env._db.query(`SELECT title FROM conversations WHERE id=?`).get(CONV)).toEqual({ title: "Plan" });
  });
  test("another scope cannot fork it (404, nothing created); bad bodies are 400", async () => {
    const env = mkEnv(STATE);
    env._db.query(`INSERT INTO conversations (id, model, scope, title) VALUES (?,?,?,?)`).run(CONV, "m", "main", "Plan");
    const g = await as(env, "guest-a");
    expect((await post(env, g, `/api/conversations/${CONV}/fork`, { message_id: 3 })).status).toBe(404);
    expect(env._db.query(`SELECT count(*) c FROM conversations`).get()).toEqual({ c: 1 });
    const w = await as(env, "example-user");
    expect((await post(env, w, `/api/conversations/${CONV}/fork`, { message_id: "3" })).status).toBe(400);
    expect((await post(env, w, `/api/conversations/${CONV}/fork`, { message_id: 2 })).status).toBe(400);
    expect((await post(env, w, `/api/conversations/not-a-uuid/fork`, { message_id: 3 })).status).toBe(404);
  });
  test("a running conversation cannot be forked", async () => {
    const env = mkEnv({ ...STATE, running: true }); const w = await as(env, "example-user");
    env._db.query(`INSERT INTO conversations (id, model, scope) VALUES (?,?,?)`).run(CONV, "m", "main");
    expect((await post(env, w, `/api/conversations/${CONV}/fork`, { message_id: 3 })).status).toBe(409);
    expect(env._db.query(`SELECT count(*) c FROM conversations`).get()).toEqual({ c: 1 });
  });
});
