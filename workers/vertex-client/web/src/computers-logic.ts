// "Computers" (comp1, Stage 1 of docs/vcl-remote-ux-design.md): pure helpers. No DOM, no network.
import type { LinkState } from "./devices-ws";

export const TERM_FIX = "vcl set terminal on";
export type Pill = { label: string; tone: "ok" | "warn" | "off"; reconnect: boolean };

/** The ONE connection pill of a machine page: Connecting… -> Connected -> Reconnecting… -> Offline. `reconnect` = show the manual button. */
export function linkPill(link: LinkState, helloed: boolean, deviceOnline: boolean): Pill {
  if (link === "revoked") return { label: "Revoked", tone: "off", reconnect: false };
  if (link === "closed") return { label: "Offline", tone: "off", reconnect: true };
  if (link === "reconnecting") return { label: "Reconnecting…", tone: "warn", reconnect: true };
  if (link === "connecting" || !helloed) return { label: "Connecting…", tone: "warn", reconnect: false };
  return deviceOnline ? { label: "Connected", tone: "ok", reconnect: false } : { label: "Offline", tone: "off", reconnect: false };
}

export type Gate = { kind: "checking" | "offline" | "off" | "ready"; title?: string; text?: string; fix?: string };
/** Terminal tab content decision. `termOn` = the hub's hello says this device can host a terminal (flag + cap + online + device switch). It cannot tell WHY it is off, so the text names the common cause and the one-line fix. */
export type TermStateIn = "on" | "off_switch" | "unsupported";
/** comp2: the device's own reason, when the (new) runtime sends it. Anything else = unknown (old runtime). */
export const termStateOf = (v: unknown): TermStateIn | undefined => (v === "on" || v === "off_switch" || v === "unsupported" ? v : undefined);
const OS_LABEL: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
/** OS label for a card; null = unknown (old runtime): show nothing rather than guess. */
export const osLabel = (os: unknown): string | null => (typeof os === "string" && Object.hasOwn(OS_LABEL, os) ? OS_LABEL[os] : null);
export function termGate(a: { helloed: boolean; termOn: boolean; online: boolean; termState?: TermStateIn; termWhy?: string }): Gate {
  if (!a.helloed) return { kind: "checking", text: "Connecting to this computer…" };
  if (!a.online) return { kind: "offline", title: "This computer is offline", text: "Start vcl on it (or wake it up). The terminal opens here as soon as it is back." }; // before termOn: a device_offline event does not clear termOn
  if (a.termOn) return { kind: "ready" };
  if (a.termState === "unsupported") return { kind: "off", title: "This computer cannot run the terminal", ...(a.termWhy ? { text: `Reason: ${a.termWhy.slice(0, 160)}` } : { text: "Its vcl cannot provide a terminal on this system." }) };
  if (a.termState === "off_switch") return { kind: "off", title: "Terminal is switched off on this computer", text: `Turn it on there: run ${TERM_FIX} in a terminal on that computer, or switch “Allow terminal” on in the vcl desktop app (Terminal tab). It connects again by itself.`, fix: TERM_FIX };
  return { kind: "off", title: "Terminal is off on this computer", text: `Turn it on there: run ${TERM_FIX} in a terminal on that computer, or switch “Allow terminal” on in the vcl desktop app (Terminal tab). If it stays off after that, this computer may not support the terminal.`, fix: TERM_FIX };
}

/** Link state for a card in the Computers list (from the device list, no socket). */
export const cardState = (online: boolean | null): { label: string; cls: "online" | "offline" | "unknown" } => online === true ? { label: "Online", cls: "online" } : online === false ? { label: "Offline", cls: "offline" } : { label: "Unknown", cls: "unknown" };

export const VIRTUAL_NAME = "Virtual computer";
export const VIRTUAL_NOTE = "A cloud desktop where an agent works; you can take over.";
export const EMPTY_TITLE = "No computers yet";
export const EMPTY_TEXT = "Link your own computer to open its terminal here: install vcl on it, then tap “Link a computer” and enter the code it shows.";
