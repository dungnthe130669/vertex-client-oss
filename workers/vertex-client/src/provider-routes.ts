// Settings > Providers write side (main scope only): add/update/delete an openai-compat provider, paste its key, load its model list, choose the enabled
// models. A row names the Worker secret (key_binding = PROVIDER_KEY_<ID>) a human may provision; a key can also be stored encrypted per base via PUT /api/providers/:id/key (user-keys.ts).
// Reads carry only `keySet` (whether that secret is present, true/false); the value is never read into a response.
import type { Context, Hono } from "hono";
import type { Env } from "./index";
import { MAIN_SCOPE, baseOf, isGuestScope, withSpace, type Scope } from "./scope";
import { openAllowed } from "./open-space";
import { deleteUserKey, deleteUserKeysOfProvider, isMissingTable, originOf, putUserKey, readBodyCapped, userKeyIds, userKeysFor, validateKey, withUserKey } from "./user-keys";
import { GATEWAY_ID, PROVIDER_ID, CLOUDFLARE_ID, KEY_BINDING, bindingFor, loadProviderConfigs, presetCaps, isPresetBase, withBuiltinPresets, parseAuthHeader, safeBaseUrl, type ProviderConfig } from "./providers/config";
import { listUpstreamModels } from "./providers/openai-compat";
import { listGeminiModels } from "./providers/gemini";
import { keySourceOf, type KeySource } from "./providers/registry";
import { PRESETS } from "./providers/presets";
import { loadCatalog } from "./providers/catalog";
import { NVIDIA_DESCRIPTOR, descriptorOf, discoveredKind } from "./providers/descriptor";
import { NO_CAPABILITIES, ProviderError } from "./providers/types";

type App = { Bindings: Env; Variables: { session: import("./auth").Session } };
const noStore = { "cache-control": "no-store" };
const RESERVED = new Set([GATEWAY_ID, CLOUDFLARE_ID, "stub", "registry"]);

/** Public view of a configured (D1) provider: never the key, the binding name or the full base URL (host only). */
export const publicConfig = (c: ProviderConfig, env: Env, savedOrigin?: string) => { const src = keySourceOf({ ...c, ...(savedOrigin !== undefined ? { userKeySet: true, userKeyStale: savedOrigin !== originOf(c.baseUrl) } : {}) }, env as unknown as Record<string, unknown>); return { id: c.id, authHeader: c.authHeader ?? "bearer", keySet: src !== "none", key_source: src, host: (() => { try { return new URL(c.baseUrl ?? "").hostname; } catch { return ""; } })(), enabledModels: c.models.map((m) => m.id), broken: c.broken ?? [], enabled: c.enabled }; };

// PUT is rate limited per base (in-memory, per isolate: a brake on guessing/abuse, not an accounting).
const PUT_LIMIT = 10, PUT_WINDOW_MS = 60_000; const putLog = new Map<string, number[]>();
export const resetPutLimit = () => putLog.clear();
export const putAllowed = (base: string, now = Date.now()) => { const l = (putLog.get(base) ?? []).filter((t) => now - t < PUT_WINDOW_MS); if (l.length >= PUT_LIMIT) { putLog.set(base, l); return false; } l.push(now); putLog.set(base, l); return true; };
/** Audit line: who (base), what, which provider. Never the value. */
const audit = (op: "put" | "delete", base: string, provider: string) => console.info(JSON.stringify({ audit: "provider-key", op, base, provider }));

