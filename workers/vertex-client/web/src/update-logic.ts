// Pure decisions behind the PWA update flow (no DOM / no service-worker access) so they are unit-testable.

export type Decision = "none" | "auto" | "defer";
/** Silent updates: a waiting worker is applied ONLY at a safe moment (cold start / return from background / navigation) when nothing is in flight, and never shown to the user.
 *  waiting: a new worker is installed and waiting. safeMoment: the caller is one of those moments. idle: nothing in flight / nothing typed. autoOk: the reload-loop guard allows another automatic reload.
 *  firstInstall: this page loaded with no controlling worker, so its "waiting" worker is the FIRST install (WebKit claims it ~1s after load), not an update:
 *  there is nothing to swap, and an automatic reload would tear down whatever the user just opened (the row menu). "defer" = leave it waiting for the next safe moment. */
export function decideUpdate(i: { waiting: boolean; visible: boolean; safeMoment: boolean; idle: boolean; autoOk: boolean; firstInstall?: boolean }): Decision {
  if (!i.waiting) return "none";
  return i.visible && i.safeMoment && i.idle && i.autoOk && !i.firstInstall ? "auto" : "defer";
}

/** A background update that failed. The notice appears only once an automatic retry has ALSO failed (a single mobile network blip stays invisible). */
export type UpdateFailure = { reason: string; attempts: number };
export const FAIL_NOTICE_AFTER = 2;
export const noticeVisible = (f: UpdateFailure | null, dismissed: boolean) => !!f && f.attempts >= FAIL_NOTICE_AFTER && !dismissed;
/** Retry delay after the Nth consecutive failure: 15s, 30s, 60s ... capped at 30 min. */
export const retryDelayMs = (attempts: number) => Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
export const shortReason = (e: unknown) => { const m = (e instanceof Error ? e.message : String(e ?? "")).replace(/\s+/g, " ").trim(); return (m || "Unknown error").slice(0, 80); };

/** Last silent-update outcome, kept in localStorage so About can show it after the reload an update causes. */
export type LastResult = { kind: "uptodate" | "updated" | "failed"; at: number; build?: string; reason?: string };
export const LAST_KEY = "vc-upd-last";
export function parseLastResult(raw: string | null): LastResult | null {
  try {
    const o = raw ? JSON.parse(raw) : null;
    if (!o || typeof o.at !== "number" || !["uptodate", "updated", "failed"].includes(o.kind)) return null;
    return { kind: o.kind, at: o.at, build: typeof o.build === "string" ? o.build : undefined, reason: typeof o.reason === "string" ? o.reason : undefined };
  } catch { return null; }
}
/** "Up to date" never overwrites a recorded "Updated to ..." (that is the more useful fact); a success replaces a failure; a failure replaces anything. */
export function nextLast(prev: LastResult | null, ev: LastResult): LastResult {
  return ev.kind === "uptodate" && prev?.kind === "updated" ? prev : ev;
}
export function lastResultText(r: LastResult | null, fmt: (at: number) => string = (at) => new Date(at).toLocaleString()): string {
  if (!r) return "No background update yet";
  if (r.kind === "uptodate") return `Up to date (${fmt(r.at)})`;
  if (r.kind === "updated") return `Updated${r.build ? ` to ${shortBuild(r.build)}` : ""} at ${fmt(r.at)}`;
  return `Last update failed: ${r.reason || "unknown error"} (${fmt(r.at)})`;
}

/** Storage that never throws (Safari private mode, quota, disabled storage): falls back to an in-memory map so a storage error can never abort the update flow. */
export function safeStore(get: () => Pick<Storage, "getItem" | "setItem">) {
  const mem = new Map<string, string>();
  return {
    get(k: string): string | null { try { return get().getItem(k); } catch { return mem.get(k) ?? null; } },
    set(k: string, v: string) { mem.set(k, v); try { get().setItem(k, v); } catch { /* memory copy only */ } },
  };
}

/** Reload-loop guard: at most one AUTOMATIC reload per window, remembered in sessionStorage (survives the reload it guards). */
export const GUARD_KEY = "vc-upd-reload";
export const GUARD_WINDOW_MS = 120_000;
export function autoReloadAllowed(raw: string | null, now: number): boolean {
  if (!raw) return true;
  const at = Number(raw);
  return !Number.isFinite(at) || now - at > GUARD_WINDOW_MS || at > now;
}

