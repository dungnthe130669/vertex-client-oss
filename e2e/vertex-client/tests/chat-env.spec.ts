import { test, expect, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { mockApp } from "./polish-mock";

// Devices v2 step 3 (docs/vertex-client-devices-v2.md section 10): a chat bound to a device. Picker on the new chat, banner per state, the step-1 status line in the normal chat, device approvals as the normal approval cards.
// API + chat socket mocked in the browser (local build via polish/serve.mjs): no login, no live device, no cost. The real round trip is NOT covered here (see docs/reports/devv2s3.md).
test.use({ serviceWorkers: "block" });
const SHOTS = process.env.DEVENV_SHOTS;
const NOW = Math.floor(Date.now() / 1000);
const ME = "0123abcd".padEnd(32, "0"), OTHER = "feedbeef".padEnd(32, "0");
const CONV = "00000000-0000-4000-8000-0000000000e1";
const row = (id: string, o: Record<string, unknown> = {}) => ({ id, name: "laptop", created_at: NOW - 86400, last_seen: NOW - 30, last_online_at: NOW - 30, online: true, roots: [{ label: "work", path: "/work/app" }], ...o });
type Env = { state: "ready" | "offline" | "revoked" | "unavailable"; dir?: string | null };
const convBody = (env: Env, messages: unknown[] = [], extra: Record<string, unknown> = {}) => ({ conversation: { id: CONV, title: "List the files", model: "claude-sonnet-5-5", pinned: 0, costUsd: 0, tokens: 0, projectId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  state: { seq: 0, minSeq: 0, running: false, inflight: null, model: "claude-sonnet-5-5", title: "List the files", error: null, costUsd: 0, tokens: 0, messages, ...extra },
  env: { kind: "device", device_id: ME, dir: env.dir === undefined ? "/work/app" : env.dir, name: "laptop", state: env.state } });
const msg = (id: number, role: string, content: unknown[]) => ({ id, role, content, model: role === "assistant" ? "device" : null, usage: null, costUsd: null, stopReason: null, status: "complete", ttftMs: null, totalMs: null, createdAt: Date.now() - 1000 });

async function open(page: Page, o: { shell?: boolean; devices?: unknown[]; envChats?: boolean; env?: Env; messages?: unknown[]; state?: Record<string, unknown>; onSocket?: (ws: WebSocketRoute, got: any) => void; path?: string }) {
  await mockApp(page, { erich: true });
  if (o.shell) await page.addInitScript(() => { (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined }; });
  const created: any[] = [], hdrs: (string | null)[] = [];
  await page.route(/\/api\/devices$/, (r: Route) => { hdrs.push(r.request().headers()["x-vc-install"] ?? null); return r.fulfill({ json: { devices: o.devices ?? [row(ME, { this_install: !!o.shell }), row(OTHER, { name: "studio", online: false, roots: [{ label: "a", path: "/a" }, { label: "b", path: "/b" }] })], server_now: Date.now(), env_chats: o.envChats !== false } }); });
  await page.route(/\/api\/conversations$/, (r: Route) => { if (r.request().method() !== "POST") return r.fallback(); created.push(r.request().postDataJSON()); return r.fulfill({ status: 201, json: { id: CONV } }); });
  if (o.env) await page.route(new RegExp(`/api/conversations/${CONV}$`), (r: Route) => r.fulfill({ json: convBody(o.env!, o.messages, o.state) }));
  const sent: any[] = [];
  await page.routeWebSocket(/\/api\/conversations\/.*\/ws/, (ws) => { ws.send(JSON.stringify({ t: "hello", seq: 0, minSeq: 0, running: false, now: Date.now() })); ws.onMessage((m) => { const got = JSON.parse(String(m)); sent.push(got); o.onSocket?.(ws, got); }); });
  await page.goto(o.path ?? (o.env ? `/c/${CONV}` : "/"));
  return { created, hdrs, sent };
}
const ev = (ws: WebSocketRoute, seq: number, e: Record<string, unknown>) => ws.send(JSON.stringify({ t: "ev", seq, ts: Date.now(), e }));
const connected = (page: Page) => expect(page.getByRole("img", { name: "Connection open" })).toBeVisible(); // a send before the socket is open is refused client-side: wait for it
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test.describe("new chat: environment picker", () => {
  test("browser: starts on Cloud (nothing guessed), lists devices incl. offline ones, creating on a device sends env with the chosen folder", async ({ page }, info) => {
    const s = await open(page, {});
    const sel = page.getByTestId("env-select"); await expect(sel).toBeVisible();
    await expect(sel).toHaveValue("");                                              // Cloud
    await expect(sel.locator("option")).toHaveText(["Cloud", "laptop", "studio · offline"]);
    await expect(page.getByTestId("model-pill")).toBeVisible();                     // cloud keeps the model picker
    await sel.selectOption(OTHER);
    await expect(page.getByTestId("model-pill")).toHaveCount(0);                    // a device chat has no model to pick
    const dir = page.getByTestId("env-dir"); await expect(dir).toBeVisible(); await expect(dir.locator("option")).toHaveText(["a", "b"]);
    await dir.selectOption("/b");
    await page.getByLabel("Message").fill("list the files"); await page.getByLabel("Send").click();
    await expect.poll(() => s.created.length).toBe(1);
    expect(s.created[0].env).toEqual({ kind: "device", device_id: OTHER, dir: "/b" });
    await noOverflow(page); if (SHOTS) await page.screenshot({ path: `${SHOTS}/picker-${info.project.name}.png` });
  });
  test("desktop app: defaults to this computer, sends the install id header, and Cloud is one tap away", async ({ page }) => {
    const s = await open(page, { shell: true });
    const sel = page.getByTestId("env-select");
    await expect(sel).toHaveValue(ME); await expect(sel.locator("option").nth(1)).toHaveText("laptop (this computer)");
    expect(s.hdrs.some((h) => /^[0-9a-f]{32}$/.test(h ?? ""))).toBe(true);
    await sel.selectOption(""); await page.getByLabel("Message").fill("cloud please"); await page.getByLabel("Send").click();
    await expect.poll(() => s.created.length).toBe(1); expect(s.created[0].env).toBeUndefined();   // plain cloud chat: no env field at all
  });
  test("environments off (env_chats false), or no devices: no picker at all, nothing new on the page", async ({ page }) => {
    await open(page, { envChats: false }); await expect(page.getByTestId("model-pill")).toBeVisible(); await expect(page.getByTestId("env-select")).toHaveCount(0);
  });
  test("no devices: no picker", async ({ page }) => { await open(page, { devices: [] }); await expect(page.getByTestId("model-pill")).toBeVisible(); await expect(page.getByTestId("env-select")).toHaveCount(0); });
});

test.describe("device chat: banner and composer", () => {
  const cases: Array<[Env["state"], string, string]> = [["ready", "Running on laptop · /work/app", ""], ["offline", "laptop is offline. Messages will run when it comes back.", ""], ["revoked", "laptop was revoked. This chat is read-only.", "disabled"], ["unavailable", "Devices are turned off for this account. This chat is read-only.", "disabled"]];
  for (const [state, text, send] of cases) for (const scheme of ["light", "dark"] as const) test(`${state} (${scheme})`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, { env: { state }, envChats: state !== "unavailable", devices: state === "revoked" ? [] : [row(ME, { online: state !== "offline" })] });   // an unavailable chat is one the server reports while the switch is OFF: the list agrees (env_chats false)
    const b = page.getByTestId("env-banner"); await expect(b).toHaveText(text); await expect(b).toHaveAttribute("data-state", state);
    await expect(page.getByTestId("model-pill")).toHaveCount(0);
    await page.getByLabel("Message").fill("hello");
    if (send) await expect(page.getByLabel("Send")).toBeDisabled(); else await expect(page.getByLabel("Send")).toBeEnabled();
    expect(await b.innerText()).not.toMatch(/mac|windows|linux/i);
    await noOverflow(page); if (SHOTS) await page.screenshot({ path: `${SHOTS}/banner-${state}-${info.project.name}-${scheme}.png` });
  });
  test("the banner follows the device list without a reload: online -> offline", async ({ page }) => {
    let online = true;
    await mockApp(page, { erich: true });
    await page.route(/\/api\/devices$/, (r) => r.fulfill({ json: { devices: [row(ME, { online })], env_chats: true } }));
    await page.route(new RegExp(`/api/conversations/${CONV}$`), (r) => r.fulfill({ json: convBody({ state: "ready" }) }));
    await page.clock.install(); await page.goto(`/c/${CONV}`);
    await expect(page.getByTestId("env-banner")).toHaveAttribute("data-state", "ready");
    online = false; await page.clock.fastForward(21_000);
    await expect(page.getByTestId("env-banner")).toHaveAttribute("data-state", "offline");
  });
});

