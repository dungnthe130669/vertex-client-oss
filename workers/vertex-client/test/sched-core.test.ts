import { describe, expect, test } from "bun:test";
import {
  parseCron, cronNext, cronNextN, tzOffsetMinutes, localToUtc, localParts, validateTimezone, validateWhen, nextSlot, slotsBetween,
  idempotencyKey, attemptKey, parseKey, retryDecision, validateRetry, validateBudget, admit, DEFAULT_BUDGET, DEFAULT_LIMITS,
  newRun, reduceRun, TRANSITIONS, due, nextWake, statusForSkip, slotRange, MINUTE, HOUR, DAY,
  type CronSpec, type ScheduleInput, type RunStatus, type RunEvent, type When,
} from "../src/sched/core";

const U = (s: string) => Date.parse(s + (s.endsWith("Z") ? "" : "Z"));
const spec = (e: string): CronSpec => { const p = parseCron(e); if (!p.ok) throw new Error(p.error.message); return p.spec; };
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().replace(".000Z", "Z"));
const next = (e: string, tz: string, after: string) => iso(cronNext(spec(e), tz, U(after)));
const nextN = (e: string, tz: string, after: string, n: number) => cronNextN(spec(e), tz, U(after), n).map((x) => iso(x));

describe("cron parser", () => {
  test("fields, names, ranges, steps, lists", () => {
    const s = spec("*/15 9-17/2 1,15 jan-mar mon-fri");
    expect(s.minute).toEqual([0, 15, 30, 45]);
    expect(s.hour).toEqual([9, 11, 13, 15, 17]);
    expect(s.dom).toEqual([1, 15]);
    expect(s.month).toEqual([1, 2, 3]);
    expect(s.dow).toEqual([1, 2, 3, 4, 5]);
  });
  test("dow 7 folds to 0, a/n runs to max, uppercase names", () => {
    expect(spec("0 0 * * 7").dow).toEqual([0]);
    expect(spec("0 0 * * SUN,sat").dow).toEqual([0, 6]);
    expect(spec("5/20 * * * *").minute).toEqual([5, 25, 45]);
    expect(spec("0 0 * * *").dow).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  test("aliases", () => {
    expect(spec("@daily").hour).toEqual([0]);
    expect(spec("@hourly").minute).toEqual([0]);
    expect(spec("@weekly").dow).toEqual([0]);
    expect(spec("@monthly").dom).toEqual([1]);
    expect(spec("@yearly").month).toEqual([1]);
    expect(spec("@MIDNIGHT").hour).toEqual([0]);
  });
  const bad: [string, string, string][] = [
    ["", "expression", "empty"], ["* * * *", "expression", "5 fields"], ["* * * * * *", "expression", "5 fields"], ["@often", "expression", "alias"],
    ["60 * * * *", "minute", "out of range 0-59"], ["* 24 * * *", "hour", "out of range 0-23"], ["* * 0 * *", "dayOfMonth", "out of range 1-31"],
    ["* * 32 * *", "dayOfMonth", "out of range"], ["* * * 13 *", "month", "out of range 1-12"], ["* * * * 8", "dayOfWeek", "out of range 0-7"],
    ["*/0 * * * *", "minute", "step"], ["*/x * * * *", "minute", "step"], ["5-1 * * * *", "minute", "starts after"], ["1,,2 * * * *", "minute", "empty"],
    ["* * * foo *", "month", "not a valid"], ["1-2-3 * * * *", "minute", "malformed"], ["1/2/3 * * * *", "minute", "more than one"], ["-5 * * * *", "minute", "malformed"],
  ];
  for (const [e, f, m] of bad) test(`rejects "${e}" -> ${f}`, () => {
    const p = parseCron(e);
    expect(p.ok).toBe(false);
    if (!p.ok) { expect(p.error.field as string).toBe(f); expect(p.error.message).toContain(m); }
  });
});

describe("time zone primitives", () => {
  test("offsets", () => {
    expect(tzOffsetMinutes("UTC", U("2026-06-01T00:00"))).toBe(0);
    expect(tzOffsetMinutes("America/New_York", U("2026-07-01T00:00"))).toBe(-240);
    expect(tzOffsetMinutes("America/New_York", U("2026-01-01T00:00"))).toBe(-300);
    expect(tzOffsetMinutes("Asia/Kolkata", U("2026-01-01T00:00"))).toBe(330);
    expect(tzOffsetMinutes("Australia/Lord_Howe", U("2026-01-01T00:00"))).toBe(660);
    expect(tzOffsetMinutes("Australia/Lord_Howe", U("2026-07-01T00:00"))).toBe(630);
    expect(tzOffsetMinutes("Pacific/Chatham", U("2026-01-01T00:00"))).toBe(825);
    expect(tzOffsetMinutes("Pacific/Chatham", U("2026-07-01T00:00"))).toBe(765);
    expect(tzOffsetMinutes("Asia/Ho_Chi_Minh", U("2026-07-01T00:00"))).toBe(420);
  });
  test("validateTimezone", () => {
    expect(validateTimezone("Europe/London")).toBeNull();
    expect(validateTimezone("UTC")).toBeNull();
    expect(validateTimezone("Mars/Olympus")).toContain("unknown");
    expect(validateTimezone("")).toContain("required");
    expect(validateTimezone(undefined)).toContain("required");
  });
  test("localToUtc ok / gap / overlap (New York 2026: gap Mar 8 02:00, overlap Nov 1 01:00)", () => {
    expect(localToUtc("America/New_York", 2026, 3, 8, 1, 30)).toEqual({ kind: "ok", at: U("2026-03-08T06:30") });
    expect(localToUtc("America/New_York", 2026, 3, 8, 2, 30)).toEqual({ kind: "gap", at: U("2026-03-08T07:00") });
    expect(localToUtc("America/New_York", 2026, 3, 8, 3, 0)).toEqual({ kind: "ok", at: U("2026-03-08T07:00") });
    expect(localToUtc("America/New_York", 2026, 11, 1, 1, 30)).toEqual({ kind: "overlap", first: U("2026-11-01T05:30"), second: U("2026-11-01T06:30") });
  });
  test("localParts roundtrip", () => {
    const p = localParts("Asia/Kolkata", U("2026-01-01T20:00"));
    expect(p).toMatchObject({ y: 2026, mo: 1, d: 2, h: 1, mi: 30 });
  });
});

describe("cron next: basics, calendar", () => {
  test("every minute / hour / daily UTC", () => {
    expect(next("* * * * *", "UTC", "2026-01-01T00:00:00")).toBe("2026-01-01T00:01:00Z");
    expect(next("* * * * *", "UTC", "2026-01-01T00:00:30")).toBe("2026-01-01T00:01:00Z");
    expect(next("0 * * * *", "UTC", "2026-01-01T10:00:00")).toBe("2026-01-01T11:00:00Z"); // strictly after
    expect(next("30 9 * * *", "UTC", "2026-01-01T09:30:00")).toBe("2026-01-02T09:30:00Z");
  });
  test("year boundary", () => {
    expect(next("0 0 1 1 *", "UTC", "2026-06-01T00:00")).toBe("2027-01-01T00:00:00Z");
    expect(next("59 23 * * *", "UTC", "2026-12-31T23:59")).toBe("2027-01-01T23:59:00Z");
    expect(next("0 0 * * *", "UTC", "2026-12-31T00:00")).toBe("2027-01-01T00:00:00Z");
  });
  test("month ends: 31st skips short months", () => {
    expect(nextN("0 12 31 * *", "UTC", "2026-01-01T00:00", 6)).toEqual([
      "2026-01-31T12:00:00Z", "2026-03-31T12:00:00Z", "2026-05-31T12:00:00Z", "2026-07-31T12:00:00Z", "2026-08-31T12:00:00Z", "2026-10-31T12:00:00Z"]);
    expect(next("0 0 30 * *", "UTC", "2026-01-31T00:00")).toBe("2026-03-30T00:00:00Z"); // no Feb 30
  });
  test("leap years / Feb 29", () => {
    expect(nextN("0 0 29 2 *", "UTC", "2026-01-01T00:00", 3)).toEqual(["2028-02-29T00:00:00Z", "2032-02-29T00:00:00Z", "2036-02-29T00:00:00Z"]);
    expect(next("0 0 29 2 *", "UTC", "2096-03-01T00:00")).toBe("2104-02-29T00:00:00Z"); // 2100 is not a leap year
    expect(next("0 0 28 2 *", "UTC", "2028-02-28T00:00")).toBe("2029-02-28T00:00:00Z");
    expect(next("0 0 * * *", "UTC", "2028-02-28T12:00")).toBe("2028-02-29T00:00:00Z");
    expect(next("0 0 * * *", "UTC", "2028-02-29T12:00")).toBe("2028-03-01T00:00:00Z");
    expect(next("0 0 * * *", "UTC", "2027-02-28T12:00")).toBe("2027-03-01T00:00:00Z");
  });
  test("impossible dates return null", () => {
    expect(next("0 0 31 2 *", "UTC", "2026-01-01T00:00")).toBeNull();
    expect(next("0 0 31 4 *", "UTC", "2026-01-01T00:00")).toBeNull();
  });
  test("day-of-week and dom/dow OR semantics", () => {
    expect(next("0 9 * * mon", "UTC", "2026-11-05T00:00")).toBe("2026-11-09T09:00:00Z"); // 2026-11-05 is Thursday
    expect(next("0 9 * * 1-5", "UTC", "2026-11-06T10:00")).toBe("2026-11-09T09:00:00Z"); // Fri after 9 -> Monday
    // both restricted: 13th OR Friday
    expect(nextN("0 0 13 * fri", "UTC", "2026-11-05T00:00", 3)).toEqual(["2026-11-06T00:00:00Z", "2026-11-13T00:00:00Z", "2026-11-20T00:00:00Z"]);
    // dom restricted, dow star -> AND (just dom)
    expect(next("0 0 15 * *", "UTC", "2026-11-05T00:00")).toBe("2026-11-15T00:00:00Z");
  });
  test("lists order and dedupe", () => {
    expect(nextN("5,35 1,13 * * *", "UTC", "2026-01-01T00:00", 5)).toEqual([
      "2026-01-01T01:05:00Z", "2026-01-01T01:35:00Z", "2026-01-01T13:05:00Z", "2026-01-01T13:35:00Z", "2026-01-02T01:05:00Z"]);
  });
});

describe("cron next: time zones without DST / fixed offsets", () => {
  test("Asia/Kolkata (+5:30)", () => {
    expect(next("0 9 * * *", "Asia/Kolkata", "2026-01-01T00:00")).toBe("2026-01-01T03:30:00Z");
    expect(next("0 0 * * *", "Asia/Kolkata", "2026-01-01T20:00")).toBe("2026-01-02T18:30:00Z"); // local day already Jan 2 01:30 -> next midnight is Jan 3 local
  });
  test("Asia/Ho_Chi_Minh (no DST), year boundary in local time", () => {
    expect(next("0 0 1 1 *", "Asia/Ho_Chi_Minh", "2026-06-01T00:00")).toBe("2026-12-31T17:00:00Z");
    expect(nextN("30 6 * * *", "Asia/Ho_Chi_Minh", "2026-02-27T00:00", 3)).toEqual(["2026-02-27T23:30:00Z", "2026-02-28T23:30:00Z", "2026-03-01T23:30:00Z"]);
  });
  test("far-from-UTC zone: local date differs from UTC date", () => {
    // Pacific/Kiritimati +14: local 00:00 on Jan 1 is Dec 31 10:00Z
    expect(next("0 0 1 1 *", "Pacific/Kiritimati", "2026-06-01T00:00")).toBe("2026-12-31T10:00:00Z");
  });
});

describe("cron next: DST", () => {
  test("New York spring forward: 02:30 daily fires once, at 03:00 local (07:00Z)", () => {
    expect(nextN("30 2 * * *", "America/New_York", "2026-03-07T12:00", 4)).toEqual([
      "2026-03-08T07:00:00Z", // gap day: first valid instant
      "2026-03-09T06:30:00Z", // EDT again: 02:30 local
      "2026-03-10T06:30:00Z", "2026-03-11T06:30:00Z"]);
    expect(next("30 2 * * *", "America/New_York", "2026-03-06T12:00")).toBe("2026-03-07T07:30:00Z"); // EST day before
  });
  test("gap: several slots collapse into one instant", () => {
    expect(nextN("*/15 2 * * *", "America/New_York", "2026-03-08T00:00", 2)).toEqual(["2026-03-08T07:00:00Z", "2026-03-09T06:00:00Z"]);
    // and an explicit 03:00 slot on the same day does not add a second run at the same instant
    expect(nextN("0,30 2,3 * * *", "America/New_York", "2026-03-08T05:00", 3)).toEqual(["2026-03-08T07:00:00Z", "2026-03-08T07:30:00Z", "2026-03-09T06:00:00Z"]);
  });
  test("New York fall back: 01:30 fires once (first occurrence, EDT 05:30Z)", () => {
    expect(nextN("30 1 * * *", "America/New_York", "2026-10-31T12:00", 3)).toEqual(["2026-11-01T05:30:00Z", "2026-11-02T06:30:00Z", "2026-11-03T06:30:00Z"]);
    // the slot after the first occurrence is NOT the second 01:30
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00")).toBe("2026-11-02T06:30:00Z");
  });
  test("hourly in overlap hour runs once for the ambiguous hour, plus every normal hour", () => {
    const xs = nextN("0 * * * *", "America/New_York", "2026-11-01T03:30", 4); // 23:30 EDT Oct 31 -> ...
    expect(xs).toEqual(["2026-11-01T04:00:00Z", "2026-11-01T05:00:00Z", "2026-11-01T07:00:00Z", "2026-11-01T08:00:00Z"]);
    // 06:00Z (= second 01:00 local) is not produced: the ambiguous local 01:00 ran once at 05:00Z
  });
  test("Europe/London: gap Mar 29 2026 01:00->02:00, overlap Oct 25 02:00->01:00", () => {
    expect(nextN("30 1 * * *", "Europe/London", "2026-03-28T12:00", 2)).toEqual(["2026-03-29T01:00:00Z", "2026-03-30T00:30:00Z"]);
    expect(nextN("30 1 * * *", "Europe/London", "2026-10-24T12:00", 2)).toEqual(["2026-10-25T00:30:00Z", "2026-10-26T01:30:00Z"]);
  });
  test("Australia/Lord_Howe 30-minute DST (2026: spring fwd Oct 4 02:00->02:30, fall back Apr 5 02:00->01:30)", () => {
    expect(tzOffsetMinutes("Australia/Lord_Howe", U("2026-10-03T00:00"))).toBe(630);
    expect(tzOffsetMinutes("Australia/Lord_Howe", U("2026-10-05T00:00"))).toBe(660);
    // 02:15 local on Oct 4 does not exist; first valid instant is 02:30 local = 02:00 UTC-10:30 -> 15:30Z Oct 3
    expect(nextN("15 2 * * *", "Australia/Lord_Howe", "2026-10-03T00:00", 3)).toEqual(["2026-10-03T15:30:00Z", "2026-10-04T15:15:00Z", "2026-10-05T15:15:00Z"]);
    // fall back: 01:45 local Apr 5 happens twice, fires once (first)
    const r = localToUtc("Australia/Lord_Howe", 2026, 4, 5, 1, 45);
    expect(r.kind).toBe("overlap");
    expect(nextN("45 1 * * *", "Australia/Lord_Howe", "2026-04-03T12:00", 3).length).toBe(3);
    const apr5 = cronNextN(spec("45 1 * * *"), "Australia/Lord_Howe", U("2026-04-04T00:00"), 3);
    const gaps = apr5.slice(1).map((v, i) => v - apr5[i]);
    expect(gaps.every((g) => g > 23 * HOUR && g < 25 * HOUR)).toBe(true);
  });
  test("Pacific/Chatham (+12:45/+13:45)", () => {
    expect(next("0 9 * * *", "Pacific/Chatham", "2026-07-01T00:00")).toBe("2026-07-01T20:15:00Z"); // +12:45
    expect(next("0 9 * * *", "Pacific/Chatham", "2026-01-01T00:00")).toBe("2026-01-01T19:15:00Z"); // +13:45
  });
  test("southern hemisphere: Australia/Sydney gap 2026-10-04 02:00->03:00", () => {
    expect(nextN("30 2 * * *", "Australia/Sydney", "2026-10-03T00:00", 2)).toEqual(["2026-10-03T16:00:00Z", "2026-10-04T15:30:00Z"]);
  });
  test("zone without DST has no gaps: Asia/Tokyo 02:30 daily is steady", () => {
    const xs = cronNextN(spec("30 2 * * *"), "Asia/Tokyo", U("2026-01-01T00:00"), 400);
    expect(xs.every((v, i) => i === 0 || v - xs[i - 1] === DAY)).toBe(true);
  });
  test("every day of a full year: exactly one run per local day in New York, DST or not", () => {
    for (const e of ["30 2 * * *", "30 1 * * *", "0 0 * * *", "59 23 * * *"]) {
      const xs = cronNextN(spec(e), "America/New_York", U("2026-01-01T05:00") - 1, 365);
      expect(xs.length).toBe(365);
      expect(new Set(xs).size).toBe(365);
      expect(xs.every((v, i) => i === 0 || v > xs[i - 1])).toBe(true);
      const days = new Set(xs.map((v) => { const p = localParts("America/New_York", v); return `${p.y}-${p.mo}-${p.d}`; }));
      expect(days.size).toBe(365);
    }
  });
  test("monotonic across 5 years in several zones (no repeats, no going back, local hour preserved except in gaps)", () => {
    for (const tz of ["America/New_York", "Europe/London", "Australia/Lord_Howe", "Pacific/Chatham", "Asia/Kolkata", "UTC"]) {
      const xs = cronNextN(spec("15 3 * * *"), tz, U("2026-01-01T00:00"), 5 * 366);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
      const bad = xs.filter((v) => { const p = localParts(tz, v); return !(p.h === 3 && p.mi === 15) && !(p.mi === 0 || p.mi === 30 || p.mi === 15 || p.mi === 45); });
      expect(bad.length).toBe(0);
    }
  });
});

describe("schedules: every / at / validation", () => {
  const every: When = { kind: "every", everySecs: 600, anchor: U("2026-01-01T00:00") };
  test("every: grid from anchor, strictly after", () => {
    expect(iso(nextSlot(every, U("2026-01-01T00:00")))).toBe("2026-01-01T00:10:00Z");
    expect(iso(nextSlot(every, U("2026-01-01T00:09:59")))).toBe("2026-01-01T00:10:00Z");
    expect(iso(nextSlot(every, U("2026-01-01T00:10:00")))).toBe("2026-01-01T00:20:00Z");
    expect(iso(nextSlot(every, U("2025-01-01T00:00")))).toBe("2026-01-01T00:00:00Z");
    expect(iso(nextSlot(every, U("2030-05-05T05:05:05")))).toBe("2030-05-05T05:10:00Z");
  });
  test("at: once", () => {
    const at: When = { kind: "at", at: U("2026-12-01T00:00") };
    expect(nextSlot(at, U("2026-11-01T00:00"))).toBe(U("2026-12-01T00:00"));
    expect(nextSlot(at, U("2026-12-01T00:00"))).toBeNull();
  });
  test("slotsBetween caps and reports truncation", () => {
    expect(slotsBetween(every, U("2026-01-01T00:00"), U("2026-01-01T01:00"), 100).slots.length).toBe(6);
    const r = slotsBetween(every, U("2026-01-01T00:00"), U("2026-01-02T00:00"), 10);
    expect(r.slots.length).toBe(10); expect(r.truncated).toBe(true);
  });
  const now = U("2026-11-05T00:00");
  test("validateWhen", () => {
    expect(validateWhen({ kind: "cron", cron: "0 9 * * *", tz: "Asia/Ho_Chi_Minh" }, now)).toBeNull();
    expect(validateWhen({ kind: "cron", cron: "0 9 * *", tz: "UTC" }, now)?.field).toBe("expression");
    expect(validateWhen({ kind: "cron", cron: "99 9 * * *", tz: "UTC" }, now)?.field).toBe("minute");
    expect(validateWhen({ kind: "cron", cron: "0 9 * * *", tz: "Nope/Nope" }, now)?.field).toBe("tz");
    expect(validateWhen({ kind: "cron", cron: "* * * * *", tz: "UTC" }, now)?.message).toContain("more often");
    expect(validateWhen({ kind: "cron", cron: "*/5 * * * *", tz: "UTC" }, now)).toBeNull();
    expect(validateWhen({ kind: "cron", cron: "0 0 31 2 *", tz: "UTC" }, now)?.message).toContain("never");
    expect(validateWhen({ kind: "every", everySecs: 60, anchor: now }, now)?.field).toBe("everySecs");
    expect(validateWhen({ kind: "every", everySecs: 300.5, anchor: now }, now)?.field).toBe("everySecs");
    expect(validateWhen({ kind: "every", everySecs: 300, anchor: now }, now)).toBeNull();
    expect(validateWhen({ kind: "at", at: now - 1 }, now)?.message).toContain("past");
    expect(validateWhen({ kind: "at", at: now + 1 }, now)).toBeNull();
    expect(validateWhen({ kind: "at", at: NaN }, now)).not.toBeNull();
  });
  test("nextSlot on an invalid cron/tz is null, not a throw", () => {
    expect(nextSlot({ kind: "cron", cron: "bad", tz: "UTC" }, 0)).toBeNull();
    expect(nextSlot({ kind: "cron", cron: "0 0 * * *", tz: "Nope" }, 0)).toBeNull();
  });
});

describe("idempotency keys", () => {
  test("deterministic, distinct per (schedule, instant), parseable", () => {
    expect(idempotencyKey("s1", 1000)).toBe(idempotencyKey("s1", 1000));
    expect(idempotencyKey("s1", 1000)).not.toBe(idempotencyKey("s1", 1001));
    expect(idempotencyKey("s1", 1000)).not.toBe(idempotencyKey("s2", 1000));
    expect(idempotencyKey("s1", 1783296000000)).toBe("s1@1783296000000");
    expect(attemptKey("s1", 5, 1)).toBe("s1@5");
    expect(attemptKey("s1", 5, 3)).toBe("s1@5#3");
    expect(parseKey("s1@5#3")).toEqual({ scheduleId: "s1", plannedMs: 5, attempt: 3 });
    expect(parseKey("a@b@77")).toEqual({ scheduleId: "a@b", plannedMs: 77, attempt: 1 });
    expect(parseKey("nope")).toBeNull();
  });
  test("two alarms computing the same slot produce the same key", () => {
    const w: When = { kind: "cron", cron: "0 9 * * *", tz: "America/New_York" };
    const a = nextSlot(w, U("2026-03-07T12:00")), b = nextSlot(w, U("2026-03-07T12:00:01"));
    expect(idempotencyKey("x", a!)).toBe(idempotencyKey("x", b!));
  });
});

describe("retry / budget / admit", () => {
  const p = { max: 2, backoffS: [60, 300, 900], on: ["start_failed", "device_lost"] as ("start_failed" | "device_lost")[] };
  test("retryDecision", () => {
    expect(retryDecision(p, "start_failed", 1, 1000)).toEqual({ retry: true, atMs: 61_000, attempt: 2 });
    expect(retryDecision(p, "device_lost", 2, 1000)).toEqual({ retry: true, atMs: 301_000, attempt: 3 });
    expect(retryDecision(p, "start_failed", 3, 1000)).toEqual({ retry: false, why: "exhausted" });
    expect(retryDecision(p, "tool_error", 1, 1000)).toEqual({ retry: false, why: "not_retryable" });
    expect(retryDecision({ ...p, max: 0 }, "start_failed", 1, 0)).toEqual({ retry: false, why: "disabled" });
    expect(retryDecision({ max: 3, backoffS: [10], on: ["start_failed"] }, "start_failed", 3, 0)).toEqual({ retry: true, atMs: 10_000, attempt: 4 }); // last backoff repeats
    expect(retryDecision({ max: 1, backoffS: [], on: ["start_failed"] }, "start_failed", 1, 0)).toEqual({ retry: true, atMs: 60_000, attempt: 2 });
  });
  test("validateRetry / validateBudget", () => {
    expect(validateRetry(p)).toBeNull();
    expect(validateRetry({ ...p, max: 4 })?.field).toBe("retry.max");
    expect(validateRetry({ ...p, backoffS: [0] })?.field).toBe("retry.backoffS");
    expect(validateBudget(DEFAULT_BUDGET)).toBeNull();
    expect(validateBudget({ ...DEFAULT_BUDGET, maxUsd: 0 })?.field).toBe("budget.maxUsd");
    expect(validateBudget({ ...DEFAULT_BUDGET, maxUsd: NaN })?.field).toBe("budget.maxUsd");
    expect(validateBudget({ ...DEFAULT_BUDGET, maxTurns: 0 })?.field).toBe("budget.maxTurns");
    expect(validateBudget({ ...DEFAULT_BUDGET, maxSecs: 3601 })?.field).toBe("budget.maxSecs");
    expect(validateBudget({ ...DEFAULT_BUDGET, maxSecs: 3600 })).toBeNull();
  });
  test("admit", () => {
    const base = { budget: DEFAULT_BUDGET, spentTodayUsd: 0, deviceRunning: 0, globalRunning: 0, limits: DEFAULT_LIMITS };
    expect(admit(base)).toEqual({ ok: true });
    expect(admit({ ...base, deviceRunning: 1 })).toEqual({ ok: false, outcome: "hold", reason: "device_busy" });
    expect(admit({ ...base, globalRunning: 4 })).toEqual({ ok: false, outcome: "hold", reason: "global_busy" });
    const capped = { ...DEFAULT_LIMITS, dailyUsdCap: 2 };
    expect(admit({ ...base, limits: capped, spentTodayUsd: 1 })).toEqual({ ok: true });
    expect(admit({ ...base, limits: capped, spentTodayUsd: 1.01 })).toEqual({ ok: false, outcome: "skip", reason: "budget_daily" });
  });
  test("statusForSkip", () => {
    expect(statusForSkip("late")).toBe("missed"); expect(statusForSkip("offline")).toBe("missed"); expect(statusForSkip("overlap")).toBe("skipped"); expect(statusForSkip("budget_daily")).toBe("skipped");
  });
});

describe("run reducer", () => {
  const STATUSES: RunStatus[] = ["planned", "dispatched", "running", "succeeded", "failed", "missed", "killed", "skipped"];
  const EVENTS: RunEvent["type"][] = ["dispatch", "started", "succeed", "fail", "kill", "miss", "skip"];
  const ev = (type: RunEvent["type"]): RunEvent => ({ type, at: 5 }) as RunEvent;
  test("exhaustive table: every (status, event) pair either follows the table or is rejected/no-op", () => {
    for (const s of STATUSES) for (const t of EVENTS) {
      const run = { ...newRun("s", 1), status: s };
      const r = reduceRun(run, ev(t));
      const want = TRANSITIONS[s][t];
      if (want) { expect(r.ok).toBe(true); if (r.ok) { expect(r.run.status).toBe(want); expect(r.noop).toBe(false); } }
      else if (r.ok) expect(r.noop).toBe(true); // only idempotent replays
      if (!want && r.ok) expect(r.run.status).toBe(s);
      if (!r.ok) expect(r.error).toContain("illegal");
    }
  });
  test("terminal states never leave", () => {
    for (const s of ["succeeded", "failed", "missed", "killed", "skipped"] as RunStatus[]) expect(Object.keys(TRANSITIONS[s]).length).toBe(0);
  });
  test("happy path with timestamps", () => {
    let r = newRun("s", 100);
    expect(r.key).toBe("s@100");
    const step = (e: RunEvent) => { const x = reduceRun(r, e); if (!x.ok) throw new Error(x.error); r = x.run; };
    step({ type: "dispatch", at: 1 }); step({ type: "started", at: 2 }); step({ type: "succeed", at: 3 });
    expect(r).toMatchObject({ status: "succeeded", dispatchedAt: 1, startedAt: 2, finishedAt: 3 });
  });
  test("idempotent replays: duplicate dispatch/started/terminal are no-ops; conflicting terminal is rejected", () => {
    let r = newRun("s", 1);
    r = (reduceRun(r, ev("dispatch")) as any).run;
    expect((reduceRun(r, ev("dispatch")) as any).noop).toBe(true);
    r = (reduceRun(r, ev("started")) as any).run;
    expect((reduceRun(r, ev("started")) as any).noop).toBe(true);
    r = (reduceRun(r, { type: "fail", at: 9, reason: "boom" }) as any).run;
    expect(r.reason).toBe("boom");
    const again = reduceRun(r, { type: "fail", at: 99, reason: "other" }) as any;
    expect(again.noop).toBe(true); expect(again.run.finishedAt).toBe(9);
    expect(reduceRun(r, ev("succeed")).ok).toBe(false);
    expect(reduceRun(r, ev("started")).ok).toBe(false);
  });
  test("planned can be missed/skipped/killed but not started directly", () => {
    const r = newRun("s", 1);
    expect(reduceRun(r, ev("started")).ok).toBe(false);
    expect(reduceRun(r, { type: "miss", at: 1, reason: "late" }).ok).toBe(true);
    expect(reduceRun(r, { type: "skip", at: 1, reason: "overlap" }).ok).toBe(true);
  });
  test("input run is never mutated", () => {
    const r = newRun("s", 1); const copy = JSON.stringify(r);
    reduceRun(r, ev("dispatch")); expect(JSON.stringify(r)).toBe(copy);
  });
});

describe("due()", () => {
  const T0 = U("2026-11-05T00:00");
  const sched = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
    id: "s1", enabled: true, deviceId: "d1", when: { kind: "cron", cron: "0 * * * *", tz: "UTC" }, since: T0, missed: "catch_up_once", missedWindowS: 6 * 3600,
    maxQueue: 3, overlap: "skip", maxQueued: 1, budget: DEFAULT_BUDGET, ...over,
  });
  const last = (o: any = {}) => ({ running: false, queued: 0, spentTodayUsd: 0, deviceOnline: true, ...o });
  const run = (ss: ScheduleInput[], now: number, lr: Record<string, any> = {}, opts = {}) => due(ss, now, lr, opts);

  test("nothing due before the first slot", () => { expect(run([sched()], T0 + 30 * MINUTE).decisions).toEqual([]); });
  test("on-time slot dispatches", () => {
    const r = run([sched()], T0 + HOUR + 20_000);
    expect(r.decisions).toEqual([{ scheduleId: "s1", plannedMs: T0 + HOUR, key: `s1@${T0 + HOUR}`, action: "dispatch" }]);
  });
  test("disabled and clock-backwards", () => {
    expect(run([sched({ enabled: false })], T0 + 5 * HOUR).decisions).toEqual([]);
    const r = run([sched()], T0 - HOUR, { s1: last({ lastPlannedMs: T0 + 2 * HOUR }) });
    expect(r.decisions).toEqual([]);
    const r2 = run([sched()], T0 + HOUR, { s1: last({ lastPlannedMs: T0 + 3 * HOUR }) });
    expect(r2.clockWentBackwards).toEqual(["s1"]); expect(r2.decisions).toEqual([]);
  });
  test("already-recorded slot is not dispatched again (idempotent re-run of due)", () => {
    const now = T0 + HOUR + 5_000;
    const first = run([sched()], now);
    const again = run([sched()], now, { s1: last({ lastPlannedMs: first.decisions[0].plannedMs }) });
    expect(first.decisions.length).toBe(1); expect(again.decisions).toEqual([]);
  });
  test("catch-up-once after 3 days offline: one late summary + one dispatch of the latest in-window slot", () => {
    const now = T0 + 3 * DAY + 20 * MINUTE; // slots hourly; window 6h
    const r = run([sched()], now);
    const d = r.decisions;
    const late = d.filter((x) => x.reason === "late");
    expect(late.length).toBe(1);
    expect(late[0].count).toBe(3 * 24 - 6 - 0); // hourly slots in (T0, now-6h-1]: 66 (01:00 d0 .. 18:00 d2... end 66th)
    const disp = d.filter((x) => x.action === "dispatch");
    expect(disp.length).toBe(1);
    expect(disp[0].plannedMs).toBe(T0 + 3 * DAY); // latest slot (00:00 day 3)
    expect(d.filter((x) => x.reason === "superseded").length).toBe(1);
    // no duplicate keys, all keys distinct
    expect(new Set(d.map((x) => x.key)).size).toBe(d.length);
    expect(d.length).toBeLessThanOrEqual(3);
  });
  test("skip policy offline days: nothing dispatches, bounded rows", () => {
    const r = run([sched({ missed: "skip" })], T0 + 3 * DAY + 20 * MINUTE);
    expect(r.decisions.filter((x) => x.action === "dispatch").length).toBe(0);
    expect(r.decisions.length).toBeLessThanOrEqual(3);
    expect(r.decisions.every((x) => x.status === "missed")).toBe(true);
  });
  test("skip policy: a slot within grace is still on time", () => {
    const r = run([sched({ missed: "skip" })], T0 + HOUR + 90_000);
    expect(r.decisions.map((x) => x.action)).toEqual(["dispatch"]);
  });
  test("queue_bounded dispatches the latest N in order (overlap allow)", () => {
    const r = run([sched({ missed: "queue_bounded", maxQueue: 3, overlap: "allow" })], T0 + 5 * HOUR + 10 * MINUTE, {}, { limits: { ...DEFAULT_LIMITS, maxConcurrentDevice: 9 } });
    const disp = r.decisions.filter((x) => x.action === "dispatch").map((x) => x.plannedMs);
    expect(disp).toEqual([T0 + 3 * HOUR, T0 + 4 * HOUR, T0 + 5 * HOUR]);
    expect(r.decisions.find((x) => x.reason === "queue_overflow")?.count).toBe(2);
  });
  test("queue_bounded with overlap=skip: only the first dispatches, rest overlap-skipped", () => {
    const r = run([sched({ missed: "queue_bounded", maxQueue: 3, overlap: "skip" })], T0 + 5 * HOUR + 10 * MINUTE);
    expect(r.decisions.filter((x) => x.action === "dispatch").length).toBe(1);
    expect(r.decisions.find((x) => x.reason === "overlap")?.count).toBe(2);
  });
  test("overlap policies against a running run", () => {
    const now = T0 + HOUR + 10_000;
    expect(run([sched({ overlap: "skip" })], now, { s1: last({ running: true }) }).decisions[0]).toMatchObject({ action: "skip", reason: "overlap", status: "skipped" });
    expect(run([sched({ overlap: "queue", maxQueued: 1 })], now, { s1: last({ running: true }) }).decisions[0].action).toBe("queue");
    expect(run([sched({ overlap: "queue", maxQueued: 1 })], now, { s1: last({ running: true, queued: 1 }) }).decisions[0]).toMatchObject({ action: "skip", reason: "overlap" });
    expect(run([sched({ overlap: "allow" })], now, { s1: last({ running: true }) }).decisions[0].action).toBe("dispatch");
  });
  test("device offline: skip records offline; catch-up policies hold, then dispatch on reconnect", () => {
    const now = T0 + HOUR + 20 * MINUTE;
    expect(run([sched({ missed: "skip" })], now, { s1: last({ deviceOnline: false }) }).decisions[0]).toMatchObject({ action: "skip", reason: "offline", status: "missed" });
    const h = run([sched()], now, { s1: last({ deviceOnline: false }) });
    expect(h.decisions).toEqual([]); expect(h.held).toEqual(["s1"]);
    const back = run([sched()], now + 10 * MINUTE, { s1: last({ deviceOnline: true }) });
    expect(back.decisions.map((x) => x.action)).toEqual(["dispatch"]);
    expect(back.decisions[0].plannedMs).toBe(T0 + HOUR);
  });
  test("offline past the window: slot is late-skipped even for catch-up", () => {
    const r = run([sched({ missedWindowS: 1800 })], T0 + HOUR + 40 * MINUTE, { s1: last({ deviceOnline: false }) });
    expect(r.decisions[0]).toMatchObject({ action: "skip", reason: "late", status: "missed", count: 1 });
  });
  test("budget_daily skips, device concurrency holds and blocks later slots from overtaking", () => {
    const lim = { ...DEFAULT_LIMITS, dailyUsdCap: 1.5 };
    expect(run([sched()], T0 + HOUR + 1000, { s1: last({ spentTodayUsd: 1 }) }, { limits: lim }).decisions[0]).toMatchObject({ action: "skip", reason: "budget_daily" });
    const r = run([sched()], T0 + HOUR + 1000, {}, { deviceRunning: { d1: 1 } });
    expect(r.decisions).toEqual([]); expect(r.held).toEqual(["s1"]);
  });
  test("global/device caps are shared across schedules within one due() call", () => {
    const a = sched({ id: "a" }), b = sched({ id: "b", deviceId: "d2" }), c = sched({ id: "c", deviceId: "d2" });
    const r = run([a, b, c], T0 + HOUR + 1000, {}, { limits: { ...DEFAULT_LIMITS, maxConcurrentGlobal: 2 } });
    expect(r.decisions.filter((x) => x.action === "dispatch").map((x) => x.scheduleId)).toEqual(["a", "b"]);
    expect(r.held).toEqual(["c"]);
  });
  test("schedule created in the past: since=createdAt; slots before creation are never run", () => {
    const created = T0 + 90 * MINUTE; // created 01:30
    const r = run([sched({ since: created })], T0 + 2 * HOUR + 5000);
    expect(r.decisions.map((x) => x.plannedMs)).toEqual([T0 + 2 * HOUR]);
  });
  test("one-shot in (since, now] fires once (catch-up), then never again", () => {
    const at: When = { kind: "at", at: T0 + 10 * MINUTE };
    const r = run([sched({ when: at })], T0 + 20 * MINUTE);
    expect(r.decisions.map((x) => x.action)).toEqual(["dispatch"]);
    expect(run([sched({ when: at })], T0 + 2 * DAY, { s1: last({ lastPlannedMs: T0 + 10 * MINUTE }) }).decisions).toEqual([]);
  });
  test("every-interval schedule, device off for 10 days, dense 5-minute grid: bounded work and rows", () => {
    const w: When = { kind: "every", everySecs: 300, anchor: T0 };
    const t = Date.now();
    const r = run([sched({ when: w })], T0 + 10 * DAY + 2 * MINUTE, {}, { enumCap: 500 });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.decisions.length).toBeLessThanOrEqual(5);
    expect(r.decisions.filter((x) => x.action === "dispatch").length).toBe(1);
    const planned = r.decisions.filter((x) => x.action === "dispatch")[0].plannedMs;
    expect(planned).toBe(T0 + 10 * DAY);
  });
  test("DST day through due(): New York daily 02:30 dispatches exactly once on the gap day", () => {
    const s = sched({ when: { kind: "cron", cron: "30 2 * * *", tz: "America/New_York" }, since: U("2026-03-07T12:00"), missed: "catch_up_once" });
    const tick = (now: number, lr: any) => run([s], now, { s1: lr });
    const r1 = tick(U("2026-03-08T07:00:30"), undefined);
    expect(r1.decisions.map((x) => x.action)).toEqual(["dispatch"]);
    const r2 = tick(U("2026-03-08T07:30:00"), { lastPlannedMs: r1.decisions[0].plannedMs });
    expect(r2.decisions).toEqual([]);
    const r3 = tick(U("2026-03-09T06:30:10"), { lastPlannedMs: r1.decisions[0].plannedMs });
    expect(r3.decisions.length).toBe(1);
  });
  test("DST fall-back through due(): the ambiguous 01:30 does not run twice", () => {
    const s = sched({ when: { kind: "cron", cron: "30 1 * * *", tz: "America/New_York" }, since: U("2026-10-31T12:00") });
    const r1 = run([s], U("2026-11-01T05:30:10"), {});
    expect(r1.decisions.length).toBe(1);
    const lp = r1.decisions[0].plannedMs;
    expect(run([s], U("2026-11-01T06:30:10"), { s1: last({ lastPlannedMs: lp }) }).decisions).toEqual([]);
  });
  test("year boundary and leap day via due()", () => {
    const s = sched({ when: { kind: "cron", cron: "0 0 29 2 *", tz: "UTC" }, since: U("2026-01-01T00:00"), missedWindowS: 3600 });
    const r = run([s], U("2028-02-29T00:00:30"), {});
    expect(r.decisions.map((x) => x.action)).toEqual(["dispatch"]);
    expect(r.decisions[0].plannedMs).toBe(U("2028-02-29T00:00"));
  });
  test("decisions are deterministic: same inputs, same output (property: shuffled order, no contention so no priority effect)", () => {
    const ss = ["a", "b", "c", "d"].map((id, i) => sched({ id, deviceId: "d" + i }));
    const now = T0 + 7 * HOUR + 10 * MINUTE;
    const norm = (r: ReturnType<typeof due>) => JSON.stringify(r.decisions.map((x) => x.key).sort());
    const base = norm(run(ss, now)); let seed = 7;
    for (let i = 0; i < 20; i++) {
      const sh = [...ss]; for (let j = sh.length - 1; j > 0; j--) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const k = seed % (j + 1); [sh[j], sh[k]] = [sh[k], sh[j]]; }
      expect(norm(run(sh, now))).toBe(base);
    }
  });
  test("property: for random lastPlanned / now, dispatched slots are unique, increasing, > since and <= now, and never replayed", () => {
    let seed = 42; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 200; i++) {
      const missed = (["skip", "catch_up_once", "queue_bounded"] as const)[rnd(3)];
      const w: When = rnd(2) ? { kind: "cron", cron: ["*/10 * * * *", "0 3 * * *", "15 */2 * * *", "30 2 * * *"][rnd(4)], tz: ["UTC", "America/New_York", "Australia/Lord_Howe"][rnd(3)] } : { kind: "every", everySecs: 300 + rnd(5000), anchor: T0 };
      const s = sched({ when: w, missed, overlap: "allow", maxQueue: 1 + rnd(4), missedWindowS: 600 + rnd(90000), since: T0 + rnd(DAY) });
      const now = s.since + rnd(20 * DAY) + 1;
      const r = run([s], now);
      const disp = r.decisions.filter((x) => x.action === "dispatch").map((x) => x.plannedMs);
      expect(disp.every((p, j) => p > s.since && p <= now && (j === 0 || p > disp[j - 1]))).toBe(true);
      expect(new Set(r.decisions.map((x) => x.key)).size).toBe(r.decisions.length);
      const maxP = Math.max(...r.decisions.map((x) => x.plannedMs), -Infinity);
      if (Number.isFinite(maxP)) expect(run([s], now, { s1: last({ lastPlannedMs: maxP }) }).decisions).toEqual([]);
    }
  });
});

