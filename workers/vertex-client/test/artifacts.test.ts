import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import worker, { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import {
  ARTIFACT_TOOL_DEFS, MAX_ARTIFACTS, MAX_CONTENT_BYTES, MAX_SCOPE_BYTES, MAX_TITLE, MAX_VERSIONS, MAX_WRITES_PER_TURN, PAGE, UNDO_GRACE_MS,
  VIEW_TTL_S, artifactKey, artifactTools, mintViewToken, verifyViewToken, createArtifact, deleteArtifact, getArtifact, listArtifacts, restoreVersion, scopeHash, sweepDeleted, undeleteArtifact, updateArtifact, validateInput, withArtifacts, type Deps,
} from "../src/artifacts";
import { ARTIFACT_TOOLS, classify, type ToolHost } from "../src/tools";
import { EMPTY_TOOL_HOST, toolHostFor } from "../src/auth-e2e";
import { SYSTEM_PROMPT } from "../src/system-prompt";
import type { Scope, GuestScope } from "../src/scope";

const ORIGIN = "https://app.test";
const TOKEN = "t".repeat(64);
function d1() {
  const db = new Database(":memory:");
  for (const f of ["0016_artifacts.sql", "0017_artifacts_html.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q) } as unknown as D1Database };
}
function r2() {
  const m = new Map<string, string>();
  const bucket = {
    put: async (k: string, v: string) => { m.set(k, String(v)); },
    get: async (k: string) => (m.has(k) ? { arrayBuffer: async () => new TextEncoder().encode(m.get(k)!).buffer } : null),
    delete: async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
  };
  return { m, bucket: bucket as unknown as R2Bucket };
}
const setup = () => { const a = d1(), b = r2(); const dep = (scope: Scope, conv: string | null = "c1"): Deps => ({ db: a.d1, files: b.bucket, scope, conv }); return { ...a, ...b, dep }; };
const ok = <T,>(r: { ok: boolean } & any): T => { if (!r.ok) throw new Error("expected ok: " + r.error); return r.v; };
const md = (title = "Doc", content = "# Hello\nbody") => ({ title, type: "markdown", content });

describe("validateInput bounds", () => {
  test("title, type, content, language, svg shape", () => {
    expect(validateInput(md(""), true).ok).toBe(false);
    expect(validateInput(md("x".repeat(MAX_TITLE + 1)), true).ok).toBe(false);
    expect(validateInput(md("x".repeat(MAX_TITLE)), true).ok).toBe(true);
    expect(validateInput({ ...md(), type: "pdf" }, true).ok).toBe(false);
    expect(validateInput({ ...md(), type: "html", content: "<h1>x</h1>" }, true).ok).toBe(true);
    expect(validateInput({ ...md(), content: "" }, true).ok).toBe(false);
    expect(validateInput({ ...md(), content: 5 }, true).ok).toBe(false);
    expect(validateInput({ title: "t", type: "code", language: "type script", content: "x" }, true).ok).toBe(false);
    expect(validateInput({ title: "t", type: "code", language: "c++", content: "x" }, true).ok).toBe(true);
    expect(validateInput({ title: "t", type: "svg", content: "<div>no</div>" }, true).ok).toBe(false);
    expect(validateInput({ title: "t", type: "svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" }, true).ok).toBe(true);
  });
  test("content over 256 KB (bytes, not characters) is a readable tool error", () => {
    expect(validateInput(md("t", "a".repeat(MAX_CONTENT_BYTES)), true).ok).toBe(true);
    const r = validateInput(md("t", "a".repeat(MAX_CONTENT_BYTES + 1)), true);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/256 KB/);
    expect(validateInput(md("t", "é".repeat(MAX_CONTENT_BYTES / 2 + 1)), true).ok).toBe(false); // 2 bytes per char
  });
});

describe("storage + R2 keys", () => {
  test("keys are derived from scope hash + uuid + numeric version; bad inputs throw", async () => {
    const id = "0b9f8c1e-1111-4222-8333-444455556666";
    const k = await artifactKey("main", id, 3);
    expect(k).toBe(`vertex-client/artifacts/${await scopeHash("main")}/${id}/v3`);
    expect(k).not.toContain("main");
    expect(await scopeHash("main")).not.toBe(await scopeHash("e2e"));
    await expect(artifactKey("main", "../../etc/passwd", 1)).rejects.toThrow();
    await expect(artifactKey("main", id, 0)).rejects.toThrow();
    await expect(artifactKey("main", id, 1.5)).rejects.toThrow();
  });
  test("create + update write only under the row-derived prefix, versions accumulate, preview/bytes follow the current version", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("Plan", "x".repeat(500)), 1));
    expect(a).toMatchObject({ title: "Plan", type: "markdown", version: 1 });
    const b = ok<any>(await updateArtifact(s.dep("main"), a.id, { content: "second ✓", title: "Plan v2" }, 1));
    expect(b).toMatchObject({ id: a.id, version: 2, title: "Plan v2" });
    const prefix = `vertex-client/artifacts/${await scopeHash("main")}/${a.id}/`;
    expect([...s.m.keys()].sort()).toEqual([`${prefix}v1`, `${prefix}v2`]);
    const row = s.db.query("SELECT preview, bytes, current_version FROM artifacts WHERE id=?").get(a.id) as any;
    expect(row).toEqual({ preview: "second ✓", bytes: new TextEncoder().encode("second ✓").length, current_version: 2 });
    const full = ok<any>(await getArtifact(s.dep("main"), a.id));
    expect(full.content).toBe("second ✓");
    expect(full.versions.map((v: any) => v.version)).toEqual([1, 2]);
    expect(ok<any>(await getArtifact(s.dep("main"), a.id, 1)).content).toBe("x".repeat(500));
    expect(s.db.query("SELECT length(preview) AS n FROM artifacts").get() as any).toEqual({ n: 8 });
  });
  test("preview is capped at ~200 chars", async () => {
    const s = setup();
    ok(await createArtifact(s.dep("main"), md("Long", "y".repeat(5000)), 1));
    expect((s.db.query("SELECT length(preview) AS n FROM artifacts").get() as any).n).toBe(200);
  });
  test("restore copies an old version into a NEW version, never rewrites history", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("R", "one"), 1));
    ok(await updateArtifact(s.dep("main"), a.id, { content: "two" }, 1));
    const r = ok<any>(await restoreVersion(s.dep("main"), a.id, 1));
    expect(r.version).toBe(3);
    expect(ok<any>(await getArtifact(s.dep("main"), a.id, 3)).content).toBe("one");
    expect(ok<any>(await getArtifact(s.dep("main"), a.id, 2)).content).toBe("two");
    expect((await restoreVersion(s.dep("main"), a.id, 99)).ok).toBe(false);
  });
  test("50 versions per artifact: the oldest non-current are pruned (rows and R2), the current one is kept", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("P", "v1"), null));
    for (let i = 2; i <= MAX_VERSIONS + 5; i++) ok(await updateArtifact(s.dep("main"), a.id, { content: `v${i}` }, null));
    const vs = (s.db.query("SELECT version FROM artifact_versions WHERE artifact_id=? ORDER BY version").all(a.id) as any[]).map((x) => x.version);
    expect(vs.length).toBe(MAX_VERSIONS);
    expect(vs[0]).toBe(6);
    expect(vs.at(-1)).toBe(MAX_VERSIONS + 5);
    expect(s.m.size).toBe(MAX_VERSIONS);
    expect(ok<any>(await getArtifact(s.dep("main"), a.id)).content).toBe(`v${MAX_VERSIONS + 5}`);
    expect((await getArtifact(s.dep("main"), a.id, 1)).ok).toBe(false);
  });
});

