// Per-base feature flags, DEFAULT ON for team users (Erich 2026-10-26): a feature is allowed unless the D1 `settings` row `feat:<base>:<feature>` is exactly "0"
// (an admin turns ONE feature off for ONE named base; setFeature writes it). No row = on. Any other value than "0" = on. An unknown feature name is ignored.
// A D1 read error or a missing DB gives the EMPTY set: the caller then refuses the OPERATOR's shared account for that base (fail closed) while a user's OWN linked
// account keeps working (it never depends on this flag). main is default-on like any base but fails OPEN on a D1 error (the operator's own scope; its own edition decides elsewhere); e2e never (must not spend real quota).
//   workers-ai  Workers AI / Browser Rendering on the OPERATOR's shared Cloudflare account in the Open space (chat/image models, web_read/web_links/web_screenshot).
//               Linking the user's own account (Settings > Cloudflare) works regardless of this flag. Open-space access itself is the separate open_space:<base> flag.
import { MAIN_SCOPE, isE2eBase, type BaseScope } from "./scope";

export const FEATURES = ["workers-ai"] as const;
export type Feature = (typeof FEATURES)[number];
export const featureName = (base: BaseScope, f: Feature) => `feat:${base}:${f}`;

/** The features allowed for this base: all of them minus those explicitly set to "0". Errors and a missing DB give the empty set (fail closed for the shared account). */
export async function featuresOf(db: D1Database | undefined, base: BaseScope): Promise<ReadonlySet<Feature>> {
  if (isE2eBase(base)) return new Set();
  // main is the operator's own scope: default on, an explicit '0' row disables the shared account for main too, and a missing DB or a D1 read error means ON (fail OPEN for main only).
  const failed = () => (base === MAIN_SCOPE ? new Set(FEATURES) : new Set<Feature>());
  if (!db) return failed();
  try {
    const r = await db.prepare(`SELECT name FROM settings WHERE name LIKE ? AND value='0'`).bind(`feat:${base}:%`).all<{ name: string }>();
    const off = new Set((r.results ?? []).map((x) => x.name));
    return new Set(FEATURES.filter((f) => !off.has(featureName(base, f))));
  } catch { return failed(); }
}
export const featureOn = async (db: D1Database | undefined, base: BaseScope, f: Feature) => (await featuresOf(db, base)).has(f);

/** Operator write (SQL in docs/reports/cf-features-audit.md does the same thing). */
export async function setFeature(db: D1Database, base: BaseScope, f: Feature, on: boolean): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(featureName(base, f), on ? "1" : "0").run();
}