export function providerWriteRoutes(app: Hono<App>, scopeOf: (c: Context<App>) => Scope, deps: { fetchImpl?: typeof fetch }) {
  // Row writes / model listing are main-only. A team user (g:<uid>) with Open enabled may only read the presets and manage its OWN key (PUT/DELETE .../key, GET configured/presets);
  // the e2e tester and a team user with Open off get 403 (never a write, never a credential). Fail closed.
  const GUEST_OK = /^\/api\/providers\/(presets|configured|[a-z][a-z0-9-]{1,23}\/key)$/;
  const guard = async (c: Context<App>, next: () => Promise<void>) => {
    if (c.req.path === "/api/providers") return next();
    const sc = withSpace(scopeOf(c), "biz");
    if (sc === MAIN_SCOPE) return next();
    if (isGuestScope(baseOf(sc)) && GUEST_OK.test(c.req.path) && ["GET", "PUT", "DELETE"].includes(c.req.method) && (await openAllowed(c.env, baseOf(sc)))) return next();
    return c.json({ error: "forbidden" }, 403, noStore);
  };
  app.use("/api/providers/*", guard as never);

  app.get("/api/providers/presets", (c) => c.json({ presets: PRESETS }, 200, noStore));
  app.get("/api/providers/configured", async (c) => { const cat = await loadCatalog(c.env.DB); const ids = await userKeyIds(c.env.DB, baseOfReq(c)); return c.json({ providers: withBuiltinPresets(baseOfReq(c), await loadProviderConfigs(c.env.DB, baseOfReq(c), cat), cat).map((x) => publicConfig(x, c.env, ids.get(x.id))) }, 200, noStore); });

  const baseOfReq = (c: Context<App>) => baseOf(scopeOf(c));
  const idOf = (c: Context<App>) => { const id = c.req.param("id") ?? ""; return PROVIDER_ID.test(id) && !RESERVED.has(id) ? id : null; };
  const one = async (c: Context<App>, id: string) => { const cat = await loadCatalog(c.env.DB); return withBuiltinPresets(baseOfReq(c), await loadProviderConfigs(c.env.DB, baseOfReq(c), cat), cat).find((p) => p.id === id) ?? null; };

  // Create / update (admin-side row, no key). Body: { baseUrl?, authHeader?, enabled?, models?: string[] }; a preset id (nvidia) supplies the defaults.
  app.put("/api/providers/:id", async (c) => {
    const id = idOf(c); if (!id) return c.json({ error: "bad provider id" }, 400);
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null; if (!b || typeof b !== "object") return c.json({ error: "bad body" }, 400);
    const cat = await loadCatalog(c.env.DB);
    const prev = await one(c, id);
    const preset = PRESETS.find((x) => x.id === id);
    // a catalog-only built-in (AI Studio): its models are the catalog and its URL is fixed; only the user's own key can be set (PUT .../key)
    if (preset?.kind === "gemini") return c.json({ error: "this provider is built in: only its API key can be set" }, 400);
    const baseUrl = safeBaseUrl(b.baseUrl ?? prev?.baseUrl ?? preset?.baseUrl); if (!baseUrl) return c.json({ error: "base URL must be https, with a public host and no credentials" }, 400);
    const authHeader = parseAuthHeader(b.authHeader ?? prev?.authHeader ?? preset?.authHeader); if (!authHeader) return c.json({ error: "bad auth header (bearer, x-api-key or a header name)" }, 400);
    const binding = bindingFor(id); if (!KEY_BINDING.test(binding)) return c.json({ error: "bad provider id" }, 400);
    let models = prev?.models ?? [];
    // moving to another origin: whatever was verified for the old one (NVIDIA tool calling) says nothing about the new one, so every model goes back to text-only
    if (prev && originOf(prev.baseUrl) !== originOf(baseUrl)) models = models.map((m) => ({ ...m, capabilities: { ...NO_CAPABILITIES, text: true } }));
    let broken = prev?.broken ?? [], reticked: string[] = [];
    if (b.models !== undefined) {
      if (!Array.isArray(b.models) || b.models.length > 200 || b.models.some((m) => typeof m !== "string" || !m || m.length > 120 || /\s/.test(m))) return c.json({ error: "bad model list" }, 400);
      const ids = [...new Set(b.models as string[])];
      const before = new Set(prev?.models.map((m) => m.id));
      // a model the owner re-ticks (it was not enabled a moment ago) leaves the broken list; one that stays ticked stays hidden
      broken = broken.filter((m) => ids.includes(m) && before.has(m));
      reticked = ids.filter((m) => !before.has(m));
      // Capabilities are NOT guessed from the id: a listing carries no metadata, so every model is text-only (no tools, no vision).
      models = ids.map((m) => models.find((x) => x.id === m) ?? { id: m, displayName: m.replace(/^.*\//, ""), capabilities: PRESETS.some((x) => x.id === id) && !!descriptorOf(id) && isPresetBase(id, baseUrl) ? presetCaps(id, m, cat) : { ...NO_CAPABILITIES, text: true }, pricePerMTok: null, contextWindow: null });
    }
    const enabled = b.enabled === undefined ? (prev?.enabled ?? true) : b.enabled === true;
    const upsert = c.env.DB.prepare(`INSERT INTO provider_configs (id, scope, kind, base_url, key_binding, enabled, models_json, allow_guests, auth_header, broken_json)
      VALUES (?, 'main', 'openai-compat', ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(scope, id) DO UPDATE SET base_url=excluded.base_url, key_binding=excluded.key_binding, enabled=excluded.enabled, models_json=excluded.models_json, auth_header=excluded.auth_header, broken_json=excluded.broken_json`)
      .bind(id, baseUrl, binding, enabled ? 1 : 0, JSON.stringify(models), authHeader, JSON.stringify(broken));
    try { await upsert.run(); }
    catch (e) {
      // migration 0026 (auth_header / broken_json) not applied yet: say so instead of an uncaught D1 error
      if (/no such column|has no column|no column named/i.test(e instanceof Error ? e.message : String(e))) return c.json({ error: "migration required: apply 0026 (wrangler d1 migrations apply --remote) before saving providers" }, 409, noStore);
      console.error("provider save", e instanceof Error ? e.message : String(e)); return c.json({ error: "could not save the provider" }, 500, noStore);
    }
    await clearUserBroken(c.env.DB, baseOfReq(c), id, reticked); // re-ticking also clears THIS user's own broken entry
    // a stored key is bound to the baseUrl origin it was saved for: moving the provider elsewhere drops every base's key for it. Done AFTER the upsert; if the purge fails the call-time origin check still refuses the stale key.
    if (prev && originOf(prev.baseUrl) !== originOf(baseUrl)) {
      try { await deleteUserKeysOfProvider(c.env.DB, id); }
      catch (e) { if (!isMissingTable(e)) { console.error("provider key purge", e instanceof Error ? e.message : String(e)); return c.json({ error: "provider saved but its stored keys could not be purged; they stay unusable (origin mismatch). Retry the save." }, 500, noStore); } }
    }
    const now = await one(c, id);
    return c.json({ provider: now ? publicConfig(now, c.env, (await userKeyIds(c.env.DB, MAIN_SCOPE)).get(id)) : null }, 200, noStore);
  });

  app.delete("/api/providers/:id", async (c) => {
    const id = idOf(c); if (!id) return c.json({ error: "bad provider id" }, 400);
    // key rows + provider row go in ONE batch (all or nothing); a failed key delete aborts the removal. Missing table (0027 not applied) = no key rows, delete the provider alone.
    const delProv = c.env.DB.prepare(`DELETE FROM provider_configs WHERE scope='main' AND id=?`).bind(id);
    try {
      try { await c.env.DB.batch([c.env.DB.prepare(`DELETE FROM provider_user_keys WHERE provider_id=?`).bind(id), delProv]); }
      catch (e) { if (!isMissingTable(e)) throw e; await delProv.run(); }
    } catch (e) { console.error("provider delete", e instanceof Error ? e.message : String(e)); return c.json({ error: "could not remove the provider" }, 500, noStore); }
    return c.json({ ok: true }, 200, noStore);
  });

  // In-app key (base-scoped, encrypted at rest). The key never appears in a response, a log line or an error: only `key_source`.
  const keyState = async (c: Context<App>, id: string): Promise<KeySource> => {
    const cfg = await one(c, id);
    const saved = cfg ? (await userKeyIds(c.env.DB, baseOfReq(c))).get(id) : undefined;
    return cfg ? keySourceOf({ ...cfg, ...(saved !== undefined ? { userKeySet: true, userKeyStale: saved !== originOf(cfg.baseUrl) } : {}) }, c.env as unknown as Record<string, unknown>) : "none";
  };
  const MIGRATION = "migration required: apply 0027 (wrangler d1 migrations apply --remote) before storing keys";
  app.put("/api/providers/:id/key", async (c) => {
    const id = idOf(c); if (!id) return c.json({ error: "bad provider id" }, 400, noStore);
    const base = baseOfReq(c);
    if (!putAllowed(base)) return c.json({ error: "too many key changes, wait a minute" }, 429, noStore);
    const secret = c.env.KEY_ENC_SECRET; if (!secret) return c.json({ error: "key storage not configured" }, 409, noStore);
    const raw = await readBodyCapped(c.req.raw); if (raw === null) return c.json({ error: "body too large" }, 413, noStore);
    let b: unknown = null; try { b = JSON.parse(raw); } catch { /* bad body */ }
    const key = validateKey((b as { key?: unknown } | null)?.key); if (!key) return c.json({ error: "key must be 8-512 characters with no spaces" }, 400, noStore);
    const prov = await one(c, id); if (!prov) return c.json({ error: "unknown provider" }, 404, noStore);
    const origin = originOf(prov.baseUrl); if (!origin) return c.json({ error: "this provider has no valid base URL" }, 400, noStore);
    try { await putUserKey({ DB: c.env.DB, KEY_ENC_SECRET: secret }, base, id, origin, key); }
    catch (e) { if (isMissingTable(e)) return c.json({ error: MIGRATION }, 409, noStore); return c.json({ error: "could not save the key" }, 500, noStore); }
    audit("put", base, id);
    return c.json({ ok: true, key_source: await keyState(c, id) }, 200, noStore);
  });
  app.delete("/api/providers/:id/key", async (c) => {
    const id = idOf(c); if (!id) return c.json({ error: "bad provider id" }, 400, noStore);
    const base = baseOfReq(c);
    try { await deleteUserKey(c.env.DB, base, id); }
    catch (e) { if (isMissingTable(e)) return c.json({ error: MIGRATION }, 409, noStore); return c.json({ error: "could not remove the key" }, 500, noStore); }
    audit("delete", base, id);
    return c.json({ ok: true, key_source: await keyState(c, id) }, 200, noStore);
  });

  // "Test connection / load models": GET <base>/models with the stored key. Lists ids only; no model is called (nothing paid is probed).
  app.post("/api/providers/:id/models", async (c) => {
    const id = idOf(c); if (!id) return c.json({ error: "bad provider id" }, 400);
    const found = await one(c, id); if (!found) return c.json({ error: "unknown provider" }, 404);
    const uk = userKeysFor(c.env, baseOfReq(c), await userKeyIds(c.env.DB, baseOfReq(c)));
    const cfg: ProviderConfig = withUserKey(found, uk);
    try {
      const cat = await loadCatalog(c.env.DB);
      const env = c.env as unknown as Record<string, unknown>;
      const ids = (cfg.kind === "gemini" ? await listGeminiModels(cfg, env, deps.fetchImpl as never) : await listUpstreamModels(cfg, env, deps.fetchImpl as never)).filter((m) => discoveredKind(descriptorOf(cfg.id) ?? NVIDIA_DESCRIPTOR, m) !== "skip");
      const on = new Set(cfg.models.map((m) => m.id)), bad = new Set([...(cfg.broken ?? []), ...((await loadUserBroken(c.env.DB, baseOfReq(c)))[cfg.id] ?? [])]);
      return c.json({ models: ids.map((m) => ({ id: m, enabled: on.has(m), broken: bad.has(m), suggested: (cat.get(cfg.id) ?? []).some((r) => r.id === m && r.suggested), verified: (cat.get(cfg.id) ?? []).some((r) => r.id === m && r.kind === "chat") })) }, 200, noStore);
    } catch (e) {
      const status = e instanceof ProviderError ? e.status : 502;
      return c.json({ error: e instanceof Error ? e.message : "provider error" }, status as 502, noStore);
    }
  });
}

/** Per-user broken list of any provider: D1 `settings` row `pbroken:<base>:<provider>` = JSON array of model ids. A user's own 404/410 (their key may lack access)
 *  hides the model for THAT user only; the shared provider_models row is never written from a request (admin edits / seed only). */
const brokenName = (base: string, providerId: string) => `pbroken:${base}:${providerId}`;
const strList = (v: unknown): string[] => { try { const a = JSON.parse(String(v)); return Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(0, 200) : []; } catch { return []; } };
export async function loadUserBroken(db: D1Database | undefined, base: string): Promise<Record<string, string[]>> {
  if (!db) return {};
  try {
    // exact, case-sensitive prefix match via substr (no LIKE: a base containing % or _ must not widen the match to another tenant)
    const prefix = `pbroken:${base}:`;
    const r = await db.prepare(`SELECT name, value FROM settings WHERE substr(name, 1, ?) = ?`).bind(prefix.length, prefix).all<{ name: string; value: string }>();
    const out: Record<string, string[]> = {};
    for (const x of r.results ?? []) { const pid = x.name.slice(prefix.length); if (pid && !pid.includes(":")) out[pid] = strList(x.value); }
    return out;
  } catch { return {}; }
}

/** A model the user re-ticked leaves THEIR own broken list (the row of this base + provider only). Best effort. */
export async function clearUserBroken(db: D1Database | undefined, base: string, providerId: string, models: string[]): Promise<void> {
  if (!db || !models.length) return;
  try {
    const name = brokenName(base, providerId);
    const r = await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(name).first<{ value: string }>();
    if (!r) return;
    const list = strList(r.value), keep = list.filter((m) => !models.includes(m));
    if (keep.length !== list.length) await db.prepare(`UPDATE settings SET value=? WHERE name=?`).bind(JSON.stringify(keep), name).run();
  } catch { /* settings unavailable */ }
}
/** D1 write for a model that answered 404/410: hide it for THIS user until the admin/seed changes the catalog. Generic for every provider: it only ever writes the caller's own
 *  `pbroken:<base>:<provider>` settings row (keyed by provider + model), never provider_configs (scope='main') or the shared catalog, so one user's 404 cannot hide a model for another. Best effort. */
export async function markBroken(db: D1Database | undefined, providerId: string, model: string, base?: string): Promise<void> {
  if (!db || !base) return;
  try {
    const name = brokenName(base, providerId);
    const r = await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(name).first<{ value: string }>();
    const list = r ? strList(r.value) : [];
    if (!list.includes(model)) await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(name, JSON.stringify([...list, model].slice(-200))).run();
  } catch { /* settings unavailable: nothing to record */ }
}
