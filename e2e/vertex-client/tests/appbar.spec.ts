import { test, expect, type Page } from "@playwright/test";
import { mockApp, IDS } from "./polish-mock";

// appbar1: the unified top app bar of the desktop layout (>=1024px). API mocked in the browser (no login, no cost); the document under test is whatever
// E2E_BASE_URL serves (a local build via polish/serve.mjs, or the live build). Hover rules: pointer MOVES open (120 ms), leaving closes (250 ms), click pins, Esc closes.
test.use({ serviceWorkers: "block" });

const bar = (p: Page) => p.getByTestId("appbar");
async function open(p: Page, path: string, w = 1280) {
  await p.setViewportSize({ width: w, height: 800 });
  await mockApp(p, { erich: true });
  await p.goto(path); await p.waitForLoadState("networkidle").catch(() => {});
  await expect(bar(p)).toBeVisible();
}
/** Screen headers under the app bar that still take room (the folded ones are 1x1). */
const foldedBars = (p: Page) => p.locator(".dmain .bar").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 2).length);
const hoverOver = async (p: Page, sel: string) => { const b = (await p.locator(sel).boundingBox())!; await p.mouse.move(b.x + b.width / 2 - 4, b.y + b.height / 2); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); };

test.describe("app bar @desktop-only", () => {
  for (const w of [1024, 1280, 1600]) {
    test(`one bar with the toggle, the screen name and the action icons @${w}`, async ({ page }) => {
      await open(page, "/library", w);
      await expect(page.getByTestId("appbar-title")).toHaveText("Library");
      for (const t of ["appbar-new-chat", "appbar-search", "notif-bell", "appbar-settings", "appbar-more"]) await expect(bar(page).getByTestId(t), t).toBeVisible();
      await expect(bar(page).locator("[style]")).toHaveCount(0); // CSP: no inline styles
      const box = await bar(page).boundingBox();
      expect(box!.y).toBe(0); expect(box!.width).toBe(w); expect(box!.height).toBeLessThanOrEqual(56);
      await expect.poll(() => foldedBars(page)).toBe(0); // the screen's own header is folded into the bar (kept in the DOM at 1x1)
    });
  }

  test("the toggle stays in the same place whether the sidebar is pinned or hidden", async ({ page }) => {
    await open(page, "/library");
    const pos = async () => { const b = (await bar(page).locator(".ab-toggle").boundingBox())!; return [b.x, b.y, b.width, b.height]; };
    await page.evaluate(() => localStorage.setItem("vc:sidebar", "closed")); await page.reload(); await expect(bar(page)).toBeVisible();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "false");
    const hidden = await pos();
    await page.getByTestId("sidebar-open").click();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "true");
    expect(await pos()).toEqual(hidden);
    await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  test("More: opens on a pointer move after the delay, closes after leaving, Esc closes and returns focus", async ({ page }) => {
    await open(page, "/library");
    const menu = page.getByTestId("appbar-more-menu");
    await hoverOver(page, '[data-testid="appbar-more"]');
    await expect(menu).toBeHidden(); // 120 ms open delay
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("appbar-more-about")).toBeVisible();
    await page.mouse.move(700, 400); await page.mouse.move(720, 420);
    await expect(menu).toBeHidden({ timeout: 3000 });
    await hoverOver(page, '[data-testid="appbar-more"]');
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("More: a pointer parked on the trigger does not open it by itself, and a stationary pointer keeps it open", async ({ page }) => {
    await open(page, "/library");
    const b = (await page.getByTestId("appbar-more").boundingBox())!;
    await page.mouse.move(b.x + 5, b.y + 5); // a single entering move opens (it is a move); then it must stay with the pointer still
    await expect(page.getByTestId("appbar-more-menu")).toBeVisible();
    await page.waitForTimeout(900);
    await expect(page.getByTestId("appbar-more-menu")).toBeVisible();
  });

  test("More: click pins it open (a stray exit does not close it), an outside click closes", async ({ page }) => {
    await open(page, "/library");
    await page.getByTestId("appbar-more").click();
    await expect(page.getByTestId("appbar-more")).toHaveAttribute("aria-expanded", "true");
    await page.mouse.move(700, 400); await page.mouse.move(720, 420);
    await page.waitForTimeout(700);
    await expect(page.getByTestId("appbar-more-menu")).toBeVisible();
    await page.mouse.click(600, 500);
    await expect(page.getByTestId("appbar-more-menu")).toBeHidden();
  });

  test("More: keyboard - ArrowDown opens, roving focus, Enter picks, Esc closes", async ({ page }) => {
    await open(page, "/library");
    await page.getByTestId("appbar-more").focus();
    await expect(page.getByTestId("appbar-more")).toHaveAttribute("aria-haspopup", "menu");
    await page.keyboard.press("ArrowDown");
    const items = page.getByTestId("appbar-more-menu").getByRole("menuitem");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp");
    await expect(items.last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("appbar-more-menu")).toBeHidden();
    await expect(page.getByTestId("appbar-more")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.getByTestId("appbar-more-about").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/about$/);
  });

  test("the icons act: Search opens the palette, Settings opens the modal, Usage navigates", async ({ page }) => {
    await open(page, "/library");
    await bar(page).getByTestId("appbar-search").click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await bar(page).getByTestId("appbar-settings").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-modal")).toBeHidden();
    await bar(page).getByTestId("appbar-new-chat").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("appbar-title")).toHaveText("New chat");
  });

  test("chat: title + caret menu on hover, the chat's own controls live in the bar, no second header", async ({ page }) => {
    await open(page, `/c/${IDS.chat}`);
    await expect(page.getByTestId("appbar-title")).not.toHaveText("Chat"); // the real title, once loaded
    await expect(bar(page).getByTestId("header-find")).toBeVisible();
    await expect(bar(page).getByTestId("chat-header-menu")).toBeVisible();
    await expect(bar(page).getByTestId("header-new-chat").or(bar(page).getByTestId("appbar-new-chat"))).toHaveCount(1);
    await expect.poll(() => foldedBars(page)).toBe(0);
    await hoverOver(page, '[data-testid="chat-title-menu"]');
    await expect(page.getByTestId("chat-menu")).toBeVisible();
    await expect(page.getByTestId("chat-menu-rename")).toBeVisible();
    await expect(page.getByTestId("chat-menu-pin")).toBeVisible();
    await expect(page.getByTestId("chat-menu-delete")).toBeVisible();
    await page.waitForTimeout(900); // a pointer parked on the caret keeps the hover-opened menu open (the scrim must not steal the hover)
    await expect(page.getByTestId("chat-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-menu")).toBeHidden();
    await hoverOver(page, '[data-testid="chat-title-menu"]');
    await expect(page.getByTestId("chat-menu")).toBeVisible();
    await page.mouse.click(600, 500); // an outside click closes it
    await expect(page.getByTestId("chat-menu")).toBeHidden();
    await page.mouse.move(700, 600); await page.mouse.move(720, 620);
    await hoverOver(page, '[data-testid="chat-title-menu"]');
    await expect(page.getByTestId("chat-menu")).toBeVisible();
    await page.mouse.move(700, 600); await page.mouse.move(720, 620);
    await expect(page.getByTestId("chat-menu")).toBeHidden({ timeout: 3000 });
    await bar(page).getByTestId("chat-header-menu").click(); // click still opens (pinned) and focuses the first item
    await expect(page.getByTestId("chat-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-menu")).toBeHidden();
  });

  for (const trig of ["chat-title-menu", "chat-header-menu"]) {
    test(`chat menu: hover then click ${trig} pins it, focuses the first item, arrows move, Esc closes and restores trigger focus (appbar1b)`, async ({ page }) => {
      await open(page, `/c/${IDS.chat}`);
      const sel = `[data-testid="${trig}"]`;
      await hoverOver(page, sel);
      await expect(page.getByTestId("chat-menu")).toBeVisible();
      await page.locator(sel).click();
      const items = page.locator('[data-testid="chat-menu"] [role=menuitem]');
      await expect(items.first()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(items.nth(1)).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(items.first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("chat-menu")).toBeHidden();
      await expect(page.locator(sel)).toBeFocused();
    });
  }

  for (const trig of ["chat-title-menu", "chat-header-menu"]) {
    test(`chat menu: Esc from a focused item of an unpinned hover menu restores focus to ${trig}; Esc with focus elsewhere keeps it (appbar1c)`, async ({ page }) => {
      await open(page, `/c/${IDS.chat}`);
      const sel = `[data-testid="${trig}"]`, menu = page.getByTestId("chat-menu");
      await hoverOver(page, sel);
      await expect(menu).toBeVisible();
      await page.getByTestId("chat-menu-pin").focus();
      await page.mouse.move(700, 600); await page.mouse.move(720, 620);
      await expect(page.getByTestId("chat-menu-pin")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(page.locator(sel)).toBeFocused();
      // focus elsewhere: Esc closes the menu but must not steal focus
      await hoverOver(page, sel);
      await expect(menu).toBeVisible();
      await page.getByTestId("header-find").focus();
      await page.mouse.move(700, 600); await page.mouse.move(720, 620);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(page.getByTestId("header-find")).toBeFocused();
    });
  }

  test("chat menu: a focused item survives the pointer leaving; closes when pointer and focus are both gone (appbar1b)", async ({ page }) => {
    await open(page, `/c/${IDS.chat}`);
    await hoverOver(page, '[data-testid="chat-title-menu"]');
    const menu = page.getByTestId("chat-menu");
    await expect(menu).toBeVisible();
    await page.getByTestId("chat-menu-pin").focus();
    await page.mouse.move(700, 600); await page.mouse.move(720, 620);
    await page.waitForTimeout(900);
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("chat-menu-pin")).toBeFocused();
    await page.getByTestId("chat-menu-pin").blur();
    await expect(menu).toBeHidden({ timeout: 3000 });
  });

  test("chat menu: at 900px a parked pointer keeps the hover menu open and items are selectable (appbar1b)", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await mockApp(page, { erich: true });
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle").catch(() => {});
    const trig = page.getByTestId("chat-header-menu");
    await expect(trig).toBeVisible();
    const b = (await trig.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2 - 4, b.y + b.height / 2); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    const menu = page.getByTestId("chat-menu");
    await expect(menu).toBeVisible();
    await page.waitForTimeout(900);
    await expect(menu).toBeVisible();
    await page.getByTestId("chat-menu-rename").click();
    await expect(page.getByTestId("rename-sheet")).toBeVisible();
  });

  test("icons collapse into More when the bar is narrow (artifact panel open at 1024)", async ({ page }) => {
    await open(page, `/c/${IDS.chat}`, 1024);
    const icons = () => bar(page).locator(".ab-right > .abtn, .ab-right > .bellbtn").count();
    const wide = await icons();
    await page.evaluate((id) => { history.pushState({}, "", `/artifacts/${id}`); dispatchEvent(new PopStateEvent("popstate")); }, IDS.artifact);
    await expect(page.getByTestId("artifact-panel")).toBeVisible();
    await expect.poll(icons).toBeLessThan(wide);
    await page.getByTestId("appbar-more").click();
    await expect(page.getByTestId("appbar-more-menu").getByRole("menuitem").filter({ hasText: "Usage" })).toHaveCount(1); // what collapsed is still reachable
  });

  test("reduced motion: the menu does not animate", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "/library");
    await page.getByTestId("appbar-more").click();
    expect(await page.getByTestId("appbar-more-menu").evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  });

  test("dark theme keeps the bar legible (contrast of the title and icons)", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page, "/library");
    const c = await page.getByTestId("appbar-title").evaluate((e) => getComputedStyle(e).color);
    const bg = await bar(page).evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(c).not.toBe(bg);
  });
});

test("phone widths have no app bar: the hamburger header is untouched @mobile-only", async ({ page }) => {
  await open(page, "/library", 390).catch(() => {});
  await expect(page.getByTestId("appbar")).toHaveCount(0);
  await expect(page.getByTestId("menu-button").filter({ visible: true }).first()).toBeVisible();
});
