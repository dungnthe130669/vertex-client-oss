import { test, expect, HAIKU, ask, openChat, type Api } from "./fixtures";

// Auto model, SHADOW mode (live e2e, cheap: haiku, 1-2 tiny messages). With the setting on, each turn's usage row records what the router WOULD have
// picked (routed_by: auto) while the model that actually ran stays the one the user chose. The setting is switched back off afterwards.
const byRoute = async (api: Api) => ((await (await api.get("/api/usage?tz=0")).json()) as any).byRoute as Array<{ model: string; routedModel: string | null; routedBy: string; n: number }>;
const setShadow = async (api: Api, enabled: boolean) => expect((await api.mut("PUT", "/api/settings/auto-shadow", { enabled })).status()).toBe(200);

test.describe("auto model shadow mode", () => {
  test("default is off, the Settings toggle is labelled and flips the setting", async ({ app: { page, api } }) => {
    await setShadow(api, false);
    expect((await (await api.get("/api/settings/auto-shadow")).json()).enabled).toBe(false);
    await page.goto("/settings");
    const row = page.getByTestId("auto-shadow-setting");
    await expect(row).toContainText("Auto model (shadow, records only)");
    const sw = page.getByTestId("auto-shadow-toggle");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await (await api.get("/api/settings/auto-shadow")).json()).enabled).toBe(true);
    await sw.click();
    await expect.poll(async () => (await (await api.get("/api/settings/auto-shadow")).json()).enabled).toBe(false);
  });

  test("on: the turn is recorded with routed_by auto, and the model that ran is unchanged", async ({ app: { page, api } }) => {
    const before = ((await byRoute(api)) ?? []).reduce((n, r) => n + r.n, 0);
    await setShadow(api, true);
    try {
      const id = await api.newChat(HAIKU);
      await openChat(page, id);
      const a = await ask(page, "Reply with just: ok");
      expect(a.toLowerCase()).toContain("ok");
      await expect.poll(async () => ((await byRoute(api)) ?? []).reduce((n, r) => n + r.n, 0), { timeout: 15_000 }).toBeGreaterThan(before);
      const rows = await byRoute(api);
      expect(rows.every((r) => r.routedBy === "auto")).toBe(true);
      expect(rows.some((r) => r.model === HAIKU)).toBe(true);                        // what ran: haiku, as chosen
      expect(rows.some((r) => r.routedModel !== null)).toBe(true);                    // what Auto would have picked is recorded
      const conv = (await api.conversations()).find((c) => c.id === id)!;
      expect(conv.model).toBe(HAIKU);                                                  // shadow never rewrites the conversation's model
    } finally { await setShadow(api, false); }
  });

  test("off: a turn records no route", async ({ app: { page, api } }) => {
    await setShadow(api, false);
    const before = ((await byRoute(api)) ?? []).reduce((n, r) => n + r.n, 0);
    await openChat(page, await api.newChat(HAIKU));
    await ask(page, "Reply with just: ok");
    await page.waitForTimeout(1500);
    expect(((await byRoute(api)) ?? []).reduce((n, r) => n + r.n, 0)).toBe(before);
  });
});
