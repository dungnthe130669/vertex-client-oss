import { test, expect, devices } from "@playwright/test";

// andfix1/andfix2: the login "Continue" button sat off-left (narrow, left-aligned under a full-width input) on Android Chrome.
// Tests the LIVE page, unauthenticated: no cookies, no token, no login code, nothing typed or submitted. Only displays the email step
// (needs /auth/config emailStep=true; skipped visibly otherwise). The button must span the same horizontal box as the input and be centered.
const VIEWPORTS = [[360, 800], [393, 851], [412, 915], [390, 844]] as const;
const box = async (l: import("@playwright/test").Locator) => (await l.boundingBox())!;

async function check(page: import("@playwright/test").Page, w: number) {
  await page.goto("/");
  const form = page.locator('[data-testid^="login-"]').first();
  test.skip(!(await form.waitFor({ timeout: 15_000 }).then(() => true, () => false)), "login email step not shown (emailStep off?)");
  const input = await box(form.locator("input")), btn = await box(form.locator(".btn"));
  expect(Math.abs(btn.x - input.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(btn.width - input.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(btn.x + btn.width / 2 - w / 2)).toBeLessThanOrEqual(1);
}

test.describe("login button layout (live, unauthenticated)", () => {
  test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });
  for (const [w, h] of VIEWPORTS) {
    test(`login Continue aligns with the Email field @ ${w}x${h}`, async ({ browser, baseURL }) => {
      const ctx = await browser.newContext({ baseURL, viewport: { width: w, height: h }, deviceScaleFactor: 2.6, hasTouch: true, serviceWorkers: "block" });
      try { await check(await ctx.newPage(), w); } finally { await ctx.close(); }
    });
  }
  test("login Continue aligns with the Email field @ Pixel 7", async ({ browser, baseURL, browserName }) => {
    test.skip(browserName !== "chromium", "Pixel 7 profile is Chromium-only");
    const ctx = await browser.newContext({ ...devices["Pixel 7"], baseURL, serviceWorkers: "block" });
    try { await check(await ctx.newPage(), devices["Pixel 7"].viewport.width); } finally { await ctx.close(); }
  });
});
