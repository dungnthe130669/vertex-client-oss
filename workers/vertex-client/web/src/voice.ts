// Recorded voice for the composer: MediaRecorder -> POST /api/transcribe (Cloudflare Workers AI Whisper) -> the text is INSERTED into the composer, never sent.
// Starts only from a tap (the mic button or the error bar's Retry). The microphone is released on Stop, Cancel, unmount and when the page is hidden.
// DEFAULT path is the browser SpeechRecognition (dictation.ts); this Whisper path runs only when Settings > Voice has it on (`vc.voice.whisper`) and MediaRecorder exists.
// Whisper ON: the error bar's "Use browser dictation" still switches by tap.
import { useEffect, useRef, useState } from "preact/hooks";
import { transcribeAudio } from "./api";
import { setBusy, withBusy } from "./busy";
import { dictationSupported, getDictLang, getWhisper, useDictation } from "./dictation";
import { nativeFocus, pickPath } from "./dictation-logic";
import { ChunkBuffer, MAX_BYTES, MAX_SECONDS, VOICE_IDLE, canFallBack, caretFor, focusTarget, stopOrRelease, errFromResponse, insertAtCaret, isIOS, meterFill, pickMime, rmsLevel, voiceReduce, type VoiceEffect, type VoiceErr, type VoiceEvent, type VoicePhase, type VoiceState } from "./voice-logic";
import { errorToast } from "./toast";

export const onIOS = (): boolean => typeof navigator !== "undefined" && isIOS(navigator.userAgent, navigator.maxTouchPoints);
const mimeOf = (): string | null => { const MR = (globalThis as any).MediaRecorder; return MR ? pickMime((m) => (typeof MR.isTypeSupported === "function" ? MR.isTypeSupported(m) : false), onIOS()) : null; };
/** True when this browser can record audio at all (the mic button is shown even when SpeechRecognition is missing). */
export const recorderSupported = (): boolean => typeof navigator !== "undefined" && typeof (globalThis as any).MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export type Voice = ReturnType<typeof useVoice>;