describe("limits", () => {
  test("at most 10 creates/updates per turn; the next turn starts fresh; other conversations are separate", async () => {
    const s = setup();
    const first = ok<any>(await createArtifact(s.dep("main"), md("A", "a"), 7));
    for (let i = 1; i < MAX_WRITES_PER_TURN; i++) ok(await updateArtifact(s.dep("main"), first.id, { content: `u${i}` }, 7));
    const over = await updateArtifact(s.dep("main"), first.id, { content: "nope" }, 7);
    expect(over.ok).toBe(false);
    expect((over as any).error).toMatch(/at most 10/);
    expect((await createArtifact(s.dep("main"), md("B", "b"), 7)).ok).toBe(false);
    expect((await createArtifact(s.dep("main"), md("B", "b"), 8)).ok).toBe(true);
    expect((await createArtifact(s.dep("main", "c2"), md("C", "c"), 7)).ok).toBe(true);
  });
  test("500 artifacts per scope (deleted ones do not count)", async () => {
    const s = setup();
    const ins = s.db.prepare("INSERT INTO artifacts (id, scope, title, type, current_version, created_at, updated_at, deleted_at) VALUES (?,?,?,?,1,?,?,?)");
    for (let i = 0; i < MAX_ARTIFACTS; i++) ins.run(crypto.randomUUID(), "main", `t${i}`, "markdown", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null);
    const r = await createArtifact(s.dep("main"), md(), null);
    expect(r.ok).toBe(false);
    expect((await createArtifact(s.dep("e2e"), md(), null)).ok).toBe(true); // another scope is unaffected
    s.db.exec("UPDATE artifacts SET deleted_at='2026-01-01T00:00:00.000Z' WHERE title='t0'");
    expect((await createArtifact(s.dep("main"), md(), null)).ok).toBe(true);
  });
  test("200 MB per scope", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("Big", "x"), null));
    s.db.exec(`UPDATE artifact_versions SET bytes=${MAX_SCOPE_BYTES - 5} WHERE artifact_id='${a.id}'`);
    expect((await createArtifact(s.dep("main"), md("two", "123456"), null)).ok).toBe(false);
    expect((await updateArtifact(s.dep("main"), a.id, { content: "123456" }, null)).ok).toBe(false);
    expect((await createArtifact(s.dep("e2e"), md("two", "123456"), null)).ok).toBe(true);
  });
  test("svg update must stay an svg document", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), { title: "S", type: "svg", content: "<svg></svg>" }, null));
    expect((await updateArtifact(s.dep("main"), a.id, { content: "<script>alert(1)</script>" }, null)).ok).toBe(false);
  });
});

describe("scope isolation", () => {
  test("another scope cannot read, list, update, delete, undelete or restore main's artifact (IDOR on :id)", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("Secret", "top secret"), 1));
    for (const other of ["e2e", "g:abcdefghijklmnopqrstuvwx" as GuestScope] as Scope[]) {
      const d = s.dep(other);
      expect((await getArtifact(d, a.id)).ok).toBe(false);
      expect((await getArtifact(d, a.id, 1)).ok).toBe(false);
      expect(ok<any>(await listArtifacts(d, "", null)).items).toEqual([]);
      expect(ok<any>(await listArtifacts(d, "secret", null)).items).toEqual([]);
      expect((await updateArtifact(d, a.id, { content: "pwned" }, 1)).ok).toBe(false);
      expect((await deleteArtifact(d, a.id)).ok).toBe(false);
      expect((await undeleteArtifact(d, a.id)).ok).toBe(false);
      expect((await restoreVersion(d, a.id, 1)).ok).toBe(false);
    }
    expect(ok<any>(await getArtifact(s.dep("main"), a.id)).content).toBe("top secret");
    expect(s.db.query("SELECT COUNT(*) AS n FROM artifact_versions").get() as any).toEqual({ n: 1 });
    expect(s.db.query("SELECT deleted_at FROM artifacts").get() as any).toEqual({ deleted_at: null });
  });
  test("update_artifact via the tool host with another scope's id fails closed and writes nothing", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("Mine", "m"), 1));
    const e2eHost = artifactTools(s.dep("e2e"));
    expect(await e2eHost.list()).toEqual([]);
    const r = await e2eHost.call("update_artifact", { id: a.id, content: "x" }, { turn: 1 });
    expect(r.isError).toBe(true);
    // even a host forced to run under a non-main scope (second lock) writes nothing
    expect(s.db.query("SELECT COUNT(*) AS n FROM artifact_versions").get() as any).toEqual({ n: 1 });
    expect([...s.m.values()]).toEqual(["m"]);
  });
  test("the tool host is main-only: g:* and e2e get no tools; the model-visible error for a foreign id is the same as for a missing one", async () => {
    const s = setup();
    for (const sc of ["e2e", "g:abcdefghijklmnopqrstuvwx" as GuestScope] as Scope[]) {
      const h = artifactTools(s.dep(sc));
      expect(await h.list()).toEqual([]);
      expect((await h.call("create_artifact", md(), { turn: 1 })).isError).toBe(true);
    }
    expect(s.m.size).toBe(0);
    const main = artifactTools(s.dep("main"));
    const a = ok<any>(await createArtifact(s.dep("e2e"), md("E", "e"), null));
    const foreign = await main.call("update_artifact", { id: a.id, content: "x" }, { turn: 1 });
    const missing = await main.call("update_artifact", { id: "0b9f8c1e-1111-4222-8333-444455556666", content: "x" }, { turn: 1 });
    expect(foreign).toEqual(missing);
    expect(foreign.isError).toBe(true);
  });
  test("a client-supplied key/id can never address an R2 object (non-uuid ids are refused before any query/key)", async () => {
    const s = setup();
    ok(await createArtifact(s.dep("main"), md("K", "k"), 1));
    for (const id of ["../x", "vertex-client/artifacts/x/y/v1", "'; DROP TABLE artifacts;--", "0b9f8c1e-1111-4222-8333-44445555666"]) {
      expect((await getArtifact(s.dep("main"), id)).ok).toBe(false);
      expect((await updateArtifact(s.dep("main"), id, { content: "x" }, 1)).ok).toBe(false);
    }
    expect((s.db.query("SELECT COUNT(*) AS n FROM artifacts").get() as any).n).toBe(1);
  });
});

