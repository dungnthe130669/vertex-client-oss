// Terminal tab of a device (vclterm5). Lazy chunk: xterm.js + fit addon are imported only when this component mounts.
import { useEffect, useRef, useState } from "preact/hooks";
import type { DeviceRoot } from "./devices-api";
import { shortPath, visiblePath } from "./devices-logic";
import { HARNESS_NOTE, KEYS, TermSession, bannerFor, withCtrl, type Sink, type TermState } from "./term-client";

export type TermBind = { onFrame: (f: Record<string, any>) => void; onLinkLive: () => void };
type Props = { roots: DeviceRoot[] | undefined; send: (f: Record<string, unknown>) => boolean; bind: (b: TermBind | null) => void; active: boolean; online: boolean; linkLive: boolean };

/** The app's CSP is `style-src 'self'` (no inline <style>), but xterm's DOM renderer writes its theme/size rules into <style> elements it appends under the terminal,
 *  so they would never apply (grey text on black). Mirror each such element into a constructable stylesheet (CSSOM: allowed by the CSP) and keep it in sync.
 *  The CSP stays as it is. Without adoptedStyleSheets (old browsers) nothing happens and the CSS fallbacks in styles.css keep the text readable. */
export function shimInlineStyles(root: HTMLElement, doc: Document = document): () => void {
  if (typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in doc)) return () => {};
  const sheets = new Map<HTMLStyleElement, CSSStyleSheet>();
  const sync = (el: HTMLStyleElement) => { let sh = sheets.get(el); if (!sh) { sh = new CSSStyleSheet(); sheets.set(el, sh); doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sh]; } try { sh.replaceSync(el.textContent ?? ""); } catch { /* bad CSS: ignore */ } };
  const drop = (el: HTMLStyleElement) => { const sh = sheets.get(el); if (!sh) return; sheets.delete(el); doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((x) => x !== sh); };
  const all = () => root.querySelectorAll("style");
  all().forEach(sync);
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => { if (n instanceof HTMLStyleElement) sync(n); else if (n instanceof Element) n.querySelectorAll("style").forEach(sync); });
      m.removedNodes.forEach((n) => { if (n instanceof HTMLStyleElement) drop(n); else if (n instanceof Element) n.querySelectorAll("style").forEach(drop); });
      const t = m.target instanceof HTMLStyleElement ? m.target : m.target.parentElement instanceof HTMLStyleElement ? m.target.parentElement : null;
      if (t && m.type !== "childList") sync(t); else if (t && m.target === t) sync(t);
    }
  });
  mo.observe(root, { childList: true, subtree: true, characterData: true });
  return () => { mo.disconnect(); for (const el of [...sheets.keys()]) drop(el); };
}

