import { withBusy } from "./busy";
import { useDevicesAvailable } from "./devices-available";
import { IconBack, IconClose, IconDevices, IconPlus } from "./icons";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Device, type DeviceRoot, type Pairing, claimDevice, createPairing, listDevices, revokeDevice } from "./devices-api";
import { pairLimitMessage } from "./devices-logic";
import { linkPill, termGate, termStateOf } from "./computers-logic";
import { addThisDevice, shellInvoke } from "./desktop-pair";
import { inDesktopShell } from "./desk-logic";
import { installId } from "./install-id";
import { deviceLabel, lastOnlineLine, replaceCandidates, sortDevices, staleDays, quietMinutes, quietText, type Approval, type Feed, type Frame, ackTurn, beginTurn, dropTurn, emptyFeed, failTurn, fmtClock, fmtLastSeen, foldEvent, isExpired, joinDir, newCid, nextPending, pairCommand, recalledInfo, rememberInfo, secondsLeft, shortPath, subfolderProblem, timeLeftFrac, turnLine, visiblePath } from "./devices-logic";
import { type Link, type LinkState, openDeviceLink } from "./devices-ws";
import { notifyApproval } from "./devices-notify";
import { shellNotifier } from "./desktop-notify";
import { ConfirmSheet, useEscape } from "./confirm";
import { errorToast, toast } from "./toast";
import { lazyScreen } from "./lazy-screen";
import type { TermBind } from "./term-pane";

const TermPane = lazyScreen(() => import("./term-pane").then((m) => m.default));

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const useTick = (ms: number, on = true) => { const [t, set] = useState(Date.now()); useEffect(() => { if (!on) return; const i = setInterval(() => set(Date.now()), ms); return () => clearInterval(i); }, [ms, on]); return t; };

/** Keeps Tab inside `ref`, focuses the container (never a button) on open and gives focus back on close. */
function useFocusTrap(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const el = ref.current, prev = document.activeElement as HTMLElement | null;
    el?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],input,textarea,select,[tabindex]:not([tabindex='-1'])")];
      if (!f.length) { e.preventDefault(); el.focus(); return; }
      const first = f[0], lastEl = f[f.length - 1], cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === el)) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && cur === lastEl) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("keydown", k); prev?.focus?.(); };
  }, []);
}

export function Bar({ title, onBack, children }: { title: string; onBack: () => void; children?: preact.ComponentChildren }) {
  return (
    <header class="bar sheetbar">
      <button class="rbtn" aria-label="Back" title="Back" data-testid="subpage-back" onClick={onBack}><IconBack /></button>
      <h2 class="title title-c ellip">{title}</h2>
      {children ?? <span class="rbtn-spacer" aria-hidden="true" />}
    </header>
  );
}

// ---------- Settings entry: hidden unless the feature answers (404 = flag off) ----------
export function DevicesRow({ onOpen }: { onOpen: () => void }) {
  const on = useDevicesAvailable(true);
  if (!on) return null;
  return <button class="srow" data-testid="open-devices" onClick={onOpen}><IconDevices /><span class="srow-l">Devices</span><span class="srow-v">Your own computers</span></button>;
}

