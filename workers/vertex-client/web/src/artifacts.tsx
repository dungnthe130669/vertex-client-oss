import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { withBusy } from "./busy";
import { type ArtifactFull, type ArtifactRow, type ArtifactType, deleteArtifact, getArtifact, listArtifacts, restoreArtifact, undeleteArtifact, viewArtifact } from "./api";
import { ConfirmSheet } from "./confirm";
import { MenuButton } from "./drawer";
import { BackButton } from "./root-bar";
import { IconBack, IconCheck, IconClose, IconChevron, IconCopy, IconDownload, IconLock, IconTrash } from "./icons";
import { renderMarkdown } from "./markdown";
import { errorToast, toast } from "./toast";
import { FILTERS, PRESET_WIDTH, type Preset, type SortKey, TYPE_LABEL, type TypeFilter, diffStats, downloadMeta, lineDiff, previewLines, relTime, stepVersion, svgOk, viewRows } from "./artifacts-logic";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const open = (id: string) => { history.pushState({ fromApp: true }, "", `/artifacts/${id}`); dispatchEvent(new PopStateEvent("popstate")); };

/** Gallery (/artifacts): newest first; text thumbnail from the stored preview; server-side search. */
export function Artifacts() {
  const [rows, setRows] = useState<ArtifactRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [del, setDel] = useState<ArtifactRow | null>(null);
  const [filter, setFilter] = useState<TypeFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [tab, setTab] = useState<"active" | "deleted">("active");
  const [sel, setSel] = useState<Set<string> | null>(null); // null = not selecting
  const [bulk, setBulk] = useState(false);
  const seq = useRef(0);
  const trash = tab === "deleted";
  const load = (term: string, cursor = "", deleted = trash) => {
    const my = ++seq.current;
    setErr("");
    void listArtifacts(term, cursor, deleted).then((r) => {
      if (my !== seq.current) return; // a newer search superseded this one
      if (r.status === 200 && r.data) { setRows((old) => (cursor && old ? [...old, ...r.data!.items] : r.data!.items)); setNext(r.data.next); }
      else setErr(`Could not load artifacts (${r.status})`);
    }).catch(() => { if (my === seq.current) setErr("Could not load artifacts (offline?)"); });
  };
  useEffect(() => { const t = setTimeout(() => load(q.trim()), rows === null ? 0 : 250); return () => clearTimeout(t); }, [q]);
  const switchTab = (t: "active" | "deleted") => { if (t === tab) return; setTab(t); setSel(null); setRows(null); setNext(null); load(q.trim(), "", t === "deleted"); };
  const shown = rows ? viewRows(rows, filter, sort) : null;
  const toggle = (id: string) => setSel((old) => { const n = new Set(old); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const restoreOne = async (a: ArtifactRow) => {
    const r = await withBusy("artifact-undelete", () => undeleteArtifact(a.id)).catch(() => null);
    if (r?.status === 200) { setRows((old) => old?.filter((x) => x.id !== a.id) ?? old); toast(`Restored “${a.title}”`); } else errorToast(r?.status === 410 ? "Too late to restore it" : "Could not restore it", () => void restoreOne(a));
  };
  const removeMany = async (only?: string[]) => {
    const ids = only ?? [...(sel ?? [])], gone: ArtifactRow[] = [];
    setBulk(false);
    for (const id of ids) {
      const a = rows?.find((x) => x.id === id);
      const r = await withBusy("artifact-delete", () => deleteArtifact(id)).catch(() => null);
      if (a && r?.status === 200) gone.push(a);
    }
    setSel(null);
    const ok = new Set(gone.map((a) => a.id));
    setRows((old) => old?.filter((x) => !ok.has(x.id)) ?? old);
    if (gone.length < ids.length) errorToast(`Deleted ${gone.length} of ${ids.length}`, () => void removeMany(ids.filter((i) => !ok.has(i))));
    else toast(`Deleted ${gone.length} artifact${gone.length === 1 ? "" : "s"}`, { action: { label: "Undo", run: () => void Promise.all(gone.map((a) => withBusy("artifact-undelete", () => undeleteArtifact(a.id)).catch(() => null))).then(() => load(q.trim())) } });
  };
  const undo = async (a: ArtifactRow) => {
    const r = await withBusy("artifact-undelete", () => undeleteArtifact(a.id)).catch(() => null);
    if (r?.status === 200) load(q.trim()); else errorToast("Could not restore it", () => void undo(a));
  };
  const remove = async (a: ArtifactRow) => {
    setDel(null);
    const r = await withBusy("artifact-delete", () => deleteArtifact(a.id)).catch(() => null);
    if (r?.status === 200) { setRows((old) => old?.filter((x) => x.id !== a.id) ?? old); toast(`Deleted “${a.title}”`, { action: { label: "Undo", run: () => void undo(a) } }); }
    else errorToast(r?.data?.error ?? "Could not delete", () => void remove(a));
  };
  return (
    <div class="shell">
      <header class="bar"><MenuButton /><BackButton /><h1 class="title">Artifacts</h1>
        {!trash && rows && rows.length > 0 && (sel
          ? <button class="btn" data-testid="artifact-select-done" onClick={() => setSel(null)}>Cancel</button>
          : <button class="btn" data-testid="artifact-select" onClick={() => setSel(new Set())}>Select</button>)}
      </header>
      <main class="list-page artpage" data-testid="artifacts-screen">
        <div class="artfilters">
          <div class="seg" role="group" aria-label="Show">
            <button class={`chip${!trash ? " on" : ""}`} aria-pressed={!trash} data-testid="artifact-tab-active" onClick={() => switchTab("active")}>Saved</button>
            <button class={`chip${trash ? " on" : ""}`} aria-pressed={trash} data-testid="artifact-tab-deleted" onClick={() => switchTab("deleted")}>Deleted</button>
          </div>
        </div>
        <div class="artfilters" role="group" aria-label="Filter by type">
          {FILTERS.map((f) => <button key={f.key} class={`chip${filter === f.key ? " on" : ""}`} aria-pressed={filter === f.key} data-testid={`artifact-filter-${f.key}`} onClick={() => setFilter(f.key)}>{f.label}</button>)}
          <select class="artsort" aria-label="Sort" data-testid="artifact-sort" value={sort} onChange={(e) => setSort(e.currentTarget.value as SortKey)}>
            <option value="recent">Recent</option>
            <option value="name">Name</option>
          </select>
        </div>
        {trash && rows && rows.length > 0 && <p class="muted small">Deleted artifacts can be restored for a few minutes.</p>}
        {err && <div class="empty"><h2>{err}</h2><button class="btn" onClick={() => load(q.trim())}>Retry</button></div>}
        {!rows && !err && <ul class="list" aria-busy="true">{[0, 1, 2, 3].map((i) => <li key={i}><div class="skel row-skel" /></li>)}</ul>}
        {rows && rows.length > 0 && shown!.length === 0 && !err && <div class="empty" data-testid="artifacts-empty-filter"><h2>No {TYPE_LABEL[filter as ArtifactType]} artifacts</h2><p class="muted">Try another type.</p><button class="btn" onClick={() => setFilter("all")}>Show all</button></div>}
        {rows && rows.length === 0 && !err && (trash
          ? <div class="empty" data-testid="artifacts-empty"><h2>Nothing deleted</h2><p class="muted">Artifacts you delete show up here for a few minutes so you can restore them.</p></div>
          : q.trim()
          ? <div class="empty" data-testid="artifacts-empty"><h2>No matches</h2><p class="muted">Nothing found for “{q.trim()}”.</p></div>
          : <div class="empty" data-testid="artifacts-empty"><h2>No artifacts yet</h2><p class="muted">When Claude writes a document, script or diagram for you, it is kept here.</p></div>)}
        <ul class="artlist" data-testid="artifacts-list">
          {shown?.map((a) => (
            <li key={a.id} data-testid="artifact-row" data-title={a.title} data-type={a.type}>
              {sel && <input type="checkbox" class="artcheck" data-testid="artifact-check" aria-label={`Select ${a.title}`} checked={sel.has(a.id)} onChange={() => toggle(a.id)} />}
              <button class="artrow" onClick={() => (sel ? toggle(a.id) : trash ? undefined : open(a.id))}>
                <span class="artthumb" aria-hidden="true"><pre>{previewLines(a.preview)}</pre><span class="arttype" data-testid="artifact-type">{TYPE_LABEL[a.type]}</span></span>
                <span class="artmeta">
                  <strong class="arttitle">{a.title}</strong>
                  <span class="muted small artline"><IconLock />Only you</span>
                  <span class="muted small">Edited {relTime(a.updatedAt)}</span>
                </span>
              </button>
              {trash
                ? <button class="btn" aria-label={`Restore ${a.title}`} data-testid="artifact-restore-deleted" onClick={() => void restoreOne(a)}>Restore</button>
                : !sel && <button class="icon del" aria-label={`Delete ${a.title}`} data-testid="artifact-delete" onClick={() => setDel(a)}><IconTrash /></button>}
            </li>
          ))}
        </ul>
        {next && <button class="btn artmore" data-testid="artifacts-more" onClick={() => load(q.trim(), next)}>Load more</button>}
      </main>
      {sel && <div class="artbulk" data-testid="artifact-bulkbar"><span class="small">{sel.size} selected</span><button class="btn del" disabled={sel.size === 0} data-testid="artifact-bulk-delete" onClick={() => setBulk(true)}>Delete</button></div>}
      <div class="artsearch"><input type="search" data-testid="artifact-search" aria-label="Search artifacts" placeholder="Search artifacts" value={q} maxLength={100} onInput={(e) => setQ(e.currentTarget.value)} /></div>
      {del && <ConfirmSheet title={`Delete “${del.title}”?`} body="All versions are removed. You can undo for a few minutes." onConfirm={() => void remove(del)} onCancel={() => setDel(null)} />}
      {bulk && sel && <ConfirmSheet title={`Delete ${sel.size} artifact${sel.size === 1 ? "" : "s"}?`} body="All versions are removed. You can restore them from Deleted for a few minutes." onConfirm={() => void removeMany()} onCancel={() => setBulk(false)} />}
    </div>
  );
}

/** SVG shown only as <img src=blob:>: scripts do not run in an image and the markup is never put in the page's DOM. */
function SvgView({ content, title }: { content: string; title: string }) {
  const ok = svgOk(content);
  const url = useMemo(() => (ok ? URL.createObjectURL(new Blob([content], { type: "image/svg+xml" })) : null), [content, ok]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!url) return <p class="error" role="alert">This SVG is too large or malformed to display.</p>;
  return <div class="artsvg"><img src={url} alt={title} data-testid="artifact-svg" /></div>;
}

/** html artifact: Preview = a sandboxed frame onto /af/:id/:version (opaque origin: sandbox="allow-scripts" only, never allow-same-origin / popups / forms / top-navigation);
 *  Source = the text in a <pre>. Messages from the frame are never listened to. The frame URL carries a 5-minute view token minted per load / Reload. */
function HtmlView({ a }: { a: ArtifactFull }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  const [full, setFull] = useState(false);
  const [preset, setPreset] = useState<Preset>("desktop");
  const box = useRef<HTMLDivElement>(null);
  // Viewport preset = CSSOM width on the frame's container (no inline style attribute, no frame access). Re-applied whenever the container (re)mounts.
  useEffect(() => { if (box.current) { box.current.style.width = PRESET_WIDTH[preset]; box.current.style.maxWidth = "100%"; } }, [preset, src, err, mode]);
  useEffect(() => { if (!full) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setFull(false); } }; addEventListener("keydown", k, true); return () => removeEventListener("keydown", k, true); }, [full]);
  useEffect(() => {
    if (mode !== "preview") return;
    let live = true;
    setSrc(null); setErr("");
    type Minted = { url: string; error?: undefined } | { error: string; url?: undefined };
    const mint = (): Promise<Minted> => viewArtifact(a.id, a.shown).then((r) => (r.status === 200 && r.data?.url ? { url: r.data.url } : { error: `Could not open the preview (${r.status})` })).catch(() => ({ error: "Could not open the preview (offline?)" }));
    // The frame URL's token is short-lived: probe it once (the body is discarded, never rendered); a 403 = expired -> re-mint exactly once, then show a placeholder.
    const alive = (url: string) => fetch(url, { cache: "no-store", credentials: "omit" }).then((x) => x.status !== 403, () => true);
    void (async () => {
      let m = await mint();
      if (!live) return;
      if (m.url && !(await alive(m.url))) { if (!live) return; m = await mint(); if (!live) return; if (m.url && !(await alive(m.url))) m = { error: "The preview link expired" }; }
      if (!live) return;
      if (m.url) setSrc(m.url); else setErr(m.error ?? "Could not open the preview");
    })();
    return () => { live = false; };
  }, [a.id, a.shown, a.version, mode, n]);
  const reload = () => setN((x) => x + 1);
  return (
    <div class={`arthtml${full ? " full" : ""}`} data-testid="artifact-html" data-full={full ? "1" : "0"}>
      <div class="arthtml-bar">
        <div class="seg" role="group" aria-label="View">
          <button class={`btn${mode === "preview" ? " on" : ""}`} aria-pressed={mode === "preview"} data-testid="artifact-mode-preview" onClick={() => setMode("preview")}>Preview</button>
          <button class={`btn${mode === "source" ? " on" : ""}`} aria-pressed={mode === "source"} data-testid="artifact-mode-source" onClick={() => setMode("source")}>Source</button>
        </div>
        {mode === "preview" && (
          <div class="seg" role="group" aria-label="Viewport">
            {(["mobile", "tablet", "desktop"] as Preset[]).map((p) => <button key={p} class={`btn${preset === p ? " on" : ""}`} aria-pressed={preset === p} data-testid={`artifact-preset-${p}`} onClick={() => setPreset(p)}>{p === "mobile" ? "Mobile" : p === "tablet" ? "Tablet" : "Desktop"}</button>)}
          </div>
        )}
        {mode === "preview" && <button class="btn" data-testid="artifact-reload" onClick={reload}>Reload</button>}
        {mode === "preview" && <button class="btn" data-testid="artifact-fullscreen" aria-pressed={full} onClick={() => setFull((x) => !x)}>{full ? "Exit fullscreen" : "Fullscreen"}</button>}
      </div>
      {mode === "preview" && err && <div class="artframe-err" role="alert" data-testid="artifact-frame-error"><p class="error">{err}</p><button class="btn" data-testid="artifact-frame-retry" onClick={reload}>Try again</button></div>}
      {mode === "preview" && src && <div class="artframebox" ref={box} data-testid="artifact-framebox"><iframe class="artframe" data-testid="artifact-frame" title={a.title} sandbox="allow-scripts" referrerpolicy="no-referrer" src={src} /></div>}
      {mode === "source" && <div class="artcode"><pre data-testid="artifact-code"><code>{a.content}</code></pre></div>}
      <p class="muted small" data-testid="artifact-sandbox-note">Runs in an isolated sandbox: no network, no access to your account or this app.</p>
    </div>
  );
}

