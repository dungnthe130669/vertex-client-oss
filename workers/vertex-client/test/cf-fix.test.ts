// Regression / security tests for the cf-acct review fixes (docs/briefs/vclient-cf-account-fix.md): shared-account use is decided by the CURRENT per-user `workers-ai` flag (default on,
// explicit '0' off, read error = no) while a linked own account always works; unlink takes effect on the very next call; SSE answers from a linked account are byte-capped;
// the Cloudflare routes need a session + CSRF + same origin and never cross bases; chat image generation is NVIDIA FLUX first with a Cloudflare fallback and names its backend.
import type { GuestScope } from "../src/scope";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { setOpenFlag } from "../src/open-space";
import { resetPutLimit } from "../src/provider-routes";
import { CF_ACCT_PROVIDER, CF_ORIGIN, CF_OWN_MAX_RESPONSE, LINK_BROKEN, encodeCreds, scrubIds } from "../src/cf-account";
import { SHARED_OFF, capStream, cloudflareProvider, restAiBinding } from "../src/providers/cloudflare";
import { buildRegistry } from "../src/providers/registry";
import { openaiCompatProvider } from "../src/providers/openai-compat";
import { CLOUDFLARE_ID, PROVIDERS, type ProviderConfig } from "../src/providers/config";
import { NVIDIA_IMAGE_MODELS } from "../src/providers/presets";
import { ProviderError, type ImageResult } from "../src/providers/types";
import { CF_IMAGE_MODEL, CF_IMAGES_PER_TURN, NVIDIA_CHAT_IMAGE_MODEL, SHARED_OFF_TOOL, cfToolDefs, cfToolFlags, cfToolsHost } from "../src/cf-tools";
import { CLOUDFLARE_IMAGE } from "../src/providers/cloudflare";
import { featureOn, featuresOf, setFeature } from "../src/features";
import { bumpKeyEpoch, deleteUserKey, keyEpochOf, putUserKey, userKeyOf, userKeysFor } from "../src/user-keys";
import { scopeFor } from "../src/scope";
import { chatMock } from "./do-mock";

