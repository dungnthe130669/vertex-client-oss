// Browser dictation (the fallback; the primary voice path is voice.ts: MediaRecorder + /api/transcribe). Wraps the browser's SpeechRecognition for the composer. It only ever starts from a tap (never on load, never from a keyboard
// shortcut) and the textarea shows the interim text while you speak. The pure parts live in dictation-logic.ts.
import { useEffect, useRef, useState } from "preact/hooks";
import { DictSession, type Rec } from "./dictation-session";
import { DICT_LANGS, IDLE, NO_SPEECH_TEXT, RETRY_MS, SETTLE_MS, WATCHDOG_MS, dictLang, dictReduce, dictText, nativeNoSpeech, retryableError, splitResults, type DictEvent, type DictState } from "./dictation-logic";

const LANG_KEY = "vc.dictation.lang";
export const getDictLang = (): string => { try { return localStorage.getItem(LANG_KEY) ?? ""; } catch { return ""; } };
export const setDictLang = (v: string): void => { try { if (v) localStorage.setItem(LANG_KEY, v); else localStorage.removeItem(LANG_KEY); } catch { /* storage blocked */ } };
export { DICT_LANGS };
const WHISPER_KEY = "vc.voice.whisper"; // "1" = the mic records and sends audio to Whisper; default off = the browser's own dictation
export const getWhisper = (): boolean => { try { return localStorage.getItem(WHISPER_KEY) === "1"; } catch { return false; } };
export const setWhisper = (on: boolean): void => { try { if (on) localStorage.setItem(WHISPER_KEY, "1"); else localStorage.removeItem(WHISPER_KEY); } catch { /* storage blocked */ } };

const ctor = (): (new () => Rec) | null => (typeof window === "undefined" ? null : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null));
export const dictationSupported = (): boolean => ctor() !== null;

/** `getText`/`setText` are the composer's. The mic button should render only when `supported`.
 *  ONE SpeechRecognition instance at a time (lifecycle in dictation-session.ts). iOS ends an instance by itself after a pause / the first final result, so an end the user did not ask for
 *  restarts a fresh instance (after the old one's onend + SETTLE_MS) and the accumulated text carries over: one continuous session until Stop. */
export function useDictation(getText: () => string, setText: (t: string) => void) {
  const state = useRef<DictState>(IDLE);
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);
  const t0 = useRef(0);
  const shown = useRef<string | null>(null); // what we last put in the composer; anything else there means the user typed or sent
  const sess = useRef<DictSession | null>(null);
  // The session's handlers are created ONCE (first render) and call `apply` for the whole dictation: getText/setText must be read through refs, otherwise they stay the FIRST render's
  // closures (getText() would keep returning the text from the tap) and the "composer was edited mid-dictation" guard stops dictation after the first result.
  const getRef = useRef(getText); getRef.current = getText;
  const setRef = useRef(setText); setRef.current = setText;
  if (!sess.current) sess.current = new DictSession({
    ctor, lang: () => dictLang(getDictLang(), navigator.language), listening: () => state.current.phase === "listening",
    onResult: (list) => apply({ t: "result", ...splitResults(list) }), onError: (code) => apply({ t: "error", code }), onEnd: () => apply({ t: "end" }),
    onStarted: () => apply({ t: "started" }), onBusy: () => apply({ t: "busy" }),
  });
  const ss = sess.current;
  const apply = (e: DictEvent) => {
    if (e.t === "result" && shown.current !== null && getRef.current() !== shown.current) { apply({ t: "tap", text: "" }); return; } // edited or sent mid-dictation: stop, do not overwrite
    const { s, effect } = dictReduce(state.current, e);
    const before = state.current;
    state.current = s;
    if (e.t === "result" || (e.t === "tap" && effect === "start")) { shown.current = dictText(s); setRef.current(shown.current); }
    if (s.phase === "idle") { shown.current = null; if (before.phase === "listening") ss.release(); }
    if (e.t === "tap" && effect === "start") t0.current = Date.now();
    ss.lastEvt = Date.now();
    if (effect === "start") ss.launch(0);
    else if (effect === "restart") ss.launch(SETTLE_MS);
    else if (effect === "retry") ss.launch(RETRY_MS);
    else if (effect === "stop") ss.stop();
    if (before.phase !== s.phase || before.error !== s.error || e.t === "clear" || s !== before) bump();
  };
  useEffect(() => {
    const away = () => { if (document.visibilityState === "hidden" || document.visibilityState === undefined) apply({ t: "halt" }); };
    const gone = () => apply({ t: "halt" });
    document.addEventListener("visibilitychange", away); window.addEventListener("pagehide", gone);
    return () => { document.removeEventListener("visibilitychange", away); window.removeEventListener("pagehide", gone); ss.release(); };
  }, []);
  const listening = state.current.phase === "listening";
  useEffect(() => {
    if (!listening) return;
    const id = window.setInterval(() => {
      if (ss.launchStuck()) { ss.abandonLaunch(); apply({ t: "error", code: "audio-capture" }); } // a launch that never finished must not leave "listening" without an instance
      else if (!state.current.stopping && !ss.launching && (!ss.cur || ss.cur.ended) && Date.now() - ss.lastEvt > WATCHDOG_MS) apply({ t: "end" }); // nothing running, nothing heard: restart (or close at the cap)
      bump();
    }, 500); // timer + no-speech hint + watchdog
    return () => clearInterval(id);
  }, [listening]);
  const elapsedMs = listening ? Date.now() - t0.current : 0;
  const st = state.current;
  const hint = listening && nativeNoSpeech(st, elapsedMs);
  const message = st.error ?? (hint ? NO_SPEECH_TEXT : null);
  return { supported: dictationSupported(), listening, elapsedMs, message, hint, retryable: retryableError(st.errCode), dismiss: () => apply({ t: "clear" }), toggle: () => apply({ t: "tap", text: getText() }) };
}
