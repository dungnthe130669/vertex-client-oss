import { test, expect, openChat, typeMessage, clickSend, ask } from "./fixtures";

// Stop before the first token, offline composer, unsent drafts, keyboard-shortcuts help.
test.describe("reliability", () => {
  test("stop pressed right after send ends the turn Stopped within seconds; composer usable; nothing charged", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    await openChat(page, id);
    await typeMessage(page, "Write a very long, detailed 1500-word essay about the history of tea.");
    await clickSend(page);
    await page.getByRole("button", { name: "Stop" }).click(); // no wait for the first token
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 8_000 });
    // Contract (stopspec1): after Stop the UI returns to idle. Stop can land before the turn starts (server answers rejected code:"stopped": no turn, no
    // banner, no label) or after (the turn ends interrupted and shows "Stopped"); both are correct, so only the idle state is asserted unconditionally.
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(page.locator(".error")).toHaveCount(0); // the user's own Stop is never a red banner
    await expect.poll(async () => (await page.locator(".msg.assistant").count()) === 0 || (await page.locator(".msg.assistant .stopped").count()) > 0, { timeout: 8_000, message: "an assistant message that exists after Stop must show Stopped" }).toBe(true);
    await expect(page.locator('[data-testid="msg-cost"]')).toHaveCount(0); // a turn stopped before any token has no usage chip
    await ask(page, "Reply with exactly one word: pong"); // the chat is usable afterwards
  });

  test("offline: the composer says why it cannot send and keeps the draft; back online it recovers @desktop-only", async ({ app: { page, api }, context }) => {
    await openChat(page, await api.newChat());
    await typeMessage(page, "draft while offline");
    await context.setOffline(true);
    try {
      await expect(page.getByTestId("composer-blocked")).toContainText("Offline - will send when back", { timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
      await expect(page.getByPlaceholder("Message")).toHaveValue("draft while offline");
    } finally { await context.setOffline(false); }
    await expect(page.getByTestId("composer-blocked")).toHaveCount(0, { timeout: 45_000 });
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });

  test("an unsent draft survives a reload, per chat", async ({ app: { page, api } }) => {
    const a = await api.newChat(), b = await api.newChat();
    await openChat(page, a);
    await typeMessage(page, "half-written thought A");
    await page.reload();
    await expect(page.getByPlaceholder("Message")).toHaveValue("half-written thought A");
    await openChat(page, b);
    await expect(page.getByPlaceholder("Message")).toHaveValue(""); // another chat does not inherit it
    await openChat(page, a);
    await expect(page.getByPlaceholder("Message")).toHaveValue("half-written thought A");
  });

  test("? opens the keyboard shortcuts dialog, Esc closes it; not while typing @desktop-only", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await page.getByPlaceholder("Message").focus();
    await page.keyboard.type("?");
    await expect(page.getByTestId("shortcuts")).toHaveCount(0);
    await expect(page.getByPlaceholder("Message")).toHaveValue("?");
    await page.getByPlaceholder("Message").fill("");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("?"); // key "?" as a real keyboard reports it (Playwright "Shift+/" reports key "/" and would never match)
    const dlg = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("Ctrl+K");
    await expect(dlg).toContainText("Shift+Enter");
    await expect(dlg.getByTestId("shortcuts-close")).toBeFocused(); // the shared focus helper / autofocus moved focus in
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
  });

  test("palette item 'Keyboard shortcuts' opens the dialog @desktop-only", async ({ app: { page } }) => {
    await page.goto("/chats");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(async () => { if (!(await page.getByTestId("palette").isVisible())) await page.keyboard.press("ControlOrMeta+k"); await expect(page.getByTestId("palette")).toBeVisible({ timeout: 2000 }); }).toPass({ timeout: 20_000 });
    await page.getByTestId("palette-input").fill("keyboard shortcuts");
    await page.getByTestId("palette-input").press("Enter");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  });
});