// ---------- Pair sheet ----------
export function PairSheet({ onClose, onPaired, known }: { onClose: () => void; onPaired: (d: Device) => void; known: Set<string> }) {
  useEscape(onClose);
  const box = useRef<HTMLDivElement>(null); useFocusTrap(box);
  const [p, setP] = useState<Pairing | null>(null); // the code lives in this component's state only: never in storage
  const [err, setErr] = useState("");
  const [started, setStarted] = useState(false); // opening the sheet creates nothing: a code (rate-limited, 5 per 10 min) is only minted by the explicit button
  const [copied, setCopied] = useState(false);
  const now = useTick(1000, !!p);
  const mint = async () => {
    setStarted(true); setErr(""); setP(null);
    const r = await withBusy("device-pair", () => createPairing());
    if (r.status === 201 && r.data?.code) setP(r.data);
    else setErr(r.status === 429 ? pairLimitMessage(r.retryAfter) : r.status === 409 ? "Device limit reached, revoke one first." : r.data?.error ?? `Could not create a code (${r.status})`);
  };
  useEffect(() => { // a newly paired device ends the flow by itself
    if (!p) return;
    const i = setInterval(() => void listDevices().then((r) => { const d = r.data?.devices.find((x) => !known.has(x.id)); if (d) onPaired(d); }).catch(() => {}), 3000);
    return () => clearInterval(i);
  }, [p]);
  const left = p ? secondsLeft(p.expires_at, now) : 0;
  const cmd = p ? pairCommand(p.code, location.origin) : "";
  const copy = async () => { try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { errorToast("Could not copy, select the command and copy it."); } };
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="pair-title" data-testid="pair-sheet" onClick={(e) => e.stopPropagation()}>
        <h3 class="confirm-title" id="pair-title">Pair a device</h3>
        {err && <p class="error" role="alert" data-testid="pair-error">{err}</p>}
        {!started && <><p class="muted small">Creates a one-time code, valid for 10 minutes, that you enter on the computer you want to connect.</p><div class="approve"><button class="btn primary" data-testid="pair-create" onClick={() => void mint()}>Create code</button></div></>}
        {started && !p && !err && <div class="skel line wide" aria-busy="true" />}
        {p && <>
          <div class="pair-code" data-testid="pair-code" aria-label={`Pairing code ${p.code.split("").join(" ")}`}>{p.display}</div>
          <div class="muted small" data-testid="pair-countdown" role="timer">{left > 0 ? `Expires in ${fmtClock(left)}` : "Code expired"}</div>
          <p class="muted small">On the computer, run this command. Anything Claude reads inside a directory you allow is sent to the model and kept in this app's transcript.</p>
          <code class="pre pair-cmd" data-testid="pair-command">{cmd}</code>
          <div class="approve">
            <button class="btn" data-testid="pair-copy" disabled={left === 0} onClick={() => void copy()}>{copied ? "Copied" : "Copy command"}</button>
            {left === 0 && <button class="btn primary" data-testid="pair-new" onClick={() => void mint()}>New code</button>}
          </div>
        </>}
        {err && <div class="approve"><button class="btn primary" data-testid="pair-new" onClick={() => void mint()}>Try again</button></div>}
        <div class="approve"><button class="btn" data-testid="pair-close" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

// ---------- Devices page ----------
export { pairLimitMessage };

/** Desktop shell only (never in a browser, an installed PWA or on a phone): mints a code and lets the shell pair this computer after its own native confirmation. */
function AddThisDevice({ onStart, onDone }: { onStart: () => void; onDone: () => void }) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const run = async () => {
    setState("working"); setMsg(""); onStart();
    const r = await addThisDevice();
    if (r.ok) { setState("done"); setMsg("Connected. This computer will appear in the list in a moment."); onDone(); }
    else { setState(r.cancelled ? "idle" : "error"); setMsg(r.message); }
  };
  return (
    <div class="approve" data-testid="add-this-device-box">
      <button class="btn primary" data-testid="add-this-device" disabled={state === "working"} onClick={() => void run()}>{state === "working" ? "Waiting for confirmation..." : "Add this device"}</button>
      {msg && <p class={state === "error" ? "error" : "muted small"} role={state === "error" ? "alert" : "status"} data-testid="add-this-device-status">{msg}</p>}
    </div>
  );
}

