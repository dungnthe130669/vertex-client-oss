// One place for modal focus management, so every sheet/dialog (confirm, new-x sheets, models, preview, settings modal, drawer) behaves the same:
// focus moves inside on open, Tab/Shift+Tab wrap inside the topmost dialog, and focus returns to what opened it on close.
// It watches the DOM for [aria-modal=true] / alertdialog nodes instead of every component wiring a hook (components keep their own Escape handling).

const MODAL = '[role="dialog"][aria-modal="true"], [role="alertdialog"]';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Index to focus on Tab (dir 1) / Shift+Tab (dir -1) among `len` focusables, wrapping; `cur` = -1 when focus is outside the list. */
export function wrapIndex(cur: number, len: number, dir: 1 | -1): number {
  if (len <= 0) return -1;
  if (cur < 0) return dir === 1 ? 0 : len - 1;
  return (cur + dir + len) % len;
}

const visible = (el: HTMLElement) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
export const focusablesIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
const topDialog = () => { const all = document.querySelectorAll<HTMLElement>(MODAL); return all.length ? all[all.length - 1] : null; };

let installed = false;
export function installDialogFocus(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  let lastOutside: HTMLElement | null = null; // last element focused/pressed outside any modal = what opened the next one
  const note = (t: EventTarget | null) => { const el = (t as Element | null)?.closest?.<HTMLElement>("button, a[href], input, select, textarea, [tabindex]"); if (el && !el.closest(MODAL) && !el.closest('[role="menu"]')) lastOutside = el; }; // a menu item is not the opener: the menu closes first, the button that opened it is
  document.addEventListener("focusin", (e) => note(e.target), true);
  document.addEventListener("pointerdown", (e) => note(e.target), true); // Safari does not focus buttons on click
  const opener = new WeakMap<Element, HTMLElement | null>();
  const known = new Set<Element>();
  new MutationObserver(() => {
    const now = new Set(document.querySelectorAll(MODAL));
    for (const d of now) if (!known.has(d)) {
      known.add(d); opener.set(d, lastOutside);
      if (!d.contains(document.activeElement)) { const f = focusablesIn(d as HTMLElement)[0]; if (f) f.focus(); else { (d as HTMLElement).tabIndex = -1; (d as HTMLElement).focus(); } }
    }
    for (const d of [...known]) if (!now.has(d)) {
      known.delete(d);
      const back = opener.get(d);
      if (now.size === 0 && back && back.isConnected && (!document.activeElement || document.activeElement === document.body)) back.focus();
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.defaultPrevented) return; // a dialog that handles Tab itself (palette, menus, drawer) wins
    const d = topDialog(); if (!d) return;
    const f = focusablesIn(d); if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (i >= 0 && !(e.shiftKey ? i === 0 : i === f.length - 1)) return; // normal Tab inside
    e.preventDefault(); f[wrapIndex(i, f.length, e.shiftKey ? -1 : 1)].focus();
  });
}
