import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createApp } from "../src/index";
import { makeSession } from "../src/auth";
import { archiveProject, createProject, getProject, listProjects, projectInstructions } from "../src/projects";
// Real D1 in workerd: migration 0018 (projects table + conversations.project_id), the ?project= filter, archive un-assigning chats,
// the 50-per-scope cap, and the scope walls, exactly as production SQL runs them.
const e = { ...(env as any), ALLOWED_GITHUB_LOGINS: "example-user,guest-a" };
const GA = "g:abcdefghijklmnopqrstuvwx";
const ORIGIN = "https://app.test";
const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
async function api(user: string, scope: string | null) {
  const app = createApp(scope ? { scopeOf: () => scope as any } : {});
  const { cookie, session } = await makeSession(e, user, "github");
  return (method: string, path: string, body?: unknown) => app.fetch(new Request(ORIGIN + path, { method, headers: { cookie: cookie.split(";")[0], "x-csrf-token": session.csrf, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), e);
}
const conv = (n: number, scope: string) => e.DB.prepare(`INSERT INTO conversations (id, model, title, scope) VALUES (?,?,?,?)`).bind(id(n), "m", `chat ${n}`, scope).run();

describe("projects on real D1", () => {
  it("migration shape: additive column is nullable, existing conversations stay unassigned", async () => {
    await conv(1, "main");
    expect(((await e.DB.prepare(`SELECT project_id FROM conversations WHERE id=?`).bind(id(1)).first()) as any).project_id).toBeNull();
    const cols = ((await e.DB.prepare(`PRAGMA table_info(projects)`).all()) as any).results.map((c: any) => c.name);
    expect(cols).toEqual(["id", "scope", "name", "instructions", "created_at", "updated_at", "archived"]);
  });
  it("assign, filter by ?project=, archive un-assigns, scope walls hold", async () => {
    const main = await api("example-user", null), guest = await api("guest-a", GA);
    await conv(2, "main"); await conv(3, "main"); await conv(4, GA);
    const p = (await (await main("POST", "/api/projects", { name: "Site", instructions: "Use Astro." })).json()) as any;
    expect((await main("PATCH", `/api/conversations/${id(2)}`, { project_id: p.id })).status).toBe(200);
    const filtered = async (f: typeof main, pid: string) => ((await (await f("GET", `/api/conversations?project=${pid}`)).json()) as any).conversations.map((c: any) => c.id);
    expect(await filtered(main, p.id)).toEqual([id(2)]);
    expect(((await (await main("GET", "/api/projects")).json()) as any).projects[0]).toMatchObject({ id: p.id, chatCount: 1 });
    // another scope: cannot see the project, cannot assign its own chat to it, filter by its id matches nothing, projects routes 403 for g:*
    expect(await filtered(guest, p.id)).toEqual([]);
    expect((await guest("GET", "/api/projects")).status).toBe(403);
    expect((await guest("PATCH", `/api/conversations/${id(4)}`, { project_id: p.id })).status).toBe(404);
    expect((await main("PATCH", `/api/conversations/${id(4)}`, { project_id: p.id })).status).toBe(404);
    expect(await getProject(e.DB, GA, p.id)).toBeNull();
    expect(await projectInstructions(e.DB, "main", id(2))).toEqual({ name: "Site", text: "Use Astro." });
    expect(await projectInstructions(e.DB, "main", id(3))).toBeNull();
    // archive: row kept (archived=1), chats un-assigned, instructions gone from the prompt path
    expect((await main("DELETE", `/api/projects/${p.id}`)).status).toBe(200);
    expect(((await e.DB.prepare(`SELECT archived FROM projects WHERE id=?`).bind(p.id).first()) as any).archived).toBe(1);
    expect(((await e.DB.prepare(`SELECT project_id FROM conversations WHERE id=?`).bind(id(2)).first()) as any).project_id).toBeNull();
    expect(await filtered(main, p.id)).toEqual([]);
    expect(await projectInstructions(e.DB, "main", id(2))).toBeNull();
    expect((await listProjects(e.DB, "main")).length).toBe(0);
  });
  it("50-per-scope cap is enforced in SQL; archived rows free a slot", async () => {
    for (let i = 0; i < 50; i++) expect(await createProject(e.DB, "e2e", { name: `p${i}` })).not.toBeNull();
    expect(await createProject(e.DB, "e2e", { name: "51st" })).toBeNull();
    expect(await createProject(e.DB, "main", { name: "other scope" })).not.toBeNull();
    const first = (await listProjects(e.DB, "e2e"))[0];
    expect(await archiveProject(e.DB, "e2e", first.id)).toBe(true);
    expect(await createProject(e.DB, "e2e", { name: "fits again" })).not.toBeNull();
  });
});