/** `getText`/`setText` are the composer's; `ta` is its textarea (read for the caret at tap time). */
export function useVoice(getText: () => string, setText: (t: string) => void, ta: { current: HTMLTextAreaElement | null }) {
  const st = useRef<VoiceState>(VOICE_IDLE);
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);
  const dict = useDictation(getText, setText);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef(new ChunkBuffer());
  const cancelled = useRef(false);
  const stopping = useRef(false);
  const t0 = useRef(0), peak = useRef(0);
  const caret = useRef<{ text: string; start: number; end: number }>({ text: "", start: 0, end: 0 });
  const prevPhase = useRef<VoicePhase>("idle");
  const stopBtn = useRef<HTMLElement | null>(null), retryBtn = useRef<HTMLElement | null>(null);
  const kept = useRef<Blob | null>(null);
  const abort = useRef<AbortController | null>(null);
  const audio = useRef<{ ctx: AudioContext; analyser: AnalyserNode; buf: Uint8Array } | null>(null);
  const raf = useRef(0), timer = useRef(0);
  const meter = useRef<HTMLElement | null>(null);

  const release = () => {
    cancelAnimationFrame(raf.current); clearInterval(timer.current);
    stream.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* already ended */ } });
    stream.current = null;
    try { void audio.current?.ctx.close(); } catch { /* closed */ }
    audio.current = null;
  };
  const apply = (e: VoiceEvent) => {
    const { s, effect } = voiceReduce(st.current, e);
    const changed = s !== st.current;
    st.current = s;
    setBusy("voice", s.phase !== "idle"); // a recording in progress must not be reloaded away by the PWA update flow
    if (effect) run(effect, e);
    if (changed) bump();
  };
  const run = (effect: VoiceEffect, e: VoiceEvent) => {
    if (effect === "request-mic") void acquire();
    else if (effect === "discard") { cancelled.current = true; abort.current?.abort(); kept.current = null; chunks.current.clear(); if (rec.current && rec.current.state !== "inactive") stopOrRelease(rec.current, release); release(); rec.current = null; }
    else if (effect === "send") void send();
    else if (effect === "insert" && e.t === "text") {
      const cur = getText();
      const [cs, ce] = caretFor(caret.current, cur);
      const r = insertAtCaret(cur, cs, ce, e.text);
      setText(r.text);
      requestAnimationFrame(() => { const t = ta.current; if (t) { try { t.setSelectionRange(r.caret, r.caret); } catch { /* not focusable yet */ } } });
    }
  };

  const acquire = async () => {
    const t = ta.current; const len = getText().length;
    caret.current = { text: getText(), start: t ? t.selectionStart ?? len : len, end: t ? t.selectionEnd ?? len : len };
    cancelled.current = false; stopping.current = false; chunks.current.clear(); peak.current = 0;
    let s: MediaStream;
    try { s = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { const n = (e as { name?: string })?.name; apply({ t: "fail", err: n === "NotAllowedError" || n === "SecurityError" ? "denied" : n === "NotFoundError" || n === "OverconstrainedError" ? "no-mic" : "failed" }); return; }
    if (st.current.phase !== "starting") { s.getTracks().forEach((x) => x.stop()); return; } // cancelled while the permission prompt was up
    stream.current = s;
    try {
      const mime = mimeOf();
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      r.ondataavailable = (ev) => { chunks.current.push(ev.data); };
      r.onstop = () => {
        const type = r.mimeType || mime || "audio/mp4";
        const blob = new Blob(chunks.current.take(), { type }); // the buffer is emptied: only the Blob holds the audio now
        const ms = Date.now() - t0.current; const pk = peak.current;
        release(); rec.current = null;
        if (cancelled.current) return;
        kept.current = blob;
        apply({ t: "stop", ms, peak: pk, bytes: blob.size });
      };
      r.onerror = () => { chunks.current.clear(); release(); rec.current = null; if (!cancelled.current) apply({ t: "fail", err: "failed" }); };
      rec.current = r; t0.current = Date.now();
      r.start();
    } catch { chunks.current.clear(); release(); apply({ t: "fail", err: "failed" }); return; }
    try { // level meter + peak (silence detection). WebAudio trouble must never break recording: the meter just stays flat.
      const AC = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
      const ctx: AudioContext = new AC(); void ctx.resume?.();
      const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(analyser);
      audio.current = { ctx, analyser, buf: new Uint8Array(analyser.fftSize) };
      const loop = () => {
        const a = audio.current; if (!a) return;
        a.analyser.getByteTimeDomainData(a.buf as any);
        const l = rmsLevel(a.buf); if (l > peak.current) peak.current = l;
        if (meter.current) meter.current.style.transform = `scaleX(${meterFill(l).toFixed(3)})`;
        raf.current = requestAnimationFrame(loop);
      };
      raf.current = requestAnimationFrame(loop);
    } catch { peak.current = 1; /* no WebAudio: silence cannot be judged, so never call the recording silent */ }
    timer.current = window.setInterval(() => { if (Date.now() - t0.current >= MAX_SECONDS * 1000) stop(); bump(); }, 250);
    apply({ t: "granted" });
  };

  const send = async () => {
    const blob = kept.current;
    if (!blob) { apply({ t: "fail", err: "failed" }); return; }
    if (blob.size > MAX_BYTES) { kept.current = null; apply({ t: "fail", err: "too-long" }); return; }
    const ctrl = new AbortController(); abort.current = ctrl;
    const r = await withBusy("transcribe", () => transcribeAudio(blob, getDictLang(), ctrl.signal));
    if (ctrl.signal.aborted || st.current.phase !== "transcribing") return;
    if (r.status === 200 && typeof r.text === "string") {
      if (!r.text.trim()) { kept.current = null; apply({ t: "fail", err: "no-speech" }); return; }
      kept.current = null; apply({ t: "text", text: r.text }); return;
    }
    const err = errFromResponse(r.status, r.code);
    if (err === "no-speech" || err === "too-long") kept.current = null;
    chunks.current.clear();
    apply({ t: "fail", err, keep: kept.current !== null });
  };

  const stop = () => { if (stopping.current || st.current.phase !== "recording" || !rec.current) return; stopping.current = true; if (!stopOrRelease(rec.current, release)) { chunks.current.clear(); rec.current = null; apply({ t: "fail", err: "failed" }); } };
  const cancel = () => apply({ t: "cancel" });
  useEffect(() => {
    const hide = () => { if (document.hidden && (st.current.phase === "starting" || st.current.phase === "recording")) { apply({ t: "cancel" }); errorToast("Recording cancelled because the app went to the background."); } };
    document.addEventListener("visibilitychange", hide);
    return () => { setBusy("voice", false); document.removeEventListener("visibilitychange", hide); cancelled.current = true; abort.current?.abort(); if (rec.current && rec.current.state !== "inactive") stopOrRelease(rec.current, release); release(); chunks.current.clear(); kept.current = null; };
  }, []);

  useEffect(() => { // keyboard focus follows the phase: Stop while recording, Retry on an error, the textarea when the flow ends
    const f = focusTarget(prevPhase.current, st.current.phase); prevPhase.current = st.current.phase;
    if (f) requestAnimationFrame(() => (f === "stop" ? stopBtn.current : f === "retry" ? retryBtn.current : ta.current)?.focus({ preventScroll: true }));
  });
  const nativePrev = useRef({ listening: false, message: false });
  const nativeStop = useRef<HTMLElement | null>(null);
  useEffect(() => { // native bar: focus Stop when listening starts (also after Retry), the composer when it ends or the message is dismissed
    const next = { listening: dict.listening, message: !!dict.message };
    const f = nativeFocus(nativePrev.current, next); nativePrev.current = next;
    if (f) requestAnimationFrame(() => (f === "stop" ? nativeStop.current : ta.current)?.focus({ preventScroll: true }));
  });
  const path = pickPath(getWhisper(), recorderSupported(), dictationSupported()); // read per render: the Settings toggle takes effect without a reload
  const useRecorder = path === "whisper";
  const phase = st.current.phase;
  return {
    /** show the mic button: the recorder works, or the browser has SpeechRecognition */
    supported: path !== "none",
    phase, error: st.current.error, keep: st.current.keep,
    /** the bar replaces the composer input while the voice flow (not the SpeechRecognition one) is active */
    active: phase !== "idle",
    listeningSR: dict.listening,
    /** the native-dictation bar (above the textarea, which keeps showing the streaming text): listening, or a message to dismiss */
    native: { show: dict.listening || !!dict.message, listening: dict.listening, elapsedMs: dict.elapsedMs, message: dict.message, hint: dict.hint, retryable: dict.retryable, stop: dict.toggle, retry: dict.toggle, dismiss: dict.dismiss, stopRef: (el: HTMLElement | null) => { nativeStop.current = el; } },
    elapsedMs: phase === "recording" ? Date.now() - t0.current : 0,
    stopRef: (el: HTMLElement | null) => { stopBtn.current = el; },
    retryRef: (el: HTMLElement | null) => { retryBtn.current = el; },
    meterRef: (el: HTMLElement | null) => { meter.current = el; },
    /** the mic button */
    toggle: () => { if (dict.listening || !useRecorder) { dict.toggle(); return; } if (phase === "idle") apply({ t: "tap" }); else if (phase === "recording") stop(); },
    stop, cancel,
    retry: () => apply({ t: "retry" }),
    canFallBack: canFallBack(st.current.error) && dictationSupported(),
    /** tap-initiated switch to the browser's own dictation (error bar button) */
    useBrowserDictation: () => { apply({ t: "cancel" }); kept.current = null; dict.toggle(); },
  };
}
export type { VoiceErr };
