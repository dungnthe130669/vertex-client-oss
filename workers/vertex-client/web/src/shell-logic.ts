import { desktopShellVersion } from "./desktop-info";
import { mobileShellVersion } from "./update-logic";
import { setBusy } from "./busy";
import { saveDraft } from "./chat-ux";
// Pure pieces of the mobile shell (start screen, drawer, lazy first send). No DOM, so bun:test covers them directly.

/** Time-of-day greeting for the empty start screen. `name` only when the API exposes a real display name (it does not today). */
export function greeting(hour: number, name?: string): string {
  const g = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening";
  return name?.trim() ? `${g}, ${name.trim()}` : g;
}

/** Up to two letters for the avatar circle: "example-user" -> "DU", "jane.doe@x.io" -> "JD", "e2e-bot" -> "EB". */
export function initials(user: string): string {
  const local = user.split("@")[0] ?? "";
  const parts = local.split(/[^A-Za-z0-9]+/).filter((p) => /[A-Za-z]/.test(p));
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const letters = local.replace(/[^A-Za-z]/g, "");
  return (letters.slice(0, 2) || local.slice(0, 2) || "?").toUpperCase();
}

export type NavKey = "chat" | "cloud" | "agents" | "desktop" | "remote" | "devices" | "skills" | "artifacts" | "library" | "projects" | "usage" | "about" | "settings" | null;
/** Which drawer row is "current" for a path. The empty start screen ("/") highlights nothing, like a fresh new chat. */
export function navKey(path: string): NavKey {
  if (path === "/chats" || path.startsWith("/c/")) return "chat";
  if (path === "/cloud" || path.startsWith("/r/")) return "cloud";
  if (path === "/agents" || path.startsWith("/a/")) return "agents";
  if (path === "/desktop" || path.startsWith("/d/")) return "desktop";
  if (path === "/remote" || path.startsWith("/m/")) return "remote";
  if (path === "/devices" || path === "/computers" || path.startsWith("/computers/") || path.startsWith("/dv/")) return "devices";
  if (path === "/skills") return "skills";
  if (path === "/artifacts" || path.startsWith("/artifacts/")) return "artifacts";
  if (path === "/library") return "library";
  if (path === "/projects" || path.startsWith("/projects/")) return "projects";
  if (path === "/usage") return "usage";
  if (path === "/about") return "about";
  if (path === "/settings" || path.startsWith("/settings/") || path === "/connectors" || path.startsWith("/connectors/")) return "settings";
  return null;
}

/** Conversation id of a chat route, so the drawer can highlight it in Recent. */
export const chatIdOf = (path: string): string | null => /^\/c\/([0-9a-f-]{36})$/.exec(path)?.[1] ?? null;

/** The drawer's "Recent" section: the first n rows of the list screen's own order (pinned first, then most recently updated). */
export const recentRows = <T>(rows: readonly T[] | null, n = 10): T[] => (rows ?? []).slice(0, n);
/** Pinned chats (their own group above Recent / the list) and the rest, each keeping the server's order. */
export const splitPinned = <T extends { pinned: number }>(rows: readonly T[] | null): { pinned: T[]; rest: T[] } => ({ pinned: (rows ?? []).filter((r) => r.pinned), rest: (rows ?? []).filter((r) => !r.pinned) });
/** Apply a local edit (rename / pin) to a row list, keeping "pinned first, then most recently updated" without a refetch. */
export const editRow = <T extends { id: string; title: string; pinned: number }>(rows: T[], id: string, e: { title?: string; pinned?: boolean; projectId?: string | null }): T[] =>
  rows.map((r) => (r.id === id ? { ...r, ...(e.projectId !== undefined ? { projectId: e.projectId } : {}), ...(e.title !== undefined ? { title: e.title } : {}), ...(e.pinned !== undefined ? { pinned: e.pinned ? 1 : 0 } : {}) } : r));

// ---- drawer state: closed -> open -> closing (exit animation) -> closed ----
export type DrawerState = "closed" | "open" | "closing";
export type DrawerAction = "open" | "close" | "done" | "toggle" | "shut";
export function drawerReducer(s: DrawerState, a: DrawerAction): DrawerState {
  switch (a) {
    case "open": return "open";
    case "toggle": return s === "open" ? "closing" : "open";
    case "close": return s === "open" ? "closing" : s;
    case "done": return s === "closing" ? "closed" : s;
    case "shut": return "closed"; // navigating away from a drawer row: no exit animation, the screen is changing anyway
  }
}

