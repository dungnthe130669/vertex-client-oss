// Provider list as DATA. `PROVIDERS` is the built-in list (nothing real is enabled: adding a credential is an admin decision);
// optional rows in D1 `provider_configs` (migration 0020, main scope only) add more. A config only ever NAMES the env binding that
// holds its key; the key itself is never stored, returned or logged.
import { CLOUDFLARE_MODELS } from "./cloudflare";
import { PRESETS, NVIDIA_PRESET } from "./presets";
import { descriptorOf } from "./descriptor";
import { catalogCap, chatRows, seedCatalog, toConfigured, type Catalog } from "./catalog";
export { NVIDIA_MAX_OUTPUT } from "./seed";
import { isGuestScope, type BaseScope } from "../scope";
import { CAPABILITY_KEYS, NO_CAPABILITIES, type Capabilities, type PricePerMTok } from "./types";

export type ProviderKind = "gateway" | "openai-compat" | "stub" | "cloudflare" | "gemini";
export interface ConfiguredModel { id: string; /** catalog row kind; routing (chat vs image) uses this, not the mutable capability flags */ kind?: "chat" | "image"; displayName: string; capabilities: Capabilities; pricePerMTok: PricePerMTok | null; contextWindow?: number | null; maxTokens?: number; /** per-model output cap; the request never asks for more */ maxOutput?: number;
  /** free-tier limits (a hint, never throttling; the adapter only reads `tpm` for a short-context model) and adapter flags from the catalog row: `limited` (tiny daily quota, never the default), `shortContext` (trim history to the per-minute token limit), `thinking` (ask for thought summaries), plus parallelTools, reasoningEffort, maxImages, imageTokens */
  limits?: { rpm?: number; rpd?: number; tpm?: number; tpd?: number }; extra?: Record<string, unknown> }
export interface ProviderConfig {
  id: string; kind: ProviderKind; enabled: boolean;
  /** openai-compat: API root without a trailing slash (https only), e.g. https://api.example.com/v1 */
  baseUrl?: string;
  /** Name of the Worker env binding holding the API key. Must look like PROVIDER_KEY_<NAME>. */
  keyBinding?: string;
  models: ConfiguredModel[];
  /** Image models served by an own endpoint (NVIDIA genai: slug + steps), from the catalog's image rows. Absent = the built-in list. */
  mediaModels?: Array<{ id: string; label: string; slug: string; steps: number }>;
  /** openai-compat auth header: "bearer" (default, Authorization: Bearer) | "x-api-key" | a custom header name. */
  authHeader?: string;
  /** Model ids that answered 404 once: hidden until the owner re-enables them. */
  broken?: string[];
  /** Set by buildRegistry (not data): this base stored its own key in the app. */
  userKeySet?: boolean;
  /** Set by buildRegistry (not data): the stored key was saved for a different baseUrl origin than the current one (re-enter it). */
  userKeyStale?: boolean;
  /** Set by buildRegistry (not data): decrypts the base's stored key for ONE request (none = no row: the Worker secret may be used; stale/error never fall back). Wins over the Worker secret; never cached. */
  resolveKey?: () => Promise<import("../user-keys").KeyResult>;
  /** Set by buildRegistry (not data): may THIS base use the operator's shared Cloudflare account right now? Read fresh per call (the per-user `workers-ai` flag, default on,
   *  explicit "0" off). Absent or a throw = no. A linked own account never asks this. */
  sharedAllowed?: () => Promise<boolean>;
  /** Set by buildRegistry (not data): called once when a model answers 404. */
  onBroken?: (model: string) => void;
  /** Guest scopes (g:<uid>) get NOTHING unless a config sets this on purpose. Default false. */
  allowGuests?: boolean;
}

