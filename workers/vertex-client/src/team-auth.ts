// Team login (instance `vertex-client-team`): the team gateway signs a short-lived assertion after ITS Google sign-in, and we exchange it for our own
// __Host-vc_session (via:"team", scope g:<uid>). We hold only the gateway's PUBLIC key (var TEAM_JWKS).
//   GET /auth/team           -> 302 ${TEAM_GATEWAY_URL}/login/vclient?return=${TEAM_ORIGIN}/auth/team/callback&state=<random>   (state also in a Lax cookie)
//   GET /auth/team/callback  -> verify assertion (EdDSA, kid in TEAM_JWKS, iss, aud, exp-iat<=60s, exp, features has vclient_app), state == cookie,
//                               jti single use (D1), upsert team_users, mint the session.
// Every refusal is a plain short message: no claim, key or upstream detail is echoed.
import { getCookie, isOwnerEmail, makeSession, randHex, safeEq, TEAM_SESSION_TTL_S, type AuthEnv } from "./auth";
import { FEATURE_APP, teamConfigured, type TeamEnv } from "./providers/team-gateway";

export interface TeamAuthEnv extends AuthEnv, TeamEnv {
  /** This instance's origin, exactly (https://host, no path). The assertion's `aud` and the return URL are derived from it. */
  TEAM_ORIGIN?: string;
  /** Public JWKS of the gateway's assertion key (JSON string, no secret). */
  TEAM_JWKS?: string;
  DB: D1Database;
}

