import { test, expect, switchMode, expectMode } from "./fixtures";

// Remote mode is read-only. The e2e user is served fixed synthetic sessions (host `e2e-host`) by the Worker itself, never real
// ones from remote-hub (steering is simulated in D1 `e2e_commands`, see src/remote.ts); the real binding path is covered by the Worker unit tests (test/remote.test.ts).
const enc = encodeURIComponent;
const RUNNING = "e2e-host:lane2:e2e-running", DONE = "e2e-host:lane2:e2e-done";

test.describe("remote mode (read-only)", () => {
  // page.route() does not see requests made through a service worker in WebKit; block the SW so the mocked hub is seen in both engines.
  test.use({ serviceWorkers: "block" });
  test("tab reaches Remote and back; list shows running / done / failed / stale badges", async ({ app: { page } }) => {
    await page.goto("/");
    await switchMode(page, "remote");
    await expect(page).toHaveURL(/\/remote$/);
    await expectMode(page, "remote");
    const rows = page.getByTestId("remote-row");
    await expect(rows).toHaveCount(4);
    const by = (n: string) => rows.filter({ hasText: n });
    await expect(by("e2e-running").getByTestId("remote-status")).toHaveText("running");
    await expect(by("e2e-done").getByTestId("remote-status")).toHaveText("done");
    await expect(by("e2e-failed").getByTestId("remote-status")).toHaveText("failed");
    await expect(by("e2e-stale").getByTestId("remote-status")).toHaveText("stale");
    await switchMode(page, "chat");
    await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
  });

  test("running session: brief, live transcript, read-only notice, no input anywhere", async ({ app: { page } }) => {
    await page.goto("/remote");
    await page.getByTestId("remote-row").filter({ hasText: "e2e-running" }).click();
    await expect(page).toHaveURL(/\/m\/e2e-host%3Alane2%3Ae2e-running$/);
    await expect(page.getByTestId("remote-brief")).toContainText("still running");
    await expect(page.getByTestId("remote-tail")).toContainText("FIXTURE-TAIL-OK");
    await expect(page.getByTestId("remote-meta")).toContainText("running for");
    await expect(page.getByTestId("remote-note")).toContainText("read-only");
    // a running session cannot be steered: the button is disabled, says why, and there is nothing to type into
    await expect(page.getByTestId("followup-open")).toBeDisabled();
    await expect(page.getByTestId("followup-blocked")).toContainText("running");
    await expect(page.locator("main input, main textarea, main select")).toHaveCount(0);
  });

  test("finished session: report rendered as sanitized markdown", async ({ app: { page } }) => {
    let dialogs = 0; page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
    await page.goto(`/m/${enc(DONE)}`);
    const rep = page.getByTestId("remote-report");
    await expect(rep.locator("h2")).toHaveText("Report");
    await expect(rep.locator("li")).toHaveCount(2);
    await expect(rep.locator("strong")).toHaveText("report");
    await expect(rep.locator("script")).toHaveCount(0);
    await expect(page.getByTestId("remote-meta")).toContainText("exit 0");
    await page.waitForTimeout(500);
    expect(dialogs).toBe(0);
    await page.getByTestId("remote-back").click();
    await expect(page).toHaveURL(/\/remote$/);
  });

  test("live transcript updates by itself while running, stops polling once done", async ({ app: { page } }) => {
    const base = { id: RUNNING, host: "e2e-host", kind: "lane2", name: "e2e-running", status: "running", started_at: 1700000000, ended_at: null, cwd: "", brief: "b", exit_code: null, session_ref: null, updated_at: 1, stale: false, report: "" };
    let hits = 0, phase: "a" | "b" | "done" = "a", after = 0;
    await page.route(new RegExp(`/api/remote/sessions/${enc(RUNNING)}$`), (r) => {
      hits++; if (phase === "done") after++;
      return r.fulfill({ json: { ...base, status: phase === "done" ? "done" : "running", ended_at: phase === "done" ? 1700000100 : null, tail: phase === "a" ? "line-one" : "line-one\nline-two-NEW" } });
    });
    await page.goto(`/m/${enc(RUNNING)}`);
    await expect(page.getByTestId("remote-tail")).toHaveText("line-one");
    phase = "b";
    await expect(page.getByTestId("remote-tail")).toContainText("line-two-NEW", { timeout: 25_000 });
    phase = "done"; after = 0;
    await expect(page.getByTestId("remote-status")).toHaveText("done", { timeout: 25_000 });
    const settled = after; await page.waitForTimeout(13_000);
    expect(after, "polling must stop once the session is no longer running").toBe(settled);
    expect(hits).toBeGreaterThan(2);
  });

  test("hub unavailable: list and detail say so, keep what they had, and recover by themselves", async ({ app: { page } }) => {
    let down = false;
    await page.route(/\/api\/remote\/sessions(\?.*)?$/, (r) => down ? r.fulfill({ status: 502, json: { error: "remote hub unavailable" } }) : r.continue());
    await page.goto("/remote");
    await expect(page.getByTestId("remote-row")).toHaveCount(4);
    down = true;
    await expect(page.getByTestId("remote-problem")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("remote-row")).toHaveCount(4); // last list stays
    down = false;
    await expect(page.getByTestId("remote-problem")).toBeHidden({ timeout: 25_000 });
  });

  test("unknown session: clear 'not found' with a way out", async ({ app: { page } }) => {
    await page.goto(`/m/${enc("e2e-host:lane2:nope")}`);
    await expect(page.getByTestId("remote-missing")).toBeVisible();
    await page.getByRole("button", { name: "Back to sessions" }).click();
    await expect(page).toHaveURL(/\/remote$/);
  });

  test("API: read-only, e2e user never reaches real sessions, bad input refused", async ({ app: { api } }) => {
    expect((await api.get("/api/remote/config").then((r) => r.json())).readOnly).toBe(true);
    expect((await api.get("/api/remote/sessions?status=bogus")).status()).toBe(400);
    expect((await api.get(`/api/remote/sessions/${enc("build-host:lane2:anything")}`)).status()).toBe(404); // real host ids are not visible to e2e scope
    expect((await api.get(`/api/remote/sessions/${enc("../../x")}`)).status()).toBe(404);
    const list = (await (await api.get("/api/remote/sessions")).json()).sessions as { host: string }[];
    expect(list.every((s) => s.host === "e2e-host")).toBe(true);
    for (const m of ["POST", "PATCH", "DELETE"] as const) expect((await api.mut(m, `/api/remote/sessions/${enc(DONE)}`, {})).status()).toBe(404);
  });

  // ---- steering: compose -> create (pending) -> confirm screen -> explicit "Send to <name>" -> audit ----
  // A command left `pending` by an earlier test/run (e.g. an expired confirmation) keeps the follow-up button disabled ("already in flight"): reject strays first so the suite heals itself.
  test.beforeEach(async ({ app: { api } }) => {
    const d = await (await api.get(`/api/remote/sessions/${enc(DONE)}`)).json();
    for (const c of d.commands ?? []) if (c.state === "pending") await api.mut("POST", `/api/remote/commands/${c.id}/reject`, {});
  });
  const openDone = async (page: import("@playwright/test").Page) => { await page.goto(`/m/${enc(DONE)}`); await expect(page.getByTestId("followup-open")).toBeEnabled(); };
  const compose = async (page: import("@playwright/test").Page, text: string) => {
    await page.getByTestId("followup-open").click();
    await page.getByTestId("followup-text").fill(text);
    await page.getByTestId("followup-review").click();
    await expect(page.getByTestId("followup-confirm")).toBeVisible();
  };
  const row = (page: import("@playwright/test").Page, text: string) => page.getByTestId("cmd-row").filter({ hasText: text }).first();

  test("follow-up is blocked with a reason on a runner session and on a stale-running one", async ({ app: { page } }) => {
    await page.goto(`/m/${enc("e2e-host:runner:e2e-failed")}`);
    await expect(page.getByTestId("followup-open")).toBeDisabled();
    await expect(page.getByTestId("followup-blocked")).toContainText("lane2");
    await page.goto(`/m/${enc("e2e-host:lane2:e2e-stale")}`);
    await expect(page.getByTestId("followup-open")).toBeDisabled(); // status is still `running` as far as the hub knows
  });

  test("confirm is required: review shows exact text + target + cwd, nothing is sent until 'Send to <name>', then the audit walks to done", async ({ app: { page, api } }) => {
    await openDone(page);
    const text = `please continue ${Date.now()}`;
    await compose(page, text);
    await expect(page.getByTestId("confirm-text")).toHaveText(text);
    await expect(page.getByTestId("confirm-target")).toHaveText("e2e-done");
    await expect(page.getByTestId("confirm-cwd")).toHaveText("/srv/e2e/demo");
    await expect(page.getByTestId("confirm-send")).toHaveText("Send to e2e-done");
    // the command exists but is still pending: creating it does not send anything
    const d = await (await api.get(`/api/remote/sessions/${enc(DONE)}`)).json();
    expect(d.commands.find((c: any) => c.text === text).state).toBe("pending");
    await page.waitForTimeout(7000); // pending must stay pending however long we wait
    expect((await (await api.get(`/api/remote/sessions/${enc(DONE)}`)).json()).commands.find((c: any) => c.text === text).state).toBe("pending");
    await page.getByTestId("confirm-send").click();
    await expect(page.getByTestId("followup-confirm")).toBeHidden();
    await expect(page.getByTestId("followup-blocked")).toContainText("in flight");
    await expect(row(page, text).getByTestId("cmd-state")).toHaveText("done", { timeout: 40_000 });
    await expect(row(page, text).getByTestId("cmd-result")).toContainText("ok");
    await expect(page.getByTestId("followup-open")).toBeEnabled();
  });

  test("cancel (button or tapping outside) rejects the pending command; it can never be approved afterwards", async ({ app: { page, api } }) => {
    await openDone(page);
    const t1 = `cancel me ${Date.now()}`;
    await compose(page, t1);
    await page.getByTestId("confirm-cancel").click();
    await expect(page.getByTestId("followup-confirm")).toBeHidden();
    await expect(row(page, t1).getByTestId("cmd-state")).toHaveText("rejected");
    await expect(row(page, t1)).toContainText("cancelled by e2e-bot");
    await expect(page.getByTestId("followup-open")).toBeEnabled();
    const t2 = `dismiss me ${Date.now()}`;
    await compose(page, t2);
    await page.locator(".scrim").first().click({ position: { x: 5, y: 5 } }); // the scrim (on desktop the sidebar sits left of it: a page-corner click misses)
    await expect(page.getByTestId("followup-confirm")).toBeHidden();
    await expect(row(page, t2).getByTestId("cmd-state")).toHaveText("rejected");
    const cmds = (await (await api.get(`/api/remote/sessions/${enc(DONE)}`)).json()).commands as { id: string; text: string }[];
    const id = cmds.find((c) => c.text === t1)!.id;
    expect((await api.mut("POST", `/api/remote/commands/${id}/approve`, { nonce: "x".repeat(48) })).status()).toBe(409);
  });

  test("refused / failed results are shown in the audit", async ({ app: { page } }) => {
    for (const [word, state, msg] of [["REFUSEME", "refused", "allowlist"], ["FAILME", "failed", "simulated failure"]] as const) {
      await openDone(page);
      const text = `${word} ${Date.now()}`;
      await compose(page, text);
      await page.getByTestId("confirm-send").click();
      await expect(row(page, text).getByTestId("cmd-state")).toHaveText(state, { timeout: 40_000 });
      await expect(row(page, text).getByTestId("cmd-result")).toContainText(msg);
    }
  });

  test("an expired confirmation says so, needs an explicit refresh, then a fresh tap on Send", async ({ app: { page } }) => {
    await openDone(page);
    const text = `expired nonce ${Date.now()}`;
    let first = true;
    await page.route(/\/api\/remote\/commands\/[\w-]+\/approve$/, (r) => { if (first) { first = false; return r.fulfill({ status: 403, json: { error: "bad or expired nonce" } }); } return r.continue(); });
    await compose(page, text);
    await page.getByTestId("confirm-send").click();
    await expect(page.getByTestId("followup-error")).toContainText("expired");
    await expect(page.getByTestId("confirm-send")).toHaveCount(0); // no silent retry: Send is replaced by Refresh
    await page.getByTestId("confirm-refresh").click();
    await expect(page.getByTestId("confirm-send")).toBeVisible();
    await page.getByTestId("confirm-send").click();
    await expect(row(page, text).getByTestId("cmd-state")).toHaveText("done", { timeout: 40_000 });
  });

  test("server refusals show inline: secret-shaped text is rejected and nothing is created", async ({ app: { page, api } }) => {
    await openDone(page);
    await page.getByTestId("followup-open").click();
    await page.getByTestId("followup-text").fill("here is SECRETSHAPE");
    await page.getByTestId("followup-review").click();
    await expect(page.getByTestId("followup-error")).toContainText("secret");
    await expect(page.getByTestId("followup-confirm")).toHaveCount(0);
    const cmds = (await (await api.get(`/api/remote/sessions/${enc(DONE)}`)).json()).commands as { text: string }[];
    expect(cmds.some((c) => c.text.includes("SECRETSHAPE"))).toBe(false);
  });

  test("API: steering needs CSRF + nonce, real session ids are unreachable for the e2e user", async ({ app: { page, api } }) => {
    expect((await api.mut("POST", "/api/remote/commands", { session_id: "build-host:lane2:steer-test-erich", text: "x" })).status()).toBe(404);
    expect((await api.mut("POST", "/api/remote/commands", { session_id: "../x", text: "x" })).status()).toBe(400);
    expect((await api.mut("POST", "/api/remote/commands/abc/approve", {})).status()).toBe(400);
    const naked = await page.request.post("/api/remote/commands", { data: { session_id: DONE, text: "x" }, headers: { origin: (process.env.E2E_BASE_URL ?? "https://app.internal.invalid").replace(/\/$/, "") } });
    expect(naked.status()).toBe(403); // no CSRF header
  });

  test("layout at 320px: confirm screen and follow-up log fit, no horizontal scroll", async ({ app: { page } }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openDone(page);
    await compose(page, "x".repeat(300) + " https://example.com/" + "a".repeat(120));
    const box = (await page.getByTestId("followup-confirm").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
    for (const id of ["confirm-cancel", "confirm-send"]) { const b = (await page.getByTestId(id).boundingBox())!; expect(b.x + b.width, id).toBeLessThanOrEqual(320); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.getByTestId("confirm-cancel").click();
    await expect(page.getByTestId("cmd-row").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});
