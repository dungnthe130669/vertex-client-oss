import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { IconMore } from "./icons";
import { useEscape } from "./confirm";
import { toast } from "./toast";

/** Writes to the clipboard and says so; a blocked clipboard (permission, insecure context) is reported, never swallowed. */
export const copyText = (text: string, what = "Copied") =>
  void (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"))).then(() => toast(what), () => toast("Copy failed - use Select text", { kind: "error" }));

/** The "…" menu on an assistant message: Copy as markdown, Select text. Copy and Regenerate are the inline buttons under the answer (not repeated here).
 *  Menu pattern: arrows move, Esc/Tab close, focus returns to the button. */
export function MsgActions({ markdown, onSelect }: { markdown: string; onSelect: () => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const open = () => { const r = btn.current?.getBoundingClientRect(); if (r) setAt({ x: r.left, y: r.bottom + 4 }); };
  const close = () => { setAt(null); btn.current?.focus(); };
  return (
    <>
      <button ref={btn} class="ghost msg-more" type="button" aria-label="Message actions" aria-haspopup="menu" aria-expanded={!!at} data-testid="msg-actions" onClick={open}><IconMore /></button>
      {at && createPortal(<Menu at={at} onClose={close} items={[
        { id: "msg-copy-md", label: "Copy as markdown", run: () => copyText(markdown, "Copied as markdown") },
        { id: "msg-select", label: "Select text", run: onSelect },
      ]} />, document.body)}
    </>
  );
}

function Menu({ at, items, onClose }: { at: { x: number; y: number }; items: Array<{ id: string; label: string; run: () => void }>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos({ left: Math.max(8, Math.min(at.x, innerWidth - w - 8)), top: at.y + h > innerHeight - 8 ? Math.max(8, at.y - h - 48) : at.y });
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, []);
  const onKey = (e: KeyboardEvent) => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); els[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); els[els.length - 1]?.focus(); }
    else if (e.key === "Tab") { e.preventDefault(); onClose(); }
  };
  return (
    <div class="cmenu-root">
      <div class="cmenu-scrim" onClick={onClose} />
      <div ref={ref} class="cmenu" role="menu" aria-label="Message actions" style={{ left: `${pos.left}px`, top: `${pos.top}px` }} onKeyDown={onKey} data-testid="msg-menu">
        {items.map((it) => <button type="button" class="cmenu-item" role="menuitem" data-testid={it.id} onClick={() => { onClose(); it.run(); }}>{it.label}</button>)}
      </div>
    </div>
  );
}

/** The answer as plain, natively selectable text (iOS cannot select inside the chat's rich markup reliably): opens with everything selected. */
export function SelectSheet({ text, onClose }: { text: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const s = getSelection(); if (!s) return;
    s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); s.addRange(r);
  }, []);
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Select text" onClick={(e) => e.stopPropagation()} data-testid="select-sheet">
        <div class="grabber" />
        <div ref={box} class="selectable" tabIndex={0} data-testid="select-text">{text}</div>
        <div class="approve"><button class="btn" type="button" onClick={() => copyText(text)}>Copy selection</button><button class="btn primary" type="button" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

/** Edit an earlier message: the edited text starts a NEW chat that keeps everything before it; this chat is left untouched. */
export function EditSheet({ initial, busy, error, onCancel, onSubmit }: { initial: string; busy: boolean; error: string; onCancel: () => void; onSubmit: (text: string) => void }) {
  const [v, setV] = useState(initial);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEscape(onCancel);
  useEffect(() => { ta.current?.focus(); ta.current?.setSelectionRange(initial.length, initial.length); }, []);
  const ok = !!v.trim() && !busy;
  return (
    <div class="scrim" onClick={onCancel}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Edit message" onClick={(e) => e.stopPropagation()} data-testid="edit-sheet">
        <div class="grabber" />
        <strong>Edit message</strong>
        <p class="muted small">Your edit starts a new chat from this point. This chat stays as it is.</p>
        <textarea ref={ta} class="edit-ta" rows={5} value={v} aria-label="Edited message" data-testid="edit-text" onInput={(e) => setV(e.currentTarget.value)} />
        {error && <div class="error small" role="alert">{error}</div>}
        <div class="approve">
          <button class="btn" type="button" onClick={onCancel}>Cancel</button>
          <button class="btn primary" type="button" disabled={!ok} data-testid="edit-fork-send" onClick={() => onSubmit(v.trim())}>{busy ? "Starting…" : "Send in new chat"}</button>
        </div>
      </div>
    </div>
  );
}