test.describe("devv2s3s: the open chat follows the environment switch", () => {
  test("switch OFF (env_chats false, or the master switch: /api/devices 404) makes the open chat unavailable and Send disabled after the next refresh; a transient error does not; ON restores it", async ({ page }) => {
    let mode: "on" | "off" | "master" | "err" = "on";
    await mockApp(page, { erich: true });
    await page.route(/\/api\/devices$/, (r) => mode === "master" ? r.fulfill({ status: 404, json: { error: "not found" } }) : mode === "err" ? r.fulfill({ status: 503, json: { error: "x" } }) : r.fulfill({ json: { devices: [row(ME, { online: true })], env_chats: mode === "on" } }));
    await page.route(new RegExp(`/api/conversations/${CONV}$`), (r) => r.fulfill({ json: convBody({ state: "ready" }) }));
    await page.clock.install(); await page.goto(`/c/${CONV}`);
    const banner = page.getByTestId("env-banner");
    await expect(banner).toHaveAttribute("data-state", "ready");
    mode = "err"; await page.clock.fastForward(21_000); await page.clock.fastForward(1000);
    await expect(banner).toHaveAttribute("data-state", "ready");                       // a transient error is not a confirmed OFF
    mode = "off"; await page.clock.fastForward(21_000);
    await expect(banner).toHaveAttribute("data-state", "unavailable"); await expect(banner).toHaveText("Devices are turned off for this account. This chat is read-only.");
    await expect(page.getByLabel("Send")).toBeDisabled();
    mode = "on"; await page.clock.fastForward(21_000);
    await expect(banner).toHaveAttribute("data-state", "ready");                       // switched back on: the chat is usable again without a reload
    mode = "master"; await page.clock.fastForward(21_000);
    await expect(banner).toHaveAttribute("data-state", "unavailable");
  });
});

