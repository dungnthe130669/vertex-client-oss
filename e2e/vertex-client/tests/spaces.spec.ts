import { test, expect, openDrawer, type Api } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import { test as mockTest, expect as mockExpect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockApp } from "./polish-mock";

// Spaces (Business | Open), web client. Mobile viewport first (iphone-webkit runs it before desktop-chromium; nothing here is desktop-only).
// The live tests need an edition where Open is available to the e2e user (the e2e base has Open via its offline stub provider, never a real one);
// they skip, not fail, when /api/me.spaces has one entry. PO runs these live; the Business suites are the regression for "no selector = unchanged".
const uniq = () => `SPC${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
const GLOBAL_OK = /\/api\/version(\?|$)/; // global app-shell probe: not space-scoped on purpose (same allowlist as test/space-client.test.tsx)

async function hasOpen(api: Api) { const me = await (await api.get("/api/me")).json(); return Array.isArray(me.spaces) && me.spaces.length > 1; }
async function seedBiz(api: Api, title: string) { const id = await api.newChat(); const r = await api.mut("PATCH", `/api/conversations/${id}`, { title }); expect(r.status(), await r.text()).toBe(200); return id; }
async function seedOpen(api: Api, title: string) {
  const models = await (await api.openGet("/api/models")).json();
  const model = models.default ?? models.models?.[0]?.id; expect(model, "Open lists a model (stub)").toBeTruthy();
  const r = await api.openMut("POST", "/api/conversations", { model }); expect(r.status(), await r.text()).toBe(201);
  const id = (await r.json()).id as string;
  expect((await api.openMut("PATCH", `/api/conversations/${id}`, { title })).status()).toBe(200);
  return id;
}
/** Tap "Open" in the drawer switcher (a switch reloads the app into the new space's start screen). */
async function switchTo(page: Page, which: "biz" | "open") {
  await openDrawer(page);
  await page.getByTestId(`space-${which}`).click();
  await page.waitForLoadState("load");
  await expect(page.getByPlaceholder("Message")).toBeVisible();
  if (which === "open") await expect(page.locator("html")).toHaveAttribute("data-space", "open"); else await expect(page.locator("html")).not.toHaveAttribute("data-space", /.*/);
}

test.describe("spaces", () => {
  test("switcher: shown iff the server lists two spaces; Business | Open, 44px targets, subtitle only in Open", async ({ app }) => {
    const { page, api } = app;
    await page.goto("/");
    await openDrawer(page);
    if (!(await hasOpen(api))) { await expect(page.getByTestId("space-switcher")).toHaveCount(0); test.skip(true, "this edition/user has no Open"); }
    const sw = page.getByTestId("space-switcher");
    await expect(sw.getByRole("button")).toHaveText(["Business", "Open"]);
    for (const b of await sw.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId("space-biz")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("space-note")).toHaveCount(0);
    await page.getByTestId("space-open").click();
    await expect(page.locator("html")).toHaveAttribute("data-space", "open");
    await openDrawer(page);
    await expect(page.getByTestId("space-open")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("space-note")).toContainText("not Vertex");
    await expect(page.getByTestId("space-chip")).toHaveText("Open");
  });

  test("switch tears down: lists, search and the palette show nothing of the other space; remembered after reload", async ({ app }) => {
    const { page, api } = app;
    test.skip(!(await hasOpen(api)), "no Open here");
    const biz = uniq(), opn = uniq();
    await seedBiz(api, biz); await seedOpen(api, opn);
    await page.goto("/"); await openDrawer(page);
    await expect(page.getByTestId("drawer-recent")).toContainText(biz); await expect(page.getByTestId("drawer-recent")).not.toContainText(opn);
    await page.getByTestId("space-open").click(); await page.waitForLoadState("load");
    await openDrawer(page);
    await expect(page.getByTestId("drawer-recent")).toContainText(opn); await expect(page.getByTestId("drawer-recent")).not.toContainText(biz);
    await page.getByTestId("menu-search").click();
    await page.getByTestId("palette-input").fill(biz.slice(0, 8)); await expect(page.getByTestId("palette-empty")).toBeVisible();
    await expect(page.getByTestId("palette-list")).not.toContainText(biz);
    await page.getByTestId("palette-input").fill("Switch"); await expect(page.getByTestId("palette-list")).toContainText("Switch to Business");
    await page.keyboard.press("Escape");
    await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-space", "open"); // vc.space survived
    expect(await page.evaluate(() => localStorage.getItem("vc.space"))).toBe("open");
    await switchTo(page, "biz"); await openDrawer(page);
    await expect(page.getByTestId("drawer-recent")).toContainText(biz); await expect(page.getByTestId("drawer-recent")).not.toContainText(opn);
    expect(await page.evaluate(() => localStorage.getItem("vc.space"))).toBeNull();
  });

  test("in Open every /api request carries the selector (header, or ?space= for media and sockets); in Business none does", async ({ app }) => {
    const { page, api } = app;
    test.skip(!(await hasOpen(api)), "no Open here");
    await seedOpen(api, uniq());
    const bare: string[] = []; const sent: string[] = []; let openPhase = false;
    page.on("request", (r) => {
      const u = new URL(r.url()); if (!u.pathname.startsWith("/api/") || GLOBAL_OK.test(u.pathname)) return;
      sent.push(u.pathname);
      const has = r.headers()["x-vc-space"] === "open" || u.searchParams.get("space") === "open";
      if (openPhase && !has) bare.push(`${r.method()} ${u.pathname}${u.search}`);
      if (!openPhase && (r.headers()["x-vc-space"] || u.searchParams.has("space"))) bare.push(`BUSINESS carried a selector: ${u.pathname}`);
    });
    page.on("websocket", (ws) => { const u = new URL(ws.url()); if (openPhase && u.searchParams.get("space") !== "open") bare.push(`WS ${u.pathname}${u.search}`); });
    await page.goto("/chats"); await page.waitForLoadState("networkidle");
    openPhase = true;
    await switchTo(page, "open");
    await page.goto("/chats"); await page.waitForLoadState("networkidle");
    const row = page.getByTestId("chat-item").first(); await row.click();
    await expect(page.getByPlaceholder("Message")).toBeVisible(); await expect(page.locator(".dot.open")).toBeVisible(); // the socket connected WITH ?space=open
    await page.waitForLoadState("networkidle");
    expect(sent.length).toBeGreaterThan(5);
    expect(bare).toEqual([]);
  });

  test("Open start screen: provider-aware (stub) start, a chat made in Open stays in Open after reload and is not in Business", async ({ app }) => {
    const { page, api } = app;
    test.skip(!(await hasOpen(api)), "no Open here");
    await page.goto("/"); await switchTo(page, "open");
    await expect(page.getByTestId("space-chip")).toHaveText("Open");
    // e2e~open has the offline stub, so the standard start screen shows; the empty state (below) is covered by the mocked test
    await expect(page.getByTestId("start-hello")).toBeVisible();
    const t = uniq(); const id = await seedOpen(api, t);
    await page.goto(`/c/${id}`); await expect(page.getByPlaceholder("Message")).toBeVisible();
    await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-space", "open"); await expect(page.locator(".dot.open")).toBeVisible();
    expect((await api.conversations()).some((c) => c.id === id)).toBe(false); // Business API: not there
  });

  test("deep link ?space=open (push click) lands in Open once and the param is stripped; a Business tab then deep-linking an Open id gets the start screen, not the chat", async ({ app }) => {
    const { page, api } = app;
    test.skip(!(await hasOpen(api)), "no Open here");
    const id = await seedOpen(api, uniq());
    await page.goto(`/c/${id}?space=open`);
    await expect(page.locator("html")).toHaveAttribute("data-space", "open"); await expect(page.getByPlaceholder("Message")).toBeVisible();
    expect(new URL(page.url()).searchParams.has("space")).toBe(false);
    await switchTo(page, "biz");
    await page.goto(`/c/${id}`); // Business: the Open id is a 404 (isolation), never the other space's content
    await expect(page.getByText("Conversation not found")).toBeVisible();
  });

  test("a stale tab (Open turned off): 403 'space unavailable' clears vc.space and reloads into Business", async ({ app }) => {
    const { page } = app;
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("vc.space", "open"));
    await page.route("**/api/me", (r) => r.request().headers()["x-vc-space"] === "open" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "space unavailable" }) }) : r.continue());
    await page.reload();
    await expect(page.getByPlaceholder("Message")).toBeVisible(); // landed in Business, signed in
    // the app reloads itself once more after clearing vc.space: evaluate() can land inside that navigation ("Execution context was destroyed"), so poll and treat it as "not settled yet"
    await expect.poll(() => page.evaluate(() => localStorage.getItem("vc.space")).catch(() => "navigating"), { timeout: 15_000 }).toBeNull();
    await expect(page.getByPlaceholder("Message")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-space", /.*/);
  });

  test("fixture hygiene: cleanup removes conversations in BOTH spaces", async ({ app }) => {
    const { api } = app;
    test.skip(!(await hasOpen(api)), "no Open here");
    await seedBiz(api, uniq()); await seedOpen(api, uniq());
    expect(await api.deleteAll()).toBeGreaterThan(0); expect(await api.deleteAllOpen()).toBeGreaterThan(0);
    expect((await (await api.openGet("/api/conversations")).json()).conversations).toEqual([]);
  });
});

// Mocked (no login, no cost): the empty Open state, the Settings split, and AA contrast (axe) of Open in both colour schemes.
async function mockTwoSpaces(page: Page, opts: { models?: boolean; team?: boolean } = {}) {
  await mockApp(page, opts.team ? { team: { hits403: [] } } : {});
  await page.route("**/api/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: opts.team ? "ann@example.com" : "demo", via: opts.team ? "team" : "github", csrf: "csrf-demo", defaultModel: null, erichOnly: !opts.team, team: opts.team === true, spaces: ["biz", "open"], space: "open" }) }));
  if (opts.models === false) await page.route("**/api/models", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ default: null, models: [] }) }));
  await page.addInitScript(() => localStorage.setItem("vc.space", "open"));
}
mockTest.describe("Open (mocked)", () => {
  mockTest.use({ serviceWorkers: "block" });
  mockTest("empty Open state: title, copy and the Add a provider CTA -> Settings > Providers", async ({ page }) => {
    await mockTwoSpaces(page, { models: false });
    await page.goto("/"); const e = page.getByTestId("open-empty");
    await mockExpect(e).toContainText("Open space"); await mockExpect(e).toContainText("Your Business chats are not visible here");
    await page.getByTestId("open-empty-cta").click(); await mockExpect(page).toHaveURL(/\/settings\/providers$/);
  });
  mockTest("empty Open state for a team user: no CTA, no pointer to credentials", async ({ page }) => {
    await mockTwoSpaces(page, { models: false, team: true });
    await page.goto("/");
    await mockExpect(page.getByTestId("open-empty-none")).toHaveText("No providers are available for your account");
    await mockExpect(page.getByTestId("open-empty-cta")).toHaveCount(0);
  });
  mockTest("Settings split: Credentials (shared) + 'This space Open' headers", async ({ page }) => {
    await mockTwoSpaces(page);
    await page.goto("/settings");
    await mockExpect(page.getByTestId("settings-credentials")).toContainText("Shared by both spaces; used by Open");
    await mockExpect(page.getByTestId("settings-space-label")).toHaveText("Open");
  });
  for (const scheme of ["light", "dark"] as const) {
    mockTest(`axe (${scheme}): start screen, open drawer and Settings in Open have no serious/critical violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockTwoSpaces(page);
      for (const path of ["/", "/settings"]) {
        await page.goto(path); await page.waitForLoadState("networkidle");
        if (path === "/") { const mb = page.getByTestId("menu-button").filter({ visible: true }); if (await mb.count()) await mb.click(); } // >=1024px has the persistent sidebar, no hamburger (appbar1)
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        mockExpect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `${scheme} ${path}`).toEqual([]);
      }
    });
  }
});
