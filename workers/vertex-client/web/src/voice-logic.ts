// Pure pieces of the recorded-voice composer (MediaRecorder -> POST /api/transcribe): mime choice, limits, the state machine, text insertion, level maths and the
// error wording. No DOM, no MediaRecorder here, so bun:test covers all of it; voice.ts is the browser wrapper and VoiceBar (voice-bar.tsx) the UI.

export const MAX_SECONDS = 120;
export const MAX_BYTES = 25 * 1024 * 1024;
export const MIN_MS = 1000;
/** Peak level (0..1 RMS of the time-domain signal) below which a recording counts as silent. Deliberately tiny: a quiet room is ~0.003, speech >0.02. */
export const SILENCE_PEAK = 0.008;

/** iOS Safari records audio/mp4 only; elsewhere webm/opus is the best supported (then mp4 for Safari desktop, then ogg). null = MediaRecorder cannot record audio here. */
export function pickMime(isSupported: (mime: string) => boolean, ios: boolean): string | null {
  const order = ios ? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"] : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return order.find((m) => { try { return isSupported(m); } catch { return false; } }) ?? null;
}
export const isIOS = (ua: string, maxTouchPoints = 0): boolean => /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);

export type VoiceErr = "denied" | "no-mic" | "no-speech" | "too-long" | "offline" | "rate-limited" | "unavailable" | "failed";
export type VoicePhase = "idle" | "starting" | "recording" | "transcribing" | "error";
export interface VoiceState { phase: VoicePhase; error: VoiceErr | null; /** the recording is kept so Retry can resend it (service / offline errors only) */ keep: boolean }
export const VOICE_IDLE: VoiceState = { phase: "idle", error: null, keep: false };
export type VoiceEvent =
  | { t: "tap" }                                                      // the mic button (idle -> asks for the microphone)
  | { t: "granted" }                                                  // getUserMedia resolved and the recorder started
  | { t: "fail"; err: VoiceErr; keep?: boolean }                      // permission / device / upload / service failure
  | { t: "stop"; ms: number; peak: number; bytes: number }            // Stop pressed (or the 2-minute cap hit): the recording is finished
  | { t: "cancel" }                                                   // Cancel, unmount, or the page went to the background
  | { t: "text"; text: string }                                       // transcription arrived
  | { t: "retry" };                                                   // the error bar's Retry
export type VoiceEffect = "request-mic" | "finalize" | "discard" | "send" | "insert" | null;

export function voiceReduce(s: VoiceState, e: VoiceEvent): { s: VoiceState; effect: VoiceEffect } {
  switch (e.t) {
    case "tap": return s.phase === "idle" ? { s: { phase: "starting", error: null, keep: false }, effect: "request-mic" } : { s, effect: null };
    case "granted": return s.phase === "starting" ? { s: { phase: "recording", error: null, keep: false }, effect: null } : { s, effect: "discard" }; // cancelled while the permission prompt was up
    case "fail": return s.phase === "idle" ? { s, effect: null } : { s: { phase: "error", error: e.err, keep: !!e.keep }, effect: null };
    case "stop": {
      if (s.phase !== "recording") return { s, effect: null };
      const bad = judgeRecording(e);
      return bad ? { s: { phase: "error", error: bad, keep: false }, effect: "discard" } : { s: { phase: "transcribing", error: null, keep: false }, effect: "send" };
    }
    case "cancel": return { s: VOICE_IDLE, effect: s.phase === "idle" ? null : "discard" };
    case "text": return s.phase === "transcribing" ? { s: VOICE_IDLE, effect: "insert" } : { s, effect: null }; // cancelled meanwhile: dropped
    case "retry":
      if (s.phase !== "error") return { s, effect: null };
      return s.keep ? { s: { phase: "transcribing", error: null, keep: false }, effect: "send" } : { s: { phase: "starting", error: null, keep: false }, effect: "request-mic" };
  }
}

/** Why a finished recording is not worth sending, or null. */
export function judgeRecording(r: { ms: number; peak: number; bytes: number }): VoiceErr | null {
  if (r.bytes > MAX_BYTES) return "too-long";
  if (r.ms < MIN_MS || r.bytes <= 0 || r.peak < SILENCE_PEAK) return "no-speech";
  return null;
}

