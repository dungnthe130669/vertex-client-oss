import { withBusy } from "./busy";
import { IconBack, IconPlus } from "./icons";
import { useEffect, useRef, useState } from "preact/hooks";
import { type DesktopDetail, type DesktopRun, desktopControl, desktopEvents, desktopStop, getDesktop, listDesktop, startDesktop } from "./desktop-api";
import { type DFeed, emptyDFeed, foldDesktop } from "./desktop-events";
import { startLive } from "./cloud-ws";
import { useEscape } from "./confirm";
import { ListBar } from "./header";
import { errorToast } from "./toast";
import { SPECIAL, chord, keysymOf, typeText } from "./vnc-keys";
import { withSpaceQuery } from "./space";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const DONE = new Set(["finished", "failed", "stopped"]);

function NewDesktop({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await withBusy("desktop-start", () => startDesktop({ instruction: text.trim(), ...(url.trim() ? { startUrl: url.trim() } : {}) }));
    setBusy(false);
    if (r.status === 201 && r.data?.id) { onClose(); go(`/d/${r.data.id}`); } else errorToast(r.data?.error ?? `Could not start (${r.status})`);
  };
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="New desktop task" data-testid="new-desktop" onClick={(e) => e.stopPropagation()}>
        <h3 class="confirm-title">New desktop task</h3>
        <label class="fld">Start URL (optional)<input data-testid="desk-url" type="url" inputMode="url" autocapitalize="off" value={url} placeholder="https://example.com" onInput={(e) => setUrl(e.currentTarget.value)} /></label>
        <label class="fld">Instruction<textarea data-testid="desk-instruction" rows={4} value={text} onInput={(e) => setText(e.currentTarget.value)} /></label>
        <div class="approve">
          <button class="btn" onClick={onClose}>Cancel</button>
          <button class="btn primary" data-testid="desk-start" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? "Starting…" : "Start"}</button>
        </div>
      </div>
    </div>
  );
}

