// Devices v2 step 3, page logic for a chat bound to a device (docs/vertex-client-devices-v2.md section 10). Pure: no DOM, no IO. Wording is computer-neutral ("this computer", never an OS name).
import type { Device, DeviceRoot } from "./devices-api";
import { shortPath } from "./devices-logic";

export type EnvState = "ready" | "offline" | "revoked" | "unavailable";
export type EnvInfo = { kind: "device"; device_id: string; dir: string | null; name: string | null; state: EnvState; roots?: DeviceRoot[] };
export type Choice = { id: string; name: string; online: boolean; thisDevice: boolean; roots: DeviceRoot[] | null };

/** The devices a new chat can run on: this computer first (desktop shell only, server-decided), then online ones, then offline ones (selectable: the chat starts queued). */
export function envChoices(devices: Device[]): Choice[] {
  const rows = devices.map((d) => ({ id: d.id, name: d.name, online: d.online === true, thisDevice: d.this_install === true, roots: Array.isArray(d.roots) ? d.roots : null }));
  return rows.sort((a, b) => Number(b.thisDevice) - Number(a.thisDevice) || Number(b.online) - Number(a.online));
}
/** The desktop app defaults a new chat to this computer; a browser never chooses for the user (no row can be "this device" there, and nothing is guessed). */
export function defaultChoice(choices: Choice[], shell: boolean): Choice | null {
  return shell ? choices.find((c) => c.thisDevice) ?? null : null;
}
/** The folder sent with the first message: the device's only root, or the picked one if the device offered it, else its first. null = roots not reported (older device): the device decides. */
export function dirFor(c: Choice, picked?: string): string | null {
  if (!c.roots || c.roots.length === 0) return null;
  return c.roots.some((r) => r.path === picked) ? picked! : c.roots[0].path;
}

export type Banner = { text: string; tone: "info" | "warn" | "error"; state: EnvState };
export function envBanner(env: EnvInfo | null): Banner | null {
  if (!env) return null;
  const n = env.name ?? "this device";
  switch (env.state) {
    case "ready": return { state: "ready", tone: "info", text: `Running on ${n}${env.dir ? ` · ${shortPath(env.dir, 40)}` : ""}` };
    case "offline": return { state: "offline", tone: "warn", text: `${n} is offline. Messages will run when it comes back.` };
    case "revoked": return { state: "revoked", tone: "error", text: `${n} was revoked. This chat is read-only.` };
    case "unavailable": return { state: "unavailable", tone: "error", text: "Devices are turned off for this account. This chat is read-only." };
  }
}
/** Why the composer cannot send ("" = it can). Offline does not block: the hub queues the command. */
export function envBlock(env: EnvInfo | null): string {
  if (!env) return "";
  return env.state === "revoked" ? `${env.name ?? "This device"} was revoked` : env.state === "unavailable" ? "Devices are turned off for this account" : "";
}
/** The live state with the environment switch folded in. `enabled`: true/false = CONFIRMED by the latest device-list response; null = unknown (still loading, or a transient error): never reads as OFF. A confirmed OFF makes
 *  the chat unavailable (read-only) unless the device is already revoked; a later confirmed ON restores the derived state (unavailable here is not sticky, the underlying env is untouched). */
export function liveEnvWith(env: EnvInfo, list: Device[] | null, enabled: boolean | null): EnvInfo {
  const cur = liveEnv(env, list);
  return enabled === false && cur.state !== "revoked" ? { ...cur, state: "unavailable" } : cur;
}
/** Re-derive ready/offline from the latest device list (null = the list could not be read: keep what we know). revoked is sticky until a reload; unavailable is NOT (a chat loaded while the environment switch was OFF recovers when it is turned on: liveEnvWith imposes the confirmed OFF state on top). */
export function liveEnv(env: EnvInfo, list: Device[] | null): EnvInfo {
  if (!list || env.state === "revoked") return env;
  const d = list.find((x) => x.id === env.device_id);
  if (!d) return { ...env, state: "revoked" };
  return { ...env, name: d.name, state: d.online === true ? "ready" : "offline", ...(Array.isArray(d.roots) ? { roots: d.roots } : {}) };
}
