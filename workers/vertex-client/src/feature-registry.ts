// feat2: ONE registry of product features + ONE effective-set resolver (docs/reports/feat1.md §2). NO behaviour change in this step:
// every feature carries a `legacy` resolver that returns TODAY's answer from the existing gates (scope.ts kindCaps, caps.ts rows, features.ts rows,
// open-space.ts, run-js/semantic flags, binding presence). With no `unlock:<class>:<id>` rows the effective set therefore equals today's answers
// (pinned by test/feature-registry.test.ts). Rule: on = bindings present AND (legacy answer [= owner base / default unlocked / today's flags, narrowing
// rows already applied] OR unlock row "1") AND NOT narrowed ("0" row beats an unlock). Unlock rows are READ here; no writer exists yet (feat1 step 4).
// Nothing enforces this yet: /api/me exposes it, routes still use their own gates.
import { capClassOf, capsOf, type CapClass, type CapsCache, type Identity } from "./caps";
import { openAllowed } from "./open-space";
import { MAIN_SCOPE, baseOf, isE2eBase, isE2eBiz, isGuestScope, isMainBase, kindCapsOf, mayUseSemantic, quotaKey, spaceOf, spaceUsesGateway, type BaseScope, type Scope } from "./scope";

/** Binding / secret names a feature needs (a subset of Env keys; kept as strings so this file stays pure and cycle-free). */
export type Need = "DB" | "CHAT" | "GATEWAY" | "GATEWAY_KEY" | "KEY_ENC_SECRET" | "AI" | "BROWSER" | "FILES" | "LOADER" | "VECTORIZE" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "AGENT" | "AGENT_INTERNAL_SECRET" | "REMOTE" | "CONNECTOR" | "CONNECTOR_TOKEN" | "DEVICES";
export type Reason = "ok" | "locked" | "no-binding" | "narrowed";
export type FeatureState = { on: boolean; reason: Reason };

export interface Ctx {
  env: Partial<Record<Need, unknown>> & { OPEN_SPACE?: string };
  db: D1Database | undefined;
  scope: Scope;
  /** The BASE of `scope` (who), computed once by the resolver. */
  base: BaseScope;
  identity: Identity;
  cache: CapsCache;
  /** Settings row read, memoised per request; a read error or missing DB = null (fail closed: an unreadable row never unlocks anything). */
  row(name: string): Promise<string | null>;
  caps(): Promise<Awaited<ReturnType<typeof capsOf>>>;
}
/** Today's answer from the existing gates. `narrowed` = it is false BECAUSE an explicit narrowing row said "0" (an unlock row must not override it). */
export interface Legacy { on: boolean; narrowed?: boolean }
export interface FeatureDef {
  id: string;
  /** Registry default for a non-owner class: "unlocked" = on without any row (when its bindings exist); "locked" = needs an unlock row. Informational: `legacy` is authoritative today. */
  default: "locked" | "unlocked";
  needs: readonly Need[];
  /** Classes an `unlock:<class>:<id>` row may ever apply to (m = main + e2e, g = team guest, o = org base). */
  scopeClasses: readonly CapClass[];
  /** Narrowing rows (exact "0" turns the feature off for this base/class and beats any unlock row), independent of whether legacy already says off. */
  narrow?: (base: string, cls: CapClass | null) => string[];
  legacy: (c: Ctx) => Promise<Legacy>;
}

const ALL: readonly CapClass[] = ["m", "g", "o"];
const yes = async (): Promise<Legacy> => ({ on: true });
const fromCap = (pick: (c: Awaited<ReturnType<Ctx["caps"]>>) => boolean) => async (c: Ctx): Promise<Legacy> => ({ on: pick(await c.caps()) });
const capRow = (name: string) => (_b: string, cls: CapClass | null) => (cls ? [`cap:${cls}:${name}`] : []);

