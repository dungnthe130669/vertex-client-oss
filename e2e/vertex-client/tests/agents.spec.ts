import { test, expect, type Api, switchMode, expectMode } from "./fixtures";

// Tests tagged @desktop-only wake a real agent (minutes + money each) and run once, on desktop-chromium: the iphone-webkit project
// excludes them via grepInvert in playwright.config.ts (by design, so they never show up as "skipped").
// Agents mode against the real agent-spike. Agents are named `e2e-*` (the server scopes e2e-bot to that prefix) and confined to a
// spike-base/* branch of the allowlisted test repo. Tasks are read-only ("reply with …, touch nothing") so no branch is produced.
const REPO = "example-user/example-repo";
const BASE = "spike-base/stats-bug";
const NAME = () => `e2e-ag-${Date.now().toString(36)}`;

async function purgeAll(api: Api) {
  const j = await (await api.get("/api/agents")).json().catch(() => ({ agents: [] }));
  for (const a of j.agents ?? []) await api.mut("DELETE", `/api/agents/${a.name}`, {}).catch(() => null);
}
async function create(api: Api, name: string, instructions = "You are a terse test agent. Never modify files or run git. Answer in one short line.") {
  const r = await api.mut("POST", "/api/agents", { name, repo: REPO, base: BASE, instructions });
  expect(r.status(), await r.text()).toBe(201);
}

