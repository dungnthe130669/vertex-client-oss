import { test, expect, type Page } from "@playwright/test";
import { mockApp } from "./polish-mock";

// appbar2: the macOS overlay title bar. The page cannot see a real window, so the native shell is faked with the UA a macOS 0.3.3 shell emits (`VertexClientDesktop/x.y.z VertexClientOverlay/1`, Macintosh UA).
// Real traffic lights / drag / zoom / fullscreen are checked on a Mac, not here. Local build via polish/serve.mjs (E2E_BASE_URL).
test.use({ serviceWorkers: "block", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 VertexClientDesktop/0.3.3 VertexClientOverlay/1" });

async function open(p: Page, w: number, h = 800) {
  await p.setViewportSize({ width: w, height: h });
  await p.addInitScript(() => { Object.defineProperty(window.screen, "width", { value: 1920, configurable: true }); Object.defineProperty(window.screen, "height", { value: 1080, configurable: true }); }); // setViewportSize makes the screen equal to the viewport, which the page would read as fullscreen
  await mockApp(p, { erich: true });
  await p.goto("/library"); await p.waitForLoadState("networkidle").catch(() => {});
}
const padL = (p: Page) => p.getByTestId("appbar").evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft));

test.describe("overlay title bar @desktop-only", () => {
  test("wide: bar clears the traffic lights; toggle starts right of 80px; drag regions on empty areas, buttons stay clickable", async ({ page }) => {
    await open(page, 1280);
    await expect(page.locator("html")).toHaveClass(/vc-overlay/);
    expect(await padL(page)).toBe(80);
    const t = (await page.getByTestId(/sidebar-(toggle|open)/).boundingBox())!;
    expect(t.x).toBeGreaterThanOrEqual(80);
    for (const sel of ["[data-testid=appbar]", ".ab-left", ".ab-right"]) await expect(page.locator(sel)).toHaveAttribute("data-tauri-drag-region", /^(true)?$/);
    for (const id of ["appbar-search", "appbar-more", "appbar-settings"]) await expect(page.getByTestId(id)).not.toHaveAttribute("data-tauri-drag-region", /.*/);
    await expect(page.getByTestId("overlay-drag")).toBeHidden(); // the strip is only for the narrow layout
    await page.getByTestId("appbar-settings").click(); // still a normal button
    await expect(page.getByTestId("appbar-settings")).toBeVisible();
  });
  test("sidebar hidden: toggle still clears the lights", async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem("vc:sidebar", "closed"); } catch { /* ignore */ } });
    await open(page, 1280);
    const t = (await page.getByTestId("sidebar-open").boundingBox())!;
    expect(t.x).toBeGreaterThanOrEqual(80);
  });
  test("narrow (480px, the window minimum): top 30px draggable strip, content below it", async ({ page }) => {
    await open(page, 480);
    await expect(page.locator("html")).toHaveClass(/vc-overlay/);
    const s = page.getByTestId("overlay-drag");
    await expect(s).toBeVisible(); await expect(s).toHaveAttribute("data-tauri-drag-region", /^(true)?$/);
    const b = (await s.boundingBox())!; expect(b.y).toBe(0); expect(b.height).toBe(30); expect(b.width).toBe(480);
    expect(await page.locator("#app").evaluate((e) => parseFloat(getComputedStyle(e).paddingTop))).toBe(30); // every phone-layout screen is padded by --sat, so nothing sits under the strip
  });
  test("fullscreen: padding and strip go away; leaving fullscreen brings them back", async ({ page }) => {
    await open(page, 1280);
    expect(await padL(page)).toBe(80);
    // the page treats a window as large as the screen as fullscreen: emulate with the screen size equal to the viewport
    await page.evaluate(() => { Object.defineProperty(window.screen, "width", { value: innerWidth, configurable: true }); Object.defineProperty(window.screen, "height", { value: innerHeight, configurable: true }); dispatchEvent(new Event("resize")); });
    await expect(page.locator("html")).not.toHaveClass(/vc-overlay/);
    expect(await padL(page)).toBe(12);
    await page.evaluate(() => { Object.defineProperty(window.screen, "height", { value: innerHeight + 100, configurable: true }); dispatchEvent(new Event("resize")); });
    await expect(page.locator("html")).toHaveClass(/vc-overlay/);
    expect(await padL(page)).toBe(80);
  });
});