/** Line diff of two versions of a text artifact (markdown / code / html source). Rendered as text children only. */
function DiffView({ id, type, shown, versions }: { id: string; type: ArtifactType; shown: number; versions: number[] }) {
  const [from, setFrom] = useState(versions.length > 1 ? versions[versions.length - 2]! : versions[0]!);
  const [to, setTo] = useState(shown);
  const [ops, setOps] = useState<ReturnType<typeof lineDiff> | undefined>(undefined);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setOps(undefined); setErr("");
    void Promise.all([getArtifact(id, from), getArtifact(id, to)]).then(([x, y]) => {
      if (!live) return;
      if (x.status === 200 && y.status === 200 && x.data && y.data) setOps(lineDiff(x.data.content, y.data.content));
      else setErr("Could not load those versions");
    }).catch(() => live && setErr("Could not load those versions (offline?)"));
    return () => { live = false; };
  }, [id, from, to]);
  const sel = (v: number, set: (n: number) => void, label: string, tid: string) => <select aria-label={label} data-testid={tid} value={v} onChange={(e) => set(Number(e.currentTarget.value))}>{versions.map((x) => <option key={x} value={x}>v{x}</option>)}</select>;
  const st = ops ? diffStats(ops) : null;
  return (
    <div class="artdiff" data-testid="artifact-diff">
      <div class="artdiff-bar">{sel(from, setFrom, "Compare from", "artifact-diff-from")}<span class="muted">→</span>{sel(to, setTo, "Compare to", "artifact-diff-to")}{st && <span class="muted small" data-testid="artifact-diff-stats">+{st.add} −{st.del}</span>}</div>
      {err && <p class="error" role="alert">{err}</p>}
      {!err && ops === undefined && <div class="skel block" aria-busy="true" />}
      {!err && ops === null && <p class="muted" data-testid="artifact-diff-big">These versions are too large to compare line by line.</p>}
      {ops && (from === to || (st!.add === 0 && st!.del === 0)
        ? <p class="muted" data-testid="artifact-diff-same">No differences.</p>
        : <pre class="artdiff-body" data-testid="artifact-diff-body">{ops.map((o) => <div class={`dl ${o.t}`} data-op={o.t}><span class="dm" aria-hidden="true">{o.t === "add" ? "+" : o.t === "del" ? "−" : " "}</span>{o.line || " "}</div>)}</pre>)}
    </div>
  );
}

