import { useEffect, useState } from "preact/hooks";
import { DESK_MIN } from "./desk-logic";

const matches = (q: string) => typeof matchMedia === "function" && matchMedia(q).matches;
export function useMedia(q: string): boolean {
  const [v, setV] = useState(() => matches(q));
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(q), f = () => setV(m.matches);
    m.addEventListener("change", f); f();
    return () => m.removeEventListener("change", f);
  }, [q]);
  return v;
}
/** True at >=1024px (live): the persistent-sidebar layout. Below it the app is the phone shell, untouched. */
export const useDesktop = () => useMedia(`(min-width:${DESK_MIN}px)`);

