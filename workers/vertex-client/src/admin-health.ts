// feat4 (docs/reports/feat1.md §3): owner-only, read-only setup/health API for bring-your-own-Cloudflare deployments.
//   GET /api/admin/health          -> per registry feature: binding presence + "what to add to wrangler" per missing binding. NO probe runs.
//   GET /api/admin/health?probe=1  -> additionally D1 `SELECT 1`, R2 `head` of a probe key, Vectorize `describe`, DO namespace no-op, and the
//                                     missing-migration check. The AI probe is NEVER run (costs money): reported as "skipped (manual)".
// Output is booleans + short fixed reasons: never a value, id, secret, error text or account detail. Probe results are cached 60 s per isolate
// (keyed on the env object). Same owner check as /api/admin/features (isOwnerSession); e2e, team guests and anything else get 403, no session 401.
import type { Hono } from "hono";
import type { Session } from "./auth";
import { isOwnerSession } from "./admin-features";
import { FEATURES, type Need } from "./feature-registry";

/** Highest migration file shipped in `migrations/` (pinned by test/admin-health.test.ts against the directory, so it cannot go stale silently). */
export const LATEST_MIGRATION = "0045_feature_audit";
export const HEALTH_PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_KEY = "__health-probe__";
const noStore = { "cache-control": "no-store" };

type HealthEnv = Partial<Record<Need, unknown>> & { DB?: D1Database; FILES?: R2Bucket; VECTORIZE?: unknown; CHAT?: DurableObjectNamespace; OWNER_EMAILS?: string; ALLOWED_GITHUB_LOGINS?: string; SESSION_SECRET?: string } & Record<string, unknown>;

