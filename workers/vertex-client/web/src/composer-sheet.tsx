// The composer's "+" sheet ("Add context"): Camera / Photos / Files tiles, then Saved prompts and Mode rows.
// A bottom sheet on phones; from 1024px it is a popover anchored above the "+" button (position set through CSSOM: the CSP is style-src 'self').
import { useEffect, useRef, useState } from "preact/hooks";
import { useEscape } from "./confirm";
import { IconAttach, IconChat, IconImage, IconSlash, IconVideo } from "./icons";
import { IconCamera } from "./composer-extras";

export type Mode = "chat" | "image" | "video";
export const MODE_LABEL: Record<Mode, string> = { chat: "Chat", image: "Image", video: "Video" };
export const ModeIcon = ({ mode }: { mode: Mode }) => (mode === "image" ? <IconImage /> : mode === "video" ? <IconVideo /> : <IconChat />);

export interface ContextSheetProps {
  mode: Mode;
  camera: boolean; // coarse pointer only, like the old camera button
  photosDisabled: boolean;
  /** why Photos/Camera are disabled (shown as a visible hint); only read when photosDisabled */
  photosWhy?: string;
  filesDisabled: boolean;
  onCamera: () => void;
  onPhotos: () => void;
  onFiles: () => void;
  onPrompts: () => void;
  onMode: (m: Mode) => void;
  onClose: () => void;
  anchor: HTMLElement | null;
}

export function ContextSheet(p: ContextSheetProps) {
  useEscape(p.onClose);
  const [pickMode, setPickMode] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => { // desktop: sit right above the + button
    const el = sheet.current;
    if (!el || !p.anchor || !matchMedia("(min-width:1024px)").matches) return;
    const r = p.anchor.getBoundingClientRect();
    el.style.setProperty("--ctx-l", `${Math.round(r.left)}px`);
    el.style.setProperty("--ctx-b", `${Math.round(innerHeight - r.top + 8)}px`);
    // an ancestor with a transform/contain (the desktop shell) re-bases position:fixed: measure where it really landed and correct
    const a = el.getBoundingClientRect();
    el.style.setProperty("--ctx-l", `${Math.round(r.left + (r.left - a.left))}px`);
    el.style.setProperty("--ctx-b", `${Math.round(innerHeight - r.top + 8 + (a.bottom - (r.top - 8)))}px`);
  }, [p.anchor]);
  const tile = (testid: string, label: string, icon: preact.ComponentChildren, onClick: () => void, disabled = false) => (
    <button type="button" class="ctx-tile" data-testid={testid} disabled={disabled} onClick={onClick}>{icon}<span>{label}</span></button>
  );
  return (
    <div class="scrim ctx" onClick={p.onClose} data-testid="ctx-scrim">
      <div class="sheet ctxsheet" ref={sheet} role="dialog" aria-modal="true" aria-label="Add context" onClick={(e) => e.stopPropagation()} data-testid="ctx-sheet">
        <div class="grabber" aria-hidden="true" />
        <h3 class="ctx-title">Add context</h3>
        <div class="ctx-tiles">
          {p.camera && tile("ctx-camera", "Camera", <IconCamera />, p.onCamera, p.photosDisabled)}
          {tile("ctx-photos", "Photos", <IconImage />, p.onPhotos, p.photosDisabled)}
          {tile("ctx-files", "Files", <IconAttach />, p.onFiles, p.filesDisabled)}
        </div>
        {p.photosDisabled && p.photosWhy && <p class="muted small ctx-why" data-testid="ctx-photos-why">{p.photosWhy}</p>}
        <button type="button" class="row ctx-row" data-testid="ctx-prompts" onClick={p.onPrompts}><IconSlash /><strong>Saved prompts</strong><span class="muted small">Type / to search</span></button>
        <button type="button" class="row ctx-row" data-testid="ctx-mode" aria-expanded={pickMode} onClick={() => setPickMode((v) => !v)}><ModeIcon mode={p.mode} /><strong>Mode</strong><span class="muted small">{MODE_LABEL[p.mode]}</span></button>
        {pickMode && (
          <span class="seg ctx-seg" role="group" aria-label="Mode" data-testid="mode-chip">
            {(["chat", "image", "video"] as Mode[]).map((m) => <button type="button" aria-label={MODE_LABEL[m]} aria-pressed={p.mode === m} onClick={() => p.onMode(m)}><ModeIcon mode={m} /><span>{MODE_LABEL[m]}</span></button>)}
          </span>
        )}
      </div>
    </div>
  );
}
