import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { ADVISOR_MODEL, SEED, validatePersona, type Persona } from "../src/personas";
import { SYSTEM_PROMPT_AUTO_DELEGATE } from "../src/system-prompt";
import { DELEGATE_TOOL, delegateToolDef, subagentHost, type SubagentDeps } from "../src/subagent";
import { DROPPED_MARK, RESULT_MAX, TRANSCRIPT_MAX, buildTranscript } from "../src/transcript";
import { ADVISOR_DEFAULT_QUESTION, BUILTINS, advisorAlias, rankSlash, slashItems } from "../src/slash";
import { RESERVED, createSkill, deleteSkill, listSkills, slashSkills, updateSkill, validateSkill } from "../src/skills";
import { atPersona, buildRequest, personaHint } from "../src/turn-engine";
import type { ModelProvider, ProviderModel } from "../src/providers/types";

const MIGS = new URL("../migrations/", import.meta.url);
const migrate = (db: Database, upTo?: string) => { for (const f of readdirSync(MIGS).sort()) { if (upTo && f > upTo) break; db.exec(readFileSync(new URL(f, MIGS), "utf8")); } };
const seedOf = (n: string) => SEED.find((s) => s.name === n)!;
const OLD_RESEARCHER = seedOf("researcher").prompt;

describe("transcript builder", () => {
  const u = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
  const a = (...content: any[]) => ({ role: "assistant", content });
  test("text only: user/assistant text, tool calls as a mark, images/thinking dropped, results truncated", () => {
    const t = buildTranscript([
      u("hello"), a({ type: "thinking", thinking: "secret" }, { type: "text", text: "hi" }, { type: "tool_use", id: "1", name: "search_notes", input: {} }),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "x".repeat(2000) }, { type: "image", source: {} }] },
    ]);
    expect(t).toContain("User: hello"); expect(t).toContain("Assistant: hi"); expect(t).toContain("Assistant called tool search_notes");
    expect(t).not.toContain("secret"); expect(t).not.toContain("image");
    const r = t.split("\n").find((l) => l.startsWith("Tool result:"))!;
    expect(r.length).toBeLessThan(RESULT_MAX + 30); expect(r).toContain("[cut]");
  });
  test("the delegate call itself is skipped; array tool_result content reads its text blocks", () => {
    const t = buildTranscript([a({ type: "tool_use", id: "1", name: DELEGATE_TOOL, input: {} }), { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "ok" }] }] }], new Set([DELEGATE_TOOL]));
    expect(t).not.toContain("called tool"); expect(t).toContain("Tool result: ok");
  });
  test("under the cap: everything, no marker; empty = empty string", () => {
    expect(buildTranscript([u("a"), a({ type: "text", text: "b" })])).toBe("User: a\n\nAssistant: b");
    expect(buildTranscript([])).toBe("");
  });
  test("over the cap: the most recent kept, oldest dropped, marker leads, total <= cap", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => u(`m${i} ` + "y".repeat(2000)));
    const t = buildTranscript(msgs, new Set(), 10_000);
    expect(t.length).toBeLessThanOrEqual(10_000); expect(t.startsWith(DROPPED_MARK)).toBe(true);
    expect(t).toContain("m49 "); expect(t).not.toContain("m0 ");
    expect(buildTranscript(msgs).length).toBeLessThanOrEqual(TRANSCRIPT_MAX);
  });
  test("a single message larger than the cap is cut from its start, still within the cap", () => {
    const t = buildTranscript([u("z".repeat(5000))], new Set(), 1000);
    expect(t.length).toBeLessThanOrEqual(1000); expect(t.startsWith(DROPPED_MARK)).toBe(true);
  });
});

describe("auto_use exclusion from the tool guidance", () => {
  test("explicit-only personas are not listed; the rest are; the 'do not call unprompted' sentence is present", () => {
    const d = delegateToolDef([{ name: "reviewer", description: "r", autoUse: true }, { name: "advisor", description: "second opinion", autoUse: false }, { name: "old", description: "pinned before the field existed" }]);
    expect(d.description).toContain("- reviewer"); expect(d.description).toContain("- old");
    expect(d.description).not.toContain("advisor"); expect(d.description).not.toContain("second opinion");
    expect(d.description).toContain("never call a persona that is not in the list unless the user explicitly asked");
  });
});

