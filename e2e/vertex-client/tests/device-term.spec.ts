import { test, expect, type Page } from "@playwright/test";
import { mockApp } from "./polish-mock";

// Device terminal tab (/dv/<id>) against an in-browser FAKE device hub (page.routeWebSocket): no backend, no login, no cost.
// Needs a build that contains the tab: serve it with scripts/serve-dist.mjs (real CSP) and set E2E_BASE_URL.
const DEV = "0123456789abcdef0123456789abcdef";
const SHOT = process.env.TERM_SHOTS; // optional dir for screenshots
const ROOTS = [{ label: "Projects", path: "/home/me/projects" }, { label: "Notes", path: "/home/me/notes" }];
const b64 = (s: string) => Buffer.from(s).toString("base64"), unb64 = (s: string) => Buffer.from(s, "base64").toString();
type Opts = { term: boolean; mode?: "sandbox" | "open"; error?: string };
type Hub = { got: any[]; push: (f: object) => void; live: boolean; buf: string; sockets: number; stale?: boolean };

async function open(page: Page, o: Opts): Promise<Hub> {
  await mockApp(page, { erich: true });
  await page.route(/\/api\/devices$/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [{ id: DEV, name: "my-laptop", created_at: 1, last_seen: Date.now(), online: true, roots: ROOTS }] }) }));
  const hub: Hub = { got: [], push: () => {}, live: false, buf: "", sockets: 0 }; // live/buf: the fake hub keeps the one session across page sockets (like the real hub + device)
  await page.routeWebSocket(/\/api\/devices\/.*\/session/, (ws) => {
    hub.sockets++;
    ws.send(JSON.stringify({ t: "hello", seq: 0, minSeq: 0, online: true, now: Date.now(), term: o.term }));
    hub.push = (f) => ws.send(JSON.stringify(f));
    let sid = "S1", out = Buffer.byteLength(hub.buf);
    const state = () => ws.send(JSON.stringify({ t: "term_state", sid: "S1", mode: o.mode ?? "sandbox", root: ROOTS[0].path, cols: 80, rows: 24, since: 1 }));
    const emit = (text: string) => { hub.buf += text; ws.send(JSON.stringify({ t: "term_out", sid, seq: out, data: b64(text) })); out += Buffer.byteLength(text); };
    if (hub.live || hub.stale) state();   // stale: announced, but the session exits before the attach (vclterm11)
    ws.onMessage((m) => {
      const f = JSON.parse(String(m)); hub.got.push(f);
      if (f.t === "term_attach" && !hub.live) ws.send(JSON.stringify({ t: "term_exit", sid: "S1", code: null, signal: "gone" }));   // like the real hub since vclterm11
      if (f.t === "term_attach" && hub.live) { if (f.lastSeq === 0 && hub.buf) ws.send(JSON.stringify({ t: "term_out", sid: "S1", seq: 0, data: b64(hub.buf) })); }
      if (f.t === "term_open" && hub.live) return state();   // a session exists: attach instead of an error
      if (f.t === "term_open") { if (o.error) return ws.send(JSON.stringify({ t: "term_error", cid: f.cid, error: o.error })); sid = "S1"; out = 0; hub.buf = ""; hub.live = true; ws.send(JSON.stringify({ t: "term_ready", cid: f.cid, sid, mode: o.mode ?? "sandbox" })); emit("me@laptop:~$ "); }
      if (f.t === "term_in") { const d = unb64(f.data); emit(d.includes("\r") ? d.replace(/\r/g, "\r\nme@laptop:~$ ") : d); }
      if (f.t === "term_close") hub.live = false;
      if (f.t === "term_close") ws.send(JSON.stringify({ t: "term_exit", sid, code: null, signal: "SIGHUP", reason: "closed" }));
    });
  });
  return hub;
}
test.use({ serviceWorkers: "block" });
const shot = async (page: Page, name: string) => { if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png` }); };
const noOverflow = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);

test("flag off / device without term: no Terminal tab, the xterm chunk is never requested", async ({ page }) => {
  const reqs: string[] = []; page.on("request", (r) => reqs.push(r.url()));
  const hub = await open(page, { term: false }); await page.goto(`/dv/${DEV}`);
  await expect(page.getByTestId("dv-stream")).toBeVisible(); await expect(page.getByTestId("dv-tab-terminal")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(reqs.some((u) => /xterm|term-pane/.test(u))).toBe(false); expect(hub.got.filter((f) => String(f.t).startsWith("term_"))).toEqual([]);
});

for (const [w, h] of [[390, 844], [1280, 800]] as const) {
  test(`terminal ${w}x${h}: start, type, echo, banner, keys, stop; no real CSP violation, readable colours, no overflow`, async ({ page }) => {
    const bad: string[] = []; page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text()) && !/Applying inline style|Refused to apply a stylesheet/.test(m.text())) bad.push(m.text()); }  // xterm's own <style> elements are reported by the browser (and mirrored by shimInlineStyles); anything else is a real violation
    ); page.on("pageerror", (e) => bad.push(String(e)));
    await page.setViewportSize({ width: w, height: h });
    const hub = await open(page, { term: true }); await page.goto(`/dv/${DEV}`);
    await page.getByTestId("dv-tab-terminal").click(); await expect(page.getByTestId("tm-screen")).toBeVisible();
    await expect(page.getByTestId("tm-banner")).toHaveText("Terminal mode not confirmed yet."); // vclwin4: before a confirmed sandbox session the banner must NOT claim "restricted"
    await expect(page.getByTestId("tm-root")).toBeVisible(); await shot(page, `idle-${w}`);
    await page.getByTestId("tm-start").click();
    await expect(page.getByTestId("tm-stop")).toBeVisible();
    await expect(page.getByTestId("tm-banner")).toHaveText("Restricted folders, not a vault"); // confirmed sandbox (term_ready mode=sandbox)
    expect(hub.got.find((f) => f.t === "term_open")).toMatchObject({ root: ROOTS[0].path }); // default = first root
    await expect(page.locator(".xterm-rows")).toContainText("me@laptop:~$");
    await expect(page.getByTestId("tm-harness-note")).toBeVisible();
    // the shim must make xterm's theme apply under the app's CSP: light text on the dark screen, not the browser default grey-on-black
    const rgb = await page.locator(".xterm-rows > div").first().evaluate((el) => getComputedStyle(el).color); const [r, g, b] = rgb.match(/\d+/g)!.map(Number); expect(Math.min(r, g, b)).toBeGreaterThan(190);
    await page.locator(".xterm-helper-textarea").focus(); await page.keyboard.type("echo hi\r");
    await expect(page.locator(".xterm-rows")).toContainText("echo hi");
    await expect.poll(() => hub.got.some((f) => f.t === "term_ack")).toBe(true); // flow control: output consumed => acked
    await page.getByTestId("tm-key-tab").click(); await expect.poll(() => hub.got.filter((f) => f.t === "term_in").some((f) => unb64(f.data) === "\t")).toBe(true);
    await page.getByTestId("tm-key-up").click(); await expect.poll(() => hub.got.filter((f) => f.t === "term_in").some((f) => unb64(f.data) === "\x1b[A")).toBe(true);
    await page.getByTestId("tm-key-ctrl").click(); await page.keyboard.type("c"); await expect.poll(() => hub.got.filter((f) => f.t === "term_in").some((f) => unb64(f.data) === "\x03")).toBe(true);
    if (w < 500) { const b = (await page.getByTestId("tm-keys").boundingBox())!; expect(b.x + b.width).toBeLessThanOrEqual(w + 0.5); }
    expect(await noOverflow(page)).toBeLessThanOrEqual(1);
    await shot(page, `running-${w}`);
    await page.getByTestId("tm-harness-ok").click(); await expect(page.getByTestId("tm-harness-note")).toHaveCount(0);
    await page.getByTestId("tm-stop").click(); await expect(page.getByTestId("tm-start")).toBeVisible(); await expect(page.getByTestId("tm-end")).toContainText("stopped");
    expect(hub.got.some((f) => f.t === "term_close" && f.sid === "S1")).toBe(true);
    expect(bad).toEqual([]);
  });
}

test("mode open: explicit unrestricted banner; term_gap redraws with a note; idle exit gets a plain message", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const hub = await open(page, { term: true, mode: "open" }); await page.goto(`/dv/${DEV}`);
  await page.getByTestId("dv-tab-terminal").click(); await page.getByTestId("tm-start").click();
  await expect(page.getByTestId("tm-banner")).toHaveText("Unrestricted: this shell can read your whole account");
  await expect(page.getByTestId("tm-banner")).toHaveClass(/warn/); await shot(page, "open-390");
  hub.push({ t: "term_gap", sid: "S1", from: 500 }); await expect(page.locator(".xterm-rows")).not.toContainText("me@laptop"); // cleared
  hub.push({ t: "term_exit", sid: "S1", code: null, signal: "idle" }); await expect(page.getByTestId("tm-end")).toContainText("30 minutes");
  await shot(page, "idle-exit-390");
});

test("term_error login_required prompts a re-login; terminal_off names the command", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, { term: true, error: "login_required" }); await page.goto(`/dv/${DEV}`);
  await page.getByTestId("dv-tab-terminal").click(); await page.getByTestId("tm-start").click();
  await expect(page.getByTestId("tm-end")).toContainText("log in again"); await expect(page.getByTestId("tm-relogin")).toBeVisible(); await shot(page, "login-required-390");
});
test("term_error terminal_off", async ({ page }) => {
  await open(page, { term: true, error: "terminal_off" }); await page.goto(`/dv/${DEV}`);
  await page.getByTestId("dv-tab-terminal").click(); await page.getByTestId("tm-start").click();
  await expect(page.getByTestId("tm-end")).toContainText("vcl set terminal on");
});

test("vclterm10 B1: reload with a running session re-attaches (Stop visible, output replayed), and Start-while-running attaches, no error", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const hub = await open(page, { term: true }); await page.goto(`/dv/${DEV}`);
  await page.getByTestId("dv-tab-terminal").click(); await page.getByTestId("tm-start").click();
  await expect(page.locator(".xterm-rows")).toContainText("me@laptop:~$"); expect(hub.live).toBe(true);
  hub.got.length = 0;
  await page.reload();                                       // the page dies without Stop
  await expect(page.getByTestId("tm-stop")).toBeVisible();   // the pane mounted itself and shows the running session
  await expect(page.getByTestId("tm-pane")).toBeVisible();
  await expect(page.locator(".xterm-rows")).toContainText("me@laptop:~$");
  expect(hub.got.find((f) => f.t === "term_attach")).toMatchObject({ sid: "S1", lastSeq: 0 });
  expect(hub.got.some((f) => f.t === "term_open")).toBe(false); expect(hub.live).toBe(true);
  await expect(page.getByTestId("tm-end")).toHaveCount(0);
  await page.getByTestId("tm-stop").click(); await expect(page.getByTestId("tm-start")).toBeVisible(); expect(hub.live).toBe(false);
});

test("vclterm10 B1: a second Start while a session exists attaches instead of 'already open'", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const hub = await open(page, { term: true }); hub.live = true; hub.buf = "me@laptop:~$ ";   // an orphan from a dead page
  await page.goto(`/dv/${DEV}`);                             // hello already carries term_state -> adopted at once
  await expect(page.getByTestId("tm-stop")).toBeVisible(); await expect(page.locator(".xterm-rows")).toContainText("me@laptop:~$");
  await expect(page.getByTestId("tm-end")).toHaveCount(0);
});

test("vclterm10 B2: resizing across the 1024 px layout breakpoint (1280 -> 900 -> 1280) keeps a usable terminal: re-attached, no stuck 'offline', Stop works", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const hub = await open(page, { term: true }); await page.goto(`/dv/${DEV}`);
  await page.getByTestId("dv-tab-terminal").click(); await page.getByTestId("tm-start").click();
  await expect(page.locator(".xterm-rows")).toContainText("me@laptop:~$");
  for (const w of [900, 1280]) {
    hub.got.length = 0;
    await page.setViewportSize({ width: w, height: 700 });
    await expect(page.getByTestId("tm-stop")).toBeVisible({ timeout: 8000 });     // running session visible again after the remount
    await expect(page.locator(".xterm-rows")).toContainText("me@laptop:~$");
    await expect(page.getByTestId("tm-offline")).toHaveCount(0);
    await expect(page.getByTestId("tm-end")).toHaveCount(0);
    expect(hub.got.some((f) => f.t === "term_open")).toBe(false);
  }
  await page.getByTestId("tm-stop").click(); await expect(page.getByTestId("tm-start")).toBeVisible();
});

test("vclterm10 B3: keystrokes typed immediately after Start (before the shell answers) are not lost", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const hub = await open(page, { term: true }); await page.goto(`/dv/${DEV}`);
  await page.getByTestId("dv-tab-terminal").click();
  await page.getByTestId("tm-start").click(); await page.keyboard.type("echo early\r");   // no wait for the prompt
  await expect(page.locator(".xterm-rows")).toContainText("echo early");
  expect(hub.got.filter((f) => f.t === "term_in").map((f) => unb64(f.data)).join("")).toBe("echo early\r");
});

test("vclterm11: the session exits between term_state and the attach -> the pane ends with a plain message and Start is enabled", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const hub = await open(page, { term: true }); hub.stale = true;
  await page.goto(`/dv/${DEV}`);
  await expect(page.getByTestId("tm-end")).toContainText("no longer exists");
  await expect(page.getByTestId("tm-start")).toBeEnabled(); await expect(page.getByTestId("tm-stop")).toHaveCount(0);
});
