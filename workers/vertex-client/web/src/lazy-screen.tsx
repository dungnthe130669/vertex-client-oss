import { Component, type ComponentChildren, type ComponentType } from "preact";
import { Suspense, lazy } from "preact/compat";

// Code-split screens: the heavy / rarely-opened ones load on first visit instead of in the main bundle.
// Fallback = the same skeleton blocks the screens themselves show while their data loads, so the swap is not a flash of something else.
// A chunk that cannot load (offline on a screen never opened before) must not blank the app: the boundary shows a retry instead.

export function ScreenSkeleton() {
  return <div class="shell screen-skel"><main class="page" aria-busy="true" aria-label="Loading"><div class="skel block" /><div class="skel block" /><div class="skel block" /></main></div>;
}

class ScreenBoundary extends Component<{ children?: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main class="center" data-testid="screen-error" role="alert">
        <h2>Couldn't load this screen</h2>
        <p class="muted">Check your connection, then try again.</p>
        <button class="btn primary" onClick={() => location.reload()}>Reload</button>
      </main>
    );
  }
}

/** lazyScreen(() => import("./cloud").then((m) => m.CloudList)) -> a component that renders the skeleton, then the screen. */
export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const L = lazy(() => load().then((c) => ({ default: c })));
  return (props: P) => <ScreenBoundary><Suspense fallback={<ScreenSkeleton />}><L {...(props as any)} /></Suspense></ScreenBoundary>;
}

/** After first paint, fetch these chunks when the browser is idle so the first click is not a skeleton. A failed preload is silent: the real navigation retries and the boundary handles it. */
export function preloadWhenIdle(loaders: Array<() => Promise<unknown>>) {
  if (typeof window === "undefined") return;
  const run = () => { for (const l of loaders) void l().catch(() => {}); };
  const ric = (window as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const start = () => (ric ? ric(run, { timeout: 5000 }) : setTimeout(run, 2000));
  if (document.readyState === "complete") start(); else addEventListener("load", start, { once: true });
}
