import { test, expect, type Page } from "@playwright/test";
import { mockApp, openSettingsRow } from "./polish-mock";

/** Is this Settings entry offered? A row on the phone page, a left-nav pane in the desktop modal. */
const offered = (page: Page, slug: string) => page.getByTestId(`open-${slug}`).or(page.getByTestId(`settings-pane-${slug}`));

// Team (g:*) session UX, mocked API (no login, no cost). Contract: a team user is never shown a page that cannot work. Erich-only entries are hidden,
// every reachable screen renders without a 403 banner (and the app never even calls an Erich-only route), and the per-scope things (saved prompts, profile name) work.
const ERICH_ONLY_TESTIDS = ["open-providers", "open-capabilities", "open-skills", "open-connectors", "menu-mode-cloud", "menu-mode-agents", "menu-mode-desktop", "menu-mode-remote", "menu-skills", "menu-projects", "menu-artifacts", "menu-devices"];
const REACHABLE = ["/", "/chats", "/library", "/usage", "/about", "/settings", "/settings/profile", "/settings/appearance", "/settings/prompts"];
const ERROR_TEXT = /could not load|not available for this account|forbidden|\(403\)/i;

test.describe("team user UX (mocked API)", () => {
  test.use({ serviceWorkers: "block" });
  const boot = async (page: Page) => { const team = { hits403: [] as string[] }; await mockApp(page, { team });
    await page.route("**/api/settings/answer-limit", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limit: "default", default: "default" }) })); // team default; registered after mockApp so it wins
    return team; };

  test("every reachable screen: no 403 banner, no Erich-only call", async ({ page }) => {
    const team = await boot(page);
    for (const path of REACHABLE) {
      await page.goto(path); await page.waitForLoadState("networkidle"); await page.waitForTimeout(250);
      await expect(page.locator("body"), path).not.toContainText(ERROR_TEXT);
    }
    expect(team.hits403).toEqual([]);
  });

  test("Erich-only entries are hidden: settings rows, drawer modes, palette", async ({ page }) => {
    const team = await boot(page);
    await page.goto("/settings"); await page.waitForLoadState("networkidle");
    for (const id of ERICH_ONLY_TESTIDS) await expect(page.getByTestId(id)).toHaveCount(0);
    for (const slug of ["providers", "capabilities", "skills", "connectors", "devices"]) await expect(page.getByTestId(`settings-pane-${slug}`), `pane ${slug}`).toHaveCount(0); // desktop modal nav
    await expect(offered(page, "profile")).toBeVisible(); await expect(offered(page, "prompts")).toBeVisible(); await expect(offered(page, "usage")).toBeVisible();
    await page.goto("/"); await page.waitForLoadState("networkidle");
    const viewport = page.viewportSize(); const wide = !!viewport && viewport.width >= 1024;
    if (!wide) await page.getByTestId("menu-button").click();
    for (const id of ERICH_ONLY_TESTIDS) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByTestId("menu-library")).toBeVisible();
    if (wide) { // the palette is a keyboard feature (Ctrl+K); phones have no shortcut
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      const box = page.getByRole("combobox");
      for (const word of ["Providers", "Capabilities", "Connectors", "Projects", "Artifacts", "Cloud", "Agents", "Skills"]) {
        await box.fill(word.toLowerCase());
        await expect(page.getByTestId("palette-item").filter({ hasText: new RegExp(`^(Settings: )?${word}$`) })).toHaveCount(0);
      }
      await box.fill("prompts"); await expect(page.getByTestId("palette-item").filter({ hasText: "Settings: Prompts" })).toHaveCount(1);
    }
    expect(team.hits403).toEqual([]);
  });

  test("deep links to Erich-only screens fall back to the start screen instead of an error page", async ({ page }) => {
    const team = await boot(page);
    for (const path of ["/settings/providers", "/settings/capabilities", "/connectors", "/projects", "/artifacts", "/skills", "/cloud", "/agents"]) {
      await page.goto(path); await page.waitForLoadState("networkidle"); await page.waitForTimeout(250);
      await expect(page.locator("body"), path).not.toContainText(ERROR_TEXT);
    }
    expect(team.hits403).toEqual([]);
  });

  test("saved prompts: add one, it is listed, and offered in the slash menu data path", async ({ page }) => {
    const team = await boot(page);
    await page.goto("/settings/prompts"); await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("prompts-empty")).toBeVisible();
    await page.getByTestId("prompt-add").click();
    await page.getByTestId("prompt-title").fill("Weekly report"); await page.getByTestId("prompt-text").fill("Write the weekly report");
    await page.getByTestId("prompt-save").click();
    await expect(page.getByTestId("prompt-row")).toHaveAttribute("data-title", "Weekly report");
    await expect(page.locator("body")).not.toContainText(ERROR_TEXT);
    expect(team.hits403).toEqual([]);
  });

  test("profile: name and nickname save; the instructions section is hidden", async ({ page }) => {
    const team = await boot(page);
    await page.goto("/settings/profile"); await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("profile-instructions")).toHaveCount(0);
    await page.getByTestId("profile-nickname").fill("Annie"); await page.getByTestId("profile-fullname").fill("Ann Example");
    await page.getByTestId("profile-fullname").blur();
    await expect(page.getByTestId("profile-status")).toHaveText("Saved");
    expect(team.hits403).toEqual([]);
  });
});
