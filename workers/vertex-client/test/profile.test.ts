// Profile: validation, the /api/profile routes (own-row isolation, 403 for g:*), and the system prompt (instructions only for scope main).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession, type Session } from "../src/auth";
import { E2E_SCOPE, scopeOfSession, type Scope, type GuestScope } from "../src/scope";
import { MAX_FULL_NAME, MAX_INSTRUCTIONS, MAX_NICKNAME, cleanText, getProfile, profileSystemText, promptInstructions, putProfile, validateProfile } from "../src/profile";
import { SYSTEM_PROMPT } from "../src/system-prompt";
import { ChatEngine, buildRequest, type IndexSink } from "../src/turn-engine";
import type { ModelProvider } from "../src/providers/types";

const ORIGIN = "https://app.test";
const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
const seam = (s: Session): Scope => (s.u === "guest-a" ? GA : scopeOfSession(s));
const app = createApp({ scopeOf: seam });

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
const mkEnv = () => { const x = d1(); return { env: { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k", E2E_TOKEN: "e2e-test-token-0123456789abcdef0123456789abcdef", ASSETS: { fetch: async () => new Response("x") }, DB: x.d1 } as unknown as Env, db: x.db, d1: x.d1 }; };
type A = { cookie: string; csrf: string };
const bot = async (env: Env): Promise<A> => { // the real bypass login: scope 'e2e'
  const r = await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": (env as any).E2E_TOKEN } }), env);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json() as any;
  return { cookie, csrf: me.csrf };
};
const login = async (env: Env, user: string, via: "github" = "github"): Promise<A> => { const { cookie, session } = await makeSession(env, user, via); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const api = (env: Env, a: A | null, method: string, body?: unknown, csrf = true) => {
  const h = new Headers({ origin: ORIGIN });
  if (a) { h.set("cookie", a.cookie); if (method !== "GET" && csrf) h.set("x-csrf-token", a.csrf); }
  if (body !== undefined) h.set("content-type", "application/json");
  return app.fetch(new Request(`${ORIGIN}/api/profile`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};

describe("validateProfile / cleanText", () => {
  test("accepts partial updates and trims", () => {
    expect(validateProfile({ nickname: "  Erich " })).toEqual({ ok: true, v: { nickname: "Erich" } });
    expect(validateProfile({ fullName: "Dung N", instructions: "a\nb" })).toEqual({ ok: true, v: { fullName: "Dung N", instructions: "a\nb" } });
  });
  test("limits are enforced per field (exactly at the limit is fine)", () => {
    expect(validateProfile({ fullName: "x".repeat(MAX_FULL_NAME) }).ok).toBe(true);
    expect(validateProfile({ fullName: "x".repeat(MAX_FULL_NAME + 1) }).ok).toBe(false);
    expect(validateProfile({ nickname: "x".repeat(MAX_NICKNAME + 1) }).ok).toBe(false);
    expect(validateProfile({ instructions: "x".repeat(MAX_INSTRUCTIONS) }).ok).toBe(true);
    expect(validateProfile({ instructions: "x".repeat(MAX_INSTRUCTIONS + 1) }).ok).toBe(false);
  });
  test("non-string, empty body, non-object are rejected", () => {
    for (const b of [{ nickname: 5 }, { instructions: null }, {}, null, [], "x", { other: "x" }]) expect(validateProfile(b).ok).toBe(false);
  });
  test("control characters are stripped; names are single-line, instructions keep newlines and tabs", () => {
    expect(cleanText("a\u0000b\u0007c\u007Fd‎", true)).toBe("abcd‎");
    expect(cleanText("li\nne\ttwo\u0000", false)).toBe("li ne two");
    expect(cleanText("a\r\nb\rc\tz\u0001", true)).toBe("a\nb\nc\tz");
    const v: any = validateProfile({ nickname: "Er\u0000ich\n", instructions: "x\u001B[31m y" });
    expect(v.v.nickname).toBe("Erich");
    expect(v.v.instructions).toBe("x[31m y");
  });
});

describe("/api/profile", () => {
  test("GET empty -> PUT -> GET round trip; CSRF is required; partial PUT keeps other fields", async () => {
    const { env } = mkEnv(); const a = await login(env, "example-user");
    expect(await (await api(env, a, "GET")).json()).toEqual({ fullName: "", nickname: "", instructions: "" });
    expect((await api(env, a, "PUT", { nickname: "E" }, false)).status).toBe(403);
    expect((await api(env, null, "GET")).status).toBe(401);
    const r = await api(env, a, "PUT", { fullName: "Dung N", nickname: "Erich", instructions: "Be terse." });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ fullName: "Dung N", nickname: "Erich", instructions: "Be terse." });
    await api(env, a, "PUT", { nickname: "Dz" });
    expect(await (await api(env, a, "GET")).json()).toEqual({ fullName: "Dung N", nickname: "Dz", instructions: "Be terse." });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  test("invalid input is a 400 and changes nothing", async () => {
    const { env } = mkEnv(); const a = await login(env, "example-user");
    await api(env, a, "PUT", { instructions: "keep" });
    expect((await api(env, a, "PUT", { instructions: "x".repeat(MAX_INSTRUCTIONS + 1) })).status).toBe(400);
    expect((await api(env, a, "PUT", { nickname: 3 })).status).toBe(400);
    expect((await api(env, a, "PUT", undefined)).status).toBe(400);
    expect((await (await api(env, a, "GET")).json() as any).instructions).toBe("keep");
  });
  test("a guest scope (g:*) has its own row (name/nickname only), never reads or writes main's, and cannot store instructions", async () => {
    const { env, db } = mkEnv(); const main = await login(env, "example-user"); const g = await login(env, "guest-a");
    await api(env, main, "PUT", { nickname: "Erich", instructions: "SECRET-PREF" });
    const r = await api(env, g, "GET");
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ fullName: "", nickname: "", instructions: "" });
    expect((await api(env, g, "PUT", { nickname: "pwn", instructions: "pwn" })).status).toBe(400); // instructions never apply to a guest: refused, not silently dropped
    expect(db.query(`SELECT scope, nickname, instructions FROM profile`).all()).toEqual([{ scope: "main", nickname: "Erich", instructions: "SECRET-PREF" }]);
    const ok = await api(env, g, "PUT", { fullName: "Guest A", nickname: "Gee" });
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ fullName: "Guest A", nickname: "Gee", instructions: "" });
    expect(db.query(`SELECT scope, nickname, instructions FROM profile ORDER BY scope`).all()).toEqual([{ scope: "g:abcdefghijklmnopqrstuvwx", nickname: "Gee", instructions: "" }, { scope: "main", nickname: "Erich", instructions: "SECRET-PREF" }]);
    expect((await (await api(env, main, "GET")).json() as any).nickname).toBe("Erich");
  });
  test("e2e user has its own row and cannot see or change main's", async () => {
    const { env, db } = mkEnv(); const main = await login(env, "example-user"); const b = await bot(env);
    await api(env, main, "PUT", { nickname: "Erich", instructions: "SECRET-PREF" });
    expect(await (await api(env, b, "GET")).json()).toEqual({ fullName: "", nickname: "", instructions: "" });
    await api(env, b, "PUT", { nickname: "Bot" });
    expect((await (await api(env, main, "GET")).json() as any).nickname).toBe("Erich");
    expect(db.query(`SELECT scope FROM profile ORDER BY scope`).all()).toEqual([{ scope: "e2e" }, { scope: "main" }]);
  });
});

describe("system prompt", () => {
  test("promptInstructions: main only; blank -> null; e2e and g:* get null even when their rows exist", async () => {
    const { d1: db, db: raw } = mkEnv();
    expect(await promptInstructions(db, "main")).toBeNull();
    await putProfile(db, "main", { instructions: "  Answer in Vietnamese.  " });
    expect(await promptInstructions(db, "main")).toBe("Answer in Vietnamese.");
    raw.exec(`INSERT INTO profile (scope, instructions) VALUES ('e2e','E2E TEXT'), ('${GA}','GUEST TEXT')`);
    expect(await promptInstructions(db, E2E_SCOPE)).toBeNull();
    expect(await promptInstructions(db, GA)).toBeNull();
    await putProfile(db, "main", { instructions: "  " });
    expect(await promptInstructions(db, "main")).toBeNull();
  });
  test("buildRequest: no instructions -> exactly the base block; with instructions -> base block unchanged + a second block", () => {
    const h = [{ role: "user", content: [{ type: "text", text: "x" }] }];
    const plain: any = buildRequest("claude-haiku-5-5", h);
    expect(plain.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    const withI: any = buildRequest("claude-haiku-5-5", h, [], "Be terse.");
    expect(withI.system).toHaveLength(2);
    expect(withI.system[0]).toEqual(plain.system[0]);
    expect(withI.system[1].text).toBe(profileSystemText("Be terse."));
    expect(withI.system[1].text).toContain("Be terse.");
  });
  test("engine: the model call carries main's instructions; a failing lookup ends the turn in an error and calls no model", async () => {
    const run = async (instructions: () => Promise<string | null>) => {
      const db = new Database(":memory:"); const calls: any[] = [];
      const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => { calls.push(b); return b.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: {} }) : new Response(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"].map((t, i) => `data: ${JSON.stringify(
        t === "message_start" ? { type: t, message: { id: "m", usage: {} } } : t === "content_block_start" ? { type: t, index: 0, content_block: { type: "text", text: "" } } : t === "content_block_delta" ? { type: t, index: 0, delta: { type: "text_delta", text: "ok" } } : t === "message_delta" ? { type: t, delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } : { type: t, index: i })}\n\n`).join(""), { status: 200 }); } } as any;
      const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
      const ev: any[] = [];
      const e = new ChatEngine({ sql: { exec: (q: string, ...b: unknown[]) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } }, provider, index, sink: { broadcast: (_s, _t, x) => ev.push(x) }, retryDelayMs: 1, instructions });
      e.setConvId("c1"); await e.send("hi");
      return { calls: calls.filter((c) => c.stream !== false), ev };
    };
    const ok = await run(async () => "Be terse.");
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0].system[1].text).toContain("Be terse.");
    const none = await run(async () => null);
    expect(none.calls[0].system).toHaveLength(1);
    const bad = await run(async () => { throw new Error("d1 down"); });
    expect(bad.calls).toHaveLength(0);
    expect(bad.ev.some((x) => x.type === "error")).toBe(true);
  });
});
