import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createPersona, deletePersona, getPersona, listPersonas, seedPersonasIfEmpty, updatePersona } from "../src/personas";
import { d1Index } from "../src/index-d1";
// Real D1 with every migration (0024 included) applied by the pool on a fresh DB.
const e = env as any;
const db = e.DB as D1Database;

describe("personas on real D1 (fresh DB, all migrations)", () => {
  it("seeds once for main, scope-bound CRUD, uniqueness per scope, delete does not re-seed", async () => {
    expect((await listPersonas(db, "main")).map((p) => p.name)).toEqual(["advisor", "researcher", "reviewer", "summarizer"]);
    await seedPersonasIfEmpty(db); await seedPersonasIfEmpty(db);
    expect((await listPersonas(db, "main")).length).toBe(4);
    expect(await listPersonas(db, "e2e")).toEqual([]);
    const c = await createPersona(db, "e2e", { name: "researcher", prompt: "mine", tools: ["read_url"], effort: "low", maxTokens: 1000 });
    expect(c.status).toBe(201);                                                       // same name as main's seed, own scope
    expect((await getPersona(db, "e2e", "researcher"))).toMatchObject({ prompt: "mine", tools: ["read_url"], effort: "low", maxTokens: 1000, model: "claude-haiku-5-5" });
    expect((await createPersona(db, "e2e", { name: "researcher", prompt: "dup" })).status).toBe(409);
    const id = (await getPersona(db, "e2e", "researcher"))!.id;
    expect((await updatePersona(db, "main", id, { prompt: "x" })).status).toBe(404);   // another scope's id
    expect((await updatePersona(db, "e2e", id, { effort: null, tools: [] })).status).toBe(200);
    expect(await getPersona(db, "e2e", "researcher")).toMatchObject({ effort: null, tools: [] });
    expect((await deletePersona(db, "main", id)).status).toBe(404);
    expect((await deletePersona(db, "e2e", id)).status).toBe(200);
    for (const p of await listPersonas(db, "main")) await deletePersona(db, "main", p.id);
    expect(await listPersonas(db, "main")).toEqual([]);                               // flag set: never re-seeded
  });
  it("seeded advisor / researcher values and new fields round-trip on real D1", async () => {
    expect(await getPersona(db, "main", "advisor")).toMatchObject({ model: "claude-opus-5-5", effort: "high", tools: [], maxTokens: 2048, contextMode: "conversation", autoUse: false });
    expect((await getPersona(db, "main", "researcher"))!.model).toBe("claude-sonnet-5-5");
    const c = await createPersona(db, "e2e", { name: "second", prompt: "p", contextMode: "conversation", autoUse: false });
    expect(c.status).toBe(201);
    const id = (await getPersona(db, "e2e", "second"))!.id;
    expect(await getPersona(db, "e2e", "second")).toMatchObject({ contextMode: "conversation", autoUse: false });
    expect((await updatePersona(db, "e2e", id, { autoUse: true })).status).toBe(200);
    expect(await getPersona(db, "e2e", "second")).toMatchObject({ contextMode: "conversation", autoUse: true });
    expect((await createPersona(db, "e2e", { name: "bad", prompt: "p", contextMode: "x" })).status).toBe(400);
  });
  it("a team scope (g:<uid>) is seeded lazily, once, with its own rows; e2e stays empty", async () => {
    const g1 = await listPersonas(db, "g:u1"), g2 = await listPersonas(db, "g:u2");
    expect(g1.map((p) => p.name)).toEqual(["advisor", "researcher", "reviewer", "summarizer"]);
    expect(g1.find((p) => p.name === "researcher")!.model).toBe("claude-sonnet-5-5");
    expect(g1.find((p) => p.name === "advisor")).toMatchObject({ model: "claude-opus-5-5", contextMode: "conversation", autoUse: false });
    expect(g1.map((p) => p.id).some((id) => g2.some((q) => q.id === id))).toBe(false);          // separate rows per scope
    await seedPersonasIfEmpty(db, "g:u1");                                                         // idempotent
    expect((await listPersonas(db, "g:u1")).length).toBe(4);
    for (const p of g1) await deletePersona(db, "g:u1", p.id);
    expect(await listPersonas(db, "g:u1")).toEqual([]);                                            // deleted by the user: never re-seeded
    expect((await listPersonas(db, "g:u2")).length).toBe(4);                                       // another team user untouched
  });
  it("usage rows carry persona + parent_turn on real D1", async () => {
    await db.prepare(`INSERT INTO conversations (id, model, scope) VALUES ('cv-sub','claude-haiku-5-5','main')`).run();
    await d1Index(db).recordUsage({ conversationId: "cv-sub", model: "claude-haiku-5-5", usage: { input_tokens: 3, output_tokens: 2 }, costUsd: 0.001, sub: { persona: "reviewer", turn: 2 } });
    const r = await db.prepare(`SELECT persona, parent_turn, scope FROM usage WHERE conversation_id='cv-sub'`).first<any>();
    expect(r).toEqual({ persona: "reviewer", parent_turn: 2, scope: "main" });
  });
});
