import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { agentState, inScope, notifyForMessage, watchAgents } from "../src/agents";

const ORIGIN = "https://app.test", TOKEN = "t".repeat(64), SECRET = "spike-secret-value-0123456789", REPO = "example-user/example-repo";
function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as D1Database };
}
type Call = { path: string; method: string; secret: string | null; actor: string | null; body: any };
const view = (name: string, o: Record<string, unknown> = {}) => ({ name, repo: REPO, image: "base", executor: "auto", phase: "idle", current: null, queued: 0, session: { id: "b00000000000001", status: "sleeping" }, costUsd: 0.25, lastActivity: 1700000000000, lastDone: null, lastWake: null, schedules: 0, ...o });
function spike(state: { agents: any[]; inbox?: Record<string, any[]> }, over: Record<string, (c: Call) => Response> = {}) {
  const calls: Call[] = [];
  const f = { fetch: async (url: string, init: RequestInit) => {
    const u = new URL(url), h = new Headers(init.headers);
    const c: Call = { path: u.pathname.replace("/internal/v1", "") + u.search, method: init.method ?? "GET", secret: h.get("x-internal-secret"), actor: h.get("x-actor"), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    for (const [k, fn] of Object.entries(over)) if (c.path.startsWith(k)) return fn(c);
    if (c.path === "/agents" && c.method === "GET") return Response.json({ agents: state.agents });
    if (c.path === "/agents" && c.method === "POST") return Response.json(view(c.body.name), { status: 201 });
    const m = c.path.match(/^\/agents\/([^/?]+)(?:\/([a-z]+))?/);
    if (m && !m[2] && c.method === "GET") { const a = state.agents.find((x) => x.name === m[1]); return a ? Response.json(a) : Response.json({ error: "no such agent" }, { status: 404 }); }
    if (m && m[2] === "inbox" && c.method === "GET") return Response.json({ messages: state.inbox?.[m[1]] ?? [] });
    if (m && m[2] === "inbox" && c.method === "POST") return Response.json({ id: "0a0b0c0d", status: "queued" }, { status: 202 });
    if (m && m[2] === "schedules" && c.method === "GET") return Response.json({ schedules: [] });
    return Response.json({ ok: true });
  } } as unknown as Fetcher;
  return { f, calls };
}
const CHAT = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) } as unknown as DurableObjectNamespace;
const mkEnv = (agent: Fetcher | undefined, over: Record<string, unknown> = {}) => {
  const x = d1();
  return { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", E2E_TOKEN: TOKEN, AGENT: agent, AGENT_INTERNAL_SECRET: agent ? SECRET : undefined,
    CLOUD_REPOS: REPO, ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, CHAT, _db: x.db, ...over } as unknown as Env & { _db: Database };
};
const app = createApp();
const erichOf = async (env: Env) => { const { cookie, session } = await makeSession(env, "example-user", "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const botOf = async (env: Env) => {
  const r = await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": TOKEN } }), env);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const me = (await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json()) as any;
  return { cookie, csrf: me.csrf as string };
};
const api = (env: Env, path: string, a: { cookie: string; csrf: string }, init: RequestInit & { json?: unknown } = {}) => {
  const h = new Headers(init.headers); h.set("cookie", a.cookie); h.set("origin", ORIGIN);
  const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
  if (method !== "GET") h.set("x-csrf-token", a.csrf);
  return app.fetch(new Request(ORIGIN + path, { ...init, method, headers: h, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }), env);
};

describe("helpers", () => {
  test("scope by name prefix", () => {
    expect(inScope("main", "reviewer")).toBe(true); expect(inScope("main", "e2e-x")).toBe(false);
    expect(inScope("e2e", "e2e-x")).toBe(true); expect(inScope("e2e", "reviewer")).toBe(false);
    expect(inScope("main", "../x")).toBe(false); expect(inScope("main", "A")).toBe(false);
  });
  test("state: running / awake / sleeping", () => {
    expect(agentState({ phase: "task", session: { status: "idle" } })).toBe("running");
    expect(agentState({ phase: "idle", session: { status: "idle" } })).toBe("awake");
    expect(agentState({ phase: "idle", session: { status: "sleeping" } })).toBe("sleeping");
    expect(agentState({ phase: "idle", session: null })).toBe("sleeping");
  });
  test("notification text", () => {
    expect(notifyForMessage("rev", { from: "schedule:ab", status: "done", reply: "all green" }).title).toMatch(/scheduled run finished/);
    expect(notifyForMessage("rev", { from: "x", status: "done", reply: "hi" }).title).toBe("rev replied");
    expect(notifyForMessage("rev", { status: "failed", error: "boom" })).toMatchObject({ title: "rev: run failed", body: "boom", url: "/a/rev" });
  });
});

describe("agents routes", () => {
  test("unconfigured: disabled, list empty, create 503", async () => {
    const env = mkEnv(undefined), a = await erichOf(env);
    expect(((await (await api(env, "/api/agents/config", a)).json()) as any).enabled).toBe(false);
    expect(((await (await api(env, "/api/agents", a)).json()) as any).agents).toEqual([]);
    expect((await api(env, "/api/agents", a, { json: { name: "abc", repo: REPO } })).status).toBe(503);
  });
  test("auth: 401 without cookie, 403 without CSRF", async () => {
    const env = mkEnv(spike({ agents: [] }).f);
    expect((await app.fetch(new Request(ORIGIN + "/api/agents"), env)).status).toBe(401);
    const a = await erichOf(env);
    expect((await api(env, "/api/agents", { ...a, csrf: "bad" }, { json: { name: "abc", repo: REPO } })).status).toBe(403);
  });
  test("list is scoped: Erich never sees e2e-*, e2e-bot only its own; state and cost derived", async () => {
    const sp = spike({ agents: [view("reviewer", { phase: "task" }), view("e2e-one", { session: null, costUsd: 0 }), view("notes")] });
    const env = mkEnv(sp.f), a = await erichOf(env), b = await botOf(env);
    const ea = ((await (await api(env, "/api/agents", a)).json()) as any).agents;
    expect(ea.map((x: any) => x.name)).toEqual(["reviewer", "notes"]);
    expect(ea[0]).toMatchObject({ state: "running", costUsd: 0.25 });
    expect(ea[1].state).toBe("sleeping");
    expect(((await (await api(env, "/api/agents", b)).json()) as any).agents.map((x: any) => x.name)).toEqual(["e2e-one"]);
    // cost ledger: delta once, re-list adds nothing
    await api(env, "/api/agents", a);
    expect((env as any)._db.query(`SELECT run_id, cost_usd, scope FROM cloud_costs ORDER BY rowid`).all()).toEqual([{ run_id: "agent:reviewer", cost_usd: 0.25, scope: "main" }, { run_id: "agent:notes", cost_usd: 0.25, scope: "main" }] );
  });
  test("cost ledger follows the lifetime total across session replacements (never double counts)", async () => {
    const agents = [view("reviewer", { costUsd: 0.25 })];
    const env = mkEnv(spike({ agents }).f), a = await erichOf(env);
    await api(env, "/api/agents", a);
    agents[0] = view("reviewer", { costUsd: 0.75, session: { id: "b00000000000002", status: "idle" } });
    await api(env, "/api/agents/reviewer", a); await api(env, "/api/agents", a);
    expect((env as any)._db.query(`SELECT SUM(cost_usd) AS c, COUNT(*) AS n FROM cloud_costs WHERE run_id='agent:reviewer'`).get()).toEqual({ c: 0.75, n: 2 });
  });
  test("events: one agent-level stream, cursor validated, forwarded to agent-spike's /agents/:name/events", async () => {
    const sp = spike({ agents: [view("reviewer")] }, { "/agents/reviewer/events": () => Response.json({ events: [], next: null }) });
    const env = mkEnv(sp.f), a = await erichOf(env);
    expect((await api(env, "/api/agents/reviewer/events?after=b000000000000001:7", a)).status).toBe(200);
    expect(sp.calls.at(-1)!.path).toBe("/agents/reviewer/events?limit=500&after=b000000000000001%3A7");
    await api(env, "/api/agents/reviewer/events?after=evil", a);
    expect(sp.calls.at(-1)!.path).toBe("/agents/reviewer/events?limit=500");
    expect((await api(env, "/api/agents/e2e-x/events", a)).status).toBe(404);
  });
  test("foreign names are 404 before any agent-spike call", async () => {
    const sp = spike({ agents: [view("reviewer"), view("e2e-one")] }), env = mkEnv(sp.f), a = await erichOf(env), b = await botOf(env);
    for (const [who, name] of [[a, "e2e-one"], [b, "reviewer"]] as const) {
      sp.calls.length = 0;
      expect((await api(env, `/api/agents/${name}`, who)).status).toBe(404);
      expect((await api(env, `/api/agents/${name}/inbox`, who, { json: { text: "x" } })).status).toBe(404);
      expect((await api(env, `/api/agents/${name}/wake`, who, { json: {} })).status).toBe(404);
      expect((await api(env, `/api/agents/${name}`, who, { method: "DELETE", json: {} })).status).toBe(404);
      expect((await api(env, `/api/agents/${name}/schedules/0a0b0c0d`, who, { method: "DELETE", json: {} })).status).toBe(404);
      expect(sp.calls).toEqual([]);
    }
  });
  test("create: allowlist, name rules per scope, e2e base confinement, secret only on the service hop", async () => {
    const sp = spike({ agents: [] }), env = mkEnv(sp.f), a = await erichOf(env), b = await botOf(env);
    expect((await api(env, "/api/agents", a, { json: { name: "e2e-x", repo: REPO } })).status).toBe(400);
    expect((await api(env, "/api/agents", a, { json: { name: "ok-agent", repo: "evil/x" } })).status).toBe(403);
    expect((await api(env, "/api/agents", b, { json: { name: "plain", repo: REPO, base: "spike-base/x" } })).status).toBe(400);
    expect((await api(env, "/api/agents", b, { json: { name: "e2e-a", repo: REPO, base: "main" } })).status).toBe(403);
    expect((await api(env, "/api/agents", b, { json: { name: "e2e-a", repo: REPO } })).status).toBe(403);
    expect(sp.calls.length).toBe(0);
    const ok = await api(env, "/api/agents", a, { json: { name: "ok-agent", repo: REPO, instructions: "be nice", image: "nope" } });
    expect(ok.status).toBe(201);
    expect(sp.calls[0]).toMatchObject({ path: "/agents", method: "POST", secret: SECRET, actor: "vertex-client:example-user", body: { name: "ok-agent", repo: REPO, image: "base", executor: "auto", instructions: "be nice" } });
    expect(await ok.text()).not.toContain(SECRET);
    expect((await api(env, "/api/agents", b, { json: { name: "e2e-a", repo: REPO, base: "spike-base/x" } })).status).toBe(201);
  });
  test("detail returns the inbox oldest first, text + reply straight from agent-spike", async () => {
    const sp = spike({ agents: [view("reviewer")], inbox: { reviewer: [{ id: "0a0b0c0d", from: "vertex-client:example-user", status: "done", text: "hi there", reply: "hello", hasReply: true, created: 2 }, { id: "11111111", from: "schedule:ab", status: "done", reply: "tick", created: 1 }] } });
    const env = mkEnv(sp.f), a = await erichOf(env);
    const p = await api(env, "/api/agents/reviewer/inbox", a, { json: { text: "hi there" } });
    expect(p.status).toBe(202);
    expect(sp.calls.find((c) => c.method === "POST" && c.path.endsWith("/inbox"))!.body).toEqual({ text: "hi there", from: "vertex-client:example-user", reply: true });
    expect((await api(env, "/api/agents/reviewer/inbox", a, { json: { text: "  " } })).status).toBe(400);
    const d = (await (await api(env, "/api/agents/reviewer", a)).json()) as any;
    expect(d.inbox.map((m: any) => [m.id, m.text, m.reply])).toEqual([["11111111", undefined, "tick"], ["0a0b0c0d", "hi there", "hello"]]);
    expect(d.agent).toMatchObject({ costUsd: 0.25, lastActivity: 1700000000000 });
    expect(d.agent.state).toBe("sleeping");
  });
  test("stop uses the agent's own session id read server-side; no session = 409", async () => {
    const sp = spike({ agents: [view("reviewer", { session: { id: "b000000000000009", status: "idle" } }), view("fresh", { session: null })] });
    const env = mkEnv(sp.f), a = await erichOf(env);
    expect((await api(env, "/api/agents/reviewer/stop", a, { json: { sid: "evil" } })).status).toBe(200);
    expect(sp.calls.at(-1)).toMatchObject({ path: "/sessions/b000000000000009/interrupt", method: "POST" });
    expect((await api(env, "/api/agents/fresh/stop", a, { json: {} })).status).toBe(409);
  });
  test("schedules: validates timing fields", async () => {
    const sp = spike({ agents: [view("reviewer")] }), env = mkEnv(sp.f), a = await erichOf(env);
    expect((await api(env, "/api/agents/reviewer/schedules", a, { json: { text: "x" } })).status).toBe(400);
    expect((await api(env, "/api/agents/reviewer/schedules", a, { json: { text: "x", delaySecs: -1 } })).status).toBe(400);
    expect((await api(env, "/api/agents/reviewer/schedules", a, { json: { text: "x", everySecs: 3600 } })).status).toBe(200);
    expect(sp.calls.at(-1)!.body).toEqual({ text: "x", everySecs: 3600 });
    expect((await api(env, "/api/agents/reviewer/schedules/0a0b0c0d", a, { method: "DELETE", json: {} })).status).toBe(200);
    expect((await api(env, "/api/agents/reviewer/schedules/zzzzzzzz", a, { method: "DELETE", json: {} })).status).toBe(404);
  });
  test("fault: agent-spike down -> 502 list, 502 detail; delete purges local rows", async () => {
    const down = mkEnv({ fetch: async () => new Response("boom", { status: 500 }) } as unknown as Fetcher), a = await erichOf(down);
    expect((await api(down, "/api/agents", a)).status).toBe(502);
    expect((await api(down, "/api/agents/reviewer", a)).status).toBe(502);
    const sp = spike({ agents: [view("reviewer")] }), env = mkEnv(sp.f), b = await erichOf(env);
    await api(env, "/api/agents/reviewer/inbox", b, { json: { text: "x" } });
    expect((await api(env, "/api/agents/reviewer", b, { method: "DELETE", json: {} })).status).toBe(200);
    expect(sp.calls.at(-1)!.path).toBe("/agents/reviewer?purge");
    expect((env as any)._db.query(`SELECT COUNT(*) AS n FROM agent_watch WHERE name='reviewer'`).get()).toEqual({ n: 0 });
  });
});

describe("watchAgents", () => {
  const msg = (id: string, finished: number, o: Record<string, unknown> = {}) => ({ id, from: "x", status: "done", reply: "r", created: finished - 1, finished, kind: "msg", ...o });
  const setup = (inbox: any[], extra: Record<string, unknown> = {}) => {
    const sp = spike({ agents: [view("reviewer"), view("e2e-one")], inbox: { reviewer: inbox, "e2e-one": inbox } });
    const env = mkEnv(sp.f, { VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", ...extra });
    (env as any)._db.query(`INSERT INTO push_subscriptions (endpoint,p256dh,auth) VALUES (?,?,?)`).run("https://push.example/1", "x", "y");
    return { sp, env };
  };
  const wm = (env: any) => env._db.query(`SELECT name, watermark FROM agent_watch ORDER BY name`).all() as any[];
  test("first sight adopts silently; a later finished message is pushed once; e2e agents never polled", async () => {
    const { sp, env } = setup([msg("a1", 100000)]);
    let sends = 0; const f = (async () => { sends++; return new Response(null, { status: 201 }); }) as any;
    const r1 = await watchAgents(env, 1000000, f);
    expect(r1).toMatchObject({ checked: 1, pushed: 0 }); expect(sends).toBe(0);
    expect(sp.calls.some((c) => c.path.includes("e2e-one/inbox"))).toBe(false);
    expect(wm(env)).toEqual([{ name: "reviewer", watermark: 1000000 }]);
    const r2 = await watchAgents(env, 2000000, f); expect(r2.errors).toEqual([]); expect(sends).toBe(0);
    // a reply lands after the watermark: attempted (bogus VAPID fails to encrypt => reported, proving the push path ran), watermark advanced
  });
  test("new finished message after watermark triggers a push attempt, then never again", async () => {
    const inbox: any[] = [msg("a1", 100000)];
    const { env } = setup(inbox);
    await watchAgents(env, 1000000);                      // adopt
    inbox.push(msg("a2", 1500000));
    const r = await watchAgents(env, 2000000);
    expect(r.errors.join()).toMatch(/reviewer: push not delivered/);
    expect(wm(env)).toEqual([{ name: "reviewer", watermark: 1500000 }]);
    const r2 = await watchAgents(env, 3000000); expect(r2.errors).toEqual([]);
  });
  test("no push while a client looked in the last 20 s; handoff messages and queued/running ones are ignored", async () => {
    const inbox: any[] = [msg("a1", 100000)];
    const { env } = setup(inbox);
    await watchAgents(env, 1000000);
    (env as any)._db.query(`UPDATE agent_watch SET seen_at=? WHERE name='reviewer'`).run(1990000);
    inbox.push(msg("a2", 1500000), msg("h", 1600000, { kind: "handoff" }), { id: "q", from: "x", status: "running", created: 1700000 });
    const r = await watchAgents(env, 2000000); expect(r.errors).toEqual([]); expect(r.pushed).toBe(0);
    expect(wm(env)).toEqual([{ name: "reviewer", watermark: 1500000 }]);
  });
  test("fault: agent-spike listing fails -> reported, nothing thrown; unconfigured -> no-op", async () => {
    const env = mkEnv({ fetch: async () => new Response("x", { status: 503 }) } as unknown as Fetcher);
    expect((await watchAgents(env)).errors.length).toBe(1);
    expect(await watchAgents(mkEnv(undefined))).toEqual({ checked: 0, pushed: 0, errors: [] });
  });
});

