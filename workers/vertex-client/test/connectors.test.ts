import type { GuestScope } from "../src/scope";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { CONNECTOR_ID, applyPatch, connectorView, filterHost, loadSettings, parseDisabled, pinSettings, saveSettings, type ConnectorSettings } from "../src/connectors";
import { APPROVAL_TOOLS, READ_TOOLS, classify, type ToolDef, type ToolHost } from "../src/tools";
import { EMPTY_TOOL_HOST, toolHostFor } from "../src/auth-e2e";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { chatMock } from "./do-mock";
import { applyPut, offeredCount } from "../web/src/connectors-logic";

const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
const def = (name: string): ToolDef => ({ name, description: `d ${name}`, input_schema: {}, approval: classify(name) === "approval" });
const ALL = [...READ_TOOLS, ...APPROVAL_TOOLS].map(def);
const host = (log: string[] = []): ToolHost => ({ list: async () => ALL, call: async (n) => { log.push(n); return { text: "ran " + n, isError: false }; } });
const S = (enabled: boolean, disabled: string[] = [], modes: ConnectorSettings["modes"] = {}): ConnectorSettings => ({ enabled, disabled, modes });

describe("filterHost", () => {
  test("defaults pass everything through", async () => {
    expect((await filterHost(host(), S(true)).list()).length).toBe(ALL.length);
  });
  test("a disabled tool is not listed and call() rejects it without reaching the connector", async () => {
    const log: string[] = []; const h = filterHost(host(log), S(true, ["save_note", "read_url"]));
    const names = (await h.list()).map((t) => t.name);
    expect(names).not.toContain("save_note"); expect(names).not.toContain("read_url"); expect(names).toContain("search_notes");
    const r = await h.call("save_note", {}); expect(r.isError).toBe(true);
    expect((await h.call("search_notes", {})).isError).toBe(false);
    expect(log).toEqual(["search_notes"]);
  });
  test("a disabled connector lists nothing and refuses every call", async () => {
    const log: string[] = []; const h = filterHost(host(log), S(false));
    expect(await h.list()).toEqual([]);
    expect((await h.call("search_notes", {})).isError).toBe(true); expect(log).toEqual([]);
  });
  test("approval is never downgraded: tiers pass through unchanged, whatever is toggled", async () => {
    const lying: ToolHost = { list: async () => ALL, call: async () => ({ text: "", isError: false }) };
    for (const s of [S(true), S(true, ["search_notes"]), S(true, [...APPROVAL_TOOLS])]) {
      for (const t of await filterHost(lying, s).list()) expect(t.approval).toBe(APPROVAL_TOOLS.has(t.name));
    }
  });
});

describe("settings patch", () => {
  test("tool on/off and master switch, sorted + deduped", () => {
    let r = applyPatch(S(true), { tool: { name: "save_note", enabled: false } }); expect(r.ok && r.next).toEqual(S(true, ["save_note"]));
    r = applyPatch(S(true, ["save_note"]), { tool: { name: "delete_note", enabled: false } }); expect(r.ok && r.next.disabled).toEqual(["delete_note", "save_note"]);
    r = applyPatch(S(true, ["save_note"]), { tool: { name: "save_note", enabled: true } }); expect(r.ok && r.next.disabled).toEqual([]);
    r = applyPatch(S(true), { enabled: false }); expect(r.ok && r.next.enabled).toBe(false);
  });
  test("rejects unknown tools, wrong types, empty bodies", () => {
    for (const b of [{}, { enabled: "no" }, { tool: { name: "rogue", enabled: false } }, { tool: { name: "list_agents", enabled: false } }, { tool: { name: "save_note" } }, { tool: "save_note" }, null]) expect(applyPatch(S(true), b as never).ok).toBe(false);
  });
  test("parseDisabled drops junk and unknown names", () => {
    expect(parseDisabled('["save_note","rogue",5,"save_note"]')).toEqual(["save_note"]);
    expect(parseDisabled("not json")).toEqual([]); expect(parseDisabled({})).toEqual([]);
  });
});

describe("pinning", () => {
  const mem = () => { let v: string | null = null; return { get: () => v, set: (x: string) => { v = x; }, peek: () => v }; };
  test("resolved once; later toggles do not reach this conversation, a new one sees them", async () => {
    let cur = S(true); let loads = 0; const load = async () => { loads++; return cur; };
    const a = mem(); expect(await pinSettings(a, load)).toEqual(S(true));
    cur = S(true, ["save_note"]);
    expect(await pinSettings(a, load)).toEqual(S(true)); expect(loads).toBe(1);
    const b = mem(); expect(await pinSettings(b, load)).toEqual(S(true, ["save_note"]));
  });
  test("a load failure pins nothing; a corrupt pin is re-resolved", async () => {
    const a = mem();
    await expect(pinSettings(a, async () => { throw new Error("d1"); })).rejects.toThrow();
    expect(a.peek()).toBeNull();
    a.set("{oops"); expect(await pinSettings(a, async () => S(false))).toEqual(S(false)); expect(JSON.parse(a.peek()!).enabled).toBe(false);
  });
});