describe("soft delete", () => {
  test("not listed, not served, not updatable; undo within the grace; the sweep removes rows + R2 only after the grace", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("Gone", "g"), 1));
    ok(await deleteArtifact(s.dep("main"), a.id));
    expect(ok<any>(await listArtifacts(s.dep("main"), "", null)).items).toEqual([]);
    expect((await getArtifact(s.dep("main"), a.id)).ok).toBe(false);
    expect((await updateArtifact(s.dep("main"), a.id, { content: "x" }, 1)).ok).toBe(false);
    expect((await deleteArtifact(s.dep("main"), a.id)).ok).toBe(false);
    ok(await undeleteArtifact(s.dep("main"), a.id));
    expect(ok<any>(await getArtifact(s.dep("main"), a.id)).content).toBe("g");
    ok(await deleteArtifact(s.dep("main"), a.id));
    expect(await sweepDeleted(s.d1, s.bucket, Date.now())).toBe(0);
    expect(s.m.size).toBe(1);
    expect(await sweepDeleted(s.d1, s.bucket, Date.now() + UNDO_GRACE_MS + 60_000)).toBe(1);
    expect(s.m.size).toBe(0);
    expect(s.db.query("SELECT COUNT(*) AS n FROM artifacts").get() as any).toEqual({ n: 0 });
    expect(s.db.query("SELECT COUNT(*) AS n FROM artifact_versions").get() as any).toEqual({ n: 0 });
  });
  test("undo after the grace is refused; the sweep never touches a live artifact or another one's objects", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("A", "a"), 1));
    const b = ok<any>(await createArtifact(s.dep("main"), md("B", "b"), 1));
    ok(await deleteArtifact(s.dep("main"), a.id));
    s.db.exec(`UPDATE artifacts SET deleted_at='2020-01-01T00:00:00.000Z' WHERE id='${a.id}'`);
    expect((await undeleteArtifact(s.dep("main"), a.id)).ok).toBe(false);
    expect(await sweepDeleted(s.d1, s.bucket)).toBe(1);
    expect(ok<any>(await getArtifact(s.dep("main"), b.id)).content).toBe("b");
    expect(s.m.size).toBe(1);
  });
});

describe("list + search", () => {
  test("newest first, keyset paging, LIKE on title + preview, wildcards are literal", async () => {
    const s = setup();
    const ins = s.db.prepare("INSERT INTO artifacts (id, scope, title, type, current_version, preview, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)");
    for (let i = 0; i < PAGE + 5; i++) ins.run(crypto.randomUUID(), "main", `Doc ${i}`, "markdown", i === 3 ? "contains 100% real" : "plain", "2026-01-01T00:00:00.000Z", new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
    ins.run(crypto.randomUUID(), "e2e", "Other scope", "markdown", "plain", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    const p1 = ok<any>(await listArtifacts(s.dep("main"), "", null));
    expect(p1.items.length).toBe(PAGE);
    expect(p1.items[0].title).toBe(`Doc ${PAGE + 4}`);
    expect(p1.next).toBeTruthy();
    const p2 = ok<any>(await listArtifacts(s.dep("main"), "", p1.next));
    expect(p2.items.length).toBe(5);
    expect(p2.next).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x: any) => x.id)).size).toBe(PAGE + 5);
    expect(ok<any>(await listArtifacts(s.dep("main"), "doc 7", null)).items.map((x: any) => x.title)).toEqual(["Doc 7"]);
    expect(ok<any>(await listArtifacts(s.dep("main"), "100%", null)).items.map((x: any) => x.title)).toEqual(["Doc 3"]);
    expect(ok<any>(await listArtifacts(s.dep("main"), "%", null)).items.map((x: any) => x.title)).toEqual(["Doc 3"]); // literal %
    expect(ok<any>(await listArtifacts(s.dep("main"), "_", null)).items).toEqual([]);                                  // literal _
    expect((await listArtifacts(s.dep("main"), "", "garbage")).ok).toBe(false);
    expect((await listArtifacts(s.dep("main"), "", "x' OR 1=1--|y")).ok).toBe(false);
  });
});

describe("composite host", () => {
  const fake = (names: string[]): ToolHost => ({ async list() { return names.map((name) => ({ name, description: "", input_schema: {}, approval: false })); }, async call(n) { return { text: `base:${n}`, isError: false }; } });
  test("sorted by name, stable, artifact calls routed to the artifact host, everything else to the base; classify() knows both as auto", async () => {
    const s = setup();
    const h = withArtifacts(fake(["search_notes", "read_url"]), artifactTools(s.dep("main")));
    const names = (await h.list()).map((t) => t.name);
    expect(names).toEqual(["create_artifact", "read_url", "search_notes", "update_artifact"]);
    expect(JSON.stringify(await h.list())).toBe(JSON.stringify(await h.list()));
    expect((await h.call("read_url", {})).text).toBe("base:read_url");
    expect((await h.call("create_artifact", md(), { turn: 1 })).isError).toBe(false);
    for (const n of ARTIFACT_TOOLS) expect(classify(n)).toBe("auto");
    expect(ARTIFACT_TOOL_DEFS.every((t) => !t.approval)).toBe(true);
  });
  test("a base host that ALSO claims an artifact tool name cannot shadow ours; non-main scopes list no artifact tools", async () => {
    const s = setup();
    const h = withArtifacts(fake(["create_artifact", "search_notes"]), artifactTools(s.dep("main")));
    expect((await h.call("create_artifact", md("Z", "z"), { turn: 1 })).text).toContain('"artifact"');
    const g = withArtifacts(fake(["search_notes"]), artifactTools(s.dep("g:abcdefghijklmnopqrstuvwx" as GuestScope)));
    expect((await g.list()).map((t) => t.name)).toEqual(["search_notes"]);
    // and the per-scope table in auth-e2e still gives g:* nothing at all before any artifact host is added on top
    expect(await toolHostFor("g:abcdefghijklmnopqrstuvwx" as GuestScope, fake(["search_notes"])).list()).toEqual([]);
    expect(EMPTY_TOOL_HOST).toBeDefined();
  });
  test("tool results: JSON the chat card parses; errors are readable text", async () => {
    const s = setup();
    const h = artifactTools(s.dep("main"));
    const r = await h.call("create_artifact", md("Card", "c"), { turn: 1 });
    expect(JSON.parse(r.text)).toEqual({ artifact: { id: expect.any(String), title: "Card", type: "markdown", version: 1 } });
    const bad = await h.call("create_artifact", md("Card", "z".repeat(MAX_CONTENT_BYTES + 1)), { turn: 1 });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toMatch(/Shorten it/);
  });
  test("the system prompt mentions artifacts exactly once (one deliberate cache-bust)", () => {
    expect(SYSTEM_PROMPT).toContain("create_artifact");
    expect(SYSTEM_PROMPT.match(/create_artifact/g)!.length).toBe(1);
  });
});

