// Offline cache of the last good /api/me (CSRF blanked): lets an offline load keep the app usable behind the offline pill.
// Strictly validated before anything reaches a component, expires, same space only, dropped on sign-out / any API 401 / an explicit "forbidden".
import type { Me } from "./api";
import { dropNewChatDrafts } from "./chat-ux";

export const ME_KEY = "vc-me";
export const ME_TTL_MS = 7 * 24 * 3600 * 1000;
export type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const store = (): KV | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
const isSpace = (v: unknown) => v === "biz" || v === "open";
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

/** Every field a component reads, type-checked; anything else (or extra junk) is dropped, so a corrupt entry can never crash a screen. */
export function validMe(m: any): Me | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  if (typeof m.user !== "string" || typeof m.via !== "string") return null;
  if (m.defaultModel !== null && typeof m.defaultModel !== "string") return null;
  if (!optBool(m.erichOnly) || !optBool(m.team) || !optBool(m.sso)) return null;
  if (m.space !== undefined && !isSpace(m.space)) return null;
  if (m.spaces !== undefined && !(Array.isArray(m.spaces) && m.spaces.every(isSpace))) return null;
  return { user: m.user, via: m.via, csrf: "", defaultModel: m.defaultModel, ...(m.erichOnly !== undefined ? { erichOnly: m.erichOnly } : {}), ...(m.team !== undefined ? { team: m.team } : {}), ...(m.sso !== undefined ? { sso: m.sso } : {}), ...(m.space !== undefined ? { space: m.space } : {}), ...(m.spaces !== undefined ? { spaces: [...m.spaces] } : {}) } as Me;
}

export const saveMe = (me: Me, space: string, now = Date.now(), kv: KV | null = store()) => { try { kv?.setItem(ME_KEY, JSON.stringify({ space, at: now, me: { ...me, csrf: "" } })); } catch { /* quota / private mode: no offline cache, nothing else lost */ } };
export const dropMe = (kv: KV | null = store()) => { try { kv?.removeItem(ME_KEY); } catch { /* ignore */ } dropNewChatDrafts(kv); }; // the identity and what it was typing leave together
/** The cached identity, or null (none, other space, expired, malformed: the last three also remove it). */
export function cachedMe(space: string, now = Date.now(), kv: KV | null = store()): Me | null {
  try {
    const raw = kv?.getItem(ME_KEY); if (!raw) return null;
    const v = JSON.parse(raw);
    const me = v && typeof v === "object" && v.space === space && typeof v.at === "number" && now - v.at >= 0 && now - v.at <= ME_TTL_MS ? validMe(v.me) : null;
    if (!me && !(v && v.space !== space)) dropMe(kv); // another space's entry is left for that space
    return me;
  } catch { dropMe(kv); return null; }
}
