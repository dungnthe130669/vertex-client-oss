// Email-first dev login. On only when the Worker secret DEV_LOGIN_SECRET exists AND the edition's settings row (`dev_login_emails:main`, or
// `dev_login_emails:team` when TEAM_GATEWAY_URL is set) is non-empty. TEAM: an entry is just an email; it signs in as the REAL team user already
// recorded in team_users by an earlier gateway login (same uid, via:"team", 7 d); no row / not active = refused, nothing is created, and the per-request
// gateway entitlement check (index.ts) still applies unchanged. MAIN: the row is comma-separated, case-insensitive; an entry is `email` or `email=githublogin` (the login whose normal main
// session it becomes; default = the first ALLOWED_GITHUB_LOGINS entry, there is no email->user table). Listed email + password = the same session a normal login mints.
import { TEAM_SESSION_TTL_S, allowedLogins, makeSession, safeEq, type AuthEnv } from "./auth";
import { teamConfigured } from "./providers/team-gateway";

export interface DevEnv { DEV_LOGIN_SECRET?: string; TEAM_GATEWAY_URL?: string; DB?: D1Database }
type E = AuthEnv & DevEnv;

const enc = new TextEncoder();
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
const j = (o: unknown, status: number, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

/** email (lowercase) -> main login ("" on team), or null when the feature is off. Any error = off. */
async function entries(env: E): Promise<Map<string, string> | null> {
  try {
    if (!env.DEV_LOGIN_SECRET || !env.DB) return null;
    const team = !!env.TEAM_GATEWAY_URL;
    if (team && (!teamConfigured(env as never) || !env.SESSION_SECRET)) return null;
    const r = await env.DB.prepare(`SELECT value FROM settings WHERE name=?`).bind(team ? "dev_login_emails:team" : "dev_login_emails:main").first<{ value: string }>();
    const fallback = allowedLogins(env)[0];
    const m = new Map<string, string>();
    for (const part of (r?.value ?? "").split(",")) {
      const [e, l] = part.split("=").map((x) => x.trim());
      if (team) { if (e) m.set(e.toLowerCase(), ""); continue; }
      const login = (l || fallback || "").toLowerCase();
      if (e && login && allowedLogins(env).includes(login)) m.set(e.toLowerCase(), login);
    }
    return m.size ? m : null;
  } catch { return null; }
}

export const devLoginEnabled = async (env: E) => (await entries(env)) !== null;

const body = async (req: Request) => (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

export async function devLoginCheck(req: Request, env: E): Promise<Response> {
  const m = await entries(env);
  if (!m) return j({ error: "not found" }, 404);
  return j({ password: m.has(norm((await body(req)).email)) }, 200);
}

export async function devLogin(req: Request, env: E): Promise<Response> {
  const m = await entries(env);
  if (!m) return j({ error: "not found" }, 404);
  const b = await body(req);
  const login = m.get(norm(b.email));
  const pw = typeof b.password === "string" ? b.password : "";
  const ok = safeEq(await sha(pw), await sha(env.DEV_LOGIN_SECRET!)); // always compared
  if (login === undefined || (!login && !env.TEAM_GATEWAY_URL) || !ok) return j({ error: "unauthorized" }, 401);
  if (env.TEAM_GATEWAY_URL) {
    const email = norm(b.email);
    const row = await env.DB!.prepare(`SELECT uid, status FROM team_users WHERE email=? ORDER BY last_login_at DESC LIMIT 1`).bind(email).first<{ uid: string; status: string }>().catch(() => null);
    if (!row || row.status !== "active") return j({ error: "unauthorized" }, 401);
    const { cookie } = await makeSession(env, email, "team", TEAM_SESSION_TTL_S, row.uid);
    return j({ ok: true }, 200, { "set-cookie": cookie });
  }
  const { cookie } = await makeSession(env, login, "github");
  return j({ ok: true }, 200, { "set-cookie": cookie });
}
