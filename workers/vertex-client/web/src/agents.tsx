import { withBusy } from "./busy";
import { IconBack, IconPlus } from "./icons";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type AgentDetail, type AgentRow, type AgentsConfig, addSchedule, agentAction, agentEvents, agentsConfig, cancelSchedule, createAgent, deleteAgent, getAgent, listAgents, sendToAgent, updateAgent } from "./agents-api";
import { type Feed, type Item, emptyFeed, fold } from "./cloud-events";
import { startAgentLive } from "./agents-live";
import { ConfirmSheet, useEscape } from "./confirm";
import { renderMarkdown } from "./markdown";
import { ListBar } from "./header";
import { errorToast } from "./toast";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const Md = ({ text }: { text: string }) => { const html = useMemo(() => renderMarkdown(text), [text]); return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />; };
const ago = (ms?: number | null) => { if (!ms) return "never"; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const last = (a: AgentRow) => a.lastActivity ?? (Math.max(a.lastDone ?? 0, a.lastWake ?? 0) || null);

/** Create (no `edit`) or edit an agent. */
function AgentSheet({ cfg, edit, onClose, onSaved }: { cfg: AgentsConfig; edit?: AgentRow; onClose: () => void; onSaved: (name: string) => void }) {
  useEscape(onClose);
  const [name, setName] = useState(edit?.name ?? cfg.namePrefix);
  const [repo, setRepo] = useState(edit?.repo ?? cfg.repos[0] ?? "");
  const [image, setImage] = useState(edit?.image ?? "base");
  const [executor, setExecutor] = useState(edit?.executor ?? "auto");
  const [base, setBase] = useState(edit?.base ?? (cfg.e2eBasePrefix ?? ""));
  const [instructions, setInstructions] = useState(edit?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const body = { repo, image, executor, base: base.trim(), instructions };
    const r = await withBusy("agent-save", () => (edit ? updateAgent(edit.name, body) : createAgent({ name: name.trim(), ...body, base: base.trim() || undefined })));
    setBusy(false);
    if (r.status < 300) { onSaved(edit?.name ?? name.trim()); onClose(); } else errorToast(r.data?.error ?? `Could not save (${r.status})`, () => void submit());
  };
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={edit ? "Edit agent" : "New agent"} data-testid="agent-sheet" onClick={(e) => e.stopPropagation()}>
        <h3 class="confirm-title">{edit ? `Edit ${edit.name}` : "New agent"}</h3>
        {!edit && <label class="fld">Name<input data-testid="agent-name" value={name} autoCapitalize="none" onInput={(e) => setName(e.currentTarget.value)} /></label>}
        <label class="fld">Repo<select data-testid="agent-repo" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>{cfg.repos.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
        <label class="fld">Image<select data-testid="agent-image" value={image} onChange={(e) => setImage(e.currentTarget.value)}>{cfg.images.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
        <label class="fld">Executor<select data-testid="agent-executor" value={executor} onChange={(e) => setExecutor(e.currentTarget.value)}>{cfg.executors.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
        <label class="fld">Base branch (optional)<input data-testid="agent-base" value={base} placeholder="default branch" onInput={(e) => setBase(e.currentTarget.value)} /></label>
        <label class="fld">Role / instructions<textarea data-testid="agent-instructions" rows={5} value={instructions} onInput={(e) => setInstructions(e.currentTarget.value)} /></label>
        <div class="approve">
          <button class="btn" onClick={onClose}>Cancel</button>
          <button class="btn primary" data-testid="agent-save" disabled={busy || !repo || (!edit && !name.trim())} onClick={() => void submit()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

export function AgentList({ onSettings }: { onSettings: () => void }) {
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [failed, setFailed] = useState(false);
  const [cfg, setCfg] = useState<AgentsConfig | null>(null);
  const [sheet, setSheet] = useState(false);
  const load = async () => {
    const r = await listAgents().catch(() => null);
    if (r && r.status === 200 && r.data) { setRows(r.data.agents); setEnabled(r.data.enabled); setFailed(false); } else setFailed(true);
  };
  useEffect(() => { void load(); void agentsConfig().then((r) => r.data && setCfg(r.data)).catch(() => null); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, []);
  return (
    <div class="shell">
      <ListBar mode="agents" title="Agents" onSettings={onSettings} />
      <main class="list-page">
        {!rows && !failed && <ul class="list" aria-busy="true">{[0, 1, 2].map((i) => <li key={i}><div class="skel row-skel" /></li>)}</ul>}
        {failed && !rows && <div class="empty state-panel" role="alert"><h2>Couldn't load agents</h2><p class="muted">Check your connection, then try again.</p><button class="btn" onClick={() => void load()}>Retry</button></div>}
        {!enabled && <div class="empty"><h2>Agents aren't configured</h2><p class="muted">agent-spike isn't bound to this deployment.</p></div>}
        {enabled && rows && rows.length === 0 && <div class="empty"><h2>No agents yet</h2><p class="muted">Create a named, persistent agent with the ＋ button.</p></div>}
        <ul class="list" data-testid="agent-list">
          {rows?.map((a) => (
            <li key={a.name}>
              <button class="row" data-testid="agent-row" onClick={() => go(`/a/${a.name}`)}>
                <strong class="ellip">{a.name}</strong>
                <span class="muted small"><span class={`st st-${a.state}`} data-testid="agent-state">{a.state}</span> · {a.repo.split("/")[1]} · {ago(last(a))}</span>
              </button>
            </li>
          ))}
        </ul>
      </main>
      {enabled && cfg && <button class="fab" data-testid="new-agent-fab" onClick={() => setSheet(true)} aria-label="New agent"><IconPlus /></button>}
      {sheet && cfg && <AgentSheet cfg={cfg} onClose={() => setSheet(false)} onSaved={(n) => go(`/a/${n}`)} />}
    </div>
  );
}

function ItemView({ it }: { it: Item }) {
  switch (it.t) {
    case "text": return <div class="msg assistant" data-testid="ev-text"><Md text={it.text} /></div>;
    case "tool": return (
      <details class={`tool${it.isError ? " error" : ""}`} data-testid="ev-tool">
        <summary><span class="tname">{it.name}</span> <span class="muted small ellip">{it.input.slice(0, 80)}</span></summary>
        <pre class="pre">{it.input}</pre>
        {it.output !== undefined && <pre class="pre">{it.output}</pre>}
      </details>
    );
    case "followup": return <div class="msg user" data-testid="ev-followup">{it.text}</div>;
    case "result": return <div class={`chip${it.isError ? " err" : ""}`} data-testid="ev-result">{it.isError ? "Failed" : "Done"}{it.turns ? ` · ${it.turns} turns` : ""}</div>;
    case "error": return <div class="error" data-testid="ev-error">{it.text}</div>;
    case "git": case "status": return <div class="muted small" data-testid="ev-status">{it.text}</div>;
  }
}

function Schedules({ name, list, reload }: { name: string; list: AgentDetail["schedules"]; reload: () => void }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"delaySecs" | "everySecs" | "cron">("delaySecs");
  const [val, setVal] = useState("3600");
  const add = async () => {
    const body = { text: text.trim(), ...(kind === "cron" ? { cron: val.trim() } : { [kind]: Number(val) }) };
    const r = await withBusy("agent-schedule-add", () => addSchedule(name, body));
    if (r.status < 300) { setText(""); reload(); } else errorToast(r.data?.error ?? `Could not schedule (${r.status})`);
  };
  return (
    <section class="card" data-testid="agent-schedules">
      <h3>Schedules</h3>
      {list.length === 0 && <p class="muted small" data-testid="sched-empty">No schedules.</p>}
      <ul class="list">
        {list.map((s) => (
          <li key={s.id} data-testid="sched-row">
            <div class="ellip">{s.text}</div>
            <div class="muted small">{s.cron ? `cron ${s.cron}` : s.everySecs ? `every ${s.everySecs}s` : "once"} · next {new Date(s.nextRun).toLocaleString()} · {s.runs} run(s)</div>
            <button class="btn" data-testid="sched-cancel" onClick={async () => { const r = await withBusy("agent-schedule-cancel", () => cancelSchedule(name, s.id)); if (r.status < 300) reload(); else errorToast(r.data?.error ?? `Cancel failed (${r.status})`); }}>Cancel</button>
          </li>
        ))}
      </ul>
      <label class="fld">Message<input data-testid="sched-text" value={text} onInput={(e) => setText(e.currentTarget.value)} /></label>
      <div class="tabs subtabs" role="radiogroup" aria-label="When">
        <button class={`tab${kind === "delaySecs" ? " on" : ""}`} data-testid="sched-kind-delay" onClick={() => { setKind("delaySecs"); setVal("3600"); }}>In…</button>
        <button class={`tab${kind === "everySecs" ? " on" : ""}`} data-testid="sched-kind-every" onClick={() => { setKind("everySecs"); setVal("3600"); }}>Every…</button>
        <button class={`tab${kind === "cron" ? " on" : ""}`} data-testid="sched-kind-cron" onClick={() => { setKind("cron"); setVal("0 9 * * *"); }}>Cron</button>
      </div>
      <label class="fld">{kind === "cron" ? "Cron (5 fields, UTC)" : "Seconds"}<input data-testid="sched-value" value={val} onInput={(e) => setVal(e.currentTarget.value)} /></label>
      <button class="btn primary" data-testid="sched-add" disabled={!text.trim() || !val.trim()} onClick={() => void add()}>Add schedule</button>
    </section>
  );
}

export function AgentView({ name }: { name: string }) {
  const [d, setD] = useState<AgentDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [feed, setFeed] = useState<Feed>(emptyFeed());
  const [text, setText] = useState("");
  const [panel, setPanel] = useState<"chat" | "schedules">("chat");
  const [ask, setAsk] = useState<null | "delete" | "rollover">(null);
  const [editing, setEditing] = useState(false);
  const [cfg, setCfg] = useState<AgentsConfig | null>(null);
  const stick = useRef(true), end = useRef<HTMLDivElement>(null), alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = async () => {
    const r = await getAgent(name).catch(() => null);
    if (!r || !alive.current) return;
    if (r.status === 404) setMissing(true); else if (r.data?.agent) setD(r.data);
  };
  useEffect(() => { void refresh(); void agentsConfig().then((r) => r.data && setCfg(r.data)).catch(() => null); const t = setInterval(() => void refresh(), 3000); return () => clearInterval(t); }, [name]);

  // One live stream for the agent's whole life: a session replaced by a rollover or wake continues on the same socket.
  useEffect(() => {
    setFeed(emptyFeed());
    const live = startAgentLive({
      name,
      onEvents: (evs) => { if (alive.current) setFeed((f) => fold(f, evs)); },
      page: async (after) => { const r = await agentEvents(name, after).catch(() => null); return r && r.data?.events ? { events: r.data.events, next: r.data.next } : r && r.status === 404 ? { events: [] } : null; },
      onProblem: (m) => { if (alive.current) setProblem(m); },
    });
    return () => live.stop();
  }, [name]);
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: "end" }); }, [feed.items.length, d?.inbox.length]);

  if (missing) return <div class="shell"><header class="bar"><button class="rbtn" aria-label="Back" title="Back" onClick={() => go("/agents")}><IconBack /></button></header><main class="empty"><h2>Agent not found</h2></main></div>;
  const a = d?.agent;
  const running = a?.state === "running";
  const act = async (x: "wake" | "sleep" | "rollover" | "stop") => {
    const r = await withBusy(`agent-${x}`, () => agentAction(name, x));
    if (r.status >= 300) errorToast(r.data?.error ?? `${x} failed (${r.status})`, x === "rollover" ? undefined : () => void act(x)); else void refresh(); // rollover starts a new context: not safe to repeat blindly
  };
  const send = async () => {
    const t = text.trim(); if (!t) return;
    const r = await withBusy("agent-send", () => sendToAgent(name, t));
    if (r.status >= 300) { errorToast(r.data?.error ?? `Send failed (${r.status})`, () => void send()); return; } // the text stays in the box: retry re-sends the same message
    setText(""); void refresh();
  };
  return (
    <div class="shell">
      <header class="bar">
        <button class="rbtn" aria-label="Back" title="Back" onClick={() => go("/agents")}><IconBack /></button>
        {!a ? <div class="title"><div class="skel line wide" /></div> : <>
          <h2 class="title ellip">{a.name}</h2>
          <span class="chip" data-testid="agent-state">{a.state}</span>
        </>}
      </header>
      <div class="tabs subtabs" role="tablist" aria-label="Agent sections">
        <button class={`tab${panel === "chat" ? " on" : ""}`} data-testid="panel-chat" onClick={() => setPanel("chat")}>Conversation</button>
        <button class={`tab${panel === "schedules" ? " on" : ""}`} data-testid="panel-schedules" onClick={() => setPanel("schedules")}>Schedules{d && d.schedules.length ? ` (${d.schedules.length})` : ""}</button>
      </div>
      {panel === "schedules" && d && <main class="page wide"><Schedules name={name} list={d.schedules} reload={() => void refresh()} /></main>}
      {panel === "chat" && <main class="msgs feed" data-testid="agent-stream" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {a && <div class="muted small">{a.repo}{a.base ? ` @ ${a.base}` : ""} · {a.image ?? "base"} · {a.executor ?? "auto"}</div>}
        {problem && <div class="error" role="status" data-testid="agent-problem">{problem}</div>}
        {d?.inbox.filter((m) => m.kind !== "handoff").map((m) => (
          <div key={m.id} data-testid="inbox-msg">
            <div class="msg user" data-testid="msg-text">{m.text ?? `(${m.from ?? "someone"})`}{m.from?.startsWith("schedule:") ? " ⏰" : ""}</div>
            {m.status === "done" && m.reply && <div class="msg assistant" data-testid="msg-reply"><Md text={m.reply} /></div>}
            {m.status === "failed" && <div class="error" data-testid="msg-error">{m.error ?? "failed"}</div>}
            {(m.status === "queued" || m.status === "running") && <div class="muted small" data-testid="msg-pending">{m.status}…</div>}
          </div>
        ))}
        {feed.items.length > 0 && <details class="tool" data-testid="agent-live" open={running}><summary>Live run ({feed.items.length} events)</summary>{feed.items.map((it) => <ItemView key={it.seq} it={it} />)}</details>}
        <div ref={end} />
      </main>}
      <footer class="composer actionbar">
        {a && <>
          {a.state === "sleeping" && <button class="btn" data-testid="agent-wake" onClick={() => void act("wake")}>Wake</button>}
          {a.state === "awake" && <button class="btn" data-testid="agent-sleep" onClick={() => void act("sleep")}>Sleep</button>}
          <button class="btn" data-testid="agent-rollover" onClick={() => setAsk("rollover")}>Rollover</button>
          <button class="btn" data-testid="agent-edit" onClick={() => setEditing(true)}>Edit</button>
          <button class="btn danger" data-testid="agent-delete" onClick={() => setAsk("delete")}>Delete</button>
        </>}
        <textarea data-testid="agent-input" rows={1} value={text} placeholder="Message this agent…" onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} aria-label="Message this agent" />
        <button class="btn primary" data-testid="agent-send" disabled={!text.trim()} onClick={() => void send()}>Send</button>
        {running && <button class="btn danger" data-testid="agent-stop" onClick={() => void act("stop")}>Stop</button>}
      </footer>
      {ask === "delete" && <ConfirmSheet title={`Delete ${name}?`} body="The agent, its inbox and schedules are removed." onConfirm={async () => { setAsk(null); const r = await withBusy("agent-delete", () => deleteAgent(name)); if (r.status < 300) go("/agents"); else errorToast(r.data?.error ?? `Delete failed (${r.status})`); }} onCancel={() => setAsk(null)} />}
      {ask === "rollover" && <ConfirmSheet title="Roll over this agent?" body="Its context is summarised into a handoff and a fresh session takes over." confirmLabel="Rollover" onConfirm={() => { setAsk(null); void act("rollover"); }} onCancel={() => setAsk(null)} />}
      {editing && a && cfg && <AgentSheet cfg={cfg} edit={a} onClose={() => setEditing(false)} onSaved={() => void refresh()} />}
    </div>
  );
}
