// Team edition (g:<uid> bases): every user with Open enabled can add their OWN provider key and use the built-in presets. REAL createApp handlers over an in-memory D1 built from
// the real migrations, then the REAL registry/adapter against a fake upstream. Isolation, fail closed, never the shared Worker secret. Fake keys only.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Env } from "../src/index";
import { createApp } from "../src/index";
import type { GuestScope } from "../src/scope";
import { makeSession } from "../src/auth";
import { setOpenFlag } from "../src/open-space";
import { buildRegistry } from "../src/providers/registry";
import { builtinPresetConfigs } from "../src/providers/config";
import { NVIDIA_VERIFIED } from "../src/providers/presets";
import { userKeyIds, userKeysFor } from "../src/user-keys";
import { resetPutLimit } from "../src/provider-routes";
import { FAKE, FAKE_B, gw, GA, upstream, fetchImpl, mkEnv } from "./user-keys-harness";

const GB = "g:bbbbbbbbbbbbbbbbbbbbbbbb" as GuestScope;
const WORKER = "worker-secret-SHARED-0000111122223333";
const app = createApp({ fetchImpl, scopeOf: (s) => (s.u === "guest-a" ? GA : s.u === "guest-b" ? GB : s.via === "e2e" ? "e2e" : "main"), provider: () => gw });
const logs: string[] = []; let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => { resetPutLimit(); upstream.length = 0; logs.length = 0; spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); })); });
afterEach(() => spies.forEach((s) => s.mockRestore()));

