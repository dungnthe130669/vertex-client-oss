// In-app provider keys: crypto, per-base isolation, delete, never in a response/log, 409s, resolution order, and the REAL PUT/GET handlers (user-keys-ui.test.tsx drives them into the real settings page).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Env } from "../src/index";
import type { GuestScope } from "../src/scope";
import { buildRegistry } from "../src/providers/registry";
import { openaiCompatProvider } from "../src/providers/openai-compat";
import { loadProviderConfigs } from "../src/providers/config";
import { decryptKey, deleteUserKey, encryptKey, putUserKey, readBodyCapped, userKeyIds, userKeyOf, userKeysFor, validateKey } from "../src/user-keys";
import { putAllowed, resetPutLimit } from "../src/provider-routes";
import { setOpenFlag } from "../src/open-space";
import { makeSession } from "../src/auth";

import { SECRET, FAKE, FAKE_B, gw, GA, upstream, fetchImpl, app, mkEnv, call } from "./user-keys-harness";

// log spy: every console.* call of a test is captured and must never contain a key
const logs: string[] = []; let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => { resetPutLimit(); logs.length = 0; upstream.length = 0; spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); })); });
afterEach(() => { spies.forEach((s) => s.mockRestore()); });
const noKeyIn = (...s: string[]) => { for (const k of [FAKE, FAKE_B]) for (const t of [...s, ...logs]) expect(t).not.toContain(k); };
const ERICH = "example-user";
const ORIGIN = "https://integrate.api.nvidia.com";
const ok = (k: string) => ({ kind: "key" as const, key: k });
const none = { kind: "none" as const };

describe("crypto", () => {
  test("round trip; iv is random per encryption; ciphertext does not contain the plaintext", async () => {
    const a = await encryptKey(SECRET, "main", "nvidia", ORIGIN, FAKE), b = await encryptKey(SECRET, "main", "nvidia", ORIGIN, FAKE);
    expect(await decryptKey(SECRET, "main", "nvidia", { ...a, origin: ORIGIN })).toBe(FAKE);
    expect(a.iv).not.toBe(b.iv); expect(a.ct).not.toBe(b.ct); expect(atob(a.iv)).toHaveLength(12);
    expect(a.ct + a.iv).not.toContain(FAKE); expect(atob(a.ct)).not.toContain(FAKE);
  });
  test("wrong base, wrong provider, wrong secret, tampered ciphertext and tampered iv all fail", async () => {
    const a = await encryptKey(SECRET, "main", "nvidia", ORIGIN, FAKE);
    await expect(decryptKey(SECRET, "g:other", "nvidia", { ...a, origin: ORIGIN })).rejects.toThrow();
    await expect(decryptKey(SECRET, "main", "acme", { ...a, origin: ORIGIN })).rejects.toThrow();
    await expect(decryptKey(SECRET, "main", "nvidia", { ...a, origin: "https://evil.example" })).rejects.toThrow(); // origin is in the AAD
    await expect(decryptKey("another-secret-0123456789", "main", "nvidia", { ...a, origin: ORIGIN })).rejects.toThrow();
    const raw = Uint8Array.from(atob(a.ct), (c) => c.charCodeAt(0)); raw[0]! ^= 1;
    await expect(decryptKey(SECRET, "main", "nvidia", { ...a, origin: ORIGIN, ct: btoa(String.fromCharCode(...raw)) })).rejects.toThrow();
    const iv = Uint8Array.from(atob(a.iv), (c) => c.charCodeAt(0)); iv[0]! ^= 1;
    await expect(decryptKey(SECRET, "main", "nvidia", { ...a, origin: ORIGIN, iv: btoa(String.fromCharCode(...iv)) })).rejects.toThrow();
  });
  test("no secret / a space-qualified base is refused", async () => {
    await expect(encryptKey("", "main", "nvidia", ORIGIN, FAKE)).rejects.toThrow();
    await expect(encryptKey(SECRET, "main~open", "nvidia", ORIGIN, FAKE)).rejects.toThrow();
  });
  test("validateKey: trims, 8..512, no whitespace", () => {
    expect(validateKey(`  ${FAKE}  `)).toBe(FAKE);
    for (const bad of ["short", "a".repeat(513), "has space inside1", "tab\tinside12", "line\nbreak123", 12345678, null, undefined]) expect(validateKey(bad), String(bad)).toBeNull();
    expect(validateKey("a".repeat(512))).not.toBeNull(); expect(validateKey("a".repeat(8))).not.toBeNull();
  });
});

