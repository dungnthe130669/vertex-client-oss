// Shared harness for the user-keys tests (real createApp over an in-memory D1 built from the real migrations). Not a test file.
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { GuestScope } from "../src/scope";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { chatMock } from "./do-mock";

export const SECRET = "enc-secret-0123456789abcdef";
export const FAKE = "fake-user-key-AAAA1111BBBB2222";
export const FAKE_B = "fake-other-key-CCCC3333DDDD4444";
export const gw = { name: "gw", messages: async () => new Response("{}"), listModels: async () => [{ id: "claude-sonnet-5-5", displayName: "S" }] };

function d1(skip: string[] = []) {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort().filter((f) => !skip.some((k) => f.startsWith(k)))) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }), run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; } } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { db.exec("BEGIN"); try { const out = []; for (const x of ss) out.push(await x.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } } } as unknown as D1Database };
}
export const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
export const upstream: Array<{ url: string; headers: Record<string, string> }> = [];
export const fetchImpl = (async (url: string, init: any) => { upstream.push({ url, headers: init.headers });
  if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "a/x" }] }), { status: 200 });
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { status: 200 }); }) as unknown as typeof fetch;
export const app = createApp({ fetchImpl, scopeOf: (s) => (s.u === "guest-a" ? GA : s.via === "e2e" ? "e2e" : "main"), provider: () => gw });
export const mkEnv = (o: { secret?: boolean; skip?: string[]; worker?: string } = {}) => { const x = d1(o.skip); const e: any = { SESSION_SECRET: "test-secret-0123456789", ...(o.secret === false ? {} : { KEY_ENC_SECRET: SECRET }), ...(o.worker ? { PROVIDER_KEY_NVIDIA: o.worker } : {}), ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k", AI: {}, E2E_TOKEN: "e2e-test-token-0123456789abcdef0123456789abcdef", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, _db: x.db }; e.CHAT = chatMock(() => e.FILES, () => {}); return e as Env & { _db: Database }; };
export async function call(env: Env, user: string, method: string, path: string, b?: unknown, space?: "open", raw?: string) {
  let cookie: string, csrf: string;
  if (user === "e2e") { const r = await app.fetch(new Request("https://app.test/auth/e2e", { method: "POST", headers: { "x-e2e-token": (env as any).E2E_TOKEN } }), env); cookie = r.headers.get("set-cookie")!.split(";")[0]!; csrf = ((await (await app.fetch(new Request("https://app.test/api/me", { headers: { cookie } }), env)).json()) as any).csrf; }
  else { const m = await makeSession(env, user, "github"); cookie = m.cookie.split(";")[0]!; csrf = m.session.csrf; }
  return app.fetch(new Request("https://app.test" + path, { method, headers: { cookie, origin: "https://app.test", "x-csrf-token": csrf, "content-type": "application/json", ...(space ? { "x-vc-space": space } : {}) }, body: raw ?? (b === undefined ? undefined : JSON.stringify(b)) }), env);
}

