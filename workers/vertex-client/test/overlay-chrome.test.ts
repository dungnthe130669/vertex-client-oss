import { describe, expect, test } from "bun:test";
import { overlayChrome, isFullscreenWindow, TRAFFIC_LIGHT_PAD, OVERLAY_STRIP } from "../web/src/overlay-chrome";

const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const OLD = `${SAFARI} VertexClientDesktop/0.3.2`; // installed 0.3.2 shell: native title bar, no overlay token
const DESK = `${SAFARI} VertexClientDesktop/0.3.3 VertexClientOverlay/1`; // exactly what a macOS 0.3.3 shell emits

describe("overlayChrome", () => {
  test("desktop shell on a Mac window: overlay on", () => {
    expect(overlayChrome(DESK, false)).toBe(true);
  });
  test("installed 0.3.2 shell (no overlay token): never", () => {
    expect(overlayChrome(OLD, false)).toBe(false);
    expect(overlayChrome(`${SAFARI} VertexClientDesktop/0.3.3`, false)).toBe(false);
    expect(overlayChrome(`${SAFARI} VertexClientDesktop/0.3.3 XVertexClientOverlay/1`, false)).toBe(false);
    expect(overlayChrome(`${SAFARI} VertexClientDesktop/0.3.3 VertexClientOverlay/2`, false)).toBe(false);
  });
  test("overlay token without the desktop shell token: never", () => {
    expect(overlayChrome(`${SAFARI} VertexClientOverlay/1`, false)).toBe(false);
  });
  test("fullscreen: the traffic lights are gone, so no overlay padding", () => {
    expect(overlayChrome(DESK, true)).toBe(false);
  });
  test("plain browser / mobile shell / junk: never", () => {
    expect(overlayChrome(SAFARI, false)).toBe(false);
    expect(overlayChrome(`${SAFARI} VertexClientMobile/1.0.0`, false)).toBe(false);
    expect(overlayChrome(undefined, false)).toBe(false);
  });
  test("non-Mac desktop shell (Windows/Linux keep the native title bar): never", () => {
    expect(overlayChrome("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 VertexClientDesktop/0.3.3 VertexClientOverlay/1", false)).toBe(false);
    expect(overlayChrome("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 VertexClientDesktop/0.3.3 VertexClientOverlay/1", false)).toBe(false);
  });
  test("constants clear the three traffic lights (~68px right edge at the default position)", () => {
    expect(TRAFFIC_LIGHT_PAD).toBeGreaterThanOrEqual(76);
    expect(OVERLAY_STRIP).toBeGreaterThanOrEqual(28);
  });
});

describe("isFullscreenWindow", () => {
  test("window as large as the screen, or an element in the Fullscreen API", () => {
    expect(isFullscreenWindow({ innerWidth: 1440, innerHeight: 900, screenW: 1440, screenH: 900, fullscreenElement: false })).toBe(true);
    expect(isFullscreenWindow({ innerWidth: 1200, innerHeight: 800, screenW: 1440, screenH: 900, fullscreenElement: true })).toBe(true);
  });
  test("a zoomed window leaves the menu bar: not fullscreen", () => {
    expect(isFullscreenWindow({ innerWidth: 1440, innerHeight: 850, screenW: 1440, screenH: 900, fullscreenElement: false })).toBe(false);
    expect(isFullscreenWindow({ innerWidth: 1200, innerHeight: 800, screenW: 1440, screenH: 900, fullscreenElement: false })).toBe(false);
  });
  test("unknown screen (0) is not fullscreen", () => {
    expect(isFullscreenWindow({ innerWidth: 0, innerHeight: 0, screenW: 0, screenH: 0, fullscreenElement: false })).toBe(false);
  });
});

describe("appbar2c: drag strip CSS", () => {
  const css = require("node:fs").readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8") as string;
  test("strip is shown on every overlay page (not media-gated), steps aside only for the app bar, sits below modals", () => {
    expect(css).toMatch(/html\.vc-overlay \.ovl-drag \{ display:block; position:fixed; top:0; left:0; right:0; height:30px; z-index:70;/);
    expect(css).toMatch(/html\.vc-overlay\.vc-has-appbar \.ovl-drag \{ display:none; \}/);
    expect(css).not.toMatch(/:has\(\.appbar\)/); // macOS 12 WebKit has no :has(): the strip must not depend on it
  });
  test("login Email/Continue gap is 12px", () => {
    expect(css).toMatch(/\[data-testid\^="login-"\] \.btn \{ margin-top:12px; \}/);
  });
});

describe("appbar2d: vc-has-appbar root class", () => {
  const { appbarMounted } = require("../web/src/overlay-chrome") as typeof import("../web/src/overlay-chrome");
  const mk = (overlay: boolean) => {
    const set = new Set<string>(overlay ? ["vc-overlay"] : []);
    return { classList: { add: (c: string) => set.add(c), remove: (...cs: string[]) => cs.forEach((c) => set.delete(c)), contains: (c: string) => set.has(c), toggle: (c: string, on?: boolean) => { const v = on ?? !set.has(c); if (v) set.add(c); else set.delete(c); return v; } } } as unknown as HTMLElement;
  };
  test("counter: class stays while any bar is mounted, goes when the last unmounts, double dispose is harmless", () => {
    const r = mk(true); const a = appbarMounted(r), b = appbarMounted(r);
    expect(r.classList.contains("vc-has-appbar")).toBe(true);
    a(); a(); expect(r.classList.contains("vc-has-appbar")).toBe(true);
    b(); expect(r.classList.contains("vc-has-appbar")).toBe(false);
  });
  test("overlay gate: no vc-has-appbar on a non-overlay page, even with a bar mounted", () => {
    const r = mk(false); const a = appbarMounted(r);
    expect(r.classList.contains("vc-has-appbar")).toBe(false);
    a();
  });
});

describe("appbar3: every non-interactive bar element is a drag target or transparent to the pointer", () => {
  const fs = require("node:fs");
  const css = fs.readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8") as string;
  const src = fs.readFileSync(new URL("../web/src/appbar.tsx", import.meta.url), "utf8") as string;
  const header = src.slice(src.indexOf('<header ref={head}'), src.indexOf("</header>"));
  const tags = [...header.matchAll(/<(header|div|span)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: m[2] }));
  test("every plain header/div/span in the AppBar JSX carries data-tauri-drag-region (buttons/menus do not)", () => {
    expect(tags.length).toBeGreaterThanOrEqual(7);
    for (const t of tags) expect(t.attrs).toContain("data-tauri-drag-region");
    expect(header).not.toMatch(/<button[^>]*data-tauri-drag-region/);
  });
  test("the title text never intercepts the pointer in the overlay shell (target falls through to the drag-region wrapper)", () => {
    expect(css).toMatch(/html\.vc-overlay \.appbar \.ab-title \{[^}]*pointer-events:none/);
    expect(css).toMatch(/html\.vc-overlay \.appbar \.ab-title \{[^}]*user-select:none/);
  });
  test("pointer-events:none is scoped to the overlay, never the interactive controls", () => {
    expect(css).not.toMatch(/(^|\n)\s*\.ab-title \{[^}]*pointer-events/);
    expect(css).not.toMatch(/\.appbar \.abtn[^{]*\{[^}]*pointer-events:none/);
  });
});
