// Pure pieces of the desktop shell (>=1024px): sidebar state, keyboard shortcuts, which route shows where. No DOM, so bun:test covers them.

export const DESK_MIN = 1024;
export const SIDEBAR_KEY = "vc:sidebar";

/** Persisted sidebar state; "open" unless the user collapsed it. Storage can throw (private mode, blocked): then the default. */
export function readSidebarOpen(store: Pick<Storage, "getItem"> | null | undefined): boolean {
  try { return store?.getItem(SIDEBAR_KEY) !== "closed"; } catch { return true; }
}
export function writeSidebarOpen(store: Pick<Storage, "setItem"> | null | undefined, open: boolean): void {
  try { store?.setItem(SIDEBAR_KEY, open ? "open" : "closed"); } catch { /* not persisted: the sidebar still toggles for this tab */ }
}

export type Shortcut = "palette" | "toggle-sidebar" | "escape" | "new-chat" | "settings";
type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };
/** True inside the desktop app's shell (Tauri injects `__TAURI__` / `__TAURI_INTERNALS__` into the page). A normal browser tab and an installed PWA are not the shell. */
export const inDesktopShell = (w: object | undefined = typeof window === "undefined" ? undefined : window): boolean => !!w && ("__TAURI_INTERNALS__" in w || "__TAURI__" in w);
/** Ctrl/Cmd+K = command palette, Ctrl/Cmd+B = toggle sidebar, Esc = close the panel/modal, Ctrl/Cmd+, = Settings,
 *  Ctrl/Cmd+Shift+O = New chat (everywhere: the browser keeps Ctrl+N for a new window), and Ctrl/Cmd+N = New chat only in the desktop shell (`shell`), where it is free.
 *  Other Shift/Alt variants belong to the browser. */
export function shortcutOf(e: KeyLike, shell = false): Shortcut | null {
  if (e.key === "Escape") return "escape";
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (e.shiftKey) return k === "o" ? "new-chat" : null;
  return k === "k" ? "palette" : k === "b" ? "toggle-sidebar" : k === "," ? "settings" : k === "n" && shell ? "new-chat" : null;
}

export const artifactIdOf = (path: string): string | null => /^\/artifacts\/([0-9a-f-]{36})$/.exec(path)?.[1] ?? null;
/** Settings and its panes. /settings/skills, /connectors and /usage are the modal's own copies of the full pages /skills, /connectors and /usage (those stay full pages when opened from the sidebar); Cloudflare and connector detail/new stay full pages. */
export const isSettingsPath = (path: string): boolean => path === "/settings" || /^\/settings\/(profile|appearance|prompts|subagents|capabilities|providers|skills|connectors|usage|devices|approvals|this-device)$/.test(path);
/** Chat routes: the only place an artifact opens beside the conversation instead of replacing the page. */
export const isChatPath = (path: string): boolean => path === "/" || /^\/c\/[0-9a-f-]{36}$/.test(path);

/** What the main area shows for `path`, given the last route that was neither an artifact viewer nor settings (`base`).
 *  An artifact opened from a chat keeps that chat; settings is an overlay on whatever was there; everything else is itself. */
export function mainPath(path: string, base: string): { main: string; panel: string | null; modal: boolean } {
  const art = artifactIdOf(path);
  if (art && isChatPath(base)) return { main: base, panel: art, modal: false };
  if (isSettingsPath(path)) return { main: base, panel: null, modal: true };
  return { main: path, panel: null, modal: false };
}
/** The route to remember as `base` after navigating to `path`. */
export const nextBase = (path: string, base: string): string => (isSettingsPath(path) || (artifactIdOf(path) && isChatPath(base)) ? base : path);

/** Settings panes / routes a team (g:*) session never gets: their APIs are 403 by design, so they are hidden rather than shown as errors. */
export const TEAM_HIDDEN_PATHS: ReadonlySet<string> = new Set(["/settings/capabilities", "/settings/providers", "/settings/devices", "/settings/this-device", "/settings/skills", "/settings/connectors"]);
/** Routes a team session may open; any other path falls back to the start screen. */
export const teamHidden = (path: string, open = false): boolean => TEAM_HIDDEN_PATHS.has(path) && !(open && path === "/settings/providers"); // a team user with Open keeps Providers (their own keys)
export const teamMayOpen = (path: string, open = false): boolean => path === "/" || path === "/chats" || /^\/c\/[0-9a-f-]{36}$/.test(path) || path === "/library" || path === "/usage" || path === "/about" || (/^\/settings(\/|$)/.test(path) && !teamHidden(path, open));

export type SettingsPane = { path: string; label: string; testid: string };
export const SETTINGS_PANES: ReadonlyArray<SettingsPane> = [
  { path: "/settings", label: "General", testid: "settings-pane-general" },
  { path: "/settings/profile", label: "Profile", testid: "settings-pane-profile" },
  { path: "/settings/appearance", label: "Appearance", testid: "settings-pane-appearance" },
  { path: "/settings/prompts", label: "Prompts", testid: "settings-pane-prompts" },
  { path: "/settings/subagents", label: "Subagents", testid: "settings-pane-subagents" },
  { path: "/settings/capabilities", label: "Capabilities", testid: "settings-pane-capabilities" },
  { path: "/settings/providers", label: "Providers", testid: "settings-pane-providers" },
  { path: "/settings/skills", label: "Skills", testid: "settings-pane-skills" },
  { path: "/settings/connectors", label: "Connectors", testid: "settings-pane-connectors" },
  { path: "/settings/usage", label: "Usage", testid: "settings-pane-usage" },
  { path: "/settings/devices", label: "Devices", testid: "settings-pane-devices" },
  { path: "/settings/this-device", label: "This device", testid: "settings-pane-this-device" },
  { path: "/settings/approvals", label: "Approvals", testid: "settings-pane-approvals" },
];
/** The panes this account gets in the modal's left nav: the same conditions as the rows on the phone's Settings page
 *  (Devices = Erich-only, Business space; Approvals = accounts with both spaces; team sessions lose the panes whose APIs are 403). */
export function settingsPanes(me: { team?: boolean; erichOnly?: boolean; spaces?: readonly string[] } | null, space: "biz" | "open", both: boolean, devicesOn = false, shell = false): SettingsPane[] {
  const team = me?.team === true;
  return SETTINGS_PANES.filter((p) => {
    if (team && teamHidden(p.path, both)) return false;
    if (p.path === "/settings/devices") return devicesOn && me?.erichOnly === true && !team && space === "biz"; // devicesOn = the /api/devices probe answered 200 (404 = feature off)
    if (p.path === "/settings/this-device") return shell && !team; // desktop shell only (UA token + native bridge), any space
    if (p.path === "/settings/approvals") return both;
    return true;
  });
}
