import { test, expect, openChat, pickMode, type Api } from "./fixtures";
import type { Page } from "@playwright/test";

// Video generation (Video mode of the composer). The e2e user's video calls are served by a deterministic STUB provider inside the
// ChatSession DO (scope 'e2e'): no network, no $. Models: `e2e-stub-video` ($0.035/s at 360p) and `e2e-stub-pro-video` ($0.15/s: 3-5 s stay
// under the $1.00 confirm line, 8 s = $1.20 crosses it). The clip is always the same 2 s VP9 MP4 fixture; the reported seconds/cost follow
// the request. Prompt words: "slow" holds the call ~6 s (running card, reload mid-call, stop), "blocked" = safety refusal, "timeout" =
// the gateway's 504. Push ("Video ready") is never sent for the e2e scope by design, so it is covered by unit tests only.
// Written, not yet run by the author (runs on build-host after deploy).

const state = async (api: Api, id: string) => ((await (await api.get(`/api/conversations/${id}`)).json()) as any).state;
const genUsage = async (api: Api) => ((await (await api.get("/api/usage")).json()) as any).today.gen as Array<{ key: string; units: number; calls: number }>;
const KEY_STUB = "video · e2e-stub-video";
const bar = (p: Page) => p.locator('[data-testid="video-bar"]');
const sendBtn = (p: Page) => p.getByRole("button", { name: "Send", exact: true });
const prompt = (p: Page) => p.getByPlaceholder("Describe the video…");

async function videoMode(page: Page, model = "e2e-stub-video", seconds = 3) {
  await pickMode(page, "Video");
  await expect(bar(page).locator('[data-testid="vid-model"]')).toBeVisible();
  await bar(page).locator('[data-testid="vid-model"]').selectOption(model);
  await bar(page).locator('[data-testid="vid-duration"]').selectOption(String(seconds));
}
async function videoLoaded(page: Page, index = 0) {
  const v = page.locator('[data-testid="gen-video"] video').nth(index);
  await expect(v).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => v.evaluate((e: HTMLVideoElement) => e.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1); // HAVE_METADATA
}

