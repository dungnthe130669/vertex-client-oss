import { test as plain, expect as pexpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, ask, openChat, uniq } from "./fixtures";
import { mockApp, IDS } from "./polish-mock";

// Chat depth: starter cards, edit-any-message (fork), per-message actions menu, conversation info sheet, steadier streaming.
// Part 1 runs on the in-browser API mock (no login, no cost, deterministic); part 2 needs the live app (real streaming). CSSOM only (CSP style-src 'self').

const T = (text: string) => [{ type: "text", text }];
const msg = (id: number, role: "user" | "assistant", text: string) => ({ id, role, content: T(text), model: null, usage: null, costUsd: null, stopReason: null, status: "done", ttftMs: null, totalMs: null, createdAt: 1 });
const THREE_TURNS = [msg(1, "user", "first question"), msg(2, "assistant", "first **answer**\n\n```js\nconst a = 1;\n```"), msg(3, "user", "second question"), msg(4, "assistant", "second answer"), msg(5, "user", "third question"), msg(6, "assistant", "third answer")];
const FORK_ID = "00000000-0000-4000-8000-000000000999";

/** The mocked app with a richer chat: three turns, plus a recording fork / rename / delete / prompts API. */
/** The chat header's shared Chat actions menu: open it and choose an item. */
const chatMenuItem = async (page: import("@playwright/test").Page, id: string) => { await page.getByTestId("chat-header-menu").click(); await page.getByTestId(id).click(); };
const openChatInfo = (page: import("@playwright/test").Page) => chatMenuItem(page, "chat-menu-info");
async function mockDepth(page: import("@playwright/test").Page, o: { prompts?: boolean; erich?: boolean } = {}) {
  await mockApp(page, { erich: o.erich });
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route(/\/api\/(conversations|prompts)/, async (route) => {
    const r = route.request(); const p = new URL(r.url()).pathname; const m = r.method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/prompts" && m === "GET") return json({ prompts: o.prompts ? [{ id: "p1", title: "Weekly review", text: "Run my weekly review.", createdAt: "2026-01-01 00:00:00", updatedAt: "2026-01-01 00:00:00" }] : [] });
    if (p === `/api/conversations/${IDS.chat}` && m === "GET") {
      return json({ conversation: { id: IDS.chat, title: "Depth chat", model: "claude-sonnet-5-5", pinned: 0, costUsd: 0.0123, tokens: 2400, projectId: null, createdAt: "2026-10-01 09:00:00", updatedAt: "2026-10-02 10:30:00" },
        state: { seq: 2, running: false, inflight: null, model: "claude-sonnet-5-5", title: "Depth chat", error: null, costUsd: 0.0123, tokens: 2400, messages: THREE_TURNS } });
    }
    if (p === `/api/conversations/${IDS.chat}/fork` && m === "POST") { calls.push({ method: m, path: p, body: r.postDataJSON() }); return json({ id: FORK_ID, model: "claude-sonnet-5-5", title: "Depth chat (edited)", projectId: null }, 201); }
    if (p === `/api/conversations/${FORK_ID}` && m === "GET") return json({ conversation: { id: FORK_ID, title: "Depth chat (edited)", model: "claude-sonnet-5-5", pinned: 0, costUsd: 0, tokens: 0, projectId: null, createdAt: "2026-10-03 09:00:00", updatedAt: "2026-10-03 09:00:00" }, state: { seq: 0, running: false, inflight: null, model: "claude-sonnet-5-5", title: "Depth chat (edited)", error: null, costUsd: 0, tokens: 0, messages: THREE_TURNS.slice(0, 2) } });
    if (p === `/api/conversations/${IDS.chat}` && (m === "PATCH" || m === "DELETE")) { calls.push({ method: m, path: p, body: r.postDataJSON() }); return json({ ok: true }); }
    return route.fallback();
  });
  return calls;
}

