import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { cacheHitRatio, periodBounds, rollup, totalsOf, usageReport, type Row } from "../src/usage";

const r = (o: Partial<Row>): Row => ({ mode: "chat", model: "m", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, n: 1, unrated: 0, ...o });

describe("roll-up math", () => {
  test("totals, cache-hit ratio = read / (input + read + write)", () => {
    const t = totalsOf([r({ input: 100, output: 50, cacheRead: 300, cacheWrite: 100, cost: 0.5, n: 2 }), r({ input: 100, cacheRead: 100, cost: null, unrated: 1 })]);
    expect(t).toMatchObject({ calls: 3, input: 200, output: 50, cacheRead: 400, cacheWrite: 100, tokens: 750, costUsd: 0.5, unratedCalls: 1 });
    expect(t.cacheHit).toBeCloseTo(400 / 700);
  });
  test("empty = zeros and null ratio (never NaN)", () => { const t = totalsOf([]); expect(t.costUsd).toBe(0); expect(t.cacheHit).toBeNull(); expect(cacheHitRatio(0, 0, 0)).toBeNull(); });
  test("groups by mode and by model, sorted by cost", () => {
    const x = rollup([r({ mode: "chat", model: "a", cost: 1 }), r({ mode: "chat", model: "b", cost: 3 }), r({ mode: "cloud", model: "a", cost: 2 })]);
    expect(x.byModel.find((g) => g.key === "a")!.costUsd).toBe(3);
    expect(x.byMode.map((g) => g.key)).toEqual(["chat", "cloud"]);
    expect(x.byMode.find((g) => g.key === "chat")!.costUsd).toBe(4);
    expect(x.total.costUsd).toBe(6);
  });
});

describe("period bounds follow the client's timezone", () => {
  const now = Date.UTC(2026, 8, 29, 20, 0, 0); // 2026-09-29 20:00 UTC = 2026-09-30 03:00 in Vietnam
  test("UTC+7: local day already 30 Sep, month Sep", () => {
    const b = periodBounds(now, 420);
    expect(b.today).toBe("2026-09-29 17:00:00"); expect(b.month).toBe("2026-08-31 17:00:00");
  });
  test("UTC: same instant is still 29 Sep", () => expect(periodBounds(now, 0).today).toBe("2026-09-29 00:00:00"));
  test("month rollover in local time (UTC-5 at 02:00 UTC on 1 Oct = 21:00 on 30 Sep)", () => {
    const b = periodBounds(Date.UTC(2026, 9, 1, 2, 0, 0), -300);
    expect(b.today).toBe("2026-09-30 05:00:00"); expect(b.month).toBe("2026-09-01 05:00:00");
  });
  test("absurd tz is clamped", () => expect(periodBounds(now, 99999).tz).toBe(840));
});

describe("usageReport against real SQL (bun:sqlite + real migration)", () => {
  const db = new Database(":memory:");
  for (const f of ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0009_usage_generation.sql", "0011_usage_dispatch.sql", "0012_scope_hardening.sql", "0018_projects.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const d1 = { prepare: (q: string) => { const st = (b: unknown[] = []): any => ({ bind: (...v: unknown[]) => st(v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null, all: async () => ({ results: db.query(q).all(...(b as any)) }) }); return st(); } } as unknown as D1Database;
  db.query(`INSERT INTO conversations (id, model, title) VALUES ('c1','m','Alpha'),('c2','m','Beta')`).run();
  const ins = db.query(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run("c1", "claude-sonnet-5-5", 100, 50, 900, 0, 0.10, "2026-09-29 18:00:00");  // = 30 Sep 01:00 VN -> today (VN)
  ins.run("c2", "claude-haiku-4-5", 10, 5, 0, 0, null, "2026-09-29 18:30:00");        // unrated
  ins.run("c1", "claude-sonnet-5-5", 200, 100, 0, 800, 0.40, "2026-09-25 05:00:00");  // this month, not today
  ins.run("c2", "claude-sonnet-5-5", 999, 999, 0, 0, 9.99, "2026-08-15 05:00:00");    // last month: excluded
  test("today / month split in VN time, top conversations, series, cache hit", async () => {
    const rep = await usageReport(d1, Date.UTC(2026, 8, 29, 20, 0, 0), 420);
    expect(rep.today.total).toMatchObject({ calls: 2, unratedCalls: 1 });
    expect(rep.today.total.costUsd).toBeCloseTo(0.10);
    expect(rep.today.total.cacheHit).toBeCloseTo(900 / 1010);
    expect(rep.month.total.calls).toBe(3); expect(rep.month.total.costUsd).toBeCloseTo(0.50);
    expect(rep.month.byModel.map((g) => g.key)).toEqual(["claude-sonnet-5-5", "claude-haiku-4-5"]);
    expect((rep.topConversations as any[]).map((x) => [x.id, x.title])).toEqual([["c1", "Alpha"], ["c2", "Beta"]]);
    expect((rep.topConversations as any[])[0].costUsd).toBeCloseTo(0.50);
    const days = (rep.daily as any[]).map((x) => x.day);
    expect(days).toEqual(["2026-09-25", "2026-09-30"]);
    expect(rep.reconcile).toBeNull();
  });
  test("reconcile row is surfaced; corrupt row is ignored", async () => {
    db.query(`INSERT INTO settings (name, value) VALUES ('gateway_reconcile', ?)`).run(JSON.stringify({ at: "x", drift: { calls: 2 } }));
    expect(((await usageReport(d1, Date.now(), 0)).reconcile as any).drift.calls).toBe(2);
    db.query(`UPDATE settings SET value='{bad' WHERE name='gateway_reconcile'`).run();
    expect((await usageReport(d1, Date.now(), 0)).reconcile).toBeNull();
  });
});