test.describe("devv2t: a chat loaded while the switch was OFF recovers when it is turned ON", () => {
  test("load OFF (server says unavailable) -> read-only; switch ON + device-list refresh -> ready/offline and Send usable WITHOUT a reload", async ({ page }) => {
    let on = false, online = true;
    await mockApp(page, { erich: true });
    await page.route(/\/api\/devices$/, (r) => r.fulfill({ json: { devices: [row(ME, { online })], env_chats: on } }));
    await page.route(new RegExp(`/api/conversations/${CONV}$`), (r) => r.fulfill({ json: convBody({ state: "unavailable" }) }));   // what the server reports while the switch is off
    await page.clock.install(); await page.goto(`/c/${CONV}`);
    const banner = page.getByTestId("env-banner");
    await expect(banner).toHaveAttribute("data-state", "unavailable"); await expect(page.getByLabel("Send")).toBeDisabled();
    on = true; await page.clock.fastForward(21_000);
    await expect(banner).toHaveAttribute("data-state", "ready"); await expect(page.getByLabel("Message")).toBeEnabled();
    await page.getByLabel("Message").fill("now it works"); await expect(page.getByLabel("Send")).toBeEnabled();
    online = false; await page.clock.fastForward(21_000);
    await expect(banner).toHaveAttribute("data-state", "offline"); await expect(page.getByLabel("Send")).toBeEnabled();   // offline still queues
  });
});

