// Model catalog as DATA: D1 `provider_models` (migration 0029) rows -> the ConfiguredModel lists the registry serves. Seed (providers/seed.ts) is the fallback ONLY when the table is
// missing or empty (see loadCatalog). Rows are authoritative: disabled / broken rows are simply not listed (an admin can switch a model off); a D1 error never falls back to the seed.
// Nothing here ever invents a price: price_json is only honoured with a `source`, otherwise the price is unknown (null), never zero.
import { CAPABILITY_KEYS, NO_CAPABILITIES, type Capabilities, type PricePerMTok } from "./types";
import { SEED_MODELS, SEED_VERSION, type SeedKind, type SeedModel } from "./seed";
import type { ConfiguredModel } from "./config";

export interface ModelLimits { rpm?: number; rpd?: number; tpm?: number; tpd?: number }
export interface CatalogRow {
  provider: string; id: string; kind: SeedKind; name: string; caps: Capabilities;
  price: (PricePerMTok & { source: string }) | null;
  context: number | null; maxTokens?: number; maxOutput?: number;
  /** free-tier limits (rpm/rpd/tpm/tpd), informational */
  limits: ModelLimits | null;
  extra: Record<string, unknown> | null;
  enabled: boolean; suggested: boolean; broken: boolean; sort: number; origin: string; verifiedAt: number | null; seedRef: string | null;
}
/** Free-tier limits (estimates, shown as a hint, never used to throttle): requests/min, requests/day, input tokens/min, tokens/day. */
export interface ModelLimits { rpm?: number; rpd?: number; tpm?: number; tpd?: number }
/** provider id -> its rows (sorted). */
export type Catalog = Map<string, CatalogRow[]>;

export const SEED_COLUMNS = ["provider_id", "model_id", "kind", "display_name", "capabilities_json", "price_json", "limits_json", "extra_json", "enabled", "sort", "suggested", "origin", "seed_ref", "user_edited", "broken", "updated_at"] as const;
type SeedValues = Record<(typeof SEED_COLUMNS)[number], string | number | null>;
/** The exact column values the 0029 seed INSERT for `m` carries (also what the equivalence test expects in the table). */
export function seedRowValues(m: SeedModel, sort: number): SeedValues {
  const caps = Object.fromEntries(Object.entries(m.caps).filter(([, v]) => v === true));
  const limits = { ...(m.context != null ? { context: m.context } : {}), ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}), ...(m.maxOutput ? { maxOutput: m.maxOutput } : {}), ...(m.limits ?? {}) };
  return { provider_id: m.provider, model_id: m.id, kind: m.kind, display_name: m.name, capabilities_json: JSON.stringify(caps), price_json: m.price ? JSON.stringify(m.price) : null, limits_json: Object.keys(limits).length ? JSON.stringify(limits) : null,
    extra_json: m.extra ? JSON.stringify(m.extra) : null, enabled: 1, sort, suggested: m.suggested ? 1 : 0, origin: "seed", seed_ref: `${SEED_VERSION}: ${m.ref}`, user_edited: 0, broken: 0, updated_at: 0 };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const limitsOf = (lim: any): ModelLimits | null => { const o: ModelLimits = {}; for (const k of ["rpm", "rpd", "tpm", "tpd"] as const) { const v = num(lim?.[k]); if (v !== null && v > 0) o[k] = v; } return Object.keys(o).length ? o : null; };
