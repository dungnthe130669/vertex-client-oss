import { test, expect, openDrawer, type Api } from "./fixtures";
import type { Page } from "@playwright/test";

// Command palette (Ctrl/Cmd+K on desktop, search button in the drawer on phones) + chat management (rename / pin / delete from the row menu).
// Runs on desktop-chromium and iphone-webkit. Chats are created through the API with a unique title; the UI is what is asserted.
const uniq = () => `PAL${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
async function seed(api: Api, title: string): Promise<string> {
  const id = await api.newChat();
  const r = await api.mut("PATCH", `/api/conversations/${id}`, { title });
  expect(r.status(), await r.text()).toBe(200);
  return id;
}
const titleOf = async (api: Api, id: string) => (await api.conversations()).find((c) => c.id === id) as { title: string; pinned?: number } | undefined;
const pinnedOf = async (api: Api, id: string) => ((await (await api.get("/api/conversations")).json()).conversations as Array<{ id: string; pinned: number }>).find((c) => c.id === id)?.pinned;
/** Open the palette the way the viewport allows: the keyboard shortcut on desktop, the drawer's search button on a phone. */
async function openPalette(page: Page, isMobile: boolean) {
  if (isMobile) { await openDrawer(page); await page.getByTestId("menu-search").click(); }
  else {
    // the shortcut listener is installed when the app mounts: pressing right after goto() raced it (the sidebar is the sign the shell is up)
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(async () => { if (!(await page.getByTestId("palette").isVisible())) await page.keyboard.press("ControlOrMeta+k"); await expect(page.getByTestId("palette")).toBeVisible({ timeout: 2000 }); }).toPass({ timeout: 20_000 });
  }
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(page.getByTestId("palette-input")).toBeFocused();
}
/** The list that holds the Recent rows: the desktop sidebar, or the phone drawer once opened. */
async function recentRoot(page: Page, isMobile: boolean) {
  if (isMobile) { await openDrawer(page); return page.getByTestId("drawer"); }
  return page.getByTestId("sidebar");
}

test.describe("command palette", () => {
  test("opens, has combobox/listbox roles, New chat is first, Esc closes", async ({ app: { page }, isMobile }) => {
    await page.goto("/chats");
    await openPalette(page, !!isMobile);
    await expect(page.getByRole("combobox")).toBeVisible();
    await expect(page.getByRole("listbox")).toBeVisible();
    const first = page.getByTestId("palette-item").first();
    await expect(first).toHaveText(/New chat/);
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("combobox")).toHaveAttribute("aria-activedescendant", /pal-opt-0/);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette")).toHaveCount(0);
  });

  test("Enter on the first item (New chat) goes to the start screen", async ({ app: { page, api }, isMobile }) => {
    const id = await seed(api, uniq());
    await page.goto(`/c/${id}`);
    await openPalette(page, !!isMobile);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });

  test("search finds a chat title and an artifact title; arrows + Enter navigate", async ({ app: { page, api }, isMobile }) => {
    const t = uniq(), a = uniq() + "ART";
    const id = await seed(api, t);
    const ar = await api.mut("POST", "/api/artifacts", { title: a, type: "markdown", content: "# palette" });
    expect(ar.status(), await ar.text()).toBe(201);
    await page.goto("/chats");
    await openPalette(page, !!isMobile);
    await page.getByTestId("palette-input").fill(t.slice(0, 7));
    const item = page.getByTestId("palette-item").filter({ hasText: t });
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute("data-kind", "chat");
    await page.getByTestId("palette-input").fill(a);
    await expect(page.getByTestId("palette-item").filter({ hasText: a })).toHaveAttribute("data-kind", "artifact"); // via the server search (>2 chars)
    await page.getByTestId("palette-input").fill(t);
    // e2eflk1: the previous query's server hits (the artifact) stay in the list until the answer for THIS term replaces them (debounce 200 ms + request), and the list
    // length changes under the arrow keys / Enter. Wait for that answer to land (the stale artifact row is gone) before navigating, instead of racing it.
    await expect(page.getByTestId("palette-item").filter({ hasText: a })).toHaveCount(0);
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp"); // wraps / stays within the list
    await expect(item).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/c/${id}$`));
    await expect(page.getByTestId("palette")).toHaveCount(0);
  });

  test("destinations and actions: 'usage' navigates, 'theme' toggles the theme", async ({ app: { page }, isMobile }) => {
    await page.goto("/chats");
    await openPalette(page, !!isMobile);
    await page.getByTestId("palette-input").fill("usage");
    await expect(page.getByTestId("palette-item").first()).toHaveText(/Usage/);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/usage$/);
    if (isMobile) await page.goto("/chats"); // Usage has a back arrow, not the hamburger: the drawer's search button is not reachable from there
    const before = await page.evaluate(() => document.documentElement.dataset.theme ?? "auto");
    await openPalette(page, !!isMobile);
    await page.getByTestId("palette-input").fill("toggle theme");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? "auto")).not.toBe(before);
    await page.evaluate(() => (window as any).vcTheme?.set("auto"));
  });

  test("an unmatched query says so, and a click on the backdrop closes", async ({ app: { page }, isMobile }) => {
    await page.goto("/chats");
    await openPalette(page, !!isMobile);
    await page.getByTestId("palette-input").fill("qqzzxxnomatch");
    await expect(page.getByTestId("palette-empty")).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.getByTestId("palette")).toHaveCount(0);
  });
});

