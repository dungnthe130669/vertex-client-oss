import { test, expect, type Page, type Route } from "@playwright/test";
import { mockApp, IDS } from "./polish-mock";

// Auto model, applied (mocked API, main + team edition; no login, no cost, no live model call). Covers the picker entry, the per-message label + reason,
// "Retry with…" (a one-message override that never changes the conversation's Auto setting), "Pin this model", and the Settings explanation + 30-day counts.
// The routing itself (resolve, stickiness, escalation, effort in the request body) is covered by the bun tests in test/auto-apply.test.ts.
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const text = (t: string) => [{ type: "text", text: t }];
const route = (model: string, effort: string | null, reason = "rule 4: code cue") => ({ by: "auto-route", model, effort, reason });
const user = (id: number, t: string) => ({ id, role: "user", content: text(t), model: null, usage: null, costUsd: null, stopReason: null, status: "complete", ttftMs: null, totalMs: null, createdAt: Date.now() - 5e3, route: null });
const asst = (id: number, t: string, model: string, r: unknown) => ({ id, role: "assistant", content: text(t), model, usage, costUsd: null, stopReason: "end_turn", status: "complete", ttftMs: 400, totalMs: 1500, createdAt: Date.now() - 4e3, route: r });
const claudeOnly = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", meta: { label: "Sonnet 5.5", vendor: "anthropic", tier: "balanced", price: { input: 2, output: 10 }, caps: { images: true, caching: true, thinking: true, tools: true }, acceptsEffort: true } },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", meta: { label: "Opus 5.5", vendor: "anthropic", tier: "flagship", price: { input: 4, output: 20 }, caps: { images: true, caching: true, thinking: true, tools: true }, acceptsEffort: true } },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", meta: { label: "Haiku 5.5", vendor: "anthropic", tier: "fast", price: { input: 0.1, output: 0.5 }, caps: { images: true, caching: true, thinking: true, tools: true } } },
];

async function setup(page: Page, o: { team: boolean; convModel: string; messages?: unknown[]; models?: unknown[]; byRoute?: unknown[] }) {
  await mockApp(page, o.team ? { team: { hits403: [] } } : {});
  await page.route(/\/api\/models$/, (r: Route) => r.fulfill({ json: { default: "claude-sonnet-5-5", models: o.models ?? claudeOnly } }));
  if (o.byRoute) await page.route(/\/api\/usage/, (r: Route) => r.fulfill({ json: { byRoute: o.byRoute } }));
  await page.route(new RegExp(`/api/conversations/${IDS.chat}$`), (r: Route) => r.fulfill({ json: { conversation: { id: IDS.chat, title: "T", model: o.convModel, pinned: 0, costUsd: 0, tokens: 0, projectId: null },
    state: { seq: 5, running: false, inflight: null, model: o.convModel, title: "T", error: null, costUsd: 0, tokens: 0, messages: o.messages ?? [] } } }));
  const sent: any[] = [];
  await page.routeWebSocket(/\/api\/conversations\/.*\/ws/, (ws) => {
    ws.send(JSON.stringify({ t: "hello", seq: 5, minSeq: 0, running: false, now: Date.now() }));
    ws.onMessage((m) => { try { const f = JSON.parse(String(m)); if (f.t === "send") sent.push(f); } catch { /* ignore */ } });
  });
  await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
  return sent;
}
const thread = [user(1, "fix src/index.ts please"), asst(2, "Done: changed the import.", "claude-sonnet-5-5", route("claude-sonnet-5-5", "medium"))];

