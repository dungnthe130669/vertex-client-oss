/** Inline note shown when cached pane data is on screen but the quiet refresh failed. */
export function StaleNote({ onRetry }: { onRetry: () => void }) {
  return <p class="muted small" role="status" data-testid="stale-note">Showing saved data - couldn't refresh. <button class="btn" onClick={onRetry}>Retry</button></p>;
}
