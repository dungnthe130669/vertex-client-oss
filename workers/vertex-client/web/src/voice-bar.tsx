// The recording bar that replaces the composer's text box while voice input is active (see voice.ts). Plain words, 44px targets, aria-live announcements.
import type { Voice } from "./voice";
import { onIOS } from "./voice";
import { errText, mmss, retryLabel } from "./voice-logic";
import { NO_SPEECH_TEXT } from "./dictation-logic";
import { IconStop } from "./icons";

export function VoiceBar({ v }: { v: Voice }) {
  const { phase } = v;
  const say = phase === "starting" ? "Waiting for the microphone…" : phase === "recording" ? "Listening… tap Stop when done" : phase === "transcribing" ? "Transcribing…" : v.error ? errText(v.error, onIOS()) : "";
  return (
    <div class={`voicebar ${phase}`} data-testid="voice-bar" data-phase={phase} role="group" aria-label="Voice input">
      <span class="sr-only" role={phase === "error" ? "alert" : "status"} aria-live={phase === "error" ? "assertive" : "polite"} data-testid="voice-live">{say}</span>
      {(phase === "starting" || phase === "recording") && <>
        <div class="vb-row">
          <span class={`vb-dot${phase === "recording" ? " on" : ""}`} aria-hidden="true" />
          <span class="vb-time num" data-testid="voice-timer" aria-hidden="true">{mmss(v.elapsedMs)}</span>
          <span class="vb-meter" data-testid="voice-meter" aria-hidden="true"><i ref={v.meterRef} /></span>
        </div>
        <div class="vb-text muted small" aria-hidden="true">{phase === "starting" ? "Waiting for the microphone…" : "Listening… tap Stop when done"}</div>
        <div class="vb-actions">
          <button type="button" class="btn vb-cancel" data-testid="voice-cancel" onClick={v.cancel}>Cancel</button>
          <button type="button" class="btn primary vb-stop" data-testid="voice-stop" ref={v.stopRef} disabled={phase !== "recording"} onClick={v.stop}><IconStop /> Stop</button>
        </div>
      </>}
      {phase === "transcribing" && <div class="vb-row" data-testid="voice-transcribing"><span class="spin" aria-hidden="true" /><span>Transcribing…</span><span class="grow" /><button type="button" class="btn vb-cancel" data-testid="voice-cancel" onClick={v.cancel}>Cancel</button></div>}
      {phase === "error" && v.error && <>
        <div class="vb-err" data-testid="voice-error" data-code={v.error} aria-hidden="true">{errText(v.error, onIOS())}</div>
        <div class="vb-actions">
          <button type="button" class="btn vb-cancel" data-testid="voice-cancel" onClick={v.cancel}>Dismiss</button>
          {v.canFallBack && <button type="button" class="btn" data-testid="voice-browser" onClick={v.useBrowserDictation}>Use browser dictation</button>}
          {v.error !== "no-mic" && <button type="button" class="btn primary" data-testid="voice-retry" ref={v.retryRef} onClick={v.retry}>{retryLabel(v)}</button>}
        </div>
      </>}
    </div>
  );
}

/** Native (browser) dictation: a compact bar ABOVE the composer; the textarea stays visible because the text streams into it. */
export function NativeBar({ v }: { v: Voice }) {
  const n = v.native;
  const warn = !!n.message;
  const say = n.listening ? "Listening… speak now, text appears below" : "";
  return (
    <div class={`voicebar native${n.listening ? " listening" : ""}`} data-testid="native-bar" data-phase={n.listening ? "listening" : "message"} role="group" aria-label="Browser dictation">
      <span class="sr-only" role="status" aria-live="polite" data-testid="native-live">{n.message ?? say}</span>
      {n.listening && <div class="vb-status" data-testid="native-status">
        <span class="vb-dot on" aria-hidden="true" />
        <span class="vb-time num" data-testid="native-timer" aria-hidden="true">{mmss(n.elapsedMs)}</span>
        <span class="vb-text" data-testid="native-label" aria-hidden="true">Listening… speak now, text appears below</span>
        <button type="button" class="btn primary vb-stop" data-testid="native-stop" ref={n.stopRef} onClick={n.stop}><IconStop /> Stop</button>
      </div>}
      {warn && <div class="vb-note" data-testid="native-note">
        <div class={`vb-err${n.hint ? " soft" : ""}`} data-testid="native-message" aria-hidden="true">{n.message}</div>
        {!n.listening && <div class="vb-actions">
          {n.retryable && <button type="button" class="btn primary" data-testid="native-retry" onClick={n.retry}>Retry</button>}
          <button type="button" class="btn vb-cancel" data-testid="native-dismiss" onClick={n.dismiss}>Dismiss</button>
        </div>}
      </div>}
    </div>
  );
}
