import { useEffect, useRef, useState } from "preact/hooks";
import { IconBack } from "./icons";
import { shellInvoke } from "./desktop-pair";
import { addThisDevice } from "./desktop-pair";
import { inDesktopShell } from "./desk-logic";
import { NOT_RUNNING_TEXT, UPDATE_TEXT, canAdd, loadThisDevice, statusLabel, thisDeviceAvailable, type Loaded } from "./this-device-logic";

export const REFRESH_MIN_MS = 3000;
export type Deps = { invoke: ReturnType<typeof shellInvoke>; ua: string; add: () => ReturnType<typeof addThisDevice> };
const real = (): Deps => ({ invoke: shellInvoke() as never, ua: typeof navigator === "undefined" ? "" : navigator.userAgent, add: () => addThisDevice() });

/** Settings entry (phone page): only inside the desktop shell. */
export function ThisDeviceRow({ onOpen }: { onOpen: () => void }) {
  if (!(inDesktopShell() && thisDeviceAvailable(typeof navigator === "undefined" ? "" : navigator.userAgent, !!shellInvoke()))) return null;
  return <button class="srow" data-testid="open-this-device" onClick={onOpen}><span class="srow-l">This device</span><span class="srow-v">This computer</span></button>;
}

export function ThisDevicePage({ onBack, onDevices, deps = real() }: { onBack: () => void; onDevices?: () => void; deps?: Deps }) {
  const [st, setSt] = useState<Loaded | null>(null);
  const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const last = useRef(0);
  const load = async () => { last.current = Date.now(); setSt(await loadThisDevice(deps.invoke as never, deps.ua)); };
  // Read once on open; no polling (each read costs a daemon ticket and the daemon allows only a few a minute). Manual refresh, at most one per REFRESH_MIN_MS.
  const refresh = () => { if (Date.now() - last.current >= REFRESH_MIN_MS) void load(); };
  useEffect(() => { void load(); }, []);
  const add = async () => { setBusy(true); setMsg(""); const r = await deps.add(); setBusy(false); if (r.ok) { setMsg("Connected. This computer will appear in the Devices list in a moment."); void load(); } else if (!r.cancelled) setMsg(r.message); };
  const gate = !thisDeviceAvailable(deps.ua, !!deps.invoke);
  return (
    <div class="shell">
      <header class="bar sheetbar"><button class="rbtn" aria-label="Back" title="Back" data-testid="subpage-back" onClick={onBack}><IconBack /></button><h2 class="title title-c ellip">This device</h2><span class="rbtn-spacer" aria-hidden="true" /></header>
      <main class="page settings" data-testid="this-device-page">
        {gate && <div class="empty" data-testid="this-device-off"><h2>Not available</h2><p class="muted">This screen is part of the Vertex Client desktop app.</p></div>}
        {!gate && !st && <div class="skel row-skel" aria-busy="true" />}
        {!gate && st?.kind === "update" && <div class="empty" data-testid="this-device-update"><h2>Update the app</h2><p class="muted">{UPDATE_TEXT}</p></div>}
        {!gate && st?.kind === "error" && <div class="empty state-panel" role="alert" data-testid="this-device-error"><h2>Couldn't read this computer</h2><p class="muted">{st.message}</p><button class="btn" onClick={refresh}>Retry</button></div>}
        {!gate && st?.kind === "ok" && !st.state.running && <div class="empty" data-testid="this-device-down"><h2>Not running</h2><p class="muted">{NOT_RUNNING_TEXT}</p><button class="btn" data-testid="this-device-recheck" onClick={refresh}>Check again</button></div>}
        {!gate && st?.kind === "ok" && st.state.running && (
          <div class="scard" data-testid="this-device-info">
            <div class="srow"><span class="srow-l">Service</span><span class="srow-v" data-testid="td-running">Running</span></div>
            <div class="srow"><span class="srow-l">Status</span><span class="srow-v" data-testid="td-status">{statusLabel(st.state.status)}</span></div>
            {st.state.reason && <div class="srow"><span class="srow-l">Details</span><span class="srow-v" data-testid="td-reason">{st.state.reason}</span></div>}
            <div class="srow"><span class="srow-l">vcl version</span><span class="srow-v" data-testid="td-version">{st.state.version ?? "unknown"}</span></div>
            <div class="srow"><span class="srow-l">Model</span><span class="srow-v" data-testid="td-model">{st.state.model ?? "default"}</span></div>
            {st.state.folders === null
              ? <div class="srow"><span class="srow-l">Folders</span><span class="srow-v muted" data-testid="td-folders-unavailable">Unavailable: could not read folders</span></div>
              : <>
                <div class="srow"><span class="srow-l">Folders</span><span class="srow-v" data-testid="td-folder-count">{st.state.folders.length}</span></div>
                <ul class="list" data-testid="td-folders">{st.state.folders.map((f) => <li key={f.path} class="muted small" data-testid="td-folder">{f.path}{f.exists ? "" : " (missing)"}</li>)}</ul>
              </>}
          </div>
        )}
        {!gate && st?.kind === "ok" && canAdd(st.state) && <div class="approve" data-testid="add-this-device-box"><button class="btn primary" data-testid="add-this-device" disabled={busy} onClick={() => void add()}>{busy ? "Waiting for confirmation..." : "Add this device"}</button></div>}
        {!gate && st?.kind === "ok" && st.state.paired && onDevices && <button class="btn" data-testid="this-device-devices" onClick={onDevices}>Devices list (mark “This is this device”)</button>}
        {!gate && st?.kind === "ok" && st.state.running && <button class="btn" data-testid="this-device-refresh" onClick={refresh}>Refresh</button>}
        {msg && <p class="muted small" role="status" data-testid="this-device-msg">{msg}</p>}
      </main>
    </div>
  );
}
