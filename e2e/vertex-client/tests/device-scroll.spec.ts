import { test, expect, type Page } from "@playwright/test";
import { mockApp } from "./polish-mock";

// Device session screen (/dv/<id>): the transcript is the only scroller, the composer sits in flow below it (never over the last line),
// the header stays visible, and new events stick to the bottom unless the user scrolled up. In-browser mocks (API + device WS), no login, no cost.
const DEV = "0123456789abcdef0123456789abcdef";
const SHOT = process.env.DEVSCROLL_SHOTS; // optional dir for screenshots
type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

type Mode = "running" | "idle" | "approval" | "picker" | "noroots";
const ROOTS = [{ label: "Projects", path: "/Users/dungnguyentien/Documents/Work/Projects" }, { label: "vcl-workspace", path: "/Users/dungnguyentien/vcl-workspace" }, { label: "Documents", path: "/Users/dungnguyentien/Documents" }];
let push: (e: object) => void = () => {};
async function open(page: Page, lines: number, mode: Mode = "running") {
  await mockApp(page);
  await page.route(/\/api\/devices$/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [{ id: DEV, name: "dungnguyentien", created_at: 1, last_seen: Date.now(), online: true, ...(mode === "picker" ? { roots: ROOTS } : mode === "noroots" ? { roots: [] } : {}) }] }) }));
  await page.routeWebSocket(/\/api\/devices\/.*\/session/, (ws) => {
    ws.send(JSON.stringify({ t: "hello", seq: lines, minSeq: 0, online: true, now: Date.now() }));
    let seq = 0; const ev = (e: object) => ws.send(JSON.stringify({ t: "ev", seq: ++seq, ts: Date.now(), e }));
    push = ev;
    if (mode !== "idle" && mode !== "picker" && mode !== "noroots") ev({ type: "session_started", dir: "/Users/x/vcl-workspace", sandbox: "none", bash: false });
    for (let i = 0; seq < lines; i++) { ev({ type: "tool_use", id: `t${i}`, name: "Glob", input: `{"pattern":"**/n${i}.txt"}` }); ev({ type: "assistant_text", text: `Line ${i}: some assistant text that is long enough to wrap on a phone screen, repeated for height.` }); ev({ type: "turn_done" }); }
    if (mode === "approval") ev({ type: "approval_request", rid: "r1", tool: "Write", preview: "/Users/x/vcl-workspace/noti2.txt\n" + "line of content\n".repeat(30), expires_at: Date.now() / 1000 + 600, ttl_s: 600 });
  });
  await page.goto(`/dv/${DEV}`); await expect(page.getByTestId("dv-stream")).toBeVisible();
  await expect(page.getByTestId("dv-note").last()).toBeVisible();
  if (mode === "idle" || mode === "picker") { await expect(page.getByTestId("dv-dir")).toBeVisible(); await expect(page.getByTestId("dv-start")).toBeVisible(); }
  if (mode === "picker") await expect(page.getByTestId("dv-root")).toBeVisible();
  if (mode === "noroots") { await expect(page.getByTestId("dv-noroots")).toBeVisible(); await expect(page.getByTestId("dv-start")).toBeVisible(); }
}

test.use({ serviceWorkers: "block" });