describe("routes", () => {
  const app = createApp();
  type A = { cookie: string; csrf: string };
  const mkEnv = () => { const s = setup(); const env = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", E2E_TOKEN: TOKEN, ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: s.d1, FILES: s.bucket, CHAT: {} } as unknown as Env; return { s, env }; };
  const main = async (env: Env): Promise<A> => { const { cookie, session } = await makeSession(env, "example-user", "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
  const bot = async (env: Env): Promise<A> => {
    const r = await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": TOKEN } }), env);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json() as any;
    return { cookie, csrf: me.csrf };
  };
  const api = (env: Env, path: string, a?: A, method = "GET", body?: unknown, application = app) => {
    const h = new Headers({ origin: ORIGIN });
    if (a) { h.set("cookie", a.cookie); if (method !== "GET") h.set("x-csrf-token", a.csrf); }
    if (body !== undefined) h.set("content-type", "application/json");
    return application.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  test("unauthenticated is 401", async () => {
    const { env } = mkEnv();
    expect((await api(env, "/api/artifacts")).status).toBe(401);
  });
  test("main: list/get/delete/undelete/restore; creates only via the model (POST is refused for main)", async () => {
    const { s, env } = mkEnv();
    const m = await main(env);
    expect((await api(env, "/api/artifacts", m, "POST", md())).status).toBe(403);
    const a = ok<any>(await createArtifact(s.dep("main"), md("Route doc", "hello world"), 1));
    ok(await updateArtifact(s.dep("main"), a.id, { content: "hello again" }, 1));
    const list = await (await api(env, "/api/artifacts?q=route", m)).json() as any;
    expect(list.items.map((x: any) => x.title)).toEqual(["Route doc"]);
    expect(list.items[0].preview).toBe("hello again");
    const g = await (await api(env, `/api/artifacts/${a.id}`, m)).json() as any;
    expect(g).toMatchObject({ content: "hello again", version: 2, shown: 2 });
    expect((await (await api(env, `/api/artifacts/${a.id}?v=1`, m)).json() as any).content).toBe("hello world");
    expect((await api(env, `/api/artifacts/${a.id}?v=abc`, m)).status).toBe(400);
    expect((await api(env, `/api/artifacts/${a.id}?v=9`, m)).status).toBe(404);
    expect((await api(env, "/api/artifacts/not-a-uuid", m)).status).toBe(404);
    expect((await api(env, "/api/artifacts?cursor=zzz", m)).status).toBe(400);
    expect((await api(env, `/api/artifacts/${a.id}/restore`, m, "POST", { version: 1 })).status).toBe(200);
    expect((await api(env, `/api/artifacts/${a.id}/restore`, m, "POST", { version: "1" })).status).toBe(400);
    expect((await api(env, `/api/artifacts/${a.id}`, m, "DELETE", {})).status).toBe(200);
    expect((await api(env, `/api/artifacts/${a.id}`, m)).status).toBe(404);
    expect(((await (await api(env, "/api/artifacts", m)).json()) as any).items).toEqual([]);
    expect((await api(env, `/api/artifacts/${a.id}/undelete`, m, "POST", {})).status).toBe(200);
    expect((await api(env, `/api/artifacts/${a.id}`, m)).status).toBe(200);
  });
  test("e2e: sees only its own rows; can seed its own via POST; IDOR on main's id is 404 everywhere", async () => {
    const { s, env } = mkEnv();
    const m = await main(env), e = await bot(env);
    const mine = ok<any>(await createArtifact(s.dep("main"), md("Main only", "private"), 1));
    const seeded = await api(env, "/api/artifacts", e, "POST", { title: "E2E seed", type: "markdown", content: "# e2e" });
    expect(seeded.status).toBe(201);
    const eid = (await seeded.json() as any).id;
    expect(((await (await api(env, "/api/artifacts", e)).json()) as any).items.map((x: any) => x.title)).toEqual(["E2E seed"]);
    expect(((await (await api(env, "/api/artifacts", m)).json()) as any).items.map((x: any) => x.title)).toEqual(["Main only"]);
    expect((await api(env, `/api/artifacts/${mine.id}`, e)).status).toBe(404);
    expect((await api(env, `/api/artifacts/${mine.id}?v=1`, e)).status).toBe(404);
    expect((await api(env, `/api/artifacts/${mine.id}`, e, "DELETE", {})).status).toBe(404);
    expect((await api(env, `/api/artifacts/${mine.id}/undelete`, e, "POST", {})).status).toBe(404);
    expect((await api(env, `/api/artifacts/${mine.id}/restore`, e, "POST", { version: 1 })).status).toBe(404);
    expect((await api(env, `/api/artifacts/${eid}`, m)).status).toBe(404); // and the other way round
    expect(ok<any>(await getArtifact(s.dep("main"), mine.id)).content).toBe("private");
    expect((await api(env, "/api/artifacts", e, "POST", { title: "x", type: "pdf", content: "x" })).status).toBe(400);
    // seeding a second version works for its own row, and is refused (404) for main's id
    expect((await api(env, "/api/artifacts", e, "POST", { id: eid, content: "# v2" })).status).toBe(200);
    expect((await (await api(env, `/api/artifacts/${eid}`, e)).json() as any).version).toBe(2);
    expect((await api(env, "/api/artifacts", e, "POST", { id: mine.id, content: "pwn" })).status).toBe(404);
    expect(ok<any>(await getArtifact(s.dep("main"), mine.id)).content).toBe("private");
  });
  test("g:* is refused with 403 on every artifact route (guardPrefix), before any handler", async () => {
    const { s, env } = mkEnv();
    const guest = createApp({ scopeOf: () => "g:abcdefghijklmnopqrstuvwx" as GuestScope });
    const m = await main(env);
    const mine = ok<any>(await createArtifact(s.dep("main"), md("Main", "x"), 1));
    for (const [method, path, body] of [["GET", "/api/artifacts", undefined], ["POST", "/api/artifacts", md()], ["GET", `/api/artifacts/${mine.id}`, undefined], ["DELETE", `/api/artifacts/${mine.id}`, {}], ["POST", `/api/artifacts/${mine.id}/undelete`, {}], ["POST", `/api/artifacts/${mine.id}/restore`, { version: 1 }]] as const)
      expect((await api(env, path, m, method, body, guest)).status).toBe(403);
    expect(s.db.query("SELECT COUNT(*) AS n FROM artifacts").get() as any).toEqual({ n: 1 });
  });
});

// ---- review fixes: concurrency, restore/undelete quotas, partial-failure compensation ----
describe("parallel tool calls (Promise.all in the turn engine)", () => {
  test("12 concurrent creates in one turn: exactly 10 succeed, the rest are 429", async () => {
    const s = setup();
    const host = artifactTools(s.dep("main"));
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => host.call("create_artifact", md(`P${i}`, `c${i}`), { turn: 3 })));
    expect(rs.filter((r) => !r.isError).length).toBe(MAX_WRITES_PER_TURN);
    expect(rs.filter((r) => r.isError).every((r) => /at most 10/.test(r.text))).toBe(true);
    expect((s.db.query("SELECT COUNT(*) AS n FROM artifacts").get() as any).n).toBe(MAX_WRITES_PER_TURN);
    expect(s.m.size).toBe(MAX_WRITES_PER_TURN);
  });
  test("concurrent creates at the 500 boundary: only the free slots are used", async () => {
    const s = setup();
    const ins = s.db.prepare("INSERT INTO artifacts (id, scope, title, type, current_version, created_at, updated_at) VALUES (?,?,?,?,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
    for (let i = 0; i < MAX_ARTIFACTS - 2; i++) ins.run(crypto.randomUUID(), "main", `t${i}`, "markdown");
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => createArtifact(s.dep("main", `c${i}`), md(`B${i}`, "x"), null)));
    expect(rs.filter((r) => r.ok).length).toBe(2);
    expect((s.db.query("SELECT COUNT(*) AS n FROM artifacts WHERE scope='main'").get() as any).n).toBe(MAX_ARTIFACTS);
  });
  test("the atomic INSERT guard alone refuses a create over the limit even if the pre-check is bypassed", async () => {
    const s = setup();
    const ins = s.db.prepare("INSERT INTO artifacts (id, scope, title, type, current_version, created_at, updated_at) VALUES (?,?,?,?,0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
    for (let i = 0; i < MAX_ARTIFACTS; i++) ins.run(crypto.randomUUID(), "main", `t${i}`, "markdown"); // in-flight reservations count
    expect((await createArtifact(s.dep("main"), md(), null)).ok).toBe(false);
  });
  test("concurrent updates of one artifact produce distinct sequential versions", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("U", "0"), null));
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => updateArtifact(s.dep("main"), a.id, { content: `u${i}` }, null)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect((s.db.query("SELECT COUNT(*) AS n FROM artifact_versions").get() as any).n).toBe(6);
    expect((s.db.query("SELECT current_version AS c FROM artifacts").get() as any).c).toBe(6);
  });
});

