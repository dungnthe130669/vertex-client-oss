// capsOf (wscaps1, C1): the single resolver of what a scope/account may do. Layers: (1) base KIND table (scope.ts kindCaps, pure), (2) per-base settings
// rows, (3) per-account identity. Everything fails closed (a missing DB, a D1 error, an odd value = the capability is OFF).
// With no new setting rows present, every answer equals the pre-wscaps1 hard-coded checks (pinned by test/caps.test.ts).
import { baseOf, isGuestScope, kindCapsOf, parseBase, spaceOf, type BaseScope, type Scope } from "./scope";

export interface Identity { user?: string; email?: string }
export interface Caps {
  erichOnlyModes: boolean;
  personalFeatures: boolean;
  /** May link devices NOW: Business space, kind allows it, and the `vcl:<base>` row is exactly '1'. */
  devices: boolean;
  /** Live (non-revoked) devices allowed; 0 when `devices` is off. main/e2e 10, g:* 1. */
  devicesMax: number;
  /** Per-ACCOUNT "shared machines" capability (C3): the identity is in settings `shared_devices_emails`. Default nobody. */
  sharedDevices: boolean;
  /** The Open space (own provider keys) is this scope's space. */
  openSpace: boolean;
}

/** Optional per-request memo of settings reads (name -> value|null). Create one per request (`new Map()`) and pass it to capsOf/devicesOn; never share across requests. */
export type CapsCache = Map<string, string | null>;

async function setting(db: D1Database | undefined, name: string, cache?: CapsCache): Promise<string | null> {
  if (!db) return null;
  if (cache?.has(name)) return cache.get(name) ?? null;
  let v: string | null = null;
  try { v = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(name).first<{ value: string }>())?.value ?? null; } catch { v = null; }
  cache?.set(name, v);
  return v;
}

/** conv2 (C2): per-base-CLASS capability rows `cap:<class>:<name>` in `settings`. class: m = main + every e2e tenant, g = a team guest (g:<uid>), o = an org base (o:<id>, not minted yet).
 *  Rows may only NARROW what the kind table (scope.ts) allows, never widen: a boolean row is honoured only when it is exactly "0" (turns the capability off);
 *  `devicesMax` honours only canonical digits <= the kind ceiling. A missing/garbled/oversized row = the default. So bad data can never grant anything,
 *  and with no rows every answer equals the pre-conv2 behaviour (pinned by test/caps-rows.test.ts). Widening stays with the explicit per-base flags (`vcl:<base>`). */
export type CapClass = "m" | "g" | "o";
export const CAP_NAMES = ["erichOnlyModes", "personalFeatures", "devices", "devicesMax", "sharedDevices", "openSpace"] as const;
export type CapName = (typeof CAP_NAMES)[number];
export function capClassOf(base: string): CapClass | null {
  if (parseBase(base) !== null) return isGuestScope(base as BaseScope) ? "g" : "m";
  return /^o:[a-z0-9]{1,32}$/.test(base) ? "o" : null;
}
const capRowName = (cls: CapClass, name: CapName) => `cap:${cls}:${name}`;
async function narrowBool(db: D1Database | undefined, scope: Scope, name: CapName, dflt: boolean, cache?: CapsCache): Promise<boolean> {
  if (!dflt) return false; // never widen
  const base = baseOf(scope);
  const cls = capClassOf(base);
  if (!cls) return dflt; // no class = no row can apply; the default (kind table) stands, exactly as before
  return (await setting(db, capRowName(cls, name), cache)) === "0" ? false : dflt;
}
async function narrowMax(db: D1Database | undefined, scope: Scope, dflt: number, cache?: CapsCache): Promise<number> {
  const base = baseOf(scope);
  const cls = capClassOf(base);
  if (!cls) return dflt;
  const raw = await setting(db, capRowName(cls, "devicesMax"), cache);
  if (raw === null || !/^(0|[1-9][0-9]{0,3})$/.test(raw)) return dflt;
  const n = Number(raw);
  return n <= dflt ? n : dflt; // a row above the kind ceiling is ignored
}

/** Device linking switch: Business space only, kind ceiling, and the explicit per-base row. (Replaces the body of the old vclEnabled.) */
export async function devicesOn(db: D1Database | undefined, scope: Scope, cache?: CapsCache): Promise<boolean> {
  if (spaceOf(scope) !== "biz") return false;
  const base = baseOf(scope);
  if (!kindCapsOf(scope).devices) return false;
  if (!(await narrowBool(db, scope, "devices", true, cache))) return false;
  return (await setting(db, `vcl:${base}`, cache)) === "1";
}

/** C3: is this identity on the shared-machines allow-list? Comma-separated, case-insensitive, trimmed; absent/empty = nobody. Matches email or user. */
export async function sharedDevicesAllowed(db: D1Database | undefined, id: Identity, cache?: CapsCache): Promise<boolean> {
  const keys = [id.email, id.user].filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim().toLowerCase());
  if (!keys.length) return false;
  const raw = await setting(db, "shared_devices_emails", cache);
  if (!raw) return false;
  const list = new Set(raw.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
  return keys.some((k) => list.has(k));
}

export async function capsOf(db: D1Database | undefined, scope: Scope, identity: Identity = {}, cache: CapsCache = new Map()): Promise<Caps> {
  const k = kindCapsOf(scope), biz = spaceOf(scope) === "biz";
  const devices = await devicesOn(db, scope, cache);
  return {
    erichOnlyModes: await narrowBool(db, scope, "erichOnlyModes", biz && k.erichOnlyModes, cache),
    personalFeatures: await narrowBool(db, scope, "personalFeatures", k.personalFeatures, cache),
    devices,
    devicesMax: devices ? await narrowMax(db, scope, k.devicesMax, cache) : 0,
    sharedDevices: devices && (await narrowBool(db, scope, "sharedDevices", true, cache)) && (await sharedDevicesAllowed(db, identity, cache)),
    openSpace: await narrowBool(db, scope, "openSpace", !biz, cache),
  };
}
