import { ModeTabs } from "./tabs";
import { MenuButton } from "./drawer";
import { IconChart, IconSettings } from "./icons";
import { BackButton } from "./root-bar";
import { Bell } from "./notifications";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
type Mode = "chat" | "cloud" | "agents" | "desktop" | "remote";

/** Header of the five mode list screens. >767px: tabs + Usage + Settings inline (unchanged). <=640px: round hamburger (opens the
 *  drawer that holds every action) + the title (CSS swaps which half is shown; see .hdr-inline / .hdr-menu-btn). */
export function ListBar({ mode, title, onSettings }: { mode: Mode; title: string; onSettings: () => void }) {
  return (
    <header class="bar bar-lift">
      <MenuButton class="hdr-menu-btn" />
      <BackButton />
      <h1 class="sr hdr-title">{title}</h1>
      <div class="hdr-inline">
        <ModeTabs mode={mode} />
        <Bell />
        <button class="icon" aria-label="Usage" title="Usage" onClick={() => go("/usage")}><IconChart /></button>
        <button class="icon" aria-label="Settings" title="Settings" onClick={onSettings}><IconSettings /></button>
      </div>
    </header>
  );
}
