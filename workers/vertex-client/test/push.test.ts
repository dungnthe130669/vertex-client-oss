import { describe, expect, test } from "bun:test";
import { b64u, encryptPayload, notifyText, pushTo, unb64u, validEndpoint, vapidHeader, withSpaceUrl } from "../src/push";
import type { Scope } from "../src/scope";

// RFC 8291 Appendix A
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const jwkOf = (d: string, pub: string): JsonWebKey => { const p = unb64u(pub); return { kty: "EC", crv: "P-256", d, x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)), ext: true }; };

describe("RFC 8291 known answer", () => {
  test("Appendix A vector reproduces byte for byte", async () => {
    const out = await encryptPayload({ p256dh: V.uaPublic, auth: V.auth }, new TextEncoder().encode(V.plaintext),
      { sender: { privateJwk: jwkOf(V.asPrivate, V.asPublic), publicRaw: unb64u(V.asPublic) }, salt: unb64u(V.salt) });
    expect(b64u(out)).toBe(V.body);
  });
  test("random encryption round-trips with a real UA key (decrypt independently)", async () => {
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const msg = new TextEncoder().encode(JSON.stringify({ title: "x", body: "héllo" }));
    const out = await encryptPayload({ p256dh: b64u(uaPub), auth: b64u(auth) }, msg);
    // decrypt per RFC 8291 §4
    const salt: Uint8Array<ArrayBuffer> = out.slice(0, 16), idlen = out[20], asPub = out.slice(21, 21 + idlen), ct = out.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
    const hk = async (s: BufferSource, ikm: BufferSource, info: BufferSource, n: number) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
    const e = new TextEncoder();
    const prk = await hk(auth, ecdh, new Uint8Array([...e.encode("WebPush: info\0"), ...uaPub, ...asPub]), 32);
    const cek = await hk(salt, prk, e.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hk(salt, prk, e.encode("Content-Encoding: nonce\0"), 12);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
    expect(pt[pt.length - 1]).toBe(2);
    expect(new TextDecoder().decode(pt.slice(0, -1))).toBe(JSON.stringify({ title: "x", body: "héllo" }));
  });
  test("rejects malformed subscription keys and oversized payloads", async () => {
    await expect(encryptPayload({ p256dh: "AAAA", auth: V.auth }, new Uint8Array(1))).rejects.toThrow("bad p256dh");
    await expect(encryptPayload({ p256dh: V.uaPublic, auth: "AAAA" }, new Uint8Array(1))).rejects.toThrow("bad auth");
    await expect(encryptPayload({ p256dh: V.uaPublic, auth: V.auth }, new Uint8Array(5000))).rejects.toThrow("too large");
  });
});

describe("VAPID", () => {
  test("JWT verifies with the public key, aud is the endpoint origin", async () => {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    const h = await vapidHeader("https://fcm.googleapis.com/fcm/send/abc", pub, jwk.d!, "https://app.example", 1000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(pub);
    expect(JSON.parse(new TextDecoder().decode(unb64u(m[2])))).toEqual({ aud: "https://fcm.googleapis.com", exp: 1000 + 43200, sub: "https://app.example" });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, unb64u(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`))).toBe(true);
  });
});

describe("endpoint allowlist + pushTo", () => {
  test("only real push services over https", () => {
    expect(validEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(validEndpoint("https://web.push.apple.com/x")).toBe(true);
    expect(validEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://evil.example/x", "https://fcm.googleapis.com.evil.example/x", "https://127.0.0.1/x", "https://fcm.googleapis.com:8443/x", "nope"]) expect(validEndpoint(bad)).toBe(false);
  });
  test("unconfigured = no-op reported; 410 deletes the subscription; 500 counted as failure", async () => {
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/1", p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
    const dels: string[] = [];
    const db = { prepare: (q: string) => ({ bind: (...b: unknown[]) => ({ run: async () => { if (q.startsWith("DELETE")) dels.push(String(b[0])); return {}; }, all: async () => ({ results: [sub] }) }), all: async () => ({ results: [sub] }) }) } as unknown as D1Database;
    expect((await pushTo({ DB: db }, "main", { title: "t", body: "b", url: "/" })).configured).toBe(false);
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const env = { DB: db, VAPID_PUBLIC_KEY: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))), VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", kp.privateKey)).d! };
    const seen: Request[] = [];
    const r410 = await pushTo(env, "main", { title: "t", body: "b", url: "/c/1", tag: "c1" }, (async (u: string, i: RequestInit) => { seen.push(new Request(u, i)); return new Response("", { status: 410 }); }) as never);
    expect(r410).toMatchObject({ removed: 1, sent: 0 }); expect(dels).toEqual([sub.endpoint]);
    expect(seen[0].headers.get("content-encoding")).toBe("aes128gcm"); expect(seen[0].headers.get("authorization")).toStartWith("vapid t=");
    const r500 = await pushTo(env, "main", { title: "t", body: "b", url: "/" }, (async () => new Response("boom", { status: 500 })) as never);
    expect(r500).toMatchObject({ failed: 1, sent: 0 }); expect(r500.errors[0]).toContain("500");
    const ok = await pushTo(env, "main", { title: "t", body: "b", url: "/" }, (async () => new Response("", { status: 201 })) as never);
    expect(ok.sent).toBe(1);
  });
});

test("notifyText", () => {
  expect(notifyText("done", "T", "  hello\n world ")).toEqual({ title: "T", body: "hello world" });
  expect(notifyText("awaiting", "", "").title).toBe("New chat");
  expect(notifyText("error", "T", "").body).toContain("retry");
  expect(notifyText("done", "T", "x".repeat(500)).body.length).toBe(140);
});

describe("push payload url carries the space", () => {
  test("withSpaceUrl: Business unchanged, Open gets ?space=open, idempotent, query/hash kept, non-paths untouched", () => {
    for (const sc of ["main", "e2e", "g:abc"] as const) expect(withSpaceUrl("/c/1?x=1", sc as Scope)).toBe("/c/1?x=1");
    expect(withSpaceUrl("/c/1", "main~open")).toBe("/c/1?space=open");
    expect(withSpaceUrl("/", "g:abc~open" as Scope)).toBe("/?space=open");
    expect(withSpaceUrl("/c/1?a=b#h", "main~open")).toBe("/c/1?a=b&space=open#h");
    expect(withSpaceUrl("/c/1?space=open", "main~open")).toBe("/c/1?space=open");
    expect(withSpaceUrl("/c/1?space=biz", "main~open")).toBe("/c/1?space=open");
    expect(withSpaceUrl("//evil.example/x", "main~open")).toBe("//evil.example/x");
  });
  test("pushTo queries only the sent scope's subscriptions and encrypts the space-tagged url", async () => {
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey)); const auth = crypto.getRandomValues(new Uint8Array(16));
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/1", p256dh: b64u(uaPub), auth: b64u(auth) };
    const queried: unknown[] = [];
    const db = { prepare: (q: string) => ({ bind: (...b: unknown[]) => ({ run: async () => ({}), all: async () => { queried.push(b[0]); return { results: b[0] === "main~open" ? [sub] : [] }; } }) }) } as unknown as D1Database;
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const env = { DB: db, VAPID_PUBLIC_KEY: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))), VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", kp.privateKey)).d! };
    let body: Uint8Array | null = null;
    const f = (async (_u: string, i: RequestInit) => { body = i.body as Uint8Array; return new Response("", { status: 201 }); }) as never;
    // Business send: the Open subscription is not delivered to.
    expect((await pushTo(env, "main", { title: "t", body: "b", url: "/c/1" }, f)).sent).toBe(0);
    const r = await pushTo(env, "main~open", { title: "t", body: "b", url: "/c/1", tag: "c1" }, f);
    expect(r.sent).toBe(1); expect(queried).toEqual(["main", "main~open"]);
    const out = body as unknown as Uint8Array; const salt = out.slice(0, 16), idlen = out[20], asPub = out.slice(21, 21 + idlen), ct = out.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
    const hk = async (s: BufferSource, ikm: BufferSource, info: BufferSource, n: number) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
    const e = new TextEncoder();
    const prk = await hk(auth, ecdh, new Uint8Array([...e.encode("WebPush: info\0"), ...uaPub, ...asPub]), 32);
    const cek = await hk(salt, prk, e.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hk(salt, prk, e.encode("Content-Encoding: nonce\0"), 12);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
    expect(JSON.parse(new TextDecoder().decode(pt.slice(0, -1))).url).toBe("/c/1?space=open");
  });
});
