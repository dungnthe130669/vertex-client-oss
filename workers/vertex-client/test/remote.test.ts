import { describe, expect, test } from "bun:test";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";

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

const ORIGIN = "https://app.test", TOKEN = "t".repeat(64);
const row = (name: string, o: Record<string, unknown> = {}) => ({ id: `build-host:lane2:${name}`, host: "build-host", kind: "lane2", name, status: "done", started_at: 1700000000, ended_at: 1700000100, cwd: "/x", brief: "b", exit_code: 0, session_ref: null, updated_at: 1700000100, stale: false, ...o });
function hub(over: Partial<{ list: any; get: any }> = {}) {
  const calls: { fn: string; arg: unknown }[] = [];
  return { calls, rpc: {
    list: async (o: unknown) => { calls.push({ fn: "list", arg: o }); return over.list ? over.list(o) : [row("a"), row("b")]; },
    get: async (id: string) => { calls.push({ fn: "get", arg: id }); return over.get ? over.get(id) : { ...row("a"), tail: "t", report: "r" }; },
  } };
}
const mkEnv = (remote?: unknown) => ({ SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", E2E_TOKEN: TOKEN, REMOTE: remote,
  ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: {} }) as unknown as Env;
const app = createApp();
const erich = async (env: Env) => (await makeSession(env, "example-user", "github")).cookie.split(";")[0];
const bot = async (env: Env) => (await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": TOKEN } }), env)).headers.get("set-cookie")!.split(";")[0];
const get = (env: Env, path: string, cookie?: string) => app.fetch(new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} }), env);

describe("remote routes", () => {
  test("no session -> 401 and the hub is never called", async () => {
    const h = hub(); const env = mkEnv(h.rpc);
    expect((await get(env, "/api/remote/sessions")).status).toBe(401);
    expect((await get(env, "/api/remote/sessions/build-host:lane2:a")).status).toBe(401);
    expect(h.calls.length).toBe(0);
  });
  test("list proxies to the binding (status filter + limit), detail returns tail/report", async () => {
    const h = hub(); const env = mkEnv(h.rpc); const c = await erich(env);
    const r = await get(env, "/api/remote/sessions?status=running", c);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).sessions.length).toBe(2);
    expect(h.calls[0]).toEqual({ fn: "list", arg: { status: "running", limit: 100 } });
    const d = await get(env, "/api/remote/sessions/" + encodeURIComponent("build-host:lane2:a"), c);
    expect(d.status).toBe(200);
    expect(((await d.json()) as any).tail).toBe("t");
    expect(h.calls[1]).toEqual({ fn: "get", arg: "build-host:lane2:a" });
  });
  test("bad status / malformed id are refused before reaching the hub; unknown id is 404", async () => {
    const h = hub({ get: () => null }); const env = mkEnv(h.rpc); const c = await erich(env);
    expect((await get(env, "/api/remote/sessions?status=x;drop", c)).status).toBe(400);
    expect((await get(env, "/api/remote/sessions/" + encodeURIComponent("../../etc:passwd"), c)).status).toBe(404);
    expect(h.calls.length).toBe(0);
    expect((await get(env, "/api/remote/sessions/" + encodeURIComponent("build-host:lane2:gone"), c)).status).toBe(404);
  });
  test("hub failure -> generic 502 (no detail leaked); not bound -> disabled / 503", async () => {
    const env = mkEnv(hub({ list: () => { throw new Error("secret-detail"); }, get: () => { throw new Error("secret-detail"); } }).rpc); const c = await erich(env);
    for (const p of ["/api/remote/sessions", "/api/remote/sessions/" + encodeURIComponent("build-host:lane2:a")]) {
      const r = await get(env, p, c); expect(r.status).toBe(502); expect(await r.text()).not.toContain("secret-detail");
    }
    const off = mkEnv(undefined); const c2 = await erich(off);
    expect(((await (await get(off, "/api/remote/config", c2)).json()) as any).enabled).toBe(false);
    expect(((await (await get(off, "/api/remote/sessions", c2)).json()) as any)).toEqual({ enabled: false, sessions: [] });
    expect((await get(off, "/api/remote/sessions/" + encodeURIComponent("build-host:lane2:a"), c2)).status).toBe(503);
  });
  test("read-only: there is no write path (POST/PUT/PATCH/DELETE are 404)", async () => {
    const h = hub(); const env = mkEnv(h.rpc); const s = await makeSession(env, "example-user", "github");
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await app.fetch(new Request(ORIGIN + "/api/remote/sessions/" + encodeURIComponent("build-host:lane2:a"), { method: m, headers: { cookie: s.cookie.split(";")[0], origin: ORIGIN, "x-csrf-token": s.session.csrf, "content-type": "application/json" }, body: "{}" }), env);
      expect(r.status).toBe(404);
    }
    expect(h.calls.length).toBe(0);
  });
  test("e2e user gets fixtures only; the hub is never consulted", async () => {
    const h = hub(); const env = { ...mkEnv(h.rpc), DB: d1().d1 } as Env; const c = await bot(env);
    const l = (await (await get(env, "/api/remote/sessions", c)).json()) as any;
    expect(l.sessions.map((s: any) => s.name)).toContain("e2e-running");
    expect(l.sessions.every((s: any) => s.host === "e2e-host" && !("tail" in s))).toBe(true);
    expect((await get(env, "/api/remote/sessions/" + encodeURIComponent("build-host:lane2:a"), c)).status).toBe(404);
    expect((await get(env, "/api/remote/sessions/" + encodeURIComponent("e2e-host:lane2:e2e-done"), c)).status).toBe(200);
    expect(h.calls.length).toBe(0);
  });
});

