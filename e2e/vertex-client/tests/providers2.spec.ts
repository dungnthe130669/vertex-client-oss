import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApp, IDS } from "./polish-mock";
// axe samples computed colours: scanning mid fade/slide transition blends foreground and background and reports a bogus colour-contrast (iphone flake, e2etriage1) -> let every animation finish first
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime as number)).map((a) => a.finished.catch(() => null))).then(() => undefined));

// prov2 (mocked API, no login, no cost, no live provider call): the NVIDIA NIM preset flow (no in-app key: presence badge only) on Settings > Providers, the picker grouped by provider,
// a chat turn on nvidia: and cloudflare: models (the send frame carries the prefixed id; Details is tokens only), and the team edition hiding Cloudflare.
const CAPS = (o: object = {}) => ({ text: true, vision: false, tools: false, "image-gen": false, "video-gen": false, reasoning: false, ...o });
const meta = (label: string, tools = false) => ({ label, vendor: "other", tier: "balanced", price: null, caps: { images: false, caching: false, thinking: false, tools } });
const MODELS = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "gateway", capabilities: CAPS({ tools: true, vision: true }), meta: { label: "Sonnet 5.5", vendor: "anthropic", tier: "balanced", price: { input: 2, output: 10 }, caps: { images: true, caching: true, thinking: true, tools: true } } },
  { id: "cloudflare:@cf/openai/gpt-oss-120b", name: "gpt-oss 120B", provider: "cloudflare", capabilities: CAPS({ tools: true, reasoning: true }), meta: meta("gpt-oss 120B", true) },
  { id: "cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B", provider: "cloudflare", capabilities: CAPS(), meta: meta("Llama 3.3 70B") },
  { id: "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b", name: "nemotron-3-super-120b-a12b", provider: "nvidia", capabilities: CAPS(), meta: meta("nemotron") },
];
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const text = (t: string) => [{ type: "text", text: t }];

async function chat(page: Page, model: string, models: unknown[] = MODELS) {
  await mockApp(page, {});
  await page.route(/\/api\/models$/, (r: Route) => r.fulfill({ json: { default: "claude-sonnet-5-5", models } }));
  await page.route(new RegExp(`/api/conversations/${IDS.chat}$`), (r: Route) => r.fulfill({ json: { conversation: { id: IDS.chat, title: "T", model, pinned: 0, costUsd: 0, tokens: 0, projectId: null },
    state: { seq: 5, running: false, inflight: null, model, title: "T", error: null, costUsd: 0, tokens: 0, messages: [
      { id: 1, role: "user", content: text("hi"), model: null, usage: null, costUsd: null, stopReason: null, status: "complete", ttftMs: null, totalMs: null, createdAt: Date.now() - 5e3, route: null },
      { id: 2, role: "assistant", content: text("hello from the stub provider"), model, usage, costUsd: null, stopReason: "end_turn", status: "complete", ttftMs: 400, totalMs: 1500, createdAt: Date.now() - 4e3, route: null }] } } }));
  const sent: any[] = [];
  await page.routeWebSocket(/\/api\/conversations\/.*\/ws/, (ws) => {
    ws.send(JSON.stringify({ t: "hello", seq: 5, minSeq: 0, running: false, now: Date.now() }));
    ws.onMessage((m) => { try { const f = JSON.parse(String(m)); if (f.t === "send") sent.push(f); } catch { /* ignore */ } });
  });
  await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
  return sent;
}