function Body({ a }: { a: ArtifactFull }) {
  if (a.type === "html") return <HtmlView a={a} />;
  if (a.type === "markdown") return <div class="md artmd" data-testid="artifact-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.content) }} />;
  if (a.type === "svg") return <SvgView content={a.content} title={a.title} />;
  return <div class="artcode"><span class="chip artlang" data-testid="artifact-lang">{a.language || "text"}</span><pre data-testid="artifact-code"><code>{a.content}</code></pre></div>;
}

/** Full-screen viewer (/artifacts/:id): version stepper, copy, restore, delete. On desktop, opened from a chat, it is the side panel instead (`onClose` set: close X, not Back). */
export function ArtifactViewer({ id, onClose }: { id: string; onClose?: () => void }) {
  const [a, setA] = useState<ArtifactFull | null>(null);
  const [err, setErr] = useState("");
  const [ask, setAsk] = useState(false);
  const [copied, setCopied] = useState(false);
  const [diff, setDiff] = useState(false);
  const load = (v?: number) => {
    setErr("");
    void getArtifact(id, v).then((r) => {
      if (r.status === 200 && r.data) setA(r.data);
      else setErr(r.status === 404 ? "This artifact no longer exists." : `Could not load it (${r.status})`);
    }).catch(() => setErr("Could not load it (offline?)"));
  };
  useEffect(() => load(), [id]);
  const back = () => (history.state?.fromApp ? history.back() : go("/artifacts"));
  const copy = () => { if (!a) return; void navigator.clipboard?.writeText(a.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => errorToast("Copy failed", copy)); };
  const download = () => {
    if (!a) return;
    const { name, mime } = downloadMeta(a);
    const url = URL.createObjectURL(new Blob([a.content], { type: mime })); // never navigated to: only an <a download> click
    const l = document.createElement("a");
    l.href = url; l.download = name; l.rel = "noopener"; document.body.append(l); l.click(); l.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const restore = async () => {
    if (!a) return;
    const r = await withBusy("artifact-restore", () => restoreArtifact(a.id, a.shown)).catch(() => null);
    if (r?.status === 200) { toast(`Restored v${a.shown} as a new version`); load(); } else errorToast(r?.data?.error ?? "Could not restore", () => void restore());
  };
  const remove = async () => {
    if (!a) return;
    setAsk(false);
    const r = await withBusy("artifact-delete", () => deleteArtifact(a.id)).catch(() => null);
    if (r?.status !== 200) { errorToast(r?.data?.error ?? "Could not delete", () => void remove()); return; }
    const title = a.title, aid = a.id;
    toast(`Deleted “${title}”`, { action: { label: "Undo", run: () => void withBusy("artifact-undelete", () => undeleteArtifact(aid)).then((u) => { if (u.status === 200) open(aid); else errorToast("Could not restore it"); }).catch(() => errorToast("Could not restore it")) } });
    go("/artifacts");
  };
  const vs = a?.versions.map((v) => v.version) ?? [];
  const step = (d: -1 | 1) => { if (a) load(stepVersion(a.shown, vs, d)); };
  return (
    <div class={`shell artview${onClose ? " embedded" : ""}`}>
      <header class="bar">
        {onClose
          ? <button class="rbtn" aria-label="Close artifact" title="Close (Esc)" data-testid="artifact-close" onClick={onClose}><IconClose /></button>
          : <button class="rbtn" aria-label="Back" title="Back" data-testid="artifact-back" onClick={back}><IconBack /></button>}
        <h1 class="title ellip" data-testid="artifact-title">{a?.title ?? "Artifact"}</h1>
        {a && <button class="icon" aria-label="Copy content" title="Copy" data-testid="artifact-copy" onClick={copy}>{copied ? <IconCheck /> : <IconCopy />}</button>}
        {a && <button class="icon" aria-label="Download file" title="Download" data-testid="artifact-download" onClick={download}><IconDownload /></button>}
        {a && <button class="icon del" aria-label="Delete artifact" title="Delete" data-testid="artifact-viewer-delete" onClick={() => setAsk(true)}><IconTrash /></button>}
      </header>
      <main class="page artbody" data-testid="artifact-viewer">
        {err && <div class="empty full"><h2>{err}</h2><button class="btn" onClick={() => load()}>Retry</button></div>}
        {!a && !err && <div aria-busy="true"><div class="skel block" /><div class="skel block" /></div>}
        {a && (
          <>
            <div class="artbar">
              <span class="chip">{TYPE_LABEL[a.type]}</span>
              <div class="artstep" role="group" aria-label="Versions">
                <button class="icon" aria-label="Previous version" data-testid="artifact-prev" disabled={vs.indexOf(a.shown) <= 0} onClick={() => step(-1)}><span class="flip"><IconChevron /></span></button>
                <span class="num small" data-testid="artifact-version" aria-live="polite">v{a.shown} / {a.version}</span>
                <button class="icon" aria-label="Next version" data-testid="artifact-next" disabled={vs.indexOf(a.shown) >= vs.length - 1} onClick={() => step(1)}><IconChevron /></button>
              </div>
              {a.type !== "svg" && vs.length > 1 && <button class={`btn${diff ? " on" : ""}`} aria-pressed={diff} data-testid="artifact-diff-toggle" onClick={() => setDiff((x) => !x)}>Compare</button>}
              {a.shown !== a.version && <button class="btn" data-testid="artifact-restore" onClick={() => void restore()}>Restore this version</button>}
            </div>
            {diff && a.type !== "svg" && vs.length > 1 ? <DiffView key={a.id} id={a.id} type={a.type} shown={a.shown} versions={vs} /> : <Body a={a} />}
          </>
        )}
      </main>
      {ask && a && <ConfirmSheet title={`Delete “${a.title}”?`} body="All versions are removed. You can undo for a few minutes." onConfirm={() => void remove()} onCancel={() => setAsk(false)} />}
    </div>
  );
}