// ---- steering ----
const cmd = (o: Record<string, unknown> = {}) => ({ id: "c1", session_id: "build-host:lane2:steer-test-x", host: "build-host", name: "steer-test-x", text: "hi", text_sha256: "x", requested_by: "example-user", created_at: 1, state: "pending", approved_by: null, approved_at: null, rejected_by: null, rejected_at: null, finished_at: null, ...o });
function steerHub(over: Record<string, any> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const mk = (fn: string, dflt: (...a: any[]) => any) => async (...args: any[]) => { calls.push({ fn, args }); return over[fn] ? over[fn](...args) : dflt(...args); };
  return { calls, rpc: {
    list: async () => [], get: async () => null,
    commandCreate: mk("commandCreate", (_a: string, sid: string, t: string) => ({ ok: true, data: { command: cmd({ session_id: sid, text: t }), nonce: "n".repeat(48), nonce_ttl_s: 120 } })),
    commandNonce: mk("commandNonce", () => ({ ok: true, data: { nonce: "m".repeat(48), nonce_ttl_s: 120 } })),
    commandApprove: mk("commandApprove", (_a: string, id: string) => ({ ok: true, data: cmd({ id, state: "approved", approved_by: "example-user" }) })),
    commandReject: mk("commandReject", (_a: string, id: string) => ({ ok: true, data: cmd({ id, state: "rejected" }) })),
    commandGet: mk("commandGet", (id: string) => (id === "gone" ? null : cmd({ id }))),
  } };
}
const post = async (env: Env, path: string, body: unknown, who: "erich" | "bot" | "nocsrf" = "erich") => {
  const s = who === "bot" ? null : await makeSession(env, "example-user", "github");
  let cookie: string, csrf: string;
  if (s) { cookie = s.cookie.split(";")[0]; csrf = s.session.csrf; }
  else { cookie = await bot(env); csrf = ((await (await get(env, "/api/me", cookie)).json()) as any).csrf; }
  const h: Record<string, string> = { cookie, origin: ORIGIN, "content-type": "application/json" };
  if (who !== "nocsrf") h["x-csrf-token"] = csrf;
  return app.fetch(new Request(ORIGIN + path, { method: "POST", headers: h, body: JSON.stringify(body) }), env);
};
const SID = "build-host:lane2:steer-test-x";

