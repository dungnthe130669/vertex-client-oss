import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { teamUidFor } from "../src/team-auth";
import { clearEntitlementCache } from "../src/providers/team-gateway";

const ORIGIN = "https://app.test";
const PW = "p".repeat(24);
function mk(over: Record<string, unknown> = {}, list: string | null = "Erich@Example.test", key = "dev_login_emails:main") {
  const db = new Database(":memory:");
  for (const f of ["0001_init.sql", "0022_team_users.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  if (list !== null) db.query(`INSERT INTO settings (name,value) VALUES (?, ?)`).run(key, list);
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }), run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; },
  } as any);
  return { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", DEV_LOGIN_SECRET: PW, ASSETS: { fetch: async () => new Response("x") },
    GATEWAY: { fetch: async () => new Response("{}") }, DB: { prepare: (q: string) => stmt(q) }, CHAT: {}, _db: db, ...over } as unknown as Env & { _db: Database };
}
const app = createApp();
const post = (env: Env, path: string, b: unknown) => app.fetch(new Request(ORIGIN + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), env);
const cfg = async (env: Env) => (await (await app.fetch(new Request(ORIGIN + "/auth/config"), env)).json()) as Record<string, unknown>;

describe("dev login (email-first)", () => {
  test("off by default: no secret, or empty/absent list -> no email step, 404s", async () => {
    for (const env of [mk({ DEV_LOGIN_SECRET: undefined }), mk({}, null), mk({}, " , ")]) {
      expect((await cfg(env)).emailStep).toBeUndefined();
      expect((await post(env, "/auth/dev-login/check", { email: "erich@example.test" })).status).toBe(404);
      expect((await post(env, "/auth/dev-login", { email: "erich@example.test", password: PW })).status).toBe(404);
    }
  });
  test("team edition with only the MAIN row set: off", async () => {
    const env = mk({ TEAM_GATEWAY_URL: "https://gw.test" });
    expect((await cfg(env)).emailStep).toBeUndefined();
    expect((await post(env, "/auth/dev-login", { email: "erich@example.test", password: PW })).status).toBe(404);
  });
  test("on: listed email (any case) asks for a password, unlisted does not", async () => {
    const env = mk();
    expect((await cfg(env)).emailStep).toBe(true);
    expect(await (await post(env, "/auth/dev-login/check", { email: " ERICH@example.test" })).json()).toEqual({ password: true });
    expect(await (await post(env, "/auth/dev-login/check", { email: "other@example.test" })).json()).toEqual({ password: false });
  });
  test("listed + right password -> the normal main session", async () => {
    const env = mk();
    const r = await post(env, "/auth/dev-login", { email: "erich@example.test", password: PW });
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toContain("Max-Age=2592000"); expect(sc).toContain("HttpOnly");
    const me = await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: sc.split(";")[0] } }), env);
    expect(await me.json()).toMatchObject({ user: "example-user", via: "github", erichOnly: true });
  });
  test("wrong password / unlisted email / junk: generic 401, no cookie", async () => {
    const env = mk();
    for (const b of [{ email: "erich@example.test", password: "wrong" }, { email: "other@example.test", password: PW }, { email: 1, password: 2 }, {}]) {
      const r = await post(env, "/auth/dev-login", b);
      expect(r.status).toBe(401); expect(await r.text()).toBe('{"error":"unauthorized"}'); expect(r.headers.get("set-cookie")).toBeNull();
    }
  });
  test("email=login entry must name an allowlisted login, else that email is not listed", async () => {
    const env = mk({ ALLOWED_GITHUB_LOGINS: "example-user,second" }, "a@x.test=second,b@x.test=nobody");
    expect(await (await post(env, "/auth/dev-login/check", { email: "a@x.test" })).json()).toEqual({ password: true });
    expect(await (await post(env, "/auth/dev-login/check", { email: "b@x.test" })).json()).toEqual({ password: false });
  });
});