describe("store: per-base isolation and delete", () => {
  test("user A's key never resolves for user B or another provider; delete takes effect immediately", async () => {
    const e = mkEnv(); const env = { DB: e.DB, KEY_ENC_SECRET: SECRET };
    await putUserKey(env, "main", "nvidia", ORIGIN, FAKE); await putUserKey(env, GA, "nvidia", ORIGIN, FAKE_B);
    expect(await userKeyOf(env, "main", "nvidia", ORIGIN)).toEqual(ok(FAKE)); expect(await userKeyOf(env, GA, "nvidia", ORIGIN)).toEqual(ok(FAKE_B));
    expect(await userKeyOf(env, "main", "acme", ORIGIN)).toEqual(none); expect(await userKeyOf(env, "g:zzzzzzzzzzzzzzzzzzzzzzzz" as GuestScope, "nvidia", ORIGIN)).toEqual(none);
    // a row copied into another base's slot does not decrypt (AAD binding)
    e._db.query(`UPDATE provider_user_keys SET ct=(SELECT ct FROM provider_user_keys WHERE base='main'), iv=(SELECT iv FROM provider_user_keys WHERE base='main') WHERE base=?`).run(GA);
    expect(await userKeyOf(env, GA, "nvidia", ORIGIN)).toEqual({ kind: "error" }); // row present but unreadable: fail closed, not "none"
    expect([...(await userKeyIds(e.DB, "main")).keys()]).toEqual(["nvidia"]);
    await deleteUserKey(e.DB, "main", "nvidia");
    expect(await userKeyOf(env, "main", "nvidia", ORIGIN)).toEqual(none); expect((await userKeyIds(e.DB, "main")).size).toBe(0);
  });
  test("no KEY_ENC_SECRET but a row present => fail closed (a Worker secret must not silently replace it)", async () => {
    const e = mkEnv(); await putUserKey({ DB: e.DB, KEY_ENC_SECRET: SECRET }, "main", "nvidia", ORIGIN, FAKE);
    expect(await userKeyOf({ DB: e.DB }, "main", "nvidia", ORIGIN)).toEqual({ kind: "error" }); expect(await userKeyOf({ DB: e.DB }, "main", "acme", ORIGIN)).toEqual(none);
  });
});

