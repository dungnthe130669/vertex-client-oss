// Devices v2 step 3: UI pieces of a chat that runs on a device. Logic is in chat-env-logic.ts (pure); this file is hooks + markup only.
import { useEffect, useState } from "preact/hooks";
import { listDevices, type Device } from "./devices-api";
import { inDesktopShell } from "./desk-logic";
import { shellInvoke } from "./desktop-pair";
import { installId } from "./install-id";
import { type Choice, type EnvInfo, defaultChoice, dirFor, envBanner, envChoices, liveEnvWith } from "./chat-env-logic";
import { type Turn, turnLine } from "./devices-logic";

/** The caller's device list + whether chat environments are switched on (`env_chats` from GET /api/devices: flag `vcl_env`). `envChats`: true/false once a response CONFIRMED it, null = unknown (loading / transient error: the last confirmed value is kept).
 *  200 = the response says; 404 = the master switch is off = confirmed false. Refreshes while `live` and the tab is visible. */
export type DeviceListState = { list: Device[] | null; envChats: boolean | null };
export function useDeviceList(want: boolean, live: boolean, everyMs = 20_000): DeviceListState {
  const [s, setS] = useState<DeviceListState>({ list: null, envChats: null });
  useEffect(() => {
    if (!want) return;
    let dead = false;
    const shell = inDesktopShell() && !!shellInvoke();
    const run = () => { if (typeof document !== "undefined" && document.visibilityState === "hidden") return; void listDevices(shell ? installId() : null).then((r) => { if (dead) return; setS((p) => r.status === 200 && r.data ? { list: r.data.devices, envChats: (r.data as { env_chats?: boolean }).env_chats === true } : r.status === 404 ? { list: null, envChats: false } : { list: p.list, envChats: p.envChats }); }).catch(() => {}); };
    run();
    if (!live) return () => { dead = true; };
    const t = setInterval(run, everyMs);
    return () => { dead = true; clearInterval(t); };
  }, [want, live, everyMs]);
  return s;
}

/** Keeps a bound chat's banner honest (ready/offline/revoked/unavailable) from the device list and the confirmed environment switch, without reloading the chat. */
export function useLiveEnv(env: EnvInfo | null, list: Device[] | null, enabled: boolean | null = null): EnvInfo | null { return env ? liveEnvWith(env, list, enabled) : null; }

/** New-chat environment: "Cloud" or one of the user's devices (+ folder when the device offers several). Only rendered when environments are on and the user has devices. */
export function EnvChip({ choices, pickedId, dir, onPick, onDir, disabled }: { choices: Choice[]; pickedId: string | null; dir?: string; onPick: (id: string | null) => void; onDir: (p: string) => void; disabled?: boolean }) {
  const picked = choices.find((c) => c.id === pickedId) ?? null;
  return (<>
    <select class="envsel pill" data-testid="env-select" aria-label="Where this chat runs" value={pickedId ?? ""} disabled={disabled} onChange={(e) => onPick(e.currentTarget.value || null)}>
      <option value="">Cloud</option>
      {choices.map((c) => <option value={c.id}>{c.name}{c.thisDevice ? " (this computer)" : ""}{c.online ? "" : " · offline"}</option>)}
    </select>
    {picked && picked.roots && picked.roots.length > 1 && (
      <select class="envsel pill" data-testid="env-dir" aria-label="Folder on the device" value={dirFor(picked, dir) ?? ""} disabled={disabled} onChange={(e) => onDir(e.currentTarget.value)}>
        {picked.roots.map((r) => <option value={r.path}>{r.label}</option>)}
      </select>
    )}
  </>);
}

/** Per-chat banner: where it runs + its state, then the step-1 status line for the turn in flight. Never silent: every state has words. */
export function EnvBanner({ env, turn, nowMs }: { env: EnvInfo; turn: Turn | null; nowMs: number }) {
  const b = envBanner(env)!, line = turnLine(turn, nowMs, env.name ?? undefined);
  return (<>
    <div class={`dv-status env-banner ${b.tone === "info" ? "" : b.tone}`} role="status" data-testid="env-banner" data-state={b.state}>{b.text}</div>
    {line && <div class={`dv-status ${line.tone === "info" ? "" : line.tone}`} role="status" data-testid="device-status" data-state={line.state}>{line.text}</div>}
  </>);
}

export { defaultChoice, envChoices };
