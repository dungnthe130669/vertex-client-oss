// D1-backed circuit breaker for Open failover (migration 0033_provider_health.sql). The decision logic is failover.ts's Breaker; this file only persists and shares it:
//  - reads: one SELECT per scope, cached 10 s per isolate (`refresh`), so every Durable Object / request isolate converges on the same view within ~10 s;
//  - writes: fail() updates the local view at once and upserts the row through waitUntil; every error is swallowed (health must never fail a turn);
//  - bounded: each write prunes rows older than TTL and keeps the newest MAX_ROWS per scope.
// The scope string is passed in by the caller (src/scope.ts is the only place that builds one); nothing here parses or builds it.
import { BREAKER, Breaker, type BreakerLike } from "./failover";
import { splitModelId } from "./providers/config";

export const HEALTH = { cacheMs: 10_000, ttlMs: 60 * 60_000, maxRows: 100, maxScopes: 500,
  /** dormant scopes: rows untouched for 24 h are deleted by whoever writes next, at most once per 10 min per isolate, at most 50 rows per sweep */
  globalTtlMs: 24 * 60 * 60_000, sweepEveryMs: 10 * 60_000, sweepBatch: 50, sweepCap: 500, sweepBudgetMs: 2_000,
  /** half-open lease: the one writer that wins the compare-and-set may probe for this long */
  probeMs: 30_000 };
let lastSweep = 0;
type Cache = Map<string, { at: number; br: Breaker; leased: Map<string, "free" | "taken"> }>;
const CACHE: Cache = new Map();
/** Tests only. */
export const resetHealthCache = () => { CACHE.clear(); lastSweep = 0; };

export interface HealthBreaker extends BreakerLike { refresh(): Promise<void> }
export function healthOf(db: D1Database | undefined, waitUntil: (p: Promise<unknown>) => void, scope: string, now: () => number = Date.now, cache: Cache = CACHE): HealthBreaker {
  const entry = () => {
    let e = cache.get(scope);
    if (!e) { e = { at: 0, br: new Breaker(), leased: new Map() }; cache.set(scope, e); while (cache.size > HEALTH.maxScopes) cache.delete(cache.keys().next().value as string); }
    return e;
  };
  const run = (p: Promise<unknown>) => { const q = p.catch(() => {}); try { waitUntil(q); } catch { /* already running */ } };
  const ids = (key: string) => { const { provider, model } = splitModelId(key); return [provider, model] as const; };
  return {
    async refresh() {
      const e = entry();
      if (!db) return;
      if (now() - e.at >= HEALTH.cacheMs) {
        e.at = now(); // a failing read is not retried on every call: the old view stays for one more cache window
        try {
          const r = await db.prepare(`SELECT provider_id, model_id, fails, window_start, open_until FROM provider_health WHERE scope=? AND updated_at>=? LIMIT ?`).bind(scope, now() - HEALTH.ttlMs, HEALTH.maxRows).all<any>();
          const br = new Breaker();
          for (const x of r.results ?? []) br.load(`${x.provider_id}:${x.model_id}`, x.fails, x.window_start, x.open_until);
          e.br = br; e.leased = new Map();
        } catch { /* migration 0033 not applied / D1 down: keep the local view */ }
      }
      // half-open: the open window is over, a probe is due. ONE writer wins a compare-and-set on the row and probes; everybody else keeps the model unhealthy for the probe window.
      for (const key of e.br.halfOpenKeys(now())) {
        if (e.leased.has(key)) continue; // already claimed (free or taken) in this isolate
        const [p, m] = ids(key), t = now();
        try {
          const r: any = await db.prepare(`UPDATE provider_health SET open_until = ?1 + ${HEALTH.probeMs}, updated_at = ?1 WHERE scope=?2 AND provider_id=?3 AND model_id=?4 AND open_until > 0 AND open_until <= ?1`).bind(t, scope, p, m).run();
          if ((r?.meta?.changes ?? r?.changes ?? 0) === 1) e.leased.set(key, "free"); // this writer may probe: the first caller that SELECTS the model takes it (take)
          else e.br.load(key, 1, t, t + HEALTH.probeMs); // somebody else holds the lease: skipped for now
        } catch { e.leased.set(key, "free"); } // D1 unreachable: do not strand the model, allow the probe locally
      }
    },
    take(key) { const e = entry(), l = e.leased.get(key); if (l === undefined) return !e.br.halfOpen(key, now()) || !db; if (l === "free") { e.leased.set(key, "taken"); return true; } return false; },
    fail(key, t) {
      entry().br.fail(key, t); entry().leased.delete(key);
      if (!db) return;
      const [p, m] = ids(key), W = BREAKER.windowMs, O = BREAKER.openMs;
      // all right-hand sides read the OLD row: nf = failures in the window including this one; a failed half-open probe (open_until passed) re-opens at once
      const nf = `(CASE WHEN window_start + ${W} <= ?4 THEN 1 ELSE fails + 1 END)`;
      const sweep = t - lastSweep >= HEALTH.sweepEveryMs; if (sweep) lastSweep = t;
      run(db.batch([
        db.prepare(`INSERT INTO provider_health (scope, provider_id, model_id, fails, window_start, open_until, updated_at) VALUES (?1, ?2, ?3, 1, ?4, 0, ?4)
          ON CONFLICT(scope, provider_id, model_id) DO UPDATE SET
            open_until = CASE WHEN open_until > 0 OR ${nf} >= ${BREAKER.failures} THEN ?4 + ${O} ELSE open_until END, -- any failure while open / leased (a failed probe) re-opens at once
            window_start = CASE WHEN window_start + ${W} <= ?4 THEN ?4 ELSE window_start END,
            fails = ${nf}, updated_at = ?4`).bind(scope, p, m, t),
        db.prepare(`DELETE FROM provider_health WHERE scope=?1 AND updated_at < ?2`).bind(scope, t - HEALTH.ttlMs),
        db.prepare(`DELETE FROM provider_health WHERE scope=?1 AND rowid NOT IN (SELECT rowid FROM provider_health WHERE scope=?1 ORDER BY updated_at DESC LIMIT ?2)`).bind(scope, HEALTH.maxRows),
      ]));
      // bounded global expiry (dormant scopes never write again, so their rows are only ever removed here): batches until the row cap or the time budget (at least one batch)
      if (sweep) run((async () => {
        const end = Date.now() + HEALTH.sweepBudgetMs; let total = 0;
        do {
          const r: any = await db.prepare(`DELETE FROM provider_health WHERE rowid IN (SELECT rowid FROM provider_health WHERE updated_at < ?1 LIMIT ?2)`).bind(t - HEALTH.globalTtlMs, HEALTH.sweepBatch).run();
          const n = r?.meta?.changes ?? r?.changes ?? 0; total += n;
          if (n < HEALTH.sweepBatch) break;
        } while (total < HEALTH.sweepCap && Date.now() < end);
      })());
    },
    ok(key) {
      const br = entry().br, known = br.has(key);
      br.ok(key); entry().leased.delete(key);
      if (!db || !known) return; // a success on a model with no failure record writes nothing
      const [p, m] = ids(key);
      run(db.prepare(`DELETE FROM provider_health WHERE scope=? AND provider_id=? AND model_id=?`).bind(scope, p, m).run());
    },
    unhealthy: (key, t) => { const e = entry(); return e.br.unhealthy(key, t) || (!!db && e.br.halfOpen(key, t) && e.leased.get(key) !== "free"); }, // half-open: allowed only while the lease is free; once one caller took it, the others still see "half-open, not yours" until the probe result is written
  };
}
