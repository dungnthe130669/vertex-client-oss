import { test, expect, openChat, pickMode, typeMessage, clickSend, waitSettled } from "./fixtures";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Library (generated media grid + preview), chat Export (Markdown/JSON, client-side) and in-chat search. Image generation is served by the
// deterministic e2e STUB provider (no network, no $). Delta-based: the e2e scope accumulates media across runs, so assertions look at the
// newest tile / the conversation this test created, and cleanup is by conversation id. Written, not run by the author (e2e runs on build-host).

async function say(page: Page, text: string) {
  const chips = await page.locator('[data-testid="msg-cost"]').count();
  await typeMessage(page, text); await clickSend(page);
  await waitSettled(page, chips);
}

test.describe("library", () => {
  test("generated image shows in the grid, preview downloads and opens its chat", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    try {
      await openChat(page, id);
      await pickMode(page, "Image");
      await page.getByPlaceholder("Describe the image…").fill("a blue sphere");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const img = page.locator('[data-testid="gen-image"] img').first();
      await expect(img).toBeVisible({ timeout: 30_000 });

      await page.goto("/library");
      await expect(page.locator('[data-testid="library-screen"]')).toBeVisible();
      const tiles = page.locator('[data-testid="library-tile"]');
      await expect(tiles.first()).toBeVisible();
      // no layout shift: every tile has its final square box before its thumbnail has loaded
      const box = await tiles.first().boundingBox();
      expect(Math.abs(box!.width - box!.height)).toBeLessThan(1.5);
      expect(await tiles.count()).toBeLessThanOrEqual(60);
      await expect(page.locator('[data-testid="library-tile"] img').first()).toHaveAttribute("loading", "lazy");

      await page.locator('[data-testid="lib-filter-video"]').click();
      await expect(page.locator('[data-testid="library-tile"][data-type="image"]')).toHaveCount(0);
      await page.locator('[data-testid="lib-filter-image"]').click();
      await expect(tiles.first()).toBeVisible();

      await tiles.first().click();
      const prev = page.locator('[data-testid="library-preview"]');
      await expect(prev).toBeVisible();
      await expect(prev.locator("img")).toBeVisible();
      const [dl] = await Promise.all([page.waitForEvent("download"), prev.locator('[data-testid="library-download"]').click()]);
      expect(dl.suggestedFilename()).toMatch(/\.png$/);
      await prev.locator('[data-testid="library-open-chat"]').click();
      await expect(page).toHaveURL(new RegExp(`/c/${id}$`));
    } finally { await api.mut("DELETE", `/api/conversations/${id}`); }
  });

  test("API: scope-isolated list; bad type / cursor are 400", async ({ app: { api } }) => {
    const r = await api.get("/api/library");
    expect(r.status()).toBe(200);
    const body = (await r.json()) as { items: Array<{ conv: string }>; next: string | null };
    const mine = new Set((await api.conversations()).map((c) => c.id));
    for (const it of body.items) expect(mine.has(it.conv)).toBe(true); // nothing from a conversation outside this scope
    expect((await api.get("/api/library?type=audio")).status()).toBe(400);
    expect((await api.get("/api/library?before=nope")).status()).toBe(400);
  });
});

test.describe("export", () => {
  test("chat menu exports Markdown and JSON of the visible conversation", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    try {
      await openChat(page, id);
      await say(page, "Reply with exactly the word: pineapple");
      for (const [tid, ext] of [["export-md", "md"], ["export-json", "json"]] as const) {
        await page.getByTestId("chat-header-menu").click(); await page.getByTestId("chat-menu-export").click();
        const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-testid="${tid}"]`).click()]);
        expect(dl.suggestedFilename()).toMatch(new RegExp(`\\.${ext}$`));
        const text = readFileSync((await dl.path())!, "utf8");
        expect(text).toContain("pineapple");
        expect(text).not.toContain("vertex-client/");
        expect(text).not.toContain(id);
        if (ext === "json") expect(JSON.parse(text).messages.length).toBeGreaterThanOrEqual(2);
        else expect(text).toContain("## You");
      }
    } finally { await api.mut("DELETE", `/api/conversations/${id}`); }
  });
});

test.describe("in-chat search", () => {
  test("magnifier opens the bar, counts, next/prev, Esc closes, markdown untouched", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    try {
      await openChat(page, id);
      await say(page, "Reply with exactly: **zebra** and zebra");
      const mdBefore = await page.locator(".msg .md").first().innerHTML();
      await page.locator('[data-testid="header-find"]').click();
      const find = page.locator('[data-testid="chat-find"]');
      await expect(find).toBeVisible();
      await page.locator('[data-testid="find-input"]').fill("zebra");
      await expect(page.locator('[data-testid="find-count"]')).toHaveText(/^1\/[2-9]\d*$/); // the question and the reply both contain it
      await page.locator('[data-testid="find-next"]').click();
      await expect(page.locator('[data-testid="find-count"]')).toHaveText(/^2\//);
      await page.locator('[data-testid="find-prev"]').click();
      await expect(page.locator('[data-testid="find-count"]')).toHaveText(/^1\//);
      await page.locator('[data-testid="find-input"]').fill("qqqq-nothing");
      await expect(page.locator('[data-testid="find-count"]')).toHaveText("No matches");
      expect(await page.locator(".msg .md").first().innerHTML()).toBe(mdBefore); // highlighting never rewrites the rendered markdown
      await page.locator('[data-testid="find-input"]').press("Escape");
      await expect(find).toHaveCount(0);
    } finally { await api.mut("DELETE", `/api/conversations/${id}`); }
  });

  test("Ctrl/Cmd+F in the chat opens it, not the browser's find @desktop-only", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    try {
      await openChat(page, id);
      await say(page, "Reply with exactly: kiwi");
      await page.locator(".msgs").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
      await expect(page.locator('[data-testid="find-input"]')).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-testid="chat-find"]')).toHaveCount(0);
    } finally { await api.mut("DELETE", `/api/conversations/${id}`); }
  });
});