export const PROVIDER_ID = /^[a-z][a-z0-9-]{1,23}$/;
/** Only bindings named PROVIDER_KEY_* may be read as a key: a config row must never be able to point at SESSION_SECRET / GATEWAY_KEY. */
export const KEY_BINDING = /^PROVIDER_KEY_[A-Z0-9_]{1,48}$/;
export const GATEWAY_ID = "gateway";
export const CLOUDFLARE_ID = "cloudflare";
/** auth header option: bearer | x-api-key | a custom header name (token chars only; never one that could change framing or identity). */
export const AUTH_HEADER_RESERVED = /^(host|content-type|content-length|accept|accept-encoding|connection|transfer-encoding|upgrade|cookie|set-cookie|origin|referer|user-agent|cf-.*|x-forwarded-.*)$/i;
export function parseAuthHeader(v: unknown): string | null {
  if (v === undefined || v === null || v === "" || v === "bearer") return "bearer";
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (t === "bearer") return "bearer";
  if (t === "x-api-key") return "x-api-key";
  return /^[a-z][a-z0-9-]{0,39}$/.test(t) && !AUTH_HEADER_RESERVED.test(t) && t !== "authorization" ? t : null;
}
/** SSRF: https only, no credentials, and no loopback / private / link-local / IP-literal / internal-suffix host. (Workers cannot reach private ranges anyway; this keeps the config honest.) */
export function safeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL; try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || /\.(local|internal|localhost|lan|home|corp|intranet)$/.test(h) || /^\[/.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h) || /^0x/i.test(h) || /^\d+$/.test(h.split(".").pop() ?? "")) return null;
  return u.toString().replace(/\/+$/, "");
}

const text = (extra: Partial<Capabilities> = {}): Capabilities => ({ ...NO_CAPABILITIES, text: true, ...extra });

/** Built-in providers. `gateway` is the Vertex team gateway (its models come from the gateway itself, so models is empty here).
 *  `stub` is deterministic and offline, for tests: disabled by default. No real third-party provider is listed. */
export const PROVIDERS: ProviderConfig[] = [
  { id: GATEWAY_ID, kind: "gateway", enabled: true, models: [] },
  // Workers AI through the `AI` binding (no key). Main edition only unless PROVIDER_CF_TEAM is on (see registry.ts). Curated list, tokens only.
  { id: CLOUDFLARE_ID, kind: "cloudflare", enabled: true, models: CLOUDFLARE_MODELS },
  { id: "stub", kind: "stub", enabled: false, models: [{ id: "echo", displayName: "Stub echo", capabilities: text(), pricePerMTok: null }] },
];

/** `<provider>:<model>` -> parts. No prefix (or an unknown shape) = gateway, so every existing model id keeps working. */
export function splitModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf(":");
  if (i > 0 && PROVIDER_ID.test(id.slice(0, i))) return { provider: id.slice(0, i), model: id.slice(i + 1) };
  return { provider: GATEWAY_ID, model: id };
}
export const providerOfModel = (id: string) => splitModelId(id).provider;
export const prefixed = (provider: string, model: string) => (provider === GATEWAY_ID ? model : `${provider}:${model}`);

/** A usable per-model output cap: an integer in [256, 1_000_000]; anything else is treated as absent. */
const outCap = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 256 && v <= 1_000_000 ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
function parseModel(v: any): ConfiguredModel | null {
  if (!v || typeof v.id !== "string" || !v.id || v.id.length > 120 || /[\s]/.test(v.id)) return null;
  const c: Capabilities = { ...NO_CAPABILITIES, text: true };
  if (v.capabilities && typeof v.capabilities === "object") for (const k of CAPABILITY_KEYS) if (typeof v.capabilities[k] === "boolean") c[k] = v.capabilities[k];
  const p = v.pricePerMTok;
  const price = p && num(p.input) !== null && num(p.output) !== null
    ? { input: num(p.input)!, output: num(p.output)!, ...(num(p.cacheRead) !== null ? { cacheRead: num(p.cacheRead)! } : {}), ...(num(p.cacheWrite) !== null ? { cacheWrite: num(p.cacheWrite)! } : {}) } : null;
  return { id: v.id, displayName: typeof v.displayName === "string" && v.displayName ? v.displayName.slice(0, 80) : v.id, capabilities: c, pricePerMTok: price,
    contextWindow: num(v.contextWindow), ...(num(v.maxTokens) ? { maxTokens: num(v.maxTokens)! } : {}), ...(outCap(v.maxOutput) !== null ? { maxOutput: outCap(v.maxOutput)! } : {}) };
}

