// comp2: device self-description (os / arch / termState) is whitelisted at the hub; the web helpers map it to labels and gate text.
import { describe, expect, test } from "bun:test";
import { parseDeviceFrame, sanitiseSelf } from "../src/device-core";
import { TERM_FIX, osLabel, termGate, termStateOf } from "../web/src/computers-logic";

const info = (i: Record<string, unknown>) => (parseDeviceFrame({ t: "hello", lastCseq: 0, info: i }) as any).info.self;
describe("comp2 hello validation", () => {
  test("good values pass through", () => {
    expect(info({ os: "win32", arch: "arm64", termState: "unsupported", termWhy: "needs Bun" })).toEqual({ os: "win32", arch: "arm64", termState: "unsupported", termWhy: "needs Bun" });
    expect(info({ os: "darwin", termState: "on" })).toEqual({ os: "darwin", termState: "on" });
  });
  test("garbage / oversized / wrong-type values are dropped", () => {
    expect(info({ os: "<img src=x>", arch: "x".repeat(5000), termState: "maybe" })).toEqual({});
    expect(info({ os: 5, arch: {}, termState: ["on"], termWhy: "x" })).toEqual({});
    expect(info({ os: "Linux", termState: "ON" })).toEqual({});   // exact enum only
  });
  test("termWhy: only with unsupported, control chars and angle brackets stripped, capped at 160", () => {
    expect(info({ termState: "off_switch", termWhy: "nope" })).toEqual({ termState: "off_switch" });
    const s = sanitiseSelf({ termState: "unsupported", termWhy: "a<b>\u0000\n" + "y".repeat(1000) });
    expect(s.termWhy!.length).toBeLessThanOrEqual(160); expect(s.termWhy).not.toMatch(/[<>\u0000\n]/);
    expect(sanitiseSelf({ termState: "unsupported", termWhy: "<>" }).termWhy).toBeUndefined();
  });
  test("old runtime (no fields) -> empty self", () => { expect(info({ name: "n" })).toEqual({}); });
});
describe("comp2 UI helpers", () => {
  test("osLabel: known OS only", () => {
    expect([osLabel("darwin"), osLabel("linux"), osLabel("win32")]).toEqual(["macOS", "Linux", "Windows"]);
    expect([osLabel(undefined), osLabel("toString"), osLabel("<b>"), osLabel(3)]).toEqual([null, null, null, null]);
  });
  test("termStateOf whitelists", () => { expect(termStateOf("on")).toBe("on"); expect(termStateOf("x")).toBeUndefined(); expect(termStateOf(undefined)).toBeUndefined(); });
  const base = { helloed: true, termOn: false, online: true };
  test("gate: off_switch -> exact fix; unsupported -> plain text (+why); on-but-off (account flag) and unknown -> generic", () => {
    const a = termGate({ ...base, termState: "off_switch" }); expect(a.fix).toBe(TERM_FIX); expect(a.title).toContain("switched off");
    const u = termGate({ ...base, termState: "unsupported", termWhy: "the terminal needs the Bun runtime" }); expect(u.title).toBe("This computer cannot run the terminal"); expect(u.fix).toBeUndefined(); expect(u.text).toContain("Bun");
    expect(termGate({ ...base, termState: "unsupported" }).text).toContain("cannot provide a terminal");
    const g = termGate(base), on = termGate({ ...base, termState: "on" }); expect(g.title).toBe("Terminal is off on this computer"); expect(on).toEqual(g);
    expect(termGate({ ...base, termOn: true, termState: "unsupported" }).kind).toBe("ready");
    expect(termGate({ ...base, online: false, termState: "unsupported" }).kind).toBe("offline");
  });
});