const jsonOf = (s: unknown): any => { try { const j = JSON.parse(String(s ?? "null")); return j && typeof j === "object" ? j : null; } catch { return null; } };
export function capsOf(j: unknown): Capabilities {
  const c: Capabilities = { ...NO_CAPABILITIES };
  const o = jsonOf(typeof j === "string" ? j : JSON.stringify(j ?? null));
  if (o) for (const k of CAPABILITY_KEYS) if (typeof o[k] === "boolean") c[k] = o[k];
  return c;
}
/** A price counts only with a non-empty `source` and finite non-negative numbers; null/anything else = unknown (never zero). */
export function priceOf(j: unknown): CatalogRow["price"] {
  const o = jsonOf(j); if (!o || typeof o.source !== "string" || !o.source) return null;
  const input = num(o.input), output = num(o.output); if (input === null || output === null) return null;
  return { input, output, ...(num(o.cacheRead) !== null ? { cacheRead: num(o.cacheRead)! } : {}), ...(num(o.cacheWrite) !== null ? { cacheWrite: num(o.cacheWrite)! } : {}), source: o.source.slice(0, 200) };
}
export function rowFromDb(r: any): CatalogRow | null {
  if (!r || typeof r.provider_id !== "string" || typeof r.model_id !== "string" || !r.model_id || r.model_id.length > 120 || /\s/.test(r.model_id)) return null;
  const kind: SeedKind = r.kind === "image" ? "image" : "chat";
  const lim = jsonOf(r.limits_json);
  const caps = capsOf(r.capabilities_json);
  if (kind === "chat") caps.text = true;
  return { provider: r.provider_id, id: r.model_id, kind, name: typeof r.display_name === "string" && r.display_name ? r.display_name.slice(0, 80) : r.model_id, caps, price: priceOf(r.price_json),
    context: num(lim?.context), limits: limitsOf(lim), ...(num(lim?.maxTokens) ? { maxTokens: num(lim.maxTokens)! } : {}), ...(num(lim?.maxOutput) ? { maxOutput: num(lim.maxOutput)! } : {}),
    extra: jsonOf(r.extra_json), enabled: r.enabled === 1 || r.enabled === true, suggested: r.suggested === 1 || r.suggested === true, broken: r.broken === 1 || r.broken === true,
    sort: num(r.sort) ?? 0, origin: typeof r.origin === "string" ? r.origin : "seed", verifiedAt: num(r.verified_at), seedRef: typeof r.seed_ref === "string" ? r.seed_ref : null };
}
const rowFromSeed = (m: SeedModel, i: number): CatalogRow => rowFromDb(seedRowValues(m, i))!;
const group = (rows: CatalogRow[]): Catalog => {
  const c: Catalog = new Map();
  for (const r of rows) (c.get(r.provider) ?? c.set(r.provider, []).get(r.provider)!).push(r);
  for (const l of c.values()) l.sort((a, b) => a.sort - b.sort);
  return c;
};
/** The in-memory fallback catalog (the seed rows). */
export const seedCatalog = (): Catalog => group(SEED_MODELS.map(rowFromSeed));
/** Last good catalog per DB handle (per isolate): what a transient D1 error serves instead of the seed, so an admin-disabled model is never re-enabled by an outage. */
const lastGood = new WeakMap<object, Catalog>();
const noTable = (e: unknown) => /no such table/i.test(String((e as { message?: unknown } | null)?.message ?? e));
/** Read the catalog. Never throws. Seed fallback ONLY when it cannot contradict an admin: no DB binding, the table missing (migration 0029 not applied), or the table present but
 *  EMPTY (never seeded/written). A table WITH rows is authoritative for every provider, including one whose rows were all deleted (= nothing listed). Any other D1 error serves the
 *  last good catalog of this isolate, else FAILS CLOSED (empty: built-in models stay hidden until D1 recovers) - the app keeps running, a disabled model never comes back. */
export async function loadCatalog(db: D1Database | undefined): Promise<Catalog> {
  const seed = seedCatalog();
  if (!db) return seed;
  try {
    const res = await db.prepare(`SELECT provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, broken, verified_at FROM provider_models ORDER BY provider_id, sort, model_id LIMIT 2000`).all<any>();
    const rows = (res.results ?? []).map(rowFromDb).filter((r): r is CatalogRow => !!r);
    if ((res.results ?? []).length === 0) return seed; // table exists, never written
    const out = group(rows);
    lastGood.set(db, out);
    return out;
  } catch (e) { return noTable(e) ? seed : lastGood.get(db) ?? new Map(); }
}
const listed = (r: CatalogRow) => r.enabled && !r.broken;
export const chatRows = (c: Catalog, provider: string) => (c.get(provider) ?? []).filter((r) => r.kind === "chat" && listed(r));
export const imageRows = (c: Catalog, provider: string) => (c.get(provider) ?? []).filter((r) => r.kind === "image" && listed(r));
export const toConfigured = (r: CatalogRow): ConfiguredModel => ({ id: r.id, kind: r.kind, displayName: r.name, capabilities: r.caps, pricePerMTok: r.price ? { input: r.price.input, output: r.price.output, ...(r.price.cacheRead !== undefined ? { cacheRead: r.price.cacheRead } : {}), ...(r.price.cacheWrite !== undefined ? { cacheWrite: r.price.cacheWrite } : {}) } : null,
  contextWindow: r.context, ...(r.limits ? { limits: r.limits } : {}), ...(r.extra ? { extra: r.extra } : {}), ...(r.maxTokens ? { maxTokens: r.maxTokens } : {}), ...(r.maxOutput ? { maxOutput: r.maxOutput } : {}) });
/** Verified (declared-true in the catalog) lookups for the "raise a stored row" rule. */
export const catalogCap = (c: Catalog, provider: string, model: string, cap: keyof Capabilities) => (c.get(provider) ?? []).some((r) => r.id === model && r.caps[cap]);
