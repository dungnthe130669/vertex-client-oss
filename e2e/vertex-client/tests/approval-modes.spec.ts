import { test as live, expect as liveExpect, openChat, uniq } from "./fixtures";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApp, IDS } from "./polish-mock";

// Approval modes (docs/design/approval-modes.md, option B). WRITTEN, NOT RUN by the author: the PO runs it.
// Part 1 is mocked (no login, no cost): the card buttons, the audit line, the Ask/Auto chip + first-time confirm, the allowed-hosts line, Settings > Approvals,
// at 390 px, light + dark, axe clean. Part 2 is live against the e2e user (Business space: the e2e user has no browse tools, so what it can prove live is the
// hard-ask rule: Auto never covers a write tool, plus the endpoints' auth).
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const serious = (r: Awaited<ReturnType<AxeBuilder["analyze"]>>) => r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`);

type Sent = Array<Record<string, unknown>>;
/** Mocked chat with a parked web approval (host + Always allowed), one audit line, one allowed host. Registered AFTER mockApp so these routes win. */
async function mockChat(page: Page, o: { approvalAuto?: boolean; mode?: "ask" | "auto" | "bypass"; canAlways?: boolean } = {}): Promise<Sent> {
  await mockApp(page);
  const sent: Sent = [];
  const call = { id: "tu_web", name: "web_read", input: { url: "https://news.example.org/world/today" }, decision: null, host: "news.example.org", canAlways: o.canAlways !== false };
  const messages = [
    { id: 1, role: "user", content: [{ type: "text", text: "What is in the news today?" }], model: null, usage: null, costUsd: null, stopReason: null, status: "done", ttftMs: null, totalMs: null, createdAt: Date.now() - 60e3 },
    { id: 2, role: "assistant", content: [{ type: "tool_use", id: "tu_auto", name: "web_read", input: { url: "https://wttr.in/Hanoi" } }, { type: "tool_use", id: "tu_web", name: "web_read", input: call.input }], model: "claude-sonnet-5-5", usage: null, costUsd: 0.001, stopReason: "tool_use", status: "done", ttftMs: 10, totalMs: 20, createdAt: Date.now() - 30e3 },
  ];
  await page.route(new RegExp(`/api/conversations/${IDS.chat}$`), (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    conversation: { id: IDS.chat, title: "News", model: "claude-sonnet-5-5", pinned: 0, costUsd: 0, tokens: 0, projectId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    state: { seq: 5, running: false, inflight: null, model: "claude-sonnet-5-5", title: "News", error: null, costUsd: 0, tokens: 0, messages, awaiting: { expiresAt: Date.now() + 29 * 60_000, calls: [call] },
      approvalMode: o.mode ?? "ask", webGrants: ["wttr.in"], approvalAuto: o.approvalAuto !== false, autoLog: { tu_auto: { name: "web_read", subject: "wttr.in", source: "chat-grant" } } } }) }));
  await page.routeWebSocket(/\/api\/conversations\/.*\/ws/, (ws) => {
    ws.send(JSON.stringify({ t: "hello", seq: 5, minSeq: 0, running: false, now: Date.now() }));
    let seq = 5;
    ws.onMessage((m) => {
      let f: Record<string, unknown>; try { f = JSON.parse(String(m)); } catch { return; }
      sent.push(f);
      // mirror the server: a mode command becomes an approval_mode event, except a Bypass without the confirmation, which is rejected
      if (f.t === "mode") {
        if (f.mode === "bypass" && !(f.confirmed === true && f.confirmVersion === 1)) ws.send(JSON.stringify({ t: "rejected", error: "Bypass needs an explicit confirmation. Pick Bypass again and confirm the dialog." }));
        else ws.send(JSON.stringify({ t: "ev", seq: ++seq, ts: Date.now(), e: { type: "approval_mode", mode: f.mode } }));
      }
    });
  });
  return sent;
}

test.describe("approval modes (mocked UI)", () => {
  test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

  test("web card: four buttons, the Always button names the host, each button sends the right grant; the audit line and allowed-hosts line show", async ({ page }) => {
    const sent = await mockChat(page);
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    const card = page.getByTestId("approval");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("approve-once")).toHaveText("Approve once");
    await expect(card.getByTestId("allow-chat")).toHaveText("Allow news.example.org in this chat");
    await expect(card.getByTestId("allow-always")).toHaveText("Always allow news.example.org");
    await expect(card.getByTestId("deny")).toHaveText("Deny");
    await expect(card.getByTestId("approval-expiry")).toContainText(/Expires in (29|30) min/);
    await expect(page.getByTestId("auto-allowed")).toHaveText("Auto-allowed web_read wttr.in - by your setting");
    await expect(page.getByTestId("chat-grants")).toContainText("wttr.in");
    for (const id of ["approve-once", "allow-chat", "allow-always", "deny"]) { const b = await card.getByTestId(id).boundingBox(); expect(b!.height, id).toBeGreaterThanOrEqual(44); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow at 390px").toBe(true);
    await card.getByTestId("allow-chat").click();
    await expect.poll(() => sent.find((m) => m.t === "approve")).toMatchObject({ t: "approve", id: "tu_web", decision: "approve", grant: "chat" });
  });

  test("Always allow sends grant=user; Approve once and Deny send no grant; without canAlways the Always button is absent", async ({ page }) => {
    const sent = await mockChat(page);
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await page.getByTestId("allow-always").click();
    await expect.poll(() => sent.filter((m) => m.t === "approve").length).toBe(1);
    expect(sent.find((m) => m.t === "approve")).toMatchObject({ grant: "user", decision: "approve" });
    const page2 = await page.context().newPage(); const sent2 = await mockChat(page2, { canAlways: false });
    await page2.goto(`/c/${IDS.chat}`); await page2.waitForLoadState("networkidle");
    await expect(page2.getByTestId("allow-always")).toHaveCount(0);
    await page2.getByTestId("approve-once").click(); await expect.poll(() => sent2.find((m) => m.t === "approve")).toMatchObject({ decision: "approve" });
    expect(sent2.find((m) => m.t === "approve")).not.toHaveProperty("grant");
    await page2.close();
  });

  test("allowed-hosts line: removing a host sends revoke_grant", async ({ page }) => {
    const sent = await mockChat(page);
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Stop allowing wttr.in in this chat" }).click();
    await expect.poll(() => sent.find((m) => m.t === "revoke_grant")).toMatchObject({ host: "wttr.in" });
  });

  test("composer chip: Ask by default, first Auto asks in plain words, confirm sends mode=auto, later toggles skip the dialog, Auto -> Ask is immediate", async ({ page }) => {
    const sent = await mockChat(page);
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await page.evaluate(() => localStorage.removeItem("vc.auto-approval-confirmed"));
    const chip = page.getByTestId("approval-chip");
    await expect(chip).toHaveText("Ask"); await expect(chip).toHaveAttribute("data-mode", "ask");
    expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await chip.click(); await page.getByTestId("mode-auto").click();
    const sheet = page.getByTestId("confirm-sheet");
    await expect(sheet).toBeVisible(); await expect(sheet).toContainText("Turn on Auto for this chat?"); await expect(sheet).toContainText("never covers");
    expect(await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze().then(serious), "axe with the Auto dialog open").toEqual([]);
    await page.getByTestId("confirm-cancel").click(); await expect(sheet).toHaveCount(0);
    expect(sent.filter((m) => m.t === "mode")).toEqual([]);
    await chip.click(); await page.getByTestId("mode-auto").click(); await page.getByTestId("confirm-ok").click();
    await expect.poll(() => sent.find((m) => m.t === "mode")).toMatchObject({ mode: "auto" });
    // a second chat session of the same browser: the dialog is not shown again
    await page.reload(); await page.waitForLoadState("networkidle");
    await page.getByTestId("approval-chip").click(); await page.getByTestId("mode-auto").click();
    await expect(page.getByTestId("confirm-sheet")).toHaveCount(0);
    await expect.poll(() => sent.filter((m) => m.t === "mode").length).toBe(2);
  });

  test("chat already in Auto: the chip says Auto and switching back sends mode=ask with no dialog", async ({ page }) => {
    const sent = await mockChat(page, { mode: "auto" });
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    const chip = page.getByTestId("approval-chip");
    await expect(chip).toHaveText("Auto"); await expect(chip).toHaveAttribute("data-mode", "auto");
    await chip.click(); await page.getByTestId("mode-ask").click(); await expect(page.getByTestId("confirm-sheet")).toHaveCount(0);
    await expect.poll(() => sent.find((m) => m.t === "mode")).toMatchObject({ mode: "ask" });
  });

  test("mode picker: three choices with English + Vietnamese text, current one checked; Bypass asks first in plain words (what it skips, what still asks), sends mode=bypass only on confirm; remembered afterwards", async ({ page }) => {
    const sent = await mockChat(page);
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await page.evaluate(() => localStorage.removeItem("vc.bypass-approval-confirmed"));
    const chip = page.getByTestId("approval-chip");
    await chip.click();
    await expect(page.getByTestId("mode-sheet")).toBeVisible();
    for (const m of ["ask", "auto", "bypass"]) { const r = page.getByTestId(`mode-${m}`); await expect(r).toBeVisible(); expect((await r.boundingBox())!.height, m).toBeGreaterThanOrEqual(44); }
    await expect(page.getByTestId("mode-ask")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("mode-bypass")).toContainText("always ask");
    await expect(page.getByTestId("mode-sheet").locator('[lang="vi"]').first()).toBeVisible();
    expect(await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze().then(serious), "axe with the mode picker open").toEqual([]);
    await page.getByTestId("mode-bypass").click();
    const sheet = page.getByTestId("bypass-sheet");
    await expect(sheet).toBeVisible(); await expect(page.getByTestId("bypass-skips")).toContainText("query string"); await expect(page.getByTestId("bypass-asks")).toContainText("deleting");
    await expect(page.getByTestId("bypass-asks")).toContainText("credentials"); await expect(page.getByTestId("bypass-asks")).toContainText("no timer");
    await expect(sheet.locator('[lang="vi"]').first()).toBeVisible(); await expect(page.getByTestId("bypass-asks")).toContainText("Vẫn hỏi");
    expect(await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze().then(serious), "axe with the Bypass dialog open").toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 390 px").toBe(true);
    await page.getByTestId("confirm-cancel").click(); expect(sent.filter((m) => m.t === "mode")).toEqual([]);
    await chip.click(); await page.getByTestId("mode-bypass").click(); await page.getByTestId("confirm-ok").click();
    await expect.poll(() => sent.find((m) => m.t === "mode")).toMatchObject({ t: "mode", mode: "bypass", confirmed: true, confirmVersion: 1 }); // the confirmation travels with the command
    await expect(chip).toHaveText("Bypass"); await expect(chip).toHaveAttribute("data-mode", "bypass"); // the mode really transitioned (mock mirrors the server)
    expect(await page.evaluate(() => localStorage.getItem("vc.bypass-approval-confirmed"))).toBe("1"); // remembered = the confirmed text version
    await chip.click(); await page.getByTestId("mode-ask").click(); // back to Ask: immediate, never a dialog, never a confirmation field
    await expect(chip).toHaveText("Ask"); await expect(page.getByTestId("confirm-sheet")).toHaveCount(0);
    expect(sent.filter((m) => m.t === "mode").at(-1)).toEqual({ t: "mode", mode: "ask" });
    await chip.click(); await page.getByTestId("mode-bypass").click(); // already confirmed in this browser: no dialog, and the command still carries the confirmation
    await expect(page.getByTestId("bypass-sheet")).toHaveCount(0);
    await expect.poll(() => sent.filter((m) => m.t === "mode").length).toBe(3);
    expect(sent.filter((m) => m.t === "mode").at(-1)).toMatchObject({ mode: "bypass", confirmed: true, confirmVersion: 1 });
    await expect(chip).toHaveText("Bypass");
    await page.evaluate(() => localStorage.setItem("vc.bypass-approval-confirmed", "0")); // a confirmation of an older text version no longer counts: the dialog is back
    await chip.click(); await page.getByTestId("mode-ask").click(); await expect(chip).toHaveText("Ask");
    await chip.click(); await page.getByTestId("mode-bypass").click(); await expect(page.getByTestId("bypass-sheet")).toBeVisible();
  });

  test("a chat already in Bypass shows it plainly on the chip (text, not colour alone) and Ask is one tap away", async ({ page }) => {
    const sent = await mockChat(page, { mode: "bypass", approvalAuto: false });
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    const chip = page.getByTestId("approval-chip");
    await expect(chip).toHaveText("Bypass"); await expect(chip).toHaveAttribute("data-mode", "bypass");
    await chip.click(); await expect(page.getByTestId("mode-auto")).toHaveCount(0); // admin switch off: only the current mode and Ask are offered
    await page.getByTestId("mode-ask").click();
    await expect.poll(() => sent.find((m) => m.t === "mode")).toMatchObject({ mode: "ask" });
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe (${scheme}): chat in Bypass with the picker closed`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, serviceWorkers: "block" }); const page = await ctx.newPage();
      await mockChat(page, { mode: "bypass" }); await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("approval-chip")).toHaveText("Bypass");
      expect(await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze().then(serious)).toEqual([]);
      await ctx.close();
    });
  }

  test("admin kill switch: no chip when Auto is off for the account (unless the chat is already in Auto)", async ({ page }) => {
    await mockChat(page, { approvalAuto: false });
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("approval-chip")).toHaveCount(0);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe (${scheme}): chat with the web card, audit line, chip and allowed-hosts line`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 390, height: 844 }, serviceWorkers: "block" }); const page = await ctx.newPage();
      await mockChat(page); await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle"); await page.waitForTimeout(300);
      await expect(page.getByTestId("approval-chip")).toBeVisible();
      expect(serious(await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())).toEqual([]);
      await ctx.close();
    });
  }

  test("Settings > Approvals: lists grants with dates, Revoke deletes exactly that host, empty state, axe clean (light + dark)", async ({ browser }) => {
    for (const scheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 390, height: 844 }, serviceWorkers: "block" }); const page = await ctx.newPage();
      await mockApp(page);
      let grants = [{ tool: "web_read", host: "news.example.org", createdAt: Date.now() - 86400e3, lastUsedAt: null }, { tool: "web_read", host: "wttr.in", createdAt: Date.now() - 2 * 86400e3, lastUsedAt: Date.now() }];
      const deleted: string[] = [];
      await page.route(/\/api\/approvals(\/.*)?$/, async (route) => {
        const u = new URL(route.request().url()); const m = route.request().method();
        if (m === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ autoAllowed: true, grants, audit: [{ tool: "web_read", host: "wttr.in", source: "user-grant", at: Date.now(), conversationId: "c" }] }) });
        const host = decodeURIComponent(u.pathname.split("/").pop()!); deleted.push(`${m} ${u.pathname}`); grants = u.pathname.endsWith("/grants") ? [] : grants.filter((g) => g.host !== host);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      });
      await page.goto("/settings/approvals"); await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("approval-grant")).toHaveCount(2);
      await expect(page.getByTestId("approval-grant-host").first()).toHaveText("news.example.org");
      await expect(page.getByTestId("approvals-audit")).toContainText("wttr.in");
      expect(serious(await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()), `axe ${scheme}`).toEqual([]);
      if (scheme === "dark") {
        await page.getByRole("button", { name: "Revoke news.example.org" }).click();
        await expect(page.getByTestId("approval-grant")).toHaveCount(1);
        expect(deleted).toEqual(["DELETE /api/approvals/grants/news.example.org"]);
        await page.getByRole("button", { name: "Revoke wttr.in" }).click();
        await expect(page.getByTestId("approval-grant")).toHaveCount(0); await expect(page.getByTestId("approvals-grants")).toContainText("Nothing yet");
      }
      await ctx.close();
    }
  });
});

// ---------- live (e2e user) ----------
live.describe("approval modes (live, e2e user)", () => {
  live("endpoints: GET /api/approvals answers for the caller only; a mutation without the CSRF token is refused; nothing can create a grant", async ({ app: { page, api }, baseURL }) => {
    const r = await api.get("/api/approvals"); liveExpect(r.status()).toBe(200);
    const j = await r.json(); liveExpect(Array.isArray(j.grants)).toBe(true); liveExpect(typeof j.autoAllowed).toBe("boolean");
    const bare = await page.context().request.delete(`${baseURL}/api/approvals/grants/example.org`, { headers: { origin: baseURL! }, failOnStatusCode: false }); // session cookie, but no x-csrf-token
    liveExpect(bare.status()).toBe(403);
    liveExpect((await api.mut("DELETE", "/api/approvals/grants/127.0.0.1")).status()).toBe(400);
    liveExpect((await api.mut("DELETE", "/api/approvals/grants/never-granted.example.org")).status()).toBe(404);
    for (const m of ["POST", "PUT"] as const) liveExpect([404, 405]).toContain((await api.mut(m, "/api/approvals/grants", { host: "evil.example" })).status());
  });

  live("Auto never covers a write: with Auto on, save_note still shows the approval card; Deny runs nothing; the mode survives a reload; Auto -> Ask is immediate", async ({ app: { page, api } }) => {
    const title = uniq("E2EAUTO");
    await openChat(page, await api.newChat());
    const chip = page.getByTestId("approval-chip");
    await liveExpect(chip).toHaveText("Ask");
    await page.evaluate(() => localStorage.removeItem("vc.auto-approval-confirmed"));
    await chip.click(); await page.getByTestId("mode-auto").click();
    await liveExpect(page.getByTestId("confirm-sheet")).toContainText("never covers");
    await page.getByTestId("confirm-ok").click();
    await liveExpect(chip).toHaveText("Auto");
    await page.reload(); await liveExpect(page.getByPlaceholder("Message")).toBeVisible();
    await liveExpect(page.getByTestId("approval-chip")).toHaveText("Auto"); // stored in the conversation, not in the browser
    await page.getByPlaceholder("Message").fill(`Use the save_note tool to save a note titled "${title}" with body "auto mode must still ask". Call the tool right now.`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const card = page.getByTestId("approval").first();
    await liveExpect(card).toBeVisible({ timeout: 90_000 });
    await liveExpect(card.getByTestId("allow-chat")).toHaveCount(0); // a write tool never offers an allowance
    await liveExpect(card.getByTestId("allow-always")).toHaveCount(0);
    await liveExpect(page.getByTestId("auto-allowed")).toHaveCount(0);
    await card.getByTestId("deny").click();
    await liveExpect(page.getByTestId("tool-card").filter({ hasText: "save_note" }).first()).toContainText(/error|Denied|declined/i, { timeout: 60_000 });
    // The chip is disabled while the turn runs (after Deny the model still answers) and the layout shifts as the reply streams in; a tap landing in that window
    // opens nothing (iphone-webkit flake, e2etriage1). Wait for the turn to settle (chip enabled), then open the sheet with a retry instead of a single blind click.
    await liveExpect(page.getByTestId("approval-chip")).toBeEnabled({ timeout: 90_000 });
    await liveExpect(async () => {
      if (!(await page.getByTestId("mode-ask").isVisible())) await page.getByTestId("approval-chip").click();
      await liveExpect(page.getByTestId("mode-ask")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByTestId("mode-ask").click();
    await liveExpect(page.getByTestId("confirm-sheet")).toHaveCount(0);
    await liveExpect(page.getByTestId("approval-chip")).toHaveText("Ask");
  });

  live("Settings > Approvals page loads for the e2e user with an empty list", async ({ app: { page } }) => {
    await page.goto("/settings/approvals");
    await liveExpect(page.getByTestId("approvals-page")).toBeVisible();
    await liveExpect(page.getByTestId("approvals-grants")).toBeVisible();
  });
});
