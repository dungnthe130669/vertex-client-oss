// Provider API keys entered in the app (Settings > Providers), stored encrypted per (base, provider). AES-256-GCM, key = HKDF(KEY_ENC_SECRET,
// info "provider-key:<base>:<provider>"), random 12-byte iv, AAD "<base>:<provider>:<origin>" (a ciphertext copied to another row, or to a provider whose baseUrl origin differs, does not decrypt).
// The plaintext exists only inside `userKeyOf` (called per request by the provider adapter); nothing here caches, returns to a client or logs it.
import type { BaseScope } from "./scope";
import type { ProviderConfig } from "./providers/config";

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const KEY_MIN = 8, KEY_MAX = 512, MAX_BODY = 4096;

/** scheme://host[:port] of a provider base URL, or null when it is not a URL. A stored key is only ever sent to the origin it was saved for. */
export const originOf = (url: string | undefined): string | null => { try { return url ? new URL(url).origin : null; } catch { return null; } };
const aadOf = (base: string, provider: string, origin: string) => `${base}:${provider}:${origin}`;
async function aesKey(secret: string, base: string, provider: string): Promise<CryptoKey> {
  if (!secret) throw new Error("key storage not configured");
  if (!base || base.includes("~")) throw new Error("bad base"); // the BASE scope only, never a space-qualified one
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(`provider-key:${base}:${provider}`) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptKey(secret: string, base: string, provider: string, origin: string, plain: string): Promise<{ ct: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aadOf(base, provider, origin)) }, await aesKey(secret, base, provider), enc.encode(plain)));
  return { ct: b64(ct), iv: b64(iv) };
}
export async function decryptKey(secret: string, base: string, provider: string, row: { ct: string; iv: string; origin: string }): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.iv), additionalData: enc.encode(aadOf(base, provider, row.origin)) }, await aesKey(secret, base, provider), unb64(row.ct));
  return new TextDecoder().decode(pt);
}

/** trimmed key, or null when it is not 8..512 chars of non-whitespace / non-control. */
export function validateKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length >= KEY_MIN && t.length <= KEY_MAX && !/[\s\u0000-\u001f\u007f]/.test(t) ? t : null;
}

/** Per-base change counter for the stored keys, bumped by the link/unlink routes. A ChatSession in the same isolate compares it before using its 15 s presence cache, so an
 *  unlink (or link) is seen at once instead of after the cache window. (Another isolate still converges within the window; the key itself is always read fresh from D1.) */
const keyEpochs = new Map<string, number>();
export const bumpKeyEpoch = (base: string) => { keyEpochs.set(base, (keyEpochs.get(base) ?? 0) + 1); };
export const keyEpochOf = (base: string) => (keyEpochs.get(base) ?? 0) + (keyEpochs.get("*") ?? 0);
export type KeyEnv = { DB?: D1Database; KEY_ENC_SECRET?: string };
const noTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));
export const isMissingTable = noTable;

/** Provider id -> the origin its stored key was saved for (presence only). A missing table (migration 0027 not applied) = none. Display only: the call path re-reads its own row (userKeyOf). */
export async function userKeyIds(db: D1Database | undefined, base: BaseScope): Promise<Map<string, string>> {
  if (!db) return new Map();
  try { const r = await db.prepare(`SELECT provider_id, origin FROM provider_user_keys WHERE base=?`).bind(base).all<{ provider_id: string; origin: string }>(); return new Map((r.results ?? []).map((x) => [x.provider_id, x.origin] as [string, string])); }
  catch { return new Map(); }
}
/** What a call may do about the base's stored key: none (no row: the Worker secret may be used), key (use it), stale (saved for another origin) or error (row present but unusable). stale/error never fall back. */
export type KeyResult = { kind: "none" } | { kind: "key"; key: string } | { kind: "stale" } | { kind: "error" };
/** Decrypt this base's key for a provider whose CURRENT baseUrl origin is `origin`. Call per request; never keep the result. Only "no row" (or no table/DB) is "none". */
export async function userKeyOf(env: KeyEnv, base: BaseScope, provider: string, origin: string | null): Promise<KeyResult> {
  if (!env.DB) return { kind: "none" };
  let row: { ct: string; iv: string; origin: string } | null;
  try { row = await env.DB.prepare(`SELECT ct, iv, origin FROM provider_user_keys WHERE base=? AND provider_id=?`).bind(base, provider).first<{ ct: string; iv: string; origin: string }>(); }
  catch (e) { return noTable(e) ? { kind: "none" } : { kind: "error" }; }
  if (!row) return { kind: "none" };
  if (!env.KEY_ENC_SECRET || !origin) return { kind: "error" };
  if (row.origin !== origin) return { kind: "stale" };
  try { return { kind: "key", key: await decryptKey(env.KEY_ENC_SECRET, base, provider, row) }; } catch { return { kind: "error" }; }
}
export async function putUserKey(env: Required<KeyEnv>, base: BaseScope, provider: string, origin: string, key: string, now = Date.now()): Promise<void> {
  const { ct, iv } = await encryptKey(env.KEY_ENC_SECRET, base, provider, origin, key);
  await env.DB.prepare(`INSERT INTO provider_user_keys (base, provider_id, origin, ct, iv, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(base, provider_id) DO UPDATE SET origin=excluded.origin, ct=excluded.ct, iv=excluded.iv, updated_at=excluded.updated_at`).bind(base, provider, origin, ct, iv, now).run();
  bumpKeyEpoch(base);
}
export const deleteUserKey = async (db: D1Database, base: BaseScope, provider: string) => { const r = await db.prepare(`DELETE FROM provider_user_keys WHERE base=? AND provider_id=?`).bind(base, provider).run(); bumpKeyEpoch(base); return r; };
/** Every base's stored key for a provider (its baseUrl origin changed, or it was removed). */
export const deleteUserKeysOfProvider = async (db: D1Database, provider: string) => { const r = await db.prepare(`DELETE FROM provider_user_keys WHERE provider_id=?`).bind(provider).run(); bumpKeyEpoch("*"); return r; };

/** The pieces a registry needs: presence (+ origin saved for) and a per-request resolver bound to one base. */
export const userKeysFor = (env: KeyEnv, base: BaseScope, ids: Map<string, string>) => ({ ids, get: (provider: string, origin: string | null) => userKeyOf(env, base, provider, origin) });
export type UserKeys = ReturnType<typeof userKeysFor>;
/** Config fields for a provider the base may hold a key for. The resolver is ALWAYS attached (even with no known row): the call path decides from its own read, so a failed presence read never falls open. */
export const withUserKey = (cfg: ProviderConfig, uk: UserKeys): ProviderConfig => {
  const saved = uk.ids.get(cfg.id);
  return { ...cfg, ...(saved !== undefined ? { userKeySet: true, userKeyStale: saved !== originOf(cfg.baseUrl) } : {}), resolveKey: () => uk.get(cfg.id, originOf(cfg.baseUrl)) };
};

/** Read a request body of at most `cap` bytes: reject by Content-Length first, then count while streaming and cancel at the cap (never buffers the whole body). null = too large / unreadable. */
export async function readBodyCapped(req: Request, cap = MAX_BODY): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return "";
  const reader = req.body.getReader(), dec = new TextDecoder(); let out = "", n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.byteLength;
      if (n > cap) { await reader.cancel().catch(() => {}); return null; }
      out += dec.decode(value, { stream: true });
    }
    return out + dec.decode();
  } catch { return null; }
}
