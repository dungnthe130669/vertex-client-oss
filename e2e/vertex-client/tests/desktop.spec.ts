import { test, expect, type Api, switchMode, expectMode } from "./fixtures";
import type { Page } from "@playwright/test";

// Desktop mode against the real agent-spike + build-host desktop container (costs a few cents per run). The agent is given a slow, harmless
// job so it is still working when we take control; take-over goes through the real noVNC tunnel (vertex-client -> AGENT binding).
const TASK = "Scroll down and back up the page slowly, three times, waiting a couple of seconds between scrolls. Then tell me the page heading in one short sentence.";
const RED = "data:text/html,<body style=background:%23ff0000><h1>e2e</h1>";

const list = async (api: Api) => (await (await api.get("/api/desktop/runs")).json()).runs as { id: string; status: string }[];
async function cleanup(api: Api) { for (const r of await list(api).catch(() => [])) await api.mut("POST", `/api/desktop/runs/${r.id}/stop`, {}).catch(() => null); }

/** Cheap fingerprint of the remote screen: sampled pixel sums of the noVNC canvas (same idea as agent-spike's takeover-proof). */
const screenHash = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid="vnc-screen"] canvas') as HTMLCanvasElement | null;
  if (!c || !c.width) return null;
  const g = c.getContext("2d"); if (!g) return null;
  let h = 0; const d = g.getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i += 4 * 97) h = (h * 31 + d[i]! * 3 + d[i + 1]! * 5 + d[i + 2]!) | 0;
  return `${c.width}x${c.height}:${h}`;
});
const centreRed = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid="vnc-screen"] canvas') as HTMLCanvasElement | null;
  if (!c) return false;
  const p = c.getContext("2d")!.getImageData(Math.floor(c.width / 2), Math.floor(c.height * 0.7), 1, 1).data;
  return p[0]! > 200 && p[1]! < 60 && p[2]! < 60;
});

test.describe("desktop mode", () => {
  test.setTimeout(480_000);

  test("tabs reach Desktop", async ({ app: { page } }) => {
    await page.goto("/");
    await switchMode(page, "desktop");
    await expect(page).toHaveURL(/\/desktop$/);
    await expectMode(page, "desktop");
  });

  test("start, live view, take control, type + click, give back, result card", async ({ app: { page, api }, isMobile }) => {
    try {
      await page.goto("/desktop");
      await page.getByTestId("new-desktop-fab").click();
      await page.getByTestId("desk-url").fill("https://example.com");
      await page.getByTestId("desk-instruction").fill(TASK);
      await page.getByTestId("desk-start").click();
      await expect(page).toHaveURL(/\/d\/[0-9a-f]{16}$/);

      // live screenshots over the WebSocket
      await expect(page.getByTestId("live-frame")).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId("desk-state")).toHaveText(/running|idle/, { timeout: 60_000 });

      // take control: agent pauses, noVNC canvas comes up through the tunnel
      await page.getByTestId("desk-take").click();
      await expect(page.getByTestId("desk-control")).toHaveText("human", { timeout: 30_000 });
      await expect(page.getByTestId("vnc-pane")).toHaveAttribute("data-state", "connected", { timeout: 60_000 });
      await expect(page.getByTestId("idle-note")).toBeVisible();
      const canvas = page.locator('[data-testid="vnc-screen"] canvas');
      await expect(canvas).toBeVisible();
      await expect.poll(() => screenHash(page), { timeout: 30_000 }).not.toBeNull();
      const h0 = await screenHash(page);

      // click (mouse on desktop, touch tap on the phone profile), then type through the real keyboard path
      if (isMobile) await canvas.tap({ position: { x: 100, y: 100 } }); else await canvas.click({ position: { x: 100, y: 100 } });
      await page.getByTestId("vnc-ctrl-l").click();
      await page.getByTestId("vnc-text").fill(RED);
      await page.getByTestId("vnc-send").click();
      await page.getByTestId("vnc-enter").click();
      await expect.poll(() => screenHash(page), { timeout: 30_000, message: "remote screen must change after input" }).not.toBe(h0);
      await expect.poll(() => centreRed(page), { timeout: 30_000, message: "typed URL must load on the remote browser" }).toBe(true);

      // give back: canvas gone, agent resumes
      await page.getByTestId("desk-giveback").click();
      await expect(page.getByTestId("vnc-pane")).toHaveCount(0);
      await expect(page.getByTestId("desk-control")).toHaveText("agent", { timeout: 30_000 });

      // finish (stop if the agent is taking long: still produces a card with cost/steps)
      await expect(page.getByTestId("result-card")).toBeVisible({ timeout: 360_000 }).catch(async () => { await page.getByTestId("desk-stop").click(); await expect(page.getByTestId("result-card")).toBeVisible({ timeout: 60_000 }); });
      await expect(page.getByTestId("card-cost")).not.toContainText("$");
      await expect(page.getByTestId("card-steps")).toContainText("steps");

      await page.goto("/desktop");
      await expect(page.getByTestId("desk-row").first()).toBeVisible();
    } finally { await cleanup(api); }
  });
});