test.describe("agents mode", () => {
  test.setTimeout(420_000);
  test.describe.configure({ retries: 0 }); // real agent wake-ups cost minutes each; a retry would double the suite, not add signal

  test("tabs reach Agents and back", async ({ app: { page } }) => {
    await page.goto("/");
    await switchMode(page, "agents");
    await expect(page).toHaveURL(/\/agents$/);
    await expectMode(page, "agents");
    await switchMode(page, "cloud");
    await expect(page).toHaveURL(/\/cloud$/);
  });

  test("scope: bad prefix and foreign names are refused before reaching agent-spike", async ({ app: { api } }) => {
    expect((await api.mut("POST", "/api/agents", { name: "plain-agent", repo: REPO, base: BASE })).status()).toBe(400);
    expect((await api.mut("POST", "/api/agents", { name: NAME(), repo: "evil/x", base: BASE })).status()).toBe(403);
    expect((await api.mut("POST", "/api/agents", { name: NAME(), repo: REPO, base: "main" })).status()).toBe(403);
    expect((await api.get("/api/agents/some-main-agent")).status()).toBe(404);
    expect((await api.mut("POST", "/api/agents/some-main-agent/inbox", { text: "x" })).status()).toBe(404);
    const list = (await (await api.get("/api/agents")).json()).agents as { name: string }[];
    expect(list.every((a) => a.name.startsWith("e2e-"))).toBe(true);
  });

  test("create in the UI, message it, see the reply, live stream, list shows state (no per-item cost), edit, delete @desktop-only", async ({ app: { page, api } }) => {
    const name = NAME();
    try {
      await page.goto("/agents");
      await page.getByTestId("new-agent-fab").click();
      await page.getByTestId("agent-name").fill(name);
      await page.getByTestId("agent-base").fill(BASE);
      await page.getByTestId("agent-instructions").fill("You are a terse test agent. Never modify files or run git. Answer in one short line.");
      await page.getByTestId("agent-save").click();
      await expect(page).toHaveURL(new RegExp(`/a/${name}$`));
      await expect(page.getByTestId("agent-state")).toHaveText("sleeping", { timeout: 30_000 });
      await page.getByTestId("agent-input").fill("Reply with exactly the word: pong-" + name.slice(-4));
      await page.getByTestId("agent-send").click();
      await expect(page.getByTestId("msg-text").first()).toContainText("pong-", { timeout: 15_000 });
      await expect(page.getByTestId("msg-reply").first()).toContainText("pong-" + name.slice(-4), { timeout: 300_000 });
      await expect(page.getByTestId("agent-live")).toBeVisible();          // live stream of the run is shown
      await expect(page.getByTestId("agent-state")).toHaveText(/awake|running/);
      await expect(page.getByTestId("agent-cost")).toHaveCount(0); // no per-run cost (usage1)
      // edit
      await page.getByTestId("agent-edit").click();
      await page.getByTestId("agent-instructions").fill("You are a terse test agent (edited).");
      await page.getByTestId("agent-save").click();
      await expect(page.getByTestId("agent-sheet")).toBeHidden();
      // list
      await page.getByRole("button", { name: "Back" }).click();
      const row = page.getByTestId("agent-row").filter({ hasText: name });
      await expect(row).toContainText(/awake|sleeping|running/);
      await expect(row).toContainText(/(awake|sleeping|running) · \S+ · \S/); // state · repo · last-active: the row renders no token/cost figure now
      await expect(row).not.toContainText("$"); // no cost on the item (326f435)
      // sleep / wake
      await row.click();
      await page.getByTestId("agent-sleep").click();
      await expect(page.getByTestId("agent-state")).toHaveText("sleeping", { timeout: 120_000 });
      await page.getByTestId("agent-wake").click();
      await expect(page.getByTestId("agent-state")).toHaveText(/awake|running/, { timeout: 180_000 });
      // delete
      await page.getByTestId("agent-delete").click();
      await page.getByTestId("confirm-ok").click();
      await expect(page).toHaveURL(/\/agents$/);
      await expect(page.getByTestId("agent-row").filter({ hasText: name })).toHaveCount(0, { timeout: 15_000 });
    } finally { await purgeAll(api); }
  });

  test("schedules: add, list, cancel", async ({ app: { page, api } }) => {
    const name = NAME();
    try {
      await create(api, name);
      await page.goto(`/a/${name}`);
      await page.getByTestId("panel-schedules").click();
      await expect(page.getByTestId("sched-empty")).toBeVisible();
      await page.getByTestId("sched-text").fill("never fires in this test");
      await page.getByTestId("sched-kind-every").click();
      await page.getByTestId("sched-value").fill("86400");
      await page.getByTestId("sched-add").click();
      await expect(page.getByTestId("sched-row")).toHaveCount(1);
      await expect(page.getByTestId("sched-row")).toContainText("every 86400s");
      await page.getByTestId("sched-cancel").click();
      await expect(page.getByTestId("sched-row")).toHaveCount(0);
      await expect(page.getByTestId("sched-empty")).toBeVisible();
      // server-side validation surfaces as an error, not a silent no-op
      const bad = await api.mut("POST", `/api/agents/${name}/schedules`, { text: "x" });
      expect(bad.status()).toBe(400);
    } finally { await purgeAll(api); }
  });

  test("stop a running agent task @desktop-only", async ({ app: { page, api } }) => {
    const name = NAME();
    try {
      await create(api, name);
      await page.goto(`/a/${name}`);
      await page.getByTestId("agent-input").fill("Run exactly this one bash command and wait for it: sleep 100. Then reply done.");
      await page.getByTestId("agent-send").click();
      await expect(page.getByTestId("agent-stop")).toBeVisible({ timeout: 120_000 });
      await page.getByTestId("agent-stop").click();
      await expect(page.getByTestId("agent-stop")).toBeHidden({ timeout: 120_000 });
    } finally { await purgeAll(api); }
  });

  test("rollover is offered and accepted for an awake agent @desktop-only", async ({ app: { page, api } }) => {
    const name = NAME();
    try {
      await create(api, name);
      await page.goto(`/a/${name}`);
      await page.getByTestId("agent-input").fill("Reply with exactly: ok");
      await page.getByTestId("agent-send").click();
      await expect(page.getByTestId("msg-reply").first()).toBeVisible({ timeout: 300_000 });
      await page.getByTestId("agent-rollover").click();
      await page.getByTestId("confirm-ok").click();
      await expect(page.getByTestId("agent-problem")).toBeHidden();
      await expect.poll(async () => (await (await api.get(`/api/agents/${name}`)).json()).agent.name, { timeout: 120_000 }).toBe(name);
    } finally { await purgeAll(api); }
  });
});