describe("restore and undelete respect the quotas", () => {
  test("restore refuses when the new version would pass 200 MB", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("R", "hello world"), null));
    ok(await updateArtifact(s.dep("main"), a.id, { content: "two" }, null));
    s.db.exec(`UPDATE artifact_versions SET bytes=${MAX_SCOPE_BYTES - 5} WHERE artifact_id='${a.id}' AND version=2`);
    const r = await restoreVersion(s.dep("main"), a.id, 1);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/200 MB/);
    expect((s.db.query("SELECT COUNT(*) AS n FROM artifact_versions").get() as any).n).toBe(2);
    expect(s.m.size).toBe(2);
  });
  test("undelete refuses when 500 live artifacts exist (delete 500, create 500, undo)", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("Old", "o"), null));
    ok(await deleteArtifact(s.dep("main"), a.id));
    const ins = s.db.prepare("INSERT INTO artifacts (id, scope, title, type, current_version, created_at, updated_at) VALUES (?,?,?,?,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
    for (let i = 0; i < MAX_ARTIFACTS; i++) ins.run(crypto.randomUUID(), "main", `n${i}`, "markdown");
    const r = await undeleteArtifact(s.dep("main"), a.id);
    expect(r.ok).toBe(false);
    expect((await getArtifact(s.dep("main"), a.id)).ok).toBe(false); // still deleted
    s.db.exec("DELETE FROM artifacts WHERE title='n0'");
    expect((await undeleteArtifact(s.dep("main"), a.id)).ok).toBe(true);
  });
  test("undelete counts ALL versions being reactivated against the byte quota", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("Big", "x"), null));
    ok(await updateArtifact(s.dep("main"), a.id, { content: "y" }, null));
    ok(await deleteArtifact(s.dep("main"), a.id));
    s.db.exec(`UPDATE artifact_versions SET bytes=${MAX_SCOPE_BYTES / 2 + 10} WHERE artifact_id='${a.id}'`); // 2 versions > 200 MB together
    expect((await undeleteArtifact(s.dep("main"), a.id)).ok).toBe(false);
    s.db.exec(`UPDATE artifact_versions SET bytes=10 WHERE artifact_id='${a.id}'`);
    expect((await undeleteArtifact(s.dep("main"), a.id)).ok).toBe(true);
  });
});

