import { withDevVisibility } from "./dev-visibility";
import { providerOfModel } from "./providers/config";
// Usage screen data. `usage` rows (one per model call: assistant messages, titles, compaction) are the source; day/month
// roll-ups are aggregate queries, so "today" follows the client's own timezone (tz offset minutes) instead of UTC.

export type Row = { mode: string; /** 'chat' (default) | 'image' */ kind?: string; units?: number; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null; n: number; unrated: number };
export type Totals = { units: number; calls: number; costUsd: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; cacheHit: number | null; unratedCalls: number };

const pad = (n: number) => String(n).padStart(2, "0");
const sqlTs = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/** UTC boundaries (as D1 `datetime('now')` strings) of the client's local day and month. tzMin = minutes EAST of UTC (Vietnam = 420). */
export function periodBounds(nowMs: number, tzMin: number) {
  const tz = Math.max(-840, Math.min(840, Math.trunc(tzMin) || 0));
  const local = new Date(nowMs + tz * 60_000); // "wall clock" carried in UTC fields
  const dayStartLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const monthStartLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  return { tz, today: sqlTs(new Date(dayStartLocal - tz * 60_000)), month: sqlTs(new Date(monthStartLocal - tz * 60_000)), seriesFrom: sqlTs(new Date(dayStartLocal - 13 * 86_400_000 - tz * 60_000)) };
}

export const cacheHitRatio = (input: number, cacheRead: number, cacheWrite: number): number | null => {
  const d = input + cacheRead + cacheWrite;
  return d > 0 ? cacheRead / d : null;
};

export function totalsOf(rows: Row[]): Totals {
  const t: Totals = { units: 0, calls: 0, costUsd: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHit: null, unratedCalls: 0 };
  for (const r of rows) {
    t.calls += r.n; t.units += r.units ?? 0; t.costUsd += r.cost ?? 0; t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite; t.unratedCalls += r.unrated;
  }
  t.tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  t.cacheHit = cacheHitRatio(t.input, t.cacheRead, t.cacheWrite);
  return t;
}

const groupBy = (rows: Row[], key: (r: Row) => string) => {
  const m = new Map<string, Row[]>();
  for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return [...m].map(([k, rs]) => ({ key: k, ...totalsOf(rs) })).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
};

const isGen = (r: Row) => !!r.kind && r.kind !== "chat";
/** Generation rows count under mode "gen" (the `mode` column only knows chat|cloud) and also get their own kind/model split. */
export function rollup(rows: Row[]) {
  return { total: totalsOf(rows), byMode: groupBy(rows, (r) => (isGen(r) ? "gen" : r.mode)), byModel: groupBy(rows, (r) => r.model), byProvider: groupBy(rows.filter((r) => !isGen(r)), (r) => providerOfModel(r.model)),
    gen: groupBy(rows.filter(isGen), (r) => `${r.kind} · ${r.model}`) };
}

const AGG = `SELECT mode, kind, model, COALESCE(SUM(units),0) AS units, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cache_read),0) AS cacheRead,
  COALESCE(SUM(cache_write),0) AS cacheWrite, SUM(cost_usd) AS cost, COUNT(*) AS n, COALESCE(SUM(cost_usd IS NULL),0) AS unrated FROM usage WHERE created_at >= ? AND scope = ? GROUP BY mode, kind, model`;

// Cloud runs (agent-spike) live in cloud_costs as cost deltas; they join the chat rows as mode "cloud", model = executor.
const CAGG = `SELECT 'cloud' AS mode, 'cloud:' || executor AS model, COUNT(DISTINCT run_id) AS units, 0 AS input, 0 AS output, 0 AS cacheRead, 0 AS cacheWrite, SUM(cost_usd) AS cost,
  COUNT(DISTINCT run_id) AS n, 0 AS unrated FROM cloud_costs WHERE created_at >= ? AND scope = ? GROUP BY executor`;

