// Approval modes (docs/design/approval-modes.md, option B): pure policy, the real ChatEngine with a fake model, and the D1 grants / audit / routes.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { ChatEngine, buildRequest, type IndexSink, type ServerEvent } from "../src/turn-engine";
import type { ModelProvider } from "../src/providers/types";
import type { ToolDef, ToolHost } from "../src/tools";
import { BYPASS_CONFIRM_VERSION, AWAITING_TTL_MS, EXPIRED_TEXT, autoUrlOk, grantHost, hardAskReason, noRedirect, urlLooksLikeData, webAuto, type AutoSource } from "../src/approval";
import { addGrant, approvalAutoOn, listAudit, listGrants, recordBypassConfirm, purgeAudit, revokeGrant, setApprovalAuto, userHosts, writeAudit } from "../src/grants";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { parseBase, scopeFor, type BaseScope, type Scope } from "../src/scope";
import { chatMock } from "./do-mock";

// ---------- pure policy ----------
describe("grantHost: exact registrable host, no tricks", () => {
  test("accepts plain hosts, lowercases, drops the trailing dot and the default port", () => {
    expect(grantHost("https://Example.ORG/a?b=1")).toBe("example.org");
    expect(grantHost("https://example.org./x")).toBe("example.org");
    expect(grantHost("https://example.org:443/x")).toBe("example.org");
    expect(grantHost("http://wttr.in/Hanoi")).toBe("wttr.in");
  });
  test("refuses userinfo, explicit ports, IP literals, dotless/local names, non-http", () => {
    for (const u of ["https://example.org@evil.com/", "https://user:pw@example.org/", "https://example.org:8443/", "http://127.0.0.1/", "http://0x7f.1/", "http://[::1]/", "http://localhost/", "http://intranet/", "http://db.internal/", "http://x.local/", "ftp://example.org/", "javascript:alert(1)", "not a url", "", null, undefined, 5])
      expect(grantHost(u as any)).toBeNull();
  });
  test("suffix / substring tricks are different hosts (exact match only)", () => {
    expect(grantHost("https://evil.com.example.org/")).toBe("evil.com.example.org");
    expect(grantHost("https://evil.com.example.org/")).not.toBe("example.org");
    expect(grantHost("https://example.org.evil.com/")).not.toBe("example.org");
    expect(grantHost("https://www.example.org/")).not.toBe("example.org"); // www is a different host
    expect(grantHost("https://exampleXorg.com/")).toBe("examplexorg.com");
  });
  test("punycode: the ASCII form is the subject; the unicode look-alike is a different host", () => {
    const h = grantHost("https://аpple.com/")!; // cyrillic а
    expect(h).toStartWith("xn--"); expect(h).not.toBe("apple.com");
    expect(grantHost("https://xn--pple-43d.com/")).toBe(h);
  });
});

describe("webAuto: which gated browse call may a grant or Auto answer", () => {
  const none = new Set<string>();
  const call = (url: string) => ({ url });
  test("chat grant, user grant, exact host only", () => {
    expect(webAuto("web_read", call("https://news.test/a"), { chat: new Set(["news.test"]), user: none, auto: false })).toEqual({ kind: "auto", source: "chat-grant", subject: "news.test" });
    expect(webAuto("web_links", call("https://news.test/a"), { chat: none, user: new Set(["news.test"]), auto: false })).toEqual({ kind: "auto", source: "user-grant", subject: "news.test" });
    for (const u of ["https://evil.com.news.test/a", "https://news.test.evil.com/a", "https://news.test@evil.com/a", "https://sub.news.test/a", "https://news.test:8080/a"])
      expect(webAuto("web_read", call(u), { chat: new Set(["news.test"]), user: new Set(["news.test"]), auto: false }).kind).toBe("approval");
  });
  test("a granted host with a data-looking address still asks", () => {
    const g = { chat: new Set(["news.test"]), user: none, auto: false };
    expect(webAuto("web_read", call("https://news.test/a?q=" + "x".repeat(200)), g).kind).toBe("approval");
    expect(webAuto("web_read", call("https://news.test/" + "a1b2c3d4".repeat(6)), g).kind).toBe("approval");
    expect(webAuto("web_read", call("https://news.test/a?page=2"), g).kind).toBe("auto");
  });
  test("Auto: any plain host, but never a query string, userinfo or a blob", () => {
    const a = { chat: none, user: none, auto: true };
    expect(webAuto("web_read", call("https://anything.test/weather/hanoi"), a)).toEqual({ kind: "auto", source: "mode-auto", subject: "anything.test" });
    expect(webAuto("web_read", call("https://anything.test/?d=hello"), a).kind).toBe("approval");
    expect(webAuto("web_read", call("https://anything.test@evil.com/x"), a).kind).toBe("approval");
    expect(webAuto("web_read", call("https://anything.test/" + "ab12".repeat(10)), a).kind).toBe("approval");
    expect(webAuto("web_read", call("https://anything.test/x"), { chat: none, user: none, auto: false }).kind).toBe("approval");
  });
  test("only the browse tools: a write tool never matches, grant or Auto", () => {
    for (const n of ["save_note", "update_task", "assign_task", "delete_note", "delete_thread", "ask_vertex", "some__custom"])
      expect(webAuto(n, call("https://news.test/a"), { chat: new Set(["news.test"]), user: new Set(["news.test"]), auto: true }).kind).toBe("approval");
  });
  test("urlLooksLikeData / autoUrlOk", () => {
    expect(urlLooksLikeData("https://a.test/2026-10-26-a-very-long-article-slug-about-nothing-secret-at-all-ok")).toBe(false);
    expect(urlLooksLikeData("https://a.test/" + "deadbeef".repeat(5))).toBe(true);
    expect(autoUrlOk("https://a.test/x")).toBe(true); expect(autoUrlOk("https://a.test/x?y=1")).toBe(false); expect(autoUrlOk("garbage")).toBe(false);
  });
});