export type Field = { tag: string; type?: string; value: string };
export type Snapshot = { busy: number; fields: Field[]; overlay: boolean };
const NON_TEXT = new Set(["hidden", "checkbox", "radio", "button", "submit", "reset", "range", "file", "color", "image"]);
/** Idle = no turn/stream/upload (busy registry), no unsent text in any field, no sheet/dialog open. Never reload when this is false. */
export function isIdle(s: Snapshot): boolean {
  if (s.busy > 0 || s.overlay) return false;
  return !s.fields.some((f) => !NON_TEXT.has((f.type ?? "").toLowerCase()) && f.value.trim() !== "");
}

/** The sw.js reply to {t:"VERSION"}: returns the build id or null for anything else. */
export function parseVersionReply(d: unknown): string | null {
  const o = d as { t?: unknown; build?: unknown } | null;
  return o && o.t === "VERSION" && typeof o.build === "string" && o.build ? o.build : null;
}
export const shortBuild = (b: string | null) => (b ? b.slice(0, 7) : "unknown");

export type VersionInfo = { build: string; commit: string | null };
/** The sw.js reply to {t:"VERSION"} with its stamped commit ("unknown" -> null). */
export function parseVersionInfo(d: unknown): VersionInfo | null {
  const build = parseVersionReply(d);
  if (!build) return null;
  const o = d as { commit?: unknown };
  const f = (v: unknown) => (typeof v === "string" && v && v !== "unknown" ? v : null);
  return { build, commit: f(o.commit) };
}

/** builtAt from a /version.json body, only when its build is the one this device runs (otherwise null: it would describe someone else's build). */
export function parseBuiltAt(d: unknown, deviceBuild: string | null): string | null {
  if (!d || typeof d !== "object" || !deviceBuild) return null;
  const o = d as { build?: unknown; builtAt?: unknown };
  return o.build === deviceBuild && typeof o.builtAt === "string" && o.builtAt && o.builtAt !== "unknown" ? o.builtAt : null;
}

/** Build facts from a /version.json body, for a page with no service worker (WKWebView shell): the page was loaded from the network, so the deployed assets are what it runs. */
export function parseDeployedVersion(d: unknown): (VersionInfo & { builtAt: string | null }) | null {
  if (!d || typeof d !== "object") return null;
  const o = d as { build?: unknown; commit?: unknown; builtAt?: unknown };
  const f = (v: unknown) => (typeof v === "string" && v && v !== "unknown" ? v : null);
  const build = f(o.build);
  return build ? { build, commit: f(o.commit), builtAt: f(o.builtAt) } : null;
}

/** GET /api/version body, validated; null for anything that is not an object. */
export type ServerVersion = { worker_version_id: string | null; build: string | null; commit: string | null; builtAt: string | null };
export function parseServerVersion(d: unknown): ServerVersion | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  const f = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { worker_version_id: f(o.worker_version_id), build: f(o.build), commit: f(o.commit), builtAt: f(o.builtAt) };
}

export type Relation = "match" | "older" | "unknown";
/** This device vs the server: "older" when the server's build differs from the build this device RUNS (the server is by definition the newest deployed). */
export function relation(deviceBuild: string | null, serverBuild: string | null): Relation {
  if (!deviceBuild || !serverBuild) return "unknown";
  return deviceBuild === serverBuild ? "match" : "older";
}

/** "Update now" is enabled when a new worker is waiting or the server is ahead of this device. */
export const canUpdateNow = (waiting: boolean, rel: Relation) => waiting || rel === "older";

export function relationText(rel: Relation): string {
  return rel === "match" ? "This device matches the server" : rel === "older" ? "This device is older than the server (update available)" : "Could not compare with the server";
}

/** The text the About "Copy" button puts on the clipboard: one "Label: value" line per row, nothing else. */
export const formatAbout = (rows: Array<[string, string]>) => rows.map(([k, v]) => `${k}: ${v}`).join("\n");
export const shortUa = (ua: string) => {
  const m = /(Edg|CriOS|FxiOS|Chrome|Firefox|Version)\/([\d.]+)/.exec(ua);
  const os = /iPhone|iPad|Android|Windows|Mac OS X|Linux/.exec(ua)?.[0] ?? "";
  const name = m ? ({ Version: "Safari", CriOS: "Chrome", FxiOS: "Firefox", Edg: "Edge" } as Record<string, string>)[m[1]] ?? m[1] : "";
  return [name && `${name} ${m![2].split(".")[0]}`, os].filter(Boolean).join(" · ") || ua.slice(0, 40);
};

/** The native mobile shell appends ` VertexClientMobile/<version>` to its user agent. Same strict SemVer-token rule as the desktop shell; anything else is null. */
const MOBILE_RE = /(?:^|\s)VertexClientMobile\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/;
export function mobileShellVersion(ua: unknown): string | null {
  return typeof ua === "string" && ua.length <= 1000 ? MOBILE_RE.exec(ua)?.[1] ?? null : null;
}
