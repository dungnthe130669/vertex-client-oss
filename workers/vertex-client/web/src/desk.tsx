import { type ComponentChildren } from "preact";
import { useContext, useEffect, useReducer, useRef } from "preact/hooks";
import { useDesktop, useMedia } from "./media";
import { AppBar } from "./appbar";
import { DrawerContent, MeCtx, newChat } from "./drawer";
import { openPalette } from "./palette";
import { IconClose, IconSidebar } from "./icons";
import { settingsPanes, isSettingsPath, inDesktopShell, mainPath, nextBase, readSidebarOpen, shortcutOf, writeSidebarOpen } from "./desk-logic";
import { hasOpen } from "./space-ui";
import { getSpace } from "./space";
import { useDevicesAvailable } from "./devices-available";
import { shellInvoke } from "./desktop-pair";
import { thisDeviceAvailable } from "./this-device-logic";
import { PaneCtx } from "./pane-ctx";
import { lazyScreen } from "./lazy-screen";
import { SIDEBAR_LEAVE_MS, sidebarPeek, sidebarReducer } from "./shell-logic";

const ArtifactViewer = lazyScreen(() => import("./artifacts").then((m) => m.ArtifactViewer)); // side panel: loaded on first open

const nav = (path: string, fromApp = false) => { history.pushState(fromApp ? { fromApp: true } : {}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const store = (): Storage | null => { try { return localStorage; } catch { return null; } };

export { useDesktop };

/** Desktop frame: left sidebar (the drawer's content), the routed page, an artifact panel on the right, settings as a two-pane modal.
 *  `render(path)` draws one route; the frame decides which route goes where (see mainPath). */
export function DeskShell({ path, render }: { path: string; render: (path: string) => ComponentChildren }) {
  const me = useContext(MeCtx);
  const [sb, sbDispatch] = useReducer(sidebarReducer, undefined, () => ({ pinned: readSidebarOpen(store()), overlay: "closed" as const, focus: false }));
  const open = sb.pinned;
  const base = useRef("/");
  const root = useRef<HTMLDivElement>(null);
  base.current = nextBase(path, base.current);
  const place = mainPath(path, base.current);
  const devicesOn = useDevicesAvailable(!!place.modal && me?.erichOnly === true && me?.team !== true && getSpace() === "biz"); // only while Settings is open: reopening it after a transient failure re-probes
  const wide = useMedia("(min-width:1280px)");
  // Between 1024 and 1279px the sidebar and a 45% panel leave the chat ~280px: the sidebar steps aside while the panel is open.
  const squeezed = !!place.panel && !wide;
  const shown = open && !squeezed;
  const closeOverlay = () => (history.state?.fromApp && !place.modal ? history.back() : nav(base.current));
  const sbRef = useRef(sb);
  sbRef.current = sb;
  const toggle = () => {
    if (squeezed) { sbDispatch({ t: "pin" }); writeSidebarOpen(store(), true); closeOverlay(); return; } // asking for the sidebar closes the panel
    const next = !sbRef.current.pinned;
    writeSidebarOpen(store(), next);
    sbDispatch({ t: "toggle" });
  };
  // Hover overlay (hidden sidebar, mouse / pen with hover only; touch keeps the hamburger drawer). Triggered by pointer MOVES over the hot zone / expand button /
  // overlay, never by pointerenter alone, so a pointer parked there during page load does not pop it open; a pressed button (drag, text selection) never opens it.
  const peek = !shown && sidebarPeek(sb);
  const hoverOn = useMedia("(hover:hover) and (pointer:fine)");
  const hover = (e: PointerEvent) => { if (!shown && hoverOn && e.pointerType !== "touch" && e.buttons === 0) sbDispatch({ t: "hover" }); };
  // The appearing overlay covers the trigger (pointerleave on it) and the pointer is then "entering" the overlay: moves between the three surfaces are not leaving.
  const leave = (e: PointerEvent) => { if (e.pointerType === "touch") return; /* a touch release on a hybrid device is not the mouse leaving */ if (e.relatedTarget instanceof Element && e.relatedTarget.closest(".sidebar,.sb-hot,.ab-toggle")) return; sbDispatch({ t: "leave" }); };
  const resumePeek = (e: PointerEvent) => { if (hoverOn && e.pointerType !== "touch" && e.buttons === 0 && sbRef.current.overlay !== "closed") sbDispatch({ t: "hover" }); }; // cancels a pending close; never opens on a bare enter
  useEffect(() => {
    if (sb.overlay !== "leaving") return;
    const id = setTimeout(() => sbDispatch({ t: "tick" }), SIDEBAR_LEAVE_MS);
    return () => clearTimeout(id);
  }, [sb.overlay]);
  useEffect(() => { if (shown) sbDispatch({ t: "esc" }); }, [shown]); // the sidebar got pinned (or came back): no overlay state left behind
  // the shortcuts read the latest values through a ref, so the listener is installed once
  const live = useRef({ place, toggle, closeOverlay, peek });
  live.current = { place, toggle, closeOverlay, peek };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      root.current?.classList.add("kbd");
      const s = shortcutOf(e, inDesktopShell());
      if (!s) return;
      const L = live.current;
      if (s === "palette") { e.preventDefault(); openPalette(); return; }
      if (s === "toggle-sidebar") { e.preventDefault(); L.toggle(); return; }
      if (s === "new-chat") { e.preventDefault(); newChat(); return; }
      if (s === "settings") { e.preventDefault(); if (!L.place.modal) nav("/settings", true); return; }
      if (e.defaultPrevented || document.querySelector(".scrim")) return; // a sheet / slash menu already took this Esc
      if (s === "escape" && L.peek && !L.place.modal) { // the hover overlay: Esc closes it and hands focus back to the button that shows it
        e.preventDefault();
        // focus first (its focusout may re-assert hover under a parked mouse), THEN dismiss: Esc is the final action
        if (document.querySelector(".sidebar")?.contains(document.activeElement)) document.querySelector<HTMLElement>('[data-testid="sidebar-open"]')?.focus();
        sbDispatch({ t: "esc" });
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT");
      if (!L.place.modal && L.place.panel && !typing) { e.preventDefault(); L.closeOverlay(); } // the Settings modal has its own capture-phase Esc below
    };
    // Settings modal: Esc in the CAPTURE phase, so a focused control that swallows Esc (stopPropagation) cannot trap the modal. A sheet, palette or open menu/dropdown keeps its own Esc first.
    const onModalEsc = (e: KeyboardEvent) => {
      const L = live.current;
      if (e.key !== "Escape" || !L.place.modal || !isSettingsPath(location.pathname)) return;
      const t = e.target as Element | null;
      if (document.querySelector(".scrim, .pal-scrim") || document.querySelector('[role="menu"], [role="listbox"]') || t?.closest?.('select, [aria-expanded="true"]')) return;
      e.preventDefault(); L.closeOverlay();
    };
    const onPointer = () => root.current?.classList.remove("kbd");
    addEventListener("keydown", onKey); addEventListener("keydown", onModalEsc, true); addEventListener("pointerdown", onPointer, true);
    return () => { removeEventListener("keydown", onKey); removeEventListener("keydown", onModalEsc, true); removeEventListener("pointerdown", onPointer, true); };
  }, []);
  const go = (p: string, fromApp = false) => () => {
    if (p === "/") newChat();
    else if (p !== location.pathname) nav(p, fromApp);
    if (!sbRef.current.pinned) sbDispatch({ t: "select" }); // a destination / chat picked from the overlay closes it
  };
  // ONE toggle, in the app bar, in the same place whether the sidebar is pinned, shown as an overlay or hidden: pressed = pinned. Its test id keeps the two
  // names the specs know (sidebar-toggle while the sidebar is pinned, sidebar-open while it is hidden); a pointer move over it shows the hover overlay.
  const toggleBtn = <button class="abtn ab-toggle" aria-label={shown ? "Hide sidebar" : "Show sidebar"} aria-pressed={shown} title={`${shown ? "Hide" : "Show"} sidebar (Ctrl+B)`} data-testid={shown ? "sidebar-toggle" : "sidebar-open"} onClick={toggle} onPointerMove={hover} onPointerLeave={leave}><IconSidebar /></button>;
  return (
    <div ref={root} class={`dshell${shown ? "" : " collapsed"}${peek ? " peek" : ""}${place.panel ? " has-panel" : ""}`} data-testid="dshell">
      <aside class="sidebar" aria-label="Sidebar" data-testid="sidebar" data-open={shown ? "true" : "false"} data-peek={peek ? "true" : "false"} {...(shown || peek ? {} : { inert: true })}
        onPointerEnter={resumePeek} onPointerMove={hover} onPointerLeave={leave} onFocusIn={() => sbDispatch({ t: "focus" })} onFocusOut={(e) => { if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; sbDispatch({ t: "blur" }); if (hoverOn && e.currentTarget.matches(":hover")) sbDispatch({ t: "hover" }); /* focus left but the mouse is still on it */ }}>
        <DrawerContent go={go} reloadKey={path} onSearch={openPalette} />
      </aside>
      {!shown && <div class="sb-hot" data-testid="sidebar-hot" aria-hidden="true" onPointerMove={hover} onPointerLeave={leave} />}
      <AppBar main={place.main} lead={toggleBtn} />
      <div class="dmain" data-testid="dmain">{render(place.main)}</div>
      {place.panel && (
        <aside class="artpanel" aria-label="Artifact" data-testid="artifact-panel">
          <ArtifactViewer id={place.panel} key={place.panel} onClose={closeOverlay} />
        </aside>
      )}
      {place.modal && (
        <div class="setmodal-root" data-testid="settings-modal">
          <div class="setmodal-scrim" onClick={closeOverlay} />
          <div class="setmodal" role="dialog" aria-modal="true" aria-label="Settings">
            <nav class="setnav" aria-label="Settings sections">
              <h2 class="setnav-h">Settings</h2>
              {settingsPanes(me, getSpace(), hasOpen(me), devicesOn, thisDeviceAvailable(navigator.userAgent, !!shellInvoke())).map((p) => <button key={p.path} class={`drow${path === p.path ? " on" : ""}`} aria-current={path === p.path ? "page" : undefined} data-testid={p.testid} onClick={() => path !== p.path && nav(p.path, true)}>{p.label}</button>)}
            </nav>
            <div class={`setpane${path === "/settings" ? "" : " sub"}`} data-testid="settings-pane"><PaneCtx.Provider value={true}>{render(path)}</PaneCtx.Provider></div>
            <button class="rbtn setmodal-x" aria-label="Close settings" title="Close (Esc)" data-testid="settings-modal-close" onClick={closeOverlay}><IconClose /></button>
          </div>
        </div>
      )}
    </div>
  );
}
