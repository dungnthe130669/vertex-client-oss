import { describe, expect, test } from "bun:test";
import { MENU_CLOSED, MENU_CLOSE_MS, MENU_OPEN_MS, menuKeyTarget, menuReducer, menuShown, visibleCount, type MenuAction, type MenuState } from "../web/src/menu-logic";

const run = (s: MenuState, ...a: MenuAction["t"][]) => a.reduce((x, t) => menuReducer(x, { t }), s);

describe("hover menu reducer", () => {
  test("delays are the documented ones", () => { expect(MENU_OPEN_MS).toBe(120); expect(MENU_CLOSE_MS).toBe(250); });
  test("hover opens only after the open delay (opening is not shown yet)", () => {
    const o = run(MENU_CLOSED, "hover");
    expect(o.phase).toBe("opening"); expect(menuShown(o)).toBe(false);
    expect(run(o, "tick").phase).toBe("open");
  });
  test("leaving before the open delay cancels it", () => { expect(run(MENU_CLOSED, "hover", "leave")).toEqual(MENU_CLOSED); });
  test("leave starts the close delay, a move back cancels it, the tick closes", () => {
    const open = run(MENU_CLOSED, "hover", "tick");
    const leaving = run(open, "leave");
    expect(leaving.phase).toBe("leaving"); expect(menuShown(leaving)).toBe(true);
    expect(run(leaving, "hover").phase).toBe("open");
    expect(run(leaving, "tick")).toEqual(MENU_CLOSED);
  });
  test("focus inside keeps it open past the close delay; blur then starts the close", () => {
    const f = run(MENU_CLOSED, "hover", "tick", "focus", "leave", "tick");
    expect(f.phase).toBe("open");
    expect(run(f, "blur").phase).toBe("leaving");
    expect(run(f, "blur", "tick")).toEqual(MENU_CLOSED);
  });
  test("a bare hover on an open menu changes nothing (a stationary pointer does not re-trigger)", () => {
    const open = run(MENU_CLOSED, "hover", "tick");
    expect(menuReducer(open, { t: "hover" })).toBe(open);
  });
  test("click pins open, leave does not close a pinned menu, second click closes", () => {
    const p = run(MENU_CLOSED, "click");
    expect(p).toEqual({ phase: "open", pinned: true, focus: true });
    expect(run(p, "leave", "tick").phase).toBe("open");
    expect(run(p, "click")).toEqual(MENU_CLOSED);
  });
  test("click during the open delay pins immediately; key-open pins and focuses", () => {
    expect(run(MENU_CLOSED, "hover", "click").pinned).toBe(true);
    expect(run(MENU_CLOSED, "key-open")).toEqual({ phase: "open", pinned: true, focus: true });
  });
  test("Esc, a pick and an outside click close everything, pinned or not", () => {
    for (const t of ["esc", "select", "outside"] as const) expect(run(run(MENU_CLOSED, "click"), t)).toEqual(MENU_CLOSED);
  });
  test("a leave on a closed menu is a no-op", () => { expect(menuReducer(MENU_CLOSED, { t: "leave" })).toBe(MENU_CLOSED); });
  // Touch is ignored by the caller (the hook never dispatches "hover" for pointerType=touch), so the reducer needs no touch case:
  // a touch tap is a click -> pinned open, which is exactly the tap-to-open behaviour.
  test("a tap (click only, no hover) opens pinned", () => { expect(menuShown(run(MENU_CLOSED, "click"))).toBe(true); });
});

test("visibleCount: icons collapse from the end as the room shrinks", () => {
  expect(visibleCount(500, 6)).toBe(6);
  expect(visibleCount(36 + 2 + 3 * 38, 6)).toBe(3);
  expect(visibleCount(80, 6)).toBe(1);
  expect(visibleCount(36, 6)).toBe(0);
  expect(visibleCount(0, 6)).toBe(0);
  expect(visibleCount(NaN, 6)).toBe(0);
});

test("menuKeyTarget wraps and maps Home / End", () => {
  expect(menuKeyTarget("ArrowDown", 2, 3)).toBe(0);
  expect(menuKeyTarget("ArrowUp", 0, 3)).toBe(2);
  expect(menuKeyTarget("Home", 2, 3)).toBe(0);
  expect(menuKeyTarget("End", 0, 3)).toBe(2);
  expect(menuKeyTarget("a", 0, 3)).toBeNull();
  expect(menuKeyTarget("ArrowDown", 0, 0)).toBeNull();
});
