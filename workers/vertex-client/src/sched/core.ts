// vcl scheduler S1: PURE core (design: docs/vcl-scheduler-design.md on branch vclsched1). No I/O, no Date.now(), no Worker/Bun/Node-only API:
// every function takes `now` explicitly. Only Intl.DateTimeFormat is used for IANA time zones. Runs in workerd, bun and node.
// Supported instant range: years 1970..2200 (second-level historical offsets such as Monrovia 1970 -00:44:30 are honoured) (Date.UTC two-digit-year quirk is avoided by never building years < 100).
//
// Sections: 1 time zones, 2 cron, 3 schedules (cron | every | at), 4 slots + idempotency, 5 policies, 6 run reducer, 7 due().

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------- 1. time zones
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    dtfCache.set(tz, f);
  }
  return f;
}

/** null when `tz` is a valid IANA zone, otherwise a message a UI can show. */
export function validateTimezone(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz.trim()) return "time zone is required (IANA name such as Asia/Ho_Chi_Minh or UTC)";
  try { dtf(tz); return null; } catch { return `unknown time zone "${tz}"`; }
}

/** UTC offset of `tz` at instant `ms`, in minutes east of UTC (e.g. New_York summer = -240, Kolkata = 330, Lord_Howe summer = 660). */
export function tzOffsetMinutes(tz: string, ms: number): number {
  const p = dtf(tz).formatToParts(ms);
  let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
  for (const x of p) {
    const v = Number(x.value);
    if (x.type === "year") y = v; else if (x.type === "month") mo = v; else if (x.type === "day") d = v;
    else if (x.type === "hour") h = v === 24 ? 0 : v; else if (x.type === "minute") mi = v; else if (x.type === "second") s = v;
  }
  const full = new Date(Date.UTC(2000, mo - 1, d, h, mi, s)); full.setUTCFullYear(y);
  return (full.getTime() - Math.floor(ms / 1000) * 1000) / MINUTE; // may be fractional (historical LMT offsets such as Monrovia 1970 -00:44:30)
}

export type LocalResolution = { kind: "ok"; at: number } | { kind: "overlap"; first: number; second: number } | { kind: "gap"; at: number };

/** Resolve a wall-clock time (month 1-12) in `tz` to UTC. overlap = ambiguous (two instants), gap = nonexistent (`at` = first instant after the gap). */
export function localToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): LocalResolution {
  const L = naiveMs(y, mo, d, h, mi);
  const offs = [...new Set([tzOffsetMinutes(tz, L - DAY), tzOffsetMinutes(tz, L + DAY)])];
  const valid: number[] = [];
  for (const o of offs) { const t = L - o * MINUTE; if (tzOffsetMinutes(tz, t) === o) valid.push(t); }
  valid.sort((a, b) => a - b);
  if (valid.length === 1) return { kind: "ok", at: valid[0] };
  if (valid.length >= 2) return { kind: "overlap", first: valid[0], second: valid[1] };
  if (offs.length < 2) return { kind: "ok", at: L - offs[0] * MINUTE }; // defensive: cannot happen
  // gap: binary-search the transition between the two invalid candidates (second resolution)
  let lo = Math.round((L - Math.max(...offs) * MINUTE) / 1000); // old-offset side
  let hi = Math.round((L - Math.min(...offs) * MINUTE) / 1000); // new-offset side
  const oldOff = tzOffsetMinutes(tz, lo * 1000);
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (tzOffsetMinutes(tz, mid * 1000) === oldOff) lo = mid; else hi = mid; }
  return { kind: "gap", at: hi * 1000 };
}

function naiveMs(y: number, mo: number, d: number, h: number, mi: number): number {
  const dt = new Date(Date.UTC(2000, mo - 1, d, h, mi)); dt.setUTCFullYear(y); return dt.getTime();
}

/** Local wall-clock fields of an instant, e.g. for display. */
export function localParts(tz: string, ms: number): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const n = new Date(ms + tzOffsetMinutes(tz, ms) * MINUTE);
  return { y: n.getUTCFullYear(), mo: n.getUTCMonth() + 1, d: n.getUTCDate(), h: n.getUTCHours(), mi: n.getUTCMinutes(), dow: n.getUTCDay() };
}