export default function TermPane({ roots, send, bind, active, online, linkLive }: Props) {
  const host = useRef<HTMLDivElement>(null), sess = useRef<TermSession | null>(null), api = useRef<{ term: any; fit: any } | null>(null);
  const sendRef = useRef(send); sendRef.current = send;
  const ctrl = useRef(false);
  const [st, setSt] = useState<TermState>({ phase: "idle", consumed: 0, acked: 0 });
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false), [ctrlOn, setCtrlOn] = useState(false), [root, setRoot] = useState("");
  const SEEN = "vc-term-harness-note";
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(SEEN) === "1"; } catch { return false; } }); // one-time privacy note about harnesses, remembered per browser
  const cur = roots?.find((r) => r.path === root) ?? roots?.[0];

  useEffect(() => {
    let dead = false, ro: ResizeObserver | undefined, t: any, unshim: (() => void) | undefined;
    (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
        if (dead || !host.current) return;
        t = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", allowProposedApi: false, theme: { background: "#0F1115", foreground: "#E6E8EE", cursor: "#E6E8EE" } });
        unshim = shimInlineStyles(host.current);
        const fit = new FitAddon(); t.loadAddon(fit); t.open(host.current); try { fit.fit(); } catch { /* hidden */ }
        api.current = { term: t, fit };
        const sink: Sink = {
          write: (b, done) => t.write(b, done),
          reset: () => { t.reset(); },
          note: (s) => t.writeln(`\r\n[${s}]`),
        };
        const s = new TermSession((f) => sendRef.current(f), sink, setSt);
        sess.current = s;
        bind({ onFrame: (f) => { s.onFrame(f); }, onLinkLive: () => s.onLinkLive() });
        t.onData((d: string) => { const out = withCtrl(ctrl.current, d); if (ctrl.current) { ctrl.current = false; setCtrlOn(false); } s.input(out); });
        t.onResize(({ cols, rows }: { cols: number; rows: number }) => s.resize(cols, rows));
        ro = new ResizeObserver(() => { try { if (host.current && host.current.offsetWidth > 0) fit.fit(); } catch { /* */ } });
        ro.observe(host.current);
        setReady(true);
      } catch { if (!dead) setFailed(true); }
    })();
    return () => { dead = true; ro?.disconnect(); unshim?.(); bind(null); sess.current?.stop(); sess.current?.dispose(); sess.current = null; try { t?.dispose(); } catch { /* */ } api.current = null; };
  }, []);
  useEffect(() => { if (active) { try { api.current?.fit.fit(); } catch { /* */ } } }, [active]);
  // A gap/error notice is written into the screen too, so it is visible in context.
  const lastNotice = useRef<string | undefined>();
  useEffect(() => { if (st.notice && st.notice !== lastNotice.current) { api.current?.term.writeln(`\r\n[${st.notice}]`); } lastNotice.current = st.notice; }, [st.notice]);

  // Focus the screen whenever a session becomes live (Start, or an adopted/re-attached one): typing right after the prompt appears must reach xterm (B3).
  useEffect(() => { if (st.phase === "live" && active) { try { api.current?.term.focus(); } catch { /* */ } } }, [st.phase, st.sid, active]);
  // A session adopted from the hub (B1): show its folder, and tell the device our size (the old page's size is what it has).
  useEffect(() => { if (st.adopted && st.phase === "live") { if (st.root) setRoot(st.root); const t = api.current?.term; if (t) sess.current?.resize(t.cols, t.rows); } }, [st.adopted, st.sid, st.phase]);

  const running = st.phase === "live" || st.phase === "opening";
  const banner = bannerFor(st.mode);
  const noRoots = !roots || roots.length === 0;
  const start = () => { const t = api.current?.term; if (!cur || !t) return; sess.current?.open(cur.path, t.cols, t.rows); t.focus(); };
  const press = (seq: string) => { if (st.phase === "live") { sess.current?.input(seq); api.current?.term.focus(); } };
  return (
    <section class="tm" data-testid="tm-pane" aria-label="Terminal" hidden={!active}>
      <div class="tm-bar">
        {!running && !noRoots && roots && <select class="dv-root" data-testid="tm-root" aria-label="Folder" value={cur?.path} onChange={(e) => setRoot(e.currentTarget.value)}>
          {roots.map((r) => <option key={r.path} value={r.path} title={visiblePath(r.path)}>{r.label === r.path ? shortPath(visiblePath(r.path)) : `${r.label} · ${shortPath(visiblePath(r.path))}`}</option>)}
        </select>}
        {running && cur && <span class="muted small ellip" data-testid="tm-where" title={visiblePath(cur.path)}>{shortPath(visiblePath(cur.path))}</span>}
        {!running
          ? <button class="btn primary" data-testid="tm-start" disabled={!ready || noRoots || !online || !linkLive} onClick={start}>Start</button>
          : <button class="btn danger" data-testid="tm-stop" disabled={st.phase === "opening"} onClick={() => sess.current?.stop()}>Stop</button>}
      </div>
      <div class={`tm-banner ${banner.tone}`} data-testid="tm-banner" role="status">{banner.text}</div>
      {!seen && st.phase === "live" && <div class="tm-note small" data-testid="tm-harness-note" role="note">{HARNESS_NOTE} <button class="btn small" data-testid="tm-harness-ok" onClick={() => { try { localStorage.setItem(SEEN, "1"); } catch { /* */ } setSeen(true); }}>Got it</button></div>}
      {noRoots && <p class="muted small" data-testid="tm-noroots" role="status">No folder added on this computer yet. Add one in vcl ui (Folders).</p>}
      {!online && linkLive && <p class="muted small" data-testid="tm-offline" role="status">The device is offline.</p>}
      {st.phase === "opening" && <p class="muted small" data-testid="tm-opening" role="status">Opening…</p>}
      {st.phase === "ended" && st.endMsg && <p class={`small ${st.errorCode ? "error" : "muted"}`} data-testid="tm-end" role="status">{st.endMsg}{st.relogin && <> <a class="tm-relogin" data-testid="tm-relogin" href="/login">Log in again</a></>}</p>}
      {failed && <p class="error small" role="alert" data-testid="tm-load-failed">Could not load the terminal. Check your connection and reload.</p>}
      <div class="tm-screen" data-testid="tm-screen" ref={host} />
      {running && <div class="tm-keys" data-testid="tm-keys" role="toolbar" aria-label="Extra keys">
        <button class={`btn small${ctrlOn ? " primary" : ""}`} data-testid="tm-key-ctrl" aria-pressed={ctrlOn} onClick={() => { ctrl.current = !ctrl.current; setCtrlOn(ctrl.current); api.current?.term.focus(); }}>Ctrl</button>
        {KEYS.map((k) => <button key={k.id} class="btn small" data-testid={`tm-key-${k.id}`} aria-label={k.label} onClick={() => press(k.seq)}>{k.label}</button>)}
      </div>}
    </section>
  );
}
