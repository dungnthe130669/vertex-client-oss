// Operator auth: shared SSO cookie (auth.internal.invalid) or GitHub OAuth (fallback), both allowlisted, exchanged for an
// HMAC-signed __Host- session cookie; CSRF via per-session token header + same-origin check on every state-changing request.
import { readSso, ssoLoginUrl, type SsoEnv } from "cf-lite/modules/sso";
import { e2eSlotOfUser } from "./scope";

export interface AuthEnv extends SsoEnv {
  SESSION_SECRET: string;
  ALLOWED_GITHUB_LOGINS: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Presence enables the E2E login bypass (auth-e2e.ts); its removal revokes every live e2e session. */
  E2E_TOKEN?: string;
  /** Team instance only: presence of TEAM_GATEWAY_URL enables the team login (src/team-auth.ts); its removal revokes every live team session. */
  TEAM_GATEWAY_URL?: string;
  /** Team instance only, opt-in owner mapping (conv4): comma list of exact lower-case emails. Unset/empty/garbled = off (byte-identical to before). */
  OWNER_EMAILS?: string;
  /** Email-first dev login (src/auth-dev.ts): the shared password; absent = feature off. */
  DEV_LOGIN_SECRET?: string;
  DB?: D1Database;
}

export const SESSION_COOKIE = "__Host-vc_session";
export const STATE_COOKIE = "__Host-vc_oauth_state";
export const SESSION_TTL_S = 30 * 24 * 3600;
const REFRESH_AFTER_S = 24 * 3600; // sliding: re-issue once the cookie is a day old

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export const randHex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function safeEq(a: string, b: string): boolean {
  const ea = enc.encode(a), eb = enc.encode(b);
  if (ea.length !== eb.length) return false;
  let d = 0;
  for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
  return d === 0;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** `lat` = login time (unix s), set once at makeSession and carried through cookie refreshes (iat slides daily, lat does not): the device terminal needs a fresh login. A cookie minted before this field has none = not fresh.
 *  `uid` is set only for via:"team" (vclient's own scope id, never the gateway's raw id). */
export type Session = { u: string; csrf: string; iat: number; exp: number; via: "github" | "e2e" | "team"; uid?: string; lat?: number; own?: true };
/** conv4: owner emails, strict. Each entry must be a well-formed lower-case-able email; malformed entries are dropped (never partially trusted); none left = feature off. */
const OWNER_EMAIL = /^[^\s@,<>"';]{1,64}@[^\s@,<>"';]{1,255}$/;
export const ownerEmails = (env: { OWNER_EMAILS?: string }): string[] => (typeof env.OWNER_EMAILS === "string" ? env.OWNER_EMAILS : "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => OWNER_EMAIL.test(x));
export const isOwnerEmail = (env: { OWNER_EMAILS?: string }, email: unknown): boolean => typeof email === "string" && email !== "" && email === email.toLowerCase() && ownerEmails(env).includes(email);
export const TEAM_SESSION_TTL_S = 7 * 24 * 3600;

export async function signSession(env: AuthEnv, s: Session): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(s)));
  return `${body}.${await hmac(env.SESSION_SECRET, body)}`;
}

