import { describe, expect, test } from "bun:test";
import { SIDEBAR_KEY, artifactIdOf, inDesktopShell, isChatPath, isSettingsPath, mainPath, nextBase, readSidebarOpen, settingsPanes, shortcutOf, writeSidebarOpen } from "../web/src/desk-logic";

const ID = "0123abcd-0123-abcd-0123-0123abcd0123";

describe("sidebar state", () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
  test("open by default, remembers a collapse", () => {
    const s = mem();
    expect(readSidebarOpen(s)).toBe(true);
    writeSidebarOpen(s, false);
    expect(s.m.get(SIDEBAR_KEY)).toBe("closed");
    expect(readSidebarOpen(s)).toBe(false);
    writeSidebarOpen(s, true);
    expect(readSidebarOpen(s)).toBe(true);
  });
  test("storage that throws or is missing never breaks it", () => {
    const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readSidebarOpen(bad)).toBe(true);
    expect(() => writeSidebarOpen(bad, false)).not.toThrow();
    expect(readSidebarOpen(null)).toBe(true);
    expect(() => writeSidebarOpen(undefined, false)).not.toThrow();
  });
  test("garbage in storage means open", () => { expect(readSidebarOpen({ getItem: () => "weird" })).toBe(true); });
});

describe("shortcutOf", () => {
  test("Ctrl/Cmd+K and +B, any letter case", () => {
    expect(shortcutOf({ key: "k", metaKey: true })).toBe("palette");
    expect(shortcutOf({ key: "K", ctrlKey: true })).toBe("palette");
    expect(shortcutOf({ key: "b", ctrlKey: true })).toBe("toggle-sidebar");
    expect(shortcutOf({ key: "B", metaKey: true })).toBe("toggle-sidebar");
  });
  test("Escape, with or without modifiers", () => { expect(shortcutOf({ key: "Escape" })).toBe("escape"); });
  test("plain keys and shift/alt variants are left to the browser", () => {
    expect(shortcutOf({ key: "k" })).toBeNull();
    expect(shortcutOf({ key: "b" })).toBeNull();
    expect(shortcutOf({ key: "k", metaKey: true, shiftKey: true })).toBeNull();
    expect(shortcutOf({ key: "b", ctrlKey: true, altKey: true })).toBeNull();
    expect(shortcutOf({ key: "x", ctrlKey: true })).toBeNull();
  });
});