const persona = (o: Partial<Persona> = {}): Persona => ({ id: "p", name: "advisor", description: "d", prompt: "You advise.", model: ADVISOR_MODEL, tools: [], maxTokens: 2048, effort: "high", contextMode: "conversation", autoUse: false, createdAt: "", updatedAt: "", ...o });
function setup(models: string[], p: Persona, history: any[]) {
  const calls: any[] = [];
  const ms: ProviderModel[] = models.map((id) => ({ id, displayName: id }));
  const provider: ModelProvider = { name: "t", listModels: async () => ms, messages: async (b: any) => { calls.push(b); return Response.json({ content: [{ type: "text", text: "advice" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }); } };
  const deps: SubagentDeps = { provider, personas: async () => [p], models: async () => ms, tools: async () => ({ list: async () => [], call: async () => ({ text: "", isError: false }) }), index: { recordUsage: async () => {} } as any, conv: () => "c", transcript: () => history };
  return { host: subagentHost(deps), calls };
}
describe("advisor run", () => {
  const hist = [{ role: "user", content: [{ type: "text", text: "@advisor plan: deploy on friday" }] }, { role: "assistant", content: [{ type: "text", text: "ok doing it" }] }];
  test("conversation mode: transcript + question, adaptive thinking + effort, no budget_tokens, no tools", async () => {
    const t = setup(["claude-opus-5-5"], persona(), hist);
    const r = await t.host.call(DELEGATE_TOOL, { persona: "advisor", task: "is this wise?" }, { turn: 1 });
    expect(r.isError).toBe(false);
    const b = t.calls[0];
    expect(b.model).toBe("claude-opus-5-5"); expect(b.max_tokens).toBe(2048); expect(b.tools).toBeUndefined();
    expect(b.thinking).toEqual({ type: "adaptive" }); expect(b.output_config).toEqual({ effort: "high" }); expect(JSON.stringify(b)).not.toContain("budget_tokens");
    expect(b.messages[0].content).toContain("[Conversation so far]\nUser: @advisor plan: deploy on friday\n\nAssistant: ok doing it");
    expect(b.messages[0].content).toContain("[Question]\nis this wise?");
    expect(b.system[0].text).toContain("transcript of the conversation");
  });
  test("task mode never sees the conversation", async () => {
    const t = setup(["claude-opus-5-5"], persona({ contextMode: "task", autoUse: true }), hist);
    await t.host.call(DELEGATE_TOOL, { persona: "advisor", task: "q" }, { turn: 1 });
    expect(t.calls[0].messages[0].content).toBe("q");
  });
  test("a model list without Opus: clear error result, no model call, no throw", async () => {
    const t = setup(["claude-sonnet-5-5"], persona(), hist);
    const r = await t.host.call(DELEGATE_TOOL, { persona: "advisor", task: "q" }, { turn: 1 });
    expect(r.isError).toBe(true); expect(r.text).toContain("advisor model not available in this account"); expect(t.calls.length).toBe(0);
  });
  test("explicit-only persona still resolves at call time (@advisor works although unlisted)", async () => {
    const t = setup(["claude-opus-5-5"], persona(), hist);
    const l = await t.host.list(); expect(l[0].description).not.toContain("advisor");
    expect((await t.host.call(DELEGATE_TOOL, { persona: "advisor", task: "q" }, { turn: 1 })).isError).toBe(false);
  });
});

describe("/advisor slash alias", () => {
  test("rewrites to the @advisor text; bare = review the conversation; other text untouched", () => {
    expect(advisorAlias("/advisor is this ok?")).toBe("@advisor is this ok?");
    expect(advisorAlias("/advisor")).toBe(`@advisor ${ADVISOR_DEFAULT_QUESTION}`);
    expect(advisorAlias("  /advisor  \n multi\nline ")).toBe("@advisor multi\nline");
    expect(advisorAlias("/advisorx hi")).toBe("/advisorx hi"); expect(advisorAlias("hello /advisor")).toBe("hello /advisor");
    expect(atPersona(advisorAlias("/advisor q"))).toBe("advisor");                 // same path as a typed @advisor
    expect(personaHint("advisor")).toContain('persona "advisor"');
  });
  test("listed in the slash menu with a description; reserved so a skill cannot shadow it", () => {
    const it = slashItems([]).find((x) => x.name === "advisor")!;
    expect(it.kind).toBe("builtin"); expect(it.description.length).toBeGreaterThan(5); expect(it.disabled).toBeUndefined();
    expect(rankSlash(BUILTINS, "adv")[0].name).toBe("advisor");
    expect(RESERVED.has("advisor")).toBe(true);
    expect(validateSkill({ name: "advisor", description: "x", template: "t" } as any, false)).toMatchObject({ ok: false });
  });
});

describe("validation + seeds", () => {
  test("contextMode / autoUse validated; accepted values pass", () => {
    expect(validatePersona({ contextMode: "x" }, true)).toMatchObject({ ok: false });
    expect(validatePersona({ autoUse: "no" }, true)).toMatchObject({ ok: false });
    expect(validatePersona({ contextMode: "conversation", autoUse: false }, true)).toEqual({ ok: true, v: { contextMode: "conversation", autoUse: false } });
  });
  test("seed values", () => {
    expect(seedOf("researcher").model).toBe("claude-sonnet-5-5");
    expect(seedOf("advisor")).toMatchObject({ model: "claude-opus-5-5", effort: "high", tools: [], maxTokens: 2048, contextMode: "conversation", autoUse: false });
    expect(seedOf("reviewer").model).toBe("claude-haiku-5-5");
  });
});

describe("migration 0025 seed upgrade", () => {
  // The OLD seed rows exactly as 0024-era code wrote them (haiku researcher/reviewer/summarizer, every field).
  const old = (name: string) => { const x = seedOf(name); return { description: x.description, prompt: x.prompt, tools: x.tools.length ? JSON.stringify(x.tools) : null, effort: x.effort, model: "claude-haiku-5-5", max: 4096 }; };
  const ins = (db: Database, scope: string, name: string, o: Partial<ReturnType<typeof old>> & { desc?: string } = {}) => { const b = { ...old(name), ...o };
    db.query(`INSERT INTO personas (id, scope, name, description, prompt, model, tools_json, max_tokens, effort) VALUES (?,?,?,?,?,?,?,?,?)`).run(`${scope}-${name}`, scope, name, b.description, b.prompt, b.model, b.tools, b.max, b.effort); };
  const fullSet = (db: Database, scope: string) => { for (const n of ["researcher", "reviewer", "summarizer"]) ins(db, scope, n); };
  const row = (db: Database, scope: string, name: string) => db.query(`SELECT * FROM personas WHERE scope=? AND name=?`).get(scope, name) as any;
  const run25 = (db: Database) => db.exec(readFileSync(new URL("0025_persona_advisor.sql", MIGS), "utf8"));
  const upto24 = () => { const db = new Database(":memory:"); migrate(db, "0024_personas.sql"); return db; };
  test("fresh DB: all migrations apply; the new columns default to task / 1", () => {
    const db = new Database(":memory:"); migrate(db);
    db.query(`INSERT INTO personas (id, scope, name, prompt, model) VALUES ('1','main','x','p','m')`).run();
    expect(row(db, "main", "x")).toMatchObject({ context_mode: "task", auto_use: 1 });
    expect((db.query(`SELECT COUNT(*) AS n FROM personas`).get() as any).n).toBe(1);
  });
  test("untouched old seed: researcher -> sonnet, advisor added with the seed values", () => {
    const db = upto24(); fullSet(db, "main"); run25(db);
    expect(row(db, "main", "researcher")).toMatchObject({ model: "claude-sonnet-5-5", prompt: OLD_RESEARCHER });
    expect(row(db, "main", "reviewer").model).toBe("claude-haiku-5-5");
    expect(row(db, "main", "advisor")).toMatchObject({ model: "claude-opus-5-5", effort: "high", tools_json: null, max_tokens: 2048, context_mode: "conversation", auto_use: 0, prompt: seedOf("advisor").prompt, description: seedOf("advisor").description });
  });
  test("researcher is moved only if EVERY seed field is unchanged (each single edit protects it)", () => {
    const edits: Array<[string, Partial<ReturnType<typeof old>>]> = [["description", { description: "mine" }], ["tools", { tools: '["read_url"]' }], ["effort", { effort: "low" }], ["max_tokens", { max: 2000 }], ["prompt", { prompt: "mine" }], ["model", { model: "claude-opus-5-5" }]];
    for (const [what, o] of edits) {
      const db = upto24(); ins(db, "g:x", "researcher", o); ins(db, "g:x", "reviewer"); ins(db, "g:x", "summarizer"); run25(db);
      const r = row(db, "g:x", "researcher");
      expect(r.model, what).toBe(o.model ?? "claude-haiku-5-5");
      expect(row(db, "g:x", "advisor"), `${what}: edited set gets no advisor`).toBeNull();
    }
  });
  test("a user-edited reviewer or summarizer, a deleted one, or an unrelated scope: no advisor", () => {
    const db = upto24();
    fullSet(db, "g:ed"); db.query(`UPDATE personas SET description='mine' WHERE scope='g:ed' AND name='reviewer'`).run();
    fullSet(db, "g:ed2"); db.query(`UPDATE personas SET max_tokens=999 WHERE scope='g:ed2' AND name='summarizer'`).run();
    fullSet(db, "g:del"); db.query(`DELETE FROM personas WHERE scope='g:del' AND name='summarizer'`).run();
    ins(db, "g:own", "researcher", { prompt: "all mine" }); ins(db, "g:own", "reviewer", { prompt: "mine" }); ins(db, "g:own", "summarizer", { prompt: "mine" });
    db.query(`INSERT INTO personas (id, scope, name, prompt, model) VALUES ('n','g:e','notes','p','m')`).run();
    fullSet(db, "g:ok");
    run25(db);
    for (const sc of ["g:ed", "g:ed2", "g:del", "g:own", "g:e"]) expect(row(db, sc, "advisor"), sc).toBeNull();
    expect(row(db, "g:ok", "advisor")).toBeTruthy();
    expect(row(db, "g:ed", "researcher").model).toBe("claude-sonnet-5-5");   // its own researcher is still the untouched seed, so it moves (per-row rule)
  });
  test("a user's own advisor is never overwritten", () => {
    const db = upto24(); fullSet(db, "g:a"); db.query(`INSERT INTO personas (id, scope, name, prompt, model) VALUES ('mine','g:a','advisor','my own advisor','claude-haiku-5-5')`).run(); run25(db);
    expect(row(db, "g:a", "advisor")).toMatchObject({ id: "mine", prompt: "my own advisor", model: "claude-haiku-5-5", context_mode: "task", auto_use: 1 });
  });
  test("the migration SQL carries the exact app seed texts", () => {
    const sql = readFileSync(new URL("0025_persona_advisor.sql", MIGS), "utf8");
    for (const n of ["researcher", "reviewer", "summarizer"]) { expect(sql).toContain(`prompt = '${seedOf(n).prompt.replace(/'/g, "''")}'`); expect(sql).toContain(`description = '${seedOf(n).description.replace(/'/g, "''")}'`); }
    expect(sql).toContain(`'${seedOf("advisor").prompt.replace(/'/g, "''")}'`);
  });
});

describe("auto_use=0 enforced at call time (server-side)", () => {
  const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
  const toolRes = { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] };
  const asst = { role: "assistant", content: [{ type: "tool_use", id: "x", name: DELEGATE_TOOL, input: {} }] };
  const call = (t: ReturnType<typeof setup>) => t.host.call(DELEGATE_TOOL, { persona: "advisor", task: "q" }, { turn: 1 });
  test("hallucinated advisor on an ordinary turn: refused, zero provider calls", async () => {
    const t = setup(["claude-opus-5-5"], persona(), [user("what time is it?")]);
    const r = await call(t);
    expect(r.isError).toBe(true); expect(r.text).toContain("runs only when the user asks for it (use /advisor)"); expect(t.calls.length).toBe(0);
  });
  test("explicit @advisor in the current turn: runs (also after tool-result rounds and on a retry)", async () => {
    const t = setup(["claude-opus-5-5"], persona(), [user("@advisor is this ok?"), asst, toolRes]);
    expect((await call(t)).isError).toBe(false); expect((await call(t)).isError).toBe(false); expect(t.calls.length).toBe(2);
  });
  test("an @advisor from an EARLIER turn does not authorise a later turn", async () => {
    const t = setup(["claude-opus-5-5"], persona(), [user("@advisor ok?"), asst, toolRes, { role: "assistant", content: [{ type: "text", text: "advice" }] }, user("now do something else")]);
    expect((await call(t)).isError).toBe(true); expect(t.calls.length).toBe(0);
  });
  test("@other or @advisor not at the start: refused; no transcript source: refused (fail closed)", async () => {
    for (const h of [[user("@researcher look")], [user("please ask @advisor")]]) { const t = setup(["claude-opus-5-5"], persona(), h); expect((await call(t)).isError).toBe(true); expect(t.calls.length).toBe(0); }
    const ms: ProviderModel[] = [{ id: "claude-opus-5-5", displayName: "O" }]; let n = 0;
    const host = subagentHost({ provider: { name: "t", listModels: async () => ms, messages: async () => { n++; return Response.json({}); } }, personas: async () => [persona()], models: async () => ms, tools: async () => ({ list: async () => [], call: async () => ({ text: "", isError: false }) }), index: { recordUsage: async () => {} } as any, conv: () => "c" });
    expect((await host.call(DELEGATE_TOOL, { persona: "advisor", task: "q" }, { turn: 1 })).isError).toBe(true); expect(n).toBe(0);
  });
  test("decided from the DB row, not the pinned definition: a stale pin that says autoUse:true cannot authorise it; a persona turned auto_use=1 runs anywhere", async () => {
    const t = setup(["claude-opus-5-5"], persona(), [user("hi")]);
    const meta = new Map<string, string>([["p", JSON.stringify([{ name: "advisor", description: "d", autoUse: true }])]]);
    const calls: any[] = [];
    const ms: ProviderModel[] = [{ id: "claude-opus-5-5", displayName: "O" }];
    const host = subagentHost({ provider: { name: "t", listModels: async () => ms, messages: async (b: any) => { calls.push(b); return Response.json({ content: [{ type: "text", text: "a" }], stop_reason: "end_turn", usage: {} }); } }, personas: async () => [persona()], models: async () => ms, tools: async () => ({ list: async () => [], call: async () => ({ text: "", isError: false }) }), index: { recordUsage: async () => {} } as any, conv: () => "c", transcript: () => [user("hi")], pin: { get: () => meta.get("p") ?? null, set: (v) => { meta.set("p", v); } } });
    expect((await host.list())[0].description).toContain("- advisor");               // the stale pin still lists it...
    expect((await host.call(DELEGATE_TOOL, { persona: "advisor", task: "q" }, { turn: 1 })).isError).toBe(true); expect(calls.length).toBe(0); // ...but the call is refused
    const open = setup(["claude-opus-5-5"], persona({ autoUse: true }), [user("hi")]);
    expect((await call(open)).isError).toBe(false);
  });
  test("auto_delegate ON (the guidance paragraph) changes nothing: still refused on an ordinary turn", async () => {
    const t = setup(["claude-opus-5-5"], persona(), [user("research A and B in parallel")]);
    const req = buildRequest("claude-sonnet-5-5", [], [delegateToolDef([{ name: "reviewer", description: "r" }])], null, null, true);
    expect(req.system[0].text).toBe(SYSTEM_PROMPT_AUTO_DELEGATE);
    const rs = await Promise.all([call(t), call(t)]);                               // a fan-out of hallucinated calls
    expect(rs.every((r) => r.isError)).toBe(true); expect(t.calls.length).toBe(0);
  });
});

describe("an existing user skill named advisor", () => {
  test("stays editable and deletable; creating one is still refused; the builtin wins in the menu", async () => {
    const { Database: D } = await import("bun:sqlite");
    const db = new D(":memory:"); migrate(db);
    db.query(`INSERT INTO skills (id, name, description, template, scope) VALUES ('s1','advisor','old','tpl {{input}}','main')`).run();
    const stmt = (q: string, b: unknown[] = []): any => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null, all: async () => ({ results: db.query(q).all(...(b as any)) as any[] }), run: async () => { db.query(q).run(...(b as any)); return {}; } });
    const D1 = { prepare: (q: string) => stmt(q) } as unknown as D1Database;
    expect((await createSkill(D1, "main", { name: "advisor", template: "x" })).status).toBe(400);        // new one: refused
    const u = await updateSkill(D1, "main", "s1", { name: "advisor", description: "edited", template: "new {{input}}" });  // UI sends the name back
    expect(u.status).toBe(200); expect(db.query(`SELECT description, template FROM skills WHERE id='s1'`).get()).toEqual({ description: "edited", template: "new {{input}}" });
    expect((await updateSkill(D1, "main", "s1", { name: "model" })).status).toBe(400);                  // renaming TO another reserved name: still refused
    expect((await updateSkill(D1, "main", "s1", { name: "renamed" })).status).toBe(200);
    expect((await updateSkill(D1, "main", "s1", { name: "advisor" })).status).toBe(400);                // ...and back to a reserved name once renamed away: refused
    db.query(`UPDATE skills SET name='advisor' WHERE id='s1'`).run();
    expect((await listSkills(D1, "main")).some((s) => s.name === "advisor")).toBe(true);                // still listed in Skills
    const menu = slashItems([], null, await slashSkills(D1, "main"));
    expect(menu.filter((x) => x.name === "advisor").map((x) => x.kind)).toEqual(["builtin"]);           // builtin wins in the slash menu
    expect((await deleteSkill(D1, "main", "s1")).status).toBe(200);
  });
});