const ACCT = "0123456789abcdef0123456789abcdef";
const TOKEN = "fake_token_" + "a1b2c3d4".repeat(4); // obviously fake, matches the token shape only
const SECRET = "test-key-enc-secret-0123456789";
const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
const GB = "g:bbbbbbbbbbbbbbbbbbbbbbbb" as GuestScope;
const CF = PROVIDERS.find((p) => p.id === CLOUDFLARE_ID)!;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const GOOD: ImageResult = { model: "m", images: [{ mime_type: "image/png", data: PNG_B64 }], text: null, finish_reason: "STOP" };

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }), run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; }, _run: () => db.query(q).run(...(b as any)) });
  return { db, d: { prepare: (q: string) => stmt(q), batch: async (l: any[]) => { for (const s of l) s._run(); return []; } } as unknown as D1Database };
}
const chatBody = () => ({ model: "@cf/meta/llama-3.1-8b-instruct-fp8", max_tokens: 99, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
const sseOk = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: {"response":"ok"}\n\ndata: [DONE]\n\n`)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const mkAi = () => { const ai: unknown[][] = []; return { ai, env: { AI: { run: async (...a: unknown[]) => { ai.push(a); return { response: "shared" }; } } } as Record<string, unknown> }; };

describe("cf-fix: Workers AI shared-account gate (provider path)", () => {
  const cfg = (resolve: "none" | "key" | "stale" | "error", allow?: () => Promise<boolean>) => ({ ...CF, ...(allow ? { sharedAllowed: allow } : {}),
    resolveKey: async () => (resolve === "key" ? { kind: "key" as const, key: encodeCreds({ accountId: ACCT, token: TOKEN }) } : { kind: resolve }) }) as unknown as ProviderConfig;
  test("no link: the shared binding only while the flag allows; absent callback, false and a throw all refuse (403) without touching AI", async () => {
    for (const allow of [undefined, async () => false, async () => { throw new Error("db down"); }]) {
      const r = mkAi(); const p = cloudflareProvider(cfg("none", allow), r.env);
      const e = await p.messages(chatBody()).then(() => null, (x) => x) as ProviderError; expect(e).toBeInstanceOf(ProviderError); expect(e.status).toBe(403); expect(e.message).toBe(SHARED_OFF);
      const i = await p.image!({ model: CLOUDFLARE_IMAGE[0]!.id, prompt: "x" }).then(() => null, (x) => x); expect(i).toBeInstanceOf(ProviderError); expect(r.ai.length).toBe(0);
    }
    const ok = mkAi(); await cloudflareProvider(cfg("none", async () => true), ok.env).messages(chatBody()); expect(ok.ai.length).toBe(1);
  });
  test("a linked own account works with the shared flag OFF (and never calls the shared binding)", async () => {
    const calls: string[] = []; const r = mkAi();
    const f = (async (u: string) => { calls.push(u); return sseOk(); }) as unknown as typeof fetch;
    const res = await cloudflareProvider(cfg("key", async () => false), r.env, f).messages(chatBody()); expect(await res.text()).toContain("ok");
    expect(calls.length).toBe(1); expect(r.ai.length).toBe(0);
  });
  test("a broken / stale / unreadable link is refused even with the flag ON: never the shared account", async () => {
    for (const k of ["stale", "error"] as const) {
      const r = mkAi(); const e = await cloudflareProvider(cfg(k, async () => true), r.env).messages(chatBody()).then(() => null, (x) => x) as ProviderError;
      expect(e.message).toBe(LINK_BROKEN); expect(r.ai.length).toBe(0);
    }
    const r = mkAi(); const thrown = { ...CF, sharedAllowed: async () => true, resolveKey: async () => { throw new Error("x"); } } as unknown as ProviderConfig;
    await expect(cloudflareProvider(thrown, r.env).messages(chatBody())).rejects.toBeInstanceOf(ProviderError); expect(r.ai.length).toBe(0);
  });
});

describe("cf-fix: registry + features default on, unlink takes effect at once", () => {
  const mkReg = (db: D1Database, env: Record<string, unknown>, fetchImpl: typeof fetch, staleIds: boolean) => buildRegistry({ scope: scopeFor(GA, "open"), gateway: null, env, fetchImpl,
    userKeys: userKeysFor(env as any, GA, staleIds ? new Map([[CF_ACCT_PROVIDER, CF_ORIGIN]]) : new Map()), features: new Set(["workers-ai"]), sharedCf: () => featureOn(db, GA, "workers-ai") } as any);
  const MODEL = `${CLOUDFLARE_ID}:@cf/meta/llama-3.1-8b-instruct-fp8`;
  test("link -> call goes to the user's account; unlink -> the VERY NEXT call (same registry, stale 15 s presence cache) uses the flag: shared if allowed, refused if '0'", async () => {
    const { d } = d1(); const r = mkAi(); const rest: string[] = [];
    const env = { ...r.env, DB: d, KEY_ENC_SECRET: SECRET };
    const f = (async (u: string) => { rest.push(u); return sseOk(); }) as unknown as typeof fetch;
    await putUserKey({ DB: d, KEY_ENC_SECRET: SECRET }, GA, CF_ACCT_PROVIDER, CF_ORIGIN, encodeCreds({ accountId: ACCT, token: TOKEN }));
    const reg = mkReg(d, env, f, true); const body = { ...chatBody(), model: MODEL };
    await (await reg.router.messages(body)).text(); expect(rest.length).toBe(1); expect(r.ai.length).toBe(0);
    const before = keyEpochOf(GA); await deleteUserKey(d, GA, CF_ACCT_PROVIDER); expect(keyEpochOf(GA)).toBeGreaterThan(before); // unlink bumps the epoch the ChatSession checks
    await (await reg.router.messages(body)).text(); expect(rest.length).toBe(1); expect(r.ai.length).toBe(1); // flag default on: shared binding, not the removed account
    await setFeature(d, GA, "workers-ai", false);
    const e = await reg.router.messages(body).then(() => null, (x) => x) as ProviderError; expect(e.status).toBe(403); expect(r.ai.length).toBe(1); expect(rest.length).toBe(1);
    await setFeature(d, GA, "workers-ai", true); await (await reg.router.messages(body)).text(); expect(r.ai.length).toBe(2); // admin switches it back: the next call sees it
  });
  test("with the flag off the shared account is refused for the base, an own account still works; main is never gated; D1 read error = shared refused", async () => {
    const { d } = d1(); await setFeature(d, GA, "workers-ai", false);
    expect(await featureOn(d, GA, "workers-ai")).toBe(false); expect(await featureOn(d, GB, "workers-ai")).toBe(true); expect(await featureOn(d, "main", "workers-ai")).toBe(true);
    const broken = { prepare: () => { throw new Error("d1 down"); } } as unknown as D1Database;
    expect(await featureOn(broken, GA, "workers-ai")).toBe(false); expect(await featureOn(undefined, GA, "workers-ai")).toBe(false); expect([...await featuresOf(broken, GA)]).toEqual([]);
    const r = mkAi(); const f = (async () => sseOk()) as unknown as typeof fetch;
    const regBroken = buildRegistry({ scope: scopeFor(GA, "open"), gateway: null, env: { ...r.env, DB: d, KEY_ENC_SECRET: SECRET }, fetchImpl: f, userKeys: userKeysFor({ DB: d, KEY_ENC_SECRET: SECRET }, GA, new Map()), features: new Set(["workers-ai"]), sharedCf: () => featureOn(broken, GA, "workers-ai") } as any);
    const e = await regBroken.router.messages({ ...chatBody(), model: MODEL }).then(() => null, (x) => x) as ProviderError; expect(e.status).toBe(403); expect(r.ai.length).toBe(0);
    // the key table itself unreadable: the link state is unknown, so even more closed (LINK_BROKEN), never the shared account
    const regKeys = buildRegistry({ scope: scopeFor(GA, "open"), gateway: null, env: { ...r.env, DB: broken, KEY_ENC_SECRET: SECRET }, fetchImpl: f, userKeys: userKeysFor({ DB: broken, KEY_ENC_SECRET: SECRET }, GA, new Map()), features: new Set(["workers-ai"]), sharedCf: async () => true } as any);
    const e2 = await regKeys.router.messages({ ...chatBody(), model: MODEL }).then(() => null, (x) => x) as ProviderError; expect(e2.message).toBe(LINK_BROKEN); expect(r.ai.length).toBe(0);
  });
  test("listing: a team base sees Cloudflare by default (features carry workers-ai), not when explicitly off, and still with its own link", () => {
    const list = (features: string[], ids = new Map<string, string>()) => buildRegistry({ scope: scopeFor(GA, "open"), gateway: null, env: { AI: {} }, features: new Set(features), userKeys: userKeysFor({}, GA, ids) } as any).list().map((p) => p.id);
    expect(list(["workers-ai"])).toContain(CLOUDFLARE_ID); expect(list([])).not.toContain(CLOUDFLARE_ID); expect(list([], new Map([[CF_ACCT_PROVIDER, CF_ORIGIN]]))).toContain(CLOUDFLARE_ID);
  });
  test("bumpKeyEpoch is per base", () => { const a = keyEpochOf(GA), b = keyEpochOf(GB); bumpKeyEpoch(GA); expect(keyEpochOf(GA)).toBe(a + 1); expect(keyEpochOf(GB)).toBe(b); });
});

describe("cf-fix: SSE responses from a linked account are byte-capped", () => {
  const stream = (chunks: number, size: number, state: { cancelled: boolean }) => { let i = 0; return new ReadableStream<Uint8Array>({ pull(c) { if (i++ < chunks) c.enqueue(new Uint8Array(size)); else c.close(); }, cancel() { state.cancelled = true; } }); };
  const drain = async (s: ReadableStream<Uint8Array>) => { const rd = s.getReader(); let n = 0; try { for (;;) { const { done, value } = await rd.read(); if (done) return { n, err: null as unknown }; n += value!.byteLength; } } catch (e) { return { n, err: e }; } };
  test("capStream passes up to the cap, then errors and cancels the source", async () => {
    const ok = await drain(capStream(stream(4, 100, { cancelled: false }), 400)); expect(ok).toEqual({ n: 400, err: null });
    const st = { cancelled: false }; const over = await drain(capStream(stream(100, 100, st), 400)); expect(over.err).toBeInstanceOf(ProviderError); expect(over.n).toBeLessThanOrEqual(400);
    await new Promise((r) => setTimeout(r, 20)); expect(st.cancelled).toBe(true);
  });
  test("restAiBinding streams are limited by CF_OWN_MAX_RESPONSE (a 13 MiB SSE answer aborts; a small one passes)", async () => {
    const mk = (chunks: number, st: { cancelled: boolean }) => restAiBinding({ accountId: ACCT, token: TOKEN }, (async () => new Response(stream(chunks, 1024 * 1024, st), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch);
    const st = { cancelled: false };
    const big = await drain((await mk(13, st).run("@cf/meta/llama-3.1-8b-instruct-fp8", { stream: true })) as ReadableStream<Uint8Array>);
    expect(big.err).toBeInstanceOf(ProviderError); expect(big.n).toBeLessThanOrEqual(CF_OWN_MAX_RESPONSE);
    const small = await drain((await mk(2, { cancelled: false }).run("@cf/meta/llama-3.1-8b-instruct-fp8", { stream: true })) as ReadableStream<Uint8Array>); expect(small).toEqual({ n: 2 * 1024 * 1024, err: null });
  });
});

describe("cf-fix: Cloudflare routes need session + CSRF + same origin and never cross bases", () => {
  const app = createApp({ scopeOf: (s) => (s.u === "guest-a" ? GA : s.u === "guest-b" ? GB : "main"), provider: () => ({ name: "gw", messages: async () => new Response("{}"), listModels: async () => [] } as any) });
  const mkEnv = () => { resetPutLimit(); /* the per-base PUT brake is module-wide: do not eat other files' budget */ const x = d1(); const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a,guest-b", GATEWAY_KEY: "k", AI: {}, KEY_ENC_SECRET: SECRET, ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d, _db: x.db }; e.CHAT = chatMock(() => e.FILES, () => {}); return e as Env & { _db: Database }; };
  const body = JSON.stringify({ accountId: ACCT, token: TOKEN });
  const req = async (env: Env, user: string | null, method: string, path: string, o: { csrf?: "ok" | "none" | "bad"; origin?: string; body?: string } = {}) => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (user) { const m = await makeSession(env, user, "github"); h.cookie = m.cookie.split(";")[0]!; if ((o.csrf ?? "ok") === "ok") h["x-csrf-token"] = m.session.csrf; else if (o.csrf === "bad") h["x-csrf-token"] = "0".repeat(32); }
    h.origin = o.origin ?? "https://app.test";
    return app.fetch(new Request("https://app.test" + path, { method, headers: h, body: method === "GET" ? undefined : o.body }), env);
  };
  const rows = (env: Env & { _db: Database }) => env._db.query(`SELECT base FROM provider_user_keys WHERE provider_id=?`).all(CF_ACCT_PROVIDER) as Array<{ base: string }>;
  test("no session = 401 on every verb; nothing is written", async () => {
    const env = mkEnv();
    for (const [m, p] of [["GET", "/api/cloudflare/account"], ["PUT", "/api/cloudflare/account"], ["DELETE", "/api/cloudflare/account"], ["POST", "/api/cloudflare/account/test"]] as const) expect((await req(env, null, m, p, { body })).status, `${m} ${p}`).toBe(401);
    expect(rows(env)).toEqual([]);
  });
  test("a session without the CSRF token (or with a wrong one) or from another origin is 403 on the mutating verbs; the link is untouched", async () => {
    const env = mkEnv();
    expect((await req(env, "example-user", "PUT", "/api/cloudflare/account", { body })).status).toBe(200);
    for (const [m, p] of [["PUT", "/api/cloudflare/account"], ["DELETE", "/api/cloudflare/account"], ["POST", "/api/cloudflare/account/test"]] as const) {
      expect((await req(env, "example-user", m, p, { csrf: "none", body })).status, `${m} no csrf`).toBe(403);
      expect((await req(env, "example-user", m, p, { csrf: "bad", body })).status, `${m} bad csrf`).toBe(403);
      expect((await req(env, "example-user", m, p, { origin: "https://evil.test", body })).status, `${m} cross-origin`).toBe(403);
    }
    expect(rows(env)).toEqual([{ base: "main" }]);
  });
  test("base isolation: guest A's link / unlink never touches main's or guest B's row", async () => {
    const env = mkEnv(); await setOpenFlag(env.DB!, GA, true); await setOpenFlag(env.DB!, GB, true);
    for (const u of ["example-user", "guest-a", "guest-b"]) expect((await req(env, u, "PUT", "/api/cloudflare/account", { body })).status).toBe(200);
    expect(rows(env).map((r) => r.base).sort()).toEqual([GA, GB, "main"].sort());
    expect((await req(env, "guest-a", "DELETE", "/api/cloudflare/account")).status).toBe(200);
    expect(rows(env).map((r) => r.base).sort()).toEqual([GB, "main"].sort());
    expect((await userKeyOf(env as any, GA, CF_ACCT_PROVIDER, CF_ORIGIN)).kind).toBe("none");
    expect((await userKeyOf(env as any, GB, CF_ACCT_PROVIDER, CF_ORIGIN)).kind).toBe("key");
  });
});

describe("cf-fix: generate_image is NVIDIA FLUX first, Cloudflare second, and says which", () => {
  const rig = (o: { nvidia?: any; image?: any; shared?: () => Promise<boolean>; account?: any } = {}) => {
    const { db, d } = d1(); const usage: any[] = [], puts: string[] = []; const calls = { nv: 0, cf: 0, nvReq: [] as any[], cfReq: [] as any[] };
    const nvidia = o.nvidia === undefined ? async (r: any) => { calls.nv++; calls.nvReq.push(r); return GOOD; } : o.nvidia && (async (r: any) => { calls.nv++; calls.nvReq.push(r); return o.nvidia(r); });
    const image = o.image === undefined ? async (r: any) => { calls.cf++; calls.cfReq.push(r); return GOOD; } : o.image && (async (r: any) => { calls.cf++; calls.cfReq.push(r); return o.image(r); });
    const host = cfToolsHost({ nvidia, image, shared: o.shared ?? (async () => true), account: o.account, db: d, scope: scopeFor(GA, "open"), files: { size: async () => null, get: async () => null, put: async (k: string) => { puts.push(k); }, delete: async () => {} },
      index: { recordUsage: async (u: any) => { usage.push(u); } } as any, conv: () => "c1" });
    const slots = () => (db.query(`SELECT COUNT(*) AS n FROM settings WHERE name LIKE 'cftool:image:%'`).get() as { n: number }).n;
    return { host, calls, usage, puts, slots };
  };
  const gen = (h: ReturnType<typeof rig>, turn = 1) => h.host.call("generate_image", { prompt: "a red fox" }, { turn } as any);
  const parsed = (t: string) => JSON.parse(t) as { generated_image: { model: string; backend: string; cost_usd: number | null }; note: string };

  test("the preferred model is a verified NVIDIA image model; Cloudflare's is in the curated list", () => {
    expect(NVIDIA_IMAGE_MODELS.map((m) => `nvidia:${m.id}`)).toContain(NVIDIA_CHAT_IMAGE_MODEL); expect(CLOUDFLARE_IMAGE.map((m) => m.id)).toContain(CF_IMAGE_MODEL);
  });
  test("NVIDIA works: it is used, Cloudflare is never called, no shared daily slot is spent (even with the shared flag off), the result names NVIDIA and claims no cost", async () => {
    const r = rig({ shared: async () => false }); const out = await gen(r);
    expect(out.isError).toBe(false); const j = parsed(out.text);
    expect(j.generated_image.model).toBe(NVIDIA_CHAT_IMAGE_MODEL); expect(j.generated_image.backend).toContain("NVIDIA"); expect(j.note).toContain("NVIDIA"); expect(j.generated_image.cost_usd).toBeNull();
    expect(r.calls).toMatchObject({ nv: 1, cf: 0 }); expect(r.calls.nvReq[0].model).toBe(NVIDIA_CHAT_IMAGE_MODEL); expect(r.slots()).toBe(0); expect(r.puts.length).toBe(1);
    expect(r.usage[0]).toMatchObject({ costUsd: null, estUsd: null, kind: "image", model: NVIDIA_CHAT_IMAGE_MODEL });
  });
  test("NVIDIA unusable (no key / 400 / 500 / network / empty / bad image) -> Cloudflare, result names Cloudflare", async () => {
    const failures: Array<[string, (r: unknown) => Promise<ImageResult>]> = [
      ["no key", async () => { throw new ProviderError("This provider has no key configured.", 503); }],
      ["not in this space", async () => { throw new ProviderError("model not available in this space", 400); }],
      ["500", async () => { throw new ProviderError("The provider failed.", 502); }],
      ["timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }],
      ["empty", async () => ({ ...GOOD, images: [], finish_reason: "empty" })],
      ["garbage image", async () => ({ ...GOOD, images: [{ mime_type: "image/png", data: "!!not base64!!" }] })],
      ["wrong mime", async () => ({ ...GOOD, images: [{ mime_type: "text/html", data: PNG_B64 }] })],
    ];
    for (const [name, nvidia] of failures) {
      const r = rig({ nvidia }); const out = await gen(r); expect(out.isError, name).toBe(false);
      const j = parsed(out.text); expect(j.generated_image.model, name).toBe(CF_IMAGE_MODEL); expect(j.generated_image.backend, name).toContain("Cloudflare"); expect(j.note, name).toContain("Cloudflare");
      expect(r.calls, name).toMatchObject({ nv: 1, cf: 1 }); expect(r.slots(), name).toBe(1); expect(r.puts.length, name).toBe(1);
    }
  });
  test("no NVIDIA backend at all -> Cloudflare directly; no Cloudflare backend -> NVIDIA only; neither -> refused", async () => {
    const a = rig({ nvidia: null }); expect(parsed((await gen(a)).text).generated_image.backend).toContain("Cloudflare"); expect(a.calls.nv).toBe(0);
    const b = rig({ image: null }); expect(parsed((await gen(b)).text).generated_image.backend).toContain("NVIDIA");
    const bFail = rig({ image: null, nvidia: async () => { throw new ProviderError("x", 502); } }); const e = await gen(bFail); expect(e.isError).toBe(true); expect(bFail.puts.length).toBe(0);
    const c = rig({ nvidia: null, image: null }); expect((await gen(c)).isError).toBe(true); expect((await c.host.list()).length).toBe(0);
  });
  test("fallback respects the shared flag: off + no link -> refused (no Cloudflare call, no slot); off + own account -> works and says so; broken link -> refused, never shared", async () => {
    const down = async () => { throw new ProviderError("down", 502); };
    const off = rig({ nvidia: down, shared: async () => false }); const o = await gen(off); expect(o.isError).toBe(true); expect(o.text).toContain(SHARED_OFF_TOOL); expect(off.calls.cf).toBe(0); expect(off.slots()).toBe(0);
    const throwing = rig({ nvidia: down, shared: async () => { throw new Error("db"); } }); expect((await gen(throwing)).isError).toBe(true); expect(throwing.calls.cf).toBe(0);
    const own = rig({ nvidia: down, shared: async () => false, account: async () => ({ kind: "acct", creds: { accountId: ACCT, token: TOKEN } }) }); const w = await gen(own);
    expect(w.isError).toBe(false); expect(parsed(w.text).generated_image.backend).toContain("your own account"); expect(own.slots()).toBe(0);
    const broken = rig({ nvidia: down, account: async () => ({ kind: "error" }) }); const b = await gen(broken); expect(b.isError).toBe(true); expect(b.text).toContain("Settings > Cloudflare"); expect(broken.calls.cf).toBe(0);
  });
  test("per-turn cap still applies across both backends; a Cloudflare failure after a failed NVIDIA stores nothing", async () => {
    const r = rig(); for (let i = 0; i < CF_IMAGES_PER_TURN; i++) expect((await gen(r, 5)).isError).toBe(false);
    const over = await gen(r, 5); expect(over.isError).toBe(true); expect(over.text).toContain(String(CF_IMAGES_PER_TURN)); expect((await gen(r, 6)).isError).toBe(false);
    const both = rig({ nvidia: async () => { throw new ProviderError("x", 502); }, image: async () => { throw new ProviderError("Workers AI failed.", 502); } }); const e = await gen(both); expect(e.isError).toBe(true); expect(both.puts.length).toBe(0);
  });
  test("the real NVIDIA provider: a 500 from the genai host is a ProviderError (so the tool falls back); success returns an image", async () => {
    const cfg = { id: "nvidia", kind: "openai-compat", enabled: true, baseUrl: "https://integrate.api.nvidia.com/v1", keyBinding: "PROVIDER_KEY_NVIDIA", authHeader: "x-api-key", models: [] } as unknown as ProviderConfig;
    const png = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0)); const jpg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 1, 2, 3, 4, 5));
    const f500 = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(openaiCompatProvider(cfg, { PROVIDER_KEY_NVIDIA: "nv-fake-key-0123456789" }, f500).image!({ model: NVIDIA_IMAGE_MODELS[0]!.id, prompt: "x" })).rejects.toBeInstanceOf(ProviderError);
    await expect(openaiCompatProvider(cfg, {}, f500).image!({ model: NVIDIA_IMAGE_MODELS[0]!.id, prompt: "x" })).rejects.toBeInstanceOf(ProviderError); // no key
    const ok = (async () => Response.json({ artifacts: [{ base64: jpg, finishReason: "SUCCESS" }] })) as unknown as typeof fetch;
    const out = await openaiCompatProvider(cfg, { PROVIDER_KEY_NVIDIA: "nv-fake-key-0123456789" }, ok).image!({ model: NVIDIA_IMAGE_MODELS[0]!.id, prompt: "x" });
    expect(out.images[0]!.mime_type).toBe("image/jpeg"); expect(out.cost?.usd).toBeNull(); void png;
  });
});

describe("cf-fix: browser tools respect the shared flag", () => {
  const mk = (over: { shared?: () => Promise<boolean>; account?: any }) => {
    const { db, d } = d1(); const shared: string[] = [], rest: string[] = [];
    const host = cfToolsHost({ browser: { quickAction: async (a: string) => { shared.push(a); return Response.json({ success: true, result: "# shared" }); } }, image: null, shared: over.shared, account: over.account,
      fetchImpl: (async (u: string) => { rest.push(u); return Response.json({ success: true, result: "# mine" }); }) as unknown as typeof fetch,
      db: d, scope: scopeFor(GA, "open"), files: null, index: { recordUsage: async () => {} } as any, conv: () => "c1" });
    return { host, shared, rest, slots: () => (db.query(`SELECT COUNT(*) AS n FROM settings WHERE name LIKE 'cftool:browse:%'`).get() as { n: number }).n };
  };
  const read = (h: ReturnType<typeof mk>) => h.host.call("web_read", { url: "https://example.com" });
  test("flag off / absent / throwing: refused before any shared call or slot; flag on: works; own account works regardless", async () => {
    for (const shared of [undefined, async () => false, async () => { throw new Error("x"); }]) {
      const r = mk({ shared }); const out = await read(r); expect(out.isError).toBe(true); expect(out.text).toBe(SHARED_OFF_TOOL); expect(r.shared.length + r.slots()).toBe(0);
    }
    const on = mk({ shared: async () => true }); expect((await read(on)).text).toContain("shared"); expect(on.shared).toEqual(["markdown"]); expect(on.slots()).toBe(1);
    const own = mk({ shared: async () => false, account: async () => ({ kind: "acct", creds: { accountId: ACCT, token: TOKEN } }) }); const o = await read(own); expect(o.isError).toBe(false); expect(o.text).toContain("mine"); expect(own.shared.length).toBe(0);
  });
});

describe("cf-fix2: main flag, slash-list availability, log hygiene", () => {
  test("main: default on, explicit '0' disables, D1 error or missing DB = ON for main only", async () => {
    const { db, d } = d1();
    expect([...await featuresOf(d, "main")]).toEqual(["workers-ai"]);
    await setFeature(d, "main", "workers-ai", false); expect([...await featuresOf(d, "main")]).toEqual([]);
    await setFeature(d, "main", "workers-ai", true); expect([...await featuresOf(d, "main")]).toEqual(["workers-ai"]);
    const broken = { prepare: () => { throw new Error("d1 down"); } } as unknown as D1Database;
    expect([...await featuresOf(broken, "main")]).toEqual(["workers-ai"]); expect([...await featuresOf(undefined, "main")]).toEqual(["workers-ai"]);
    expect([...await featuresOf(broken, GA as never)]).toEqual([]); expect([...await featuresOf(undefined, GA as never)]).toEqual([]); // other bases still fail closed
    void db;
  });
  test("cfToolFlags: the slash list and the host use one predicate (image via NVIDIA alone, browser via a linkable env)", () => {
    expect(cfToolFlags({ nvidia: true })).toEqual({ browser: false, image: true });
    expect(cfToolFlags({ linkable: true, nvidia: true })).toEqual({ browser: true, image: true });
    expect(cfToolFlags({})).toEqual({ browser: false, image: false });
    const host = cfToolsHost({ browser: null, image: null, nvidia: async () => ({ model: "m", images: [], text: null, finish_reason: "x", cost: { usd: null, basis: "" } }), db: undefined as never, scope: scopeFor(GA, "open"), files: null, index: { recordUsage: async () => {} } as any, conv: () => "c1" });
    return host.list().then((l) => expect(l.map((t) => t.name)).toEqual(cfToolDefs(cfToolFlags({ nvidia: true })).map((t) => t.name)));
  });
  test("logs never carry an account id from a fetch error", async () => {
    expect(scrubIds(`fetch failed https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/run`)).not.toContain(ACCT);
    const logged: string[] = []; const orig = console.error; console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
    try {
      const { d } = d1();
      const host = cfToolsHost({ browser: null, linkable: true, image: null, account: async () => ({ kind: "acct", creds: { accountId: ACCT, token: TOKEN } }),
        fetchImpl: (async () => { throw new Error(`fetch failed https://api.cloudflare.com/client/v4/accounts/${ACCT}/browser-rendering/markdown`); }) as unknown as typeof fetch,
        db: d, scope: scopeFor(GA, "open"), files: null, index: { recordUsage: async () => {} } as any, conv: () => "c1" });
      expect((await host.call("web_read", { url: "https://example.com" })).isError).toBe(true);
    } finally { console.error = orig; }
    expect(logged.length).toBeGreaterThan(0); expect(logged.join("\n")).not.toContain(ACCT);
  });
});
