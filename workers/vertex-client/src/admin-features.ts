// feat3 (docs/reports/feat1.md §4 step 4): owner-only admin API for feature unlock + audit.
//   GET  /api/admin/features  -> effective matrix feature x class (m/g/o) + last 20 audit lines (actor opaque, no emails).
//   POST /api/admin/features  {class, feature, unlocked} -> writes ONLY the `unlock:<class>:<id>` row ("1" = unlocked, row deleted = locked) and ONE
//                                feature_audit row in the SAME D1 batch. Never touches narrowing rows. Nothing else in the code base writes unlock rows.
// NOTE: no route consults the resolver for enforcement yet (feat1 step 5), so an unlock row has NO effect on what any user can do today.
// Owner = a session that readSession already re-validated against the env on this request AND that is re-checked here:
//   team: via "team" && own === true && email still in OWNER_EMAILS;  personal edition: via "github" && login still in ALLOWED_GITHUB_LOGINS.
// e2e, every team guest and anything else => 403. CSRF + same-origin come from the shared /api/* gate (authenticate) like every other POST.
import type { Hono } from "hono";
import { allowedLogins, isOwnerEmail, type Session } from "./auth";
import { FEATURES, featuresEffective, type FeatureDef } from "./feature-registry";
import { MAIN_SCOPE, type Scope } from "./scope";

export const ADMIN_WRITES_PER_MIN = 30;
const CLASSES = ["m", "g", "o"] as const;
type Cls = (typeof CLASSES)[number];
/** Representative Business-space scope per class for the read-only matrix (a team guest / org base shape; not real users). */
const REP: Record<Cls, string> = { m: MAIN_SCOPE, g: "g:000000000000000000000000", o: "o:matrix" };
const noStore = { "cache-control": "no-store" };

type AdminEnv = { DB?: D1Database; OWNER_EMAILS?: string; ALLOWED_GITHUB_LOGINS?: string; SESSION_SECRET?: string } & Record<string, unknown>;

/** True only for a real owner session (re-checked against the env on this request). */
export function isOwnerSession(env: AdminEnv, s: Session | undefined): boolean {
  if (!s) return false;
  if (s.via === "team") return s.own === true && isOwnerEmail(env, s.u);
  if (s.via === "github") return allowedLogins(env as never).includes(s.u.toLowerCase());
  return false; // e2e and anything unknown
}

/** Opaque, stable actor id: HMAC(SESSION_SECRET, via:user) truncated. Never an email or login; not reversible without the secret. */
export async function actorId(env: AdminEnv, s: Session): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.SESSION_SECRET ?? "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`feature-audit:${s.via}:${s.u.toLowerCase()}`)));
  return "a_" + [...mac.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const hasBindings = (env: AdminEnv, f: FeatureDef) => f.needs.every((k) => !!env[k]);
const unlockRow = (cls: string, id: string) => `unlock:${cls}:${id}`;

export function adminFeatureRoutes<A extends { Bindings: any; Variables: { session: Session } }>(app: Hono<A>): void {
  const owner = async (c: any): Promise<Response | null> => (isOwnerSession(c.env as AdminEnv, c.get("session")) ? null : c.json({ error: "forbidden" }, 403, noStore));

  app.get("/api/admin/features", async (c) => {
    const denied = await owner(c); if (denied) return denied;
    const env = c.env as AdminEnv, db = env.DB;
    const matrix: Record<string, Record<string, unknown>> = {};
    for (const cls of CLASSES) {
      const eff = await featuresEffective(env as never, db, REP[cls] as Scope, {});
      for (const f of FEATURES) {
        const applicable = f.scopeClasses.includes(cls);
        let unlock: "1" | null = null;
        if (db && applicable) { try { unlock = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(unlockRow(cls, f.id)).first<{ value: string }>())?.value === "1" ? "1" : null; } catch { unlock = null; } }
        (matrix[f.id] ??= {})[cls] = { applicable, on: eff[f.id]!.on, reason: eff[f.id]!.reason, binding: hasBindings(env, f) ? "present" : "missing", unlock };
      }
    }
    let audit: unknown[] = [];
    if (db) { try { audit = (await db.prepare(`SELECT id, ts, actor, class, feature, old, new FROM feature_audit ORDER BY id DESC LIMIT 20`).all()).results ?? []; } catch { audit = []; } }
    return c.json({ classes: CLASSES, features: FEATURES.map((f) => ({ id: f.id, needs: f.needs, classes: f.scopeClasses })), matrix, audit, enforced: false }, 200, noStore);
  });

  app.post("/api/admin/features", async (c) => {
    const denied = await owner(c); if (denied) return denied;
    const env = c.env as AdminEnv, s = c.get("session");
    let b: unknown;
    try { b = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400, noStore); }
    if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ error: "invalid body" }, 400, noStore);
    const o = b as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== "class" && k !== "feature" && k !== "unlocked")) return c.json({ error: "unknown field" }, 400, noStore);
    if (typeof o.class !== "string" || !(CLASSES as readonly string[]).includes(o.class)) return c.json({ error: "invalid class" }, 400, noStore);
    const f = typeof o.feature === "string" ? FEATURES.find((x) => x.id === o.feature) : undefined;
    if (!f) return c.json({ error: "unknown feature" }, 400, noStore);
    if (typeof o.unlocked !== "boolean") return c.json({ error: "unlocked must be boolean" }, 400, noStore);
    const cls = o.class as Cls;
    if (!f.scopeClasses.includes(cls)) return c.json({ error: "feature not applicable to this class" }, 400, noStore);
    const db = env.DB;
    if (!db) return c.json({ error: "database unavailable" }, 503, noStore);
    if (o.unlocked && !hasBindings(env, f)) return c.json({ error: "required binding is absent" }, 409, noStore);
    const actor = await actorId(env, s);
    const name = unlockRow(cls, f.id);
    try {
      const recent = await db.prepare(`SELECT COUNT(*) AS n FROM feature_audit WHERE actor=? AND ts>?`).bind(actor, Date.now() - 60_000).first<{ n: number }>();
      if ((recent?.n ?? 0) >= ADMIN_WRITES_PER_MIN) return c.json({ error: "rate limited" }, 429, { ...noStore, "retry-after": "60" });
      const old = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(name).first<{ value: string }>())?.value ?? null;
      const next = o.unlocked ? "1" : null;
      if (old === next) return c.json({ ok: true, changed: false, enforced: false }, 200, noStore);
      const write = o.unlocked
        ? db.prepare(`INSERT INTO settings (name, value) VALUES (?, '1') ON CONFLICT(name) DO UPDATE SET value='1'`).bind(name)
        : db.prepare(`DELETE FROM settings WHERE name=?`).bind(name);
      await db.batch([write, db.prepare(`INSERT INTO feature_audit (ts, actor, class, feature, old, new) VALUES (?,?,?,?,?,?)`).bind(Date.now(), actor, cls, f.id, old, next)]);
    } catch { return c.json({ error: "write failed" }, 500, noStore); }
    return c.json({ ok: true, changed: true, enforced: false }, 200, noStore);
  });
}
