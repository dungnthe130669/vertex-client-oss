import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApp, SCREENS } from "./polish-mock";

// axe-core on the main screens, light + dark, with the API mocked in the browser (polish/mock.ts), so it needs no login and costs nothing:
// the document under test is whatever E2E_BASE_URL serves (the live build, or a local `npm run build` via `node polish/serve.mjs`).
// serious + critical violations must be 0. Suppressions: none (a rule is only disabled here with a written justification).
const SUPPRESSED: Record<string, string> = {};

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe (${scheme})`, () => {
    test.use({ colorScheme: scheme, serviceWorkers: "block" });
    for (const [slug, path] of SCREENS) {
      test(`${slug}: no serious/critical violations`, async ({ page }) => {
        await mockApp(page);
        await page.goto(path); await page.waitForLoadState("networkidle");
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(Object.keys(SUPPRESSED)).analyze();
        const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")} -- ${v.nodes[0]?.failureSummary?.split("\n")[1] ?? ""} :: ${v.nodes[0]?.html.slice(0, 140)}`), slug).toEqual([]);
      });
    }
  });
}

// Focus management, announcements and motion, on the mocked app (no login, no cost).
test.describe("a11y behaviour", () => {
  test.use({ serviceWorkers: "block" });

  test("confirm sheet: focus moves in, Tab is trapped, Escape closes, focus returns to the trigger; axe clean while open", async ({ page }) => {
    await mockApp(page);
    await page.goto("/chats"); await page.waitForLoadState("networkidle");
    const trigger = page.getByTestId("chat-menu-button").nth(1);
    await trigger.focus(); await page.keyboard.press("Enter");
    await page.getByTestId("chat-menu-delete").click();
    const sheet = page.getByTestId("confirm-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(":focus")).toHaveCount(1);
    for (let i = 0; i < 5; i++) { await page.keyboard.press("Tab"); expect(await sheet.locator(":focus").count(), `Tab #${i + 1} left the dialog`).toBe(1); }
    for (let i = 0; i < 5; i++) { await page.keyboard.press("Shift+Tab"); expect(await sheet.locator(":focus").count(), `Shift+Tab #${i + 1} left the dialog`).toBe(1); }
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("command palette: focus in the input, Escape restores focus to the opener", async ({ page }) => {
    await mockApp(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/chats"); await page.waitForLoadState("networkidle");
    const opener = page.getByTestId("menu-search").first();
    await opener.focus(); await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.press("Tab"); await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette")).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("mobile drawer: focus trapped inside, Escape closes and returns to the menu button", async ({ page }) => {
    await mockApp(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chats"); await page.waitForLoadState("networkidle");
    const menu = page.getByRole("button", { name: /menu/i }).first();
    await menu.focus(); await page.keyboard.press("Enter");
    const drawer = page.getByTestId("drawer");
    await expect(drawer).toBeVisible();
    for (let i = 0; i < 40; i++) { await page.keyboard.press("Tab"); expect(await drawer.locator(":focus").count(), `Tab #${i + 1} left the drawer`).toBe(1); }
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(menu).toBeFocused();
  });

  test("toasts live region is mounted from the start (so the first toast is announced)", async ({ page }) => {
    await mockApp(page);
    await page.goto("/chats"); await page.waitForLoadState("networkidle");
    await expect(page.locator('.toasts[role="status"][aria-live="polite"]')).toBeAttached();
  });

  test("chat has a labelled conversation region and a polite status line", async ({ page }) => {
    await mockApp(page);
    await page.goto("/c/00000000-0000-4000-8000-000000000001"); await page.waitForLoadState("networkidle");
    await expect(page.getByRole("main", { name: "Conversation" })).toBeVisible();
    await expect(page.getByTestId("sr-status")).toHaveAttribute("aria-live", "polite");
  });

  test("prefers-reduced-motion: no animation or transition longer than a frame", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await ctx.newPage(); await mockApp(page, { mode: "slow" });
    await page.goto("/chats"); await page.waitForLoadState("networkidle");
    const longest = await page.evaluate(`(() => { let m = 0; for (const e of document.querySelectorAll("*")) { const c = getComputedStyle(e); for (const v of [c.animationDuration, c.transitionDuration]) for (const p of v.split(",")) { const n = parseFloat(p) * (p.trim().endsWith("ms") ? 1 : 1000); if (n > m) m = n; } } return m; })()`);
    expect(longest).toBeLessThanOrEqual(1);
    await ctx.close();
  });

  test("code-split screens: a chunk that cannot load shows a retry, not a blank app; the others still open", async ({ page }) => {
    await mockApp(page);
    await page.route(/\/assets\/usage-[^/]*\.js/, (r) => r.abort());
    await page.goto("/usage");
    await expect(page.getByTestId("screen-error")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
    await page.goto("/skills"); // another chunk, unaffected
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
  });
});
