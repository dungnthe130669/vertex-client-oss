// Spaces T4: per-space gates. Personal connector default OFF in Open, custom MCP / profile / projects / artifacts read the space's own rows,
// Open gets no seeds, voice quota is shared by base, usage reconcile is Business only. Every case also checks the other space stays untouched.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { EMPTY_TOOL_HOST, toolHostFor } from "../src/auth-e2e";
import { filterHost, loadSettings, saveSettings } from "../src/connectors";
import { decryptToken, encryptToken, listCustom } from "../src/custom-connectors";
import { artifactTools, mintViewToken } from "../src/artifacts";
import { promptInstructions, putProfile } from "../src/profile";
import { createProject, assignConversation, projectInstructions } from "../src/projects";
import { listPersonas } from "../src/personas";
import { listSkills } from "../src/skills";
import { takeTranscribeSlot } from "../src/transcribe";
import { usageReport } from "../src/usage";
import { parseBase, scopeFor, type BaseScope, type Scope } from "../src/scope";
import type { ToolHost } from "../src/tools";
import { chatMock } from "./do-mock";

const ORIGIN = "https://app.test";
const G = parseBase("g:abcdefghijklmnop1234") as BaseScope;
const BIZ = "main" as Scope, OPEN = scopeFor("main" as BaseScope, "open"), GOPEN = scopeFor(G, "open"), EOPEN = scopeFor("e2e" as BaseScope, "open");
function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { const o = []; for (const s of ss) o.push(await s.all()); return o; } } as unknown as D1Database };
}
const mk = () => {
  const x = d1();
  const env: any = { DB: x.d1, SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", E2E_TOKEN: "e".repeat(40), GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") } };
  env.CHAT = chatMock(() => env.FILES);
  return { env: env as Env, db: x.db, d1: x.d1 };
};
const req = async (env: Env, path: string, o: { seam?: Scope; headers?: Record<string, string>; method?: string; body?: unknown } = {}) => {
  const app = createApp(o.seam ? { scopeOf: () => o.seam! } : {});
  const { cookie: ck, session } = await makeSession(env, "example-user", "github"); const cookie = ck.split(";")[0]!;
  return app.request(`${ORIGIN}${path}`, { method: o.method ?? "GET", headers: { cookie, origin: ORIGIN, "x-csrf-token": session.csrf, ...(o.body ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}) }, env);
};
const raw: ToolHost = { async list() { return [{ name: "search_notes", description: "d", input_schema: { type: "object" }, approval: false }]; }, async call() { return { text: "SECRET NOTE", isError: false }; } };
const insertCustom = (db: Database, id: string, scope: string, name: string, enc: string | null = null) =>
  db.query(`INSERT INTO custom_connectors (id, scope, name, url, auth_kind, auth_header_name, enc_token, enabled, last_status) VALUES (?,?,?,?,?,?,?,1,'ok')`).run(id, scope, name, "https://mcp.example/x", "none", null, enc);

describe("personal connector: default OFF in Open, per-space switch", () => {
  test("Open, no row: nothing is offered and calls are refused; Business, no row: unchanged (everything)", async () => {
    const { d1: D } = mk();
    const open = filterHost(toolHostFor(OPEN, raw), await loadSettings(D, OPEN));
    expect(await open.list()).toEqual([]);
    expect(await open.call("search_notes", {})).toMatchObject({ isError: true });
    const biz = filterHost(toolHostFor(BIZ, raw), await loadSettings(D, BIZ));
    expect((await biz.list()).map((t) => t.name)).toEqual(["search_notes"]);
  });
  test("a row enabling it in Open turns it on there only; Business row is independent", async () => {
    const { d1: D } = mk();
    await saveSettings(D, OPEN, { enabled: true, disabled: [], modes: {} });
    expect((await filterHost(toolHostFor(OPEN, raw), await loadSettings(D, OPEN)).list()).map((t) => t.name)).toEqual(["search_notes"]);
    await saveSettings(D, BIZ, { enabled: false, disabled: [], modes: {} });
    expect(await filterHost(toolHostFor(BIZ, raw), await loadSettings(D, BIZ)).list()).toEqual([]);
    expect((await loadSettings(D, OPEN)).enabled).toBe(true); // switching Business off did not touch Open
  });
  test("a row can never enable the connector for e2e~open or a guest's Open (table is empty)", async () => {
    const { d1: D } = mk();
    for (const sc of [EOPEN, GOPEN]) {
      await saveSettings(D, sc, { enabled: true, disabled: [], modes: {} });
      expect(await filterHost(toolHostFor(sc, raw), await loadSettings(D, sc)).list()).toEqual([]);
    }
    expect(toolHostFor(GOPEN, raw)).toBe(EMPTY_TOOL_HOST);
  });
  test("HTTP: GET /api/connectors?space=open reports enabled=false by default; PUT enables it for Open only", async () => {
    const { env } = mk();
    const view = async (sp: string) => ((await (await req(env, `/api/connectors?space=${sp}`)).json()) as any).connectors[0];
    expect((await view("open")).enabled).toBe(false); expect((await view("biz")).enabled).toBe(true);
    const put = await req(env, "/api/connectors/personal-connector", { method: "PUT", headers: { "x-vc-space": "open" }, body: { enabled: true } });
    expect(put.status).toBe(200);
    expect((await view("open")).enabled).toBe(true); expect((await view("biz")).enabled).toBe(true);
    await req(env, "/api/connectors/personal-connector", { method: "PUT", body: { enabled: false } }); // Business off
    expect((await view("open")).enabled).toBe(true); expect((await view("biz")).enabled).toBe(false);
  });
  test("a guest's Open space cannot reach connectors / projects / artifacts routes at all", async () => {
    const { env } = mk();
    for (const p of ["/api/connectors", "/api/projects", "/api/artifacts"]) expect((await req(env, p, { seam: GOPEN })).status).toBe(403);
    for (const p of ["/api/connectors", "/api/projects", "/api/artifacts"]) expect((await req(env, p, { seam: G })).status).toBe(403);
  });
});

