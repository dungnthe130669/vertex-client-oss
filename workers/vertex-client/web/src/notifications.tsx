import { useEffect, useState } from "preact/hooks";
import { RootBar } from "./root-bar";
import { IconBell } from "./icons";
import { type Notif, badgeText, bellLabel, timeAgo } from "./notif-logic";
import { dismissToast, getState, loadMore, markAllRead, markRead, refresh, subscribe } from "./notif-store";

const go = (path: string) => { history.pushState({ fromApp: true }, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const useNotifs = () => { const [s, setS] = useState(getState()); useEffect(() => subscribe(setS), []); return s; };

/** Bell with the unread count. Opens /notifications. The count is also in the accessible name, so it is not colour/shape only. */
export function Bell({ class: cls = "icon" }: { class?: string }) {
  const { unread } = useNotifs();
  return (
    <button class={`${cls} bellbtn`} aria-label={bellLabel(unread)} title="Notifications" data-testid="notif-bell" onClick={() => go("/notifications")}>
      <IconBell />
      {unread > 0 && <span class="bellbadge" data-testid="notif-badge" aria-hidden="true">{badgeText(unread)}</span>}
    </button>
  );
}

/** Top-of-screen toasts for notifications that arrive while the app is open; auto-hide ~5 s (store), tap opens the url and marks it read. */
export function NotifToasts() {
  const { toasts } = useNotifs();
  const open = (n: Notif) => { dismissToast(n.id); void markRead([n.id]); go(n.url); };
  return (
    <div class="ntoasts" role="status" aria-live="polite" aria-relevant="additions" data-testid="notif-toasts">
      {toasts.map((n) => (
        <div class="ntoast" key={n.id} data-testid="notif-toast">
          <button class="ntoast-main" onClick={() => open(n)}><strong class="ellip">{n.title}</strong><span class="ellip">{n.body}</span></button>
          <button class="icon x" aria-label="Dismiss notification" onClick={() => dismissToast(n.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

/** History (/notifications): newest first, unread highlighted, tap = open + mark read, "Mark all read". */
export function NotificationsPage() {
  const { items, unread, loaded, next } = useNotifs();
  useEffect(() => { void refresh(); }, []);
  return (
    <div class="shell">
      <RootBar title="Notifications" titleClass="hdr-title ellip notif-title">
        <button class="btn small" data-testid="notif-mark-all" disabled={unread === 0} onClick={() => void markAllRead()}>Mark all read</button>
      </RootBar>
      <main class="page" aria-busy={!loaded}>
        {!loaded && <div class="skel block" />}
        {loaded && items.length === 0 && <div class="empty" data-testid="notif-empty"><p>No notifications yet</p><p class="muted small">Finished replies, cloud runs and approval requests will show up here.</p></div>}
        {items.length > 0 && (
          <ul class="nlist" aria-label="Notification history">
            {items.map((n) => (
              <li key={n.id}>
                <button class={`nrow${n.read ? "" : " unread"}`} data-testid="notif-row" data-unread={n.read ? "0" : "1"} onClick={() => { void markRead([n.id]); go(n.url); }}>
                  <span class="ndot" aria-hidden="true" />
                  <span class="nbody">
                    <span class="ntitle ellip">{n.title}{!n.read && <span class="sr"> (unread)</span>}</span>
                    <span class="ntext">{n.body}</span>
                    <span class="muted small">{timeAgo(n.ts)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {next !== null && <button class="btn" data-testid="notif-more" onClick={() => void loadMore()}>Show older</button>}
      </main>
    </div>
  );
}
