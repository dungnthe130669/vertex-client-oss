import { shellInvoke } from "./desktop-pair";
import type { Notif } from "./notif-logic";

/** Native notifications inside the desktop shell (design 4): forwards an incoming `notif` row or `approval_request` to the ONE native command `native_notify`
 *  when the user is not looking at the page (window hidden or unfocused). Browser / installed PWA: no bridge, nothing happens. Text and an in-app path only. */
export type NotifyInvoke = (cmd: string, args: { title: string; body: string; route: string }) => Promise<unknown>;
export type Away = () => boolean;

const MAX_TITLE = 80, MAX_BODY = 240, SEEN_MAX = 200, SAME_ROUTE_MS = 15_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Single line, no control characters, capped in characters (not UTF-16 units: the shell counts chars). */
export function clip(s: unknown, max: number): string {
  const t = (typeof s === "string" ? s : "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const a = Array.from(t);
  return a.length <= max ? t : `${a.slice(0, max - 1).join("")}…`;
}

/** Same relative-path rule as the shell (`validate_route`): one leading `/`, no `//`, scheme, backslash or `..`. The shell checks again; this only avoids a pointless call. */
export function safeRoute(r: unknown): string | null {
  return typeof r === "string" && r.length <= 200 && /^\/[A-Za-z0-9\-_.~%?=&+,:@/]*$/.test(r) && !r.startsWith("//") && !r.includes("..") ? r : null;
}

/** The user is looking only when the page is visible AND the window has focus. `document.hidden` is what the hub's `vis` report is also based on. */
export function userAway(d: Pick<Document, "visibilityState" | "hasFocus"> | undefined = typeof document === "undefined" ? undefined : document): boolean {
  return !!d && (d.visibilityState === "hidden" || !d.hasFocus());
}

export type ShellNotifier = {
  notif: (n: Pick<Notif, "id" | "title" | "body" | "url" | "kind">) => void;
  approval: (deviceId: string, e: { rid?: unknown; tool?: unknown; preview?: unknown }) => void;
};

export function createShellNotifier(invoke: NotifyInvoke | null, away: Away = userAway, now: () => number = Date.now): ShellNotifier | null {
  if (!invoke) return null;
  const seen = new Set<string>();
  const approvalRoutes = new Map<string, number>(); // route -> when an approval for it was forwarded: its server-side `notif` twin is not shown again
  let denied = false; // permission-denied (or the shell said it cannot show): stop calling; the in-app toast stays the notice
  const first = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
    return true;
  };
  const send = (title: string, body: string, route: string) => {
    if (denied || !title) return;
    try { void Promise.resolve(invoke("native_notify", { title, body, route })).catch((e: unknown) => { if (e === "permission-denied") denied = true; }); }
    catch { /* a broken bridge must never break the in-app notice that called us */ }
  };
  return {
    notif(n) {
      if (typeof n?.id !== "string" || !first(`n:${n.id}`) || !away()) return;
      const route = safeRoute(n.url);
      if (!route) return;
      const at = approvalRoutes.get(route);
      if (at !== undefined && now() - at < SAME_ROUTE_MS) return;
      send(clip(n.title, MAX_TITLE), clip(n.body, MAX_BODY), route);
    },
    approval(deviceId, e) {
      if (typeof e?.rid !== "string" || !first(`a:${e.rid}`) || !away()) return;
      const route = safeRoute(`/dv/${deviceId}`);
      if (!route) return;
      approvalRoutes.set(route, now());
      // Only the tool name: `preview` is a command line or file content and must never reach an OS banner, notification history or lock screen
      // (same rule as the Web Push payload, src/device-push.ts). The details are on the page the click opens.
      send("Approval needed", clip(e.tool, 40) || "a tool", route);
    },
  };
}

let shared: ShellNotifier | null | undefined;
/** The page-wide notifier: null (and never retried) outside the shell. */
export function shellNotifier(): ShellNotifier | null {
  if (shared === undefined) { const inv = shellInvoke(); shared = createShellNotifier(inv as unknown as NotifyInvoke | null); }
  return shared;
}
