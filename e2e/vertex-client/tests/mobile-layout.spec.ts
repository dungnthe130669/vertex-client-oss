import { test, expect, type Page } from "@playwright/test";
import { mockApp, IDS } from "./polish-mock";

// Mobile layout guard at 390px (mocked app: no login, no cost): no horizontal overflow on every top-level screen, every interactive target >= 44px,
// a short drawer (grouped, remembered), compact Recent rows. Run against a local build: node polish/serve.mjs & E2E_BASE_URL=http://127.0.0.1:4173 npx playwright test mobile-layout
test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
// phone layout: tagged @mobile-only (excluded on desktop-chromium by the config); touch targets are a coarse-pointer rule.

const SCREENS = ["/", "/chats", `/c/${IDS.chat}`, "/library", "/projects", `/projects/${IDS.project}`, "/artifacts", "/skills", "/settings", "/settings/profile", "/settings/appearance", "/usage", "/about", "/agents", "/cloud", "/desktop", "/remote", "/connectors"];
const MANY = Array.from({ length: 30 }, (_, i) => {
  const t = new Date(Date.now() - i * 7 * 3600e3).toISOString();
  return { id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`, title: i % 3 === 0 ? `A very long conversation title number ${i} about migrating the billing service to the new ledger and what to do with legacy invoices` : `Chat ${i}`, model: "claude-sonnet-5-5", pinned: i === 0 ? 1 : 0, costUsd: 0, tokens: 100, projectId: null, createdAt: t, updatedAt: t };
});

async function open(page: Page, path: string, o: Parameters<typeof mockApp>[1] = {}, after?: () => Promise<void>) {
  await mockApp(page, o);
  await after?.(); // routes registered after mockApp win over its own
  await page.goto(path); await page.waitForLoadState("networkidle"); await page.waitForTimeout(300);
}
async function manyChats(page: Page) {
  await page.route(/\/api\/conversations$/, (r) => (r.request().method() === "GET" ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: MANY }) }) : r.fallback()));
}
const drawer = async (page: Page) => { await page.getByTestId("menu-button").first().click(); await expect(page.getByTestId("drawer")).toBeVisible(); await page.waitForTimeout(450); };

/** Visible interactive elements whose box (or, for a form control inside a row/label, that row's box) is smaller than 44px. */
const smallTargets = (page: Page) => page.evaluate(() => {
  const out: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("button, a[href], [role=button], [role=tab], [role=menuitem], input:not([type=hidden]), select, textarea, summary")) {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none" || r.bottom < 0 || r.top > innerHeight) continue;
    if (el.closest("[hidden], [inert]") || (el as HTMLInputElement).type === "file" || el.classList.contains("sr")) continue;
    const host = el.closest<HTMLElement>("label, .srow, .row, .composer") ?? el;
    const hr = host.getBoundingClientRect();
    const w = Math.max(r.width, host === el || host.classList.contains("composer") ? 0 : hr.width), h = Math.max(r.height, host === el || host.classList.contains("composer") ? 0 : hr.height);
    if (w < 43.5 || h < 43.5) out.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}"${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return [...new Set(out)];
});

test.describe("390px mobile layout (mocked app) @mobile-only", () => {
  for (const path of SCREENS) {
    test(`${path.replace(IDS.chat, ":chat").replace(IDS.project, ":project")}: no horizontal overflow, every target >= 44px`, async ({ page }) => {
      await open(page, path, { erich: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow (px)").toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth), "body wider than the viewport").toBe(true);
      expect(await smallTargets(page), "targets under 44px").toEqual([]);
    });
  }

  test("drawer: <= 6 primary rows, groups collapsed, no horizontal overflow, targets >= 44px, few visible destination rows", async ({ page }) => {
    await open(page, "/chats", { erich: true });
    await drawer(page);
    expect(await page.locator(".drawer-nav > *").count()).toBeLessThanOrEqual(6);
    await expect(page.getByTestId("drawer-new-chat")).toBeVisible(); await expect(page.getByTestId("menu-search")).toBeVisible();
    // New chat + Search + primary (More is gone, menu3): nothing like the old 11-row flat list
    const rows = await page.locator(".drawer-top .drow, .drawer-nav .drow").count();
    expect(rows).toBeLessThanOrEqual(8);
    await expect(page.getByTestId("drawer-group-workspaces")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("drawer-group-more")).toHaveCount(0);
    await expect(page.getByTestId("menu-mode-chat")).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await smallTargets(page), "drawer targets under 44px").toEqual([]);
    const box = (await page.getByTestId("drawer").boundingBox())!;
    expect(box.x + box.width, "drawer stays inside the viewport").toBeLessThanOrEqual(390);
  });

  test("drawer groups open inline, the state survives a reload (localStorage), and a screen inside a group opens it", async ({ page }) => {
    await open(page, "/chats", { erich: true });
    await drawer(page);
    await page.getByTestId("drawer-group-workspaces").click();
    await expect(page.getByTestId("menu-mode-cloud")).toBeVisible();
    await expect(page.getByTestId("menu-skills")).toHaveCount(0); // Skills left Workspaces
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("vc.drawer.sections") ?? "{}"))).toEqual({ workspaces: true });
    await page.reload(); await page.waitForLoadState("networkidle");
    await drawer(page);
    await expect(page.getByTestId("menu-mode-cloud")).toBeVisible();
    expect(await smallTargets(page), "open groups: targets under 44px").toEqual([]);
    await page.getByTestId("drawer-group-workspaces").click(); // collapse again, then navigate into the group: it opens by itself only when no choice was stored
    await expect(page.getByTestId("menu-mode-cloud")).toHaveCount(0);
    await page.evaluate(() => localStorage.clear());
    await page.goto("/cloud"); await page.waitForLoadState("networkidle");
    await drawer(page);
    await expect(page.getByTestId("menu-mode-cloud")).toHaveAttribute("aria-current", "page");
  });

  test("deep link into a collapsed group: /cloud with a persisted {workspaces:false} shows the group open, the item current; More is a labelled landmark", async ({ page }) => {
    await mockApp(page, { erich: true });
    await page.addInitScript(() => localStorage.setItem("vc.drawer.sections", JSON.stringify({ workspaces: false })));
    await page.goto("/cloud"); await page.waitForLoadState("networkidle");
    await drawer(page);
    await expect(page.getByTestId("drawer-group-workspaces")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("menu-mode-cloud")).toHaveAttribute("aria-current", "page");
    await page.getByTestId("drawer-group-workspaces").click(); // collapse after arriving: respected, and the toggle says where you are
    await expect(page.getByTestId("drawer-group-workspaces")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("drawer-group-workspaces")).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("navigation", { name: "More" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  });

  test("Recent: compact rows (<= 48px, one line), grouped by day, first 12 then Show all", async ({ page }) => {
    await open(page, "/chats", { erich: true }, () => manyChats(page));
    await drawer(page);
    const recent = page.getByTestId("drawer-recent");
    const rows = recent.getByTestId("recent-row");
    expect(await rows.count()).toBe(12);
    const hs = await page.getByTestId("recent-row").evaluateAll((els) => els.map((e) => (e.closest("li") as HTMLElement).getBoundingClientRect().height));
    for (const h of hs) { expect(h, "Recent row height").toBeLessThanOrEqual(48); expect(h, "hit area").toBeGreaterThanOrEqual(43.5); }
    const lines = await page.getByTestId("recent-row").evaluateAll((els) => els.map((e) => { const l = e.querySelector(".drow-l") as HTMLElement; return { wrap: getComputedStyle(l).whiteSpace, ell: getComputedStyle(l).textOverflow, fs: parseFloat(getComputedStyle(e).fontSize) }; }));
    for (const l of lines) { expect(l.wrap).toBe("nowrap"); expect(l.ell).toBe("ellipsis"); expect(l.fs).toBeGreaterThanOrEqual(14); expect(l.fs).toBeLessThanOrEqual(15); }
    // the "…" actions button is part of the row, not below it
    const act = (await page.getByTestId("chat-menu-button").nth(1).boundingBox())!; const li = (await page.getByTestId("chat-item").nth(1).boundingBox())!;
    expect(act.y, "actions button sits inside its row").toBeGreaterThanOrEqual(li.y - 0.5); expect(act.y + act.height).toBeLessThanOrEqual(li.y + li.height + 0.5);
    expect(act.x + act.width, "actions button inside the drawer").toBeLessThanOrEqual(li.x + li.width + 0.5);
    const heads = await page.locator(".drawer-bucket-h").allTextContents();
    expect(heads.length).toBeGreaterThanOrEqual(2); for (const h of heads) expect(["Today", "Yesterday", "Previous 7 days", "Older"]).toContain(h);
    await page.getByTestId("drawer-show-all").click();
    expect(await rows.count()).toBe(29); // 30 chats, one of them pinned (own group)
    await expect(page.getByTestId("drawer-all-chats"), "C6: the duplicate All chats row is gone; Chats is the way to the list").toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByTestId("drawer-pinned").getByTestId("recent-row")).toHaveCount(1);
  });

  test("Recent: tapping the row opens the chat, the actions button opens the menu (hit areas intact)", async ({ page }) => {
    await open(page, "/chats", { erich: true }, () => manyChats(page));
    await drawer(page);
    await page.getByTestId("recent-row").nth(2).click();
    await expect(page).toHaveURL(/\/c\//);
    await drawer(page);
    await page.getByTestId("chat-menu-button").nth(1).click();
    await expect(page.getByTestId("chat-menu")).toBeVisible();
    await expect(page.getByTestId("chat-menu-rename")).toBeVisible();
  });

  test("team edition drawer: only Chats + Library (Usage/About are in Settings)", async ({ page }) => {
    await open(page, "/chats", { team: { hits403: [] } });
    await drawer(page);
    expect(await page.locator(".drawer-nav > *").count()).toBe(2);
    for (const t of ["menu-projects", "menu-artifacts", "drawer-group-workspaces"]) await expect(page.getByTestId(t)).toHaveCount(0);
    for (const t of ["drawer-group-more", "menu-usage", "menu-about"]) await expect(page.getByTestId(t)).toHaveCount(0);
    await page.getByTestId("menu-settings").click();
    await expect(page.getByTestId("open-usage")).toBeVisible(); await expect(page.getByTestId("open-about")).toBeVisible();
  });
});

// stylefix2: with appearance:auto WebKit rendered the Settings > Profile language select 23px tall (min-height/padding ignored); mobile now uses appearance:none.
test("native select is >= 44px tall (Profile language) @mobile-only", async ({ page }) => {
  await open(page, "/settings/profile");
  const h = await page.locator("#pf-lang").evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(44);
});