test.describe("video generation", () => {
  test("Video mode: controls from /api/gen/models?kind=video, live estimate, chat sheet lists no video model", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await pickMode(page, "Video");
    const models = bar(page).locator('[data-testid="vid-model"] option');
    await expect(models).toHaveCount(2);
    expect(await models.allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("E2E stub video")]));
    expect(await bar(page).locator('[data-testid="vid-duration"] option').allTextContents()).toEqual(["3 s", "5 s", "8 s", "10 s"]);
    expect(await bar(page).locator('[data-testid="vid-resolution"] option').allTextContents()).toEqual(["360p", "720p"]);
    await expect(bar(page).locator('[data-testid="vid-estimate"]')).toHaveText("≈ $0.10 · 3 s video");
    await bar(page).locator('[data-testid="vid-duration"]').selectOption("10");
    await expect(bar(page).locator('[data-testid="vid-estimate"]')).toHaveText("≈ $0.35 · 10 s video");
    await bar(page).locator('[data-testid="vid-model"]').selectOption("e2e-stub-pro-video");
    await expect(bar(page).locator('[data-testid="vid-estimate"]')).toHaveText("≈ $1.50 · 10 s video");
    await page.getByTestId("composer-plus").click();
    await expect(page.getByTestId("ctx-files")).toBeDisabled();
    // no reference media in video v1. Esc is wired by a passive effect after the sheet renders: on a slow runner a too-early press is lost and the scrim then blocks the next click (ossci1j, public CI). Re-press until the sheet is really closed.
    await expect(async () => { await page.keyboard.press("Escape"); await expect(page.getByTestId("ctx-scrim")).toHaveCount(0, { timeout: 1000 }); }).toPass({ timeout: 10_000 });
    await pickMode(page, "Chat");
    await expect(bar(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Choose model" }).click();
    const sheet = page.getByRole("dialog", { name: "Models" });
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toContainText("e2e-stub");
    await expect(sheet).not.toContainText("omni");
  });

  test("/video in the slash menu switches to Video mode", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message…");
    await box.fill("/vid");
    await expect(page.locator('[data-testid="slash-row"][data-name="video"]')).toBeVisible();
    await box.press("Enter");
    await expect(bar(page)).toBeVisible();
    await expect(prompt(page)).toHaveValue("");
    await expect(page.getByTestId("mode-active")).toContainText("Video");
  });

  test("start -> running card with elapsed timer -> survives reload -> <video> playable -> usage delta -> delete removes the R2 object", async ({ app: { page, api } }) => {
    const unitsBefore = (await genUsage(api)).find((u) => u.key === KEY_STUB)?.units ?? 0;
    const id = await api.newChat();
    await openChat(page, id);
    await videoMode(page, "e2e-stub-video", 5);
    await prompt(page).fill("a slow cat walking on a beach");
    await sendBtn(page).click();
    await expect(page.locator('[data-testid="confirm-sheet"]')).toHaveCount(0); // $0.175: no modal
    const card = page.locator('[data-testid="gen-running"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText("Generating video");
    await expect(page.locator('[data-testid="gen-elapsed"]')).toHaveText(/^0:0[1-9]$/, { timeout: 5_000 });
    expect((await state(api, id))).toMatchObject({ running: true, generating: true, genKind: "video" });

    await page.reload(); // mid-call: the card comes back from /state (turn-engine replay), timer keeps counting from the server start
    await expect(page.locator('[data-testid="gen-running"]')).toBeVisible();
    await videoLoaded(page);
    await expect(page.locator('[data-testid="gen-running"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gen-video"] [data-testid="gen-cost"]')).not.toContainText("$"); // no per-item cost (usage1)
    await expect(page.locator('[data-testid="gen-video"] figcaption')).toContainText("5 s");
    await expect(page.locator(".msg.user")).toContainText("a slow cat walking on a beach");

    const v = page.locator('[data-testid="gen-video"] video').first();
    expect(await v.getAttribute("preload")).toBe("metadata");
    expect(await v.evaluate((e: HTMLVideoElement) => e.controls && e.playsInline)).toBe(true);
    const src = await v.getAttribute("src");
    expect(src).toMatch(new RegExp(`^/api/conversations/${id}/files/gen/[0-9a-f-]{36}\\.mp4$`));
    const probe = await page.request.get(src!, { headers: { range: "bytes=0-1" } }); // the iOS Safari probe; same cookies as the page
    expect(probe.status()).toBe(206);
    expect(probe.headers()["content-range"]).toMatch(/^bytes 0-1\/\d+$/);
    expect(probe.headers()["content-type"]).toBe("video/mp4");
    await expect(page.locator('[data-testid="gen-video-download"]')).toHaveAttribute("href", src!);

    await page.reload();
    await videoLoaded(page);

    // usage is cumulative across tests/retries/projects: assert this flow's increment only (units = seconds)
    expect((await genUsage(api)).find((u) => u.key === KEY_STUB)?.units ?? 0).toBe(unitsBefore + 5);
    await page.goto("/usage");
    await expect(page.locator('[data-testid="usage-generation"]').first()).toContainText(KEY_STUB);
    await expect(page.locator('[data-testid="usage-generation"]').first()).toContainText("s of video");

    expect((await api.mut("DELETE", `/api/conversations/${id}`)).status()).toBe(200);
    expect((await api.get(src!)).status()).toBe(404); // the R2 object itself is asserted in test-cf/video.test.ts (head() is null)
  });

  test("estimate > $1 (pro, 8 s = $1.20): modal; Cancel sends nothing; Generate runs it", async ({ app: { page, api } }) => {
    const id = await api.newChat();
    await openChat(page, id);
    const before = (await genUsage(api)).reduce((a, u) => a + u.calls, 0);
    await videoMode(page, "e2e-stub-pro-video", 8);
    await prompt(page).fill("eight pro seconds");
    await sendBtn(page).click();
    const modal = page.locator('[data-testid="confirm-sheet"]');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("$1.20");
    await expect(modal).toContainText("8 s video");
    await page.locator('[data-testid="confirm-cancel"]').click();
    await expect(modal).toHaveCount(0);
    await expect(prompt(page)).toHaveValue("eight pro seconds");
    await page.waitForTimeout(1500);
    expect((await state(api, id)).messages).toEqual([]);
    expect((await genUsage(api)).reduce((a, u) => a + u.calls, 0)).toBe(before);
    await sendBtn(page).click();
    await page.locator('[data-testid="confirm-ok"]').click();
    await videoLoaded(page);
  });

  test("stop mid-call: interrupted with the 'may still be billed' note, no video", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await videoMode(page);
    await prompt(page).fill("a slow dog");
    await sendBtn(page).click();
    await expect(page.locator('[data-testid="gen-running"]')).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator(".msg.assistant").last()).toContainText("may still be billed", { timeout: 15_000 });
    await expect(page.locator('[data-testid="gen-video"]')).toHaveCount(0);
  });

  test("a refusal is a normal message; a gateway timeout is an error card with 'billing uncertain' and no Retry", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    await videoMode(page);
    await prompt(page).fill("a blocked scene");
    await sendBtn(page).click();
    await expect(page.locator(".msg.assistant .md").last()).toContainText("declined to generate this video", { timeout: 30_000 });
    await expect(page.locator(".msg.err")).toHaveCount(0);
    await prompt(page).fill("timeout please");
    await sendBtn(page).click();
    const err = page.locator(".msg.err");
    await expect(err).toContainText("timed out", { timeout: 30_000 });
    await expect(err).toContainText("Billing uncertain");
    await expect(err.getByRole("button", { name: "Retry" })).toHaveCount(0); // a retry could bill twice
  });
});
