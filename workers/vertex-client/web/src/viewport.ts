// Tracks the visual viewport for the chat screen. In an iOS standalone PWA, 100dvh does not follow the keyboard and Safari pans the
// layout viewport to reveal the focused field, which left the composer floating high (header under the status bar, a stale
// home-indicator inset between the composer and the keyboard). --vvh/--vvt are the visual viewport's height/offset; the keyboard
// covers the home indicator, so the bottom inset is dropped while it is open (:root.kb).
// --appvh is the full-screen height: in a standalone PWA fixed/100dvh/vv heights can end ~60pt short of the screen bottom (a page-bg
// strip below the drawer), so there it is the max of every height that can be trusted; in a browser tab it is just the visual viewport.
const KB_MIN = 120;

export interface VpEnv { inner: number; vvHeight: number; vvTop: number; lvh: number; screenH: number; standalone: boolean; portrait: boolean; kb: boolean }

/** The app's full height in px (pure; unit-tested). Keyboard open: the visual viewport as it is. */
export function appVh(e: VpEnv): number {
  if (e.kb) return Math.round(e.vvHeight);
  if (!e.standalone) return Math.round(e.vvHeight);
  const c = [e.inner, e.vvHeight + e.vvTop, e.lvh];
  if (e.portrait) c.push(e.screenH);
  return Math.round(Math.max(...c.filter((n) => Number.isFinite(n) && n > 0)));
}

/** Keyboard open? In an iOS standalone PWA innerHeight shrinks WITH the keyboard, so the inner-vs-visual gap alone misses it:
 *  also true when an editable field has focus and the visual viewport is well below the full screen height. */
export function keyboardOpen(e: Pick<VpEnv, "inner" | "vvHeight" | "vvTop" | "lvh" | "screenH" | "portrait"> & { editable: boolean }): boolean {
  if (e.inner - e.vvHeight - e.vvTop > KB_MIN) return true;
  const ref = Math.max(e.inner, e.lvh || 0, e.portrait ? e.screenH || 0 : 0);
  return e.editable && e.vvHeight < ref * 0.8;
}

const isEditable = (el: Element | null): boolean => !!el && (el.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]),textarea,[contenteditable=''],[contenteditable=true]"));

export const isStandalone = (): boolean => matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

/** Set styles one property at a time through the CSSOM: `style.cssText=` (and a string `style=` prop in Preact) is an inline-style attribute write, which WebKit reports as style-src-attr under `style-src 'self'`; `style.setProperty` is not. */
export function setStyles(el: HTMLElement, props: Record<string, string>): void {
  for (const k in props) el.style.setProperty(k, props[k]);
}

/** Computed px of a CSS length (100vh / 100dvh / 100lvh) through a hidden probe element (CSSOM only: the CSP is style-src 'self'). */
export function probePx(len: string, doc: Document = document): number {
  const p = doc.createElement("div");
  setStyles(p, { position: "fixed", left: "0", top: "0", width: "0", visibility: "hidden", "pointer-events": "none", height: len });
  doc.body.appendChild(p);
  const h = p.getBoundingClientRect().height;
  p.remove();
  return h;
}

export function trackViewport(root: HTMLElement = document.documentElement, vv: VisualViewport | null = window.visualViewport): void {
  if (!vv) return;
  const sync = () => {
    const lvh = probePx("100lvh"), portrait = innerHeight >= innerWidth;
    const kb = keyboardOpen({ inner: innerHeight, vvHeight: vv.height, vvTop: vv.offsetTop, lvh, screenH: screen.height, portrait, editable: isEditable(document.activeElement) });
    const h = appVh({ inner: innerHeight, vvHeight: vv.height, vvTop: vv.offsetTop, lvh, screenH: screen.height, standalone: isStandalone(), portrait, kb });
    root.style.setProperty("--appvh", `${h}px`);
    root.style.setProperty("--vvh", `${kb ? Math.round(vv.height) : h}px`);
    root.style.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
    root.classList.toggle("kb", kb);
    if (kb) { const m = document.querySelector<HTMLElement>(".chat .msgs"); if (m && document.activeElement?.closest(".composer")) m.scrollTop = m.scrollHeight; }
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  addEventListener("focusin", () => setTimeout(sync, 300));
  addEventListener("focusout", () => setTimeout(sync, 300));
  addEventListener("orientationchange", sync);
  sync();
}
