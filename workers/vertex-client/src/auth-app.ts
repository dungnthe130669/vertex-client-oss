// Desktop app sign-in through the system browser (docs/vertex-client-desktop-app.md section 9). PKCE-style one-time handoff:
//   GET  /auth/app/start?c=<challenge>&st=<state>   consent page (after the usual session / SSO); mints nothing, writes nothing
//   POST /auth/app/approve                           the only place a code is minted; answers a page with the vertexclient:// link
//   POST /auth/app/exchange {code, verifier}         inside the app's WebView: code + verifier -> the normal __Host- session cookie
//   GET  /auth/app/complete (+ /complete.js)         static page + script; the secrets travel in the URL fragment, never to the server
// Flag-gated: every route answers a plain 404 unless the settings row `desktop_login:main`='1' (default OFF, D1 error = OFF).
// The code and the verifier are never stored, logged or put in a Location header; log lines carry the outcome only.
import type { Context } from "hono";
import { SESSION_TTL_S, TEAM_SESSION_TTL_S, allowedLogins, isOwnerEmail, makeSession, randHex, readSession, safeEq, sameOrigin, sessionCookie, signSession, ssoBounceUrlFor, ssoExchange, type AuthEnv, type Session } from "./auth";
import { E2E_TTL_S, e2eEnabled } from "./auth-e2e";
import { e2eSlotOfUser } from "./scope";

export const HANDOFF_TTL_S = 60;
export const APPROVE_PER_USER_WINDOW = 5;       // codes one user may mint per APPROVE_WINDOW_S
export const APPROVE_WINDOW_S = 600;
export const MAX_OPEN_CODES = 2;                // unused, unexpired codes one user may hold at once
export const EXCHANGE_FAIL_PER_IP = 8;          // failed exchanges per client address per FAIL_WINDOW_S
export const EXCHANGE_FAIL_GLOBAL = 60;         // failed exchanges from everyone per FAIL_WINDOW_S
export const FAIL_WINDOW_S = 600;
export const FLAG = "desktop_login:main";
export const APP_SCHEME = "vertexclient://auth/callback";

