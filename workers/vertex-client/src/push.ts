// Web Push: RFC 8291 payload encryption (aes128gcm, RFC 8188) + RFC 8292 VAPID, WebCrypto only.
// Private key lives in the Worker secret VAPID_PRIVATE_KEY (base64url, 32-byte scalar `d`); the public key is a var.
import { parseScope, spaceOf, type Scope } from "./scope";
export const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s: string): Uint8Array<ArrayBuffer> => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(t); const u: Uint8Array<ArrayBuffer> = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
const enc = new TextEncoder();
const cat = (...a: Uint8Array[]): Uint8Array<ArrayBuffer> => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

type U8 = Uint8Array<ArrayBuffer>;
async function hkdf(salt: U8, ikm: U8, info: U8, len: number): Promise<U8> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

export type Subscription = { endpoint: string; p256dh: string; auth: string };
export type EphemeralKey = { privateJwk: JsonWebKey; publicRaw: Uint8Array<ArrayBuffer> };

/** Test seam: fixed sender key + salt. In production both are random per message. */
export async function encryptPayload(
  sub: { p256dh: string; auth: string }, plaintext: Uint8Array<ArrayBuffer>,
  fixed?: { sender?: EphemeralKey; salt?: Uint8Array<ArrayBuffer> },
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPub = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error("bad p256dh");
  if (authSecret.length !== 16) throw new Error("bad auth secret");
  let asPriv: CryptoKey, asPub: Uint8Array;
  if (fixed?.sender) {
    asPriv = await crypto.subtle.importKey("jwk", fixed.sender.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    asPub = fixed.sender.publicRaw;
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    asPriv = kp.privateKey; asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prkKey = await hkdf(authSecret, ecdh, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const cek = await hkdf(salt, prkKey, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, prkKey, enc.encode("Content-Encoding: nonce\0"), 12);
  const rs = 4096;
  if (plaintext.length > rs - 17) throw new Error("payload too large"); // single record; push services cap at ~4 KB anyway
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(plaintext, new Uint8Array([2]))));
  const hdr = new Uint8Array(21); hdr.set(salt, 0); new DataView(hdr.buffer).setUint32(16, rs); hdr[20] = asPub.length;
  return cat(hdr, asPub, ct);
}

export async function vapidHeader(endpoint: string, publicKey: string, privateD: string, subject: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const pub = unb64u(publicKey);
  if (pub.length !== 65) throw new Error("bad VAPID public key");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: privateD, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`))); // raw r||s, as JWS wants
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicKey}`;
}

// Only genuine push services; the endpoint is client-supplied and the Worker will POST to it.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function validEndpoint(u: string): boolean {
  if (u.length > 1000) return false;
  try { const x = new URL(u); return x.protocol === "https:" && !x.port && PUSH_HOSTS.some((r) => r.test(x.hostname)); } catch { return false; }
}

export type PushEnv = { DB: D1Database; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };
export type PushPayload = { title: string; body: string; url: string; tag?: string };
/** A tap must open the space the notification belongs to: Open-space payload urls carry `?space=open` (the app validates it against
 *  /api/me.spaces, then strips it). Business urls are returned byte-identical. Idempotent; keeps any existing query and hash. */
export function withSpaceUrl(url: string, scope: Scope): string {
  if (spaceOf(scope) !== "open" || !url.startsWith("/") || url.startsWith("//")) return url;
  const u = new URL(url, "https://x.invalid");
  if (u.searchParams.get("space") === "open") return url;
  u.searchParams.set("space", "open");
  return u.pathname + u.search + u.hash;
}
export type PushResult = { sent: number; failed: number; removed: number; configured: boolean; errors: string[] };

/** Send to the stored subscriptions of ONE scope (the conversation owner's / the caller's), never to anyone else's. 404/410 = subscription gone,
 *  delete it. A malformed scope sends nothing. Never throws. */
export async function pushTo(env: PushEnv, scope: Scope, payload: PushPayload, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
  const r: PushResult = { sent: 0, failed: 0, removed: 0, configured: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY), errors: [] };
  if (!r.configured) return r;
  if (!parseScope(scope)) { r.errors.push("push: bad scope"); return r; }
  try {
    const subs = (await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE scope=?`).bind(scope).all<Subscription>()).results;
    const data = enc.encode(JSON.stringify({ ...payload, url: withSpaceUrl(payload.url, scope) }));
    for (const s of subs) {
      try {
        const body = await encryptPayload(s, data);
        const res = await fetchImpl(s.endpoint, {
          method: "POST", body,
          headers: {
            authorization: await vapidHeader(s.endpoint, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!, env.VAPID_SUBJECT ?? "https://app.internal.invalid"),
            "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "normal",
            ...(payload.tag ? { topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
          },
        });
        if (res.status === 404 || res.status === 410) { await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=? AND scope=?`).bind(s.endpoint, scope).run(); r.removed++; }
        else if (res.ok) { r.sent++; await env.DB.prepare(`UPDATE push_subscriptions SET last_ok_at=datetime('now') WHERE endpoint=? AND scope=?`).bind(s.endpoint, scope).run(); }
        else { r.failed++; r.errors.push(`${new URL(s.endpoint).hostname} ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`); }
      } catch (e) { r.failed++; r.errors.push(e instanceof Error ? e.message : String(e)); }
    }
  } catch (e) { r.errors.push(e instanceof Error ? e.message : String(e)); }
  return r;
}

/** Hook for any finished unit of work that finds no live client (chat turn today; Cloud task end later). */
export function notifyText(kind: "done" | "awaiting" | "error", title: string, preview: string, media?: "video"): { title: string; body: string } {
  const t = title || "New chat";
  if (kind === "done" && media === "video") return { title: t, body: "Video ready" };
  if (kind === "awaiting") return { title: t, body: "Waiting for your approval" };
  if (kind === "error") return { title: t, body: "The reply failed — tap to retry" };
  return { title: t, body: preview.replace(/\s+/g, " ").trim().slice(0, 140) || "Reply ready" };
}