for (const mode of ["running", "idle", "approval", "picker", "noroots"] as const) {
for (const [w, h] of [[320, 568], [390, 844], [1216, 800], [1280, 800]] as const) {
  if (mode !== "running" && w === 1280) continue;
  for (const scheme of ["light", "dark"] as const) {
    test(`device session ${mode} ${w}x${h} ${scheme}: transcript scrolls, composer never overlaps, header visible`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: w, height: h });
      await open(page, 60, mode);
      const s = page.getByTestId("dv-stream");
      if (mode === "approval") {
        // modal sheet: fully inside the viewport, actions reachable; then minimise to the banner and run the layout checks on that state
        await page.waitForTimeout(600); // sheet-up animation
        const sh = (await page.getByTestId("approval-sheet").boundingBox())!;
        expect(sh.y).toBeGreaterThanOrEqual(-0.5); expect(sh.y + sh.height).toBeLessThanOrEqual(h + 0.5); expect(sh.x + sh.width).toBeLessThanOrEqual(w + 0.5);
        await page.getByTestId("approval-allow").scrollIntoViewIfNeeded(); const al = (await page.getByTestId("approval-allow").boundingBox())!; expect(al.y + al.height).toBeLessThanOrEqual(h + 0.5);
        if (SHOT) await page.screenshot({ path: `${SHOT}/approval-sheet-${w}x${h}-${scheme}.png` });
        await page.getByTestId("approval-later").click(); await expect(page.getByTestId("approval-banner")).toBeVisible();
      }
      const m = await s.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, page: document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight }));
      expect(m.sh).toBeGreaterThan(m.ch);                        // many lines overflow the transcript box…
      expect(m.page).toBeLessThanOrEqual(1);                     // …and not the page
      await expect.poll(() => s.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), "stuck to the bottom on arrival").toBeLessThan(4);
      // no-yank: scrolled up, a new event arrives => scrollTop unchanged (and still not stuck)
      await s.evaluate((el) => { el.scrollTop = 600; }); await expect.poll(() => s.evaluate((el) => el.scrollTop)).toBe(600);
      const before = await s.evaluate((el) => el.scrollHeight);
      push({ type: "assistant_text", text: "A NEW EVENT while the user reads older lines" });
      await expect.poll(() => s.evaluate((el) => el.scrollHeight)).toBeGreaterThan(before);
      await page.waitForTimeout(250);
      expect(await s.evaluate((el) => el.scrollTop), "new event yanked the scrolled-up transcript").toBe(600);
      // back at the bottom, a new event is followed
      // WebKit delivers the scroll event for a programmatic jump a frame later: wait for the app to have seen it (a real user cannot scroll and receive an event in the same frame)
      await s.evaluate((el) => new Promise<void>((r) => { el.scrollTop = el.scrollHeight; requestAnimationFrame(() => requestAnimationFrame(() => r())); }));
      push({ type: "assistant_text", text: "FOLLOWED EVENT at the tail" });
      await expect.poll(() => s.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
      const comp = (await page.locator("footer.dv-composer").boundingBox())!, st = (await s.boundingBox())!;
      const last = (await page.getByTestId("dv-text").last().boundingBox())!;
      expect(overlap(comp, last), "composer overlaps last transcript line").toBe(false);
      expect(overlap(comp, st), "composer overlaps transcript box").toBe(false);
      expect(last.y + last.height).toBeLessThanOrEqual(comp.y + 0.5);
      expect(comp.y).toBeGreaterThanOrEqual(0); expect(comp.y + comp.height).toBeLessThanOrEqual(h + 0.5);
      expect(comp.x).toBeGreaterThanOrEqual(-0.5); expect(comp.x + comp.width).toBeLessThanOrEqual(w + 0.5);
      if (mode === "approval") { const bn = (await page.getByTestId("approval-banner").boundingBox())!; expect(overlap(bn, comp), "banner overlaps composer").toBe(false); expect(overlap(bn, last), "banner overlaps last line").toBe(false); expect(bn.y + bn.height).toBeLessThanOrEqual(h + 0.5); }
      if (mode === "idle" || mode === "picker") for (const id of ["dv-dir", "dv-input", "dv-start"]) { const b = (await page.getByTestId(id).boundingBox())!; expect(b.y, id).toBeGreaterThanOrEqual(comp.y - 0.5); expect(b.y + b.height, id).toBeLessThanOrEqual(comp.y + comp.height + 0.5); expect(b.x + b.width, id).toBeLessThanOrEqual(w + 0.5); }
      if (mode === "picker") {
        for (const id of ["dv-root", "dv-subfolder"]) { const b = (await page.getByTestId(id).boundingBox())!; expect(b.x, id).toBeGreaterThanOrEqual(-0.5); expect(b.x + b.width, id).toBeLessThanOrEqual(w + 0.5); expect(b.y, id).toBeGreaterThanOrEqual(comp.y - 0.5); expect(b.y + b.height, id).toBeLessThanOrEqual(comp.y + comp.height + 0.5); expect(b.height, id).toBeGreaterThanOrEqual(40); }
        await page.getByTestId("dv-subfolder").fill("../x"); await expect(page.getByTestId("dv-subfolder-hint")).toBeVisible();   // the hint appears inside the composer and must not break the layout
        const c2 = (await page.locator("footer.dv-composer").boundingBox())!, st2 = (await s.boundingBox())!, hb = (await page.getByTestId("dv-subfolder-hint").boundingBox())!;
        expect(overlap(c2, st2), "composer overlaps transcript box with the hint shown").toBe(false); expect(hb.y + hb.height).toBeLessThanOrEqual(c2.y + c2.height + 0.5); expect(c2.y + c2.height).toBeLessThanOrEqual(h + 0.5);
        expect(await page.getByTestId("dv-start").isDisabled()).toBe(true);
        await page.getByTestId("dv-subfolder").fill("src");
        if (SHOT) await page.screenshot({ path: `${SHOT}/picker-${w}x${h}-${scheme}.png` });
      }
      if (mode === "noroots") { const b = (await page.getByTestId("dv-noroots").boundingBox())!; expect(b.x + b.width).toBeLessThanOrEqual(w + 0.5); expect(b.y).toBeGreaterThanOrEqual(comp.y - 0.5); expect(b.y + b.height).toBeLessThanOrEqual(comp.y + comp.height + 0.5); }
      for (const id of ["dv-conn", "dv-online", "dv-disconnect"]) { const b = (await page.getByTestId(id).boundingBox())!; expect(b.y, id).toBeGreaterThanOrEqual(0); expect(b.x + b.width, id).toBeLessThanOrEqual(w + 0.5); expect(b.y + b.height, id).toBeLessThanOrEqual(st.y + 0.5); }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
      if (SHOT) await page.screenshot({ path: `${SHOT}/${mode}-${w}x${h}-${scheme}.png` });
    });
  }
}
}

