// POST /api/transcribe: the composer's recorded audio -> text through Cloudflare Workers AI (Whisper large-v3 turbo, `AI` binding).
// Nothing is stored (no R2, no D1 row of the audio or the text) and nothing about the content is logged; the only write is the per-scope hourly counter.
import type { Hono } from "hono";
import type { Env } from "./index";
import { quotaKey, type Scope } from "./scope";

export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 120;
export const MIN_AUDIO_BYTES = 1024; // anything smaller than 1 KB cannot hold speech
export const TRANSCRIBE_PER_HOUR = 30;

/** Whisper takes an ISO-639 code ("vi"), the Dictation setting stores a BCP-47 tag ("vi-VN"). Empty / invalid = auto-detect (undefined). */
export function whisperLang(v: string | null | undefined): string | undefined {
  const m = /^([a-z]{2,3})(?:[-_][A-Za-z0-9]+)*$/i.exec((v ?? "").trim());
  return m ? m[1].toLowerCase() : undefined;
}

export const hourBucket = (now: number): number => Math.floor(now / 3_600_000);

/** Allowed recorder output types: MediaRecorder gives audio/mp4 (iOS) or audio/webm / ogg; uploads of the other common audio containers are fine too. Only a `;codecs=` parameter is accepted. */
export const AUDIO_TYPE = /^audio\/(?:mp4|m4a|x-m4a|aac|webm|ogg|wav|x-wav|mpeg|mp3)(?:\s*;\s*codecs\s*=\s*"?[\w.,\- ]{1,60}"?)?$/i;
export const audioTypeOk = (header: string | null | undefined): boolean => AUDIO_TYPE.test((header ?? "").trim());

/** Cheap container sniff on the first bytes: ISO-BMFF `ftyp` (mp4/m4a), EBML (webm), OggS, RIFF....WAVE, ID3 or an MPEG/ADTS frame sync. */
export function sniffAudio(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const at = (o: number, t: string) => [...t].every((ch, i) => b[o + i] === ch.charCodeAt(0));
  return at(4, "ftyp") || (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) || at(0, "OggS") || (at(0, "RIFF") && at(8, "WAVE")) || at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
}

/** Read a request body but stop as soon as the running total passes `cap` (the rest is never read; the stream is cancelled). Holds at most cap + one chunk. null = over the cap. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader(); const parts: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/** Base64 without spreading a 25 MB array into String.fromCharCode. */
export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Counts this call against `scope`'s hour; false = over the limit. Settings row `transcribe:<scope>:<hour>` (counter only). One batch: bump the caller's own
 *  bucket and drop only buckets numerically OLDER than it, so a straggler from hour H can never delete the live bucket of hour H+1. */
export async function takeTranscribeSlot(db: D1Database, scope: Scope, now = Date.now(), limit = TRANSCRIBE_PER_HOUR): Promise<boolean> {
  const hour = hourBucket(now); const prefix = `transcribe:${quotaKey(scope)}:`; const name = `${prefix}${hour}`; // keyed by BASE: Business + Open share one hourly limit (Business key unchanged)
  const bump = db.prepare(`INSERT INTO settings (name, value) VALUES (?, '1') ON CONFLICT(name) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) RETURNING value`).bind(name);
  const sweep = db.prepare(`DELETE FROM settings WHERE name LIKE ? AND CAST(substr(name, ?) AS INTEGER) < ?`).bind(`${prefix}%`, prefix.length + 1, hour);
  const res = (await db.batch([bump, sweep])) as Array<{ results?: Array<{ value?: string }> }>;
  let v = res?.[0]?.results?.[0]?.value;
  if (v === undefined) v = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(name).first<{ value: string }>())?.value;
  return Number(v ?? 1) <= limit;
}

export function transcribeRoutes(app: Hono<{ Bindings: Env; Variables: { session: import("./auth").Session } }>, scopeOf: (c: any) => Scope) {
  const noStore = { "cache-control": "no-store" };
  app.post("/api/transcribe", async (c) => {
    const err = (status: 400 | 413 | 415 | 429 | 502 | 503, error: string, extra: Record<string, unknown> = {}) => c.json({ error, ...extra }, status, noStore);
    if (!c.env.AI) return err(503, "Voice transcription is not available on this deployment.", { code: "no-binding" });
    if (!audioTypeOk(c.req.header("content-type"))) return err(415, "Send the recording as audio.", { code: "bad-type" });
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_AUDIO_BYTES) return err(413, "That recording is too long (max 25 MB / 2 minutes).", { code: "too-large" }); // before reading a byte
    const buf = await readCapped(c.req.raw.body, MAX_AUDIO_BYTES);
    if (!buf) return err(413, "That recording is too long (max 25 MB / 2 minutes).", { code: "too-large" });
    if (buf.byteLength < MIN_AUDIO_BYTES) return err(400, "No speech detected.", { code: "no-speech" });
    if (!sniffAudio(buf)) return err(415, "That does not look like an audio recording.", { code: "bad-type" });
    if (!(await takeTranscribeSlot(c.env.DB, scopeOf(c)))) return err(429, `Voice limit reached (${TRANSCRIBE_PER_HOUR} per hour). Try again later.`, { code: "rate-limited" });
    const language = whisperLang(c.req.query("lang"));
    try {
      const out = (await c.env.AI.run(TRANSCRIBE_MODEL, { audio: toBase64(buf), ...(language ? { language } : {}) })) as { text?: unknown } | null;
      if (!out || typeof out.text !== "string") return err(502, "The transcription service returned no text.", { code: "bad-response" });
      return c.json({ text: out.text.trim() }, 200, noStore);
    } catch { return err(502, "The transcription service failed. Try again.", { code: "ai-failed" }); } // never log the error: it may echo audio metadata
  });
}
