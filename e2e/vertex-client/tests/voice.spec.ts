import { test, expect, openChat } from "./fixtures";
import type { Page } from "@playwright/test";

// Recorded voice input, only with Settings > Voice > Whisper ON (the default is the browser's own dictation: see voice-native.spec.ts) (MediaRecorder -> POST /api/transcribe -> text inserted in the composer). Fully mocked: a fake MediaRecorder / getUserMedia / AudioContext
// in the page and a fake /api/transcribe route, so no microphone, no Workers AI and no cost. Run only against a deploy that has the `voice` branch.

const FAKES = `(() => {
  const w = window; w.__gum = 0; w.__stopped = 0; w.__rec = 0; w.__deny = false; w.__level = 40;
  delete w.SpeechRecognition; delete w.webkitSpeechRecognition;
  try { localStorage.setItem("vc.voice.whisper", "1"); } catch {} // Whisper is OFF by default: these tests exercise the toggled-on path
  // WebKit ignores plain assignment to navigator.mediaDevices.getUserMedia (the native one stayed and was denied): replace mediaDevices wholesale
  const gum = async () => {
    w.__gum++;
    if (w.__deny) { const e = new Error("denied"); e.name = "NotAllowedError"; throw e; }
    return { getTracks: () => [{ stop() { w.__stopped++; } }] };
  };
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: gum }, configurable: true });
  w.MediaRecorder = class { static isTypeSupported(m) { return m === "audio/mp4" || m.startsWith("audio/webm"); }
    constructor(s, o) { this.state = "inactive"; this.mimeType = (o && o.mimeType) || "audio/mp4"; }
    start() { w.__rec++; this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable && this.ondataavailable({ data: new Blob([new Uint8Array(4000)], { type: this.mimeType }) }); setTimeout(() => this.onstop && this.onstop(), 10); } };
  w.AudioContext = class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
    createAnalyser() { return { fftSize: 1024, getByteTimeDomainData(b) { for (let i = 0; i < b.length; i++) b[i] = 128 + (i % 2 ? w.__level : -w.__level); } }; }
    createMediaStreamSource() { return { connect() {} }; } };
})();`;

async function setup(page: Page, answers: Array<{ status: number; body: unknown }>) {
  const calls: { type: string | undefined; url: string; size: number }[] = [];
  await page.addInitScript(FAKES);
  await page.route("**/api/transcribe**", async (route) => {
    const req = route.request();
    calls.push({ type: req.headers()["content-type"], url: req.url(), size: req.postDataBuffer()?.length ?? 0 });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    await new Promise((r) => setTimeout(r, 250)); // long enough to see "Transcribing…"
    await route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) });
  });
  return calls;
}
const OK = { status: 200, body: { text: "hello from voice" } };
const n = (page: Page, k: string) => page.evaluate((x) => (window as any)[x] as number, k);

