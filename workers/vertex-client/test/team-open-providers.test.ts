import { describe, expect, test } from "bun:test";
import { teamMayOpen, teamHidden } from "../web/src/desk-logic";

describe("team Providers route", () => {
  test("hidden for a team user without Open, reachable with Open", () => {
    expect(teamMayOpen("/settings/providers")).toBe(false);
    expect(teamMayOpen("/settings/providers", true)).toBe(true);
  });
  test("Capabilities stays hidden for team even with Open", () => {
    expect(teamMayOpen("/settings/capabilities", true)).toBe(false);
    expect(teamHidden("/settings/capabilities", true)).toBe(true);
  });
});
import { SETTINGS_PANES, isSettingsPath, mainPath } from "../web/src/desk-logic";

describe("settings modal keeps every pane inside the modal", () => {
  test("each nav pane is a settings path and opens as a modal over the base page", () => {
    for (const p of SETTINGS_PANES) {
      expect(isSettingsPath(p.path)).toBe(true);
      expect(mainPath(p.path, "/").modal).toBe(true);
    }
  });
});
