// Shared fixtures. The ONLY thing bypassed is the GitHub login: POST /auth/e2e (header x-e2e-token) issues a short-lived
// session for the separate user `e2e-bot` (or `e2e-bot-<n>` when E2E_SLOT=n: parallel runs each get their own account). Everything after that is the real app, driven through the real UI.
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

export const RUN_ID = process.env.E2E_RUN_ID ?? `local-${Date.now().toString(36)}`;
/** The account slot of this run (runner-run.sh sets E2E_SLOT = the lock slot it holds): 0 = the classic fixture user `e2e-bot`, 1..3 = `e2e-bot-<n>`. Strictly parsed: anything else throws. */
export const SLOT = (() => { const v = process.env.E2E_SLOT ?? "0"; if (!/^[0-3]$/.test(v)) throw new Error(`E2E_SLOT must be 0..3, got ${JSON.stringify(v)}`); return Number(v); })();
export const BOT = SLOT === 0 ? "e2e-bot" : `e2e-bot-${SLOT}`;
export const HAIKU = "claude-haiku-5-5";

export function e2eToken(): string {
  const t = process.env.E2E_TOKEN ?? (process.env.E2E_TOKEN_FILE ? readFileSync(process.env.E2E_TOKEN_FILE, "utf8") : "");
  if (!t.trim()) throw new Error("E2E_TOKEN or E2E_TOKEN_FILE must be set (never printed)");
  return t.trim();
}

export async function login(context: BrowserContext, baseURL: string): Promise<void> {
  const r = await context.request.post(`${baseURL}/auth/e2e`, { headers: { "x-e2e-token": e2eToken(), origin: baseURL, ...(SLOT > 0 ? { "x-e2e-slot": String(SLOT) } : {}) } });
  if (r.status() !== 200) throw new Error(`/auth/e2e (slot ${SLOT}) -> ${r.status()} (bypass not deployed, slot unsupported, token wrong, or E2E_TOKEN unset on the Worker)`);
  // Fail closed: whatever the server says it logged in as MUST be this slot's user. A Worker that ignores x-e2e-slot would answer e2e-bot, i.e. another run's account.
  const who = (await r.json()) as { user?: string };
  if (who.user !== BOT) throw new Error(`slot ${SLOT} expected to be ${BOT} but the server logged in ${JSON.stringify(who.user)}: refusing to run on a shared account`);
}

/** Thin API client sharing the browser context's cookies (used for setup/cleanup only, never for the assertions). */
export class Api {
  private csrf = "";
  constructor(private req: APIRequestContext, private base: string) {}
  private async ensure() { if (!this.csrf) this.csrf = (await (await this.req.get(`${this.base}/api/me`)).json()).csrf; }
  async get(path: string) { return this.req.get(this.base + path); }
  async mut(method: "POST" | "PUT" | "DELETE" | "PATCH", path: string, data?: unknown) {
    await this.ensure();
    return this.req.fetch(this.base + path, { method, data, headers: { origin: this.base, "x-csrf-token": this.csrf } });
  }
  /** Same as get/mut but inside the Open space (x-vc-space: open). 403 `space unavailable` = this edition/user has no Open. */
  async openGet(path: string) { return this.req.get(this.base + path, { headers: { "x-vc-space": "open" } }); }
  async openMut(method: "POST" | "PUT" | "DELETE" | "PATCH", path: string, data?: unknown) {
    await this.ensure();
    return this.req.fetch(this.base + path, { method, data, headers: { origin: this.base, "x-csrf-token": this.csrf, "x-vc-space": "open" } });
  }
  /** Deletes every Open conversation of this user; a no-op when Open is not available. */
  async deleteAllOpen(): Promise<number> {
    const r = await this.openGet("/api/conversations");
    if (r.status() !== 200) return 0;
    const rows = ((await r.json()).conversations ?? []) as { id: string }[];
    for (const c of rows) await this.openMut("DELETE", `/api/conversations/${c.id}`);
    return rows.length;
  }
  async newChat(model = HAIKU): Promise<string> {
    const r = await this.mut("POST", "/api/conversations", { model });
    expect(r.status()).toBe(201);
    return (await r.json()).id as string;
  }
  async conversations(): Promise<{ id: string; title: string; model: string }[]> {
    return (await (await this.get("/api/conversations")).json()).conversations;
  }
  async deleteAll(): Promise<number> {
    const rows = await this.conversations();
    for (const c of rows) await this.mut("DELETE", `/api/conversations/${c.id}`);
    return rows.length;
  }
}

export type WsControl = { dropNow(): void; block(on: boolean): void };
/** Proxies the chat WebSocket so a test can cut it (and refuse reconnects) deterministically in every browser engine. */
export async function controlWs(page: Page): Promise<WsControl> {
  const open = new Set<{ close(): void }>();
  let blocked = false;
  await page.routeWebSocket(/\/api\/conversations\/[^/]+\/ws/, (ws) => {
    if (blocked) { ws.close(); return; }
    ws.connectToServer();
    open.add(ws);
  });
  return {
    dropNow: () => { for (const w of open) try { w.close(); } catch {} open.clear(); },
    block: (on) => { blocked = on; },
  };
}

