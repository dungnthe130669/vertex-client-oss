import { test, expect, openChat, ask } from "./fixtures";

// Notifications center: a finished chat turn while the app is open is stored, toasted at the top over the existing socket, counted on the bell
// and listed on /notifications. The e2e user never gets Web Push, so this exercises the "watching" path. Delta-based: the e2e scope
// accumulates rows across runs (and the pre-test cleanup only deletes conversations), so assertions compare counts before/after.
// Written, not run by the author (e2e runs on build-host).
const bell = (page: import("@playwright/test").Page) => page.getByTestId("notif-bell").filter({ visible: true }).first();
// Exact count from the bell's aria-label ("Notifications, N unread"; no suffix at 0). The badge text is capped at "99+", so it cannot be parsed.
const unread = async (page: import("@playwright/test").Page) => {
  const m = ((await bell(page).getAttribute("aria-label")) ?? "").match(/(\d+) unread/);
  return m ? Number(m[1]) : 0;
};
// Same endpoint the app's "mark all read" button calls; only ever acts on the e2e-bot session of this test.
const markAllRead = async (api: { mut(m: "POST", p: string, d?: unknown): Promise<{ status(): number }> }) => {
  expect((await api.mut("POST", "/api/notifications/read", { all: true })).status()).toBe(200);
};

test.describe("notifications center", () => {
  test("reply while the app is open: top toast, bell badge, history row, mark all read", async ({ app: { page, api } }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await markAllRead(api); // independent of rows earlier runs left behind
    try {
    const id = await api.newChat();
    await openChat(page, id);
    await page.getByTestId("menu-button").first().click(); // the bell lives in the drawer foot on phones
    await expect(bell(page)).toBeVisible();
    const b = (await bell(page).boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(43.9); // touch target is 44 css px; allow sub-pixel rounding (43.999992)
    expect(b.height).toBeGreaterThanOrEqual(43.9);
    const before = await unread(page);
    expect(before, "started from a clean slate").toBe(0);
    await page.keyboard.press("Escape");

    await ask(page, "Reply with the single word: pong");
    const toast = page.getByTestId("notif-toast").first();
    await expect(toast).toBeVisible({ timeout: 15_000 });
    const box = (await toast.boundingBox())!;
    expect(box.y, "toast sits at the top of the screen").toBeLessThan(120);
    await expect(toast).toBeHidden({ timeout: 10_000 }); // auto-hides after ~5 s

    await page.getByTestId("menu-button").first().click();
    await expect(bell(page)).toHaveAttribute("aria-label", new RegExp(`${before + 1} unread`));
    await bell(page).click();
    await expect(page).toHaveURL(/\/notifications$/);
    const rows = page.getByTestId("notif-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toHaveAttribute("data-unread", "1");
    const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(sw.sw).toBeLessThanOrEqual(sw.iw + 1); // no horizontal scroll at 390

    await page.getByTestId("notif-mark-all").click();
    await expect(page.locator('[data-testid="notif-row"][data-unread="1"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-testid="notif-row"][data-unread="1"]')).toHaveCount(0); // persisted server-side
    // tap a row opens its conversation
    await rows.first().click();
    await expect(page).toHaveURL(new RegExp(`/c/${id}$`));
    } finally { await markAllRead(api).catch(() => {}); }
  });

  test("320px and 1280px: history page has no horizontal overflow", async ({ app: { page } }) => {
    for (const w of [320, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.goto("/notifications");
      await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      expect(o.sw, `${w}px`).toBeLessThanOrEqual(o.iw + 1);
    }
  });
});
