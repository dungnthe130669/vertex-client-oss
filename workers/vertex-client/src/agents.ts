// Agents mode: proxy to agent-spike's named persistent agents (/internal/v1/agents, service binding AGENT). The browser never sees the
// secret. agent-spike has no per-user filter and agent names are global, so scope is the name: `e2e-*` belongs to the e2e user,
// everything else to Erich (incl. agents other sessions created). A name outside the caller's scope is a plain 404 before any call.
import type { Context, Hono } from "hono";
import { guardPrefix, type Scope } from "./scope";
import type { Env } from "./index";
import { pushTo, type PushPayload } from "./push";
import { recordNotification } from "./notifications";

const NAME = /^[a-z0-9][a-z0-9._-]{1,39}$/;
const CURSOR = /^[bs][0-9a-f]{15}:-?\d{1,9}$/;
const SESSION_ID = /^[bs][0-9a-f]{15}$/;
const E2E_PREFIX = "e2e-";
export const AGENT_IMAGES = ["base", "video", "opencode", "browser"] as const;
export const AGENT_EXECUTORS = ["auto", "proxmox", "cloudflare"] as const;
const E2E_BASE = /^spike-base\//;
const BASE = /^[A-Za-z0-9._\/-]{1,100}$/;
const RECENT_VIEW_MS = 20_000;

export const inScope = (scope: string, name: string) => NAME.test(name) && (scope === "main" ? !name.startsWith(E2E_PREFIX) : name.startsWith(E2E_PREFIX));

/** sleeping | awake | running — derived from agent-spike's phase + session status. */
export function agentState(a: { phase?: string; session?: { status?: string } | null }): "running" | "awake" | "sleeping" {
  if (a.phase === "task") return "running";
  const s = a.session?.status;
  return s === "idle" || s === "running" || s === "starting" ? "awake" : "sleeping";
}

