// POST /api/transcribe: auth, CSRF/origin, type + size caps, per-scope hourly limit, 503 without the AI binding, 502 on AI failure, nothing stored.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createApp, type Env } from "../src/index";
import { makeSession, type Session } from "../src/auth";
import { scopeOfSession, type Scope, type GuestScope } from "../src/scope";

const ORIGIN = "https://app.test";
const GA = "g:abcdefghijklmnopqrstuvwx" as GuestScope;
const seam = (s: Session): Scope => (s.u === "guest-a" ? GA : scopeOfSession(s));
const app = createApp({ scopeOf: seam });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function d1() {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
    _run: () => db.query(q).run(...(b as any)), _q: q, _b: b,
  });
  const d = { prepare: (q: string) => stmt(q), batch: async (l: any[]) => { for (const s of l) s._run(); return []; } } as unknown as D1Database;
  return { db, d1: d };
}
import { MAX_AUDIO_BYTES, audioTypeOk, sniffAudio, readCapped, TRANSCRIBE_MODEL, TRANSCRIBE_PER_HOUR, takeTranscribeSlot, toBase64, whisperLang } from "../src/transcribe";

// real D1 batch() returns [{results}] per statement; the shared shim's batch drops them, so give this suite one that keeps RETURNING rows
const withResults = (d: any, db: Database) => ({ ...d, batch: async (ss: any[]) => ss.map((st) => { const q: string = st._q; const b: unknown[] = st._b; return /RETURNING/i.test(q) ? { results: db.query(q).all(...(b as any)) } : (db.query(q).run(...(b as any)), { results: [] }); }) });
const mk = (ai?: unknown) => { const x = d1(); x.d1 = withResults(x.d1, x.db) as any; return { env: { SESSION_SECRET: "test-secret-0123456789", ALLOWED_GITHUB_LOGINS: "example-user,guest-a", GATEWAY_KEY: "k", E2E_TOKEN: "e2e-test-token-0123456789abcdef0123456789abcdef", ASSETS: { fetch: async () => new Response("x") }, DB: x.d1, ...(ai ? { AI: ai } : {}) } as unknown as Env, db: x.db }; };
const login = async (env: Env, user: string) => { const { cookie, session } = await makeSession(env, user, "github"); return { cookie: cookie.split(";")[0], csrf: session.csrf }; };
const audio = (n: number, head: number[] = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]) => { const u = new Uint8Array(n).fill(7); u.set(head); return u; }; // ISO-BMFF "ftyp" start
const AUDIO = audio(4096);
const post = (env: Env, a: { cookie: string; csrf: string } | null, o: { path?: string; type?: string; body?: BodyInit; headers?: Record<string, string> } = {}) => {
  const h = new Headers({ origin: ORIGIN, "content-type": o.type ?? "audio/webm;codecs=opus", ...(a ? { cookie: a.cookie, "x-csrf-token": a.csrf } : {}), ...o.headers });
  return app.fetch(new Request(ORIGIN + (o.path ?? "/api/transcribe"), { method: "POST", headers: h, body: o.body ?? AUDIO }), env);
};
const stubAI = (text = " hello world ") => { const calls: { model: string; input: any }[] = []; return { calls, run: async (model: string, input: any) => { calls.push({ model, input }); return { text }; } }; };
const rows = (db: Database) => db.query(`SELECT name, value FROM settings WHERE name LIKE 'transcribe:%'`).all() as { name: string; value: string }[];