describe("remote steering routes (real hub path)", () => {
  test("CSRF + session gate: no cookie 401, missing CSRF token 403, hub untouched", async () => {
    const h = steerHub(); const env = mkEnv(h.rpc);
    expect((await app.fetch(new Request(ORIGIN + "/api/remote/commands", { method: "POST", body: "{}" }), env)).status).toBe(401);
    expect((await post(env, "/api/remote/commands", { session_id: SID, text: "x" }, "nocsrf")).status).toBe(403);
    expect(h.calls.length).toBe(0);
  });
  test("create passes the SSO user as actor; approve passes actor + nonce; reject passes actor", async () => {
    const h = steerHub(); const env = mkEnv(h.rpc);
    const r = await post(env, "/api/remote/commands", { session_id: SID, text: "do the thing" });
    expect(r.status).toBe(201); const j = (await r.json()) as any; expect(j.nonce.length).toBe(48); expect(j.command.text).toBe("do the thing");
    expect(h.calls[0]).toEqual({ fn: "commandCreate", args: ["example-user", SID, "do the thing"] });
    const a = await post(env, "/api/remote/commands/c1/approve", { nonce: j.nonce }); expect(a.status).toBe(200); expect(((await a.json()) as any).state).toBe("approved");
    expect(h.calls[1]).toEqual({ fn: "commandApprove", args: ["example-user", "c1", j.nonce] });
    expect((await post(env, "/api/remote/commands/c1/reject", {})).status).toBe(200);
    expect(h.calls[2]).toEqual({ fn: "commandReject", args: ["example-user", "c1"] });
    expect(((await (await post(env, "/api/remote/commands/c1/nonce", {})).json()) as any).nonce.length).toBe(48);
  });
  test("approve without a nonce is refused before the hub; hub error codes pass through (409 running, 403 nonce, 422, 429)", async () => {
    const err = (status: number, error: string) => () => ({ ok: false, status, error });
    const h = steerHub({ commandCreate: err(409, "session is running"), commandApprove: err(403, "bad or expired nonce") }); const env = mkEnv(h.rpc);
    expect((await post(env, "/api/remote/commands/c1/approve", {})).status).toBe(400);
    expect(h.calls.length).toBe(0);
    const c = await post(env, "/api/remote/commands", { session_id: SID, text: "x" }); expect(c.status).toBe(409); expect(((await c.json()) as any).error).toBe("session is running");
    expect((await post(env, "/api/remote/commands/c1/approve", { nonce: "z".repeat(40) })).status).toBe(403);
    for (const [st, er] of [[422, "text contains a secret-shaped value"], [429, "rate limit"]] as const) {
      const e2 = mkEnv(steerHub({ commandCreate: err(st, er) }).rpc);
      expect((await post(e2, "/api/remote/commands", { session_id: SID, text: "x" })).status).toBe(st);
    }
  });
  test("bad input never reaches the hub; hub crash -> generic 502; GET command 404", async () => {
    const h = steerHub({ commandCreate: () => { throw new Error("secret-detail"); } }); const env = mkEnv(h.rpc);
    expect((await post(env, "/api/remote/commands", { session_id: "../x", text: "x" })).status).toBe(400);
    expect((await post(env, "/api/remote/commands", { session_id: SID })).status).toBe(400);
    expect(h.calls.length).toBe(0);
    const r = await post(env, "/api/remote/commands", { session_id: SID, text: "x" }); expect(r.status).toBe(502); expect(await r.text()).not.toContain("secret-detail");
    const c = await erich(env);
    expect((await get(env, "/api/remote/commands/gone", c)).status).toBe(404);
    expect((await get(env, "/api/remote/commands/c9", c)).status).toBe(200);
    expect((await get(env, "/api/remote/commands/" + encodeURIComponent("../x"), c)).status).toBe(404);
  });
  test("not bound -> 503 on every steering route", async () => {
    const env = mkEnv(undefined);
    for (const p of ["/api/remote/commands", "/api/remote/commands/c1/approve", "/api/remote/commands/c1/reject", "/api/remote/commands/c1/nonce"]) expect((await post(env, p, { session_id: SID, text: "x", nonce: "n".repeat(40) })).status).toBe(503);
  });
});

