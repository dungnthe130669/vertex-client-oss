import { test, expect, openDrawer } from "./fixtures";

// About screen against the live app. Delta-based: build/commit values are read from the page and compared with the server's own
// /api/version, never hard-coded. (The two-build "Update ready -> Update now" swap needs a local static server, see docs/reports/about-shots.)
test.describe("about", () => {
  test("Viewport block shows innerHeight and the probes", async ({ app: { page } }) => {
    await page.goto("/about");
    const vp = page.getByTestId("about-viewport");
    await expect(vp).toContainText("innerHeight");
    await expect(vp).toContainText("100vh / 100dvh / 100lvh");
    await expect(vp).toContainText("env(safe-area-inset)");
  });

  test("reachable from the drawer, shows build + commit rows matching /api/version, Check gives a terminal status", async ({ app: { page } }) => {
    await page.goto("/"); // the start screen has the hamburger on every width
    await openDrawer(page);
    await expect(page.getByTestId("menu-about")).toHaveCount(0); // not in the drawer any more: Settings > Version row (or the "i" in its header)
    await page.getByTestId("menu-settings").click();
    await page.getByTestId("open-about").click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.getByTestId("about-screen")).toBeVisible();
    const build = page.getByTestId("about-app-build").locator("code");
    await expect(build).toHaveText(/^[0-9a-f]{12}$/, { timeout: 20_000 });
    await expect(page.getByTestId("about-code-commit").locator("code")).toHaveText(/^([0-9a-f]{7,40}|unknown)$/);
    const sv = await (await page.request.get("/api/version")).json() as { build: string | null; commit: string | null; worker_version_id: string | null };
    await expect(page.getByTestId("about-server-build").locator("code")).toHaveText(sv.build ?? "unknown");
    const rel = page.getByTestId("about-relation");
    await expect(rel).toHaveText(/matches the server|older than the server/);
    await page.getByTestId("check-update").click();
    await expect(page.getByTestId("update-status")).toHaveText(/Up to date|Update ready|Error/, { timeout: 30_000 });
    for (const t of ["about-installed-app", "about-service-worker", "about-safe-area-inset", "about-theme", "about-network"]) await expect(page.getByTestId(t)).toBeVisible();
  });

  test("Copy puts every row on the clipboard; no horizontal overflow", async ({ app: { page } }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {}); // webkit has no such permission: the fallback path is then exercised
    await page.goto("/about");
    await expect(page.getByTestId("about-app-build").locator("code")).toHaveText(/^[0-9a-f]{12}$/, { timeout: 20_000 });
    const build = await page.getByTestId("about-app-build").locator("code").innerText();
    await page.getByTestId("about-copy").click();
    await expect(page.getByText(/^(Copied|Could not copy)\.$/)).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    if (clip !== null) { expect(clip).toContain(`App build: ${build}`); expect(clip).toContain("Code commit: "); expect(clip.split("\n").length).toBeGreaterThanOrEqual(10); }
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(o.sw).toBeLessThanOrEqual(o.iw);
  });

  test("at 390px: no h-overflow", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/about");
    await expect(page.getByTestId("about-screen")).toBeVisible();
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(o.sw).toBeLessThanOrEqual(o.iw);
  });
});

// The desktop shell appends ` VertexClientDesktop/<version>` to the webview user agent; About shows it (no native command involved).
test.describe("about in the desktop shell", () => {
  const SHELL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 VertexClientDesktop/0.2.1";
  test.use({ userAgent: SHELL_UA });

  test("shows 'Desktop app' and 'Installed app: desktop app'", async ({ app: { page } }) => {
    await page.goto("/about");
    await expect(page.getByTestId("about-desktop-app").locator("code")).toHaveText("0.2.1 (native shell)");
    await expect(page.getByTestId("about-installed-app").locator("code")).toHaveText("desktop app");
  });
});

test.describe("about in a plain browser", () => {
  test("no 'Desktop app' row", async ({ app: { page } }) => {
    await page.goto("/about");
    await expect(page.getByTestId("about-installed-app")).toBeVisible();
    await expect(page.getByTestId("about-desktop-app")).toHaveCount(0);
  });
});