async function call(env: Env, user: string, method: string, path: string, b?: unknown, space?: "open") {
  let cookie: string, csrf: string;
  if (user === "e2e") { const r = await app.fetch(new Request("https://app.test/auth/e2e", { method: "POST", headers: { "x-e2e-token": (env as any).E2E_TOKEN } }), env); cookie = r.headers.get("set-cookie")!.split(";")[0]!; csrf = ((await (await app.fetch(new Request("https://app.test/api/me", { headers: { cookie } }), env)).json()) as any).csrf; }
  else { const m = await makeSession(env, user, "github"); cookie = m.cookie.split(";")[0]!; csrf = m.session.csrf; }
  return app.fetch(new Request("https://app.test" + path, { method, headers: { cookie, origin: "https://app.test", "x-csrf-token": csrf, "content-type": "application/json", ...(space ? { "x-vc-space": space } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }), env);
}
const j = async (r: Response) => (await r.json()) as any;
const env0 = async (o: { worker?: string; flags?: GuestScope[] } = {}) => { const e = mkEnv({ worker: o.worker }); e.ALLOWED_GITHUB_LOGINS = "example-user,guest-a,guest-b"; for (const g of o.flags ?? [GA, GB]) await setOpenFlag(e.DB!, g, true); return e; };
const nvidia = async (e: Env, u: string) => (await j(await call(e, u, "GET", "/api/providers", undefined, "open"))).providers.find((p: any) => p.id === "nvidia");
const modelIds = async (e: Env, u: string) => (await j(await call(e, u, "GET", "/api/models", undefined, "open"))).models.map((m: any) => m.id as string);
const put = (e: Env, u: string, k: string) => call(e, u, "PUT", "/api/providers/nvidia/key", { key: k });

describe("team key routes: gates", () => {
  test("Open not enabled for the user, or e2e: every provider route is 403 and nothing is stored", async () => {
    const e = await env0({ flags: [] }); await setOpenFlag(e.DB!, GA, false); await setOpenFlag(e.DB!, GB, false); // default is ON now: the kill switch row is what turns it off
    expect((await put(e, "guest-a", FAKE)).status).toBe(403);
    expect((await call(e, "guest-a", "DELETE", "/api/providers/nvidia/key")).status).toBe(403);
    expect((await call(e, "guest-a", "GET", "/api/providers/presets")).status).toBe(403);
    expect((await call(e, "guest-a", "GET", "/api/providers", undefined, "open")).status).toBe(403);
    await setOpenFlag(e.DB!, GA, false);
    expect((await put(e, "guest-a", FAKE)).status).toBe(403);
    expect((await put(e, "e2e", FAKE)).status).toBe(403);
    expect((await call(e, "e2e", "DELETE", "/api/providers/nvidia/key")).status).toBe(403);
    expect(e._db.query(`SELECT count(*) n FROM provider_user_keys`).get()).toEqual({ n: 0 });
  });
  test("OPEN_SPACE=off beats the per-user flag", async () => {
    const e = await env0(); (e as any).OPEN_SPACE = "off";
    expect((await put(e, "guest-a", FAKE)).status).toBe(403);
  });
  test("row writes, model listing, custom URLs and provider delete stay main-only (presets only on team)", async () => {
    const e = await env0();
    for (const [m, p, b] of [["PUT", "/api/providers/evil", { baseUrl: "https://evil.example.com/v1" }], ["PUT", "/api/providers/nvidia", { baseUrl: "https://evil.example.com/v1" }], ["PUT", "/api/providers/nvidia", {}], ["DELETE", "/api/providers/nvidia", undefined], ["POST", "/api/providers/nvidia/models", {}]] as const)
      expect((await call(e, "guest-a", m, p, b, "open")).status, `${m} ${p}`).toBe(403);
    expect(e._db.query(`SELECT count(*) n FROM provider_configs`).get()).toEqual({ n: 0 });
    // a custom provider id has no preset: unknown, nothing stored
    expect((await call(e, "guest-a", "PUT", "/api/providers/evil/key", { key: FAKE })).status).toBe(404);
    expect(e._db.query(`SELECT count(*) n FROM provider_user_keys`).get()).toEqual({ n: 0 });
  });
});

describe("team presets and the picker", () => {
  test("with Open on and NO key: NVIDIA is listed as 'needs-key', hidden from the picker, and the shared Worker secret is NOT used", async () => {
    const e = await env0({ worker: WORKER });
    const p = await nvidia(e, "guest-a");
    expect(p).toMatchObject({ id: "nvidia", status: "needs-key", key_source: "none", keySet: false, presetOnly: true, editable: true, host: "integrate.api.nvidia.com" });
    expect((await modelIds(e, "guest-a")).filter((x: string) => x.startsWith("nvidia:"))).toEqual([]);
    // main, same worker secret: still falls back to it (unchanged)
    expect(await nvidia(e, "example-user")).toMatchObject({ key_source: "worker", status: "enabled" });
    expect(JSON.stringify(await j(await call(e, "guest-a", "GET", "/api/providers/configured")))).not.toContain(WORKER);
  });
  test("after the user's own key: the verified NVIDIA models appear (only for that user); remove hides them again", async () => {
    const e = await env0();
    const r = await put(e, "guest-a", FAKE); expect(r.status).toBe(200); expect(await j(r)).toEqual({ ok: true, key_source: "user" });
    expect((await nvidia(e, "guest-a"))).toMatchObject({ status: "enabled", key_source: "user" });
    expect((await modelIds(e, "guest-a")).filter((x: string) => x.startsWith("nvidia:")).sort()).toEqual(NVIDIA_VERIFIED.map((x) => `nvidia:${x}`).sort());
    expect((await modelIds(e, "guest-b")).some((x: string) => x.startsWith("nvidia:"))).toBe(false);          // B cannot see A's key
    expect((await modelIds(e, "example-user")).some((x: string) => x.startsWith("nvidia:"))).toBe(false);   // nor can main
    expect((await call(e, "guest-a", "DELETE", "/api/providers/nvidia/key")).status).toBe(200);
    expect((await modelIds(e, "guest-a")).some((x: string) => x.startsWith("nvidia:"))).toBe(false);
    for (const t of logs) expect(t).not.toContain(FAKE);
  });
  test("a main user's key is not visible to a team user and removing a team key does not touch main's", async () => {
    const e = await env0();
    expect((await put(e, "example-user", FAKE_B)).status).toBe(200);
    expect(await nvidia(e, "guest-a")).toMatchObject({ key_source: "none", status: "needs-key" });
    expect((await put(e, "guest-a", FAKE)).status).toBe(200);
    expect((await call(e, "guest-a", "DELETE", "/api/providers/nvidia/key")).status).toBe(200);
    expect(await nvidia(e, "example-user")).toMatchObject({ key_source: "user" });
  });
  test("builtin presets: main gets the Worker-secret binding, a team base none, e2e nothing", () => {
    expect(builtinPresetConfigs("main")[0]).toMatchObject({ id: "nvidia", keyBinding: "PROVIDER_KEY_NVIDIA" });
    expect(builtinPresetConfigs(GA)[0]!.keyBinding).toBeUndefined(); expect(builtinPresetConfigs(GA)[0]!.allowGuests).toBe(true); expect(builtinPresetConfigs("e2e")).toEqual([]);
  });
});

describe("team: REAL handler -> REAL registry/adapter -> upstream", () => {
  const reg = async (e: Env, g: GuestScope) => buildRegistry({ scope: `${g}~open` as never, gateway: null, env: e as unknown as Record<string, unknown>, fetchImpl, userKeys: userKeysFor(e, g, await userKeyIds(e.DB, g)) });
  const msg = (r: Awaited<ReturnType<typeof reg>>) => r.router.messages({ model: "nvidia:nvidia/nemotron-3-ultra-550b-a55b", messages: [{ role: "user", content: "hi" }], stream: true } as any);
  test("no own key => no upstream call at all, even with the shared Worker secret provisioned", async () => {
    const e = await env0({ worker: WORKER });
    await expect(msg(await reg(e, GA))).rejects.toThrow();
    expect(upstream).toHaveLength(0);
  });
  test("own key => upstream gets exactly that user's key, to the preset origin only; the other user still has none", async () => {
    const e = await env0({ worker: WORKER });
    expect((await put(e, "guest-a", FAKE)).status).toBe(200); expect((await put(e, "guest-b", FAKE_B)).status).toBe(200);
    await (await msg(await reg(e, GA))).text(); await (await msg(await reg(e, GB))).text();
    expect(upstream.map((u) => new URL(u.url).origin)).toEqual(["https://integrate.api.nvidia.com", "https://integrate.api.nvidia.com"]);
    expect(upstream[0]!.headers.authorization).toBe(`Bearer ${FAKE}`); expect(upstream[1]!.headers.authorization).toBe(`Bearer ${FAKE_B}`);
    expect(JSON.stringify(upstream)).not.toContain(WORKER);
    // delete A's key: next call fails closed, B unaffected
    await call(e, "guest-a", "DELETE", "/api/providers/nvidia/key"); upstream.length = 0;
    await expect(msg(await reg(e, GA))).rejects.toThrow(); expect(upstream).toHaveLength(0);
    await (await msg(await reg(e, GB))).text(); expect(upstream).toHaveLength(1);
  });
  test("origin binding and fail-closed survive: a key saved for another origin / an unreadable row is never sent and never replaced by the Worker secret", async () => {
    const e = await env0({ worker: WORKER });
    expect((await put(e, "guest-a", FAKE)).status).toBe(200);
    e._db.query(`UPDATE provider_user_keys SET origin='https://other.example.com' WHERE base=?`).run(GA);
    expect(await nvidia(e, "guest-a")).toMatchObject({ key_source: "stale" });
    await expect(msg(await reg(e, GA))).rejects.toThrow(); expect(upstream).toHaveLength(0);
    e._db.query(`UPDATE provider_user_keys SET origin='https://integrate.api.nvidia.com', ct='AAAA' WHERE base=?`).run(GA);
    await expect(msg(await reg(e, GA))).rejects.toThrow(); expect(upstream).toHaveLength(0);
  });
});
