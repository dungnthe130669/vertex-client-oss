import { test, expect, ask, openChat, uniq, RUN_ID } from "./fixtures";

// Slash menu (spec §1, B1: tools + builtins). The e2e user sees only its own tool allowlist (search_notes, save_note,
// delete_note, connector_usage) plus the builtins. Written, not yet run by the author.

test.describe("slash menu", () => {
  test("typing / opens the popover with groups, rows and the approval badge", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    await box.fill("/");
    const pop = page.locator('[data-testid="slash-popover"]');
    await expect(pop).toBeVisible();
    await expect(pop.getByRole("listbox")).toBeVisible();
    expect(await pop.locator('[data-testid="slash-row"]').count()).toBeLessThanOrEqual(8);
    await expect(pop.locator('[data-testid="slash-group"]').first()).toBeVisible();
    await expect(pop.locator('[data-testid="slash-row"][data-name="save_note"] [data-testid="slash-approval"]')).toHaveText("will ask for approval");
    await expect(pop.locator('[data-testid="slash-row"][data-name="search_notes"] [data-testid="slash-approval"]')).toHaveCount(0);
    await expect(pop.locator('[data-name="list_agents"]')).toHaveCount(0);
    await expect(box).toHaveAttribute("aria-activedescendant", /slash-opt-0/);
  });

  test("/sea filters to search_notes; Enter inserts it and does NOT send", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    await box.fill("/sea");
    const rows = page.locator('[data-testid="slash-row"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-name", "search_notes");
    await box.press("Enter");
    await expect(box).toHaveValue("/search_notes ");
    await expect(page.locator('[data-testid="slash-popover"]')).toHaveCount(0);
    await expect(page.locator(".msg.user")).toHaveCount(0); // nothing was sent
  });

  test("arrows move the selection, Tab accepts, Esc dismisses", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    await box.fill("/");
    const rows = page.locator('[data-testid="slash-row"]');
    await expect(rows.first()).toHaveAttribute("aria-selected", "true");
    await box.press("ArrowDown");
    await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
    await box.press("ArrowUp");
    await expect(rows.first()).toHaveAttribute("aria-selected", "true");
    await box.press("Escape");
    await expect(page.locator('[data-testid="slash-popover"]')).toHaveCount(0);
    await expect(box).toHaveValue("/");
    await box.fill("/sea");
    await box.press("Tab");
    await expect(box).toHaveValue("/search_notes ");
  });

  test("tapping a row accepts it", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    await box.fill("/sea");
    await page.locator('[data-testid="slash-row"][data-name="search_notes"]').click();
    await expect(box).toHaveValue("/search_notes ");
  });

  test("/model opens the model sheet; disabled /clear does nothing", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    await box.fill("/clear");
    await expect(page.locator('[data-testid="slash-row"][data-name="clear"]')).toHaveAttribute("aria-disabled", "true");
    await box.press("Enter");
    await expect(box).toHaveValue("/clear");
    await expect(page.locator(".msg.user")).toHaveCount(0);
    await box.fill("/model");
    await box.press("Enter");
    await expect(page.getByRole("dialog", { name: "Models" })).toBeVisible();
    await expect(box).toHaveValue("");
  });

  test("a slash on an approval tool still shows the approval card (never bypasses approval)", async ({ app: { page, api } }) => {
    const title = uniq("E2ESLASH");
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    try {
      await box.fill("/save_note");
      await box.press("Tab");
      await expect(box).toHaveValue("/save_note ");
      await box.pressSequentially(`titled "${title}" with body "slash e2e, safe to delete". Call it right now without asking me anything.`);
      await page.getByRole("button", { name: "Send" }).click();
      // the visible text keeps the slash (history is honest)
      await expect(page.locator(".msg.user .bubble-text").first()).toContainText("/save_note");
      await expect(page.locator('[data-testid="approval"]')).toBeVisible({ timeout: 60_000 });
      await page.locator('[data-testid="approval"]').getByRole("button", { name: "Deny" }).click();
    } finally {
      await ask(page, `Find the note titled "${title}" with search_notes; if it exists delete it with delete_note, then reply: done`, { approve: "approve" }).catch((e) => console.error(`SLASH NOTE CLEANUP FAILED for ${title} (run ${RUN_ID}):`, e.message));
    }
  });
});
