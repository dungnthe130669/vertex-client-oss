import { withBusy } from "./busy";
import { useContext, useEffect, useState } from "preact/hooks";
import { MeCtx } from "./drawer";
import { type Me, type Model, getAutoMaxUsd, getAutoShadow, getChatImages, getModels, getOpenFailover, getOpenFailoverAistudio, getUsage, putOpenFailover, putOpenFailoverAistudio, putAutoMaxUsd, putAutoShadow, putChatImages } from "./api";
import { VersionSetting } from "./about";
import { THEME_LABEL, THEME_MODES, useTheme } from "./theme";
import { errorToast, toast } from "./toast";
import { type PushState, disablePush, enablePush, pushState, sendTestPush } from "./push";
import { IconBell, IconBolt, IconBranch, IconChart, IconChat, IconChevron, IconClose, IconCloud, IconCoin, IconFile, IconImage, IconInfo, IconModels, IconPlug, IconShield, IconSignOut, IconSlash, IconSwap, IconTheme, IconTool, IconUser } from "./icons";
import { useNickname } from "./profile";
import { initials } from "./shell-logic";
import { routeCounts, shortModel } from "./auto-ui";
import { SPACE_LABEL, hasOpen } from "./space-ui";
import { getSpace } from "./space";
import { DevicesRow } from "./devices";
import { ThisDeviceRow } from "./this-device";
import { PaneCtx } from "./pane-ctx";
import { setFailoverState } from "./failover-state";

const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const goApp = (path: string) => { history.pushState({ fromApp: true }, "", path); dispatchEvent(new PopStateEvent("popstate")); };

