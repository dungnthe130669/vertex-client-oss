import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mockApp, IDS } from "./polish-mock";

// Menu regrouping steps 1-4 (brief menu2), on the mocked app: no login, no cost. Runs on iphone-webkit and desktop-chromium (desktop-only cases skip on the phone project).
// Covers: C1 names, C2 icons, C3 hit area + accessible name, C9 message menu, C6 no duplicate "All chats", C12 palette entries,
// C8 the shared Chat actions menu from all three entry points, C10 desktop Settings nav/General, C11 desktop shortcuts.
test.use({ serviceWorkers: "block" });
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

type Call = { method: string; path: string; body: unknown };
/** mockApp + recording PATCH/DELETE on any conversation (the base mock answers 404 for them) and the Devices feature flag on. */
const DEVICE = { id: "dev-1", name: "Erich's Mac", created_at: Math.floor(Date.now() / 1000) - 86400, last_seen: Math.floor(Date.now() / 1000) - 30, online: true, roots: [] };
async function setup(page: Page, o: { erich?: boolean; devices?: boolean | "populated" } = {}) {
  await mockApp(page, { erich: o.erich ?? true });
  const calls: Call[] = [];
  await page.route(/\/api\/conversations\/[^/]+$/, (r: Route) => {
    const m = r.request().method();
    if (m !== "PATCH" && m !== "DELETE") return r.fallback();
    calls.push({ method: m, path: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
    return r.fulfill({ json: { ok: true } });
  });
  if (o.devices) await page.route(/\/api\/devices$/, (r: Route) => (r.request().method() === "GET" ? r.fulfill({ json: { devices: o.devices === "populated" ? [DEVICE] : [] } }) : r.fallback()));
  if (o.devices) await page.route(/\/api\/devices\/pair$/, (r: Route) => r.fulfill({ status: 201, json: { code: "ABCD1234", display: "ABCD-1234", expires_at: Math.floor(Date.now() / 1000) + 600, ttl_s: 600 } }));
  return calls;
}
const goto = async (p: Page, path: string) => { await p.goto(path); await p.waitForLoadState("networkidle"); };
const svgOf = (p: Page, tid: string) => p.getByTestId(tid).first().locator("svg.ic").first().innerHTML();
const MENU_ITEMS = ["Rename", "Unpin", "Move to project…", "Export…", "Delete"]; // the mock's first chat is pinned

test.describe("menu2 phone 390x844", () => {
  test.use({ viewport: MOBILE });

  test("C1 names: Settings Skills subtitle + push row; Saved tab; no stale wording", async ({ page }) => {
    await setup(page);
    await goto(page, "/settings");
    await expect(page.getByTestId("open-skills")).toContainText("Slash commands");
    await expect(page.getByTestId("open-skills")).not.toContainText("Manage / skills");
    await expect(page.getByTestId("notifications")).toContainText("Push alerts on this device");
    await goto(page, "/artifacts");
    await expect(page.getByTestId("artifact-tab-active")).toHaveText("Saved");
    await expect(page.getByTestId("artifact-tab-active")).not.toHaveText("Library");
  });

  test("C1 names: header tab says Chats (641-1023px)", async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 800, height: 900 });
    await goto(page, "/cloud");
    await expect(page.getByTestId("tab-chat")).toHaveText("Chats");
  });

  test("C2 icons: Workspaces has its own icon; Devices is not a plus; every Settings row has a distinct icon", async ({ page }) => {
    await setup(page, { devices: true });
    await goto(page, "/");
    await page.getByTestId("menu-button").click();
    const g = page.getByTestId("drawer-group-workspaces");
    if ((await g.getAttribute("aria-expanded")) !== "true") await g.click();
    const ws = await svgOf(page, "drawer-group-workspaces");
    for (const t of ["menu-mode-agents", "menu-mode-cloud", "menu-mode-desktop", "menu-mode-remote"]) expect(await svgOf(page, t), `Workspaces icon vs ${t}`).not.toBe(ws);
    await page.keyboard.press("Escape");
    await goto(page, "/settings");
    await expect(page.getByTestId("open-devices")).toBeVisible();
    const ids = ["open-profile", "open-appearance", "open-subagents", "open-prompts", "open-devices", "open-capabilities", "open-providers", "open-skills", "open-connectors", "open-usage"];
    const sigs = new Map<string, string>();
    for (const t of ids) { const s = await svgOf(page, t); expect(sigs.has(s), `${t} shares an icon with ${sigs.get(s)}`).toBe(false); sigs.set(s, t); }
    expect(await svgOf(page, "open-devices")).not.toContain("M10 4v12M4 10h12"); // the plus
  });

  test("C3 hit area: both Settings switches are >=44px tall to touch (visual 31px, padded hit area)", async ({ page }) => {
    await setup(page);
    for (const [path, sel] of [["/settings", '[data-testid="chat-images-toggle"]'], ["/settings/appearance", '[role="switch"]']] as const) {
      await goto(page, path);
      const sw = page.locator(sel).first();
      await expect(sw).toBeVisible();
      const box = (await sw.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      // the padded hit area: 31px control + 7px each side = 45px tall, centred. Points 21px above/below the centre hit the switch, 26px do not.
      const hit = (dy: number) => sw.evaluate((e, d) => { const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 + d); return t === e || e.contains(t); }, dy);
      expect(await hit(-21), `${path} 21px above centre`).toBe(true); expect(await hit(21), `${path} 21px below centre`).toBe(true);
      expect(await hit(-26), `${path} 26px above centre is outside`).toBe(false); expect(await hit(26), `${path} 26px below centre is outside`).toBe(false);
    }
  });

  test("C3 accessible name: 'Pin this model' contains its visible text", async ({ page }) => {
    await mockApp(page);
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const text = (t: string) => [{ type: "text", text: t }];
    const msgs = [{ id: 1, role: "user", content: text("fix it"), model: null, usage: null, costUsd: null, stopReason: null, status: "complete", ttftMs: null, totalMs: null, createdAt: Date.now() - 5e3, route: null },
      { id: 2, role: "assistant", content: text("done"), model: "claude-sonnet-5-5", usage, costUsd: null, stopReason: "end_turn", status: "complete", ttftMs: 400, totalMs: 1500, createdAt: Date.now() - 4e3, route: { by: "auto-route", model: "claude-sonnet-5-5", effort: "medium", reason: "rule 4" } }];
    await page.route(new RegExp(`/api/conversations/${IDS.chat}$`), (r: Route) => r.fulfill({ json: { conversation: { id: IDS.chat, title: "T", model: "auto", pinned: 0, costUsd: 0, tokens: 0, projectId: null }, state: { seq: 5, running: false, inflight: null, model: "auto", title: "T", error: null, costUsd: 0, tokens: 0, messages: msgs } } }));
    await goto(page, `/c/${IDS.chat}`);
    const pin = page.getByTestId("pin-model");
    await expect(pin).toBeVisible();
    const visible = (await pin.innerText()).trim();
    expect(visible).toBe("Pin this model");
    expect(((await pin.getAttribute("aria-label")) ?? "").toLowerCase()).toContain(visible.toLowerCase());
    await expect(page.getByRole("button", { name: /Pin this model/ })).toHaveCount(1); // Playwright's accessible-name match
  });

  test("C9 message menu: only Copy as markdown + Select text; Copy answer / Regenerate stay inline", async ({ page }) => {
    await setup(page);
    await goto(page, `/c/${IDS.chat}`);
    await expect(page.getByRole("button", { name: "Copy answer" }).first()).toBeVisible();
    await page.getByTestId("msg-actions").first().click();
    await expect(page.getByTestId("msg-menu").getByRole("menuitem")).toHaveText(["Copy as markdown", "Select text"]);
    await expect(page.getByTestId("msg-copy")).toHaveCount(0);
    await expect(page.getByTestId("msg-regenerate")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("regenerate")).toHaveCount(1); // the last answer keeps its inline Regenerate
  });

  test("C6 drawer: no duplicate 'All chats' row; Chats and Show all remain", async ({ page }) => {
    await setup(page);
    await goto(page, "/");
    await page.getByTestId("menu-button").click();
    await expect(page.getByTestId("menu-mode-chat")).toBeVisible();
    await expect(page.getByTestId("drawer-all-chats")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Menu" }).getByText("All chats")).toHaveCount(0);
    await page.getByTestId("menu-mode-chat").click();
    await expect(page).toHaveURL(/\/chats$/);
  });

  test("C12 palette: Notifications and Devices are reachable; Approvals only with two spaces", async ({ page }) => {
    await setup(page, { devices: true });
    await goto(page, "/");
    const open = async () => { await page.getByTestId("menu-button").click(); await page.getByTestId("menu-search").click(); await expect(page.getByTestId("palette-input")).toBeVisible(); };
    await open();
    await page.getByTestId("palette-input").fill("notif");
    await expect(page.getByTestId("palette-item").filter({ hasText: "Notifications" }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/notifications$/);
    await page.goto("/"); await page.waitForLoadState("networkidle");
    await open();
    await page.getByTestId("palette-input").fill("devices");
    await expect(page.getByTestId("palette-item").filter({ hasText: "Settings: Devices" })).toBeVisible();
    await page.getByTestId("palette-input").fill("approvals");
    await expect(page.getByTestId("palette-item").filter({ hasText: "Settings: Approvals" })).toHaveCount(0); // one-space account: no Approvals row in Settings either
  });

  test("C8 Chats list rows and the chat header open the same Chat actions menu (header adds Chat info + Pin)", async ({ page }) => {
    const calls = await setup(page);
    await goto(page, "/chats");
    await page.getByTestId("chat-menu-button").first().click();
    await expect(page.getByTestId("chat-menu").getByRole("menuitem")).toHaveText(MENU_ITEMS);
    await expect(page.getByTestId("chat-menu")).toHaveAttribute("aria-label", "Chat actions");
    await page.keyboard.press("Escape");
    await goto(page, `/c/${IDS.chat}`);
    await expect(page.getByRole("button", { name: "Chat info" })).toHaveCount(0); // the header "⋯" is Chat actions now
    await page.getByTestId("chat-header-menu").click();
    await expect(page.getByTestId("chat-menu").getByRole("menuitem")).toHaveText(["Chat info", ...MENU_ITEMS]);
    await page.getByTestId("chat-menu-pin").click(); // Pin/Unpin is available from the header
    await expect.poll(() => calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toContainEqual({ pinned: false });
    await page.getByTestId("chat-header-menu").click();
    await expect(page.getByTestId("chat-menu-pin")).toHaveText("Pin"); // state followed
  });

  test("C8 drawer row menu is the same menu; rename, export, delete work from a row", async ({ page }) => {
    const calls = await setup(page);
    await goto(page, "/");
    await page.getByTestId("menu-button").click();
    const row = page.getByTestId("chat-item").first();
    await row.getByTestId("chat-menu-button").click();
    await expect(page.getByTestId("chat-menu").getByRole("menuitem")).toHaveText(MENU_ITEMS);
    await page.getByTestId("chat-menu-export").click();
    const dl = page.waitForEvent("download");
    await page.getByTestId("export-md").click();
    const d = await dl;
    expect(d.suggestedFilename()).toMatch(/\.md$/);
    expect(readFileSync((await d.path())!, "utf8")).toContain("migration plan"); // fetched from the conversation, not the (closed) chat screen
    await row.getByTestId("chat-menu-button").click();
    await page.getByTestId("chat-menu-delete").click();
    await page.getByTestId("confirm-ok").click();
    await expect.poll(() => calls.some((c) => c.method === "DELETE" && c.path.endsWith(IDS.chat))).toBe(true);
  });

  test("C8 header: Rename, Move to project and Delete keep working; Chat info shows facts only", async ({ page }) => {
    const calls = await setup(page);
    await goto(page, `/c/${IDS.chat}`);
    await page.getByTestId("chat-header-menu").click(); await page.getByTestId("chat-menu-info").click();
    await expect(page.getByTestId("conv-info")).toBeVisible();
    await expect(page.getByTestId("info-model")).not.toHaveText("—");
    for (const id of ["info-rename", "info-move", "info-delete", "export-md", "export-json"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-header-menu").click(); await page.getByTestId("chat-menu-rename").click();
    await page.getByTestId("rename-sheet-input").fill("Renamed from header");
    await page.getByTestId("rename-sheet-save").click();
    await expect(page.locator("h2.title")).toHaveText("Renamed from header");
    expect(calls.find((c) => c.method === "PATCH" && (c.body as { title?: string }).title)?.body).toEqual({ title: "Renamed from header" });
    await page.getByTestId("chat-header-menu").click(); await page.getByTestId("chat-menu-move").click();
    await page.getByTestId("move-option").first().click();
    await expect.poll(() => calls.some((c) => c.method === "PATCH" && (c.body as { project_id?: string }).project_id === IDS.project)).toBe(true);
    await page.getByTestId("chat-header-menu").click(); await page.getByTestId("chat-menu-delete").click();
    await page.getByTestId("confirm-ok").click();
    await expect(page).toHaveURL(/\/chats$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  test("C8 a non-main account has no Move to project in the shared menu", async ({ page }) => {
    await setup(page, { erich: false });
    await goto(page, `/c/${IDS.chat}`);
    await page.getByTestId("chat-header-menu").click();
    await expect(page.getByTestId("chat-menu-move")).toHaveCount(0);
    await expect(page.getByTestId("chat-menu").getByRole("menuitem")).toHaveText(["Chat info", "Rename", "Unpin", "Export…", "Delete"]);
  });

  test("layout: chat header buttons and the shared menu stay inside the 390px screen without overlapping", async ({ page }) => {
    await setup(page);
    await goto(page, `/c/${IDS.chat}`);
    const names = ["Menu", "New chat", "Find in chat", "Chat actions"];
    const boxes = [];
    for (const n of names) { const b = await page.getByRole("button", { name: n, exact: true }).first().boundingBox(); expect(b, n).not.toBeNull(); boxes.push(b!); expect(b!.x).toBeGreaterThanOrEqual(0); expect(b!.x + b!.width).toBeLessThanOrEqual(MOBILE.width + 0.5); expect(b!.width).toBeGreaterThanOrEqual(43.5); expect(b!.height).toBeGreaterThanOrEqual(43.5); }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; expect(a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5, `${names[i]} overlaps ${names[j]}`).toBe(true); }
    await page.getByTestId("chat-header-menu").click();
    const m = (await page.getByTestId("chat-menu").boundingBox())!;
    expect(m.x).toBeGreaterThanOrEqual(0); expect(m.x + m.width).toBeLessThanOrEqual(MOBILE.width); expect(m.y + m.height).toBeLessThanOrEqual(MOBILE.height);
    if (await page.evaluate(() => matchMedia("(pointer:coarse)").matches)) for (const it of await page.getByTestId("chat-menu").getByRole("menuitem").all()) expect((await it.boundingBox())!.height).toBeGreaterThanOrEqual(43.5); // touch: 44px rows (a mouse pointer keeps the 34px desktop rows)
  });

  test("phone Settings keeps every pane row (the desktop-only slimming does not leak to the phone)", async ({ page }) => {
    await setup(page, { devices: true });
    await goto(page, "/settings");
    for (const id of ["open-profile", "open-appearance", "open-subagents", "open-prompts", "open-devices", "open-capabilities", "open-providers", "open-skills", "open-connectors", "open-usage"]) await expect(page.getByTestId(id), id).toBeVisible();
  });
});

test.describe("menu2 desktop 1280x800 @desktop-only", () => {  // keyboard + sidebar layout
  test.use({ viewport: DESKTOP });

  test("C10 Settings modal: nav gets Skills, Connectors, Usage, Devices; General has no pane rows", async ({ page }) => {
    await setup(page, { devices: true });
    await goto(page, "/chats");
    await page.getByTestId("menu-settings").click();
    const modal = page.getByRole("dialog", { name: "Settings" });
    await expect(modal).toBeVisible();
    for (const p of ["general", "profile", "appearance", "prompts", "subagents", "capabilities", "providers", "skills", "connectors", "usage", "devices"]) await expect(page.getByTestId(`settings-pane-${p}`), p).toBeVisible();
    await expect(page.getByTestId("settings-pane-approvals")).toHaveCount(0); // needs two spaces
    for (const id of ["open-profile", "open-appearance", "open-subagents", "open-prompts", "open-devices", "open-capabilities", "open-providers", "open-skills", "open-connectors", "open-usage", "open-approvals"]) await expect(page.getByTestId(id), `General repeats ${id}`).toHaveCount(0);
    for (const id of ["sign-out", "theme-setting", "notifications", "chat-images-setting", "auto-info"]) await expect(page.getByTestId(id), `General keeps ${id}`).toBeVisible();
    // the nav items open in the modal (the page behind stays), each with its own content
    await page.getByTestId("settings-pane-skills").click();
    await expect(page).toHaveURL(/\/settings\/skills$/);
    await expect(modal.getByText("summarise").first()).toBeVisible();
    await page.getByTestId("settings-pane-connectors").click();
    await expect(page).toHaveURL(/\/settings\/connectors$/);
    await expect(modal.getByText("Personal connector").first()).toBeVisible();
    await page.getByTestId("settings-pane-usage").click();
    await expect(page).toHaveURL(/\/settings\/usage$/);
    await expect(modal.getByTestId("usage-today")).toBeVisible();
    await page.getByTestId("settings-pane-devices").click();
    await expect(page).toHaveURL(/\/settings\/devices$/);
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("settings-pane-devices")).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(/\/chats$/);
  });

  test("C10 the full-page Skills / Usage / Connectors from the sidebar are still full pages (no modal)", async ({ page }) => {
    await setup(page);
    await goto(page, "/usage");
    await expect(page.getByTestId("settings-modal")).toHaveCount(0);
    await expect(page.getByTestId("usage-today")).toBeVisible();
    await goto(page, "/skills");
    await expect(page.getByTestId("settings-modal")).toHaveCount(0);
  });

  test("C11 shortcuts: Ctrl+Shift+O = New chat and Ctrl+, = Settings in a normal tab; plain Ctrl+N is not claimed", async ({ page }) => {
    await setup(page);
    await goto(page, "/chats");
    await page.keyboard.press("Control+n");
    await expect(page).toHaveURL(/\/chats$/); // the browser keeps Ctrl+N in a tab
    await page.keyboard.press("Control+Shift+O");
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press("Control+,");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page).toHaveURL(/\/settings$/);
    await page.keyboard.press("Control+,"); // already open: no second entry
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await page.keyboard.press("Meta+Shift+O"); // Cmd works as well
    await expect(page).toHaveURL(/\/$/);
  });

  test("C11 shortcuts: inside the desktop shell Ctrl+N is New chat too", async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}; });
    await setup(page);
    await goto(page, "/chats");
    await page.keyboard.press("Control+n");
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press("Meta+,");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  test("C11 the ? help lists the new shortcuts, scheme explained", async ({ page }) => {
    await setup(page);
    await goto(page, "/chats");
    await page.keyboard.press("?");
    const dlg = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dlg).toBeVisible();
    const rows = await dlg.getByTestId("shortcut-row").allInnerTexts();
    const all = rows.join("\n");
    for (const k of ["Ctrl+Shift+O", "Cmd+Shift+O", "Ctrl+N", "Cmd+N", "Ctrl+,", "Cmd+,"]) expect(all, k).toContain(k);
    expect(all).toContain("Desktop app only");
    expect(all).toContain("Open Settings");
  });

  test("C8 sidebar rows, Chats list and header: the shared menu on desktop, nothing clipped", async ({ page }) => {
    await setup(page);
    await goto(page, `/c/${IDS.chat}`);
    await page.getByTestId("sidebar").getByTestId("chat-menu-button").first().click({ force: true });
    await expect(page.getByTestId("chat-menu").getByRole("menuitem")).toHaveText(MENU_ITEMS);
    let m = (await page.getByTestId("chat-menu").boundingBox())!;
    expect(m.x).toBeGreaterThanOrEqual(0); expect(m.x + m.width).toBeLessThanOrEqual(DESKTOP.width); expect(m.y + m.height).toBeLessThanOrEqual(DESKTOP.height);
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-header-menu").click();
    await expect(page.getByTestId("chat-menu").getByRole("menuitem")).toHaveText(["Chat info", ...MENU_ITEMS]);
    m = (await page.getByTestId("chat-menu").boundingBox())!;
    expect(m.x).toBeGreaterThanOrEqual(0); expect(m.x + m.width).toBeLessThanOrEqual(DESKTOP.width); expect(m.y + m.height).toBeLessThanOrEqual(DESKTOP.height);
  });

  test("fix1 (3): with /api/devices 404 the Devices pane and palette entry are hidden; with 200 they show", async ({ page }) => {
    await setup(page); // /api/devices is not mocked = 404 (feature off)
    await goto(page, "/chats");
    await page.getByTestId("menu-settings").click();
    await expect(page.getByTestId("settings-pane-usage")).toBeVisible();
    await expect(page.getByTestId("settings-pane-devices")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("devices");
    await expect(page.getByTestId("palette-item").filter({ hasText: "Settings: Devices" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const on = await page.context().newPage();
    await setup(on, { devices: true });
    await goto(on, "/chats");
    await on.getByTestId("menu-settings").click();
    await expect(on.getByTestId("settings-pane-devices")).toBeVisible();
    await on.keyboard.press("Escape");
    await on.keyboard.press("Control+k");
    await on.getByTestId("palette-input").fill("devices");
    await expect(on.getByTestId("palette-item").filter({ hasText: "Settings: Devices" })).toBeVisible();
  });

  test("fix1 (1): pane actions stay reachable: Pair a device with a POPULATED list, Add custom connector, Usage refresh", async ({ page }) => {
    await setup(page, { devices: "populated" });
    await goto(page, "/chats");
    await page.getByTestId("menu-settings").click();
    const modal = page.getByRole("dialog", { name: "Settings" });
    const reachable = async (tid: string) => { // visible, inside the modal, not under the close button
      const el = modal.getByTestId(tid); await expect(el).toBeVisible();
      const b = (await el.boundingBox())!, m = (await modal.boundingBox())!, x = (await modal.getByTestId("settings-modal-close").boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(m.x); expect(b.x + b.width).toBeLessThanOrEqual(m.x + m.width); expect(b.y).toBeGreaterThanOrEqual(m.y);
      expect(b.x + b.width <= x.x || b.y + b.height <= x.y || x.y + x.height <= b.y, `${tid} overlaps the close button`).toBe(true);
      return el;
    };
    await page.getByTestId("settings-pane-devices").click();
    await expect(modal.getByText("Erich's Mac").first()).toBeVisible(); // a device exists, so the empty-state button is gone
    await (await reachable("pair-open")).click();
    await expect(page.getByRole("dialog", { name: /pair/i }).or(page.getByText("ABCD-1234")).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("settings-pane-connectors").click();
    await expect(await reachable("connector-add")).toBeEnabled();
    await page.getByTestId("settings-pane-usage").click();
    await (await reachable("usage-refresh")).click();
    // the pane's plain bars (Back + title) stay hidden: Skills has no action
    await page.getByTestId("settings-pane-skills").click();
    await expect(modal.getByRole("button", { name: "Back" })).toHaveCount(0);
  });

  test("fix1 (2): pin / unpin in the chat header and in a sidebar row stay in step (both directions)", async ({ page }) => {
    await setup(page);
    await goto(page, `/c/${IDS.chat}`); // the mock's first chat is pinned
    const sidebarRow = page.getByTestId("sidebar").getByTestId("chat-item").filter({ hasText: "Planning the Q4" }).first();
    const sidebarPinLabel = async () => { await sidebarRow.getByTestId("chat-menu-button").click({ force: true }); const t = await page.getByTestId("chat-menu-pin").innerText(); await page.keyboard.press("Escape"); return t; };
    const headerPinLabel = async () => { await page.getByTestId("chat-header-menu").click(); const t = await page.getByTestId("chat-menu-pin").innerText(); await page.keyboard.press("Escape"); return t; };
    expect(await sidebarPinLabel()).toBe("Unpin"); expect(await headerPinLabel()).toBe("Unpin");
    await page.getByTestId("chat-header-menu").click(); await page.getByTestId("chat-menu-pin").click(); // header -> sidebar
    await expect(page.getByTestId("drawer-pinned")).toHaveCount(0);
    expect(await sidebarPinLabel()).toBe("Pin");
    await sidebarRow.getByTestId("chat-menu-button").click({ force: true }); await page.getByTestId("chat-menu-pin").click(); // sidebar -> header
    await expect.poll(headerPinLabel).toBe("Unpin");
    expect(await sidebarPinLabel()).toBe("Unpin");
  });
});
