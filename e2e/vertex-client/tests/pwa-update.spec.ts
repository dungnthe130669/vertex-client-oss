import { test, expect } from "./fixtures";

// PWA update plumbing against the live app (updates are SILENT; UI only on failure). The two-build swap (silent apply / no-loop / no reload while typing) can't be done
// against a deployed origin; that was verified with a local two-build static server (see docs/reports/pwa-update-shots).
test.describe("pwa update", () => {
  test("Settings shows a compact version row linking to About; About has check + reset", async ({ app: { page } }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("version-setting")).toBeVisible();
    await expect(page.getByTestId("app-version")).toHaveText(/^[0-9a-f]{7}$/, { timeout: 20_000 });
    await page.getByTestId("open-about").click();
    await expect(page.getByTestId("about-screen")).toBeVisible();
    await expect(page.getByTestId("reset-app")).toBeVisible();
    await page.getByTestId("check-update").click();
    await expect(page.getByTestId("update-status")).toHaveText(/Up to date|Update ready|Error/, { timeout: 30_000 });
  });

  test("Home never shows update UI; a detected update stays silent", async ({ app: { page } }) => {
    await page.goto("/");
    await expect(page.getByTestId("app-version").or(page.locator("main, .shell").first())).toBeVisible();
    // Simulate "a new version was detected" foreground signals: nothing about updates may appear on Home.
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); dispatchEvent(new Event("focus")); });
    await page.waitForTimeout(1500);
    for (const id of ["update-banner", "update-now", "update-failed"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByText(/new version|updating|updated/i)).toHaveCount(0);
  });

  test("navigation between screens never reloads the page (popstate is not an apply moment)", async ({ app: { page } }) => {
    await page.goto("/");
    await page.evaluate(() => { (window as unknown as { __m: number }).__m = 1; });
    await page.evaluate(() => { history.pushState({ fromApp: true }, "", "/settings"); dispatchEvent(new PopStateEvent("popstate")); });
    await page.waitForTimeout(1500);
    await page.goBack();
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __m?: number }).__m)).toBe(1);
  });

  // FIXME 2026-10-23: Playwright route interception of the browser's own sw.js update fetch does not trigger the failure path (notice never appears) in Chromium or WebKit. The failure state machine, backoff and notice rules are covered by test/update-logic.test.ts + test/update-flow.test.ts; verify the visible notice by hand (block sw.js in devtools).
  test.fixme("a failing background update shows ONE dismissable notice with Retry + Details in About", { annotation: { type: "fixme", description: "skips1 2026-10-30: route interception of the browser sw.js update fetch never triggers the failure path (notice never appears), so the ONE-dismissable-notice behavior has no e2e; unit coverage: update-flow.test.ts, update-logic.test.ts" } }, async ({ app: { page } }) => {
    const context = page.context();
    await page.goto("/");
    await expect(page.getByTestId("app-version").or(page.locator("main, .shell").first())).toBeVisible();
    await context.route("**/sw.js", (r) => r.fulfill({ status: 503, body: "down" })); // the new version's fetch fails
    for (let i = 0; i < 2; i++) { // failure 1 stays hidden; the retry's failure surfaces the notice
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.waitForTimeout(800);
    }
    const n = page.getByTestId("update-failed");
    await expect(n).toBeVisible({ timeout: 15_000 });
    await expect(n.getByTestId("update-retry")).toBeVisible();
    await n.getByTestId("update-dismiss").click();
    await expect(n).toHaveCount(0);
    await context.unroute("**/sw.js");
  });

  test("About: manual check still works and shows the last silent-update result", async ({ app: { page } }) => {
    await page.goto("/about");
    await expect(page.getByTestId("about-screen")).toBeVisible();
    await expect(page.getByTestId("last-update")).toHaveText(/Up to date|Updated|Last update failed|No background update yet/);
    await page.getByTestId("check-update").click();
    await expect(page.getByTestId("update-status")).toHaveText(/Up to date|Update ready|Error/, { timeout: 30_000 });
    await expect(page.getByTestId("update-now-about")).toBeVisible();
  });

  test("shell, sw.js, manifest and theme.js are not cacheable; hashed assets are immutable", async ({ app: { page } }) => {
    for (const p of ["/", "/sw.js", "/manifest.webmanifest", "/theme.js"]) {
      const r = await page.request.get(p);
      expect(r.headers()["cache-control"] ?? "", p).toMatch(/no-cache|no-store|max-age=0/);
    }
    const html = await (await page.request.get("/")).text();
    const asset = /\/assets\/[^"'\s)]+/.exec(html)?.[0];
    expect(asset).toBeTruthy();
    expect((await page.request.get(asset!)).headers()["cache-control"]).toContain("immutable");
  });
});