describe("handlers", () => {
  const put = (env: Env, key: unknown, user = ERICH) => call(env, user, "PUT", "/api/providers/nvidia/key", { key });
  const list = async (env: Env) => ((await (await call(env, ERICH, "GET", "/api/providers", undefined, "open")).json()) as any).providers.find((p: any) => p.id === "nvidia");
  const withProvider = async <E extends Env>(env: E) => { expect((await call(env, ERICH, "PUT", "/api/providers/nvidia", { models: ["a/x"] })).status).toBe(200); return env; };

  test("PUT stores encrypted, key_source becomes user, responses/logs never contain the key or ciphertext; DELETE falls back to worker/none", async () => {
    const env = await withProvider(mkEnv()); const bodies: string[] = [];
    expect((await list(env)).key_source).toBe("none");
    const r = await put(env, `  ${FAKE}  `); bodies.push(await r.clone().text()); expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true, key_source: "user" });
    const row = env._db.query(`SELECT * FROM provider_user_keys`).get() as any; expect(row.base).toBe("main"); expect(row.provider_id).toBe("nvidia"); expect(JSON.stringify(row)).not.toContain(FAKE);
    for (const p of ["/api/providers", "/api/providers/configured", "/api/providers/presets"]) { const t = await (await call(env, ERICH, "GET", p, undefined, "open")).text(); bodies.push(t); expect(t, p).not.toContain(row.ct); expect(t).not.toContain(row.iv); }
    const l = await list(env); expect(l).toMatchObject({ key_source: "user", keySet: true, status: "enabled" });
    expect(((await (await call(env, ERICH, "GET", "/api/providers/configured")).json()) as any).providers[0]).toMatchObject({ key_source: "user", keySet: true });
    const d = await call(env, ERICH, "DELETE", "/api/providers/nvidia/key"); bodies.push(await d.clone().text()); expect(await d.json()).toEqual({ ok: true, key_source: "none" });
    expect((await list(env)).key_source).toBe("none"); expect((await list(env)).status).toBe("needs-key");
    noKeyIn(...bodies);
  });
  test("a worker secret shows 'worker'; the user key wins over it and removing it falls back to the worker secret", async () => {
    const env = await withProvider(mkEnv({ worker: "worker-secret-key-123456" }));
    expect((await list(env)).key_source).toBe("worker");
    await put(env, FAKE); expect((await list(env)).key_source).toBe("user");
    expect(((await (await call(env, ERICH, "DELETE", "/api/providers/nvidia/key")).json()) as any).key_source).toBe("worker");
    expect((await list(env)).key_source).toBe("worker");
  });
  test("KEY_ENC_SECRET unset => PUT 409 'key storage not configured', nothing stored; everything else (worker secret path) keeps working", async () => {
    const env = await withProvider(mkEnv({ secret: false, worker: "worker-secret-key-123456" }));
    const r = await put(env, FAKE); expect(r.status).toBe(409); expect(((await r.json()) as any).error).toBe("key storage not configured");
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_user_keys`).get()).toEqual({ n: 0 });
    expect((await list(env)).key_source).toBe("worker");
    expect((await call(env, ERICH, "POST", "/api/providers/nvidia/models")).status).toBe(200);
    expect((await call(env, ERICH, "DELETE", "/api/providers/nvidia/key")).status).toBe(200);
    noKeyIn();
  });
  test("before migration 0027: PUT and DELETE answer a controlled 409; GET /api/providers and /api/models still work", async () => {
    const env = await withProvider(mkEnv({ skip: ["0027"] }));
    for (const r of [await put(env, FAKE), await call(env, ERICH, "DELETE", "/api/providers/nvidia/key")]) { expect(r.status).toBe(409); expect(((await r.json()) as any).error).toMatch(/migration required.*0027/); }
    expect((await call(env, ERICH, "GET", "/api/providers")).status).toBe(200); expect((await call(env, ERICH, "GET", "/api/models", undefined, "open")).status).toBe(200);
    expect((await list(env)).key_source).toBe("none");
    noKeyIn();
  });
  test("validation, body bound, unknown provider; guests and e2e are refused; nothing stored on any refusal", async () => {
    const env = await withProvider(mkEnv());
    for (const bad of ["short", "has a space inside", "x".repeat(513), 42, null]) expect((await put(env, bad)).status, String(bad)).toBe(400);
    expect((await call(env, ERICH, "PUT", "/api/providers/nvidia/key", undefined, undefined, "not json")).status).toBe(400);
    expect((await call(env, ERICH, "PUT", "/api/providers/nvidia/key", undefined, undefined, JSON.stringify({ key: FAKE, pad: "x".repeat(5000) }))).status).toBe(413);
    expect((await call(env, ERICH, "PUT", "/api/providers/nope/key", { key: FAKE })).status).toBe(404);
    expect((await call(env, ERICH, "PUT", "/api/providers/gateway/key", { key: FAKE })).status).toBe(400);
    await setOpenFlag(env.DB!, GA, false); // Open is default-on for team users; the kill switch row makes the guest refusal apply
    for (const u of ["guest-a", "e2e"]) { expect((await put(env, FAKE, u)).status, u).toBe(403); expect((await call(env, u, "DELETE", "/api/providers/nvidia/key")).status, u).toBe(403); }
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_user_keys`).get()).toEqual({ n: 0 });
    noKeyIn();
  });
  test("PUT is rate limited per base", async () => {
    const t = 1_000_000; for (let i = 0; i < 10; i++) expect(putAllowed("rl-base", t + i)).toBe(true);
    expect(putAllowed("rl-base", t + 11)).toBe(false); expect(putAllowed("rl-other", t + 11)).toBe(true); expect(putAllowed("rl-base", t + 61_000)).toBe(true);
  });
  test("audit line carries op/provider/base only", async () => {
    const env = await withProvider(mkEnv()); await put(env, FAKE); await call(env, ERICH, "DELETE", "/api/providers/nvidia/key");
    const a = logs.filter((l) => l.includes("provider-key")); expect(a).toHaveLength(2); expect(JSON.parse(a[0]!)).toEqual({ audit: "provider-key", op: "put", base: "main", provider: "nvidia" });
    noKeyIn();
  });
});