/** Settings (/settings): grouped cards (Account / App / Models / About), close X top-left, title centred, About "i" top-right. */
export function Settings({ me, onBack, onSignOut }: { me: Me; onBack: () => void; onSignOut: () => void }) {
  const [models, setModels] = useState<Model[] | null>(null);
  const [def, setDef] = useState("");
  const [err, setErr] = useState("");
  const load = () => {
    setErr("");
    void getModels().then((r) => {
      if (r.status === 200 && r.data?.models) { setModels(r.data.models); setDef(r.data.default); }
      else setErr(r.data?.error ?? `Could not load models (${r.status})`);
    }).catch(() => setErr("Could not load models (offline?)"));
  };
  useEffect(load, []);
  const nickname = useNickname();
  const pane = useContext(PaneCtx); // desktop modal: panes are in the left nav, so their rows are not repeated here
  const defLabel = models?.find((m) => m.id === def)?.meta?.label ?? def;
  const split = hasOpen(me); // two spaces: Providers move to a shared "Credentials" section, the rest is labelled with the space being edited
  const spaceName = SPACE_LABEL[getSpace()];
  const providersRow = !pane && (me.team !== true || hasOpen(me)) && <button class="srow" data-testid="open-providers" onClick={() => goApp("/settings/providers")}><IconModels /><span class="srow-l">Providers</span><IconChevron /></button>;
  const cloudflareRow = (me.team !== true || hasOpen(me)) && <button class="srow" data-testid="open-cloudflare" onClick={() => goApp("/settings/cloudflare")}><IconCloud /><span class="srow-l">Cloudflare</span><IconChevron /></button>;
  return (
    <div class="shell">
      <header class="bar sheetbar">
        <button class="rbtn" aria-label="Close" title="Close" data-testid="settings-close" onClick={onBack}><IconClose /></button>
        <h2 class="title title-c">Settings</h2>
        <button class="rbtn" aria-label="About" title="About" data-testid="settings-about" onClick={() => goApp("/about")}><IconInfo /></button>
      </header>
      <main class="page settings">
        <section aria-labelledby="sg-account">
          <h3 class="sg-title" id="sg-account">Account</h3>
          <div class="scard">
            <div class="srow static">
              <span class="avatar sm" aria-hidden="true">{initials(me.user)}</span>
              <span class="srow-l"><span class="muted small block">Signed in as</span> <strong>{me.user}</strong> <span class="muted small">({me.via})</span></span>
            </div>
            <button class="srow" data-testid="sign-out" onClick={onSignOut}><IconSignOut /><span class="srow-l">Sign out</span></button>
          </div>
        </section>
        {split && (
          <section aria-labelledby="sg-cred" data-testid="settings-credentials">
            <h3 class="sg-title" id="sg-cred">Credentials (shared)</h3>
            <div class="scard">
              {providersRow}{cloudflareRow}
              <div class="srow static"><span class="srow-l"><span class="muted small block">Shared by both spaces; used by Open.{me.team === true ? " Managed by an administrator." : ""}</span></span></div>
            </div>
          </section>
        )}
        <section aria-labelledby="sg-prefs">
          <h3 class="sg-title" id="sg-prefs">{split ? <>This space <span class="space-tag" data-testid="settings-space-label">{spaceName}</span>: Preferences</> : "Preferences"}</h3>
          <div class="scard">
            {!pane && <button class="srow" data-testid="open-profile" onClick={() => goApp("/settings/profile")}><IconUser /><span class="srow-l">Profile</span><span class="srow-v" data-testid="profile-value">{nickname}</span><IconChevron /></button>}
            <ChatImagesSetting />
            <AutoModelInfo />
            <AutoCeilingSetting />
            <AutoShadowSetting />
            {getSpace() === "open" && <OpenFailoverSetting />}
            {getSpace() === "open" && <OpenFailoverAistudioSetting />}
            {!pane && <button class="srow" data-testid="open-appearance" onClick={() => goApp("/settings/appearance")}><IconTheme /><span class="srow-l">Appearance</span><IconChevron /></button>}
            {!pane && <button class="srow" data-testid="open-subagents" onClick={() => goApp("/settings/subagents")}><IconBranch /><span class="srow-l">Subagents</span><span class="srow-v">Helpers the chat can delegate to</span><IconChevron /></button>}
            {!pane && <button class="srow" data-testid="open-prompts" onClick={() => goApp("/settings/prompts")}><IconChat /><span class="srow-l">Prompts</span><IconChevron /></button>}
            {!pane && me.erichOnly === true && me.team !== true && getSpace() === "biz" && <DevicesRow onOpen={() => goApp("/settings/devices")} />}
            {!pane && me.team !== true && <ThisDeviceRow onOpen={() => goApp("/settings/this-device")} />}
            {!pane && hasOpen(me) && <button class="srow" data-testid="open-approvals" onClick={() => goApp("/settings/approvals")}><IconShield /><span class="srow-l">Approvals</span><span class="srow-v">Always-allowed websites</span><IconChevron /></button>}
            {!split && providersRow}
            {!pane && me.team !== true && <button class="srow" data-testid="open-capabilities" onClick={() => goApp("/settings/capabilities")}><IconTool /><span class="srow-l">Capabilities</span><IconChevron /></button>}
          </div>
        </section>
        <section aria-labelledby="sg-app">
          <h3 class="sg-title" id="sg-app">{split ? <>This space <span class="space-tag">{spaceName}</span>: Tools &amp; usage</> : "App"}</h3>
          <div class="scard">
            <ThemeSetting />
            <Notifications />
            {!pane && me.team !== true && <button class="srow" data-testid="open-skills" onClick={() => go("/skills")}><IconSlash /><span class="srow-l">Skills</span><span class="srow-v">Slash commands</span><IconChevron /></button>}
            {!pane && me.team !== true && <button class="srow" data-testid="open-connectors" onClick={() => go("/connectors")}><IconPlug /><span class="srow-l">Connectors</span><IconChevron /></button>}
            {!pane && <button class="srow" data-testid="open-usage" onClick={() => go("/usage")}><IconChart /><span class="srow-l">Usage &amp; costs</span><IconChevron /></button>}
          </div>
        </section>
        <section aria-labelledby="sg-models">
          <h3 class="sg-title" id="sg-models">Models</h3>
          <div class="scard">
            <div class="srow static"><IconModels /><span class="srow-l">Default model</span><span class="srow-v">{defLabel || "…"}</span></div>
            {err && <div class="srow static col"><p class="error">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
            {!models && !err && <div class="srow static col" aria-busy="true"><div class="skel line wide" /><div class="skel line" /></div>}
            {models && (
              <ul class="models">
                {models.map((m) => (
                  <li>
                    <div><strong>{m.meta?.label ?? m.name}</strong>{m.id === def && <span class="badge">default</span>}</div>
                    <div class="muted small">{m.id}{m.meta?.price ? ` · $${m.meta.price.input}/${m.meta.price.output} per Mtok` : " · unrated"}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section aria-labelledby="sg-about">
          <h3 class="sg-title" id="sg-about">About</h3>
          <VersionSetting />
        </section>
      </main>
    </div>
  );
}

function Notifications() {
  const [st, setSt] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => { void pushState().then(setSt).catch(() => setSt({ kind: "unsupported", reason: "Could not check notification support." })); };
  useEffect(refresh, []);
  // Permission is requested ONLY here, from the tap on the button (iOS requires a user gesture).
  const openSpaces = hasOpen(useContext(MeCtx));
  const turnOn = async () => { setBusy(true); try { const r = await withBusy("push-enable", enablePush); if (r.ok) toast("Notifications enabled."); else errorToast(r.error, turnOn); } catch (e) { errorToast(e instanceof Error ? e.message : "Could not enable notifications", turnOn); } setBusy(false); refresh(); };
  const turnOff = async () => { setBusy(true); try { await withBusy("push-disable", disablePush); toast("Notifications turned off."); } catch { errorToast("Could not turn off notifications", turnOff); } setBusy(false); refresh(); };
  const test = async () => { setBusy(true); const r = await withBusy("push-test", sendTestPush).catch(() => null); setBusy(false); if (r?.status === 200 && r.data && r.data.sent > 0) toast("Test notification sent."); else errorToast(`Test push failed${r?.data?.errors?.length ? `: ${r.data.errors[0]}` : ""}`, test); };
  const spaceNote = hasOpen(useContext(MeCtx)) ? " This device's notifications go to the space where you enabled them." : "";
  const note = !st ? null
    : st.kind === "unsupported" || st.kind === "needs-install" ? st.reason
    : st.kind === "not-configured" ? "Push is not configured on the server."
    : st.kind === "denied" ? "Notifications are blocked for this site. Enable them in your browser / iOS Settings → Notifications, then come back."
    : st.kind === "off" ? "Get a notification when a reply finishes while the app is closed or in the background." + spaceNote : null;
  return (
    <div class="srow static col" data-testid="notifications">
      <div class="srow-top"><IconBell /><span class="srow-l">Push alerts on this device</span><span class="srow-v">{!st ? "" : st.kind === "on" ? "On" : st.kind === "off" ? "Off" : "Unavailable"}</span></div>
      {!st && <div class="skel line" aria-busy="true" />}
      {note && <p class="muted small srow-note">{note}</p>}
      {openSpaces && <p class="muted small srow-note" data-testid="push-space-note">This device gets notifications for one space at a time: the one that was active when you last turned them on. To switch, open the other space and turn notifications on again.</p>}
      {st?.kind === "off" && <div class="actions srow-note"><button class="btn primary" disabled={busy} onClick={turnOn}>Enable notifications</button></div>}
      {st?.kind === "on" && <div class="actions srow-note"><button class="btn" disabled={busy} onClick={test}>Send test</button><button class="btn" disabled={busy} onClick={turnOff}>Turn off</button></div>}
    </div>
  );
}

function ThemeSetting() {
  const [theme, setTheme] = useTheme();
  return (
    <div class="srow static col" data-testid="theme-setting">
      <div class="srow-top"><IconTheme /><span class="srow-l">Theme</span><span class="srow-v">{theme === "auto" ? "Follows your device" : ""}</span></div>
      <div class="seg themeseg srow-note" role="group" aria-label="Theme">
        {THEME_MODES.map((m) => <button key={m} aria-pressed={theme === m} data-testid={`theme-${m}`} onClick={() => setTheme(m)}>{THEME_LABEL[m]}</button>)}
      </div>
    </div>
  );
}

/** Settings > General: what Auto is, and how it chose over the last 30 days (applied routes only; the shadow records are a separate thing). */
function AutoModelInfo() {
  const [rows, setRows] = useState<Array<{ model: string; n: number; fallback: number }> | null>(null);
  useEffect(() => { void getUsage().then((r) => { if (r.status === 200 && r.data) setRows(routeCounts(r.data.byRoute)); }).catch(() => {}); }, []);
  return (
    <div class="srow static" data-testid="auto-info">
      <IconBolt /><span class="srow-l"><span>Auto model</span>
        <span class="muted small block">Pick "Auto" in a chat's model list and it chooses the model and thinking effort for each message: short chats go to Haiku, code and documents to Sonnet, deep design or proofs to Opus. It is never the default, and a chat only uses it when you pick it. Each answer shows what was used; "Retry with…" re-runs one answer on a model you choose, and "Pin this model" leaves Auto.</span>
        {rows && rows.length > 0 && <><span class="muted small block">Last 30 days, messages by model Auto chose:</span>
          <ul class="auto-counts small" data-testid="auto-counts">{rows.map((r) => <li key={r.model}><span>{shortModel(r.model)}</span><span class="num">{r.n}{r.fallback ? ` (${r.fallback} after a fallback)` : ""}</span></li>)}</ul></>}
        {rows && rows.length === 0 && <span class="muted small block" data-testid="auto-counts-empty">No Auto messages in the last 30 days.</span>}
      </span>
    </div>
  );
}

/** Settings > General: optional per-message spend ceiling for Auto (an estimate). Empty = none (default). */
function AutoCeilingSetting() {
  const [saved, setSaved] = useState<number | null | undefined>(undefined);
  const [val, setVal] = useState("");
  useEffect(() => { void getAutoMaxUsd().then((r) => { if (r.status === 200 && r.data) { setSaved(r.data.usd); setVal(r.data.usd === null ? "" : String(r.data.usd)); } }).catch(() => {}); }, []);
  if (saved === undefined) return null;
  const save = async () => {
    const t = val.trim(), n = t === "" ? null : Number(t);
    if (n !== null && !(Number.isFinite(n) && n > 0 && n <= 1000)) { errorToast("Enter a positive dollar amount, or leave empty for none"); return; }
    if (n === saved) return;
    const r = await withBusy("auto-ceiling", () => putAutoMaxUsd(n)).catch(() => null);
    if (r?.status === 200) { setSaved(n); toast(n === null ? "Auto has no spend ceiling." : `Auto ceiling set to $${n} per message (estimate).`); } else errorToast("Could not save", save);
  };
  return (
    <div class="srow static" data-testid="auto-ceiling-setting">
      <IconCoin /><span class="srow-l"><label id="auto-ceiling-l" for="auto-ceiling-input">Auto spend ceiling (optional)</label><span class="muted small block">Optional per-message spend ceiling for Auto, estimate; empty = none. When every model is over it, Auto uses the cheapest one that fits and says so; it never refuses your message.</span></span>
      <span class="row-inline"><span class="muted">$</span><input id="auto-ceiling-input" type="text" inputmode="decimal" size={6} placeholder="none" value={val} data-testid="auto-ceiling-input" aria-labelledby="auto-ceiling-l" onInput={(e) => setVal((e.currentTarget as HTMLInputElement).value)} onBlur={() => void save()} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} /></span>
    </div>
  );
}

/** Settings > General "Auto model (shadow, records only)": per scope, default OFF. Records the router's pick on usage rows; the model that runs never changes. */
/** Open: separate opt-in for Google AI Studio as an automatic fallback (default OFF: with it off a failing model is never replaced by a Google model). */
function OpenFailoverAistudioSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  // v1: the server says `available: false` (AI Studio is not an automatic target at all): no setting that does nothing is shown
  useEffect(() => { void getOpenFailoverAistudio().then((r) => { if (r.status === 200 && r.data && r.data.available === true) setOn(r.data.enabled); }).catch(() => {}); }, []);
  if (on === null) return null;
  const flip = async () => {
    const next = !on;
    const r = await withBusy("open-failover-aistudio", () => putOpenFailoverAistudio(next)).catch(() => null);
    if (r?.status === 200) { setOn(next); setFailoverState({ aistudio: next }); toast(next ? "Google AI Studio may answer when other models fail." : "Google AI Studio is never used as an automatic fallback."); } else errorToast("Could not save", flip);
  };
  return (
    <div class="srow static" data-testid="open-failover-aistudio-setting">
      <IconSwap /><span class="srow-l"><label id="open-failover-aistudio-l">Allow Google AI Studio as an automatic fallback</label><span class="muted small block">Google may use your conversation to improve its products. Off: a failing model is never replaced by a Google model. Needs your own AI Studio key.</span></span>
      <button type="button" role="switch" class={`switch${on ? " on" : ""}`} aria-checked={on} aria-labelledby="open-failover-aistudio-l" data-testid="open-failover-aistudio-toggle" onClick={() => void flip()}><span class="knob" /></button>
    </div>
  );
}

/** Open: "Auto-switch models when one fails", default ON. Business is unaffected (it has its own Auto). */
export const FAILOVER_PRIVACY = "If a model fails, this chat (including its history) may be sent to another Open provider (NVIDIA, Groq...). Each provider has its own data policy.";
function OpenFailoverSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  useEffect(() => { void getModels().then((r) => setNotices(r.data?.providerNotices ?? {})).catch(() => {}); }, []);
  useEffect(() => { void getOpenFailover().then((r) => { if (r.status === 200 && r.data) setOn(r.data.enabled); }).catch(() => {}); }, []);
  if (on === null) return null;
  const flip = async () => {
    const next = !on;
    const r = await withBusy("open-failover", () => putOpenFailover(next)).catch(() => null);
    if (r?.status === 200) { setOn(next); setFailoverState({ failover: next }); toast(next ? "A failing model is replaced by the next one automatically." : "Models are no longer switched automatically."); } else errorToast("Could not save", flip);
  };
  return (
    <div class="srow static" data-testid="open-failover-setting">
      <IconSwap /><span class="srow-l"><label id="open-failover-l">Auto-switch models when one fails</label><span class="muted small block" data-testid="open-failover-privacy">{FAILOVER_PRIVACY} The message tells you which provider answered. Never leaves Open.</span>
        {Object.keys(notices).length > 0 && <ul class="muted small block" data-testid="open-failover-notices">{Object.entries(notices).map(([p, n]) => <li key={p}><b>{p}</b>: {n}</li>)}</ul>}</span>
      <button type="button" role="switch" class={`switch${on ? " on" : ""}`} aria-checked={on} aria-labelledby="open-failover-l" data-testid="open-failover-toggle" onClick={() => void flip()}><span class="knob" /></button>
    </div>
  );
}

function AutoShadowSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void getAutoShadow().then((r) => { if (r.status === 200 && r.data) setOn(r.data.enabled); }).catch(() => {}); }, []);
  if (on === null) return null;
  const flip = async () => {
    const next = !on;
    const r = await withBusy("auto-shadow", () => putAutoShadow(next)).catch(() => null);
    if (r?.status === 200) { setOn(next); toast(next ? "Auto model will record its pick (shadow). Your model still runs." : "Auto model recording is off."); } else errorToast("Could not save", flip);
  };
  return (
    <div class="srow static" data-testid="auto-shadow-setting">
      <IconFile /><span class="srow-l"><label id="auto-shadow-l">Auto model (shadow, records only)</label><span class="muted small block">Notes which model Auto would pick for each message. It never changes the model that answers.</span></span>
      <button type="button" role="switch" class={`switch${on ? " on" : ""}`} aria-checked={on} aria-labelledby="auto-shadow-l" data-testid="auto-shadow-toggle" onClick={() => void flip()}><span class="knob" /></button>
    </div>
  );
}

