import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApp, REMOTE_IDS, IDS } from "./polish-mock";

// UI audit fixes (uiaudit1), on the mocked app: no login, no cost. Runs on iphone-webkit and desktop-chromium; the document under test is whatever E2E_BASE_URL serves.
const enc = encodeURIComponent;
const MOBILE = { width: 390, height: 844 };
test.use({ serviceWorkers: "block" });

test.describe("F01/F02 /remote list", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`stale rows keep AA text contrast (axe, ${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApp(page); await page.goto("/remote"); await expect(page.getByTestId("remote-row").first()).toBeVisible();
      await page.getByTestId("remote-older").click(); // axe over the stale rows too
      await expect(page.getByTestId("remote-row")).toHaveCount(40);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      // the dimming must not come from opacity (that is what dropped the text under 4.5:1)
      expect(await page.locator("button.row.dim").first().evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
    });
  }
  test("live first, 20 shown, older behind 'Show older (N)'", async ({ page }) => {
    await mockApp(page); await page.goto("/remote");
    const rows = page.getByTestId("remote-row");
    await expect(rows).toHaveCount(20);
    await expect(rows.nth(0).getByTestId("remote-status")).not.toHaveText("stale");
    await expect(rows.nth(2).getByTestId("remote-status")).not.toHaveText("stale");
    await expect(rows.nth(3).getByTestId("remote-status")).toHaveText("stale");
    await expect(page.getByTestId("remote-older")).toHaveText("Show older (20)");
    await page.getByTestId("remote-older").click();
    await expect(rows).toHaveCount(40); await expect(page.getByTestId("remote-older")).toHaveCount(0);
  });
});

test.describe("F06 /m/<id> transcript", () => {
  test.use({ viewport: MOBILE });
  test("no nested scroller on a phone: the page scrolls, the first line is not cut", async ({ page }) => {
    await mockApp(page); await page.goto(`/m/${enc(REMOTE_IDS.running)}`);
    const tail = page.getByTestId("remote-tail"); await expect(tail).toContainText("line 1:");
    const m = await tail.evaluate((e) => ({ ov: getComputedStyle(e).overflowY, scrolls: e.scrollHeight > e.clientHeight + 1, top: e.scrollTop }));
    expect(m.ov).toBe("visible"); expect(m.scrolls).toBe(false); expect(m.top).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  });
});

test.describe("F03 touch targets <= 640px (44px: the rule this CSS implements; nothing here is designed at 40-43)", () => {
  test.use({ viewport: MOBILE });
  // 0.5px tolerance only for sub-pixel layout rounding (WebKit reports 43.99); a 43px target still fails
  const small = (page: import("@playwright/test").Page, sel: string) => page.locator(sel).evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 43.5 || r.width < 43.5); }).map((e) => `${(e.textContent || e.getAttribute("aria-label") || e.tagName).trim().slice(0, 20)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
  test("the 44px check itself rejects a 43x43 target and accepts 44x44", async ({ page }) => {
    await page.setContent('<button id=a style="width:43px;height:43px">a</button><button id=b style="width:44px;height:44px">b</button>');
    expect(await small(page, "#a")).toEqual(["a 43x43"]); expect(await small(page, "#b")).toEqual([]);
  });
  test("chats list actions, artifacts tabs/filters/sort, library chips, appearance segments, switches", async ({ page }) => {
    await mockApp(page);
    await page.goto("/chats"); await expect(page.getByTestId("chat-menu-button").first()).toBeVisible();
    expect(await small(page, '[data-testid="chat-menu-button"]')).toEqual([]);
    await page.goto("/artifacts"); await expect(page.getByTestId("artifact-sort")).toBeVisible();
    expect(await small(page, ".artfilters .chip, .artsort")).toEqual([]);
    await page.goto("/library"); await expect(page.getByTestId("lib-filter-all")).toBeVisible();
    expect(await small(page, ".libfilters .chip")).toEqual([]);
    await page.goto("/settings/appearance"); await expect(page.getByTestId("appearance-page")).toBeVisible();
    expect(await small(page, ".seg button, .themeseg button")).toEqual([]);
    // switches keep their 51x31 look but get a >= 44px-high hit area through ::before (31px + 2x6px = 43 is NOT enough, so the inset is 7px)
    const sw = page.locator(".srow .switch").first(); const h = await sw.evaluate((e) => parseFloat(getComputedStyle(e, "::before").height) || 0);
    expect(h).toBeGreaterThanOrEqual(44);
  });
});

test.describe("F07 appearance alignment", () => {
  test.use({ viewport: MOBILE });
  test("segmented controls and dividers start at the row labels", async ({ page }) => {
    await mockApp(page); await page.goto("/settings/appearance");
    const label = await page.getByText("Transcript font", { exact: true }).evaluate((e) => e.getBoundingClientRect().left);
    const seg = await page.getByRole("group", { name: "Transcript font" }).evaluate((e) => e.getBoundingClientRect().left);
    expect(Math.abs(seg - label)).toBeLessThanOrEqual(1);
    const divider = await page.locator(".scard.noic").nth(1).evaluate((e) => { const r = e.children[1]; return parseFloat(getComputedStyle(r, "::before").left); });
    expect(divider).toBe(16);
  });
});

