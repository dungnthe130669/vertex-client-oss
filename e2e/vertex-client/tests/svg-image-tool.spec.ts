import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApp, IDS } from "./polish-mock";

// Inline SVG in chat + the generate_image chat tool (render side) + the "Let chat create images" setting. Mocked API, no login, no cost.
// The SVG must only ever be an <img> (blob:), never markup in the DOM; unsafe markup is refused with a note and shows as code.
const SVG_ID = "00000000-0000-4000-8000-000000000077";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP438PwH4QZYAwAXJIKKXIKGZIAAAAAElFTkSuQmCC", "base64");
const DOG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="400" height="240"><rect width="100" height="60" fill="#fde68a"/><circle cx="50" cy="30" r="18" fill="#92400e"/></svg>';
const HOSTILE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>window.__pwn=1</script><rect width="10" height="10" onload="window.__pwn=2"/></svg>';
const msg = (id: number, role: string, content: unknown[], extra: object = {}) => ({ id, role, content, model: role === "assistant" ? "claude-sonnet-5-5" : null, usage: null, costUsd: null, stopReason: null, status: "done", ttftMs: null, totalMs: null, createdAt: Date.now() - 1000 * (10 - id), ...extra });
const text = (t: string) => ({ type: "text", text: t });

async function chat(page: Page, messages: unknown[], opts: { team?: boolean; chatImagesAvailable?: boolean } = {}) {
  await mockApp(page, opts.team ? { team: { hits403: [] } } : {});
  await page.route(new RegExp(`/api/conversations/${IDS.chat}$`), (route: Route) => route.fulfill({ json: { conversation: { id: IDS.chat, title: "T", model: "claude-sonnet-5-5", pinned: 0, costUsd: 0, tokens: 0, projectId: null, createdAt: "", updatedAt: "" },
    state: { seq: 5, running: false, inflight: null, model: "claude-sonnet-5-5", title: "T", error: null, costUsd: 0, tokens: 0, messages } } }));
  await page.route(`**/api/artifacts/${SVG_ID}**`, (route: Route) => route.fulfill({ json: { id: SVG_ID, title: "Con cho (SVG)", type: "svg", language: null, version: 1, bytes: DOG.length, createdAt: "", updatedAt: "", shown: 1, content: DOG, versions: [{ version: 1, bytes: DOG.length, createdAt: "" }] } }));
  await page.route("**/api/conversations/*/files/**", (route: Route) => route.fulfill({ body: PNG, contentType: "image/png" }));
  await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
}
const imgLoaded = (page: Page, sel: string) => expect.poll(() => page.locator(sel).first().evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);

