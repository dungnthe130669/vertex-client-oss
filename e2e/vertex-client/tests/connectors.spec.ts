import { test, expect, type Api } from "./fixtures";
import { openSettingsRow } from "./polish-mock";

// Connectors v1: Settings -> Connectors -> detail with switches. The e2e user sees only its own tool allowlist (search_notes, save_note, delete_note,
// connector_usage) and has its own connector_settings rows. Written, not run by the author (e2e runs on build-host).

const ID = "personal-connector";
const TOOL = "connector_usage"; // read tool in the e2e allowlist
const reset = (api: Api) => api.mut("PUT", `/api/connectors/${ID}`, { tool: { name: TOOL, mode: "always" } });
const slashTools = async (api: Api) => ((await (await api.get("/api/slash")).json()).items as { kind: string; name: string }[]).filter((i) => i.kind === "tool").map((i) => i.name);

test.describe("connectors", () => {
  test("opens from Settings; toggle persists after reload; a disabled tool is absent for a NEW chat; approval tier unchanged", async ({ app: { page, api } }) => {
    try {
      await reset(api);
      await page.goto("/settings");
      await openSettingsRow(page, "connectors"); // phone: the Connectors row; desktop: the Connectors pane of the Settings modal
      const row = page.locator(`[data-testid="connector-row"][data-id="${ID}"]`);
      await expect(row).toContainText(ID);
      await expect(row.locator('[data-testid="connector-count"]')).toHaveText(/^\d+$/);
      await row.click();
      await expect(page.locator('[data-testid="connector-screen"]')).toBeVisible();
      await expect(page.locator('[data-testid="connector-note"]')).toContainText("Applies to new chats");
      const mode = (n: string, m: string) => page.locator(`[data-testid="connector-tool"][data-name="${n}"] [data-testid="tool-mode-${m}"]`);
      await expect(mode("save_note", "ask")).toHaveAttribute("aria-pressed", "true"); // approval tool: Ask first, no Always offered
      await expect(mode("save_note", "always")).toHaveCount(0);
      await expect(mode(TOOL, "always")).toHaveAttribute("aria-pressed", "true");
      expect(await slashTools(api)).toContain(TOOL);

      await mode(TOOL, "block").click();
      await expect(mode(TOOL, "block")).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => slashTools(api)).not.toContain(TOOL); // a NEW chat's slash catalog no longer lists it
      await api.newChat();
      expect(await slashTools(api)).not.toContain(TOOL);

      await page.reload();
      await expect(mode(TOOL, "block")).toHaveAttribute("aria-pressed", "true");
      await expect(mode("save_note", "ask")).toHaveAttribute("aria-pressed", "true");
    } finally { await reset(api); }
  });

  // Custom MCP connectors need a public https server, so the add/connect flow is covered by route-level tests (test/custom-connectors.test.ts) with a fake MCP server;
  // here only what needs no external network: the add screen, its honest note, and the Disconnect confirm on the built-in.
  test("add screen is honest; built-in Disconnect asks first and Cancel changes nothing", async ({ app: { page } }) => {
    await page.goto("/connectors/new");
    await expect(page.locator('[data-testid="add-note"]')).toContainText("OAuth connectors are not supported yet");
    await page.locator('[data-testid="add-auth-header"]').click();
    await expect(page.locator('[data-testid="add-header-name"]')).toBeVisible();
    await page.locator('[data-testid="add-name"]').fill("x"); await page.locator('[data-testid="add-url"]').fill("http://x.example.com");
    await page.locator('[data-testid="add-submit"]').click();
    await expect(page.locator('[data-testid="add-error"]')).toBeVisible();
    await page.goto(`/connectors/${ID}`);
    await page.locator('[data-testid="connector-disconnect"]').click();
    await expect(page.locator('[data-testid="confirm-sheet"]')).toContainText("turned off, not deleted");
    await page.locator('[data-testid="confirm-cancel"]').click();
    await expect(page.locator('[data-testid="connector-master"]')).toHaveAttribute("aria-checked", "true");
  });

  test("390px: list, detail and add screen do not overflow horizontally", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    for (const path of ["/connectors", `/connectors/${ID}`, "/connectors/new"]) {
      await page.goto(path);
      await expect(page.locator('[data-testid="connector-row"], [data-testid="connector-tool"], [data-testid="add-screen"]').first()).toBeVisible();
      const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(sw).toBeLessThanOrEqual(cw);
    }
  });
});
