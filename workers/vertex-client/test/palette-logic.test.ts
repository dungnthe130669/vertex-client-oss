import { describe, expect, test } from "bun:test";
import type { ArtifactRow, ConvRow } from "../web/src/api";
import { buildItems, fuzzyScore, moveActive, navItems } from "../web/src/palette-logic";
import { editRow, splitPinned } from "../web/src/shell-logic";

const chat = (id: string, title: string, pinned = 0): ConvRow => ({ id, title, model: "m", pinned, costUsd: 0, tokens: 0, createdAt: "", updatedAt: "" });
const art = (id: string, title: string): ArtifactRow => ({ id, title, type: "markdown", language: null, version: 1, bytes: 1, createdAt: "", updatedAt: "", preview: "" });

describe("fuzzyScore", () => {
  test("substring beats subsequence; no match is -1; empty query matches", () => {
    expect(fuzzyScore("nginx", "Nginx reverse proxy")).toBeGreaterThan(fuzzyScore("ngx", "Nginx reverse proxy"));
    expect(fuzzyScore("ngx", "Nginx reverse proxy")).toBeGreaterThan(0);
    expect(fuzzyScore("zzz", "Nginx")).toBe(-1);
    expect(fuzzyScore("", "anything")).toBe(0);
  });
  test("prefix > word start > mid-word; shorter wins a tie; case-insensitive", () => {
    expect(fuzzyScore("set", "Settings")).toBeGreaterThan(fuzzyScore("set", "Reset"));
    expect(fuzzyScore("set", "Go set it")).toBeGreaterThan(fuzzyScore("set", "Reset"));
    expect(fuzzyScore("set", "Set")).toBeGreaterThan(fuzzyScore("set", "Settings"));
    expect(fuzzyScore("SETT", "settings")).toBeGreaterThan(0);
  });
});

describe("buildItems", () => {
  const src = { chats: [chat("1", "Docker notes"), chat("2", "Deploy plan", 1)], artifacts: [art("a", "Deploy checklist")], erichOnly: true };
  test("empty query: New chat is first, then actions, destinations and recent chats (no artifacts)", () => {
    const it = buildItems("", src);
    expect(it[0]).toMatchObject({ label: "New chat", act: "new-chat" });
    expect(it.map((x) => x.label)).toContain("Toggle theme");
    expect(it.filter((x) => x.kind === "chat").map((x) => x.label)).toEqual(["Docker notes", "Deploy plan"]);
    expect(it.some((x) => x.kind === "artifact")).toBe(false);
  });
  test("a query finds chats, artifacts, destinations and actions, best first", () => {
    const it = buildItems("deploy", src);
    expect(it.map((x) => x.id).sort()).toEqual(["c:2", "f:a"]);
    expect(it[0].id).toBe("c:2");                                    // pinned chat edges out the artifact on an equal-ish match
    expect(buildItems("theme", src)[0]).toMatchObject({ act: "toggle-theme" });
    expect(buildItems("usage", src)[0]).toMatchObject({ kind: "nav", path: "/usage" });
    expect(buildItems("profile", src)[0]).toMatchObject({ path: "/settings/profile", fromApp: true });
  });
  test("scope gating: a non-erich scope never sees cloud / agents / desktop / remote, whether browsing or searching", () => {
    const gated = { ...src, erichOnly: false };
    for (const l of ["Cloud", "Agents", "Desktop", "Remote"]) {
      expect(navItems(false).map((x) => x.label)).not.toContain(l);
      expect(buildItems(l, gated).filter((x) => x.kind === "nav" && x.label === l)).toEqual([]);
      expect(navItems(true).map((x) => x.label)).toContain(l);
    }
    expect(buildItems("", gated).some((x) => ["/cloud", "/agents", "/desktop", "/remote"].includes(x.path ?? ""))).toBe(false);
    expect(navItems(false).map((x) => x.label)).toEqual(expect.arrayContaining(["Chats", "Library", "Usage", "Settings", "Settings: Profile", "Settings: Prompts", "About"]));
    for (const l of ["Skills", "Artifacts", "Projects", "Settings: Providers", "Settings: Capabilities", "Settings: Connectors"]) expect(navItems(false).map((x) => x.label)).not.toContain(l); // team: their APIs are 403, so hidden
  });
  test("C12: Notifications, Devices (Erich, Business) and Approvals (both spaces) are reachable from the palette", () => {
    const labels = (erich: boolean, open: boolean, both: boolean) => navItems(erich, open, both).map((x) => x.label);
    expect(labels(false, false, false)).toContain("Notifications"); // everyone has the bell
    expect(labels(false, false, false)).not.toContain("Settings: Devices");
    expect(navItems(true, false, false, false).map((x) => x.label)).not.toContain("Settings: Devices"); // /api/devices 404: hidden
    expect(buildItems("devices", { ...src, erichOnly: true }).map((x) => x.path)).not.toContain("/settings/devices");
    expect(buildItems("devices", { ...src, erichOnly: true, devices: true }).map((x) => x.path)).toContain("/settings/devices"); // 200: shown
    expect(navItems(true, false, false, true).map((x) => x.label)).toContain("Settings: Devices");
    expect(labels(true, true, true)).not.toContain("Settings: Devices"); // Business only
    expect(labels(true, false, false)).not.toContain("Settings: Approvals");
    expect(labels(false, false, true)).toContain("Settings: Approvals");
    expect(buildItems("approvals", { ...src, switchTo: "open" }).map((x) => x.path)).toContain("/settings/approvals");
    expect(buildItems("notif", src).map((x) => x.path)).toContain("/notifications");
  });
  test("results are capped", () => {
    const many = Array.from({ length: 80 }, (_, i) => chat(String(i), `report ${i}`));
    expect(buildItems("report", { chats: many, artifacts: [], erichOnly: true }).length).toBe(30);
  });
});