/** Canonical form of a base URL for equality: https only, no userinfo/query/fragment, host compared verbatim (a trailing dot is a different host), default port dropped, trailing slashes dropped from the path. null = not canonicalisable. */
const canonicalBase = (u: string | undefined): string | null => {
  try {
    const x = new URL(u ?? "");
    if (x.protocol !== "https:" || x.username || x.password || x.search || x.hash) return null;
    return `${x.protocol}//${x.hostname}${x.port ? `:${x.port}` : ""}${x.pathname.replace(/\/+$/, "")}`;
  } catch { return null; }
};
/** True only for the NVIDIA preset's own base URL (scheme + host + port + path); a path edit, look-alike host, userinfo or trailing-dot host is NOT it. Capability raising and the genai key use hang on this, not on the bare origin. */
export const isNvidiaPresetBase = (u: string | undefined): boolean => { const a = canonicalBase(u); return a !== null && a === canonicalBase(NVIDIA_PRESET.baseUrl); };
/** True only for the given built-in preset's own base URL (same exactness as isNvidiaPresetBase). */
export const isPresetBase = (id: string, u: string | undefined): boolean => { const p = PRESETS.find((x) => x.id === id); const a = canonicalBase(u); return !!p && a !== null && a === canonicalBase(p.baseUrl); };
/** Catalog capabilities of a preset-origin chat model (text everywhere, tools/vision only where the catalog says so). */
export const presetCaps = (provider: string, id: string, catalog: Catalog = seedCatalog()): Capabilities => ({ ...NO_CAPABILITIES, text: true, tools: catalogCap(catalog, provider, id, "tools"), vision: catalogCap(catalog, provider, id, "vision"), reasoning: catalogCap(catalog, provider, id, "reasoning") });
/** Validate untrusted config (a D1 row). null = reject the whole entry (it is listed nowhere and used by nothing). */
/** Capabilities of a preset-origin NVIDIA chat model: text everywhere, `tools` / `vision` only where the catalog (seeded from live requests) says so. */
export const nvidiaCaps = (id: string, catalog: Catalog = seedCatalog()): Capabilities => ({ ...NO_CAPABILITIES, text: true, tools: catalogCap(catalog, "nvidia", id, "tools"), vision: catalogCap(catalog, "nvidia", id, "vision") });
/** The NVIDIA list from the catalog (DB rows; the seed when the table is not there yet). */
export function nvidiaDefaultModels(catalog: Catalog = seedCatalog()): ConfiguredModel[] { return chatRows(catalog, "nvidia").map(toConfigured); }
export function parseConfig(r: { id: unknown; kind: unknown; base_url?: unknown; key_binding?: unknown; auth_header?: unknown; broken_json?: unknown; enabled?: unknown; models_json?: unknown; allow_guests?: unknown }, catalog: Catalog = seedCatalog()): ProviderConfig | null {
  if (typeof r.id !== "string" || !PROVIDER_ID.test(r.id) || r.id === GATEWAY_ID) return null;
  if (r.kind !== "openai-compat" && r.kind !== "stub") return null;
  // a locked built-in preset (AI Studio, Groq): a stored row carries ONLY the on/off switch; origin, catalog, defaults and key binding always come from the built-in (withBuiltinPresets)
  const lockedPreset = PRESETS.find((p) => p.id === r.id && descriptorOf(p.id)?.locked);
  if (lockedPreset) return { id: r.id, kind: lockedPreset.kind === "gemini" ? "gemini" : "openai-compat", enabled: r.enabled === 1 || r.enabled === true, models: [] };
  let models: ConfiguredModel[] = [];
  try { const a = JSON.parse(String(r.models_json ?? "[]")); if (Array.isArray(a)) models = a.map(parseModel).filter((m): m is ConfiguredModel => !!m).slice(0, 200); } catch { /* no models */ }
  const cfg: ProviderConfig = { id: r.id, kind: r.kind, enabled: r.enabled === 1 || r.enabled === true, models };
  if (r.kind === "openai-compat") {
    if (typeof r.base_url !== "string") return null;
    const base = safeBaseUrl(r.base_url); if (!base) return null;
    cfg.baseUrl = base;
    // NVIDIA's verified tool support holds for the preset origin only; a stored row pointed elsewhere is text-only whatever its models_json says.
    // only presets with a descriptor + catalog rows (NVIDIA, Groq) get the origin-bound capability rules; any other preset is a plain openai-compat row
    const isPreset = PRESETS.some((x) => x.id === r.id) && !!descriptorOf(r.id), atPreset = isPreset && isPresetBase(r.id, base);
    if (isPreset && !atPreset)
      cfg.models = models = models.map((m) => ({ ...m, capabilities: { ...NO_CAPABILITIES, text: true } }));
    // The catalog is the authority at call time (preset origin): a stored model the catalog knows as disabled / broken / not-a-chat-row is dropped (an admin switch-off sticks), a live catalog row
    // supplies name/limits/capabilities/price (stale stored limits or caps never win), and an id the catalog has never heard of (ticked from a live listing) keeps its stored text-level entry.
    const fresh = models.length === 0;
    if (atPreset) {
      const rows = new Map((catalog.get(r.id) ?? []).map((row) => [row.id, row]));
      cfg.models = models = models.flatMap((m) => { const row = rows.get(m.id); return !row ? [m] : row.kind === "chat" && row.enabled && !row.broken ? [toConfigured(row)] : []; });
    }
    // A fresh NVIDIA row (nothing ticked yet) starts with every live-verified model on; ticking in Settings overrides it.
    if (fresh && atPreset)
      cfg.models = models = chatRows(catalog, r.id).map(toConfigured);
    const ah = parseAuthHeader(r.auth_header); if (!ah) return null;
    cfg.authHeader = ah;
    try { const b = JSON.parse(String(r.broken_json ?? "[]")); if (Array.isArray(b)) cfg.broken = b.filter((x) => typeof x === "string").slice(0, 200); } catch { /* none */ }
    if (typeof r.key_binding === "string" && KEY_BINDING.test(r.key_binding)) cfg.keyBinding = r.key_binding;
  }
  if (r.allow_guests === 1 || r.allow_guests === true) cfg.allowGuests = true;
  return cfg;
}

