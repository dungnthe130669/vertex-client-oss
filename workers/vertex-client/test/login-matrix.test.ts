// conv3: ONE codebase, login methods chosen purely by env vars. Matrix of GitHub / SSO / team configs -> /auth/config + login routes (fail closed).
import { describe, expect, test } from "bun:test";
import { createApp, type Env } from "../src/index";
import { loginMethods } from "../src/auth";

const ORIGIN = "https://app.test";
const app = createApp({ provider: () => ({ name: "stub", listModels: async () => [], messages: async () => new Response("{}") }) });
const GH = { GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csec" };
const SSO = { SSO_PUBLIC_KEYS: "{}", SSO_AUTH_ORIGIN: "https://auth.test" };
const TEAM = { TEAM_GATEWAY_URL: "https://gw.test", TEAM_ORIGIN: ORIGIN, TEAM_JWKS: "{}", VCLIENT_TEAM_CALLER_KEY: "k" };
const env = (over: Record<string, unknown>) => ({ SESSION_SECRET: "test-secret-0123456789", DB: {} as never, CHAT: {} as never, ASSETS: { fetch: async () => new Response("x") }, ...over }) as unknown as Env;
const get = (e: Env, p: string) => app.fetch(new Request(ORIGIN + p), e);
const cfg = async (e: Env) => (await (await get(e, "/auth/config")).json()) as Record<string, unknown>;

const cases: Array<{ name: string; vars: Record<string, unknown>; config: Record<string, unknown>; login: number; github: number; team: number }> = [
  { name: "none", vars: {}, config: { github: false, sso: false }, login: 503, github: 503, team: 404 },
  { name: "github only (today's main without SSO)", vars: GH, config: { github: true, sso: false }, login: 302, github: 302, team: 404 },
  { name: "sso only", vars: SSO, config: { github: false, sso: true }, login: 302, github: 503, team: 404 },
  { name: "team only (today's team instance)", vars: TEAM, config: { github: false, sso: false, team: true }, login: 503, github: 503, team: 302 },
  { name: "team + github", vars: { ...TEAM, ...GH }, config: { github: true, sso: false, team: true }, login: 302, github: 302, team: 302 },
  { name: "main today: github + sso", vars: { ...GH, ...SSO }, config: { github: true, sso: true }, login: 302, github: 302, team: 404 },
  { name: "all three", vars: { ...TEAM, ...GH, ...SSO }, config: { github: true, sso: true, team: true }, login: 302, github: 302, team: 302 },
];

describe("login matrix (env vars only)", () => {
  for (const c of cases) {
    test(c.name, async () => {
      const e = env(c.vars);
      expect(await cfg(e)).toEqual(c.config);
      expect((await get(e, "/auth/login?sso=1")).status).toBe(c.github);   // sso=1 = straight to GitHub, 503 when GitHub is not configured
      expect((await get(e, "/auth/github")).status).toBe(c.github);
      expect((await get(e, "/auth/team")).status).toBe(c.team);
      const m = loginMethods(e as never);
      expect(m.github).toBe(c.config.github as boolean); expect(m.sso).toBe(c.config.sso as boolean); expect(m.team).toBe(!!c.config.team);
    });
  }
  test("none enabled: no login route ever issues a cookie", async () => {
    for (const p of ["/auth/login", "/auth/github", "/auth/team", "/auth/callback?code=x&state=y", "/auth/team/callback?assertion=x&state=y"]) {
      const r = await get(env({}), p); expect([404, 503]).toContain(r.status); expect(r.headers.get("set-cookie") ?? "").not.toContain("vc_session");
    }
  });
  test("team vars alone do not enable GitHub, GitHub vars alone do not enable team", async () => {
    expect((await cfg(env(TEAM))).github).toBe(false);
    expect("team" in (await cfg(env(GH)))).toBe(false);
  });
});
