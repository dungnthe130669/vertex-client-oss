import { describe, expect, test } from "bun:test";
import { TERM_FIX, cardState, linkPill, termGate } from "../web/src/computers-logic";
import { KEYS, bannerFor } from "../web/src/term-client";

describe("comp1 linkPill", () => {
  test("Connecting -> Connected -> Reconnecting -> Offline, one word per state", () => {
    expect(linkPill("connecting", false, true).label).toBe("Connecting…");
    expect(linkPill("live", false, true).label).toBe("Connecting…"); // socket up, hello not yet in
    expect(linkPill("live", true, true)).toEqual({ label: "Connected", tone: "ok", reconnect: false });
    expect(linkPill("reconnecting", true, true)).toEqual({ label: "Reconnecting…", tone: "warn", reconnect: true });
    expect(linkPill("closed", true, true)).toEqual({ label: "Offline", tone: "off", reconnect: true });
    expect(linkPill("live", true, false)).toEqual({ label: "Offline", tone: "off", reconnect: false }); // the computer itself is offline: a socket retry cannot help
    expect(linkPill("revoked", true, true).reconnect).toBe(false);
  });
});
describe("comp1 termGate", () => {
  test("checking until hello; ready when on", () => {
    expect(termGate({ helloed: false, termOn: false, online: true }).kind).toBe("checking");
    expect(termGate({ helloed: true, termOn: true, online: true }).kind).toBe("ready");
  });
  test("off: plain explanation + the exact one-line fix, never a dead tab", () => {
    const g = termGate({ helloed: true, termOn: false, online: true });
    expect(g.kind).toBe("off"); expect(g.fix).toBe("vcl set terminal on"); expect(TERM_FIX).toBe(g.fix!); expect(g.text!).toContain("vcl set terminal on"); expect(g.text!).toContain("desktop app");
  });
  test("comp1b: offline wins over a stale termOn (device_offline does not clear it); checking stays first", () => {
    expect(termGate({ helloed: true, termOn: true, online: false }).kind).toBe("offline");
    expect(termGate({ helloed: false, termOn: true, online: false }).kind).toBe("checking");
  });
  test("offline computer is explained as offline, not as 'terminal off'", () => {
    const g = termGate({ helloed: true, termOn: false, online: false });
    expect(g.kind).toBe("offline"); expect(g.fix).toBeUndefined();
  });
});
describe("comp1 misc", () => {
  test("card state words", () => { expect(cardState(true).label).toBe("Online"); expect(cardState(false).cls).toBe("offline"); expect(cardState(null).cls).toBe("unknown"); });
  test("phone key row has Esc/Tab/arrows/| ~ /", () => { expect(KEYS.map((k) => k.id)).toEqual(["esc", "tab", "up", "down", "left", "right", "pipe", "tilde", "slash"]); expect(KEYS.find((k) => k.id === "pipe")!.seq).toBe("|"); });
  test("an unconfirmed (e.g. Windows) session never says restricted", () => { expect(bannerFor(undefined).text).not.toMatch(/^restricted/i); expect(bannerFor("open").text).not.toMatch(/^restricted/i); });
});
