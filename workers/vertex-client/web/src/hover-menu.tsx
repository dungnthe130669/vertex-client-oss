import { type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useReducer, useRef } from "preact/hooks";
import { MENU_CLOSED, MENU_CLOSE_MS, MENU_OPEN_MS, menuKeyTarget, menuReducer, menuShown, type MenuState } from "./menu-logic";

const fine = () => typeof matchMedia === "function" && matchMedia("(hover:hover) and (pointer:fine)").matches;

/** Hover / click / keyboard open-close for one trigger + its menu (see menu-logic.ts for the rules). The wrapper element must contain BOTH, so the pointer
 *  moving from the trigger into the menu never leaves it. */
export function useHoverMenu() {
  const [s, dispatch] = useReducer(menuReducer, MENU_CLOSED as MenuState);
  const wrap = useRef<HTMLDivElement>(null);
  const shown = menuShown(s);
  useEffect(() => {
    if (s.phase !== "opening" && s.phase !== "leaving") return;
    const id = setTimeout(() => (s.phase === "leaving" && wrap.current?.matches(":hover") && fine() ? dispatch({ t: "hover" }) : dispatch({ t: "tick" })), s.phase === "opening" ? MENU_OPEN_MS : MENU_CLOSE_MS); // a pointer parked on it keeps it open
    return () => clearTimeout(id);
  }, [s.phase]);
  useEffect(() => { // a click anywhere else closes a pinned menu
    if (!shown) return;
    const f = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) dispatch({ t: "outside" }); };
    addEventListener("pointerdown", f, true);
    return () => removeEventListener("pointerdown", f, true);
  }, [shown]);
  useEffect(() => { // Esc closes it wherever focus is (a hover-opened menu has no focus inside); it is the final action for this key
    if (!shown) return;
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(wrap.current?.contains(document.activeElement) ?? false); } };
    addEventListener("keydown", f, true);
    return () => removeEventListener("keydown", f, true);
  }, [shown]);
  useLayoutEffect(() => { // opened by click / key: focus the first item (a hover-open never steals focus)
    if (shown && s.pinned) wrap.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [shown && s.pinned]);
  const close = (refocus = false) => { dispatch({ t: "select" }); if (refocus) wrap.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus(); };
  const wrapProps = {
    ref: wrap,
    onPointerMove: (e: PointerEvent) => { if (e.pointerType !== "touch" && e.buttons === 0 && fine()) dispatch({ t: "hover" }); },
    onPointerEnter: (e: PointerEvent) => { if (e.pointerType !== "touch" && e.buttons === 0 && fine() && s.phase !== "closed") dispatch({ t: "hover" }); }, // cancels a pending close; never opens on a bare enter
    onPointerLeave: (e: PointerEvent) => { if (e.pointerType !== "touch") dispatch({ t: "leave" }); },
    onFocusIn: () => dispatch({ t: "focus" }),
    onFocusOut: (e: FocusEvent) => { if (wrap.current?.contains(e.relatedTarget as Node | null)) return; dispatch({ t: "blur" }); if (fine() && wrap.current?.matches(":hover")) dispatch({ t: "hover" }); },
    onKeyDown: (e: KeyboardEvent) => {
      const items = [...(wrap.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Escape" && shown) { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (!shown && (e.key === "ArrowDown") && (e.target as HTMLElement).hasAttribute("aria-haspopup")) { e.preventDefault(); dispatch({ t: "key-open" }); return; }
      if (!shown) return;
      if (e.key === "Tab") { dispatch({ t: "esc" }); return; }
      const j = menuKeyTarget(e.key, i, items.length);
      if (j !== null) { e.preventDefault(); items[j]?.focus(); }
    },
  };
  return { s, shown, dispatch, wrapProps, close };
}

export type MenuEntry = { id: string; label: string; testid?: string; danger?: boolean; icon?: ComponentChildren; onSelect: () => void };

/** A trigger button + a menu that opens on hover (120 ms), on click / Enter (pinned) and closes 250 ms after the pointer leaves. */
export function HoverMenu({ label, testid, icon, items, align = "end", cls = "", menuLabel }: { label: string; testid: string; icon: ComponentChildren; items: readonly MenuEntry[]; align?: "start" | "end"; cls?: string; menuLabel?: string }) {
  const m = useHoverMenu();
  return (
    <div class={`abm ${cls}`} {...m.wrapProps}>
      <button type="button" class="abtn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={m.shown} data-testid={testid} onClick={() => m.dispatch({ t: "click" })}>{icon}</button>
      {m.shown && (
        <div class={`abmenu ${align}`} role="menu" aria-label={menuLabel ?? label} data-testid={`${testid}-menu`}>
          {items.map((it) => <button key={it.id} type="button" role="menuitem" class={`abitem${it.danger ? " danger" : ""}`} data-testid={it.testid ?? `${testid}-${it.id}`} onClick={() => { m.dispatch({ t: "select" }); it.onSelect(); }}>{it.icon}<span>{it.label}</span></button>)}
        </div>
      )}
    </div>
  );
}