describe("nextWake", () => {
  test("min over enabled schedules; null if none", () => {
    const T0 = U("2026-11-05T00:00");
    const mk = (id: string, when: When, enabled = true): ScheduleInput => ({ id, enabled, deviceId: "d", when, since: T0, missed: "skip", missedWindowS: 3600, maxQueue: 1, overlap: "skip", maxQueued: 1, budget: DEFAULT_BUDGET });
    const a = mk("a", { kind: "cron", cron: "0 9 * * *", tz: "UTC" }), b = mk("b", { kind: "every", everySecs: 600, anchor: T0 }), c = mk("c", { kind: "at", at: T0 + 1000 }, false);
    expect(nextWake([a, b, c])).toBe(T0 + 600_000);
    expect(nextWake([a, b, c], { b: { running: false, queued: 0, spentTodayUsd: 0, deviceOnline: true, lastPlannedMs: T0 + 600_000 } })).toBe(T0 + 1_200_000);
    expect(nextWake([c])).toBeNull();
    expect(nextWake([mk("d", { kind: "at", at: T0 - 5 })])).toBeNull();
  });
});

describe("vclsched3 regressions (review findings)", () => {
  test("stepped N/step form for every field", () => {
    expect(spec("7/1 * * * *").minute.length).toBe(53);
    expect(spec("50/5 * * * *").minute).toEqual([50, 55]);
    expect(spec("0 20/2 * * *").hour).toEqual([20, 22]);
    expect(spec("0 0 25/3 * *").dom).toEqual([25, 28, 31]);
    expect(spec("0 0 1 9/2 *").month).toEqual([9, 11]);
    expect(spec("0 0 1 oct/1 *").month).toEqual([10, 11, 12]);
    expect(spec("0 0 * * 7/1").dow).toEqual([0]);
    expect(spec("0 0 * * 1/2").dow).toEqual([0, 1, 3, 5]);
    expect(spec("0 0 * * 6/1").dow).toEqual([0, 6]);
    expect(spec("0 0 * * 0/3").dow).toEqual([0, 3, 6]);
    expect(spec("0 0 * * 7-7/1").dow).toEqual([0]);
  });
  test("frequency validation does not depend on the creation instant", () => {
    for (const t of ["2026-01-01T00:00", "2026-01-01T03:00", "2026-06-15T02:57", "2026-03-08T09:00"])
      expect(validateWhen({ kind: "cron", cron: "*/7 2-3 * * *", tz: "UTC" }, U(t))?.message).toContain("more often");
    expect(validateWhen({ kind: "cron", cron: "1,58 0,23 * * *", tz: "UTC" }, U("2026-01-01T00:00"))?.message).toContain("more often"); // wrap 23:58 -> 00:01
    expect(validateWhen({ kind: "cron", cron: "*/10 2-3 * * *", tz: "UTC" }, U("2026-01-01T03:00"))).toBeNull();
    expect(validateWhen({ kind: "cron", cron: "0 0 * * *", tz: "UTC" }, U("2026-01-01T03:00"))).toBeNull();
  });
  test("Monrovia 1970 second-level offset is honoured", () => {
    expect(tzOffsetMinutes("Africa/Monrovia", U("1970-01-02T00:00"))).toBe(-44.5);
    const r = localToUtc("Africa/Monrovia", 1970, 1, 2, 0, 0);
    expect(r.kind).toBe("ok"); expect(iso((r as any).at)).toBe("1970-01-02T00:44:30Z");
  });
  const T0 = U("2026-11-05T00:00");
  const sc = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({ id: "s1", enabled: true, deviceId: "d1", when: { kind: "every", everySecs: 300, anchor: T0 }, since: T0, missed: "catch_up_once", missedWindowS: 6 * 3600, maxQueue: 3, overlap: "skip", maxQueued: 1, budget: DEFAULT_BUDGET, ...over });
  const total = (r: ReturnType<typeof due>) => r.decisions.reduce((n, d) => n + (d.count ?? 1), 0);
  test.each([["every", { kind: "every", everySecs: 300, anchor: T0 } as When], ["cron", { kind: "cron", cron: "*/5 * * * *", tz: "UTC" } as When]])(
    "%s: ten days offline, default cap, accounts for all 2,880 slots", (_n, w) => {
    const now = T0 + 10 * DAY;
    const r = due([sc({ when: w, missedWindowS: 3600 })], now, {});
    expect(total(r)).toBe(2880);
    expect(r.decisions.filter((d) => d.action === "dispatch").map((d) => d.plannedMs)).toEqual([now]);
    const maxP = Math.max(...r.decisions.map((d) => d.plannedMs));
    expect(maxP).toBe(now);
    expect(due([sc({ when: w, missedWindowS: 3600 })], now, { s1: { running: false, queued: 0, spentTodayUsd: 0, deviceOnline: true, lastPlannedMs: maxP } }).decisions).toEqual([]);
  });
  test.each([["every", { kind: "every", everySecs: 300, anchor: T0 } as When], ["cron", { kind: "cron", cron: "*/5 * * * *", tz: "UTC" } as When]])(
    "%s: twenty days, 30-day window, catch_up_once dispatches only the newest slot, repeat is empty", (_n, w) => {
    const now = T0 + 20 * DAY, s = sc({ when: w, missedWindowS: 30 * 86400 });
    const r = due([s], now, {});
    expect(total(r)).toBe(5760);
    expect(r.decisions.filter((d) => d.action === "dispatch").map((d) => d.plannedMs)).toEqual([now]);
    expect(new Set(r.decisions.map((d) => d.key)).size).toBe(r.decisions.length);
    expect(due([s], now, { s1: { running: false, queued: 0, spentTodayUsd: 0, deviceOnline: true, lastPlannedMs: now } }).decisions).toEqual([]);
  });
  test("cron work ceiling is resumable: the cursor never crosses unprocessed slots", () => {
    const w: When = { kind: "cron", cron: "*/5 * * * *", tz: "UTC" }, s = sc({ when: w, missedWindowS: 3600 }), now = T0 + 10 * DAY;
    let lp: number | undefined, seen = 0, rounds = 0;
    while (rounds++ < 10) {
      const r = due([s], now, lp === undefined ? {} : { s1: { running: false, queued: 0, spentTodayUsd: 0, deviceOnline: true, lastPlannedMs: lp } }, { enumCeiling: 1000 });
      if (!r.decisions.length) break;
      seen += total(r); lp = Math.max(...r.decisions.map((d) => d.plannedMs));
    }
    expect(seen).toBe(2880);
  });
  test("slotRange: counts exactly, keeps the newest, ceiling reports exhausted:false", () => {
    const w: When = { kind: "every", everySecs: 300, anchor: T0 };
    const r = slotRange(w, T0 - 1, T0 + DAY, 3);
    expect(r.count).toBe(289); expect(r.tail).toEqual([T0 + DAY - 600_000, T0 + DAY - 300_000, T0 + DAY]);
    expect(slotRange({ kind: "cron", cron: "*/5 * * * *", tz: "UTC" }, T0 - 1, T0 + DAY, 3)).toEqual(r);
    expect(slotRange({ kind: "cron", cron: "*/5 * * * *", tz: "UTC" }, T0 - 1, T0 + DAY, 3, 10).exhausted).toBe(false);
  });
  test("input order is admission priority under shared concurrency (documented contract)", () => {
    const mk = (id: string) => sc({ id, deviceId: id, when: { kind: "cron", cron: "0 * * * *", tz: "UTC" } });
    const now = T0 + HOUR + 5000, o = { limits: { ...DEFAULT_LIMITS, maxConcurrentGlobal: 1 } };
    const disp = (r: ReturnType<typeof due>) => r.decisions.filter((d) => d.action === "dispatch").map((d) => d.scheduleId);
    expect(disp(due([mk("a"), mk("b")], now, {}, o))).toEqual(["a"]);
    expect(disp(due([mk("b"), mk("a")], now, {}, o))).toEqual(["b"]);
  });
});