describe("moveActive / pinned helpers", () => {
  test("arrow keys wrap; empty list has no active item", () => {
    expect(moveActive(0, 3, -1)).toBe(2); expect(moveActive(2, 3, 1)).toBe(0); expect(moveActive(-1, 3, 1)).toBe(0); expect(moveActive(-1, 3, -1)).toBe(2); expect(moveActive(0, 0, 1)).toBe(-1);
  });
  test("splitPinned keeps order; editRow renames / pins in place", () => {
    const rows = [chat("1", "a"), chat("2", "b", 1), chat("3", "c")];
    expect(splitPinned(rows)).toEqual({ pinned: [rows[1]], rest: [rows[0], rows[2]] });
    expect(splitPinned(null)).toEqual({ pinned: [], rest: [] });
    const e = editRow(rows, "3", { title: "C!", pinned: true });
    expect(e[2]).toMatchObject({ title: "C!", pinned: 1 }); expect(e[0]).toBe(rows[0]);
    expect(editRow(rows, "2", { pinned: false })[1].pinned).toBe(0);
  });
});

describe("projects in the palette", () => {
  const projects = [{ id: "00000000-0000-4000-8000-000000000001", name: "Website redesign", instructions: "", createdAt: "", updatedAt: "", chatCount: 0 }];
  test("Projects destination and project items appear for erichOnly only (fail closed)", () => {
    const on = buildItems("website", { chats: [], artifacts: [], projects, erichOnly: true });
    expect(on.find((i) => i.kind === "project")).toMatchObject({ label: "Website redesign", path: "/projects/00000000-0000-4000-8000-000000000001" });
    expect(buildItems("", { chats: [], artifacts: [], erichOnly: true }).some((i) => i.label === "Projects" && i.path === "/projects")).toBe(true);
    const off = { chats: [], artifacts: [], projects, erichOnly: false };
    expect(buildItems("website", off).some((i) => i.kind === "project")).toBe(false);
    expect(buildItems("", off).some((i) => i.path === "/projects")).toBe(false);
  });
});
