import { useContext, useEffect, useState } from "preact/hooks";
import { MeCtx } from "./drawer";
import { getOpenFailover, getOpenFailoverAistudio, type Me } from "./api";
import { type Space, getSpace, switchSpace } from "./space";
import { failoverBanner, failoverState, refreshFailover, subscribeFailover } from "./failover-state";
export { FAILOVER_BANNER, failoverBanner } from "./failover-state";

export const SPACE_LABEL: Record<Space, string> = { biz: "Business", open: "Open" };
/** The switcher exists only when the server says this user has both spaces: everyone else sees exactly today's UI. */
export const hasOpen = (me: Me | null | undefined) => !!me?.spaces && me.spaces.length > 1 && me.spaces.includes("open");

/** Two-segment control, 44px targets, full width. The server decides; this only asks. */
export function SpaceSwitcher() {
  const me = useContext(MeCtx);
  if (!hasOpen(me)) return null;
  const cur = getSpace();
  return (
    <div class="space-switch" data-testid="space-switcher">
      <div class="space-seg" role="group" aria-label="Space">
        {(["biz", "open"] as const).map((s) => <button key={s} type="button" class="space-opt" aria-pressed={cur === s} data-testid={`space-${s}`} onClick={() => switchSpace(s)}>{SPACE_LABEL[s]}</button>)}
      </div>
      {cur === "open" && <p class="space-note muted small" data-testid="space-note">Open: not Vertex. Other providers, separate chats. If a model fails, the chat may be sent to another Open provider.</p>}
    </div>
  );
}

/** The always-visible Open composer line about failover. Shown from the first render of an Open chat, hidden only once the server confirmed failover OFF; refreshed on focus and whenever a Settings toggle changes. */
export function FailoverNote() {
  const [st, setSt] = useState(failoverState());
  const open = getSpace() === "open";
  useEffect(() => {
    if (!open) return;
    const un = subscribeFailover(setSt), load = () => void refreshFailover({ failover: getOpenFailover, aistudio: getOpenFailoverAistudio });
    setSt(failoverState()); load(); addEventListener("focus", load);
    return () => { un(); removeEventListener("focus", load); };
  }, [open]);
  const t = open ? failoverBanner(st.failover, st.aistudio) : "";
  return t ? <p class="muted small failover-note" role="note" data-testid="failover-note">{t}</p> : null;
}

/** Chat header chip so the active space is visible without opening the drawer. Business shows nothing (as today). */
export function SpaceChip() {
  const me = useContext(MeCtx);
  if (!hasOpen(me) || getSpace() !== "open") return null;
  return <span class="chip space-chip" data-testid="space-chip">Open</span>;
}

/** 6.4: Open with no usable model. Erich-type users can fix it in Settings; a team user cannot, so no pointer to credentials they cannot manage. */
export function OpenEmpty({ me }: { me: Me | null }) {
  const canAdd = me?.team !== true;
  const go = () => { history.pushState({ fromApp: true }, "", "/settings/providers"); dispatchEvent(new PopStateEvent("popstate")); };
  return (
    <div class="hello open-empty" data-testid="open-empty">
      <h2>Open space</h2>
      <p class="muted">Chat with other providers. Your Business chats are not visible here.</p>
      {canAdd ? <button type="button" class="btn primary" data-testid="open-empty-cta" onClick={go}>Add a provider</button>
        : <p class="muted" data-testid="open-empty-none">No providers are available for your account</p>}
    </div>
  );
}
