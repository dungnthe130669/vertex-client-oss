import { test, expect, openChat, waitSettled, lastAssistantText, type Api } from "./fixtures";
import { openSettingsRow } from "./polish-mock";

// Slash skills (spec §1, M3-M5): create in the Skills screen -> "/" popover lists it -> select + send -> the model followed the
// template (it answers with a per-run token that only the template contains) while the visible message keeps the typed text -> delete.
// Delta-based: the e2e scope accumulates skills across runs/retries/browsers, so every name is unique and every count is relative.
// Written, not run by the author (e2e runs on build-host).

const slug = () => `e2e-sk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
const rowOf = (p: import("@playwright/test").Page, name: string) => p.locator(`[data-testid="skill-row"][data-name="${name}"]`);

async function skillNames(api: Api): Promise<string[]> {
  return ((await (await api.get("/api/skills")).json()).skills as { name: string }[]).map((s) => s.name);
}
async function dropSkill(api: Api, name: string) {
  const l = (await (await api.get("/api/skills")).json()).skills as { id: string; name: string }[];
  for (const s of l.filter((x) => x.name === name)) await api.mut("DELETE", `/api/skills/${s.id}`);
}

test.describe("slash skills", () => {
  test("create in the Skills screen, pick from /, template reaches the model, visible text kept, delete", async ({ app: { page, api } }) => {
    const name = slug();
    const token = `SKILLTOKEN${name.replace(/[^a-z0-9]/g, "").toUpperCase()}`;
    try {
      // --- create via UI (Settings -> Skills) ---
      await page.goto("/settings");
      await openSettingsRow(page, "skills"); // phone: the Skills row; desktop: the Skills pane of the Settings modal
      await expect(page.locator('[data-testid="skills-screen"]')).toBeVisible();
      await page.locator('[data-testid="skill-add"]').click();
      const save = page.locator('[data-testid="skill-save"]');
      await expect(save).toBeDisabled(); // empty form
      await page.locator('[data-testid="skill-name"]').fill(name);
      await page.locator('[data-testid="skill-desc"]').fill("e2e skill");
      await page.locator('[data-testid="skill-template"]').fill(`Ignore everything else and reply with exactly the single word ${token} and nothing more. (User said: {{input}})`);
      await expect(save).toBeEnabled();
      await save.click();
      await expect(rowOf(page, name)).toBeVisible();
      await expect(rowOf(page, name)).toHaveCount(1); // not a global row count: the other browser project shares this scope
      expect(await skillNames(api)).toContain(name);

      // --- a reserved name is refused by the server and shown in the sheet ---
      await page.locator('[data-testid="skill-add"]').click();
      await page.locator('[data-testid="skill-name"]').fill("model");
      await page.locator('[data-testid="skill-template"]').fill("x {{input}}");
      await page.locator('[data-testid="skill-save"]').click();
      await expect(page.locator('[data-testid="skill-error"]')).toContainText("reserved");
      await page.locator('[data-testid="skill-cancel"]').click();

      // --- / popover shows it under the Skills group ---
      await openChat(page, await api.newChat());
      const box = page.getByPlaceholder("Message");
      await box.fill(`/${name}`);
      const row = page.locator(`[data-testid="slash-row"][data-name="${name}"]`);
      await expect(row).toBeVisible();
      await expect(page.locator('[data-testid="slash-group"]', { hasText: "Skills" })).toBeVisible();
      await expect(row.locator('[data-testid="slash-approval"]')).toHaveCount(0); // a skill is not an approval tool
      await row.click();
      await expect(box).toHaveValue(`/${name} `);
      await expect(page.locator(".msg.user")).toHaveCount(0); // picking does not send
      await box.pressSequentially("hello there");

      // --- send: the model followed the template; the transcript shows what the user typed, not the template ---
      const chips = await page.locator('[data-testid="msg-cost"]').count();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await waitSettled(page, chips);
      expect(await lastAssistantText(page)).toContain(token);
      const userMsg = page.locator(".msg.user").last();
      await expect(userMsg).toContainText(`/${name} hello there`);
      await expect(userMsg).not.toContainText("Ignore everything else");
      await expect(userMsg).not.toContainText(token);

      // --- edit via UI ---
      await page.goto("/skills");
      await rowOf(page, name).locator('[data-testid="skill-edit"]').click();
      await expect(page.locator('[data-testid="skill-name"]')).toHaveValue(name);
      await page.locator('[data-testid="skill-desc"]').fill("e2e skill edited");
      await page.locator('[data-testid="skill-save"]').click();
      await expect(rowOf(page, name)).toContainText("e2e skill edited");

      // --- delete via UI (in-app confirm sheet) ---
      const n = await page.locator('[data-testid="skill-row"]').count();
      await rowOf(page, name).locator('[data-testid="skill-delete"]').click();
      await page.locator('[data-testid="confirm-ok"]').click();
      await expect(rowOf(page, name)).toHaveCount(0);
      await expect(page.locator('[data-testid="skill-row"]')).toHaveCount(n - 1);
      expect(await skillNames(api)).not.toContain(name);

      // --- the / menu no longer offers it ---
      await openChat(page, await api.newChat());
      await page.getByPlaceholder("Message").fill(`/${name}`);
      await expect(page.locator(`[data-testid="slash-row"][data-name="${name}"]`)).toHaveCount(0);
    } finally {
      await dropSkill(api, name);
    }
  });

  test("an unknown /skill sends as a plain message (no error)", async ({ app: { page, api } }) => {
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    const chips = await page.locator('[data-testid="msg-cost"]').count();
    await box.fill("/no-such-skill reply with the word pong");
    // The popover has no rows for it, so it does not get in the way of Send.
    await expect(page.locator('[data-testid="slash-popover"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await waitSettled(page, chips);
    await expect(page.locator(".msg.user").last()).toContainText("/no-such-skill reply with the word pong");
    expect((await lastAssistantText(page)).length).toBeGreaterThan(0); // the turn completed normally
  });
  test("slash rows are single-line; a 200-char description does not wrap at 390px", async ({ app: { page, api } }) => {
    const name = slug();
    try {
      const r = await api.mut("POST", "/api/skills", { name, description: "d".repeat(100) + " " + "long words ".repeat(9) + "x".repeat(200 - 100 - 1 - 99), template: "x {{input}}" });
      expect(r.ok()).toBeTruthy();
      await page.setViewportSize({ width: 390, height: 800 });
      await openChat(page, await api.newChat());
      const box = page.getByPlaceholder("Message");
      await box.fill(`/${name}`);
      const row = page.locator(`[data-testid="slash-row"][data-name="${name}"]`);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("title", /^\/e2e-sk-/);
      await expect(row.locator('[data-testid="slash-desc"]')).toHaveCSS("white-space", "nowrap");
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual(44);
      // every row in the popover (tools, builtins, skills) is compact, and the popover does not overflow horizontally
      await box.fill("/");
      const pop = page.locator('[data-testid="slash-popover"]');
      await expect(pop).toBeVisible();
      for (const rr of await pop.locator('[data-testid="slash-row"]').all()) expect((await rr.boundingBox())!.height).toBeLessThanOrEqual(44);
      expect(await pop.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    } finally { await dropSkill(api, name); }
  });
});