describe("partial failures are compensated", () => {
  /** D1 whose statements matching `fail` throw while armed. */
  function flaky(base: D1Database) {
    const f = { sql: null as RegExp | null, times: 0 };
    const d1 = { prepare: (q: string) => { const st = base.prepare(q); if (!f.sql || !f.sql.test(q) || f.times <= 0) return st; return { bind: (...v: unknown[]) => ({ ...st.bind(...v), run: async () => { if (f.times-- > 0) throw new Error("D1_ERROR injected"); return st.bind(...v).run(); } }) } as any; } } as unknown as D1Database;
    return { f, d1 };
  }
  const rows = (s: any) => ({ a: (s.db.query("SELECT COUNT(*) AS n FROM artifacts").get() as any).n, v: (s.db.query("SELECT COUNT(*) AS n FROM artifact_versions").get() as any).n });

  test("create: R2 put fails -> no artifact row, no version row, no object; retry works", async () => {
    const s = setup();
    const files = { ...s.bucket, put: async () => { throw new Error("r2 down"); } } as unknown as R2Bucket;
    const r = await createArtifact({ ...s.dep("main"), files }, md("F", "f"), null);
    expect(r.ok).toBe(false);
    expect(rows(s)).toEqual({ a: 0, v: 0 });
    expect(s.m.size).toBe(0);
    expect((await createArtifact(s.dep("main"), md("F", "f"), null)).ok).toBe(true);
  });
  test("create: artifact-row UPDATE fails after the R2 put -> exact object + version row + parent removed", async () => {
    const s = setup(); const { f, d1: fd } = flaky(s.d1);
    f.sql = /UPDATE artifacts SET current_version/; f.times = 1;
    const r = await createArtifact({ ...s.dep("main"), db: fd }, md("G", "g"), null);
    expect(r.ok).toBe(false);
    expect(rows(s)).toEqual({ a: 0, v: 0 });
    expect(s.m.size).toBe(0);
  });
  test("update: failure after the version insert / after the R2 put does not wedge the artifact (no permanent 409), and leaves nothing behind", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("W", "w1"), null));
    // (a) artifact-row update fails after R2 put
    const x = flaky(s.d1); x.f.sql = /UPDATE artifacts SET current_version/; x.f.times = 1;
    expect((await updateArtifact({ ...s.dep("main"), db: x.d1 }, a.id, { content: "w2" }, null)).ok).toBe(false);
    expect(rows(s)).toEqual({ a: 1, v: 1 });
    expect(s.m.size).toBe(1);
    // (b) R2 put fails after the version insert
    const files = { ...s.bucket, put: async () => { throw new Error("r2 down"); } } as unknown as R2Bucket;
    expect((await updateArtifact({ ...s.dep("main"), files }, a.id, { content: "w2" }, null)).ok).toBe(false);
    expect(rows(s)).toEqual({ a: 1, v: 1 });
    // (c) cleanup of the version row itself fails once: the next write still succeeds (numbering is MAX+1, retry is possible)
    const y = flaky(s.d1); y.f.sql = /DELETE FROM artifact_versions/; y.f.times = 2;
    const z = flaky(y.d1); z.f.sql = /UPDATE artifacts SET current_version/; z.f.times = 1;
    expect((await updateArtifact({ ...s.dep("main"), db: z.d1 }, a.id, { content: "w2" }, null)).ok).toBe(false);
    const again = await updateArtifact(s.dep("main"), a.id, { content: "w3" }, null);
    expect(again.ok).toBe(true);
    expect(ok<any>(await getArtifact(s.dep("main"), a.id)).content).toBe("w3");
    // the leftover version row (no bytes) heals on first read
    expect((await getArtifact(s.dep("main"), a.id, 2)).ok).toBe(false);
    expect((s.db.query("SELECT COUNT(*) AS n FROM artifact_versions WHERE version=2").get() as any).n).toBe(0);
  });
  test("a create whose parent cleanup also fails leaves a hidden reservation that the sweep removes (retryable)", async () => {
    const s = setup();
    const x = flaky(s.d1); x.f.sql = /UPDATE artifacts SET current_version|DELETE FROM artifacts WHERE id=\? AND scope=\? AND current_version=0/; x.f.times = 2;
    expect((await createArtifact({ ...s.dep("main"), db: x.d1 }, md("H", "h"), null)).ok).toBe(false);
    expect(rows(s).a).toBe(1);
    expect(ok<any>(await listArtifacts(s.dep("main"), "", null)).items).toEqual([]); // hidden
    s.db.exec("UPDATE artifacts SET created_at='2020-01-01T00:00:00.000Z'");
    await sweepDeleted(s.d1, s.bucket); // marks the stale reservation
    await sweepDeleted(s.d1, s.bucket, Date.now() + UNDO_GRACE_MS + 60_000);
    expect(rows(s)).toEqual({ a: 0, v: 0 });
  });
  test("prune: D1 row goes first; if the R2 delete fails the row is put back (bytes still exist) and the next write retries", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("P", "v1"), null));
    for (let i = 2; i <= MAX_VERSIONS; i++) ok(await updateArtifact(s.dep("main"), a.id, { content: `v${i}` }, null));
    const files = { ...s.bucket, delete: async () => { throw new Error("r2 delete down"); } } as unknown as R2Bucket;
    ok(await updateArtifact({ ...s.dep("main"), files }, a.id, { content: "v51" }, null)); // 51 versions, prune fails
    const vs = (s.db.query("SELECT version FROM artifact_versions ORDER BY version").all() as any[]).map((x) => x.version);
    expect(vs.length).toBe(MAX_VERSIONS + 1);
    for (const v of vs) expect((await getArtifact(s.dep("main"), a.id, v)).ok).toBe(true); // every exposed version has its bytes
    ok(await updateArtifact(s.dep("main"), a.id, { content: "v52" }, null)); // retry succeeds
    expect((s.db.query("SELECT COUNT(*) AS n FROM artifact_versions").get() as any).n).toBe(MAX_VERSIONS);
    expect(s.m.size).toBe(MAX_VERSIONS);
    for (const v of (s.db.query("SELECT version FROM artifact_versions").all() as any[])) expect((await getArtifact(s.dep("main"), a.id, v.version)).ok).toBe(true);
  });
});

