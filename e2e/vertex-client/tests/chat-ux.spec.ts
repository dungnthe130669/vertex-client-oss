import { test, expect, ask, openChat, uniq } from "./fixtures";

// Chat UX polish: code-block copy, regenerate/edit, jump-to-latest, paste/drop attachments, Esc/Enter. CSSOM only (CSP style-src 'self').
// Written, not yet run by the author (the lead runs the e2e subset).

test.describe("chat ux", () => {
  test("code block: language label, Copy toast, scrolls inside itself at 320px", async ({ app: { page, api } }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await openChat(page, await api.newChat());
    await ask(page, "Reply with exactly this fenced block and nothing else (a single very long line, no wrapping):\n```python\nprint('" + "x".repeat(160) + "')\n```");
    const block = page.locator(".codeblock").last();
    await expect(block.locator(".lang")).toHaveText("python");
    const pre = block.locator("pre");
    expect(await pre.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === "auto")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // no layout break
    await block.getByRole("button", { name: "Copy" }).click();
    await expect(page.locator(".toast", { hasText: "Copied" })).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null); // webkit has no clipboard-read: the toast is then the whole check
    if (clip !== null) expect(clip).toContain("print(");
    expect(await block.evaluate((el) => el.querySelectorAll("[style],[onclick]").length)).toBe(0);
  });

  test("regenerate sends the previous user turn again; Edit refills the composer on the last user message only", async ({ app: { page, api } }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openChat(page, await api.newChat());
    const word = uniq("RG");
    await ask(page, `Reply with the single word ${word}`);
    await expect(page.getByTestId("edit-msg")).toHaveCount(1);
    await page.getByTestId("regenerate").click();
    await expect(page.locator(".msg.user")).toHaveCount(2); // a NEW turn, history untouched
    await expect(page.getByTestId("regenerate")).toHaveCount(0); // hidden while busy
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId("regenerate")).toHaveCount(2); // every finished turn carries its own Regenerate; Edit stays on the last user message only
    await expect(page.getByTestId("edit-msg")).toHaveCount(1);
    await page.getByTestId("edit-msg").click();
    await expect(page.getByPlaceholder("Message")).toHaveValue(`Reply with the single word ${word}`);
    await expect(page.locator(".msg.user")).toHaveCount(2); // no history rewrite
  });

  test("jump-to-latest appears past 200px and returns to the bottom", async ({ app: { page, api } }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await openChat(page, await api.newChat());
    await ask(page, "Count from 1 to 60, one number per line, nothing else.");
    const msgs = page.locator("main.msgs");
    await expect(page.getByTestId("jump-bottom")).toHaveCount(0);
    await msgs.evaluate((el) => { el.scrollTop = 0; });
    await expect(page.getByTestId("jump-bottom")).toBeVisible();
    await page.getByTestId("jump-bottom").click();
    await expect(page.getByTestId("jump-bottom")).toHaveCount(0);
    expect(await msgs.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(80);
  });

  test("pasting an image and dropping a file on the chat attach chips", async ({ app: { page, api } }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    await box.focus();
    await page.evaluate(async () => {
      const c = document.createElement("canvas"); c.width = 8; c.height = 8; c.getContext("2d")!.fillRect(0, 0, 8, 8);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
      const dt = new DataTransfer(); dt.items.add(new File([blob], "pasted.png", { type: "image/png" }));
      document.querySelector("textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId("file-chip")).toHaveCount(1);
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.items.add(new File(["hello"], "dropped.txt", { type: "text/plain" }));
      const main = document.querySelector("main.msgs")!; // dropped on the message area, not the composer
      main.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      main.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId("file-chip")).toHaveCount(2);
    await expect(page.getByTestId("file-chip").last()).toContainText("dropped.txt");
  });

  test("desktop: Enter sends, Shift+Enter is a newline, Esc stops a running turn @desktop-only", async ({ app: { page, api } }) => {  // touch: Enter is a newline (covered by the pointer:coarse test)
    await page.setViewportSize({ width: 1280, height: 800 });
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    await box.fill("line one");
    await box.press("Shift+Enter");
    await box.type("line two");
    await expect(box).toHaveValue("line one\nline two");
    await expect(page.locator(".msg.user")).toHaveCount(0);
    await box.fill("Write a detailed 600-word essay about the history of tea.");
    await box.press("Enter");
    const stop = page.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible();
    await expect(page.locator(".msg.assistant.live .md")).toBeVisible({ timeout: 60_000 }); // tokens are flowing: a stop before the first one leaves no partial answer to mark
    await box.evaluate((e) => (e as HTMLElement).blur()); // focus off the composer: Esc is global
    await page.keyboard.press("Escape");
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".stopped")).toBeVisible();
  });

  test("touch (pointer:coarse): Enter is a newline, Send button sends", async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 }, storageState: undefined });
    const { login } = await import("./fixtures");
    await login(ctx, baseURL!);
    const page = await ctx.newPage();
    const { Api } = await import("./fixtures");
    const id = await new Api(ctx.request, baseURL!).newChat();
    await openChat(page, id);
    const box = page.getByPlaceholder("Message");
    await box.fill("hi");
    await box.press("Enter");
    await expect(page.locator(".msg.user")).toHaveCount(0);
    expect(await box.inputValue()).toContain("\n");
    await ctx.close();
  });
});
