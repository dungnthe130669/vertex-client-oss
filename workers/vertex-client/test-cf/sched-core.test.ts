import { describe, expect, it } from "vitest";
import { parseCron, cronNextN, due, DEFAULT_BUDGET } from "../src/sched/core";
// The scheduler core must load and compute (Intl IANA time zones, DST) inside workerd.
describe("sched core in workerd", () => {
  it("cron + DST gap/overlap in workerd", () => {
    const g = parseCron("30 2 * * *"); if (!g.ok) throw new Error("parse");
    expect(cronNextN(g.spec, "America/New_York", Date.parse("2026-03-07T12:00:00Z"), 2).map((x) => new Date(x).toISOString())).toEqual(["2026-03-08T07:00:00.000Z", "2026-03-09T06:30:00.000Z"]);
    const o = parseCron("30 1 * * *"); if (!o.ok) throw new Error("parse");
    expect(new Date(cronNextN(o.spec, "America/New_York", Date.parse("2026-10-31T12:00:00Z"), 1)[0]).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    const l = parseCron("0 9 * * *"); if (!l.ok) throw new Error("parse");
    expect(new Date(cronNextN(l.spec, "Australia/Lord_Howe", Date.parse("2026-01-01T00:00:00Z"), 1)[0]).toISOString()).toBe("2026-01-01T22:00:00.000Z");
  });
  it("due() in workerd", () => {
    const T0 = Date.parse("2026-11-05T00:00:00Z");
    const r = due([{ id: "s", enabled: true, deviceId: "d", when: { kind: "every", everySecs: 600, anchor: T0 }, since: T0, missed: "catch_up_once", missedWindowS: 3600, maxQueue: 1, overlap: "skip", maxQueued: 1, budget: DEFAULT_BUDGET }], T0 + 601_000, {});
    expect(r.decisions[0].action).toBe("dispatch");
  });
});