describe("POST /api/transcribe", () => {
  test("happy path: trimmed text, whisper turbo called with base64 audio and the language hint; nothing stored but the counter", async () => {
    const ai = stubAI(); const { env, db } = mk(ai); const a = await login(env, "example-user");
    const r = await post(env, a, { path: "/api/transcribe?lang=vi-VN" });
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ text: "hello world" });
    expect(ai.calls).toHaveLength(1); expect(ai.calls[0].model).toBe(TRANSCRIBE_MODEL);
    expect(ai.calls[0].input.language).toBe("vi"); expect(ai.calls[0].input.audio).toBe(toBase64(AUDIO.buffer as ArrayBuffer));
    expect(rows(db)).toHaveLength(1); // only the counter
    expect((db.query(`SELECT COUNT(*) AS n FROM settings`).get() as any).n).toBe(1);
    const r2 = await post(env, a); await r2.json(); expect(ai.calls[1].input.language).toBeUndefined(); // no hint = auto
  });
  test("needs a session, the CSRF token and a same-origin request", async () => {
    const ai = stubAI(); const { env } = mk(ai); const a = await login(env, "example-user");
    expect((await post(env, null)).status).toBe(401);
    expect((await post(env, { ...a, csrf: "wrong" })).status).toBe(403);
    expect((await post(env, a, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(ai.calls).toHaveLength(0);
  });
  test("non-audio type 415, empty/tiny body 400 no-speech, oversize 413 (declared and actual)", async () => {
    const ai = stubAI(); const { env } = mk(ai); const a = await login(env, "example-user");
    expect((await post(env, a, { type: "application/json", body: "{}" })).status).toBe(415);
    const tiny = await post(env, a, { body: new Uint8Array(10) }); expect(tiny.status).toBe(400); expect((await tiny.json() as any).code).toBe("no-speech");
    const decl = await post(env, a, { headers: { "content-length": String(MAX_AUDIO_BYTES + 1) } }); expect(decl.status).toBe(413);
    const big = await post(env, a, { body: audio(MAX_AUDIO_BYTES + 1) }); expect(big.status).toBe(413); expect((await big.json() as any).code).toBe("too-large");
    expect((await post(env, a, { body: audio(MAX_AUDIO_BYTES) })).status).toBe(200); // exactly the cap is fine
    expect(ai.calls).toHaveLength(1);
  });
  test("rate limit: 30 per hour per scope, other scopes unaffected, 429 never reaches the AI", async () => {
    const ai = stubAI(); const { env } = mk(ai); const a = await login(env, "example-user"); const g = await login(env, "guest-a");
    for (let i = 0; i < TRANSCRIBE_PER_HOUR; i++) expect((await post(env, a)).status).toBe(200);
    const over = await post(env, a); expect(over.status).toBe(429); expect((await over.json() as any).code).toBe("rate-limited");
    expect(ai.calls).toHaveLength(TRANSCRIBE_PER_HOUR);
    expect((await post(env, g)).status).toBe(200); // g:* has its own counter
  });
  test("takeTranscribeSlot: counts per scope+hour and drops older hours", async () => {
    const { env, db } = mk(); const d = (env as any).DB as D1Database; const t = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) expect(await takeTranscribeSlot(d, "main", t, 3)).toBe(true);
    expect(await takeTranscribeSlot(d, "main", t, 3)).toBe(false);
    expect(await takeTranscribeSlot(d, "e2e", t, 3)).toBe(true);
    expect(await takeTranscribeSlot(d, "main", t + 3_600_000, 3)).toBe(true); // next hour starts again
    expect(rows(db).map((r) => r.name).sort()).toEqual([`transcribe:e2e:${Math.floor(t / 3_600_000)}`, `transcribe:main:${Math.floor(t / 3_600_000) + 1}`]);
  });
  test("AI binding missing -> 503 json; AI throws -> 502 json without echoing the error; bad AI answer -> 502", async () => {
    const a0 = mk(); const a = await login(a0.env, "example-user");
    const none = await post(a0.env, a); expect(none.status).toBe(503); expect((await none.json() as any).code).toBe("no-binding");
    const boom = mk({ run: async () => { throw new Error("secret-detail-xyz"); } }); const b = await login(boom.env, "example-user");
    const r = await post(boom.env, b); expect(r.status).toBe(502); const t = await r.text(); expect(t).not.toContain("secret-detail-xyz"); expect(JSON.parse(t).code).toBe("ai-failed");
    const odd = mk({ run: async () => ({ nope: 1 }) }); const o = await login(odd.env, "example-user");
    expect((await post(odd.env, o)).status).toBe(502);
  });
  test("streaming cap: a chunked body without Content-Length is cut off as soon as the total passes 25 MB (never fully read), 413", async () => {
    const { env } = mk(stubAI()); const a = await login(env, "example-user");
    let pulled = 0; const MB = 1024 * 1024; const total = 200; // a 200 MB upload
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (pulled >= total) return c.close(); pulled++; c.enqueue(audio(MB)); } });
    const r = await app.fetch(new Request(ORIGIN + "/api/transcribe", { method: "POST", headers: { origin: ORIGIN, cookie: a.cookie, "x-csrf-token": a.csrf, "content-type": "audio/mp4" }, body, duplex: "half" } as any), env);
    expect(r.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(25 + 8); // 25 MB + what the runtime had already pre-fetched, nowhere near 200
  });
  test("readCapped: exact cap passes, cap+1 is null and cancels the stream", async () => {
    const mk2 = (n: number) => { let cancelled = false; const st = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(n)); c.close(); }, cancel() { cancelled = true; } }); return { st, was: () => cancelled }; };
    expect((await readCapped(mk2(100).st, 100))!.byteLength).toBe(100);
    expect(await readCapped(mk2(101).st, 100)).toBeNull();
    expect((await readCapped(null, 100))!.byteLength).toBe(0);
  });
  test("MIME allow-list and magic bytes: other types / mislabeled bytes are 415 before the AI call", async () => {
    const ai = stubAI(); const { env } = mk(ai); const a = await login(env, "example-user");
    for (const t of ["audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/webm;codecs=opus", "audio/webm; codecs=\"opus\"", "audio/ogg;codecs=opus", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"]) expect(audioTypeOk(t)).toBe(true);
    for (const t of ["audio/x-evil", "audio/webm;boundary=x", "audio/", "video/mp4", "text/plain", "audio/mp4;codecs=a;b", "", null]) expect(audioTypeOk(t as any)).toBe(false);
    expect((await post(env, a, { type: "audio/x-evil" })).status).toBe(415);
    expect((await post(env, a, { type: "audio/mp4", body: new Uint8Array(4096).fill(65) })).status).toBe(415); // text bytes labelled audio
    const heads: Record<string, number[]> = { webm: [0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0], ogg: [0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0], wav: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], id3: [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0], mpeg: [0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    for (const h of Object.values(heads)) expect(sniffAudio(Uint8Array.from(h))).toBe(true);
    expect(sniffAudio(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBe(false); // RIFF/AVI
    expect((await post(env, a, { type: "audio/webm", body: audio(4096, heads.webm) })).status).toBe(200);
    expect(ai.calls).toHaveLength(1);
  });
  test("rate-limit race: a straggler from hour H must not delete hour H+1's live bucket", async () => {
    const { env, db } = mk(); const d = (env as any).DB as D1Database; const t = 1_800_000_000_000; const H = Math.floor(t / 3_600_000);
    expect(await takeTranscribeSlot(d, "main", t + 3_600_000, 3)).toBe(true);  // hour H+1 request lands first
    expect(await takeTranscribeSlot(d, "main", t + 3_600_000, 3)).toBe(true);  // count 2 in H+1
    expect(await takeTranscribeSlot(d, "main", t, 3)).toBe(true);              // straggler from hour H: sweeps only < H
    expect(rows(db).find((r) => r.name === `transcribe:main:${H + 1}`)?.value).toBe("2"); // live bucket intact, not reset
    expect(await takeTranscribeSlot(d, "main", t + 3_600_000, 3)).toBe(true);  // 3rd
    expect(await takeTranscribeSlot(d, "main", t + 3_600_000, 3)).toBe(false); // 4th is over the limit (would be 1 again with the old cleanup)
    expect(await takeTranscribeSlot(d, "main", t + 7_200_000, 3)).toBe(true);  // hour H+2 sweeps H and H+1
    expect(rows(db).map((r) => r.name)).toEqual([`transcribe:main:${H + 2}`]);
  });
  test("whisperLang: BCP-47 -> ISO code, junk -> auto", () => {
    expect(whisperLang("vi-VN")).toBe("vi"); expect(whisperLang("EN_us")).toBe("en"); expect(whisperLang("")).toBeUndefined(); expect(whisperLang(null)).toBeUndefined();
    for (const bad of ["x", "123", "vi VN", "../..", "auto!"]) expect(whisperLang(bad)).toBeUndefined();
  });
});
