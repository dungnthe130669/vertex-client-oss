import { test, expect, openChat, ask, headerAction } from "./fixtures";

// Every screen must load without a single CSP violation or console error (a refused stylesheet was seen in the first E2E run).
test.describe("csp / console hygiene", () => {
  test("no CSP violations or console errors across the main screens", async ({ app: { page, api } }) => {
    const bad: string[] = [];
    await page.addInitScript(() => {
      (window as any).__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => (window as any).__csp.push(`${e.violatedDirective} blocked=${e.blockedURI} src=${e.sourceFile}:${e.lineNumber}`));
    });
    page.on("console", (m) => { if ((m.type() === "error" && !/Failed to load resource/.test(m.text())) || /content security policy|refused/i.test(m.text())) bad.push(`console.${m.type()}: ${m.text().slice(0, 300)}`); });
    page.on("response", (r) => { if (r.status() >= 400 && !/\/api\/(push\/config|devices)$/.test(r.url())) bad.push(`http ${r.status()} ${r.url()}`); });
    page.on("pageerror", (e) => bad.push(`pageerror: ${e.message.slice(0, 300)}`));
    const collect = async () => bad.push(...((await page.evaluate(() => (window as any).__csp ?? []).catch(() => [])) as string[]).map((s) => `csp: ${s}`));
    await page.goto("/"); await expect(page.getByTestId("greeting")).toBeVisible(); await collect(); // start screen
    await page.goto("/chats"); await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible(); await collect();
    await openChat(page, await api.newChat());
    await ask(page, "Reply with a markdown table of two rows and a code block, nothing else.");
    await collect();
    await page.goto("/usage"); await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible(); await collect();
    // search + refresh: run a search, then reload the page mid-state (the exploratory agent hit a CSP complaint around here once; not reproduced since)
    await page.goto("/chats"); await page.getByPlaceholder("Search chats").fill("pong"); await page.waitForTimeout(800); await collect();
    await page.reload(); await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible(); await collect();
    await page.goto("/"); await headerAction(page, "Settings"); await expect(page.locator("ul.models li").first()).toBeVisible(); await collect();
    expect(bad, bad.join("\n")).toEqual([]);
  });
});
