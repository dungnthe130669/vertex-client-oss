// Cloud mode: proxy to agent-spike (service binding AGENT, /internal/v1, header x-internal-secret). The browser never sees the
// secret, the GitHub token or the gateway key. Ownership lives in D1 (cloud_runs.scope) because agent-spike has no per-user filter:
// every :id route checks the run belongs to the caller's scope first, so an id guessed from another scope is a plain 404.
import type { Context, Hono } from "hono";
import { guardPrefix, type Scope } from "./scope";
import type { Env } from "./index";
import { isModelIdSyntax } from "./model-id";

export const DEFAULT_REPOS = ["example-user/example-repo"];
export const EXECUTORS = ["auto", "proxmox", "cloudflare"] as const;
const RUN_ID = /^(?:[0-9a-f]{16}|[bs][0-9a-f]{15})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BASE = /^[A-Za-z0-9._\/-]{1,100}$/;
/** The e2e user may only run against throwaway bases, never a real branch. */
const E2E_BASE = /^spike-base\//;

export const repoList = (env: Pick<Env, "CLOUD_REPOS">) => {
  const l = (env.CLOUD_REPOS ?? "").split(",").map((s) => s.trim()).filter((s) => REPO.test(s));
  return l.length ? l : DEFAULT_REPOS;
};

type Run = { id: string; kind: "task" | "session"; repo: string; base: string | null; branch: string | null; executor: string; title: string; status: string; cost_usd: number; created_at: string; updated_at: string; pr_number: number | null; pr_url: string | null };
const RUN_COLS = "id, kind, repo, base, branch, executor, title, status, cost_usd, created_at, updated_at, pr_number, pr_url";
const TERMINAL = new Set(["finished", "failed", "stopped", "closed"]);
/** Session states in which nothing is running, so its pushed branch can be turned into a PR. */
const SESSION_QUIET = new Set(["idle", "sleeping"]);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

type Ctx = Context<{ Bindings: Env; Variables: { session: import("./auth").Session } }>;

/** agent-spike's GET /sessions/:id/tasks/:tid is a task record whose result card (pushed/compareUrl/branch/files/diffStat/prUrl) is nested at `.card`.
 *  Flatten it to the same shape as a kind=task card (the one normalisation point: route preconditions, sticky merge and UI all read the flat shape). */
export function flattenTaskCard(body: any, taskId: string): any {
  if (!body || typeof body !== "object") return { taskId };
  const { card: inner, ...meta } = body;
  return { ...meta, ...(inner && typeof inner === "object" ? inner : {}), taskId };
}

