import { test, expect, ask, drawerSettled } from "./fixtures";
import type { Page } from "@playwright/test";

// Mobile app shell (Claude-app-like): "/" is always an EMPTY new chat; the conversation is created lazily on the first send;
// the left drawer (hamburger) holds navigation + Recent + New chat + Settings.
const noHOverflow = async (page: Page, what: string) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  expect(o.sw, `${what}: page scrolls horizontally (scrollWidth ${o.sw} > ${o.iw})`).toBeLessThanOrEqual(o.iw + 1);
};
const pickHaiku = async (page: Page) => {
  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("dialog", { name: "Models" }).getByRole("button", { name: /Haiku 5\.5/ }).click();
};

test.describe("mobile shell @390", () => {
  test.beforeEach(async ({ app: { page } }) => { await page.setViewportSize({ width: 390, height: 844 }); });

  test("start screen is an empty new chat: greeting, composer, no conversation created by opening it", async ({ app: { page, api } }) => {
    await page.goto("/");
    await expect(page.getByTestId("greeting")).toHaveText(/^Good (morning|afternoon|evening)/);
    await expect(page.getByPlaceholder("Message")).toBeVisible();
    await expect(page.getByTestId("composer-plus")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose model" })).toBeEnabled();
    await expect(page.locator(".msg")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("greeting")).toBeVisible();
    expect((await api.conversations()).length, "visiting the start screen must not create conversations").toBe(0);
    const box = (await page.locator("footer.composer").boundingBox())!;
    expect(box.y + box.height, "composer pinned at the bottom").toBeGreaterThan(844 - 140);
    await noHOverflow(page, "start");
  });

  test("first send creates the conversation lazily and navigates; Recent lists it; New chat returns to the empty start", async ({ app: { page, api } }) => {
    await page.goto("/");
    await pickHaiku(page);
    const a = await ask(page, "Reply with exactly one word: pong");
    expect(a.toLowerCase()).toContain("pong");
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
    const id = /\/c\/([0-9a-f-]{36})$/.exec(page.url())![1];
    const rows = await api.conversations();
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(rows[0].model).toContain("haiku");
    await expect(page.locator(".msg.user")).toHaveCount(1); // the first message arrived exactly once
    // drawer: Recent has it on top, highlighted as the current chat
    await page.getByTestId("menu-button").click();
    const first = page.getByTestId("recent-row").first();
    await expect(first).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("menu-mode-chat")).toHaveAttribute("aria-current", "page");
    await drawerSettled(page);
    await noHOverflow(page, "drawer open in a chat");
    await page.getByTestId("drawer-new-chat").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("greeting")).toBeVisible();
    await expect(page.locator(".msg")).toHaveCount(0);
    // the conversation header's own New chat button does the same
    await page.goto(`/c/${id}`);
    await page.getByTestId("header-new-chat").click();
    await expect(page.getByTestId("greeting")).toBeVisible();
    expect((await api.conversations()).length, "New chat alone creates nothing").toBe(1);
  });

  test("drawer opens / closes via hamburger, Esc and scrim; Settings reachable from the avatar", async ({ app: { page } }) => {
    await page.goto("/");
    const mb = page.getByTestId("menu-button");
    await mb.click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
    await expect(mb).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("drawer")).toHaveCount(0);
    await expect(mb).toBeFocused();
    await mb.click();
    await page.getByTestId("drawer-scrim").click({ position: { x: 375, y: 420 } });
    await expect(page.getByTestId("drawer")).toHaveCount(0);
    await mb.click();
    await page.getByTestId("menu-settings").click(); // the gear is the single Settings entry (the account row is only a label)
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click(); // came from inside the app: back to where we were
    await expect(page).toHaveURL(/\/$/);
  });

  test("safe area: hamburger, drawer header and New chat pill clear the notch / home indicator", async ({ app: { page } }) => {
    await page.goto("/");
    await page.evaluate(() => { const st = document.documentElement.style; st.setProperty("--sat", "59px", "important"); st.setProperty("--sab", "34px", "important"); }); // CSSOM: CSP style-src 'self' refuses addStyleTag
    expect((await page.getByTestId("menu-button").boundingBox())!.y).toBeGreaterThanOrEqual(59 - 0.5);
    await page.getByTestId("menu-button").click();
    await drawerSettled(page);
    expect((await page.locator(".drawer-head").boundingBox())!.y).toBeGreaterThanOrEqual(59 - 0.5);
    const pill = (await page.getByTestId("drawer-new-chat").boundingBox())!;
    expect(pill.y + pill.height).toBeLessThanOrEqual(844 - 34 + 0.5);
  });
});