export const FEATURES: readonly FeatureDef[] = [
  { id: "chat", default: "unlocked", needs: ["DB", "CHAT"], scopeClasses: ALL, legacy: yes },
  // Vertex gateway: Business only; main/e2e use the gateway key, a team guest goes through the team act-as provider (its own config, NOT expressible here: see report).
  { id: "vertex-models", default: "unlocked", needs: ["GATEWAY"], scopeClasses: ALL, legacy: async (c) => ({ on: spaceUsesGateway(c.scope) && (isGuestScope(c.base) || !!c.env.GATEWAY_KEY) }) },
  // Open space: openAllowed (OPEN_SPACE var, main/e2e/guest rules, `open_space:<base>`="0" kill switch, D1 error = off for guests). KEY_ENC_SECRET is NOT required today.
  { id: "open-space", default: "unlocked", needs: ["DB"], scopeClasses: ALL, narrow: (b) => [`open_space:${b}`], legacy: async (c) => {
      const on = await openAllowed({ DB: c.db, OPEN_SPACE: c.env.OPEN_SPACE }, c.base);
      const killed = c.env.OPEN_SPACE === "off" || (!isMainBase(c.scope) && !isE2eBase(c.base) && (await c.row(`open_space:${c.base}`)) === "0");
      return { on, narrowed: !on && killed };
    } },
  // Workers AI / Browser Rendering on the operator's shared account (features.ts featureOn): e2e never; row `feat:<base>:workers-ai`="0" off; main fails OPEN on a D1 error.
  { id: "workers-ai", default: "unlocked", needs: ["AI", "BROWSER"], scopeClasses: ALL, narrow: (b) => [`feat:${b}:workers-ai`], legacy: async (c) => {
      if (isE2eBase(c.base)) return { on: false };
      if (!c.db) return { on: c.base === MAIN_SCOPE };
      try { const v = (await c.db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`feat:${c.base}:workers-ai`).first<{ value: string }>())?.value ?? null; return v === "0" ? { on: false, narrowed: true } : { on: true }; }
      catch { return { on: c.base === MAIN_SCOPE }; }
    } },
  { id: "files", default: "unlocked", needs: ["FILES"], scopeClasses: ALL, legacy: yes },
  // run_js: binding AND settings row `run_js:<base>`="1" (default OFF, per loadRunJs) — the catalogue said "on if bound"; code says flag-gated.
  { id: "run-js", default: "locked", needs: ["LOADER"], scopeClasses: ALL, legacy: async (c) => ({ on: (await c.row(`run_js:${c.base}`)) === "1" }) },
  // semantic search: bindings + OPEN space + not e2e (mayUseSemantic) + `semantic_ready:<base>`="1" (the table check of semEnabled is NOT mirrored: it needs sqlite_master, see report).
  { id: "semantic-search", default: "locked", needs: ["VECTORIZE", "AI"], scopeClasses: ALL, legacy: async (c) => ({ on: mayUseSemantic(c.scope) && (await c.row(`semantic_ready:${quotaKey(c.scope)}`)) === "1" }) },
  { id: "transcribe", default: "unlocked", needs: ["AI"], scopeClasses: ALL, legacy: yes },
  // push: closed to the e2e Business scope only (index.ts /api/push/*).
  { id: "push", default: "unlocked", needs: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"], scopeClasses: ALL, legacy: async (c) => ({ on: !isE2eBiz(c.scope) }) },
  { id: "personal-features", default: "locked", needs: ["DB"], scopeClasses: ALL, narrow: capRow("personalFeatures"), legacy: fromCap((k) => k.personalFeatures) },
  { id: "erich-only-modes", default: "locked", needs: ["AGENT", "AGENT_INTERNAL_SECRET"], scopeClasses: ALL, narrow: capRow("erichOnlyModes"), legacy: fromCap((k) => k.erichOnlyModes) },
  // Remote / Fleet: guarded by the erichOnly middleware = the same answer as erich-only-modes.
  { id: "remote", default: "locked", needs: ["REMOTE"], scopeClasses: ALL, narrow: capRow("erichOnlyModes"), legacy: fromCap((k) => k.erichOnlyModes) },
  // Built-in connectors: tool host is the raw connector for the main base only (toolHostFor), e2e gets a guarded subset (counted as on).
  { id: "connectors", default: "locked", needs: ["CONNECTOR", "CONNECTOR_TOKEN"], scopeClasses: ["m"], legacy: async (c) => ({ on: isMainBase(c.scope) || isE2eBiz(c.scope) }) },
  { id: "devices", default: "locked", needs: ["DEVICES"], scopeClasses: ALL, narrow: capRow("devices"), legacy: fromCap((k) => k.devices) },
  { id: "devices-shared", default: "locked", needs: ["DEVICES"], scopeClasses: ALL, narrow: capRow("sharedDevices"), legacy: async (c) => ({ on: (await c.caps()).sharedDevices }) },
  { id: "devices-env", default: "locked", needs: ["DEVICES"], scopeClasses: ALL, legacy: async (c) => ({ on: (await c.caps()).devices && (await c.row(`vcl_env:${c.base}`)) === "1" }) },
  { id: "usage", default: "unlocked", needs: ["DB"], scopeClasses: ALL, legacy: yes },
  { id: "scheduler", default: "unlocked", needs: ["DB"], scopeClasses: ALL, legacy: yes },
  { id: "spaces", default: "unlocked", needs: ["DB"], scopeClasses: ALL, legacy: yes },
];

/** Effective feature set for one scope + identity. `db` undefined or any D1 error never widens (rows read as absent). */
export async function featuresEffective(env: Ctx["env"], db: D1Database | undefined, scope: Scope, identity: Identity = {}): Promise<Record<string, FeatureState>> {
  const cache: CapsCache = new Map();
  const memo = new Map<string, Promise<string | null>>();
  const row = (name: string) => {
    let p = memo.get(name);
    if (!p) {
      p = (async () => {
        if (!db) return null;
        try { return (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(name).first<{ value: string }>())?.value ?? null; } catch { return null; }
      })();
      memo.set(name, p);
    }
    return p;
  };
  let capsP: ReturnType<Ctx["caps"]> | undefined;
  const base = baseOf(scope);
  const ctx: Ctx = { env, db, scope, base, identity, cache, row, caps: () => (capsP ??= capsOf(db, scope, identity, cache)) };
  const cls = capClassOf(base);
  const out: Record<string, FeatureState> = {};
  for (const f of FEATURES) {
    if (!f.needs.every((k) => !!env[k])) { out[f.id] = { on: false, reason: "no-binding" }; continue; }
    const l = await f.legacy(ctx);
    if (l.on) { out[f.id] = { on: true, reason: "ok" }; continue; }
    const narrowRows = f.narrow?.(base, cls) ?? [];
    let narrowed = !!l.narrowed;
    for (const n of narrowRows) if (!narrowed && (await row(n)) === "0") narrowed = true;
    if (narrowed) { out[f.id] = { on: false, reason: "narrowed" }; continue; }
    // unlock rows: only for a well-formed class the feature allows, never for an e2e tenant (it must never gain capabilities from a shared class row)
    const unlocked = cls !== null && !isE2eBase(base) && f.scopeClasses.includes(cls) && (await row(`unlock:${cls}:${f.id}`)) === "1";
    out[f.id] = unlocked ? { on: true, reason: "ok" } : { on: false, reason: "locked" };
  }
  return out;
}

/** The additive `/api/me.features` shape: id -> boolean, no reasons. */
export const featureFlags = (s: Record<string, FeatureState>): Record<string, boolean> => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.on]));