describe("menu2 shortcuts (C11): Ctrl/Cmd+Shift+O everywhere, Ctrl/Cmd+N only in the desktop shell, Ctrl/Cmd+, Settings", () => {
  test("new chat: Shift+O in any browser tab, plain N only when the shell says so", () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(shortcutOf({ key: "O", shiftKey: true, ...mod })).toBe("new-chat");
      expect(shortcutOf({ key: "o", shiftKey: true, ...mod }, true)).toBe("new-chat");
      expect(shortcutOf({ key: "n", ...mod })).toBeNull(); // the browser's own Ctrl+N: never claimed in a tab
      expect(shortcutOf({ key: "n", ...mod }, true)).toBe("new-chat");
      expect(shortcutOf({ key: ",", ...mod })).toBe("settings");
      expect(shortcutOf({ key: ",", ...mod }, true)).toBe("settings");
    }
  });
  test("no modifier, wrong modifier combos and other Shift keys stay with the browser", () => {
    expect(shortcutOf({ key: "O", shiftKey: true })).toBeNull();
    expect(shortcutOf({ key: "n" }, true)).toBeNull();
    expect(shortcutOf({ key: ",", ctrlKey: true, altKey: true })).toBeNull();
    expect(shortcutOf({ key: "N", ctrlKey: true, shiftKey: true }, true)).toBeNull(); // Ctrl+Shift+N = browser incognito
    expect(shortcutOf({ key: "O", ctrlKey: true, shiftKey: true, altKey: true })).toBeNull();
  });
  test("inDesktopShell: only the Tauri markers count; a plain window or an installed PWA is not the shell", () => {
    expect(inDesktopShell({})).toBe(false);
    expect(inDesktopShell(undefined)).toBe(false);
    expect(inDesktopShell({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(inDesktopShell({ __TAURI__: {} })).toBe(true);
  });
});

describe("settings modal panes (C10)", () => {
  const labels = (me: Parameters<typeof settingsPanes>[0], space: "biz" | "open" = "biz", both = false, devicesOn = true) => settingsPanes(me, space, both, devicesOn).map((p) => p.label);
  test("Erich in Business gets every pane except Approvals (needs both spaces)", () => {
    expect(labels({ erichOnly: true })).toEqual(["General", "Profile", "Appearance", "Prompts", "Subagents", "Capabilities", "Providers", "Skills", "Connectors", "Usage", "Devices"]);
  });
  test("Devices needs the /api/devices probe: 404 (feature off) hides it, 200 shows it", () => {
    expect(labels({ erichOnly: true }, "biz", false, false)).not.toContain("Devices");
    expect(labels({ erichOnly: true }, "biz", false, true)).toContain("Devices");
    expect(settingsPanes({ erichOnly: true }, "biz", false).map((p) => p.label)).not.toContain("Devices"); // default = unknown = hidden
  });
  test("both spaces add Approvals; Open hides Devices (Business only)", () => {
    expect(labels({ erichOnly: true }, "biz", true)).toContain("Approvals");
    expect(labels({ erichOnly: true }, "open", true)).not.toContain("Devices");
  });
  test("a team session keeps only General / Profile / Appearance / Prompts / Subagents / Usage", () => {
    expect(labels({ team: true })).toEqual(["General", "Profile", "Appearance", "Prompts", "Subagents", "Usage"]);
  });
  test("every pane is a settings path (it opens in the modal), including the new ones", () => {
    for (const p of ["skills", "connectors", "usage", "devices", "approvals"]) expect(isSettingsPath(`/settings/${p}`)).toBe(true);
    expect(isSettingsPath("/settings/cloudflare")).toBe(false); // still a full page
    expect(isSettingsPath("/usage")).toBe(false); expect(isSettingsPath("/skills")).toBe(false); expect(isSettingsPath("/connectors")).toBe(false);
  });
});

describe("route placement", () => {
  test("path classifiers", () => {
    expect(artifactIdOf(`/artifacts/${ID}`)).toBe(ID);
    expect(artifactIdOf("/artifacts")).toBeNull();
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/appearance")).toBe(true);
    expect(isSettingsPath("/settings/nope")).toBe(false);
    expect(isSettingsPath("/connectors")).toBe(false);
    expect(isChatPath("/")).toBe(true);
    expect(isChatPath(`/c/${ID}`)).toBe(true);
    expect(isChatPath("/chats")).toBe(false);
  });
  test("an artifact opened from a chat is a panel beside that chat", () => {
    expect(mainPath(`/artifacts/${ID}`, `/c/${ID}`)).toEqual({ main: `/c/${ID}`, panel: ID, modal: false });
  });
  test("an artifact opened from the gallery or a deep link stays a full page", () => {
    expect(mainPath(`/artifacts/${ID}`, "/artifacts")).toEqual({ main: `/artifacts/${ID}`, panel: null, modal: false });
  });
  test("settings is a modal over the previous page", () => {
    expect(mainPath("/settings/profile", "/cloud")).toEqual({ main: "/cloud", panel: null, modal: true });
  });
  test("anything else is itself", () => { expect(mainPath("/usage", "/")).toEqual({ main: "/usage", panel: null, modal: false }); });
  test("base follows ordinary navigation, skips settings, keeps the chat under an artifact panel", () => {
    expect(nextBase("/cloud", "/")).toBe("/cloud");
    expect(nextBase("/settings", "/cloud")).toBe("/cloud");
    expect(nextBase(`/artifacts/${ID}`, `/c/${ID}`)).toBe(`/c/${ID}`);
    expect(nextBase(`/artifacts/${ID}`, "/artifacts")).toBe(`/artifacts/${ID}`);
  });
});