describe("custom MCP connectors: per-space rows, AAD scope:id", () => {
  test("each space lists only its own rows (HTTP)", async () => {
    const { env, db } = mk();
    insertCustom(db, "cc_biz", "main", "bizmcp"); insertCustom(db, "cc_open", "main~open", "openmcp");
    const names = async (sp: string) => ((await (await req(env, `/api/connectors?space=${sp}`)).json()) as any).connectors.slice(1).map((c: any) => c.name);
    expect(await names("biz")).toEqual(["bizmcp"]); expect(await names("open")).toEqual(["openmcp"]);
    expect((await req(env, "/api/connectors/cc_biz?space=open")).status).toBe(404); // another space's id = unknown
    expect((await req(env, "/api/connectors/cc_open")).status).toBe(404);
    expect((await req(env, "/api/connectors/cc_biz", { method: "DELETE", headers: { "x-vc-space": "open" } })).status).toBe(404);
    expect((await listCustom(mk().d1, OPEN)).length).toBe(0);
  });
  test("a ciphertext copied from a Business row into an Open row does not decrypt", async () => {
    const enc = await encryptToken("test-secret-0123456789", "main:cc_x", "tok");
    expect(await decryptToken("test-secret-0123456789", "main:cc_x", enc)).toBe("tok");
    await expect(decryptToken("test-secret-0123456789", "main~open:cc_x", enc)).rejects.toThrow();
  });
});

describe("profile, project instructions read the space's own row", () => {
  test("Open instructions never see Business text and vice versa; guest Open gets none", async () => {
    const { d1: D } = mk();
    await putProfile(D, BIZ, { instructions: "BIZ-TEXT" }); await putProfile(D, OPEN, { instructions: "OPEN-TEXT" }); await putProfile(D, GOPEN, { instructions: "GUEST-TEXT" });
    expect(await promptInstructions(D, BIZ)).toBe("BIZ-TEXT");
    expect(await promptInstructions(D, OPEN)).toBe("OPEN-TEXT");
    expect(await promptInstructions(D, GOPEN)).toBeNull();
    const only = mk(); await putProfile(only.d1, BIZ, { instructions: "BIZ-ONLY" });
    expect(await promptInstructions(only.d1, OPEN)).toBeNull(); // no Open row: nothing falls back to Business
  });
  test("HTTP /api/profile is per space", async () => {
    const { env } = mk();
    await req(env, "/api/profile", { method: "PUT", body: { instructions: "b" } });
    await req(env, "/api/profile", { method: "PUT", headers: { "x-vc-space": "open" }, body: { instructions: "o" } });
    expect(((await (await req(env, "/api/profile")).json()) as any).instructions).toBe("b");
    expect(((await (await req(env, "/api/profile?space=open")).json()) as any).instructions).toBe("o");
  });
  test("project instructions: the project and conversation of the other space are invisible", async () => {
    const { d1: D, db } = mk();
    const cid = "11111111-1111-4111-8111-111111111111", oid = "22222222-2222-4222-8222-222222222222";
    db.query(`INSERT INTO conversations (id, title, model, scope) VALUES (?,?,?,?)`).run(cid, "t", "m", "main"); db.query(`INSERT INTO conversations (id, title, model, scope) VALUES (?,?,?,?)`).run(oid, "t", "m", "main~open");
    const pb = (await createProject(D, BIZ, { name: "pb", instructions: "BIZ-PROJ" }))!, po = (await createProject(D, OPEN, { name: "po", instructions: "OPEN-PROJ" }))!;
    expect(await assignConversation(D, OPEN, oid, pb.id)).toBe(false); // Business project cannot attach to an Open chat
    expect(await assignConversation(D, OPEN, oid, po.id)).toBe(true); expect(await assignConversation(D, BIZ, cid, pb.id)).toBe(true);
    expect((await projectInstructions(D, OPEN, oid))?.text).toBe("OPEN-PROJ"); expect((await projectInstructions(D, BIZ, cid))?.text).toBe("BIZ-PROJ");
    expect(await projectInstructions(D, OPEN, cid)).toBeNull(); expect(await projectInstructions(D, GOPEN, oid)).toBeNull();
  });
});

