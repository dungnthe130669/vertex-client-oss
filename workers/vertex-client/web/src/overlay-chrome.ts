import { desktopShellVersion } from "./desktop-info";

/** Phase 2 of the app bar: on macOS the desktop shell draws the window with an overlay title bar (tauri `titleBarStyle: "Overlay"`), so the traffic lights sit on top of the
 *  page. The page then (a) clears them (left padding in the >=1024px app bar, a top strip below it) and (b) gives up that room in fullscreen, where the lights are gone.
 *  Windows / Linux keep the native title bar (their UA has no `VertexClientOverlay/1` token, which only overlay-enabled macOS builds append), so nothing changes there. */
export const TRAFFIC_LIGHT_PAD = 80; // px: the right edge of the zoom light is ~68px at the default position, + a gap before the sidebar toggle
export const OVERLAY_STRIP = 30; // px: the draggable top strip of the narrow (<1024px) layout, which has no app bar

/** Explicit feature token appended to the UA only by overlay-enabled macOS desktop builds (>= 0.3.3). An installed 0.3.2 shell has the same Macintosh UA but a native title bar. */
const OVERLAY_TOKEN = /(?:^|\s)VertexClientOverlay\/1(?=\s|$)/;

export const overlayChrome = (ua: unknown, fullscreen: boolean): boolean =>
  !fullscreen && desktopShellVersion(ua) !== null && typeof ua === "string" && /\bMacintosh\b/.test(ua) && OVERLAY_TOKEN.test(ua);

export type Screenish = { innerWidth: number; innerHeight: number; screenW: number; screenH: number; fullscreenElement: boolean };
/** macOS native fullscreen: the window fills the whole screen (menu bar hidden). A zoomed window keeps the menu bar, so it is shorter than the screen. */
export const isFullscreenWindow = (s: Screenish): boolean =>
  s.fullscreenElement || (s.screenW > 0 && s.screenH > 0 && s.innerWidth >= s.screenW && s.innerHeight >= s.screenH);

/** Sets `vc-overlay` on <html> (CSS: --ab-pad-l, the top strip, --sat) and keeps it in step with fullscreen / resize. Returns a disposer. */
export function installOverlayChrome(w: Window = window): () => void {
  const root = w.document.documentElement;
  const ua = w.navigator.userAgent;
  if (!overlayChrome(ua, false)) return () => {};
  const strip = w.document.createElement("div");
  strip.className = "ovl-drag";
  strip.setAttribute("data-tauri-drag-region", "");
  strip.setAttribute("data-testid", "overlay-drag");
  strip.setAttribute("aria-hidden", "true");
  w.document.body.appendChild(strip);
  const sync = () => {
    const fs = isFullscreenWindow({ innerWidth: w.innerWidth, innerHeight: w.innerHeight, screenW: w.screen?.width ?? 0, screenH: w.screen?.height ?? 0, fullscreenElement: !!w.document.fullscreenElement });
    root.classList.toggle("vc-overlay", overlayChrome(ua, fs));
    syncAppbar(root);
  };
  sync();
  w.addEventListener("resize", sync);
  w.document.addEventListener("fullscreenchange", sync);
  return () => { w.removeEventListener("resize", sync); w.document.removeEventListener("fullscreenchange", sync); root.classList.remove("vc-overlay", "vc-has-appbar"); strip.remove(); };
}

let bars = 0;
/** `vc-has-appbar` exists exactly when `vc-overlay` exists AND at least one app bar is mounted (also after a fullscreen exit without a remount). */
const syncAppbar = (root: HTMLElement) => { root.classList.toggle("vc-has-appbar", bars > 0 && root.classList.contains("vc-overlay")); };
/** Marks <html> with `vc-has-appbar` while at least one app bar is mounted on an overlay page (CSS hides the drag strip then; `:has()` is not available in the macOS 12 WebView). Returns the unmount callback. */
export function appbarMounted(root: HTMLElement = document.documentElement): () => void {
  bars++; syncAppbar(root);
  let done = false;
  return () => { if (done) return; done = true; bars = Math.max(0, bars - 1); syncAppbar(root); };
}