export const TEAM_STATE_COOKIE = "__Host-vc_team_state";
export const TEAM_ISSUER = "vertex-team-gateway";
export const MAX_ASSERTION_TTL_S = 60;
const SKEW_S = 30;
const enc = new TextEncoder();
const stateCookie = (v: string, maxAge = 600) => `${TEAM_STATE_COOKIE}=${v}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
const noStore = { "cache-control": "no-store" };
const fail = (status: number, msg: string) => new Response(msg, { status, headers: { "content-type": "text/plain", ...noStore, "set-cookie": stateCookie("", 0) } });

export const teamLoginEnabled = (env: TeamEnv) => !!env.TEAM_GATEWAY_URL;
export const teamCallbackUrl = (env: TeamAuthEnv) => `${(env.TEAM_ORIGIN ?? "").replace(/\/+$/, "")}/auth/team/callback`;

export function teamLoginRedirect(env: TeamAuthEnv): Response {
  if (!teamLoginEnabled(env) || !env.TEAM_ORIGIN) return fail(404, "not found");
  const state = randHex(16);
  const u = new URL("/login/vclient", env.TEAM_GATEWAY_URL!);
  u.searchParams.set("return", teamCallbackUrl(env));
  u.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: u.href, "set-cookie": stateCookie(state), ...noStore } });
}

const unb64u = (s: string) => { if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("b64"); return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)); };
const json = (s: string) => JSON.parse(new TextDecoder().decode(unb64u(s)));

export interface Assertion { email: string; gatewayUid: string; features: string[]; jti: string; exp: number }

/** Verify the assertion. Returns the claims we use, or a short internal reason (never shown to the client). */
export async function verifyAssertion(env: TeamAuthEnv, token: string, now = Math.floor(Date.now() / 1000)): Promise<Assertion | { why: string }> {
  const bad = (why: string) => ({ why });
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 4096) return bad("shape");
    const header = json(parts[0]!);
    if (header.alg !== "EdDSA" || typeof header.kid !== "string") return bad("alg");
    let jwk: { kty?: string; crv?: string; x?: string; kid?: string } | undefined;
    try { jwk = (JSON.parse(env.TEAM_JWKS ?? "") as { keys?: any[] }).keys?.find((k) => k?.kid === header.kid); } catch { return bad("jwks"); }
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") return bad("kid");
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, unb64u(parts[2]!), enc.encode(`${parts[0]}.${parts[1]}`)))) return bad("sig");
    const c = json(parts[1]!);
    if (c.iss !== TEAM_ISSUER) return bad("iss");
    if (typeof c.aud !== "string" || c.aud !== env.TEAM_ORIGIN) return bad("aud");
    if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return bad("times");
    if (c.exp - c.iat > MAX_ASSERTION_TTL_S || c.exp <= c.iat) return bad("ttl");
    if (c.exp <= now || c.iat > now + SKEW_S) return bad("expired");
    if (typeof c.sub !== "string" || c.sub !== c.sub.toLowerCase() || !/^[^\s@,<>"']{1,64}@[^\s@,<>"']{1,255}$/.test(c.sub)) return bad("sub");
    if (typeof c.uid !== "string" || !/^[\w.:-]{1,128}$/.test(c.uid)) return bad("uid");
    if (typeof c.jti !== "string" || !/^[\w.:-]{8,128}$/.test(c.jti)) return bad("jti");
    if (!Array.isArray(c.features) || !c.features.every((f: unknown) => typeof f === "string")) return bad("features");
    if (!c.features.includes(FEATURE_APP)) return bad("feature");
    return { email: c.sub, gatewayUid: c.uid, features: c.features, jti: c.jti, exp: c.exp };
  } catch { return bad("parse"); }
}

/** vclient's own stable scope id for a gateway user: 24 lowercase hex of SHA-256. Deterministic (same user, same data on every login), fits the
 *  g:<16-32 [a-z0-9]> scope grammar, and keeps the gateway's raw id and the email out of scope strings. */
export async function teamUidFor(gatewayUid: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`vclient-team-uid:${gatewayUid}`)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function teamCallback(req: Request, env: TeamAuthEnv): Promise<Response> {
  if (!teamLoginEnabled(env) || !env.TEAM_ORIGIN || !env.TEAM_JWKS || !teamConfigured(env) || !env.SESSION_SECRET) return fail(404, "not found");
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "", bound = getCookie(req, TEAM_STATE_COOKIE) ?? "";
  if (!state || !bound || !safeEq(state, bound)) return fail(400, "sign-in state mismatch");
  const assertion = url.searchParams.get("assertion") ?? "";
  if (!assertion) return fail(400, "missing assertion");
  const a = await verifyAssertion(env, assertion);
  if ("why" in a) { console.log(JSON.stringify({ evt: "team_login", ok: false, why: a.why })); return a.why === "feature" ? fail(403, "this account has no access to this app") : fail(401, "sign-in refused"); }
  const now = Math.floor(Date.now() / 1000);
  try {
    // Single use: the primary key makes the second use of a jti fail. Swept rows are long past exp.
    await env.DB.prepare(`DELETE FROM team_assertions WHERE exp < ?`).bind(now - 3600).run();
    try { await env.DB.prepare(`INSERT INTO team_assertions (jti, exp) VALUES (?,?)`).bind(a.jti, a.exp).run(); }
    catch { console.log(JSON.stringify({ evt: "team_login", ok: false, why: "replay" })); return fail(401, "sign-in refused"); }
    const uid = await teamUidFor(a.gatewayUid);
    const owner = isOwnerEmail(env, a.email); // conv4: only the VERIFIED assertion email, exact match, env opt-in
    const row = await env.DB.prepare(`SELECT status FROM team_users WHERE gateway_uid=?`).bind(a.gatewayUid).first<{ status: string }>();
    if (row && row.status !== "active") return fail(403, "this account is disabled");
    await env.DB.prepare(`INSERT INTO team_users (uid, gateway_uid, email, status, created_at, last_login_at) VALUES (?,?,?,'active',?,?)
      ON CONFLICT(gateway_uid) DO UPDATE SET email=excluded.email, last_login_at=excluded.last_login_at`).bind(uid, a.gatewayUid, a.email, now, now).run();
    const { cookie } = await makeSession(env, a.email, "team", TEAM_SESSION_TTL_S, uid, owner);
    console.log(JSON.stringify({ evt: "team_login", ok: true, uid, ...(owner ? { owner: true } : {}) }));
    if (owner) console.log(JSON.stringify({ evt: "team_owner_map", scope: "main", uid, jti: a.jti })); // audit: no email in the log
    const h = new Headers({ location: "/", ...noStore });
    h.append("set-cookie", cookie);
    h.append("set-cookie", stateCookie("", 0));
    return new Response(null, { status: 302, headers: h });
  } catch (e) { console.error("team login", e instanceof Error ? e.message : "error"); return fail(503, "sign-in unavailable"); }
}