// Follow-tail regressions (yank1 round 2): the decision is made from the LIVE scroll position against the geometry before the change.
// Deterministic: every step waits on a measured condition (scrollHeight / clientHeight / two rAFs for the observer), no sleeps.
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
for (const [w, h] of [[390, 844], [1280, 800]] as const) {
  test(`device follow-tail ${w}x${h}: viewport growth / content growth never pull a scrolled-up user down; at the tail still follows`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await open(page, 60, "running");
    const s = page.getByTestId("dv-stream");
    const gap = () => s.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(gap, "stuck to the bottom on arrival").toBeLessThan(4);
    await frames(page);

    // (a) the viewport grows by 60px while the user is 100px above the tail: they stay put (60 < 100, so the browser does not clamp either)
    await s.evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 100; });
    await frames(page);
    const topA = await s.evaluate((el) => el.scrollTop), chA = await s.evaluate((el) => el.clientHeight);
    await page.setViewportSize({ width: w, height: h + 60 });
    await expect.poll(() => s.evaluate((el) => el.clientHeight)).toBeGreaterThan(chA);
    await frames(page);
    expect(await s.evaluate((el) => el.scrollTop), "viewport growth pulled a scrolled-up user to the tail").toBe(topA);

    // (b) content-only growth (every tool <details> opens: scrollHeight grows, the box and the item list do not change), then the user ends up 200px above the tail
    await s.evaluate((el) => { el.scrollTop = 0; });
    const shB = await s.evaluate((el) => el.scrollHeight);
    await frames(page);
    await s.evaluate((el) => el.querySelectorAll("details").forEach((d) => { d.open = true; }));
    await expect.poll(() => s.evaluate((el) => el.scrollHeight)).toBeGreaterThan(shB + 300);
    await frames(page);
    await s.evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 200; });
    await frames(page);
    const topB = await s.evaluate((el) => el.scrollTop), shB2 = await s.evaluate((el) => el.scrollHeight);
    push({ type: "assistant_text", text: "NEW EVENT after the details were expanded" });
    await expect.poll(() => s.evaluate((el) => el.scrollHeight)).toBeGreaterThan(shB2);
    await frames(page);
    expect(await s.evaluate((el) => el.scrollTop), "stale geometry after content-only growth yanked the user").toBe(topB);

    // (c) at the tail, growth still follows: content-only growth (collapse + reopen all tools) and then an event
    await s.evaluate((el) => { el.scrollTop = el.scrollHeight; }); await frames(page);
    const shC = await s.evaluate((el) => el.scrollHeight);
    await s.evaluate((el) => el.querySelectorAll("details").forEach((d) => { d.open = false; })); await frames(page);
    await s.evaluate((el) => el.querySelectorAll("details").forEach((d) => { d.open = true; }));
    await expect.poll(() => s.evaluate((el) => el.scrollHeight)).toBeGreaterThanOrEqual(shC - 5);
    await expect.poll(gap, "at the tail, content growth stays followed").toBeLessThan(4);
    push({ type: "assistant_text", text: "FOLLOWED at the tail after content growth" });
    await expect.poll(gap).toBeLessThan(4);
  });
}
