import { MenuButton } from "./drawer";
import { IconBack } from "./icons";
import { backAction, inNativeShell } from "./shell-logic";
import { useDesktop } from "./media";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };

/** Back for a top-level screen, native shells only (a browser has its own Back button). Same round .rbtn as every detail screen's Back. */
export function BackButton() {
  if (useDesktop()) return null; // >=1024px: the app bar (desk.tsx) draws Back for top-level screens
  return <RootBack />;
}
/** The Back button itself (also drawn by the desktop app bar). */
export function RootBack() {
  if (!inNativeShell()) return null;
  const back = () => (backAction(history.state) === "history" ? history.back() : go("/"));
  return <button class="rbtn hdr-back" aria-label="Back" title="Back" data-testid="root-back" onClick={back}><IconBack /></button>;
}

/** Shared header of the top-level screens that are not one of the five mode lists (Library, Projects, Notifications, ...): menu button whenever the
 *  sidebar is not on screen (<1024px, see .hdr-menu-btn), Back in the native shells, then the title (+ optional right-hand actions). */
export function RootBar({ title, titleClass = "title", children }: { title: string; titleClass?: string; children?: preact.ComponentChildren }) {
  return (
    <header class={`bar${children ? "" : " bar-lift"}`}>
      <MenuButton class="hdr-menu-btn" />
      <BackButton />
      <h1 class={titleClass}>{title}</h1>
      {children}
    </header>
  );
}
