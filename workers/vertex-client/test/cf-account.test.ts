// "Link your own Cloudflare account": pure helpers, the settings routes (scope gate, write-only token, test button), REST routing of Workers AI / Browser Rendering to the
// user's account (shared bindings otherwise, fail closed on an unreadable row), registry gating, per-user feature flags, and the Settings wording.
import type { GuestScope } from "../src/scope";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { setOpenFlag } from "../src/open-space";
import { ACCOUNT_ID, CF_ACCT_PROVIDER, CF_API, CF_OWN_BROWSE_PER_TURN, CF_OWN_MAX_TOKENS, CF_ORIGIN, REST_PATH, cfAccountOf, cfFetch, cfVerify, decodeCreds, encodeCreds, parseLinkBody } from "../src/cf-account";
import { cloudflareProvider } from "../src/providers/cloudflare";
import { buildRegistry } from "../src/providers/registry";
import { CLOUDFLARE_ID, PROVIDERS, type ProviderConfig } from "../src/providers/config";
import { ProviderError } from "../src/providers/types";
import { cfToolsHost, restBrowser } from "../src/cf-tools";
import { FEATURES, featuresOf, setFeature } from "../src/features";
import { putUserKey, userKeyOf, userKeysFor } from "../src/user-keys";
import { scopeFor } from "../src/scope";
import { CF_PROVIDERS_NOTICE, cfBadge, cfUsing, linkError, testNote } from "../web/src/cf-account-logic";
import { chatMock } from "./do-mock";

const ACCT = "0123456789abcdef0123456789abcdef";
const TOKEN = "TESTFIXTURENOTAREALTOKEN00000000000000ABCD";
const SECRET = "test-key-enc-secret-0123456789";
const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
const GB = "g:bbbbbbbbbbbbbbbbbbbbbbbb" as GuestScope;

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }), run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; }, _run: () => db.query(q).run(...(b as any)) });
  return { db, d: { prepare: (q: string) => stmt(q), batch: async (l: any[]) => { for (const s of l) s._run(); return []; } } as unknown as D1Database };
}

