import { useEffect, useState } from "preact/hooks";
import { getProfile } from "./api";
// The nickname the greeting uses. Loaded once per page load (first start screen that asks), updated by the Profile page after a save.
// A failed load just means no name in the greeting; it is never an error on the start screen.
let nickname: string | null = null;
let loading = false;
const subs = new Set<() => void>();
export const setNickname = (n: string) => { nickname = n; subs.forEach((f) => f()); };
export function useNickname(): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    subs.add(f);
    if (nickname === null && !loading) {
      loading = true;
      void getProfile().then((r) => { if (r.status === 200 && r.data) setNickname(r.data.nickname); }).catch(() => {}).finally(() => { loading = false; });
    }
    return () => { subs.delete(f); };
  }, []);
  return nickname ?? "";
}
