// Pure pieces of voice dictation (the composer's mic button): the state machine, the text it produces, the language choice and the error wording.
// No DOM and no SpeechRecognition here, so bun:test covers all of it; dictation.ts is the thin browser wrapper.

export type DictPhase = "idle" | "listening";
export interface DictState {
  phase: DictPhase; /** composer text when the tap happened */ base: string;
  /** finished phrases of EARLIER recognition instances (iOS ends an instance by itself; we restart it, the text carries over) */ carry: string;
  /** finished phrases of the current instance */ final: string; /** the phrase still being recognised */ interim: string;
  /** the trailing interim phrase of an instance that ended by itself: shown in the composer until the next instance produces any text, which REPLACES it (never appended: "hel" + "hello" must give "hello") */ pending: string;
  error: string | null; /** the engine code behind `error` (or "cap"), for the Retry button */ errCode: string | null;
  /** auto-restarts AND retries so far this session (one shared budget, capped at MAX_RESTARTS) */ restarts: number; /** the one automatic retry after a mic error has been used */ retried: boolean;
  /** the user tapped Stop; the next end is final */ stopping: boolean; /** a retry is scheduled; the failing instance's end must not trigger a restart */ awaiting: boolean;
}
export type DictEvent =
  | { t: "tap"; text: string }                              // the mic button: starts when idle, stops when listening
  | { t: "result"; final: string; interim: string }         // every SpeechRecognition result event carries the full list OF THAT INSTANCE, so this REPLACES final+interim
  | { t: "end" }                                            // the engine stopped (silence, iOS ending the session by itself, stop(), error)
  | { t: "error"; code: string }
  | { t: "started" }                                        // a (re)started instance accepted start()
  | { t: "busy" }                                           // a previous instance could not be confirmed ended (iOS ignored abort()): do not start another
  | { t: "halt" }                                           // page hidden / navigation: leave dictation, the text stays in the composer
  | { t: "clear" };                                         // dismiss the bar's message

export const IDLE: DictState = { phase: "idle", base: "", carry: "", final: "", interim: "", pending: "", error: null, errCode: null, restarts: 0, retried: false, stopping: false, awaiting: false };

export const MAX_RESTARTS = 20;
export const SETTLE_MS = 300;       // gap between an instance ending and the next start(): iOS still holds the audio session for a moment
export const END_WAIT_MS = 1000;    // how long we wait for the old instance's onend after abort()
export const RETRY_MS = 700;        // the one automatic retry after audio-capture / not-allowed
export const STOP_ABORT_MS = 1000;  // Stop = stop(), then abort() if onend has not come
export const WATCHDOG_MS = 20000;   // listening, nothing running and no event for this long: restart or close
export const CAP_TEXT = "Dictation paused after a long session. Tap the mic to continue.";
const MIC_CODES = ["audio-capture", "service-not-allowed", "not-allowed"];
export const retryableError = (code: string | null): boolean => code !== null && (MIC_CODES.includes(code) || code === "cap" || code === "busy");
export const ZOMBIE_ATTEMPTS = 3;   // abort() + END_WAIT_MS rounds before an unconfirmed instance makes us show "busy" instead of starting another
export const ZOMBIE_RETRY_MS = 2000; // background abort() retries on an unconfirmed instance
export const ZOMBIE_RETRY_CAP = 5;
export const LAUNCH_STUCK_MS = 5000;

/** `effect`: "start" a first instance, "restart" a new one after a self-end, "retry" a new one after a mic error (longer delay), "stop" = call stop() on the live one. */
export function dictReduce(s: DictState, e: DictEvent): { s: DictState; effect: "start" | "restart" | "retry" | "stop" | null } {
  switch (e.t) {
    case "tap": return s.phase === "idle" ? { s: { ...IDLE, phase: "listening", base: e.text }, effect: "start" } : { s: { ...s, stopping: true }, effect: "stop" };
    case "result": {
      if (s.phase !== "listening") return { s, effect: null }; // a late result after the end is dropped
      const empty = !`${e.final}${e.interim}`.trim();
      return { s: { ...s, final: e.final, interim: e.interim, pending: empty ? s.pending : "", retried: false, awaiting: false }, effect: null }; // any real text from the new instance REPLACES the pending interim
    }
    case "started": return { s: s.awaiting ? { ...s, awaiting: false } : s, effect: null };
    case "error": {
      if (s.phase !== "listening" || e.code === "aborted" || e.code === "no-speech") return { s, effect: null }; // no-speech between restart cycles is not a failure; aborted is us
      if (s.stopping) return { s: { ...IDLE }, effect: null };
      if (MIC_CODES.includes(e.code) && !s.retried) {
        if (s.restarts >= MAX_RESTARTS) return { s: { ...IDLE, error: CAP_TEXT, errCode: "cap" }, effect: null };
        return { s: { ...s, retried: true, awaiting: true, restarts: s.restarts + 1 }, effect: "retry" };
      }
      return { s: { ...IDLE, error: dictError(e.code), errCode: e.code }, effect: null };
    }
    case "clear": return s.phase === "idle" ? { s: { ...IDLE }, effect: null } : { s, effect: null };
    case "halt": return { s: { ...IDLE }, effect: null };
    case "busy": return s.phase === "idle" ? { s, effect: null } : { s: { ...IDLE, error: dictError("busy"), errCode: "busy" }, effect: null };
    case "end": {
      if (s.phase === "idle") return { s: s.error ? s : { ...IDLE }, effect: null };
      if (s.awaiting) return { s, effect: null };
      if (s.stopping) return { s: { ...IDLE }, effect: null };
      if (s.restarts >= MAX_RESTARTS) return { s: { ...IDLE, error: CAP_TEXT, errCode: "cap" }, effect: null };
      return { s: { ...s, carry: joinText(s.carry, s.final), final: "", interim: "", pending: s.interim.trim() ? s.interim : s.pending, restarts: s.restarts + 1 }, effect: "restart" }; // only FINAL text is promoted; the trailing interim waits as `pending`
    }
  }
}