// ---------------------------------------------------------------------------------------------------------------- 2. cron
export interface CronSpec {
  minute: number[]; hour: number[]; dom: number[]; month: number[]; dow: number[]; // sorted, unique; dow 0-6 (7 folded to 0)
  domStar: boolean; dowStar: boolean; // field text started with "*": decides AND vs OR of dom/dow (vixie semantics)
  source: string;
}
export interface CronError { field: "expression" | "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek"; message: string }
export type CronParse = { ok: true; spec: CronSpec } | { ok: false; error: CronError };

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FIELDS = [
  { key: "minute" as const, min: 0, max: 59, names: null as string[] | null, base: 0 },
  { key: "hour" as const, min: 0, max: 23, names: null, base: 0 },
  { key: "dayOfMonth" as const, min: 1, max: 31, names: null, base: 0 },
  { key: "month" as const, min: 1, max: 12, names: MONTHS, base: 1 },
  { key: "dayOfWeek" as const, min: 0, max: 7, names: DOWS, base: 0 },
];

function parseField(text: string, f: (typeof FIELDS)[number]): number[] | string {
  const out = new Set<number>();
  const num = (s: string): number | string => {
    const low = s.toLowerCase();
    if (f.names) { const i = f.names.indexOf(low); if (i >= 0) return i + f.base; }
    if (!/^\d+$/.test(s)) return `"${s}" is not a valid ${f.key} value`;
    const n = Number(s);
    if (n < f.min || n > f.max) return `${f.key} value ${n} is out of range ${f.min}-${f.max}`;
    return n;
  };
  for (const item of text.split(",")) {
    if (!item) return `${f.key} has an empty list item`;
    const [rangePart, stepPart, extra] = item.split("/");
    if (extra !== undefined) return `${f.key} item "${item}" has more than one "/"`;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) return `${f.key} step "${stepPart}" must be a positive number`;
      step = Number(stepPart);
    }
    let a: number, b: number;
    if (rangePart === "*") { a = f.min; b = f.key === "dayOfWeek" ? 6 : f.max; }
    else if (rangePart.includes("-")) {
      const [x, y, z] = rangePart.split("-");
      if (z !== undefined || !x || !y) return `${f.key} range "${rangePart}" is malformed`;
      const nx = num(x), ny = num(y);
      if (typeof nx === "string") return nx; if (typeof ny === "string") return ny;
      if (nx > ny) return `${f.key} range "${rangePart}" starts after it ends`;
      a = nx; b = ny;
    } else {
      const n = num(rangePart);
      if (typeof n === "string") return n;
      a = n; b = stepPart !== undefined ? f.max : n; // "a/n" = from a to the field max (dow max 7 is folded to 0 below)
    }
    for (let v = a; v <= b; v += step) out.add(f.key === "dayOfWeek" && v === 7 ? 0 : v);
  }
  return [...out].sort((x, y) => x - y);
}

export function parseCron(expr: string): CronParse {
  if (typeof expr !== "string" || !expr.trim()) return { ok: false, error: { field: "expression", message: "cron expression is empty" } };
  const src = expr.trim();
  const body = src.startsWith("@") ? ALIASES[src.toLowerCase()] : src;
  if (!body) return { ok: false, error: { field: "expression", message: `unknown alias "${src}" (use @hourly @daily @weekly @monthly @yearly)` } };
  const parts = body.split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: { field: "expression", message: `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}` } };
  const vals: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i], FIELDS[i]);
    if (typeof r === "string") return { ok: false, error: { field: FIELDS[i].key, message: r } };
    vals.push(r);
  }
  return { ok: true, spec: { minute: vals[0], hour: vals[1], dom: vals[2], month: vals[3], dow: vals[4], domStar: parts[2].startsWith("*"), dowStar: parts[4].startsWith("*"), source: src } };
}

function dayMatches(spec: CronSpec, month: number, dom: number, dow: number): boolean {
  if (!spec.month.includes(month)) return false;
  const dm = spec.dom.includes(dom), wm = spec.dow.includes(dow);
  if (!spec.domStar && !spec.dowStar) return dm || wm;
  return dm && wm;
}

