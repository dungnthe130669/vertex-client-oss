import { test, expect, type Page, type Route } from "@playwright/test";
import { mockApp, IDS, openSettingsRow } from "./polish-mock";

// Subagents (`delegate`): the transcript card (persona, model, task, status, TOKENS only, summary) for a finished call, an errored call and two parallel
// calls, plus the Settings -> Subagents screen (create / list / delete) on main AND the team edition. Mocked API (stub provider side lives in the
// bun tests: test/subagent.test.ts), no login, no cost. Written, not run by the author (e2e runs on build-host).
const msg = (id: number, role: string, content: unknown[]) => ({ id, role, content, model: role === "assistant" ? "claude-sonnet-5-5" : null, usage: null, costUsd: null, stopReason: null, status: "complete", ttftMs: null, totalMs: null, createdAt: 1 });
const text = (t: string) => ({ type: "text", text: t });
const use = (id: string, persona: string, task: string) => ({ type: "tool_use", id, name: "delegate", input: { persona, task } });
const res = (id: string, o: { persona: string; status: "ok" | "error"; summary: string; i?: number; o?: number }, isError = false) => ({ type: "tool_result", tool_use_id: id, is_error: isError || undefined,
  content: JSON.stringify({ subagent: { persona: o.persona, model: "claude-haiku-5-5", status: o.status, rounds: 1, input_tokens: o.i ?? 1234, output_tokens: o.o ?? 56 }, summary: o.summary }) });

async function chat(page: Page, messages: unknown[], opts: { team?: boolean } = {}) {
  await mockApp(page, opts.team ? { team: { hits403: [] } } : {});
  await page.route(new RegExp(`/api/conversations/${IDS.chat}$`), (route: Route) => route.fulfill({ json: { conversation: { id: IDS.chat, title: "T", model: "claude-sonnet-5-5", pinned: 0, costUsd: 0, tokens: 0, projectId: null },
    state: { seq: 5, running: false, inflight: null, model: "claude-sonnet-5-5", title: "T", error: null, costUsd: 0, tokens: 0, messages } } }));
  await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
}

test.describe("subagent card (mocked API)", () => {
  test.use({ serviceWorkers: "block" });
  for (const scope of ["main", "team"] as const) {
    test(`${scope}: two parallel delegates render two collapsible cards with tokens only and the summary`, async ({ page }) => {
      await chat(page, [msg(1, "user", [text("research a and b")]),
        msg(2, "assistant", [text("On it."), use("t1", "researcher", "find A"), use("t2", "reviewer", "review B")]),
        msg(3, "user", [res("t1", { persona: "researcher", status: "ok", summary: "A is 42." }), res("t2", { persona: "reviewer", status: "ok", summary: "B has two issues." })]),
        msg(4, "assistant", [text("Both done.")])], { team: scope === "team" });
      const cards = page.getByTestId("subagent-card");
      await expect(cards).toHaveCount(2);
      await expect(page.getByText("2 tools in parallel")).toBeVisible();
      await cards.first().locator("summary").click();
      await expect(cards.first().getByTestId("subagent-persona")).toHaveText("researcher");
      await expect(cards.first().getByTestId("subagent-model")).toHaveText("claude-haiku-5-5");
      await expect(cards.first().getByTestId("subagent-task")).toHaveText("find A");
      await expect(cards.first().getByTestId("subagent-tokens")).toHaveText("1.2k in · 56 out");
      await expect(cards.first().getByTestId("subagent-summary")).toHaveText("A is 42.");
      await expect(cards.first().getByTestId("subagent-card")).toHaveCount(0);
      expect(await cards.first().innerText()).not.toMatch(/\$\d/);          // tokens only: no per-item cost
      await expect(cards.first()).toHaveAttribute("data-status", "done");
    });
  }
  test("a failed subagent shows as an error card and the answer still follows", async ({ page }) => {
    await chat(page, [msg(1, "user", [text("x")]), msg(2, "assistant", [use("t1", "researcher", "find A")]),
      msg(3, "user", [res("t1", { persona: "researcher", status: "error", summary: "Subagent unavailable: model m is not available for this account." }, true)]), msg(4, "assistant", [text("It could not run.")])]);
    const card = page.getByTestId("subagent-card");
    await expect(card).toHaveAttribute("data-status", "error");
    await card.locator("summary").click();
    await expect(card.getByTestId("subagent-summary")).toContainText("not available");
    await expect(page.locator("body")).toContainText("It could not run.");
  });
});

test.describe("Settings -> Subagents (mocked API)", () => {
  test.use({ serviceWorkers: "block" });
  for (const scope of ["main", "team"] as const) {
    test(`${scope}: list, add, delete`, async ({ page }) => {
      const hits403: string[] = [];
      await mockApp(page, scope === "team" ? { team: { hits403 } } : {});
      let rows: any[] = [{ id: "p1", name: "researcher", description: "Looks things up", prompt: "p", model: "claude-haiku-5-5", tools: ["read_url"], maxTokens: 4096, effort: null, createdAt: "", updatedAt: "" }];
      await page.route(/\/api\/personas(\/[^/]+)?$/, async (route: Route) => {
        const m = route.request().method(), id = new URL(route.request().url()).pathname.split("/")[3];
        if (m === "GET") return route.fulfill({ json: { personas: rows } });
        if (m === "POST") { const b = route.request().postDataJSON(); const r = { id: "p" + (rows.length + 1), ...b, createdAt: "", updatedAt: "" }; rows = [...rows, r]; return route.fulfill({ status: 201, json: { persona: r } }); }
        if (m === "DELETE") { rows = rows.filter((r) => r.id !== id); return route.fulfill({ json: { ok: true } }); }
        return route.fulfill({ status: 405, json: {} });
      });
      await page.goto("/settings"); await openSettingsRow(page, "subagents");
      await expect(page.getByTestId("subagents-screen")).toBeVisible();
      await expect(page.getByTestId("persona-row")).toHaveCount(1);
      await page.getByTestId("persona-add").click();
      const save = page.getByTestId("persona-save");
      await expect(save).toBeDisabled();
      await page.getByTestId("persona-name").fill("summ-two");
      await page.getByTestId("persona-prompt").fill("Summarise tersely.");
      await expect(save).toBeEnabled();
      await save.click();
      await expect(page.locator('[data-testid="persona-row"][data-name="summ-two"]')).toBeVisible();
      await page.locator('[data-testid="persona-row"][data-name="summ-two"]').getByTestId("persona-delete").click();
      await page.getByTestId("confirm-ok").click();
      await expect(page.locator('[data-testid="persona-row"][data-name="summ-two"]')).toHaveCount(0);
      expect(hits403).toEqual([]);
    });
  }
});