export function sessionCookie(value: string, maxAge = SESSION_TTL_S): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
export const clearSessionCookie = () => sessionCookie("", 0);
// OAuth state must survive the cross-site redirect back from github.com, hence Lax.
export const stateCookie = (v: string, maxAge = 600) => `${STATE_COOKIE}=${v}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export async function makeSession(env: AuthEnv, user: string, via: Session["via"], ttl = SESSION_TTL_S, uid?: string, own?: boolean): Promise<{ cookie: string; session: Session }> {
  const now = Math.floor(Date.now() / 1000);
  const session: Session = { u: user, csrf: randHex(16), iat: now, lat: now, exp: now + ttl, via, ...(uid ? { uid } : {}), ...(own ? { own: true as const } : {}) };
  return { session, cookie: sessionCookie(await signSession(env, session), ttl) };
}

export function getCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
}

export const allowedLogins = (env: AuthEnv) => (env.ALLOWED_GITHUB_LOGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export async function readSession(req: Request, env: AuthEnv): Promise<Session | null> {
  if (!env.SESSION_SECRET) return null;
  const v = getCookie(req, SESSION_COOKIE);
  if (!v) return null;
  const [body, sig, extra] = v.split(".");
  if (!body || !sig || extra !== undefined || !safeEq(sig, await hmac(env.SESSION_SECRET, body))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64u(body))) as Session;
    if (typeof s.u !== "string" || typeof s.csrf !== "string" || typeof s.exp !== "number") return null;
    if (s.exp < Date.now() / 1000) return null;
    // Allowlist is re-checked on every request, so removing a login revokes live sessions.
    if (s.via === "e2e") {
      // Bypass session: fixed user, hard 15-minute cap regardless of what the cookie claims, dead if the secret is gone.
      if (e2eSlotOfUser(s.u) === null || !env.E2E_TOKEN || env.E2E_TOKEN.length < 32 || s.exp - s.iat > 15 * 60) return null;
      return s;
    }
    if (s.via === "team") {
      // Team session: only while the instance is configured for it, a 7-day hard cap, and a well-formed uid. Entitlements are re-checked per request (index.ts).
      if (!env.TEAM_GATEWAY_URL || typeof s.uid !== "string" || !/^[a-z0-9]{16,32}$/.test(s.uid) || s.u !== s.u.toLowerCase() || s.exp - s.iat > TEAM_SESSION_TTL_S) return null;
      // conv4: an owner session is valid only while OWNER_EMAILS still lists its email (removing it revokes at once). `own` must be exactly true; anything else is dropped.
      if (s.own !== undefined && (s.own !== true || !isOwnerEmail(env, s.u))) return null;
      return s;
    }
    if (s.via !== "github" || !allowedLogins(env).includes(s.u.toLowerCase())) return null;
    return s;
  } catch { return null; }
}

// Same-origin check for state-changing requests and WebSocket upgrades. A missing Origin is rejected.
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

export type Authed = { session: Session; refreshCookie?: string };

export async function authenticate(req: Request, env: AuthEnv): Promise<Authed | { err: Response }> {
  const deny = (status: number, msg: string) => ({ err: new Response(JSON.stringify({ error: msg }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }) });
  const s = await readSession(req, env);
  if (!s) return deny(401, "unauthorized");
  const isWs = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (isWs || mutating) {
    if (!sameOrigin(req)) return deny(403, "cross-origin request rejected");
  }
  if (mutating && !isWs) {
    const tok = req.headers.get("x-csrf-token") ?? "";
    if (!tok || !safeEq(tok, s.csrf)) return deny(403, "missing/invalid CSRF token");
  }
  let refreshCookie: string | undefined;
  const now = Math.floor(Date.now() / 1000);
  // team sessions are never refreshed here: a new one needs a fresh gateway assertion (revocation latency stays <= 7d even without the per-request check)
  if (s.via === "github" && now - (s.iat ?? 0) > REFRESH_AFTER_S) {
    refreshCookie = sessionCookie(await signSession(env, { ...s, iat: now, exp: now + SESSION_TTL_S }));
  }
  return { session: s, refreshCookie };
}

// ---- Shared SSO (workers/auth) ----
// The `sso` cookie (Domain=.internal.invalid, Ed25519 JWT) is only ever an *input*: a valid one is exchanged for our own
// __Host-vc_session (same `u` as a GitHub login, so per-user scope is unchanged). It never mints via:"e2e" and is never
// consulted by /auth/e2e or any machine path.

/** Fresh session for a browser holding a valid, allowlisted SSO cookie; null if there is none. */
export async function ssoExchange(req: Request, env: AuthEnv): Promise<{ session: Session; cookie: string } | null> {
  if (!env.SESSION_SECRET) return null;
  // Same-site navigations / same-origin fetches only (a cross-site page must not be able to trigger the exchange).
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") return null;
  const r = await readSso(req, env);
  if (!r.ok || !allowedLogins(env).includes(r.claims.sub.toLowerCase())) return null;
  return makeSession(env, r.claims.sub, "github");
}

/** Where /auth/login sends a browser with no SSO cookie. `sso=1` on the way back lets us detect a bounce that changed nothing. */
export const ssoBounceUrl = (req: Request, env: SsoEnv) => ssoLoginUrl(new URL("/auth/login?sso=1", req.url).href, env, false, [new URL(req.url).origin]);
/** Same bounce, but back to an arbitrary URL on this origin (the caller has already added its own `sso=1`).
 *  cf-lite >= 0.4.1 refuses absolute return URLs unless their origin is allow-listed: allow exactly this request's own origin (no new env var). */
export const ssoBounceUrlFor = (req: Request, returnUrl: string, env: SsoEnv) => ssoLoginUrl(returnUrl, env, false, [new URL(req.url).origin]);
export const ssoLogoutUrl = (req: Request, env: SsoEnv) => `${env.SSO_AUTH_ORIGIN}/logout?return=${encodeURIComponent(new URL("/?signedout=1", req.url).href)}`;

/** GET /auth/login: SSO valid -> session -> `/`; else to auth.dev2 (once); if that bounce came back empty-handed, GitHub directly. */
export async function loginRoute(req: Request, env: AuthEnv): Promise<Response> {
  const noStore = { "cache-control": "no-store" };
  const x = await ssoExchange(req, env);
  if (x) return new Response(null, { status: 302, headers: { location: "/", "set-cookie": x.cookie, ...noStore } });
  if (!env.SSO_PUBLIC_KEYS || new URL(req.url).searchParams.get("sso") === "1") return githubLoginRedirect(req, env);
  return new Response(null, { status: 302, headers: { location: ssoBounceUrl(req, env), ...noStore } });
}

// ---- GitHub OAuth (authorization-code flow) ----

const jsonRes = (o: unknown, status: number) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function githubConfigured(env: AuthEnv) { return !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET; }

/** Which login methods this deployment offers, derived ONLY from env vars (no edition constant): GitHub OAuth vars => github, SSO_PUBLIC_KEYS => sso, TEAM_GATEWAY_URL => team.
 *  Any combination is valid; none enabled = every login route fails closed (503 / 404). `team` is omitted from /auth/config when off (byte-compatible with the pre-conv3 shape). */
export function loginMethods(env: AuthEnv) { return { github: githubConfigured(env), sso: !!env.SSO_PUBLIC_KEYS, team: !!env.TEAM_GATEWAY_URL }; }

export function githubLoginRedirect(req: Request, env: AuthEnv): Response {
  if (!githubConfigured(env)) return jsonRes({ error: "GitHub OAuth is not configured yet" }, 503);
  const state = randHex(16);
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
  u.searchParams.set("redirect_uri", new URL("/auth/callback", req.url).href);
  u.searchParams.set("scope", "read:user");
  u.searchParams.set("state", state);
  u.searchParams.set("allow_signup", "false");
  return new Response(null, { status: 302, headers: { location: u.href, "set-cookie": stateCookie(state), "cache-control": "no-store" } });
}

export async function githubCallback(req: Request, env: AuthEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const fail = (status: number, msg: string) => new Response(msg, { status, headers: { "content-type": "text/plain", "cache-control": "no-store", "set-cookie": stateCookie("", 0) } });
  if (!githubConfigured(env)) return fail(503, "GitHub OAuth is not configured yet");
  const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
  const bound = getCookie(req, STATE_COOKIE) ?? "";
  if (!state || !bound || !safeEq(state, bound)) return fail(400, "OAuth state mismatch");
  if (!code) return fail(400, "missing code");
  const redirect_uri = new URL("/auth/callback", req.url).href;
  const tokRes = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "vertex-client" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri }),
  });
  const tok = (await tokRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tok.access_token) return fail(502, "GitHub token exchange failed");
  const me = await fetchImpl("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "vertex-client", accept: "application/vnd.github+json" } });
  const user = (await me.json().catch(() => ({}))) as { login?: string };
  if (!user.login) return fail(502, "could not read GitHub user");
  if (!allowedLogins(env).includes(user.login.toLowerCase())) return fail(403, "GitHub user is not allowed");
  const { cookie } = await makeSession(env, user.login, "github");
  const h = new Headers({ location: "/", "cache-control": "no-store" });
  h.append("set-cookie", cookie);
  h.append("set-cookie", stateCookie("", 0));
  return new Response(null, { status: 302, headers: h });
}