/** Top spenders of the month. A device chat of ANOTHER user of the scope never appears (its title is private to env_user); `user` null = unfiltered (callers without a session). */
async function topConvs(db: D1Database, since: string | number, scope: string, user: string | null) {
  const run = (dv: string, dva: unknown[]) => db.prepare(`SELECT u.conversation_id AS id, COALESCE(c.title,'') AS title, COALESCE(SUM(u.cost_usd),0) AS costUsd,
        COALESCE(SUM(u.input_tokens+u.output_tokens+u.cache_read+u.cache_write),0) AS tokens, COUNT(*) AS calls
      FROM usage u LEFT JOIN conversations c ON c.id=u.conversation_id WHERE u.created_at >= ? AND u.scope = ? AND u.conversation_id IS NOT NULL${dv}
      GROUP BY u.conversation_id ORDER BY costUsd DESC, tokens DESC LIMIT 10`).bind(since, scope, ...dva).all();
  return user === null ? run("", []) : withDevVisibility("c", user, run);
}

export async function usageReport(db: D1Database, nowMs = Date.now(), tzMin = 0, scope = "main", user: string | null = null) {
  const b = periodBounds(nowMs, tzMin);
  const [today, month, top, series, rec, cToday, cMonth, cSeries] = await Promise.all([
    db.prepare(AGG).bind(b.today, scope).all<Row>(),
    db.prepare(AGG).bind(b.month, scope).all<Row>(),
    topConvs(db, b.month, scope, user),
    db.prepare(`SELECT date(created_at, ?) AS d, COALESCE(SUM(cost_usd),0) AS costUsd, COALESCE(SUM(input_tokens+output_tokens+cache_read+cache_write),0) AS tokens
      FROM usage WHERE created_at >= ? AND scope = ? GROUP BY d ORDER BY d`).bind(`${b.tz >= 0 ? "+" : "-"}${Math.abs(b.tz)} minutes`, b.seriesFrom, scope).all(),
    scope === "main" ? db.prepare(`SELECT value FROM settings WHERE name='gateway_reconcile'`).first<{ value: string }>().catch(() => null) : Promise.resolve(null),
    db.prepare(CAGG).bind(b.today, scope).all<Row>(),
    db.prepare(CAGG).bind(b.month, scope).all<Row>(),
    db.prepare(`SELECT date(created_at, ?) AS d, COALESCE(SUM(cost_usd),0) AS costUsd FROM cloud_costs WHERE created_at >= ? AND scope = ? GROUP BY d`).bind(`${b.tz >= 0 ? "+" : "-"}${Math.abs(b.tz)} minutes`, b.seriesFrom, scope).all<{ d: string; costUsd: number }>(),
  ]);
  const days = new Map<string, { day: string; costUsd: number; tokens: number }>();
  for (const x of series.results as Array<{ d: string; costUsd: number; tokens: number }>) days.set(x.d, { day: x.d, costUsd: x.costUsd, tokens: x.tokens });
  for (const x of cSeries.results) { const d = days.get(x.d) ?? { day: x.d, costUsd: 0, tokens: 0 }; d.costUsd += x.costUsd; days.set(x.d, d); }
  let reconcile: unknown = null;
  try { reconcile = rec ? JSON.parse(rec.value) : null; } catch { /* corrupt row: show nothing */ }
  // Auto: last 30 days, by how the model was chosen (`auto` = shadow record, `auto-route`/`auto-fallback`/`manual-override` = applied). Shadow review: how often the router's pick matched the model that ran. Own query so a missing migration 0023 only empties this block.
  const byRoute = await db.prepare(`SELECT model, routed_model AS routedModel, routed_by AS routedBy, COUNT(*) AS n FROM usage
    WHERE created_at >= ? AND scope = ? AND routed_by IS NOT NULL GROUP BY model, routed_model, routed_by ORDER BY n DESC`).bind(sqlTs(new Date(nowMs - 30 * 86_400_000)), scope).all<{ model: string; routedModel: string | null; routedBy: string; n: number }>().then((x) => x.results).catch(() => []);
  return { byRoute, asOf: nowMs, tz: b.tz, today: rollup([...today.results, ...cToday.results]), month: rollup([...month.results, ...cMonth.results]), topConversations: top.results, daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), reconcile };
}