describe("call path: user key reaches the provider", () => {
  const cfgOf = async (env: Env) => { await call(env, ERICH, "PUT", "/api/providers/nvidia", { models: ["a/x"] }); return loadProviderConfigs(env.DB, "main"); };
  const send = (reg: ReturnType<typeof buildRegistry>) => reg.router.messages({ model: "nvidia:a/x", max_tokens: 5, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then((r) => r.text());
  const registry = async (env: Env, base: "main" = "main") => buildRegistry({ scope: "main~open" as never, gateway: gw, extra: await cfgOf(env), env: env as unknown as Record<string, unknown>, fetchImpl, userKeys: userKeysFor(env, base, await userKeyIds(env.DB, base)) });

  test("model 'nvidia:a/x' with a stored key: Authorization Bearer uses the USER key (not the worker secret); after delete the next call uses the worker secret", async () => {
    const env = mkEnv({ worker: "worker-secret-key-123456" }); await cfgOf(env); await putUserKey({ DB: env.DB, KEY_ENC_SECRET: SECRET }, "main", "nvidia", ORIGIN, FAKE);
    const reg = await registry(env);
    await send(reg); expect(upstream.at(-1)!.url).toContain("/chat/completions"); expect(upstream.at(-1)!.headers.authorization).toBe(`Bearer ${FAKE}`);
    await deleteUserKey(env.DB, "main", "nvidia"); // same registry object (a running ChatSession): the very next call must not use the deleted key
    await send(reg); expect(upstream.at(-1)!.headers.authorization).toBe("Bearer worker-secret-key-123456");
    noKeyIn();
  });
  test("deleted key and no worker secret: the next call fails with 'no key configured' and sends nothing upstream", async () => {
    const env = mkEnv(); await cfgOf(env); await putUserKey({ DB: env.DB, KEY_ENC_SECRET: SECRET }, "main", "nvidia", ORIGIN, FAKE);
    const reg = await registry(env); await deleteUserKey(env.DB, "main", "nvidia"); upstream.length = 0;
    await expect(send(reg)).rejects.toMatchObject({ status: 503 }); expect(upstream).toHaveLength(0);
  });
  test("user B's registry (other base) never uses user A's key; Business scope never lists the provider", async () => {
    const env = mkEnv(); const cfgs = await cfgOf(env); await putUserKey({ DB: env.DB, KEY_ENC_SECRET: SECRET }, "main", "nvidia", ORIGIN, FAKE);
    const b = buildRegistry({ scope: `${GA}~open` as never, gateway: null, extra: cfgs.map((c) => ({ ...c, allowGuests: true })), env: env as unknown as Record<string, unknown>, fetchImpl, userKeys: userKeysFor(env, GA, await userKeyIds(env.DB, GA)) });
    expect(b.list().find((p) => p.id === "nvidia")).toMatchObject({ status: "needs-key", key_source: "none" }); // A's key is invisible to B: not live
    await expect(send(b)).rejects.toBeDefined(); expect(upstream.filter((u) => u.url.includes("/chat/completions"))).toHaveLength(0);
  });
  test("Open for a base without any provider config / key: providerFor still never hands out the gateway key", async () => {
    const { providerFor } = await import("../src/scope");
    expect(() => providerFor("main~open" as never, () => "gateway-key")).toThrow(/no provider for scope/);
  });
  test("test-connection (POST /models) uses the user key", async () => {
    const env = mkEnv(); await cfgOf(env); await putUserKey({ DB: env.DB, KEY_ENC_SECRET: SECRET }, "main", "nvidia", ORIGIN, FAKE);
    expect((await call(env, ERICH, "POST", "/api/providers/nvidia/models")).status).toBe(200);
    expect(upstream.at(-1)!.headers.authorization).toBe(`Bearer ${FAKE}`);
  });
});

describe("origin binding, fail-closed, streamed body cap", () => {
  const WORKER = "worker-secret-key-123456";
  const cfgOf = async (env: Env) => { await call(env, ERICH, "PUT", "/api/providers/nvidia", { models: ["a/x"] }); return loadProviderConfigs(env.DB, "main"); };
  const send = (reg: ReturnType<typeof buildRegistry>) => reg.router.messages({ model: "nvidia:a/x", max_tokens: 5, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then((r) => r.text());
  const reg = async (env: Env) => buildRegistry({ scope: "main~open" as never, gateway: gw, extra: await loadProviderConfigs(env.DB, "main"), env: env as unknown as Record<string, unknown>, fetchImpl, userKeys: userKeysFor(env, "main", await userKeyIds(env.DB, "main")) });
  const chat = (r: ReturnType<typeof buildRegistry>) => r.list().find((p) => p.id === "nvidia");
  const listed = async (env: Env) => ((await (await call(env, ERICH, "GET", "/api/providers", undefined, "open")).json()) as any).providers.find((p: any) => p.id === "nvidia");

  test("PUT stores the origin the key is bound to", async () => {
    const env = mkEnv(); await cfgOf(env); expect((await call(env, ERICH, "PUT", "/api/providers/nvidia/key", { key: FAKE })).status).toBe(200);
    expect((env._db.query(`SELECT origin FROM provider_user_keys`).get() as any).origin).toBe(ORIGIN);
  });
  test("baseUrl origin changed (row edited / config moved): NO upstream call, NO Worker-secret fallback, clear error; key_source 'stale'", async () => {
    const env = mkEnv({ worker: WORKER }); await cfgOf(env); await putUserKey({ DB: env.DB, KEY_ENC_SECRET: SECRET }, "main", "nvidia", ORIGIN, FAKE);
    // bypass the PUT handler (which would purge the key): move the provider straight in D1
    env._db.query(`UPDATE provider_configs SET base_url='https://attacker.example/v1' WHERE id='nvidia'`).run();
    const r = await reg(env); upstream.length = 0;
    await expect(send(r)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/URL changed.*re-enter/) });
    expect(upstream).toHaveLength(0);
    expect(chat(r)).toMatchObject({ key_source: "stale" });
    expect((await listed(env)).key_source).toBe("stale");
    // test-connection must not leak it either
    const m = await call(env, ERICH, "POST", "/api/providers/nvidia/models"); expect(m.status).toBe(409); expect(upstream).toHaveLength(0);
    noKeyIn(await m.text());
  });
  test("saving the provider with a different origin deletes the stored key; same-origin edits keep it", async () => {
    const env = mkEnv({ worker: WORKER }); await cfgOf(env); await call(env, ERICH, "PUT", "/api/providers/nvidia/key", { key: FAKE });
    expect((await call(env, ERICH, "PUT", "/api/providers/nvidia", { baseUrl: "https://integrate.api.nvidia.com/v2" })).status).toBe(200);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_user_keys`).get()).toEqual({ n: 1 });
    const r = await call(env, ERICH, "PUT", "/api/providers/nvidia", { baseUrl: "https://attacker.example/v1" });
    expect(r.status).toBe(200); expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_user_keys`).get()).toEqual({ n: 0 });
    expect(((await r.json()) as any).provider.key_source).toBe("none"); // the shared Worker secret is NOT usable at a non-preset origin either
    noKeyIn();
  });
  test("nvidia baseUrl edited to https://evil.example/v1 (no user key, Worker secret set): zero upstream fetches, in chat and test-connection, key_source none", async () => {
    const env = mkEnv({ worker: WORKER }); await cfgOf(env);
    expect((await call(env, ERICH, "PUT", "/api/providers/nvidia", { baseUrl: "https://evil.example/v1" })).status).toBe(200);
    const r = await reg(env); upstream.length = 0;
    await expect(send(r)).rejects.toThrow(); // registry: not usable (no allowed key) => never reaches the adapter
    // the adapter itself (chat path) refuses too, even when handed the config directly
    const direct = openaiCompatProvider((await loadProviderConfigs(env.DB, "main"))[0]!, env as unknown as Record<string, unknown>, fetchImpl);
    await expect(direct.messages({ model: "a/x", max_tokens: 5, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/URL changed.*re-enter/) });
    const m = await call(env, ERICH, "POST", "/api/providers/nvidia/models"); expect(m.status).toBe(409);
    expect(upstream).toHaveLength(0); expect(upstream.filter((u: any) => u.headers?.authorization)).toHaveLength(0);
    expect(chat(r)).toMatchObject({ key_source: "none" });
    noKeyIn(await m.text());
  });
  test("a custom (non-preset) provider never gets a Worker secret", async () => {
    const env = mkEnv({ worker: WORKER }); await call(env, ERICH, "PUT", "/api/providers/zed", { baseUrl: "https://api.zed.example/v1", models: ["a/x"] });
    (env as any).PROVIDER_KEY_ZED = WORKER;
    const m = await call(env, ERICH, "POST", "/api/providers/zed/models"); expect(m.status).toBe(409); expect(upstream).toHaveLength(0);
  });
  test("provider delete removes its key rows; a failing key delete aborts (provider row stays)", async () => {
    const env = mkEnv(); await cfgOf(env); await call(env, ERICH, "PUT", "/api/providers/nvidia/key", { key: FAKE });
    expect((await call(env, ERICH, "DELETE", "/api/providers/nvidia")).status).toBe(200);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_user_keys`).get()).toEqual({ n: 0 });
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_configs`).get()).toEqual({ n: 0 });
    const e2 = mkEnv(); await cfgOf(e2); await call(e2, ERICH, "PUT", "/api/providers/nvidia/key", { key: FAKE });
    e2._db.exec(`ALTER TABLE provider_user_keys RENAME COLUMN provider_id TO pid_broken`);
    expect((await call(e2, ERICH, "DELETE", "/api/providers/nvidia")).status).toBe(500);
    expect(e2._db.query(`SELECT COUNT(*) AS n FROM provider_configs`).get()).toEqual({ n: 1 });
  });
  test("tampered row (ciphertext, iv, origin forged to match) => fail closed: error, no upstream call, no Worker-secret fallback", async () => {
    for (const sql of [`UPDATE provider_user_keys SET ct='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'`, `UPDATE provider_user_keys SET iv='AAAAAAAAAAAAAAAA'`, `UPDATE provider_user_keys SET ct='%%not base64%%'`]) {
      const env = mkEnv({ worker: WORKER }); await cfgOf(env); await putUserKey({ DB: env.DB, KEY_ENC_SECRET: SECRET }, "main", "nvidia", ORIGIN, FAKE); env._db.query(sql).run();
      const r = await reg(env); upstream.length = 0;
      await expect(send(r), sql).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/could not be read/) }); expect(upstream, sql).toHaveLength(0);
    }
    // origin column rewritten to the attacker's origin AND the config moved there: AAD no longer matches
    const env = mkEnv({ worker: WORKER }); await cfgOf(env); await putUserKey({ DB: env.DB, KEY_ENC_SECRET: SECRET }, "main", "nvidia", ORIGIN, FAKE);
    env._db.query(`UPDATE provider_user_keys SET origin='https://attacker.example'`).run(); env._db.query(`UPDATE provider_configs SET base_url='https://attacker.example/v1' WHERE id='nvidia'`).run();
    const r = await reg(env); upstream.length = 0; await expect(send(r)).rejects.toMatchObject({ status: 500 }); expect(upstream).toHaveLength(0);
  });
  test("wrong/missing KEY_ENC_SECRET with a row present => fail closed, no upstream call (test-connection too)", async () => {
    const env = mkEnv({ worker: WORKER }); await cfgOf(env); await putUserKey({ DB: env.DB, KEY_ENC_SECRET: SECRET }, "main", "nvidia", ORIGIN, FAKE);
    for (const secret of ["a-different-secret-0123456789", undefined]) {
      (env as any).KEY_ENC_SECRET = secret; const r = await reg(env); upstream.length = 0;
      await expect(send(r)).rejects.toMatchObject({ status: 500 }); expect(upstream).toHaveLength(0);
      expect((await call(env, ERICH, "POST", "/api/providers/nvidia/models")).status).toBe(500); expect(upstream).toHaveLength(0);
    }
  });
  test("D1 error on the key lookup => fail closed even though the presence read failed too (no Worker-secret fallback); 'no row' still falls back", async () => {
    const env = mkEnv({ worker: WORKER }); await cfgOf(env);
    const r0 = await reg(env); upstream.length = 0; await send(r0); expect(upstream.at(-1)!.headers.authorization).toBe(`Bearer ${WORKER}`); // no row: fallback OK
    env._db.exec(`ALTER TABLE provider_user_keys RENAME COLUMN ct TO ct_broken`); // every lookup now errors, and it is not "no such table"
    const r = await reg(env); upstream.length = 0;
    await expect(send(r)).rejects.toMatchObject({ status: 500 }); expect(upstream).toHaveLength(0);
  });
  test("readBodyCapped: Content-Length over the cap is rejected without reading; a chunked body is cut at the cap and the stream is cancelled", async () => {
    let pulled = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024).fill(120)); if (pulled > 1000) c.close(); }, cancel() { cancelled = true; } });
    const req = new Request("https://x.test/", { method: "PUT", body: stream, duplex: "half" } as RequestInit);
    expect(await readBodyCapped(req)).toBeNull(); expect(cancelled).toBe(true); expect(pulled).toBeLessThan(20); // 4 KB cap, nowhere near all 1000 chunks
    let touched = false; // a declared length over the cap is refused before `body` is even looked at
    const big = { headers: new Headers({ "content-length": "999999" }), get body() { touched = true; return null; } } as unknown as Request;
    expect(await readBodyCapped(big)).toBeNull(); expect(touched).toBe(false);
    expect(await readBodyCapped(new Request("https://x.test/", { method: "PUT", body: JSON.stringify({ key: FAKE }) }))).toBe(JSON.stringify({ key: FAKE }));
  });
  test("PUT /key with an oversized chunked body (no Content-Length) => 413 and nothing stored", async () => {
    const env = mkEnv(); await cfgOf(env); const m = await makeSession(env, ERICH, "github");
    let pulled = 0; const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode("x".repeat(1024))); if (pulled > 5000) c.close(); } });
    const res = await app.fetch(new Request("https://app.test/api/providers/nvidia/key", { method: "PUT", headers: { cookie: m.cookie.split(";")[0]!, origin: "https://app.test", "x-csrf-token": m.session.csrf, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit), env);
    expect(res.status).toBe(413); expect(pulled).toBeLessThan(100);
    expect(env._db.query(`SELECT COUNT(*) AS n FROM provider_user_keys`).get()).toEqual({ n: 0 });
  });
});

describe("static guards", () => {
  test("no console.* call in src/ or web/src mentions a key variable; the key module and routes never log values", () => {
    const files = ["src/user-keys.ts", "src/provider-routes.ts", "src/providers/openai-compat.ts", "src/providers/registry.ts", "web/src/provider-key-logic.ts", "web/src/settings-pages.tsx", "web/src/api.ts"];
    for (const f of files) for (const [i, line] of readFileSync(new URL(`../${f}`, import.meta.url), "utf8").split("\n").entries()) {
      if (!/console\.\w+\(/.test(line)) continue;
      expect(line, `${f}:${i + 1}`).not.toMatch(/[,(]\s*(key|keyInput|plain|plaintext|secret|ct|iv|k|value|v)\s*[,)]|\$\{\s*(key|keyInput|plain|plaintext|secret)\b/);
    }
  });
  test("web: the key is never put in localStorage/sessionStorage", () => {
    for (const f of ["web/src/provider-key-logic.ts", "web/src/settings-pages.tsx"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      for (const l of src.split("\n")) if (/keyInput|saveKey/.test(l)) expect(l).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});