test.describe("inline SVG in chat (mocked API)", () => {
  test.use({ serviceWorkers: "block" });
  for (const scope of ["main", "team"] as const) {
    test(`${scope}: a closed svg fence renders as an <img>, constrained, markup never in the DOM`, async ({ page }) => {
      await chat(page, [msg(1, "user", [text("draw a dog")]), msg(2, "assistant", [text("Here you go:\n\n```svg\n" + DOG + "\n```\n\nEnjoy.")])], { team: scope === "team" });
      const fig = page.getByTestId("svg-inline");
      await expect(fig).toBeVisible();
      await imgLoaded(page, '[data-testid="svg-inline-img"]');
      expect(await page.locator('[data-testid="svg-inline"] circle, [data-testid="svg-inline"] svg[viewBox="0 0 100 60"]').count()).toBe(0); // the picture is an <img>, the markup is not injected
      const box = await page.getByTestId("svg-inline-img").boundingBox(); const vw = page.viewportSize()!.width;
      expect(box!.width).toBeLessThanOrEqual(vw); expect(box!.height).toBeLessThanOrEqual(page.viewportSize()!.height * 0.6 + 1);
      const dl = page.waitForEvent("download");
      await page.getByTestId("svg-download").click();
      expect((await dl).suggestedFilename()).toMatch(/\.svg$/);
      await expect(page.getByTestId("svg-copy")).toBeVisible();
      await expect(page.locator("body")).toContainText("Enjoy.");
    });
  }

  for (const scheme of ["light", "dark"] as const) {
    test(`axe (${scheme}): chat with an inline svg + a generated image has no serious/critical violations; the picture is keyboard reachable`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await chat(page, [msg(1, "user", [text("draw")]), msg(2, "assistant", [text("```svg\n" + DOG + "\n```")])]);
      await expect(page.getByTestId("svg-inline")).toBeVisible();
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
      await page.getByTestId("svg-download").focus(); await expect(page.getByTestId("svg-download")).toBeFocused();
    });
  }

  test("a hostile svg fence is NOT rendered: code card + note, no script runs", async ({ page }) => {
    await chat(page, [msg(1, "user", [text("x")]), msg(2, "assistant", [text("```svg\n" + HOSTILE + "\n```")])]);
    await expect(page.getByTestId("svg-unsafe")).toContainText("Not rendered: script or embedded content");
    await expect(page.getByTestId("svg-inline-img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwn)).toBeUndefined();
  });

  test("an unclosed (still streaming) fence stays a plain code block", async ({ page }) => {
    await chat(page, [msg(1, "user", [text("x")]), msg(2, "assistant", [text("```svg\n" + DOG)])]);
    await expect(page.getByTestId("svg-inline")).toHaveCount(0);
    await expect(page.locator(".codeblock").first()).toBeVisible();
  });

  test("an svg artifact card shows the picture, and tapping it opens the Artifact viewer", async ({ page }) => {
    const result = JSON.stringify({ artifact: { id: SVG_ID, title: "Con cho (SVG)", type: "svg", version: 1 } });
    await chat(page, [msg(1, "user", [text("draw a dog")]),
      msg(2, "assistant", [{ type: "tool_use", id: "tu1", name: "create_artifact", input: { title: "Con cho (SVG)", type: "svg", content: DOG } }], { stopReason: "tool_use" }),
      msg(3, "user", [{ type: "tool_result", tool_use_id: "tu1", content: result }]),
      msg(4, "assistant", [text("Done.")])]);
    await expect(page.getByTestId("artifact-card")).toBeVisible();
    await imgLoaded(page, '[data-testid="svg-inline-img"]');
    await expect(page.getByTestId("svg-inline-img")).toHaveAttribute("alt", "Con cho (SVG)");
    await page.getByTestId("svg-inline-open").click();
    await expect(page).toHaveURL(new RegExp(`/artifacts/${SVG_ID}$`));
  });
});

test.describe("chat image tool (mocked API)", () => {
  test.use({ serviceWorkers: "block" });
  test("a generate_image tool result shows the image inline with the Image-mode figure", async ({ page }) => {
    const ref = `files/${IDS.chat}/gen/11111111-1111-4111-8111-111111111111.png`;
    const result = JSON.stringify({ generated_image: { ref, mime: "image/png", prompt: "a red fox", model: "e2e-stub-image", cost_usd: 0.045, est_usd: 0.045 } });
    await chat(page, [msg(1, "user", [text("make a fox picture")]),
      msg(2, "assistant", [{ type: "tool_use", id: "tu2", name: "generate_image", input: { prompt: "a red fox" } }], { stopReason: "tool_use" }),
      msg(3, "user", [{ type: "tool_result", tool_use_id: "tu2", content: result }]),
      msg(4, "assistant", [text("Here is your fox.")])]);
    await expect(page.getByTestId("gen-image")).toBeVisible();
    await imgLoaded(page, '[data-testid="gen-image"] img');
    await page.getByRole("button", { name: "Open generated image" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("a refused call (over the confirm line) is a normal tool card, no image", async ({ page }) => {
    await chat(page, [msg(1, "user", [text("pro fox")]),
      msg(2, "assistant", [{ type: "tool_use", id: "tu3", name: "generate_image", input: { prompt: "x" } }], { stopReason: "tool_use" }),
      msg(3, "user", [{ type: "tool_result", tool_use_id: "tu3", content: "Not generated: ... use Image mode ...", is_error: true }]),
      msg(4, "assistant", [text("Please use Image mode.")])]);
    await expect(page.getByTestId("tool-card")).toBeVisible();
    await expect(page.getByTestId("gen-image")).toHaveCount(0);
  });

  test("Settings > General: toggle is shown and saves; hidden when image generation is not available", async ({ page }) => {
    await mockApp(page);
    let put: unknown = null;
    await page.route("**/api/settings/chat-images", (route) => route.request().method() === "PUT" ? (put = route.request().postDataJSON(), route.fulfill({ json: { enabled: false } })) : route.fulfill({ json: { enabled: true, available: true } }));
    await page.goto("/settings"); await page.waitForLoadState("networkidle");
    const sw = page.getByTestId("chat-images-toggle");
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    expect(put).toEqual({ enabled: false });
    await page.unroute("**/api/settings/chat-images");
    await page.route("**/api/settings/chat-images", (route) => route.fulfill({ json: { enabled: true, available: false } }));
    await page.goto("/settings"); await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("chat-images-setting")).toHaveCount(0);
  });
});