test.describe("F11 about", () => {
  test("navigator.standalone is n/a, never the raw word undefined", async ({ page }) => {
    await mockApp(page); await page.goto("/about");
    const row = page.getByText("navigator.standalone").locator("xpath=..");
    await expect(row).toBeVisible(); await expect(row).toContainText("n/a"); await expect(row).not.toContainText("undefined");
  });
});

test.describe("F05 offline", () => {
  test("offline after a good load: cached screen stays, one pill, Retry now; back online clears it", async ({ page, context }) => {
    await mockApp(page); await page.goto("/chats"); await expect(page.getByTestId("chat-item").first()).toBeVisible();
    await context.setOffline(true);
    await page.evaluate(() => dispatchEvent(new Event("offline")));
    await expect(page.getByTestId("offline-pill")).toBeVisible();
    await expect(page.getByTestId("offline")).toHaveCount(0); // no full-screen error
    await expect(page.getByTestId("chat-item").first()).toBeVisible();
    await context.setOffline(false); // the browser's own `online` event re-checks by itself
    await expect(page.getByTestId("offline-pill")).toHaveCount(0);
  });
  test("Retry now on the pill re-checks and clears it", async ({ page }) => {
    await mockApp(page); await page.goto("/chats"); await expect(page.getByTestId("chat-item").first()).toBeVisible();
    await page.evaluate(() => dispatchEvent(new Event("offline")));
    await page.getByTestId("offline-pill").getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByTestId("offline-pill")).toHaveCount(0);
  });
  test("reload while the API is unreachable: cached identity keeps the app usable behind the pill", async ({ page }) => {
    await mockApp(page); await page.goto("/chats"); await expect(page.getByTestId("chat-item").first()).toBeVisible();
    await page.unroute(/\/(api|auth)\//); await page.route(/\/(api|auth)\//, (r) => r.abort("connectionrefused"));
    await page.reload();
    await expect(page.getByTestId("offline-pill")).toBeVisible(); await expect(page.getByTestId("offline")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible(); // the app chrome is there; the list itself says it could not load (nothing cached across a reload)
  });
  test("revoked access (403 forbidden from /api/me) clears the cached identity: signed-out screen, no pill, nothing cached", async ({ page }) => {
    await mockApp(page); await page.goto("/chats"); await expect(page.getByTestId("chat-item").first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("vc-me"))).not.toBeNull();
    await page.route(/\/api\/me$/, (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }));
    await page.reload();
    await expect(page.getByTestId("offline-pill")).toHaveCount(0); await expect(page.getByTestId("offline")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("vc-me"))).toBeNull();
    await expect(page.getByTestId("chat-item")).toHaveCount(0);
  });
  test("a different 403 (space unavailable) keeps the old behaviour: cached identity behind the pill", async ({ page }) => {
    await mockApp(page); await page.goto("/chats"); await expect(page.getByTestId("chat-item").first()).toBeVisible();
    await page.route(/\/api\/me$/, (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "space unavailable" }) }));
    await page.reload();
    await expect(page.getByTestId("offline-pill")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("vc-me"))).not.toBeNull();
  });
  test("a corrupt cached identity (spaces: {length:2}) is discarded; Settings opens without crashing", async ({ page }) => {
    await mockApp(page); await page.goto("/chats"); await expect(page.getByTestId("chat-item").first()).toBeVisible();
    await page.evaluate(() => { const v = JSON.parse(localStorage.getItem("vc-me")!); v.me.spaces = { length: 2 }; localStorage.setItem("vc-me", JSON.stringify(v)); });
    const errs: string[] = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.unroute(/\/(api|auth)\//); await page.route(/\/(api|auth)\//, (r) => r.abort("connectionrefused"));
    await page.reload();
    await expect(page.getByTestId("offline")).toBeVisible(); // no usable cache => the full-screen error, not a half-built app
    expect(await page.evaluate(() => localStorage.getItem("vc-me"))).toBeNull();
    expect(errs).toEqual([]);
  });
  test("any API 401 (not only /api/me) drops the cached identity", async ({ page }) => {
    await mockApp(page); await page.goto("/chats"); await expect(page.getByTestId("chat-item").first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("vc-me"))).not.toBeNull();
    await page.route(/\/api\/usage/, (r) => r.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
    await page.goto("/usage"); await expect.poll(() => page.evaluate(() => localStorage.getItem("vc-me"))).toBeNull();
  });
  test("no cached identity (first ever load): the full-screen error with Retry now stays", async ({ page }) => {
    await page.route(/\/(api|auth)\//, (r) => r.abort("connectionrefused"));
    await page.goto("/chats");
    await expect(page.getByTestId("offline")).toBeVisible(); await expect(page.getByRole("button", { name: "Retry now" })).toBeVisible();
  });
});
void IDS;
