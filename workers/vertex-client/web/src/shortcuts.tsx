import { useEffect, useState } from "preact/hooks";
import { SHORTCUTS, opensShortcutHelp } from "./chat-ux";
import { useEscape } from "./confirm";

/** Opens the keyboard-shortcuts dialog. Fired by "?" (desktop, outside text fields) and by the palette item "Keyboard shortcuts". */
export const SHORTCUTS_EVENT = "vc:shortcuts";
export const openShortcuts = () => dispatchEvent(new Event(SHORTCUTS_EVENT));

/** Mounted once under the signed-in app. Focus handling (move in, wrap Tab, restore) comes from the shared dialog-focus helper via aria-modal. */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const o = () => setOpen(true);
    const k = (e: KeyboardEvent) => { if (opensShortcutHelp(e, matchMedia("(pointer:fine)").matches) && !document.querySelector('[role="dialog"], [role="alertdialog"]')) { e.preventDefault(); setOpen(true); } };
    addEventListener(SHORTCUTS_EVENT, o); addEventListener("keydown", k);
    return () => { removeEventListener(SHORTCUTS_EVENT, o); removeEventListener("keydown", k); };
  }, []);
  return open ? <ShortcutDialog onClose={() => setOpen(false)} /> : null;
}

function ShortcutDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  return (
    <div class="scrim" onClick={onClose} data-testid="shortcuts-scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()} data-testid="shortcuts">
        <h3 class="confirm-title">Keyboard shortcuts</h3>
        <ul class="kb-list">
          {SHORTCUTS.map((s) => (
            <li class="kb-row" data-testid="shortcut-row">
              <span class="kb-keys">{s.keys.map((k, i) => <>{i > 0 && <span class="muted small"> or </span>}<kbd>{k}</kbd></>)}</span>
              <span class="kb-does">{s.does}<span class="muted small"> · {s.where}</span></span>
            </li>
          ))}
        </ul>
        <div class="approve"><button class="btn primary" onClick={onClose} data-testid="shortcuts-close" autoFocus>Close</button></div>
      </div>
    </div>
  );
}