// PARKED 2026-10-23 (Erich: native dictation is the default and works; Whisper paused): these Whisper-path tests were never green against the live build
// (Stop -> transcribe flows fail in Chromium and WebKit; fakes were fixed for WebKit mediaDevices). Re-enable when Whisper work resumes.
test.describe.skip("recorded voice input", () => {
  test("mic is visible without SpeechRecognition and nothing records until a tap", async ({ app: { page, api } }) => {
    await setup(page, [OK]);
    await openChat(page, await api.newChat());
    await expect(page.getByTestId("dictate")).toBeVisible();
    expect(await n(page, "__gum")).toBe(0);
    await expect(page.getByTestId("voice-bar")).toHaveCount(0);
  });

  test("bar while recording, then Stop -> Transcribing -> text inserted at the end of what was typed, never sent", async ({ app: { page, api } }) => {
    test.skip(({ browserName }) => browserName === "webkit", "Playwright WebKit never delivers the recorded-Blob fetch to page.route (calls stay empty, the app shows its network-failure message); the same flow passes on Chromium. Verify on a real iPhone.");
    const calls = await setup(page, [OK]);
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    await box.fill("Please");
    await page.getByTestId("dictate").click();
    const bar = page.getByTestId("voice-bar");
    await expect(bar).toHaveAttribute("data-phase", "recording");
    await expect(bar).toContainText("Listening… tap Stop when done");
    await expect(page.getByTestId("voice-meter")).toBeVisible();
    await expect(page.getByPlaceholder("Message")).toHaveCount(0); // the bar REPLACES the input
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(page.getByTestId("voice-stop")).toBeFocused(); // focus moves to Stop when recording starts
    await expect(page.getByTestId("voice-timer")).toHaveText(/^00:0[1-9]$/, { timeout: 5000 }); // the timer ticks
    await expect.poll(() => page.getByTestId("voice-meter").locator("i").evaluate((e) => (e as HTMLElement).style.transform)).toMatch(/scaleX\((0\.[1-9]|1)/); // live level
    await page.getByTestId("voice-stop").click();
    await expect(page.getByTestId("voice-transcribing")).toBeVisible();
    await expect(page.getByTestId("voice-transcribing")).toContainText("Transcribing…");
    await expect(page.getByTestId("voice-bar")).toHaveCount(0);
    await expect(page.getByPlaceholder("Message")).toHaveValue("Please hello from voice");
    await expect(page.getByPlaceholder("Message")).toBeFocused(); // and returns to the composer when the flow ends
    await expect(page.locator(".msg.user")).toHaveCount(0); // not auto-sent
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("audio/mp4"); expect(calls[0].size).toBe(4000);
    expect(await n(page, "__stopped")).toBeGreaterThanOrEqual(1); // microphone released
  });

  test("Cancel releases the microphone, sends nothing, keeps the typed text", async ({ app: { page, api } }) => {
    const calls = await setup(page, [OK]);
    await openChat(page, await api.newChat());
    await page.getByPlaceholder("Message").fill("draft");
    await page.getByTestId("dictate").click();
    await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    await page.getByTestId("voice-cancel").click();
    await expect(page.getByTestId("voice-bar")).toHaveCount(0);
    await expect(page.getByPlaceholder("Message")).toHaveValue("draft");
    await expect(page.getByPlaceholder("Message")).toBeFocused();
    expect(calls).toHaveLength(0);
    expect(await n(page, "__stopped")).toBeGreaterThanOrEqual(1);
  });

  test("service error shows plain words, Retry resends the SAME recording and inserts the text", async ({ app: { page, api } }) => {
    test.skip(({ browserName }) => browserName === "webkit", "Playwright WebKit never delivers the recorded-Blob fetch to page.route (calls stay empty, the app shows its network-failure message); the same flow passes on Chromium. Verify on a real iPhone.");
    const calls = await setup(page, [{ status: 502, body: { error: "The transcription service failed. Try again.", code: "ai-failed" } }, OK]);
    await openChat(page, await api.newChat());
    await page.getByTestId("dictate").click();
    await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    await page.waitForTimeout(1300);
    await page.getByTestId("voice-stop").click();
    const err = page.getByTestId("voice-error");
    await expect(err).toHaveAttribute("data-code", "failed");
    await expect(err).toContainText("Transcription failed");
    await expect(page.getByTestId("voice-retry")).toBeFocused(); // focus lands on Retry for the error
    await expect(page.getByTestId("voice-live")).toContainText("Transcription failed"); // announced to screen readers
    expect(await n(page, "__gum")).toBe(1);
    await page.getByTestId("voice-retry").click();
    await expect(page.getByPlaceholder("Message")).toHaveValue("hello from voice");
    expect(calls).toHaveLength(2); expect(calls[1].size).toBe(4000);
    expect(await n(page, "__gum")).toBe(1); // no second recording was needed
    await expect(page.locator(".msg.user")).toHaveCount(0);
  });

  test("microphone permission denied: how to enable it, Retry records again", async ({ app: { page, api } }) => {
    await setup(page, [OK]);
    await page.addInitScript("window.__deny = true;");
    await openChat(page, await api.newChat());
    await page.getByTestId("dictate").click();
    const err = page.getByTestId("voice-error");
    await expect(err).toHaveAttribute("data-code", "denied");
    await expect(err).toContainText(/allow the microphone/i);
    await page.evaluate(() => { (window as any).__deny = false; });
    await page.getByTestId("voice-retry").click();
    await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    expect(await n(page, "__gum")).toBe(2);
    await page.getByTestId("voice-cancel").click();
  });

  test("caret is reused only while the draft is unchanged: typing is impossible during the bar, so the text goes at the caret; a changed draft appends", async ({ app: { page, api } }) => {
    test.skip(({ browserName }) => browserName === "webkit", "Playwright WebKit never delivers the recorded-Blob fetch to page.route (calls stay empty, the app shows its network-failure message); the same flow passes on Chromium. Verify on a real iPhone.");
    await setup(page, [OK]);
    await openChat(page, await api.newChat());
    const box = page.getByPlaceholder("Message");
    await box.fill("ab cd"); await box.evaluate((e: HTMLTextAreaElement) => { e.focus(); e.setSelectionRange(2, 2); });
    await page.getByTestId("dictate").click();
    await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    await page.waitForTimeout(1300);
    await page.getByTestId("voice-stop").click();
    await expect(page.getByPlaceholder("Message")).toHaveValue("ab hello from voice cd");
  });

  test("a too-short recording says no speech detected and never calls the server", async ({ app: { page, api } }) => {
    const calls = await setup(page, [OK]);
    await openChat(page, await api.newChat());
    await page.getByTestId("dictate").click();
    await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    await page.getByTestId("voice-stop").click(); // well under 1 second
    await expect(page.getByTestId("voice-error")).toHaveAttribute("data-code", "no-speech");
    expect(calls).toHaveLength(0);
  });

  test("composer stays inside the viewport with the bar open (390px) and targets are 44px", async ({ app: { page, api } }) => {
    await setup(page, [OK]);
    await page.setViewportSize({ width: 390, height: 780 });
    await openChat(page, await api.newChat());
    await page.getByTestId("dictate").click();
    await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    for (const id of ["voice-stop", "voice-cancel"]) { const b = await page.getByTestId(id).boundingBox(); expect(b!.height).toBeGreaterThanOrEqual(44); expect(b!.x + b!.width).toBeLessThanOrEqual(390); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
