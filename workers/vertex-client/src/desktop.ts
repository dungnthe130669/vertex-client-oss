// Desktop mode: agent-spike image=desktop (computer use in a build-host desktop container) + noVNC take-over, all through the AGENT
// service binding. Same rules as cloud.ts: the browser never reaches agent-spike, ownership lives in D1 (desktop_runs.scope) and every
// :id route checks it first, so an id from another scope is a plain 404 before any call leaves this Worker.
import type { Context, Hono } from "hono";
import { guardPrefix, type Scope } from "./scope";
import type { Env } from "./index";
import { pushTo, type PushPayload } from "./push";
import { recordNotification } from "./notifications";

const RUN_ID = /^[0-9a-f]{16}$/;
const RECENT_VIEW_MS = 20_000;
const DONE = new Set(["finished", "failed", "stopped"]);
type Ctx = Context<{ Bindings: Env; Variables: { session: import("./auth").Session } }>;
type Row = { id: string; title: string; start_url: string | null; status: string; cost_usd: number; scope: string; notified: string; seen_at: number; created_at: string; updated_at: string };
const COLS = "id, title, start_url, status, cost_usd, scope, notified, seen_at, created_at, updated_at";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** http(s) only, no credentials, bounded. Returns the normalised URL or null. */
export function cleanStartUrl(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim() || v.length > 500) return null;
  try {
    const u = new URL(v.trim());
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}
/** agent-spike has no start-URL field, so it rides in the instruction. */
export const buildInstruction = (instruction: string, url: string | null) => (url ? `First open ${url} in the browser. Then: ${instruction}` : instruction);

export type DesktopCard = { status: string; costUsd: number; costEstimated: boolean; turns: number; maxSteps: number | null; wallSecs: number | null; containerSecs: number | null; finalMessage: string | null; stopReason: string | null };
/** The result card is derived from task state (desktop tasks have no runnerCard). */
export function cardOf(st: any): DesktopCard | null {
  if (!st || typeof st !== "object") return null;
  const live = st.live ?? {};
  return {
    status: String(st.status ?? ""), costUsd: num(st.costUsd ?? live.costUsd), costEstimated: st.costEstimated !== false,
    turns: num(st.turns), maxSteps: typeof st.maxSteps === "number" ? st.maxSteps : null,
    wallSecs: typeof live.wallSecs === "number" ? live.wallSecs : null, containerSecs: typeof live.containerSecs === "number" ? live.containerSecs : null,
    finalMessage: typeof st.finalMessage === "string" ? st.finalMessage : null, stopReason: typeof st.stopReason === "string" ? st.stopReason : null,
  };
}

/** What to tell Erich. `key` is the dedupe value stored in `notified`. */
export function notifyFor(st: { status?: string; control?: string; askReason?: string; controlSince?: number | string }, title: string, id: string): { key: string; push: PushPayload } | null {
  const url = `/d/${id}`, tag = `desk-${id}`, t = title || id;
  if (st.control === "asking") return { key: `ask:${st.controlSince ?? "?"}`, push: { title: "Desktop agent needs you", body: `${st.askReason ? String(st.askReason).slice(0, 140) : t}`, url, tag } };
  if (st.status === "finished") return { key: "finished", push: { title: "Desktop task finished", body: t, url, tag } };
  if (st.status === "failed") return { key: "failed", push: { title: "Desktop task failed", body: t, url, tag } };
  if (st.status === "stopped") return { key: "stopped", push: { title: "Desktop task stopped", body: t, url, tag } };
  return null;
}

