import { createContext, type ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useContext, useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import { type ConvRow, type Me, listConversations } from "./api";
import { IconAgent, IconChart, IconChat, IconChevronDown, IconCloud, IconDesktop, IconDevices, IconDoc, IconFolder, IconGrid, IconInfo, IconLibrary, IconMenu, IconPlus, IconRemote, IconSearch, IconSettings, IconSlash } from "./icons";
import { type NavKey, chatIdOf, drawerReducer, editRow, initials, isCloseSwipe, navKey, splitPinned } from "./shell-logic";
import { type DestKey, type GroupId, type NavItem, type Sections, RECENT_PREVIEW, drawerNav, groupByBucket, groupOf, groupOpen, loadSections, msUntilMidnight, nextLimit, previewRows, saveSections } from "./drawer-nav";
import { ChatItem } from "./chat-item";
import { onConvEdit } from "./chat-menu";
import { openPalette } from "./palette";
import { SpaceSwitcher } from "./space-ui";
import { getSpace } from "./space";
import { useDevicesAvailable } from "./devices-available";
import { Bell } from "./notifications";

/** The signed-in user, for the drawer's avatar (provided once by App). */
export const MeCtx = createContext<Me | null>(null);

const nav = (path: string, fromApp = false) => { history.pushState(fromApp ? { fromApp: true } : {}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const ICONS: Record<DestKey, () => ComponentChildren> = { chat: IconChat, cloud: IconCloud, agents: IconAgent, desktop: IconDesktop, remote: IconRemote, devices: IconDevices, skills: IconSlash, projects: IconFolder, artifacts: IconDoc, library: IconLibrary, usage: IconChart, about: IconInfo };
/** Fired when "New chat" is chosen while the start screen is already showing (the draft resets instead of navigating). */
export const NEW_CHAT_EVENT = "vc:new-chat";
/** "New chat" from anywhere: the empty start screen. */
export const newChat = () => { if (location.pathname === "/") { if (location.search) history.replaceState({}, "", "/"); dispatchEvent(new Event(NEW_CHAT_EVENT)); } else nav("/"); };
let lastInputKey = false; // last input before the drawer opened: keyboard (true) or pointer/touch (false)
if (typeof addEventListener === "function") { addEventListener("keydown", () => { lastInputKey = true; }, true); addEventListener("pointerdown", () => { lastInputKey = false; }, true); }
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Round hamburger button + the left slide-over drawer it opens. Used by every top bar on phones (and by the chat bars on all widths). */
export function MenuButton({ class: cls = "" }: { class?: string }) {
  const [st, dispatch] = useReducer(drawerReducer, "closed");
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => dispatch("close");
  useEffect(() => { // the exit animation ends the closing state; the timer covers reduced motion (no animationend) and a missed event
    if (st !== "closing") return;
    const t = setTimeout(() => { dispatch("done"); btn.current?.focus(); }, reduced() ? 0 : 240);
    return () => clearTimeout(t);
  }, [st]);
  return (
    <>
      <button ref={btn} class={`rbtn menubtn ${cls}`} aria-label="Menu" title="Menu" aria-haspopup="dialog" aria-expanded={st === "open"} data-testid="menu-button" onClick={() => dispatch("open")}><IconMenu /></button>
      {st !== "closed" && createPortal(<Drawer closing={st === "closing"} onClose={close} onNavigate={() => dispatch("shut")} />, document.body)}
    </>
  );
}

function Drawer({ closing, onClose, onNavigate }: { closing: boolean; onClose: () => void; onNavigate: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const focusables = () => [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href]") ?? [])];
  useLayoutEffect(() => { // keyboard modality: the focus ring shows only after a key press, never after a touch (WebKit treats script focus as focus-visible)
    const k = () => panel.current?.classList.add("kbd"), m = () => panel.current?.classList.remove("kbd");
    if (lastInputKey) k();
    addEventListener("keydown", k, true); addEventListener("pointerdown", m, true);
    return () => { removeEventListener("keydown", k, true); removeEventListener("pointerdown", m, true); };
  }, []);
  useLayoutEffect(() => { // focus lands inside at once; Esc closes even before focus moved; the page behind does not scroll
    (panel.current?.querySelector<HTMLElement>(".drow.on") ?? panel.current?.querySelector<HTMLElement>(".drawer-top .drow"))?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; };
  }, []);
  const onKey = (e: KeyboardEvent) => { // focus trap: Tab / Shift+Tab wrap inside the drawer
    if (e.key !== "Tab") return;
    const f = focusables(); if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    const j = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
    e.preventDefault(); f[j].focus();
  };
  // swipe-left to close: the panel follows the finger, then either closes or springs back
  const touch = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY, dx: 0, dy: 0 }; };
  const onTouchMove = (e: TouchEvent) => {
    const s = touch.current; if (!s || !panel.current) return;
    const t = e.touches[0]; s.dx = t.clientX - s.x; s.dy = t.clientY - s.y;
    if (s.dx < 0 && Math.abs(s.dx) > Math.abs(s.dy)) panel.current.style.transform = `translateX(${s.dx}px)`;
  };
  const onTouchEnd = () => {
    const s = touch.current; touch.current = null;
    if (!panel.current || !s) return;
    panel.current.style.transform = "";
    if (isCloseSwipe(s.dx, s.dy)) onClose();
  };
  const go = (p: string, fromApp = false) => () => {
    onNavigate();
    if (p === "/") newChat(); // already on the start screen: "New chat" clears the draft
    else if (p !== location.pathname) nav(p, fromApp);
  };
  return (
    <div class="drawer-root">
      <div class={`drawer-scrim${closing ? " out" : ""}`} data-testid="drawer-scrim" onClick={onClose} />
      <div ref={panel} class={`drawer${closing ? " out" : ""}`} role="dialog" aria-modal="true" aria-label="Menu" data-testid="drawer"
        onKeyDown={onKey} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
        <DrawerContent go={go} onSearch={() => { onNavigate(); openPalette(); }} />
      </div>
    </div>
  );
}

const roomy = () => typeof matchMedia === "function" && matchMedia("(min-width:1024px)").matches; // the desktop sidebar has the height for open groups

/** Everything inside the drawer panel (header, New chat + Search, short primary list, Recent, More, account). Shared by the phone drawer and the desktop sidebar.
 *  `go` builds the click handler for a destination; `reloadKey` refetches Recent when it changes (the sidebar outlives navigation). */
export function DrawerContent({ go, headExtra, reloadKey, onSearch }: { go: (p: string, fromApp?: boolean) => () => void; headExtra?: ComponentChildren; reloadKey?: string; onSearch?: () => void }) {
  const me = useContext(MeCtx);
  const [rows, setRows] = useState<ConvRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [limit, setLimit] = useState(RECENT_PREVIEW);
  const [dismissed, setDismissed] = useState<NavKey>(null); // the user collapsed the group of this screen after arriving
  const [, setDay] = useState(0);
  const [sections, setSections] = useState<Sections>(() => loadSections());
  const path = location.pathname;
  const cur = navKey(path);
  const curChat = chatIdOf(path);
  const devicesOn = useDevicesAvailable(me?.erichOnly === true && me?.team !== true && getSpace() === "biz");
  const nav = drawerNav(me, getSpace(), devicesOn);
  const curGroup = groupOf(nav, cur);
  const open = (id: GroupId) => groupOpen(sections, id, curGroup === id, roomy(), dismissed !== null && dismissed === cur);
  useEffect(() => { setDismissed(null); }, [cur]); // a route change forgets the collapse: arriving again opens the group
  const toggle = (id: GroupId) => {
    if (curGroup === id) { setDismissed(open(id) ? cur : null); return; } // the current screen's group: a session-local choice, never persisted over the "show me where I am" rule
    setSections((s) => { const n = { ...s, [id]: !open(id) }; saveSections(n); return n; });
  };
  useEffect(() => { // buckets are relative to "today": re-evaluate at local midnight and when the app comes back to the foreground
    let t: ReturnType<typeof setTimeout>;
    const arm = () => { t = setTimeout(() => { setDay((d) => d + 1); arm(); }, msUntilMidnight(new Date())); };
    const vis = () => { if (document.visibilityState === "visible") setDay((d) => d + 1); };
    arm(); document.addEventListener("visibilitychange", vis);
    return () => { clearTimeout(t); document.removeEventListener("visibilitychange", vis); };
  }, []);
  useEffect(() => { void listConversations().then((r) => { if (r.status === 200 && r.data?.conversations) { setRows(r.data.conversations); setFailed(false); } else setFailed(true); }).catch(() => setFailed(true)); }, [reloadKey]);
  useEffect(() => onConvEdit(({ id, ...e }) => setRows((cur) => (cur ? editRow(cur, id, e) : cur))), []); // pin / rename done from the chat header (or another list) reaches this copy
  const { pinned, rest } = splitPinned(rows);
  const shown = previewRows(rest, limit);
  const buckets = groupByBucket(shown, new Date());
  const item = (r: ConvRow) => <ChatItem key={r.id} row={r} variant="drawer" current={r.id === curChat} onOpen={go(`/c/${r.id}`)}
    onEdit={(id, e) => setRows((cur) => (cur ? editRow(cur, id, e) : cur))} onRemoved={(id) => { setRows((cur) => cur?.filter((x) => x.id !== id) ?? cur); if (id === curChat) go("/chats")(); }} />;
  const dest = (i: NavItem, sub = false) => { const Icon = ICONS[i.key]; return (
    <button key={i.key} class={`drow${sub ? " sub" : ""}${cur === i.key ? " on" : ""}`} aria-current={cur === i.key ? "page" : undefined} data-testid={i.tid} onClick={go(i.path, i.fromApp)}><Icon /><span class="drow-l">{i.label}</span></button>
  ); };
  const groupRow = (id: GroupId, label: string, tid: string, Icon: () => ComponentChildren, items: NavItem[]) => {
    const isOpen = open(id);
    return (
      <div key={id} class="drawer-group">
        <button class={`drow group${curGroup === id && !isOpen ? " within" : ""}`} aria-expanded={isOpen} aria-current={curGroup === id && !isOpen ? "true" : undefined} aria-controls={`drawer-g-${id}`} data-testid={tid} onClick={() => toggle(id)}>
          <Icon /><span class="drow-l">{label}</span><span class={`drow-chev${isOpen ? " open" : ""}`} aria-hidden="true"><IconChevronDown /></span>
        </button>
        {isOpen && <div class="drawer-sub" id={`drawer-g-${id}`}>{items.map((i) => dest(i, true))}</div>}
      </div>
    );
  };
  return (
    <>
      <div class="drawer-head">
        <span class="drawer-name">Vertex</span>
        {headExtra}
      </div>
      <SpaceSwitcher />
      <div class="drawer-scroll">
        <div class="drawer-top">
          <button class="drow newrow" data-testid="drawer-new-chat" onClick={go("/")}><IconPlus /><span class="drow-l">New chat</span></button>
          {onSearch && <button class="drow" data-testid="menu-search" title="Search (Ctrl+K)" onClick={onSearch}><IconSearch /><span class="drow-l">Search</span></button>}
        </div>
        <nav class="drawer-nav" aria-label="Main" data-testid="drawer-nav">
          {nav.primary.map((e) => e.kind === "item" ? dest(e) : groupRow(e.id, e.label, e.tid, IconGrid, e.items))}
        </nav>
        {pinned.length > 0 && (
          <section class="drawer-recent drawer-pinned" aria-labelledby="drawer-pinned-h" data-testid="drawer-pinned">
            <h2 class="drawer-sec" id="drawer-pinned-h">Pinned</h2>
            <ul class="drawer-list">{pinned.map(item)}</ul>
          </section>
        )}
        <section class="drawer-recent" aria-labelledby="drawer-recent-h" data-testid="drawer-recent">
          <h2 class="drawer-sec" id="drawer-recent-h">Recent</h2>
          {!rows && !failed && <div aria-busy="true">{[0, 1, 2].map((i) => <div key={i} class="skel drow-skel" />)}</div>}
          {failed && !rows && <p class="muted small drawer-note">Couldn't load chats.</p>}
          {rows && rows.length === 0 && <p class="muted small drawer-note">No chats yet.</p>}
          {buckets.map((b) => (
            <div key={b.bucket} class="drawer-bucket" role="group" aria-label={b.label} data-testid={`recent-${b.bucket}`}>
              <h3 class="drawer-bucket-h">{b.label}</h3>
              <ul class="drawer-list">{b.rows.map(item)}</ul>
            </div>
          ))}
          {rest.length > limit && <button class="drawer-all" data-testid="drawer-show-all" onClick={() => setLimit(nextLimit(limit))}>{limit <= RECENT_PREVIEW ? `Show all (${rest.length})` : `Show more (${rest.length - limit})`}</button>}
        </section>
      </div>
      <div class="drawer-foot">
        <div class="acct" title={me?.user} data-testid="drawer-avatar">
          <span class="avatar" aria-hidden="true">{initials(me?.user ?? "")}</span><span class="acct-name ellip">{me?.user ?? "Account"}</span>
        </div>
        <Bell class="rbtn" />
        <button class="rbtn" aria-label="Settings" title="Settings" data-testid="menu-settings" onClick={go("/settings", true)}><IconSettings /></button>
      </div>
    </>
  );
}