export function cloudRoutes(app: Hono<{ Bindings: Env; Variables: { session: import("./auth").Session } }>, scopeOf: (c: Ctx) => Scope) {
  guardPrefix(app, "/api/cloud", scopeOf); // Erich-only: main (and the e2e tester); every other scope gets 403 before any handler
  const off = (c: Ctx) => c.json({ error: "cloud mode is not configured" }, 503);
  const spike = (c: Ctx, path: string, init?: { method?: string; body?: unknown; upgrade?: boolean }) => {
    if (!c.env.AGENT || !c.env.AGENT_INTERNAL_SECRET) return Promise.resolve(null);
    return c.env.AGENT.fetch(`https://agent-spike.internal/internal/v1${path}`, {
      method: init?.method ?? "GET",
      headers: { "x-internal-secret": c.env.AGENT_INTERNAL_SECRET, "x-actor": `vertex-client:${c.get("session").u}`.slice(0, 80), ...(init?.body !== undefined ? { "content-type": "application/json" } : {}), ...(init?.upgrade ? { upgrade: "websocket" } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  };
  const relay = async (r: Response) => new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const jsonOf = async (r: Response | null): Promise<any> => (r ? r.json().catch(() => null) : null);

  const run = (c: Ctx, id: string) =>
    RUN_ID.test(id) ? c.env.DB.prepare(`SELECT ${RUN_COLS} FROM cloud_runs WHERE id=? AND scope=?`).bind(id, scopeOf(c)).first<Run>() : Promise.resolve(null);

  /** Record a cost change we have just observed (delta only, so re-polling never double counts). */
  async function syncRun(c: Ctx, r: Run, status: string | undefined, cost: unknown, branch?: unknown) {
    const cur = num(cost), delta = cur - r.cost_usd;
    const st = status ?? r.status;
    const stmts: D1PreparedStatement[] = [];
    if (delta > 1e-9) {
      stmts.push(c.env.DB.prepare(`INSERT INTO cloud_costs (run_id, executor, cost_usd, scope) VALUES (?,?,?,?)`).bind(r.id, r.executor, delta, scopeOf(c)));
      stmts.push(c.env.DB.prepare(`UPDATE cloud_runs SET cost_usd=?, status=?, updated_at=datetime('now') WHERE id=?`).bind(cur, st, r.id));
    } else if (st !== r.status || (typeof branch === "string" && branch !== r.branch)) {
      stmts.push(c.env.DB.prepare(`UPDATE cloud_runs SET status=?, branch=COALESCE(?, branch), updated_at=datetime('now') WHERE id=?`).bind(st, typeof branch === "string" ? branch : null, r.id));
    }
    if (typeof branch === "string" && branch !== r.branch && delta > 1e-9) stmts.push(c.env.DB.prepare(`UPDATE cloud_runs SET branch=? WHERE id=?`).bind(branch, r.id));
    if (stmts.length) await c.env.DB.batch(stmts).catch((e) => console.error("cloud sync", String(e)));
    r.cost_usd = Math.max(cur, r.cost_usd); r.status = st; if (typeof branch === "string") r.branch = branch;
  }

  app.get("/api/cloud/config", (c) => c.json({ enabled: !!(c.env.AGENT && c.env.AGENT_INTERNAL_SECRET), repos: repoList(c.env), executors: EXECUTORS, e2eBasePrefix: scopeOf(c) === "main" ? null : "spike-base/" }));

  app.get("/api/cloud/runs", async (c) => {
    const sc = scopeOf(c);
    const rows = (await c.env.DB.prepare(`SELECT ${RUN_COLS} FROM cloud_runs WHERE scope=? ORDER BY created_at DESC, rowid DESC LIMIT 100`).bind(sc).all<Run>()).results;
    // Enrich with live state from agent-spike (best-effort: a spike outage must not blank the list).
    const [t, s] = await Promise.all([spike(c, "/tasks?limit=200").then(jsonOf).catch(() => null), spike(c, "/sessions").then(jsonOf).catch(() => null)]);
    const live = new Map<string, any>();
    for (const x of Array.isArray(t?.tasks) ? t.tasks : []) if (x?.id) live.set(x.id, x);
    for (const x of Array.isArray(s?.sessions) ? s.sessions : []) if (x?.id) live.set(x.id, x);
    for (const r of rows) {
      const l = live.get(r.id);
      if (l) await syncRun(c, r, typeof l.status === "string" ? l.status : undefined, l.costUsd, l.branch);
    }
    return c.json({ enabled: !!(c.env.AGENT && c.env.AGENT_INTERNAL_SECRET), runs: rows.map((r) => ({ ...r, live: live.get(r.id)?.live ?? null, ranOn: live.get(r.id)?.ranOn ?? null })) });
  });

  app.post("/api/cloud/runs", async (c) => {
    if (!c.env.AGENT || !c.env.AGENT_INTERNAL_SECRET) return off(c);
    const sc = scopeOf(c);
    const b = (await c.req.json().catch(() => ({}))) as { kind?: unknown; repo?: unknown; instruction?: unknown; base?: unknown; executor?: unknown; model?: unknown };
    const kind = b.kind === "session" ? "session" : "task";
    const repo = typeof b.repo === "string" ? b.repo : "";
    if (!repoList(c.env).includes(repo)) return c.json({ error: "repo is not in the allowlist" }, 403);
    const instruction = typeof b.instruction === "string" ? b.instruction.trim() : "";
    if (!instruction || instruction.length > 8000) return c.json({ error: "instruction required (max 8000 chars)" }, 400);
    const base = typeof b.base === "string" && b.base.trim() ? b.base.trim() : undefined;
    if (base !== undefined && (!BASE.test(base) || base.includes(".."))) return c.json({ error: "bad base branch" }, 400);
    if (sc !== "main" && !(base && E2E_BASE.test(base))) return c.json({ error: "this user may only use spike-base/* bases" }, 403);
    const executor = typeof b.executor === "string" && (EXECUTORS as readonly string[]).includes(b.executor) ? b.executor : "auto";
    const model = isModelIdSyntax(b.model) ? b.model : undefined;
    const title = instruction.replace(/\s+/g, " ").slice(0, 80);
    let id: string, branch: string | null = null;
    if (kind === "task") {
      const r = await spike(c, "/tasks", { method: "POST", body: { repo, instruction, ...(base ? { base } : {}), ...(model ? { model } : {}), executor } });
      const j = await jsonOf(r);
      if (!r || r.status !== 201 || !j?.id) return c.json({ error: j?.error ?? "agent-spike refused the task" }, (r && r.status >= 400 && r.status < 500 ? r.status : 502) as 400);
      id = j.id; branch = j.branch ?? null;
    } else {
      const r = await spike(c, "/sessions", { method: "POST", body: { repo, ...(base ? { base } : {}), ...(model ? { model } : {}), instanceType: "basic", executor } });
      const j = await jsonOf(r);
      const sid = j?.id ?? j?.sessionId;
      if (!r || r.status >= 300 || typeof sid !== "string") return c.json({ error: j?.error ?? "agent-spike refused the session" }, (r && r.status >= 400 && r.status < 500 ? r.status : 502) as 400);
      id = sid; branch = j.branch ?? null;
    }
    await c.env.DB.prepare(`INSERT INTO cloud_runs (id, kind, repo, base, branch, executor, title, status, scope) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(id, kind, repo, base ?? null, branch, executor, title, "starting", sc).run();
    if (kind === "session") {
      const r = await spike(c, `/sessions/${id}/tasks`, { method: "POST", body: { instruction } });
      if (!r || r.status !== 201) return c.json({ id, kind, warning: "session created but the first task was not accepted; send it again", detail: await jsonOf(r) }, 201);
    }
    return c.json({ id, kind, branch }, 201);
  });

  /** A client is looking at this run right now: the cron watcher stays quiet about it (no push for what you can see). */
  const touch = (c: Ctx, id: string) => c.env.DB.prepare(`UPDATE cloud_runs SET seen_at=? WHERE id=?`).bind(Date.now(), id).run().catch(() => null);

  /** Newest session task card, made sticky: a no-op follow-up has pushed:false and no compare URL, which hides that the branch was pushed
   *  by an earlier task, so pushed/compareUrl/branch come from the newest card that did push (files/diffStat stay the latest's unless it changed nothing). */
  async function sessionCard(c: Ctx, r: Run, st: any): Promise<any> {
    let card: any = null;
    const carded = [...(st.rec?.tasks ?? st.tasks ?? [])].reverse().filter((t: any) => t?.hasCard);
    const cardOf = async (t: any) => flattenTaskCard(await jsonOf(await spike(c, `/sessions/${r.id}/tasks/${t.id}`).catch(() => null)), t.id);
    if (carded.length) {
      card = await cardOf(carded[0]);
      if (card && card.pushed !== true) {
        for (const t of carded.slice(1, 4)) {
          const p = await cardOf(t);
          if (p?.pushed !== true) continue;
          const noop = !Array.isArray(card.files) || card.files.length === 0;
          card = { ...card, pushed: true, compareUrl: p.compareUrl ?? card.compareUrl ?? null, branch: p.branch ?? card.branch, pushedTaskId: t.id, ...(noop ? { files: p.files ?? [], diffStat: p.diffStat ?? card.diffStat } : {}) };
          break;
        }
      }
    }
    return card;
  }

  app.get("/api/cloud/runs/:id", async (c) => {
    const r = await run(c, c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    await touch(c, r.id);
    const path = r.kind === "task" ? `/tasks/${r.id}` : `/sessions/${r.id}`;
    const s = await spike(c, path).catch(() => null);
    const st = await jsonOf(s);
    if (!s || s.status !== 200 || !st) return c.json({ run: r, state: null, card: null, error: s && s.status === 404 ? "gone from agent-spike" : "agent-spike unavailable" });
    await syncRun(c, r, st.status, st.costUsd ?? st.live?.costUsd, st.branch);
    const card = r.kind === "task" ? st.card ?? null : await sessionCard(c, r, st);
    return c.json({ run: r, state: st, card });
  });

  // Live stream: pipes agent-spike's own event WebSocket (same {seq,ts,kind,data} frames as the polling route, `?after=` resumes).
  // Auth is the normal /api/* middleware (session cookie + same-origin), then the run must be in the caller's scope.
  app.get("/api/cloud/runs/:id/ws", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket" }, 426);
    const r = await run(c, c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    const after = Math.trunc(Number(c.req.query("after") ?? -1));
    const s = await spike(c, `${r.kind === "task" ? "/tasks" : "/sessions"}/${r.id}/events?after=${Number.isFinite(after) ? after : -1}`, { upgrade: true }).catch(() => null);
    const sock = (s as (Response & { webSocket?: WebSocket }) | null)?.webSocket;
    if (!s || s.status !== 101 || !sock) return c.json({ error: "agent-spike unavailable" }, 502);
    await touch(c, r.id);
    return new Response(null, { status: 101, webSocket: sock } as ResponseInit);
  });

  app.get("/api/cloud/runs/:id/events", async (c) => {
    const r = await run(c, c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    await touch(c, r.id);
    const after = Math.trunc(Number(c.req.query("after") ?? -1));
    const q = `?after=${Number.isFinite(after) ? after : -1}&limit=500`;
    const s = await spike(c, `${r.kind === "task" ? "/tasks" : "/sessions"}/${r.id}/events${q}`).catch(() => null);
    if (!s) return c.json({ error: "agent-spike unavailable" }, 502);
    return relay(s);
  });

  // Open a draft PR for a finished, pushed task run or an idle session with a pushed commit. agent-spike owns the policy (always draft, head agent/<id>, repo allowlist, idempotent,
  // never merges); VC checks ownership + state first and never relays an upstream body or the secret.
  const DEFAULT_PR_BASE = "main";
  const PR_ERR: Record<number, string> = { 400: "this run cannot have a pull request", 403: "pull requests are not allowed for this repository", 404: "branch or repository not found", 409: "the run is not ready for a pull request", 422: "GitHub refused the pull request" };
  app.post("/api/cloud/runs/:id/pr", async (c) => {
    const r = await run(c, c.req.param("id") ?? "");
    if (!r) return c.json({ error: "not found" }, 404);
    const send = (pr: { number: number; url: string; draft?: unknown; head?: unknown; base?: unknown }) => c.json({ number: pr.number, url: pr.url, draft: pr.draft === false ? false : true, head: pr.head ?? r.branch, base: typeof pr.base === "string" && pr.base ? pr.base : r.base ?? DEFAULT_PR_BASE });
    if (r.pr_number && r.pr_url) {
      // The base is not stored (no column): a run opened without an explicit base has r.base null, so ask agent-spike's idempotent /pr for it (best effort); never answer null.
      let base: string | undefined = r.base ?? undefined;
      if (!base && c.env.AGENT && c.env.AGENT_INTERNAL_SECRET) {
        const p = await spike(c, r.kind === "session" ? `/sessions/${r.id}/pr` : `/tasks/${r.id}/pr`, { method: "POST" }).catch(() => null);
        const j = p && p.status >= 200 && p.status < 300 ? await jsonOf(p) : null;
        if (typeof j?.base === "string" && j.base) base = j.base;
      }
      return send({ number: r.pr_number, url: r.pr_url, base });
    }
    if (!c.env.AGENT || !c.env.AGENT_INTERNAL_SECRET) return off(c);
    const isSession = r.kind === "session";
    const s = await spike(c, isSession ? `/sessions/${r.id}` : `/tasks/${r.id}`).catch(() => null);
    const st = await jsonOf(s);
    if (!s || s.status !== 200 || !st) return c.json({ error: "agent-spike unavailable" }, 502);
    if (isSession) {
      if (!TERMINAL.has(st.status) && !SESSION_QUIET.has(st.status)) return c.json({ error: "session is busy" }, 409);
      if ((await sessionCard(c, r, st))?.pushed !== true) return c.json({ error: "the run must be finished with its branch pushed" }, 409);
    } else if (!TERMINAL.has(st.status) || st.card?.pushed !== true) return c.json({ error: "the run must be finished with its branch pushed" }, 409);
    const given = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const body = { ...(typeof given.title === "string" && given.title.trim() ? { title: given.title.slice(0, 200) } : {}), ...(typeof given.body === "string" && given.body.trim() ? { body: given.body.slice(0, 8000) } : {}) };
    const p = await spike(c, isSession ? `/sessions/${r.id}/pr` : `/tasks/${r.id}/pr`, { method: "POST", ...(Object.keys(body).length ? { body } : {}) }).catch(() => null);
    const j = await jsonOf(p);
    if (!p) return c.json({ error: "agent-spike unavailable" }, 502);
    if (isSession && p.status === 404) return c.json({ error: "pull request for sessions is not available yet" }, 501); // route not deployed on agent-spike yet
    if (p.status < 200 || p.status >= 300) return c.json({ error: PR_ERR[p.status] ?? "could not open the pull request" }, (p.status >= 400 && p.status < 500 ? p.status : 502) as 400);
    const url = typeof j?.url === "string" && /^https:\/\/github\.com\//.test(j.url) ? j.url : null;
    if (!Number.isInteger(j?.number) || !url) return c.json({ error: "agent-spike returned an unreadable pull request" }, 502);
    await c.env.DB.prepare(`UPDATE cloud_runs SET pr_number=?, pr_url=?, updated_at=datetime('now') WHERE id=?`).bind(j.number, url, r.id).run().catch((e) => console.error("cloud pr", String(e)));
    return send({ number: j.number, url, draft: j.draft, head: j.head, base: j.base });
  });

  const forward = (suffix: string, method = "POST", pick?: (b: Record<string, unknown>) => unknown, sessionOnly = false, taskSuffix = suffix) =>
    async (c: Ctx) => {
      const r = await run(c, c.req.param("id") ?? "");
      if (!r) return c.json({ error: "not found" }, 404);
      if (sessionOnly && r.kind !== "session") return c.json({ error: "only for sessions" }, 400);
      const body = pick ? pick((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : undefined;
      if (body === null) return c.json({ error: "text required (max 8000 chars)" }, 400);
      const base = r.kind === "task" ? `/tasks/${r.id}${taskSuffix}` : `/sessions/${r.id}${suffix}`;
      const s = await spike(c, base, { method, body }).catch(() => null);
      if (!s) return c.json({ error: "agent-spike unavailable" }, 502);
      return relay(s);
    };
  const textBody = (b: Record<string, unknown>) => (typeof b.text === "string" && b.text.trim() && b.text.length <= 8000 ? { text: b.text } : null);
  const instrBody = (b: Record<string, unknown>) => (typeof b.instruction === "string" && b.instruction.trim() && b.instruction.length <= 8000 ? { instruction: b.instruction } : null);
  app.post("/api/cloud/runs/:id/message", forward("/message", "POST", textBody));
  app.post("/api/cloud/runs/:id/stop", forward("/interrupt", "POST", undefined, false, "/stop"));
  app.post("/api/cloud/runs/:id/tasks", forward("/tasks", "POST", instrBody, true));
  app.post("/api/cloud/runs/:id/sleep", forward("/sleep", "POST", undefined, true));
  app.post("/api/cloud/runs/:id/wake", forward("/wake", "POST", undefined, true));
  app.post("/api/cloud/runs/:id/close", forward("/close", "POST", undefined, true));
}