export function desktopRoutes(app: Hono<{ Bindings: Env; Variables: { session: import("./auth").Session } }>, scopeOf: (c: Ctx) => Scope) {
  guardPrefix(app, "/api/desktop", scopeOf); // Erich-only: main (and the e2e tester); every other scope gets 403 before any handler
  const on = (c: Ctx) => !!(c.env.AGENT && c.env.AGENT_INTERNAL_SECRET);
  const spike = (c: Ctx, path: string, init?: { method?: string; body?: unknown; upgrade?: boolean; protocols?: string | null }) => {
    if (!on(c)) return Promise.resolve(null);
    const h: Record<string, string> = { "x-internal-secret": c.env.AGENT_INTERNAL_SECRET!, "x-actor": `vertex-client:${c.get("session").u}`.slice(0, 80) };
    if (init?.body !== undefined) h["content-type"] = "application/json";
    if (init?.upgrade) h.upgrade = "websocket";
    if (init?.protocols) h["sec-websocket-protocol"] = init.protocols;
    return c.env.AGENT!.fetch(`https://agent-spike.internal/internal/v1${path}`, { method: init?.method ?? "GET", headers: h, body: init?.body !== undefined ? JSON.stringify(init.body) : undefined });
  };
  const jsonOf = async (r: Response | null): Promise<any> => (r ? r.json().catch(() => null) : null);
  const relay = async (r: Response) => new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const run = (c: Ctx, id: string) => (RUN_ID.test(id) ? c.env.DB.prepare(`SELECT ${COLS} FROM desktop_runs WHERE id=? AND scope=?`).bind(id, scopeOf(c)).first<Row>() : Promise.resolve(null));
  const touch = (c: Ctx, id: string) => c.env.DB.prepare(`UPDATE desktop_runs SET seen_at=? WHERE id=?`).bind(Date.now(), id).run().catch(() => null);

  async function sync(env: Env, r: Row, st: any) {
    const cur = num(st?.costUsd ?? st?.live?.costUsd), delta = cur - r.cost_usd, status = typeof st?.status === "string" ? st.status : r.status;
    const stmts: D1PreparedStatement[] = [];
    if (delta > 1e-9) {
      stmts.push(env.DB.prepare(`INSERT INTO cloud_costs (run_id, executor, cost_usd, scope) VALUES (?,?,?,?)`).bind(r.id, "desktop", delta, r.scope));
      stmts.push(env.DB.prepare(`UPDATE desktop_runs SET cost_usd=?, status=?, updated_at=datetime('now') WHERE id=?`).bind(cur, status, r.id));
    } else if (status !== r.status) stmts.push(env.DB.prepare(`UPDATE desktop_runs SET status=?, updated_at=datetime('now') WHERE id=?`).bind(status, r.id));
    if (stmts.length) await env.DB.batch(stmts).catch((e) => console.error("desktop sync", String(e)));
    r.cost_usd = Math.max(cur, r.cost_usd); r.status = status;
  }

  app.get("/api/desktop/config", (c) => c.json({ enabled: on(c), maxSteps: { default: 25, max: 100 } }));

  app.get("/api/desktop/runs", async (c) => {
    const rows = (await c.env.DB.prepare(`SELECT ${COLS} FROM desktop_runs WHERE scope=? ORDER BY created_at DESC, rowid DESC LIMIT 100`).bind(scopeOf(c)).all<Row>()).results;
    return c.json({ enabled: on(c), runs: rows.map(({ notified: _n, seen_at: _s, scope: _sc, ...r }) => r) });
  });

  app.post("/api/desktop/runs", async (c) => {
    if (!on(c)) return c.json({ error: "desktop mode is not configured" }, 503);
    const b = (await c.req.json().catch(() => ({}))) as { instruction?: unknown; startUrl?: unknown; maxSteps?: unknown };
    const instruction = typeof b.instruction === "string" ? b.instruction.trim() : "";
    if (!instruction || instruction.length > 6000) return c.json({ error: "instruction required (max 6000 chars)" }, 400);
    let url: string | null = null;
    if (b.startUrl !== undefined && b.startUrl !== null && b.startUrl !== "") { url = cleanStartUrl(b.startUrl); if (!url) return c.json({ error: "start URL must be http(s), without credentials (max 500 chars)" }, 400); }
    const maxSteps = typeof b.maxSteps === "number" && Number.isInteger(b.maxSteps) && b.maxSteps >= 1 && b.maxSteps <= 100 ? b.maxSteps : 25;
    const r = await spike(c, "/tasks", { method: "POST", body: { instruction: buildInstruction(instruction, url), image: "desktop", maxSteps, executor: "proxmox" } });
    const j = await jsonOf(r);
    if (!r || r.status !== 201 || !j?.id || !RUN_ID.test(j.id)) return c.json({ error: j?.error ?? "agent-spike refused the desktop task" }, (r && r.status >= 400 && r.status < 500 ? r.status : 502) as 400);
    await c.env.DB.prepare(`INSERT INTO desktop_runs (id, title, start_url, status, scope) VALUES (?,?,?,?,?)`).bind(j.id, instruction.replace(/\s+/g, " ").slice(0, 80), url, "starting", scopeOf(c)).run();
    return c.json({ id: j.id }, 201);
  });

  app.get("/api/desktop/runs/:id", async (c) => {
    const r = await run(c, c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    await touch(c, r.id);
    const s = await spike(c, `/tasks/${r.id}`).catch(() => null);
    const st = await jsonOf(s);
    const { notified: _n, seen_at: _s, scope: _sc, ...pub } = r;
    if (!s || s.status !== 200 || !st) return c.json({ run: pub, state: null, card: null, error: s && s.status === 404 ? "gone from agent-spike" : "agent-spike unavailable" });
    await sync(c.env, r, st);
    const control = st.control === "human" || st.control === "asking" ? st.control : "agent";
    return c.json({
      run: { ...pub, status: r.status, cost_usd: r.cost_usd },
      state: { status: st.status, control, askReason: typeof st.askReason === "string" ? st.askReason : null, controlSince: st.controlSince ?? null, image: st.image ?? "desktop", ranOn: st.ranOn ?? null },
      card: DONE.has(st.status) ? cardOf(st) : null,
    });
  });

  // Live stream incl. transient `frame` events ({seq:-1, kind:"frame", data:{jpg,ms}}) - these exist only on the WebSocket.
  app.get("/api/desktop/runs/:id/ws", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket" }, 426);
    const r = await run(c, c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    const after = Math.trunc(Number(c.req.query("after") ?? -1));
    const s = await spike(c, `/tasks/${r.id}/events?after=${Number.isFinite(after) ? after : -1}`, { upgrade: true }).catch(() => null);
    const sock = (s as (Response & { webSocket?: WebSocket }) | null)?.webSocket;
    if (!s || s.status !== 101 || !sock) return c.json({ error: "agent-spike unavailable" }, 502);
    await touch(c, r.id);
    return new Response(null, { status: 101, webSocket: sock } as ResponseInit);
  });

  app.get("/api/desktop/runs/:id/events", async (c) => {
    const r = await run(c, c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    await touch(c, r.id);
    const after = Math.trunc(Number(c.req.query("after") ?? -1));
    const s = await spike(c, `/tasks/${r.id}/events?after=${Number.isFinite(after) ? after : -1}&limit=500`).catch(() => null);
    return s ? relay(s) : c.json({ error: "agent-spike unavailable" }, 502);
  });

  app.post("/api/desktop/runs/:id/control", async (c) => {
    const r = await run(c, c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { on?: unknown };
    if (typeof b.on !== "boolean") return c.json({ error: "on (boolean) required" }, 400);
    const s = await spike(c, `/tasks/${r.id}/control`, { method: "POST", body: { on: b.on } }).catch(() => null);
    return s ? relay(s) : c.json({ error: "agent-spike unavailable" }, 502);
  });

  app.post("/api/desktop/runs/:id/stop", async (c) => {
    const r = await run(c, c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    const s = await spike(c, `/tasks/${r.id}/stop`, { method: "POST", body: {} }).catch(() => null);
    return s ? relay(s) : c.json({ error: "agent-spike unavailable" }, 502);
  });

  // noVNC tunnel. agent-spike itself answers 403 unless control==="human", so a take-over can never be opened without the pause.
  // The "binary" subprotocol is echoed only if the browser offered it (noVNC does), and is forwarded to agent-spike unchanged.
  app.get("/api/desktop/runs/:id/vnc/websockify", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket" }, 426);
    const r = await run(c, c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    const offered = c.req.header("sec-websocket-protocol") ?? null;
    const s = await spike(c, `/tasks/${r.id}/vnc/websockify`, { upgrade: true, protocols: offered }).catch(() => null);
    const sock = (s as (Response & { webSocket?: WebSocket }) | null)?.webSocket;
    if (!s || s.status !== 101 || !sock) {
      if (s && s.status >= 400 && s.status < 500) return c.json({ error: (await jsonOf(s))?.error ?? "take control first" }, s.status as 403);
      return c.json({ error: "agent-spike unavailable" }, 502);
    }
    await touch(c, r.id);
    const hdr = new Headers();
    if (offered?.split(",").some((p) => p.trim() === "binary")) hdr.set("sec-websocket-protocol", "binary");
    return new Response(null, { status: 101, webSocket: sock, headers: hdr } as ResponseInit);
  });
}

// ---- cron watcher: push once per ask_human / terminal transition, only for main, never while someone is looking ----
export type WatchResult = { checked: number; pushed: number; errors: string[] };
export async function watchDesktop(env: Env, now = Date.now(), fetchImpl?: typeof fetch): Promise<WatchResult> {
  const out: WatchResult = { checked: 0, pushed: 0, errors: [] };
  if (!env.AGENT || !env.AGENT_INTERNAL_SECRET) return out;
  const rows = (await env.DB.prepare(`SELECT ${COLS} FROM desktop_runs WHERE scope='main' AND (status IN ('starting','running','idle') OR notified NOT IN ('finished','failed','stopped')) AND created_at > datetime('now','-2 days') ORDER BY created_at DESC LIMIT 30`).all<Row>()).results;
  for (const r of rows) {
    out.checked++;
    try {
      const res = await env.AGENT.fetch(`https://agent-spike.internal/internal/v1/tasks/${r.id}`, { headers: { "x-internal-secret": env.AGENT_INTERNAL_SECRET, "x-actor": "vertex-client:cron" } });
      if (res.status === 404) { await env.DB.prepare(`UPDATE desktop_runs SET status='failed', notified='failed', updated_at=datetime('now') WHERE id=?`).bind(r.id).run(); continue; }
      if (res.status !== 200) { out.errors.push(`${r.id}: agent-spike ${res.status}`); continue; }
      const st = (await res.json().catch(() => null)) as any;
      if (!st || typeof st.status !== "string") { out.errors.push(`${r.id}: no status`); continue; }
      const cur = num(st.costUsd ?? st.live?.costUsd), delta = cur - r.cost_usd;
      if (delta > 1e-9) {
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO cloud_costs (run_id, executor, cost_usd, scope) VALUES (?,?,?,?)`).bind(r.id, "desktop", delta, "main"),
          env.DB.prepare(`UPDATE desktop_runs SET cost_usd=?, updated_at=datetime('now') WHERE id=?`).bind(cur, r.id),
        ]);
      }
      if (st.status !== r.status) await env.DB.prepare(`UPDATE desktop_runs SET status=?, updated_at=datetime('now') WHERE id=?`).bind(st.status, r.id).run();
      const n = notifyFor(st, r.title, r.id);
      if (!n || n.key === r.notified) continue;
      await env.DB.prepare(`UPDATE desktop_runs SET notified=? WHERE id=?`).bind(n.key, r.id).run(); // also when quiet/watched: never re-announce
      await recordNotification(env.DB, "main", { kind: "desktop", ...n.push }); // stored even when watched: the PWA picks it up on its next poll
      if (now - r.seen_at < RECENT_VIEW_MS) continue;
      const p = await pushTo(env, "main", n.push, fetchImpl);
      if (p.sent > 0) out.pushed++; else if (p.configured) out.errors.push(`${r.id}: push not delivered (${p.errors[0] ?? "no subscriptions"})`);
    } catch (e) { out.errors.push(`${r.id}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return out;
}