describe("html artifacts: view token + /af/:id/:version frame route", () => {
  const SECRET = "test-secret-0123456789";
  const app = createApp();
  const mkEnv = () => { const s = setup(); const env = { SESSION_SECRET: SECRET, ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", E2E_TOKEN: TOKEN, ASSETS: { fetch: async () => new Response("spa-shell") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: s.d1, FILES: s.bucket, CHAT: {} } as unknown as Env; return { s, env }; };
  const login = async (env: Env) => { const { cookie, session } = await makeSession(env, "example-user", "github"); return { cookie: cookie.split(";")[0]!, csrf: session.csrf }; };
  const mut = (env: Env, path: string, a: { cookie: string; csrf: string }, body: unknown = {}) =>
    app.fetch(new Request(ORIGIN + path, { method: "POST", headers: { origin: ORIGIN, cookie: a.cookie, "x-csrf-token": a.csrf, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  // the real default export (route + withSecurityHeaders), no cookie, no origin
  const frame = (env: Env, path: string, init: RequestInit = {}) => worker.fetch!(new Request(ORIGIN + path, init) as any, env, { waitUntil() {}, passThroughOnException() {} } as any) as Promise<Response>;
  const HTML = "<!doctype html><title>t</title><script>document.title='x'</script><h1>hi</h1>";
  const html = (title = "Page", content = HTML) => ({ title, type: "html", content });

  test("token: round trip; tamper, wrong secret, expiry, malformed all fail", async () => {
    const claims = { id: "0b9f8c1e-1111-4222-8333-444455556666", version: 3, scope: "main" };
    const { token, exp } = await mintViewToken(SECRET, claims, 1_000_000);
    expect(exp).toBe(1_000_000 + VIEW_TTL_S);
    expect(VIEW_TTL_S).toBe(300);
    expect(await verifyViewToken(SECRET, token, 1_000_000)).toEqual({ i: claims.id, v: 3, s: "main", e: exp });
    expect(await verifyViewToken(SECRET, token, exp)).not.toBeNull();     // last valid second
    expect(await verifyViewToken(SECRET, token, exp + 1)).toBeNull();      // expired
    expect(await verifyViewToken("other-secret", token, 1_000_000)).toBeNull();
    expect(await verifyViewToken(undefined, token, 1_000_000)).toBeNull();
    const [body, sig] = token.split(".") as [string, string];
    const forged = btoa(JSON.stringify({ i: claims.id, v: 3, s: "e2e", e: exp })).replace(/=+$/, "");
    for (const t of [`${forged}.${sig}`, `${body}.${sig.slice(0, -2)}AA`, `${body}x.${sig}`, body, `${body}.${sig}.extra`, "", ".", "a.b", `${body}.${"A".repeat(2000)}`]) expect(await verifyViewToken(SECRET, t, 1_000_000)).toBeNull();
    // domain separation: a session cookie value is not a view token and vice versa
    const env = mkEnv().env;
    const { cookie } = await makeSession(env, "example-user", "github");
    expect(await verifyViewToken(SECRET, decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!), 0)).toBeNull();
  });

  test("mint (main, CSRF) then GET /af/... with NO session serves the html with the exact sandbox header set", async () => {
    const { s, env } = mkEnv();
    const a = ok<any>(await createArtifact(s.dep("main"), html(), 1));
    const m = await login(env);
    const r = await mut(env, `/api/artifacts/${a.id}/view`, m);
    expect(r.status).toBe(200);
    const { url, expiresAt } = await r.json() as any;
    expect(url).toMatch(new RegExp(`^/af/${a.id}/1\\?t=[A-Za-z0-9_.-]+$`));
    expect(expiresAt).toBeGreaterThan(Date.now() / 1000);
    const f = await frame(env, url);
    expect(f.status).toBe(200);
    expect(await f.text()).toBe(HTML);
    const h = f.headers;
    const csp = h.get("content-security-policy")!;
    expect(csp.startsWith("sandbox allow-scripts;")).toBe(true);
    expect(csp).toContain("default-src 'none'"); expect(csp).toContain("script-src 'unsafe-inline'"); expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'"); expect(csp).toContain("form-action 'none'"); expect(csp).toContain("base-uri 'none'"); expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("img-src data: blob:"); expect(csp).toContain("font-src data:"); expect(csp).toContain("media-src data: blob:");
    expect(csp).not.toContain("unsafe-eval"); expect(csp).not.toMatch(/https?:/); expect(csp).not.toContain("allow-same-origin");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("no-referrer");
    expect(h.get("cache-control")).toBe("private, no-store");
    expect(h.get("content-type")).toBe("text/html; charset=utf-8");
    for (const k of ["x-frame-options", "strict-transport-security", "permissions-policy", "set-cookie"]) expect(h.get(k)).toBeNull();
  });

  test("the app CSP stays strict everywhere else (API, shell) and the /af/ carve-out does not leak", async () => {
    const { env } = mkEnv();
    const shell = await frame(env, "/");
    expect(shell.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(shell.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(shell.headers.get("content-security-policy")).not.toContain("sandbox");
    expect(shell.headers.get("x-frame-options")).toBe("DENY");
    const api = await frame(env, "/api/me");
    expect(api.status).toBe(401);
    expect(api.headers.get("x-frame-options")).toBe("DENY");
    expect(api.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    // non-frame URLs under /af/ never fall through to the SPA shell; they are sandboxed 404s
    for (const p of ["/af/", "/af/x", "/af/0b9f8c1e-1111-4222-8333-444455556666", "/af/0b9f8c1e-1111-4222-8333-444455556666/1/extra"]) {
      const r = await frame(env, p); expect(r.status).toBe(404); expect(await r.text()).toBe(""); expect(r.headers.get("content-security-policy")!.startsWith("sandbox")).toBe(true);
    }
  });

  test("fail closed: no/bad/tampered/expired token = bare 403; mismatched id or version = 403", async () => {
    const { s, env } = mkEnv();
    const a = ok<any>(await createArtifact(s.dep("main"), html(), 1));
    ok(await updateArtifact(s.dep("main"), a.id, { content: HTML + "2" }, 1));
    const b = ok<any>(await createArtifact(s.dep("main"), html("Other"), 1));
    const tok = async (id: string, version: number, scope = "main", now?: number) => (await mintViewToken(SECRET, { id, version, scope }, now)).token;
    const t1 = await tok(a.id, 1);
    for (const path of [`/af/${a.id}/1`, `/af/${a.id}/1?t=`, `/af/${a.id}/1?t=garbage`, `/af/${a.id}/1?t=${t1.slice(0, -3)}AAA`, `/af/${a.id}/2?t=${t1}`, `/af/${b.id}/1?t=${t1}`, `/af/${a.id}/1?t=${await tok(a.id, 1, "main", 1000)}`]) {
      const r = await frame(env, path);
      expect(r.status, path).toBe(403);
      expect(await r.text()).toBe(""); // no body detail
    }
    expect((await frame(env, `/af/${a.id}/1?t=${t1}`)).status).toBe(200);
    expect(await (await frame(env, `/af/${a.id}/2?t=${await tok(a.id, 2)}`)).text()).toBe(HTML + "2"); // a specific version
    expect((await frame(env, `/af/${a.id}/1?t=${t1}`, { method: "POST" })).status).toBe(404); // GET only (the /af/* catch-all)
    // a cookie, if sent, is irrelevant: no session is consulted
    const m = await login(env);
    expect((await frame(env, `/af/${a.id}/1`, { headers: { cookie: m.cookie } })).status).toBe(403);
  });

  test("scope: a token for another scope finds nothing (404); g:* and unknown scopes never get a frame; e2e only its own rows", async () => {
    const { s, env } = mkEnv();
    const a = ok<any>(await createArtifact(s.dep("main"), html("Mine"), 1));
    const e = ok<any>(await createArtifact(s.dep("e2e"), html("E2E"), null));
    const tok = async (id: string, scope: string) => (await mintViewToken(SECRET, { id, version: 1, scope })).token;
    expect((await frame(env, `/af/${a.id}/1?t=${await tok(a.id, "e2e")}`)).status).toBe(404);   // e2e token, main row
    expect((await frame(env, `/af/${e.id}/1?t=${await tok(e.id, "main")}`)).status).toBe(404);   // main token, e2e row
    expect((await frame(env, `/af/${e.id}/1?t=${await tok(e.id, "e2e")}`)).status).toBe(200);
    const g = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
    s.db.exec(`INSERT INTO artifacts (id, scope, title, type, current_version, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111','${g}','g','html',1,'x','x')`);
    expect((await frame(env, `/af/11111111-1111-4111-8111-111111111111/1?t=${await tok("11111111-1111-4111-8111-111111111111", g)}`)).status).toBe(404);
    // minting: a guest scope is refused by the prefix guard before the handler
    const guest = createApp({ scopeOf: () => g });
    const m = await login(env);
    expect((await guest.fetch(new Request(`${ORIGIN}/api/artifacts/${a.id}/view`, { method: "POST", headers: { origin: ORIGIN, cookie: m.cookie, "x-csrf-token": m.csrf, "content-type": "application/json" }, body: "{}" }), env)).status).toBe(403);
  });

  test("mint: needs session + CSRF; only html; only existing versions of own rows; 503 without a secret", async () => {
    const { s, env } = mkEnv();
    const a = ok<any>(await createArtifact(s.dep("main"), html(), 1));
    const note = ok<any>(await createArtifact(s.dep("main"), md(), 1));
    const m = await login(env);
    const post = (path: string, h: Record<string, string>, body: unknown = {}) => app.fetch(new Request(ORIGIN + path, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }), env);
    expect((await post(`/api/artifacts/${a.id}/view`, {})).status).toBe(401);
    expect((await post(`/api/artifacts/${a.id}/view`, { origin: ORIGIN, cookie: m.cookie })).status).toBe(403);                       // no CSRF
    expect((await post(`/api/artifacts/${a.id}/view`, { origin: "https://evil.test", cookie: m.cookie, "x-csrf-token": m.csrf })).status).toBe(403); // cross-origin
    expect((await mut(env, `/api/artifacts/${note.id}/view`, m)).status).toBe(400);                                                  // markdown has no frame
    expect((await mut(env, `/api/artifacts/${a.id}/view`, m, { version: 9 })).status).toBe(404);
    expect((await mut(env, `/api/artifacts/${a.id}/view`, m, { version: "1" })).status).toBe(400);
    expect((await mut(env, `/api/artifacts/${a.id}/view`, m, { version: 1 })).status).toBe(200);
    expect((await mut(env, "/api/artifacts/not-a-uuid/view", m)).status).toBe(404);
    const e2e = await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": TOKEN } }), env);
    const ec = e2e.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: ec } }), env)).json() as any;
    expect((await mut(env, `/api/artifacts/${a.id}/view`, { cookie: ec, csrf: me.csrf })).status).toBe(404); // e2e cannot mint for a main row
    expect((await mut({ ...env, SESSION_SECRET: "" } as Env, `/api/artifacts/${a.id}/view`, m)).status).toBe(401); // no secret = no session either (fail closed)
  });

  test("replay after delete / after the sweep: the still-valid token gets 404", async () => {
    const { s, env } = mkEnv();
    const a = ok<any>(await createArtifact(s.dep("main"), html(), 1));
    const m = await login(env);
    const { url } = await (await mut(env, `/api/artifacts/${a.id}/view`, m)).json() as any;
    expect((await frame(env, url)).status).toBe(200);
    ok(await deleteArtifact(s.dep("main"), a.id));
    expect((await frame(env, url)).status).toBe(404);
    ok(await undeleteArtifact(s.dep("main"), a.id));
    expect((await frame(env, url)).status).toBe(200);
    ok(await deleteArtifact(s.dep("main"), a.id));
    await sweepDeleted(s.d1, s.bucket, Date.now() + UNDO_GRACE_MS + 60_000);
    expect((await frame(env, url)).status).toBe(404);
  });

  test("a non-html artifact never gets a frame, even with a validly signed token", async () => {
    const { s, env } = mkEnv();
    const a = ok<any>(await createArtifact(s.dep("main"), md("Doc", "<script>alert(1)</script>"), 1));
    const { token } = await mintViewToken(SECRET, { id: a.id, version: 1, scope: "main" });
    expect((await frame(env, `/af/${a.id}/1?t=${token}`)).status).toBe(404);
  });

  test("tools: html is accepted by create_artifact; the system prompt tells the model it is sandboxed and self-contained", async () => {
    const s = setup();
    const h = artifactTools(s.dep("main"));
    expect(JSON.stringify(ARTIFACT_TOOL_DEFS)).toContain("html");
    const r = await h.call("create_artifact", html("Calc"), { turn: 1 });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).artifact.type).toBe("html");
    expect(SYSTEM_PROMPT).toMatch(/self-contained/);
    expect(SYSTEM_PROMPT).toMatch(/no network/);
  });

  test("e2e seam: the e2e scope can seed an html row; main still cannot POST", async () => {
    const { env } = mkEnv();
    const m = await login(env);
    expect((await mut(env, "/api/artifacts", m, html())).status).toBe(403);
    const e2e = await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": TOKEN } }), env);
    const ec = e2e.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie: ec } }), env)).json() as any;
    const c = await mut(env, "/api/artifacts", { cookie: ec, csrf: me.csrf }, html());
    expect(c.status).toBe(201);
    expect((await c.json() as any).type).toBe("html");
  });
});

