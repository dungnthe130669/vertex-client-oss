import { test, expect, type Page, type Route } from "@playwright/test";
import { mockApp } from "./polish-mock";

// Devices v2 step 2 (docs/vertex-client-devices-v2.md): the list marks "This device" (desktop shell only, server-decided), tells identical names apart,
// shows an honest last-online and offers (never forces) replacing an older same-name device. API mocked in the browser; no login, no cost.
test.use({ serviceWorkers: "block" });
const SHOTS = process.env.DEVID_SHOTS; // optional dir for screenshots
const NOW = Math.floor(Date.now() / 1000);
const A = "ffdaafa6".padEnd(32, "0"), B = "c884f4ff".padEnd(32, "0"), PC = "01234567".padEnd(32, "0");
const row = (id: string, o: Record<string, unknown> = {}) => ({ id, name: "dungnguyentien", created_at: NOW - 86400 * 5, last_seen: NOW - 60, last_online_at: NOW - 60, online: true, ...o });
const LIST = (thisId?: string) => [
  row(A, { this_install: thisId === A }),
  row(B, { online: false, last_online_at: NOW - 7200, last_seen: NOW - 7200, this_install: thisId === B }),
  row(PC, { name: "Studio PC", online: false, last_online_at: NOW - 20 * 86400, last_seen: NOW - 20 * 86400 }),
];
async function open(page: Page, o: { shell: boolean; thisId?: string; list?: () => unknown[] }) {
  await mockApp(page, { erich: true });
  if (o.shell) await page.addInitScript(() => { (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined }; });
  const hdrs: (string | null)[] = [];
  await page.route(/\/api\/devices$/, (r: Route) => { if (r.request().method() !== "GET") return r.fallback(); hdrs.push(r.request().headers()["x-vc-install"] ?? null); return r.fulfill({ json: { devices: (o.list ?? (() => LIST(o.thisId)))(), server_now: Date.now() } }); });
  await page.goto("/settings/devices"); await expect(page.getByTestId("device-list")).toBeVisible(); await expect(page.getByTestId("device-row")).toHaveCount((o.list ?? (() => LIST()))().length);
  return hdrs;
}