plain.describe("chat depth (mocked app)", () => {
  plain.use({ serviceWorkers: "block" });

  plain("empty chat shows four starter cards that fill the composer; offers saved prompts only when any exist", async ({ page }) => {
    await mockDepth(page);
    await page.goto("/"); await page.waitForLoadState("networkidle");
    const cards = page.getByTestId("starter");
    await pexpect(cards).toHaveCount(4);
    await pexpect(page.getByTestId("starter-saved")).toHaveCount(0);
    const title = await cards.nth(1).locator("strong").innerText();
    await cards.nth(1).click();
    const box = page.getByPlaceholder("Message");
    await pexpect(box).not.toHaveValue("");
    await pexpect(box).toBeFocused();
    pexpect((await box.inputValue()).length).toBeGreaterThan(10);
    pexpect(title.length).toBeLessThan(25);
    for (let i = 0; i < 4; i++) pexpect((await cards.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44); // touch target
  });

  plain("saved prompts: the extra card opens the / library", async ({ page }) => {
    await mockDepth(page, { prompts: true });
    await page.goto("/"); await page.waitForLoadState("networkidle");
    await pexpect(page.getByTestId("starter")).toHaveCount(4);
    await page.getByTestId("starter-saved").click();
    await pexpect(page.getByPlaceholder("Message")).toHaveValue("/");
    await pexpect(page.getByTestId("slash-popover")).toBeVisible();
    await pexpect(page.getByTestId("slash-row").filter({ hasText: "Weekly review" }).or(page.getByTestId("slash-row").filter({ hasText: "weekly" }))).toHaveCount(1);
  });

  plain("starters are gone once the chat has messages", async ({ page }) => {
    await mockDepth(page);
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await pexpect(page.locator(".msg.user")).toHaveCount(3);
    await pexpect(page.getByTestId("starters")).toHaveCount(0);
  });

  plain("edit an earlier message: forks into a new chat, original untouched; the last message keeps the in-place edit", async ({ page }) => {
    const calls = await mockDepth(page);
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await pexpect(page.getByTestId("edit-msg")).toHaveCount(1); // last user message: refills the composer as before
    await pexpect(page.getByTestId("edit-earlier")).toHaveCount(2); // every earlier one
    const mid = page.getByTestId("edit-earlier").nth(1); // "second question"
    pexpect((await mid.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await mid.click();
    const sheet = page.getByTestId("edit-sheet");
    await pexpect(sheet).toBeVisible();
    await pexpect(page.getByTestId("edit-text")).toHaveValue("second question");
    await page.getByTestId("edit-text").fill("second question, reworded");
    await page.getByTestId("edit-fork-send").click();
    await pexpect(page).toHaveURL(new RegExp(`/c/${FORK_ID}$`));
    pexpect(calls).toEqual([{ method: "POST", path: `/api/conversations/${IDS.chat}/fork`, body: { message_id: 3 } }]);
    pexpect(calls.filter((c) => c.method !== "POST")).toEqual([]); // the original was never PATCHed/DELETEd
  });

  plain("edit sheet: Escape cancels, nothing is sent", async ({ page }) => {
    const calls = await mockDepth(page);
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await page.getByTestId("edit-earlier").first().click();
    await pexpect(page.getByTestId("edit-sheet")).toBeVisible();
    await pexpect(page.getByTestId("edit-text")).toBeFocused(); // the sheet's effects (focus, Escape listener) have run
    await page.keyboard.press("Escape");
    await pexpect(page.getByTestId("edit-sheet")).toHaveCount(0);
    pexpect(calls).toEqual([]);
  });

  plain("message actions: the menu has Copy as markdown + Select text only (Copy / Regenerate are the inline buttons); keyboard works", async ({ page, browserName }) => {
    await mockDepth(page);
    if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    const btns = page.getByTestId("msg-actions");
    await pexpect(btns).toHaveCount(3); // one per assistant message
    const bb = (await btns.first().boundingBox())!; pexpect(bb.width).toBeGreaterThanOrEqual(44); pexpect(bb.height).toBeGreaterThanOrEqual(44);
    // menu: no Copy, no Regenerate (they are inline buttons under the answer)
    await btns.first().focus(); await page.keyboard.press("Enter");
    const menu = page.getByTestId("msg-menu");
    await pexpect(menu).toBeVisible();
    await pexpect(menu.getByRole("menuitem")).toHaveText(["Copy as markdown", "Select text"]);
    await pexpect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown"); await pexpect(menu.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp"); await pexpect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("End"); await pexpect(menu.getByRole("menuitem").last()).toBeFocused();
    await page.keyboard.press("Escape");
    await pexpect(menu).toHaveCount(0);
    await pexpect(btns.first()).toBeFocused(); // focus returns to the opener
    // the last answer's menu has no Regenerate either; the inline button stays
    await btns.last().click();
    await pexpect(page.getByTestId("msg-regenerate")).toHaveCount(0);
    await pexpect(page.getByTestId("msg-copy")).toHaveCount(0);
    await pexpect(page.getByTestId("msg-menu").getByRole("menuitem")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await pexpect(page.getByTestId("regenerate").last()).toBeVisible(); // the inline Regenerate buttons stay
    await pexpect(page.getByRole("button", { name: "Copy answer" }).first()).toBeVisible();
    // copy as markdown writes the source markdown, not the rendered text
    await btns.first().click();
    await page.getByTestId("msg-copy-md").click();
    await pexpect(page.locator(".toast", { hasText: "markdown" })).toBeVisible();
    if (browserName === "chromium") pexpect(await page.evaluate(() => navigator.clipboard.readText())).toBe("first **answer**\n\n```js\nconst a = 1;\n```");
    // select text: plain text, pre-selected, in a dialog
    await btns.first().click();
    await page.getByTestId("msg-select").click();
    const sel = page.getByRole("dialog", { name: "Select text" });
    await pexpect(sel).toBeVisible();
    await pexpect(page.getByTestId("select-text")).toContainText("const a = 1;");
    pexpect(await page.evaluate(() => getSelection()?.toString() ?? "")).toContain("first **answer**");
    await page.keyboard.press("Escape");
    await pexpect(sel).toHaveCount(0);
  });

  plain("conversation info (stats only, from the Chat actions menu); rename, pin, export, delete, move are menu actions", async ({ page }) => {
    const calls = await mockDepth(page, { erich: true });
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await openChatInfo(page);
    const info = page.getByTestId("conv-info");
    await pexpect(info).toBeVisible();
    await pexpect(page.getByTestId("info-model")).not.toHaveText("—");
    await pexpect(page.getByTestId("info-count")).toHaveText("6");
    await pexpect(page.getByTestId("info-created")).toContainText("2026");
    await pexpect(page.getByTestId("info-updated")).toContainText("2026");
    await pexpect(page.getByTestId("info-usage")).toContainText("tokens");
    await pexpect(page.getByTestId("conv-info")).not.toContainText("$");
    // the info sheet shows facts only: no action buttons
    for (const id of ["info-rename", "info-move", "info-delete", "export-md", "export-json"]) await pexpect(page.getByTestId(id)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await chatMenuItem(page, "chat-menu-rename"); // rename
    await page.getByTestId("rename-sheet-input").fill("Renamed in sheet");
    await page.getByTestId("rename-sheet-save").click();
    await pexpect(page.locator("h2.title")).toHaveText("Renamed in sheet");
    pexpect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ title: "Renamed in sheet" });
    await chatMenuItem(page, "chat-menu-pin"); // pin (new in the header)
    await pexpect.poll(() => calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toContainEqual({ pinned: true });
    await page.getByTestId("chat-header-menu").click();
    await pexpect(page.getByTestId("chat-menu-pin")).toHaveText("Unpin");
    await pexpect(page.getByTestId("chat-menu-move")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await chatMenuItem(page, "chat-menu-export"); // export...
    const dl = page.waitForEvent("download");
    await page.getByTestId("export-md").click();
    pexpect((await dl).suggestedFilename()).toMatch(/\.md$/);
    await chatMenuItem(page, "chat-menu-delete");
    await page.getByTestId("confirm-ok").click();
    await pexpect(page).toHaveURL(/\/chats$/);
    pexpect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  plain("chat actions menu: Move to project is hidden for non-main accounts", async ({ page }) => {
    await mockDepth(page, { erich: false });
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await page.getByTestId("chat-header-menu").click();
    await pexpect(page.getByTestId("chat-menu")).toBeVisible();
    await pexpect(page.getByTestId("chat-menu-move")).toHaveCount(0);
    await pexpect(page.getByTestId("chat-menu-rename")).toHaveCount(1);
  });

  for (const scheme of ["light", "dark"] as const) {
    plain(`axe (${scheme}, reduced motion): starters, actions menu, select sheet, edit sheet, info sheet have no serious/critical violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await mockDepth(page, { prompts: true });
      const scan = async (label: string) => {
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        pexpect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")} :: ${v.nodes[0]?.failureSummary?.split("\n")[1] ?? ""}`), label).toEqual([]);
      };
      await page.goto("/"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(400);
      await scan("starters");
      await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle"); await page.waitForTimeout(400);
      await page.getByTestId("msg-actions").first().click(); await scan("actions menu");
      await page.getByTestId("msg-select").click(); await scan("select sheet"); await page.keyboard.press("Escape");
      await page.getByTestId("edit-earlier").first().click(); await scan("edit sheet"); await page.keyboard.press("Escape");
      await openChatInfo(page); await scan("info sheet");
    });
  }

  plain("reduced motion: no animation is running on the new surfaces", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockDepth(page);
    await page.goto(`/c/${IDS.chat}`); await page.waitForLoadState("networkidle");
    await openChatInfo(page);
    await pexpect(page.getByTestId("conv-info")).toBeVisible();
    pexpect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a.effect?.getComputedTiming().duration as number) > 50).length)).toBe(0);
  });
});

