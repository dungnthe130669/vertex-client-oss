// Device terminal relay (vclterm3), pure part: frame parsing, admission, rate window, idle rule. No D1, no DO, no I/O: the DeviceHub shell (device-hub.ts) calls these and executes the verdicts.
// Contract: docs/vcl-term-hub-api.md. Terminal payload (`data`) is LIVE-RELAY ONLY: it is never logged, never written to D1, never put in the event log (EVENT_RETENTION is not touched).
import { MAX_FRAME_BYTES, isRid, type Json } from "./device-core";

export const TERM_CAP = "term";
export const TERM_FRESH_LOGIN_S = 12 * 3600;     // term_open needs a login (not a cookie refresh) at most this old
export const TERM_IDLE_S = 30 * 60;              // no term_in for this long -> hub closes the session
export const TERM_OPEN_TIMEOUT_S = 20;           // device must answer term_open (ready / error) within this
export const TERM_RATE_BPS = 2 * 1024 * 1024;    // bytes per second per device, each direction, payload bytes
export const TERM_MAX_IN_B64 = 64 * 1024;        // one term_in payload (base64 chars)
export const TERM_MAX_COLS = 500, TERM_MAX_ROWS = 200;
export const TERM_AUDIT_TTL_S = 30 * 24 * 3600;

const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SID = /^[\w.-]{1,64}$/;
const isSid = (v: unknown): v is string => typeof v === "string" && SID.test(v);
const dim = (v: unknown, max: number): v is number => int(v) && v >= 1 && v <= max;
const b64 = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && B64.test(v);
const word = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max && /^[\w.:-]+$/.test(v);

/** Frames the app may send. `data` stays base64 (the hub never decodes or inspects it). */
export type TermAppFrame =
  | { t: "term_open"; cid: string; root: string; cols: number; rows: number }
  | { t: "term_in"; sid: string; data: string }
  | { t: "term_resize"; sid: string; cols: number; rows: number }
  | { t: "term_close"; sid: string }
  | { t: "term_attach"; sid: string; lastSeq: number }
  | { t: "term_ack"; sid: string; seq: number };
export const isTermFrame = (t: unknown): t is string => typeof t === "string" && t.startsWith("term_");

export function parseTermApp(f: Json): TermAppFrame | null {
  switch (f.t) {
    case "term_open": return isRid(f.cid) && typeof f.root === "string" && f.root.length >= 1 && f.root.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(f.root) && dim(f.cols, TERM_MAX_COLS) && dim(f.rows, TERM_MAX_ROWS) ? { t: "term_open", cid: f.cid, root: f.root, cols: f.cols, rows: f.rows } : null;
    case "term_in": return isSid(f.sid) && b64(f.data, TERM_MAX_IN_B64) && (f.data as string).length > 0 ? { t: "term_in", sid: f.sid, data: f.data as string } : null;
    case "term_resize": return isSid(f.sid) && dim(f.cols, TERM_MAX_COLS) && dim(f.rows, TERM_MAX_ROWS) ? { t: "term_resize", sid: f.sid, cols: f.cols, rows: f.rows } : null;
    case "term_close": return isSid(f.sid) ? { t: "term_close", sid: f.sid } : null;
    case "term_attach": return isSid(f.sid) && int(f.lastSeq) ? { t: "term_attach", sid: f.sid, lastSeq: f.lastSeq } : null;
    case "term_ack": return isSid(f.sid) && int(f.seq) ? { t: "term_ack", sid: f.sid, seq: f.seq } : null;
  }
  return null;
}

/** Frames the device may send. Everything is rebuilt field by field: an unknown extra field never reaches the app. */
export type TermDeviceFrame =
  | { t: "term_ready"; cid: string; sid: string; mode?: string }
  | { t: "term_out"; sid: string; seq: number; data: string }
  | { t: "term_exit"; sid: string; code: number | null; signal: string | null; reason?: string }
  | { t: "term_gap"; sid: string; from: number }
  | { t: "term_error"; cid?: string; sid?: string; error: string }
  | { t: "term_audit"; sid: string; mode: string };
