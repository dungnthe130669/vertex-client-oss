import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApp, openSettingsRow } from "./polish-mock";
import { test as live } from "./fixtures";

// Multi-provider framework. Mocked-API variants (no login, no cost) for the picker grouping and the read-only Providers page;
// live variants for the API contract against the deployed build (e2e scope: only offline stubs are visible, never a real provider).
test.describe("providers UI (mocked API)", () => {
  test.use({ serviceWorkers: "block" });

  test("Providers page lists each provider with its status and says an admin must add one; axe clean", async ({ page }) => {
    await mockApp(page, { providers: "multi" });
    await page.goto("/settings/providers"); await page.waitForLoadState("networkidle");
    const rows = page.getByTestId("provider-row");
    await expect(rows).toHaveCount(4);
    await expect(page.locator('[data-testid="provider-row"][data-id="gateway"]')).toContainText("Enabled");
    await expect(page.locator('[data-testid="provider-row"][data-id="stub"]')).toContainText("Off");
    await expect(page.locator('[data-testid="provider-row"][data-id="beta"]')).toContainText("No key");
    expect(await page.getByTestId("providers-page").locator("input, textarea, [contenteditable]").count()).toBe(0); // nothing to type a key into until a preset/Edit is opened
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  });

  test("Settings -> Providers row navigates to the page", async ({ page }) => {
    await mockApp(page, { providers: "multi" });
    await page.goto("/settings"); await page.waitForLoadState("networkidle");
    await openSettingsRow(page, "providers");
    await expect(page.getByTestId("providers-page")).toBeVisible();
  });

  test("403 from /api/providers shows a plain message, not an empty list", async ({ page }) => {
    await mockApp(page, { providers: "forbidden" });
    await page.goto("/settings/providers"); await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("providers-page")).toContainText("not available for this account");
    await expect(page.getByTestId("provider-row")).toHaveCount(0);
  });

  test("model picker groups by provider with a label, and flags models without tools/images; a single provider keeps the flat list", async ({ page }) => {
    await mockApp(page, { providers: "multi" });
    await page.goto("/"); await page.waitForLoadState("networkidle");
    await page.getByTestId("model-pill").click();
    const dlg = page.getByRole("dialog", { name: "Models" });
    await expect(dlg.getByTestId("provider-label")).toHaveText(["Vertex (Claude)", "acme"]);
    await expect(dlg).toContainText("Acme One");
    await expect(dlg.locator("button.row", { hasText: "Acme Two" })).toContainText("no tools");
    const r = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    // single provider: no labels
    await page.goto("about:blank");
    await mockApp(page);
    await page.goto("/"); await page.waitForLoadState("networkidle");
    await page.getByTestId("model-pill").click();
    await expect(page.getByTestId("provider-label")).toHaveCount(0);
  });
});

live.describe("providers API (live, e2e scope)", () => {
  live("/api/providers is 200, lists the gateway, and carries no key/binding/url fields", async ({ app: { api } }) => {
    const r = await api.get("/api/providers");
    expect(r.status()).toBe(200);
    const t = await r.text(); const j = JSON.parse(t);
    expect(j.providers.find((p: { id: string }) => p.id === "gateway")).toMatchObject({ kind: "gateway", enabled: true, status: "enabled" });
    expect(t).not.toMatch(/apiKey|secret|binding|base_?url|token|nvapi/i);
  });
  live("the e2e scope cannot write or load providers (main only), and the bare collection has no write route", async ({ app: { api } }) => {
    for (const m of ["POST", "PUT", "DELETE"] as const) expect([404, 405], m).toContain((await api.mut(m, "/api/providers", { id: "x", key: "k" })).status());
    expect((await api.mut("PUT", "/api/providers/nvidia", { baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "nvapi-not-a-real-key" })).status()).toBe(403);
    expect((await api.mut("POST", "/api/providers/nvidia/models", {})).status()).toBe(403);
  });
  live("/api/models still lists gateway models unprefixed, each with provider + capabilities", async ({ app: { api } }) => {
    const j = await (await api.get("/api/models")).json();
    expect(j.models.length).toBeGreaterThan(0);
    const gw = j.models.filter((m: { provider?: string }) => m.provider === "gateway");
    expect(gw.length).toBe(j.models.length); // e2e never sees a real third-party provider
    for (const m of gw) { expect(m.id).not.toContain(":"); expect(m.capabilities).toHaveProperty("text"); expect(m.capabilities).toHaveProperty("tools"); }
    expect(j.models.map((m: { id: string }) => m.id)).toContain(j.default);
  });
  // A g:<uid> tenant cannot be minted over HTTP (production has no such login), so its 403 for /api/providers and the empty provider list
  // are asserted in the unit suite (test/isolation.test.ts, test/providers.test.ts), not here.
});