/** Horizontal swipe on the drawer: true when it is a deliberate leftward swipe (not a vertical scroll of the Recent list). */
export const isCloseSwipe = (dx: number, dy: number, min = 56) => dx <= -min && Math.abs(dx) > Math.abs(dy) * 1.2;

// ---- lazy conversation: the start screen holds the first frame until the conversation exists, then hands it to /c/<id> ----
export type FirstFrame = { t: "send" | "generate"; [k: string]: unknown };
export type PendingFirst = { id: string; frame: FirstFrame; mode: "chat" | "image" | "video"; sent?: boolean };
/** Safety net: a pending first message nobody ever acked (the user left /c/<id> for good) stops blocking the update flow. */
export const PENDING_FIRST_MS = 30_000;
const PENDING_BUSY = "pending-first";
let pending: PendingFirst | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
/** Called by the start screen right before it navigates to the new conversation. The registry owns the busy key from here until
 *  ack / failure, so there is no gap between the start screen's own busy key releasing and the chat screen sending the frame. */
export function setPendingFirst(p: PendingFirst) {
  pending = p;
  setBusy(PENDING_BUSY, true);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    // never delivered: give the text back to the new-chat draft instead of dropping it; delivered-but-unacked: just release
    const q = pending; pendingTimer = undefined;
    if (q && !q.sent) restoreIntoDraft(q);
    clearPendingFirst();
  }, PENDING_FIRST_MS);
}
/** The pending first frame for this conversation. NOT consumed by reading: it stays until ackPendingFirst / clearPendingFirst. */
export const peekPendingFirst = (id: string): PendingFirst | null => (pending && pending.id === id ? pending : null);
/** The server accepted (user_message / turn_start) or refused the frame: only now is the pending frame released. */
export function ackPendingFirst(id: string) { if (pending && pending.id === id) clearPendingFirst(); }
export function clearPendingFirst() { pending = null; clearTimeout(pendingTimer); pendingTimer = undefined; setBusy(PENDING_BUSY, false); }
function restoreIntoDraft(p: PendingFirst) {
  newChatDraft.text = newChatDraft.text || firstFrameText(p.frame);
  newChatDraft.mode = p.mode;
  // files are not restored: they were uploaded into a conversation, their refs mean nothing to a fresh new chat
}
/** After a reconnect: should the frame be sent (again)? Only if it was never sent, or the conversation shows no user message yet
 *  (the protocol has no idempotency key, so a resend is only safe when the server demonstrably did not receive the first one). */
export const shouldSendPending = (p: PendingFirst, hasUserMessage: boolean): boolean => !p.sent || !hasUserMessage;

// ---- the new-chat draft survives leaving "/" (Chats / Settings) and coming back ----
export type DraftUploaded = { ref: string; name: string; mime: string; size: number; kind?: string; tokens?: number };
export type NewChatDraft = { /** persistence key of the (account, space) that owns this draft; null = nobody yet */ owner: string | null; text: string; mode: "chat" | "image" | "video"; model: string; files: DraftUploaded[]; held: Map<string, DraftFile> };
export const newChatDraft: NewChatDraft = { owner: null, text: "", mode: "chat", model: "", files: [], held: new Map() };
/** NEW_CHAT_EVENT / a successful send: clears the in-memory draft and the persisted entry of ITS owner (never another account's or space's). */
export function clearNewChatDraft() { if (newChatDraft.owner) saveDraft(newChatDraft.owner, ""); newChatDraft.text = ""; newChatDraft.mode = "chat"; newChatDraft.model = ""; newChatDraft.files = []; newChatDraft.held = new Map(); }
/** The start screen mounts (or the account / space changed under it): a draft held in memory for a different owner is dropped (memory only; that owner's persisted entry stays theirs). */
export function claimNewChatDraft(owner: string) {
  if (newChatDraft.owner === owner) return;
  newChatDraft.owner = owner; newChatDraft.text = ""; newChatDraft.mode = "chat"; newChatDraft.model = ""; newChatDraft.files = []; newChatDraft.held = new Map();
}

/** Visible text of a first frame (the optimistic user bubble shown until the server echoes the real message). */
export const firstFrameText = (f: FirstFrame): string => String((f.t === "send" ? f.text : f.prompt) ?? "");

