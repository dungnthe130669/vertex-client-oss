import { describe, expect, test } from "bun:test";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { versionReply } from "../src/version";

const ORIGIN = "https://app.test";
const VJ = JSON.stringify({ build: "0123456789ab", commit: "abcdef123456", builtAt: "2026-10-20T01:02:03Z" });
const mk = (assets: () => Response | Promise<Response>, meta?: { id?: string }): Env => ({
  SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "SECRET-GW-KEY",
  ASSETS: { fetch: async () => assets() }, GATEWAY: { fetch: async () => new Response("{}") }, DB: {} as never, CHAT: {} as never, CF_VERSION_METADATA: meta,
} as never);
const app = createApp();
const get = async (env: Env, authed: boolean) => {
  const h = new Headers({ origin: ORIGIN });
  if (authed) h.set("cookie", (await makeSession(env, "example-user", "github")).cookie.split(";")[0]);
  return app.fetch(new Request(ORIGIN + "/api/version", { headers: h }), env);
};

describe("GET /api/version", () => {
  test("unauthenticated -> 401, no data", async () => {
    const r = await get(mk(() => new Response(VJ)), false);
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("0123456789ab");
  });
  test("authenticated: exact shape, worker id from the binding, build facts from version.json", async () => {
    const r = await get(mk(() => new Response(VJ), { id: "06bed9b6-3653-4cf1-b0fd-9a763f2d9286" }), true);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ worker_version_id: "06bed9b6-3653-4cf1-b0fd-9a763f2d9286", build: "0123456789ab", commit: "abcdef123456", builtAt: "2026-10-20T01:02:03Z" });
  });
  test("binding absent -> worker_version_id null", async () => {
    expect((await (await get(mk(() => new Response(VJ)), true)).json() as any).worker_version_id).toBeNull();
  });
  test("version.json missing / HTML fallback / throws -> nulls, still 200", async () => {
    for (const a of [() => new Response("nope", { status: 404 }), () => new Response("<html></html>"), () => { throw new Error("boom"); }]) {
      const r = await get(mk(a), true);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ worker_version_id: null, build: null, commit: null, builtAt: null });
    }
  });
  test("no secrets: only the four keys, junk values are dropped, env secrets never appear", async () => {
    const env = mk(() => new Response(JSON.stringify({ build: "x".repeat(40), commit: "<script>", builtAt: "now", extra: "SECRET-GW-KEY", secret: "s" })), { id: "not a uuid!" });
    const body = await (await get(env, true)).text();
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(["build", "builtAt", "commit", "worker_version_id"]);
    expect(body).not.toContain("SECRET");
    expect(JSON.parse(body)).toEqual({ worker_version_id: null, build: null, commit: null, builtAt: null });
  });
  test("versionReply: 'unknown' commit/builtAt pass through", async () => {
    const r = await versionReply({ ASSETS: { fetch: async () => new Response(JSON.stringify({ build: "0123456789ab", commit: "unknown", builtAt: "unknown" })) } as never });
    expect(r).toEqual({ worker_version_id: null, build: "0123456789ab", commit: "unknown", builtAt: "unknown" });
  });
});
