import { test, expect, ask, openChat, makePng, makePdf, uniq } from "./fixtures";

test.describe("attachments", () => {
  test("image upload + question", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const code = "PINEAPPLE 7421";
    const png = await makePng(page, code);
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "code.png", mimeType: "image/png", buffer: png });
    await expect(page.locator(".attachbar .fchip")).toContainText("code.png", { timeout: 30_000 });
    await expect(page.getByText("Uploading…")).toHaveCount(0);
    const a = await ask(page, "What text is written in the attached image? Answer with just that text.");
    await expect(page.locator(".msg.user .fchip")).toContainText("code.png");
    expect(a.toUpperCase().replace(/\s+/g, "")).toContain("PINEAPPLE7421");
  });

  test("PDF upload + question", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const word = uniq("ZEBRA");
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: makePdf(`Fruit report. The mascot of this report is ${word}`) });
    await expect(page.locator(".attachbar .fchip")).toContainText("report.pdf", { timeout: 30_000 });
    const a = await ask(page, "What is the mascot named in the attached PDF? Answer with just the name.");
    expect(a.toUpperCase()).toContain(word);
  });

  test("an unsupported file type is rejected with a visible message", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "x.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await expect(page.locator(".attachbar .error")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".attachbar .fchip")).toHaveCount(0);
  });
});