test.describe("device chat: status line + approvals in the normal chat", () => {
  test("queued -> sent -> waiting -> received -> working -> gone at the end; silence turns into 'not answering' after 15 s", async ({ page }) => {
    await open(page, { env: { state: "ready" }, onSocket: (ws, got) => { if (got.t !== "send") return;
      ev(ws, 1, { type: "user_message", message: msg(1, "user", [{ type: "text", text: got.text }]) }); ev(ws, 2, { type: "turn_start", turn: 1 }); ev(ws, 3, { type: "device_ev", e: { type: "cmd_ack", cid: "c1", queued: false } }); } });
    await connected(page); await page.clock.install();
    await page.getByLabel("Message").fill("list the files"); await page.getByLabel("Send").click();
    const line = page.getByTestId("device-status");
    await expect(line).toHaveText("Sent to laptop…");
    await page.clock.fastForward(16_000);
    await expect(line).toHaveText("laptop is not answering; it may be asleep or offline."); await expect(line).toHaveAttribute("data-state", "unreachable");
  });
  test("an offline device reads queued, and the lifecycle events move the line", async ({ page }) => {
    let wsr: WebSocketRoute | null = null;
    await open(page, { env: { state: "offline" }, devices: [row(ME, { online: false })], onSocket: (ws, got) => { wsr = ws; if (got.t !== "send") return;
      ev(ws, 1, { type: "user_message", message: msg(1, "user", [{ type: "text", text: got.text }]) }); ev(ws, 2, { type: "turn_start", turn: 1 }); ev(ws, 3, { type: "device_ev", e: { type: "cmd_ack", cid: "c1", queued: true } }); } });
    await connected(page);
    await page.getByLabel("Message").fill("when you wake"); await page.getByLabel("Send").click();
    const line = page.getByTestId("device-status"); await expect(line).toHaveText("Device is offline. Will run when it reconnects."); await expect(line).toHaveAttribute("data-state", "queued");
    ev(wsr!, 4, { type: "device_ev", e: { type: "cmd_sent", cid: "c1", cseq: 1 } }); await expect(line).toHaveText("Waiting for laptop…");
    ev(wsr!, 5, { type: "device_ev", e: { type: "cmd_acked", cid: "c1", cseq: 1 } }); await expect(line).toHaveText("laptop received it");
    ev(wsr!, 6, { type: "device_ev", e: { type: "assistant_text" } }); await expect(line).toHaveText("Working…");
    ev(wsr!, 7, { type: "assistant_saved", message: msg(2, "assistant", [{ type: "text", text: "All done." }]) });
    ev(wsr!, 8, { type: "turn_end", status: "done", error: null, costUsd: 0, tokens: 0 });
    await expect(line).toHaveCount(0); await expect(page.getByText("All done.")).toBeVisible();
  });
  test("a device approval is the normal approval card on the tool call; Allow sends the normal approve frame once", async ({ page }) => {
    const tool = msg(2, "assistant", [{ type: "text", text: "I will delete tmp." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf tmp" } }]);
    const s = await open(page, { env: { state: "ready" }, messages: [msg(1, "user", [{ type: "text", text: "clean up" }]), tool], state: { running: true, inflight: { fromSeq: 0 }, awaiting: { expiresAt: Date.now() + 120_000, calls: [{ id: "t1", name: "Bash", input: { preview: "rm -rf tmp" }, decision: null, host: null, canAlways: false, reason: null }] } } });
    const card = page.getByTestId("tool-card"); await expect(card).toContainText("Bash"); await expect(card).toContainText("needs approval");
    await page.getByRole("button", { name: /^Allow|Approve/i }).first().click();
    await expect.poll(() => s.sent.filter((f) => f.t === "approve").length).toBe(1);
    expect(s.sent.find((f) => f.t === "approve")).toMatchObject({ t: "approve", id: "t1", decision: "approve" });
  });
  test("no horizontal overflow with a long folder path", async ({ page }) => {
    await open(page, { env: { state: "ready", dir: "/Users/someone/projects/a-very-long-folder-name/with/many/nested/segments/app" } }); await expect(page.getByTestId("env-banner")).toBeVisible(); await noOverflow(page);
  });
});
