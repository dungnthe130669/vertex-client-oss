// "Link your own Cloudflare account": a user pastes an API token + account id, stored with the per-base encrypted key machinery (user-keys.ts) under the
// provider id `cf-account`, bound to the Cloudflare API origin (AAD). Without a link every Cloudflare feature uses the operator's shared bindings (AI,
// BROWSER); with one, Workers AI (/ai/run) and Browser Rendering (/browser-rendering/*) go to THAT account through the REST API instead, so the user's own
// allowance and billing apply. The token + account id live in ONE ciphertext ("<accountId>:<token>"): neither can be swapped for the other's.
// Rules: requests only to api.cloudflare.com (fixed origin, allowlisted path, account id validated), redirects are never followed, the token appears in
// no log, URL, error or response (only its last 4 characters in the status), and an unreadable row FAILS CLOSED (never falls back to the shared account).
import type { BaseScope } from "./scope";
import { userKeyOf, type KeyEnv } from "./user-keys";

export const CF_ACCT_PROVIDER = "cf-account";
export const CF_ORIGIN = "https://api.cloudflare.com";
export const CF_API = `${CF_ORIGIN}/client/v4`;
export const ACCOUNT_ID = /^[0-9a-f]{32}$/;
/** Cloudflare API tokens are url-safe characters only (40 today); a wide bound so a future format still fits, but nothing with spaces or punctuation. */
export const CF_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
/** Per-request sanity caps for a linked account (the shared daily caps do not apply to it). */
export const CF_OWN_MAX_TOKENS = 16_384;
export const CF_OWN_MAX_BODY = 2_000_000;
export const CF_OWN_MAX_RESPONSE = 12 * 1024 * 1024;
export const CF_OWN_TIMEOUT_MS = 60_000;
export const CF_OWN_BROWSE_PER_TURN = 20;

export type CfCreds = { token: string; accountId: string };
export const encodeCreds = (c: CfCreds) => `${c.accountId}:${c.token}`;
export function decodeCreds(s: string): CfCreds | null {
  const i = s.indexOf(":"); if (i < 0) return null;
  const accountId = s.slice(0, i), token = s.slice(i + 1);
  return ACCOUNT_ID.test(accountId) && CF_TOKEN.test(token) ? { accountId, token } : null;
}
/** Validate what the user typed. Returns creds or a message that never echoes the value. */
export function parseLinkBody(b: unknown): { creds: CfCreds } | { error: string } {
  const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const accountId = typeof o.accountId === "string" ? o.accountId.trim().toLowerCase() : "";
  const token = typeof o.token === "string" ? o.token.trim() : "";
  if (!ACCOUNT_ID.test(accountId)) return { error: "The account id is 32 hexadecimal characters (Cloudflare dashboard > Workers & Pages, right-hand side)." };
  if (!CF_TOKEN.test(token)) return { error: "That does not look like a Cloudflare API token (letters, digits, - and _ only, no spaces)." };
  return { creds: { accountId, token } };
}
/** This deployment can store a linked account (key encryption secret + D1). */
/** Log hygiene: a raw fetch error can carry the request URL, which contains the account id. Every 32-hex run is masked before anything is logged. */
export const scrubIds = (m: string) => m.replace(/[0-9a-f]{32}/gi, "<id>");
export const linkableEnv = (env: KeyEnv) => !!env.KEY_ENC_SECRET && !!env.DB;
export const last4 = (s: string) => s.slice(-4);

/** What a Cloudflare call for this base may do: shared bindings (none), the user's account (acct), or nothing (error: row present but unusable - never the shared account). */
export type CfAcct = { kind: "none" } | { kind: "acct"; creds: CfCreds } | { kind: "error" };
export async function cfAccountOf(env: KeyEnv, base: BaseScope): Promise<CfAcct> {
  const r = await userKeyOf(env, base, CF_ACCT_PROVIDER, CF_ORIGIN).catch(() => ({ kind: "error" as const }));
  if (r.kind === "none") return { kind: "none" };
  if (r.kind !== "key") return { kind: "error" };
  const creds = decodeCreds(r.key);
  return creds ? { kind: "acct", creds } : { kind: "error" };
}
export const LINK_BROKEN = "Your linked Cloudflare account could not be used. Open Settings > Cloudflare to test, re-link or remove it.";