type Ctx = Context<{ Bindings: Env; Variables: { session: import("./auth").Session } }>;
type Agent = { name: string; repo: string; phase?: string; session?: { id?: string; status?: string } | null; executor?: string; lastDone?: number | null; lastWake?: number | null; lastActivity?: number | null; costUsd?: number };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Feed the Usage screen: record how far agent-spike's own lifetime total (`costUsd`, all sessions) is ahead of what cloud_costs already holds. */
export async function syncAgentCost(db: D1Database, scope: string, a: Agent): Promise<number> {
  const cur = num(a.costUsd);
  const have = (await db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM cloud_costs WHERE scope=? AND run_id=?`).bind(scope, `agent:${a.name}`).first<{ c: number }>().catch(() => null))?.c ?? 0;
  const delta = cur - have;
  if (delta > 1e-9) await db.prepare(`INSERT INTO cloud_costs (run_id, executor, cost_usd, scope) VALUES (?,?,?,?)`).bind(`agent:${a.name}`, a.executor ?? "auto", delta, scope).run().catch((e) => console.error("agent cost", String(e)));
  return cur;
}

export function agentRoutes(app: Hono<{ Bindings: Env; Variables: { session: import("./auth").Session } }>, scopeOf: (c: Ctx) => Scope, repoList: (env: Env) => string[]) {
  guardPrefix(app, "/api/agents", scopeOf); // Erich-only: main (and the e2e tester); every other scope gets 403 before any handler
  const enabled = (c: Ctx) => !!(c.env.AGENT && c.env.AGENT_INTERNAL_SECRET);
  const spike = (c: Ctx, path: string, init?: { method?: string; body?: unknown; upgrade?: boolean }) => {
    if (!enabled(c)) return Promise.resolve(null);
    return c.env.AGENT!.fetch(`https://agent-spike.internal/internal/v1${path}`, {
      method: init?.method ?? "GET",
      headers: { "x-internal-secret": c.env.AGENT_INTERNAL_SECRET!, "x-actor": `vertex-client:${c.get("session").u}`.slice(0, 80), ...(init?.body !== undefined ? { "content-type": "application/json" } : {}), ...(init?.upgrade ? { upgrade: "websocket" } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  };
  const jsonOf = async (r: Response | null): Promise<any> => (r ? r.json().catch(() => null) : null);
  const relay = async (r: Response) => new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const off = (c: Ctx) => c.json({ error: "agents are not configured" }, 503);
  const unavailable = (c: Ctx) => c.json({ error: "agent-spike unavailable" }, 502);
  /** The agent name from the URL, only if it is in the caller's scope. */
  const nameOf = (c: Ctx) => { const n = c.req.param("name") ?? ""; return inScope(scopeOf(c), n) ? n : null; };
  const touch = (c: Ctx, name: string) => c.env.DB.prepare(`INSERT INTO agent_watch (name, seen_at, watermark) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET seen_at=excluded.seen_at, watermark=CASE WHEN watermark=0 THEN excluded.watermark ELSE watermark END`).bind(name, Date.now(), Date.now()).run().catch(() => null);
  const text = (b: Record<string, unknown>, max = 8000) => (typeof b.text === "string" && b.text.trim() && b.text.length <= max ? b.text : null);

  app.get("/api/agents/config", (c) => c.json({ enabled: enabled(c), repos: repoList(c.env), images: AGENT_IMAGES, executors: AGENT_EXECUTORS, namePrefix: scopeOf(c) === "main" ? "" : E2E_PREFIX, e2eBasePrefix: scopeOf(c) === "main" ? null : "spike-base/" }));

  app.get("/api/agents", async (c) => {
    if (!enabled(c)) return c.json({ enabled: false, agents: [] });
    const sc = scopeOf(c);
    const r = await spike(c, "/agents").catch(() => null), j = await jsonOf(r);
    if (!r || r.status !== 200 || !Array.isArray(j?.agents)) return unavailable(c);
    const rows = (j.agents as Agent[]).filter((a) => a?.name && inScope(sc, a.name));
    await Promise.all(rows.map((a) => syncAgentCost(c.env.DB, sc, a)));
    return c.json({ enabled: true, agents: rows.map((a) => ({ ...a, state: agentState(a), costUsd: num(a.costUsd) })) });
  });

  app.post("/api/agents", async (c) => {
    if (!enabled(c)) return off(c);
    const sc = scopeOf(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!inScope(sc, name)) return c.json({ error: sc === "main" ? "name must match [a-z0-9][a-z0-9._-]{1,39} and not start with e2e-" : `name must start with ${E2E_PREFIX}` }, 400);
    const repo = typeof b.repo === "string" ? b.repo : "";
    if (!repoList(c.env).includes(repo)) return c.json({ error: "repo is not in the allowlist" }, 403);
    const base = typeof b.base === "string" && b.base.trim() ? b.base.trim() : undefined;
    if (base !== undefined && (!BASE.test(base) || base.includes(".."))) return c.json({ error: "bad base branch" }, 400);
    if (sc !== "main" && !(base && E2E_BASE.test(base))) return c.json({ error: "this user may only use spike-base/* bases" }, 403);
    const image = typeof b.image === "string" && (AGENT_IMAGES as readonly string[]).includes(b.image) ? b.image : "base";
    const executor = typeof b.executor === "string" && (AGENT_EXECUTORS as readonly string[]).includes(b.executor) ? b.executor : "auto";
    const instructions = typeof b.instructions === "string" ? b.instructions.slice(0, 20_000) : undefined;
    const r = await spike(c, "/agents", { method: "POST", body: { name, repo, ...(base ? { base } : {}), image, executor, ...(instructions ? { instructions } : {}) } }).catch(() => null);
    if (!r) return unavailable(c);
    if (r.status === 201) await touch(c, name);
    return relay(r);
  });

  app.get("/api/agents/:name", async (c) => {
    const name = nameOf(c); if (!name) return c.json({ error: "not found" }, 404);
    if (!enabled(c)) return off(c);
    await touch(c, name);
    const [a, i, s] = await Promise.all([spike(c, `/agents/${name}`), spike(c, `/agents/${name}/inbox?limit=50`), spike(c, `/agents/${name}/schedules`)].map((p) => p.catch(() => null)));
    if (a && a.status === 404) return c.json({ error: "not found" }, 404);
    const agent = a && a.status === 200 ? await jsonOf(a) : null;
    if (!agent) return unavailable(c);
    await syncAgentCost(c.env.DB, scopeOf(c), agent);
    const msgs: any[] = (await jsonOf(i))?.messages ?? [];
    return c.json({ agent: { ...agent, state: agentState(agent), costUsd: num(agent.costUsd) }, inbox: msgs.slice().reverse(), schedules: (await jsonOf(s))?.schedules ?? [] });
  });

  app.patch("/api/agents/:name", async (c) => {
    const name = nameOf(c); if (!name) return c.json({ error: "not found" }, 404);
    if (!enabled(c)) return off(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof b.repo === "string") { if (!repoList(c.env).includes(b.repo)) return c.json({ error: "repo is not in the allowlist" }, 403); out.repo = b.repo; }
    if (typeof b.base === "string") {
      const base = b.base.trim();
      if (base && (!BASE.test(base) || base.includes(".."))) return c.json({ error: "bad base branch" }, 400);
      if (scopeOf(c) !== "main" && !E2E_BASE.test(base)) return c.json({ error: "this user may only use spike-base/* bases" }, 403);
      out.base = base;
    }
    if (typeof b.image === "string") { if (!(AGENT_IMAGES as readonly string[]).includes(b.image)) return c.json({ error: "bad image" }, 400); out.image = b.image; }
    if (typeof b.executor === "string") { if (!(AGENT_EXECUTORS as readonly string[]).includes(b.executor)) return c.json({ error: "bad executor" }, 400); out.executor = b.executor; }
    if (typeof b.instructions === "string") out.instructions = b.instructions.slice(0, 20_000);
    const r = await spike(c, `/agents/${name}`, { method: "PATCH", body: out }).catch(() => null);
    return r ? relay(r) : unavailable(c);
  });

  app.delete("/api/agents/:name", async (c) => {
    const name = nameOf(c); if (!name) return c.json({ error: "not found" }, 404);
    if (!enabled(c)) return off(c);
    const r = await spike(c, `/agents/${name}?purge`, { method: "DELETE" }).catch(() => null);
    if (!r) return unavailable(c);
    if (r.status < 300) await c.env.DB.prepare(`DELETE FROM agent_watch WHERE name=?`).bind(name).run().catch(() => null);
    return relay(r);
  });

  app.post("/api/agents/:name/inbox", async (c) => {
    const name = nameOf(c); if (!name) return c.json({ error: "not found" }, 404);
    if (!enabled(c)) return off(c);
    const t = text((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
    if (!t) return c.json({ error: "text required (max 8000 chars)" }, 400);
    const r = await spike(c, `/agents/${name}/inbox`, { method: "POST", body: { text: t, from: `vertex-client:${c.get("session").u}`.slice(0, 60), reply: true } }).catch(() => null);
    if (!r) return unavailable(c);
    const j = await jsonOf(r);
    if (r.status < 300 && typeof j?.id === "string") await touch(c, name);
    return c.json(j ?? { error: "bad response" }, r.status as 200);
  });

  for (const a of ["wake", "sleep", "rollover"] as const) {
    app.post(`/api/agents/:name/${a}`, async (c) => {
      const name = nameOf(c); if (!name) return c.json({ error: "not found" }, 404);
      if (!enabled(c)) return off(c);
      const r = await spike(c, `/agents/${name}/${a}`, { method: "POST", body: {} }).catch(() => null);
      if (!r) return unavailable(c);
      if (a === "wake" && r.status < 300) await touch(c, name);
      return relay(r);
    });
  }

  app.post("/api/agents/:name/schedules", async (c) => {
    const name = nameOf(c); if (!name) return c.json({ error: "not found" }, 404);
    if (!enabled(c)) return off(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const t = text(b); if (!t) return c.json({ error: "text required (max 8000 chars)" }, 400);
    const when: Record<string, unknown> = {};
    for (const k of ["delaySecs", "everySecs"] as const) if (b[k] !== undefined) { const v = Number(b[k]); if (!Number.isFinite(v) || v <= 0) return c.json({ error: `${k} must be a positive number` }, 400); when[k] = v; }
    if (typeof b.cron === "string" && b.cron.trim()) when.cron = b.cron.trim().slice(0, 100);
    if (typeof b.at === "string" && b.at.trim()) when.at = b.at.trim().slice(0, 40);
    if (!Object.keys(when).length) return c.json({ error: "give one of delaySecs, at, everySecs, cron" }, 400);
    const r = await spike(c, `/agents/${name}/schedules`, { method: "POST", body: { text: t, ...when } }).catch(() => null);
    return r ? relay(r) : unavailable(c);
  });
  app.delete("/api/agents/:name/schedules/:sid", async (c) => {
    const name = nameOf(c); if (!name) return c.json({ error: "not found" }, 404);
    const sid = c.req.param("sid"); if (!/^[0-9a-f]{8}$/.test(sid)) return c.json({ error: "not found" }, 404);
    if (!enabled(c)) return off(c);
    const r = await spike(c, `/agents/${name}/schedules/${sid}`, { method: "DELETE" }).catch(() => null);
    return r ? relay(r) : unavailable(c);
  });

  /** The agent's CURRENT session id, read from agent-spike (never from the client), so stream/stop can only touch this agent's session. */
  const sessionOf = async (c: Ctx, name: string): Promise<string | null> => {
    const a = await jsonOf(await spike(c, `/agents/${name}`).catch(() => null));
    const id = a?.session?.id;
    return typeof id === "string" && SESSION_ID.test(id) ? id : null;
  };
  app.post("/api/agents/:name/stop", async (c) => {
    const name = nameOf(c); if (!name) return c.json({ error: "not found" }, 404);
    if (!enabled(c)) return off(c);
    const sid = await sessionOf(c, name); if (!sid) return c.json({ error: "no session" }, 409);
    const r = await spike(c, `/sessions/${sid}/interrupt`, { method: "POST", body: {} }).catch(() => null);
    return r ? relay(r) : unavailable(c);
  });
  // ONE stream per agent across session replacements (agent-spike /agents/:name/events). `after` is agent-spike's cursor
  // "<session>:<seq>"; anything else is dropped (no cursor = the current session from its start).
  const cursorOf = (c: Ctx) => { const v = c.req.query("after") ?? ""; return CURSOR.test(v) ? `&after=${encodeURIComponent(v)}` : ""; };
  app.get("/api/agents/:name/events", async (c) => {
    const name = nameOf(c); if (!name) return c.json({ error: "not found" }, 404);
    if (!enabled(c)) return off(c);
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      const s = await spike(c, `/agents/${name}/events?x=1${cursorOf(c)}`, { upgrade: true }).catch(() => null);
      const sock = (s as (Response & { webSocket?: WebSocket }) | null)?.webSocket;
      if (!s) return unavailable(c);
      if (s.status !== 101 || !sock) return relay(s);
      await touch(c, name);
      return new Response(null, { status: 101, webSocket: sock } as ResponseInit);
    }
    await touch(c, name);
    const s = await spike(c, `/agents/${name}/events?limit=500${cursorOf(c)}`).catch(() => null);
    return s ? relay(s) : unavailable(c);
  });
}

// ---- cron watcher: one push per finished inbox message (agent reply / schedule-triggered run / failure) ----
export function notifyForMessage(name: string, m: { from?: string; status?: string; reply?: string | null; error?: string | null }): PushPayload {
  const sched = typeof m.from === "string" && m.from.startsWith("schedule:");
  const failed = m.status === "failed";
  const body = (failed ? m.error ?? "failed" : m.reply ?? "").replace(/\s+/g, " ").trim().slice(0, 140) || (failed ? "failed" : "(no text)");
  return { title: failed ? `${name}: run failed` : sched ? `${name}: scheduled run finished` : `${name} replied`, body, url: `/a/${name}`, tag: `agent-${name}` };
}

export type AgentWatchResult = { checked: number; pushed: number; errors: string[] };
export async function watchAgents(env: Env, now = Date.now(), fetchImpl?: typeof fetch): Promise<AgentWatchResult> {
  const out: AgentWatchResult = { checked: 0, pushed: 0, errors: [] };
  if (!env.AGENT || !env.AGENT_INTERNAL_SECRET) return out;
  const get = async (path: string) => {
    const r = await env.AGENT!.fetch(`https://agent-spike.internal/internal/v1${path}`, { headers: { "x-internal-secret": env.AGENT_INTERNAL_SECRET!, "x-actor": "vertex-client:cron" } });
    if (r.status !== 200) throw new Error(`agent-spike ${r.status} ${path}`);
    return (await r.json()) as any;
  };
  let agents: Agent[];
  try { agents = ((await get("/agents")).agents as Agent[]).filter((a) => a?.name && inScope("main", a.name)).slice(0, 30); } catch (e) { out.errors.push(e instanceof Error ? e.message : String(e)); return out; }
  for (const a of agents) {
    out.checked++;
    try {
      await syncAgentCost(env.DB, "main", a);
      const w = await env.DB.prepare(`SELECT watermark, seen_at FROM agent_watch WHERE name=?`).bind(a.name).first<{ watermark: number; seen_at: number }>();
      const inbox = ((await get(`/agents/${a.name}/inbox?limit=20`)).messages ?? []) as { id: string; from?: string; status?: string; reply?: string | null; error?: string | null; finished?: number | null; kind?: string }[];
      const fin = inbox.filter((m) => (m.status === "done" || m.status === "failed") && typeof m.finished === "number" && m.kind !== "handoff").sort((x, y) => x.finished! - y.finished!);
      const newest = fin.length ? fin[fin.length - 1].finished! : 0;
      const mark = (v: number) => env.DB.prepare(`INSERT INTO agent_watch (name, watermark) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET watermark=excluded.watermark`).bind(a.name, v).run();
      // First sight of an agent (no watermark yet): adopt the current state silently, never announce history.
      if (!w || w.watermark === 0) { await mark(now); continue; }
      const fresh = fin.filter((m) => m.finished! > w.watermark);
      if (!fresh.length) continue;
      await mark(newest);
      const last = fresh[fresh.length - 1];
      const np = notifyForMessage(a.name, last);
      await recordNotification(env.DB, "main", { kind: "agent", ...np }); // stored even when watched: the PWA picks it up on its next poll
      if (now - w.seen_at < RECENT_VIEW_MS) continue; // someone is looking at it
      const res = await pushTo(env, "main", np, fetchImpl);
      if (res.sent > 0) out.pushed++; else if (res.configured) out.errors.push(`${a.name}: push not delivered (${res.errors[0] ?? "no subscriptions"})`);
    } catch (e) { out.errors.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return out;
}