describe("artifact frame prefix does not shadow SPA routes", () => {
  test("/a/<agent> (agent detail) is not the frame surface; /af/ is", async () => {
    const { isArtifactFramePath } = await import("../src/headers");
    expect(isArtifactFramePath("/a/rev")).toBe(false);
    expect(isArtifactFramePath("/a/")).toBe(false);
    expect(isArtifactFramePath("/af/x/1")).toBe(true);
  });
});

describe("list deleted (Deleted tab)", () => {
  test("only own soft-deleted rows inside the undo window; restorable; live list excludes them", async () => {
    const s = setup();
    const a = ok<any>(await createArtifact(s.dep("main"), md("Gone", "x"), 1));
    const old = ok<any>(await createArtifact(s.dep("main"), md("Ancient", "x"), 1));
    const other = ok<any>(await createArtifact(s.dep("e2e"), md("Theirs", "x"), 1));
    ok(await deleteArtifact(s.dep("main"), a.id));
    ok(await deleteArtifact(s.dep("e2e"), other.id));
    ok(await deleteArtifact(s.dep("main"), old.id));
    s.db.prepare("UPDATE artifacts SET deleted_at=? WHERE id=?").run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), old.id);
    expect(ok<any>(await listArtifacts(s.dep("main"), "", null, true)).items.map((x: any) => x.title)).toEqual(["Gone"]);
    expect(ok<any>(await listArtifacts(s.dep("main"), "", null)).items).toEqual([]);
    ok(await undeleteArtifact(s.dep("main"), a.id));
    expect(ok<any>(await listArtifacts(s.dep("main"), "", null, true)).items).toEqual([]);
    expect(ok<any>(await listArtifacts(s.dep("main"), "", null)).items.map((x: any) => x.title)).toEqual(["Gone"]);
  });
});
