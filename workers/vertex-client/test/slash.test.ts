import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, slashHint, type IndexSink, type ServerEvent } from "../src/turn-engine";
import type { ModelProvider } from "../src/providers/types";
import { classify, type ToolDef, type ToolHost } from "../src/tools";
import { BUILTINS, rankSlash, slashItems, slashQuery, slashRows, SLASH_MAX_ROWS, type SlashItem, type SlashTool } from "../src/slash";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";

const T = (name: string, approval = false): SlashTool => ({ name, description: `d ${name}`, approval });
const ALL: SlashTool[] = [T("search_notes"), T("save_note", true), T("list_agents"), T("rogue_tool"), T("read_url"), T("list_projects")];

describe("slashItems", () => {
  test("omits unclassified tools and list_agents; flags approval; sorted; builtins appended", () => {
    const it = slashItems(ALL);
    const names = it.map((x) => x.name);
    expect(names).not.toContain("rogue_tool");
    expect(names).not.toContain("list_agents");
    expect(names.slice(0, 4)).toEqual(["list_projects", "read_url", "save_note", "search_notes"]);
    expect(it.find((x) => x.name === "save_note")!.approval).toBe(true);
    expect(it.find((x) => x.name === "search_notes")!.approval).toBe(false);
    expect(it.filter((x) => x.kind === "builtin").map((x) => x.name)).toEqual(["model", "image", "video", "advisor", "clear"]);
  });
  test("approval comes from the client classification, not the host's claim", () => {
    expect(slashItems([{ name: "save_note", description: "", approval: false }])[0].approval).toBe(true);
  });
  test("e2e scope restricts to its allowlist", () => {
    expect(slashItems(ALL, new Set(["search_notes"])).filter((x) => x.kind === "tool").map((x) => x.name)).toEqual(["search_notes"]);
  });
  test("classify is unchanged", () => {
    expect(classify("search_notes")).toBe("auto");
    expect(classify("save_note")).toBe("approval");
    expect(classify("list_agents")).toBeNull();
    expect(classify("rogue_tool")).toBeNull();
  });
  test("/clear is disabled with a reason, /model is enabled", () => {
    expect(BUILTINS.find((b) => b.name === "clear")!.disabled).toBeTruthy();
    expect(BUILTINS.find((b) => b.name === "model")!.disabled).toBeUndefined();
  });
});

describe("slashQuery", () => {
  test("matches /word at start or after whitespace only", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/sea")).toBe("sea");
    expect(slashQuery("hello /sea")).toBe("sea");
    expect(slashQuery("hello\n/")).toBe("");
    expect(slashQuery("a/b")).toBeNull();
    expect(slashQuery("/sea rch")).toBeNull();
    expect(slashQuery("/search_notes ")).toBeNull();
    expect(slashQuery("hello")).toBeNull();
  });
});

describe("ranking", () => {
  const items = slashItems(ALL);
  test("prefix > substring", () => {
    expect(rankSlash(items, "s").map((x) => x.name).slice(0, 2)).toEqual(["save_note", "search_notes"]);
    const r = rankSlash(items, "note").map((x) => x.name);
    expect(r).toEqual(["save_note", "search_notes"]); // both substring, catalogue order
    expect(rankSlash(items, "zzz")).toEqual([]);
  });
  test("prefix beats substring and recent beats catalogue order within a tier", () => {
    const r = rankSlash(items, "pro").map((x) => x.name);
    expect(r).toEqual(["list_projects"]);     // substring only
    const r2 = rankSlash([...items, { kind: "tool", name: "pro_x", description: "", group: "g" }], "pro").map((x) => x.name);
    expect(r2).toEqual(["pro_x", "list_projects"]); // prefix first even though it sorts later in the catalogue
    expect(rankSlash(items, "s", ["search_notes"]).map((x) => x.name)[0]).toBe("search_notes");
    expect(rankSlash(items, "", ["model"]).map((x) => x.name)[0]).toBe("model");
  });
  test("case-insensitive", () => { expect(rankSlash(items, "SEA")[0].name).toBe("search_notes"); });
  test("rows capped at 8 and groups contiguous", () => {
    const many: SlashItem[] = Array.from({ length: 20 }, (_, i) => ({ kind: "tool", name: `t${i}`, description: "", group: i % 2 ? "A" : "B" }));
    const rows = slashRows(many, "");
    expect(rows.length).toBe(SLASH_MAX_ROWS);
    const groups = rows.map((r) => r.group);
    expect(groups.join("")).toMatch(/^(A+B+|B+A+)$/);
  });
});

