import { withBusy } from "./busy";
import { ConfirmSheet } from "./confirm";
import { IconBack, IconChevron, IconPlus } from "./icons";
import { useEffect, useState } from "preact/hooks";
import { type AuthKind, type ConnectorPut, type ConnectorRow, deleteConnector, getConnector, getConnectors, postConnector, putConnector } from "./api";
import { ADD_NOTE, CHANGED_BADGE, CHANGED_HELP, CONNECTORS_NEW_CHATS_NOTE, MODE_LABEL, applyPut, disconnectText, modesFor, newConnectorBody, newConnectorError, offeredCount } from "./connectors-logic";
import { errorToast } from "./toast";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };

function useConnectors() {
  const [rows, setRows] = useState<ConnectorRow[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => {
    setErr("");
    void getConnectors().then((r) => { if (r.status === 200 && r.data) setRows(r.data.connectors); else setErr(r.data?.error ?? `Could not load connectors (${r.status})`); }).catch(() => setErr("Could not load connectors (offline?)"));
  };
  useEffect(load, []);
  return { rows, err, load };
}

/** One connector. The built-in comes from the list; a custom one is fetched on its own (that call contacts its server and shows its live tools). */
function useConnector(id: string) {
  const [c, setC] = useState<ConnectorRow | null>(null);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const load = () => {
    setErr("");
    const p = id.startsWith("cc_")
      ? getConnector(id).then((r) => { if (r.status === 200 && r.data) setC(r.data.connector); else setC(null); if (r.status !== 200 && r.status !== 404) setErr(r.data?.error ?? `Could not load connector (${r.status})`); })
      : getConnectors().then((r) => { if (r.status === 200 && r.data) setC(r.data.connectors.find((x) => x.id === id) ?? null); else setErr(r.data?.error ?? `Could not load connectors (${r.status})`); });
    void p.catch(() => setErr("Could not load connector (offline?)")).finally(() => setDone(true));
  };
  useEffect(load, [id]);
  return { c, setC, err, load, done };
}

/** Connectors list (/connectors): the built-in plus the user's own MCP connectors. "+" adds one. Only what is real is listed. */
export function Connectors({ onBack }: { onBack: () => void }) {
  const { rows, err, load } = useConnectors();
  return (
    <div class="shell">
      <header class="bar sheetbar"><button class="rbtn" aria-label="Back" title="Back" data-testid="connectors-back" onClick={onBack}><IconBack /></button><h2 class="title title-c">Connectors</h2>
        <button class="rbtn bar-act" aria-label="Add custom connector" title="Add custom connector" data-testid="connector-add" onClick={() => go("/connectors/new")}><IconPlus /></button></header>
      <main class="page settings" data-testid="connectors-screen">
        {err && <div><p class="error">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
        {!rows && !err && <div aria-busy="true"><div class="skel block" /></div>}
        {rows && (
          <div class="scard">
            {rows.map((c) => (
              <button class="srow" key={c.id} data-testid="connector-row" data-id={c.id} onClick={() => go(`/connectors/${c.id}`)}>
                <span class={`dot ${c.status === "ok" && c.enabled ? "open" : "closed"}`} role="img" aria-label={!c.enabled ? "Off" : c.status === "ok" ? "Reachable" : "Unreachable"} />
                <span class="srow-l">{c.name}{!c.enabled && <span class="muted small block">Disconnected</span>}</span>
                {c.toolCount !== null && <span class="cx-count" data-testid="connector-count" aria-label={`${c.toolCount} tools`}>{c.toolCount}</span>}
                <IconChevron />
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

/** Add custom connector (/connectors/new). */
export function AddConnector({ onBack }: { onBack: () => void }) {
  const [f, setF] = useState({ name: "", url: "", authKind: "none" as AuthKind, headerName: "", token: "" });
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const submit = async () => {
    const e = newConnectorError(f);
    if (e) { setErr(e); return; }
    setErr(""); setPending(true);
    const r = await withBusy("connector-add", () => postConnector(newConnectorBody(f))).catch(() => null);
    setPending(false);
    if (r?.status === 201 && r.data?.connector) { set({ token: "" }); history.replaceState({}, "", `/connectors/${r.data.connector.id}`); dispatchEvent(new PopStateEvent("popstate")); return; }
    setErr(r?.data?.error ?? "Could not add (offline?)");
  };
  return (
    <div class="shell">
      <header class="bar sheetbar"><button class="rbtn" aria-label="Back" title="Back" data-testid="add-back" onClick={onBack}><IconBack /></button><h2 class="title title-c">Add custom connector</h2><span class="rbtn-spacer" aria-hidden="true" /></header>
      <main class="page settings" data-testid="add-screen">
        <div class="scard">
          <div class="sfield"><label for="cx-name">Name</label><input id="cx-name" data-testid="add-name" type="text" maxLength={40} autocomplete="off" value={f.name} onInput={(e) => set({ name: e.currentTarget.value })} /></div>
          <div class="sfield"><label for="cx-url">MCP server URL</label><input id="cx-url" data-testid="add-url" type="url" inputMode="url" autocomplete="off" autocapitalize="off" placeholder="https://" value={f.url} onInput={(e) => set({ url: e.currentTarget.value })} /></div>
          <div class="sfield"><label id="cx-auth-l">Authentication</label>
            <div class="seg" role="group" aria-labelledby="cx-auth-l">
              {(["none", "bearer", "header"] as const).map((k) => <button type="button" key={k} data-testid={`add-auth-${k}`} aria-pressed={f.authKind === k} onClick={() => set({ authKind: k })}>{k === "none" ? "None" : k === "bearer" ? "Bearer token" : "Header"}</button>)}
            </div></div>
          {f.authKind === "header" && <div class="sfield"><label for="cx-hn">Header name</label><input id="cx-hn" data-testid="add-header-name" type="text" autocomplete="off" autocapitalize="off" placeholder="X-Api-Key" value={f.headerName} onInput={(e) => set({ headerName: e.currentTarget.value })} /></div>}
          {f.authKind !== "none" && <div class="sfield"><label for="cx-tok">{f.authKind === "bearer" ? "Bearer token" : "Header value"}</label><input id="cx-tok" data-testid="add-token" type="password" autocomplete="new-password" value={f.token} onInput={(e) => set({ token: e.currentTarget.value })} /></div>}
        </div>
        <p class="muted small cx-note" data-testid="add-note">{ADD_NOTE} The token is stored encrypted on the server and is never shown again.</p>
        {err && <p class="error" role="alert" data-testid="add-error">{err}</p>}
        <div class="approve"><button class="btn primary" data-testid="add-submit" disabled={pending} onClick={() => void submit()}>{pending ? "Connecting…" : "Add"}</button></div>
      </main>
    </div>
  );
}

function Switch({ on, label, testid, disabled, onToggle }: { on: boolean; label: string; testid: string; disabled?: boolean; onToggle: (next: boolean) => void }) {
  return <button class="cx-switch" role="switch" aria-checked={on} aria-label={label} data-testid={testid} disabled={disabled} onClick={() => onToggle(!on)}><span class="cx-knob" /></button>;
}

/** One connector (/connectors/<id>): reachability, tools with Always / Ask first / Block, Disconnect. */
export function ConnectorDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { c, setC, err, load, done } = useConnector(id);
  const [pending, setPending] = useState(false);
  const [ask, setAsk] = useState(false);
  const custom = c?.kind === "remote-mcp";
  const put = async (b: ConnectorPut) => {
    if (!c) return;
    setC((x) => (x ? applyPut(x, b) : x));
    setPending(true);
    const r = await withBusy("connector-put", () => putConnector(id, b)).catch(() => null);
    setPending(false);
    if (r?.status !== 200) { errorToast(r?.data?.error ?? "Could not save (offline?)", () => void put(b)); load(); }
  };
  const disconnect = async () => {
    setAsk(false);
    if (!c) return;
    if (!custom) { await put({ enabled: false }); return; }
    setPending(true);
    const r = await withBusy("connector-delete", () => deleteConnector(id)).catch(() => null);
    setPending(false);
    if (r?.status === 200) { history.replaceState({}, "", "/connectors"); dispatchEvent(new PopStateEvent("popstate")); }
    else errorToast(r?.data?.error ?? "Could not disconnect (offline?)", () => void disconnect());
  };
  const t = c ? disconnectText(c) : null;
  return (
    <div class="shell">
      <header class="bar sheetbar"><button class="rbtn" aria-label="Back" title="Back" data-testid="connector-back" onClick={onBack}><IconBack /></button><h2 class="title title-c">{c?.name ?? "Connector"}</h2><span class="rbtn-spacer" aria-hidden="true" /></header>
      <main class="page settings" data-testid="connector-screen">
        {err && <div><p class="error">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
        {!done && !err && <div aria-busy="true"><div class="skel block" /><div class="skel block" /></div>}
        {done && !c && !err && <p class="muted">Connector not found.</p>}
        {c && (
          <>
            <div class="scard">
              <div class="srow static">
                <span class={`dot ${c.status === "ok" && c.enabled ? "open" : "closed"}`} aria-hidden="true" />
                <span class="srow-l"><strong>{c.name}</strong><span class="muted small block" data-testid="connector-status">{!c.enabled ? "Disconnected" : c.status === "ok" ? `Reachable · ${offeredCount(c)} of ${c.toolCount ?? c.tools.length} tools on` : `Unreachable${c.error ? `: ${c.error}` : ""}`}</span>
                  {custom && <span class="muted small block cx-url" data-testid="connector-url">{c.url}{c.hasToken ? " · token saved" : ""}</span>}</span>
                {c.enabled && <Switch on={c.enabled} label={`Use ${c.name}`} testid="connector-master" disabled={pending} onToggle={(v) => void put({ enabled: v })} />}
              </div>
            </div>
            <p class="muted small cx-note" data-testid="connector-note">{CONNECTORS_NEW_CHATS_NOTE}. Block hides a tool from the model; Ask first waits for your tap; Always runs without asking.</p>
            {c.enabled && (
              <section aria-labelledby="cx-all">
                <h3 class="sg-title" id="cx-all">All tools — choose how each one runs</h3>
                <div class="scard" data-testid="connector-tools">
                  {c.tools.length === 0 && <div class="srow static"><span class="srow-l muted">{c.status === "ok" ? "No tools" : "Tools unavailable"}</span></div>}
                  {c.tools.map((tl) => (
                    <div class="srow static cx-tool" key={tl.name} data-testid="connector-tool" data-name={tl.name}>
                      <span class="srow-l"><strong>{tl.name}</strong><span class="muted small block">{tl.description}</span>
                        {tl.changed && <span class="cx-changed" data-testid="tool-changed"><strong>{CHANGED_BADGE}</strong><span class="small block">{CHANGED_HELP}</span>
                          <button type="button" class="btn" data-testid="tool-reconfirm" disabled={pending} onClick={() => void put({ tool: { name: tl.name, mode: "always" } })}>Confirm Always</button></span>}
                        <span class="seg cx-modes" role="group" aria-label={`Mode for ${tl.name}`}>
                          {modesFor(tl).map((m) => <button type="button" key={m} data-testid={`tool-mode-${m}`} aria-pressed={tl.mode === m} disabled={pending} onClick={() => tl.mode !== m && void put({ tool: { name: tl.name, mode: m } })}>{MODE_LABEL[m]}</button>)}
                        </span></span>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <div class="approve cx-disc">
              {c.enabled
                ? <button class="btn danger" data-testid="connector-disconnect" disabled={pending} onClick={() => setAsk(true)}>Disconnect</button>
                : <button class="btn primary" data-testid="connector-reconnect" disabled={pending} onClick={() => void put({ enabled: true })}>Reconnect</button>}
            </div>
          </>
        )}
      </main>
      {ask && t && <ConfirmSheet title={t.title} body={t.body} confirmLabel={t.confirm} onConfirm={() => void disconnect()} onCancel={() => setAsk(false)} />}
    </div>
  );
}
