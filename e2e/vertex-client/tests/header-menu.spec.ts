import { test, expect, drawerSettled, openDrawer, navItem } from "./fixtures";

// Mobile shell header: <=640px every top bar has a round hamburger (menu-button) that opens the left drawer holding every action
// that used to sit in the header Menu popover (modes, Usage, Settings, About, Theme, version). The start/chat screens show it on
// every width. >640px list screens keep the inline tabs + Usage + Settings (bottom of this file).
const noHOverflow = async (page: import("@playwright/test").Page, what: string) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  expect(o.sw, `${what}: page scrolls horizontally (scrollWidth ${o.sw} > ${o.iw})`).toBeLessThanOrEqual(o.iw + 1);
};
const theme = (page: import("@playwright/test").Page) => page.locator("html").getAttribute("data-theme");
const SCREENS = ["/", "/chats", "/cloud", "/agents", "/desktop", "/remote"];

test.describe("mobile drawer @390", () => {
  test.beforeEach(async ({ app: { page } }) => { await page.setViewportSize({ width: 390, height: 844 }); });

  test("hamburger replaces the inline actions; drawer has every action + Theme; Esc / scrim close it", async ({ app: { page } }) => {
    for (const path of SCREENS) {
      await page.goto(path);
      const mb = page.getByTestId("menu-button").filter({ visible: true });
      await expect(mb, path).toBeVisible();
      await expect(mb).toHaveAttribute("aria-label", "Menu");
      const b = (await mb.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x, `${path}: hamburger sits on the left`).toBeLessThan(60);
      await expect(page.getByRole("button", { name: "Settings", exact: true }), "inline Settings must be hidden on mobile").toBeHidden();
      await expect(page.getByRole("tablist", { name: "Mode" })).toBeHidden();
      await noHOverflow(page, `${path} closed`);
      await mb.click();
      const drawer = page.getByRole("dialog", { name: "Menu" });
      await drawerSettled(page);
      for (const id of ["menu-mode-chat", "menu-library", "drawer-group-workspaces", "menu-settings", "drawer-avatar", "drawer-new-chat", "menu-search"])
        await expect(drawer.getByTestId(id), `${path}: ${id}`).toBeVisible();
      await expect(drawer.getByTestId("drawer-all-chats"), `${path}: the duplicate All chats row is gone`).toHaveCount(0);
      for (const id of ["drawer-group-more", "menu-usage", "menu-about", "menu-theme", "menu-version", "menu-skills"]) await expect(drawer.getByTestId(id), `${path}: ${id} left the drawer (it is in Settings)`).toHaveCount(0);
      for (const id of ["menu-mode-cloud", "menu-mode-agents", "menu-mode-desktop", "menu-mode-remote"]) await navItem(page, id); // behind Workspaces
      for (const id of ["menu-mode-cloud", "menu-mode-agents", "menu-mode-desktop", "menu-mode-remote"]) await expect(drawer.getByTestId(id), `${path}: ${id}`).toBeVisible();
      await expect(mb).toHaveAttribute("aria-expanded", "true");
      await noHOverflow(page, `${path} open`);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("drawer")).toHaveCount(0);
      await expect(mb).toBeFocused();
      await mb.click();
      await page.getByTestId("drawer-scrim").click({ position: { x: 375, y: 420 } }); // the strip of page to the right of the drawer
      await expect(page.getByTestId("drawer")).toHaveCount(0);
    }
  });

  test("focus moves into the drawer and Tab stays inside it", async ({ app: { page } }) => {
    await page.goto("/");
    await openDrawer(page);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="drawer"]'))).toBe(true);
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="drawer"]'))).toBe(true);
  });

  test("Settings (the gear is the single entry; the account row is a label), Usage (via Settings) and modes are reachable from the drawer; the current mode is marked", async ({ app: { page } }) => {
    await page.goto("/");
    await openDrawer(page);
    await page.getByTestId("menu-settings").click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.goto("/");
    await openDrawer(page);
    await expect(page.getByTestId("drawer-avatar")).toBeVisible();
    await expect(page.getByTestId("drawer-avatar").locator("button, a, [tabindex]")).toHaveCount(0); // account row: display-only, no second tab stop
    await page.getByTestId("drawer-avatar").click();
    await expect(page).toHaveURL(/\/$/); // clicking the label goes nowhere
    await expect(page.getByTestId("drawer")).toBeVisible();
    await page.getByTestId("menu-settings").click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByTestId("open-usage").click(); // Usage & costs: the row of Settings > App
    await expect(page).toHaveURL(/\/usage$/);
    await page.goto("/settings"); await page.getByTestId("open-skills").click(); // Skills left Workspaces: Settings > App
    await expect(page).toHaveURL(/\/skills$/);
    await page.goto("/settings"); await page.getByTestId("open-about").click(); // Version row opens About
    await expect(page).toHaveURL(/\/about$/);
    await page.goto("/settings"); await expect(page.getByTestId("app-version")).toBeVisible();
    await page.goto("/");
    await openDrawer(page);
    await page.goto("/");
    await openDrawer(page);
    await (await navItem(page, "menu-mode-cloud")).click();
    await expect(page).toHaveURL(/\/cloud$/);
    await openDrawer(page);
    await expect(page.getByTestId("menu-mode-cloud")).toHaveAttribute("aria-current", "page");
    await page.getByTestId("menu-mode-chat").click();
    await expect(page).toHaveURL(/\/chats$/);
    await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
  });

  test("theme: Auto -> Light -> Dark from Settings, sets data-theme, persists after reload, theme-color follows", async ({ app: { page } }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("vc-theme")); await page.reload();
    expect(await theme(page)).toBeNull();
    await page.goto("/settings"); // the drawer's Theme row is gone: the segmented control in Settings > App is the path
    const seg = page.getByTestId("theme-setting");
    await expect(seg.getByTestId("theme-auto")).toHaveAttribute("aria-pressed", "true");
    await seg.getByTestId("theme-light").click();
    await expect(seg.getByTestId("theme-light")).toHaveAttribute("aria-pressed", "true");
    expect(await theme(page)).toBe("light");
    await seg.getByTestId("theme-dark").click();
    await expect(seg.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
    expect(await theme(page)).toBe("dark");
    expect(await page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content")))).toEqual(["#0F1115", "#0F1115"]);
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 21)");
    await page.reload();
    expect(await theme(page), "applied before first paint after reload").toBe("dark");
    await page.goto("/settings");
    await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("theme-auto").click(); // back to Auto: leaves the shared storage clean
    expect(await theme(page)).toBeNull();
  });

  test("Settings has the 3-way theme control", async ({ app: { page } }) => {
    await page.goto("/settings");
    const box = page.getByTestId("theme-setting");
    await expect(box).toBeVisible();
    await box.getByTestId("theme-dark").click();
    await expect(box.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
    expect(await theme(page)).toBe("dark");
    await page.reload();
    expect(await theme(page)).toBe("dark");
    await page.getByTestId("theme-light").click();
    expect(await theme(page)).toBe("light");
    for (const id of ["theme-auto", "theme-light", "theme-dark"]) expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await page.getByTestId("theme-auto").click();
    expect(await theme(page)).toBeNull();
  });

  test("no horizontal overflow at 320/360/390 on every screen + drawer open", async ({ app: { page } }) => {
    for (const w of [320, 360, 390]) {
      await page.setViewportSize({ width: w, height: 800 });
      for (const path of [...SCREENS, "/settings", "/usage", "/skills", "/about"]) { await page.goto(path); await page.waitForTimeout(300); await noHOverflow(page, `${path} @${w}`); }
      await page.goto("/");
      await openDrawer(page);
      await noHOverflow(page, `drawer @${w}`);
    }
  });
});

test.describe("desktop shell @1280 @desktop-only", () => {
  test("list screens: persistent sidebar (modes + Settings; Usage is a Settings pane), no hamburger; Settings opens with the theme control", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/chats");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Mode" })).toHaveCount(0);
    await expect(page.getByTestId("menu-button").filter({ visible: true })).toHaveCount(0);
    await expect(page.getByTestId("menu-mode-chat")).toHaveAttribute("aria-current", "page");
    for (const t of ["menu-usage", "menu-about", "menu-theme", "menu-skills", "drawer-group-more"]) await expect(page.getByTestId(t), `${t} left the sidebar`).toHaveCount(0);
    await page.getByTestId("menu-settings").click();
    await expect(page.getByTestId("theme-setting")).toBeVisible();
    await expect(page.getByTestId("app-version")).toBeVisible(); // Version row (About) in General
    await page.getByTestId("settings-pane-skills").click(); await expect(page.getByTestId("settings-pane").getByTestId("skill-add")).toBeVisible();
    await page.getByTestId("settings-pane-usage").click(); await expect(page.getByTestId("settings-pane").getByTestId("usage-today")).toBeVisible();
  });
});
