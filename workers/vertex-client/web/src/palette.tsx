import { createPortal } from "preact/compat";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { type ArtifactRow, type ConvRow, type ProjectRow, type PromptRow, listArtifacts, listConversations, listProjects, listPrompts } from "./api";
import { MeCtx, newChat } from "./drawer";
import { IconPin, IconSearch } from "./icons";
import { openShortcuts } from "./shortcuts";
import { type PalItem, buildItems, chatItem, artifactItem, moveActive } from "./palette-logic";
import { composerMounted, requestInsertPrompt } from "./prompts";
import { nextTheme, useTheme } from "./theme";
import { getSpace, switchSpace } from "./space";
import { hasOpen } from "./space-ui";
import { useDevicesAvailable } from "./devices-available";

/** Opens the command palette. Fired by Ctrl/Cmd+K (desktop shell) and by the search button in the drawer / sidebar. */
export const PALETTE_EVENT = "vc:palette";
export const openPalette = () => dispatchEvent(new Event(PALETTE_EVENT));

const KIND_LABEL = { action: "Action", nav: "Go to", chat: "Chat", artifact: "Artifact", project: "Project", prompt: "Prompt" } as const;
const nav = (path: string, fromApp = false) => { history.pushState(fromApp ? { fromApp: true } : {}, "", path); dispatchEvent(new PopStateEvent("popstate")); };

/** Mounted once under the signed-in app. Renders nothing until opened. */
export function Palette() {
  const [open, setOpen] = useState(false);
  useEffect(() => { const o = () => setOpen(true); addEventListener(PALETTE_EVENT, o); return () => removeEventListener(PALETTE_EVENT, o); }, []);
  return open ? createPortal(<PaletteDialog onClose={() => setOpen(false)} />, document.body) : null;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const me = useContext(MeCtx);
  const devicesOn = useDevicesAvailable(me?.erichOnly === true && me?.team !== true && getSpace() === "biz");
  const [theme, setTheme] = useTheme();
  const [q, setQ] = useState("");
  const [chats, setChats] = useState<ConvRow[]>([]);
  const [arts, setArts] = useState<ArtifactRow[]>([]);
  const [projs, setProjs] = useState<ProjectRow[]>([]);
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [hits, setHits] = useState<{ chats: ConvRow[]; arts: ArtifactRow[] }>({ chats: [], arts: [] }); // server-side search results for the current query
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const prevFocus = useRef<Element | null>(document.activeElement);
  useEffect(() => { // base data + focus; focus goes back to where it was on close
    input.current?.focus();
    void listConversations().then((r) => r.data && setChats(r.data.conversations)).catch(() => {});
    if (me?.erichOnly === true) void listArtifacts().then((r) => r.data?.items && setArts(r.data.items)).catch(() => {});
    if (me?.erichOnly === true) void listProjects().then((r) => r.data?.projects && setProjs(r.data.projects)).catch(() => {});
    void listPrompts().then((r) => r.data?.prompts && setPrompts(r.data.prompts)).catch(() => {});
    return () => { (prevFocus.current as HTMLElement | null)?.focus?.(); };
  }, []);
  const term = q.trim();
  useEffect(() => { // server search (title + message text) once the query is longer than 2 characters; stale answers are dropped
    if (term.length <= 2) { setHits({ chats: [], arts: [] }); return; }
    let live = true;
    const t = setTimeout(() => {
      void Promise.all([listConversations(term).then((r) => r.data?.conversations ?? []).catch(() => []), (me?.erichOnly === true ? listArtifacts(term).then((r) => r.data?.items ?? []).catch(() => []) : Promise.resolve([] as ArtifactRow[]))])
        .then(([c, a]) => { if (live) setHits({ chats: c, arts: a }); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [term]);
  const base = buildItems(term, { chats, artifacts: arts, projects: projs, prompts, erichOnly: me?.erichOnly === true, devices: devicesOn, openSpace: getSpace() === "open", switchTo: hasOpen(me) ? (getSpace() === "open" ? "biz" : "open") : undefined });
  const seen = new Set(base.map((i) => i.id));
  const extra: PalItem[] = term.length > 2 ? [...hits.chats.map(chatItem), ...hits.arts.map(artifactItem)].filter((i) => !seen.has(i.id)) : [];
  const items = [...base, ...extra].slice(0, 40);
  useEffect(() => setActive(0), [term]);
  useEffect(() => { list.current?.querySelector(`#pal-opt-${active}`)?.scrollIntoView?.({ block: "nearest" }); }, [active]);
  const run = (it: PalItem) => {
    onClose();
    if (it.act === "switch-space") switchSpace(getSpace() === "open" ? "biz" : "open");
    else if (it.act === "new-chat") newChat();
    else if (it.act === "insert-prompt" && it.text) { requestInsertPrompt(it.text); if (!composerMounted()) nav("/"); }
    else if (it.act === "toggle-theme") setTheme(nextTheme(theme));
    else if (it.act === "shortcuts") setTimeout(openShortcuts, 0); // after the palette dialog has unmounted, so the help is not suppressed by it
    else if (it.path && it.path !== location.pathname) nav(it.path, it.fromApp);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((i) => moveActive(i, items.length, e.key === "ArrowDown" ? 1 : -1)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = items[active]; if (it) run(it); }
    else if (e.key === "Tab") e.preventDefault(); // the dialog is one input + a listbox driven by aria-activedescendant: focus stays on the input
  };
  return (
    <div class="pal-root" data-testid="palette">
      <div class="pal-scrim" onClick={onClose} />
      <div class="pal" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <div class="pal-field">
          <IconSearch />
          <input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" aria-activedescendant={items.length ? `pal-opt-${active}` : undefined}
            aria-label="Search chats, artifacts, pages and actions" placeholder="Search chats, artifacts, pages…" autocomplete="off" autocapitalize="off" spellcheck={false} enterkeyhint="go"
            data-testid="palette-input" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
        <ul id="pal-list" ref={list} class="pal-list" role="listbox" aria-label="Results" data-testid="palette-list">
          {items.map((it, i) => (
            <li key={it.id} id={`pal-opt-${i}`} role="option" aria-selected={i === active} class={`pal-opt${i === active ? " on" : ""}`} data-testid="palette-item" data-kind={it.kind}
              onMouseMove={() => active !== i && setActive(i)} onClick={() => run(it)}>
              <span class="pal-l ellip">{it.label}</span>
              {it.pinned && <span class="pal-pin" aria-label="Pinned"><IconPin /></span>}
              <span class="pal-k">{it.hint ?? KIND_LABEL[it.kind]}</span>
            </li>
          ))}
          {!items.length && <li class="pal-empty muted small" role="presentation" data-testid="palette-empty">No matches for “{term}”.</li>}
        </ul>
      </div>
    </div>
  );
}
