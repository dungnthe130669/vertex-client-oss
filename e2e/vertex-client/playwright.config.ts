import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));

// e2eperf1: spec lists that steer what runs where (files next to run.sh; see docs/vertex-client-e2e-slots.md).
const list = (f: string): string[] => readFileSync(join(HERE, f), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));   // a missing list must throw, never silently empty
const spec = (b: string) => `**/${b}.spec.ts`;
const fast = list("bot-free-specs.txt").map(spec);                       // mocked-API specs: never touch the live backend, so a hung test is a bug -> 60 s instead of 150 s (slowest observed: 25 s)
const dedup = process.env.E2E_DEDUP === "1" ? list("chromium-only-specs.txt").map(spec) : [];   // CORE tier: logic-only specs skip the iphone duplicate
const liveDevice = (process.env.E2E_GREP ?? "").startsWith("vclterm") ? [] : ["**/device-term-live.spec.ts", "**/device-term-live12.spec.ts"];   // need a real paired Mac: only when a vclterm phase is selected

// Two projects: an iPhone (WebKit) and a desktop Chromium. Serial (workers:1): every test talks to the live app and the
// app itself caps concurrent generations at 3; serial also keeps cost and flakiness predictable.
const outDir = process.env.E2E_OUT ?? "out";
export default defineConfig({
  testDir: "tests",
  // Erich 2026-10-27: the Cloud/Agents/Desktop container specs are PAUSED (spike done; they ran real agent-spike containers every day and cost money for no coverage we use). Files are kept for when Cloud mode is developed: remove this line then.
  testIgnore: process.env.E2E_CLOUD === "1" ? [] : ["**/cloud.spec.ts", "**/cloud-stop.spec.ts", "**/agents.spec.ts", "**/desktop.spec.ts"].concat(liveDevice),
  outputDir: `${outDir}/test-results`,
  timeout: 150_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: process.env.E2E_RETRIES ? Number(process.env.E2E_RETRIES) : 1,
  reporter: [["list"], ["json", { outputFile: `${outDir}/results.json` }], ["html", { outputFolder: `${outDir}/playwright-report`, open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://app.internal.invalid",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  // Two device profiles x (live | mocked). The "-mock" projects run only the bot-free specs with a 60 s timeout (same device, same tags); project names start with the profile name.
  projects: [
    // @desktop-only = real agent wake-ups (cost) / browser-engine limits: run once on desktop-chromium, excluded here instead of skipped.
    { name: "iphone-webkit", use: { ...devices["iPhone 15"] }, grepInvert: /@desktop-only/, testIgnore: [...fast, ...dedup] },
    { name: "iphone-webkit-mock", use: { ...devices["iPhone 15"] }, grepInvert: /@desktop-only/, testMatch: fast, testIgnore: dedup, timeout: 60_000 },
    // @mobile-only = phone layout / touch rules: run once on iphone-webkit, excluded here instead of skipped.
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } }, grepInvert: /@mobile-only/, testIgnore: fast },
    { name: "desktop-chromium-mock", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } }, grepInvert: /@mobile-only/, testMatch: fast, timeout: 60_000 },
  ],
});
