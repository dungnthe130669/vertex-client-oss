import { test, expect, ask, openChat } from "./fixtures";

// SMOKE tier (e2eperf1): the few things that must work after ANY deploy. ~7 tests x 2 projects, one real haiku round trip, target <= 5 min wall.
// Logs in through ./fixtures (slot-aware). No feature that is still in flux is touched (see flux-specs.txt); layout details live in the other specs.
test.describe("smoke", () => {
  test("login works: the signed-in app shell loads on the start screen", async ({ app: { page } }) => {
    await page.goto("/");
    await expect(page.getByTestId("greeting")).toBeVisible();
  });

  test("send a chat: haiku answers and the cost chip appears", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const a = await ask(page, "Reply with exactly one word: pong");
    expect(a.toLowerCase()).toContain("pong");
    await expect(page.locator('[data-testid="msg-cost"]').last()).toContainText(/ in \/ .* out/);
  });

  test("chat list shows the chat and reopening it keeps the messages", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    await openChat(page, id);
    await ask(page, "Reply with exactly one word: ping");
    await page.goto("/chats");
    await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
    await expect(page.locator(".list .row").first()).toBeVisible();
    await page.locator(".list .row").first().click();
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
    await expect(page.locator(".msg.user")).toContainText("ping");
  });

  test("main pages load without an error screen: /library /projects /usage", async ({ app: { page } }) => {
    for (const path of ["/library", "/projects", "/usage"]) {
      const r = await page.goto(path);
      expect(r?.status(), `${path} http status`).toBeLessThan(400);
      await expect(page.locator("body"), `${path} renders`).not.toBeEmpty();
      await expect(page.getByText(/something went wrong|application error/i), `${path} error screen`).toHaveCount(0);
    }
  });

  test("devices: the list API answers (200 with a list, or 404 = master switch off for the e2e user; never 5xx) and its settings page loads", async ({ app: { page, api } }) => {
    const r = await api.get("/api/devices");   // measured 2026-11-05: the e2e fixture users have the devices switch OFF => 404 (see chat-env.spec.ts)
    expect([200, 404], `GET /api/devices -> ${r.status()}`).toContain(r.status());
    if (r.status() === 200) expect(Array.isArray((await r.json()).devices)).toBe(true);
    const p = await page.goto("/settings/devices");
    expect(p?.status()).toBeLessThan(400);
    await expect(page.getByText(/something went wrong|application error/i)).toHaveCount(0);
  });

  test("navigation: chats list -> New chat -> start screen; deep link to a chat works", async ({ app: { page, api } }) => {
    await page.goto("/chats");
    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.getByTestId("greeting")).toBeVisible();
    const id = await api.newChat();
    await page.goto(`/c/${id}`);
    await expect(page.getByPlaceholder("Message")).toBeVisible();
  });

  test("API guard: /api/me answers for the signed-in user and 401 without a session", async ({ app: { api }, playwright, baseURL }) => {
    expect((await api.get("/api/me")).status()).toBe(200);
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.get("/api/me")).status()).toBe(401);
    await anon.dispose();
  });
});