describe("remote steering: e2e simulation (scope e2e only, hub never consulted)", () => {
  const DONE = "e2e-host:lane2:e2e-done";
  const setup = () => { const h = steerHub(); const x = d1(); const env = { ...mkEnv(h.rpc), DB: x.d1 } as Env; return { h, env, db: x.db }; };
  test("create -> confirm required (still pending) -> approve walks to done; replayed nonce 409", async () => {
    const { h, env, db } = setup();
    const r = await post(env, "/api/remote/commands", { session_id: DONE, text: "please continue" }, "bot"); expect(r.status).toBe(201);
    const j = (await r.json()) as any; expect(j.command.state).toBe("pending"); expect(j.command.requested_by).toBe("e2e-bot");
    expect(((await (await get(env, "/api/remote/commands/" + j.command.id, await bot(env))).json()) as any).state).toBe("pending"); // nothing runs without the tap
    const a = await post(env, `/api/remote/commands/${j.command.id}/approve`, { nonce: j.nonce }, "bot"); expect(a.status).toBe(200);
    expect(((await a.json()) as any).state).toBe("approved");
    expect((await post(env, `/api/remote/commands/${j.command.id}/approve`, { nonce: j.nonce }, "bot")).status).toBe(409);
    db.query("UPDATE e2e_commands SET approved_at = approved_at - 10").run();
    const c = (await (await get(env, "/api/remote/commands/" + j.command.id, await bot(env))).json()) as any;
    expect(c.state).toBe("done"); expect(c.result_summary).toContain("ok");
    expect(h.calls.length).toBe(0);
  });
  test("wrong nonce 403, cancel -> rejected, one open command per session, refused/failed simulated, running/non-lane2/secret refused", async () => {
    const { env, db } = setup();
    const mk = async (text: string, sid = DONE) => post(env, "/api/remote/commands", { session_id: sid, text }, "bot");
    const c1 = (await (await mk("one")).json()) as any;
    expect((await post(env, `/api/remote/commands/${c1.command.id}/approve`, { nonce: "q".repeat(48) }, "bot")).status).toBe(403);
    expect((await mk("two")).status).toBe(409);
    const rj = await post(env, `/api/remote/commands/${c1.command.id}/reject`, {}, "bot"); expect(((await rj.json()) as any).state).toBe("rejected");
    expect((await post(env, `/api/remote/commands/${c1.command.id}/approve`, { nonce: c1.nonce }, "bot")).status).toBe(409);
    for (const [word, want] of [["REFUSEME", "refused"], ["FAILME", "failed"]] as const) {
      const c = (await (await mk(word)).json()) as any;
      await post(env, `/api/remote/commands/${c.command.id}/approve`, { nonce: c.nonce }, "bot");
      db.query("UPDATE e2e_commands SET approved_at = approved_at - 10").run();
      expect(((await (await get(env, "/api/remote/commands/" + c.command.id, await bot(env))).json()) as any).state).toBe(want);
    }
    expect((await mk("x", "e2e-host:lane2:e2e-running")).status).toBe(409);
    expect((await mk("x", "e2e-host:runner:e2e-failed")).status).toBe(422);
    expect((await mk("SECRETSHAPE")).status).toBe(422);
    expect((await mk("x", "build-host:lane2:steer-test-x")).status).toBe(404); // real sessions don't exist for e2e
    const d = (await (await get(env, "/api/remote/sessions/" + encodeURIComponent(DONE), await bot(env))).json()) as any;
    expect(d.commands.length).toBeGreaterThanOrEqual(3);
  });
  test("nonce expiry: an expired nonce is refused (403) and a fresh one works", async () => {
    const { env, db } = setup();
    const c = (await (await post(env, "/api/remote/commands", { session_id: DONE, text: "x" }, "bot")).json()) as any;
    db.query("UPDATE e2e_commands SET nonce_expires_at = nonce_expires_at - 500").run();
    expect((await post(env, `/api/remote/commands/${c.command.id}/approve`, { nonce: c.nonce }, "bot")).status).toBe(403);
    const n = (await (await post(env, `/api/remote/commands/${c.command.id}/nonce`, {}, "bot")).json()) as any;
    expect((await post(env, `/api/remote/commands/${c.command.id}/approve`, { nonce: n.nonce }, "bot")).status).toBe(200);
  });
});
