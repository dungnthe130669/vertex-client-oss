// Computers (comp1, Stage 1): ONE page listing my linked devices + the virtual computer; choosing a device opens its Terminal (/computers/:id).
// Additive: /devices, /dv/:id, /desktop and /remote keep working unchanged. Reuses PairSheet / listDevices / DeviceView.
import { useEffect, useState } from "preact/hooks";
import { desktopConfig } from "./desktop-api";
import { type Device, listDevices } from "./devices-api";
import { deviceLabel, lastOnlineLine, sortDevices } from "./devices-logic";
import { Bar, PairSheet } from "./devices";
import { EMPTY_TEXT, EMPTY_TITLE, VIRTUAL_NAME, VIRTUAL_NOTE, cardState, osLabel } from "./computers-logic";
import { IconDesktop, IconDevices, IconPlus } from "./icons";
import { toast } from "./toast";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };

export function ComputersPage({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Device[] | null>(null), [gone, setGone] = useState(false), [failed, setFailed] = useState(false), [virtual, setVirtual] = useState(false), [pair, setPair] = useState(false);
  const [now, setNow] = useState(Date.now());
  const load = async () => {
    const r = await listDevices().catch(() => null);
    if (!r) { setFailed(true); return; }
    if (r.status === 404 || r.status === 403) { setGone(true); setRows(null); return; }
    if (r.status === 200 && r.data) { setRows(r.data.devices); setGone(false); setFailed(false); } else setFailed(true);
  };
  useEffect(() => { void load(); const t = setInterval(() => { void load(); setNow(Date.now()); }, 10_000); return () => clearInterval(t); }, []);
  useEffect(() => { let live = true; void desktopConfig().then((r) => { if (live) setVirtual(r.status === 200 && r.data?.enabled === true); }).catch(() => {}); return () => { live = false; }; }, []);
  if (gone) return <div class="shell"><Bar title="Computers" onBack={onBack} /><main class="page settings empty" data-testid="computers-off"><h2>Not available</h2><p class="muted">Computers are not enabled here.</p></main></div>;
  const known = new Set(rows?.map((d) => d.id));
  return (
    <div class="shell">
      <Bar title="Computers" onBack={onBack}><button class="rbtn bar-act" aria-label="Link a computer" title="Link a computer" data-testid="cm-pair-open" onClick={() => setPair(true)}><IconPlus /></button></Bar>
      <main class="page settings" data-testid="computers-page">
        {!rows && !failed && !gone && <ul class="list" aria-busy="true">{[0, 1].map((i) => <li key={i}><div class="skel row-skel" /></li>)}</ul>}
        {failed && !rows && <div class="empty state-panel" role="alert"><h2>Couldn't load computers</h2><button class="btn" onClick={() => void load()}>Retry</button></div>}
        {rows && rows.length === 0 && <div class="empty" data-testid="computers-empty"><h2>{EMPTY_TITLE}</h2><p class="muted">{EMPTY_TEXT}</p><button class="btn primary" data-testid="cm-pair-empty" onClick={() => setPair(true)}>Link a computer</button></div>}
        <ul class="list" data-testid="computer-list">
          {rows && sortDevices(rows).map((d) => {
            const lb = deviceLabel(d, rows), st = cardState(d.online);
            return (
              <li key={d.id} class="scard dev-row cm-card" data-testid="computer-card">
                <div class="dev-main">
                  <span class="dev-title"><IconDevices /><strong class="ellip">{d.name}</strong>{lb.dup && <span class="muted small dev-short">#{lb.short}</span>}</span>
                  <span class="muted small"><span class={`chip dev-${st.cls}`} data-testid="computer-status">{st.label}</span>{osLabel(d.os) && <> · <span data-testid="computer-os">{osLabel(d.os)}</span></>} · <span data-testid="computer-last">{lastOnlineLine(d, now)}</span></span>
                </div>
                <div class="dev-act"><button class="btn primary" data-testid="computer-open" aria-label={`Open ${d.name}`} onClick={() => go(`/computers/${d.id}`)}>Open terminal</button></div>
              </li>
            );
          })}
          {virtual && <li class="scard dev-row cm-card" data-testid="computer-virtual">
            <div class="dev-main">
              <span class="dev-title"><IconDesktop /><strong class="ellip">{VIRTUAL_NAME}</strong></span>
              <span class="muted small">{VIRTUAL_NOTE}</span>
            </div>
            <div class="dev-act"><button class="btn" data-testid="computer-virtual-open" onClick={() => go("/desktop")}>Open</button></div>
          </li>}
        </ul>
      </main>
      {pair && <PairSheet known={known} onClose={() => { setPair(false); void load(); }} onPaired={(d) => { setPair(false); toast(`Linked ${d.name}`); void load(); }} />}
    </div>
  );
}