describe("cf-account: helpers", () => {
  test("parseLinkBody validates the account id and the token, and never echoes the value", () => {
    expect(parseLinkBody({ accountId: ` ${ACCT.toUpperCase()} `, token: ` ${TOKEN} ` })).toEqual({ creds: { accountId: ACCT, token: TOKEN } });
    for (const b of [null, {}, { accountId: "short", token: TOKEN }, { accountId: ACCT, token: "has space in it 0123456789" }, { accountId: ACCT, token: "x" }, { accountId: ACCT, token: "a".repeat(201) }, { accountId: ACCT, token: 5 }, { accountId: `${ACCT}x`, token: TOKEN }]) {
      const r = parseLinkBody(b) as { error?: string }; expect(r.error, JSON.stringify(b)).toBeTruthy(); expect(r.error).not.toContain(TOKEN);
    }
  });
  test("encode/decode round trip; a mangled blob is refused", () => {
    expect(decodeCreds(encodeCreds({ accountId: ACCT, token: TOKEN }))).toEqual({ accountId: ACCT, token: TOKEN });
    for (const s of ["", "nocolon", `zz:${TOKEN}`, `${ACCT}:bad token`, `${ACCT}:`]) expect(decodeCreds(s), s).toBeNull();
  });
  test("REST path allowlist: only /ai/run/@cf/<v>/<m> and the three browser quick actions used; nothing else", () => {
    for (const p of ["ai/run/@cf/meta/llama-3.1-8b-instruct-fp8", "ai/run/@cf/black-forest-labs/flux-1-schnell", "browser-rendering/markdown", "browser-rendering/links", "browser-rendering/screenshot"]) expect(REST_PATH.test(p), p).toBe(true);
    for (const p of ["", "../user/tokens", "ai/run/@cf/a/b/../../x", "ai/run/gpt-4", "ai/run/@cf/a/b?x=1", "ai/run/@cf/a/b#f", "d1/database", "browser-rendering/evil", "/ai/run/@cf/a/b", "ai/run/@cf//b", "https://evil.test/ai/run/@cf/a/b", "ai/run/@cf/a/b/c"]) expect(REST_PATH.test(p), p).toBe(false);
    expect(ACCOUNT_ID.test(ACCT)).toBe(true);
  });
  test("cfFetch: fixed origin, bearer header, redirect manual; bad path / bad account id / oversize body never reach the network; a 3xx is an error", async () => {
    const seen: any[] = []; const f = (async (u: string, i: any) => { seen.push({ u, i }); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const c = { accountId: ACCT, token: TOKEN };
    await cfFetch(c, "ai/run/@cf/meta/x-y", { body: "{}" }, f);
    expect(seen[0].u).toBe(`${CF_API}/accounts/${ACCT}/ai/run/@cf/meta/x-y`); expect(seen[0].u.startsWith(CF_ORIGIN + "/")).toBe(true);
    expect(seen[0].i.redirect).toBe("manual"); expect(seen[0].i.headers.authorization).toBe(`Bearer ${TOKEN}`);
    for (const bad of [() => cfFetch(c, "d1/x", {}, f), () => cfFetch({ accountId: "../x", token: TOKEN }, "browser-rendering/links", {}, f), () => cfFetch(c, "browser-rendering/links", { body: "x".repeat(2_000_001) }, f)]) await expect(bad()).rejects.toThrow();
    expect(seen.length).toBe(1);
    const red = (async () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } })) as unknown as typeof fetch;
    expect((await cfFetch(c, "browser-rendering/links", { body: "{}" }, red)).status).toBe(502);
    try { await cfFetch(c, "d1/x", {}, f); } catch (e) { expect(String(e)).not.toContain(TOKEN); }
  });
  test("cfVerify: user token ok; account-owned token via the fallback; rejected / network / 429 texts never carry the body or the token", async () => {
    const mk = (map: Record<string, Response | "throw">) => (async (u: string) => { const r = map[u.replace(CF_API, "")]; if (r === "throw") throw new Error(`boom ${TOKEN}`); return r ?? new Response("{}", { status: 404 }); }) as unknown as typeof fetch;
    const c = { accountId: ACCT, token: TOKEN };
    expect(await cfVerify(c, mk({ "/user/tokens/verify": Response.json({ success: true, result: { status: "active" } }) }))).toMatchObject({ ok: true });
    expect(await cfVerify(c, mk({ "/user/tokens/verify": new Response("{}", { status: 401 }), [`/accounts/${ACCT}/tokens/verify`]: Response.json({ success: true, result: { status: "active" } }) }))).toMatchObject({ ok: true });
    const bad = await cfVerify(c, mk({ "/user/tokens/verify": Response.json({ errors: [{ message: TOKEN }] }, { status: 401 }), [`/accounts/${ACCT}/tokens/verify`]: Response.json({ errors: [{ message: TOKEN }] }, { status: 403 }) }));
    expect(bad.ok).toBe(false); expect(bad.detail).toContain("403"); expect(bad.detail).not.toContain(TOKEN);
    const exp = await cfVerify(c, mk({ "/user/tokens/verify": Response.json({ success: true, result: { status: "expired" } }) })); expect(exp).toMatchObject({ ok: false }); expect(exp.detail).toContain("expired");
    const net = await cfVerify(c, mk({ "/user/tokens/verify": "throw" })); expect(net.ok).toBe(false); expect(net.detail).not.toContain(TOKEN);
    expect((await cfVerify(c, mk({ "/user/tokens/verify": new Response("{}", { status: 429 }) }))).detail).toContain("rate");
  });
});

