import { BIZ_ONLY_MODES, getSpace } from "./space";

const nav = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };

type Mode = "chat" | "cloud" | "agents" | "desktop" | "remote";
const ALL_TABS: Array<[Mode, string, string]> = [["chat", "Chats", "/chats"], ["cloud", "Cloud", "/cloud"], ["agents", "Agents", "/agents"], ["desktop", "Desktop", "/desktop"], ["remote", "Remote", "/remote"]];

export function ModeTabs({ mode }: { mode: Mode }) {
  const TABS = getSpace() === "open" ? ALL_TABS.filter((t) => !BIZ_ONLY_MODES.includes(t[0])) : ALL_TABS; // Business-only modes are not shown in Open
  // Roving tabindex + arrow keys (WAI-ARIA tabs): the selected tab is the one Tab stop; arrows / Home / End move and activate.
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t[0] === mode);
    const j = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    nav(TABS[j][2]);
    queueMicrotask(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="tab-${TABS[j][0]}"]`)?.focus()));
  };
  return (
    <div class="tabs" role="tablist" aria-label="Mode" onKeyDown={onKey}>
      {TABS.map(([m, label, path]) => (
        <button key={m} class={`tab${mode === m ? " on" : ""}`} role="tab" aria-selected={mode === m} tabIndex={mode === m ? 0 : -1} data-testid={`tab-${m}`} onClick={() => mode !== m && nav(path)}>{label}</button>
      ))}
    </div>
  );
}