describe("artifacts: base gate, own rows, frame token bound to the storage scope", () => {
  test("artifact tools: main in either space, guest Open none", async () => {
    const { d1: D } = mk();
    const t = (scope: Scope) => artifactTools({ db: D, files: undefined, scope, conv: null }).list();
    expect((await t(BIZ)).length).toBe(2); expect((await t(OPEN)).length).toBe(2); expect(await t(GOPEN)).toEqual([]); expect(await t(EOPEN)).toEqual([]);
  });
  test("an artifact made in Business is not listed or readable in Open", async () => {
    const { env, db } = mk();
    db.query(`INSERT INTO artifacts (id, scope, title, type, current_version, preview, bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`).run("a".repeat(32), "main", "biz-doc", "markdown", 1, "p", 1);
    expect(((await (await req(env, "/api/artifacts")).json()) as any).items.length).toBe(1);
    expect(((await (await req(env, "/api/artifacts?space=open")).json()) as any).items.length).toBe(0);
    expect((await req(env, `/api/artifacts/${"a".repeat(32)}?space=open`)).status).toBe(404);
  });
  test("a frame token minted for main does not open an Open claim's row (and a junk scope claim is 404)", async () => {
    const { env, db } = mk();
    const id = "a".repeat(32);
    db.query(`INSERT INTO artifacts (id, scope, title, type, current_version, preview, bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`).run(id, "main", "d", "html", 1, "p", 1);
    const app = createApp({});
    const get = async (scope: string) => app.request(`${ORIGIN}/af/${id}/1?t=${(await mintViewToken(env.SESSION_SECRET, { id, version: 1, scope })).token}`, {}, env);
    expect((await get("main~open")).status).toBe(404);
    expect((await get("g:abcdefghijklmnop1234~open")).status).toBe(404);
    expect((await get("nonsense")).status).toBe(404);
  });
});

describe("seeds: Open starts empty", () => {
  test("personas and skills of Open are empty and seeding Open writes nothing; Business still seeds", async () => {
    const { d1: D, db } = mk();
    expect(await listPersonas(D, OPEN)).toEqual([]); expect(await listSkills(D, OPEN)).toEqual([]);
    expect(db.query(`SELECT COUNT(*) n FROM settings WHERE name LIKE '%seeded%'`).get()).toEqual({ n: 0 });
    expect((await listSkills(D, BIZ)).length).toBeGreaterThan(0);
    expect((await listPersonas(D, BIZ)).length).toBeGreaterThan(0);
    expect(await listSkills(D, OPEN)).toEqual([]); // Business seeding did not leak into Open
  });
});

describe("voice quota and usage reconcile", () => {
  test("hourly voice limit is shared by base: Business + Open cannot double it", async () => {
    const { d1: D, db } = mk(); const now = Date.now();
    expect(await takeTranscribeSlot(D, BIZ, now, 2)).toBe(true); expect(await takeTranscribeSlot(D, OPEN, now, 2)).toBe(true);
    expect(await takeTranscribeSlot(D, BIZ, now, 2)).toBe(false); expect(await takeTranscribeSlot(D, OPEN, now, 2)).toBe(false);
    expect((db.query(`SELECT name FROM settings WHERE name LIKE 'transcribe:%'`).all() as any[]).every((r) => r.name.startsWith("transcribe:main:"))).toBe(true);
    expect(await takeTranscribeSlot(D, GOPEN, now, 2)).toBe(true); // another base has its own counter
  });
  test("gateway_reconcile is shown for Business only, even when the row exists", async () => {
    const { d1: D, db } = mk();
    db.query(`INSERT INTO settings (name, value) VALUES ('gateway_reconcile', ?)`).run(JSON.stringify({ ok: 1 }));
    expect((await usageReport(D, Date.now(), 0, "main") as any).reconcile).toEqual({ ok: 1 });
    expect((await usageReport(D, Date.now(), 0, OPEN) as any).reconcile).toBeNull();
    expect((await usageReport(D, Date.now(), 0, GOPEN) as any).reconcile).toBeNull();
  });
});