/** Settings > General "Let chat create images": per scope, default ON. Hidden when this user cannot generate images at all (e.g. a team user without image_gen). */
function ChatImagesSetting() {
  const [st, setSt] = useState<{ enabled: boolean; available: boolean } | null>(null);
  useEffect(() => { void getChatImages().then((r) => { if (r.status === 200 && r.data) setSt(r.data); }).catch(() => {}); }, []);
  if (!st || !st.available) return null;
  const flip = async () => {
    const next = !st.enabled;
    const r = await withBusy("chat-images", () => putChatImages(next)).catch(() => null);
    if (r?.status === 200) { setSt({ ...st, enabled: next }); toast(next ? "Chat can create images (new chats)." : "Chat will not create images (new chats)."); } else errorToast("Could not save", flip);
  };
  return (
    <div class="srow static" data-testid="chat-images-setting">
      <IconImage /><span class="srow-l"><label id="chat-images-l">Let chat create images</label><span class="muted small block">Applies to new chats. Costs are checked before anything is generated.</span></span>
      <button type="button" role="switch" class={`switch${st.enabled ? " on" : ""}`} aria-checked={st.enabled} aria-labelledby="chat-images-l" data-testid="chat-images-toggle" onClick={() => void flip()}><span class="knob" /></button>
    </div>
  );
}
