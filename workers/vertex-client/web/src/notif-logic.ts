// Notifications center, pure parts: list merge, "which rows are new" for the toast, relative time, badge text. No DOM, no fetch.
export type Notif = { id: string; ts: number; kind: string; title: string; body: string; url: string; read: boolean };
export const POLL_MS = 60_000;
export const TOAST_MS = 5000;
export const MAX_TOASTS = 3;
export const MAX_KEPT = 200;

/** Newest first, de-duplicated by id (an incoming copy wins: it may carry read=true), capped. */
export function mergeNotifs(cur: Notif[], incoming: Notif[]): Notif[] {
  const m = new Map<string, Notif>();
  for (const n of cur) m.set(n.id, n);
  for (const n of incoming) m.set(n.id, n);
  return [...m.values()].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1)).slice(0, MAX_KEPT);
}
/** Rows a poll found that the client has not shown yet: unread, not already seen, oldest first. */
export const freshFrom = (rows: Notif[], seen: Set<string>): Notif[] => rows.filter((n) => !n.read && !seen.has(n.id)).sort((a, b) => a.ts - b.ts);
export const badgeText = (n: number) => (n <= 0 ? "" : n > 99 ? "99+" : String(n));
export const bellLabel = (n: number) => (n > 0 ? `Notifications, ${n} unread` : "Notifications");
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
/** A frame from the socket carries the whole row; anything malformed is ignored rather than rendered. */
export function parseNotif(x: unknown): Notif | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.ts !== "number" || typeof o.title !== "string" || typeof o.body !== "string" || typeof o.url !== "string") return null;
  if (!o.url.startsWith("/") || o.url.startsWith("//")) return null;
  return { id: o.id, ts: o.ts, kind: typeof o.kind === "string" ? o.kind : "other", title: o.title, body: o.body, url: o.url, read: o.read === true };
}
