import { describe, expect, it } from "vitest";
import { runScheduled, testApp } from "@cf-lite/testing";
import worker from "../server/worker";

// server/worker.ts in workerd: the cf-lite middleware gate in front of the Hono routes, real D1 (migrations applied per test), the real ChatSession DO.
const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");
const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64");
const now = Math.floor(Date.now() / 1000);
async function token(over: object = {}) {
  const head = b64u(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "k1" }));
  const body = b64u(JSON.stringify({ sub: "example-user", iat: now, exp: now + 3600, iss: "auth.internal.invalid", aud: "dev2", ...over }));
  return `${head}.${body}.${b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(head + "." + body)))}`;
}
const ORIGIN = "https://app.test";
const PAGE = "<!doctype html><title>spa</title>";
const E2E = "e2e-test-token-0123456789abcdef0123456789abcdef";
const app = (extra: object = {}) => testApp({
  worker, origin: ORIGIN,
  env: { SSO_PUBLIC_KEYS: JSON.stringify({ k1: pub }), ASSETS: { fetch: async () => new Response(PAGE, { headers: { "content-type": "text/html" } }) }, ...extra },
});
async function e2e(a = app()) {
  const r = await a.fetch("/auth/e2e", { method: "POST", headers: { "x-e2e-token": E2E, origin: ORIGIN } });
  expect(r.status).toBe(200);
  const me = (await (await a.fetch("/api/me")).json()) as { csrf: string };
  return { a, csrf: me.csrf };
}

describe("public surface", () => {
  it("/auth/config is open and carries the security headers", async () => {
    const r = await app().fetch("/auth/config");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ github: false, sso: true });
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("unknown /auth/* is a JSON 404; everything else falls to the ASSETS binding", async () => {
    const a = app();
    expect((await a.fetch("/auth/nope")).status).toBe(404);
    expect(await (await a.fetch("/some/spa/route")).text()).toBe(PAGE);
  });
  it("/auth/e2e: wrong token 401, missing E2E_TOKEN 404", async () => {
    expect((await app().fetch("/auth/e2e", { method: "POST", headers: { "x-e2e-token": "x".repeat(40) } })).status).toBe(401);
    expect((await app({ E2E_TOKEN: undefined }).fetch("/auth/e2e", { method: "POST", headers: { "x-e2e-token": E2E } })).status).toBe(404);
  });
});

describe("/api gate (server/middleware.ts)", () => {
  it("no session -> 401 JSON with no-store and security headers, on every /api path", async () => {
    for (const p of ["/api/me", "/api/conversations", "/api/models", "/api/nope"]) {
      const r = await app().fetch(p);
      expect(r.status, p).toBe(401);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
  it("e2e session: GET ok; mutation needs Origin + CSRF; unknown /api path -> 404 after the gate", async () => {
    const { a, csrf } = await e2e();
    expect(((await (await a.fetch("/api/me")).json()) as { via: string }).via).toBe("e2e");
    expect((await a.fetch("/api/conversations", { method: "POST", body: "{}", headers: { origin: ORIGIN } })).status).toBe(403);
    expect((await a.fetch("/api/conversations", { method: "POST", body: "{}", headers: { origin: "https://evil.test", "x-csrf-token": csrf } })).status).toBe(403);
    const made = await a.fetch("/api/conversations", { method: "POST", body: "{}", headers: { origin: ORIGIN, "x-csrf-token": csrf } });
    expect(made.status).toBe(201);
    expect(((await (await a.fetch("/api/conversations")).json()) as { conversations: unknown[] }).conversations).toHaveLength(1);
    expect((await a.fetch("/api/nope")).status).toBe(404);
  });
  it("shared SSO cookie: GET /api/me exchanges it for our own session; a stranger's does not", async () => {
    const a = app();
    const r = await a.fetch("/api/me", { headers: { cookie: `sso=${await token()}`, "sec-fetch-site": "same-origin" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { sso: boolean }).sso).toBe(true);
    expect((await a.fetch("/api/conversations")).status).toBe(200); // the exchanged __Host- cookie was replayed
    expect((await app().fetch("/api/me", { headers: { cookie: `sso=${await token({ sub: "stranger" })}` } })).status).toBe(401);
  });
  it("push routes are closed to the e2e user (except /config)", async () => {
    const { a } = await e2e();
    expect((await a.fetch("/api/push/config")).status).toBe(200);
    expect((await a.fetch("/api/push/test", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(403);
  });
});

describe("Durable Object + WebSocket", () => {
  it("/api/conversations/:id/ws upgrades through the gate to the ChatSession DO and sends its hello frame", async () => {
    const { a, csrf } = await e2e();
    const id = ((await (await a.fetch("/api/conversations", { method: "POST", body: "{}", headers: { origin: ORIGIN, "x-csrf-token": csrf } })).json()) as { id: string }).id;
    expect((await a.fetch(`/api/conversations/${id}/ws`)).status).toBe(426);
    expect((await a.fetch(`/api/conversations/${id}/ws`, { headers: { upgrade: "websocket" } })).status).toBe(403); // upgrade without Origin
    const r = await a.fetch(`/api/conversations/${id}/ws?since=0`, { headers: { upgrade: "websocket", origin: ORIGIN } });
    expect(r.status).toBe(101);
    const ws = r.webSocket!;
    ws.accept();
    const first = await new Promise<string>((res) => ws.addEventListener("message", (e) => res(String(e.data))));
    expect(JSON.parse(first).t).toBe("hello");
    ws.close();
    const st = (await (await a.fetch(`/api/conversations/${id}`)).json()) as { state: unknown };
    expect(st.state).toBeTruthy(); // /state answered by the DO
  });
});

describe("cron", () => {
  it("scheduled() runs the three watchers without the optional bindings", async () => {
    await runScheduled(worker);
  });
});
