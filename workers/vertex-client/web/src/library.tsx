import { useEffect, useRef, useState } from "preact/hooks";
import { getLibrary } from "./api";
import { RootBar } from "./root-bar";
import { useEscape } from "./confirm";
import { IconDownload, IconPlay } from "./icons";
import { type LibItem, libFileName, libUrl } from "./library-logic";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
type Filter = "" | "image" | "video";

/** Library (/library): every image and video this account generated, newest first, 60 per page. Tiles reserve a square box up front so
 *  late-loading thumbnails never shift the grid; images are lazy, videos get a play tile (no media is fetched until opened). */
export function Library() {
  const [type, setType] = useState<Filter>("");
  const [items, setItems] = useState<LibItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<LibItem | null>(null);
  const gen = useRef(0); // a slow response for an old filter must not overwrite the current one
  const load = (t: Filter, before: string | null) => {
    const my = ++gen.current;
    setErr(""); setMore(!!before);
    if (!before) { setItems(null); setNext(null); }
    void getLibrary(t, before).then((r) => {
      if (my !== gen.current) return;
      setMore(false);
      if (r.status === 200 && r.data) { const d = r.data; setItems((cur) => (before ? [...(cur ?? []), ...d.items] : d.items)); setNext(d.next); }
      else { setErr(`Could not load the library (${r.status})`); if (!before) setItems([]); }
    }).catch(() => { if (my === gen.current) { setMore(false); setErr("Could not load the library (offline?)"); if (!before) setItems([]); } });
  };
  useEffect(() => { load(type, null); }, [type]);
  return (
    <div class="shell">
      <RootBar title="Library" />
      <main class="page" data-testid="library-screen">
        <div class="seg libfilters" role="group" aria-label="Filter">
          {([["", "All"], ["image", "Images"], ["video", "Videos"]] as const).map(([k, l]) => (
            <button key={k} type="button" class={`chip${type === k ? " on" : ""}`} aria-pressed={type === k} data-testid={`lib-filter-${k || "all"}`} onClick={() => setType(k)}>{l}</button>
          ))}
        </div>
        {err && <div><p class="error" role="alert">{err}</p><button class="btn" onClick={() => load(type, null)}>Retry</button></div>}
        {!items && !err && <div class="libgrid" aria-busy="true">{Array.from({ length: 12 }, (_, i) => <div key={i} class="libtile skel" />)}</div>}
        {items && items.length === 0 && !err && <p class="muted" data-testid="library-empty">Nothing generated yet. Images and videos you create in chat show up here.</p>}
        {items && items.length > 0 && (
          <ul class="libgrid" data-testid="library-grid">
            {items.map((it) => (
              <li key={`${it.conv}/${it.ref}`}>
                <button type="button" class="libtile" data-testid="library-tile" data-type={it.type} aria-label={`Open ${it.type} from ${it.title || "New chat"}`} onClick={() => setOpen(it)}>
                  {it.type === "image" ? <img src={libUrl(it)} alt="" loading="lazy" decoding="async" /> : <span class="libplay"><IconPlay /></span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {next && <div class="libmore"><button class="btn" data-testid="library-more" disabled={more} onClick={() => load(type, next)}>{more ? "Loading…" : "Load more"}</button></div>}
      </main>
      {open && <LibraryPreview it={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function LibraryPreview({ it, onClose }: { it: LibItem; onClose: () => void }) {
  useEscape(onClose);
  const url = libUrl(it);
  const download = () => { const a = document.createElement("a"); a.href = url; a.download = libFileName(it); document.body.appendChild(a); a.click(); a.remove(); };
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet preview libpreview" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Library preview" data-testid="library-preview">
        <div class="grabber" />
        <strong class="pname ellip">{it.title || "New chat"}</strong>
        {it.type === "image" ? <img src={url} alt="Generated image" /> : <video src={url} controls playsInline preload="metadata" />}
        <div class="muted small num">{new Date(it.createdAt).toLocaleString()}</div>
        <div class="approve">
          <button class="btn" data-testid="library-download" onClick={download}><IconDownload /> Download</button>
          <button class="btn primary" data-testid="library-open-chat" onClick={() => go(`/c/${it.conv}`)}>Open chat</button>
          <button class="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
