import { test, expect, openChat, type Api } from "./fixtures";

// Input features: voice dictation button (feature-detected), saved prompts (settings page -> "/" menu -> palette), camera "Add photo" (touch only).
// Needs the deploy of the `input` branch + migration 0019 on the remote D1. Delta-based and cleaned up by id: the e2e scope accumulates rows.

const slug = () => `e2e-pr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function dropPrompt(api: Api, title: string) {
  const l = ((await (await api.get("/api/prompts")).json()).prompts ?? []) as { id: string; title: string }[];
  for (const p of l.filter((x) => x.title === title)) await api.mut("DELETE", `/api/prompts/${p.id}`);
}
const FAKE_SR = `(() => { window.__srStarts = 0; window.SpeechRecognition = class { start() { window.__srStarts++; } stop() {} abort() {} }; })();`;
const NO_SR = `delete window.SpeechRecognition; delete window.webkitSpeechRecognition; delete window.MediaRecorder;`; // the mic shows when SpeechRecognition exists, or MediaRecorder with the Whisper toggle on

test.describe("voice dictation button", () => {
  test("hidden without SpeechRecognition and MediaRecorder", async ({ app: { page, api } }) => {
    await page.addInitScript(NO_SR);
    await openChat(page, await api.newChat());
    await expect(page.getByTestId("dictate")).toHaveCount(0);
  });
  test("visible with SpeechRecognition, and nothing is recorded until a tap", async ({ app: { page, api } }) => {
    await page.addInitScript("delete window.MediaRecorder;"); // browser dictation is the DEFAULT path now (Whisper only behind the Settings toggle, see voice.spec.ts / voice-native.spec.ts)
    await page.addInitScript(FAKE_SR);
    await openChat(page, await api.newChat());
    const mic = page.getByTestId("dictate");
    await expect(mic).toBeVisible();
    await expect(mic).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => (window as any).__srStarts)).toBe(0);
    await mic.click();
    await expect.poll(() => page.evaluate(() => (window as any).__srStarts), { timeout: 5000 }).toBe(1); // the first start() follows the ~300 ms settle
    await expect(mic).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("saved prompts", () => {
  test("create in Settings, pick from the / menu (placeholders resolved), find in the palette, edit, delete", async ({ app: { page, api } }) => {
    const title = slug();
    try {
      await page.goto("/settings/prompts");
      await expect(page.getByTestId("prompts-page")).toBeVisible();
      await page.getByTestId("prompt-add").click();
      const save = page.getByTestId("prompt-save");
      await expect(save).toBeDisabled();
      await page.getByTestId("prompt-title").fill(title);
      await page.getByTestId("prompt-text").fill("Today is {{date}}. Summarise.");
      await save.click();
      await expect(page.locator(`[data-testid="prompt-row"][data-title="${title}"]`)).toBeVisible();

      // slash menu: the Prompts group, picking inserts the resolved text and does not send
      const chat = await api.newChat();
      await openChat(page, chat);
      const box = page.getByPlaceholder("Message");
      await box.fill(`/${title.toLowerCase()}`);
      const row = page.locator('[data-testid="slash-popover"] [data-testid="slash-row"]').first();
      await expect(row).toBeVisible();
      await expect(page.locator('[data-testid="slash-group"]', { hasText: "Prompts" })).toBeVisible();
      await box.press("Enter");
      await expect(box).toHaveValue(/^Today is \d{4}-\d{2}-\d{2}\. Summarise\.$/);
      await expect(page.locator(".msg.user")).toHaveCount(0);

      // palette (desktop shortcut or drawer button): the prompt is listed and inserts into the open composer
      await box.fill("");
      await page.evaluate(() => dispatchEvent(new Event("vc:palette")));
      await page.getByTestId("palette-input").fill(title);
      const item = page.locator('[data-testid="palette-item"][data-kind="prompt"]').first();
      await expect(item).toBeVisible();
      await item.click();
      await expect(box).toHaveValue(/^Today is \d{4}-\d{2}-\d{2}\. Summarise\.$/);

      // edit then delete
      await page.goto("/settings/prompts");
      await page.locator(`[data-testid="prompt-row"][data-title="${title}"] [data-testid="prompt-edit"]`).click();
      await page.getByTestId("prompt-text").fill("Edited");
      await save.click();
      await expect(page.locator(`[data-testid="prompt-row"][data-title="${title}"]`)).toContainText("Edited");
      await page.locator(`[data-testid="prompt-row"][data-title="${title}"] [data-testid="prompt-delete"]`).click();
      await expect(page.locator(`[data-testid="prompt-row"][data-title="${title}"]`)).toHaveCount(0);
    } finally { await dropPrompt(api, title); }
  });
});

test.describe("camera photo", () => {
  test("Add photo is offered on touch devices only, and feeds a camera-capture image input", async ({ app: { page, api } }, testInfo) => {
    await openChat(page, await api.newChat());
    const touch = testInfo.project.name.startsWith("iphone-webkit");
    await page.getByTestId("composer-plus").click();
    await expect(page.getByTestId("ctx-camera")).toHaveCount(touch ? 1 : 0);
    await expect(page.getByTestId("ctx-photos")).toHaveCount(1);
    if (touch) await expect(page.locator('[data-testid="photo-input"]')).toHaveAttribute("capture", "environment");
  });
});
