import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApp } from "./polish-mock";

// Composer redesign (mobile first): "+" sheet, model pill, mic, send in ONE row that never overlaps; mode chip; starters hide with the keyboard.
// Everything runs on the in-browser API mock (no login, no cost). CSSOM only (CSP style-src 'self').

const FAKE_SR = `(() => { window.SpeechRecognition = class { start() {} stop() {} abort() {} }; })();`;
const LONG = "Claude Super Extended Reasoning Model With A Ridiculously Long Display Name 5.5";

async function open(page: Page, o: { longModel?: boolean } = {}) {
  await page.addInitScript(FAKE_SR);
  await mockApp(page);
  if (o.longModel) {
    await page.route(/\/api\/models$/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ default: "claude-sonnet-5-5", models: [{ id: "claude-sonnet-5-5", name: LONG, meta: { label: LONG, vendor: "Anthropic", tier: "balanced", price: { input: 3, output: 15 }, caps: { images: true, caching: true, thinking: true, tools: true } } }] }) }));
  }
  await page.goto("/"); await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("composer-plus")).toBeVisible();
}
type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page, sel: string): Promise<Box> => (await page.locator(sel).first().boundingBox())!;
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

test.use({ serviceWorkers: "block" });

test.describe("composer bottom row (mocked app)", () => {
  for (const width of [320, 390, 430]) {
    for (const longModel of [false, true]) {
      test(`${width}px${longModel ? ", very long model name" : ""}: plus, model pill, mic, send sit on one line, no overlap, nothing overflows`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await open(page, { longModel });
        const sels = ['[data-testid="composer-plus"]', '[data-testid="model-pill"]', '[data-testid="dictate"]', 'button[aria-label="Send"]'];
        const boxes = [] as Box[];
        for (const s of sels) { await expect(page.locator(s)).toBeVisible(); boxes.push(await box(page, s)); }
        const comp = await box(page, "footer.composer");
        for (let i = 0; i < boxes.length; i++) {
          expect(boxes[i].x, `${sels[i]} left edge`).toBeGreaterThanOrEqual(comp.x - 0.5);
          expect(boxes[i].x + boxes[i].width, `${sels[i]} right edge`).toBeLessThanOrEqual(comp.x + comp.width + 0.5);
          expect(boxes[i].width, `${sels[i]} 44px target`).toBeGreaterThanOrEqual(43.5);
          expect(boxes[i].height, `${sels[i]} 44px target`).toBeGreaterThanOrEqual(43.5);
          for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${sels[i]} overlaps ${sels[j]}`).toBe(false);
        }
        const ys = boxes.map((b) => b.y + b.height / 2);
        expect(Math.max(...ys) - Math.min(...ys), "one line").toBeLessThan(6);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal page overflow").toBe(true);
        if (longModel) {
          const pill = page.getByTestId("model-pill").locator(".pill-l");
          expect(await pill.evaluate((e) => e.scrollWidth > e.clientWidth), "model name is ellipsized").toBe(true);
          expect(await pill.evaluate((e) => getComputedStyle(e).textOverflow)).toBe("ellipsis");
        }
      });
    }
  }

  test("textarea grows to about six lines, then scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    const ta = page.getByPlaceholder("Message…");
    const h0 = (await ta.boundingBox())!.height;
    await ta.fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
    const h1 = (await ta.boundingBox())!.height;
    expect(h1).toBeGreaterThan(h0 + 50);
    expect(h1).toBeLessThanOrEqual(24 * 6 + 20);
    expect(await ta.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  });
});

test.describe("+ sheet (mocked app)", () => {
  test("opens and closes with Esc / backdrop, focus is inside, Tab is trapped, focus returns to +", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    const plus = page.getByTestId("composer-plus");
    await plus.click();
    const sheet = page.getByRole("dialog", { name: "Add context" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(":focus")).toHaveCount(1);
    for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); expect(await sheet.locator(":focus").count(), `Tab #${i + 1} left the dialog`).toBe(1); }
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(plus).toBeFocused();
    await plus.click(); await expect(sheet).toBeVisible();
    await page.getByTestId("ctx-scrim").click({ position: { x: 5, y: 5 } });
    await expect(sheet).toHaveCount(0);
  });

  test("Photos and Files tiles open the file picker; Camera too on touch devices", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    for (const t of ["ctx-photos", "ctx-files", ...(testInfo.project.name.startsWith("iphone-webkit") ? ["ctx-camera"] : [])]) {
      await page.getByTestId("composer-plus").click();
      const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId(t).click()]);
      expect(fc, t).toBeTruthy();
      await expect(page.getByRole("dialog", { name: "Add context" })).toHaveCount(0);
    }
    if (!testInfo.project.name.startsWith("iphone-webkit")) { await page.getByTestId("composer-plus").click(); await expect(page.getByTestId("ctx-camera")).toHaveCount(0); }
  });

  test("Saved prompts tile opens the / list", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    await page.getByTestId("composer-plus").click();
    await page.getByTestId("ctx-prompts").click();
    await expect(page.getByPlaceholder("Message…")).toHaveValue("/");
  });

  test("Mode: Image shows a removable chip above the textarea; removing returns to Chat (and the model pill)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    await expect(page.getByTestId("mode-active")).toHaveCount(0);
    await expect(page.getByTestId("ctx-mode")).toHaveCount(0);
    await page.getByTestId("composer-plus").click();
    await expect(page.getByTestId("ctx-mode")).toContainText("Chat");
    await page.getByTestId("ctx-mode").click();
    await page.getByTestId("mode-chip").getByRole("button", { name: "Image", exact: true }).click();
    const chip = page.getByTestId("mode-active");
    await expect(chip).toContainText("Image");
    expect((await chip.boundingBox())!.y).toBeLessThan((await box(page, "footer.composer textarea")).y);
    await expect(page.getByTestId("model-pill")).toHaveCount(0);
    await page.getByTestId("composer-plus").click();
    await expect(page.getByTestId("ctx-mode")).toContainText("Image");
    // Esc is wired by a passive effect after the sheet renders: under load a too-early press is lost and the scrim then covers mode-clear. Re-press until the sheet is really closed (closing stays asserted).
    await expect(async () => { await page.keyboard.press("Escape"); await expect(page.getByTestId("ctx-scrim")).toHaveCount(0, { timeout: 1000 }); }).toPass({ timeout: 10_000 });
    await page.getByTestId("mode-clear").click();
    await expect(chip).toHaveCount(0);
    await expect(page.getByTestId("model-pill")).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe (${scheme}): composer, + sheet with mode list and mode chip have no serious/critical violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 800 });
      await open(page);
      const scan = async (what: string) => {
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`), what).toEqual([]);
      };
      await scan("composer");
      await page.getByTestId("composer-plus").click(); await page.getByTestId("ctx-mode").click();
      await page.waitForTimeout(400); await scan("+ sheet");
      await page.getByTestId("mode-chip").getByRole("button", { name: "Video", exact: true }).click();
      await page.waitForTimeout(200); await scan("mode chip");
    });
  }

  test("model pill opens the model picker", async ({ page }) => {
    await open(page);
    await page.getByTestId("model-pill").click();
    await expect(page.getByRole("dialog", { name: "Models" })).toBeVisible();
  });
});

test.describe("starters + desktop (mocked app)", () => {
  test("starters are a compact grid, and hide while the keyboard is up; greeting stays", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    const cards = page.getByTestId("starter");
    await expect(cards).toHaveCount(4);
    const b = [] as Box[]; for (let i = 0; i < 4; i++) b.push((await cards.nth(i).boundingBox())!);
    expect(Math.abs(b[0].y - b[1].y), "2 columns").toBeLessThan(2); expect(b[2].y).toBeGreaterThan(b[0].y + 20);
    expect(b[0].height).toBeLessThan(90);
    await page.evaluate(() => document.documentElement.classList.add("kb"));
    await expect(page.getByTestId("starters")).toBeHidden();
    await expect(page.getByTestId("greeting")).toBeVisible();
    await page.evaluate(() => document.documentElement.classList.remove("kb"));
    await expect(page.getByTestId("starters")).toBeVisible();
  });

  test("starters hide on a short viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 560 });
    await open(page);
    await expect(page.getByTestId("starters")).toBeHidden();
  });

  test("desktop: the message column and composer are centered and at most 720px; + opens a popover above the button @desktop-only", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    const comp = await box(page, "footer.composer");
    expect(comp.width).toBeLessThanOrEqual(721);
    const col = await box(page, ".chat .col");
    expect(col.width).toBeLessThanOrEqual(721);
    expect(Math.abs(comp.x + comp.width / 2 - (col.x + col.width / 2)), "composer aligned with the message column").toBeLessThan(2);
    const plus = await box(page, '[data-testid="composer-plus"]');
    await page.getByTestId("composer-plus").click();
    const s = (await page.getByTestId("ctx-sheet").boundingBox())!;
    expect(s.y + s.height).toBeLessThanOrEqual(plus.y + 1);
    expect(Math.abs(s.x - plus.x)).toBeLessThan(4);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ctx-sheet")).toHaveCount(0);
  });
});