/** A file picked on the start screen: held locally (there is no conversation to upload it to yet), uploaded on the first send. */
export type DraftFile = { blob: Blob; name: string };
type Res<T> = { status: number; data: T | null };
type UploadRes<U> = { ok: true; file: U } | { ok: false; error: string };
/** The first send from the start screen: create the conversation, upload the held files into it, rewrite the frame's file refs.
 *  On failure after the create, `id` is returned so the caller can delete the empty conversation (none must linger in the list). */
export async function lazyStart<U extends { ref: string }>(o: {
  model: string; frame: FirstFrame; drafts: ReadonlyMap<string, DraftFile>;
  /** False once a newer operation (e.g. "New chat") superseded this one: it must stop and never navigate. */
  isCurrent?: () => boolean;
  create: (model?: string) => Promise<Res<{ id: string }>>;
  upload: (id: string, blob: Blob, name: string) => Promise<UploadRes<U>>;
}): Promise<{ ok: true; id: string; frame: FirstFrame } | { ok: false; error: string; id?: string; superseded?: boolean }> {
  const cur = o.isCurrent ?? (() => true);
  const r = await o.create(o.model || undefined).catch(() => null);
  const id = r?.data?.id;
  if (!id) return { ok: false, error: r ? `Could not create chat (${r.status})` : "Could not create chat (offline?)" };
  if (!cur()) return { ok: false, error: "superseded", id, superseded: true };
  const files = Array.isArray(o.frame.files) ? (o.frame.files as Array<{ ref: string }>) : [];
  const out: unknown[] = [];
  for (const f of files) {
    const d = o.drafts.get(f.ref);
    if (!d) { out.push(f); continue; }
    if (!cur()) return { ok: false, error: "superseded", id, superseded: true };
    const u = await o.upload(id, d.blob, d.name).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "upload failed" }));
    if (!u.ok) return { ok: false, error: `${d.name}: ${u.error}`, id };
    out.push(u.file);
  }
  if (!cur()) return { ok: false, error: "superseded", id, superseded: true };
  return { ok: true, id, frame: files.length ? { ...o.frame, files: out } : o.frame };
}

/** The native shells (desktop / mobile) have no browser Back button, so a top-level screen draws its own. Detected from the UA token the shell appends. */
export const inNativeShell = (ua: unknown = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean => desktopShellVersion(ua) !== null || mobileShellVersion(ua) !== null;
/** What a root screen's Back does: history.back() when this entry was pushed from inside the app (history.state.fromApp), else the start screen (a deep link / reload / first entry has nothing safe to go back to). */
export const backAction = (state: unknown): "history" | "home" => ((state as { fromApp?: unknown } | null)?.fromApp === true ? "history" : "home");

// ---- desktop sidebar (>=1024px, fine pointer): pinned, or hidden with a temporary hover overlay ----
export type SidebarState = { pinned: boolean; overlay: "closed" | "open" | "leaving"; focus: boolean };
export type SidebarAction = { t: "hover" | "leave" | "tick" | "focus" | "blur" | "esc" | "select" | "toggle" | "pin" | "hide" };
/** How long the overlay lingers after the pointer left it and the hot zone (a stray exit must not flicker it shut). */
export const SIDEBAR_LEAVE_MS = 250;
/** The overlay is on screen (hidden sidebar, shown temporarily). */
export const sidebarPeek = (s: SidebarState): boolean => !s.pinned && s.overlay !== "closed";
export function sidebarReducer(s: SidebarState, a: SidebarAction): SidebarState {
  switch (a.t) {
    case "hover": return s.pinned ? s : { ...s, overlay: "open" };
    case "leave": return s.overlay === "open" ? { ...s, overlay: "leaving" } : s;
    case "tick": return s.overlay === "leaving" && !s.focus ? { ...s, overlay: "closed" } : s.overlay === "leaving" ? { ...s, overlay: "open" } : s;
    case "focus": return { ...s, focus: s.overlay !== "closed" || s.pinned };
    case "blur": return { ...s, focus: false, overlay: s.overlay === "open" ? "leaving" : s.overlay }; // focus left the sidebar: start the close delay (a pointer still on it cancels with its next move)
    case "esc": case "select": return { ...s, overlay: "closed", focus: false };
    case "toggle": return s.pinned ? { pinned: false, overlay: "closed", focus: false } : { pinned: true, overlay: "closed", focus: false };
    case "pin": return { pinned: true, overlay: "closed", focus: false };
    case "hide": return { pinned: false, overlay: "closed", focus: false };
  }
}
