import { test, expect, openChat, pickMode, type Api } from "./fixtures";
import type { Page } from "@playwright/test";

// Image generation (Image mode of the composer). The e2e user's image calls are served by a deterministic STUB provider inside the
// ChatSession DO (scope 'e2e'): no network, no $. Models offered to this user are `e2e-stub-image` ($0.045/img) and
// `e2e-stub-pro-image` ($0.40/img: 1-2 images stay under the $1.00 confirm line, 3 cross it). A prompt containing the word "blocked"
// yields a safety-filtered (no image) result. Written, not yet run by the author (runs on build-host after deploy).

const state = async (api: Api, id: string) => ((await (await api.get(`/api/conversations/${id}`)).json()) as any).state;
const genUsage = async (api: Api) => ((await (await api.get("/api/usage")).json()) as any).today.gen as Array<{ key: string; units: number; calls: number }>;
const KEY_STUB = "image · e2e-stub-image";
const KEY_PRO = "image · e2e-stub-pro-image";
const bar = (p: Page) => p.locator('[data-testid="image-bar"]');
const sendBtn = (p: Page) => p.getByRole("button", { name: "Send", exact: true });

async function imageMode(page: Page, model = "e2e-stub-image", n = 1) {
  await pickMode(page, "Image");
  await expect(bar(page).locator('[data-testid="img-model"]')).toBeVisible();
  await bar(page).locator('[data-testid="img-model"]').selectOption(model);
  await bar(page).locator('[data-testid="img-count"]').selectOption(String(n));
}
async function imageLoaded(page: Page, index = 0) {
  const img = page.locator('[data-testid="gen-image"] img').nth(index);
  await expect(img).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);
}

