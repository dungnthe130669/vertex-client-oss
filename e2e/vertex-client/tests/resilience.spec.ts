import { test as base, expect as bx } from "@playwright/test";
import { test, expect, openChat } from "./fixtures";

// M6 hardening + SSO landing (container-safe half: the positive SSO landing needs a real token and runs from build-host, scripts/sso-check.mjs).
test.describe("sso: signed-out entry", () => {
  base.use({ storageState: { cookies: [], origins: [] } });
  base("/auth/login bounces to auth.dev2 (302), and the login page offers Sign in + GitHub fallback", async ({ page, request, baseURL }) => {
    const r = await request.get(`${baseURL}/auth/login`, { maxRedirects: 0 });
    bx(r.status()).toBe(302);
    bx(r.headers()["location"]).toMatch(/^https:\/\/auth\.internal\.invalid\/login\?/);
    // loop guard: with ?sso=1 we must NOT bounce again, we go to GitHub
    const g = await request.get(`${baseURL}/auth/login?sso=1`, { maxRedirects: 0 });
    bx(g.status()).toBe(302); bx(g.headers()["location"]).toMatch(/github\.com\/login\/oauth/);
    // an unsigned/forged sso cookie is not a session
    const f = await request.get(`${baseURL}/api/me`, { headers: { cookie: "sso=aaa.bbb.ccc" } });
    bx(f.status()).toBe(401);
    await page.goto("/");
    // either entry: legacy "Sign in" link/button, or (emailStep:true) the email step with its Continue button / Email input
    await bx(page.getByRole("link", { name: /sign in/i }).or(page.getByRole("button", { name: /sign in|continue/i })).or(page.getByTestId("login-email-step").getByRole("textbox", { name: /email/i })).first()).toBeVisible();
  });
});

test.describe("resilience", () => {
  // @desktop-only: WebKit cannot reload a page while the context is offline (engine limitation); the SW itself is covered by test/sw.test.ts
  test("offline shell: the installed app still opens with the network down and says why the list is empty @desktop-only", async ({ app: { page }, context }) => {
    await page.goto("/chats");
    await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload(); // second load is served under the SW's control
    await page.evaluate(async () => { for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100)); });
    await context.setOffline(true);
    try {
      await page.reload();
      // shell loads from the SW cache; with no network the app says so (not a login page, not an endless skeleton). Since c6f1634 (2026-10-28, offline identity cache) a
      // signed-in session keeps the app usable behind the offline pill; the full-page "offline" state is only for a visitor with no cached identity.
      await expect(page.getByTestId("offline-pill").or(page.getByTestId("offline")).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("offline-pill")).toBeVisible();
      await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0);
    } finally { await context.setOffline(false); }
    await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible({ timeout: 30_000 }); // control: back online, recovers by itself
  });

  test("deleted conversation: clear 'not found' screen with a way out, and the socket is never opened/retried", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    expect((await api.mut("DELETE", `/api/conversations/${id}`)).status()).toBe(200);
    let sockets = 0;
    page.on("websocket", () => sockets++);
    await page.goto(`/c/${id}`);
    await expect(page.getByRole("heading", { name: "Conversation not found" })).toBeVisible();
    await page.waitForTimeout(3000);
    expect(sockets, "a deleted conversation must not reconnect a socket in a loop").toBe(0);
    await page.getByTestId("back-to-list").click();
    await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
    // control: a live conversation does open its socket
    const live = await api.newChat(); await openChat(page, live);
    await expect.poll(() => sockets).toBeGreaterThan(0);
  });

  // Service workers are blocked here: in WebKit a SW-controlled page's fetches bypass page.route(), so the mocked run detail was
  // refreshed against the real API (404). With the SW out of the picture the route sees every request in both engines.
  test.describe("cloud run fault", () => {
  test.use({ serviceWorkers: "block" });
  test("cloud run: agent-spike 5xx on the event feed shows a message, then recovers by itself with no lost events", async ({ app: { page } }) => {
    const id = "f".repeat(16);
    const run = { id, kind: "task", repo: "o/r", base: null, branch: null, executor: "auto", title: "fault demo", status: "running", cost_usd: 0, created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00" };
    let down = true, hits = 0;
    await page.route(new RegExp(`/api/cloud/runs/${id}(\\?.*)?$`), (r) => r.fulfill({ json: { run, state: { status: "running" }, card: null } }));
    // A WebSocket that always drops right away (route-faking an upgrade behaves differently per engine): forces the polling fallback.
    await page.addInitScript(() => { (window as any).WebSocket = class { onclose: any; constructor() { setTimeout(() => this.onclose?.({ code: 1006 }), 0); } close() {} send() {} }; });
    await page.route(`**/api/cloud/runs/${id}/events*`, (r) => {
      hits++;
      if (down) return r.fulfill({ status: 503, json: { error: "agent-spike unavailable" } });
      return r.fulfill({ json: { events: [{ seq: 0, ts: 1, kind: "text", data: { text: "hello after outage" } }], next: 1 } });
    });
    await page.goto(`/r/${id}`);
    await expect(page.getByTestId("run-problem")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("run-state")).toHaveText("running"); // the screen itself did not die
    down = false;
    await expect(page.getByText("hello after outage")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("run-problem")).toBeHidden({ timeout: 15_000 });
    expect(hits).toBeGreaterThan(1);
  });
  });

  test("websocket drop (network blip): the chat reconnects and no messages are lost or duplicated", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    // The chat runs over the DO WebSocket; a dropped socket must resume, not lose the conversation.
    const before = await page.locator(".msg").count();
    await page.context().setOffline(true); await page.waitForTimeout(1500); await page.context().setOffline(false);
    await expect(page.locator(".dot.open")).toBeVisible({ timeout: 30_000 });
    expect(await page.locator(".msg").count()).toBe(before);
  });
});