describe("scope tables compose with the filter", () => {
  test("g:* stays empty even if a row says enabled; e2e keeps only its subset", async () => {
    expect(await filterHost(toolHostFor(GA, host()), S(true)).list()).toEqual([]);
    expect(filterHost(EMPTY_TOOL_HOST, S(true)).call("search_notes", {})).resolves.toMatchObject({ isError: true });
    expect((await filterHost(toolHostFor("e2e", host()), S(true, ["save_note"])).list()).map((t) => t.name).sort()).toEqual(["connector_usage", "delete_note", "search_notes"]);
  });
});

describe("connectorView", () => {
  test("15 real tools, tier + switch state; list_agents hidden; unreachable when empty or errored", () => {
    const v = connectorView([...ALL, def("list_agents"), def("rogue")], S(true, ["save_note"]));
    expect(v.id).toBe(CONNECTOR_ID); expect(v.status).toBe("ok"); expect(v.toolCount).toBe(15); expect(v.enabledCount).toBe(14);
    expect(v.tools.find((t) => t.name === "save_note")).toMatchObject({ approval: true, enabled: false });
    expect(v.tools.find((t) => t.name === "search_notes")).toMatchObject({ approval: false, enabled: true });
    expect(connectorView([], S(true)).status).toBe("unreachable");
    expect(connectorView(ALL, S(true), "boom")).toMatchObject({ status: "unreachable", error: "boom" });
    const off = connectorView(ALL, S(false, ["save_note"])); expect(off.enabledCount).toBe(0); expect(off.tools.find((t) => t.name === "search_notes")!.enabled).toBe(true);
  });
});

// ---- routes ----
const ORIGIN = "https://app.test";
function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as unknown as D1Database };
}
const app = createApp({ scopeOf: (s) => (s.u === "guest-a" ? (GA as any) : s.via === "e2e" ? "e2e" : "main") });
function mkEnv() {
  const x = d1();
  const e: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k", E2E_TOKEN: "e2e-test-token-0123456789abcdef0123456789abcdef", ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, _db: x.db };
  e.CHAT = { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => (new URL(r.url).pathname === "/connector-tools" ? Response.json({ tools: ALL }) : Response.json({ tools: [] })) }) };
  return e as Env & { _db: Database };
}
const who = async (env: Env, user: string) => { const { cookie, session } = await makeSession(env, user, "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const e2eWho = async (env: Env) => { // the real bypass login, exactly as the e2e tester does it
  const r = await app.fetch(new Request(ORIGIN + "/auth/e2e", { method: "POST", headers: { "x-e2e-token": (env as any).E2E_TOKEN } }), env);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const me = (await (await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), env)).json()) as any;
  return { cookie, csrf: me.csrf as string };
};
const call = (env: Env, w: { cookie: string; csrf: string }, method: string, path: string, body?: unknown, csrf = true) => {
  const h = new Headers({ cookie: w.cookie, origin: ORIGIN });
  if (method !== "GET") { if (csrf) h.set("x-csrf-token", w.csrf); h.set("content-type", "application/json"); }
  return app.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};

