import { useEffect, useState } from "preact/hooks";
import { GUARD_KEY, LAST_KEY, autoReloadAllowed, decideUpdate, isIdle, nextLast, parseBuiltAt, parseDeployedVersion, parseLastResult, parseServerVersion, parseVersionInfo, relation, retryDelayMs, safeStore, shortReason, type LastResult, type ServerVersion, type Snapshot, type UpdateFailure, type VersionInfo } from "./update-logic";
import { busyCount } from "./busy";

export type Check = "idle" | "checking" | "uptodate" | "ready" | "error";
export type UpdateState = { build: string | null; buildSource: "worker" | "deployed" | null; commit: string | null; builtAt: string | null; server: ServerVersion | null; waitingBuild: string | null; waiting: boolean; failure: UpdateFailure | null; noticeDismissed: boolean; last: LastResult | null; check: Check; error: string };
const local = safeStore(() => localStorage);
const session = safeStore(() => sessionStorage);
function loadLast(): LastResult | null { return parseLastResult(local.get(LAST_KEY)); }
function recordLast(ev: LastResult) {
  const n = nextLast(st.last, ev);
  local.set(LAST_KEY, JSON.stringify(n));
  set({ last: n });
}
let st: UpdateState = { build: null, buildSource: null, commit: null, builtAt: null, server: null, waitingBuild: null, waiting: false, failure: null, noticeDismissed: false, last: loadLast(), check: "idle", error: "" };
const subs = new Set<(s: UpdateState) => void>();
const set = (p: Partial<UpdateState>) => { st = { ...st, ...p }; subs.forEach((f) => f(st)); };
export const getState = () => st;
/** The build this page RUNS for comparison with the server: null when the only source is the /version.json fallback (that is the deployed build, possibly newer than the open page). */
export const runningBuild = (s: Pick<UpdateState, "build" | "buildSource">) => (s.buildSource === "deployed" ? null : s.build);
export function useUpdate(): UpdateState {
  const [s, setS] = useState(st);
  useEffect(() => { subs.add(setS); setS(st); return () => { subs.delete(setS); }; }, []);
  return s;
}

let reg: ServiceWorkerRegistration | null = null;
let asked = false;
let firstInstall = false; // set by registerSw: the page loaded without a controller
const visible = () => document.visibilityState === "visible";

function snapshot(): Snapshot {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")].map((e) => ({ tag: e.tagName, type: (e as HTMLInputElement).type, value: e.value }));
  return { busy: busyCount(), fields, overlay: !!document.querySelector(".scrim, .cmenu-root") };
}

/** Ask a worker for its build id (the BUILD stamped into sw.js is the single source of truth). */
function askVersion(w: ServiceWorker | null | undefined): Promise<VersionInfo | null> {
  return new Promise((res) => {
    if (!w) return res(null);
    const ch = new MessageChannel();
    const t = setTimeout(() => res(null), 2000);
    ch.port1.onmessage = (e) => { clearTimeout(t); res(parseVersionInfo(e.data)); };
    try { w.postMessage({ t: "VERSION" }, [ch.port2]); } catch { clearTimeout(t); res(null); }
  });
}
export const refreshBuild = async () => {
  const v = await askVersion(navigator.serviceWorker?.controller ?? reg?.active);
  if (v) { set({ build: v.build, commit: v.commit, buildSource: "worker" }); void refreshBuiltAt(); } else if (!navigator.serviceWorker?.controller && !st.build) void refreshDeployed();
};

