import { afterEach, describe, expect, test } from "bun:test";
import { probeDevices } from "../web/src/devices-available";
import { readFileSync } from "node:fs";

const REAL = globalThis.fetch;
afterEach(() => { globalThis.fetch = REAL; });
const answer = (status: number) => { globalThis.fetch = (async () => new Response(JSON.stringify(status === 200 ? { devices: [] } : { error: "x" }), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch; };

describe("menu2-fix1: the Devices availability probe (same one the Settings row always used)", () => {
  test("200 = available; 404 (flag off), 403 and a network failure = hidden", async () => {
    answer(200); expect(await probeDevices()).toBe(true);
    answer(404); expect(await probeDevices()).toBe(false);
    answer(403); expect(await probeDevices()).toBe(false);
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch; expect(await probeDevices()).toBe(false);
  });
});

describe("menu2-fix1: action-bearing bars stay visible in the desktop Settings pane", () => {
  const src = (f: string) => readFileSync(new URL(`../web/src/${f}`, import.meta.url), "utf8");
  test("Pair a device, Add custom connector and Refresh carry the bar-act marker", () => {
    expect(src("devices.tsx")).toMatch(/class="rbtn bar-act" aria-label="Pair a device"[^>]*data-testid="pair-open"/);
    expect(src("connectors.tsx")).toMatch(/class="rbtn bar-act" aria-label="Add custom connector"[^>]*data-testid="connector-add"/);
    expect(src("usage.tsx")).toMatch(/class="rbtn bar-act" aria-label="Refresh"[^>]*data-testid="usage-refresh"/);
  });
  test("the pane CSS hides plain bars but keeps (and re-lays-out) bars with an action, hiding only their Back + title", () => {
    const css = src("styles.css");
    expect(css).toContain(".setpane .bar { display:none; }");
    expect(css).toMatch(/\.setpane \.bar:has\(\.bar-act\) \{ display:flex;/);
    expect(css).toMatch(/\.setpane \.bar:has\(\.bar-act\) > :not\(\.bar-act\) \{ display:none; \}/);
  });
});
