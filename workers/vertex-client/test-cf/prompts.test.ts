import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createApp } from "../src/index";
import { makeSession } from "../src/auth";
import { MAX_PROMPTS } from "../src/prompts";
// Real D1 in workerd: migration 0019 (saved_prompts), the per-scope cap and the scope walls, exactly as production SQL runs them.
const e = { ...(env as any), ALLOWED_GITHUB_LOGINS: "example-user,guest-a" };
const GA = "g:abcdefghijklmnopqrstuvwx";
const ORIGIN = "https://app.test";
async function api(user: string, scope: string | null) {
  const app = createApp(scope ? { scopeOf: () => scope as any } : {});
  const { cookie, session } = await makeSession(e, user, "github");
  return (method: string, path: string, body?: unknown) => app.fetch(new Request(ORIGIN + path, { method, headers: { cookie: cookie.split(";")[0], "x-csrf-token": session.csrf, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), e);
}

describe("saved prompts on real D1", () => {
  it("migration shape", async () => {
    const cols = ((await e.DB.prepare(`PRAGMA table_info(saved_prompts)`).all()) as any).results.map((c: any) => c.name);
    expect(cols).toEqual(["id", "scope", "title", "text", "created_at", "updated_at"]);
  });
  it("CRUD, the cap, and the scope walls hold", async () => {
    const main = await api("example-user", null), guest = await api("guest-a", GA);
    const p = (await (await main("POST", "/api/prompts", { title: "Review", text: "Review: {{clipboard}}" })).json()) as any;
    expect((await main("PATCH", `/api/prompts/${p.id}`, { title: "Review 2" })).status).toBe(200);
    expect(((await (await main("GET", "/api/prompts")).json()) as any).prompts[0]).toMatchObject({ title: "Review 2", text: "Review: {{clipboard}}" });
    expect(((await (await guest("GET", "/api/prompts")).json()) as any).prompts).toEqual([]); // own (empty) list, never main's
    expect((await guest("DELETE", `/api/prompts/${p.id}`)).status).toBe(404);
    for (let i = 1; i < MAX_PROMPTS; i++) expect((await main("POST", "/api/prompts", { title: `p${i}`, text: "x" })).status).toBe(201);
    expect((await main("POST", "/api/prompts", { title: "over", text: "x" })).status).toBe(409);
    expect((await main("DELETE", `/api/prompts/${p.id}`)).status).toBe(200);
    expect((await main("POST", "/api/prompts", { title: "fits again", text: "x" })).status).toBe(201);
  });
});
