// Security headers, single source of truth (media-src 'self': generated video plays from the authed same-origin file endpoint). web/public/_headers (static assets) is checked against this in tests.
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; " +
  "manifest-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** Headers of GET /af/:id/:version (an html artifact, model-authored code). They REPLACE SECURITY_HEADERS: the `sandbox` CSP directive makes the document an opaque origin
 *  (no cookies, storage or same-origin API access) even when it is opened top-level, and everything that could reach the network or another document is 'none'. */
export const ARTIFACT_FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
export const ARTIFACT_FRAME_HEADERS: Record<string, string> = {
  "content-security-policy": ARTIFACT_FRAME_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
};
/** The whole /af/ prefix (NOT /a/: that is the SPA agent-detail route /a/<name>) is the artifact frame surface (the route itself answers anything under it that is not a valid frame URL with 404). */
export const isArtifactFramePath = (pathname: string) => pathname.startsWith("/af/");

export function withSecurityHeaders(res: Response, req?: Request): Response {
  // A WebSocket upgrade must pass through untouched: rebuilding it would drop the socket (and 101 headers are immutable).
  if (res.status === 101) return res;
  const r = new Response(res.body, res);
  if (req && isArtifactFramePath(new URL(req.url).pathname)) {
    for (const k of Object.keys(SECURITY_HEADERS)) r.headers.delete(k); // not x-frame-options / HSTS / permissions-policy: frame-ancestors governs framing
    for (const [k, v] of Object.entries(ARTIFACT_FRAME_HEADERS)) r.headers.set(k, v);
    return r;
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  // The desktop sign-in approve page carries the one-time code in its body: never send even a same-origin Referer from it (src/auth-app.ts; start/complete deliberately keep the default, see there).
  if (req && new URL(req.url).pathname === "/auth/app/approve") r.headers.set("referrer-policy", "no-referrer");
  return r;
}
