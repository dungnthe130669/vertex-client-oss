import { test, expect, drawerSettled, openDrawer } from "./fixtures";
import type { Page } from "@playwright/test";

// Notch / Dynamic Island: the sticky header must carry the top inset in its own box so no header content sits under the cut-out,
// at scroll 0 and while scrolled; the drawer and sheets stay inside it; the composer / FAB / drawer pill clear the home indicator.
// Real iPhones report env(safe-area-inset-*); here the single source of truth (--sat/--sab/--sal/--sar in :root) is overridden.
// Delta-based: every number is compared with the override, not with a hard-coded pixel layout.
const VARIANTS = [
  { n: "dynamic-island", sat: 59, sab: 34, sal: 0, sar: 0 },
  { n: "notch", sat: 47, sab: 34, sal: 0, sar: 0 },
  { n: "landscape", sat: 0, sab: 21, sal: 59, sar: 59 },
];
type V = (typeof VARIANTS)[number];
const SCREENS = ["/", "/chats", "/cloud", "/agents", "/desktop", "/remote", "/usage", "/settings", "/skills"];

// CSSOM (not addStyleTag): the app's CSP is style-src 'self', which blocks injected <style> in Chromium.
const inset = (page: Page, v: V) => page.evaluate((x) => {
  const st = document.documentElement.style;
  for (const k of ["sat", "sab", "sal", "sar"] as const) st.setProperty(`--${k}`, `${x[k]}px`, "important");
}, v);
const barMetrics = async (page: Page) => { await page.locator("header.bar").first().waitFor(); return page.evaluate(() => {
  const bar = document.querySelector("header.bar")!;
  const r = bar.getBoundingClientRect();
  let top = Infinity, left = Infinity, right = -Infinity;
  for (const e of bar.querySelectorAll("button,h1,h2,.title,.tabs,.chip,svg")) {
    if (e.closest(".sr") || getComputedStyle(e).display === "none") continue;
    const b = e.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    top = Math.min(top, b.top); left = Math.min(left, b.left); right = Math.max(right, b.right);
  }
  return { barTop: r.top, barH: r.height, top, left, right, sw: document.documentElement.scrollWidth, iw: innerWidth };
}); };

for (const v of VARIANTS) {
  test.describe(`safe area @${v.n} (sat ${v.sat} sab ${v.sab} sal ${v.sal} sar ${v.sar})`, () => {
    test.beforeEach(async ({ app: { page } }) => {
      const land = v.sal > 0;
      await page.setViewportSize(land ? { width: 852, height: 393 } : { width: 393, height: 852 });
    });

    test("header content is below the cut-out at scroll 0 and after scrolling, on every screen", async ({ app: { page } }) => {
      for (const path of SCREENS) {
        await page.goto(path);
        await inset(page, v);
        let m = await barMetrics(page);
        const at = `${path} scroll0`;
        expect(m.barTop, `${at}: bar top`).toBeLessThanOrEqual(0.5);
        expect(m.top, `${at}: header content top`).toBeGreaterThanOrEqual(v.sat - 0.5);
        expect(m.left, `${at}: left inset`).toBeGreaterThanOrEqual(v.sal - 0.5);
        expect(m.right, `${at}: right inset`).toBeLessThanOrEqual(m.iw - v.sar + 0.5);
        expect(m.barH, `${at}: bar box includes the inset`).toBeGreaterThanOrEqual(v.sat + 56 - 0.5);
        expect(m.sw, `${at}: horizontal overflow`).toBeLessThanOrEqual(m.iw + 1);
        await page.evaluate(() => scrollTo(0, 600));
        m = await barMetrics(page);
        expect(m.barTop, `${path} scrolled: bar stays at viewport top`).toBeLessThanOrEqual(0.5);
        expect(m.top, `${path} scrolled: header content top`).toBeGreaterThanOrEqual(v.sat - 0.5);
      }
    });

    test("chat: header below the cut-out, document does not scroll, composer clears the home indicator", async ({ app: { page, api } }) => {
      const id = await api.newChat();
      try {
        await page.goto(`/c/${id}`);
        await inset(page, v);
        const m = await barMetrics(page);
        expect(m.top).toBeGreaterThanOrEqual(v.sat - 0.5);
        const c = await page.evaluate(() => ({ b: document.querySelector("footer.composer")!.getBoundingClientRect().bottom, ih: innerHeight, sh: document.documentElement.scrollHeight }));
        expect(c.ih - c.b, "gap under the composer >= --sab").toBeGreaterThanOrEqual(v.sab - 0.5);
        expect(c.sh, "chat page must not scroll (inset double-counted)").toBeLessThanOrEqual(c.ih + 1);
      } finally { await api.mut("DELETE", `/api/conversations/${id}`); }
    });

    test("drawer and FAB / sheet stay inside the safe area", async ({ app: { page } }) => {
      test.skip(v.sal > 0, "landscape is wider than 640px: inline header on list screens");
      await page.setViewportSize({ width: 390, height: 852 }); // the overlay drawer is the phone shell (>=1024px has a sidebar)
      await page.goto("/");
      await inset(page, v);
      await openDrawer(page);
      const head = (await page.locator(".drawer-head").boundingBox())!;
      expect(head.y, "drawer header top").toBeGreaterThanOrEqual(v.sat - 0.5);
      const pill = (await page.getByTestId("drawer-avatar").boundingBox())!;
      expect(pill.y + pill.height, "drawer account row bottom").toBeLessThanOrEqual(852 - v.sab + 0.5);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("drawer")).toHaveCount(0);
      for (const path of ["/agents", "/cloud", "/desktop"]) {
        await page.goto(path);
        await inset(page, v);
        const fab = await page.locator(".fab").first().boundingBox();
        if (!fab) continue;
        expect(fab.y + fab.height, `${path} FAB bottom`).toBeLessThanOrEqual(852 - v.sab + 0.5);
        await page.locator(".fab").first().click();
        await page.locator(".sheet").first().waitFor();
        await page.locator(".sheet").first().evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished))).catch(() => {}); // sheet-up slides in from +24px: measure the settled box
        const sh = await page.locator(".sheet").first().boundingBox();
        if (sh) { expect(sh.y, `${path} sheet top`).toBeGreaterThanOrEqual(v.sat - 0.5); expect(sh.y + sh.height).toBeLessThanOrEqual(852 + 0.5); }
      }
    });
  });
}