describe("dev login on the team edition", () => {
  const TEAM = { TEAM_GATEWAY_URL: "https://tg.test", VCLIENT_TEAM_CALLER_KEY: "caller-key", ALLOWED_GITHUB_LOGINS: "" };
  const EM = "ann@example.com";
  const team = (over: Record<string, unknown> = {}, list: string | null = EM, seed = true) => {
    const env = mk({ ...TEAM, ...over }, list, "dev_login_emails:team") as Env & { _db: Database };
    if (seed) env._db.query(`INSERT INTO team_users (uid, gateway_uid, email, status, created_at, last_login_at) VALUES (?,?,?,'active',1,1)`).run("a".repeat(24), "gw-ann", EM);
    return env;
  };
  const gw = (features: string[], status = 200) => createApp({ fetchImpl: (async () => new Response(JSON.stringify({ features }), { status })) as never });

  test("off by default on team: no secret, no team row, or only the main row", async () => {
    for (const env of [team({ DEV_LOGIN_SECRET: undefined }), team({}, null), mk(TEAM, EM, "dev_login_emails:main")]) {
      expect((await cfg(env)).emailStep).toBeUndefined();
      expect((await post(env, "/auth/dev-login", { email: EM, password: PW })).status).toBe(404);
    }
  });
  test("listed + password -> a real team session (via team, uid from team_users, 7d), entitlements still checked per request", async () => {
    clearEntitlementCache();
    const env = team();
    expect((await cfg(env)).emailStep).toBe(true);
    expect(await (await post(env, "/auth/dev-login/check", { email: "ANN@example.com" })).json()).toEqual({ password: true });
    const r = await post(env, "/auth/dev-login", { email: EM, password: PW });
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toContain(`Max-Age=${7 * 24 * 3600}`);
    const me = await gw(["vclient_app", "chat"]).fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: sc.split(";")[0] } }), env);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: EM, via: "team", team: true });
    // gateway withdraws the entitlement -> the dev session is refused like any team session
    clearEntitlementCache();
    expect((await gw([]).fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: sc.split(";")[0] } }), env)).status).toBe(403);
  });
  test("uid equals the one a real login derives for that gateway user", async () => {
    const env = team({}, EM, false);
    const uid = await teamUidFor("gw-ann");
    env._db.query(`INSERT INTO team_users (uid, gateway_uid, email, status, created_at, last_login_at) VALUES (?,?,?,'active',1,1)`).run(uid, "gw-ann", EM);
    const sc = (await post(env, "/auth/dev-login", { email: EM, password: PW })).headers.get("set-cookie")!;
    clearEntitlementCache();
    const s = await (await import("../src/auth")).readSession(new Request(ORIGIN, { headers: { cookie: sc.split(";")[0] } }), env);
    expect(s).toMatchObject({ via: "team", uid, u: EM });
  });
  test("no prior real team login (no team_users row) or a disabled user: refused, nothing created", async () => {
    const none = team({}, EM, false);
    expect((await post(none, "/auth/dev-login", { email: EM, password: PW })).status).toBe(401);
    expect(none._db.query(`SELECT count(*) c FROM team_users`).get()).toEqual({ c: 0 });
    const off = team();
    off._db.query(`UPDATE team_users SET status='disabled'`).run();
    expect((await post(off, "/auth/dev-login", { email: EM, password: PW })).status).toBe(401);
  });
  test("unlisted email / wrong password on team: 401 or password:false", async () => {
    const env = team();
    expect(await (await post(env, "/auth/dev-login/check", { email: "bob@example.com" })).json()).toEqual({ password: false });
    for (const b of [{ email: EM, password: "wrong" }, { email: "bob@example.com", password: PW }]) {
      const r = await post(env, "/auth/dev-login", b);
      expect(r.status).toBe(401); expect(r.headers.get("set-cookie")).toBeNull();
    }
  });
  test("main edition still works", async () => {
    const r = await post(mk(), "/auth/dev-login", { email: "erich@example.test", password: PW });
    expect(r.status).toBe(200);
  });
});