describe("cf-account: settings routes", () => {
  const seen: Array<{ url: string; auth: string }> = [];
  const fetchImpl = (async (url: string, init: any) => { seen.push({ url, auth: init?.headers?.authorization }); return url.endsWith("/user/tokens/verify") ? Response.json({ success: true, result: { status: "active" } }) : new Response("{}", { status: 404 }); }) as unknown as typeof fetch;
  const app = createApp({ fetchImpl, scopeOf: (s) => (s.u === "guest-a" ? GA : s.u === "guest-b" ? GB : s.via === "e2e" ? "e2e" : "main"), provider: () => ({ name: "gw", messages: async () => new Response("{}"), listModels: async () => [] } as any) });
  const mkEnv = (over: Record<string, unknown> = {}) => { const x = d1(); const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a,guest-b", GATEWAY_KEY: "k", AI: {}, KEY_ENC_SECRET: SECRET, E2E_TOKEN: "e2e-test-token-0123456789abcdef0123456789abcdef", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d, _db: x.db, ...over }; e.CHAT = chatMock(() => e.FILES, () => {}); return e as Env & { _db: Database }; };
  const call = async (env: Env, user: string, method: string, path: string, b?: unknown) => {
    let cookie: string, csrf: string;
    if (user === "e2e") { const r = await app.fetch(new Request("https://app.test/auth/e2e", { method: "POST", headers: { "x-e2e-token": (env as any).E2E_TOKEN } }), env); cookie = r.headers.get("set-cookie")!.split(";")[0]!; csrf = ((await (await app.fetch(new Request("https://app.test/api/me", { headers: { cookie } }), env)).json()) as any).csrf; }
    else { const m = await makeSession(env, user, "github"); cookie = m.cookie.split(";")[0]!; csrf = m.session.csrf; }
    return app.fetch(new Request("https://app.test" + path, { method, headers: { cookie, origin: "https://app.test", "x-csrf-token": csrf, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) }), env);
  };
  const link = (env: Env, u = "example-user", b: unknown = { accountId: ACCT, token: TOKEN }) => call(env, u, "PUT", "/api/cloudflare/account", b);

  test("default = shared; link -> own with last 4 only; the response, the DB row and the log never hold the token", async () => {
    const env = mkEnv(); const logs: string[] = []; const orig = console.info; console.info = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      const g0 = await (await call(env, "example-user", "GET", "/api/cloudflare/account")).json() as any;
      expect(g0).toMatchObject({ using: "shared", storage: true, origin: CF_ORIGIN }); expect(g0.scopes.map((s: any) => s.permission).join()).toContain("Workers AI - Read and Workers AI - Edit"); expect(g0.scopes.map((s: any) => s.permission).join()).toContain("Browser Rendering - Edit");
      const r = await link(env); expect(r.status).toBe(200);
      const body = await r.text(); expect(body).not.toContain(TOKEN); expect(JSON.parse(body)).toMatchObject({ ok: true, using: "own", token_last4: "ABCD", account_last4: "cdef" });
      const row = env._db.query(`SELECT * FROM provider_user_keys WHERE provider_id=?`).get(CF_ACCT_PROVIDER) as any;
      expect(row).toMatchObject({ base: "main", origin: CF_ORIGIN }); expect(JSON.stringify(row)).not.toContain(TOKEN); expect(JSON.stringify(row)).not.toContain(ACCT);
      expect(await cfAccountOf(env as any, "main")).toEqual({ kind: "acct", creds: { accountId: ACCT, token: TOKEN } });
      expect(await (await call(env, "example-user", "GET", "/api/cloudflare/account")).text()).not.toContain(TOKEN);
      expect(logs.join("\n")).not.toContain(TOKEN); expect(logs.some((l) => l.includes("cf-account"))).toBe(true);
    } finally { console.info = orig; }
  });
  test("Test button: ONE read to api.cloudflare.com with the stored token (no token accepted in the request); Remove returns to shared; no link = no network", async () => {
    const env = mkEnv(); seen.length = 0;
    const none = await (await call(env, "example-user", "POST", "/api/cloudflare/account/test")).json() as any; expect(none.ok).toBe(false); expect(seen.length).toBe(0);
    await link(env);
    const t = await (await call(env, "example-user", "POST", "/api/cloudflare/account/test", { token: "attacker-supplied-token-0123456789" })).json() as any;
    expect(t.ok).toBe(true); expect(seen.length).toBe(1); expect(seen[0]!.url).toBe(`${CF_API}/user/tokens/verify`); expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
    const d = await (await call(env, "example-user", "DELETE", "/api/cloudflare/account")).json() as any; expect(d).toMatchObject({ ok: true, using: "shared" });
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_user_keys WHERE provider_id=?`).get(CF_ACCT_PROVIDER)).toEqual({ n: 0 });
  });
  test("validation: bad id / token = 400 with no value echoed; no KEY_ENC_SECRET = 409; oversized body = 413", async () => {
    const env = mkEnv();
    for (const b of [{ accountId: "nope", token: TOKEN }, { accountId: ACCT, token: "bad token" }, {}]) { const r = await link(env, "example-user", b); expect(r.status).toBe(400); expect(await r.text()).not.toContain("bad token"); }
    expect((await link(mkEnv({ KEY_ENC_SECRET: undefined }))).status).toBe(409);
    expect((await call(env, "example-user", "PUT", "/api/cloudflare/account", { accountId: ACCT, token: "a".repeat(9000) })).status).toBe(413);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_user_keys`).get()).toEqual({ n: 0 });
  });
  test("scope gate: e2e never; a team user only with Open on; each base sees only its own link", async () => {
    const env = mkEnv();
    expect((await link(env, "e2e")).status).toBe(403); expect((await call(env, "e2e", "GET", "/api/cloudflare/account")).status).toBe(403);
    await setOpenFlag(env.DB!, GA, false); await setOpenFlag(env.DB!, GB, false); // Open is default-on for a team user: "0" is the kill switch
    for (const m of ["GET", "PUT", "DELETE"]) expect((await call(env, "guest-a", m, "/api/cloudflare/account", m === "PUT" ? { accountId: ACCT, token: TOKEN } : undefined)).status, m).toBe(403);
    expect((await call(env, "guest-a", "POST", "/api/cloudflare/account/test")).status).toBe(403);
    await setOpenFlag(env.DB!, GA, true);
    expect((await link(env, "guest-a")).status).toBe(200);
    expect((await call(env, "guest-b", "GET", "/api/cloudflare/account")).status).toBe(403); // B is switched off
    await setOpenFlag(env.DB!, GB, true);
    expect(await (await call(env, "guest-b", "GET", "/api/cloudflare/account")).json()).toMatchObject({ using: "shared" });
    expect(await (await call(env, "guest-a", "GET", "/api/cloudflare/account")).json()).toMatchObject({ using: "own" });
    expect(env._db.query(`SELECT base FROM provider_user_keys`).all()).toEqual([{ base: GA }]);
    await setOpenFlag(env.DB!, GA, false); expect((await call(env, "guest-a", "GET", "/api/cloudflare/account")).status).toBe(403);
  });
  test("an unreadable row (wrong secret / tampered) is 'broken', never shared; the generic provider-key route cannot touch this row", async () => {
    const env = mkEnv(); await link(env);
    (env as any).KEY_ENC_SECRET = "a-different-secret-0123456789";
    expect(await (await call(env, "example-user", "GET", "/api/cloudflare/account")).json()).toMatchObject({ using: "broken" });
    expect(await cfAccountOf(env as any, "main")).toEqual({ kind: "error" });
    const t = await (await call(env, "example-user", "POST", "/api/cloudflare/account/test")).json() as any; expect(t.ok).toBe(false);
    expect((await call(env, "example-user", "PUT", `/api/providers/${CF_ACCT_PROVIDER}/key`, { key: "x".repeat(20) })).status).toBe(404); // not a provider row
  });
  test("a ciphertext copied to another base or origin does not decrypt", async () => {
    const env = mkEnv(); await link(env);
    env._db.query(`INSERT INTO provider_user_keys SELECT ?, provider_id, origin, ct, iv, updated_at FROM provider_user_keys WHERE base='main'`).run(GA);
    expect(await cfAccountOf(env as any, GA)).toEqual({ kind: "error" });
    expect((await userKeyOf(env as any, "main", CF_ACCT_PROVIDER, "https://evil.test")).kind).toBe("stale");
  });
});