/** Secrets are set with `wrangler secret put`; everything else is a wrangler.jsonc block. Text only, no real ids. */
const SECRETS: ReadonlySet<Need> = new Set<Need>(["GATEWAY_KEY", "KEY_ENC_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "AGENT_INTERNAL_SECRET", "CONNECTOR_TOKEN"]);
const WRANGLER_HINT: Record<Need, string> = {
  DB: `"d1_databases": [{ "binding": "DB", "database_name": "<name>", "database_id": "<your-d1-id>", "migrations_dir": "migrations" }]`,
  CHAT: `"durable_objects": { "bindings": [{ "name": "CHAT", "class_name": "ChatSession" }] } + migrations tag v1 (new_sqlite_classes ChatSession)`,
  DEVICES: `"durable_objects" binding { "name": "DEVICES", "class_name": "DeviceHub" } + migrations tag v2 (new_sqlite_classes DeviceHub)`,
  FILES: `"r2_buckets": [{ "binding": "FILES", "bucket_name": "<your-bucket>" }]`,
  AI: `"ai": { "binding": "AI" }`,
  BROWSER: `"browser": { "binding": "BROWSER" }`,
  LOADER: `"worker_loaders": [{ "binding": "LOADER" }]`,
  VECTORIZE: `"vectorize": [{ "binding": "VECTORIZE", "index_name": "<your-index>" }] (npx wrangler vectorize create <your-index> ...)`,
  GATEWAY: `service binding to a Vertex gateway Worker; not available in a bring-your-own-Cloudflare deployment`,
  AGENT: `service binding to a Cloud agent Worker; not available in a bring-your-own-Cloudflare deployment`,
  REMOTE: `service binding to a Remote hub Worker; not available in a bring-your-own-Cloudflare deployment`,
  CONNECTOR: `service binding to a connector Worker; not available in a bring-your-own-Cloudflare deployment`,
  GATEWAY_KEY: "", KEY_ENC_SECRET: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", AGENT_INTERNAL_SECRET: "", CONNECTOR_TOKEN: "",
};
const addText = (n: Need): string => (SECRETS.has(n) ? `set the secret: npx wrangler secret put ${n}` : `add to wrangler config: ${WRANGLER_HINT[n]}`);

export type ProbeState = "ok" | "failed" | "timeout" | "no-binding" | "skipped (manual)";
export type Probes = { d1: ProbeState; r2: ProbeState; vectorize: ProbeState; durableObject: ProbeState; ai: ProbeState; migrations: { state: "up-to-date" | "behind" | "unknown"; latest: string } };

const withTimeout = <T,>(p: Promise<T>): Promise<T | "timeout"> => new Promise((res, rej) => { const t = setTimeout(() => res("timeout"), PROBE_TIMEOUT_MS); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
async function run(fn: () => Promise<unknown>): Promise<ProbeState> { try { return (await withTimeout(fn())) === "timeout" ? "timeout" : "ok"; } catch { return "failed"; } }

/** On-demand probes. Never touches AI. Nothing here writes. */
export async function runProbes(env: HealthEnv): Promise<Probes> {
  const d1 = env.DB ? await run(() => env.DB!.prepare("SELECT 1 AS ok").first()) : "no-binding";
  const r2 = env.FILES ? await run(() => env.FILES!.head(PROBE_KEY)) : "no-binding";
  const vec = env.VECTORIZE as { describe?: () => Promise<unknown> } | undefined;
  const vectorize: ProbeState = vec ? (typeof vec.describe === "function" ? await run(() => vec.describe!()) : "failed") : "no-binding";
  // DO no-op: resolving an id + stub from the namespace creates and wakes nothing (no fetch is sent).
  const durableObject: ProbeState = env.CHAT ? await run(async () => { env.CHAT!.get(env.CHAT!.idFromName(PROBE_KEY)); }) : "no-binding";
  let migrations: Probes["migrations"] = { state: "unknown", latest: LATEST_MIGRATION };
  if (d1 === "ok") {
    try {
      const r = await withTimeout(env.DB!.prepare("SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1").first<{ name: string }>());
      if (r !== "timeout" && r?.name) migrations = { state: r.name.replace(/\.sql$/, "") >= LATEST_MIGRATION ? "up-to-date" : "behind", latest: LATEST_MIGRATION };
    } catch { /* table absent (e.g. migrations applied by hand) => unknown */ }
  }
  return { d1, r2, vectorize, durableObject, ai: env.AI ? "skipped (manual)" : "no-binding", migrations };
}

const cache = new WeakMap<object, { at: number; probes: Probes }>();
export async function probesCached(env: HealthEnv): Promise<{ probes: Probes; cached: boolean }> {
  const hit = cache.get(env);
  if (hit && Date.now() - hit.at < HEALTH_PROBE_TTL_MS) return { probes: hit.probes, cached: true };
  const probes = await runProbes(env);
  cache.set(env, { at: Date.now(), probes });
  return { probes, cached: false };
}

export function healthReport(env: HealthEnv) {
  const bindings = new Set<Need>();
  const features = FEATURES.map((f) => {
    const missing = f.needs.filter((n) => !env[n]);
    for (const n of f.needs) bindings.add(n);
    return { id: f.id, ready: missing.length === 0, reason: missing.length ? `needs binding ${missing.join(", ")}` : "ok", missing: missing.map((n) => ({ name: n, kind: SECRETS.has(n) ? "secret" : "binding", add: addText(n) })) };
  });
  return { features, bindings: Object.fromEntries([...bindings].sort().map((n) => [n, !!env[n]])) };
}

export function adminHealthRoutes<A extends { Bindings: any; Variables: { session: Session } }>(app: Hono<A>): void {
  app.get("/api/admin/health", async (c) => {
    const env = c.env as HealthEnv;
    if (!isOwnerSession(env as never, c.get("session"))) return c.json({ error: "forbidden" }, 403, noStore);
    const base = healthReport(env);
    if (c.req.query("probe") !== "1") return c.json({ ...base, probes: null, probeHint: "add ?probe=1 to run the read-only probes (AI is never probed)" }, 200, noStore);
    const { probes, cached } = await probesCached(env);
    return c.json({ ...base, probes, cached }, 200, noStore);
  });
}
