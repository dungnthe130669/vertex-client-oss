// Fault injection (M6): break ONE dependency at a time and assert the app degrades with a clear message and without losing data.
// Every group has a healthy control, so a suite that only ever fails (or an injection that injects nothing) cannot pass unnoticed.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession } from "../src/auth";
import { startLive } from "../web/src/cloud-ws";

const ORIGIN = "https://app.test", SECRET = "spike-secret-value-0123456789", REPO = "example-user/example-repo";
function d1(failOn?: () => RegExp | null) {
  const db = new Database(":memory:");
  for (const f of ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0018_projects.sql", "0037_cloud_runs_pr.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const boom = (q: string) => { const re = failOn?.(); if (re && re.test(q)) throw new Error("D1_ERROR: injected"); };
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => { boom(q); return (db.query(q).get(...(b as any)) as any) ?? null; },
    all: async () => { boom(q); return { results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }; },
    run: async () => { boom(q); db.query(q).run(...(b as any)); return { results: [], success: true, meta: {} }; },
  } as any);
  return { db, d1: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; } } as D1Database };
}
const CHAT = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ seq: 0, messages: [] }) }) } as unknown as DurableObjectNamespace;
function rig(spike: (path: string, method: string) => Response | Promise<Response>, failOn?: () => RegExp | null) {
  const x = d1(failOn);
  const agent = { fetch: async (url: string, init: RequestInit) => spike(new URL(url).pathname.replace("/internal/v1", ""), init.method ?? "GET") } as unknown as Fetcher;
  const env = { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user", GATEWAY_KEY: "k", AGENT: agent, AGENT_INTERNAL_SECRET: SECRET, CLOUD_REPOS: REPO,
    ASSETS: { fetch: async () => new Response("x") }, GATEWAY: { fetch: async () => new Response("{}") }, DB: x.d1, CHAT } as unknown as Env;
  return { env, db: x.db };
}
const app = createApp();
async function call(env: Env, path: string, json?: unknown) {
  const { cookie, session } = await makeSession(env, "example-user", "github");
  const h = new Headers({ cookie: cookie.split(";")[0], origin: ORIGIN });
  const method = json !== undefined ? "POST" : "GET";
  if (method === "POST") { h.set("x-csrf-token", session.csrf); h.set("content-type", "application/json"); }
  return app.fetch(new Request(ORIGIN + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined }), env);
}
const healthy = (p: string, m: string) => m === "POST" && p === "/tasks" ? Response.json({ id: "0000000000000001", branch: "agent/x" }, { status: 201 }) : Response.json({ status: "running", id: "0000000000000001" });
const runs = (db: Database) => (db.query(`SELECT COUNT(*) n FROM cloud_runs`).get() as any).n;

describe("fault: agent-spike", () => {
  test("control: healthy spike creates the run and records it", async () => {
    const { env, db } = rig(healthy);
    expect((await call(env, "/api/cloud/runs", { repo: REPO, instruction: "do it" })).status).toBe(201);
    expect(runs(db)).toBe(1);
  });
  test("503 on create: clear error, no ghost run row", async () => {
    const { env, db } = rig(() => new Response("upstream down", { status: 503 }));
    const r = await call(env, "/api/cloud/runs", { repo: REPO, instruction: "do it" });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(typeof ((await r.json()) as any).error).toBe("string");
    expect(runs(db)).toBe(0);
  });
  test("unreachable (throws) on create: still a JSON error, not a crash", async () => {
    const { env, db } = rig(() => { throw new Error("network"); });
    const r = await call(env, "/api/cloud/runs", { repo: REPO, instruction: "do it" });
    expect(r.status).toBeGreaterThanOrEqual(500); expect(r.headers.get("content-type")).toContain("json");
    expect(runs(db)).toBe(0);
  });
  test("503 after the run exists: detail says 'unavailable', run row and list survive, events answer 5xx the UI retries", async () => {
    let down = false;
    const { env, db } = rig((p, m) => (down ? new Response("x", { status: 503 }) : healthy(p, m)));
    await call(env, "/api/cloud/runs", { repo: REPO, instruction: "do it" });
    down = true;
    const d = (await (await call(env, "/api/cloud/runs/0000000000000001")).json()) as any;
    expect(d.error).toBe("agent-spike unavailable"); expect(d.state).toBeNull(); expect(d.run.id).toBe("0000000000000001");
    expect((await call(env, "/api/cloud/runs/0000000000000001/events?after=3")).status).toBeGreaterThanOrEqual(500);
    expect(((await (await call(env, "/api/cloud/runs")).json()) as any).runs.length).toBe(1);
    expect(runs(db)).toBe(1);
  });
});

