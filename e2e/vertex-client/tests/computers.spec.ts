import { test, expect, type Page } from "@playwright/test";
import { mockApp } from "./polish-mock";

// Computers page (comp1) against an in-browser FAKE device hub (page.routeWebSocket): no backend, no login, no cost.
// Needs a build that contains the page: serve it with scripts/serve-dist.mjs (real CSP) and set E2E_BASE_URL.
const DEV = "0123456789abcdef0123456789abcdef", DEV2 = "fedcba9876543210fedcba9876543210";
const SHOT = process.env.COMP_SHOTS; // optional dir for screenshots
const ROOTS = [{ label: "Projects", path: "/home/me/projects" }];
const b64 = (s: string) => Buffer.from(s).toString("base64");
type Hub = { got: any[]; sockets: number; refuse: boolean; drop: () => void; live: boolean; buf: string };
test.use({ serviceWorkers: "block" });
const shot = async (page: Page, name: string) => { if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png` }); };
const noOverflow = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);

async function setup(page: Page, o: { term?: boolean; devices?: object[]; self?: object } = {}): Promise<Hub> {
  await mockApp(page, { erich: true });
  const devices = o.devices ?? [{ id: DEV, name: "my-laptop", created_at: 1, last_seen: Date.now() / 1000, online: true, roots: ROOTS, os: "darwin", arch: "arm64" }, { id: DEV2, name: "office-pc", created_at: 1, last_seen: Date.now() / 1000 - 7200, last_online_at: Date.now() / 1000 - 7200, online: false, os: "win32" }];
  await page.route(/\/api\/devices$/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices, server_now: Date.now() }) }));
  const hub: Hub = { got: [], sockets: 0, refuse: false, drop: () => {}, live: false, buf: "" };
  await page.routeWebSocket(/\/api\/devices\/.*\/session/, (ws) => {
    if (hub.refuse) { ws.close({ code: 1006 }); return; }
    hub.sockets++; hub.drop = () => ws.close({ code: 1006 });
    ws.send(JSON.stringify({ t: "hello", seq: 0, minSeq: 0, online: true, now: Date.now(), term: o.term !== false, ...(o.self ?? {}) }));
    let out = Buffer.byteLength(hub.buf);
    const emit = (t: string) => { hub.buf += t; ws.send(JSON.stringify({ t: "term_out", sid: "S1", seq: out, data: b64(t) })); out += Buffer.byteLength(t); };
    if (hub.live) ws.send(JSON.stringify({ t: "term_state", sid: "S1", mode: "sandbox", root: ROOTS[0].path, cols: 80, rows: 24, since: 1 }));
    ws.onMessage((m) => {
      const f = JSON.parse(String(m)); hub.got.push(f);
      if (f.t === "term_attach" && hub.live && f.lastSeq === 0 && hub.buf) ws.send(JSON.stringify({ t: "term_out", sid: "S1", seq: 0, data: b64(hub.buf) }));
      if (f.t === "term_open") { out = 0; hub.buf = ""; hub.live = true; ws.send(JSON.stringify({ t: "term_ready", cid: f.cid, sid: "S1", mode: "sandbox" })); emit("me@laptop:~$ "); }
    });
  });
  return hub;
}

for (const [w, h] of [[390, 844], [1280, 800]] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`list ${w}x${h} ${scheme}: cards (name, status, last seen) + virtual computer; opening a card lands on the Terminal tab; no overflow`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h }); await page.emulateMedia({ colorScheme: scheme });
      await setup(page); await page.goto("/computers");
      await expect(page.getByTestId("computer-card")).toHaveCount(2);
      await expect(page.getByTestId("computer-status")).toHaveText(["Online", "Offline"]);
      await expect(page.getByTestId("computer-last").nth(1)).toContainText("last online");
      await expect(page.getByTestId("computer-os")).toHaveText(["macOS", "Windows"]);
      await expect(page.getByTestId("computer-virtual")).toContainText("Virtual computer");
      expect(await noOverflow(page)).toBeLessThanOrEqual(1); await shot(page, `list-${w}-${scheme}`);
      await page.getByTestId("computer-open").first().click();
      await expect(page).toHaveURL(new RegExp(`/computers/${DEV}$`));
      await expect(page.getByTestId("dv-tab-terminal")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("tm-screen")).toBeVisible(); await expect(page.getByTestId("cm-tab-screen")).toBeDisabled();
      await expect(page.getByTestId("dv-conn")).toHaveText("Connected");
      expect(await noOverflow(page)).toBeLessThanOrEqual(1); await shot(page, `terminal-idle-${w}-${scheme}`);
    });
  }
}

test("empty state: plain words on how to link a computer", async ({ page }) => {
  await setup(page, { devices: [] }); await page.goto("/computers");
  await expect(page.getByTestId("computers-empty")).toContainText("vcl"); await page.getByTestId("cm-pair-empty").click();
  await expect(page.getByTestId("pair-sheet")).toBeVisible();
});

test("comp2: device says unsupported -> plain text + reason, no fix command; off_switch -> fix; old runtime -> generic; old device card shows no OS", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { term: false, self: { os: "win32", termState: "unsupported", termWhy: "the terminal needs the Bun runtime (this vcl runs on Node)" } }); await page.goto(`/computers/${DEV}`);
  await expect(page.getByTestId("cm-term-gate")).toContainText("This computer cannot run the terminal"); await expect(page.getByTestId("cm-term-gate")).toContainText("needs the Bun runtime");
  await expect(page.getByTestId("cm-term-fix")).toHaveCount(0); expect(await noOverflow(page)).toBeLessThanOrEqual(1); await shot(page, "terminal-unsupported-390");
  const p2 = await page.context().newPage(); await p2.setViewportSize({ width: 390, height: 844 });
  await setup(p2, { term: false, self: { os: "linux", termState: "off_switch" } }); await p2.goto(`/computers/${DEV}`);
  await expect(p2.getByTestId("cm-term-gate")).toContainText("switched off"); await expect(p2.getByTestId("cm-term-fix")).toHaveText("vcl set terminal on"); await shot(p2, "terminal-offswitch-390");
  const p3 = await page.context().newPage(); await setup(p3, { devices: [{ id: DEV, name: "old-box", created_at: 1, last_seen: Date.now() / 1000, online: true }] }); await p3.goto("/computers");
  await expect(p3.getByTestId("computer-card")).toHaveCount(1); await expect(p3.getByTestId("computer-os")).toHaveCount(0);
});
test("terminal off on the device: plain explanation + the exact one-line fix, no dead tab; Claude tab still works", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { term: false }); await page.goto(`/computers/${DEV}`);
  await expect(page.getByTestId("cm-term-gate")).toHaveAttribute("data-kind", "off");
  await expect(page.getByTestId("cm-term-fix")).toHaveText("vcl set terminal on"); await expect(page.getByTestId("cm-term-gate")).toContainText("desktop app");
  expect(await noOverflow(page)).toBeLessThanOrEqual(1); await shot(page, "terminal-off-390");
  await page.getByTestId("dv-tab-session").click(); await expect(page.getByTestId("dv-stream")).toBeVisible(); await expect(page.getByTestId("cm-term-gate")).toHaveCount(0);
});

test("reconnect: Reconnecting… with a Reconnect button, manual reconnect restores Connected and keeps the scrollback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const hub = await setup(page); await page.goto(`/computers/${DEV}`);
  await page.getByTestId("tm-start").click(); await expect(page.locator(".xterm-rows")).toContainText("me@laptop:~$");
  await expect(page.getByTestId("tm-keys")).toBeVisible(); await expect(page.getByTestId("tm-key-pipe")).toBeVisible();
  const k = (await page.getByTestId("tm-keys").boundingBox())!; expect(k.x + k.width).toBeLessThanOrEqual(390.5);
  hub.refuse = true; hub.drop();
  await expect(page.getByTestId("dv-conn")).toHaveText("Reconnecting…"); await expect(page.getByTestId("cm-reconnect")).toBeVisible(); await shot(page, "reconnecting-390");
  await expect(page.locator(".xterm-rows")).toContainText("me@laptop:~$"); // scrollback stays while reconnecting
  const before = hub.sockets; hub.refuse = false; await page.getByTestId("cm-reconnect").click();
  await expect(page.getByTestId("dv-conn")).toHaveText("Connected"); expect(hub.sockets).toBe(before + 1); await expect(page.getByTestId("cm-reconnect")).toHaveCount(0);
  await expect.poll(() => hub.got.some((f) => f.t === "term_attach" && f.lastSeq > 0)).toBe(true); // re-attached from the last byte, not from 0
  await expect(page.locator(".xterm-rows")).toContainText("me@laptop:~$");
  expect(await noOverflow(page)).toBeLessThanOrEqual(1); await shot(page, "reconnected-390");
});

test("old routes stay: /devices list and /dv/:id keep the Session default tab", async ({ page }) => {
  await setup(page); await page.goto("/devices"); await expect(page.getByTestId("device-row")).toHaveCount(2);
  await page.goto(`/dv/${DEV}`); await expect(page.getByTestId("dv-tab-session")).toHaveAttribute("aria-selected", "true");
});

test("comp1b gating: non-Erich user, devices 403 never reach Computers; no device socket", async ({ page }) => {
  const sockets: string[] = []; page.on("websocket", (w) => sockets.push(w.url()));
  await mockApp(page, { erich: false });
  await page.route(/\/api\/devices$/, (r) => r.fulfill({ status: 403, json: { error: "forbidden" } }));
  for (const p of ["/computers", `/computers/${DEV}`]) { await page.goto(p); await expect(page.getByTestId("chat-input").or(page.locator("textarea")).first()).toBeVisible(); await expect(page.getByTestId("computers-page")).toHaveCount(0); await expect(page.getByTestId("cm-pair-open")).toHaveCount(0); await expect(page.getByTestId("dv-conn")).toHaveCount(0); }
  expect(sockets.filter((u) => /\/api\/devices\//.test(u))).toEqual([]);
});
test("comp1b gating: Erich but devices 404 -> only 'Not available' (Desktop on); 403 same", async ({ page }) => {
  for (const status of [404, 403]) {
    await mockApp(page, { erich: true });
    await page.route(/\/api\/devices$/, (r) => r.fulfill({ status, json: { error: "nf" } }));
    await page.goto("/computers"); await expect(page.getByTestId("computers-off")).toBeVisible();
    await expect(page.getByTestId("computer-virtual")).toHaveCount(0); await expect(page.getByTestId("cm-pair-open")).toHaveCount(0);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
test("comp1b: SPA navigation /computers/:id <-> /dv/:id picks each route's default tab, same socket", async ({ page }) => {
  const hub = await setup(page); await page.goto(`/computers/${DEV}`);
  await expect(page.getByTestId("dv-tab-terminal")).toHaveAttribute("aria-selected", "true"); await expect(page.getByTestId("dv-conn")).toHaveText("Connected");
  const n = hub.sockets;
  await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, `/dv/${DEV}`);
  await expect(page.getByTestId("dv-tab-session")).toHaveAttribute("aria-selected", "true"); await expect(page.getByTestId("dv-stream")).toBeVisible();
  await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, `/computers/${DEV}`);
  await expect(page.getByTestId("dv-tab-terminal")).toHaveAttribute("aria-selected", "true"); await expect(page.getByTestId("tm-screen")).toBeVisible();
  expect(hub.sockets).toBe(n);
});