const MAX_DAYS_SEARCH = 366 * 9; // Feb 29 can be 8 years away (2096 -> 2104)

/** First occurrence strictly after `after` (UTC ms), or null if none within ~9 years (e.g. 31 Feb). DST: gap -> once at the first valid instant; overlap -> once, first occurrence. */
export function cronNext(spec: CronSpec, tz: string, after: number): number | null {
  const startDay = Math.floor((after + tzOffsetMinutes(tz, after) * MINUTE) / DAY) - 1;
  for (let di = 0; di < MAX_DAYS_SEARCH; di++) {
    const dayMs = (startDay + di) * DAY;
    const dt = new Date(dayMs);
    if (!dayMatches(spec, dt.getUTCMonth() + 1, dt.getUTCDate(), dt.getUTCDay())) continue;
    const offA = tzOffsetMinutes(tz, dayMs - 15 * HOUR);
    const offB = tzOffsetMinutes(tz, dayMs + 37 * HOUR);
    let best = Infinity;
    if (offA === offB) { // fast path: no transition near this local day
      const base = dayMs - offA * MINUTE;
      outer: for (const h of spec.hour) for (const m of spec.minute) { const t = base + h * HOUR + m * MINUTE; if (t > after) { best = t; break outer; } }
    } else {
      const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate();
      for (const h of spec.hour) for (const m of spec.minute) {
        const r = localToUtc(tz, y, mo, d, h, m);
        const t = r.kind === "overlap" ? r.first : r.at;
        if (t > after && t < best) best = t;
      }
    }
    if (best !== Infinity) return best;
  }
  return null;
}

/** Next `n` occurrences after `after` (for UI previews). */
export function cronNextN(spec: CronSpec, tz: string, after: number, n: number): number[] {
  const out: number[] = [];
  let t = after;
  while (out.length < n) { const x = cronNext(spec, tz, t); if (x === null) break; out.push(x); t = x; }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- 3. schedules
export type When =
  | { kind: "cron"; cron: string; tz: string }
  | { kind: "every"; everySecs: number; anchor: number } // slots at anchor + k * everySecs
  | { kind: "at"; at: number };

export interface WhenLimits { minEverySecs: number; minCronGapSecs: number }
export const DEFAULT_WHEN_LIMITS: WhenLimits = { minEverySecs: 300, minCronGapSecs: 300 };

export interface ValidationError { field: string; message: string }

/** True if the calendar can match two consecutive days (otherwise the last-firing -> first-firing wrap across midnight never happens). Scans a 400-year cycle. */
function hasAdjacentDays(spec: CronSpec): boolean {
  const matches = (ms: number) => { const d = new Date(ms); return dayMatches(spec, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay()); };
  for (let t = Date.UTC(2000, 0, 1); t < Date.UTC(2400, 0, 1); t += DAY) if (matches(t) && matches(t + DAY)) return true;
  return false;
}

/** Validate a schedule's `when` at creation. `now` is needed to reject one-shots in the past. */
export function validateWhen(when: When, now: number, limits: WhenLimits = DEFAULT_WHEN_LIMITS): ValidationError | null {
  if (when.kind === "at") {
    if (!Number.isFinite(when.at)) return { field: "at", message: "time is not a valid instant" };
    if (when.at <= now) return { field: "at", message: "one-shot time is in the past" };
    return null;
  }
  if (when.kind === "every") {
    if (!Number.isFinite(when.everySecs) || !Number.isInteger(when.everySecs)) return { field: "everySecs", message: "interval must be a whole number of seconds" };
    if (when.everySecs < limits.minEverySecs) return { field: "everySecs", message: `interval must be at least ${limits.minEverySecs} seconds` };
    if (!Number.isFinite(when.anchor)) return { field: "anchor", message: "anchor is not a valid instant" };
    return null;
  }
  if (when.kind !== "cron") return { field: "kind", message: "unknown schedule kind" };
  const tzErr = validateTimezone(when.tz);
  if (tzErr) return { field: "tz", message: tzErr };
  const p = parseCron(when.cron);
  if (!p.ok) return { field: p.error.field, message: p.error.message };
  // within-day pattern first: independent of the creation instant (incl. the wrap from the last firing to the first of the next day)
  const mins = p.spec.hour.flatMap((h) => p.spec.minute.map((m) => h * 60 + m));
  for (let i = 0; i < mins.length; i++) {
    const gap = (i + 1 < mins.length ? mins[i + 1] - mins[i] : mins[0] + 1440 - mins[i]) * 60;
    if (mins.length > 1 && (i + 1 < mins.length || hasAdjacentDays(p.spec)) && gap < limits.minCronGapSecs) return { field: "expression", message: `fires more often than every ${limits.minCronGapSecs} seconds` };
  }
  const xs = cronNextN(p.spec, when.tz, now, 12);
  if (xs.length === 0) return { field: "expression", message: "this expression never fires (for example 31 Feb)" };
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] < limits.minCronGapSecs * 1000) return { field: "expression", message: `fires more often than every ${limits.minCronGapSecs} seconds` };
  return null;
}