/** Map an /api/transcribe answer (or a thrown fetch, status 0) to the error to show. */
export function errFromResponse(status: number, code?: string): VoiceErr {
  if (status === 0) return "offline";
  if (status === 413 || code === "too-large") return "too-long";
  if (code === "no-speech") return "no-speech";
  if (status === 429) return "rate-limited";
  if (status === 503 || code === "no-binding") return "unavailable";
  return "failed";
}
/** Errors where the browser's own dictation (if it has any) is a sensible alternative. */
export const canFallBack = (e: VoiceErr | null): boolean => e === "unavailable" || e === "failed" || e === "rate-limited";

export function errText(e: VoiceErr, ios = false): string {
  switch (e) {
    case "denied": return ios
      ? "Microphone access is off. Open the iPhone Settings app, find this app (or Safari > Settings for Websites > Microphone), allow the microphone, then tap Retry."
      : "Microphone access was denied. Allow the microphone for this site in your browser settings, then tap Retry.";
    case "no-mic": return "No microphone was found on this device.";
    case "no-speech": return "No speech detected. Hold the phone closer and speak for at least a second.";
    case "too-long": return "That recording is too long (limit 2 minutes / 25 MB). Record a shorter message.";
    case "offline": return "You are offline. Your recording is kept - reconnect and tap Retry.";
    case "rate-limited": return "Voice limit reached (30 per hour). Try again later.";
    case "unavailable": return "Voice transcription is not available right now.";
    case "failed": return "Transcription failed. Your recording is kept - tap Retry.";
  }
}
/** Retry resends the kept recording only when one is kept; otherwise it records again. */
export const retryLabel = (s: Pick<VoiceState, "keep">): string => (s.keep ? "Retry" : "Record again");

export function mmss(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** RMS of an AnalyserNode.getByteTimeDomainData() frame (128 = silence), 0..1. */
export function rmsLevel(frame: ArrayLike<number>): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) { const v = (frame[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / frame.length);
}
/** Meter fill 0..1 from an RMS: speech sits around 0.05-0.3, so scale gently. */
export const meterFill = (rms: number): number => Math.min(1, Math.sqrt(Math.max(0, rms)) * 1.6);

/** Insert dictated text at the caret (or replace the selection) without touching the rest. One space between words, never inventing a leading one at the start. */
export function insertAtCaret(text: string, start: number, end: number, add: string): { text: string; caret: number } {
  const a = add.trim();
  const s = Math.min(Math.max(0, start), text.length), e = Math.min(Math.max(s, end), text.length);
  if (!a) return { text, caret: s };
  const before = text.slice(0, s), after = text.slice(e);
  const pre = before && !/\s$/.test(before) ? " " : "";
  const post = after && !/^\s/.test(after) ? " " : "";
  const out = `${before}${pre}${a}${post}${after}`;
  return { text: out, caret: before.length + pre.length + a.length };
}

/** The caret/selection captured at tap time is only valid if the draft is unchanged since; otherwise the text goes at the END of the current draft. */
export function caretFor(captured: { text: string; start: number; end: number }, current: string): [number, number] {
  return current === captured.text ? [captured.start, captured.end] : [current.length, current.length];
}

/** MediaRecorder.stop() can throw (already inactive, platform bug) and then no onstop will ever run to release the microphone: `release` runs in the finally. false = it threw. */
export function stopOrRelease(rec: { stop(): void } | null | undefined, release: () => void): boolean {
  let ok = false;
  try { rec?.stop(); ok = true; }
  catch { /* reported through the return value */ }
  finally { if (!ok) release(); }
  return ok;
}

/** Recorded pieces, dropped as soon as they are not needed (after the Blob is built, on cancel, on error, on unmount). */
export class ChunkBuffer {
  private parts: Blob[] = [];
  push(b: Blob) { if (b && b.size) this.parts.push(b); }
  /** the pieces, emptying the buffer */
  take(): Blob[] { const p = this.parts; this.parts = []; return p; }
  clear() { this.parts = []; }
  get size(): number { return this.parts.length; }
}

/** Where keyboard focus goes when the voice phase changes (null = leave it). */
export function focusTarget(prev: VoicePhase, next: VoicePhase): "stop" | "retry" | "textarea" | null {
  if (prev === next) return null;
  if (next === "recording") return "stop";
  if (next === "error") return "retry";
  if (next === "idle" && prev !== "idle") return "textarea";
  return null;
}
