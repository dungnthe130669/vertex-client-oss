// The active space (Business | Open) as the CLIENT knows it. This is only a selector sent to the server (x-vc-space header / ?space=); the
// server decides whether it is allowed and which rows it means. Business is the absence of a selector: nothing is sent, nothing is stored.
import { clearPaneCache } from "./pane-cache";
export type Space = "biz" | "open";
export const SPACE_KEY = "vc.space";
export const SPACE_HEADER = "x-vc-space";
export const SPACE_UNAVAILABLE = "space unavailable";

export const parseSpaceValue = (v: unknown): Space | null => (v === "biz" || v === "open" ? v : null);

let current: Space | null = null; // null = not read yet (read lazily on first use so no request can run before the init)

const store = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
const persist = (s: Space) => { try { if (s === "open") store()?.setItem(SPACE_KEY, "open"); else store()?.removeItem(SPACE_KEY); } catch {} };
const paint = (s: Space) => { if (typeof document === "undefined") return; if (s === "open") document.documentElement.dataset.space = "open"; else delete document.documentElement.dataset.space; };

/** First read: a `?space=` in the URL (push click / deep link) wins once and is stripped; otherwise the remembered value; otherwise Business. */
function init(): Space {
  let s: Space = "biz";
  try { s = parseSpaceValue(store()?.getItem(SPACE_KEY)) ?? "biz"; } catch {}
  if (typeof location !== "undefined" && typeof location.search === "string" && location.search.includes("space=")) {
    const u = new URL(location.href); const fromUrl = parseSpaceValue(u.searchParams.get("space"));
    if (fromUrl) { s = fromUrl; persist(s); }
    u.searchParams.delete("space");
    try { history.replaceState(history.state, "", u.pathname + u.search + u.hash); } catch {}
  }
  paint(s);
  return s;
}

export const getSpace = (): Space => (current ??= init());
/** Sets the selector for this page load + this device. Does not reload anything: see `switchSpace`. */
export const setSpace = (s: Space) => { current = s; persist(s); paint(s); clearPaneCache(); };
/** Test hook: forget the in-memory value so the next read re-inits from storage / URL. */
export const resetSpaceForTest = () => { current = null; };

/** Headers to add to a request. Empty in Business, so the Business wire format is byte-identical to before spaces. */
export const spaceHeaders = (): Record<string, string> => (getSpace() === "open" ? { [SPACE_HEADER]: "open" } : {});
/** `?space=open` on a URL that cannot carry a header (img src, WebSocket, a download link). Unchanged in Business. */
export function withSpaceQuery(url: string): string {
  if (getSpace() !== "open") return url;
  const hash = url.indexOf("#"); const base = hash < 0 ? url : url.slice(0, hash); const tail = hash < 0 ? "" : url.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}space=open${tail}`;
}

/** Everything that must not survive a switch listens for this (the page reloads right after, so it is a belt: sockets close, timers stop). */
export const SPACE_SWITCH_EVENT = "vc:space-switch";
let navigate: (to: string) => void = (to) => location.replace(to);
export const setNavigateForTest = (f: (to: string) => void) => { navigate = f; };

/** Switch space: close sockets (listeners), remember the choice, then a full reload into the new space's start screen. A reload is the teardown:
 *  every in-memory list, model list, palette index, open chat, artifact panel and stream of the old space is gone, none can be shown in the new one. */
export function switchSpace(next: Space, to = "/") {
  if (next === getSpace()) return;
  if (typeof dispatchEvent === "function") dispatchEvent(new Event(SPACE_SWITCH_EVENT));
  setSpace(next);
  navigate(to);
}

/** Loop guard for the forced fall-back to Business: one reload per tab session. If Open still looks wrong after that (server keeps contradicting
 *  itself), the page stays in Business without reloading again. Cleared once the server confirms the space we are in. */
const GUARD_KEY = "vc.space.fallback";
const guard = () => { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } };
export const clearFallbackGuard = () => { try { guard()?.removeItem(GUARD_KEY); } catch {} };
/** Forget Open (stored value + in-memory + accent) and reload into Business ONCE. Returns true when it reloaded, false when the guard stopped a second one. */
export function fallBackToBusiness(): boolean {
  setSpace("biz");
  const g = guard();
  try { if (g?.getItem(GUARD_KEY)) return false; g?.setItem(GUARD_KEY, "1"); } catch {}
  if (typeof dispatchEvent === "function") dispatchEvent(new Event(SPACE_SWITCH_EVENT));
  navigate("/");
  return true;
}

/** Reconcile the remembered space with what the server says for this user. Stored `open` that /api/me does not confirm (older server, rollback,
 *  revoked) is dropped. "ok" = render; "reload" = a reload into Business is under way, render nothing; "stay" = guard hit, already Business, render. */
export function reconcileSpace(me: { spaces?: readonly string[]; space?: string } | null | undefined): "ok" | "reload" | "stay" {
  if (getSpace() !== "open") return "ok";
  if (me?.spaces?.includes("open") && me.space === "open") { clearFallbackGuard(); return "ok"; }
  return fallBackToBusiness() ? "reload" : "stay";
}

/** Cloud, Agents and Desktop are Business-only on the server: in Open their routes and entry points are not shown. */
export const BIZ_ONLY_MODES: readonly string[] = ["cloud", "agents", "desktop"];
export const isBizOnlyPath = (p: string) => /^\/(cloud|agents|desktop)$/.test(p) || /^\/(d|a|r|dv|computers)\/[^/]+$/.test(p) || p === "/computers" || p === "/devices" || p === "/settings/devices";

/** A stale tab sent `open` after Open was turned off for this user: forget it and land in Business (once: see `fallBackToBusiness`). The one body for every off-reason. */
export function handleSpaceStatus(status: number, data: unknown) {
  if (status !== 403 || getSpace() !== "open") return;
  if ((data as { error?: string } | null)?.error !== SPACE_UNAVAILABLE) return;
  fallBackToBusiness();
}
