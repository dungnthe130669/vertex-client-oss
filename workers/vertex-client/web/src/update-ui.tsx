import { useEffect } from "preact/hooks";
import { dismissNotice, refreshBuild, retryUpdate, useUpdate } from "./update";
import { noticeVisible, shortBuild } from "./update-logic";

const openAbout = () => { history.pushState({ fromApp: true }, "", "/about"); dispatchEvent(new PopStateEvent("popstate")); };

/** Updates are silent. This renders ONLY when a background update has failed (twice, with backoff): one small fixed notice, dismissable for the session. Never on success, never "available"/"updating". */
export function UpdateBanner() {
  const u = useUpdate();
  if (!noticeVisible(u.failure, u.noticeDismissed)) return null;
  return (
    <div class="update-notice" role="status" data-testid="update-failed">
      <span>Update failed</span>
      <button class="btn small" data-testid="update-retry" onClick={retryUpdate}>Retry</button>
      <button class="linkbtn" data-testid="update-details" onClick={openAbout}>Details in About</button>
      <button class="icon x" aria-label="Dismiss" title="Dismiss" data-testid="update-dismiss" onClick={dismissNotice}>×</button>
    </div>
  );
}

/** Build id of the running app, for the menu footer and Settings. */
export function useBuild(): string | null {
  const u = useUpdate();
  useEffect(() => { void refreshBuild(); }, []);
  return u.build;
}
export const VersionLine = () => <div class="menu-ver muted small" data-testid="menu-version">Version {shortBuild(useBuild())}</div>;