const joinText = (...p: string[]): string => p.map((x) => x.trim()).filter(Boolean).join(" ");

/** What the textarea shows: the text before the tap, then the finished phrases, then the interim phrase. One space between non-empty parts. */
export function dictText(s: Pick<DictState, "base" | "final" | "interim"> & { carry?: string; pending?: string }): string {
  const spoken = joinText(s.carry ?? "", s.final, s.interim, s.pending ?? "");
  if (!spoken) return s.base;
  return s.base && !/\s$/.test(s.base) ? `${s.base} ${spoken}` : `${s.base}${spoken}`;
}

/** Split a SpeechRecognitionResultList-like array into finished and interim text. */
export function splitResults(list: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>): { final: string; interim: string } {
  let final = "", interim = "";
  for (let i = 0; i < list.length; i++) { const r = list[i]; if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript; }
  return { final, interim };
}

/** The language SpeechRecognition gets: the saved Dictation language (Settings > Profile) if set, else the browser's, else English. */
export const dictLang = (saved: string | null | undefined, nav: string | null | undefined): string => (saved && saved.trim()) || (nav && nav.trim()) || "en-US";

export const DICT_LANGS: Array<[string, string]> = [["", "Automatic (browser language)"], ["vi-VN", "Tiếng Việt"], ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["fr-FR", "Français"], ["de-DE", "Deutsch"], ["es-ES", "Español"], ["ja-JP", "日本語"], ["zh-CN", "中文"]];

/** The message shown when dictation fails. "aborted" and "no-speech" are not failures worth a toast: null. */
export function dictError(code: string): string | null {
  if (code === "aborted" || code === "no-speech") return null;
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone access was denied. Allow the microphone (iPhone: Settings > Safari > Microphone, or Settings > this app), then tap the mic again.";
  if (code === "audio-capture" || code === "busy") return "The microphone is busy or unavailable. Wait a second and tap the mic again. If it keeps happening, close and reopen the app, or turn on Whisper in Settings > Voice.";
  if (code === "network") return "Dictation needs a network connection.";
  if (code === "language-not-supported") return "This browser cannot dictate in that language. Change it in Settings > Profile.";
  return "Dictation stopped unexpectedly.";
}

/** No speech heard this long after the bar opened (restart cycles do not reset it): the bar says so in plain words (the engine itself may stay silent for a long time). */
export const NO_SPEECH_MS = 8000;
export const NO_SPEECH_TEXT = "No speech heard — check the microphone permission in iOS Settings, or turn on Whisper in Settings > Voice";
/** True while listening, nothing has been recognised (finished or interim) and NO_SPEECH_MS have passed since the tap. */
export const nativeNoSpeech = (s: Pick<DictState, "phase" | "final" | "interim"> & { carry?: string; pending?: string }, elapsedMs: number): boolean => s.phase === "listening" && !`${s.carry ?? ""}${s.pending ?? ""}${s.final}${s.interim}`.trim() && elapsedMs >= NO_SPEECH_MS;

/** Which path the mic button takes. Whisper only when the Settings toggle is on AND the browser can record; otherwise the browser's own dictation; else no mic. */
export type VoicePath = "whisper" | "native" | "none";
export const pickPath = (whisperOn: boolean, recorder: boolean, native: boolean): VoicePath => (whisperOn && recorder ? "whisper" : native ? "native" : "none");

/** Where keyboard focus goes when the native bar changes state: Stop when listening starts (also after Retry), the composer when dictation ends or the message is dismissed. */
export function nativeFocus(prev: { listening: boolean; message: boolean }, next: { listening: boolean; message: boolean }): "stop" | "composer" | null {
  if (next.listening && !prev.listening) return "stop";
  if (!next.listening && (prev.listening || (prev.message && !next.message))) return "composer";
  return null;
}
