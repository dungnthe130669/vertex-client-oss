import { setBusy, withBusy } from "./busy";
import { IconBack } from "./icons";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { MeCtx } from "./drawer";
import { type ApprovalsView, getAnswerLimit, putAnswerLimit, getApprovals, revokeAllApprovals, revokeApproval } from "./api";
import { SOURCE_NOTE, fmtDate } from "./approval-logic";
import { type CfAccountView, deleteCfAccount, getCfAccount, putCfAccount, testCfAccount, type ProfileData, type PromptRow, type ListedModel, type ProviderInfo, type ProviderPreset, createPrompt, deletePrompt, deleteProvider, deleteProviderKey, putProviderKey, getProfile, getProviderPresets, getProviders, loadProviderModels, putProvider, getSlash, listPrompts, putProfile, updatePrompt } from "./api";
import { DICT_LANGS, getDictLang, getWhisper, setDictLang, setWhisper } from "./dictation";
import { APPEARANCE_DEFAULTS, CODE_FONTS, CODE_FONT_LABEL, FONT_SIZES, FONT_SIZE_PX, TEXT_FONTS, TEXT_FONT_LABEL, useAppearance } from "./appearance";
import { keyBadge, keyNote, saveKeyFlow } from "./provider-key-logic";
import { CF_ACCOUNT_ID_HELP, CF_FREE_NOTE, CF_HELP, CF_PROVIDERS_NOTICE, cfBadge, cfUsing, linkError, testNote } from "./cf-account-logic";
import { setNickname } from "./profile";
import { paneToken, peekPane, putPane } from "./pane-cache";
import { StaleNote } from "./stale-note";
import { errorToast } from "./toast";
import { MAX_FULL_NAME, MAX_INSTRUCTIONS, MAX_NICKNAME } from "../../src/profile";
import { MAX_PROMPTS, MAX_PROMPT_TEXT, MAX_PROMPT_TITLE } from "../../src/prompts";
import type { SlashItem } from "../../src/slash";

const SAVE_DELAY_MS = 700;