describe("noRedirect: a grant only covers an address that answers without redirecting", () => {
  const mk = (map: Record<string, { status: number; loc?: string }>): typeof fetch => (async (u: any) => { const r = map[String(u)]; if (!r) throw new Error("net"); return new Response(null, { status: r.status, headers: r.loc ? { location: r.loc } : {} }); }) as any;
  test("plain answer ok; any redirect (other host, same host, userinfo trick, loop), failure, wrong host = false", async () => {
    expect(await noRedirect("https://a.test/x", "a.test", mk({ "https://a.test/x": { status: 200 } }))).toBe(true);
    expect(await noRedirect("https://a.test/x", "a.test", mk({ "https://a.test/x": { status: 302, loc: "https://evil.example/z" } }))).toBe(false); // redirect to a different host
    expect(await noRedirect("https://a.test/x", "a.test", mk({ "https://a.test/x": { status: 302, loc: "/y" }, "https://a.test/y": { status: 200 } }))).toBe(false); // same-host redirect: demoted (no final URL to prove it)
    expect(await noRedirect("https://a.test/x", "a.test", mk({ "https://a.test/x": { status: 302, loc: "https://a.test@evil.example/" } }))).toBe(false);
    expect(await noRedirect("https://a.test/x", "a.test", mk({ "https://a.test/x": { status: 302, loc: "/x" } }))).toBe(false);
    expect(await noRedirect("https://a.test/x", "a.test", mk({}))).toBe(false);
    expect(await noRedirect("https://a.test/x", "a.test", mk({ "https://a.test/x": { status: 302 } }))).toBe(false);
    expect(await noRedirect("https://b.test/x", "a.test", mk({ "https://b.test/x": { status: 200 } }))).toBe(false);
    expect(await noRedirect("http://127.0.0.1/x", "127.0.0.1", mk({ "http://127.0.0.1/x": { status: 200 } }))).toBe(false);
  });
});

describe("hardAskReason: addresses a grant or Auto NEVER covers", () => {
  const BAD = ["http://127.0.0.1/", "http://10.0.0.5/x", "http://8.8.8.8/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://0x7f.1/", "http://127.1/", "http://[::1]/", "http://[2001:db8::1]/x", "http://[::ffff:127.0.0.1]/",
    "http://localhost/", "http://LOCALHOST./", "http://foo.localhost/", "http://intranet/", "http://db.internal/", "http://x.local/", "http://nas.lan/", "https://a.test:8443/", "http://a.test:8080/", "https://a.test:22/",
    "https://good.test@evil.test/", "https://user:pw@a.test/", "ftp://a.test/", "file:///etc/passwd", "javascript:alert(1)", "not a url", ""];
  test("each form has a plain-words reason", () => { for (const u of BAD) expect(typeof hardAskReason(u)).toBe("string"); expect(hardAskReason(5)).toBeTruthy(); });
  test("ordinary public addresses (incl. default ports) have none", () => { for (const u of ["https://a.test/x", "http://wttr.in/Hanoi", "https://a.test:443/x", "http://a.test:80/"]) expect(hardAskReason(u)).toBeNull(); });
  test("webAuto: neither Auto, a chat grant nor a user grant answers any of them", () => {
    const hosts = new Set(["127.0.0.1", "localhost", "a.test", "[::1]", "10.0.0.5", "x.local", "intranet", "good.test"]);
    for (const u of BAD) { for (const g of [{ chat: hosts, user: hosts, auto: true }, { chat: hosts, user: new Set<string>(), auto: false }]) expect(webAuto("web_read", { url: u }, g).kind).toBe("approval"); }
    expect(webAuto("web_read", { url: "https://a.test:8443/" }, { chat: new Set(["a.test"]), user: new Set<string>(), auto: true }).kind).toBe("approval");
  });
});

// ---------- engine ----------
const sse = (evs: ServerEvent[]) => { const enc = new TextEncoder(); return new Response(new ReadableStream({ start(c) { for (const e of evs) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } }); };
const msg = (blocks: any[], stop: string): ServerEvent[] => {
  const ev: ServerEvent[] = [{ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }];
  blocks.forEach((b, i) => {
    if (b.type === "text") ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    else ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }, { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    ev.push({ type: "content_block_stop", index: i });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return ev;
};
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const WEBDEF = (name: string): ToolDef => ({ name, description: name, input_schema: { type: "object", properties: {} }, approval: false });
const DONE = () => sse(msg([{ type: "text", text: "done" }], "end_turn"));

type Rig = ReturnType<typeof rig>;
function rig(script: Array<() => Response>, o: { auto?: boolean; mode?: "ask" | "auto" | "bypass"; tools?: ToolDef[]; user?: string[]; autoOn?: boolean; auditFails?: boolean; redirectOk?: boolean; now?: () => number } = {}) {
  const db = new Database(":memory:"), ran: string[] = [], events: ServerEvent[] = [], order: string[] = [], audits: any[] = [], saved: any[] = [];
  let n = 0;
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (body: any) => { if (body.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }); return (script[n++] ?? DONE)(); } };
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
  const host: ToolHost = {
    list: async () => o.tools ?? [WEBDEF("web_read"), WEBDEF("web_links"), { ...WEBDEF("save_note"), approval: true }, { ...WEBDEF("delete_note"), approval: true }],
    call: async (name, args: any) => { ran.push(`${name}:${args?.url ?? args?.title ?? ""}`); order.push(`run:${name}`); return { text: `result of ${name}`, isError: false }; },
  };
  const userSet = new Set(o.user ?? []);
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: 1, tools: host, now: o.now,
    approvals: {
      autoOn: async () => o.autoOn !== false, userHosts: async () => userSet,
      audit: async (e) => { if (o.auditFails) throw new Error("d1 down"); order.push("audit"); audits.push(e); },
      saveUserGrant: async (tool, h) => { saved.push([tool, h]); return true; },
      noRedirect: async () => o.redirectOk !== false,
    },
  });
  engine.setConvId("c1");
  if (o.auto) engine.setApprovalMode("auto");
  if (o.mode) engine.setApprovalMode(o.mode);
  return { engine, events, ran, order, audits, saved, db };
}
// first message reads a page (user-typed URL: auto, and it taints the chat); the model then calls the second batch
const tainted = (second: any[], more: Array<() => Response> = []) => [() => sse(msg([use("u1", "web_read", { url: "https://a.test/p" })], "tool_use")), () => sse(msg(second, "tool_use")), ...more];
const START = "read https://a.test/p";
const MODEL = "claude-sonnet-5-5";
const evs = (r: Rig, t: string) => r.events.filter((e) => e.type === t) as any[];

