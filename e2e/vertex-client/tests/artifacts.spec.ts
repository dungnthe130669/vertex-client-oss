import { test, expect, openDrawer, type Api } from "./fixtures";
import type { Page } from "@playwright/test";

// Artifacts v1a (markdown / code / svg): gallery, search, viewer, version stepper, delete + undo, rendering safety, 390px.
// A real model producing an artifact is NOT driven here: artifact tools are offered to Erich's `main` scope only (the e2e user is refused by design),
// so rows are seeded through POST /api/artifacts, a route that exists for the e2e scope only (main gets 403) and writes through the same code as the tool.
// Written, not run by the author (e2e runs on build-host). The e2e scope accumulates rows across runs, so every title is unique and every count relative.

const uniq = () => `E2E${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
type Seed = { title: string; type: "markdown" | "code" | "svg"; content: string; language?: string };

async function seed(api: Api, s: Seed): Promise<string> {
  const r = await api.mut("POST", "/api/artifacts", s);
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).id as string;
}
async function addVersion(api: Api, id: string, content: string) {
  const r = await api.mut("POST", "/api/artifacts", { id, content });
  expect(r.status(), await r.text()).toBe(200);
}
async function drop(api: Api, ids: string[]) { for (const id of ids) await api.mut("DELETE", `/api/artifacts/${id}`, {}); }
const rowOf = (p: Page, title: string) => p.locator(`[data-testid="artifact-row"][data-title="${title}"]`);
async function noHOverflow(page: Page, what: string) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  expect(o.sw, `${what}: page scrolls horizontally (scrollWidth ${o.sw} > ${o.iw})`).toBeLessThanOrEqual(o.iw + 1);
}

test.describe("artifacts", () => {
  test("drawer row opens the gallery; rows show thumbnail text, lock + Only you, Edited, type badge; server-side search; empty state", async ({ app: { page, api } }) => {
    const t = uniq(), ids: string[] = [];
    try {
      ids.push(await seed(api, { title: `${t} Plan`, type: "markdown", content: "# Heading\nline two\nneedle-" + t }));
      ids.push(await seed(api, { title: `${t} Script`, type: "code", language: "python", content: "print('hello')" }));
      ids.push(await seed(api, { title: `${t} Logo`, type: "svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="red"/></svg>' }));
      await page.goto("/");
      await openDrawer(page); // phones: the drawer; >=1024px: the sidebar is already there
      await page.getByTestId("menu-artifacts").click();
      await expect(page).toHaveURL(/\/artifacts$/);
      await expect(page.getByTestId("artifacts-list")).toBeVisible();
      const plan = rowOf(page, `${t} Plan`);
      await expect(plan).toBeVisible();
      await expect(plan).toContainText("Only you");
      await expect(plan).toContainText(/Edited (just now|\d+m ago)/);
      await expect(plan.getByTestId("artifact-type")).toHaveText("Markdown");
      await expect(plan.locator(".artthumb")).toContainText("Heading");
      await expect(rowOf(page, `${t} Script`).getByTestId("artifact-type")).toHaveText("Code");
      await expect(rowOf(page, `${t} Logo`).getByTestId("artifact-type")).toHaveText("SVG");
      // search by title, by preview text, no match
      const search = page.getByTestId("artifact-search");
      await search.fill(`${t} Script`);
      await expect(page.getByTestId("artifact-row")).toHaveCount(1);
      await search.fill(`needle-${t}`);
      await expect(page.getByTestId("artifact-row")).toHaveCount(1);
      await expect(plan).toBeVisible();
      await search.fill(`${t}-no-such-thing`);
      await expect(page.getByTestId("artifacts-empty")).toContainText("No matches");
      await search.fill("");
      await expect(rowOf(page, `${t} Plan`)).toBeVisible();
    } finally { await drop(api, ids); }
  });

  test("viewer: markdown XSS payloads are inert; svg is an <img src=blob:> (scripts do not run); code is literal text", async ({ app: { page, api } }) => {
    const t = uniq(), ids: string[] = [];
    try {
      const mdId = await seed(api, { title: `${t} Evil md`, type: "markdown", content: [
        "# Title", "<script>window.__xss=1</script>", '<img src=x onerror="window.__xss=2">', '<a href="javascript:window.__xss=3">click</a>',
        '<iframe src="/api/me"></iframe>', '<form action="/api/x"><input name=a></form>', '<svg onload="window.__xss=4"></svg>', '<div style="position:fixed;inset:0">overlay</div>', "[link](https://example.com)" ].join("\n\n") });
      ids.push(mdId);
      await page.goto(`/artifacts/${mdId}`);
      const body = page.getByTestId("artifact-md");
      await expect(body.locator("h1")).toHaveText("Title");
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
      for (const sel of ["script", "iframe", "form", "input", "svg", "[onerror]", "[onload]", "[style]", 'a[href^="javascript:"]']) await expect(body.locator(sel), sel).toHaveCount(0);
      await expect(body.locator('a[href="https://example.com"]')).toHaveAttribute("rel", /noopener/);

      const svgId = await seed(api, { title: `${t} Evil svg`, type: "svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" onload="window.__xss=5"><script>window.__xss=6</script><circle cx="40" cy="40" r="30" fill="blue"/></svg>' });
      ids.push(svgId);
      await page.goto(`/artifacts/${svgId}`);
      const img = page.getByTestId("artifact-svg");
      await expect(img).toBeVisible();
      await expect(img).toHaveAttribute("src", /^blob:/);
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      await expect(img.locator("xpath=..").locator("svg, script")).toHaveCount(0); // never inline in the artifact body (the page chrome has its own icon <svg>s)
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();

      const codeId = await seed(api, { title: `${t} Code`, type: "code", language: "html", content: "<script>window.__xss=7</script>\n<b>bold</b>" });
      ids.push(codeId);
      await page.goto(`/artifacts/${codeId}`);
      await expect(page.getByTestId("artifact-code")).toContainText("<script>window.__xss=7</script>");
      await expect(page.getByTestId("artifact-lang")).toHaveText("html");
      await expect(page.getByTestId("artifact-code").locator("b, script")).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    } finally { await drop(api, ids); }
  });

  test("version stepper, copy, restore creates a new version", async ({ app: { page, api, } }) => {
    const t = uniq(), ids: string[] = [];
    try {
      const id = await seed(api, { title: `${t} Versions`, type: "markdown", content: "first draft" });
      ids.push(id);
      await addVersion(api, id, "second draft");
      await addVersion(api, id, "third draft");
      await page.goto(`/artifacts/${id}`);
      await expect(page.getByTestId("artifact-version")).toHaveText("v3 / 3");
      await expect(page.getByTestId("artifact-md")).toContainText("third draft");
      await expect(page.getByTestId("artifact-next")).toBeDisabled();
      await expect(page.getByTestId("artifact-restore")).toHaveCount(0);
      await page.getByTestId("artifact-prev").click();
      await expect(page.getByTestId("artifact-version")).toHaveText("v2 / 3");
      await expect(page.getByTestId("artifact-md")).toContainText("second draft");
      await page.getByTestId("artifact-prev").click();
      await expect(page.getByTestId("artifact-md")).toContainText("first draft");
      await expect(page.getByTestId("artifact-prev")).toBeDisabled();
      await page.getByTestId("artifact-restore").click();
      await expect(page.getByTestId("artifact-version")).toHaveText("v4 / 4");
      await expect(page.getByTestId("artifact-md")).toContainText("first draft");
      const g = await (await api.get(`/api/artifacts/${id}?v=3`)).json();
      expect(g.content).toBe("third draft"); // history untouched
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
      await page.getByTestId("artifact-copy").click();
      await expect(page.getByTestId("artifact-copy")).toBeVisible();
    } finally { await drop(api, ids); }
  });

  test("delete from the list: confirm dialog, row disappears, Undo brings it back; delete from the viewer returns to the gallery", async ({ app: { page, api } }) => {
    const t = uniq(), ids: string[] = [];
    try {
      const a = await seed(api, { title: `${t} Del A`, type: "markdown", content: "a" });
      const b = await seed(api, { title: `${t} Del B`, type: "markdown", content: "b" });
      ids.push(a, b);
      await page.goto("/artifacts");
      const rowA = rowOf(page, `${t} Del A`);
      await expect(rowA).toBeVisible();
      await rowA.getByTestId("artifact-delete").click();
      await expect(page.getByTestId("confirm-sheet")).toContainText(`${t} Del A`);
      await page.getByTestId("confirm-cancel").click();
      await expect(rowA).toBeVisible(); // cancel keeps it
      await rowA.getByTestId("artifact-delete").click();
      await page.getByTestId("confirm-ok").click();
      await expect(rowA).toHaveCount(0);
      expect((await api.get(`/api/artifacts/${a}`)).status()).toBe(404);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(rowOf(page, `${t} Del A`)).toBeVisible();
      expect((await api.get(`/api/artifacts/${a}`)).status()).toBe(200);
      // viewer delete
      await rowOf(page, `${t} Del B`).click();
      await expect(page).toHaveURL(new RegExp(`/artifacts/${b}$`));
      await page.getByTestId("artifact-viewer-delete").click();
      await page.getByTestId("confirm-ok").click();
      await expect(page).toHaveURL(/\/artifacts$/);
      await expect(rowOf(page, `${t} Del B`)).toHaveCount(0);
    } finally { await drop(api, ids); }
  });

  test("390px: gallery and viewer never scroll horizontally (long title, wide code line, wide table), search pill clears the bottom inset", async ({ app: { page, api } }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const t = uniq(), ids: string[] = [];
    try {
      const long = `${t} ${"very-long-unbroken-title-".repeat(8)}`.slice(0, 120);
      const mdId = await seed(api, { title: long, type: "markdown", content: `| ${Array.from({ length: 12 }, (_, i) => `col${i}-wide-header`).join(" | ")} |\n|${"---|".repeat(12)}\n| ${Array.from({ length: 12 }, () => "cell-value-long").join(" | ")} |\n\n${"x".repeat(300)}` });
      const codeId = await seed(api, { title: `${t} wide code`, type: "code", language: "text", content: "y".repeat(400) });
      const svgId = await seed(api, { title: `${t} big svg`, type: "svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1200"><rect width="2000" height="1200" fill="green"/></svg>' });
      ids.push(mdId, codeId, svgId);
      await page.goto("/artifacts");
      await expect(page.getByTestId("artifact-row").first()).toBeVisible();
      await noHOverflow(page, "gallery");
      const pill = (await page.getByTestId("artifact-search").boundingBox())!;
      expect(pill.y + pill.height, "search pill inside the viewport").toBeLessThanOrEqual(844);
      expect(pill.width).toBeGreaterThan(200);
      for (const id of ids) { await page.goto(`/artifacts/${id}`); await expect(page.getByTestId("artifact-viewer")).toBeVisible(); await page.waitForTimeout(300); await noHOverflow(page, `viewer ${id.slice(0, 4)}`); }
    } finally { await drop(api, ids); }
  });

  test("a deleted or foreign id shows a not-found state, not a crash", async ({ app: { page } }) => {
    await page.goto("/artifacts/0b9f8c1e-1111-4222-8333-444455556666");
    await expect(page.getByText("no longer exists")).toBeVisible();
  });

  test("polish: download with the right name, filters + sort, bulk delete, restore from Deleted", async ({ app: { page, api } }) => {
    const t = uniq(), ids: string[] = [];
    try {
      ids.push(await seed(api, { title: `${t} Beta`, type: "markdown", content: "# b" }));
      ids.push(await seed(api, { title: `${t} Alpha`, type: "code", language: "python", content: "print(1)" }));
      ids.push(await seed(api, { title: `${t} Logo`, type: "svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
      await page.goto("/artifacts");
      await page.getByTestId("artifact-search").fill(t);
      await expect(page.getByTestId("artifact-row")).toHaveCount(3);
      await page.getByTestId("artifact-filter-code").click();
      await expect(page.getByTestId("artifact-row")).toHaveCount(1);
      await page.getByTestId("artifact-filter-html").click();
      await expect(page.getByTestId("artifacts-empty-filter")).toBeVisible();
      await page.getByTestId("artifact-filter-all").click();
      await page.getByTestId("artifact-sort").selectOption("name");
      await expect(page.getByTestId("artifact-row").first()).toHaveAttribute("data-title", `${t} Alpha`);
      // download from the viewer
      await rowOf(page, `${t} Alpha`).locator("button.artrow").click();
      const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("artifact-download").click()]);
      expect(dl.suggestedFilename()).toBe(`${t}-Alpha.py`);
      await page.getByTestId("artifact-back").click();
      // bulk delete two, then restore one from Deleted
      await page.getByTestId("artifact-search").fill(t);
      const mine = page.locator(`[data-testid="artifact-row"][data-title^="${t} "]`); // the Deleted tab also lists other runs' soft-deleted rows
      await page.getByTestId("artifact-select").click();
      const checks = page.getByTestId("artifact-check");
      await checks.nth(0).check(); await checks.nth(1).check();
      await page.getByTestId("artifact-bulk-delete").click();
      await page.getByRole("button", { name: /^Delete$/ }).last().click();
      await expect(mine).toHaveCount(1);
      await page.getByTestId("artifact-tab-deleted").click();
      await expect(mine).toHaveCount(2);
      await mine.first().getByTestId("artifact-restore-deleted").click();
      await expect(mine).toHaveCount(1);
      await page.getByTestId("artifact-tab-active").click();
      await expect(mine).toHaveCount(2);
    } finally { await drop(api, ids); }
  });

  test("polish: version diff shows added and removed lines", async ({ app: { page, api } }) => {
    const t = uniq(), ids: string[] = [];
    try {
      const id = await seed(api, { title: `${t} Doc`, type: "markdown", content: "one\ntwo\nthree" });
      ids.push(id);
      await addVersion(api, id, "one\n2\nthree\nfour");
      await page.goto(`/artifacts/${id}`);
      await page.getByTestId("artifact-diff-toggle").click();
      await expect(page.getByTestId("artifact-diff-stats")).toHaveText("+2 −1");
      await expect(page.locator('[data-testid="artifact-diff-body"] [data-op="del"]')).toHaveText(/two/);
      await expect(page.locator('[data-testid="artifact-diff-body"] [data-op="add"]')).toHaveCount(2);
      await page.getByTestId("artifact-diff-to").selectOption("1");
      await expect(page.getByTestId("artifact-diff-same")).toBeVisible();
    } finally { await drop(api, ids); }
  });

  test("polish: html viewer presets (CSSOM width), fullscreen, reload; sandbox attribute unchanged; no new-tab control", async ({ app: { page, api } }) => {
    const t = uniq(), ids: string[] = [];
    try {
      const r = await api.mut("POST", "/api/artifacts", { title: `${t} Page`, type: "html", content: "<!doctype html><h1>hi</h1>" });
      expect(r.status()).toBe(201);
      const id = (await r.json()).id as string; ids.push(id);
      await page.goto(`/artifacts/${id}`);
      const frame = page.getByTestId("artifact-frame");
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      await page.getByTestId("artifact-preset-mobile").click();
      await expect.poll(async () => (await page.getByTestId("artifact-framebox").boundingBox())?.width).toBeLessThanOrEqual(390);
      await page.getByTestId("artifact-preset-desktop").click();
      await page.getByTestId("artifact-fullscreen").click();
      await expect(page.getByTestId("artifact-html")).toHaveAttribute("data-full", "1");
      // the Esc listener is attached by a passive (post-paint) effect: on a slow runner an early Esc misses it and hits the app-level handler (viewer closes -> artifact-html gone; ossci1j, public CI). Let the effect flush first.
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 150))));
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("artifact-html")).toHaveAttribute("data-full", "0");
      const before = await frame.getAttribute("src");
      await page.waitForTimeout(1100); // the token carries a whole-second expiry: a reload inside the same second mints an identical src (ossci1: flaked 2/4 on a fast local Worker)
      await page.getByTestId("artifact-reload").click();
      await expect.poll(async () => await frame.getAttribute("src")).not.toBe(before); // a freshly minted token
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      await expect(page.getByText(/open in new tab/i)).toHaveCount(0);
    } finally { await drop(api, ids); }
  });
});
