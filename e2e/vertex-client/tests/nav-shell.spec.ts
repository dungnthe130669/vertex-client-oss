import { test, expect, type Page } from "@playwright/test";
import { mockApp, IDS, REMOTE_IDS } from "./polish-mock";

// Every screen needs a way to the menu and a way back, at every width, in a browser and in the native desktop shell (which has no browser Back button).
// API mocked in the browser (no login, no cost); the document under test is whatever E2E_BASE_URL serves (the live build or a local build via polish/serve.mjs).
test.use({ serviceWorkers: "block" });

const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) VertexClientDesktop/0.9.0";
// Top-level screens (a drawer destination / mode list): menu on every width < 1024 (the sidebar / its expand button at >= 1024), Back in the native shell.
const ROOTS = ["/chats", "/cloud", "/agents", "/desktop", "/remote", "/projects", "/artifacts", "/library", "/notifications"];
// Detail / sub screens: their own Back at every width (the desktop modal / panel have their own Close).
const DETAILS = ["/usage", "/about", "/skills", "/connectors", "/connectors/new", `/projects/${IDS.project}`, `/artifacts/${IDS.artifact}`, `/m/${encodeURIComponent(REMOTE_IDS.running)}`, "/settings/profile", "/settings/appearance"];

const visible = (page: Page, sel: string) => page.locator(sel).filter({ visible: true });
async function open(page: Page, path: string) { await page.goto(path); await page.waitForLoadState("networkidle").catch(() => {}); await expect(page.locator(".bar").filter({ visible: true }).first()).toBeVisible(); }
/** A way to the menu: the hamburger (<1024), or the persistent sidebar / its expand button (>=1024). */
const menuCount = async (page: Page) => (await visible(page, '[data-testid="menu-button"], [data-testid="sidebar-open"], [data-testid="sidebar"][data-open="true"]').count());

