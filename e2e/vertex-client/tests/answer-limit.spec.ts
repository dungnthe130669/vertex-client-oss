import { test, expect, headerAction, type Api } from "./fixtures";
import { openSettingsRow } from "./polish-mock";

// "Limit answer length" (Settings -> Profile). Flips the real switch as the e2e bot and checks the saved state through the API; no model call is made.
const get = async (api: Api) => (await (await api.get("/api/settings/answer-limit")).json()) as { limit: string; default: string };

test.describe("settings: limit answer length", () => {
  test("the switch shows the saved state, flips it both ways, and survives a reload", async ({ app: { page, api } }) => {
    const before = await get(api);
    try {
      await page.goto("/");
      await headerAction(page, "Settings");
      await openSettingsRow(page, "profile");
      const row = page.getByTestId("answer-limit-setting");
      await expect(row).toBeVisible();
      await expect(row).toContainText("Limit answer length");
      await expect(row).toContainText("Off = models write as long as they can (Vertex models only)");
      const sw = page.getByTestId("answer-limit-toggle");
      await expect(sw).toHaveAttribute("aria-checked", before.limit === "default" ? "true" : "false");
      // start from a known state: limited
      if ((await sw.getAttribute("aria-checked")) === "false") { await sw.click(); await expect(sw).toHaveAttribute("aria-checked", "true"); }
      expect((await get(api)).limit).toBe("default");
      await sw.click();                                   // limit OFF = no answer limit
      await expect(sw).toHaveAttribute("aria-checked", "false");
      await expect.poll(async () => (await get(api)).limit).toBe("off");
      await page.reload();
      await expect(page.getByTestId("answer-limit-toggle")).toHaveAttribute("aria-checked", "false");
      await page.getByTestId("answer-limit-toggle").click();
      await expect(page.getByTestId("answer-limit-toggle")).toHaveAttribute("aria-checked", "true");
      await expect.poll(async () => (await get(api)).limit).toBe("default");
    } finally { await api.mut("PUT", "/api/settings/answer-limit", { limit: before.limit }); }
  });

  // Touch hit area: styles.css gives `.srow .switch` a ::before with inset:-7px 0 inside the coarse-pointer media query. Derived from the computed pseudo-element, nothing assumed:
  // removing that rule leaves content "none" / zero expansion and this fails. Phone only (the rule need not apply on desktop).
  test("the switch is a >=44px touch target on a phone (computed ::before hit area) and the row does not overflow @mobile-only", async ({ app: { page } }) => {
    await page.goto("/settings/profile");
    const sw = page.getByTestId("answer-limit-toggle");
    await expect(sw).toBeVisible();
    const hit = await sw.evaluate((el) => {
      const r = el.getBoundingClientRect(), b = getComputedStyle(el, "::before");
      return { h: r.height, content: b.content, position: b.position, top: parseFloat(b.top), bottom: parseFloat(b.bottom) };
    });
    expect(hit.content, "no ::before hit-area pseudo-element on the switch").not.toBe("none");
    expect(hit.position).toBe("absolute");
    expect(hit.top).toBeLessThan(0); expect(hit.bottom).toBeLessThan(0);       // it extends beyond the visual switch on both sides
    expect(hit.h - hit.top - hit.bottom, "switch + hit-area expansion").toBeGreaterThanOrEqual(44);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(o.sw).toBeLessThanOrEqual(o.iw + 1);
  });
});
