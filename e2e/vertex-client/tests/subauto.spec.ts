import { test, expect, type Page, type Route } from "@playwright/test";
import { mockApp, IDS, openSettingsRow } from "./polish-mock";

// Auto-delegation (mocked API, main + team edition; written, not run by the author — e2e runs on build-host, never live for this feature):
// 1) Settings -> Subagents: the "Let chat delegate to subagents by itself" switch (default off, saved through PUT /api/settings/auto-delegate).
// 2) Two parallel delegate calls = two OWN cards with status + tokens (tokens only), the turn's Details footer sums the children, and the
//    conversation info sheet carries a "Subagents" line. The model-side behaviour (paragraph on/off, parallel dispatch ordering, cache stability)
//    is covered by the bun tests in test/auto-delegate.test.ts.
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const msg = (id: number, role: string, content: unknown[]) => ({ id, role, content, model: role === "assistant" ? "claude-sonnet-5-5" : null, usage: role === "assistant" ? usage : null, costUsd: null, stopReason: null, status: "complete", ttftMs: null, totalMs: null, createdAt: 1 });
const text = (t: string) => ({ type: "text", text: t });
const use = (id: string, persona: string, task: string) => ({ type: "tool_use", id, name: "delegate", input: { persona, task } });
const res = (id: string, persona: string, i: number, o: number, summary: string) => ({ type: "tool_result", tool_use_id: id,
  content: JSON.stringify({ subagent: { persona, model: "claude-haiku-5-5", status: "ok", rounds: 1, input_tokens: i, output_tokens: o }, summary }) });

async function chat(page: Page, messages: unknown[], team: boolean) {
  await mockApp(page, team ? { team: { hits403: [] } } : {});
  await page.route(new RegExp(`/api/conversations/${IDS.chat}$`), (route: Route) => route.fulfill({ json: { conversation: { id: IDS.chat, title: "T", model: "claude-sonnet-5-5", pinned: 0, costUsd: 0, tokens: 0, projectId: null },
    state: { seq: 5, running: false, inflight: null, model: "claude-sonnet-5-5", title: "T", error: null, costUsd: 0, tokens: 0, messages } } }));
  await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
}

for (const scope of ["main", "team"] as const) {
  test.describe(`auto-delegate (${scope}, mocked API)`, () => {
    test.use({ serviceWorkers: "block" });

    test("Settings -> Subagents: switch is labelled, default off, and saves", async ({ page }) => {
      const hits403: string[] = [];
      await mockApp(page, scope === "team" ? { team: { hits403 } } : {});
      let enabled = false; const puts: unknown[] = [];
      await page.route(/\/api\/personas$/, (route: Route) => route.fulfill({ json: { personas: [] } }));
      await page.route(/\/api\/settings\/auto-delegate$/, async (route: Route) => {
        if (route.request().method() === "PUT") { const b = route.request().postDataJSON(); puts.push(b); enabled = b.enabled; return route.fulfill({ json: { enabled } }); }
        return route.fulfill({ json: { enabled } });
      });
      await page.goto("/settings"); await openSettingsRow(page, "subagents");
      const row = page.getByTestId("auto-delegate-setting");
      await expect(row).toContainText("Let chat delegate to subagents by itself");
      await expect(row).toContainText("several at once");
      await expect(row).toContainText("extra tokens");
      const sw = page.getByTestId("auto-delegate-toggle");
      await expect(sw).toHaveAttribute("aria-checked", "false");
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "true");
      expect(puts).toEqual([{ enabled: true }]);
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "false");
      expect(puts).toEqual([{ enabled: true }, { enabled: false }]);
      expect(hits403).toEqual([]);
    });

    test("two parallel delegates: two cards, tokens only, footer sums the children, info sheet has a Subagents line", async ({ page }) => {
      await chat(page, [msg(1, "user", [text("research a and review b")]),
        msg(2, "assistant", [text("Running both."), use("t1", "researcher", "find A"), use("t2", "reviewer", "review B")]),
        msg(3, "user", [res("t1", "researcher", 1200, 100, "A is 42."), res("t2", "reviewer", 800, 50, "B has two issues.")]),
        msg(4, "assistant", [text("Synthesis: A is 42, B has two issues.")])], scope === "team");
      const cards = page.getByTestId("subagent-card");
      await expect(cards).toHaveCount(2);
      await expect(page.getByText("2 tools in parallel")).toBeVisible();
      await expect(cards.nth(0)).toHaveAttribute("data-status", "done");
      await expect(cards.nth(1)).toHaveAttribute("data-status", "done");
      await cards.nth(0).locator("summary").click(); await cards.nth(1).locator("summary").click();
      await expect(cards.nth(0).getByTestId("subagent-persona")).toHaveText("researcher");
      await expect(cards.nth(1).getByTestId("subagent-persona")).toHaveText("reviewer");
      await expect(cards.nth(0).getByTestId("subagent-tokens")).toHaveText("1.2k in · 100 out");
      await expect(cards.nth(1).getByTestId("subagent-tokens")).toHaveText("800 in · 50 out");
      expect(await cards.nth(0).innerText()).not.toMatch(/\$\d/);
      const foot = page.locator(".turn-foot").last();
      await foot.locator("summary").click();
      await expect(foot.getByTestId("turn-subagents")).toContainText("subagents: 2");
      await expect(foot.getByTestId("turn-subagents")).toContainText("2.0k in / 150 out");
      await expect(foot).not.toContainText("$");
      await page.getByTestId("chat-header-menu").click(); await page.getByTestId("chat-menu-info").click();
      await expect(page.getByTestId("info-subagents")).toHaveText("2 delegations · 2.1k tokens");
      await expect(page.getByTestId("conv-info")).not.toContainText("$");
    });

    test("no delegations: no Subagents line in the info sheet", async ({ page }) => {
      await chat(page, [msg(1, "user", [text("hi")]), msg(2, "assistant", [text("hello")])], scope === "team");
      await page.getByTestId("chat-header-menu").click(); await page.getByTestId("chat-menu-info").click();
      await expect(page.getByTestId("conv-info")).toBeVisible();
      await expect(page.getByTestId("info-subagents")).toHaveCount(0);
    });
  });
}
