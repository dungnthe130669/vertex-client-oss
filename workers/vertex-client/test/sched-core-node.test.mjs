// Smoke: the scheduler core loads and works under plain node (also run by bun test). `node --test test/sched-core-node.test.mjs`
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronNextN, due, reduceRun, newRun, idempotencyKey, DEFAULT_BUDGET } from "../src/sched/core.ts";

test("cron + DST gap under node", () => {
  const p = parseCron("30 2 * * *"); assert.ok(p.ok);
  const xs = cronNextN(p.spec, "America/New_York", Date.parse("2026-03-07T12:00:00Z"), 2).map((x) => new Date(x).toISOString());
  assert.deepEqual(xs, ["2026-03-08T07:00:00.000Z", "2026-03-09T06:30:00.000Z"]);
});
test("due + reducer under node", () => {
  const T0 = Date.parse("2026-11-05T00:00:00Z");
  const s = { id: "s", enabled: true, deviceId: "d", when: { kind: "every", everySecs: 600, anchor: T0 }, since: T0, missed: "catch_up_once", missedWindowS: 3600, maxQueue: 1, overlap: "skip", maxQueued: 1, budget: DEFAULT_BUDGET };
  const r = due([s], T0 + 601_000, {});
  assert.equal(r.decisions[0].action, "dispatch");
  assert.equal(r.decisions[0].key, idempotencyKey("s", T0 + 600_000));
  const x = reduceRun(newRun("s", T0 + 600_000), { type: "dispatch", at: 1 });
  assert.ok(x.ok && x.run.status === "dispatched");
});