test.describe("chat management (row menu)", () => {
  test("rename inline from the All chats list: Enter saves, Esc cancels", async ({ app: { page, api } }) => {
    const t = uniq(), n = uniq() + "NEW";
    const id = await seed(api, t);
    await page.goto("/chats");
    const row = page.getByTestId("list-row").filter({ hasText: t }).locator("xpath=ancestor::li[1]");
    await row.getByTestId("chat-menu-button").click();
    await page.getByTestId("chat-menu-rename").click();
    const input = page.getByTestId("rename-input"); // page-wide: the row locator filters on the title text, which the input replaces
    await expect(input).toBeFocused();
    await input.fill("discarded"); await page.keyboard.press("Escape");
    await expect(page.getByTestId("rename-input")).toHaveCount(0);
    expect((await titleOf(api, id))?.title).toBe(t);
    await row.getByTestId("chat-menu-button").click();
    await page.getByTestId("chat-menu-rename").click();
    await page.getByTestId("rename-input").fill(n); await page.keyboard.press("Enter");
    await expect(page.getByTestId("list-row").filter({ hasText: n })).toBeVisible();
    await expect.poll(async () => (await titleOf(api, id))?.title).toBe(n);
  });

  test("pin / unpin: a Pinned group appears above Recent in the sidebar / drawer and in All chats; the server keeps it", async ({ app: { page, api }, isMobile }) => {
    const t = uniq(); const id = await seed(api, t);
    await seed(api, uniq()); // a newer chat, so "pinned first" is visible
    await page.goto("/chats");
    const row = page.getByTestId("list-row").filter({ hasText: t }).locator("xpath=ancestor::li[1]");
    await row.getByTestId("chat-menu-button").click();
    await expect(page.getByTestId("chat-menu-pin")).toHaveText("Pin");
    await page.getByTestId("chat-menu-pin").click();
    await expect(page.getByTestId("list-pinned").getByTestId("list-row").filter({ hasText: t })).toBeVisible();
    await expect.poll(() => pinnedOf(api, id)).toBe(1);
    await page.reload();
    await expect(page.getByTestId("list-pinned").getByTestId("list-row").filter({ hasText: t })).toBeVisible();
    const root = await recentRoot(page, !!isMobile);
    await expect(root.getByTestId("drawer-pinned").getByTestId("recent-row").filter({ hasText: t })).toBeVisible();
    // unpin from the sidebar / drawer row
    const srow = root.getByTestId("drawer-pinned").getByTestId("chat-item").filter({ hasText: t });
    await srow.hover();
    await srow.getByTestId("chat-menu-button").click();
    await expect(page.getByTestId("chat-menu-pin")).toHaveText("Unpin");
    await page.getByTestId("chat-menu-pin").click();
    await expect(root.getByTestId("drawer-pinned")).toHaveCount(0);
    await expect.poll(() => pinnedOf(api, id)).toBe(0);
  });

  test("delete from the sidebar / drawer asks first; cancel keeps, confirm deletes", async ({ app: { page, api }, isMobile }) => {
    const t = uniq(); const id = await seed(api, t);
    await page.goto("/chats");
    const root = await recentRoot(page, !!isMobile);
    const srow = root.getByTestId("chat-item").filter({ hasText: t });
    await srow.hover();
    await srow.getByTestId("chat-menu-button").click();
    await page.getByTestId("chat-menu-delete").click();
    await expect(page.getByTestId("confirm-sheet")).toBeVisible();
    await page.getByTestId("confirm-cancel").click();
    expect(await titleOf(api, id)).toBeTruthy();
    await srow.getByTestId("chat-menu-button").click();
    await page.getByTestId("chat-menu-delete").click();
    await page.getByTestId("confirm-ok").click();
    await expect(srow).toHaveCount(0);
    await expect.poll(async () => !!(await titleOf(api, id))).toBe(false);
  });

  test("long-press (touch) opens the menu without opening the chat @mobile-only", async ({ app: { page, api } }) => {
    const t = uniq(); await seed(api, t);
    await page.goto("/chats");
    const row = page.getByTestId("list-row").filter({ hasText: t });
    const b = (await row.boundingBox())!;
    const at = { clientX: b.x + 20, clientY: b.y + b.height / 2, pointerType: "touch", pointerId: 7, isPrimary: true, bubbles: true };
    await row.dispatchEvent("pointerdown", at);
    await page.waitForTimeout(700);
    await expect(page.getByTestId("chat-menu")).toBeVisible();
    await row.dispatchEvent("pointerup", at);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-menu")).toHaveCount(0);
    await expect(page).toHaveURL(/\/chats$/);
  });
});
