// Cron-driven watcher for Cloud runs: the only thing that can notice "finished / needs you" while the phone is locked and no
// browser is polling. Polls agent-spike for runs we still consider live, records the new status, and pushes ONCE per notable
// transition (D1 `notified` is the dedupe key). Erich's data only: the e2e scope never pushes.
// agent-spike has no explicit "awaiting input" state. The nearest signals are: a session going running -> idle (the turn ended,
// it waits for a follow-up) and any run going failed. A one-shot task ends `finished|failed|stopped`.
import type { Env } from "./index";
import { pushTo, type PushPayload } from "./push";
import { recordNotification } from "./notifications";

export const LIVE = ["starting", "running"] as const;          // statuses the cron keeps polling (plus an idle task, see the query)
const TERMINAL = new Set(["finished", "failed", "stopped", "closed"]);

/** What (if anything) to tell Erich about a status change. `null` = stay quiet. */
export function notifyFor(kind: "task" | "session", status: string, title: string, id: string): PushPayload | null {
  const url = `/r/${id}`, tag = `run-${id}`;
  const t = title || id;
  if (status === "failed") return { title: "Cloud run failed", body: t, url, tag };
  if (kind === "task") {
    if (status === "finished") return { title: "Cloud task finished", body: t, url, tag };
    if (status === "stopped") return { title: "Cloud task stopped", body: t, url, tag };
    return null; // `idle` on a task is the 30 s follow-up window before it finishes; the terminal status is what matters
  }
  if (status === "idle") return { title: "Cloud session is waiting for you", body: t, url, tag };
  if (status === "closed") return null; // Erich closed it himself
  return null;
}

type Row = { id: string; executor: string; kind: "task" | "session"; title: string; status: string; notified: string; seen_at: number; cost_usd: number };
export type WatchResult = { checked: number; pushed: number; errors: string[] };
const RECENT_VIEW_MS = 20_000;

export async function watchRuns(env: Env, now = Date.now(), fetchImpl?: typeof fetch): Promise<WatchResult> {
  const out: WatchResult = { checked: 0, pushed: 0, errors: [] };
  if (!env.AGENT || !env.AGENT_INTERNAL_SECRET) return out;
  const rows = (await env.DB.prepare(
    `SELECT id, executor, kind, title, status, notified, seen_at, cost_usd FROM cloud_runs WHERE scope='main' AND (status IN ('starting','running') OR (kind='task' AND status='idle') OR notified != status) ORDER BY created_at DESC LIMIT 50`,
  ).all<Row>()).results;
  for (const r of rows) {
    out.checked++;
    // A client's own poll may already have recorded the new status (syncRun): nothing to fetch, just announce it.
    if (r.notified !== r.status && !LIVE.includes(r.status as any) && !(r.kind === "task" && r.status === "idle")) { await pushOnce(env, r, r.status, now, out, fetchImpl); continue; }
    try {
      const res = await env.AGENT.fetch(`https://agent-spike.internal/internal/v1/${r.kind === "task" ? "tasks" : "sessions"}/${r.id}`, {
        headers: { "x-internal-secret": env.AGENT_INTERNAL_SECRET, "x-actor": "vertex-client:cron" },
      });
      if (res.status === 404) { // gone from agent-spike: stop watching it (would poll forever otherwise)
        await env.DB.prepare(`UPDATE cloud_runs SET status='failed', updated_at=datetime('now') WHERE id=?`).bind(r.id).run();
        await pushOnce(env, r, "failed", now, out, fetchImpl);
        continue;
      }
      if (res.status !== 200) { out.errors.push(`${r.id}: agent-spike ${res.status}`); continue; }
      const st = (await res.json().catch(() => null)) as { status?: string; costUsd?: number; live?: { costUsd?: number } } | null;
      if (!st || typeof st.status !== "string") { out.errors.push(`${r.id}: no status in response`); continue; }
      // Cost too (same delta-only ledger as cloud.ts syncRun), so Usage is final without the app being open.
      const cur = typeof st.costUsd === "number" && Number.isFinite(st.costUsd) ? st.costUsd : 0, delta = cur - r.cost_usd;
      if (delta > 1e-9) {
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO cloud_costs (run_id, executor, cost_usd, scope) VALUES (?,?,?,?)`).bind(r.id, r.executor, delta, "main"),
          env.DB.prepare(`UPDATE cloud_runs SET cost_usd=?, updated_at=datetime('now') WHERE id=?`).bind(cur, r.id),
        ]);
        r.cost_usd = cur;
      }
      if (st.status !== r.status || r.notified !== st.status) {
        await env.DB.prepare(`UPDATE cloud_runs SET status=?, updated_at=datetime('now') WHERE id=?`).bind(st.status, r.id).run();
        await pushOnce(env, r, st.status, now, out, fetchImpl);
      }
    } catch (e) { out.errors.push(`${r.id}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return out;
}

async function pushOnce(env: Env, r: Row, status: string, now: number, out: WatchResult, fetchImpl?: typeof fetch) {
  if (r.notified === status) return;
  const p = notifyFor(r.kind, status, r.title, r.id);
  // Mark as handled even when quiet or watched, so a later tick never re-announces an old transition.
  await env.DB.prepare(`UPDATE cloud_runs SET notified=? WHERE id=?`).bind(status, r.id).run();
  if (p) await recordNotification(env.DB, "main", { kind: "cloud", ...p }); // stored even when the user is watching: the PWA picks it up on its next poll
  if (!p || now - r.seen_at < RECENT_VIEW_MS) return;
  const res = await pushTo(env, "main", p, fetchImpl);
  if (res.sent > 0) out.pushed++;
  else if (res.configured) out.errors.push(`${r.id}: push not delivered (${res.errors[0] ?? "no subscriptions"})`);
}
export { TERMINAL };
