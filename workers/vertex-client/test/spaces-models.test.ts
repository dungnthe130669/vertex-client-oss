// Spaces T3: models / providers per space. Business = Vertex only; Open = shared provider configs (credentials read by the BASE), never the gateway.
import { setOpenFlag } from "../src/open-space";
import { PRESETS as __PRESETS } from "../src/providers/presets";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { ChatEngine, AUTO_MODEL, type ServerEvent } from "../src/turn-engine";
import { buildRegistry } from "../src/providers/registry";
import { stubProvider } from "../src/providers/stub";
import { DEFAULT_MODEL } from "../src/models-meta";
import type { ModelProvider } from "../src/providers/types";
import { chatMock } from "./do-mock";
// test-only: the fake "acme" provider's origin may receive its Worker secret (production allows the preset origin only)
if (!__PRESETS.some((x) => x.id === "acme")) __PRESETS.push({ key: "acme", label: "Acme", id: "acme", baseUrl: "https://llm.example.test/v1", authHeader: "bearer", secret: "PROVIDER_KEY_ACME", help: "" });

const ORIGIN = "https://app.test";
const KEY = "acme-super-secret-key-value";
const GW_MODELS = [{ id: "claude-sonnet-5-5", displayName: "Sonnet" }, { id: "gemini-3-pro", displayName: "Gemini" }];
const gw: ModelProvider = { name: "gw", messages: async (b: any) => new Response(JSON.stringify({ gateway: b.model })), listModels: async () => GW_MODELS };
function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }), run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; } } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as unknown as D1Database };
}
const mkEnv = (extra: Record<string, unknown> = {}) => {
  const x = d1();
  const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", E2E_TOKEN: "e".repeat(40), GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, _db: x.db, PROVIDER_KEY_ACME: KEY, ...extra };
  e.CHAT = chatMock(() => e.FILES);
  x.db.query(`INSERT INTO provider_configs (id, scope, kind, base_url, key_binding, enabled, models_json) VALUES ('acme','main','openai-compat','https://llm.example.test/v1','PROVIDER_KEY_ACME',1,?)`)
    .run(JSON.stringify([{ id: "m1", displayName: "Acme One", capabilities: { tools: true } }, { id: "m2", displayName: "Acme Two" }]));
  return e as Env & { _db: Database };
};
const GA = "g:abcdefghijklmnopqrstuvwx" as any;
const app = createApp({ scopeOf: (s) => (s.u === "guest-a" ? GA : s.via === "e2e" ? "e2e" : "main"), provider: () => gw });
const call = async (env: Env, user: "example-user" | "guest-a" | "e2e", method: string, path: string, o: { space?: "open" | "biz"; body?: unknown } = {}) => {
  let cookie: string, csrf: string;
  if (user === "e2e") { const r = await app.fetch(new Request(`${ORIGIN}/auth/e2e`, { method: "POST", headers: { "x-e2e-token": (env as any).E2E_TOKEN } }), env); cookie = r.headers.get("set-cookie")!.split(";")[0]!; csrf = ((await (await app.fetch(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }), env)).json()) as any).csrf; }
  else { const m = await makeSession(env, user, "github"); cookie = m.cookie.split(";")[0]!; csrf = m.session.csrf; }
  return app.fetch(new Request(ORIGIN + path, { method, headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json", ...(o.space ? { "x-vc-space": o.space } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env);
};
const json = async (r: Response) => (await r.json()) as any;

describe("registry per space", () => {
  const CFG = { id: "acme", kind: "openai-compat" as const, enabled: true, baseUrl: "https://llm.example.test/v1", keyBinding: "PROVIDER_KEY_ACME", models: [{ id: "m1", displayName: "M1", capabilities: { text: true, vision: false, tools: false, "image-gen": false, "video-gen": false, reasoning: false }, pricePerMTok: null }] };
  const ENV = { PROVIDER_KEY_ACME: KEY, AI: {} };
  const reg = (scope: any, extra = [CFG]) => buildRegistry({ scope, gateway: gw, extra, env: ENV });
  test("Business lists no provider config for any base; Open never gets the gateway", async () => {
    for (const sc of ["main", "e2e", GA]) expect(reg(sc).list().some((p) => p.id === "acme" || p.id === "cloudflare" || p.id === "stub"), String(sc)).toBe(false);
    expect((await reg("main").models()).map((m) => m.id)).toEqual(GW_MODELS.map((m) => m.id));
    const o = await reg("main~open").models(); expect(o.map((m) => m.id)).toEqual(expect.arrayContaining(["acme:m1"])); expect(o.some((m) => m.provider === "gateway")).toBe(false);
    expect(reg("main~open").list().some((p) => p.id === "gateway")).toBe(false);
  });
  test("router: another space's model is rejected with the generic message (no hint of what exists elsewhere)", async () => {
    const o = reg("main~open");
    const a = await o.router.messages({ model: "claude-sonnet-5-5" }).catch((e) => e); expect(a.status).toBe(400); expect(a.message).toBe("model not available in this space");
    const b = reg("main"); const c = await b.router.messages({ model: "acme:m1" }).catch((e) => e); expect(c.status).toBe(400); expect(c.message).toBe("model not available in this space");
    expect(JSON.stringify([a.message, c.message])).not.toMatch(/acme|claude|gateway/i);
    const img = await o.router.image!({ model: "claude-sonnet-5-5", prompt: "x" } as any).catch((e) => e); expect(img.message).toBe("model not available in this space");
  });
  test("e2e~open has only the built-in offline stub; the stub is off for main Open", async () => {
    const e = reg("e2e~open"); expect(e.list().map((p) => [p.id, p.status])).toEqual([["stub", "enabled"]]);
    expect((await e.models()).map((m) => m.id)).toEqual(["stub:echo"]);
    const txt = await (await e.router.messages({ model: "stub:echo", stream: true, messages: [{ role: "user", content: "hi" }] })).text(); expect(txt).toContain("echo: hi");
    expect(reg("main~open").list().find((p) => p.id === "stub")!.status).toBe("off");
  });
  test("guest Open: only allowGuests configs; never the team/gateway provider", async () => {
    const GO = `${GA as string}~open`;
    expect(reg(GO).list().map((p) => p.id)).toEqual(["nvidia", "aistudio", "groq"]); // only the built-in presets, and it needs the user's own key (no models until then)
    const g = buildRegistry({ scope: GO as any, gateway: gw, team: gw, extra: [{ ...CFG, allowGuests: true }], env: ENV });
    expect(g.list().map((p) => [p.id, p.status])).toEqual([["acme", "needs-key"], ["nvidia", "needs-key"], ["aistudio", "needs-key"], ["groq", "needs-key"]]); // allowGuests config is listed, but a team base never uses the shared Worker secret
    expect((await g.models()).map((m) => m.id)).toEqual([]);
  });
});

describe("/api/models, /api/me, /api/providers, /api/gen/models per space", () => {
  test("default per space: Business keeps DEFAULT_MODEL, Open = first Open model, never a Claude id", async () => {
    const env = mkEnv();
    const b = await json(await call(env, "example-user", "GET", "/api/models")); expect(b.default).toBe(DEFAULT_MODEL); expect(b.models.map((m: any) => m.id)).toEqual(["claude-sonnet-5-5", "gemini-3-pro"]);
    const o = await json(await call(env, "example-user", "GET", "/api/models", { space: "open" })); expect(o.default).toBe("acme:m1"); expect(o.models.map((m: any) => m.id)).toEqual(["acme:m1", "acme:m2"]);
    expect(JSON.stringify(o)).not.toMatch(/claude|gemini/);
    expect((await json(await call(env, "example-user", "GET", "/api/me", { space: "open" }))).defaultModel).toBeNull();
    expect((await json(await call(env, "example-user", "GET", "/api/me"))).defaultModel).toBe(DEFAULT_MODEL);
  });
  test("Open with no usable provider: 200, empty list, default null (empty state), not a 403", async () => {
    const env = mkEnv(); delete (env as any).PROVIDER_KEY_ACME;
    const r = await call(env, "example-user", "GET", "/api/models", { space: "open" }); expect(r.status).toBe(200); expect(await json(r)).toEqual({ default: null, models: [] });
  });
  test("a provider key / binding name / base URL never appears in any Open response", async () => {
    const env = mkEnv(); let all = "";
    for (const p of ["/api/models", "/api/providers", "/api/providers/configured", "/api/gen/models?kind=image", "/api/gen/models?kind=video", "/api/me", "/api/settings/chat-images"]) all += await (await call(env, "example-user", "GET", p, { space: "open" })).text();
    expect(all).not.toContain(KEY); expect(all).not.toMatch(/PROVIDER_KEY|https:\/\/llm|keyBinding|baseUrl/);
  });
  test("/api/providers: Business = gateway only; Open = configs only; guests 403 in both; shared rows are the same in both spaces' management routes", async () => {
    const env = mkEnv();
    expect((await json(await call(env, "example-user", "GET", "/api/providers"))).providers.map((p: any) => p.id)).toEqual(["gateway"]);
    expect((await json(await call(env, "example-user", "GET", "/api/providers", { space: "open" }))).providers.map((p: any) => p.id)).toEqual(["cloudflare", "stub", "acme", "nvidia", "aistudio", "groq"]);
    await setOpenFlag(env.DB!, GA as never, false); // Open is default-on for team users; kill switch
    expect((await call(env, "guest-a", "GET", "/api/providers")).status).toBe(403);
    expect((await call(env, "guest-a", "GET", "/api/providers", { space: "open" })).status).toBe(403);
    expect((await json(await call(env, "example-user", "GET", "/api/providers/configured", { space: "open" }))).providers.map((p: any) => p.id)).toEqual(["acme", "nvidia", "aistudio", "groq"]);
    expect((await json(await call(env, "example-user", "GET", "/api/providers/configured"))).providers.map((p: any) => p.id)).toEqual(["acme", "nvidia", "aistudio", "groq"]);
    expect((await call(env, "e2e", "GET", "/api/providers/configured", { space: "open" })).status).toBe(403);
  });
  test("/api/gen/models: Open has no gateway media; Business unchanged", async () => {
    const env = mkEnv({ AI: {}, OPEN_SPACE: "per-user" });
    const bi = await json(await call(env, "example-user", "GET", "/api/gen/models?kind=image")); expect(bi.models.some((m: any) => m.id.startsWith("cloudflare:"))).toBe(false);
    const oi = await json(await call(env, "example-user", "GET", "/api/gen/models?kind=image", { space: "open" })); expect(oi.models.every((m: any) => m.id.startsWith("cloudflare:"))).toBe(true);
    const ov = await json(await call(env, "example-user", "GET", "/api/gen/models?kind=video", { space: "open" })); expect(ov.models).toEqual([]);
    const e2eO = await json(await call(env, "e2e", "GET", "/api/gen/models?kind=image", { space: "open" })); expect(e2eO.models).toEqual([]);
  });
  test("e2e~open: the stub provider is listed and chat-able; e2e Business untouched", async () => {
    const env = mkEnv({ OPEN_SPACE: "per-user" });
    const o = await json(await call(env, "e2e", "GET", "/api/models", { space: "open" })); expect(o.models.map((m: any) => m.id)).toEqual(["stub:echo"]); expect(o.default).toBe("stub:echo");
    expect((await json(await call(env, "e2e", "GET", "/api/models"))).models.map((m: any) => m.id)).toEqual(["claude-sonnet-5-5", "gemini-3-pro"]);
  });
});

describe("create conversation", () => {
  const create = (env: Env, user: any, body: unknown, space?: "open") => call(env, user, "POST", "/api/conversations", { space, body });
  const rowOf = (env: any, id: string) => env._db.query(`SELECT model, scope FROM conversations WHERE id=?`).get(id) as any;
  test("Business: unchanged (regex only, default fallback, no model-list lookup)", async () => {
    const env = mkEnv(); const a = await json(await create(env, "example-user", { model: "gemini-3-pro" })); expect(a.model).toBe("gemini-3-pro");
    const b = await json(await create(env, "example-user", {})); expect(b.model).toBe(DEFAULT_MODEL);
    const c = await json(await create(env, "example-user", { model: "weird model!" })); expect(c.model).toBe(DEFAULT_MODEL);
    expect(rowOf(env, a.id).scope).toBe("main");
  });
  test("Open: member model kept, scope main~open", async () => {
    const env = mkEnv(); const a = await create(env, "example-user", { model: "acme:m2" }, "open"); expect(a.status).toBe(201);
    const j = await json(a); expect(j.model).toBe("acme:m2"); expect(rowOf(env, j.id)).toEqual({ model: "acme:m2", scope: "main~open" });
  });
  test("Open: missing / invalid / other-space model falls back to the space default, never a Claude id", async () => {
    const env = mkEnv();
    for (const body of [{}, { model: "claude-sonnet-5-5" }, { model: "gemini-3-pro" }, { model: "acme:nope" }, { model: "nvidia:x" }, { model: 5 }, { model: "a b" }, { model: "../x" }]) {
      const j = await json(await create(env, "example-user", body, "open")); expect(j.model, JSON.stringify(body)).toBe("acme:m1");
    }
  });
  test("Open with no model at all: 409, nothing inserted; list failure: 502, nothing inserted", async () => {
    const env = mkEnv(); delete (env as any).PROVIDER_KEY_ACME;
    const r = await create(env, "example-user", { model: "claude-sonnet-5-5" }, "open"); expect(r.status).toBe(409);
    expect((env._db.query(`SELECT COUNT(*) AS n FROM conversations`).get() as any).n).toBe(0);
  });
  test("cross-space leak: an Open conversation is invisible to Business and vice versa; the Open row never carries a Claude model", async () => {
    const env = mkEnv();
    const o = await json(await create(env, "example-user", { model: "claude-sonnet-5-5" }, "open")); const b = await json(await create(env, "example-user", {}));
    expect((await json(await call(env, "example-user", "GET", "/api/conversations"))).conversations.map((c: any) => c.id)).toEqual([b.id]);
    expect((await json(await call(env, "example-user", "GET", "/api/conversations", { space: "open" }))).conversations.map((c: any) => c.id)).toEqual([o.id]);
    expect(rowOf(env, o.id).model).not.toMatch(/claude|gemini/);
  });
});

describe("Auto is a Vertex feature: refused in Open", () => {
  function rig(autoAllowed?: () => boolean | Promise<boolean>) {
    const db = new Database(":memory:"); const events: ServerEvent[] = []; const bodies: any[] = [];
    const provider: ModelProvider = { name: "p", listModels: async () => [], messages: async (b: any) => { bodies.push(b); return new Response("{}", { status: 500 }); } };
    const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
      provider, index: { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} }, sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: 1,
      autoCandidates: async () => [{ id: "stub:echo", meta: null }], autoDefaultPlausible: () => false, autoAllowed });
    engine.setConvId("c1"); engine.setMeta("model", AUTO_MODEL);
    return { engine, events, bodies };
  }
  test("autoAllowed=false: plain error 'model not available in this space', no provider call", async () => {
    const { engine, events, bodies } = rig(() => false); await engine.send("hi", undefined, [], null); await Bun.sleep(30);
    expect(events.find((e) => e.type === "error")?.error.message).toBe("model not available in this space"); expect(bodies).toHaveLength(0);
  });
  test("autoAllowed throws: fail closed", async () => {
    const { engine, events, bodies } = rig(() => { throw new Error("x"); }); await engine.send("hi", undefined, [], null); await Bun.sleep(30);
    expect(events.some((e) => e.type === "error")).toBe(true); expect(bodies).toHaveLength(0);
  });
});

describe("shared credentials, per-space visibility", () => {
  test("one provider_configs row serves Open of main; Business never reads it; a team base reads none (rows are main's)", async () => {
    const env = mkEnv();
    expect((await json(await call(env, "example-user", "GET", "/api/models", { space: "open" }))).models.some((m: any) => m.provider === "acme")).toBe(true);
    expect((await json(await call(env, "example-user", "GET", "/api/models"))).models.some((m: any) => m.provider === "acme")).toBe(false);
    expect(stubProvider([], "x").name).toBe("x"); // (adapter stays usable standalone)
  });
});
