import { test, expect, headerAction, hasSidebar, type Api } from "./fixtures";
import { openSettingsRow } from "./polish-mock";
import type { Page } from "@playwright/test";

const noHOverflow = async (page: Page, what: string) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  expect(o.sw, `${what}: page scrolls horizontally (scrollWidth ${o.sw} > ${o.iw})`).toBeLessThanOrEqual(o.iw + 1);
};
// back to the main Settings page: the phone's pushed-screen Back, or the desktop modal's left list
const back = async (page: Page) => { if (await hasSidebar(page)) await page.getByTestId("settings-pane-general").click(); else await page.getByTestId("subpage-back").click(); };
const resetProfile = async (api: Api) => { await api.mut("PUT", "/api/profile", { fullName: "", nickname: "", instructions: "" }); };
const PAGES = [["profile", "Profile", "profile-page"], ["appearance", "Appearance", "appearance-page"], ["capabilities", "Capabilities", "capabilities-page"]] as const;

test.describe("settings: Profile / Appearance / Capabilities", () => {
  for (const [slug, title, pageId] of PAGES) {
    test(`navigation: Settings -> ${title} -> back; deep link and reload work`, async ({ app: { page } }) => {
      await page.goto("/");
      await headerAction(page, "Settings");
      await openSettingsRow(page, slug);
      await expect(page).toHaveURL(new RegExp(`/settings/${slug}$`));
      if (!(await hasSidebar(page))) await expect(page.getByRole("heading", { name: title })).toBeVisible(); // desktop: the modal's left list names the page
      await expect(page.getByTestId(pageId)).toBeVisible();
      await back(page);
      await expect(page).toHaveURL(/\/settings$/);
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      // deep link: no in-app history, Back still lands on Settings
      await page.goto(`/settings/${slug}`);
      await expect(page.getByTestId(pageId)).toBeVisible();
      await page.reload();
      await expect(page.getByTestId(pageId)).toBeVisible();
      await back(page);
      await expect(page).toHaveURL(/\/settings$/);
    });
  }

  test("profile: auto-saves, persists after reload, and the start screen greets by nickname", async ({ app: { page, api } }) => {
    try {
      await page.goto("/settings/profile");
      const nick = page.getByTestId("profile-nickname");
      await expect(nick).toBeVisible();
      await page.getByTestId("profile-fullname").fill("Test Person");
      await nick.fill("Quokka");
      await page.getByTestId("profile-instructions").fill("Always reply tersely.");
      await expect(page.getByTestId("profile-count")).toHaveText("21 / 4000");
      await expect(page.getByTestId("profile-status")).toHaveText("Saved");
      await page.reload();
      await expect(page.getByTestId("profile-nickname")).toHaveValue("Quokka");
      await expect(page.getByTestId("profile-fullname")).toHaveValue("Test Person");
      await expect(page.getByTestId("profile-instructions")).toHaveValue("Always reply tersely.");
      await page.goto("/");
      await expect(page.getByTestId("greeting")).toHaveText(/^Good (morning|afternoon|evening), Quokka$/);
      await headerAction(page, "Settings");
      if (!(await hasSidebar(page))) await expect(page.getByTestId("profile-value")).toHaveText("Quokka"); // the phone's Profile row shows the nickname; the desktop modal lists Profile as a pane instead
      // clearing the nickname goes back to the plain greeting
      await openSettingsRow(page, "profile");
      await page.getByTestId("profile-nickname").fill("");
      await expect(page.getByTestId("profile-status")).toHaveText("Saved");
      await page.goto("/");
      await expect(page.getByTestId("greeting")).toHaveText(/^Good (morning|afternoon|evening)$/);
    } finally { await resetProfile(api); }
  });

  test("profile: leaving the page right after typing still saves; instructions are capped at 4000", async ({ app: { page, api } }) => {
    try {
      await page.goto("/settings/profile");
      await page.getByTestId("profile-nickname").fill("QuickLeave");
      await back(page); // before the debounce fires: the page flushes on leave
      await expect.poll(async () => (await (await api.get("/api/profile")).json()).nickname).toBe("QuickLeave");
      await page.goto("/settings/profile");
      await page.getByTestId("profile-instructions").fill("x".repeat(4100));
      await expect(page.getByTestId("profile-count")).toHaveText("4000 / 4000");
      await expect(page.getByTestId("profile-status")).toHaveText("Saved");
      expect((await (await api.get("/api/profile")).json()).instructions).toHaveLength(4000);
    } finally { await resetProfile(api); }
  });

  test("appearance: size, fonts and code wrapping apply, persist after reload, reset restores defaults", async ({ app: { page } }) => {
    await page.goto("/settings/appearance");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-fs", "3");
    const sampleSize = () => page.getByTestId("appearance-sample").evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(await sampleSize()).toBe(16);
    await page.getByTestId("font-size").fill("5");
    await expect(html).toHaveAttribute("data-fs", "5");
    expect(await sampleSize()).toBe(20);
    await expect(page.getByTestId("font-size-value")).toHaveText("20 px");
    await page.getByTestId("tf-serif").click();
    await expect(html).toHaveAttribute("data-tf", "serif");
    expect(await page.getByTestId("appearance-sample").evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/serif|Georgia/i);
    await page.getByTestId("cf-sf").click();
    await expect(html).toHaveAttribute("data-cf", "sf");
    const wrap = page.getByTestId("code-wrap");
    await expect(wrap).toHaveAttribute("aria-checked", "false");
    const preWs = () => page.locator('[data-testid="appearance-sample"] pre code').evaluate((e) => getComputedStyle(e).whiteSpace);
    expect(await preWs()).toBe("pre");
    await wrap.click();
    await expect(wrap).toHaveAttribute("aria-checked", "true");
    await expect(html).toHaveAttribute("data-wrap", "1");
    expect(await preWs()).toBe("pre-wrap");
    // before first paint after a reload: attributes are already there when the page is read back
    await page.reload();
    await expect(html).toHaveAttribute("data-fs", "5");
    await expect(html).toHaveAttribute("data-tf", "serif");
    await expect(html).toHaveAttribute("data-cf", "sf");
    await expect(html).toHaveAttribute("data-wrap", "1");
    await expect(page.getByTestId("tf-serif")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("appearance-reset").click();
    await expect(html).toHaveAttribute("data-fs", "3");
    await expect(html).toHaveAttribute("data-tf", "system");
    await expect(html).not.toHaveAttribute("data-wrap", /.*/);
    await expect(wrap).toHaveAttribute("aria-checked", "false");
  });

  test("capabilities: read-only list, no switches, tools match the slash catalogue", async ({ app: { page, api } }) => {
    await page.goto("/settings/capabilities");
    await expect(page.getByTestId("capabilities-page")).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    const items = (await (await api.get("/api/slash")).json()).items as Array<{ kind: string; name: string }>;
    const tools = items.filter((i) => i.kind === "tool").map((i) => i.name).sort();
    await expect.poll(async () => page.getByTestId("capability-tool").evaluateAll((els) => els.map((e) => e.getAttribute("data-name")).sort())).toEqual(tools);
  });

  test("layout at 390px: the three pages and the Settings list do not overflow", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [slug, , pageId] of PAGES) {
      await page.goto(`/settings/${slug}`);
      await expect(page.getByTestId(pageId)).toBeVisible();
      if (slug === "profile") { await expect(page.getByTestId("profile-nickname")).toBeVisible(); await page.getByTestId("profile-fullname").fill("N".repeat(80)); }
      await noHOverflow(page, slug);
    }
    await page.goto("/settings");
    await expect(page.getByTestId("open-profile").or(page.getByTestId("settings-pane-profile"))).toBeVisible();
    await noHOverflow(page, "settings list");
  });
});
