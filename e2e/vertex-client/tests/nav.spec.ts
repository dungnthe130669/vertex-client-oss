import { test, expect, ask, openChat, uniq, login, BOT, headerAction, drawerSettled, hasSidebar } from "./fixtures";

const noHOverflow = async (page: import("@playwright/test").Page, what: string) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  expect(o.sw, `${what}: page scrolls horizontally (scrollWidth ${o.sw} > ${o.iw})`).toBeLessThanOrEqual(o.iw + 1);
};

test.describe("navigation & screens", () => {
  test("search finds the conversation by message text, and shows no-match otherwise", async ({ app: { page, api } }) => {
    const word = uniq("QUOKKA");
    await openChat(page, await api.newChat());
    await ask(page, `The codeword is ${word}. Reply with just: noted`);
    await page.goto("/chats");
    const search = page.getByPlaceholder("Search chats");
    await search.fill(word);
    await expect.poll(async () => page.locator(".list .row").count(), { timeout: 30_000 }).toBe(1);
    await page.locator(".list .row").first().click();
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
    await expect(page.locator(".msg.user")).toContainText(word);
    await page.goto("/chats");
    await page.getByPlaceholder("Search chats").fill(uniq("NOSUCHTHING"));
    await expect(page.getByRole("heading", { name: "No matches" })).toBeVisible();
  });

  test("usage screen shows cost and token numbers", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await ask(page, "Reply with exactly one word: pong");
    await page.goto("/");
    await headerAction(page, "Usage");
    await expect(page).toHaveURL(/\/(settings\/)?usage$/); // desktop: /usage (appbar1 button) or the Settings modal pane; the screen's own <h2> is not visible in either (appbar title / modal chrome), so the content checks below are the real assertion
    const today = page.locator('[data-testid="usage-today"]');
    await expect(today).toBeVisible({ timeout: 20_000 });
    await expect(today.locator('[data-testid="usage-cost"]')).toContainText(/\$\d/); // aggregate total only
    await expect(today.locator('[data-testid="usage-estimate"]')).toContainText(/estimate/i);
    await expect(today).toContainText(/\d[\d.,kM]* tokens/);
    await expect(today).toContainText(/[1-9]\d* calls/);
    await expect(page.locator('[data-testid="usage-this-month"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: /Top conversations/ })).toBeVisible();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(today.locator('[data-testid="usage-cost"]')).toContainText(/\$\d/);
  });

  test("settings button uses a gear icon (not a sun/theme glyph), labelled Settings, >=40px (desktop list layout; the drawer is in header-menu.spec)", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/chats");
    const btn = page.getByTestId("menu-settings").filter({ visible: true }); // >=1024px: the sidebar's gear; the appbar1 top bar has its own "Settings" button (appbar-settings), so a role/name locator is now ambiguous
    await expect(btn).toBeVisible();
    await expect(btn.locator('[data-testid="settings-icon-gear"]')).toBeVisible();
    await expect(btn).toHaveAttribute("title", "Settings");
    const box = (await btn.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(40);
  });

  test("settings: account, models, notifications, link to usage", async ({ app: { page } }) => {
    await page.goto("/");
    await headerAction(page, "Settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Signed in as")).toBeVisible();
    await expect(page.locator("main").getByText(BOT, { exact: true }).first()).toBeVisible();
    await expect(page.locator('[data-testid="notifications"]')).toBeVisible();
    await expect.poll(async () => page.locator("ul.models li").count(), { timeout: 20_000 }).toBeGreaterThan(3);
    await expect(page.locator("ul.models")).toContainText("claude-sonnet-5-5");
    await expect(page.locator("ul.models .badge")).toHaveText("default");
    if (await hasSidebar(page)) { // desktop: Usage is a pane of the Settings modal (the nav lists it; General does not repeat it)
      await page.getByTestId("settings-pane-usage").click();
      await expect(page).toHaveURL(/\/settings\/usage$/);
      await expect(page.getByRole("dialog", { name: "Settings" }).getByTestId("usage-today")).toBeVisible();
    } else {
      await page.getByTestId("open-usage").click();
      await expect(page).toHaveURL(/\/usage$/);
      await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0); // the overlay must close, not sit on top of /usage
      await expect(page.getByRole("heading", { name: "Usage", level: 1 }).or(page.getByRole("heading", { name: "Usage", level: 2 }))).toBeVisible();
    }
  });

  test("deep link / reload on /settings shows Settings, not the start screen (exploratory finding 20260930T022850Z-c90cd3)", async ({ app: { page } }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // phones: Settings replaces the page; >=1024px: it is a modal over the start screen
    if (!(await hasSidebar(page))) await expect(page.getByTestId("greeting")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click(); // deep link: no in-app history, so Close goes to the start screen
    await expect(page).not.toHaveURL(/\/settings$/);
    await expect(page.getByTestId("greeting")).toBeVisible();
  });

  test("layout at 390px: no horizontal overflow on any screen, long content wraps", async ({ app: { page, api } }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await noHOverflow(page, "start screen");
    await page.goto("/chats");
    await noHOverflow(page, "chat list");
    await openChat(page, await api.newChat());
    await ask(page, "Reply with (1) a markdown code block containing one single line made of 200 letter x characters with no spaces, (2) a markdown table with 6 columns and 2 rows, (3) this unbroken string: " + "A".repeat(120));
    await noHOverflow(page, "chat with long code/table/unbroken text");
    const cell = await page.locator(".md td, .md th").first().evaluate((e) => e.getBoundingClientRect().width);
    expect(cell, "table cells are crushed (text wraps per character)").toBeGreaterThanOrEqual(60);
    const right = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll(".msg")].map((e) => e.getBoundingClientRect().right)));
    expect(right, "a message bubble extends past the viewport").toBeLessThanOrEqual(391);
    await page.goto("/usage"); await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible(); await noHOverflow(page, "usage");
    await page.goto("/"); await headerAction(page, "Settings"); await expect(page.locator("ul.models li").first()).toBeVisible(); await noHOverflow(page, "settings");
    // composer stays inside the viewport with the keyboard-less viewport
    await openChat(page, (await api.conversations())[0].id);
    const ta = (await page.locator("footer.composer textarea").boundingBox())!;
    expect(ta.width, "message box is squeezed by the buttons beside it").toBeGreaterThanOrEqual(250);
    const box = await page.locator("footer.composer").boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(845);
  });
});