const B64U43 = /^[A-Za-z0-9_-]{43}$/;           // 32 random bytes / a SHA-256 digest, base64url without padding
const B64U22 = /^[A-Za-z0-9_-]{22}$/;           // 16 random bytes
const nowS = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256Hex = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(t)))].map((x) => x.toString(16).padStart(2, "0")).join("");
/** PKCE S256 (RFC 7636 section 4.2): base64url(SHA-256(ASCII(verifier))), no padding. Exported so the Rust core and the tests share one reference. */
export const challengeOf = async (verifier: string) => b64u(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
export const newCode = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
const codeHash = (code: string) => sha256Hex(`vcl-app-handoff:${code}`);

type Ctx = Context<{ Bindings: AuthEnv & { DB: D1Database } }>;
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ evt: "app_handoff", ...o }));
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
// Referrer-Policy: only the approve response (the page that carries the code) is no-referrer. start and complete must NOT be: a page under `no-referrer` makes the browser send `Origin: null`
// on its same-origin FORM POST (not on a default-mode fetch(), which still sends its real origin: verified in Chromium and WebKit), which sameOrigin() refuses (found by the e2e run: the consent form's Allow answered "Cross-origin request rejected"). What the other pages hold
// (c/st in the URL, code/verifier only in the fragment, which is never part of a Referer) is useless alone, and the global same-origin policy sends no Referer off-site.
const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
const page = (title: string, body: string, status = 200, extra: Record<string, string> = {}) => {
  const h = new Headers({ ...PAGE_HEADERS, ...extra });
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${body}</body></html>`, { status, headers: h });
};
export const MAX_BODY_BYTES = 4096;
/** Reads at most MAX_BODY_BYTES (streaming, so a missing or lying Content-Length cannot get past it). null = too large. */
async function readBody(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
const tooLarge = () => jerr(413, "request too large");
/** readBody with a failing / aborted stream handled: outcome-only log (never the error text), a controlled non-cacheable 400. Returns the bytes or the Response to send. */
async function readBodySafe(req: Request): Promise<Uint8Array | Response> {
  try { return (await readBody(req)) ?? tooLarge(); }
  catch { log({ step: "body", ok: false, why: "body-read" }); return jerr(400, "invalid request body"); }
}
const nf = () => new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const jerr = (status: number, error: string, extra: Record<string, string> = {}) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

/** Only the exact row '1' enables it. A D1 error or a missing DB is OFF (fail closed). */
export async function desktopLoginEnabled(db: D1Database | undefined): Promise<boolean> {
  if (!db) return false;
  try { return (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(FLAG).first<{ value: string }>())?.value === "1"; } catch { return false; }
}

const COMPLETE_JS = `(() => {
  const msg = (t) => { const e = document.getElementById("msg"); if (e) e.textContent = t; };
  const h = new URLSearchParams(location.hash.slice(1));
  const code = h.get("code") || "", verifier = h.get("v") || "";
  history.replaceState(null, "", location.pathname);
  if (!code || !verifier) { msg("This sign-in link is incomplete. Go back to the app and try again."); return; }
  fetch("/auth/app/exchange", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, verifier }) })
    .then((r) => { if (r.ok) location.replace("/"); else msg("Sign-in did not complete. Go back to the app and try again."); })
    .catch(() => msg("Sign-in did not complete. Go back to the app and try again."));
})();
`;

/** Fetch Metadata guard for the completion page and its script: the page auto-exchanges whatever credentials sit in its URL fragment and replaces the browser's session with them, so a foreign site
 *  that navigates a victim there (link, redirect, script) would log the victim into the attacker's account. Allow only `none` (typed / OS- or app-initiated top-level load) and `same-origin`;
 *  a missing header FAILS CLOSED (every browser that matters sends it; a client that does not gets no completion page). */
const untrustedNavigation = (req: Request) => {
  const site = req.headers.get("sec-fetch-site");
  // Speculative loads (Speculation Rules prefetch / prerender, legacy `Purpose: prefetch`) also arrive as Sec-Fetch-Site: none; the browser can later consume the prefetched response as if it were the
  // user's navigation, after which the page's own script and exchange look same-origin. Never serve usable HTML to them.
  const purpose = `${req.headers.get("sec-purpose") ?? ""} ${req.headers.get("purpose") ?? ""}`;
  return /prefetch|prerender/i.test(purpose) || (site !== "none" && site !== "same-origin");
};
const refuseNav = () => { log({ step: "complete", ok: false, why: "untrusted-navigation" }); return jerr(403, "untrusted navigation", VARY); };
const VARY = { vary: "Sec-Fetch-Site, Sec-Purpose, Purpose" };

export function appAuthRoutes(app: { get(p: string, h: (c: Ctx) => Response | Promise<Response>): unknown; post(p: string, h: (c: Ctx) => Response | Promise<Response>): unknown }) {
  const gated = (h: (c: Ctx) => Response | Promise<Response>) => async (c: Ctx) => ((await desktopLoginEnabled(c.env.DB)) ? h(c) : nf());

  app.get("/auth/app/start", gated(async (c) => {
    const req = c.req.raw, url = new URL(req.url);
    const cc = url.searchParams.get("c") ?? "", st = url.searchParams.get("st") ?? "";
    if (!B64U43.test(cc) || !B64U22.test(st)) return page("Invalid sign-in link", "<p>This sign-in link is not valid. Go back to the app and try again.</p>", 400);
    let session: Session | null = await readSession(req, c.env), setCookie: string | undefined;
    if (!session) {
      const x = await ssoExchange(req, c.env);
      if (x) { session = x.session; setCookie = x.cookie; }
    }
    if (!session) {
      // First time: one bounce through the shared SSO, back to this same URL. A bounce that changed nothing is a dead end here (no GitHub fallback: its callback always lands on "/").
      if (url.searchParams.get("sso") === "1" || !c.env.SSO_PUBLIC_KEYS) return page("Sign-in did not complete", "<p>Sign-in did not complete. Go back to the app and try again.</p>", 401);
      const back = new URL(req.url); back.searchParams.set("sso", "1");
      return new Response(null, { status: 302, headers: { location: ssoBounceUrlFor(req, back.href, c.env), "cache-control": "no-store" } });
    }
    if (session.via === "team" && session.own !== true) return page("Not available", "<p>Desktop sign-in is not available for this account.</p>", 403);
    const extra: Record<string, string> = setCookie ? { "set-cookie": setCookie } : {};
    return page("Sign in the Vertex Client app?",
      `<p>Sign in the Vertex Client app on a Mac as <strong>${esc(session.u)}</strong>?</p>` +
      `<form method="post" action="/auth/app/approve"><input type="hidden" name="c" value="${esc(cc)}"><input type="hidden" name="st" value="${esc(st)}"><input type="hidden" name="csrf" value="${esc(session.csrf)}">` +
      `<button type="submit">Allow</button> <a href="/">Cancel</a></form>`, 200, extra);
  }));

  app.post("/auth/app/approve", gated(async (c) => {
    const req = c.req.raw, db = c.env.DB;
    const body = await readBodySafe(req);
    if (body instanceof Response) return body;
    const s = await readSession(req, c.env);
    if (!s) return page("Sign in again", "<p>Your session has expired. Sign in again, then retry from the app.</p>", 401);
    if (s.via === "team" && s.own !== true) return page("Not available", "<p>Desktop sign-in is not available for this account.</p>", 403);
    if (!sameOrigin(req)) return page("Refused", "<p>Cross-origin request rejected.</p>", 403);
    const form = await new Response(body as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData().catch(() => null);
    const field = (k: string) => { const v = form?.get(k); return typeof v === "string" ? v : ""; };
    if (!safeEq(field("csrf"), s.csrf)) return page("Refused", "<p>Missing or invalid request token. Go back to the app and try again.</p>", 403);
    const cc = field("c"), st = field("st");
    if (!B64U43.test(cc) || !B64U22.test(st)) return page("Invalid sign-in link", "<p>This sign-in link is not valid. Go back to the app and try again.</p>", 400);
    const t = nowS();
    try {
      await db.prepare(`DELETE FROM app_handoffs WHERE expires_at < ?`).bind(t - 3600).run();
      // Admission is part of the INSERT itself (counts and write in one statement), so concurrent approvals cannot all read "below the cap" and then all insert.
      // The 10-minute window cap does not apply to the e2e-bot (a fixed test user, 15 min sessions, own data scope): its suite legitimately mints several codes per run and repeats it.
      // The unused-open-codes cap applies to everyone.
      const code = newCode();
      const ins = await db.prepare(`INSERT INTO app_handoffs (code_hash, challenge, user, via, created_at, expires_at, auth_expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE (? = 'e2e' OR (SELECT COUNT(*) FROM app_handoffs WHERE user=? AND created_at > ?) < ?)
        AND (SELECT COUNT(*) FROM app_handoffs WHERE user=? AND used_at IS NULL AND expires_at > ?) < ?`)
        .bind(await codeHash(code), cc, s.u, s.via === "team" ? `team:${s.lat ?? 0}` : s.via, t, t + HANDOFF_TTL_S, s.exp, s.via, s.u, t - APPROVE_WINDOW_S, APPROVE_PER_USER_WINDOW, s.u, t, MAX_OPEN_CODES).run();
      if (!ins.meta.changes) { log({ step: "approve", ok: false, why: "rate" }); return page("Too many attempts", "<p>Too many sign-in attempts. Wait a few minutes and try again.</p>", 429, { "retry-after": String(APPROVE_WINDOW_S) }); }
      log({ step: "approve", ok: true });
      const link = `${APP_SCHEME}?code=${code}&st=${st}`;
      return page("Open Vertex Client", `<p><a href="${esc(link)}">Open Vertex Client</a></p><p>Nothing opened? Make sure Vertex Client is installed in Applications, then go back to the app and try again.</p>`, 200, { "referrer-policy": "no-referrer" });
    } catch (e) { console.error("app handoff approve", e instanceof Error ? e.message : String(e)); return page("Unavailable", "<p>Desktop sign-in is unavailable right now.</p>", 503); }
  }));

  app.post("/auth/app/exchange", gated(async (c) => {
    const req = c.req.raw, db = c.env.DB;
    if (!sameOrigin(req)) return jerr(403, "cross-origin request rejected");
    // Defence in depth: a browser fetch from the completion page is always Sec-Fetch-Site same-origin (the page itself is only served to none/same-origin navigations), so an explicit
    // none / same-site / cross-site is refused. An ABSENT header is allowed here (non-browser clients, e2e API contexts): Origin + code + verifier already gate it, and requiring the header would only break them.
    const fetchSite = req.headers.get("sec-fetch-site");
    if (fetchSite !== null && fetchSite !== "same-origin") return jerr(403, "cross-origin request rejected");
    const bad = () => jerr(400, "invalid or expired code");
    const body = await readBodySafe(req);
    if (body instanceof Response) return body;
    const raw: unknown = (() => { try { return JSON.parse(new TextDecoder().decode(body)); } catch { return null; } })();
    const b = (raw !== null && typeof raw === "object" ? raw : {}) as { code?: unknown; verifier?: unknown };   // null / array / scalar bodies fall through to the uniform shape failure
    const code = typeof b.code === "string" ? b.code : "", verifier = typeof b.verifier === "string" ? b.verifier : "";
    const t = nowS();
    const ip = await sha256Hex("vcl-app-ip:" + (req.headers.get("cf-connecting-ip") ?? "unknown"));
    try {
      await db.prepare(`DELETE FROM app_handoff_fails WHERE at < ?`).bind(t - FAIL_WINDOW_S).run();
      const mine = await db.prepare(`SELECT COUNT(*) AS n FROM app_handoff_fails WHERE ip_hash=?`).bind(ip).first<{ n: number }>();
      const all = await db.prepare(`SELECT COUNT(*) AS n FROM app_handoff_fails`).first<{ n: number }>();
      if ((mine?.n ?? 0) >= EXCHANGE_FAIL_PER_IP || (all?.n ?? 0) >= EXCHANGE_FAIL_GLOBAL) return jerr(429, "too many attempts", { "retry-after": String(FAIL_WINDOW_S) });
      // A miss counts toward the failure throttle, except one against a code that belongs to the e2e-bot (a row only the e2e token can create): its suite deliberately reuses and mis-verifies
      // codes and repeats the run, which an 8-per-10-minutes-per-address ceiling would otherwise starve. Unknown / malformed codes always count.
      // The counted failure is recorded with a conditional INSERT (budget check and write in one statement): concurrent misses cannot all pass a count and then all insert; over budget => 429.
      const miss = async (why: string, count = true) => {
        if (count) {
          const w = await db.prepare(`INSERT INTO app_handoff_fails (ip_hash, at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM app_handoff_fails WHERE ip_hash=?) < ? AND (SELECT COUNT(*) FROM app_handoff_fails) < ?`)
            .bind(ip, t, ip, EXCHANGE_FAIL_PER_IP, EXCHANGE_FAIL_GLOBAL).run();
          if (!w.meta.changes) { log({ step: "exchange", ok: false, why: "throttled" }); return jerr(429, "too many attempts", { "retry-after": String(FAIL_WINDOW_S) }); }
        }
        log({ step: "exchange", ok: false, why }); return bad();
      };
      if (!B64U43.test(code) || !B64U43.test(verifier)) return await miss("shape");
      const h = await codeHash(code);
      const row = await db.prepare(`SELECT challenge, user, via, used_at, expires_at, auth_expires_at FROM app_handoffs WHERE code_hash=?`).bind(h).first<{ challenge: string; user: string; via: string; used_at: number | null; expires_at: number; auth_expires_at: number }>();
      if (!row) return await miss("unknown");
      // A team row carries the approver's original login time packed into via ("team:<lat>", no new column): the handed-off session keeps it, so a handoff never refreshes login freshness.
      const teamLat = row.via.startsWith("team:") ? Number(row.via.slice(5)) : row.via === "team" ? 0 : null;
      if (teamLat !== null) row.via = "team";
      const count = row.via !== "e2e";
      if (row.used_at !== null || row.expires_at <= t) return await miss("dead", count);
      // Claim BEFORE checking the verifier: single use is one atomic UPDATE (two concurrent exchanges: exactly one changes a row), and a wrong verifier burns the code.
      const claim = await db.prepare(`UPDATE app_handoffs SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at > ?`).bind(t, h, t).run();
      if (!claim.meta.changes) return await miss("claimed", count);
      if (!safeEq(await challengeOf(verifier), row.challenge)) return await miss("verifier", count);
      // Same kind as the approving session; the allowlist / e2e switch is re-checked now (a login removed in the last 60 s gets nothing). The user comes from the row, never the request.
      // b-merge (conv5): a handoff approved by an owner team session (via "team", only ever written for own===true). Re-checked now: the email must STILL be in OWNER_EMAILS, the instance still team-configured and the
      // team user active; the uid comes from our own team_users row for that email, never from the request.
      let teamUid: string | null = null;
      if (row.via === "team") {
        const u = c.env.TEAM_GATEWAY_URL && isOwnerEmail(c.env, row.user)
          ? await db.prepare(`SELECT uid FROM team_users WHERE email=? AND status='active'`).bind(row.user).first<{ uid: string }>() : null;
        teamUid = u?.uid ?? null;
      }
      if (row.via === "team" ? teamUid === null : row.via === "github" ? !allowedLogins(c.env).includes(row.user.toLowerCase()) : row.via === "e2e" ? !e2eEnabled(c.env) || e2eSlotOfUser(row.user) === null : true) return await miss("revoked", count);
      // The e2e-bot's session is "15 minutes, never refreshed" (auth-e2e.ts): a handed-off one must not outlive the session that approved it, or chained handoffs would renew it forever without the token.
      // So it is minted with an ABSOLUTE expiry from ONE clock reading (never "now + ttl" against a later reading: time advancing across the awaits above would otherwise push it past the approver).
      let cookie: string;
      if (row.via === "e2e") {
        const iat = nowS(), exp = Math.min(iat + E2E_TTL_S, row.auth_expires_at);
        if (exp <= iat) return await miss("expired-session", count);
        const session: Session = { u: row.user, csrf: randHex(16), iat, exp, via: "e2e" };
        cookie = sessionCookie(await signSession(c.env, session), exp - iat);
        if (exp <= nowS()) return await miss("expired-session", count);   // it ran out while being signed
      } else if (row.via === "team") {
        // Preserve the approver's lat, never outlive the approving session (also across chained handoffs), fresh CSRF, absolute expiry from one clock reading.
        const iat = nowS(), exp = Math.min(iat + TEAM_SESSION_TTL_S, row.auth_expires_at);
        if (exp <= iat) return await miss("expired-session", count);
        const session: Session = { u: row.user, csrf: randHex(16), iat, lat: Number.isFinite(teamLat) ? teamLat! : 0, exp, via: "team", uid: teamUid!, own: true };
        cookie = sessionCookie(await signSession(c.env, session), exp - iat);
        if (exp <= nowS()) return await miss("expired-session", count);
      }
      else cookie = (await makeSession(c.env, row.user, "github", SESSION_TTL_S)).cookie;
      log({ step: "exchange", ok: true });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cookie } });
    } catch (e) { console.error("app handoff exchange", e instanceof Error ? e.message : String(e)); return jerr(503, "unavailable"); }
  }));

  app.get("/auth/app/complete", gated((c) => untrustedNavigation(c.req.raw) ? refuseNav() : page("Signing in", `<p id="msg">Signing in to Vertex Client...</p><script src="/auth/app/complete.js"></script>`, 200, VARY)));
  app.get("/auth/app/complete.js", gated((c) => untrustedNavigation(c.req.raw) ? refuseNav() : new Response(COMPLETE_JS, { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", ...VARY } })));
}