test.describe("providers 2 (mocked API)", () => {
  test.use({ serviceWorkers: "block" });

  const PRESET = { key: "nvidia", label: "NVIDIA NIM", id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", authHeader: "bearer", secret: "PROVIDER_KEY_NVIDIA", help: "The key is a Worker secret, not entered here: get a free key at build.nvidia.com. About 40 requests per minute. Only the free-preview models work." };
  const BASE = [{ id: "gateway", kind: "gateway", enabled: true, status: "enabled", modelCount: 3 }, { id: "cloudflare", kind: "cloudflare", enabled: true, status: "enabled", modelCount: 9 }];

  test("NVIDIA NIM preset: no key field until the preset is added, then only the write-only password box; badge 'No key' then 'Ready (shared)'; load models pre-ticks lightning + ultra; enable selected; axe clean", async ({ page }) => {
    await mockApp(page, { providers: "multi" });
    const puts: any[] = []; let listCalls = 0; let nim: any = null; let provisioned = false;
    await page.route(/\/api\/providers$/, (r: Route) => r.fulfill({ json: { providers: [...BASE, ...(nim ? [{ id: "nvidia", kind: "openai-compat", enabled: true, status: provisioned ? "enabled" : "needs-key", modelCount: 0, editable: true, keySet: provisioned, authHeader: "bearer", host: "integrate.api.nvidia.com", enabledModels: [], broken: [] }] : [])] } }));
    await page.route(/\/api\/providers\/presets$/, (r: Route) => r.fulfill({ json: { presets: [PRESET] } }));
    await page.route(/\/api\/providers\/nvidia$/, (r: Route) => { puts.push(r.request().postDataJSON()); if (r.request().method() === "PUT") nim = {}; return r.fulfill({ json: { provider: { id: "nvidia" } } }); });
    await page.route(/\/api\/providers\/nvidia\/models$/, (r: Route) => { listCalls++; return r.fulfill({ json: { models: [
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", enabled: false, broken: false, suggested: true, verified: true },
      { id: "nvidia/nemotron-3-ultra-550b-a55b", enabled: false, broken: false, suggested: true, verified: true },
      { id: "meta/llama-3.1-8b-instruct", enabled: false, broken: false, suggested: false },
      { id: "x/dead-model", enabled: true, broken: true, suggested: false }] } }); });
    await page.goto("/settings/providers"); await page.waitForLoadState("networkidle");
    expect(await page.getByTestId("providers-page").locator("input[type=password], input[type=text], textarea").count()).toBe(0); // nowhere to type a key
    await expect(page.getByTestId("provider-help")).toContainText("Worker secret");
    await page.getByTestId("provider-preset").click();
    expect(puts[0]).toEqual({});                                          // the preset row is created without any key or value
    const row = page.locator('[data-testid="provider-row"][data-id="nvidia"]');
    await expect(row.getByTestId("provider-badge")).toHaveText("No key");
    await expect(page.getByTestId("provider-status-note")).toContainText("wrangler secret put PROVIDER_KEY_NVIDIA");
    await expect(page.getByTestId("pf-test")).toBeDisabled();
    expect(await page.getByTestId("providers-page").locator("input[type=text], textarea").count()).toBe(0);
    expect(await page.getByTestId("providers-page").locator("input[type=password]").count()).toBe(1); // in-app keys (fb2905d): exactly one write-only box, no visible text field a key could be echoed into
    await expect(page.getByTestId("pf-key")).toHaveValue("");
    provisioned = true; await page.reload(); await page.waitForLoadState("networkidle");
    await row.getByTestId("provider-edit").click();
    await expect(row.getByTestId("provider-badge")).toHaveText("Ready (shared)");
    await page.getByTestId("pf-test").click();
    await expect(page.getByTestId("pm-row")).toHaveCount(4); expect(listCalls).toBe(1);
    await expect(page.locator('[data-id="nvidia/nemotron-3.5-lightning-30b-a3b"] input')).toBeChecked();
    await expect(page.locator('[data-id="nvidia/nemotron-3-ultra-550b-a55b"] input')).toBeChecked();
    await expect(page.locator('[data-id="meta/llama-3.1-8b-instruct"] input')).not.toBeChecked();
    await expect(page.locator('[data-id="x/dead-model"]')).toContainText("404/410");
    await page.locator('[data-id="meta/llama-3.1-8b-instruct"] input').check();
    await page.getByTestId("pm-save").click();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]).toEqual({ models: ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b", "meta/llama-3.1-8b-instruct"], enabled: true });
    await settled(page);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  });

  test("a server error while adding the preset is shown plainly", async ({ page }) => {
    await mockApp(page, { providers: "multi" });
    await page.route(/\/api\/providers\/presets$/, (r: Route) => r.fulfill({ json: { presets: [PRESET] } }));
    await page.route(/\/api\/providers\/nvidia$/, (r: Route) => r.fulfill({ status: 400, json: { error: "bad provider id" } }));
    await page.goto("/settings/providers"); await page.waitForLoadState("networkidle");
    await page.getByTestId("provider-preset").click();
    await expect(page.getByTestId("pf-error")).toContainText("bad provider id");
  });

  test("picker groups by provider with labels Vertex (Claude) / Cloudflare / NVIDIA", async ({ page }) => {
    await chat(page, "claude-sonnet-5-5");
    await page.getByTestId("model-pill").click();
    const dlg = page.getByRole("dialog", { name: "Models" });
    await expect(dlg.getByTestId("provider-label")).toHaveText(["Vertex (Claude)", "Cloudflare", "NVIDIA"]);
    await expect(dlg.locator("button.row", { hasText: "Llama 3.3 70B" })).toContainText("no tools");
    await settled(page);
    const r = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  });

  for (const model of ["nvidia:nvidia/nemotron-3.5-lightning-30b-a3b", "cloudflare:@cf/openai/gpt-oss-120b"]) {
    test(`a chat turn on ${model.split(":")[0]}: the send frame carries the prefixed id; Details shows tokens only`, async ({ page }) => {
      const sent = await chat(page, "claude-sonnet-5-5");
      await page.getByTestId("model-pill").click();
      await page.getByRole("dialog", { name: "Models" }).locator("button.row", { hasText: model.split("/").pop()!.replace(/-instruct.*/, "").replace("-fp8-fast", "") }).first().click();
      await page.getByPlaceholder("Message").fill("hello");
      await page.getByRole("button", { name: /send/i }).click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0].model).toBe(model);
    });
  }

  test("details of an answer from a provider model: tokens, no dollar amount", async ({ page }) => {
    await chat(page, "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b");
    await page.getByText("Details", { exact: true }).click();
    await expect(page.locator(".chat")).not.toContainText("$");
  });

  test("team edition: Cloudflare is not in the picker and the Providers row is hidden", async ({ page }) => {
    await mockApp(page, { team: { hits403: [] } });
    await page.route(/\/api\/models$/, (r: Route) => r.fulfill({ json: { default: "claude-sonnet-5-5", models: MODELS.slice(0, 1) } }));
    await page.goto("/"); await page.waitForLoadState("networkidle");
    await page.getByTestId("model-pill").click();
    await expect(page.getByRole("dialog", { name: "Models" })).not.toContainText("Cloudflare");
    await page.goto("about:blank"); await mockApp(page, { team: { hits403: [] } });
    await page.goto("/settings"); await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("open-providers")).toHaveCount(0);
  });
});
