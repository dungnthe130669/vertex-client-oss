import { test, expect, HAIKU, ask, controlWs, openChat, typeMessage, clickSend, waitSettled, lastAssistantText } from "./fixtures";

test.describe("chat", () => {
  test("new chat from the list -> empty start screen, first send creates it, streamed answer, follow-up keeps context, token chip", async ({ app: { page, api } }) => {
    await page.goto("/chats");
    await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
    await page.getByRole("button", { name: "New chat" }).first().click();   // the FAB (or the empty-state button) -> the start screen
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("greeting")).toBeVisible();
    expect((await api.conversations()).length, "no conversation until the first send").toBe(0);
    // default model is the flagship; switch to haiku through the real sheet to keep the run cheap
    await page.getByRole("button", { name: "Choose model" }).click();
    await page.getByRole("dialog", { name: "Models" }).getByRole("button", { name: /Haiku 5\.5/ }).click();
    const a1 = await ask(page, "My favourite colour is teal. Reply with just: noted");
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
    expect(a1.toLowerCase()).toContain("noted");
    const a2 = await ask(page, "What is my favourite colour? One word.");
    expect(a2.toLowerCase()).toContain("teal");
    await expect(page.locator('[data-testid="msg-cost"]').last()).toContainText(/ in \/ .* out/);
    await expect(page.locator('[data-testid="conv-cost"]')).toContainText(/tokens/);
    expect((await api.conversations()).length).toBe(1);
  });

  test("text streams in incrementally", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const before = await page.locator('[data-testid="msg-cost"]').count();
    await typeMessage(page, "Write the numbers from 1 to 300 separated by single spaces, nothing else.");
    await clickSend(page);
    const seen = new Set<number>();
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      const md = page.locator(".msg.assistant .md");
      const n = (await md.count()) ? (await md.last().innerText().catch(() => "")).length : 0;
      if (n) seen.add(n);
      if ((await page.locator('[data-testid="msg-cost"]').count()) > before) break;
      await page.waitForTimeout(60);
    }
    expect(seen.size, `distinct text lengths observed while streaming: ${[...seen].join(",")}`).toBeGreaterThanOrEqual(3);
    await waitSettled(page, before);
    expect(await lastAssistantText(page)).toMatch(/\b300\b/);
  });

  test("connection drop mid-turn: reconnects and the answer arrives complete", async ({ app: { page, api }, context, browserName }) => {
    const ws = await controlWs(page);
    await openChat(page, await api.newChat());
    const before = await page.locator('[data-testid="msg-cost"]').count();
    await typeMessage(page, "List the integers from 1 to 70, one per line, with no other text.");
    await clickSend(page);
    await expect(page.locator(".msg.assistant .md, .msg.assistant.live").first()).toBeVisible({ timeout: 60_000 });
    // go offline: cut the socket, refuse reconnects, and (where supported) really take the network down
    ws.block(true);
    if (browserName === "chromium") await context.setOffline(true).catch(() => {});
    ws.dropNow();
    await expect(page.locator(".dot.open")).toHaveCount(0, { timeout: 15_000 });
    await page.waitForTimeout(3000);
    if (browserName === "chromium") await context.setOffline(false).catch(() => {});
    ws.block(false);
    await expect(page.locator(".dot.open")).toBeVisible({ timeout: 45_000 });
    await waitSettled(page, before);
    const text = await lastAssistantText(page);
    for (let i = 1; i <= 70; i++) expect(text, `number ${i} missing after reconnect`).toMatch(new RegExp(`(^|\\D)${i}(\\D|$)`));
  });

  test("stop mid-turn keeps the partial answer and the chat stays usable", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await typeMessage(page, "Write a detailed 600-word essay about the history of tea.");
    await clickSend(page);
    await expect(page.locator(".msg.assistant.live .md")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    const partial = await lastAssistantText(page);
    expect(partial.length).toBeGreaterThan(20);
    expect(partial.length).toBeLessThan(4000);
    // a stopped turn's cost chip can land late and confuse ask()'s settle check, so poll for the reply itself
    await ask(page, "Reply with exactly one word: pong");
    await expect.poll(async () => (await lastAssistantText(page)).toLowerCase(), { timeout: 30_000 }).toContain("pong");
  });

  test("model switch via the bottom sheet applies to the next turn", async ({ app: { page, api } }) => {
    const id = await api.newChat("claude-sonnet-5-5");
    await openChat(page, id);
    const pill = page.getByRole("button", { name: "Choose model" });
    await expect(pill).toContainText(/Sonnet 5\.5/);
    await pill.click();
    const sheet = page.getByRole("dialog", { name: "Models" });
    await expect(sheet).toBeVisible();
    expect(await sheet.getByRole("button").count()).toBeGreaterThan(2);
    await sheet.getByRole("button", { name: /Haiku 5\.5/ }).click();
    await expect(sheet).toHaveCount(0);
    await expect(pill).toContainText(/Haiku 5\.5/);
    const a = await ask(page, "Reply with exactly one word: pong");
    expect(a.toLowerCase()).toContain("pong");
    await page.goto("/chats");
    await expect(page.locator(".list .row").first()).toContainText(HAIKU);   // list shows the model the turn ran on
  });
});

test.describe("usage1: tokens only per item, cost only as an estimated total", () => {
  test("no $ in the message footer or info sheet; tokens shown; usage total says estimate", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    await openChat(page, id);
    await ask(page, "Reply with just: ok");
    await expect(page.locator('[data-testid="msg-cost"]').last()).toContainText(/ in \/ .* out/);
    await expect(page.locator('[data-testid="msg-cost"]').last()).not.toContainText("$");
    const foot = page.locator(".turn-foot").last();
    await foot.locator("summary").click();
    await expect(foot.locator(".turn-meta")).toContainText(/ in \/ .* out/);
    await expect(foot).not.toContainText("$");
    await page.getByTestId("chat-header-menu").click(); await page.getByTestId("chat-menu-info").click();
    await expect(page.getByTestId("info-usage")).toContainText(/tokens/);
    await expect(page.getByTestId("conv-info")).not.toContainText("$");
    await page.goto("/usage");
    await expect(page.getByTestId("usage-today")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("usage-estimate").first()).toContainText(/estimate/i);
  });
});