test.describe("image generation", () => {
  test("Image mode: model picker lists only image models, live estimate, chat sheet lists no image model", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await pickMode(page, "Image");
    const models = bar(page).locator('[data-testid="img-model"] option');
    await expect(models).toHaveCount(2);
    expect(await models.allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("E2E stub image")]));
    await expect(bar(page).locator('[data-testid="img-estimate"]')).toHaveText("≈ $0.045 · 1 image");
    await bar(page).locator('[data-testid="img-count"]').selectOption("3");
    await expect(bar(page).locator('[data-testid="img-estimate"]')).toHaveText("≈ $0.14 · 3 images");
    await bar(page).locator('[data-testid="img-model"]').selectOption("e2e-stub-pro-image");
    await expect(bar(page).locator('[data-testid="img-estimate"]')).toHaveText("≈ $1.20 · 3 images");
    await pickMode(page, "Chat");
    await expect(bar(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Choose model" }).click();
    const sheet = page.getByRole("dialog", { name: "Models" });
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toContainText("e2e-stub");
  });

  test("/image flow: image renders with its cost, survives reload, delete removes it", async ({ app: { page, api } }) => {
    const unitsBefore = (await genUsage(api)).find((u) => u.key === KEY_STUB)?.units ?? 0;
    const id = await api.newChat();
    await openChat(page, id);
    await imageMode(page);
    await page.getByPlaceholder("Describe the image…").fill("a red cube on a table");
    await sendBtn(page).click();
    await imageLoaded(page);
    await expect(page.locator('[data-testid="gen-cost"]').first()).not.toContainText("$");
    await expect(page.locator(".msg.user")).toContainText("a red cube on a table");
    await expect(page.locator('[data-testid="confirm-sheet"]')).toHaveCount(0); // under $1: no modal
    const src = await page.locator('[data-testid="gen-image"] img').first().getAttribute("src");
    expect(src).toMatch(new RegExp(`^/api/conversations/${id}/files/gen/[0-9a-f-]{36}\\.png$`));
    expect((await api.get(src!)).status()).toBe(200);

    await page.reload();
    await expect(page.getByPlaceholder("Message")).toBeVisible();
    await imageLoaded(page);
    await expect(page.locator('[data-testid="gen-cost"]').first()).not.toContainText("$");

    // usage is cumulative across tests/retries/projects: assert this flow's increment only
    const units = async () => (await genUsage(api)).find((u) => u.key === KEY_STUB)?.units ?? 0;
    expect(await units()).toBe(unitsBefore + 1);

    expect((await api.mut("DELETE", `/api/conversations/${id}`)).status()).toBe(200);
    expect((await api.get(src!)).status()).toBe(404); // the R2 object itself is asserted in test-cf/gen.test.ts (head() is null)
  });

  test("a filtered result is a normal assistant message, not an error", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await imageMode(page);
    await page.getByPlaceholder("Describe the image…").fill("a blocked scene");
    await sendBtn(page).click();
    await expect(page.locator(".msg.assistant .md").last()).toContainText("No image was generated (SAFETY)", { timeout: 30_000 });
    await expect(page.locator('[data-testid="gen-image"]')).toHaveCount(0);
    await expect(page.locator(".msg.err")).toHaveCount(0);
  });

  test("estimate > $1: modal with the estimate; Cancel leaves no message, no usage row, no provider call", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    await openChat(page, id);
    const before = (await genUsage(api)).reduce((a, u) => a + u.calls, 0);
    await imageMode(page, "e2e-stub-pro-image", 3);
    await page.getByPlaceholder("Describe the image…").fill("three pro cubes");
    await sendBtn(page).click();
    const modal = page.locator('[data-testid="confirm-sheet"]');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("$1.20");
    await expect(modal).toContainText("3 images");
    await page.locator('[data-testid="confirm-cancel"]').click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByPlaceholder("Describe the image…")).toHaveValue("three pro cubes"); // the draft is kept
    await page.waitForTimeout(1500);
    expect((await state(api, id)).messages).toEqual([]);                       // nothing sent
    expect((await genUsage(api)).reduce((a, u) => a + u.calls, 0)).toBe(before); // every provider call records a usage row: none happened
    await expect(page.locator('[data-testid="gen-image"]')).toHaveCount(0);
  });

  test("estimate > $1: Generate runs it; 3 images appear; Usage shows the Generation row", async ({ app: { page, api } }) => {
    const proBefore = (await genUsage(api)).find((u) => u.key === KEY_PRO)?.units ?? 0;
    await openChat(page, await api.newChat());
    await imageMode(page, "e2e-stub-pro-image", 3);
    await page.getByPlaceholder("Describe the image…").fill("three pro cubes");
    await sendBtn(page).click();
    await page.locator('[data-testid="confirm-ok"]').click();
    await expect(page.locator('[data-testid="gen-image"]')).toHaveCount(3, { timeout: 30_000 });
    await imageLoaded(page, 2);
    expect((await genUsage(api)).find((u) => u.key === KEY_PRO)?.units ?? 0).toBe(proBefore + 3); // cumulative: delta only
    await page.goto("/usage");
    await expect(page.locator('[data-testid="usage-generation"]').first()).toContainText(KEY_PRO);
  });

  test("under $1 (1 pro image = $0.40) needs no modal", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await imageMode(page, "e2e-stub-pro-image", 1);
    await expect(bar(page).locator('[data-testid="img-estimate"]')).toHaveText("≈ $0.40 · 1 image");
    await page.getByPlaceholder("Describe the image…").fill("one pro cube");
    await sendBtn(page).click();
    await expect(page.locator('[data-testid="confirm-sheet"]')).toHaveCount(0);
    await imageLoaded(page);
  });

  test("an attached image becomes a reference image (chip on the prompt, generation still works)", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await imageMode(page);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP438PwH4QZYAwAXJIKKXIKGZIAAAAASUVORK5CYII=", "base64");
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "ref.png", mimeType: "image/png", buffer: png });
    await expect(page.locator(".attachbar .fchip")).toContainText("ref.png", { timeout: 30_000 });
    await page.getByPlaceholder("Describe the image…").fill("same cube, but blue");
    await sendBtn(page).click();
    await expect(page.locator(".msg.user .fchip")).toContainText("ref.png");
    await imageLoaded(page);
  });
});
