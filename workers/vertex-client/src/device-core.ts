// VCL device bridge, pure helpers shared by the routes (devices.ts) and the DeviceHub Durable Object (device-hub.ts). Wire protocol: docs/vertex-client-vcl-protocol.md.
// Nothing here touches D1 or the DO; secrets are only ever hashed here, never logged or returned after minting.
import { b64u } from "./push";

export const VCL_VERSION = 1;
export const PAIR_TTL_S = 600;                // a pairing code lives 10 min
export const PAIR_MAX_OPEN = 3;               // unused, unexpired codes one user may hold at once
export const PAIR_CREATE_PER_WINDOW = 5;      // codes one user may mint per PAIR_TTL_S
export const PAIR_FAIL_PER_IP = 8;            // failed redeems per client address per PAIR_TTL_S
export const PAIR_FAIL_GLOBAL = 60;           // failed redeems from everyone per PAIR_TTL_S (a distributed guess still runs into this)
export const TOKEN_TTL_S = 30 * 24 * 3600;    // sliding: last_seen + this
export const MAX_DEVICES = 10;                // live (unrevoked) devices per user
export const MAX_FRAME_BYTES = 256 * 1024;
export const EVENT_RETENTION = 2000;          // events kept for PWA replay
export const OUTBOX_MAX = 200;                // un-acked commands to a daemon
export const HB_TIMEOUT_S = 75;              // a daemon that announced `hb` and sent no frame for this long is treated as gone (half-open socket: sleeping/locked machine)
export const APPROVAL_TTL_DEFAULT_S = 300;
export const APPROVAL_TTL_MAX_S = 600;
export const CLOSE = { DISCONNECT: 4001, REPLACED: 4002, REVOKED: 4003, BAD_FRAME: 4004, DISABLED: 4005, TIMEOUT: 4006 } as const;

const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
export const nowS = () => Math.floor(Date.now() / 1000);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (t: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
export function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** 8 base32 chars (40 bits) from rejection-free sampling: 32 symbols divide 256 evenly. */
export function newPairCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  return [...r].map((x) => B32[x % 32]).join("");
}
/** Users type codes: accept lowercase and separators, reject anything that is not exactly 8 symbols of the alphabet. */
export function normalizeCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-HJ-NP-Z2-9]{8}$/.test(s) ? s : null;
}
export const codeHash = (code: string) => sha256(`vcl-pair:${code}`);

export const DEVICE_ID = /^[0-9a-f]{32}$/;
export const newDeviceId = () => hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
/** `vcl_<deviceId>.<256-bit secret>`: the id lets the Worker find the row, only sha256(token) is stored. */
export function mintToken(deviceId: string): string { return `vcl_${deviceId}.${b64u(crypto.getRandomValues(new Uint8Array(32)))}`; }
export function parseToken(v: unknown): { deviceId: string } | null {
  if (typeof v !== "string" || v.length > 120) return null;
  const m = /^vcl_([0-9a-f]{32})\.[A-Za-z0-9_-]{43}$/.exec(v);
  return m ? { deviceId: m[1] } : null;
}
export const tokenHash = (token: string) => sha256(`vcl-token:${token}`);
export const bearerOf = (h: string | null) => { const m = /^Bearer (\S+)$/.exec(h ?? ""); return m ? m[1] : null; };

export const cleanName = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return s.length >= 1 && s.length <= 60 ? s : null;
};

// ---- wire frames ----
export type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const RID = /^[\w.-]{1,64}$/;
export const isRid = (v: unknown): v is string => typeof v === "string" && RID.test(v);
const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

export function parseFrame(raw: string | ArrayBuffer): Json | null {
  if (typeof raw !== "string") { if (raw.byteLength > MAX_FRAME_BYTES) return null; raw = new TextDecoder().decode(raw); }
  if (raw.length > MAX_FRAME_BYTES) return null;
  try { const j = JSON.parse(raw); return isObj(j) && typeof j.t === "string" ? j : null; } catch { return null; }
}

export type DeviceRoot = { label: string; path: string };
export const MAX_ROOTS = 20, MAX_ROOT_PATH = 300, MAX_ROOT_LABEL = 100;
// eslint-disable-next-line no-control-regex
const LABEL_CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex
const PATH_BAD = /[\u0000-\u001f\u007f]/;
/** The folders the device allows sessions in, as it reports them. undefined = not reported (older vcl); [] = reported, none. A path is kept byte-for-byte or the entry is dropped (never rewritten into another path); only the label is cleaned. */
export function sanitiseRoots(v: unknown): DeviceRoot[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: DeviceRoot[] = [];
  for (const r of v) {
    if (out.length >= MAX_ROOTS) break;
    if (!isObj(r) || typeof r.path !== "string" || typeof r.label !== "string") continue;
    if (!r.path || r.path.length > MAX_ROOT_PATH || PATH_BAD.test(r.path) || out.some((o) => o.path === r.path)) continue;
    out.push({ label: r.label.replace(LABEL_CTRL, "").slice(0, MAX_ROOT_LABEL) || "(folder)", path: r.path });
  }
  return out;
}