describe("/api/connectors", () => {
  test("main: real list, PUT persists, CSRF required, bad input 400, unknown connector 404", async () => {
    const env = mkEnv(); const m = await who(env, "example-user");
    const j = (await (await call(env, m, "GET", "/api/connectors")).json()) as any;
    expect(j.connectors).toHaveLength(1); expect(j.connectors[0]).toMatchObject({ id: CONNECTOR_ID, status: "ok", toolCount: 15, enabled: true });
    expect((await call(env, m, "PUT", `/api/connectors/${CONNECTOR_ID}`, { tool: { name: "save_note", enabled: false } }, false)).status).toBe(403);
    expect((await call(env, m, "PUT", `/api/connectors/${CONNECTOR_ID}`, { tool: { name: "save_note", enabled: false } })).status).toBe(200);
    const j2 = (await (await call(env, m, "GET", "/api/connectors")).json()) as any;
    expect(j2.connectors[0].enabledCount).toBe(14); expect(j2.connectors[0].tools.find((t: any) => t.name === "save_note")).toMatchObject({ enabled: false, approval: true });
    expect(await loadSettings(env.DB as any, "main")).toEqual(S(true, ["save_note"]));
    expect((await call(env, m, "PUT", `/api/connectors/${CONNECTOR_ID}`, { tool: { name: "rogue", enabled: false } })).status).toBe(400);
    expect((await call(env, m, "PUT", "/api/connectors/other", { enabled: false })).status).toBe(404);
  });
  test("g:* gets 403 on GET and PUT and writes nothing; e2e has its own rows", async () => {
    const env = mkEnv(); const m = await who(env, "example-user"), g = await who(env, "guest-a"), e = await e2eWho(env);
    expect((await call(env, g, "GET", "/api/connectors")).status).toBe(403);
    expect((await call(env, g, "PUT", `/api/connectors/${CONNECTOR_ID}`, { enabled: false })).status).toBe(403);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM connector_settings`).get()).toEqual({ n: 0 });
    expect((await call(env, e, "PUT", `/api/connectors/${CONNECTOR_ID}`, { enabled: false })).status).toBe(200);
    expect(((await (await call(env, m, "GET", "/api/connectors")).json()) as any).connectors[0].enabled).toBe(true);
    expect(((await (await call(env, e, "GET", "/api/connectors")).json()) as any).connectors[0].enabled).toBe(false);
    await saveSettings(env.DB as any, "main", S(true));
    expect((env._db.query(`SELECT scope FROM connector_settings ORDER BY scope`).all() as any[]).map((r) => r.scope)).toEqual(["e2e", "main"]);
  });
  test("connector down -> status unreachable, still 200", async () => {
    const env = mkEnv(); (env as any).CHAT = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ tools: [], error: "mcp http 500" }) }) };
    const j = (await (await call(env, await who(env, "example-user"), "GET", "/api/connectors")).json()) as any;
    expect(j.connectors[0]).toMatchObject({ status: "unreachable", error: "mcp http 500" });
  });
});

describe("web logic", () => {
  const row = connectorView(ALL, S(true)) as any;
  test("applyPut sets one tool's mode or the master switch; master off keeps per-tool state", () => {
    const a = applyPut(row, { tool: { name: "read_url", mode: "block" } });
    expect(a.tools.find((t: any) => t.name === "read_url")).toMatchObject({ mode: "block", enabled: false }); expect(a.tools.find((t: any) => t.name === "get_note")!.mode).toBe("always");
    const b = applyPut(a, { enabled: false }); expect(offeredCount(b)).toBe(0); expect(b.tools.filter((t: any) => t.mode !== "block").length).toBe(14);
    expect(offeredCount(applyPut(b, { enabled: true }))).toBe(14);
    expect(applyPut(row, { tool: { name: "get_note", mode: "ask" } }).tools.find((t: any) => t.name === "get_note")).toMatchObject({ mode: "ask", approval: true });
  });
});

describe("built-in per-tool modes", () => {
  test("view: read tools default Always, approval tools Ask first, block from disabled, ask override from modes", () => {
    const v = connectorView(ALL, S(true, ["read_url"], { get_note: "ask" }));
    const m = (n: string) => v.tools.find((t) => t.name === n)!;
    expect(m("search_notes")).toMatchObject({ mode: "always", canAlways: true, approval: false });
    expect(m("get_note")).toMatchObject({ mode: "ask", canAlways: true, approval: true });
    expect(m("save_note")).toMatchObject({ mode: "ask", canAlways: false, approval: true });
    expect(m("read_url")).toMatchObject({ mode: "block", enabled: false });
  });
  test("patch: ask raises a read tool, always is refused for an approval tool, block/always clean up", () => {
    let r = applyPatch(S(true), { tool: { name: "get_note", mode: "ask" } }); expect(r.ok && r.next.modes).toEqual({ get_note: "ask" });
    r = applyPatch(S(true, [], { get_note: "ask" }), { tool: { name: "get_note", mode: "always" } }); expect(r.ok && r.next.modes).toEqual({});
    r = applyPatch(S(true, [], { get_note: "ask" }), { tool: { name: "get_note", mode: "block" } }); expect(r.ok && r.next).toEqual(S(true, ["get_note"], {}));
    expect(applyPatch(S(true), { tool: { name: "save_note", mode: "always" } }).ok).toBe(false);
    expect(applyPatch(S(true), { tool: { name: "get_note", mode: "yolo" } }).ok).toBe(false);
    r = applyPatch(S(true), { tool: { name: "save_note", mode: "ask" } }); expect(r.ok && r.next.modes).toEqual({});
  });
  test("filterHost raises approval for an ask override and never lowers it", async () => {
    const l = await filterHost(host(), S(true, [], { get_note: "ask" })).list();
    expect(l.find((t) => t.name === "get_note")!.approval).toBe(true); expect(l.find((t) => t.name === "search_notes")!.approval).toBe(false); expect(l.find((t) => t.name === "save_note")!.approval).toBe(true);
  });
  test("pin keeps modes; a stored 'always' for an approval tool is dropped on load", async () => {
    let v: string | null = null; const st = { get: () => v, set: (x: string) => { v = x; } };
    await pinSettings(st, async () => S(true, [], { get_note: "ask" }));
    expect((await pinSettings(st, async () => S(true))).modes).toEqual({ get_note: "ask" });
    st.set(JSON.stringify({ enabled: true, disabled: [], modes: { get_note: "ask", save_note: "always", rogue: "ask" } }));
    expect((await pinSettings(st, async () => S(true))).modes).toEqual({ get_note: "ask" });
  });
});
