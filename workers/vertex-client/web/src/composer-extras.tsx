// Composer helpers kept out of chat.tsx on purpose: voice dictation (mic) and the camera check for the + sheet.
import type { Voice } from "./voice";

const Svg = ({ children }: { children: preact.ComponentChildren }) => <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{children}</svg>;
const IconMic = () => <Svg><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" /></Svg>;
const IconMicStop = () => <Svg><rect x="6" y="6" width="12" height="12" rx="2.4" fill="currentColor" stroke="none" /></Svg>;
export const IconCamera = () => <Svg><path d="M4 8.5A1.5 1.5 0 015.5 7h2l1.3-2h6.4l1.3 2h2A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5z" /><circle cx="12" cy="13" r="3.2" /></Svg>;

/** Mic: shown when the chosen path works (browser dictation by default; recorder only with Settings > Voice > Whisper on). A tap starts the recording bar (VoiceBar); while it runs the same button is Stop. */
export function MicButton({ voice: v, disabled }: { voice: Voice; disabled?: boolean }) {
  if (!v.supported) return null;
  const on = v.phase === "recording" || v.listeningSR;
  const label = on ? "Stop dictation" : v.phase === "starting" || v.phase === "transcribing" ? "Voice input busy" : "Dictate";
  return <button class={`icon${on ? " rec" : ""}`} type="button" data-testid="dictate" aria-label={label} aria-pressed={on} title={label} disabled={(disabled && !on) || v.phase === "starting" || v.phase === "transcribing" || v.phase === "error"} onClick={v.toggle}>{on ? <IconMicStop /> : <IconMic />}</button>;
}

/** Phones only (coarse pointer): the "Camera" tile of the + sheet is offered, and opens the camera directly. The photo goes through the same `attach` path as any image (downscaled before upload). */
export const cameraWanted = (): boolean => typeof matchMedia === "function" && matchMedia("(pointer:coarse)").matches;