describe("engine: grants", () => {
  test("baseline (no grant, ask mode): a second host after a web read asks", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]));
    await r.engine.send(START, MODEL);
    expect(r.engine.state().awaiting).not.toBeNull(); expect(r.ran).toEqual(["web_read:https://a.test/p"]);
    expect(evs(r, "approval_required")[0].calls[0]).toMatchObject({ id: "u2", host: "news.test", canAlways: true });
  });
  test("'Allow this domain in this chat': approve + grant chat, then the next batch on that host runs without a card, with an audit row BEFORE the call and a chat line", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })], [() => sse(msg([use("u3", "web_read", { url: "https://news.test/b" })], "tool_use"))]));
    await r.engine.send(START, MODEL);
    expect(r.engine.decide("u2", "approve", "chat")).toMatchObject({ ok: true, ready: true });
    await r.engine.resume();
    expect(r.engine.state().awaiting).toBeNull();
    expect(r.ran).toEqual(["web_read:https://a.test/p", "web_read:https://news.test/a", "web_read:https://news.test/b"]);
    expect(r.audits).toEqual([{ conversationId: "c1", tool: "web_read", subject: "news.test", source: "chat-grant", mode: "ask" }]);
    expect(r.order.slice(-2)).toEqual(["audit", "run:web_read"]); // audit first
    expect(evs(r, "approval_auto")).toMatchObject([{ id: "u3", name: "web_read", subject: "news.test", source: "chat-grant" }]);
    expect(r.engine.state().autoLog["u3"]).toMatchObject({ subject: "news.test" });
    expect(r.engine.chatGrants()).toEqual(["news.test"]);
  });
  test("a once-approval creates no grant", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })], [() => sse(msg([use("u3", "web_read", { url: "https://news.test/b" })], "tool_use"))]));
    await r.engine.send(START, MODEL); r.engine.decide("u2", "approve", "once"); await r.engine.resume();
    expect(r.engine.chatGrants()).toEqual([]); expect(r.engine.state().awaiting).not.toBeNull(); // u3 asks
  });
  test("deny with a grant flag grants nothing", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]));
    await r.engine.send(START, MODEL); r.engine.decide("u2", "deny", "chat"); expect(r.engine.chatGrants()).toEqual([]);
  });
  test("the grant host comes from the parked call: a grant on a data-looking or ineligible URL is not offered / not stored", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://user@evil.example/a" })]));
    await r.engine.send(START, MODEL);
    expect(evs(r, "approval_required")[0].calls[0]).toMatchObject({ host: null, canAlways: false });
    expect(r.engine.decide("u2", "approve", "user")).toEqual({ ok: true, ready: true }); expect(r.engine.chatGrants()).toEqual([]);
  });
  test("'Always allow' returns the host to persist, and also covers the rest of the chat", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]));
    await r.engine.send(START, MODEL);
    expect(r.engine.decide("u2", "approve", "user")).toEqual({ ok: true, ready: true, userGrant: { tool: "web_read", host: "news.test" } });
    expect(r.engine.chatGrants()).toEqual(["news.test"]);
  });
  test("a persistent (user) grant auto-approves in a NEW chat and logs source user-grant", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]), { user: ["news.test"] });
    await r.engine.send(START, MODEL);
    expect(r.engine.state().awaiting).toBeNull();
    expect(r.audits).toMatchObject([{ source: "user-grant", subject: "news.test" }]);
  });
  test("sibling in the SAME batch: approving one never auto-approves the other (grants apply to later batches only)", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" }), use("u3", "web_links", { url: "https://news.test/b" })]));
    await r.engine.send(START, MODEL);
    expect(r.engine.decide("u2", "approve", "chat")).toMatchObject({ ok: true, ready: false });
    expect(r.ran).toEqual(["web_read:https://a.test/p"]); // u3 still parked
    expect(r.engine.state().awaiting!.calls.map((c: any) => [c.id, c.decision])).toEqual([["u2", "approve"], ["u3", null]]);
  });
  test("a grant never leaks to another conversation (separate engine) nor into a fork's seed", async () => {
    const a = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]));
    await a.engine.send(START, MODEL); a.engine.decide("u2", "approve", "chat");
    const b = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]));
    await b.engine.send(START, MODEL);
    expect(b.engine.chatGrants()).toEqual([]); expect(b.engine.state().awaiting).not.toBeNull();
    const f = rig([]); f.engine.seedHistory(MODEL, "t", a.engine.messages().map((m) => ({ role: m.role, content: m.content, model: m.model })), true);
    expect(f.engine.chatGrants()).toEqual([]); expect(f.engine.approvalMode()).toBe("ask");
  });
  test("audit write fails -> fail closed: the card stays, nothing runs", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]), { user: ["news.test"], auditFails: true });
    await r.engine.send(START, MODEL);
    expect(r.engine.state().awaiting).not.toBeNull(); expect(r.ran).toEqual(["web_read:https://a.test/p"]);
  });
  test("a granted call whose address redirects (to another host, or the same one) is demoted to a card that says why; nothing runs, no audit", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]), { user: ["news.test"], redirectOk: false });
    await r.engine.send(START, MODEL);
    expect(r.engine.state().awaiting).not.toBeNull(); expect(r.audits).toEqual([]); expect(r.ran).toEqual(["web_read:https://a.test/p"]);
    expect(evs(r, "approval_required")[0].calls[0].reason).toContain("redirects");
    expect((r.engine.state().awaiting!.calls[0] as any).reason).toContain("redirects");
  });
  test("a granted call that does not redirect still runs without a card", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]), { user: ["news.test"] });
    await r.engine.send(START, MODEL); expect(r.engine.state().awaiting).toBeNull(); expect(r.audits).toMatchObject([{ source: "user-grant" }]);
  });
  test("engine: an IP / localhost / port / userinfo address always cards in Auto with a reason, no grant buttons, and is never auto-run", async () => {
    for (const url of ["http://127.0.0.1/x", "http://2130706433/", "http://[::1]/", "http://localhost/x", "https://a.test:8443/x", "https://a.test@evil.test/x", "http://intranet/x"]) {
      const r = rig(tainted([use("u2", "web_read", { url })]), { auto: true, user: ["127.0.0.1", "localhost", "intranet"] });
      await r.engine.send(START, MODEL);
      expect(r.engine.state().awaiting).not.toBeNull(); expect(r.ran).toEqual(["web_read:https://a.test/p"]); expect(r.audits).toEqual([]);
      expect(evs(r, "approval_required")[0].calls[0]).toMatchObject({ host: null, canAlways: false, reason: expect.stringContaining("always needs your approval") });
    }
  });
  test("admin kill switch off: persistent grants and Auto are ignored", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]), { user: ["news.test"], autoOn: false, auto: true });
    await r.engine.send(START, MODEL);
    expect(r.engine.state().awaiting).not.toBeNull();
    expect(evs(r, "approval_required")[0].calls[0].canAlways).toBe(false);
  });
});

