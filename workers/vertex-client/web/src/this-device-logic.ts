import { desktopShellVersion } from "./desktop-info";

/** First desktop shell that has the read-only `this_device_state` command (vclui3). Older shells keep their own tray window; the page only hints at updating. */
export const THIS_DEVICE_MIN_SHELL = "0.3.4";

export type FolderState = { path: string; exists: boolean };
export type ThisDeviceState = { running: boolean; status: string | null; reason: string | null; paired: boolean; version: string | null; model: string | null; /** null = the shell could not read them (not the same as an empty list) */ folders: FolderState[] | null };
export type DeviceInvoke = (cmd: string) => Promise<unknown>;
export type Loaded = { kind: "ok"; state: ThisDeviceState } | { kind: "update" } | { kind: "error"; message: string } | { kind: "none" };

const num = (s: string) => s.split("-")[0].split("+")[0].split(".").map((x) => parseInt(x, 10) || 0);
/** a >= b for plain x.y.z (pre-release tags ignored: the shell ships plain versions). */
export function versionAtLeast(a: string, b: string): boolean {
  const x = num(a), y = num(b);
  for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); }
  return true;
}

/** The screen exists only inside the desktop shell: the UA token AND the native bridge (the marker alone is not enough). */
export const thisDeviceAvailable = (ua: unknown, hasBridge: boolean): boolean => hasBridge && desktopShellVersion(ua) !== null;
/** UA token below the first shell with the command (or an unreadable one): do not even try. */
export const shellHasThisDevice = (ua: unknown): boolean => { const v = desktopShellVersion(ua); return v !== null && versionAtLeast(v, THIS_DEVICE_MIN_SHELL); };

const NATIVE_TEXT: Record<string, string> = {
  "wrong-origin": "This page is not allowed to read this computer.",
  failed: "Could not read the state of this computer. Try again in a few seconds.",
};
export const GENERIC_STATE_ERROR = NATIVE_TEXT.failed;

const s = (v: unknown, n: number): string | null => (typeof v === "string" ? v.slice(0, n) : null);
/** Strict shape check of what the shell returns; anything else is treated as an error, never rendered raw. */
export function parseState(raw: unknown): ThisDeviceState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.running !== "boolean") return null;
  const folders = r.folders === null || r.folders === undefined ? null : Array.isArray(r.folders) ? r.folders.flatMap((f): FolderState[] => (f && typeof (f as FolderState).path === "string" ? [{ path: (f as FolderState).path.slice(0, 300), exists: (f as FolderState).exists !== false }] : [])).slice(0, 50) : null;
  return { running: r.running, status: s(r.status, 40), reason: s(r.reason, 200), paired: r.paired === true, version: s(r.version, 40), model: s(r.model, 80), folders };
}

export async function loadThisDevice(invoke: DeviceInvoke | null, ua: unknown): Promise<Loaded> {
  if (!invoke || desktopShellVersion(ua) === null) return { kind: "none" };
  if (!shellHasThisDevice(ua)) return { kind: "update" };
  try {
    const st = parseState(await invoke("this_device_state"));
    return st ? { kind: "ok", state: st } : { kind: "error", message: GENERIC_STATE_ERROR };
  } catch (e) {
    if (typeof e === "string" && Object.hasOwn(NATIVE_TEXT, e)) return { kind: "error", message: NATIVE_TEXT[e] };
    return { kind: "update" }; // "command not found" / not allowed by the shell's capabilities: an older or differently built shell
  }
}

const STATUS_TEXT: Record<string, string> = { online: "Connected", connecting: "Connecting…", unpaired: "Not added yet", revoked: "Removed from your account", disconnected_by_app: "Disconnected from the app", error: "Problem" };
export const statusLabel = (st: string | null): string => (st && Object.hasOwn(STATUS_TEXT, st) ? STATUS_TEXT[st] : st ? `Status: ${st}` : "Unknown");
export const NOT_RUNNING_TEXT = "The vcl service is not running on this computer. Start the vcl service on this computer, then press Check again.";
export const UPDATE_TEXT = "This screen needs a newer version of the desktop app. Update the app (tray menu, “Check for updates”) and reopen it.";
export const canAdd = (st: ThisDeviceState): boolean => st.running && (!st.paired || st.status === "revoked");