// ---- part 2: live app (real streaming, real fork through the Worker + Durable Object) ----
test.describe("chat depth (live)", () => {
  test("edit an earlier message forks a new chat holding the history before it; the original keeps all its turns", async ({ app: { page, api } }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const id = await api.newChat();
    await openChat(page, id);
    const w1 = uniq("AA"), w2 = uniq("BB"), w3 = uniq("CC"), w4 = uniq("DD");
    await ask(page, `Reply with the single word ${w1}`);
    await ask(page, `Reply with the single word ${w2}`);
    await ask(page, `Reply with the single word ${w3}`);
    await page.getByTestId("edit-earlier").nth(1).click(); // the second user message
    await page.getByTestId("edit-text").fill(`Reply with the single word ${w4}`);
    await page.getByTestId("edit-fork-send").click();
    await expect(page).not.toHaveURL(new RegExp(`/c/${id}$`));
    await expect(page.locator(".msg.user").last()).toContainText(w4, { timeout: 30_000 });
    await expect(page.locator(".msg.assistant .md").last()).toContainText(w4, { timeout: 120_000 }); // the reply to the EDITED text
    await expect(page.locator(".msg.user")).toHaveCount(2); // first turn copied + the edited one; nothing after it
    await expect(page.locator(".msg.user").first()).toContainText(w1);
    const orig = (await (await api.get(`/api/conversations/${id}`)).json()).state.messages.filter((m: any) => m.role === "user").length;
    expect(orig).toBe(3); // original untouched
    expect((await api.conversations()).length).toBe(2);
  });

  test("streaming: the view stays pinned at the bottom, and stays put once the reader scrolls up", async ({ app: { page, api } }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    await openChat(page, await api.newChat());
    await page.getByPlaceholder("Message").fill("Write a 45-line Python function with a comment on every line, in one fenced code block. After it, list 12 short bullet points about it.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const msgs = page.locator("main.msgs");
    await expect(page.locator(".msg.assistant.live .codeblock")).toBeVisible({ timeout: 60_000 });
    // at the bottom while the block opens and grows: never left behind by more than a few px
    for (let i = 0; i < 6; i++) { await page.waitForTimeout(300); const gap = await msgs.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight); if (await page.getByRole("button", { name: "Stop" }).count()) expect(gap).toBeLessThan(40); }
    // reader scrolls up while it is still streaming: no yank back
    if (await page.getByRole("button", { name: "Stop" }).count()) {
      await msgs.evaluate((el) => { el.scrollTop = 0; });
      const top = await msgs.evaluate((el) => el.scrollTop);
      await page.waitForTimeout(1500);
      expect(await msgs.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(top + 2);
      await expect(page.getByTestId("jump-bottom")).toBeVisible();
      await page.getByTestId("jump-bottom").click();
      await expect.poll(() => msgs.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(40);
    }
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 120_000 });
  });
});