describe("cf-account: Workers AI routing", () => {
  const CF = PROVIDERS.find((p) => p.id === CLOUDFLARE_ID)!;
  const mk = (kind: "none" | "key" | "stale" | "error", key = encodeCreds({ accountId: ACCT, token: TOKEN })) => ({ ...CF, sharedAllowed: async () => true, resolveKey: async () => (kind === "key" ? { kind, key } : { kind }) }) as unknown as ProviderConfig;
  const chatBody = (extra: object = {}) => ({ model: "@cf/meta/llama-3.1-8b-instruct-fp8", max_tokens: 99_999, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...extra });
  const sseBody = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: {"response":"ok"}\n\ndata: [DONE]\n\n`)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const rig = (res: () => Response) => { const calls: any[] = [], ai: any[] = []; const f = (async (u: string, i: any) => { calls.push({ u, i, body: i.body ? JSON.parse(i.body) : null }); return res(); }) as unknown as typeof fetch; return { calls, ai, f, env: { AI: { run: async (...a: unknown[]) => { ai.push(a); return { response: "shared" }; } } } as Record<string, unknown> }; };

  test("linked account: chat streams through POST /accounts/<id>/ai/run/<model> with the user's bearer, max_tokens clamped, the shared binding untouched", async () => {
    const r = rig(sseBody); const res = await cloudflareProvider(mk("key"), r.env, r.f).messages(chatBody());
    expect(await res.text()).toContain("ok");
    expect(r.calls.length).toBe(1); expect(r.calls[0].u).toBe(`${CF_API}/accounts/${ACCT}/ai/run/@cf/meta/llama-3.1-8b-instruct-fp8`);
    expect(r.calls[0].i.headers.authorization).toBe(`Bearer ${TOKEN}`); expect(r.calls[0].body.max_tokens).toBe(CF_OWN_MAX_TOKENS); expect(r.calls[0].body.stream).toBe(true); expect(r.ai.length).toBe(0);
  });
  test("linked account: image via REST (JSON result.image and raw PNG bytes both work)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const j = rig(() => Response.json({ success: true, result: { image: "iVBORw0KGgo=" } }));
    expect((await cloudflareProvider(mk("key"), j.env, j.f).image!({ model: "@cf/black-forest-labs/flux-1-schnell", prompt: "x" })).images[0]!.data).toBe("iVBORw0KGgo=");
    const b = rig(() => new Response(png, { headers: { "content-type": "image/png" } }));
    const out = await cloudflareProvider(mk("key"), b.env, b.f).image!({ model: "@cf/bytedance/stable-diffusion-xl-lightning", prompt: "x" });
    expect(out.images[0]!.mime_type).toBe("image/png"); expect(b.ai.length).toBe(0);
  });
  test("no link: the shared binding as today, no network", async () => {
    const r = rig(sseBody); await cloudflareProvider(mk("none"), r.env, r.f).messages(chatBody({ stream: true })).catch(() => {});
    expect(r.calls.length).toBe(0); expect(r.ai.length).toBe(1);
    const noCfg = rig(sseBody); await cloudflareProvider({ ...CF, sharedAllowed: async () => true }, noCfg.env, noCfg.f).messages(chatBody()).catch(() => {}); expect(noCfg.ai.length).toBe(1);
  });
  test("stale / error / garbled row: FAILS CLOSED (neither the shared binding nor the network), message without the token", async () => {
    for (const k of [mk("stale"), mk("error"), mk("key", "garbled")]) {
      const r = rig(sseBody);
      const e = await cloudflareProvider(k, r.env, r.f).messages(chatBody()).then(() => null, (x) => x) as ProviderError;
      expect(e).toBeInstanceOf(ProviderError); expect(e.message).toContain("Settings > Cloudflare"); expect(e.message).not.toContain(TOKEN); expect(r.calls.length + r.ai.length).toBe(0);
      const i = await cloudflareProvider(k, r.env, r.f).image!({ model: "@cf/black-forest-labs/flux-1-schnell", prompt: "x" }).then(() => null, (x) => x); expect(i).toBeInstanceOf(ProviderError); expect(r.calls.length + r.ai.length).toBe(0);
    }
    const thrown = rig(sseBody); const cfg = { ...CF, resolveKey: async () => { throw new Error("db down"); } } as unknown as ProviderConfig;
    await expect(cloudflareProvider(cfg, thrown.env, thrown.f).messages(chatBody())).rejects.toBeInstanceOf(ProviderError); expect(thrown.ai.length).toBe(0);
  });
  test("upstream 401/403/429/404 -> clear user-safe errors (no body, no token); a model outside the curated list never reaches the network", async () => {
    for (const [status, re] of [[401, /rejected/], [403, /rejected/], [429, /capacity|allowance/], [404, /not available/]] as const) {
      const r = rig(() => new Response(JSON.stringify({ errors: [{ message: `leak ${TOKEN}` }] }), { status }));
      const e = await cloudflareProvider(mk("key"), r.env, r.f).messages(chatBody()).then(() => null, (x) => x) as ProviderError;
      expect(e.message, String(status)).toMatch(re); expect(e.message).not.toContain(TOKEN);
    }
    const r = rig(sseBody); await expect(cloudflareProvider(mk("key"), r.env, r.f).messages(chatBody({ model: "@cf/evil/../../../x" }))).rejects.toBeInstanceOf(ProviderError); expect(r.calls.length).toBe(0);
  });
});

describe("cf-account: registry + features", () => {
  const ids = (m: Record<string, string>) => userKeysFor({}, GA, new Map(Object.entries(m)));
  const listed = (o: Partial<Parameters<typeof buildRegistry>[0]>, env: Record<string, unknown> = { AI: {} }) => buildRegistry({ scope: scopeFor(GA, "open"), gateway: null, env, ...o } as any).list().map((p) => p.id);
  test("team Open: Cloudflare is offered only with the global team flag, a linked account, or the per-user workers-ai flag", () => {
    expect(listed({})).not.toContain("cloudflare");
    expect(listed({ userKeys: ids({}) })).not.toContain("cloudflare");
    expect(listed({ userKeys: ids({ [CF_ACCT_PROVIDER]: CF_ORIGIN }) })).toContain("cloudflare");
    expect(listed({ features: new Set(["workers-ai"]) })).toContain("cloudflare");
    expect(listed({ features: new Set(["something-else"]) })).not.toContain("cloudflare");
    expect(listed({}, { AI: {}, PROVIDER_CF_TEAM: "true" })).toContain("cloudflare");
  });
  test("a linked account works without the shared AI binding (status enabled); without link or binding it is off", () => {
    const reg = (userKeys?: any, env: Record<string, unknown> = {}) => buildRegistry({ scope: scopeFor("main", "open"), gateway: null, env, userKeys } as any).list().find((p) => p.id === "cloudflare")?.status;
    expect(reg(undefined)).toBe("off");
    expect(reg(userKeysFor({}, "main", new Map([[CF_ACCT_PROVIDER, CF_ORIGIN]])))).toBe("enabled");
  });
  test("featuresOf: default ON, only an explicit '0' turns a feature off, per base, unknown names ignored, D1 error = empty set; main all, e2e none", async () => {
    const { d, db } = d1(); const base = GA;
    expect([...await featuresOf(d, base)]).toEqual(["workers-ai"]); // no row = allowed
    await setFeature(d, base, "workers-ai", false); expect([...await featuresOf(d, base)]).toEqual([]); expect([...await featuresOf(d, GB)]).toEqual(["workers-ai"]);
    await setFeature(d, base, "workers-ai", true); expect([...await featuresOf(d, base)]).toEqual(["workers-ai"]);
    for (const v of ["true", "no", "", "2"]) { db.query(`UPDATE settings SET value=? WHERE name=?`).run(v, `feat:${base}:workers-ai`); expect([...await featuresOf(d, base)], v).toEqual(["workers-ai"]); } // only exactly "0" disables
    db.query(`UPDATE settings SET value='0' WHERE name=?`).run(`feat:${base}:workers-ai`); db.query(`INSERT INTO settings (name, value) VALUES (?, '0')`).run(`feat:${base}:made-up`); expect([...await featuresOf(d, base)]).toEqual([]);
    expect([...await featuresOf(undefined, base)]).toEqual([]); expect([...await featuresOf({ prepare: () => { throw new Error("x"); } } as any, base)]).toEqual([]);
    expect([...await featuresOf(d, "main")]).toEqual([...FEATURES]); expect([...await featuresOf(d, "e2e")]).toEqual([]);
  });
});

describe("cf-account: browser tools on the user's account", () => {
  const OPEN = scopeFor(GA, "open");
  const mkHost = (over: { account?: any; browser?: any; fetchImpl?: typeof fetch; linkable?: boolean } = {}) => {
    const { d, db } = d1(); const usage: any[] = []; const shared: any[] = [];
    const host = cfToolsHost({ browser: over.browser === undefined ? { quickAction: async (a: string) => { shared.push(a); return Response.json({ success: true, result: "# shared" }); } } : over.browser, image: null, shared: async () => true, account: over.account, linkable: over.linkable, fetchImpl: over.fetchImpl,
      db: d, scope: OPEN, files: null, index: { recordUsage: async (u: any) => { usage.push(u); } } as any, conv: () => "c1" });
    return { host, db, d, shared, usage };
  };
  const acct = { kind: "acct" as const, creds: { accountId: ACCT, token: TOKEN } };
  const rest = (calls: any[], res: () => Response = () => Response.json({ success: true, result: "# From my account" })) => (async (u: string, i: any) => { calls.push({ u, i, body: JSON.parse(i.body) }); return res(); }) as unknown as typeof fetch;

  test("linked: web_read goes to /accounts/<id>/browser-rendering/markdown with the user's token; no shared call, NO shared daily counter row", async () => {
    const calls: any[] = []; const r = mkHost({ account: async () => acct, fetchImpl: rest(calls) });
    const out = await r.host.call("web_read", { url: "https://example.com/a" });
    expect(out.isError).toBe(false); expect(out.text).toContain("From my account");
    expect(calls[0].u).toBe(`${CF_API}/accounts/${ACCT}/browser-rendering/markdown`); expect(calls[0].i.headers.authorization).toBe(`Bearer ${TOKEN}`); expect(calls[0].body.url).toBe("https://example.com/a");
    expect(r.shared.length).toBe(0); expect(r.db.query(`SELECT COUNT(*) AS n FROM settings WHERE name LIKE 'cftool:%'`).get()).toEqual({ n: 0 });
    expect(out.text).not.toContain(TOKEN);
  });
  test("linked: links works; the URL guard still applies; per-turn sanity cap instead of the daily cap", async () => {
    const calls: any[] = []; const r = mkHost({ account: async () => acct, fetchImpl: rest(calls, () => Response.json({ success: true, result: ["https://a.test/x"] })) });
    expect((await r.host.call("web_links", { url: "https://example.com" })).text).toContain("https://a.test/x");
    expect((await r.host.call("web_read", { url: "http://169.254.169.254/" })).isError).toBe(true); expect(calls.length).toBe(1);
    for (let i = 0; i < CF_OWN_BROWSE_PER_TURN; i++) await r.host.call("web_links", { url: "https://example.com" }, { turn: 7 } as any);
    const over = await r.host.call("web_links", { url: "https://example.com" }, { turn: 7 } as any); expect(over.isError).toBe(true); expect(over.text).toContain(String(CF_OWN_BROWSE_PER_TURN));
    expect((await r.host.call("web_links", { url: "https://example.com" }, { turn: 8 } as any)).isError).toBe(false);
  });
  test("unreadable link: refuses (never the shared binding, never the network)", async () => {
    const calls: any[] = []; const r = mkHost({ account: async () => ({ kind: "error" as const }), fetchImpl: rest(calls) });
    const out = await r.host.call("web_read", { url: "https://example.com" }); expect(out.isError).toBe(true); expect(out.text).toContain("Settings > Cloudflare"); expect(calls.length + r.shared.length).toBe(0);
    const th = mkHost({ account: async () => { throw new Error("db"); }, fetchImpl: rest(calls) }); expect((await th.host.call("web_read", { url: "https://example.com" })).isError).toBe(true); expect(th.shared.length).toBe(0);
  });
  test("upstream 401 / 429 on the user's account -> clear messages without the token", async () => {
    for (const [status, re] of [[401, /rejected/], [403, /rejected/], [429, /limit/]] as const) {
      const calls: any[] = []; const r = mkHost({ account: async () => acct, fetchImpl: rest(calls, () => new Response(`{"errors":[{"message":"${TOKEN}"}]}`, { status })) });
      const out = await r.host.call("web_read", { url: "https://example.com" }); expect(out.isError).toBe(true); expect(out.text).toMatch(re); expect(out.text).not.toContain(TOKEN);
    }
  });
  test("no link: shared binding + the daily cap exactly as before", async () => {
    for (const account of [undefined, async () => ({ kind: "none" as const })]) {
      const r = mkHost({ account }); const out = await r.host.call("web_read", { url: "https://example.com" });
      expect(out.text).toContain("shared"); expect(r.shared).toEqual(["markdown"]); expect(r.db.query(`SELECT COUNT(*) AS n FROM settings WHERE name LIKE 'cftool:browse:%'`).get()).toEqual({ n: 1 });
    }
    const noBind = mkHost({ browser: null, linkable: true, account: async () => ({ kind: "none" as const }) });
    expect((await noBind.host.list()).map((t) => t.name)).toEqual(["web_links", "web_read", "web_screenshot"]); // offered so a user can link
    const out = await noBind.host.call("web_read", { url: "https://example.com" }); expect(out.isError).toBe(true); expect(out.text).toContain("Link your own Cloudflare account");
    expect((await mkHost({ browser: null }).host.list()).length).toBe(0); // no binding and not linkable: nothing offered, as before
  });
  test("restBrowser only knows markdown/links/screenshot", async () => {
    const b = restBrowser({ accountId: ACCT, token: TOKEN }, (async () => Response.json({ success: true, result: "x" })) as unknown as typeof fetch);
    await expect(b.quickAction("pdf", {})).rejects.toThrow(); await expect(b.quickAction("../../x", {})).rejects.toThrow();
  });
});

describe("cf-account: Settings wording", () => {
  test("the Providers notice is the accurate shared-or-own text, not 'needs no key'", () => {
    expect(CF_PROVIDERS_NOTICE).toContain("shared account"); expect(CF_PROVIDERS_NOTICE).toContain("Link your own Cloudflare account"); expect(CF_PROVIDERS_NOTICE).not.toMatch(/needs no key/i);
    const src = readFileSync(new URL("../web/src/settings-pages.tsx", import.meta.url), "utf8"); expect(src).not.toContain("needs no key"); expect(src).toContain("CF_PROVIDERS_NOTICE");
  });
  test("status lines: shared / your account ••••last4 / broken; badges; messages", () => {
    expect(cfUsing({ using: "shared" })).toBe("Using: shared account"); expect(cfUsing({ using: "own", token_last4: "1234" })).toBe("Using: your account ••••1234"); expect(cfUsing({ using: "broken" })).toContain("cannot be read"); expect(cfUsing(null)).toBe("");
    expect([cfBadge({ using: "shared" }), cfBadge({ using: "own" }), cfBadge({ using: "broken" })]).toEqual(["Shared", "Your account", "Re-link"]);
    expect(testNote({ ok: true, detail: "fine" }, 200)).toBe("fine"); expect(testNote({}, 429)).toContain("Too many"); expect(linkError({ error: "bad" }, 400)).toBe("bad"); expect(linkError(null, 500)).toContain("500");
  });
});