/** Config rows from D1, read with the BASE scope (credentials are the one thing shared across spaces). Main base only (anything else gets none);
 *  a missing table (migration not applied) = none. */
export async function loadProviderConfigs(db: D1Database | undefined, scope: BaseScope, catalog: Catalog = seedCatalog()): Promise<ProviderConfig[]> {
  if (!db || scope !== "main") return [];
  let rows: { results: any[] } | null = null;
  try { rows = await db.prepare(`SELECT id, kind, base_url, key_binding, enabled, models_json, allow_guests, auth_header, broken_json FROM provider_configs WHERE scope='main' ORDER BY created_at, id`).all<any>(); } catch { rows = null; }
  // migration 0026 not applied yet: the old columns still load (no auth option)
  if (!rows) { try { rows = await db.prepare(`SELECT id, kind, base_url, key_binding, enabled, models_json, allow_guests FROM provider_configs WHERE scope='main' ORDER BY created_at, id`).all<any>(); } catch { rows = null; } }
  const out: ProviderConfig[] = []; const seen = new Set(PROVIDERS.map((p) => p.id));
  for (const r of rows?.results ?? []) { const c = parseConfig(r, catalog); if (c && !seen.has(c.id)) {
    seen.add(c.id); out.push(c);
  } }
  return out;
}