for (const scope of ["main", "team"] as const) {
  const team = scope === "team";
  test.describe(`auto model (${scope}, mocked API)`, () => {
    test.use({ serviceWorkers: "block" });

    test("picker: Auto is first with its description; picking it sends model auto", async ({ page }) => {
      const sent = await setup(page, { team, convModel: "claude-sonnet-5-5" });
      await page.getByTestId("model-pill").click();
      const sheet = page.getByRole("dialog", { name: "Models" });
      const rows = sheet.getByRole("button");
      await expect(rows.first()).toContainText("Auto");
      await expect(rows.first()).toContainText("Picks the model and thinking effort for each message");
      await rows.first().click();
      await expect(page.getByTestId("model-pill")).toContainText("Auto");
      await page.getByPlaceholder("Message").fill("hello");
      await page.getByRole("button", { name: /send/i }).click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0].model).toBe("auto");
    });

    test("picker: a scope with no Claude chat model gets no Auto entry", async ({ page }) => {
      await setup(page, { team, convModel: "gemini-x", models: [{ id: "gemini-x", name: "Gemini X", meta: { label: "Gemini X", vendor: "google", tier: "balanced", price: null, caps: { images: false, caching: false, thinking: false, tools: false } } }] });
      await page.getByTestId("model-pill").click();
      await expect(page.getByRole("dialog", { name: "Models" })).not.toContainText("Picks the model and thinking effort");
    });

    test("a conversation on a concrete model is unchanged: no label, no Auto controls", async ({ page }) => {
      await setup(page, { team, convModel: "claude-sonnet-5-5", messages: [user(1, "hi"), asst(2, "hello", "claude-sonnet-5-5", null)] });
      await expect(page.getByTestId("auto-label")).toHaveCount(0);
      await expect(page.getByTestId("retry-with")).toHaveCount(0);
      await expect(page.getByTestId("pin-model")).toHaveCount(0);
    });

    test("label under the answer shows what ran; the reason is in Details", async ({ page }) => {
      await setup(page, { team, convModel: "auto", messages: thread });
      await expect(page.getByTestId("auto-label")).toHaveText("Auto: Sonnet 5.5 · medium");
      await page.getByText("Details", { exact: true }).click();
      await expect(page.getByTestId("auto-reason")).toContainText("rule 4: code cue");
      await expect(page.locator(".chat")).not.toContainText("$");              // tokens only, no per-item cost
    });

    test("Retry with…: one-message override frame, the conversation stays Auto", async ({ page }) => {
      const sent = await setup(page, { team, convModel: "auto", messages: thread });
      await page.getByTestId("retry-with").click();
      const sheet = page.getByTestId("retry-sheet");
      await sheet.getByTestId("retry-model-claude-opus-5-5").click();
      await sheet.getByTestId("retry-effort-high").click();
      await sheet.getByTestId("retry-run").click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0].text).toBe("fix src/index.ts please");
      expect(sent[0].override).toEqual({ model: "claude-opus-5-5", effort: "high" });
      expect(sent[0].model).toBeUndefined();                       // the conversation's model is not touched
      await expect(page.getByTestId("model-pill")).toContainText("Auto");
    });

    test("Retry with… haiku offers no effort control", async ({ page }) => {
      await setup(page, { team, convModel: "auto", messages: thread });
      await page.getByTestId("retry-with").click();
      await page.getByTestId("retry-model-claude-haiku-5-5").click();
      await expect(page.getByTestId("retry-effort-high")).toHaveCount(0);
    });

    test("an override answer is labelled as such and offers no Pin", async ({ page }) => {
      const r = { by: "manual-override", model: "claude-opus-5-5", effort: "high", reason: "chosen" };
      await setup(page, { team, convModel: "auto", messages: [user(1, "q"), asst(2, "a", "claude-opus-5-5", r)] });
      await expect(page.getByTestId("auto-label")).toHaveText("Retried with Opus 5.5 · high");
      await expect(page.getByTestId("pin-model")).toHaveCount(0);
    });

    test("Pin this model leaves Auto: the picker shows the concrete model and the next send carries it", async ({ page }) => {
      const sent = await setup(page, { team, convModel: "auto", messages: thread });
      await page.getByTestId("pin-model").click();
      await expect(page.getByTestId("model-pill")).toContainText("Sonnet 5.5");
      await page.getByPlaceholder("Message").fill("next");
      await page.getByRole("button", { name: /send/i }).click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0].model).toBe("claude-sonnet-5-5");
      expect(sent[0].override).toBeUndefined();
    });

    test("Settings: explains Auto, keeps the shadow toggle, shows last-30-day counts by chosen model", async ({ page }) => {
      await mockApp(page, team ? { team: { hits403: [] } } : {});
      await page.route(/\/api\/usage/, (r: Route) => r.fulfill({ json: { byRoute: [
        { model: "claude-sonnet-5-5", routedModel: "claude-sonnet-5-5", routedBy: "auto-route", n: 7 }, { model: "claude-haiku-5-5", routedModel: "claude-haiku-5-5", routedBy: "auto-route", n: 3 },
        { model: "claude-opus-5-5", routedModel: "claude-haiku-5-5", routedBy: "auto", n: 99 }] } }));
      await page.route(/\/api\/settings\/auto-shadow$/, (r: Route) => r.fulfill({ json: { enabled: false } }));
      await page.goto("/settings"); await page.waitForLoadState("networkidle");
      const info = page.getByTestId("auto-info");
      await expect(info).toContainText("Pick \"Auto\" in a chat's model list");
      await expect(info).toContainText("never the default");
      const counts = page.getByTestId("auto-counts");
      await expect(counts).toContainText("Sonnet 5.5");
      await expect(counts).toContainText("7");
      await expect(counts).toContainText("Haiku 5.5");
      await expect(counts).not.toContainText("Opus");              // shadow rows are not applied routes
      await expect(page.getByTestId("auto-shadow-toggle")).toBeVisible();
    });

    test("Settings: optional spend ceiling is empty by default, saves a number, and clears", async ({ page }) => {
      await mockApp(page, team ? { team: { hits403: [] } } : {});
      await page.route(/\/api\/usage/, (r: Route) => r.fulfill({ json: { byRoute: [] } }));
      let usd: number | null = null; const puts: unknown[] = [];
      await page.route(/\/api\/settings\/auto-max-usd$/, (r: Route) => {
        if (r.request().method() === "PUT") { const b = r.request().postDataJSON(); puts.push(b); usd = b.usd; return r.fulfill({ json: { usd } }); }
        return r.fulfill({ json: { usd } });
      });
      await page.goto("/settings"); await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("auto-ceiling-setting")).toContainText("empty = none");
      const input = page.getByTestId("auto-ceiling-input");
      await expect(input).toHaveValue("");
      await input.fill("1.5"); await input.press("Enter");
      await expect.poll(() => puts.length).toBe(1);
      expect(puts[0]).toEqual({ usd: 1.5 });
      await input.fill(""); await input.press("Enter");
      await expect.poll(() => puts.length).toBe(2);
      expect(puts[1]).toEqual({ usd: null });
    });
  });
}
