import { type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { MeCtx, newChat } from "./drawer";
import { openPalette } from "./palette";
import { Bell } from "./notifications";
import { HoverMenu, type MenuEntry } from "./hover-menu";
import { visibleCount } from "./menu-logic";
import { setAppbarSlots, useAppbar } from "./appbar-store";
import { RootBack } from "./root-bar";
import { appbarMounted } from "./overlay-chrome";
import { IconChart, IconCompose, IconInfo, IconMore, IconRemote, IconSearch, IconSettings, IconSlash, IconBell } from "./icons";

const nav = (path: string, fromApp = false) => { history.pushState(fromApp ? { fromApp: true } : {}, "", path); dispatchEvent(new PopStateEvent("popstate")); };

/** Top-level screens: a native shell (no browser Back button) draws Back for them in the bar's left cluster. */
const ROOT_PATHS: ReadonlySet<string> = new Set(["/chats", "/cloud", "/agents", "/desktop", "/remote", "/projects", "/artifacts", "/library", "/notifications"]);
export const hasRootBack = (path: string): boolean => ROOT_PATHS.has(path);

const TITLES: ReadonlyArray<[RegExp, string]> = [
  [/^\/$/, "New chat"], [/^\/chats$/, "Chats"], [/^\/c\//, "Chat"], [/^\/(cloud|r\/)/, "Cloud"], [/^\/(agents|a\/)/, "Agents"], [/^\/(desktop|d\/)/, "Desktop"], [/^\/(remote|m\/)/, "Remote"],
  [/^\/projects/, "Projects"], [/^\/artifacts/, "Artifacts"], [/^\/library/, "Library"], [/^\/notifications/, "Notifications"], [/^\/usage/, "Usage"], [/^\/skills/, "Skills"], [/^\/about/, "About"], [/^\/(settings|connectors)/, "Settings"],
];
/** The name shown in the bar for a route (a chat shows its own title once loaded, see appbar-store). */
export const screenTitle = (path: string): string => TITLES.find(([re]) => re.test(path))?.[1] ?? "Vertex";

const LEFT_MIN = 240;
type Act = { id: string; label: string; testid: string; icon: ComponentChildren; run: () => void; el?: ComponentChildren };

/** Unified top bar of the desktop layout (>=1024px): sidebar toggle + title on the left, action icons on the right. In priority order, the icons that do not fit
 *  collapse into the "..." menu (which also holds the rarely used destinations). `lead` is the sidebar toggle (owned by DeskShell: it carries the overlay handlers). */
export function AppBar({ main, lead }: { main: string; lead: ComponentChildren }) {
  const me = useContext(MeCtx);
  const st = useAppbar();
  const head = useRef<HTMLElement>(null), slot = useRef<HTMLDivElement>(null), caret = useRef<HTMLSpanElement>(null);
  const [avail, setAvail] = useState(10_000);
  useLayoutEffect(() => appbarMounted(), []); // root class that hides the overlay drag strip (no :has())
  useEffect(() => { setAppbarSlots(slot.current, caret.current); return () => setAppbarSlots(null, null); }, []);
  useEffect(() => {
    const el = head.current;
    if (!el) return;
    // room for the action icons = the bar minus its padding, the toggle / Back / caret and a minimum title (the title ellipsizes below that), minus the screen's own slot
    const measure = () => setAvail(el.clientWidth - 24 - LEFT_MIN - (slot.current?.offsetWidth ?? 0) - 8);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el); if (slot.current) ro.observe(slot.current);
    return () => ro.disconnect();
  }, []);
  const erich = me?.team !== true && me?.erichOnly === true;
  const acts: Act[] = [
    { id: "new-chat", label: "New chat", testid: /^\/c\//.test(main) ? "header-new-chat" : "appbar-new-chat", // the chat header's own id, so its specs keep finding it
     icon: <IconCompose />, run: newChat },
    { id: "search", label: "Search", testid: "appbar-search", icon: <IconSearch />, run: openPalette },
    { id: "notifications", label: "Notifications", testid: "appbar-notifications", icon: <IconBell />, run: () => nav("/notifications"), el: <Bell class="abtn" /> },
    { id: "settings", label: "Settings", testid: "appbar-settings", icon: <IconSettings />, run: () => nav("/settings", true) },
    { id: "usage", label: "Usage", testid: "appbar-usage", icon: <IconChart />, run: () => nav("/usage") },
    ...(erich ? [{ id: "remote", label: "Remote", testid: "appbar-remote", icon: <IconRemote />, run: () => nav("/remote") }] : []),
  ];
  const inChat = /^\/c\//.test(main); // a chat has its own Find in the bar: the global Search steps into the "..." menu there
  const ordered = inChat ? [...acts.filter((a) => a.id !== "search"), ...acts.filter((a) => a.id === "search")] : acts;
  const n = inChat ? Math.min(visibleCount(avail, acts.length), acts.length - 1) : visibleCount(avail, acts.length);
  const shownActs = ordered.slice(0, n);
  const more: MenuEntry[] = [
    ...ordered.slice(n).map((a) => ({ id: a.id, label: a.label, icon: a.icon, testid: `appbar-more-${a.id}`, onSelect: a.run })),
    ...(me?.team !== true ? [{ id: "skills", label: "Skills", icon: <IconSlash />, testid: "appbar-more-skills", onSelect: () => nav("/skills") }] : []),
    { id: "about", label: "About", icon: <IconInfo />, testid: "appbar-more-about", onSelect: () => nav("/about") },
  ];
  const title = /^\/c\//.test(main) && st.title ? st.title : screenTitle(main);
  return (
    <header ref={head} class="bar appbar" data-testid="appbar" data-tauri-drag-region>
      <div class="ab-left" data-tauri-drag-region>
        {lead}
        {hasRootBack(main) && <RootBack />}
        <div class="ab-titlewrap" data-tauri-drag-region>
          <span class="ab-title" data-testid="appbar-title" data-tauri-drag-region>{title}</span>
          <span class="ab-caret" ref={caret} data-tauri-drag-region />
        </div>
      </div>
      <div class="ab-right" data-tauri-drag-region>
        <div class="ab-slot" ref={slot} data-tauri-drag-region />
        {shownActs.map((a) => a.el ?? <button key={a.id} type="button" class="abtn" aria-label={a.label} title={a.label} data-testid={a.testid} onClick={a.run}>{a.icon}</button>)}
        <HoverMenu label="More" testid="appbar-more" icon={<IconMore />} items={more} menuLabel="More actions" />
      </div>
    </header>
  );
}