export const test = base.extend<{ app: { page: Page; api: Api } }>({
  app: async ({ page, context, baseURL }, use) => {
    await login(context, baseURL!);
    const api = new Api(context.request, baseURL!);
    // Start from an empty scope too: a conversation a previous test created after its own cleanup (a send still in flight) would leak into this one.
    try { await api.deleteAll(); await api.deleteAllOpen(); } catch (e) { console.error("pre-test cleanup failed:", e instanceof Error ? e.message : e); }
    await use({ page, api });
    // Every conversation under e2e-bot belongs to a test run: remove them all so nothing accumulates.
    try { await api.deleteAll(); await api.deleteAllOpen(); } catch (e) { console.error("cleanup failed:", e instanceof Error ? e.message : e); }
  },
});
export { expect };

// ---------- UI helpers (visible UI only) ----------
const costChips = (p: Page) => p.locator('[data-testid="msg-cost"]');
const stop = (p: Page) => p.getByRole("button", { name: "Stop" });
const sendBtn = (p: Page) => p.getByRole("button", { name: "Send", exact: true });

export async function openChat(page: Page, id: string) {
  await page.goto(`/c/${id}`);
  await expect(page.getByPlaceholder("Message")).toBeVisible();
  await expect(page.locator(".dot.open")).toBeVisible(); // socket connected
}
export async function typeMessage(page: Page, text: string) {
  await page.getByPlaceholder("Message").fill(text);
}
export async function clickSend(page: Page) {
  await expect(sendBtn(page)).toBeEnabled();
  await sendBtn(page).click();
}

async function pendingApprovals(p: Page) { return p.locator('[data-testid="approval"]').count(); }

/** True once the turn has finished: no Stop button, no approval card, a new cost chip appeared — and stayed that way. */
export async function waitSettled(page: Page, chipsBefore: number, opts: { approve?: "approve" | "deny"; timeout?: number } = {}) {
  const deadline = Date.now() + (opts.timeout ?? 120_000);
  let stableSince = 0;
  while (Date.now() < deadline) {
    const pend = await pendingApprovals(page);
    if (pend > 0 && opts.approve) {
      // the card re-renders while the stream updates; a detached/unstable click is retried by the loop
      await page.locator('[data-testid="approval"]').first().getByRole("button", { name: opts.approve === "approve" ? "Approve" : "Deny" }).click({ timeout: 4000 }).catch(() => {});
      stableSince = 0;
      await page.waitForTimeout(500);
      continue;
    }
    const done = pend === 0 && (await stop(page).count()) === 0 && (await costChips(page).count()) > chipsBefore && (await page.locator(".msg.assistant.live").count()) === 0;
    if (done) { stableSince ||= Date.now(); if (Date.now() - stableSince > 2000) return; } else stableSince = 0;
    await page.waitForTimeout(250);
  }
  throw new Error(`turn did not settle within ${opts.timeout ?? 120_000} ms`);
}

/** Type + send + wait for the reply. Returns the text of the last assistant text block. */
export async function ask(page: Page, text: string, opts: { approve?: "approve" | "deny" } = {}): Promise<string> {
  const before = await costChips(page).count();
  await typeMessage(page, text);
  await clickSend(page);
  await waitSettled(page, before, opts);
  return lastAssistantText(page);
}

export async function lastAssistantText(page: Page): Promise<string> {
  const md = page.locator(".msg.assistant .md");
  if ((await md.count()) === 0) return "";
  return (await md.last().innerText()).trim();
}

export const uniq = (label: string) => `${label}${RUN_ID.replace(/[^A-Za-z0-9]/g, "").slice(-8)}`.toUpperCase();

/** Draws `text` on a canvas in the page and returns PNG bytes — no image fixtures needed. */
export async function makePng(page: Page, text: string): Promise<Buffer> {
  const b64 = await page.evaluate((t) => {
    const c = document.createElement("canvas"); c.width = 900; c.height = 300;
    const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.fillRect(0, 0, 900, 300);
    g.fillStyle = "#000"; g.font = "bold 90px sans-serif"; g.fillText(t, 40, 170);
    return c.toDataURL("image/png").split(",")[1];
  }, text);
  return Buffer.from(b64, "base64");
}

/** Minimal valid one-page PDF containing `text` (Helvetica). */
export function makePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 40 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Minimal .docx (stored/uncompressed zip, hand-rolled so the e2e package needs no zip dependency) whose body is one paragraph of `text`. */
export function makeDocx(text: string): Buffer {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const files: Array<[string, string]> = [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ["word/document.xml", `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${esc}</w:t></w:r></w:p></w:body></w:document>`],
  ];
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const local: Buffer[] = [], central: Buffer[] = []; let off = 0;
  for (const [name, body] of files) {
    const n = Buffer.from(name), d = Buffer.from(body), c = crc(d);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    local.push(lh, n, d); central.push(ch, n); off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, end]);
}