for (const native of [false, true]) {
  test.describe(`nav shell (${native ? "desktop app UA" : "browser"})`, () => {
    test.use({ userAgent: native ? DESKTOP_UA : undefined });
    for (const w of [390, 700, 1280]) {
      test(`top-level screens have the menu${native ? " and Back" : ""} @${w}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: 800 });
        await mockApp(page, { erich: true });
        for (const path of ROOTS) {
          await open(page, path);
          expect(await menuCount(page), `${path} @${w}: no menu control`).toBeGreaterThan(0);
          const back = visible(page, '.bar [data-testid="root-back"]');
          if (native) await expect(back, `${path} @${w}: no Back in the desktop app`).toHaveCount(1);
          else await expect(back, `${path} @${w}: the browser has its own Back`).toHaveCount(0);
          if (w < 1024) { // the hamburger really opens the drawer
            await visible(page, '[data-testid="menu-button"]').first().click();
            await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(page.getByTestId("drawer")).toHaveCount(0);
          }
        }
      });
    }

    test(`detail screens keep their Back @390 and @1280`, async ({ page }) => {
      await mockApp(page, { erich: true });
      for (const w of [390, 1280]) {
        await page.setViewportSize({ width: w, height: 800 });
        for (const path of DETAILS) {
          await open(page, path);
          const back = visible(page, '.bar button[aria-label="Back"], [data-testid="settings-modal-close"], [data-testid="artifact-panel"] [data-testid="artifact-close"]');
          if (w === 390) await expect(back.first(), `${path} @390: no Back`).toBeVisible();
          else expect(await menuCount(page) + await back.count(), `${path} @1280: neither menu nor Back`).toBeGreaterThan(0);
        }
      }
    });
  });
}

test("native shell: Back on a top-level screen goes home, or back in-app history", async ({ page, browser }) => {
  const ctx = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 700, height: 800 }, serviceWorkers: "block" });
  const p = await ctx.newPage(); await mockApp(p, { erich: true });
  await open(p, "/library"); // deep link: no in-app entry to return to -> start screen
  const tap = async () => { const b = (await p.getByTestId("root-back").boundingBox())!; expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44); await p.getByTestId("root-back").click(); };
  await tap();
  await expect(p).toHaveURL(/\/$/);
  await open(p, "/chats"); // pushed from inside the app -> real history.back()
  await p.evaluate(() => { history.pushState({ fromApp: true }, "", "/library"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(p.getByTestId("library-screen")).toBeVisible();
  await tap();
  await expect(p).toHaveURL(/\/chats$/);
  await ctx.close();
});

// The compact header (hamburger) must take over before the inline tabs + actions overflow: no horizontal scroll, Menu/Usage/Settings reachable.
for (const w of [641, 700, 767, 768, 1023, 1024]) {
  for (const path of ["/chats", "/library"]) {
    test(`mode-list header fits without overflow ${path} @${w}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 });
      await mockApp(page, { erich: true });
      await open(page, path);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(m.sw, `${path} @${w}: document ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
      // Menu is a direct control, or Usage/Settings are inline (all inside the viewport); either way each must be reachable on screen.
      const inView = async (sel: string) => { const l = visible(page, sel); if (!(await l.count())) return false; const b = (await l.first().boundingBox())!; return b.x >= 0 && b.x + b.width <= w; };
      if (w < 1024) expect(await inView('[data-testid="menu-button"]'), `${path} @${w}: Menu not on screen`).toBe(true);
      else expect(await menuCount(page), `${path} @${w}: no sidebar / expand button`).toBeGreaterThan(0); // >=1024: the persistent sidebar replaces the hamburger
      // Usage / Settings are in the drawer (compact) or inline; open the drawer when not inline-visible.
      const inline = (await visible(page, '.bar button[aria-label="Usage"], .bar button[aria-label="Settings"]').count()) > 0;
      if (inline) { expect(await inView('.bar button[aria-label="Usage"]'), `${path} @${w}: Usage off-screen`).toBe(true); expect(await inView('.bar button[aria-label="Settings"]'), `${path} @${w}: Settings off-screen`).toBe(true); }
    });
  }
}

// Sidebar like the Claude desktop app (>=1024px, mouse): pinned, or hidden with a temporary hover overlay; clicking the toggle pins / hides.
test.describe("sidebar: pin / hide / hover overlay @desktop-only", () => {
  const shot = (page: Page, name: string) => process.env.NAVFIX2_SHOTS ? page.screenshot({ path: `${process.env.NAVFIX2_SHOTS}/${name}.png` }) : Promise.resolve(undefined);
  const mainBox = async (page: Page) => (await page.getByTestId("dmain").boundingBox())!;
  const sb = (page: Page) => page.getByTestId("sidebar");
  async function start(page: Page, w = 1280, hidden = false) {
    await page.setViewportSize({ width: w, height: 800 });
    await mockApp(page, { erich: true });
    if (hidden) await page.addInitScript(() => { try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("vc:sidebar", "closed"); } } catch { /* ignore */ } });
    await open(page, "/chats");
  }

  test("hidden: hover the left edge shows an overlay with no layout shift; leaving closes it", async ({ page }) => {
    await start(page, 1280, true);
    await expect(sb(page)).toHaveAttribute("data-open", "false");
    await expect(sb(page)).toBeHidden();
    const before = await mainBox(page);
    await shot(page, "1-hidden");
    await page.mouse.move(400, 300); await page.mouse.move(3, 300); await page.mouse.move(5, 320);
    await expect(sb(page)).toBeVisible();
    await expect(sb(page)).toHaveAttribute("data-peek", "true");
    await expect(sb(page)).toHaveAttribute("data-open", "false"); // an overlay, not pinned
    expect(await mainBox(page)).toEqual(before);                 // main did not move or resize
    await expect.poll(async () => (await sb(page).boundingBox())!.x, { timeout: 2000 }).toBeGreaterThanOrEqual(-1);
    await shot(page, "2-hover-overlay");
    await page.mouse.move(700, 300); // away from the overlay and the hot zone
    await page.waitForTimeout(100);
    await expect(sb(page)).toHaveAttribute("data-peek", "true"); // grace period: a zero-delay close fails here
    await expect(sb(page)).toHaveAttribute("data-peek", "false");
    await expect(sb(page)).toBeHidden({ timeout: 3000 });
    expect(await mainBox(page)).toEqual(before);
  });

  test("a stationary pointer stays over the overlay; leaving the combined area closes it after the delay", async ({ page }) => {
    await start(page, 1280, true);
    await page.mouse.move(700, 300); await page.mouse.move(5, 300); // one move onto the hot zone, then stop
    await expect(sb(page)).toHaveAttribute("data-peek", "true");
    await page.waitForTimeout(600);
    await expect(sb(page)).toHaveAttribute("data-peek", "true");
    await page.mouse.move(100, 300); // inside the overlay now: still open
    await page.waitForTimeout(400);
    await expect(sb(page)).toHaveAttribute("data-peek", "true");
    await page.mouse.move(700, 300);
    await expect(sb(page)).toHaveAttribute("data-peek", "false", { timeout: 3000 });
  });

  const peekOpen = async (page: Page) => { await page.mouse.move(700, 300); await page.mouse.move(5, 300); await expect(sb(page)).toHaveAttribute("data-peek", "true"); await expect.poll(async () => (await sb(page).boundingBox())!.x).toBeGreaterThanOrEqual(0); /* slide-in finished: a mid-slide overlay can pass under the pointer */ };
  const fire = (page: Page, type: string, pointerType: string) => page.evaluate(([t, pt]) => document.querySelector('[data-testid="sidebar"]')!.dispatchEvent(new PointerEvent(t, { pointerType: pt, relatedTarget: null, bubbles: false })), [type, pointerType]);

  test("keyboard focus leaving the overlay does not close it while the mouse is still over it", async ({ page }) => {
    await start(page, 1280, true);
    await peekOpen(page);
    await page.mouse.move(110, 300); // park inside the overlay
    await sb(page).getByRole("button", { name: "Settings" }).focus();
    await page.keyboard.press("Tab"); // focus leaves the sidebar
    await page.waitForTimeout(600);
    await expect(sb(page)).toHaveAttribute("data-peek", "true");
    await page.mouse.move(700, 300); // really leaving still closes it
    await expect(sb(page)).toHaveAttribute("data-peek", "false", { timeout: 3000 });
  });

  test("Esc from inside the overlay closes it and restores focus even with the mouse parked over it", async ({ page }) => {
    await start(page, 1280, true);
    await peekOpen(page);
    await page.mouse.move(110, 300); // park inside
    await page.getByTestId("sidebar-open").focus();
    await page.keyboard.press("Shift+Tab"); // back into the sidebar
    await expect(sb(page).locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sidebar-open")).toBeFocused();
    await page.waitForTimeout(600);
    await expect(sb(page)).toHaveAttribute("data-peek", "false");
    // and a later hover + real leave still opens and closes it
    await page.mouse.move(700, 300); await peekOpen(page); await page.mouse.move(700, 300);
    await expect(sb(page)).toHaveAttribute("data-peek", "false", { timeout: 3000 });
  });

  test("a touch pointerleave does not close a mouse-hovered overlay; a mouse leaving the window does", async ({ page }) => {
    await start(page, 1280, true);
    await peekOpen(page);
    await page.mouse.move(110, 300);
    await fire(page, "pointerleave", "touch");
    await page.waitForTimeout(600);
    await expect(sb(page)).toHaveAttribute("data-peek", "true");
    await fire(page, "pointerleave", "mouse"); // relatedTarget null, as when the mouse leaves the window
    await expect(sb(page)).toHaveAttribute("data-peek", "false", { timeout: 3000 });
  });

  test("a touch pointerenter does not cancel a pending close", async ({ page }) => {
    await start(page, 1280, true);
    await peekOpen(page);
    await page.mouse.move(110, 300); // off the 12px hot zone: a closed overlay must not re-open under a parked pointer
    await fire(page, "pointerleave", "mouse"); // close timer starts
    await fire(page, "pointerenter", "touch");
    await expect(sb(page)).toHaveAttribute("data-peek", "false", { timeout: 3000 });
  });

  test("same for the toggle button: one hover, no further movement, stays open", async ({ page }) => {
    await start(page, 1280, true);
    await page.mouse.move(700, 300);
    await page.getByTestId("sidebar-open").hover();
    await page.waitForTimeout(600);
    await expect(sb(page)).toHaveAttribute("data-peek", "true");
  });

  test("hovering the toggle button shows the overlay too", async ({ page }) => {
    await start(page, 1280, true);
    await page.mouse.move(700, 300);
    await page.getByTestId("sidebar-open").hover();
    await expect(sb(page)).toBeVisible();
  });

  test("a pointer that never moved does not open it; a pressed button (selection drag) does not either", async ({ page }) => {
    await start(page, 1280, true);
    await page.waitForTimeout(400);
    await expect(sb(page)).toBeHidden(); // playwright's pointer sits at 0,0 inside the hot zone: no move, no overlay
    await page.mouse.move(600, 300); await page.mouse.down();
    await page.mouse.move(3, 300); await page.mouse.move(5, 310);
    await expect(sb(page)).toBeHidden();
    await page.mouse.up();
  });

  test("Esc closes the overlay; picking a destination closes it", async ({ page }) => {
    await start(page, 1280, true);
    await page.mouse.move(700, 300); await page.mouse.move(4, 300); await page.mouse.move(6, 300);
    await expect(sb(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sb(page)).toBeHidden();
    await page.mouse.move(700, 300); await page.mouse.move(4, 300); await page.mouse.move(6, 300);
    await expect(sb(page)).toBeVisible();
    await sb(page).locator(".drow").filter({ hasText: /Library|Projects|Artifacts/ }).first().click();
    await page.mouse.move(6, 310); // still on the edge: a closed-by-selection overlay must not pop straight back before the pointer leaves... it may on a fresh move, so move away first
    await page.mouse.move(700, 300);
    await expect(sb(page)).toBeHidden({ timeout: 3000 });
  });

  test("keyboard focus inside keeps the overlay open past the close delay", async ({ page }) => {
    await start(page, 1280, true);
    await page.mouse.move(700, 300); await page.mouse.move(4, 300); await page.mouse.move(6, 300);
    await expect(sb(page)).toBeVisible();
    await sb(page).locator(".drow").first().focus(); // focus inside the overlay (the toggle itself now lives in the app bar)
    await page.mouse.move(700, 300);
    await page.waitForTimeout(700);
    await expect(sb(page)).toBeVisible();
  });

  test("click the toggle: hidden -> pinned (main shifts); click again: hidden; reload keeps the choice", async ({ page }) => {
    await start(page, 1280, true);
    const hiddenBox = await mainBox(page);
    expect(hiddenBox.x).toBeLessThan(2);
    const btn = page.getByTestId("sidebar-open");
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    await expect(btn).toHaveAttribute("aria-label", "Show sidebar");
    await btn.click();
    await expect(sb(page)).toHaveAttribute("data-open", "true");
    await expect(async () => expect((await mainBox(page)).x).toBeGreaterThan(200)).toPass();
    await shot(page, "3-pinned");
    const t = page.getByTestId("sidebar-toggle");
    await expect(t).toHaveAttribute("aria-pressed", "true");
    await expect(t).toHaveAttribute("aria-label", "Hide sidebar");
    await page.reload(); await expect(sb(page)).toHaveAttribute("data-open", "true");
    await page.getByTestId("sidebar-toggle").click();
    await expect(sb(page)).toHaveAttribute("data-open", "false");
    await expect(sb(page)).toBeHidden({ timeout: 3000 });
    await expect(async () => expect((await mainBox(page)).x).toBeLessThan(2)).toPass();
    await page.reload(); await expect(sb(page)).toHaveAttribute("data-open", "false");
    // hover shows it temporarily again after hiding
    await page.mouse.move(700, 300); await page.mouse.move(4, 300); await page.mouse.move(6, 300);
    await expect(sb(page)).toBeVisible();
  });

  test("hover overlay: the app-bar toggle pins it", async ({ page }) => {
    await start(page, 1280, true);
    await page.mouse.move(700, 300); await page.mouse.move(4, 300); await page.mouse.move(6, 300);
    await expect(sb(page)).toBeVisible();
    await page.getByTestId("sidebar-open").click(); // the one toggle, in the app bar: pressing it while the overlay shows pins
    await expect(sb(page)).toHaveAttribute("data-open", "true");
    await page.mouse.move(700, 300);
    await page.waitForTimeout(500);
    await expect(sb(page)).toBeVisible(); // pinned stays
  });

  test("Ctrl/Cmd+B still toggles", async ({ page }) => {
    await start(page);
    await page.keyboard.press("ControlOrMeta+b");
    await expect(sb(page)).toHaveAttribute("data-open", "false");
    await page.keyboard.press("ControlOrMeta+b");
    await expect(sb(page)).toHaveAttribute("data-open", "true");
  });

  test("no inline styles on the sidebar markup (CSP)", async ({ page }) => {
    await start(page, 1280, true);
    await page.mouse.move(700, 300); await page.mouse.move(4, 300); await page.mouse.move(6, 300);
    expect(await page.locator('[data-testid="dshell"] [style]').count()).toBe(0);
  });

  test("@800 unchanged: no persistent sidebar, no hot zone, hamburger drawer", async ({ page }) => {
    await start(page, 800, true);
    await expect(sb(page)).toHaveCount(0);
    await expect(page.getByTestId("sidebar-hot")).toHaveCount(0);
    await page.mouse.move(700, 300); await page.mouse.move(3, 300); await page.mouse.move(5, 300);
    await expect(page.getByTestId("drawer")).toHaveCount(0);
    await visible(page, '[data-testid="menu-button"]').first().click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
  });
});

// Touch / coarse pointer (iphone-webkit): no hover overlay at any width, the hamburger drawer stays the way in below 1024.
test.describe("sidebar: touch @mobile-only", () => {
  test("pointer movement over the left edge never opens the overlay", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockApp(page, { erich: true });
    await page.addInitScript(() => { try { localStorage.setItem("vc:sidebar", "closed"); } catch { /* ignore */ } });
    await open(page, "/chats");
    await page.mouse.move(700, 300); await page.mouse.move(3, 300); await page.mouse.move(5, 320);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-peek", "false");
    await expect(page.getByTestId("sidebar")).toBeHidden();
  });
});