describe("vclsched4 regressions (re-review findings)", () => {
  const S0 = Date.UTC(2027, 0, 1);
  test("ceiling hit: newest bounded queue still dispatched exactly once (default settings, 50,001 slots)", () => {
    const w: When = { kind: "cron", cron: "*/5 * * * *", tz: "UTC" };
    const base = S0 - 1, now = S0 + 50_000 * 300_000; // slots S0 .. now = 50,001 slots
    const s: ScheduleInput = { id: "s1", enabled: true, deviceId: "d1", when: w, since: base, missed: "queue_bounded", missedWindowS: 180 * 86400, maxQueue: 3, overlap: "allow", maxQueued: 0, budget: DEFAULT_BUDGET };
    let lp: number | undefined, disp: number[] = [], accounted = 0, rounds = 0;
    while (rounds++ < 10) {
      const r = due([s], now, lp === undefined ? {} : { s1: { running: false, queued: 0, spentTodayUsd: 0, deviceOnline: true, lastPlannedMs: lp } });
      if (!r.decisions.length) break;
      for (const d of r.decisions) { accounted += d.action === "skip" ? (d.count ?? 1) : 1; if (d.action === "dispatch") disp.push(d.plannedMs); }
      lp = Math.max(...r.decisions.map((d) => d.plannedMs));
    }
    expect(disp).toEqual([now - 600_000, now - 300_000, now]);
    expect(accounted).toBe(50_001);
  });
  test("ceiling must exceed enumCap (explicit failure, no silent loss)", () => {
    const s: ScheduleInput = { id: "s1", enabled: true, deviceId: "d1", when: { kind: "cron", cron: "*/5 * * * *", tz: "UTC" }, since: S0 - 1, missed: "queue_bounded", missedWindowS: 86400, maxQueue: 3, overlap: "allow", maxQueued: 0, budget: DEFAULT_BUDGET };
    expect(() => due([s], S0 + DAY, {}, { enumCeiling: 50, enumCap: 100 })).toThrow(RangeError);
  });
  test("restricted-day schedules are not rejected for an imaginary wrap gap", () => {
    for (const t of ["2026-01-01T00:00", "2026-01-05T23:59", "2026-06-15T12:00"]) {
      expect(validateWhen({ kind: "cron", cron: "1,58 0,23 * * 1", tz: "UTC" }, U(t))).toBeNull();
      expect(validateWhen({ kind: "cron", cron: "1,58 0,23 * * 1,3,5", tz: "UTC" }, U(t))).toBeNull();
      expect(validateWhen({ kind: "cron", cron: "1,58 0,23 * * *", tz: "UTC" }, U(t))?.message).toContain("more often");
      expect(validateWhen({ kind: "cron", cron: "1,58 0,23 * * 1-2", tz: "UTC" }, U(t))?.message).toContain("more often"); // Mon->Tue adjacent
      expect(validateWhen({ kind: "cron", cron: "*/7 2-3 * * *", tz: "UTC" }, U(t))?.message).toContain("more often");
      expect(validateWhen({ kind: "cron", cron: "*/7 2-3 * * 1", tz: "UTC" }, U(t))?.message).toContain("more often"); // within-day stays unconditional
    }
  });
  test("slotRange keep:0 returns an empty tail even when the ceiling is hit", () => {
    const w: When = { kind: "cron", cron: "*/5 * * * *", tz: "UTC" };
    const r = slotRange(w, S0 - 1, S0 + DAY, 0, 10);
    expect(r.exhausted).toBe(false); expect(r.count).toBe(10); expect(r.tail).toEqual([]);
    expect(slotRange(w, S0 - 1, S0 + DAY, 0).tail).toEqual([]);
  });
});