// ---- header navigation that works on both layouts: >640px list screens have inline tabs/buttons; everywhere else (phones, and the
// start/chat screens on every width) the round hamburger (menu-button) opens the left drawer that holds every action ----
export type NavMode = "chat" | "cloud" | "agents" | "desktop" | "remote";
const visibleMenuButton = (page: Page) => page.getByTestId("menu-button").filter({ visible: true });
/** >=1024px: the persistent sidebar replaces the hamburger + drawer; it holds the same rows (same testids). */
export const hasSidebar = async (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
/** Wait until the drawer's slide-in has finished (bounding boxes measured mid-animation are off-screen). */
export async function drawerSettled(page: Page) {
  await expect(page.getByTestId("drawer")).toBeVisible();
  await page.getByTestId("drawer").evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished))).catch(() => {});
}
/** Open the drawer through the hamburger and wait for it. */
export async function openDrawer(page: Page) {
  if (await hasSidebar(page)) return; // desktop: the sidebar is always there
  // a click that lands while the screen is still re-rendering (its header is replaced, taking the drawer state with it) opens nothing: click again
  const drawer = page.getByTestId("drawer");
  await expect(async () => {
    if (!(await drawer.isVisible())) await visibleMenuButton(page).click();
    await expect(drawer).toBeVisible({ timeout: 2000 });
    await page.waitForTimeout(400); // the app can still be mounting right after goto(): a drawer that vanishes again is a miss, click again
    await expect(drawer).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 20_000 });
  await drawerSettled(page);
}
/** A drawer destination, with its collapsible group (Workspaces / More) opened first when it is not visible yet. Call with the drawer open (or the desktop sidebar). */
export async function navItem(page: Page, testid: string) {
  const el = page.getByTestId(testid).filter({ visible: true });
  if (await el.count()) return el.first();
  for (const g of ["drawer-group-workspaces"]) {
    const t = page.getByTestId(g).filter({ visible: true });
    if (await t.count() && (await t.first().getAttribute("aria-expanded")) === "false") { await t.first().click(); if (await el.count()) return el.first(); }
  }
  await expect(el.first()).toBeVisible();
  return el.first();
}
/** Click a header action ("Settings" | "Usage"), through the drawer when there is no inline button (phones, start/chat screens). */
export async function headerAction(page: Page, name: "Settings" | "Usage") {
  if (name === "Usage") { // Usage has no drawer/sidebar row any more (menu3): it is the Usage pane of the desktop Settings modal, or the "Usage & costs" row of the phone's Settings page
    const inline = page.getByRole("button", { name, exact: true }).filter({ visible: true });
    if (await inline.count()) { await inline.first().click(); return; }
    if (!(await hasSidebar(page))) await openDrawer(page);
    await page.getByTestId("menu-settings").filter({ visible: true }).first().click();
    const pane = page.getByTestId("settings-pane-usage"), row = page.getByTestId("open-usage");
    await pane.or(row).first().waitFor();
    if (await pane.count()) await pane.click(); else await row.click();
    return;
  }
  if (await hasSidebar(page)) { await page.getByTestId(`menu-${name.toLowerCase()}`).click(); return; }
  const inline = page.getByRole("button", { name, exact: true }).filter({ visible: true });
  // wait until one of the two paths is rendered: on a freshly loaded page neither may be there yet
  await expect(inline.or(visibleMenuButton(page)).first()).toBeVisible();
  if (await inline.count()) { await inline.first().click(); return; }
  await openDrawer(page);
  await (await navItem(page, `menu-${name.toLowerCase()}`)).click();
}
/** Switch mode via the tab (desktop list screens) or the drawer row. */
export async function switchMode(page: Page, mode: NavMode) {
  if (await hasSidebar(page)) { await page.getByTestId(`menu-mode-${mode}`).click(); return; }
  const tab = page.getByTestId(`tab-${mode}`).filter({ visible: true });
  await expect(tab.or(visibleMenuButton(page)).first()).toBeVisible();
  if (await tab.count()) { await tab.click(); return; }
  await openDrawer(page);
  await (await navItem(page, `menu-mode-${mode}`)).click();
}
/** Assert the current mode: aria-selected on the tab (desktop) or aria-current on the drawer row (opens and closes the drawer). */
export async function expectMode(page: Page, mode: NavMode) {
  if (await hasSidebar(page)) { await page.getByTestId(`menu-mode-${mode}`).click(); return; }
  const tab = page.getByTestId(`tab-${mode}`).filter({ visible: true });
  await expect(tab.or(visibleMenuButton(page)).first()).toBeVisible();
  if (await tab.count()) { await expect(tab).toHaveAttribute("aria-selected", "true"); return; }
  await openDrawer(page);
  await expect(await navItem(page, `menu-mode-${mode}`)).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("drawer")).toHaveCount(0);
}

/** Composer mode (Chat / Image / Video) is chosen in the "+" sheet: + → Mode → option. The sheet closes on pick. */
export async function pickMode(page: Page, mode: "Chat" | "Image" | "Video") {
  await page.getByTestId("composer-plus").click();
  await page.getByTestId("ctx-mode").click();
  await page.getByTestId("mode-chip").getByRole("button", { name: mode, exact: true }).click();
}
