// Pure state of the app bar's hover menus (no DOM, no timers: bun:test drives it directly). Same pointer rules as the sidebar overlay (sidebarReducer):
// a menu opens on a pointer MOVE over its trigger (never on a bare enter, so a pointer parked there at page load does not pop it), touch is ignored by the
// caller, a stationary pointer keeps it open, Esc closes, focus inside keeps it open, and a click / Enter PINS it open until an outside click, Esc or a pick.

/** Delay before a hovered trigger opens its menu / before a menu the pointer left closes (a stray exit must not flicker it shut). */
export const MENU_OPEN_MS = 120;
export const MENU_CLOSE_MS = 250;

export type MenuState = { phase: "closed" | "opening" | "open" | "leaving"; pinned: boolean; focus: boolean };
export type MenuAction = { t: "hover" | "leave" | "tick" | "focus" | "blur" | "click" | "key-open" | "esc" | "select" | "outside" };
export const MENU_CLOSED: MenuState = { phase: "closed", pinned: false, focus: false };
/** The menu is on screen. */
export const menuShown = (s: MenuState): boolean => s.phase === "open" || s.phase === "leaving";

export function menuReducer(s: MenuState, a: MenuAction): MenuState {
  switch (a.t) {
    case "hover": return s.phase === "closed" ? { ...s, phase: "opening" } : s.phase === "leaving" ? { ...s, phase: "open" } : s; // moves over an open / opening menu change nothing; over a closing one they cancel the close
    case "leave": return s.phase === "opening" ? { ...s, phase: "closed" } : s.phase === "open" && !s.pinned ? { ...s, phase: "leaving" } : s;
    case "tick": return s.phase === "opening" ? { ...s, phase: "open" } : s.phase === "leaving" ? (s.focus || s.pinned ? { ...s, phase: "open" } : MENU_CLOSED) : s;
    case "focus": return { ...s, focus: true };
    case "blur": return { ...s, focus: false, phase: s.phase === "open" && !s.pinned ? "leaving" : s.phase === "opening" ? "closed" : s.phase };
    case "click": return s.pinned ? MENU_CLOSED : { phase: "open", pinned: true, focus: true }; // a second click on the pinned trigger closes it
    case "key-open": return { phase: "open", pinned: true, focus: true }; // Enter / Space / ArrowDown on the trigger
    case "esc": case "select": case "outside": return MENU_CLOSED;
  }
}

/** How many of `total` icon buttons fit in `avail` px next to the always-present "..." button (the rest collapse into its menu, lowest priority = last first). */
export function visibleCount(avail: number, total: number, item = 36, gap = 2, more = 36): number {
  if (!(avail > 0)) return 0;
  return Math.max(0, Math.min(total, Math.floor((avail - more - gap) / (item + gap))));
}

/** Roving focus inside a menu: the next index for a key, or null when the key is not a menu key. */
export function menuKeyTarget(key: string, i: number, n: number): number | null {
  if (n <= 0) return null;
  if (key === "ArrowDown") return (i + 1) % n;
  if (key === "ArrowUp") return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}
