import { test, expect, type Api } from "./fixtures";
import type { Page } from "@playwright/test";

// Desktop shell (>=1024px): persistent sidebar, no hamburger/overlay drawer, Cmd/Ctrl+K and +B, artifact side panel, settings modal.
// Artifacts are seeded through POST /api/artifacts (e2e scope only); the chat is an empty conversation (no model call). Written to run on desktop-chromium;
// the last test is the phone regression (iphone-webkit): the hamburger + drawer must be exactly what they were.
const uniq = () => `E2E${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
async function seed(api: Api, s: { title: string; type: "markdown" | "html"; content: string }): Promise<string> {
  const r = await api.mut("POST", "/api/artifacts", s);
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).id as string;
}
// what ArtifactCard's Open button does: a pushed history entry marked fromApp
const openArtifact = (page: Page, id: string) => page.evaluate((x) => { history.pushState({ fromApp: true }, "", `/artifacts/${x}`); dispatchEvent(new PopStateEvent("popstate")); }, id);
const widthOf = async (page: Page, testid: string) => (await page.getByTestId(testid).boundingBox())!.width;

for (const vp of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
  test.describe(`desktop shell @${vp.width} @desktop-only`, () => {
    test.beforeEach(async ({ app: { page } }) => { await page.setViewportSize(vp); });

    test("sidebar is there, the hamburger and the drawer are not; chat column and composer are bounded", async ({ app: { page } }) => {
      await page.goto("/");
      await expect(page.getByTestId("sidebar")).toBeVisible();
      for (const t of ["menu-mode-chat", "menu-mode-cloud", "menu-artifacts", "menu-settings", "drawer-new-chat", "drawer-avatar"]) await expect(page.getByTestId(t)).toBeVisible();
      expect(await widthOf(page, "sidebar")).toBeGreaterThan(260);
      expect(await widthOf(page, "sidebar")).toBeLessThan(300);
      await expect(page.getByTestId("menu-button").filter({ visible: true })).toHaveCount(0);
      await expect(page.getByTestId("drawer")).toHaveCount(0);
      const col = (await page.locator(".msgs .col").first().boundingBox())!;
      expect(col.width, "chat column ~760px max").toBeLessThanOrEqual(762);
      const box = (await page.locator("footer.composer").boundingBox())!;
      expect(box.y + box.height, "composer docked at the bottom").toBeGreaterThan(vp.height - 60);
      expect(box.x, "composer sits right of the sidebar").toBeGreaterThan(280);
    });

    test("sidebar rows navigate; list screens use the main width (not a 960px column)", async ({ app: { page } }) => {
      await page.goto("/");
      await page.getByTestId("menu-mode-cloud").click();
      await expect(page).toHaveURL(/\/cloud$/);
      await expect(page.getByTestId("menu-mode-cloud")).toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId("menu-usage")).toHaveCount(0); // Usage is a pane of the Settings modal now
      await page.getByTestId("menu-settings").click();
      await page.getByTestId("settings-pane-usage").click();
      await expect(page.getByTestId("settings-pane").getByTestId("usage-today")).toBeVisible(); // pane content (the modal hides the page's own title)
      await page.getByTestId("settings-modal-close").click();
      await page.goto("/usage"); // standalone Usage page: the width checks below measure it, not the Cloud page behind the modal
      await expect(page.getByTestId("usage-today")).toBeVisible();
      const main = (await page.getByTestId("dmain").boundingBox())!;
      expect(main.x).toBeGreaterThanOrEqual(279);
      expect(main.x + main.width).toBeGreaterThanOrEqual(vp.width - 1);
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      expect(o.sw).toBeLessThanOrEqual(o.iw + 1);
    });

    test("Ctrl/Cmd+K opens the command palette from anywhere; its first item (New chat) starts a chat", async ({ app: { page } }) => {
      await page.goto("/usage");
      await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByTestId("palette")).toBeVisible();
      await expect(page.getByTestId("palette-item").first()).toHaveText(/New chat/);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("palette")).toHaveCount(0);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId("greeting")).toBeVisible();
      await page.keyboard.press("Control+k"); // on the start screen the palette opens again, Esc closes it, nothing breaks
      await expect(page.getByTestId("palette")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("palette")).toHaveCount(0);
      await expect(page.getByTestId("greeting")).toBeVisible();
    });

    test("Ctrl/Cmd+B toggles the sidebar and the choice survives a reload", async ({ app: { page } }) => {
      await page.goto("/");
      const sb = page.getByTestId("sidebar");
      await expect(sb).toHaveAttribute("data-open", "true");
      await page.keyboard.press("ControlOrMeta+b");
      await expect(sb).toHaveAttribute("data-open", "false");
      await expect(sb).toBeHidden();
      await expect(page.getByTestId("sidebar-open")).toBeVisible();
      expect((await page.getByTestId("dmain").boundingBox())!.x).toBeLessThan(2); // the main area took the space
      await page.reload();
      await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "false");
      await page.getByTestId("sidebar-open").click(); // the expand button
      await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "true");
      await page.getByTestId("sidebar-toggle").click(); // the collapse button inside the sidebar
      await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "false");
      await page.keyboard.press("Control+b");
      await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "true");
    });

    test("an artifact opened from a chat is a side panel next to it; sandbox contract; Esc and the X close it", async ({ app: { page, api } }) => {
      const ids: string[] = [], t = uniq();
      const conv = await api.newChat();
      try {
        ids.push(await seed(api, { title: `${t} Page`, type: "html", content: "<!doctype html><h1>hello panel</h1>" }));
        await page.goto(`/c/${conv}`);
        await expect(page.getByPlaceholder("Message")).toBeVisible();
        await openArtifact(page, ids[0]);
        const panel = page.getByTestId("artifact-panel");
        await expect(panel).toBeVisible();
        await expect(page.getByTestId("artifact-title")).toHaveText(`${t} Page`);
        await expect(page.getByPlaceholder("Message"), "the chat stays next to the panel").toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/artifacts/${ids[0]}$`));
        const pw = await widthOf(page, "artifact-panel");
        expect(pw / vp.width).toBeGreaterThan(0.42);
        expect(pw / vp.width).toBeLessThan(0.48);
        const frame = page.getByTestId("artifact-frame");
        await expect(frame).toBeVisible();
        await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
        expect(await frame.getAttribute("src")).toMatch(/\/af\//);
        await expect(page.frameLocator('[data-testid="artifact-frame"]').getByRole("heading", { name: "hello panel" })).toBeVisible();
        if (vp.width < 1280) await expect(page.getByTestId("sidebar")).toBeHidden(); // not enough room for both: the sidebar steps aside
        else await expect(page.getByTestId("sidebar")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`/c/${conv}$`));
        await openArtifact(page, ids[0]);
        await expect(panel).toBeVisible();
        await page.getByTestId("artifact-close").click();
        await expect(panel).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`/c/${conv}$`));
      } finally {
        for (const id of ids) await api.mut("DELETE", `/api/artifacts/${id}`, {});
        await api.mut("DELETE", `/api/conversations/${conv}`);
      }
    });

    test("gallery still works and a viewer opened from it is the full page, not a panel", async ({ app: { page, api } }) => {
      const t = uniq(), id = await seed(api, { title: `${t} Notes`, type: "markdown", content: "# Heading\ntext" });
      try {
        await page.goto("/");
        await page.getByTestId("menu-artifacts").click();
        await expect(page).toHaveURL(/\/artifacts$/);
        await page.locator(`[data-testid="artifact-row"][data-title="${t} Notes"]`).locator("button.artrow").click();
        await expect(page.getByTestId("artifact-md")).toContainText("Heading");
        await expect(page.getByTestId("artifact-panel")).toHaveCount(0);
        await page.getByTestId("artifact-back").click();
        await expect(page.getByTestId("artifacts-list")).toBeVisible();
      } finally { await api.mut("DELETE", `/api/artifacts/${id}`, {}); }
    });

    test("settings is a two-pane modal: same pages, Esc closes, Appearance still applies", async ({ app: { page } }) => {
      await page.goto("/usage");
      await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
      await page.getByTestId("menu-settings").click();
      const modal = page.getByRole("dialog", { name: "Settings" });
      await expect(modal).toBeVisible();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(page.getByRole("heading", { name: "Usage", exact: true }), "the page you came from stays behind it").toBeVisible();
      await expect(page.getByTestId("settings-pane-general")).toHaveAttribute("aria-current", "page");
      await page.getByTestId("settings-pane-appearance").click();
      await expect(page).toHaveURL(/\/settings\/appearance$/);
      await expect(page.getByTestId("appearance-page")).toBeVisible();
      await page.getByTestId("settings-pane-profile").click();
      await expect(page.getByTestId("profile-page")).toBeVisible();
      await page.getByTestId("settings-pane-capabilities").click();
      await expect(page.getByTestId("capabilities-page")).toBeVisible();
      await page.getByTestId("settings-pane-general").click();
      await page.getByTestId("theme-dark").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.getByTestId("theme-light").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.getByTestId("theme-auto").click();
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);
      await expect(page).toHaveURL(/\/usage$/);
      await page.getByTestId("menu-settings").click(); // the X closes too
      await page.getByTestId("settings-modal-close").click();
      await expect(modal).toHaveCount(0);
    });

    test("settings deep link opens the modal over the start screen", async ({ app: { page } }) => {
      await page.goto("/settings");
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await page.getByTestId("settings-modal-close").click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId("greeting")).toBeVisible();
    });

    test("keyboard focus ring shows for keys, not for the mouse", async ({ app: { page } }) => {
      await page.goto("/");
      await page.getByTestId("menu-library").click();
      const row = page.getByTestId("menu-mode-cloud");
      await expect(row).toBeVisible();
      await page.keyboard.press("Tab");
      await page.getByTestId("menu-mode-cloud").focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const kbd = await page.getByTestId("dshell").evaluate((e) => e.classList.contains("kbd"));
      expect(kbd).toBe(true);
      const ring = await page.evaluate(() => { const e = document.activeElement as HTMLElement; return getComputedStyle(e).outlineStyle; });
      expect(ring).not.toBe("none");
      await page.getByTestId("menu-library").click();
      expect(await page.getByTestId("dshell").evaluate((e) => e.classList.contains("kbd"))).toBe(false);
    });
  });
}

test.describe("phone shell is unchanged @390 @mobile-only", () => {
  test("hamburger + overlay drawer, no sidebar, no desktop frame", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByTestId("greeting")).toBeVisible();
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    await expect(page.getByTestId("dshell")).toHaveCount(0);
    await page.getByTestId("menu-button").click();
    const drawer = page.getByTestId("drawer");
    await expect(drawer).toBeVisible();
    await drawer.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished))).catch(() => {});
    await expect(page.getByTestId("drawer-scrim")).toBeVisible();
    await page.getByTestId("menu-artifacts").click();
    await expect(page).toHaveURL(/\/artifacts$/);
    await expect(drawer).toHaveCount(0);
    await page.getByTestId("menu-button").click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });
});