describe("engine: Auto mode", () => {
  test("Auto: a plain new host runs, with audit + chat line; a query URL still asks", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://other.test/weather" })], [() => sse(msg([use("u3", "web_read", { url: "https://other.test/x?d=secret" })], "tool_use"))]), { auto: true });
    await r.engine.send(START, MODEL);
    expect(r.ran).toEqual(["web_read:https://a.test/p", "web_read:https://other.test/weather"]);
    expect(r.audits).toMatchObject([{ source: "mode-auto", subject: "other.test" }]);
    expect(r.engine.state().awaiting!.calls.map((c: any) => c.id)).toEqual(["u3"]);
  });
  test("Auto never covers write / delete tools, in a tainted chat or not (hard-ask)", async () => {
    for (const name of ["save_note", "delete_note"]) {
      const r = rig(tainted([use("u2", name, { title: "x" })]), { auto: true, user: ["news.test"] });
      await r.engine.send(START, MODEL);
      expect(r.engine.state().awaiting!.calls.map((c: any) => c.name)).toEqual([name]);
      expect(r.ran).toEqual(["web_read:https://a.test/p"]); expect(r.audits).toEqual([]);
    }
    const clean = rig([() => sse(msg([use("u1", "save_note", { title: "x" })], "tool_use"))], { auto: true }); // untainted chat, Auto on: still a card
    await clean.engine.send("hi", MODEL); expect(clean.engine.state().awaiting).not.toBeNull(); expect(clean.ran).toEqual([]);
  });
  test("a write tool in the same batch as an auto-approved web call still parks; the web call runs, the write waits", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://other.test/weather" }), use("u3", "save_note", { title: "n" })]), { auto: true });
    await r.engine.send(START, MODEL);
    expect(r.ran).toEqual(["web_read:https://a.test/p", "web_read:https://other.test/weather"]);
    expect(r.engine.state().awaiting!.calls.map((c: any) => c.id)).toEqual(["u3"]);
  });
  test("mode is per conversation, refused while a turn is pending, default ask", async () => {
    const r = rig([]); expect(r.engine.approvalMode()).toBe("ask");
    expect(r.engine.setApprovalMode("auto")).toEqual({ ok: true }); expect(r.engine.approvalMode()).toBe("auto"); expect(evs(r, "approval_mode")).toMatchObject([{ mode: "auto" }]);
    r.engine.setMeta("pending", "{}"); expect(r.engine.setApprovalMode("ask")).toMatchObject({ ok: false });
  });
});

describe("engine: pending cards expire after 30 minutes", () => {
  test("expired: decide is refused, the model is told plainly, nothing runs, the chat is idle", async () => {
    let t = 1_000_000; const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]), { now: () => t });
    await r.engine.send(START, MODEL);
    t += AWAITING_TTL_MS - 1000; expect(r.engine.state().awaiting).not.toBeNull(); // not yet
    t += 2000;
    const d = r.engine.decide("u2", "approve", "chat"); expect(d).toMatchObject({ ok: false });
    expect(r.engine.state().awaiting).toBeNull(); expect(r.ran).toEqual(["web_read:https://a.test/p"]); expect(r.engine.chatGrants()).toEqual([]);
    const last = r.engine.messages().at(-1)!; expect(last.role).toBe("user");
    expect((last.content as any[])[0]).toMatchObject({ tool_use_id: "u2", is_error: true, content: EXPIRED_TEXT });
    expect(evs(r, "approval_expired")).toHaveLength(1); expect(r.engine.running).toBe(false);
  });
  test("a fully answered batch does not expire while its resume is pending", async () => {
    let t = 1_000_000; const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })]), { now: () => t });
    await r.engine.send(START, MODEL); r.engine.decide("u2", "approve"); t += AWAITING_TTL_MS * 2;
    expect(r.engine.sweepExpired()).toBe(false); await r.engine.resume(); expect(r.ran).toContain("web_read:https://news.test/a");
  });
  test("the sweep never runs while a turn is running; a new user message after expiry works", async () => {
    let t = 1_000_000; const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })], [DONE]), { now: () => t });
    await r.engine.send(START, MODEL); t += AWAITING_TTL_MS + 5; expect(r.engine.sweepExpired()).toBe(true);
    await r.engine.send("continue", MODEL); expect(r.engine.state().awaiting).toBeNull();
  });
});

// ---------- team tool exposure ----------
import { toolHostFor } from "../src/auth-e2e";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_TEAM, SYSTEM_PROMPT_TEAM_OPEN, SYSTEM_PROMPT_TEAM_AUTO_DELEGATE, SYSTEM_PROMPT_TEAM_OPEN_AUTO_DELEGATE } from "../src/system-prompt";
const PERSONAL = ["save_note", "update_task", "assign_task", "delete_note", "delete_thread", "ask_vertex", "search_notes", "get_note", "list_projects", "check_tasks", "list_threads", "connector_usage", "fleet_status", "fleet_usage", "read_url"];
describe("team edition never offers the personal-connector tools", () => {
  const G = parseBase("g:abcdefghijklmnop1234") as BaseScope;
  const raw: ToolHost = { list: async () => PERSONAL.map((n) => ({ ...WEBDEF(n), approval: /^(save|update|assign|delete|ask)/.test(n) })), call: async (n) => ({ text: `raw:${n}`, isError: false }) };
  test("on a team scope (Business or Open) the tool list contains none of them and a direct call is refused", async () => {
    for (const sc of [scopeFor(G, "biz"), scopeFor(G, "open")] as Scope[]) {
      const h = toolHostFor(sc, raw);
      expect((await h.list()).map((t) => t.name)).toEqual([]);
      for (const n of PERSONAL) expect((await h.call(n, {})).isError).toBe(true);
    }
    expect((await toolHostFor("main", raw).list()).map((t) => t.name).sort()).toEqual([...PERSONAL].sort()); // main keeps them (and they stay hard-ask, see the Auto test above)
  });
  test("the team system prompts mention none of the personal-connector tools; the Business prompt is untouched", () => {
    for (const p of [SYSTEM_PROMPT_TEAM, SYSTEM_PROMPT_TEAM_OPEN, SYSTEM_PROMPT_TEAM_AUTO_DELEGATE, SYSTEM_PROMPT_TEAM_OPEN_AUTO_DELEGATE]) {
      for (const n of PERSONAL) expect(p).not.toContain(n);
      expect(p).not.toMatch(/personal connector|his notes|approval card/i);
      expect(p).toContain("create_artifact"); // the rest of the prompt is intact
    }
    expect(SYSTEM_PROMPT).toContain("save or delete a note");
  });
  test("buildRequest sends the team prompt only for a team user", () => {
    const text = (b: any) => b.system[0].text;
    expect(text(buildRequest(MODEL, [], [], null, null, false, null, false, undefined, false, true))).toBe(SYSTEM_PROMPT_TEAM);
    expect(text(buildRequest(MODEL, [], [], null, null, false, null, true, undefined, false, true))).toBe(SYSTEM_PROMPT_TEAM_OPEN);
    expect(text(buildRequest(MODEL, [], []))).toBe(SYSTEM_PROMPT);
  });
  test("chat-session wires personalTools from the guest check (source guard)", async () => {
    const src = await Bun.file(new URL("../src/chat-session.ts", import.meta.url)).text();
    expect(src).toContain("personalTools: async () => {"); expect(src).toContain("return !isGuestScope(gb);");
    expect(await Bun.file(new URL("../src/turn-engine.ts", import.meta.url)).text()).toContain("await this.noPersonalForPrompt()");
  });
});

