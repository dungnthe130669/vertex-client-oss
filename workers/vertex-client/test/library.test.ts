// Library: GET /api/library (scope isolation, paging, filters, cursor validation) + the pure pieces behind Export and in-chat search.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession, type Session } from "../src/auth";
import { scopeOfSession, type Scope, type GuestScope } from "../src/scope";
import { classifyGenKey, makeCursor, parseCursor } from "../src/library";
import { exportFileName, exportJson, exportMarkdown, findRanges, libQuery, libUrl, matchPlan, stepMatch, visibleMessages } from "../web/src/library-logic";
import type { Msg } from "../web/src/chat-state";

const ORIGIN = "https://app.test";
const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
const seam = (s: Session): Scope => (s.u === "guest-a" ? GA : scopeOfSession(s));
const app = createApp({ scopeOf: seam });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  });
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async () => [] } as unknown as D1Database };
}
/** R2 stand-in: list() honours prefix + limit and reports uploaded/size like the real binding. */
const bucket = () => {
  const m = new Map<string, { up: number; size: number }>();
  const listed: string[] = [];
  const b = { list: async (o?: any) => { listed.push(o?.prefix ?? ""); return { objects: [...m.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "")).sort(([a], [b2]) => (a < b2 ? -1 : 1)).map(([key, v]) => ({ key, uploaded: new Date(v.up), size: v.size })), truncated: false }; } } as unknown as R2Bucket;
  return { m, b, listed, add: (conv: string, name: string, up: number, size = 10) => m.set(`vertex-client/${conv}/gen/${name}`, { up, size }) };
};
const seedConv = (db: Database, id: string, scope: string, title = "t", updated = "2026-10-01 00:00:00") => db.query(`INSERT INTO conversations (id, model, scope, title, updated_at) VALUES (?,?,?,?,?)`).run(id, "m", scope, title, updated);
const mk = () => { const x = d1(), bk = bucket(); const env = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k", E2E_TOKEN: "e".repeat(40), ASSETS: { fetch: async () => new Response("x") }, DB: x.d1, FILES: bk.b } as unknown as Env; return { env, db: x.db, bk }; };
const login = async (env: Env, user: string) => { const { cookie } = await makeSession(env, user, "github"); return cookie.split(";")[0]; };
const get = (env: Env, cookie: string, path: string) => app.fetch(new Request(ORIGIN + path, { headers: { cookie, origin: ORIGIN } }), env);
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

describe("GET /api/library", () => {
  test("lists only the caller's scope, newest first, with type + title + tail ref", async () => {
    const { env, db, bk } = mk();
    seedConv(db, uuid(1), "main", "Mine"); seedConv(db, uuid(2), GA, "Theirs");
    bk.add(uuid(1), "a.png", T0 + 1000); bk.add(uuid(1), "b.mp4", T0 + 3000); bk.add(uuid(1), "c.webp", T0 + 2000); bk.add(uuid(2), "guest.png", T0 + 9000);
    const main = await login(env, "example-user"), guest = await login(env, "guest-a");
    const r = await (await get(env, main, "/api/library")).json() as any;
    expect(r.items.map((i: any) => [i.ref, i.type, i.title, i.conv])).toEqual([["gen/b.mp4", "video", "Mine", uuid(1)], ["gen/c.webp", "image", "Mine", uuid(1)], ["gen/a.png", "image", "Mine", uuid(1)]]);
    expect(r.next).toBeNull();
    const g = await (await get(env, guest, "/api/library")).json() as any;
    expect(g.items.map((i: any) => i.ref)).toEqual(["gen/guest.png"]);
    expect(bk.listed.some((p) => p.includes(uuid(2)))).toBe(true); // guest listed its own conversation...
    bk.listed.length = 0; await get(env, main, "/api/library");
    expect(bk.listed.every((p) => p.includes(uuid(1)))).toBe(true); // ...and main never listed a foreign prefix
  });
  test("a conversation id of another scope in R2 is never returned (even with media present)", async () => {
    const { env, db, bk } = mk();
    seedConv(db, uuid(3), GA); bk.add(uuid(3), "x.png", T0);
    const r = await (await get(env, await login(env, "example-user"), "/api/library")).json() as any;
    expect(r.items).toEqual([]);
  });
  test("type filter, bad type 400, bad cursor 400, anonymous 401, no bucket 503", async () => {
    const { env, db, bk } = mk();
    seedConv(db, uuid(1), "main"); bk.add(uuid(1), "a.png", T0); bk.add(uuid(1), "b.mp4", T0 + 1);
    const c = await login(env, "example-user");
    expect(((await (await get(env, c, "/api/library?type=video")).json()) as any).items.map((i: any) => i.type)).toEqual(["video"]);
    expect(((await (await get(env, c, "/api/library?type=image")).json()) as any).items.map((i: any) => i.type)).toEqual(["image"]);
    expect((await get(env, c, "/api/library?type=audio")).status).toBe(400);
    expect((await get(env, c, "/api/library?before=garbage")).status).toBe(400);
    expect((await get(env, c, `/api/library?before=${encodeURIComponent("1~vertex-client/../x/gen/a.png")}`)).status).toBe(400);
    expect((await app.fetch(new Request(ORIGIN + "/api/library"), env)).status).toBe(401);
    expect((await get({ ...(env as any), FILES: undefined } as Env, c, "/api/library")).status).toBe(503);
  });
  test("pages of 60 with a cursor, no duplicates, no gaps, across conversations", async () => {
    const { env, db, bk } = mk();
    for (let c = 1; c <= 3; c++) seedConv(db, uuid(c), "main", `c${c}`, `2026-10-0${c} 00:00:00`);
    // 130 images: ms strictly increasing, interleaved across the three conversations
    for (let i = 0; i < 130; i++) bk.add(uuid((i % 3) + 1), `${String(i).padStart(3, "0")}.png`, T0 + i * 1000);
    const c = await login(env, "example-user");
    const seen: string[] = []; let before = ""; let pages = 0;
    for (;;) {
      const r = await (await get(env, c, `/api/library${before ? `?before=${encodeURIComponent(before)}` : ""}`)).json() as any;
      pages++; expect(r.items.length).toBeLessThanOrEqual(60);
      seen.push(...r.items.map((i: any) => i.ref));
      if (!r.next) break; before = r.next;
    }
    expect(pages).toBe(3);
    expect(seen.length).toBe(130);
    expect(new Set(seen).size).toBe(130);
    expect(seen[0]).toBe("gen/129.png"); expect(seen[129]).toBe("gen/000.png");
  });
  test("non-generated or unknown objects under the prefix are ignored", async () => {
    const { env, db, bk } = mk();
    seedConv(db, uuid(1), "main"); bk.add(uuid(1), "a.png", T0); bk.add(uuid(1), "notes.txt", T0 + 1); bk.add(uuid(1), "noext", T0 + 2);
    const r = await (await get(env, await login(env, "example-user"), "/api/library")).json() as any;
    expect(r.items.map((i: any) => i.ref)).toEqual(["gen/a.png"]);
  });
  test("cursor + key helpers", () => {
    const k = `vertex-client/${uuid(1)}/gen/a.png`;
    expect(parseCursor(makeCursor(5, k))).toEqual({ ms: 5, key: k });
    expect(parseCursor(undefined)).toBeUndefined(); expect(parseCursor("")).toBeUndefined();
    expect(parseCursor("5~vertex-client/x/gen/a.png")).toBeNull();
    expect(classifyGenKey("a/b.MP4")?.type).toBe("video"); expect(classifyGenKey("a.gif")).toBeNull();
  });
});

describe("library client helpers", () => {
  test("url + query building", () => {
    expect(libUrl({ conv: uuid(1), ref: "gen/a b.png" })).toBe(`/api/conversations/${uuid(1)}/files/gen/a%20b.png`);
    expect(libQuery("", null)).toBe("/api/library");
    expect(libQuery("image", "5~k")).toBe("/api/library?type=image&before=5%7Ek");
  });
});

describe("in-chat search matcher", () => {
  test("case-insensitive, non-overlapping, blank = nothing", () => {
    expect(findRanges("Hello hello HELLO", "hello")).toEqual([[0, 5], [6, 11], [12, 17]]);
    expect(findRanges("aaaa", "aa")).toEqual([[0, 2], [2, 4]]);
    expect(findRanges("abc", "  ")).toEqual([]);
    expect(findRanges("abc", "x")).toEqual([]);
    expect(findRanges("İstanbul", "i")).toEqual([]); // lowercase changes the length: refuse rather than mis-highlight
  });
  test("plan flattens per node in order; stepping wraps", () => {
    const p = matchPlan(["a b a", "none", "A"], "a");
    expect(p.flat).toEqual([{ node: 0, range: [0, 1] }, { node: 0, range: [4, 5] }, { node: 2, range: [0, 1] }]);
    expect(stepMatch(-1, 3, 1)).toBe(0); expect(stepMatch(-1, 3, -1)).toBe(2); expect(stepMatch(2, 3, 1)).toBe(0); expect(stepMatch(0, 3, -1)).toBe(2); expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});

const msg = (id: number, role: "user" | "assistant", content: any[]): Msg => ({ id, role, content, model: role === "assistant" ? "claude-x" : null, usage: null, costUsd: null, stopReason: null, status: "complete", ttftMs: null, totalMs: null, createdAt: T0 + id });
describe("export", () => {
  const msgs = [
    msg(1, "user", [{ type: "text", text: "Hi\nthere" }, { type: "file_ref", name: "notes.pdf", mime: "application/pdf", ref: `vertex-client/${uuid(9)}/abc-notes.pdf` }]),
    msg(2, "assistant", [{ type: "thinking", thinking: "secret chain of thought" }, { type: "tool_use", id: "t1", name: "web_search", input: { q: "x" } }]),
    msg(3, "user", [{ type: "tool_result", tool_use_id: "t1", content: "RESULT BODY" }]),
    msg(4, "assistant", [{ type: "text", text: "Answer **here**" }, { type: "gen_image", ref: `vertex-client/${uuid(9)}/gen/z.png`, mime: "image/png", prompt: "a cat", model: "m" }]),
  ];
  test("visible conversation only; markdown names attachments and leaks no refs, ids or hidden blocks", () => {
    expect(visibleMessages(msgs).map((m) => m.id)).toEqual([1, 2, 4]);
    const md = exportMarkdown("My: chat", msgs, new Date("2026-10-20T00:00:00Z"));
    expect(md).toContain("# My: chat"); expect(md).toContain("## You"); expect(md).toContain("Attachments: notes.pdf"); expect(md).toContain("Answer **here**"); expect(md).toContain("> Generated image: a cat"); expect(md).toContain("> Tool: web_search");
    for (const bad of ["vertex-client/", uuid(9), "secret chain of thought", "RESULT BODY"]) expect(md).not.toContain(bad);
  });
  test("json is valid, same visibility rules, attachments by name", () => {
    const j = JSON.parse(exportJson("T", msgs, new Date("2026-10-20T00:00:00Z")));
    expect(j.messages.length).toBe(3); expect(j.messages[0].attachments).toEqual(["notes.pdf"]); expect(j.messages[0].role).toBe("user");
    const raw = JSON.stringify(j);
    for (const bad of ["vertex-client/", uuid(9), "secret chain of thought", "RESULT BODY"]) expect(raw).not.toContain(bad);
  });
  test("file names are safe and never empty", () => {
    const d = new Date("2026-10-20T10:00:00Z");
    expect(exportFileName("a/b\\c: d?", "md", d)).toBe("a-b-c-d-2026-10-20.md");
    expect(exportFileName("   ", "json", d)).toBe("chat-2026-10-20.json");
    expect(exportFileName("../../etc", "md", d)).not.toContain("/");
  });
});