/** Pushed settings screen: round back button left, centred title (same shell as Settings itself). */
function SubPage({ title, onBack, testid, children }: { title: string; onBack: () => void; testid: string; children: preact.ComponentChildren }) {
  return (
    <div class="shell">
      <header class="bar sheetbar">
        <button class="rbtn" aria-label="Back" title="Back" data-testid="subpage-back" onClick={onBack}><IconBack /></button>
        <h2 class="title title-c">{title}</h2>
        <span class="rbtn-spacer" aria-hidden="true" />
      </header>
      <main class="page settings" data-testid={testid}>{children}</main>
    </div>
  );
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** Profile (/settings/profile): full name, nickname, instructions. Auto-saves (debounced, no button); the save holds a busy key so an update never reloads under it. */
export function ProfilePage({ onBack }: { onBack: () => void }) {
  const team = useContext(MeCtx)?.team === true; // instructions only apply to Erich's chats (server refuses them for a team scope), so the section is hidden
  const [p, setP] = useState<ProfileData | null>(() => peekPane<ProfileData>("/api/profile")); // last data at once, refreshed quietly below
  const [loadErr, setLoadErr] = useState("");
  const [stale, setStale] = useState(false);
  const [save, setSave] = useState<SaveState>("idle");
  const latest = useRef<ProfileData | null>(p);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  const [dictLang, setDictLangState] = useState(getDictLang);
  const [whisper, setWhisperState] = useState(getWhisper);
  const load = () => {
    setLoadErr("");
    const tok = paneToken("/api/profile");
    void getProfile().then((r) => { if (r.status === 200 && r.data) { if (!dirty.current && putPane("/api/profile", r.data, tok)) { latest.current = r.data; setP(r.data); setNickname(r.data.nickname); setStale(false); } } else if (!latest.current) setLoadErr(`Could not load your profile (${r.status})`); else setStale(true); }).catch(() => { if (!latest.current) setLoadErr("Could not load your profile (offline?)"); else setStale(true); });
  };
  useEffect(load, []);
  const flush = async () => {
    clearTimeout(timer.current);
    const cur = latest.current;
    if (!cur || !dirty.current) return;
    dirty.current = false;
    setSave("saving");
    const tok = paneToken("/api/profile");
    const r = await withBusy("profile-save", () => putProfile(team ? { fullName: cur.fullName, nickname: cur.nickname } : cur)).catch(() => null);
    if (r?.status === 200 && r.data) { if (!putPane("/api/profile", r.data, tok)) return; setNickname(r.data.nickname); setStale(false); setSave(dirty.current ? "dirty" : "saved"); if (!dirty.current) setBusy("profile-draft", false); }
    else { dirty.current = true; setSave("error"); errorToast(r?.data?.error ?? "Could not save your profile", () => void flush()); }
  };
  const edit = (patch: Partial<ProfileData>) => {
    const next = { ...(latest.current as ProfileData), ...patch };
    latest.current = next; setP(next); dirty.current = true; setSave("dirty"); setBusy("profile-draft", true); // an unsaved edit must not be reloaded away by an app update
    clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };
  useEffect(() => () => { clearTimeout(timer.current); if (dirty.current) void flush(); else setBusy("profile-draft", false); }, []);
  const status = save === "saving" ? "Saving…" : save === "saved" ? "Saved" : save === "dirty" ? "Unsaved changes…" : save === "error" ? "Not saved. Retrying needs a tap on the toast." : "";
  return (
    <SubPage title="Profile" onBack={() => { void flush(); onBack(); }} testid="profile-page">
      {loadErr && <div><p class="error">{loadErr}</p><button class="btn" onClick={load}>Retry</button></div>}
      {stale && !loadErr && <StaleNote onRetry={load} />}
      {!p && !loadErr && <div aria-busy="true"><div class="skel block" /><div class="skel block" /></div>}
      {p && (
        <>
          <section aria-labelledby="pf-who">
            <h3 class="sg-title" id="pf-who">About you</h3>
            <div class="scard">
              <div class="sfield"><label for="pf-full">Full name</label>
                <input id="pf-full" data-testid="profile-fullname" type="text" maxLength={MAX_FULL_NAME} autocomplete="name" value={p.fullName} onInput={(e) => edit({ fullName: e.currentTarget.value })} onBlur={() => void flush()} /></div>
              <div class="sfield"><label for="pf-nick">What should the app call you?</label>
                <input id="pf-nick" data-testid="profile-nickname" type="text" maxLength={MAX_NICKNAME} autocomplete="nickname" value={p.nickname} onInput={(e) => edit({ nickname: e.currentTarget.value })} onBlur={() => void flush()} /></div>
            </div>
          </section>
          {!team && <section aria-labelledby="pf-instr">
            <h3 class="sg-title" id="pf-instr">Instructions</h3>
            <div class="scard">
              <div class="sfield"><label for="pf-ins">Added to the system prompt of every chat</label>
                <textarea id="pf-ins" data-testid="profile-instructions" maxLength={MAX_INSTRUCTIONS} placeholder="How you want replies to look, what you work on…" value={p.instructions} onInput={(e) => edit({ instructions: e.currentTarget.value })} onBlur={() => void flush()} />
                <span class={`count${p.instructions.length >= MAX_INSTRUCTIONS ? " over" : ""}`} data-testid="profile-count">{p.instructions.length} / {MAX_INSTRUCTIONS}</span></div>
            </div>
          </section>}
          <section aria-labelledby="pf-dict">
            <h3 class="sg-title" id="pf-dict">Voice dictation</h3>
            <div class="scard">
              <div class="sfield"><label for="pf-lang">Dictation language (this device)</label>
                <select id="pf-lang" data-testid="profile-dict-lang" value={dictLang} onChange={(e) => { setDictLangState(e.currentTarget.value); setDictLang(e.currentTarget.value); }}>
                  {DICT_LANGS.map(([v, l]) => <option value={v}>{l}</option>)}
                </select></div>
              <div class="srow static"><span class="srow-l">Voice: use Whisper (records audio, transcribes on our server)<span class="muted small block" id="pf-whisper-help">Off = your browser's built-in dictation (live text, free). On = records then sends the audio to Cloudflare Whisper; more accurate, works where browser dictation does not. Audio is not stored.</span></span>
                <button class="switch" role="switch" aria-checked={whisper} aria-label="Voice: use Whisper" aria-describedby="pf-whisper-help" data-testid="voice-whisper-toggle" onClick={() => { setWhisperState(!whisper); setWhisper(!whisper); }} /></div>
            </div>
          </section>
          <section aria-labelledby="pf-ans">
            <h3 class="sg-title" id="pf-ans">Answers</h3>
            <div class="scard"><AnswerLimitRow /></div>
          </section>
          <p class="sstatus" role="status" data-testid="profile-status">{status}</p>
          {!team && <p class="muted small caps-note">Instructions apply to Chat replies only. They sit below the built-in rules and never override tool approval.</p>}
        </>
      )}
    </SubPage>
  );
}

/** "Limit answer length" (Vertex models only): ON = the model's own cap (today's behaviour), OFF = models write as long as they can. The stored value is "default" / "off"; the edition default comes from the server. */
export function AnswerLimitRow() {
  const [limited, setLimited] = useState<boolean | "error" | null>(null);
  const load = () => {
    const fail = () => { setLimited("error"); errorToast("Could not load the answer-length setting", load); };
    void getAnswerLimit().then((r) => { if (r.status === 200 && r.data) setLimited(r.data.limit === "default"); else fail(); }).catch(fail);
  };
  useEffect(load, []);
  if (limited === null) return null;
  if (limited === "error") return (
    <div class="srow static" data-testid="answer-limit-setting">
      <span class="srow-l"><span id="answer-limit-l">Limit answer length</span><span class="error small block" role="alert" data-testid="answer-limit-error">Could not load this setting.</span></span>
      <button type="button" class="btn small" data-testid="answer-limit-retry" onClick={() => { setLimited(null); load(); }}>Retry</button>
    </div>
  );
  const flip = async () => {
    const next = !limited;
    const r = await withBusy("answer-limit", () => putAnswerLimit(next ? "default" : "off")).catch(() => null);
    if (r?.status === 200) setLimited(next); else errorToast("Could not save", flip);
  };
  return (
    <div class="srow static" data-testid="answer-limit-setting">
      <span class="srow-l"><label id="answer-limit-l">Limit answer length</label><span class="muted small block" id="answer-limit-help">Off = models write as long as they can (Vertex models only). Long answers use more tokens. New messages pick up the change.</span></span>
      <button type="button" role="switch" class={`switch${limited ? " on" : ""}`} aria-checked={limited} aria-labelledby="answer-limit-l" aria-describedby="answer-limit-help" data-testid="answer-limit-toggle" onClick={() => void flip()} />
    </div>
  );
}

function Switch({ on, label, testid, onChange }: { on: boolean; label: string; testid: string; onChange: (v: boolean) => void }) {
  return <button class="switch" role="switch" aria-checked={on} aria-label={label} data-testid={testid} onClick={() => onChange(!on)} />;
}

/** Appearance (/settings/appearance): client-only reading options (localStorage via appearance.js, applied as data-* on <html> before first paint). */
export function AppearancePage({ onBack }: { onBack: () => void }) {
  const [a, set] = useAppearance();
  return (
    <SubPage title="Appearance" onBack={onBack} testid="appearance-page">
      <section aria-labelledby="ap-text">
        <h3 class="sg-title" id="ap-text">Transcript</h3>
        <div class="scard noic">
          <div class="sample" data-testid="appearance-sample">
            Sample reply text in your chosen font and size.
            <pre tabIndex={0}><code>{"const total = items.map((i) => i.price).reduce((a, b) => a + b, 0); // long lines wrap or scroll"}</code></pre>
          </div>
          <div class="srow static col">
            <div class="srow-top"><span class="srow-l">Font size</span><span class="srow-v" data-testid="font-size-value">{FONT_SIZE_PX[a.fs]} px</span></div>
            <input class="range" type="range" min={FONT_SIZES[0]} max={FONT_SIZES[FONT_SIZES.length - 1]} step={1} value={a.fs} aria-label="Transcript font size" data-testid="font-size" onInput={(e) => set({ fs: Number(e.currentTarget.value) })} />
            <div class="range-ends" aria-hidden="true"><span class="a-sm">A</span><span class="a-lg">A</span></div>
          </div>
          <div class="srow static col">
            <div class="srow-top"><span class="srow-l">Transcript font</span></div>
            <div class="seg srow-note" role="group" aria-label="Transcript font">
              {TEXT_FONTS.map((f) => <button key={f} aria-pressed={a.tf === f} data-testid={`tf-${f}`} onClick={() => set({ tf: f })}>{TEXT_FONT_LABEL[f]}</button>)}
            </div>
          </div>
        </div>
      </section>
      <section aria-labelledby="ap-code">
        <h3 class="sg-title" id="ap-code">Code</h3>
        <div class="scard noic">
          <div class="srow static col">
            <div class="srow-top"><span class="srow-l">Code font</span></div>
            <div class="seg srow-note" role="group" aria-label="Code font">
              {CODE_FONTS.map((f) => <button key={f} aria-pressed={a.cf === f} data-testid={`cf-${f}`} onClick={() => set({ cf: f })}>{CODE_FONT_LABEL[f]}</button>)}
            </div>
          </div>
          <div class="srow static"><span class="srow-l">Truncate long lines<span class="muted small block">Wrap code lines instead of scrolling sideways</span></span><Switch on={a.wrap} label="Truncate long lines" testid="code-wrap" onChange={(v) => set({ wrap: v })} /></div>
        </div>
      </section>
      <div class="sbtn-row"><button class="btn" data-testid="appearance-reset" onClick={() => set({ ...APPEARANCE_DEFAULTS })}>Reset to defaults</button></div>
    </SubPage>
  );
}

/** Capabilities (/settings/capabilities): read-only. The app has no real per-feature switches yet (tools are always offered, approval is fixed per tool), so this lists what Chat can do. */
export function CapabilitiesPage({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<SlashItem[] | null>(() => peekPane<SlashItem[]>("/api/slash"));
  const [err, setErr] = useState("");
  const [stale, setStale] = useState(false);
  const load = () => { setErr(""); const tok = paneToken("/api/slash"); void getSlash().then((r) => { if (r.status === 200 && r.data) { if (putPane("/api/slash", r.data.items, tok)) { setItems(r.data.items); setStale(false); } } else if (!items) setErr(`Could not load tools (${r.status})`); else setStale(true); }).catch(() => { if (!items) setErr("Could not load tools (offline?)"); else setStale(true); }); };
  useEffect(load, []);
  const tools = items?.filter((i) => i.kind === "tool") ?? [];
  return (
    <SubPage title="Capabilities" onBack={onBack} testid="capabilities-page">
      <p class="muted small caps-note">What Chat can do right now. There is nothing to switch here: these are fixed by the app, so this page only shows them.</p>
      <section aria-labelledby="cp-tools">
        <h3 class="sg-title" id="cp-tools">Tools</h3>
        <div class="scard" data-testid="capabilities-tools">
          {err && <div class="srow static col"><p class="error">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
          {stale && !err && <div class="srow static col"><StaleNote onRetry={load} /></div>}
          {!items && !err && <div class="srow static col" aria-busy="true"><div class="skel line wide" /><div class="skel line" /></div>}
          {items && tools.length === 0 && <div class="srow static"><span class="srow-l">No tools are connected</span></div>}
          {tools.map((t) => (
            <div class="srow static" data-testid="capability-tool" data-name={t.name} key={t.name}>
              <span class="srow-l"><strong>{t.name}</strong><span class="muted small block">{t.description}</span></span>
              <span class="srow-v">{t.approval ? "Asks first" : "Runs directly"}</span>
            </div>
          ))}
        </div>
      </section>
      <section aria-labelledby="cp-more">
        <h3 class="sg-title" id="cp-more">Also in Chat</h3>
        <div class="scard">
          <div class="srow static"><span class="srow-l">Attach images and PDFs<span class="muted small block">If the chosen model cannot see an attachment, the message says so</span></span></div>
          <div class="srow static"><span class="srow-l">Image and video generation<span class="muted small block">Switch the composer mode; a cost confirmation comes first</span></span></div>
          <div class="srow static"><span class="srow-l">Skills<span class="muted small block">Prompt templates from the “/” menu. They never run code or skip approval</span></span></div>
          <div class="srow static"><span class="srow-l">Not available<span class="muted small block">Running commands, browsing beyond reading a URL</span></span></div>
        </div>
      </section>
    </SubPage>
  );
}

const PROVIDER_STATUS: Record<ProviderInfo["status"], string> = { enabled: "Enabled", off: "Off", "needs-key": "No key" };
const PROVIDER_NAME: Record<string, string> = { gateway: "Vertex (Claude)", cloudflare: "Cloudflare Workers AI", nvidia: "NVIDIA NIM", aistudio: "Google AI Studio", groq: "Groq" };
const NIM_FALLBACK: ProviderPreset = { key: "nvidia", label: "NVIDIA NIM", id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", authHeader: "bearer", secret: "PROVIDER_KEY_NVIDIA", help: "The key is a Worker secret, not entered here. About 40 requests per minute. Only the free-preview models work." };

/** Providers (/settings/providers): the configured model providers, plus the NVIDIA NIM preset. A key can be pasted here (password field, sent once, cleared after
 *  save, never stored client-side or shown again) or provisioned by an admin as a Worker secret; the badge says which one is in use ("Ready (your key)" /
 *  "Ready (shared)" / "No key"). Lets you tick which models to enable and shows models hidden after a 404. Main account only; any other 403 shows as "not available". */
export function ProvidersPage({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<ProviderInfo[] | null>(() => peekPane<ProviderInfo[]>("/api/providers"));
  const [err, setErr] = useState("");
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [listed, setListed] = useState<{ id: string; models: ListedModel[]; ticked: Set<string> } | null>(null);
  const [note, setNote] = useState("");
  const [keyInput, setKeyInput] = useState(""); // transient: cleared on save/remove/switch, never persisted anywhere
  const [stale, setStale] = useState(false);
  const load = () => { setErr(""); const tok = paneToken("/api/providers"); void getProviders().then((r) => { if (r.status === 200 && r.data?.providers) { if (putPane("/api/providers", r.data.providers, tok)) { setItems(r.data.providers); setStale(false); } } else if (r.status === 403 || !items) setErr(r.status === 403 ? "Providers are not available for this account." : `Could not load providers (${r.status})`); else setStale(true); }).catch(() => { if (!items) setErr("Could not load providers (offline?)"); else setStale(true); }); };
  useEffect(() => { load(); void getProviderPresets().then((r) => setPresets(r.status === 200 && r.data?.presets?.length ? r.data.presets : [NIM_FALLBACK])).catch(() => setPresets([NIM_FALLBACK])); }, []);
  const add = async (p: ProviderPreset) => {
    setBusy(true); setFormErr(""); setNote(""); setListed(null);
    try { const r = await withBusy("provider-save", () => putProvider(p.id, {})); if (r.status !== 200) { setFormErr(r.data?.error ?? `Could not add (${r.status})`); return; } setOpen(p.id); load(); }
    catch { setFormErr("Could not add (offline?)"); } finally { setBusy(false); }
  };
  const test = async (id: string) => {
    setBusy(true); setFormErr(""); setNote(""); setListed(null);
    try {
      const r = await withBusy("provider-models", () => loadProviderModels(id));
      if (r.status !== 200 || !r.data?.models) { setFormErr(r.data?.error ?? `Could not load models (${r.status})`); return; }
      const models = r.data.models; const on = models.filter((m) => m.enabled && !m.broken);
      // already-enabled models stay ticked; a fresh provider starts with the known-good free-preview ones
      setListed({ id, models, ticked: new Set((on.length ? on : models.filter((m) => m.suggested)).map((m) => m.id)) });
      setNote(`${models.length} models listed. Nothing was called: tick the ones to enable.`);
    } catch { setFormErr("Could not load models (offline?)"); } finally { setBusy(false); }
  };
  const saveModels = async () => {
    if (!listed) return; setBusy(true); setFormErr("");
    try { const r = await withBusy("provider-models-save", () => putProvider(listed.id, { models: [...listed.ticked], enabled: true })); if (r.status !== 200) setFormErr(r.data?.error ?? `Could not save (${r.status})`); else { setNote(`${listed.ticked.size} model${listed.ticked.size === 1 ? "" : "s"} enabled.`); load(); } }
    catch { setFormErr("Could not save (offline?)"); } finally { setBusy(false); }
  };
  const saveKey = async (id: string) => {
    const v = keyInput; setBusy(true); setFormErr(""); setNote("");
    try { const r = await saveKeyFlow(id, v, { put: (i, k) => withBusy("provider-key-save", () => putProviderKey(i, k)), del: (i) => withBusy("provider-key-remove", () => deleteProviderKey(i)) }); setKeyInput(""); if (r.error) setFormErr(r.error); else { setNote(r.note); load(); } }
    catch { setKeyInput(""); setFormErr("Could not save the key (offline?)"); } finally { setBusy(false); }
  };
  const removeKey = async (id: string) => {
    setBusy(true); setFormErr(""); setNote(""); setKeyInput("");
    try { const r = await saveKeyFlow(id, null, { put: (i, k) => withBusy("provider-key-save", () => putProviderKey(i, k)), del: (i) => withBusy("provider-key-remove", () => deleteProviderKey(i)) }); if (r.error) setFormErr(r.error); else { setNote(r.note); load(); } }
    catch { setFormErr("Could not remove the key (offline?)"); } finally { setBusy(false); }
  };
  const remove = async (id: string) => { if (!confirm(`Remove ${PROVIDER_NAME[id] ?? id}?`)) return; const r = await withBusy("provider-delete", () => deleteProvider(id)); if (r.status === 200) { setOpen(null); setListed(null); load(); } else setErr(r.data?.error ?? `Could not remove (${r.status})`); };
  const tick = (id: string) => setListed((l) => { if (!l) return l; const t = new Set(l.ticked); t.has(id) ? t.delete(id) : t.add(id); return { ...l, ticked: t }; });
  const cur = items?.find((x) => x.id === open && x.editable);
  const curPreset = presets.find((x) => x.id === open);
  return (
    <SubPage title="Providers" onBack={onBack} testid="providers-page">
      <p class="muted small caps-note" data-testid="cf-notice">Where models come from. {CF_PROVIDERS_NOTICE} Other providers need an API key: paste yours under Manage (stored encrypted, never shown again) or an admin can set a shared Worker secret.</p>
      <section aria-labelledby="pv-list">
        <h3 class="sg-title" id="pv-list">Configured providers</h3>
        <div class="scard" data-testid="providers-list">
          {err && <div class="srow static col"><p class="error">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
          {stale && !err && <div class="srow static col"><StaleNote onRetry={load} /></div>}
          {!items && !err && <div class="srow static col" aria-busy="true"><div class="skel line wide" /><div class="skel line" /></div>}
          {items?.map((p) => (
            <div class="srow static" data-testid="provider-row" data-id={p.id} data-status={p.status} key={p.id}>
              <span class="srow-l"><strong>{PROVIDER_NAME[p.id] ?? p.id}</strong><span class="muted small block">{p.kind}{p.modelCount ? ` · ${p.modelCount} model${p.modelCount === 1 ? "" : "s"}` : ""}{p.broken?.length ? ` · ${p.broken.length} hidden (404/410)` : ""}</span></span>
              <span class="srow-v" data-testid="provider-badge">{p.editable ? keyBadge(p) : PROVIDER_STATUS[p.status]}</span>
              {p.editable && <button class="btn" data-testid="provider-edit" onClick={() => { setOpen(p.id); setListed(null); setNote(""); setFormErr(""); setKeyInput(""); }}>Manage</button>}
            </div>
          ))}
        </div>
      </section>
      {!err && presets.filter((p) => !items?.some((x) => x.id === p.id)).length > 0 && <section aria-labelledby="pv-add">
        <h3 class="sg-title" id="pv-add">Add a provider</h3>
        <div class="scard">
          {presets.filter((p) => !items?.some((x) => x.id === p.id)).map((p) => (
            <div class="srow static col" key={p.key}>
              <p class="muted small" data-testid="provider-help">{p.help}</p>
              <button class="btn" data-testid="provider-preset" disabled={busy} onClick={() => void add(p)}>{p.label}</button>
            </div>
          ))}
        </div>
      </section>}
      {formErr && <p class="error" role="alert" data-testid="pf-error">{formErr}</p>}
      {cur && <section aria-labelledby="pv-form">
        <h3 class="sg-title" id="pv-form">{PROVIDER_NAME[cur.id] ?? cur.id}</h3>
        <div class="scard" data-testid="provider-form">
          <div class="srow static col">
            <p class="muted small" data-testid="provider-status-note">{cur.presetOnly && cur.key_source !== "user" && cur.key_source !== "stale" ? "No key yet. Paste your own key below to use this provider's models. Only you can use your key." : keyNote(cur, curPreset?.secret ?? "PROVIDER_KEY_" + cur.id.toUpperCase().replace(/-/g, "_"))}</p>
            <label class="block small" for="pf-key">API key</label>
            <input id="pf-key" class="input" data-testid="pf-key" type="password" autocomplete="off" autocapitalize="off" spellcheck={false} placeholder="Paste your API key" value={keyInput} onInput={(e) => setKeyInput((e.target as HTMLInputElement).value)} />
            <div class="row-actions">
              <button class="btn primary" data-testid="pf-key-save" disabled={busy || !keyInput.trim()} onClick={() => void saveKey(cur.id)}>Save key</button>
              <button class="btn" data-testid="pf-key-remove" disabled={busy || cur.key_source !== "user"} onClick={() => void removeKey(cur.id)}>Remove my key</button>
            </div>
            {curPreset && !cur.presetOnly && <p class="muted small" data-testid="provider-help-open">{curPreset.help}</p>}
            {cur.presetOnly && !cur.catalogOnly && <p class="muted small" data-testid="provider-help-open">Get a free key at build.nvidia.com. About 40 requests per minute. Your key is stored encrypted and is never shown again.</p>}
            {cur.catalogOnly && cur.presetOnly && curPreset && <p class="muted small" data-testid="provider-help-open">{curPreset.help}</p>}
            {(cur.dataWarning ?? curPreset?.warning) && <p class="warn small" role="note" data-testid="provider-data-warning">{(cur.dataWarning ?? curPreset!.warning)!.en}<br /><span lang="vi">{(cur.dataWarning ?? curPreset!.warning)!.vi}</span></p>}
            {note && <p class="muted small" role="status" data-testid="pf-note">{note}</p>}
            <div class="row-actions">
              {!cur.presetOnly && !cur.catalogOnly && <button class="btn" data-testid="pf-test" disabled={busy || !cur.keySet} onClick={() => void test(cur.id)}>Test connection / load models</button>}
              {!cur.presetOnly && !cur.catalogOnly && <button class="btn" data-testid="pf-delete" disabled={busy} onClick={() => void remove(cur.id)}>Remove</button>}
            </div>
          </div>
        </div>
      </section>}
      {listed && <section aria-labelledby="pv-models">
        <h3 class="sg-title" id="pv-models">Models to enable</h3>
        <div class="scard" data-testid="provider-models">
          {listed.models.map((m) => (
            <label class="srow" key={m.id} data-testid="pm-row" data-id={m.id}>
              <span class="srow-l">{m.id}{m.verified && <span class="muted small"> · known to work</span>}{m.broken && <span class="muted small"> · answered 404/410, hidden</span>}</span>
              <input type="checkbox" checked={listed.ticked.has(m.id)} onChange={() => tick(m.id)} aria-label={`Enable ${m.id}`} />
            </label>
          ))}
          <div class="srow static col"><p class="muted small">Models are text-only (no tools, no images) unless the provider says otherwise. A model that answers 404 is hidden automatically; ticking it again clears that.</p>
            <button class="btn primary" data-testid="pm-save" disabled={busy} onClick={() => void saveModels()}>Enable selected</button></div>
        </div>
      </section>}
    </SubPage>
  );
}

/** Cloudflare (/settings/cloudflare): which account Cloudflare features run on (shared operator account, or the user's own, linked by pasting an API token + account id).
 *  The token is a password field, sent once, cleared right after, never stored client-side or shown again (status shows its last 4 characters). 403 = not available. */
export function CloudflarePage({ onBack }: { onBack: () => void }) {
  const [v, setV] = useState<CfAccountView | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy2] = useState(false);
  const [acct, setAcct] = useState("");
  const [tok, setTok] = useState(""); // transient
  const load = () => { setErr(""); void getCfAccount().then((r) => { if (r.status === 200 && r.data) setV(r.data); else setErr(r.status === 403 ? "Cloudflare account linking is not available for your account." : `Could not load (${r.status})`); }).catch(() => setErr("Could not load (offline?)")); };
  useEffect(load, []);
  const link = async () => {
    const a = acct, t = tok; setBusy2(true); setErr(""); setNote("");
    try { const r = await withBusy("cf-link", () => putCfAccount(a, t)); setTok(""); if (r.status === 200 && r.data) { setV(r.data); setAcct(""); setNote("Linked. Press Test to check it."); } else setErr(linkError(r.data, r.status)); }
    catch { setTok(""); setErr("Could not link the account (offline?)"); } finally { setBusy2(false); }
  };
  const unlink = async () => {
    if (!confirm("Remove your linked Cloudflare account? Cloudflare features go back to the shared account. Also delete the token in Cloudflare.")) return;
    setBusy2(true); setErr(""); setNote("");
    try { const r = await withBusy("cf-unlink", () => deleteCfAccount()); if (r.status === 200 && r.data) { setV(r.data); setNote("Removed. The shared account is used again."); } else setErr(r.data?.error ?? `Could not remove (${r.status})`); }
    catch { setErr("Could not remove (offline?)"); } finally { setBusy2(false); }
  };
  const test = async () => {
    setBusy2(true); setErr(""); setNote("");
    try { const r = await withBusy("cf-test", () => testCfAccount()); const text = testNote(r.data ?? {}, r.status); if (r.status === 200 && r.data?.ok) setNote(text); else setErr(text); }
    catch { setErr("Test failed (offline?)"); } finally { setBusy2(false); }
  };
  return (
    <SubPage title="Cloudflare" onBack={onBack} testid="cloudflare-page">
      <p class="muted small caps-note" data-testid="cf-notice">{CF_PROVIDERS_NOTICE}</p>
      {err && <p class="error" role="alert" data-testid="cf-error">{err}</p>}
      {v && <>
        <section aria-labelledby="cf-status">
          <h3 class="sg-title" id="cf-status">Status</h3>
          <div class="scard">
            <div class="srow static"><span class="srow-l" data-testid="cf-using">{cfUsing(v)}</span><span class="srow-v" data-testid="cf-badge">{cfBadge(v)}</span></div>
            {v.using !== "shared" && <div class="srow static col"><div class="row-actions">
              <button class="btn" data-testid="cf-test" disabled={busy || v.using !== "own"} onClick={() => void test()}>Test</button>
              <button class="btn" data-testid="cf-remove" disabled={busy} onClick={() => void unlink()}>Remove</button>
            </div></div>}
            {note && <div class="srow static col"><p class="muted small" role="status" data-testid="cf-note">{note}</p></div>}
          </div>
        </section>
        <section aria-labelledby="cf-link">
          <h3 class="sg-title" id="cf-link">{v.using === "shared" ? "Link your own account" : "Replace the linked account"}</h3>
          <div class="scard">
            <div class="srow static col">
              {!v.storage && <p class="error" data-testid="cf-nostorage">Key storage is not configured on this server, so an account cannot be linked.</p>}
              <p class="muted small">{CF_HELP}</p>
              <label class="block small" for="cf-acct">Account id</label>
              <input id="cf-acct" class="input" data-testid="cf-acct" autocomplete="off" autocapitalize="off" spellcheck={false} placeholder="32 hexadecimal characters" value={acct} onInput={(e) => setAcct((e.target as HTMLInputElement).value)} />
              <p class="muted small">{CF_ACCOUNT_ID_HELP}</p>
              <label class="block small" for="cf-token">API token</label>
              <input id="cf-token" class="input" data-testid="cf-token" type="password" autocomplete="off" autocapitalize="off" spellcheck={false} placeholder="Paste your API token" value={tok} onInput={(e) => setTok((e.target as HTMLInputElement).value)} />
              <div class="row-actions"><button class="btn primary" data-testid="cf-save" disabled={busy || !v.storage || !acct.trim() || !tok.trim()} onClick={() => void link()}>Link account</button></div>
            </div>
          </div>
        </section>
        <section aria-labelledby="cf-scopes">
          <h3 class="sg-title" id="cf-scopes">Token permissions (account level, minimum)</h3>
          <div class="scard" data-testid="cf-scopes">
            {v.scopes.map((s) => <div class="srow static col" key={s.feature}><strong>{s.feature}</strong><span class="muted small block">{s.permission}</span><span class="muted small block">Calls: {s.used_for}</span></div>)}
            <div class="srow static col"><p class="muted small">{CF_FREE_NOTE}</p></div>
          </div>
        </section>
      </>}
      {!v && !err && <div class="srow static col" aria-busy="true"><div class="skel line wide" /><div class="skel line" /></div>}
    </SubPage>
  );
}

/** Prompts (/settings/prompts): saved composer text for the "/" menu and the palette. Main + e2e only; a 403 shows as "not available". */
export function PromptsPage({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<PromptRow[] | null>(() => peekPane<PromptRow[]>("/api/prompts"));
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<{ id: string | null; title: string; text: string } | null>(null);
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const load = () => {
    setErr("");
    const tok = paneToken("/api/prompts");
    void listPrompts().then((r) => { if (r.status === 200 && r.data) { if (putPane("/api/prompts", r.data.prompts, tok)) { setRows(r.data.prompts); setStale(false); } } else if (r.status === 403 || !rows) setErr(r.status === 403 ? "Prompts are not available for this account" : `Could not load prompts (${r.status})`); else setStale(true); }).catch(() => { if (!rows) setErr("Could not load prompts (offline?)"); else setStale(true); });
  };
  useEffect(load, []);
  const save = async () => {
    if (!edit) return;
    setBusy(true); setFormErr("");
    const body = { title: edit.title.trim(), text: edit.text.trim() };
    const r = await withBusy("prompt-save", () => (edit.id ? updatePrompt(edit.id, body) : createPrompt(body))).catch(() => null);
    setBusy(false);
    if (r && (r.status === 200 || r.status === 201)) { setEdit(null); load(); } else setFormErr(r?.data?.error ?? "Could not save (offline?)");
  };
  const remove = async (p: PromptRow) => {
    const r = await withBusy("prompt-delete", () => deletePrompt(p.id)).catch(() => null);
    if (r?.status === 200) load(); else errorToast(r?.data?.error ?? "Could not delete the prompt");
  };
  return (
    <SubPage title="Prompts" onBack={onBack} testid="prompts-page">
      <p class="muted small caps-note">Reusable text for the message box. Type “/” in a chat and pick one, or search for it in the command palette. <code>{"{{clipboard}}"}</code> and <code>{"{{date}}"}</code> are filled in when you insert it.</p>
      {err && <div><p class="error" role="alert">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
      {stale && !err && <StaleNote onRetry={load} />}
      {!rows && !err && <div aria-busy="true"><div class="skel block" /><div class="skel block" /></div>}
      {rows && !edit && (
        <>
          <div class="sbtn-row"><button class="btn primary" data-testid="prompt-add" disabled={rows.length >= MAX_PROMPTS} onClick={() => { setFormErr(""); setEdit({ id: null, title: "", text: "" }); }}>New prompt</button></div>
          {rows.length === 0 && <p class="muted" data-testid="prompts-empty">No saved prompts yet.</p>}
          <div class="scard" data-testid="prompt-list">
            {rows.map((p) => (
              <div class="srow static" key={p.id} data-testid="prompt-row" data-title={p.title}>
                <span class="srow-l"><strong>{p.title}</strong><span class="muted small block ellip">{p.text.replace(/\s+/g, " ")}</span></span>
                <button class="btn" data-testid="prompt-edit" aria-label={`Edit ${p.title}`} onClick={() => { setFormErr(""); setEdit({ id: p.id, title: p.title, text: p.text }); }}>Edit</button>
                <button class="btn" data-testid="prompt-delete" aria-label={`Delete ${p.title}`} onClick={() => void remove(p)}>Delete</button>
              </div>
            ))}
          </div>
        </>
      )}
      {edit && (
        <section aria-labelledby="pr-edit">
          <h3 class="sg-title" id="pr-edit">{edit.id ? "Edit prompt" : "New prompt"}</h3>
          <div class="scard">
            <div class="sfield"><label for="pr-title">Title</label>
              <input id="pr-title" data-testid="prompt-title" type="text" maxLength={MAX_PROMPT_TITLE} value={edit.title} onInput={(e) => setEdit({ ...edit, title: e.currentTarget.value })} /></div>
            <div class="sfield"><label for="pr-text">Text</label>
              <textarea id="pr-text" data-testid="prompt-text" maxLength={MAX_PROMPT_TEXT} value={edit.text} onInput={(e) => setEdit({ ...edit, text: e.currentTarget.value })} />
              <span class="count" data-testid="prompt-count">{edit.text.length} / {MAX_PROMPT_TEXT}</span></div>
          </div>
          {formErr && <p class="error" role="alert" data-testid="prompt-error">{formErr}</p>}
          <div class="sbtn-row">
            <button class="btn" data-testid="prompt-cancel" onClick={() => setEdit(null)}>Cancel</button>
            <button class="btn primary" data-testid="prompt-save" disabled={busy || !edit.title.trim() || !edit.text.trim()} onClick={() => void save()}>Save</button>
          </div>
        </section>
      )}
    </SubPage>
  );
}

/** Settings > Approvals: hosts the user chose "Always allow" for, with Revoke, plus the recent automatic approvals (kept 30 days). */
export function ApprovalsPage({ onBack }: { onBack: () => void }) {
  const [v, setV] = useState<ApprovalsView | null>(null);
  const [err, setErr] = useState("");
  const load = () => { setErr(""); void getApprovals().then((r) => { if (r.status === 200 && r.data) setV(r.data); else setErr(`Could not load (${r.status})`); }).catch(() => setErr("Could not load (offline?)")); };
  useEffect(load, []);
  const revoke = async (host: string) => { setErr(""); try { const r = await withBusy("approval-revoke", () => revokeApproval(host)); if (r.status === 200) load(); else setErr(r.data?.error ?? `Could not revoke (${r.status})`); } catch { setErr("Could not revoke (offline?)"); } };
  const revokeAll = async () => { setErr(""); try { const r = await withBusy("approval-revoke-all", () => revokeAllApprovals()); if (r.status === 200) load(); else setErr(r.data?.error ?? `Could not revoke (${r.status})`); } catch { setErr("Could not revoke (offline?)"); } };
  return (
    <SubPage title="Approvals" onBack={onBack} testid="approvals-page">
      <section aria-labelledby="ap-grants">
        <h3 class="sg-title" id="ap-grants">Always allowed web addresses</h3>
        <div class="scard approvals-list" data-testid="approvals-grants">
          {!v && !err && <div class="srow static col" aria-busy="true"><div class="skel line wide" /></div>}
          {v && v.grants.length === 0 && <div class="srow static"><span class="srow-l"><span class="muted small block">Nothing yet. Choose "Always allow" on an approval card to add a website here.</span></span></div>}
          {v?.grants.map((g) => (
            <div class="srow static" key={g.tool + g.host} data-testid="approval-grant">
              <span class="srow-l"><strong data-testid="approval-grant-host">{g.host}</strong> <span class="muted small block">{g.tool} · added {fmtDate(g.createdAt)} · last used {fmtDate(g.lastUsedAt)}</span></span>
              <button class="btn" data-testid="approval-revoke" aria-label={`Revoke ${g.host}`} onClick={() => void revoke(g.host)}>Revoke</button>
            </div>
          ))}
        </div>
        {v && v.grants.length > 1 && <p><button class="btn" data-testid="approval-revoke-all" onClick={() => void revokeAll()}>Revoke all</button></p>}
        {v && !v.autoAllowed && <p class="muted small" data-testid="approvals-off">Auto and saved allowances are turned off for this account by an administrator. Every web page asks first.</p>}
        <p class="muted small">An allowance covers that exact address only (not other sites, not sub-domains). Saving, deleting, sending, spending and credential changes always ask.</p>
      </section>
      <section aria-labelledby="ap-log">
        <h3 class="sg-title" id="ap-log">Recent automatic approvals (30 days)</h3>
        <div class="scard approvals-list" data-testid="approvals-audit">
          {v && v.audit.length === 0 && <div class="srow static"><span class="srow-l"><span class="muted small block">None.</span></span></div>}
          {v?.audit.map((a, i) => <div class="srow static" key={i} data-testid="approval-audit-row"><span class="srow-l">{a.tool} {a.host} <span class="muted small block">{fmtDate(a.at)} · {SOURCE_NOTE[a.source as keyof typeof SOURCE_NOTE] ?? a.source}</span></span></div>)}
        </div>
      </section>
      {err && <p class="error" role="alert">{err}</p>}
    </SubPage>
  );
}
