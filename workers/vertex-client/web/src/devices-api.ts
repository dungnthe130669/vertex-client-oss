import { call } from "./api";

export type DeviceRoot = { label: string; path: string };
/** last_heard_at (ms, hub clock) and hb: only while online; absent from an older hub. hb=false = the daemon never announced a heartbeat (vcl <= 0.9.0). */
/** roots: absent = the device runs an older vcl that does not report them; [] = reported, none added yet. */
/** last_online_at (unix s): written by the hub at hello/close; null/absent = never seen online since this existed (older rows, older server). this_install: this row is the machine running THIS app (desktop shell only, server-decided from x-vc-install; absent/false = not known, never a guess). */
export type Device = { id: string; name: string; created_at: number; last_seen: number; last_online_at?: number | null; this_install?: boolean; linked?: boolean; online: boolean | null; roots?: DeviceRoot[]; last_heard_at?: number; hb?: boolean; os?: string; arch?: string };
export type Pairing = { code: string; display: string; expires_at: number; ttl_s: number };

/** 404 from any of these = the vcl flag is off (or not Business/main): the UI hides the entry instead of showing an error. */
export const listDevices = (install: string | null = null) => call<{ devices: Device[]; server_now?: number; /** chats may run on a device (flag vcl_env) */ env_chats?: boolean }>("/api/devices", install ? { headers: { "x-vc-install": install } } : {});
/** install: only "Add this device" in the desktop shell passes one; a code shown for another computer carries none. */
export const createPairing = (install: string | null = null) => call<Pairing & { error?: string }>("/api/devices/pair", { method: "POST", body: JSON.stringify(install ? { install_id: install } : {}) });
export const revokeDevice = (id: string) => call<{ ok?: boolean; closed?: boolean; error?: string }>(`/api/devices/${id}`, { method: "DELETE" });
/** "This is this device" (desktop shell only): bind this app install to one existing row that has no install id yet. Server checks ownership, revoked, collisions; 200 also when already bound to this install. */
export const claimDevice = (id: string, install: string) => call<{ ok?: boolean; error?: string }>(`/api/devices/${id}/claim`, { method: "POST", body: JSON.stringify({ install_id: install }) });
