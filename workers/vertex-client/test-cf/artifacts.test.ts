import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { artifactTools, createArtifact, deleteArtifact, getArtifact, listArtifacts, scopeHash, sweepDeleted, updateArtifact, UNDO_GRACE_MS } from "../src/artifacts";
// Real D1 (migration 0016 applied by the pool) + real R2 in workerd: the SQL (LIKE ... ESCAPE, keyset cursor, PK guard) and the object keys are what production runs.
const e = env as any;
const dep = (scope: any, conv: string | null = "conv-1") => ({ db: e.DB as D1Database, files: e.FILES as R2Bucket, scope, conv });
const md = (title: string, content: string) => ({ title, type: "markdown", content });

describe("artifacts on real D1 + R2", () => {
  it("create/update/get/list/search/delete/sweep round trip, keys under the scope-hash prefix", async () => {
    const r = await createArtifact(dep("main"), md("Real 100% doc", "# hi"), 1);
    if (!r.ok) throw new Error(r.error);
    const id = r.v.id;
    const u = await updateArtifact(dep("main"), id, { content: "# hi again" }, 1);
    expect(u.ok && u.v.version).toBe(2);
    const prefix = `vertex-client/artifacts/${await scopeHash("main")}/${id}/`;
    expect((await e.FILES.list({ prefix })).objects.map((o: any) => o.key).sort()).toEqual([`${prefix}v1`, `${prefix}v2`]);
    const g = await getArtifact(dep("main"), id, 1);
    expect(g.ok && g.v.content).toBe("# hi");
    const l = await listArtifacts(dep("main"), "100%", null);
    expect(l.ok && l.v.items.map((x) => x.id)).toEqual([id]);
    const none = await listArtifacts(dep("main"), "%zzz", null);
    expect(none.ok && none.v.items).toEqual([]);
    expect((await getArtifact(dep("e2e"), id)).ok).toBe(false);
    expect((await listArtifacts(dep("e2e"), "", null)).ok && (await listArtifacts(dep("e2e"), "", null) as any).v.items).toEqual([]);
    expect((await deleteArtifact(dep("main"), id)).ok).toBe(true);
    expect((await getArtifact(dep("main"), id)).ok).toBe(false);
    expect(await sweepDeleted(e.DB, e.FILES, Date.now() + UNDO_GRACE_MS + 60_000)).toBeGreaterThanOrEqual(1);
    expect((await e.FILES.list({ prefix })).objects).toEqual([]);
  });
  it("a version row taken by someone else is skipped (numbering is MAX+1); the tool host works end to end and is main-only", async () => {
    const h = artifactTools(dep("main", "conv-2"));
    const c = await h.call("create_artifact", { title: "T", type: "code", language: "python", content: "print(1)" }, { turn: 1 });
    expect(c.isError).toBe(false);
    const id = JSON.parse(c.text).artifact.id;
    await e.DB.prepare(`INSERT INTO artifact_versions (artifact_id, version, r2_key, bytes, created_at) VALUES (?,2,'x',1,'t')`).bind(id).run(); // someone else took v2
    const r = await updateArtifact(dep("main", "conv-2"), id, { content: "print(2)" }, 1);
    expect(r.ok && r.v.version).toBe(3);
    expect((await e.DB.prepare(`SELECT r2_key FROM artifact_versions WHERE artifact_id=? AND version=2`).bind(id).first() as any).r2_key).toBe("x"); // not overwritten
    expect((await artifactTools(dep("g:abcdefghijklmnopqrstuvwx")).list())).toEqual([]);
  });

  it("migration 0017: html is an accepted type on real D1; its bytes round-trip through R2; the CHECK still rejects unknown types", async () => {
    const r = await createArtifact(dep("main"), { title: "Page", type: "html", content: "<h1>x</h1><script>1</script>" }, 1);
    if (!r.ok) throw new Error(r.error);
    expect(r.v.type).toBe("html");
    const g = await getArtifact(dep("main"), r.v.id);
    expect(g.ok && g.v.content).toBe("<h1>x</h1><script>1</script>");
    await expect(e.DB.prepare("INSERT INTO artifacts (id, scope, title, type, created_at, updated_at) VALUES ('x','main','t','pdf','a','a')").run()).rejects.toThrow();
    await deleteArtifact(dep("main"), r.v.id);
  });
});