export function parseTermDevice(f: Json): TermDeviceFrame | null {
  switch (f.t) {
    case "term_ready": return isRid(f.cid) && isSid(f.sid) ? { t: "term_ready", cid: f.cid, sid: f.sid, ...(word(f.mode, 24) ? { mode: f.mode } : {}) } : null;
    case "term_out": return isSid(f.sid) && int(f.seq) && b64(f.data, MAX_FRAME_BYTES) ? { t: "term_out", sid: f.sid, seq: f.seq, data: f.data as string } : null;
    case "term_exit": return isSid(f.sid) && (f.code === null || (typeof f.code === "number" && Number.isSafeInteger(f.code))) && (f.signal === null || word(f.signal, 24)) ? { t: "term_exit", sid: f.sid, code: f.code as number | null, signal: f.signal as string | null, ...(word(f.reason, 24) ? { reason: f.reason } : {}) } : null;
    case "term_gap": return isSid(f.sid) && int(f.from) ? { t: "term_gap", sid: f.sid, from: f.from } : null;
    case "term_error": return word(f.error, 40) && (f.cid === undefined || isRid(f.cid)) && (f.sid === undefined || isSid(f.sid)) ? { t: "term_error", ...(f.cid !== undefined ? { cid: f.cid as string } : {}), ...(f.sid !== undefined ? { sid: f.sid as string } : {}), error: f.error as string } : null;
    case "term_audit": return isSid(f.sid) && word(f.mode, 24) ? { t: "term_audit", sid: f.sid, mode: f.mode as string } : null;
  }
  return null;
}

/** The one session a hub (= one device) may carry. `sid` is null until the device answers term_ready. Lives in DO storage (meta `term`) so hibernation keeps it; contains no terminal content. */
export type TermSession = { cid: string; sid: string | null; user: string; root: string; mode: string | null; openedAt: number; lastIn: number; cols?: number; rows?: number };

export type OpenVerdict = { ok: true } | { ok: false; error: "login_required" | "offline" | "no_cap" | "limit" | "forbidden" };
/** Admission for term_open. `lat` = the session's login time (unix s) as signed in the cookie; a cookie without it (older) is not fresh. The flag is checked by the caller before this is reached. */
export function admitOpen(i: { user: string; owner: string | undefined; lat: number | undefined; nowS: number; online: boolean; hasCap: boolean; session: TermSession | null }): OpenVerdict {
  if (!i.owner || i.owner !== i.user) return { ok: false, error: "forbidden" };
  if (i.lat === undefined || !Number.isFinite(i.lat) || i.nowS - i.lat > TERM_FRESH_LOGIN_S || i.lat > i.nowS + 60) return { ok: false, error: "login_required" };
  if (!i.online) return { ok: false, error: "offline" };
  if (!i.hasCap) return { ok: false, error: "no_cap" };
  if (i.session) return { ok: false, error: "limit" };
  return { ok: true };
}

/** The `term_state` frame the hub sends an owner's app socket when a session already exists (after hello, or when a second term_open meets it): enough to re-attach. No terminal content. `null` = nothing to announce (no session, still opening, not the owner). */
export function termStateFrame(s: TermSession | null, user: string, owner: string | undefined): { t: "term_state"; sid: string; mode?: string; root: string; cols?: number; rows?: number; since: number } | null {
  if (!s || s.sid === null || !owner || owner !== user || s.user !== owner) return null;
  return { t: "term_state", sid: s.sid, ...(s.mode ? { mode: s.mode } : {}), root: s.root, ...(s.cols ? { cols: s.cols } : {}), ...(s.rows ? { rows: s.rows } : {}), since: s.openedAt };
}

export const idleExpired = (s: TermSession, nowMs: number, idleS = TERM_IDLE_S) => nowMs - s.lastIn > idleS * 1000;
export const openExpired = (s: TermSession, nowMs: number) => s.sid === null && nowMs - s.openedAt > TERM_OPEN_TIMEOUT_S * 1000;
/** Next moment the session needs the alarm (idle close / open timeout), ms; null = none. */
export const termDeadline = (s: TermSession | null, idleS = TERM_IDLE_S): number | null => (s ? (s.sid === null ? s.openedAt + TERM_OPEN_TIMEOUT_S * 1000 : s.lastIn + idleS * 1000) : null);

/** Fixed 1 s window byte budget, one per direction. In memory only (a hibernated DO starts a fresh window: harmless). */
export class RateWindow {
  private start = 0; private used = 0;
  constructor(private limit = TERM_RATE_BPS) {}
  /** Count n payload bytes at nowMs; false = over budget, the frame must be dropped (and is not counted). */
  take(n: number, nowMs: number): boolean {
    if (nowMs - this.start >= 1000) { this.start = nowMs; this.used = 0; }
    if (this.used + n > this.limit) return false;
    this.used += n; return true;
  }
}
/** Decoded size of a base64 string without decoding it. */
export const b64Bytes = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
