import { withBusy } from "./busy";
import { IconBack, IconPlus } from "./icons";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type RemoteCommand, type RemoteSessionDetail, type RemoteRow, approveCommand, createCommand, rejectCommand, remoteSession, remoteSessions, renewNonce } from "./remote-api";
import { errorToast, toast } from "./toast";
import { renderMarkdown } from "./markdown";
import { ListBar } from "./header";
import { splitRemoteRows } from "./remote-logic";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const POLL_MS = 10_000;
// Times from remote-hub are epoch seconds.
const ago = (s?: number | null) => { if (!s) return "never"; const d = Math.max(0, Math.round(Date.now() / 1000 - s)); return d < 60 ? `${d}s ago` : d < 3600 ? `${Math.round(d / 60)}m ago` : d < 86400 ? `${Math.round(d / 3600)}h ago` : `${Math.round(d / 86400)}d ago`; };
const dur = (a?: number | null, b?: number | null) => { if (!a) return ""; const d = Math.max(0, (b ?? Math.round(Date.now() / 1000)) - a); return d < 60 ? `${d}s` : d < 3600 ? `${Math.round(d / 60)}m` : `${(d / 3600).toFixed(1)}h`; };
const Md = ({ text }: { text: string }) => { const html = useMemo(() => renderMarkdown(text), [text]); return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />; };
const OPEN = ["pending", "approved", "running"];
const who = (c: RemoteCommand) => (c.state === "rejected" ? `cancelled by ${c.rejected_by ?? "?"}` : c.approved_by ? `sent by ${c.approved_by}` : `requested by ${c.requested_by}`);
const label = (s: { status: string; stale: boolean }) => (s.stale ? "stale" : s.status);
const Badge = ({ s }: { s: { status: string; stale: boolean } }) => <span class={`chip rstat ${label(s)}`} data-testid="remote-status">{label(s)}</span>;

