import { test, expect, type Page, type Route } from "@playwright/test";
import { mockApp, IDS } from "./polish-mock";

// `/advisor` (a persona with a conversation transcript, Opus, explicit-only): slash menu entry, the alias sends exactly what `@advisor <question>` sends,
// the card reads "advisor · opus", and an account without Opus gets a clear error card while the turn continues. Mocked API + socket (the child call
// itself is covered by test/advisor.test.ts), main AND team edition, no login, no cost. Written, not run by the author (e2e runs on build-host).
const msg = (id: number, role: string, content: unknown[]) => ({ id, role, content, model: role === "assistant" ? "claude-sonnet-5-5" : null, usage: null, costUsd: null, stopReason: null, status: "complete", ttftMs: null, totalMs: null, createdAt: 1 });
const text = (t: string) => ({ type: "text", text: t });
const use = (id: string, task: string) => ({ type: "tool_use", id, name: "delegate", input: { persona: "advisor", task } });
const res = (id: string, o: { status: "ok" | "error"; summary: string }, isError = false) => ({ type: "tool_result", tool_use_id: id, is_error: isError || undefined,
  content: JSON.stringify({ subagent: { persona: "advisor", model: "claude-opus-5-5", status: o.status, rounds: 1, input_tokens: 4200, output_tokens: 310 }, summary: o.summary }) });

async function setup(page: Page, team: boolean, messages: unknown[] = []) {
  await mockApp(page, team ? { team: { hits403: [] } } : {});
  await page.route(/\/api\/slash$/, (route: Route) => route.fulfill({ json: { items: [
    { kind: "builtin", name: "model", description: "Choose the model for this chat", group: "Commands" },
    { kind: "builtin", name: "advisor", description: "Ask a senior second opinion (Opus) on this conversation", group: "Commands" }] } }));
  await page.route(new RegExp(`/api/conversations/${IDS.chat}$`), (route: Route) => route.fulfill({ json: { conversation: { id: IDS.chat, title: "T", model: "claude-sonnet-5-5", pinned: 0, costUsd: 0, tokens: 0, projectId: null },
    state: { seq: 5, running: false, inflight: null, model: "claude-sonnet-5-5", title: "T", error: null, costUsd: 0, tokens: 0, messages } } }));
  const sent: any[] = [];
  await page.routeWebSocket(/\/api\/conversations\/.*\/ws/, (ws) => {
    ws.send(JSON.stringify({ t: "hello", seq: 5, minSeq: 0, running: false, now: Date.now() }));
    ws.onMessage((m) => { try { const f = JSON.parse(String(m)); if (f.t === "send") { sent.push(f); ws.send(JSON.stringify({ t: "ev", seq: 5 + sent.length, ts: Date.now(), e: { type: "turn_end" } })); } } catch { /* ignore */ } });
  });
  await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
  return sent;
}

test.describe("/advisor (mocked API)", () => {
  test.use({ serviceWorkers: "block" });
  for (const scope of ["main", "team"] as const) {
    const team = scope === "team";
    test(`${scope}: the slash menu lists /advisor with its description; picking it inserts @advisor`, async ({ page }) => {
      await setup(page, team);
      const box = page.getByPlaceholder("Message");
      await box.fill("/adv");
      const row = page.locator('[data-testid="slash-row"][data-name="advisor"]');
      await expect(row).toBeVisible();
      await expect(row.getByTestId("slash-desc")).toContainText("second opinion");
      await box.press("Enter");
      await expect(box).toHaveValue("@advisor ");
    });
    test(`${scope}: "/advisor <question>" and a bare "/advisor" send the @advisor text`, async ({ page }) => {
      const sent = await setup(page, team);
      const box = page.getByPlaceholder("Message");
      await box.fill("/advisor is the rollout plan safe?");
      await page.keyboard.press("Escape"); // close the menu if it is open
      await page.getByRole("button", { name: /send/i }).click();
      await expect.poll(() => sent.length).toBe(1);
      await expect(page.getByRole("button", { name: /stop/i })).toHaveCount(0); // the mocked turn ended (turn_end), so the composer is back to Send
      expect(sent[0].text).toBe("@advisor is the rollout plan safe?");
      await box.fill("/advisor");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /send/i }).click();
      await expect.poll(() => sent.length).toBe(2);
      expect(sent[1].text).toBe("@advisor Review the conversation so far.");
    });
    test(`${scope}: the card says "advisor · opus", tokens only, with the summary`, async ({ page }) => {
      await setup(page, team, [msg(1, "user", [text("@advisor is this ok?")]), msg(2, "assistant", [use("t1", "is this ok?")]),
        msg(3, "user", [res("t1", { status: "ok", summary: "Mostly. Risk: no rollback. Recommend: add one." })]), msg(4, "assistant", [text("Added a rollback.")])]);
      const card = page.getByTestId("subagent-card");
      await expect(card.getByTestId("subagent-title")).toHaveText("advisor · opus");
      await card.locator("summary").click();
      await expect(card.getByTestId("subagent-tokens")).toHaveText("4.2k in · 310 out");
      await expect(card.getByTestId("subagent-summary")).toContainText("Recommend");
      expect(await card.innerText()).not.toMatch(/\$\d/);
    });
    test(`${scope}: no Opus in this account -> a clear error card, the reply still follows`, async ({ page }) => {
      await setup(page, team, [msg(1, "user", [text("@advisor ok?")]), msg(2, "assistant", [use("t1", "ok?")]),
        msg(3, "user", [res("t1", { status: "error", summary: "advisor model not available in this account" }, true)]), msg(4, "assistant", [text("The advisor is not available here.")])]);
      const card = page.getByTestId("subagent-card");
      await expect(card).toHaveAttribute("data-status", "error");
      await card.locator("summary").click();
      await expect(card.getByTestId("subagent-summary")).toContainText("advisor model not available in this account");
      await expect(page.locator("body")).toContainText("The advisor is not available here.");
    });
  }
});
