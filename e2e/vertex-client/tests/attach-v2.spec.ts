// Attachments v2 (spec §2): text/code/CSV, Office, paste, drag-drop, oversize, preview. Written against the same helpers as files.spec.ts.
import { test, expect, ask, openChat, makePng, makeDocx, uniq } from "./fixtures";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test.describe("attachments v2", () => {
  test("attach a .csv and ask about its content", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const word = uniq("MANGO");
    const csv = "fruit,qty\napple,3\n" + `${word},99\n` + "pear,5\n";
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "stock.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await expect(page.locator(".attachbar .fchip")).toContainText("stock.csv", { timeout: 30_000 });
    await expect(page.locator(".attachbar .fchip .ftok")).toContainText("tok");
    const a = await ask(page, "In the attached CSV, which fruit has quantity 99? Answer with just the name.");
    expect(a.toUpperCase()).toContain(word);
    await expect(page.locator(".msg.user .fchip")).toContainText("stock.csv");
  });

  test("attach a .py file (octet-stream mime, extension fallback)", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const fn = uniq("fnx").toLowerCase();
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "tool.py", mimeType: "application/octet-stream", buffer: Buffer.from(`def ${fn}():\n    return 42\n`) });
    await expect(page.locator(".attachbar .fchip")).toContainText("tool.py", { timeout: 30_000 });
    const a = await ask(page, "What is the name of the function defined in the attached Python file? Answer with just the name.");
    expect(a.toLowerCase()).toContain(fn);
  });

  test("attach a .docx and ask about its content", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const word = uniq("OTTER");
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "memo.docx", mimeType: DOCX, buffer: makeDocx(`Team memo. The mascot is ${word}.`) });
    await expect(page.locator(".attachbar .fchip")).toContainText("memo.docx", { timeout: 30_000 });
    const a = await ask(page, "What is the mascot named in the attached memo? Answer with just the name.");
    expect(a.toUpperCase()).toContain(word);
  });

  test("tapping a chip opens a preview of the extracted text; Close dismisses it", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const word = uniq("HERON");
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(`preview me ${word}`) });
    await expect(page.locator(".attachbar .fchip")).toContainText("notes.txt", { timeout: 30_000 });
    await page.locator(".attachbar .fchip .fopen").click();
    await expect(page.getByTestId("file-preview")).toContainText(word);
    await page.getByTestId("file-preview").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("file-preview")).toHaveCount(0);
  });

  test("paste an image into the composer attaches it", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const png = (await makePng(page, "PASTED 5521")).toString("base64");
    await page.getByLabel("Message").evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, png);
    await expect(page.locator(".attachbar .fchip")).toContainText("image.png", { timeout: 30_000 });
  });

  test("drag-drop a file onto the composer attaches it", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await page.locator("footer.composer").evaluate((el) => {
      const dt = new DataTransfer(); dt.items.add(new File(["a,b\n1,2\n"], "dropped.csv", { type: "text/csv" }));
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".attachbar .fchip")).toContainText("dropped.csv", { timeout: 30_000 });
  });

  test("an oversized text file is rejected with a visible size message", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "huge.txt", mimeType: "text/plain", buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 97) });
    await expect(page.locator(".attachbar .error")).toContainText("2 MB", { timeout: 20_000 });
    await expect(page.locator(".attachbar .fchip")).toHaveCount(0);
  });

  test("a binary file disguised as .txt and an .mp3 are rejected", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "fake.txt", mimeType: "text/plain", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]) });
    await expect(page.locator(".attachbar .error")).toContainText("binary", { timeout: 20_000 });
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "song.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("ID3") });
    await expect(page.locator(".attachbar .error")).toContainText("audio", { timeout: 20_000 });
    await expect(page.locator(".attachbar .fchip")).toHaveCount(0);
  });
});
