import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createApp } from "../src/index";
import { makeSession } from "../src/auth";
// Real D1 in workerd: pin / rename / title search (LIKE ... ESCAPE, limit 50, pinned first) exactly as production SQL runs it, for main and a g:* scope.
const e = { ...(env as any), ALLOWED_GITHUB_LOGINS: "example-user,guest-a" };
const GA = "g:abcdefghijklmnopqrstuvwx";
const ORIGIN = "https://app.test";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function api(user: string, scope: string | null) {
  const app = createApp(scope ? { scopeOf: () => scope as any } : {});
  const { cookie, session } = await makeSession(e, user, "github");
  return (method: string, path: string, body?: unknown) => app.fetch(new Request(ORIGIN + path, { method, headers: { cookie: cookie.split(";")[0], "x-csrf-token": session.csrf, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), e);
}
describe("conversations on real D1: pin + search", () => {
  it("pinned first (list and search), % and _ literal, search capped at 50, g:* cannot pin another scope's chat", async () => {
    for (let i = 1; i <= 55; i++) await e.DB.prepare(`INSERT INTO conversations (id, model, title, scope) VALUES (?,?,?,?)`).bind(id(i), "m", `palette report ${i}`, "main").run();
    await e.DB.prepare(`INSERT INTO conversations (id, model, title, scope) VALUES (?,?,?,?)`).bind(id(100), "m", "palette 100% done_x", "main").run();
    await e.DB.prepare(`INSERT INTO conversations (id, model, title, scope) VALUES (?,?,?,?)`).bind(id(101), "m", "palette 100 percent doneXx", "main").run();
    await e.DB.prepare(`INSERT INTO conversations (id, model, title, scope) VALUES (?,?,?,?)`).bind(id(200), "m", "palette report guest", GA).run();
    const main = await api("example-user", null), guest = await api("guest-a", GA);
    const ids = async (f: typeof main, q: string) => ((await (await f("GET", `/api/conversations?q=${encodeURIComponent(q)}`)).json()) as any).conversations as Array<{ id: string; pinned: number }>;
    expect((await ids(main, "palette report")).length).toBe(50);
    expect((await ids(main, "0% done_x")).map((c) => c.id)).toEqual([id(100)]);
    expect((await main("PATCH", `/api/conversations/${id(7)}`, { pinned: true })).status).toBe(200);
    expect((await ids(main, "palette report"))[0]).toMatchObject({ id: id(7), pinned: 1 });
    expect((((await (await main("GET", "/api/conversations")).json()) as any).conversations[0]).id).toBe(id(7));
    expect((await guest("PATCH", `/api/conversations/${id(8)}`, { pinned: true })).status).toBe(404);
    expect((await main("PATCH", `/api/conversations/${id(200)}`, { pinned: true })).status).toBe(404);
    expect((await guest("PATCH", `/api/conversations/${id(200)}`, { pinned: true, title: "mine" })).status).toBe(200);
    expect((await ids(guest, "mine")).map((c) => c.id)).toEqual([id(200)]);
    expect(((await e.DB.prepare(`SELECT pinned FROM conversations WHERE id=?`).bind(id(8)).first()) as any).pinned).toBe(0);
    expect((await main("PATCH", `/api/conversations/${id(7)}`, { pinned: false })).status).toBe(200);
  });
});