// Composer bottom gap (bug: ~100px of dead space under the composer on an iPhone PWA, ~55px above the keyboard).
// The composer's bottom edge must sit within GAP px of the safe-area line, on the start screen and in a chat.
const GAP = 12;
test.describe("composer bottom gap", () => {
  test.beforeEach(async ({ app: { page } }) => { await page.setViewportSize({ width: 393, height: 852 }); });
  const gap = (page: Page) => page.evaluate(() => ({ b: document.querySelector("footer.composer")!.getBoundingClientRect().bottom, ih: innerHeight }));

  test("start screen and chat: composer sits just above the home-indicator inset", async ({ app: { page, api } }) => {
    const v = VARIANTS[0];
    await page.goto("/");
    await inset(page, v);
    await page.locator("footer.composer").waitFor();
    let g = await gap(page);
    expect(g.ih - v.sab - g.b, "start: extra space under composer").toBeLessThanOrEqual(GAP + 0.5);
    expect(g.ih - v.sab - g.b).toBeGreaterThanOrEqual(-0.5);
    const id = await api.newChat();
    try {
      await page.goto(`/c/${id}`);
      await inset(page, v);
      await page.locator("footer.composer").waitFor();
      g = await gap(page);
      expect(g.ih - v.sab - g.b, "chat: extra space under composer").toBeLessThanOrEqual(GAP + 0.5);
      expect(g.ih - v.sab - g.b).toBeGreaterThanOrEqual(-0.5);
    } finally { await api.mut("DELETE", `/api/conversations/${id}`); }
  });

  test("keyboard open (visualViewport shrinks, layout viewport panned): composer rides on the keyboard with no inset gap", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    try {
      await page.goto(`/c/${id}`);
      await inset(page, VARIANTS[0]);
      await page.locator("footer.composer").waitFor();
      // Real iOS cannot be driven here: fake a 336px keyboard by overriding the visualViewport the app listens to.
      const r = await page.evaluate(async () => {
        const vv = window.visualViewport!;
        const fake = { height: innerHeight - 336, offsetTop: 0 };
        for (const k of ["height", "offsetTop"] as const) Object.defineProperty(vv, k, { configurable: true, get: () => fake[k] });
        vv.dispatchEvent(new Event("resize"));
        await new Promise((res) => requestAnimationFrame(() => res(null)));
        return { b: document.querySelector("footer.composer")!.getBoundingClientRect().bottom, kbTop: fake.height, kb: document.documentElement.classList.contains("kb") };
      });
      expect(r.kb, "keyboard class set").toBe(true);
      expect(r.kbTop - r.b, "gap between composer and keyboard top").toBeLessThanOrEqual(GAP + 0.5);
      expect(r.kbTop - r.b).toBeGreaterThanOrEqual(-0.5);
    } finally { await api.mut("DELETE", `/api/conversations/${id}`); }
  });
});

test.describe("drawer fills the screen + no touch focus ring", () => {
  test("drawer-root bottom == innerHeight; the active row shows no focus ring after a tap", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // the overlay drawer is the phone shell (>=1024px has a sidebar)
    await page.goto("/");
    await openDrawer(page);
    const m = await page.getByTestId("drawer-scrim").evaluate(() => {
      const r = document.querySelector(".drawer-root")!.getBoundingClientRect();
      return { bottom: r.bottom, ih: innerHeight, top: r.top };
    });
    expect(m.top).toBe(0);
    expect(Math.abs(m.bottom - m.ih)).toBeLessThanOrEqual(1);
    // Recent list scrolls fully clear of the floating footer: scroll padding >= footer height
    const pad = await page.locator(".drawer-scroll").evaluate((e) => ({ pb: parseFloat(getComputedStyle(e).paddingBottom), foot: document.querySelector(".drawer-foot")!.getBoundingClientRect().height }));
    expect(pad.pb).toBeGreaterThanOrEqual(pad.foot);
    // script/touch focus on a row (WebKit treats script focus as keyboard focus) must not draw a ring; only a key press does
    const ring = await page.locator(".drawer .drawer-nav .drow").first().evaluate((e) => { (e as HTMLElement).focus(); return getComputedStyle(e).outlineStyle; });
    expect(ring).toBe("none");
  });
});