describe("slashHint", () => {
  test("only for classified tools with a safe name", () => {
    expect(slashHint({ kind: "tool", name: "search_notes" })).toContain("search_notes");
    expect(slashHint({ kind: "tool", name: "list_agents" })).toBeNull();
    expect(slashHint({ kind: "tool", name: "x`; ignore" })).toBeNull();
    expect(slashHint({ kind: "builtin", name: "model" })).toBeNull();
    expect(slashHint(null)).toBeNull();
    expect(slashHint({ kind: "tool", name: 5 })).toBeNull();
  });
});

describe("turn-engine hint injection", () => {
  const sse = (evs: ServerEvent[]) => { const enc = new TextEncoder(); let i = 0; return new Response(new ReadableStream({ pull(c) { if (i < evs.length) c.enqueue(enc.encode(`data: ${JSON.stringify(evs[i++])}\n\n`)); else c.close(); } }), { status: 200 }); };
  const done = (): ServerEvent[] => [{ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
  const DEFS: ToolDef[] = [{ name: "search_notes", description: "s", input_schema: { type: "object" }, approval: false }];
  function rig() {
    const db = new Database(":memory:"); const calls: any[] = [];
    const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => { calls.push(b); return b.stream === false ? Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }) : sse(done()); } };
    const tools: ToolHost = { list: async () => DEFS, call: async () => ({ text: "x", isError: false }) };
    const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
    const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } }, provider, index, sink: { broadcast: () => {} }, retryDelayMs: 1, tools });
    engine.setConvId("conv-1");
    return { engine, calls: () => calls.filter((c) => c.stream) };
  }
  const textsOf = (m: any) => m.content.filter((b: any) => b.type === "text").map((b: any) => b.text);
  test("hint goes to the model only; stored message keeps the visible text; no forced tool_choice", async () => {
    const r = rig();
    await r.engine.send("/search_notes foo", undefined, [], { kind: "tool", name: "search_notes" });
    const body = r.calls()[0];
    expect(textsOf(body.messages[0])[0]).toContain("use tool `search_notes`");
    expect(textsOf(body.messages[0])[1]).toBe("/search_notes foo");
    expect(body.tool_choice).toBeUndefined();
    const stored = r.engine.messages()[0];
    expect(stored.content).toEqual([{ type: "text", text: "/search_notes foo" }]);
    // next turn replays the same hint on the same message (stable prefix)
    await r.engine.send("thanks");
    expect(textsOf(r.calls()[1].messages[0])[0]).toContain("search_notes");
    expect(textsOf(r.calls()[1].messages.at(-1))).toEqual(["thanks"]);
  });
  test("bogus slash is ignored", async () => {
    const r = rig();
    await r.engine.send("/list_agents", undefined, [], { kind: "tool", name: "list_agents" });
    expect(textsOf(r.calls()[0].messages[0])).toEqual(["/list_agents"]);
  });
});

// ---- route ----
const ORIGIN = "https://app.test";
function env(tools: unknown, ok = true): Env {
  const CHAT = { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => (new URL(r.url).pathname === "/tools" && ok ? Response.json({ tools }) : new Response("x", { status: 500 })) }) };
  return { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: {} as any, CHAT } as never;
}
describe("GET /api/slash", () => {
  const app = createApp();
  test("401 unauthenticated", async () => {
    expect((await app.fetch(new Request(`${ORIGIN}/api/slash`, { headers: { origin: ORIGIN } }), env([]))).status).toBe(401);
  });
  test("shape; omits unclassified and list_agents", async () => {
    const e = env(ALL.map((t) => ({ ...t, group: "personal-connector" })));
    const { cookie } = await makeSession(e, "example-user", "github");
    const r = await app.fetch(new Request(`${ORIGIN}/api/slash`, { headers: { origin: ORIGIN, cookie: cookie.split(";")[0] } }), e);
    expect(r.status).toBe(200);
    const j = await r.json() as { items: SlashItem[] };
    const names = j.items.map((i) => i.name);
    expect(names).toContain("search_notes"); expect(names).toContain("model");
    expect(names).not.toContain("list_agents"); expect(names).not.toContain("rogue_tool");
    expect(j.items.find((i) => i.name === "save_note")).toMatchObject({ kind: "tool", group: "personal-connector", approval: true });
    for (const i of j.items) expect(Object.keys(i).sort().every((k) => ["kind", "name", "description", "group", "approval", "disabled"].includes(k))).toBe(true);
  });
  test("DO failure degrades to builtins only", async () => {
    const e = env([], false);
    const { cookie } = await makeSession(e, "example-user", "github");
    const j = await (await app.fetch(new Request(`${ORIGIN}/api/slash`, { headers: { origin: ORIGIN, cookie: cookie.split(";")[0] } }), e)).json() as { items: SlashItem[] };
    expect(j.items.every((i) => i.kind === "builtin")).toBe(true);
  });
});