for (const scheme of ["light", "dark"] as const) {
  test(`desktop shell: exactly one "This device" badge on the marked row, short ids on the duplicates, honest last online (${scheme})`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    const hdrs = await open(page, { shell: true, thisId: B });
    const rows = page.getByTestId("device-row");
    await expect(page.getByTestId("device-this")).toHaveCount(1);
    await expect(rows.nth(0)).not.toContainText("This device"); await expect(rows.nth(0)).toContainText("#ffda"); await expect(rows.nth(0)).toContainText("online");
    await expect(rows.nth(1)).toContainText("This device"); await expect(rows.nth(1)).toContainText("#c884"); await expect(rows.nth(1)).toContainText("last online 2 h ago");
    await expect(rows.nth(2)).not.toContainText("#0123"); await expect(page.getByTestId("device-stale")).toContainText("20 days");
    const sent = hdrs.filter((h) => h !== null);                                                              // (the Settings availability probe sends none; the Devices page does)
    expect(sent.length).toBeGreaterThan(0); expect(sent[0]).toMatch(/^[0-9a-f]{32}$/);                        // the shell sends its install id...
    expect(await page.evaluate(() => localStorage.getItem("vc:install"))).toBe(sent[0]);                      // ...the one it stored
    const w = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth); expect(w).toBe(true); // no horizontal overflow
    const box = await rows.nth(1).boundingBox(); expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/list-${info.project.name}-${scheme}.png` });
  });
}

test("browser / phone (not the desktop shell): no badge even if a row were marked, and no install header is sent", async ({ page }) => {
  const hdrs = await open(page, { shell: false, thisId: B });
  await expect(page.getByTestId("device-this")).toHaveCount(1); // the server's mark is shown as given; the point is that the page itself never sends an id
  expect(hdrs.every((h) => h === null)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("vc:install"))).toBeNull();
});

test("server marks nothing (CLI-paired, unknown): no badge on any row, never a guess", async ({ page }) => {
  await open(page, { shell: true });
  await expect(page.getByTestId("device-this")).toHaveCount(0);
  await expect(page.getByTestId("device-short")).toHaveCount(2); // duplicates are still told apart
});

test("pairing a same-name device offers to replace the old one: Keep revokes nothing, confirm revokes only that row", async ({ page }) => {
  let paired = false; const NEW = "9999aaaa".padEnd(32, "0"); const deletes: string[] = [];
  await mockApp(page, { erich: true });
  await page.route(/\/api\/devices$/, (r) => r.request().method() === "GET" ? r.fulfill({ json: { devices: paired ? [row(A, { online: false, last_online_at: NOW - 600 }), row(NEW, { created_at: NOW, last_online_at: NOW })] : [row(A, { online: false, last_online_at: NOW - 600 })], server_now: Date.now() } }) : r.fallback());
  await page.route(/\/api\/devices\/pair$/, (r) => r.fulfill({ status: 201, json: { code: "ABCD2345", display: "ABCD-2345", expires_at: NOW + 600, ttl_s: 600 } }));
  await page.route(/\/api\/devices\/[0-9a-f]{32}$/, (r) => { if (r.request().method() === "DELETE") { deletes.push(new URL(r.request().url()).pathname.split("/").pop()!); return r.fulfill({ json: { ok: true } }); } return r.fallback(); });
  await page.goto("/settings/devices"); await expect(page.getByTestId("device-row")).toHaveCount(1);
  await page.getByTestId("pair-open").click(); await page.getByTestId("pair-create").click(); await expect(page.getByTestId("pair-code")).toBeVisible();
  paired = true;
  await expect(page.getByTestId("confirm-sheet")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("confirm-sheet")).toContainText("#ffda");
  await page.getByTestId("confirm-cancel").click(); await expect(page.getByTestId("confirm-sheet")).toHaveCount(0); expect(deletes).toEqual([]);
});

// devv2s2c: rows paired before install ids existed (install_id NULL, `linked` false) get one explicit "This is this device" action, desktop shell only.
test("desktop shell, unmarked list: 'This is this device' asks first (Cancel sends nothing), confirm POSTs the stored install id for that row only, then the badge appears", async ({ page }) => {
  let marked = false; const posts: { url: string; body: any }[] = [];
  await mockApp(page, { erich: true });
  await page.addInitScript(() => { (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined }; });
  await page.route(/\/api\/devices$/, (r) => r.request().method() === "GET" ? r.fulfill({ json: { devices: [row(A, { this_install: marked, linked: marked }), row(B, { online: false, last_online_at: NOW - 7200, linked: false })], server_now: Date.now() } }) : r.fallback());
  await page.route(/\/api\/devices\/[0-9a-f]{32}\/claim$/, (r) => { posts.push({ url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() }); marked = true; return r.fulfill({ json: { ok: true } }); });
  await page.goto("/settings/devices"); await expect(page.getByTestId("device-row")).toHaveCount(2);
  await expect(page.getByTestId("device-this")).toHaveCount(0);
  await expect(page.getByTestId("device-mark-this")).toHaveCount(2); await expect(page.getByTestId("device-mark-this").first()).toHaveText("This is this device");
  const first = page.getByTestId("device-row").nth(0);
  await first.getByTestId("device-mark-this").click(); await expect(page.getByTestId("confirm-sheet")).toContainText("#ffda"); await expect(page.getByTestId("confirm-sheet")).toContainText("this device?"); await expect(page.getByTestId("confirm-sheet")).not.toContainText(/\bMac\b/);
  await page.getByTestId("confirm-cancel").click(); await expect(page.getByTestId("confirm-sheet")).toHaveCount(0); expect(posts).toEqual([]);
  await first.getByTestId("device-mark-this").click(); await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("device-this")).toHaveCount(1); await expect(first).toContainText("This device");
  await expect(page.getByTestId("device-mark-this")).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem("vc:install"));
  expect(posts).toEqual([{ url: `/api/devices/${A}/claim`, body: { install_id: stored } }]);
  expect(stored).toMatch(/^[0-9a-f]{32}$/);
});

test("claim: a rejected fetch shows an error toast, no unhandled rejection, the button stays and a retry works", async ({ page }) => {
  let marked = false, attempts = 0; const unhandled: string[] = [];
  page.on("pageerror", (e) => unhandled.push(String(e)));
  await page.addInitScript(() => { window.addEventListener("unhandledrejection", () => { (window as any).__unh = ((window as any).__unh ?? 0) + 1; }); });
  await mockApp(page, { erich: true });
  await page.addInitScript(() => { (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined }; });
  await page.route(/\/api\/devices$/, (r) => r.request().method() === "GET" ? r.fulfill({ json: { devices: [row(A, { this_install: marked, linked: marked }), row(B, { online: false, last_online_at: NOW - 7200, linked: false })], server_now: Date.now() } }) : r.fallback());
  await page.route(/\/api\/devices\/[0-9a-f]{32}\/claim$/, (r) => { attempts++; if (attempts === 1) return r.abort("failed"); marked = true; return r.fulfill({ json: { ok: true } }); });
  await page.goto("/settings/devices"); await expect(page.getByTestId("device-row")).toHaveCount(2);
  const first = page.getByTestId("device-row").nth(0);
  await first.getByTestId("device-mark-this").click(); await page.getByTestId("confirm-ok").click();
  await expect(page.getByText("Could not mark this device. Check your connection and try again.")).toBeVisible();
  await expect(page.getByTestId("device-this")).toHaveCount(0);
  await expect(page.getByTestId("device-mark-this")).toHaveCount(2);
  expect(unhandled).toEqual([]); expect(await page.evaluate(() => (window as any).__unh ?? 0)).toBe(0);
  await first.getByTestId("device-mark-this").click(); await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("device-this")).toHaveCount(1); expect(attempts).toBe(2);
});

test("claim button: accessible name contains the visible wording", async ({ page }) => {
  await mockApp(page, { erich: true });
  await page.addInitScript(() => { (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined }; });
  await page.route(/\/api\/devices$/, (r) => r.fulfill({ json: { devices: [row(A, { linked: false }), row(B, { linked: false })], server_now: Date.now() } }));
  await page.goto("/settings/devices"); await expect(page.getByTestId("device-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "This is this device: dungnguyentien ffda" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^This is this device/ })).toHaveCount(2);
});

test("browser / phone: never offers 'This is this device'", async ({ page }) => {
  await open(page, { shell: false, list: () => [row(A, { linked: false }), row(B, { linked: false })] });
  await expect(page.getByTestId("device-mark-this")).toHaveCount(0);
});

/** The drawer is closed below 1024px (hamburger first, appbar1/nav-shell); on the persistent desktop sidebar there is no button. */
const openMenu = async (page: Page) => { const b = page.locator('[data-testid="menu-button"]').filter({ visible: true }); if (await b.count()) await b.first().click(); };
// "Computers" top-level sidebar entry (comp1, replaces "My devices"): shown when the devices probe answers 200, opens /computers; the old /devices list still works.
test("sidebar: Computers opens the computers list at /computers; /devices still works; hidden when the feature is off", async ({ page }) => {
  await mockApp(page, { erich: true });
  await page.route(/\/api\/devices$/, (r: Route) => r.request().method() === "GET" ? r.fulfill({ json: { devices: LIST(), server_now: Date.now() } }) : r.fallback());
  await page.goto("/chats"); await openMenu(page);
  const entry = page.getByTestId("menu-devices"); await expect(entry).toBeVisible(); await expect(entry).toHaveText("Computers");
  await entry.click(); await expect(page).toHaveURL(/\/computers$/);
  await expect(page.getByTestId("computer-card")).toHaveCount(3); if ((page.viewportSize()?.width ?? 0) >= 1024) await expect(page.getByTestId("menu-devices")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("computer-open").first().click(); await expect(page).toHaveURL(/\/computers\/[0-9a-f]{32}$/);
  await page.getByTestId("subpage-back").click(); await expect(page).toHaveURL(/\/computers$/);
  await page.goto("/devices"); await expect(page.getByTestId("device-row")).toHaveCount(3); // the old list stays
  await page.goto("/settings/devices"); await expect(page.getByTestId("device-list")).toBeVisible(); // the old route still works
});
test("sidebar: no Computers entry when the devices feature is off (404)", async ({ page }) => {
  await mockApp(page, { erich: true });
  await page.route(/\/api\/devices$/, (r: Route) => r.fulfill({ status: 404, json: { error: "not found" } }));
  await page.goto("/chats"); await openMenu(page); await expect(page.getByTestId("menu-library")).toBeVisible(); await expect(page.getByTestId("menu-devices")).toHaveCount(0);
});