// appbar2c: the window must be draggable on pages with no app shell (login). Signed-out mock: /api/me 401, /auth/config with the email step.
async function openLogin(p: Page, w: number) {
  await p.setViewportSize({ width: w, height: 800 });
  await p.addInitScript(() => { Object.defineProperty(window.screen, "width", { value: 1920, configurable: true }); Object.defineProperty(window.screen, "height", { value: 1080, configurable: true }); });
  await mockApp(p, { erich: true });
  await p.route("**/api/me", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) }));
  await p.route("**/auth/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ github: false, sso: true, emailStep: true }) }));
  await p.goto("/"); await p.getByTestId("login-email-step").waitFor();
}
const topEl = (p: Page, x: number, y: number) => p.evaluate(([a, b]) => { const e = document.elementFromPoint(a, b); return { drag: e?.hasAttribute("data-tauri-drag-region") ?? false, id: e?.getAttribute("data-testid") ?? "", inside: Array.from(document.querySelectorAll("[data-testid]")).filter((n) => n.contains(e)).map((n) => n.getAttribute("data-testid")) }; }, [x, y]);
test.describe("overlay: login + shell drag regions @desktop-only", () => {
  for (const w of [1280, 480]) test(`login at ${w}px: top strip is the drag region, Email/Continue have a >=12px gap`, async ({ page }) => {
    await openLogin(page, w);
    await expect(page.locator("html")).toHaveClass(/vc-overlay/);
    expect(await topEl(page, 200, 10)).toMatchObject({ drag: true, id: "overlay-drag" });
    const e = (await page.getByLabel("Email").boundingBox())!, c = (await page.getByRole("button", { name: "Continue" }).boundingBox())!;
    expect(c.y - (e.y + e.height)).toBeGreaterThanOrEqual(12);
  });
  test("shell at 1280: strip stays out of the way, every bar button is the topmost element", async ({ page }) => {
    await open(page, 1280);
    await expect(page.getByTestId("overlay-drag")).toBeHidden();
    for (const id of ["appbar-search", "appbar-more", "appbar-settings"]) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(await topEl(page, b.x + b.width / 2, b.y + b.height / 2)).toMatchObject({ inside: expect.arrayContaining([id]) });
    }
  });
  test("appbar2d: vc-has-appbar follows the bar's mount/unmount (no :has() involved), strip returns when the bar is gone", async ({ page }) => {
    await open(page, 1280);
    const html = page.locator("html");
    await expect(html).toHaveClass(/vc-has-appbar/);
    await expect(page.getByTestId("overlay-drag")).toBeHidden();
    const css = await page.evaluate(async () => (await Promise.all(Array.from(document.styleSheets).map(async (s) => { try { return Array.from(s.cssRules).map((r) => r.cssText).join("\n"); } catch { return ""; } }))).join("\n"));
    expect(css).not.toContain(":has(.appbar)");
    await page.setViewportSize({ width: 800, height: 800 }); // < 1024: DeskShell (and the bar) unmount
    await expect(page.getByTestId("appbar")).toHaveCount(0);
    await expect(html).not.toHaveClass(/vc-has-appbar/);
    await expect(page.getByTestId("overlay-drag")).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(html).toHaveClass(/vc-has-appbar/);
    await expect(page.getByTestId("overlay-drag")).toBeHidden();
  });
  test("login: no bar, no vc-has-appbar class", async ({ page }) => {
    await openLogin(page, 1280);
    await expect(page.locator("html")).not.toHaveClass(/vc-has-appbar/);
    await expect(page.getByTestId("overlay-drag")).toBeVisible();
  });
  test("shell at 480: exactly one 30px strip, not doubled", async ({ page }) => {
    await open(page, 480);
    await expect(page.getByTestId("overlay-drag")).toHaveCount(1);
    await expect(page.locator("[data-tauri-drag-region]").first()).toHaveAttribute("data-testid", "overlay-drag");
    expect(await topEl(page, 200, 10)).toMatchObject({ drag: true, id: "overlay-drag" });
  });
});

test.describe("plain browser is untouched @desktop-only", () => {
  test.use({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" });
  test("no overlay class, 12px padding, no strip", async ({ page }) => {
    await open(page, 1280);
    await expect(page.locator("html")).not.toHaveClass(/vc-overlay/);
    expect(await padL(page)).toBe(12);
    await expect(page.getByTestId("overlay-drag")).toHaveCount(0);
  });
});

// appbar2b: shells that must NOT get the overlay chrome (no feature token): installed 0.3.2 (same Macintosh UA, native title bar), Windows / Linux builds.
for (const [name, ua] of [
  ["installed 0.3.2 shell (no overlay token)", "%s VertexClientDesktop/0.3.2"],
  ["0.3.3 desktop UA without the token", "%s VertexClientDesktop/0.3.3"],
  ["Windows-style desktop UA", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 VertexClientDesktop/0.3.3"],
  ["Linux-style desktop UA", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 VertexClientDesktop/0.3.3"],
] as const) {
  test.describe(`${name} is untouched @desktop-only`, () => {
    test.use({ userAgent: ua.replace("%s", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15") });
    test("no overlay class, 12px padding, no strip", async ({ page }) => {
      await open(page, 1280);
      await expect(page.locator("html")).not.toHaveClass(/vc-overlay/);
      expect(await padL(page)).toBe(12);
      await expect(page.getByTestId("overlay-drag")).toHaveCount(0);
      await open(page, 800);
      await expect(page.getByTestId("overlay-drag")).toHaveCount(0);
      await openLogin(page, 1280);
      await expect(page.getByTestId("overlay-drag")).toHaveCount(0);
    });
  });
}