// ---------- D1: grants, audit TTL, kill switch, routes ----------
const MIGS = readdirSync(new URL("../migrations/", import.meta.url)).sort();
function d1() {
  const db = new Database(":memory:");
  for (const f of MIGS) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, D: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as unknown as D1Database };
}
const GA = parseBase("g:abcdefghijklmnop1234") as BaseScope;
const MAIN_OPEN = scopeFor("main", "open"), GA_OPEN = scopeFor(GA, "open");

describe("D1 grants", () => {
  test("migration 0034 is additive and idempotent (applies twice)", () => {
    const { db } = d1(); db.exec(readFileSync(new URL("../migrations/0034_tool_grants.sql", import.meta.url), "utf8"));
    expect((db.query(`SELECT name FROM sqlite_master WHERE name IN ('tool_grants','approval_audit')`).all() as any[]).length).toBe(2);
  });
  test("per-scope isolation: main~open, a team user and main (Business) never see each other's grants; revoke is scoped too", async () => {
    const { D } = d1();
    expect(await addGrant(D, MAIN_OPEN, "web_read", "news.test")).toBe(true);
    expect([...await userHosts(D, MAIN_OPEN)]).toEqual(["news.test"]);
    expect([...await userHosts(D, GA_OPEN)]).toEqual([]); expect([...await userHosts(D, "main")]).toEqual([]);
    expect(await revokeGrant(D, GA_OPEN, "news.test")).toBe(0); expect([...await userHosts(D, MAIN_OPEN)]).toEqual(["news.test"]);
    expect(await revokeGrant(D, MAIN_OPEN, "news.test")).toBe(1); expect([...await userHosts(D, MAIN_OPEN)]).toEqual([]);
  });
  test("addGrant refuses an ineligible host or a non-browse tool; reads fail closed", async () => {
    const { D, db } = d1();
    for (const h of ["127.0.0.1", "localhost", "evil.com@x.org", "a b.com", ""]) expect(await addGrant(D, MAIN_OPEN, "web_read", h)).toBe(false);
    expect(await addGrant(D, MAIN_OPEN, "save_note", "news.test")).toBe(false);
    db.exec("DROP TABLE tool_grants"); expect([...await userHosts(D, MAIN_OPEN)]).toEqual([]); expect(await addGrant(D, MAIN_OPEN, "web_read", "news.test")).toBe(false);
  });
  test("kill switch: default on, '0' off, a D1 error = off", async () => {
    const { D, db } = d1();
    expect(await approvalAutoOn(D, "main")).toBe(true);
    await setApprovalAuto(D, GA, false); expect(await approvalAutoOn(D, GA)).toBe(false); expect(await approvalAutoOn(D, "main")).toBe(true);
    await setApprovalAuto(D, GA, true); expect(await approvalAutoOn(D, GA)).toBe(true);
    db.exec("DROP TABLE settings"); expect(await approvalAutoOn(D, "main")).toBe(false); expect(await approvalAutoOn(undefined, "main")).toBe(false);
  });
  test("audit: 30-day TTL (expires_at), expired rows are deleted on the next write and by purgeAudit, fresh rows stay; tool+host only", async () => {
    const { D, db } = d1(); const DAY = 86_400_000, t0 = 1_700_000_000_000;
    await writeAudit(D, MAIN_OPEN, { conversationId: "c1", tool: "web_read", subject: "old.test", source: "mode-auto", mode: "auto" }, t0);
    const row = db.query(`SELECT * FROM approval_audit`).get() as any;
    expect(row.expires_at - row.created_at).toBe(30 * DAY); expect(Object.keys(row).sort()).toEqual(["conversation_id", "created_at", "expires_at", "id", "mode", "scope", "source", "subject", "tool"]);
    await writeAudit(D, MAIN_OPEN, { conversationId: "c1", tool: "web_read", subject: "mid.test", source: "chat-grant", mode: "ask" }, t0 + 29 * DAY);
    expect((db.query(`SELECT subject FROM approval_audit ORDER BY id`).all() as any[]).map((x) => x.subject)).toEqual(["old.test", "mid.test"]); // 29 days: the old one is not due yet
    await writeAudit(D, MAIN_OPEN, { conversationId: "c1", tool: "web_read", subject: "new.test", source: "user-grant", mode: "ask" }, t0 + 31 * DAY); // write-time purge deletes old.test
    expect((db.query(`SELECT subject FROM approval_audit ORDER BY id`).all() as any[]).map((x) => x.subject)).toEqual(["mid.test", "new.test"]);
    await purgeAudit(D, t0 + 62 * DAY); // cron path (the newest row expires at day 61)
    expect((db.query(`SELECT COUNT(*) AS n FROM approval_audit`).get() as any).n).toBe(0);
  });
  test("writeAudit THROWS when the table is unavailable (the engine then asks instead of auto-approving)", async () => {
    const { D, db } = d1(); db.exec("DROP TABLE approval_audit");
    await expect(writeAudit(D, MAIN_OPEN, { conversationId: "c", tool: "web_read", subject: "a.test", source: "mode-auto", mode: "auto" })).rejects.toThrow();
  });
});