export function RemoteList({ onSettings }: { onSettings: () => void }) {
  const [rows, setRows] = useState<RemoteRow[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [failed, setFailed] = useState(false);
  const [older, setOlder] = useState(false);
  const { shown, hidden } = splitRemoteRows(rows ?? [], older);
  const load = async () => {
    const r = await remoteSessions().catch(() => null);
    if (r && r.status === 200 && r.data) { setRows(r.data.sessions); setEnabled(r.data.enabled); setFailed(false); } else setFailed(true);
  };
  useEffect(() => { void load(); const t = setInterval(() => void load(), POLL_MS); return () => clearInterval(t); }, []);
  return (
    <div class="shell">
      <ListBar mode="remote" title="Remote sessions" onSettings={onSettings} />
      <main class="list-page">
        {!rows && !failed && <ul class="list" aria-busy="true">{[0, 1, 2].map((i) => <li key={i}><div class="skel row-skel" /></li>)}</ul>}
        {failed && !rows && <div class="empty state-panel" role="alert" data-testid="remote-error"><h2>Couldn't load remote sessions</h2><p class="muted">Check your connection, then try again.</p><button class="btn" onClick={() => void load()}>Retry</button></div>}
        {failed && rows && <p class="muted small" data-testid="remote-problem" role="status">Couldn't refresh — showing the last list. Retrying…</p>}
        {!enabled && <div class="empty"><h2>Remote isn't configured</h2><p class="muted">remote-hub isn't bound to this deployment.</p></div>}
        {enabled && rows && rows.length === 0 && <div class="empty" data-testid="remote-empty"><h2>No remote sessions</h2><p class="muted">Work sessions running on build-host show up here, read-only.</p></div>}
        <ul class="list" data-testid="remote-list">
          {shown.map((s) => (
            <li key={s.id}>
              <button class={`row${s.stale ? " dim" : ""}`} data-testid="remote-row" onClick={() => go(`/m/${encodeURIComponent(s.id)}`)}>
                <span class="rtop"><strong class="ellip" data-testid="remote-name">{s.name}</strong><Badge s={s} /></span>
                <span class="muted small ellip">{s.brief || "(no brief)"}</span>
                <span class="muted small">{s.kind} · {s.host} · {s.status === "running" ? `started ${ago(s.started_at)}` : `ended ${ago(s.ended_at ?? s.updated_at)}`}</span>
              </button>
            </li>
          ))}
        </ul>
        {hidden > 0 && <button class="btn older-btn" data-testid="remote-older" onClick={() => setOlder(true)}>Show older ({hidden})</button>}
      </main>
    </div>
  );
}

export function RemoteView({ id }: { id: string }) {
  const [d, setD] = useState<RemoteSessionDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState("");
  const tailRef = useRef<HTMLPreElement>(null);
  const load = async () => {
    const r = await remoteSession(id).catch(() => null);
    if (r && r.status === 200 && r.data) { setD(r.data); setProblem(""); }
    else if (r && r.status === 404) setMissing(true);
    else setProblem(r ? `Couldn't refresh (${r.status}). Retrying…` : "Couldn't refresh (offline?). Retrying…");
  };
  useEffect(() => { void load(); }, [id]);
  const running = d?.status === "running" && !d.stale; // live view polls only while it can still change
  const open = !!d?.commands?.some((c) => OPEN.includes(c.state));
  // poll while the session can still change, and faster while a follow-up is in flight so its status/result shows up promptly
  useEffect(() => { if (d && !running && !open) return; const t = setInterval(() => void load(), open ? 3000 : POLL_MS); return () => clearInterval(t); }, [id, running, open, !d]);
  useEffect(() => { const el = tailRef.current; if (el) el.scrollTop = el.scrollHeight; }, [d?.tail]);
  const back = () => go("/remote");
  if (missing) return (
    <div class="shell"><header class="bar"><button class="rbtn" aria-label="Back" title="Back" onClick={back}><IconBack /></button><h2 class="title">Remote</h2></header>
      <main class="page"><div class="empty" data-testid="remote-missing"><h2>Session not found</h2><p class="muted">It may have aged out of the hub.</p><button class="btn" onClick={back}>Back to sessions</button></div></main></div>
  );
  return (
    <div class="shell">
      <header class="bar"><button class="rbtn" aria-label="Back" title="Back" data-testid="remote-back" onClick={back}><IconBack /></button><h2 class="title ellip">{d?.name ?? "Remote"}</h2>{d && <Badge s={d} />}</header>
      <main class="page wide remote-detail" data-testid="remote-detail">
        {!d && !problem && <div aria-busy="true"><div class="skel block" /><div class="skel block" /></div>}
        {problem && <p class="muted small" data-testid="remote-problem" role="status">{problem}</p>}
        {d && <>
          <section class="card">
            <p class="muted small" data-testid="remote-meta">{d.kind} · {d.host} · {d.status === "running" ? `running for ${dur(d.started_at)}` : `took ${dur(d.started_at, d.ended_at)}${d.exit_code !== null ? ` · exit ${d.exit_code}` : ""}`} · updated {ago(d.updated_at)}</p>
            {d.cwd && <p class="muted small ellip" data-testid="remote-cwd">{d.cwd}</p>}
            {d.stale && <p class="error" data-testid="remote-stale">No update from the host for a while — this may be out of date.</p>}
            <p class="muted small" data-testid="remote-note">Viewing is read-only. A follow-up is only sent after you confirm it on a separate screen.</p>
          </section>
          <section class="card"><h3>Brief</h3><pre class="pre" data-testid="remote-brief">{d.brief || "(none)"}</pre></section>
          <section class="card tail-card"><h3>Live transcript{running ? " · updating" : ""}</h3>
            {d.tail ? <pre class="pre tail" ref={tailRef} tabIndex={0} aria-label="Live transcript" data-testid="remote-tail">{d.tail}</pre> : <p class="muted small" data-testid="remote-tail-empty">No activity captured yet.</p>}
          </section>
          <FollowUp d={d} open={open} onChanged={() => void load()} />
          {d.commands && d.commands.length > 0 && <CommandLog cmds={d.commands} />}
          {d.report && <section class="card"><h3>Report</h3><div data-testid="remote-report"><Md text={d.report} /></div></section>}
        </>}
      </main>
    </div>
  );
}

function CommandLog({ cmds }: { cmds: RemoteCommand[] }) {
  return (
    <section class="card" data-testid="remote-commands"><h3>Follow-ups</h3>
      <ul class="list">
        {cmds.map((c) => (
          <li key={c.id} data-testid="cmd-row">
            <div class="rtop"><span class="muted small">{ago(c.created_at)} · {who(c)}</span><span class={`chip rstat cmd-${c.state}`} data-testid="cmd-state">{c.state}</span></div>
            <pre class="pre" data-testid="cmd-text">{c.text}</pre>
            {c.result_summary && <p class={`small ${c.state === "done" ? "muted" : "error"}`} data-testid="cmd-result">{c.result_summary}{c.exit_code != null ? ` (exit ${c.exit_code})` : ""}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Why a follow-up cannot be composed right now (null = it can). */
function blockedReason(d: RemoteSessionDetail, open: boolean): string | null {
  if (d.kind !== "lane2") return "Only lane2 sessions can receive follow-ups.";
  if (d.status === "running") return "This session is running — a follow-up can only be sent once it is idle.";
  if (open) return "A follow-up is already in flight for this session.";
  return null;
}

type Step = { k: "closed" } | { k: "compose" } | { k: "confirm"; cmd: RemoteCommand; nonce: string; expired: boolean };
function FollowUp({ d, open, onChanged }: { d: RemoteSessionDetail; open: boolean; onChanged: () => void }) {
  const [step, setStep] = useState<Step>({ k: "closed" });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const why = blockedReason(d, open);
  const bytes = new TextEncoder().encode(text).length;
  const review = async () => {
    setBusy(true); setErr("");
    const r = await withBusy("remote-create", () => createCommand(d.id, text)).catch(() => null);
    setBusy(false);
    if (r && r.status === 201 && r.data) setStep({ k: "confirm", cmd: r.data.command, nonce: r.data.nonce, expired: false });
    else setErr(r?.data?.error ?? "Couldn't reach the server.");
  };
  const cancel = async () => { // leaving the confirm screen cancels the pending command, so it never lingers and blocks the session
    if (step.k === "confirm") { await withBusy("remote-reject", () => rejectCommand(step.cmd.id)).catch(() => null); onChanged(); }
    setStep({ k: "closed" }); setErr("");
  };
  const send = async () => {
    if (step.k !== "confirm") return;
    setBusy(true); setErr("");
    const r = await withBusy("remote-approve", () => approveCommand(step.cmd.id, step.nonce)).catch(() => null);
    setBusy(false);
    if (r && r.status === 200) { toast("Follow-up sent."); setStep({ k: "closed" }); setText(""); onChanged(); }
    else if (r && r.status === 403) { setStep({ ...step, expired: true }); setErr("This confirmation expired. Refresh it and tap Send again."); }
    else { setErr(r?.data?.error ?? "Couldn't reach the server."); if (r && r.status === 409) onChanged(); }
  };
  const refresh = async () => {
    if (step.k !== "confirm") return;
    setBusy(true); const r = await withBusy("remote-renew", () => renewNonce(step.cmd.id)).catch(() => null); setBusy(false);
    if (r && r.status === 200 && r.data) { setStep({ ...step, nonce: r.data.nonce, expired: false }); setErr(""); } else errorToast(r?.data?.error ?? "Couldn't refresh the confirmation", () => void refresh());
  };
  return (
    <section class="card" data-testid="remote-followup">
      <h3>Follow-up</h3>
      {why && <p class="muted small" data-testid="followup-blocked">{why}</p>}
      <button class="btn" data-testid="followup-open" disabled={!!why} onClick={() => { setStep({ k: "compose" }); setErr(""); }}>Send follow-up</button>
      {step.k === "compose" && (
        <div data-testid="followup-compose">
          <label class="fld">Message for {d.name}<textarea data-testid="followup-text" rows={4} value={text} onInput={(e) => setText(e.currentTarget.value)} /></label>
          <p class="muted small">{bytes} / 4096 bytes. Nothing is sent yet — you'll review it first.</p>
          {err && <p class="error" data-testid="followup-error" role="alert">{err}</p>}
          <div class="approve"><button class="btn" data-testid="followup-discard" onClick={() => { setStep({ k: "closed" }); setErr(""); }}>Discard</button>
            <button class="btn primary" data-testid="followup-review" disabled={busy || !text.trim() || bytes > 4096} onClick={() => void review()}>{busy ? "Preparing…" : "Review"}</button></div>
        </div>
      )}
      {step.k === "confirm" && (
        <div class="scrim" onClick={() => void cancel()}>
          <div class="sheet" role="dialog" aria-modal="true" aria-label="Confirm follow-up" data-testid="followup-confirm" onClick={(e) => e.stopPropagation()}>
            <h3 class="confirm-title">Send this follow-up?</h3>
            <p class="muted small">Target session</p><p data-testid="confirm-target"><strong>{d.name}</strong></p>
            <p class="muted small">Working directory</p><p class="ellip" data-testid="confirm-cwd">{d.cwd || "(unknown)"}</p>
            <p class="muted small">Exact text</p><pre class="pre" data-testid="confirm-text">{step.cmd.text}</pre>
            {err && <p class="error" data-testid="followup-error" role="alert">{err}</p>}
            <div class="approve">
              <button class="btn" data-testid="confirm-cancel" disabled={busy} onClick={() => void cancel()}>Cancel</button>
              {step.expired
                ? <button class="btn primary" data-testid="confirm-refresh" disabled={busy} onClick={() => void refresh()}>Refresh confirmation</button>
                : <button class="btn primary" data-testid="confirm-send" disabled={busy} onClick={() => void send()}>Send to {d.name}</button>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
