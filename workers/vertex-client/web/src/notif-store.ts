// Notifications center store. Live: a "notif" frame on the chat / device socket (ingest). Everything else (cloud, agents, desktop runs have no
// socket of their own) arrives by a cheap poll of GET /api/notifications while the tab is visible. Rows seen once never toast twice.
import { call } from "./api";
import { shellNotifier } from "./desktop-notify";
import { type Notif, MAX_TOASTS, POLL_MS, TOAST_MS, freshFrom, mergeNotifs, parseNotif } from "./notif-logic";

type State = { items: Notif[]; unread: number; loaded: boolean; toasts: Notif[]; next: string | null };
let st: State = { items: [], unread: 0, loaded: false, toasts: [], next: null };
const seen = new Set<string>();
let epoch = 0; // bumped by every local/live change to the unread state; a poll that started before it must not overwrite it
const subs = new Set<(s: State) => void>();
const set = (p: Partial<State>) => { st = { ...st, ...p }; subs.forEach((f) => f(st)); };
export const getState = () => st;
export const subscribe = (f: (s: State) => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Test seam: forget everything (tests share one module instance). */
export function resetNotifs() { epoch++; st = { items: [], unread: 0, loaded: false, toasts: [], next: null }; seen.clear(); }

function showToast(n: Notif) {
  set({ toasts: [...st.toasts.filter((t) => t.id !== n.id), n].slice(-MAX_TOASTS) });
  setTimeout(() => dismissToast(n.id), TOAST_MS);
}
export const dismissToast = (id: string) => { if (st.toasts.some((t) => t.id === id)) set({ toasts: st.toasts.filter((t) => t.id !== id) }); };

/** One notification pushed live by the server over a socket: list it, bump the count, toast it. */
export function ingest(raw: unknown) {
  const n = parseNotif(raw);
  if (!n || seen.has(n.id)) return;
  seen.add(n.id); epoch++;
  set({ items: mergeNotifs(st.items, [n]), unread: st.unread + (n.read ? 0 : 1) });
  if (!n.read) { showToast(n); shellNotifier()?.notif(n); } // inside the desktop shell and not looking at the page: also a native notification
}

type Page = { items: Notif[]; next: string | null; unread: number };
/** Reload the newest page. The very first load only adopts what exists (no toast storm for history); later loads toast unread rows not seen before. */
export async function refresh(): Promise<void> {
  const at = epoch;
  const r = await call<Page>("/api/notifications?limit=50").catch(() => null);
  if (!r || r.status !== 200 || !r.data || !Array.isArray(r.data.items)) return;
  if (at !== epoch) return; // a live frame / mark-read landed meanwhile: this snapshot is older than the state; the next poll catches up
  const rows = r.data.items.map(parseNotif).filter((n): n is Notif => !!n);
  const first = !st.loaded;
  const fresh = first ? [] : freshFrom(rows, seen);
  for (const n of rows) seen.add(n.id);
  set({ items: mergeNotifs(st.items, rows), unread: Number(r.data.unread) || 0, loaded: true, next: first ? r.data.next : st.next }); // history cursor is set once; only loadMore() advances it
  for (const n of fresh) showToast(n);
}
export async function loadMore(): Promise<void> {
  if (st.next === null) return;
  const r = await call<Page>(`/api/notifications?limit=50&before=${encodeURIComponent(st.next)}`).catch(() => null);
  if (!r || r.status !== 200 || !r.data) return;
  const rows = r.data.items.map(parseNotif).filter((n): n is Notif => !!n);
  for (const n of rows) seen.add(n.id);
  set({ items: mergeNotifs(st.items, rows), next: r.data.next });
}
/** Optimistic: the row/badge change at once; the server call follows, and a failure reloads the truth. */
export async function markRead(ids: string[]): Promise<void> {
  epoch++;
  const mine = st.items.filter((n) => ids.includes(n.id) && !n.read).length;
  if (mine === 0 && !ids.length) return;
  set({ items: st.items.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)), unread: Math.max(0, st.unread - mine), toasts: st.toasts.filter((t) => !ids.includes(t.id)) });
  const r = await call("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: ids.slice(0, 100) }) }).catch(() => null);
  if (!r || r.status !== 200) void refresh();
}
export async function markAllRead(): Promise<void> {
  epoch++;
  set({ items: st.items.map((n) => ({ ...n, read: true })), unread: 0, toasts: [] });
  const r = await call("/api/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }).catch(() => null);
  if (!r || r.status !== 200) void refresh();
}

let started = false;
/** Begin polling (once per page load): immediately, every POLL_MS while visible, and when the tab becomes visible again. */
export function startNotifs(): () => void {
  if (started) return () => {};
  started = true;
  const tick = () => { if (document.visibilityState !== "hidden") void refresh(); };
  tick();
  const t = setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", tick);
  return () => { started = false; clearInterval(t); document.removeEventListener("visibilitychange", tick); };
}