/** comp2: what a device says about itself, whitelisted. Anything off-list/oversized is dropped (undefined), never passed on. */
export const DEV_OS = ["darwin", "linux", "win32"] as const, DEV_ARCH = ["x64", "arm64", "ia32", "arm"] as const, TERM_STATES = ["on", "off_switch", "unsupported"] as const;
export type DevOs = (typeof DEV_OS)[number]; export type TermState = (typeof TERM_STATES)[number];
export type DevSelf = { os?: DevOs; arch?: string; termState?: TermState; termWhy?: string };
const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined => (typeof v === "string" ? list.find((x) => x === v) : undefined);
// eslint-disable-next-line no-control-regex
const WHY_BAD = /[\u0000-\u001f\u007f<>]/g;
export function sanitiseSelf(i: Json): DevSelf {
  const os = pick(DEV_OS, i.os), arch = pick(DEV_ARCH, i.arch), termState = pick(TERM_STATES, i.termState);
  const why = typeof i.termWhy === "string" && termState === "unsupported" ? i.termWhy.replace(WHY_BAD, " ").trim().slice(0, 160) : "";
  return { ...(os ? { os } : {}), ...(arch ? { arch } : {}), ...(termState ? { termState } : {}), ...(why ? { termWhy: why } : {}) };
}

export type DeviceFrame =
  | { t: "hello"; lastCseq: number; info?: { name?: string; version?: string; roots?: DeviceRoot[]; caps?: string[]; self?: DevSelf } }
  | { t: "hb" }
  | { t: "ev"; dseq: number; e: Json & { type: string } }
  | { t: "cack"; cseq: number };
export function parseDeviceFrame(f: Json): DeviceFrame | null {
  if (f.t === "hello") return int(f.lastCseq) ? { t: "hello", lastCseq: f.lastCseq, ...(isObj(f.info) ? { info: { name: str(f.info.name, 60) ? f.info.name : undefined, version: str(f.info.version, 40) ? f.info.version : undefined, ...(f.info.roots !== undefined ? { roots: sanitiseRoots(f.info.roots) } : {}), ...(Array.isArray(f.info.caps) ? { caps: f.info.caps.filter((c): c is string => str(c, 24)).slice(0, 16) } : {}), self: sanitiseSelf(f.info) } } : {}) } : null;
  if (f.t === "hb") return { t: "hb" };
  if (f.t === "ev") return int(f.dseq) && f.dseq >= 1 && isObj(f.e) && str(f.e.type, 40) && (f.e.type as string).length > 0 ? { t: "ev", dseq: f.dseq, e: f.e as Json & { type: string } } : null;
  if (f.t === "cack") return int(f.cseq) ? { t: "cack", cseq: f.cseq } : null;
  return null;
}

export type CmdKind = "start" | "say" | "stop";
export type AppFrame =
  | { t: "cmd"; cid: string; kind: CmdKind; body: Json }
  | { t: "approval_res"; rid: string; allow: boolean }
  | { t: "disconnect" };
export function parseAppFrame(f: Json): AppFrame | null {
  if (f.t === "disconnect") return { t: "disconnect" };
  if (f.t === "approval_res") return isRid(f.rid) && typeof f.allow === "boolean" ? { t: "approval_res", rid: f.rid, allow: f.allow } : null;
  if (f.t === "cmd") {
    if (!isRid(f.cid)) return null;
    if (f.kind === "stop") return { t: "cmd", cid: f.cid, kind: "stop", body: {} };
    if (f.kind === "say") return str(f.text, 32768) && f.text.length > 0 ? { t: "cmd", cid: f.cid, kind: "say", body: { text: f.text } } : null;
    if (f.kind === "start") return str(f.prompt, 32768) && f.prompt.length > 0 && (f.dir === undefined || str(f.dir, 1024)) ? { t: "cmd", cid: f.cid, kind: "start", body: { prompt: f.prompt, ...(f.dir !== undefined ? { dir: f.dir } : {}) } } : null;
  }
  return null;
}

/** What the PWA sees of a device-sent approval request: only known fields, bounded, `expires_at` (epoch s) set by the hub, never by the daemon. */
export function approvalEvent(e: Json, now: number): { rid: string; tool: string; preview: string; expires_at: number; ttl_s: number } | null {
  if (!isRid(e.rid) || !str(e.tool, 80) || (e.tool as string).length === 0) return null;
  const ttl = int(e.ttl_s) && e.ttl_s > 0 ? Math.min(e.ttl_s, APPROVAL_TTL_MAX_S) : APPROVAL_TTL_DEFAULT_S;
  const preview = typeof e.preview === "string" ? e.preview.slice(0, 4000) : "";
  return { rid: e.rid, tool: e.tool as string, preview, expires_at: now + ttl, ttl_s: ttl };
}

/** Same-origin check for the PWA WebSocket (browsers always send Origin on a WS upgrade; a missing one is refused). */
export const sameOrigin = (req: Request) => { const o = req.headers.get("origin"); return !!o && o === new URL(req.url).origin; };