describe("fault: D1", () => {
  test("control: conversations list works", async () => {
    const { env } = rig(healthy);
    expect((await call(env, "/api/conversations")).status).toBe(200);
  });
  test("D1 error: generic 500 JSON (no SQL/stack leaked), other routes and the session keep working", async () => {
    let fail: RegExp | null = /FROM conversations/i;
    const { env } = rig(healthy, () => fail);
    const r = await call(env, "/api/conversations");
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).toContain("internal error"); expect(body).not.toContain("D1_ERROR"); expect(body).not.toContain("SELECT");
    expect((await call(env, "/api/me")).status).toBe(200);
    fail = null; // D1 recovers: the very next request succeeds, nothing was poisoned
    expect((await call(env, "/api/conversations")).status).toBe(200);
  });
  test("D1 error while recording a created run: the user is told, and the failure is not reported as success", async () => {
    const { env } = rig(healthy, () => /INSERT INTO cloud_runs/i);
    const r = await call(env, "/api/cloud/runs", { repo: REPO, instruction: "do it" });
    expect(r.status).toBe(500);
  });
});

describe("fault: live run transport (WS drop / polling failure)", () => {
  class FakeWS {
    static last: FakeWS | null = null; static refuse = false;
    onopen: any; onmessage: any; onclose: any; onerror: any; closed = false;
    constructor(public url: string) { FakeWS.last = this; queueMicrotask(() => { if (FakeWS.refuse) this.onclose?.({ code: 1006 }); else this.onopen?.(); }); }
    frame(seq: number) { this.onmessage?.({ data: JSON.stringify({ seq, ts: 1, kind: "text", data: { text: "t" + seq } }) }); }
    close() { this.closed = true; }
  }
  (globalThis as any).location ??= { protocol: "https:", host: "app.test" };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function live(poll: any, over: any = {}) {
    const got: number[] = [], problems: (string | null)[] = []; let after = -1;
    const l = startLive({ id: "x", getAfter: () => after, onEvents: (e) => e.forEach((x: any) => { if (x.seq > after) { after = x.seq; got.push(x.seq); } }), onTick: () => {}, poll, onProblem: (m) => problems.push(m), pollMs: 5, wsRetryMs: 5, WS: FakeWS as any, ...over });
    return { l, got, problems };
  }
  test("control: healthy socket delivers frames in order and never polls", async () => {
    FakeWS.refuse = false; let polled = 0;
    const { l, got } = live(async () => { polled++; return { events: [] }; });
    await wait(5); FakeWS.last!.frame(0); FakeWS.last!.frame(1);
    expect(got).toEqual([0, 1]); expect(polled).toBe(0); l.stop();
  });
  test("socket drops mid-stream: polling catches up from the last seq, no duplicates, no loss", async () => {
    FakeWS.refuse = false; const seen: number[] = [];
    const { l, got } = live(async (after: number) => { seen.push(after); return { events: [1, 2, 3].filter((s) => s > after).map((seq) => ({ seq, ts: 1, kind: "text", data: {} })) }; });
    await wait(5); FakeWS.last!.frame(0); FakeWS.last!.frame(1);
    FakeWS.last!.onclose({ code: 1006 }); // drop
    await wait(30);
    expect(got).toEqual([0, 1, 2, 3]); expect(seen[0]).toBe(1); l.stop();
  });
  test("socket refused twice: falls back to polling for good", async () => {
    FakeWS.refuse = true; let polls = 0;
    const { l, got } = live(async () => { polls++; return { events: polls === 1 ? [{ seq: 0, ts: 1, kind: "text", data: {} }] : [] }; });
    await wait(60);
    expect(got).toEqual([0]); expect(polls).toBeGreaterThan(1); l.stop();
  });
  test("polling fails then recovers: a visible message appears, then clears, and the loop survives the throw", async () => {
    FakeWS.refuse = true; let n = 0;
    const { l, got, problems } = live(async () => { n++; if (n <= 2) throw new Error("offline"); return { events: n === 3 ? [{ seq: 0, ts: 1, kind: "text", data: {} }] : [] }; });
    await wait(150);
    expect(problems.some((p) => p && /interrupted/.test(p))).toBe(true);
    expect(problems[problems.length - 1]).toBeNull(); expect(got).toEqual([0]); l.stop();
  });
});
