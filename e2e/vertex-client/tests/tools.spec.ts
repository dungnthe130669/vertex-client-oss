import { test, expect, ask, openChat, uniq, RUN_ID } from "./fixtures";

// The tools run against the real personal-connector. The only write is a note whose title carries the run id; the
// approve test deletes it again in a `finally` (delete_note also needs approval), so nothing is left behind.

test.describe("tools", () => {
  test("read tool runs automatically and shows a card with its result", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await ask(page, "Use the search_notes tool to search for E2E, then tell me in one short sentence how many notes matched.");
    const card = page.locator('[data-testid="tool-card"]').first();
    await expect(card.locator(".tname")).toHaveText("search_notes");
    await expect(card).toContainText("done");
    await expect(page.locator('[data-testid="approval"]')).toHaveCount(0);
    await card.locator("summary").first().click();
    await expect(card.getByText("Result")).toBeVisible();
  });

  test("side-effecting tool asks first; Approve runs it, and the note is cleaned up", async ({ app: { page, api } }) => {
    const title = uniq("E2ENOTE");
    await openChat(page, await api.newChat());
    try {
      await ask(page, `Use the save_note tool to save a note titled "${title}" with the body "created by an automated test, safe to delete". Call the tool right now, in your first reply, without asking me anything or describing it first. Do nothing else.`, { approve: "approve" });
      const save = page.locator('[data-testid="tool-card"]').filter({ hasText: "save_note" }).first();
      await expect(save).toContainText("done");
      await expect(page.locator('[data-testid="approval"]')).toHaveCount(0);
      // prove it exists
      const found = await ask(page, `Use search_notes to look for "${title}" and answer only yes or no: does a note with that exact title exist?`);
      expect(found.toLowerCase()).toContain("yes");
    } finally {
      await ask(page, `Find the note titled "${title}" with search_notes and delete it with delete_note. Then reply: deleted`, { approve: "approve" }).catch((e) => console.error(`NOTE CLEANUP FAILED for ${title} (run ${RUN_ID}):`, e.message));
    }
    const gone = await ask(page, `Use search_notes to look for "${title}" and answer only yes or no: does a note with that exact title still exist?`);
    expect(gone.toLowerCase()).toContain("no");
  });

  test("Deny sends an error result to the model and nothing is saved", async ({ app: { page, api } }) => {
    const title = uniq("E2EDENY");
    await openChat(page, await api.newChat());
    const before = await page.locator('[data-testid="msg-cost"]').count();
    await page.getByPlaceholder("Message").fill(`Use the save_note tool to save a note titled "${title}" with body "test note for the deny flow".`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const card = page.locator('[data-testid="approval"]').first();
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("Waiting for your approval above")).toBeVisible();
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(page.locator('[data-testid="tool-card"]').filter({ hasText: "save_note" }).first()).toContainText(/error|Denied/i, { timeout: 60_000 });
    await expect(page.locator('[data-testid="approval"]')).toHaveCount(0);
    // the turn continues: the model answers after the denial
    await expect.poll(async () => page.locator('[data-testid="msg-cost"]').count(), { timeout: 90_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(2500);
    const check = await ask(page, `Use search_notes to look for "${title}" and answer only yes or no: does a note with that exact title exist?`);
    expect(check.toLowerCase()).toContain("no");
  });
});