describe("brute-force oracle (minute scan vs slotRange/cronNext, leap year 2028, fixed-offset zones; DST is covered by the DST tests)", () => {
  test.each([["Asia/Kolkata", 330, "*/30 1-3 * * *"], ["Asia/Tokyo", 540, "15 2 * * 1,5"], ["UTC", 0, "0 */6 29 2 *"], ["Asia/Kolkata", 330, "5 4 13 * 5"], ["Asia/Tokyo", 540, "5 4 * 1-3 *"]] as const)("%s %s", (tz, off, expr) => {
    const sp = spec(expr), a = Date.UTC(2028, 0, 1), b = Date.UTC(2029, 0, 1), oracle: number[] = [];
    for (let t = a; t < b; t += MINUTE) {
      const d = new Date(t + off * MINUTE);
      if (!sp.minute.includes(d.getUTCMinutes()) || !sp.hour.includes(d.getUTCHours()) || !sp.month.includes(d.getUTCMonth() + 1)) continue;
      const domOk = sp.dom.includes(d.getUTCDate()), dowOk = sp.dow.includes(d.getUTCDay());
      if (sp.domStar || sp.dowStar ? domOk && dowOk : domOk || dowOk) oracle.push(t);
    }
    const r = slotRange({ kind: "cron", cron: expr, tz }, a - 1 + off * 0, b - 1, 5);
    expect(r.count).toBe(oracle.length);
    expect(r.tail).toEqual(oracle.slice(-5));
    expect(cronNext(sp, tz, a - 1)).toBe(oracle[0]);
  });
});
