import { useEffect, useState } from "preact/hooks";
// Tiny external store between the desktop app bar (DeskShell) and the screen under it: the chat screen publishes its title and portals its own controls
// (find, chat actions, connection dot, space chip) into the bar's slots, so there is one bar at >=1024px and the same controls inline below that.

export type AppbarState = { title: string | null; right: HTMLElement | null; caret: HTMLElement | null };
let state: AppbarState = { title: null, right: null, caret: null };
const subs = new Set<() => void>();
const set = (p: Partial<AppbarState>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };

export const setAppbarTitle = (title: string | null) => set({ title });
export const setAppbarSlots = (right: HTMLElement | null, caret: HTMLElement | null) => { if (right !== state.right || caret !== state.caret) set({ right, caret }); };
export const getAppbar = (): AppbarState => state;

export function useAppbar(): AppbarState {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); f(); return () => { subs.delete(f); }; }, []);
  return state;
}
/** Publish this screen's title to the app bar while mounted (the bar falls back to the screen's name). */
export function useAppbarTitle(title: string | null | undefined) {
  useEffect(() => { setAppbarTitle(title || null); return () => setAppbarTitle(null); }, [title]);
}
