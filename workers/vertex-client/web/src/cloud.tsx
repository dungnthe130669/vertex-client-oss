import { withBusy } from "./busy";
import { IconBack, IconPlus } from "./icons";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Card, type CloudConfig, type CloudRun, type RunDetail, cloudConfig, getRun, listRuns, openPr, runAction, runEvents, startRun } from "./cloud-api";
import { type Feed, type Item, type NetGroup, emptyFeed, fold, groupNet } from "./cloud-events";
import { startLive } from "./cloud-ws";
import { fmtTokens } from "./chat-state";
import { ConfirmSheet, useEscape } from "./confirm";
import { renderMarkdown } from "./markdown";
import { ListBar } from "./header";
import { errorToast } from "./toast";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const DONE = new Set(["finished", "failed", "stopped", "closed"]);
const Md = ({ text }: { text: string }) => { const html = useMemo(() => renderMarkdown(text), [text]); return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />; };
const stateOf = (d: RunDetail | null, r: CloudRun): string => {
  const s = d?.state as { status?: string; rec?: { status?: string } } | null;
  return s?.status ?? s?.rec?.status ?? r.status;
};

/** ONE display string per run: `live` is a stats OBJECT from agent-spike (uptimeSecs, instance, note…), only a string `live` is a state; else the D1 `status`. Sanitised to [a-z-] so it is safe as a CSS class. */
export const runState = (r: { live?: unknown; status?: unknown }): string => {
  const raw = typeof r.live === "string" && r.live ? r.live : typeof r.status === "string" ? r.status : "";
  return raw.toLowerCase().replace(/[^a-z-]/g, "");
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Card tokens: the server sends {input, output, cacheRead, cacheWrite}; a bare number is tolerated, anything else yields null (line omitted). */
export function tokensLabel(t: unknown): string | null {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  if (typeof t === "number") return t > 0 ? `${fmtTokens(t)} tokens` : null;
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  const inp = n(o.input) + n(o.cacheRead) + n(o.cacheWrite), out = n(o.output);
  return inp + out > 0 ? `${fmtTokens(inp)} in / ${fmtTokens(out)} out tokens` : null;
}
/** "just now" / "5m ago" / "3h ago" / "2d ago" / date; input is the D1 "YYYY-MM-DD HH:MM:SS" UTC string. */
export function relDate(s: string, now = Date.now()): string {
  const t = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  if (!Number.isFinite(t)) return "";
  const m = Math.floor((now - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  if (m < 43200) return `${Math.floor(m / 1440)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

function NewRun({ cfg, onClose }: { cfg: CloudConfig; onClose: () => void }) {
  useEscape(onClose);
  const [repo, setRepo] = useState(cfg.repos[0] ?? "");
  const [kind, setKind] = useState<"task" | "session">("task");
  const [executor, setExecutor] = useState("auto");
  const [base, setBase] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await withBusy("run-start", () => startRun({ kind, repo, instruction: text.trim(), executor, ...(base.trim() ? { base: base.trim() } : {}) }));
    setBusy(false);
    if (r.status === 201 && r.data?.id) { if (r.data.warning) errorToast(r.data.warning); onClose(); go(`/r/${r.data.id}`); }
    else errorToast(r.data?.error ?? `Could not start (${r.status})`);
  };
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="New cloud run" data-testid="new-run" onClick={(e) => e.stopPropagation()}>
        <h3 class="confirm-title">New cloud run</h3>
        <label class="fld">Repo<select data-testid="run-repo" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>{cfg.repos.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
        <div class="tabs" role="radiogroup" aria-label="Kind">
          <button class={`tab${kind === "task" ? " on" : ""}`} data-testid="kind-task" onClick={() => setKind("task")}>Task</button>
          <button class={`tab${kind === "session" ? " on" : ""}`} data-testid="kind-session" onClick={() => setKind("session")}>Session</button>
        </div>
        <label class="fld">Executor<select data-testid="run-executor" value={executor} onChange={(e) => setExecutor(e.currentTarget.value)}>{cfg.executors.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
        <label class="fld">Base branch (optional)<input data-testid="run-base" value={base} placeholder="default branch" onInput={(e) => setBase(e.currentTarget.value)} /></label>
        <label class="fld">Instruction<textarea data-testid="run-instruction" rows={4} value={text} onInput={(e) => setText(e.currentTarget.value)} /></label>
        <div class="approve">
          <button class="btn" onClick={onClose}>Cancel</button>
          <button class="btn primary" data-testid="run-start" disabled={busy || !text.trim() || !repo} onClick={() => void submit()}>{busy ? "Starting…" : "Start"}</button>
        </div>
      </div>
    </div>
  );
}

export function CloudList({ onSettings }: { onSettings: () => void }) {
  const [rows, setRows] = useState<CloudRun[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [failed, setFailed] = useState(false);
  const [cfg, setCfg] = useState<CloudConfig | null>(null);
  const [sheet, setSheet] = useState(false);
  const load = async () => {
    const r = await listRuns();
    if (r.status === 200 && r.data) { setRows(r.data.runs); setEnabled(r.data.enabled); setFailed(false); } else setFailed(true);
  };
  useEffect(() => { void load(); void cloudConfig().then((r) => r.data && setCfg(r.data)).catch(() => {}); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, []);
  return (
    <div class="shell">
      <ListBar mode="cloud" title="Cloud runs" onSettings={onSettings} />
      <main class="list-page">
        {!rows && !failed && <ul class="list" aria-busy="true">{[0, 1, 2].map((i) => <li key={i}><div class="skel row-skel" /></li>)}</ul>}
        {failed && !rows && <div class="empty state-panel" role="alert"><h2>Couldn't load runs</h2><p class="muted">Check your connection, then try again.</p><button class="btn" onClick={() => void load()}>Retry</button></div>}
        {!enabled && <div class="empty"><h2>Cloud mode isn't configured</h2><p class="muted">agent-spike isn't bound to this deployment.</p></div>}
        {enabled && rows && rows.length === 0 && <div class="empty"><h2>No cloud runs yet</h2><p class="muted">Start a task on a repo with the ＋ button.</p></div>}
        <ul class="list" data-testid="run-list">
          {rows?.map((r) => (
            <li key={r.id}>
              <button class="row" data-testid="run-row" onClick={() => go(`/r/${r.id}`)}>
                <strong class="clamp2" data-testid="run-title">{r.title || r.id}</strong>
                <span class="muted small run-meta">
                  <span class={`st st-${runState(r)}`} data-testid="run-status">{runState(r)}</span>
                  {[r.kind, r.repo.split("/")[1], r.executor, relDate(r.created_at)].filter(Boolean).map((x, i) => <span key={i}> · {x}</span>)}
                  {r.pr_number ? <span class="pr-badge" data-testid="run-pr"> PR #{r.pr_number}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </main>
      {enabled && cfg && <button class="fab" data-testid="new-run-fab" onClick={() => setSheet(true)} aria-label="New cloud run"><IconPlus /></button>}
      {sheet && cfg && <NewRun cfg={cfg} onClose={() => { setSheet(false); void load(); }} />}
    </div>
  );
}

function NetRow({ g }: { g: NetGroup }) {
  return (
    <details class="net muted small" data-testid="ev-net">
      <summary>{plural(g.items.length, "network event")}</summary>
      {g.items.map((it) => <div key={it.seq}>{(it as { text: string }).text}</div>)}
    </details>
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
    case "result": return <div class={`chip${it.isError ? " err" : ""}`} data-testid="ev-result">{it.isError ? "Failed" : "Done"}{it.turns ? ` · ${plural(it.turns, "turn")}` : ""}</div>;
    case "error": return <div class="error" data-testid="ev-error">{it.text}</div>;
    case "git": case "status": return <div class="muted small" data-testid="ev-status">{it.text}</div>;
  }
}

/** "Open PR (draft)": only for a pushed branch with no PR yet; the server is idempotent, so a retry after an error is safe. */
export function OpenPrButton({ id, pushed, pr, onOpened }: { id: string; pushed: boolean; pr?: { number: number; url: string } | null; onOpened?: () => void }) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<{ number: number; url: string } | null>(null);
  const done = made ?? pr ?? null;
  if (done) return <a class="pr-link" href={done.url} target="_blank" rel="noopener noreferrer" data-testid="card-pr">Pull request #{done.number}</a>;
  if (!pushed) return null;
  const click = async () => {
    setPending(true); setErr(null);
    const r = await withBusy("run-pr", () => openPr(id)).catch(() => null);
    setPending(false);
    if (r && r.status < 300 && r.data?.url) { setMade({ number: r.data.number, url: r.data.url }); onOpened?.(); }
    else setErr(r?.data?.error ?? "Could not open the pull request");
  };
  return (
    <div class="pr-open">
      <button class="btn" data-testid="card-open-pr" disabled={pending} aria-busy={pending} aria-label="Open pull request as draft" onClick={() => void click()}>{pending ? "Opening…" : "Open PR (draft)"}</button>
      {err && <p class="error" role="alert" data-testid="card-pr-error">{err}</p>}
    </div>
  );
}

function ResultCard({ card, id, turns, pr, onOpened }: { card: Card; id: string; turns?: number; pr?: { number: number; url: string } | null; onOpened?: () => void }) {
  return (
    <section class="card" data-testid="result-card">
      <h3>Result{card.partial ? " (partial)" : ""}</h3>
      <div><span class="muted small">Branch </span><code data-testid="card-branch">{card.branch}</code>{card.pushed ? "" : " (not pushed)"}</div>
      {card.compareUrl && <a href={card.compareUrl} target="_blank" rel="noopener noreferrer" data-testid="card-compare">Compare on GitHub</a>}
      {card.prUrl && !pr ? <a href={card.prUrl} target="_blank" rel="noopener noreferrer">Pull request</a> : <OpenPrButton id={id} pushed={card.pushed} pr={pr} onOpened={onOpened} />}
      <div class="muted small" data-testid="card-files">{card.files.length} file(s) changed{card.diffStat ? ` · ${card.diffStat.trim().split("\n").pop()}` : ""}</div>
      <ul class="list">{card.files.map((f) => <li key={f.path}><code class="small">{f.status} {f.path} +{f.add}/-{f.del}</code></li>)}</ul>
      <div class="muted small" data-testid="card-cost">{[tokensLabel(card.tokens), card.wallSecs !== undefined ? `${card.wallSecs}s wall` : "", (turns ?? card.turns) ? plural((turns ?? card.turns)!, "turn") : ""].filter(Boolean).join(" · ") || "no token count"}</div>
      {card.error && <p class="error">{card.error}</p>}
    </section>
  );
}

export function RunView({ id }: { id: string }) {
  const [d, setD] = useState<RunDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [feed, setFeed] = useState<Feed>(emptyFeed());
  const [text, setText] = useState("");
  const [ask, setAsk] = useState(false);
  const last = useRef(-1);
  const stick = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Responses can arrive out of order (WS frame + poll ticks overlap): only the newest request may update state, otherwise a stale
  // "no card yet" reply landing last hides the result card.
  const reqSeq = useRef(0), applied = useRef(0), doneCard = useRef(false);
  const refresh = async () => {
    const my = ++reqSeq.current;
    const r = await getRun(id).catch(() => null);
    if (!r || !alive.current || my < applied.current) return;
    applied.current = my;
    if (r.status === 404) setMissing(true);
    else if (r.data) { setD(r.data); const st = r.data.run ? stateOf(r.data, r.data.run) : ""; doneCard.current = r.data.run?.kind !== "task" ? DONE.has(st) : !!r.data.card || st === "closed"; }
  };
  // State must not depend on the live transport: a WebSocket that stays open but silent after the last event (seen on WebKit) gives
  // no further ticks, so keep refreshing run state on its own timer until the run is finished and its card has been received.
  useEffect(() => { const t = setInterval(() => { if (!doneCard.current) void refresh().catch(() => null); }, 3000); return () => clearInterval(t); }, [id]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const live = startLive({
      id, getAfter: () => last.current,
      onEvents: (evs) => { if (alive.current) setFeed((f) => { const n = fold(f, evs); last.current = n.last; return n; }); },
      onTick: () => { void refresh().catch(() => null); },
      poll: async (after) => { const r = await runEvents(id, after).catch(() => null); return r && r.data?.events ? { events: r.data.events } : r && r.status === 404 ? { events: [] } : null; },
      onProblem: (m) => { if (alive.current) setProblem(m); },
    });
    return () => live.stop();
  }, [id]);
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: "end" }); }, [feed.items.length]);

  if (missing) return <div class="shell"><header class="bar"><button class="rbtn" aria-label="Back" title="Back" onClick={() => go("/cloud")}><IconBack /></button></header><main class="empty"><h2>Run not found</h2></main></div>;
  const run = d?.run;
  const lastTurns = [...feed.items].reverse().find((x): x is Extract<Item, { t: "result" }> => x.t === "result" && !!x.turns)?.turns;
  const status = run ? stateOf(d, run) : "";
  const isSession = run?.kind === "session";
  const running = status === "running" || status === "starting";
  const finished = !isSession && DONE.has(status);
  const act = async (a: "message" | "stop" | "tasks" | "sleep" | "wake" | "close", body?: unknown) => {
    const r = await withBusy(`run-${a}`, () => runAction(id, a, body));
    if (r.status >= 300) errorToast(r.data?.error ?? `${a} failed (${r.status})`, a === "message" ? undefined : () => void act(a, body)); else void refresh();
    return r.status < 300;
  };
  const send = async () => {
    const t = text.trim(); if (!t) return;
    const ok = await act(isSession && !running ? "tasks" : "message", isSession && !running ? { instruction: t } : { text: t });
    if (ok) setText("");
  };
  return (
    <div class="shell">
      <header class="bar">
        <button class="rbtn" aria-label="Back" title="Back" onClick={() => go("/cloud")}><IconBack /></button>
        {!run ? <div class="title"><div class="skel line wide" data-testid="run-skel" /></div> : <>
          <h2 class="title clamp2" aria-label={run.title || run.id} title={run.title || run.id} data-testid="run-title">{run.title || run.id}</h2>
          <span class="chip" data-testid="run-state">{status}</span>
        </>}
      </header>
      <main class="msgs feed" data-testid="run-stream" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {run && <div class="muted small">{run.repo} · {run.executor}{d?.state && (d.state as { executor?: string }).executor ? ` (${(d.state as { executor?: string }).executor})` : ""}{run.branch ? ` · ${run.branch}` : ""}</div>}
        {d?.error && <div class="error">{d.error}</div>}
        {problem && <div class="error" role="status" data-testid="run-problem">{problem}</div>}
        {groupNet(feed.items).map((it) => it.t === "net" ? <NetRow key={`n${it.seq}`} g={it} /> : <ItemView key={it.seq} it={it} />)}
        {isSession && status === "idle" && d?.card?.pushed && <div class="muted small" role="status" data-testid="run-idle-note">Idle: branch pushed, session still open. Close it when you are done.</div>}
        {d?.card && <ResultCard card={d.card} id={id} turns={lastTurns} pr={run?.pr_number && run.pr_url ? { number: run.pr_number, url: run.pr_url } : null} onOpened={() => void refresh()} />}
        <div ref={end} />
      </main>
      <footer class="composer actionbar">
        {isSession && run && <>
          {status === "sleeping" && <button class="btn" data-testid="run-wake" onClick={() => void act("wake")}>Wake</button>}
          {status === "idle" && <button class="btn" data-testid="run-sleep" onClick={() => void act("sleep")}>Sleep</button>}
          {status !== "closed" && <button class="btn" data-testid="run-close" onClick={() => setAsk(true)}>Close</button>}
        </>}
        {!finished && status !== "closed" && <textarea data-testid="run-input" rows={1} value={text} placeholder={running ? "Follow-up while it works…" : "Next task…"} onInput={(e) => setText(e.currentTarget.value)} />}
        {!finished && status !== "closed" && <button class="btn primary" data-testid="run-send" disabled={!text.trim()} onClick={() => void send()}>Send</button>}
        {running && <button class="btn danger" data-testid="run-stop" onClick={() => void act("stop")}>Stop</button>}
      </footer>
      {ask && <ConfirmSheet title="Close this session?" body="The sandbox is discarded; pushed branches stay." confirmLabel="Close" onConfirm={() => { setAsk(false); void act("close"); }} onCancel={() => setAsk(false)} />}
    </div>
  );
}