test.describe("narrow phones", () => {
  test("layout at 320px: header (hamburger + title) fits on every list screen, Settings reachable in the drawer", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    for (const path of ["/", "/chats", "/cloud", "/agents", "/remote", "/desktop"]) {
      await page.goto(path);
      const mb = page.getByTestId("menu-button");
      await expect(mb).toBeVisible();
      await noHOverflow(page, `list ${path} at 320px`);
      const b = (await mb.boundingBox())!;
      expect(b.x + b.width, "Menu button is cut off").toBeLessThanOrEqual(320);
      expect(b.width).toBeGreaterThanOrEqual(40); expect(b.height).toBeGreaterThanOrEqual(40);
      await mb.click();
      await drawerSettled(page);
      const item = page.getByTestId("menu-settings");
      await expect(item).toBeVisible();
      const r = (await item.boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.width, "drawer item is cut off").toBeLessThanOrEqual(320);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("drawer")).toHaveCount(0);
    }
  });
});

test.describe("auth surface", () => {
  test("signed-out visitors see the login screen and get 401 from the API", async ({ page, baseURL }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Vertex Client" })).toBeVisible();
    expect((await page.request.get(`${baseURL}/api/me`)).status()).toBe(401);
    expect((await page.request.get(`${baseURL}/api/conversations`)).status()).toBe(401);
  });

  test("sign out returns to the login screen and ends the session", async ({ page, context, baseURL }) => {
    await login(context, baseURL!);
    await page.goto("/");
    await headerAction(page, "Settings");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Vertex Client" })).toBeVisible();
    expect((await page.request.get(`${baseURL}/api/me`)).status()).toBe(401);
  });
});