export function DesktopList({ onSettings }: { onSettings: () => void }) {
  const [rows, setRows] = useState<DesktopRun[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [failed, setFailed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const load = async () => { const r = await listDesktop(); if (r.status === 200 && r.data) { setRows(r.data.runs); setEnabled(r.data.enabled); setFailed(false); } else setFailed(true); };
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, []);
  return (
    <div class="shell">
      <ListBar mode="desktop" title="Desktop tasks" onSettings={onSettings} />
      <main class="list-page">
        {!rows && !failed && <ul class="list" aria-busy="true">{[0, 1, 2].map((i) => <li key={i}><div class="skel row-skel" /></li>)}</ul>}
        {failed && !rows && <div class="empty state-panel" role="alert"><h2>Couldn't load tasks</h2><p class="muted">Check your connection, then try again.</p><button class="btn" onClick={() => void load()}>Retry</button></div>}
        {!enabled && <div class="empty"><h2>Desktop mode isn't configured</h2><p class="muted">agent-spike isn't bound to this deployment.</p></div>}
        {enabled && rows && rows.length === 0 && <div class="empty"><h2>No desktop tasks yet</h2><p class="muted">An agent drives a real browser on a remote desktop; you can take over at any time.</p></div>}
        <ul class="list" data-testid="desk-list">
          {rows?.map((r) => (
            <li key={r.id}><button class="row" data-testid="desk-row" onClick={() => go(`/d/${r.id}`)}>
              <strong class="ellip">{r.title || r.id}</strong>
              <span class="muted small"><span class={`st st-${r.status}`} data-testid="desk-status">{r.status}</span></span>
            </button></li>
          ))}
        </ul>
      </main>
      {enabled && <button class="fab" data-testid="new-desktop-fab" onClick={() => setSheet(true)} aria-label="New desktop task"><IconPlus /></button>}
      {sheet && <NewDesktop onClose={() => { setSheet(false); void load(); }} />}
    </div>
  );
}

/** Embedded noVNC through /api/desktop/runs/:id/vnc/websockify. Touch -> mouse is noVNC's own gesture layer; typing on a phone goes through
 *  a real (visually hidden, 16px so iOS does not zoom) textarea, since iOS only raises its keyboard for a focused text field. */
function VncPane({ id, onDrop }: { id: string; onDrop: (why: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const kb = useRef<HTMLTextAreaElement>(null);
  const rfbRef = useRef<import("@novnc/novnc").default | null>(null);
  const [st, setSt] = useState("connecting");
  const [line, setLine] = useState("");
  useEffect(() => {
    let dead = false;
    void import("@novnc/novnc").then(({ default: RFB }) => {
      if (dead || !box.current) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const rfb = new RFB(box.current, withSpaceQuery(`${proto}://${location.host}/api/desktop/runs/${id}/vnc/websockify`), { wsProtocols: ["binary"] });
      rfb.scaleViewport = true; rfb.clipViewport = false; rfb.resizeSession = false; rfb.showDotCursor = true;
      rfb.addEventListener("connect", () => { setSt("connected"); });
      rfb.addEventListener("disconnect", (e) => { if (dead) return; setSt("disconnected"); onDrop((e as CustomEvent).detail?.clean ? "Remote screen closed" : "Remote screen connection lost"); });
      rfb.addEventListener("securityfailure", () => setSt("refused"));
      rfbRef.current = rfb;
    }).catch(() => { if (!dead) { setSt("failed"); onDrop("Could not load the remote screen client"); } });
    return () => { dead = true; try { rfbRef.current?.disconnect(); } catch { /* already gone */ } rfbRef.current = null; };
  }, [id]);
  const key = (k: string) => { const s = SPECIAL[k]; if (s) rfbRef.current?.sendKey(s[0], s[1]); };
  const openKb = () => { kb.current?.focus(); };
  return (
    <div class="vnc-wrap" data-testid="vnc-pane" data-state={st}>
      <div class="vnc-screen" ref={box} data-testid="vnc-screen" />
      <div class="vnc-bar" role="toolbar" aria-label="Remote keyboard">
        <span class="chip" data-testid="vnc-status">{st}</span>
        <button class="btn" data-testid="vnc-kb" onClick={openKb}>⌨ Keyboard</button>
        <button class="btn" data-testid="vnc-ctrl-l" onClick={() => rfbRef.current && chord(rfbRef.current, "l", "KeyL")}>Ctrl+L</button>
        <button class="btn" data-testid="vnc-tab" onClick={() => key("Tab")}>Tab</button>
        <button class="btn" data-testid="vnc-esc" onClick={() => key("Escape")}>Esc</button>
        <button class="btn" data-testid="vnc-enter" onClick={() => key("Enter")}>↵</button>
        <button class="btn" data-testid="vnc-bksp" onClick={() => key("Backspace")}>⌫</button>
      </div>
      <form class="vnc-type" onSubmit={(e) => { e.preventDefault(); if (line && rfbRef.current) { typeText(rfbRef.current, line); setLine(""); } }}>
        <input data-testid="vnc-text" value={line} placeholder="Type text to send…" autocapitalize="off" autocomplete="off" spellcheck={false} onInput={(e) => setLine(e.currentTarget.value)} />
        <button class="btn" data-testid="vnc-send" type="submit" disabled={!line}>Send</button>
      </form>
      <textarea class="vnc-kb" ref={kb} data-testid="vnc-kb-input" aria-label="Remote keyboard input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck={false} rows={1}
        onBeforeInput={(e) => {
          const ev = e as InputEvent;
          if (ev.inputType === "insertText" || ev.inputType === "insertFromPaste" || ev.inputType === "insertCompositionText") { if (ev.data && rfbRef.current) typeText(rfbRef.current, ev.data); ev.preventDefault(); }
          else if (ev.inputType === "insertLineBreak" || ev.inputType === "insertParagraph") { key("Enter"); ev.preventDefault(); }
          else if (ev.inputType === "deleteContentBackward") { key("Backspace"); ev.preventDefault(); }
        }}
        onKeyDown={(e) => {
          if (SPECIAL[e.key]) { e.preventDefault(); key(e.key); return; }
          if ((e.ctrlKey || e.metaKey) && e.key.length === 1 && rfbRef.current) { e.preventDefault(); chord(rfbRef.current, e.key.toLowerCase(), "Key" + e.key.toUpperCase()); }
        }}
        onInput={(e) => { e.currentTarget.value = ""; }} />
    </div>
  );
}

export function DesktopView({ id }: { id: string }) {
  const [d, setD] = useState<DesktopDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [feed, setFeed] = useState<DFeed>(emptyDFeed());
  const [frame, setFrame] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [vnc, setVnc] = useState(false);
  const [busy, setBusy] = useState(false);
  const last = useRef(-1);
  const alive = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = async () => { const r = await getDesktop(id).catch(() => null); if (!r || !alive.current) return; if (r.status === 404) setMissing(true); else if (r.data) setD(r.data); };
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2500);
    const live = startLive({
      id, wsPath: `/api/desktop/runs/${id}/ws`, getAfter: () => last.current,
      onEvents: (evs) => {
        if (!alive.current) return;
        const fr = evs.filter((e) => e.kind === "frame"), rest = evs.filter((e) => e.kind !== "frame");
        const jpg = (fr.at(-1)?.data as { jpg?: unknown } | undefined)?.jpg;
        if (typeof jpg === "string") setFrame(jpg);
        if (rest.length) { setFeed((f) => { const n = foldDesktop(f, rest); last.current = n.last; return n; }); if (rest.some((e) => e.kind === "control" || e.kind === "ask_human" || e.kind === "result")) void refresh(); }
      },
      onTick: () => {},
      poll: async (after) => { const r = await desktopEvents(id, after).catch(() => null); return r && r.data?.events ? { events: r.data.events } : r && r.status === 404 ? { events: [] } : null; },
      onProblem: (m) => { if (alive.current) setProblem(m); },
    });
    return () => { clearInterval(t); live.stop(); };
  }, [id]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [feed.items.length]);

  const status = d?.state?.status ?? d?.run.status ?? "";
  const control = d?.state?.control ?? "agent";
  const done = DONE.has(status);
  // The idle timeout (or the end of the task) can take control away from under us: drop the VNC pane when the server says so.
  useEffect(() => { if (vnc && (done || (d?.state && control !== "human" && !busy))) setVnc(false); }, [control, done, d?.state?.status]);

  const take = async () => {
    setBusy(true);
    const r = await withBusy("desktop-take", () => desktopControl(id, true));
    if (r.status >= 300) { errorToast(r.data?.error ?? `Take control failed (${r.status})`, () => void take()); setBusy(false); return; }
    setVnc(true); await refresh(); setBusy(false);
  };
  const giveBack = async () => {
    setBusy(true); setVnc(false);
    const r = await withBusy("desktop-giveback", () => desktopControl(id, false));
    if (r.status >= 300) errorToast(r.data?.error ?? `Give back failed (${r.status})`, () => void giveBack());
    await refresh(); setBusy(false);
  };
  const stop = async () => { const r = await withBusy("desktop-stop", () => desktopStop(id)); if (r.status >= 300) errorToast(r.data?.error ?? `Stop failed (${r.status})`, () => void stop()); else void refresh(); };

  if (missing) return <div class="shell"><header class="bar"><button class="rbtn" aria-label="Back" title="Back" onClick={() => go("/desktop")}><IconBack /></button></header><main class="empty"><h2>Task not found</h2></main></div>;
  const run = d?.run;
  const asking = control === "asking" && !done;
  const card = d?.card;
  return (
    <div class="shell wide">
      <header class="bar">
        <button class="rbtn" aria-label="Back" title="Back" onClick={() => go("/desktop")}><IconBack /></button>
        {!run ? <div class="title"><div class="skel line wide" /></div> : <>
          <h2 class="title ellip">{run.title || run.id}</h2>
          <span class="chip" data-testid="desk-state">{status}</span>
          <span class="chip" data-testid="desk-control">{control}</span>
        </>}
      </header>
      <main class="msgs feed desk-main" data-testid="desk-stream">
        {asking && !vnc && (
          <div class="banner" role="alert" data-testid="ask-banner">
            <strong>The agent needs you</strong>
            <span data-testid="ask-reason">{d?.state?.askReason ?? feed.asking ?? ""}</span>
            <button class="btn primary" data-testid="ask-take" disabled={busy} onClick={() => void take()}>Take control</button>
          </div>
        )}
        {problem && <div class="error" role="status" data-testid="desk-problem">{problem}</div>}
        {vnc ? <VncPane id={id} onDrop={(why) => { setVnc(false); errorToast(why); void refresh(); }} /> : (
          <div class="desktop-live" data-testid="live-view">
            {frame ? <img class="live-img" data-testid="live-frame" alt="Live view of the remote desktop" src={`data:image/jpeg;base64,${frame}`} /> : <div class="live-empty muted">{done ? "Task ended" : "Waiting for the first screenshot…"}</div>}
          </div>
        )}
        {control === "human" && <p class="muted small" data-testid="idle-note">You are in control. The agent is paused; with no input for 10 minutes, control goes back to it.</p>}
        {card && (
          <section class="card" data-testid="result-card">
            <h3>Result · {card.status}</h3>
            {card.finalMessage && <p data-testid="card-message">{card.finalMessage}</p>}
            {card.stopReason && <div class="muted small">Stopped: {card.stopReason}</div>}
            <div class="muted small" data-testid="card-cost"><span data-testid="card-steps">{card.turns}{card.maxSteps ? `/${card.maxSteps}` : ""} steps</span>{card.wallSecs !== null ? ` · ${card.wallSecs}s wall` : ""}</div>
          </section>
        )}
        <ul class="list desk-feed" data-testid="desk-feed">
          {feed.items.map((it) => <li key={it.seq} class={`desk-item ${it.t}`} data-testid={`ev-${it.t}`}>{it.t === "action" ? <code>{it.text}</code> : it.text}</li>)}
        </ul>
        <div ref={end} />
      </main>
      {!done && run && (
        <footer class="composer actionbar desk-actions">
          {vnc ? <button class="btn primary" data-testid="desk-giveback" disabled={busy} onClick={() => void giveBack()}>Give back</button>
            : <button class="btn primary" data-testid="desk-take" disabled={busy || status === "starting"} onClick={() => void take()}>Take control</button>}
          <button class="btn danger" data-testid="desk-stop" onClick={() => void stop()}>Stop</button>
        </footer>
      )}
    </div>
  );
}