/** Where Back from a device returns to: the top-level list when it was opened from there, else the Settings list (the original entry). */
let listPath = "/settings/devices";
export function DevicesPage({ onBack, top = false }: { onBack: () => void; top?: boolean }) {
  listPath = top ? "/devices" : "/settings/devices";
  const [rows, setRows] = useState<Device[] | null>(null);
  const [gone, setGone] = useState(false); // flag off / 404: nothing to show
  const [failed, setFailed] = useState(false);
  const [offset, setOffset] = useState<number | null>(null); // hub clock minus browser clock at the last fetch; null (older hub) = no silence hint
  const [pair, setPair] = useState(false);
  const [ask, setAsk] = useState<Device | null>(null);
  const [mark, setMark] = useState<Device | null>(null); // "This is this device" confirm
  const [replace, setReplace] = useState<{ fresh: Device; old: Device[] } | null>(null);
  const watch = useRef<Set<string> | null>(null); // ids that existed when a pairing started: the first row not in it is the new device
  const shell = inDesktopShell() && !!shellInvoke(); // the marker alone is not enough: the button needs the native bridge it calls
  const load = async () => {
    const r = await listDevices(shell ? installId() : null).catch(() => null); // the install id is only sent from the desktop shell: a browser tab or phone can never be "this device"
    if (!r) { setFailed(true); return; }
    if (r.status === 404) { setGone(true); return; }
    if (r.status === 200 && r.data) {
      const list = r.data.devices;
      const fresh = watch.current ? list.find((x) => !watch.current!.has(x.id)) : undefined;
      if (fresh) { watch.current = null; const old = replaceCandidates(list, fresh.id); if (old.length) setReplace({ fresh, old }); }
      setRows(list); setOffset(typeof r.data.server_now === "number" ? r.data.server_now - Date.now() : null); setFailed(false); } else setFailed(true);
  };
  useEffect(() => { void load(); const t = setInterval(() => void load(), 10_000); return () => clearInterval(t); }, []);
  const now = useTick(30_000);
  const startWatch = () => { watch.current = new Set(rows?.map((d) => d.id)); };
  const revokeOld = async (old: Device[]) => { // explicit user action only; each is its own DELETE, a failure stops the rest and is shown
    setReplace(null);
    for (const d of old) { const r = await withBusy("device-revoke", () => revokeDevice(d.id)); if (r.status !== 200) { errorToast(r.data?.error ?? `Could not revoke ${d.name} (${r.status})`); break; } toast(`${d.name} revoked`); }
    void load();
  };
  const claim = async (d: Device) => { // explicit one-time user action, desktop shell only; the server decides, the page never guesses
    setMark(null);
    const id = installId(); if (!id) { errorToast("Could not mark this device."); return; }
    let r: Awaited<ReturnType<typeof claimDevice>>;
    try { r = await withBusy("device-claim", () => claimDevice(d.id, id)); } // a rejected fetch must not escape: toast it, the button is still there for a retry
    catch { errorToast("Could not mark this device. Check your connection and try again."); return; }
    if (r.status === 200) { toast(`${d.name} is marked as this device`); void load(); }
    else errorToast(r.status === 409 ? "Could not mark it: this device or this app is already linked to another one." : r.status === 429 ? "Too many attempts. Wait a few minutes." : "Could not mark this device.");
  };
  const revoke = async (d: Device) => {
    setAsk(null);
    const r = await withBusy("device-revoke", () => revokeDevice(d.id));
    if (r.status === 200) { toast(`${d.name} revoked`); void load(); } else errorToast(r.data?.error ?? `Could not revoke (${r.status})`, () => void revoke(d));
  };
  if (gone) return <div class="shell"><Bar title="Devices" onBack={onBack} /><main class="page settings empty" data-testid="devices-off"><h2>Not available</h2><p class="muted">Local devices are not enabled here.</p></main></div>;
  return (
    <div class="shell">
      <Bar title="Devices" onBack={onBack}><button class="rbtn bar-act" aria-label="Pair a device" title="Pair a device" data-testid="pair-open" onClick={() => { startWatch(); setPair(true); }}><IconPlus /></button></Bar>
      <main class="page settings" data-testid="devices-page">
        {shell && <AddThisDevice onStart={startWatch} onDone={() => void load()} />}
        {!rows && !failed && <ul class="list" aria-busy="true">{[0, 1].map((i) => <li key={i}><div class="skel row-skel" /></li>)}</ul>}
        {failed && !rows && <div class="empty state-panel" role="alert"><h2>Couldn't load devices</h2><button class="btn" onClick={() => void load()}>Retry</button></div>}
        {rows && rows.length === 0 && <div class="empty" data-testid="devices-empty"><h2>No devices yet</h2><p class="muted">Pair your own computer to let Claude work in a directory you choose, with your approval for every change.</p><button class="btn primary" data-testid="pair-empty" onClick={() => { startWatch(); setPair(true); }}>Pair a device</button></div>}
        <ul class="list" data-testid="device-list">
          {rows && sortDevices(rows).map((d) => {
            const info = recalledInfo(d.id);
            const lb = deviceLabel(d, rows), stale = staleDays(d, Date.now() + (offset ?? 0));
            const st = d.online === true ? "online" : d.online === false ? "offline" : "unknown";
            return (
              <li key={d.id} class="scard dev-row" data-testid="device-row">
                <div class="dev-main">
                  <span class="dev-title"><strong class="ellip">{d.name}</strong>{lb.dup && <span class="muted small dev-short" data-testid="device-short" title="Device id (first characters)">#{lb.short}</span>}{d.this_install === true && <span class="chip dev-this" data-testid="device-this">This device</span>}</span>
                  <span class="muted small"><span class={`chip dev-${st}`} data-testid="device-status">{st}</span>{st !== "online" && <> · <span data-testid="device-last">{lastOnlineLine(d, now)}</span></>}</span>
                  {stale !== null && <span class="muted small" data-testid="device-stale">Not seen for {stale} days. Revoke it if you no longer use it.</span>}
                  {offset !== null && quietMinutes(d, Date.now() + offset) !== null && <span class="muted small" data-testid="device-quiet">{quietText(quietMinutes(d, Date.now() + offset)!)}</span>}
                  <span class="muted small" data-testid="device-sandbox">{info ? `Last session: sandbox ${info.sandbox || "unknown"} · bash ${info.bash ? "on" : "off"}` : "Sandbox and bash status show after a session starts"}</span>
                </div>
                <div class="dev-act">
                  {shell && !d.linked && !rows.some((x) => x.this_install === true) && <button class="btn" data-testid="device-mark-this" aria-label={`This is this device: ${d.name}${lb.dup ? ` ${lb.short}` : ""}`} onClick={() => setMark(d)}>This is this device</button>}
                  <button class="btn primary" data-testid="device-open" onClick={() => go(`/dv/${d.id}`)}>Open</button>
                  <button class="btn" data-testid="device-revoke" aria-label={lb.dup ? `Revoke ${d.name} ${lb.short}` : `Revoke ${d.name}`} onClick={() => setAsk(d)}>Revoke</button>
                </div>
              </li>
            );
          })}
        </ul>
      </main>
      {replace && <ConfirmSheet title={`Replace the old “${replace.fresh.name}”?`} body={`You now have ${replace.old.length + 1} devices named “${replace.fresh.name}”. ${replace.old.map((d) => `#${d.id.slice(0, 4)} (${lastOnlineLine(d, Date.now() + (offset ?? 0))})`).join(", ")} ${replace.old.length > 1 ? "are" : "is"} still listed. Revoke ${replace.old.length > 1 ? "them" : "it"} now? Nothing is revoked unless you confirm; the new one #${replace.fresh.id.slice(0, 4)} stays.`} confirmLabel="Revoke old" onConfirm={() => void revokeOld(replace.old)} onCancel={() => setReplace(null)} />}
      {pair && <PairSheet known={new Set(rows?.map((d) => d.id))} onClose={() => { setPair(false); void load(); }} onPaired={(d) => { setPair(false); toast(`Paired ${d.name}`); void load(); }} />}
      {mark && <ConfirmSheet title={`Is “${mark.name}” this device?`} body={`Mark #${mark.id.slice(0, 4)} as the device on this computer, so it shows “This device”. Only do this if vcl on this computer is the one paired as “${mark.name}” (its id starts with ${mark.id.slice(0, 4)}). It changes only this label; nothing is paired or revoked.`} confirmLabel="Yes, this device" danger={false} onConfirm={() => void claim(mark)} onCancel={() => setMark(null)} />}
      {ask && <ConfirmSheet title={`Revoke ${ask.name}?`} body="The device is disconnected now and its token stops working. Pair it again to use it later." confirmLabel="Revoke" onConfirm={() => void revoke(ask)} onCancel={() => setAsk(null)} />}
    </div>
  );
}

// ---------- Approval sheet ----------
const DiffLine = ({ l }: { l: string }) => <span class={l.startsWith("+") ? "dl add" : l.startsWith("-") ? "dl del" : "dl"}>{l}{"\n"}</span>;
/** Faithful preview: the exact text the device sent, as plain text (never markdown/HTML). Edit previews get +/- colouring; the text itself is unchanged. */
export function Preview({ tool, text }: { tool: string; text: string }) {
  const lines = text.split("\n");
  return (
    <div data-testid="approval-preview">
      {(tool === "Write" || tool === "Edit") && <div class="muted small">File</div>}
      {(tool === "Write" || tool === "Edit") && <code class="pre" data-testid="approval-path">{lines[0]}</code>}
      <pre class="pre tail" tabIndex={0} aria-label={tool === "Bash" ? "Command" : "Change"}>{tool === "Edit" ? lines.slice(1).map((l, i) => <DiffLine key={i} l={l} />) : tool === "Write" ? lines.slice(1).join("\n") : text}</pre>
      {text.length >= 4000 && <div class="muted small">The device truncates previews at 4000 characters.</div>}
    </div>
  );
}
export function ApprovalSheet({ a, nowS, answered, onAnswer, onMinimize, more = 0 }: { a: Approval; nowS: number; answered: boolean; onAnswer: (allow: boolean) => void; onMinimize: () => void; more?: number }) {
  useEscape(onMinimize);
  const box = useRef<HTMLDivElement>(null); useFocusTrap(box);
  const expired = isExpired(a, nowS), left = Math.max(0, Math.ceil(a.expires_at - nowS)), done = answered || expired || a.state !== "pending";
  return (
    <div class="scrim" data-testid="approval-scrim">
      <div class="sheet approval-sheet" ref={box} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="ap-title" aria-describedby="ap-time" data-testid="approval-sheet">
        <h3 class="confirm-title" id="ap-title">Allow {a.tool}?</h3>
        <div class="tleft" role="progressbar" aria-label="Time left to answer" aria-valuemin={0} aria-valuemax={a.ttl_s} aria-valuenow={left} data-testid="approval-bar"><span style={{ width: `${Math.round(timeLeftFrac(a, nowS) * 100)}%` }} /></div>
        <div class="muted small" id="ap-time" data-testid="approval-time">{expired ? "expired" : answered ? "Answer sent…" : a.state !== "pending" ? a.state : `${fmtClock(left)} left`}</div>
        <Preview tool={a.tool} text={a.preview} />
        {more > 0 && <div class="muted small">{more} more waiting</div>}
        <div class="approve">
          <button class="btn danger" data-testid="approval-deny" disabled={done} onClick={() => onAnswer(false)}>Deny</button>
          <button class="btn primary" data-testid="approval-allow" disabled={done} onClick={() => onAnswer(true)}>Allow</button>
        </div>
        <button class="btn" data-testid="approval-later" onClick={onMinimize}>Close for now</button>
      </div>
    </div>
  );
}

// ---------- Session view ----------
const PILL: Record<LinkState, string> = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", closed: "Closed", revoked: "Revoked" };
function ItemView({ it }: { it: Feed["items"][number] }) {
  switch (it.k) {
    case "user": return <div class="msg user" data-testid="dv-user">{it.text}</div>;
    case "text": return <div class="msg assistant pre" data-testid="dv-text">{it.text}</div>;
    case "tool": return (
      <details class={`tool${it.isError ? " error" : ""}`} data-testid="dv-tool">
        <summary><span class="tname">{it.name}</span> <span class="muted small ellip">{it.input.slice(0, 80)}</span>{it.output === undefined ? <span class="muted small"> · running</span> : null}</summary>
        <pre class="pre">{it.input}</pre>
        {it.output !== undefined && <pre class="pre">{it.output}</pre>}
      </details>
    );
    case "note": return <div class="muted small" data-testid="dv-note">{it.text}{it.n && it.n > 1 ? ` ×${it.n}${it.ts ? `, last at ${new Date(it.ts * (it.ts < 1e12 ? 1000 : 1)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}` : ""}</div>;
    case "error": return <div class="error" role="alert" data-testid="dv-error">{it.text}</div>;
  }
}

/** Where a new session starts: the folders the computer added with vcl (reported by its daemon) + an optional subfolder. Older vcl (roots unknown) keeps the plain text box. */
function DirPicker({ roots, root, setRoot, sub, setSub, dir, setDir, note }: { note: string; roots: DeviceRoot[] | undefined; root: string; setRoot: (v: string) => void; sub: string; setSub: (v: string) => void; dir: string; setDir: (v: string) => void }) {
  if (!roots) return <input class="dv-dir" data-testid="dv-dir" aria-label="Directory" value={dir} placeholder="Directory (blank = first root)" onInput={(e) => setDir(e.currentTarget.value)} />;
  if (roots.length === 0) return <p class="dv-noroots muted small" data-testid="dv-noroots" role="status">No folder added on this computer yet. Add one in vcl ui (Folders).</p>;
  const cur = roots.find((r) => r.path === root) ?? roots[0], bad = subfolderProblem(sub);
  return <div class="dv-pick" data-testid="dv-dir">
    <select class="dv-root" data-testid="dv-root" aria-label={`Folder: ${visiblePath(cur.path)}`} title={visiblePath(cur.path)} value={cur.path} onChange={(e) => setRoot(e.currentTarget.value)}>
      {roots.map((r) => <option key={r.path} value={r.path} title={visiblePath(r.path)}>{r.label === r.path ? shortPath(visiblePath(r.path)) : `${r.label} · ${shortPath(visiblePath(r.path))}`}</option>)}
    </select>
    <input class="dv-sub-in" data-testid="dv-subfolder" aria-label="Subfolder (optional)" aria-invalid={bad ? "true" : undefined} value={sub} placeholder="subfolder (optional)" autocapitalize="off" autocorrect="off" spellcheck={false} onInput={(e) => setSub(e.currentTarget.value)} />
    {note && <div class="dv-sub-note muted small" data-testid="dv-roots-note" role="status">{note}</div>}
    {bad && <div class="dv-sub-bad small" data-testid="dv-subfolder-hint" role="alert">{bad}</div>}
  </div>;
}

export function DeviceView({ id, WS, computers = false }: { id: string; WS?: typeof WebSocket; computers?: boolean }) {
  const [dev, setDev] = useState<Device | null | undefined>(undefined);
  const [feed, setFeed] = useState<Feed>(emptyFeed());
  const [link, setLink] = useState<LinkState>("connecting");
  const [text, setText] = useState(""), [dir, setDir] = useState(""), [root, setRoot] = useState(""), [sub, setSub] = useState(""), [rootsNote, setRootsNote] = useState("");
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [ask, setAsk] = useState(false);
  const modeSeen = useRef(computers);
  useEffect(() => { if (modeSeen.current === computers) return; modeSeen.current = computers; setTab(computers ? "terminal" : "session"); if (computers) setTermSeen(true); }, [computers]); // same device, other route (SPA nav): that route's default tab; the socket stays
  const termPend = useRef<Record<string, any> | null>(null); // term_state that arrived before the lazy terminal pane bound (a reloaded page)
  const [termOn, setTermOn] = useState(false), [termState, setTermState] = useState<ReturnType<typeof termStateOf>>(undefined), [termWhy, setTermWhy] = useState<string | undefined>(undefined), [tab, setTab] = useState<"session" | "terminal">(computers ? "terminal" : "session"), [termSeen, setTermSeen] = useState(computers), [helloed, setHelloed] = useState(false); // computers (comp1): opened from the Computers page: Terminal is the default tab and is always listed // termOn: the hub says this device can host a terminal (flag on + cap + online); fail closed
  const termBind = useRef<TermBind | null>(null);
  const skew = useRef(0), conn = useRef<Link | null>(null), seen = useRef(new Set<string>());
  const now = useTick(1000);
  const nowS = (now + skew.current) / 1000;
  // The device list is re-read while this screen is open (and on every hello): a daemon restarted with other folders changes `roots` without anything else on this screen changing.
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true, first = true;
    const load = () => void listDevices().then((r) => { if (!live) return; if (r.status === 200 || first) setDev(r.data?.devices.find((d) => d.id === id) ?? null); first = false; }).catch(() => { if (live && first) setDev(null); first = false; }); // a later failed poll keeps what is known; only the first read can say "not found"
    refresh.current = load; load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); refresh.current = () => {}; };
  }, [id]);
  const rootsKey = dev?.roots ? dev.roots.map((r) => r.path).join("\n") : null;
  useEffect(() => { // the chosen folder is gone after a daemon restart: fall back to the first one, drop its subfolder, and say so
    if (!dev?.roots?.length || !root || dev.roots.some((r) => r.path === root)) return;
    setRoot(""); setSub(""); setRootsNote(`The folder you picked is no longer available on this computer; using ${dev.roots[0].label}.`);
  }, [rootsKey]);
  useEffect(() => {
    if (!dev) return; // loading, or not found / revoked: no socket against a 404
    const l = openDeviceLink({
      id, WS, onState: setLink,
      onHello: (f) => { setHelloed(true); setTermOn(f.term === true); setTermState(termStateOf(f.termState)); setTermWhy(typeof f.termWhy === "string" ? f.termWhy : undefined); termBind.current?.onLinkLive(); refresh.current(); conn.current?.send({ t: "vis", hidden: document.visibilityState === "hidden" }); if (typeof f.now === "number") skew.current = f.now - Date.now(); setFeed((x) => ({ ...x, online: !!f.online, resynced: x.resynced || !!f.resync })); },
      onEvent: (seq, e, ts) => {
        setFeed((f) => { const n = foldEvent(f, seq, e, ts); if (e.type === "session_started") rememberInfo(id, { sandbox: n.sandbox, bash: n.bash }); return n; });
        if (e.type === "approval_request" && !seen.current.has(e.rid)) { seen.current.add(e.rid); shellNotifier()?.approval(id, e); if (document.visibilityState === "hidden") notifyApproval(String(e.tool), () => setHidden((h) => ({ ...h, [e.rid]: false }))); } // visible: the sheet/banner is the notice; a toast stacked over the sheet covered Deny/Allow for 12 s
        if (e.type === "approval_resolved") setAnswered((a) => { const { [e.rid]: _, ...rest } = a; return rest; });
      },
      onFrame: (f) => {
        if (typeof f.t === "string" && f.t.startsWith("term_")) { if (f.t === "term_caps") { setTermOn(f.on === true); setTermState(termStateOf(f.termState)); setTermWhy(typeof f.termWhy === "string" ? f.termWhy : undefined); } else if (f.t === "term_state" && !termBind.current) { termPend.current = f; setTermSeen(true); setTab("terminal"); } else termBind.current?.onFrame(f); return; }
        if (f.t === "err") {
          if (f.rid) setAnswered((a) => { const { [f.rid]: _, ...rest } = a; return rest; });
          if (f.cid) setFeed((x) => failTurn(x, f.cid, f.code === "queue_full" ? "The device has too many unanswered commands waiting; try again later." : `The hub refused it (${f.code}).`, Date.now() + skew.current));
          else errorToast(f.code === "expired" ? "That approval expired." : f.code === "already_resolved" ? "Already answered." : `Device error: ${f.code}`);
        }
        else if (f.t === "cmd_ack") setFeed((x) => ackTurn(x, f.cid, !!f.queued, Date.now() + skew.current, f.cseq)); // the status line says "offline, will run later" itself
      },
    });
    conn.current = l;
    // Tell the hub whether this tab is visible: a hidden tab does not count as watching, so an approval request is pushed to the phone instead.
    const vis = () => { l.send({ t: "vis", hidden: document.visibilityState === "hidden" }); };
    document.addEventListener("visibilitychange", vis);
    return () => { document.removeEventListener("visibilitychange", vis); l.stop(); conn.current = null; };
  }, [id, !!dev]);
  const gone = dev === null || link === "revoked";
  const pending = nextPending(feed, nowS);
  const waiting = feed.approvals.filter((a) => a.state === "pending" && !isExpired(a, nowS));
  const send = (f: Frame) => { const ok = conn.current?.send(f) ?? false; if (!ok) errorToast("Not connected: try again in a moment."); return ok; };
  const sendTurn = (frame: Frame): boolean => { // the one place a user message goes out: written to the socket => the status line starts at "Sending…"
    const cid = newCid();
    setFeed((f) => beginTurn(f, cid, frame, Date.now() + skew.current)); // tracked BEFORE the write: the hub's cmd_ack must always find its turn, however fast it answers
    if (send({ ...frame, cid })) return true;
    setFeed((f) => failTurn(f, cid, "The app could not reach the hub.", Date.now() + skew.current)); // keep the line and the frame: Retry stays available
    return false;
  };
  const start = () => {
    const prompt = text.trim(); if (!prompt) return;
    const picked = dev?.roots?.length ? joinDir((dev.roots.find((r) => r.path === root) ?? dev.roots[0]).path, sub) : dev?.roots ? "" : dir.trim();
    if (sendTurn({ t: "cmd", kind: "start", prompt, ...(picked ? { dir: picked } : {}) })) { setFeed((f) => ({ ...f, items: [...f.items, { k: "user", id: `u${Date.now()}`, text: prompt }] })); setText(""); }
  };
  const say = () => {
    const t = text.trim(); if (!t) return;
    if (sendTurn({ t: "cmd", kind: "say", text: t })) { setFeed((f) => ({ ...f, items: [...f.items, { k: "user", id: `u${Date.now()}`, text: t }] })); setText(""); }
  };
  const line = turnLine(feed.turn, nowS * 1000, dev?.name);
  const retried = useRef<string | null>(null); // synchronous guard: two activations before the re-render would both use this closure's turn
  const retry = () => { const t = feed.turn; if (!t?.frame || retried.current === t.cid) return; retried.current = t.cid; sendTurn(t.frame); }; // same text, new cid: the old command's dedupe is untouched
  const answer = (a: Approval, allow: boolean) => { if (answered[a.rid]) return; if (send({ t: "approval_res", rid: a.rid, allow })) setAnswered((m) => ({ ...m, [a.rid]: true })); };
  const stream = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null), geom = useRef({ sh: 0, ch: 0 });
  // Follow the tail only if the user was at the tail BEFORE this change: live scrollTop against the geometry we last settled on (no event-driven flag:
  // WebKit delivers scroll events late/coalesced, so a flag still says "following" after the user already scrolled up and a new event would yank them down).
  const settle = (el: HTMLElement) => { const was = geom.current; const follow = was.sh === 0 || was.sh - el.scrollTop - was.ch < 48; geom.current = { sh: el.scrollHeight, ch: el.clientHeight }; return follow; };
  const tail = (el: HTMLElement) => { if (settle(el)) { el.scrollTo({ top: el.scrollHeight, behavior: "instant" }); geom.current = { sh: el.scrollHeight, ch: el.clientHeight }; } };
  useEffect(() => { // the transcript box itself resizing (approval banner appears, keyboard, rotation) keeps a following view at the tail
    const el = stream.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => tail(el)); ro.observe(el); if (content.current) ro.observe(content.current); // content-only growth (a tool <details> opening, a non-last item replaced) must settle the geometry too, or a later event is judged against stale numbers
    return () => ro.disconnect();
  }, [gone]);
  useEffect(() => { const el = stream.current; if (el) tail(el); }, [feed.items.length, feed.items[feed.items.length - 1]]);
  const inTerm = (termOn || computers) && tab === "terminal";
  const back = computers ? "/computers" : listPath, pill = computers ? linkPill(link, helloed, !!feed.online) : null, gate = computers ? termGate({ helloed, termOn, online: !!feed.online, termState, termWhy }) : null;
  const sheet = pending && !hidden[pending.rid];
  return (
    <div class="shell chat dvs">
      <Bar title={dev?.name ?? (computers ? "Computer" : "Device")} onBack={() => go(back)}>
        {!gone && (pill ? <span class={`chip dv-pill cm-${pill.tone}`} data-testid="dv-conn" role="status">{pill.label}</span> : <span class={`chip dv-pill ${link}`} data-testid="dv-conn" role="status">{PILL[link]}</span>)}
      </Bar>
      {gone && <main class="empty" data-testid="dv-revoked"><h2>This device was revoked</h2><p class="muted">It was removed, or no longer exists. Pair it again from Devices to use it.</p><button class="btn" data-testid="dv-revoked-back" onClick={() => go(back)}>{computers ? "Back to Computers" : "Back to Devices"}</button></main>}
      {!gone && <>
        <div class="dv-sub muted small" data-testid="dv-sub">
          <span class={`chip dev-${feed.online ? "online" : "offline"}`} data-testid="dv-online">{feed.online ? "device online" : "device offline"}</span>
          {feed.online && quietMinutes(dev, now + skew.current) !== null && <span class="muted small" data-testid="dv-quiet" role="status"> {quietText(quietMinutes(dev, now + skew.current)!)}</span>}
          {!feed.online && feed.lastOnline !== undefined && <span data-testid="dv-last-online"> last online {fmtLastSeen(feed.lastOnline / 1000, now + skew.current)}</span>}
          {feed.sandbox !== undefined && <span> sandbox {feed.sandbox || "none"} · bash {feed.bash ? "on" : "off"}</span>}
          {pill?.reconnect && <button class="btn small primary" data-testid="cm-reconnect" onClick={() => conn.current?.reconnect()}>Reconnect</button>}
          <button class="btn small" data-testid="dv-disconnect" onClick={() => setAsk(true)} disabled={!feed.online}>Disconnect</button>
        </div>
        {(termOn || computers) && <div class="dv-tabs" role="tablist" data-testid="dv-tabs">
          {computers && <button class="dv-tab" role="tab" aria-selected={tab === "terminal"} data-testid="dv-tab-terminal" onClick={() => { setTab("terminal"); setTermSeen(true); }}>Terminal</button>}
          <button class="dv-tab" role="tab" aria-selected={tab === "session"} data-testid="dv-tab-session" onClick={() => setTab("session")}>{computers ? "Claude" : "Session"}</button>
          {!computers && <button class="dv-tab" role="tab" aria-selected={tab === "terminal"} data-testid="dv-tab-terminal" onClick={() => { setTab("terminal"); setTermSeen(true); }}>Terminal</button>}
          {computers && <button class="dv-tab" role="tab" aria-selected="false" aria-disabled="true" disabled data-testid="cm-tab-screen" title="Seeing the screen is coming later">Screen · soon</button>}
        </div>}
        {gate && inTerm && gate.kind !== "ready" && <section class="empty cm-gate" data-testid="cm-term-gate" data-kind={gate.kind} role="status">
          {gate.title && <h2>{gate.title}</h2>}<p class="muted">{gate.text}</p>
          {gate.fix && <p><code class="cm-fix" data-testid="cm-term-fix">{gate.fix}</code></p>}
        </section>}
        {termOn && termSeen && <TermPane active={tab === "terminal"} roots={dev?.roots} online={feed.online} linkLive={link === "live"} send={(f) => conn.current?.send(f) ?? false} bind={(b) => { termBind.current = b; if (b && termPend.current) { const p = termPend.current; termPend.current = null; b.onFrame(p); } }} />}
        <main hidden={inTerm} class="msgs feed" aria-live="polite" aria-relevant="additions" aria-label="Session events" data-testid="dv-stream" ref={stream}>
          <div class="dv-content" ref={content}>
          {feed.resynced && <div class="muted small" role="status" data-testid="dv-resync">Older history was pruned; the stream may be incomplete.</div>}
          {feed.items.length === 0 && <div class="muted small">No activity yet. Start a session below.</div>}
          {feed.items.map((it) => <ItemView key={it.id} it={it} />)}
          </div>
        </main>
        {line && !inTerm && <div class={`dv-status ${line.tone}`} role="status" aria-live="polite" data-testid="dv-status" data-state={line.state}>
          <span>{line.text}</span>
          {line.retry && feed.turn?.frame && <button class="btn small" data-testid="dv-status-retry" onClick={retry}>Retry</button>}
          {line.stop && <button class="btn small" data-testid="dv-status-stop" onClick={() => setFeed(dropTurn)}>{line.state === "failed" ? "Dismiss" : "Stop waiting"}</button>}
        </div>}
        {pending && !sheet && <button class="btn primary ap-banner" data-testid="approval-banner" onClick={() => setHidden((h) => ({ ...h, [pending.rid]: false }))}>Approval needed: {pending.tool} · Review</button>}
        <footer hidden={inTerm} class="composer actionbar dv-composer">
          {!feed.active && <DirPicker roots={dev?.roots} root={root} setRoot={(v) => { setRoot(v); setRootsNote(""); }} sub={sub} setSub={setSub} dir={dir} setDir={setDir} note={rootsNote} />}
          <textarea data-testid="dv-input" aria-label={feed.active ? "Message" : "Prompt"} rows={1} value={text} placeholder={feed.active ? "Follow-up…" : "What should Claude do?"} onInput={(e) => setText(e.currentTarget.value)} />
          {feed.active
            ? <><button class="btn primary" data-testid="dv-send" disabled={!text.trim()} onClick={say}>Send</button><button class="btn danger" data-testid="dv-stop" onClick={() => send({ t: "cmd", cid: newCid(), kind: "stop" })}>Stop</button></>
            : <button class="btn primary" data-testid="dv-start" disabled={!text.trim() || link !== "live" || dev?.roots?.length === 0 || !!(dev?.roots?.length && subfolderProblem(sub))} onClick={start}>Start</button>}
        </footer>
      </>}
      {sheet && pending && <ApprovalSheet a={pending} nowS={nowS} answered={!!answered[pending.rid]} more={waiting.length - 1 > 0 ? waiting.length - 1 : 0} onAnswer={(al) => answer(pending, al)} onMinimize={() => setHidden((h) => ({ ...h, [pending.rid]: true }))} />}
      {ask && <ConfirmSheet title="Disconnect this device?" body="The device is cut off from the app and will not reconnect until you start vcl on it again. It stays paired." confirmLabel="Disconnect" onConfirm={() => { setAsk(false); send({ t: "disconnect" }); }} onCancel={() => setAsk(false)} />}
    </div>
  );
}