/** Public status: never the token. */
export async function cfStatus(env: KeyEnv, base: BaseScope): Promise<{ using: "shared" | "own" | "broken"; token_last4?: string; account_last4?: string }> {
  const a = await cfAccountOf(env, base);
  if (a.kind === "none") return { using: "shared" };
  if (a.kind === "error") return { using: "broken" };
  return { using: "own", token_last4: last4(a.creds.token), account_last4: last4(a.creds.accountId) };
}

// ---- REST ----
/** The only account-scoped paths this layer may call. Model ids are validated by the caller's allowlists AND here. */
export const REST_PATH = /^(?:ai\/run\/@cf\/[a-z0-9][a-z0-9._-]{0,60}\/[a-z0-9][a-z0-9._-]{0,80}|browser-rendering\/(?:markdown|links|screenshot|content|pdf|snapshot|scrape|json))$/;
type Init = { method?: "GET" | "POST"; body?: string; signal?: AbortSignal };
const sigOf = (outer?: AbortSignal) => (outer ? AbortSignal.any([outer, AbortSignal.timeout(CF_OWN_TIMEOUT_MS)]) : AbortSignal.timeout(CF_OWN_TIMEOUT_MS));
/** One call to https://api.cloudflare.com/client/v4/accounts/<id>/<path>. A 3xx is an error (redirect: manual). The caller maps status codes; this never throws a message containing the token. */
export async function cfFetch(creds: CfCreds, path: string, init: Init = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (!ACCOUNT_ID.test(creds.accountId) || !REST_PATH.test(path)) throw new Error("bad cloudflare request");
  if (init.body !== undefined && init.body.length > CF_OWN_MAX_BODY) throw new Error("cloudflare request too large");
  const r = await fetchImpl(`${CF_API}/accounts/${creds.accountId}/${path}`, { method: init.method ?? "POST", redirect: "manual", signal: sigOf(init.signal),
    headers: { authorization: `Bearer ${creds.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) }, ...(init.body !== undefined ? { body: init.body } : {}) });
  if (r.status >= 300 && r.status < 400) { void r.body?.cancel().catch(() => {}); return new Response(null, { status: 502 }); }
  return r;
}

/** The "Test" button: ONE harmless read, no product is called and nothing is billed. A user token verifies at /user/tokens/verify, an account-owned token at
 *  /accounts/<id>/tokens/verify; the second is only tried when the first says the token is not a user token. Result text is fixed: never the response body. */
export async function cfVerify(creds: CfCreds, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const get = async (url: string) => {
    try {
      const r = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${creds.token}` } });
      let status: string | null = null;
      if (r.ok) { const j = (await r.json().catch(() => null)) as { success?: boolean; result?: { status?: string } } | null; if (j?.success === true) status = String(j.result?.status ?? ""); }
      else void r.body?.cancel().catch(() => {});
      return { http: r.status, status };
    } catch { return { http: 0, status: null as string | null }; }
  };
  if (!ACCOUNT_ID.test(creds.accountId)) return { ok: false, detail: "The account id is not valid." };
  let r = await get(`${CF_API}/user/tokens/verify`);
  if (r.status === null && r.http !== 0 && r.http !== 429 && r.http < 500) r = await get(`${CF_API}/accounts/${creds.accountId}/tokens/verify`);
  if (r.status === "active") return { ok: true, detail: "Cloudflare accepted the token (active). Product permissions are checked on first use." };
  if (r.status !== null) return { ok: false, detail: `The token is not active (${r.status.replace(/[^a-z_ -]/gi, "").slice(0, 20) || "unknown"}).` };
  if (r.http === 0) return { ok: false, detail: "Could not reach Cloudflare (network error or timeout)." };
  if (r.http === 429) return { ok: false, detail: "Cloudflare is rate limiting this check. Try again in a minute." };
  return { ok: false, detail: `Cloudflare rejected the token (HTTP ${r.http}). It may be revoked, expired, or for another account.` };
}

/** Minimum permissions, by Cloudflare's permission names (Account level). Source: developers.cloudflare.com (Workers AI REST API page; Browser Rendering REST API page). */
export const CF_SCOPES = [
  { feature: "Workers AI chat + image models", permission: "Workers AI - Read and Workers AI - Edit", used_for: "POST /ai/run/<model>" },
  { feature: "Browser tools (web_read, web_links, web_screenshot)", permission: "Browser Rendering - Edit (shown as Browser Run - Edit in newer dashboards)", used_for: "POST /browser-rendering/{markdown,links,screenshot}" },
] as const;