describe("Settings > Approvals routes (auth, CSRF, Origin, scope)", () => {
  const mk = () => {
    const { db, D } = d1();
    const env: any = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", E2E_TOKEN: "e".repeat(40), GATEWAY_KEY: "k", ASSETS: { fetch: async () => new Response("x") }, DB: D };
    env.CHAT = chatMock(() => env.FILES);
    const app = createApp({ scopeOf: (s) => (s.u === "guest-a" ? (GA as unknown as Scope) : s.via === "e2e" ? "e2e" : "main") });
    return { env: env as Env, db, app };
  };
  const as = async (env: Env, u: string) => { const m = await makeSession(env, u, "github"); return { cookie: m.cookie.split(";")[0]!, csrf: m.session.csrf }; };
  const go = (app: ReturnType<typeof createApp>, env: Env, s: { cookie: string; csrf: string } | null, method: string, path: string, h: Record<string, string> = {}) =>
    app.fetch(new Request("https://app.test" + path, { method, headers: { ...(s ? { cookie: s.cookie } : {}), origin: "https://app.test", ...(s ? { "x-csrf-token": s.csrf } : {}), ...h } }), env);
  test("GET lists only the caller's grants + audit; another user sees none and cannot revoke", async () => {
    const x = mk(); await addGrant(x.env.DB, MAIN_OPEN, "web_read", "news.test"); await writeAudit(x.env.DB, MAIN_OPEN, { conversationId: "c", tool: "web_read", subject: "news.test", source: "user-grant", mode: "ask" });
    const main = await as(x.env, "example-user"), guest = await as(x.env, "guest-a");
    const jm = await (await go(x.app, x.env, main, "GET", "/api/approvals")).json() as any;
    expect(jm.autoAllowed).toBe(true); expect(jm.grants).toMatchObject([{ host: "news.test", tool: "web_read" }]); expect(jm.audit).toMatchObject([{ host: "news.test", source: "user-grant" }]);
    const jg = await (await go(x.app, x.env, guest, "GET", "/api/approvals")).json() as any; expect(jg.grants).toEqual([]); expect(jg.audit).toEqual([]);
    expect((await go(x.app, x.env, guest, "DELETE", "/api/approvals/grants/news.test")).status).toBe(404);
    expect([...await userHosts(x.env.DB, MAIN_OPEN)]).toEqual(["news.test"]);
    expect((await go(x.app, x.env, main, "DELETE", "/api/approvals/grants/news.test")).status).toBe(200);
    expect([...await userHosts(x.env.DB, MAIN_OPEN)]).toEqual([]);
  });
  test("unauthenticated 401; mutating without the CSRF token 403; cross-origin 403; bad host 400; there is no create endpoint", async () => {
    const x = mk(); await addGrant(x.env.DB, MAIN_OPEN, "web_read", "news.test"); const main = await as(x.env, "example-user");
    expect((await go(x.app, x.env, null, "GET", "/api/approvals")).status).toBe(401);
    expect((await go(x.app, x.env, null, "DELETE", "/api/approvals/grants/news.test")).status).toBe(401);
    expect((await x.app.fetch(new Request("https://app.test/api/approvals/grants/news.test", { method: "DELETE", headers: { cookie: main.cookie, origin: "https://app.test" } }), x.env)).status).toBe(403);
    expect((await x.app.fetch(new Request("https://app.test/api/approvals/grants/news.test", { method: "DELETE", headers: { cookie: main.cookie, "x-csrf-token": main.csrf, origin: "https://evil.example" } }), x.env)).status).toBe(403);
    expect((await go(x.app, x.env, main, "DELETE", "/api/approvals/grants/127.0.0.1")).status).toBe(400);
    for (const m of ["POST", "PUT", "PATCH"]) expect([404, 405]).toContain((await go(x.app, x.env, main, m, "/api/approvals/grants")).status);
    expect([...await userHosts(x.env.DB, MAIN_OPEN)]).toEqual(["news.test"]);
    expect((await go(x.app, x.env, main, "DELETE", "/api/approvals/grants")).status).toBe(200); expect([...await userHosts(x.env.DB, MAIN_OPEN)]).toEqual([]);
  });
  test("kill switch is reported to the page", async () => {
    const x = mk(); await setApprovalAuto(x.env.DB, GA, false); const guest = await as(x.env, "guest-a");
    expect(((await (await go(x.app, x.env, guest, "GET", "/api/approvals")).json()) as any).autoAllowed).toBe(false);
  });
});

// ---------- approval v2: Bypass (guarded), read-tool Ask, audit mode ----------
import { bypassTool, bypassWeb, REDIRECT_CARD_REASON } from "../src/approval";
const T = (name: string, approval = false): ToolDef => ({ ...WEBDEF(name), approval });
const TOOLS_V2: ToolDef[] = [T("web_read"), T("web_links"), T("save_note", true), T("delete_note", true), T("assign_task", true), T("ask_vertex", true), T("update_task", true), T("search_notes", true), T("get_note"),
  T("acme__get_items", true), T("acme__delete_item", true), T("acme__send_email", true), T("acme__frobnicate", true)];