/** No service worker (native WKWebView shell): the page came from the network, so /version.json (no-cache) is the build it runs. Never overrides a worker-reported build. */
async function refreshDeployed(): Promise<void> {
  try {
    const r = await fetch("/version.json", { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const v = parseDeployedVersion(await r.json());
    if (v && !st.build) set({ build: v.build, commit: v.commit, builtAt: v.builtAt, buildSource: "deployed" });
  } catch { /* stay unknown */ }
}

/** builtAt is wall-clock, so it is not in sw.js: read /version.json fresh (no-cache) and trust it only when it describes the build this device runs. */
export async function refreshBuiltAt(): Promise<void> {
  try {
    const r = await fetch("/version.json", { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    set({ builtAt: parseBuiltAt(await r.json(), st.build) });
  } catch { /* keep the last value */ }
}

/** Ask the server which build is deployed (authenticated like every /api route). Keeps the last value on failure; returns the error text or "". */
export async function refreshServer(): Promise<string> {
  try {
    const r = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const v = parseServerVersion(await r.json());
    if (!v) throw new Error("Bad reply");
    set({ server: v });
    return "";
  } catch (e) { return e instanceof Error ? e.message : "Could not reach the server"; }
}
export const swState = (): "waiting" | "installing" | "active" | "none" => (reg?.waiting ? "waiting" : reg?.installing ? "installing" : reg?.active ? "active" : "none");
export const busyNow = () => busyCount() > 0;

/** Apply the waiting worker, then reload once it takes control. "Updated" is recorded only when the new worker is actually controlling (controllerchange);
 *  if activation never happens that is a FAILURE (feeds the notice/backoff), never a false "Updated". */
let appliedBuild: string | undefined;
export function applyUpdate(auto = false) {
  const w = reg?.waiting;
  if (!w) return;
  asked = true;
  appliedBuild = st.waitingBuild ?? undefined;
  if (auto) session.set(GUARD_KEY, String(Date.now()));
  try { w.postMessage({ t: "SKIP_WAITING" }); } catch (e) { asked = false; noteFailure(e); return; }
  setTimeout(() => {
    if (!asked) return;
    asked = false;
    noteFailure(new Error("Activation timed out"));
    if (!auto) location.reload(); // the user asked: do not leave a dead button
  }, 4000);
}

/** Explicit "Update now" (About): the user asked, so no idle guard. With no waiting worker (server ahead) fetch it first; last resort is a plain reload. */
export async function updateNow() {
  if (!reg?.waiting && reg) { try { await reg.update(); await installed(reg.installing); } catch { /* fall through to reload */ } }
  if (reg?.waiting) applyUpdate(); else location.reload();
}

/** Re-evaluate. A waiting worker is applied silently, but only when `safe` (cold start / return from background / navigation) and nothing is in flight; otherwise it just waits. Nothing here is user-visible. */
function tick(safe = false) {
  const w = reg?.waiting;
  if (!w) { if (st.waiting) set({ waiting: false, waitingBuild: null }); return; }
  if (!navigator.serviceWorker.controller) { w.postMessage({ t: "SKIP_WAITING" }); return; } // uncontrolled page: nothing of ours to swap
  if (!st.waiting) { set({ waiting: true, check: "ready" }); void askVersion(w).then((v) => set({ waitingBuild: v?.build ?? null })); }
  const d = decideUpdate({ waiting: true, visible: visible(), safeMoment: safe, idle: isIdle(snapshot()), autoOk: autoReloadAllowed(session.get(GUARD_KEY), Date.now()), firstInstall });
  if (d === "auto" && !asked) applyUpdate(true);
}

function installed(w: ServiceWorker | null): Promise<void> {
  return new Promise((res) => {
    if (!w || w.state === "installed" || w.state === "redundant" || w.state === "activated") return res();
    const t = setTimeout(res, 30_000);
    w.addEventListener("statechange", () => { if (w.state !== "installing") { clearTimeout(t); res(); } });
  });
}

/** reg.update() and wait for an install it triggers. Resolves the outcome for the Settings button. */
export async function checkNow(): Promise<Check> {
  if (!reg) { set({ check: "error", error: "Service worker not active" }); return "error"; }
  set({ check: "checking", error: "" });
  try {
    const [, serverErr] = await Promise.all([reg.update().then(() => installed(reg!.installing)), refreshServer()]);
    tick();
    // "Ready" = a new worker waits OR the server's build is not the one this device runs (even if the worker has not finished installing yet).
    const ahead = relation(runningBuild(st), st.server?.build ?? null) === "older";
    if (serverErr && !reg.waiting) { set({ check: "error", error: `Server check failed: ${serverErr}` }); return "error"; }
    const c: Check = reg.waiting || ahead ? "ready" : "uptodate";
    set({ check: c, failure: null });
    clearTimeout(retryTimer);
    if (c === "uptodate") recordLast({ kind: "uptodate", at: Date.now() });
    return c;
  } catch (e) {
    set({ check: "error", error: e instanceof Error ? e.message : "Check failed" });
    return "error";
  }
}
let retryTimer: ReturnType<typeof setTimeout> | undefined;
function noteFailure(e: unknown) {
  const attempts = (st.failure?.attempts ?? 0) + 1;
  const reason = shortReason(e);
  set({ failure: { reason, attempts } });
  recordLast({ kind: "failed", at: Date.now(), reason });
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void silentCheck(false), retryDelayMs(attempts));
}
/** Background check + install (also (re)tries a failed registration). It only DOWNLOADS: it applies the waiting worker only when `apply` (a safe moment: cold start / return from background),
 *  never from the 15-min timer or a retry timer. Only a failure while ONLINE is recorded (offline retries on the next `online`/foreground signal). */
export async function silentCheck(apply = false): Promise<void> {
  if (!visible() || st.check === "checking") return;
  if (!reg) { await registerOnce(); return; }
  try {
    await reg.update();
    const w = reg.installing;
    await installed(w);
    if (w && w.state === "redundant" && !reg.waiting) throw new Error("Install failed");
    if (w && w.state === "installing") throw new Error("Install timed out");
    clearTimeout(retryTimer);
    if (st.failure) set({ failure: null });
    if (!reg.waiting) recordLast({ kind: "uptodate", at: Date.now() });
    tick(apply);
  } catch (e) {
    if (navigator.onLine === false) return;
    noteFailure(e);
  }
}
export const retryUpdate = () => { set({ noticeDismissed: false }); void silentCheck(false); };

/** Escape hatch: drop the worker and every shell cache, then load fresh from the network. */
export const OFFLINE_RESET_MSG = "You are offline — try again when connected";
export async function resetApp(): Promise<boolean> {
  // Prove the network works BEFORE destroying the only copy of the shell that still boots offline.
  try {
    // The "?" makes the URL miss the worker's cached "/" entry, so a pass means the NETWORK answered, not our own shell cache.
    const r = await fetch(`/?vc-reset=${Date.now()}`, { cache: "reload" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch { set({ check: "error", error: OFFLINE_RESET_MSG }); return false; }
  try {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) if (k.startsWith("vc-shell-")) await caches.delete(k);
  } finally { location.reload(); }
  return true;
}

export function dismissNotice() { set({ noticeDismissed: true }); }

let wired = false;
/** Register sw.js; a failure while online (sw.js fetch/registration error) counts as an update failure with backoff, offline does not. */
async function registerOnce(): Promise<void> {
  const sw = navigator.serviceWorker;
  try {
    const r = await sw.register("/sw.js", { updateViaCache: "none" });
    reg = r;
    if (st.failure) set({ failure: null });
    void refreshBuild();
    tick(true); // cold start
    if (wired) return;
    wired = true;
    r.addEventListener("updatefound", () => {
      const w = r.installing;
      w?.addEventListener("statechange", () => { if (w.state === "installed") tick(); });
    });
    void silentCheck(true);
    // Foreground signals: an installed iOS PWA is suspended and resumed, not reloaded, so these are the only chances we get.
    const fg = () => { if (!visible()) return; void silentCheck(true); tick(true); void refreshBuild(); };
    document.addEventListener("visibilitychange", fg);
    addEventListener("pageshow", fg); addEventListener("focus", fg); addEventListener("online", fg);
    setInterval(() => void silentCheck(false), 15 * 60_000); // download only; applying stays on the safe moments above
  } catch (e) {
    if (navigator.onLine !== false) noteFailure(e);
  }
}

export function registerSw(go: (path: string) => void) {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  firstInstall = !sw.controller;
  sw.addEventListener("controllerchange", () => {
    if (asked) { asked = false; recordLast({ kind: "updated", at: Date.now(), build: appliedBuild }); location.reload(); } else void refreshBuild();
  });
  sw.addEventListener("message", (e) => { if (e.data?.t === "nav" && typeof e.data.url === "string" && e.data.url.startsWith("/")) go(e.data.url); });
  // Online/foreground signals only exist once registration succeeded; until then the failure backoff timer (noteFailure) and `online` retry it.
  addEventListener("online", () => { if (!reg) void silentCheck(true); });
  document.addEventListener("visibilitychange", () => { if (!reg && visible()) void silentCheck(true); });
  if (document.readyState === "complete") void registerOnce(); else addEventListener("load", () => void registerOnce());
}
