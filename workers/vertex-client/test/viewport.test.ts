import { describe, expect, it, test } from "bun:test";
import { appVh, keyboardOpen, type VpEnv } from "../web/src/viewport";

const base: VpEnv = { inner: 790, vvHeight: 790, vvTop: 0, lvh: 790, screenH: 852, standalone: true, portrait: true, kb: false };
describe("appVh", () => {
  test("standalone portrait: the short fixed/vv heights lose to the screen height (the ~60pt gap)", () => {
    expect(appVh(base)).toBe(852);
  });
  test("standalone landscape ignores screen.height (it is the portrait dimension)", () => {
    expect(appVh({ ...base, portrait: false, inner: 393, vvHeight: 393, lvh: 393, screenH: 852 })).toBe(393);
  });
  test("standalone takes vv.height + offsetTop and 100lvh when larger", () => {
    expect(appVh({ ...base, portrait: false, vvHeight: 380, vvTop: 20, inner: 390, lvh: 400 })).toBe(400);
    expect(appVh({ ...base, portrait: false, vvHeight: 400, vvTop: 30, inner: 390, lvh: 395 })).toBe(430);
  });
  test("browser tab: the visual viewport, untouched by screen.height", () => {
    expect(appVh({ ...base, standalone: false, vvHeight: 700 })).toBe(700);
  });
  test("keyboard open: the visual viewport as today (no stale home-indicator gap), even in standalone", () => {
    expect(appVh({ ...base, kb: true, vvHeight: 480, vvTop: 0 })).toBe(480);
  });
  test("ignores zero/NaN probes", () => {
    expect(appVh({ ...base, lvh: 0, screenH: NaN, inner: 800 })).toBe(800);
  });
});

describe("keyboardOpen", () => {
  const e = { inner: 480, vvHeight: 480, vvTop: 0, lvh: 480, screenH: 852, portrait: true, editable: true };
  it("PWA where innerHeight shrinks with the keyboard: editable focus + small visual viewport", () => expect(keyboardOpen(e)).toBe(true));
  it("no editable focus: not a keyboard", () => expect(keyboardOpen({ ...e, editable: false })).toBe(false));
  it("editable focused, full height: closed", () => expect(keyboardOpen({ ...e, inner: 852, vvHeight: 852, lvh: 852 })).toBe(false));
  it("classic gap between inner and visual viewport", () => expect(keyboardOpen({ ...e, inner: 800, vvHeight: 500, editable: false })).toBe(true));
});
