import { test, expect, openChat, ask, typeMessage, clickSend } from "./fixtures";

// SW off: the skeleton test delays the state fetch with page.route, which WebKit does not apply to service-worker-handled requests.
test.describe("E2E findings", () => {
  test.use({ serviceWorkers: "block" });
  test("delete uses an in-app confirm sheet (no native dialog), cancel keeps, confirm deletes", async ({ app: { page, api } }) => {
    let native = 0;
    page.on("dialog", (d) => { native++; void d.dismiss(); });
    const id = await api.newChat();
    await page.goto("/chats");
    const row = page.getByTestId("chat-item").first();
    const del = async () => { await row.getByTestId("chat-menu-button").click(); await page.getByTestId("chat-menu-delete").click(); }; // the row's "…" menu
    await del();
    const sheet = page.getByTestId("confirm-sheet");
    await expect(sheet).toBeVisible();
    await page.getByTestId("confirm-cancel").click();
    await expect(sheet).toBeHidden();
    expect((await api.conversations()).some((c) => c.id === id)).toBe(true);
    await del();
    await page.getByTestId("confirm-ok").click();
    await expect(sheet).toBeHidden();
    await expect.poll(async () => (await api.conversations()).some((c) => c.id === id)).toBe(false);
    expect(native).toBe(0);
  });

  test("reopening a chat shows a skeleton, never 'New chat' / 0 tokens / 'model' placeholders", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    await openChat(page, id);
    await ask(page, "Reply with just: ok");
    await expect(page.getByTestId("conv-cost")).toContainText(/tokens/);
    // slow the state load so the pre-load frame is observable
    await page.route(new RegExp(`/api/conversations/${id}$`), async (r) => { await new Promise((f) => setTimeout(f, 1500)); await r.continue(); });
    await page.goto("/");
    await page.goto(`/c/${id}`);
    await expect(page.getByTestId("chat-skel")).toBeVisible();
    await expect(page.locator("header.chatbar").getByText("New chat", { exact: true })).toHaveCount(0); // the header only: the desktop sidebar lists a pending title as "New chat"
    await expect(page.getByTestId("conv-cost")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Choose model" })).toBeDisabled();
    await expect(page.getByTestId("conv-cost")).toContainText(/tokens/, { timeout: 15_000 });
    await expect(page.getByTestId("chat-skel")).toHaveCount(0);
  });

  test("chat header token chip matches the Usage tokens for the conversation (title call included)", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    await openChat(page, id);
    await ask(page, "Reply with just: ok");
    await expect.poll(async () => (await api.conversations()).find((c) => c.id === id)?.title ?? "", { timeout: 60_000 }).not.toBe("");
    await expect(page.getByTestId("conv-cost")).toContainText(/tokens/);
    const m = (await page.getByTestId("conv-cost").innerText()).match(/([\d.]+)([kM]?) tokens/) ?? [];
    const chip = Number(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1);
    const rep = await (await api.get(`/api/usage?tz=0`)).json();
    const row = (rep.topConversations as { id: string; tokens: number }[]).find((c) => c.id === id);
    expect(row, "conversation missing from Usage").toBeDefined();
    expect(Math.abs(row!.tokens - chip)).toBeLessThan(60 + row!.tokens * 0.06); // chip is rounded to 0.1k
    await expect(page.getByTestId("conv-cost")).not.toContainText("$");
  });

  // exploratory finding 20260930T051910Z-c4c983: `.live` (desktop remote-screen frame, black) also matched the streaming assistant bubble.
  test("streaming assistant bubble is styled like a finished reply (not the black desktop-frame box)", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await typeMessage(page, "Write a numbered list of 60 fun facts about the ocean, two sentences each.");
    await clickSend(page);
    const live = page.locator(".msg.assistant.live");
    await expect(page.locator(".msg.assistant.live .md")).toBeVisible({ timeout: 60_000 });
    const css = await live.evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, display: c.display }; });
    expect(css.bg, "streaming bubble must not have an opaque black background").not.toBe("rgb(0, 0, 0)");
    expect(css.display).not.toBe("flex");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 30_000 });
  });
});
