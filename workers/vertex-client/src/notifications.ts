// Notifications center: every notification the server decides to send (or suppresses because the user is watching) is stored here, so a
// visible PWA can toast it and the history page can list it. Fail soft: nothing in here may ever affect the flow that raised it.
import type { Scope } from "./scope";

export const KEEP_PER_USER = 200;
export const PAGE_MAX = 100;
export type NotifKind = "turn" | "cloud" | "agent" | "desktop" | "device" | "other";
export type Notification = { id: string; ts: number; kind: NotifKind; title: string; body: string; url: string; read: boolean };
type Row = { id: string; ts: number; kind: string; title: string; body: string; url: string; read_at: number | null };
const KINDS = new Set<string>(["turn", "cloud", "agent", "desktop", "device", "other"]);

const clip = (s: unknown, n: number) => (typeof s === "string" ? s : "").replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
/** Only an in-app path may be stored: a tap navigates to it, so an absolute or protocol-relative url is dropped to "/". */
export const safeUrl = (u: unknown) => (typeof u === "string" && u.startsWith("/") && !u.startsWith("//") && u.length <= 300 && !/[\u0000-\u001F\\]/.test(u) ? u : "/");
const toNotif = (r: Row): Notification => ({ id: r.id, ts: r.ts, kind: (KINDS.has(r.kind) ? r.kind : "other") as NotifKind, title: r.title, body: r.body, url: r.url, read: r.read_at !== null });

/** Store one notification for `scope` and prune to the newest KEEP_PER_USER. Returns the stored row, or null when it could not be stored (never throws). */
export async function recordNotification(db: D1Database | undefined, scope: Scope, n: { kind: NotifKind; title: string; body: string; url: string }, now = Date.now()): Promise<Notification | null> {
  if (!db) return null;
  try {
    const row: Notification = { id: crypto.randomUUID(), ts: now, kind: KINDS.has(n.kind) ? n.kind : "other", title: clip(n.title, 80) || "Vertex Client", body: clip(n.body, 140), url: safeUrl(n.url), read: false };
    await db.prepare(`INSERT INTO notifications (id, user_id, ts, kind, title, body, url, read_at) VALUES (?,?,?,?,?,?,?,NULL)`).bind(row.id, scope, row.ts, row.kind, row.title, row.body, row.url).run();
    await db.prepare(`DELETE FROM notifications WHERE user_id=? AND id NOT IN (SELECT id FROM notifications WHERE user_id=? ORDER BY ts DESC, id DESC LIMIT ?)`).bind(scope, scope, KEEP_PER_USER).run();
    return row;
  } catch (e) { console.error("notification not stored", e instanceof Error ? e.message : String(e)); return null; }
}

/** Cursor = "<ts>~<id>" of the last row on a page (strictly older in (ts, id) order); a bare "<ts>" (the old form) means ts < that. null = invalid. */
export function parseNotifCursor(v: string | undefined | null): { ts: number; id: string | null } | null | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const m = /^(\d{1,15})(?:~([A-Za-z0-9-]{1,64}))?$/.exec(v);
  return m ? { ts: Number(m[1]), id: m[2] ?? null } : null;
}

/** Newest first. `before` = cursor from a previous page's `next`. `unread` is the caller's total unread count, independent of the page. */
export async function listNotifications(db: D1Database, scope: Scope, o: { limit?: number; before?: { ts: number; id: string | null } }): Promise<{ items: Notification[]; next: string | null; unread: number }> {
  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(o.limit ?? 50) || 50));
  const cols = `SELECT id, ts, kind, title, body, url, read_at FROM notifications WHERE user_id=?`;
  const b = o.before;
  const rows = (b === undefined ? await db.prepare(`${cols} ORDER BY ts DESC, id DESC LIMIT ?`).bind(scope, limit + 1).all<Row>()
    : b.id === null ? await db.prepare(`${cols} AND ts<? ORDER BY ts DESC, id DESC LIMIT ?`).bind(scope, b.ts, limit + 1).all<Row>()
    : await db.prepare(`${cols} AND (ts<? OR (ts=? AND id<?)) ORDER BY ts DESC, id DESC LIMIT ?`).bind(scope, b.ts, b.ts, b.id, limit + 1).all<Row>()).results;
  const page = rows.slice(0, limit);
  const unread = (await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL`).bind(scope).first<{ n: number }>())?.n ?? 0;
  const last = page[page.length - 1];
  return { items: page.map(toNotif), next: rows.length > limit && last ? `${last.ts}~${last.id}` : null, unread };
}

/** `ids` = those of the caller's own rows (other users' ids simply match nothing); "all" = every unread row of the caller. Returns the rows changed. */
export async function markRead(db: D1Database, scope: Scope, which: string[] | "all", now = Date.now()): Promise<number> {
  if (which === "all") return Number((await db.prepare(`UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL`).bind(now, scope).run()).meta?.changes ?? 0);
  let n = 0;
  for (const id of which.slice(0, 100)) n += Number((await db.prepare(`UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL`).bind(now, id, scope).run()).meta?.changes ?? 0);
  return n;
}

/** Body validator for POST /api/notifications/read: {all:true} or {ids:[<= 100 strings]}. */
export function parseReadBody(b: unknown): { ok: true; which: string[] | "all" } | { ok: false; error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "expected a JSON object" };
  const o = b as Record<string, unknown>;
  if (o.all === true) return { ok: true, which: "all" };
  if (Array.isArray(o.ids) && o.ids.length > 0 && o.ids.length <= 100 && o.ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) return { ok: true, which: o.ids as string[] };
  return { ok: false, error: "send {all:true} or {ids:[...]} (1-100 ids)" };
}