/** Built-in presets every authenticated base sees WITHOUT a provider_configs row (NVIDIA NIM with its verified models on). A preset is only usable with a key:
 *  main may also fall back to the Worker secret PROVIDER_KEY_<ID>; a team base (g:<uid>) gets NO keyBinding, so a shared secret can never be spent on its behalf. e2e gets none. */
export function builtinPresetConfigs(scope: BaseScope, catalog: Catalog = seedCatalog()): ProviderConfig[] {
  const main = scope === "main", guest = isGuestScope(scope);
  if (!main && !guest) return [];
  return PRESETS.map((p): ProviderConfig => p.kind === "gemini"
    // Gemini (AI Studio): the user's own key only (no Worker secret binding), models straight from the catalog, every authenticated base may use it
    ? { id: p.id, kind: "gemini", enabled: true, baseUrl: p.baseUrl, authHeader: p.authHeader, models: chatRows(catalog, p.id).map(toConfigured), allowGuests: true }
    : {
      id: p.id, kind: "openai-compat", enabled: true, baseUrl: p.baseUrl, authHeader: p.authHeader,
      models: chatRows(catalog, p.id).map(toConfigured),
      // a descriptor with keyMode "user" (Groq) never reads a shared Worker secret: only the user's own stored key can authenticate it
      ...(main ? (descriptorOf(p.id)?.keyMode === "user" ? {} : { keyBinding: bindingFor(p.id) }) : { allowGuests: true }),
    });
}
/** A stored row (main only) wins over the built-in preset of the same id; presets fill the gaps. */
export const withBuiltinPresets = (scope: BaseScope, rows: ProviderConfig[], catalog: Catalog = seedCatalog()): ProviderConfig[] => {
  const locked = (id: string) => !!descriptorOf(id)?.locked && PRESETS.some((p) => p.id === id);
  // a locked preset keeps its built-in config; the stored row only contributes enabled
  return [...rows.filter((r) => !locked(r.id)),
    ...builtinPresetConfigs(scope, catalog).filter((p) => !PROVIDERS.some((r) => r.id === p.id) && (locked(p.id) || !rows.some((r) => r.id === p.id)))
      .map((p) => (locked(p.id) && rows.some((r) => r.id === p.id && !r.enabled) ? { ...p, enabled: false } : p))];
};

/** The Worker secret a provider row names: `nvidia` -> PROVIDER_KEY_NVIDIA. A human provisions it (`wrangler secret put`); the app never stores a key. */
export const bindingFor = (id: string) => `PROVIDER_KEY_${id.toUpperCase().replace(/-/g, "_")}`;

/** Re-read a value at most every `ttlMs` (on use). A failed reload keeps the last good value. Used so removing/disabling a provider reaches running ChatSessions within ~15 s. */
export function ttlLoader<K, T>(load: (k: K) => Promise<T>, initial: T, ttlMs = 15_000, now: () => number = Date.now) {
  let value = initial, at = 0;
  return {
    get value() { return value; },
    /** Mark as just loaded (the constructor's own first load). */
    set(v: T) { value = v; at = now(); },
    /** Force the next refresh() to reload. */
    invalidate() { at = 0; },
    async refresh(k: K): Promise<T> { if (now() - at >= ttlMs) { at = now(); try { value = await load(k); } catch { /* keep the last good value */ } } return value; },
  };
}

/** The shared Worker secret (PROVIDER_KEY_<ID>) belongs to the built-in preset's origin only: a provider whose baseUrl was edited elsewhere (or that has no preset) must never receive it. */
export const workerKeyAllowed = (cfg: Pick<ProviderConfig, "id" | "baseUrl">): boolean => {
  const p = PRESETS.find((x) => x.id === cfg.id); if (!p || !cfg.baseUrl) return false;
  try { return new URL(cfg.baseUrl).origin === new URL(p.baseUrl).origin; } catch { return false; }
};