const lastAudit = (r: Rig) => r.audits[r.audits.length - 1];
describe("bypassTool / bypassWeb (pure floor)", () => {
  test("allow-list by EXACT name: built-in read tools (not read_url), clean-chat save_note / update_task; everything else asks, whatever it is called", () => {
    for (const n of ["search_notes", "get_note", "list_projects", "check_tasks", "list_threads", "connector_usage", "fleet_status", "fleet_usage"]) { expect(bypassTool(n, { tainted: true }), n).toBe(true); }
    expect(bypassTool("read_url", { tainted: false })).toBe(false);
    expect(bypassTool("save_note", { tainted: false })).toBe(true); expect(bypassTool("save_note", { tainted: true })).toBe(false); expect(bypassTool("update_task", { tainted: true })).toBe(false);
    for (const n of ["delete_note", "delete_thread", "assign_task", "ask_vertex", "something_else", ""]) expect(bypassTool(n, { tainted: false }), n).toBe(false);
  });
  test("unknown or mislabelled names fall to ASK: read-looking prefixes, namespaced look-alikes of an allowed name, case/space tricks, a custom tool named like a built-in", () => {
    for (const n of ["get_items", "list_all", "search_everything", "read_file", "fetch_data", "find_user", "query_db", "lookup", "view_x", "describe_x", "show_x", "check_x", "get_note_and_delete", "acme__get_items", "acme__get_note", "acme__search_notes", "acme__frobnicate", "Get_Note", "get_note ", "get-note", "search_notes2", "x__save_note"])
      expect(bypassTool(n, { tainted: false }), n).toBe(false);
  });
  test("web: query strings on public hosts pass; IP / local / port / userinfo / blob / non-web do not", () => {
    expect(bypassWeb("web_read", { url: "https://news.test/a?q=hanoi+weather" })).toEqual({ host: "news.test" });
    for (const u of ["http://10.0.0.1/a", "http://127.0.0.1:8080/x", "https://printer.local/", "https://x.test:8443/a", "https://good.com@evil.test/", `https://x.test/?d=${"a".repeat(64)}`, "ftp://x.test/"]) expect(bypassWeb("web_read", { url: u })).toBeNull();
    expect(bypassWeb("save_note", { url: "https://x.test/" })).toBeNull();
  });
});
describe("engine: Bypass", () => {
  test("a query-string link from search results: Ask and Auto show a card, Bypass runs it with an audit row that records mode=bypass", async () => {
    const url = "https://news.test/a?q=hanoi";
    for (const mode of ["ask", "auto"] as const) { const r = rig(tainted([use("u2", "web_read", { url })]), { mode }); await r.engine.send(START, MODEL); expect(r.engine.state().awaiting).not.toBeNull(); expect(r.audits).toEqual([]); }
    const r = rig(tainted([use("u2", "web_read", { url })], [DONE]), { mode: "bypass" });
    await r.engine.send(START, MODEL);
    expect(r.engine.state().awaiting).toBeNull(); expect(r.ran).toEqual(["web_read:https://a.test/p", `web_read:${url}`]);
    expect(r.audits).toEqual([{ conversationId: "c1", tool: "web_read", subject: "news.test", source: "mode-bypass", mode: "bypass" }]);
    expect(evs(r, "approval_auto")).toMatchObject([{ id: "u2", source: "mode-bypass" }]);
    expect(r.order.slice(-2)).toEqual(["audit", "run:web_read"]);
  });
  test("Auto's audit row records mode=auto", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a" })], [DONE]), { mode: "auto" });
    await r.engine.send(START, MODEL); expect(lastAudit(r)).toMatchObject({ source: "mode-auto", mode: "auto" });
  });
  test("the floor holds in Bypass: raw IP, local name, odd port, userinfo, blob address and a redirecting page all still show a card", async () => {
    for (const url of ["http://192.168.1.5/admin", "https://nas.local/", "https://x.test:8443/a", "https://good.com@evil.test/", `https://x.test/?d=${"f".repeat(64)}`]) {
      const r = rig(tainted([use("u2", "web_read", { url })]), { mode: "bypass" }); await r.engine.send(START, MODEL);
      expect(r.engine.state().awaiting, url).not.toBeNull(); expect(r.audits, url).toEqual([]);
    }
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a?q=1" })]), { mode: "bypass", redirectOk: false });
    await r.engine.send(START, MODEL);
    expect(r.engine.state().awaiting).not.toBeNull(); expect(r.audits).toEqual([]); expect(evs(r, "approval_required")[0].calls[0].reason).toBe(REDIRECT_CARD_REASON);
  });
  test("an audit write that fails turns a Bypass call back into a card", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a?q=1" })]), { mode: "bypass", auditFails: true });
    await r.engine.send(START, MODEL); expect(r.engine.state().awaiting).not.toBeNull(); expect(r.ran).toEqual(["web_read:https://a.test/p"]);
  });
  test("the admin kill switch (approval_auto='0') turns Bypass off exactly like Auto", async () => {
    const r = rig(tainted([use("u2", "web_read", { url: "https://news.test/a?q=1" })]), { mode: "bypass", autoOn: false });
    await r.engine.send(START, MODEL); expect(r.engine.state().awaiting).not.toBeNull(); expect(r.audits).toEqual([]);
    const s = rig([() => sse(msg([use("n1", "save_note", { title: "t" })], "tool_use"))], { mode: "bypass", autoOn: false, tools: TOOLS_V2 });
    await s.engine.send("save a note", MODEL); expect(s.engine.state().awaiting).not.toBeNull(); expect(s.ran).toEqual([]);
  });
  test("a write (save_note) in a CLEAN chat runs in Bypass; in a tainted chat, or next to a web_read in the same batch, it still asks; Ask always asks", async () => {
    const clean = rig([() => sse(msg([use("n1", "save_note", { title: "t" })], "tool_use")), DONE], { mode: "bypass", tools: TOOLS_V2 });
    await clean.engine.send("save a note", MODEL); expect(clean.engine.state().awaiting).toBeNull(); expect(clean.ran).toEqual(["save_note:t"]); expect(lastAudit(clean)).toMatchObject({ tool: "save_note", source: "mode-bypass", mode: "bypass" });
    const ask = rig([() => sse(msg([use("n1", "save_note", { title: "t" })], "tool_use"))], { tools: TOOLS_V2 });
    await ask.engine.send("save a note", MODEL); expect(ask.engine.state().awaiting).not.toBeNull();
    const tainted1 = rig(tainted([use("n1", "save_note", { title: "t" })]), { mode: "bypass", tools: TOOLS_V2 });
    await tainted1.engine.send(START, MODEL); expect(tainted1.engine.state().awaiting).not.toBeNull(); expect(tainted1.ran).toEqual(["web_read:https://a.test/p"]);
    const sib = rig([() => sse(msg([use("w1", "web_read", { url: "https://a.test/p" }), use("n1", "save_note", { title: "t" })], "tool_use"))], { mode: "bypass", tools: TOOLS_V2 });
    await sib.engine.send(START, MODEL); expect(sib.engine.state().awaiting).not.toBeNull(); expect(sib.ran).toEqual(["web_read:https://a.test/p"]);
  });
  test("delete_note, assign_task, ask_vertex and a custom tool ALWAYS ask in Bypass, clean chat or not", async () => {
    for (const name of ["delete_note", "assign_task", "ask_vertex", "acme__delete_item", "acme__send_email"]) {
      const r = rig([() => sse(msg([use("x1", name, { title: "t" })], "tool_use"))], { mode: "bypass", tools: TOOLS_V2 });
      await r.engine.send("do it", MODEL); expect(r.engine.state().awaiting, name).not.toBeNull(); expect(r.ran, name).toEqual([]); expect(r.audits, name).toEqual([]);
    }
  });
  test("a built-in read tool the user set to Ask now shows a card in Ask/Auto and is auto-approved in Bypass; every custom connector tool asks", async () => {
    const ask = rig([() => sse(msg([use("r1", "search_notes", { title: "q" })], "tool_use"))], { tools: TOOLS_V2 });
    await ask.engine.send("find", MODEL); expect(ask.engine.state().awaiting).not.toBeNull();
    const byp = rig([() => sse(msg([use("r1", "search_notes", { title: "q" })], "tool_use")), DONE], { mode: "bypass", tools: TOOLS_V2 });
    await byp.engine.send("find", MODEL); expect(byp.engine.state().awaiting).toBeNull(); expect(byp.ran).toEqual(["search_notes:q"]);
    const noAsk = rig([() => sse(msg([use("r1", "get_note", { title: "q" })], "tool_use")), DONE], { tools: TOOLS_V2 }); // default Always: unchanged, no card
    await noAsk.engine.send("find", MODEL); expect(noAsk.engine.state().awaiting).toBeNull();
    for (const name of ["acme__get_items", "acme__frobnicate", "acme__get_note"]) { // every custom connector tool asks in Bypass, clean chat or not, read-looking or not
      for (const clean of [true, false]) {
        const r = rig(clean ? [() => sse(msg([use("c1", name, { title: "q" })], "tool_use"))] : tainted([use("c1", name, { title: "q" })]), { mode: "bypass", tools: TOOLS_V2 });
        await r.engine.send(clean ? "go" : START, MODEL); expect(r.engine.state().awaiting, `${name} clean=${clean}`).not.toBeNull(); expect(r.audits, name).toEqual([]);
      }
    }
    const url = rig([() => sse(msg([use("r1", "read_url", { url: "https://x.test/" })], "tool_use"))], { mode: "bypass", tools: [...TOOLS_V2, T("read_url", true)] }); // read_url keeps asking: it is an egress channel
    await url.engine.send("go", MODEL); expect(url.engine.state().awaiting).not.toBeNull();
  });
  test("mode: bypass is stored per chat, reported in state, a fresh chat (what a fork is) starts in Ask, and it is refused while a turn is running", async () => {
    const r = rig([DONE], { mode: "bypass" }); expect(r.engine.state().approvalMode).toBe("bypass");
    expect(r.engine.setApprovalMode("ask")).toEqual({ ok: true }); expect(r.engine.state().approvalMode).toBe("ask");
    expect(evs(r, "approval_mode").map((e) => e.mode)).toEqual(["bypass", "ask"]);
    expect(rig([DONE]).engine.state().approvalMode).toBe("ask");
  });
  test("a persisted Bypass whose confirmation version is missing/older is Ask (stale consent), persistently, with an approval_mode event; a current one survives", async () => {
    const r = rig([DONE], { mode: "bypass" });
    expect(r.engine.state().approvalMode).toBe("bypass"); expect(r.engine.meta("bypass_version")).toBe(String(BYPASS_CONFIRM_VERSION));
    r.engine.setMeta("bypass_version", String(BYPASS_CONFIRM_VERSION - 1)); // the required version was bumped since the consent (what a DO wake after a deploy reads)
    expect(r.engine.state().approvalMode).toBe("ask"); expect(r.engine.meta("approval_mode")).toBeNull();
    expect(evs(r, "approval_mode").map((e) => e.mode)).toEqual(["bypass", "ask"]);
    expect(r.engine.approvalMode()).toBe("ask"); expect(evs(r, "approval_mode").length).toBe(2); // told once
    const old = rig([DONE], { mode: "bypass" }); old.engine.setMeta("bypass_version", null); // a chat from before the version was recorded
    expect(old.engine.approvalMode()).toBe("ask");
  });
  test("writeAudit stores the mode that approved: ask (grant), auto and bypass rows read back with exactly that mode", async () => {
    const { D, db } = d1();
    await writeAudit(D, MAIN_OPEN, { conversationId: "c1", tool: "web_read", subject: "a.test", source: "chat-grant", mode: "ask" });
    await writeAudit(D, MAIN_OPEN, { conversationId: "c1", tool: "web_read", subject: "b.test", source: "mode-auto", mode: "auto" });
    await writeAudit(D, MAIN_OPEN, { conversationId: "c1", tool: "web_read", subject: "c.test", source: "mode-bypass", mode: "bypass" });
    expect((db.query(`SELECT subject, mode FROM approval_audit ORDER BY id`).all() as any[]).map((x) => `${x.subject}:${x.mode}`)).toEqual(["a.test:ask", "b.test:auto", "c.test:bypass"]);
    expect((await listAudit(D, MAIN_OPEN)).map((x) => x.mode).sort()).toEqual(["ask", "auto", "bypass"]);
  });
  test("strict fail closed: without the mode column (0035 not applied) the audit write throws, no row, nothing silently written without the mode", async () => {
    const db = new Database(":memory:");
    for (const f of MIGS.filter((f) => !f.startsWith("0035"))) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    const D = { prepare: (q: string) => { const st = (b: unknown[]): any => ({ bind: (...v: unknown[]) => st(v), run: async () => { db.query(q).run(...(b as any)); return { meta: {} }; } }); return st([]); } } as unknown as D1Database;
    await expect(writeAudit(D, MAIN_OPEN, { conversationId: "c", tool: "web_read", subject: "a.test", source: "mode-auto", mode: "auto" })).rejects.toThrow();
    expect((db.query(`SELECT COUNT(*) AS n FROM approval_audit`).get() as any).n).toBe(0);
  });
  test("migrations 0001..0035 apply in order on a fresh sqlite (0035's plain ALTER runs once per DB) and 0035 adds approval_audit.mode", () => {
    expect(MIGS[0]).toMatch(/^0001/); expect(MIGS.some((f) => f.startsWith("0035"))).toBe(true);
    const db = new Database(":memory:");
    for (const f of MIGS) expect(() => db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8")), f).not.toThrow();
    expect((db.query(`PRAGMA table_info(approval_audit)`).all() as any[]).some((c) => c.name === "mode")).toBe(true);
  });
  test("recordBypassConfirm stores who (scope) / when / which chat / text version; a D1 failure throws", async () => {
    const { D, db } = d1();
    await recordBypassConfirm(D, MAIN_OPEN, "conv-1", BYPASS_CONFIRM_VERSION, 1234);
    const row = db.query(`SELECT name, value FROM settings WHERE name LIKE 'bypass_confirm:%'`).get() as any;
    expect(row.name).toBe(`bypass_confirm:${MAIN_OPEN}:conv-1`); expect(JSON.parse(row.value)).toEqual({ at: 1234, version: BYPASS_CONFIRM_VERSION, scope: MAIN_OPEN, conversationId: "conv-1" });
    db.exec("DROP TABLE settings"); await expect(recordBypassConfirm(D, MAIN_OPEN, "conv-1", 1)).rejects.toThrow();
  });
});