/** First slot strictly after `after`, or null (one-shot already used, or cron that never fires / invalid). */
export function nextSlot(when: When, after: number): number | null {
  if (when.kind === "at") return when.at > after ? when.at : null;
  if (when.kind === "every") {
    const step = when.everySecs * 1000;
    if (!(step > 0)) return null;
    if (after < when.anchor) return when.anchor;
    return when.anchor + (Math.floor((after - when.anchor) / step) + 1) * step;
  }
  const p = parseCron(when.cron);
  if (!p.ok || validateTimezone(when.tz)) return null;
  return cronNext(p.spec, when.tz, after);
}

// ---------------------------------------------------------------------------------------------------------------- 4. slots + idempotency
/** Deterministic key for the run of schedule `scheduleId` planned at instant `plannedMs`. Same inputs -> same key, so a double alarm cannot double-dispatch. */
export function idempotencyKey(scheduleId: string, plannedMs: number): string { return `${scheduleId}@${plannedMs}`; }
export function attemptKey(scheduleId: string, plannedMs: number, attempt: number): string { return attempt <= 1 ? idempotencyKey(scheduleId, plannedMs) : `${idempotencyKey(scheduleId, plannedMs)}#${attempt}`; }
export function parseKey(key: string): { scheduleId: string; plannedMs: number; attempt: number } | null {
  const m = /^(.+)@(\d+)(?:#(\d+))?$/.exec(key);
  return m ? { scheduleId: m[1], plannedMs: Number(m[2]), attempt: m[3] ? Number(m[3]) : 1 } : null;
}

/** Slots in (since, until], at most `cap`; `truncated` when more exist. */
export function slotsBetween(when: When, since: number, until: number, cap: number): { slots: number[]; truncated: boolean } {
  const slots: number[] = [];
  let t = since;
  while (true) {
    const x = nextSlot(when, t);
    if (x === null || x > until) return { slots, truncated: false };
    if (slots.length >= cap) return { slots, truncated: true };
    slots.push(x); t = x;
  }
}

export interface SlotRange { count: number; first: number | null; last: number | null; tail: number[]; exhausted: boolean }
/**
 * Account for EVERY slot in (since, until]: total `count`, `first`, `last`, and the newest `keep` slots in `tail`.
 * `every` uses direct arithmetic; cron/at iterate with a work ceiling. `exhausted:false` = the ceiling was hit: count/first/last/tail then describe only
 * the enumerated prefix (since, last], and the caller must advance its cursor no further than `last` (resumable, nothing is skipped silently).
 */
export function slotRange(when: When, since: number, until: number, keep: number, ceiling = DEFAULT_ENUM_CEILING): SlotRange {
  if (when.kind === "every") {
    const step = when.everySecs * 1000;
    const first = nextSlot(when, since);
    if (first === null || first > until) return { count: 0, first: null, last: null, tail: [], exhausted: true };
    const count = Math.floor((until - first) / step) + 1;
    const n = Math.min(keep, count), tail: number[] = [];
    for (let i = count - n; i < count; i++) tail.push(first + i * step);
    return { count, first, last: first + (count - 1) * step, tail, exhausted: true };
  }
  let count = 0, first: number | null = null, last: number | null = null, buf: number[] = [], t = since;
  while (true) {
    const x = nextSlot(when, t);
    if (x === null || x > until) break;
    if (count >= ceiling) return { count, first, last, tail: keep > 0 ? buf.slice(-keep) : [], exhausted: false };
    count++; if (first === null) first = x; last = x; t = x;
    if (keep > 0) { buf.push(x); if (buf.length > keep * 2 + 16) buf = buf.slice(-keep); }
  }
  return { count, first, last, tail: keep > 0 ? buf.slice(-keep) : [], exhausted: true };
}

// ---------------------------------------------------------------------------------------------------------------- 5. policies
export type MissedPolicy = "skip" | "catch_up_once" | "queue_bounded";
export type OverlapPolicy = "skip" | "queue" | "allow";
export type SkipReason = "late" | "missed" | "offline" | "overlap" | "superseded" | "queue_overflow" | "budget_daily" | "budget_run" | "disabled";
/** Run status a skip reason maps to: things that did not happen because the clock/device was not there are "missed"; deliberate policy outcomes "skipped". */
export function statusForSkip(r: SkipReason): "missed" | "skipped" { return r === "late" || r === "missed" || r === "offline" ? "missed" : "skipped"; }

export interface RetryPolicy { max: number; backoffS: number[]; on: RetryReason[] }
export type RetryReason = "start_failed" | "device_lost";
export const NO_RETRY: RetryPolicy = { max: 0, backoffS: [], on: [] };

/** Retry decision after a failed attempt (attempt is 1-based = the one that just failed). Never retries tool/agent errors (reason must be in policy.on). */
export function retryDecision(p: RetryPolicy, reason: string, attempt: number, now: number): { retry: true; atMs: number; attempt: number } | { retry: false; why: "disabled" | "not_retryable" | "exhausted" } {
  if (p.max <= 0) return { retry: false, why: "disabled" };
  if (!(p.on as string[]).includes(reason)) return { retry: false, why: "not_retryable" };
  if (attempt > p.max) return { retry: false, why: "exhausted" }; // attempt 1 failed -> retry #1 allowed while 1 <= max
  const b = p.backoffS.length ? p.backoffS[Math.min(attempt - 1, p.backoffS.length - 1)] : 60;
  return { retry: true, atMs: now + b * 1000, attempt: attempt + 1 };
}
export function validateRetry(p: RetryPolicy): ValidationError | null {
  if (!Number.isInteger(p.max) || p.max < 0 || p.max > 3) return { field: "retry.max", message: "retries must be 0-3" };
  if (p.backoffS.some((s) => !Number.isFinite(s) || s < 1 || s > 86_400)) return { field: "retry.backoffS", message: "backoff must be 1-86400 seconds" };
  return null;
}

export interface Budget { maxUsd: number; maxTurns: number; maxSecs: number }
export const DEFAULT_BUDGET: Budget = { maxUsd: 1, maxTurns: 30, maxSecs: 900 };
export const MAX_RUN_SECS = 3600;
export function validateBudget(b: Budget): ValidationError | null {
  if (!(b.maxUsd > 0) || !Number.isFinite(b.maxUsd)) return { field: "budget.maxUsd", message: "max cost per run must be above 0" };
  if (!Number.isInteger(b.maxTurns) || b.maxTurns < 1) return { field: "budget.maxTurns", message: "max turns must be a whole number >= 1" };
  if (!Number.isFinite(b.maxSecs) || b.maxSecs < 1 || b.maxSecs > MAX_RUN_SECS) return { field: "budget.maxSecs", message: `max seconds must be 1-${MAX_RUN_SECS}` };
  return null;
}

export interface Limits { maxConcurrentDevice: number; maxConcurrentGlobal: number; dailyUsdCap: number | null }
export const DEFAULT_LIMITS: Limits = { maxConcurrentDevice: 1, maxConcurrentGlobal: 4, dailyUsdCap: null };
export interface AdmitInput { budget: Budget; spentTodayUsd: number; deviceRunning: number; globalRunning: number; limits: Limits }
/** Budget/concurrency gate for one dispatch. `hold` = transient (try again later, slot stays pending until it expires); `skip` = final. */
export function admit(i: AdmitInput): { ok: true } | { ok: false; outcome: "skip" | "hold"; reason: SkipReason | "device_busy" | "global_busy" } {
  if (i.limits.dailyUsdCap !== null && i.spentTodayUsd + i.budget.maxUsd > i.limits.dailyUsdCap) return { ok: false, outcome: "skip", reason: "budget_daily" };
  if (i.deviceRunning >= i.limits.maxConcurrentDevice) return { ok: false, outcome: "hold", reason: "device_busy" };
  if (i.globalRunning >= i.limits.maxConcurrentGlobal) return { ok: false, outcome: "hold", reason: "global_busy" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------- 6. run reducer
export type RunStatus = "planned" | "dispatched" | "running" | "succeeded" | "failed" | "missed" | "killed" | "skipped";
export const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "missed", "killed", "skipped"];
export const isTerminal = (s: RunStatus) => TERMINAL.includes(s);
export type RunEvent =
  | { type: "dispatch"; at: number }
  | { type: "started"; at: number }
  | { type: "succeed"; at: number }
  | { type: "fail"; at: number; reason?: string }
  | { type: "kill"; at: number; reason?: string }
  | { type: "miss"; at: number; reason?: string }
  | { type: "skip"; at: number; reason?: string };
export interface Run { key: string; scheduleId: string; plannedMs: number; attempt: number; status: RunStatus; reason?: string; dispatchedAt?: number; startedAt?: number; finishedAt?: number }

/** Legal transitions: status -> event type -> next status. Terminal states have no outgoing edges (duplicates of the same terminal event are a no-op). */
export const TRANSITIONS: Record<RunStatus, Partial<Record<RunEvent["type"], RunStatus>>> = {
  planned: { dispatch: "dispatched", miss: "missed", skip: "skipped", kill: "killed", fail: "failed" },
  dispatched: { started: "running", succeed: "succeeded", fail: "failed", kill: "killed" },
  running: { succeed: "succeeded", fail: "failed", kill: "killed" },
  succeeded: {}, failed: {}, missed: {}, killed: {}, skipped: {},
};
const EVENT_RESULT: Record<string, RunStatus> = { succeed: "succeeded", fail: "failed", kill: "killed", miss: "missed", skip: "skipped" };

export function newRun(scheduleId: string, plannedMs: number, attempt = 1): Run {
  return { key: attemptKey(scheduleId, plannedMs, attempt), scheduleId, plannedMs, attempt, status: "planned" };
}

export type ReduceResult = { ok: true; run: Run; noop: boolean } | { ok: false; error: string };
/** Pure reducer. Replaying a terminal event that already produced the current terminal status is an idempotent no-op; anything else illegal is an error (state unchanged). */
export function reduceRun(run: Run, ev: RunEvent): ReduceResult {
  const next = TRANSITIONS[run.status][ev.type];
  if (!next) {
    if (isTerminal(run.status) && EVENT_RESULT[ev.type] === run.status) return { ok: true, run, noop: true };
    if (ev.type === "dispatch" && run.status === "dispatched") return { ok: true, run, noop: true };
    if (ev.type === "started" && (run.status === "running")) return { ok: true, run, noop: true };
    return { ok: false, error: `illegal transition: ${run.status} -[${ev.type}]-> ?` };
  }
  const r: Run = { ...run, status: next };
  if ("reason" in ev && ev.reason !== undefined) r.reason = ev.reason;
  if (ev.type === "dispatch") r.dispatchedAt = ev.at;
  else if (ev.type === "started") r.startedAt = ev.at;
  else r.finishedAt = ev.at;
  return { ok: true, run: r, noop: false };
}

// ---------------------------------------------------------------------------------------------------------------- 7. due()
export interface ScheduleInput {
  id: string; enabled: boolean; deviceId: string; when: When;
  /** Slots strictly after this instant are candidates: set to createdAt at creation and to `now` on re-enable (never replay a disabled period). */
  since: number;
  missed: MissedPolicy; missedWindowS: number; maxQueue: number; // maxQueue: bound for queue_bounded
  overlap: OverlapPolicy; maxQueued: number; // overlap=queue: how many pending runs may wait
  budget: Budget;
}
export interface LastRun {
  lastPlannedMs?: number; // latest slot already recorded as a run (any status incl. skipped)
  running: boolean; queued: number; spentTodayUsd: number; deviceOnline: boolean;
}
export interface DueOptions { limits?: Limits; graceMs?: number; deviceRunning?: Record<string, number>; globalRunning?: number; enumCap?: number; enumCeiling?: number }
export interface Decision {
  scheduleId: string; plannedMs: number; key: string;
  action: "dispatch" | "queue" | "skip";
  reason?: SkipReason; status?: "missed" | "skipped"; // for skip
  count?: number; // collapsed slots represented by this skip decision (>= 1)
  firstPlannedMs?: number;
}
export interface DueResult { decisions: Decision[]; held: string[]; clockWentBackwards: string[] }

const DEFAULT_GRACE_MS = 2 * MINUTE;
const DEFAULT_ENUM_CAP = 2000; // newest in-window slots kept individually
const DEFAULT_ENUM_CEILING = 50_000; // max slots walked per schedule per due() call for cron (every is O(1))
const DEFAULT_LAST: LastRun = { running: false, queued: 0, spentTodayUsd: 0, deviceOnline: true };

/**
 * What to do right now for each schedule. Deterministic for a given ordered input; each schedule is evaluated independently, but input order is the
 * admission priority when schedules share concurrency limits (device/global slots go to earlier entries first); the caller records every decision as a run row
 * (using the key) and advances nothing else. Skips are collapsed (one decision per reason with `count`) so a device offline for days
 * yields a handful of rows, not thousands. `held` = slots intentionally left pending (device offline w/ catch-up policies, or busy).
 */
export function due(schedules: ScheduleInput[], now: number, lastRuns: Record<string, LastRun | undefined>, opts: DueOptions = {}): DueResult {
  const limits = opts.limits ?? DEFAULT_LIMITS, grace = opts.graceMs ?? DEFAULT_GRACE_MS, cap = opts.enumCap ?? DEFAULT_ENUM_CAP, ceiling = opts.enumCeiling ?? DEFAULT_ENUM_CEILING;
  const devRunning: Record<string, number> = { ...(opts.deviceRunning ?? {}) };
  let globalRunning = opts.globalRunning ?? 0;
  const out: DueResult = { decisions: [], held: [], clockWentBackwards: [] };

  for (const s of schedules) {
    if (!s.enabled) continue;
    const lr = lastRuns[s.id] ?? DEFAULT_LAST;
    const since = Math.max(s.since, lr.lastPlannedMs ?? -Infinity);
    if (!Number.isFinite(since)) continue;
    if (since > now) { out.clockWentBackwards.push(s.id); continue; }
    const windowMs = s.missedWindowS * 1000;
    const tailStart = Math.max(since, now - windowMs - 1);

    const decisions: Decision[] = [];
    const late = (r: { count: number; first: number | null; last: number | null }) => {
      if (r.count > 0 && r.first !== null && r.last !== null) decisions.push({ scheduleId: s.id, plannedMs: r.last, key: idempotencyKey(s.id, r.last), action: "skip", reason: "late", status: "missed", count: r.count, firstPlannedMs: r.first });
    };
    const flush = () => { decisions.sort((x, y) => x.plannedMs - y.plannedMs || (x.action === "skip" ? -1 : 1)); out.decisions.push(...decisions); };

    // expired slots (older than the window): ALL accounted in one collapsed "late" skip. If the work ceiling was hit, only the enumerated prefix is
    // recorded and the cursor stops there; the rest is handled by the next call (never advance across unprocessed slots).
    if (tailStart > since) {
      const old = slotRange(s.when, since, tailStart, 0, ceiling);
      late(old);
      if (!old.exhausted) { flush(); continue; }
    }
    // in-window slots: keep the newest `cap` individually; older ones are one collapsed "late" skip
    const win = slotRange(s.when, tailStart, now, cap + 1, ceiling);
    if (!win.exhausted) {
      // ceiling hit: the newest `cap` slots of the walked prefix are NOT recorded (they may belong to the bounded queue); only the older ones are
      // collapsed and the cursor stops at tail[0], so the next call re-walks from there. Needs ceiling > cap to make progress.
      if (win.count <= cap) throw new RangeError("enumCeiling must exceed enumCap");
      late({ count: win.count - cap, first: win.first, last: win.tail[0] });
      flush(); continue;
    }
    let slots = win.tail;
    if (win.count > cap) { // slots[0] is the newest dropped slot (it carries the key of the collapsed range)
      late({ count: win.count - cap, first: win.first, last: slots[0] });
      slots = slots.slice(1);
    }

    const collapse = (list: number[], reason: SkipReason) => {
      if (!list.length) return;
      const last = list[list.length - 1];
      decisions.push({ scheduleId: s.id, plannedMs: last, key: idempotencyKey(s.id, last), action: "skip", reason, status: statusForSkip(reason), count: list.length, firstPlannedMs: list[0] });
    };

    // choose candidates to dispatch from in-window slots
    let candidates: number[] = [];
    if (slots.length) {
      const latest = slots[slots.length - 1];
      const current = now - latest <= grace; // the latest slot is "on time"
      if (lr.deviceOnline === false) {
        if (s.missed === "skip") collapse(slots, "offline");
        else out.held.push(s.id); // keep pending, decide on reconnect (expired part handled above)
      } else if (s.missed === "skip") {
        if (current) { candidates = [latest]; collapse(slots.slice(0, -1), "missed"); } else collapse(slots, "missed");
      } else if (s.missed === "catch_up_once") {
        candidates = [latest]; collapse(slots.slice(0, -1), "superseded");
      } else { // queue_bounded
        const n = Math.max(1, s.maxQueue);
        candidates = slots.slice(-n); collapse(slots.slice(0, -n), "queue_overflow");
      }
    }

    // overlap + admission, in order
    let running = lr.running, queued = lr.queued, dispatchedNow = 0, spent = lr.spentTodayUsd;
    const skippedOverlap: number[] = [];
    for (const c of candidates) {
      const busy = running || dispatchedNow > 0;
      if (s.overlap !== "allow" && busy) {
        if (s.overlap === "queue" && queued < s.maxQueued) { queued++; decisions.push({ scheduleId: s.id, plannedMs: c, key: idempotencyKey(s.id, c), action: "queue" }); }
        else skippedOverlap.push(c);
        continue;
      }
      const a = admit({ budget: s.budget, spentTodayUsd: spent, deviceRunning: devRunning[s.deviceId] ?? 0, globalRunning, limits });
      if (!a.ok) {
        if (a.outcome === "hold") { if (!out.held.includes(s.id)) out.held.push(s.id); break; } // later slots must not overtake a held one
        decisions.push({ scheduleId: s.id, plannedMs: c, key: idempotencyKey(s.id, c), action: "skip", reason: a.reason as SkipReason, status: "skipped" });
        continue;
      }
      decisions.push({ scheduleId: s.id, plannedMs: c, key: idempotencyKey(s.id, c), action: "dispatch" });
      dispatchedNow++; devRunning[s.deviceId] = (devRunning[s.deviceId] ?? 0) + 1; globalRunning++; spent += s.budget.maxUsd;
      running = running || s.overlap !== "allow";
    }
    collapse(skippedOverlap, "overlap");
    flush();
  }
  return out;
}

/** Earliest instant at which `due()` could have work (for arming one alarm); null if nothing will ever fire. */
export function nextWake(schedules: ScheduleInput[], lastRuns: Record<string, LastRun | undefined> = {}): number | null {
  let best: number | null = null;
  for (const s of schedules) {
    if (!s.enabled) continue;
    const x = nextSlot(s.when, Math.max(s.since, lastRuns[s.id]?.lastPlannedMs ?? -Infinity));
    if (x !== null && (best === null || x < best)) best = x;
  }
  return best;
}
