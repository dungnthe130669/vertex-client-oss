import { withBusy } from "./busy";
import { IconBack } from "./icons";
import { useContext, useEffect, useState } from "preact/hooks";
import { MeCtx } from "./drawer";
import { type Model, type PersonaRow, createPersona, deletePersona, getAutoDelegate, getModels, listPersonas, putAutoDelegate, updatePersona } from "./api";
import { ConfirmSheet, useEscape } from "./confirm";
import { errorToast, toast } from "./toast";
import { paneToken, peekPane, putPane } from "./pane-cache";
import { StaleNote } from "./stale-note";
import { SUBAGENT_TOOL_CHOICES } from "../../src/subagent-parse";

const MAX_PROMPT = 8000, MAX_DESCRIPTION = 200, DEFAULT_MODEL = "claude-haiku-5-5";
type Effort = "" | "low" | "medium" | "high";
type Draft = { id: string | null; name: string; description: string; prompt: string; model: string; tools: string[]; maxTokens: number; effort: Effort; contextMode: "task" | "conversation"; autoUse: boolean };
const blank: Draft = { id: null, name: "", description: "", prompt: "", model: DEFAULT_MODEL, tools: [], maxTokens: 4096, effort: "", contextMode: "task", autoUse: true };

/** Subagents screen (Settings -> Subagents): personas the chat can delegate to (own model, prompt, read-only tools). Each scope sees only its own. */
export function Subagents({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<PersonaRow[] | null>(() => peekPane<PersonaRow[]>("/api/personas"));
  const [models, setModels] = useState<Model[]>(() => peekPane<Model[]>("/api/models") ?? []);
  const [err, setErr] = useState("");
  const [stale, setStale] = useState(false);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [del, setDel] = useState<PersonaRow | null>(null);
  const load = () => {
    setErr("");
    const tok = paneToken("/api/personas");
    void listPersonas().then((r) => { if (r.status === 200 && r.data) { if (putPane("/api/personas", r.data.personas, tok)) { setRows(r.data.personas); setStale(false); } } else if (!rows) setErr(`Could not load subagents (${r.status})`); else setStale(true); }).catch(() => { if (!rows) setErr("Could not load subagents (offline?)"); else setStale(true); });
  };
  useEffect(load, []);
  useEffect(() => { const tok = paneToken("/api/models"); void getModels().then((r) => { if (r.status === 200 && r.data && putPane("/api/models", r.data.models, tok)) setModels(r.data.models); else if (!(r.status === 200 && r.data) && peekPane("/api/models")) setStale(true); }).catch(() => { if (peekPane("/api/models")) setStale(true); }); }, []);
  const remove = async (p: PersonaRow) => {
    setDel(null);
    const r = await withBusy("persona-delete", () => deletePersona(p.id)).catch(() => null);
    if (r?.status === 200) { toast(`Deleted ${p.name}`); load(); } else errorToast(r?.data?.error ?? "Could not delete subagent", () => void remove(p));
  };
  return (
    <div class="shell">
      <header class="bar"><button class="rbtn" aria-label="Back" title="Back" onClick={onBack}><IconBack /></button><h2 class="title">Subagents</h2></header>
      <main class="page" data-testid="subagents-screen">
        <p class="muted small">A subagent is a helper with its own model and instructions that the chat can hand a task to (several at once). It starts with no memory of the conversation and only gets read-only tools. Or type <strong>@name</strong> and your task in the composer. New chats pick up changes.</p>
        <AutoDelegateSetting />
        <div><button class="btn primary" data-testid="persona-add" onClick={() => setEdit({ ...blank })}>Add subagent</button></div>
        {err && <div><p class="error">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
        {stale && !err && <StaleNote onRetry={load} />}
        {!rows && !err && <div aria-busy="true"><div class="skel block" /><div class="skel block" /></div>}
        {rows && rows.length === 0 && <p class="muted" data-testid="personas-empty">No subagents yet. Tap “Add subagent” to create one.</p>}
        <ul class="models" data-testid="persona-list">
          {rows?.map((p) => (
            <li data-testid="persona-row" data-name={p.name} key={p.id}>
              <div><strong>@{p.name}</strong> <span class="muted small">{p.model}</span></div>
              {p.description && <div class="muted small">{p.description}</div>}
              <div class="actions">
                <button class="btn" data-testid="persona-edit" onClick={() => setEdit({ id: p.id, name: p.name, description: p.description, prompt: p.prompt, model: p.model, tools: p.tools, maxTokens: p.maxTokens, effort: p.effort ?? "", contextMode: p.contextMode, autoUse: p.autoUse })}>Edit</button>
                <button class="btn" data-testid="persona-delete" onClick={() => setDel(p)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      </main>
      {edit && <PersonaSheet draft={edit} models={models} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {del && <ConfirmSheet title={`Delete @${del.name}?`} body="Chats can no longer delegate to it." onConfirm={() => void remove(del)} onCancel={() => setDel(null)} />}
    </div>
  );
}

/** "Let chat delegate to subagents by itself": per scope, default OFF. ON = the chat may call `delegate` on its own (several at once); OFF = only for an explicit @persona. */
function AutoDelegateSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void getAutoDelegate().then((r) => { if (r.status === 200 && r.data) setOn(r.data.enabled); }).catch(() => {}); }, []);
  if (on === null) return null;
  const flip = async () => {
    const next = !on;
    const r = await withBusy("auto-delegate", () => putAutoDelegate(next)).catch(() => null);
    if (r?.status === 200) { setOn(next); toast(next ? "Chat may delegate to subagents by itself." : "Chat delegates only when you type @name."); } else errorToast("Could not save", flip);
  };
  return (
    <div class="srow static" data-testid="auto-delegate-setting">
      <span class="srow-l"><label id="auto-delegate-l">Let chat delegate to subagents by itself</label><span class="muted small block">May run several at once and uses extra tokens. Off: subagents run only when you type @name. New messages pick up the change.</span></span>
      <button type="button" role="switch" class={`switch${on ? " on" : ""}`} aria-checked={on} aria-labelledby="auto-delegate-l" data-testid="auto-delegate-toggle" onClick={() => void flip()}><span class="knob" /></button>
    </div>
  );
}

function PersonaSheet({ draft, models, onClose, onSaved }: { draft: Draft; models: Model[]; onClose: () => void; onSaved: () => void }) {
  useEscape(onClose);
  const team = useContext(MeCtx)?.team === true; // a team user has no personal connector: the personal-tool picker is not shown
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ids = models.map((m) => m.id);
  const options = ids.includes(d.model) ? models : [...models, { id: d.model, name: d.model } as Model];
  const ok = /^[a-z0-9-]{2,32}$/.test(d.name) && d.prompt.trim().length > 0 && d.prompt.length <= MAX_PROMPT && d.description.length <= MAX_DESCRIPTION && d.maxTokens >= 256 && d.maxTokens <= 16000;
  const toggle = (t: string) => setD({ ...d, tools: d.tools.includes(t) ? d.tools.filter((x) => x !== t) : [...d.tools, t] });
  const save = async () => {
    setBusy(true); setErr("");
    const body = { name: d.name, description: d.description, prompt: d.prompt, model: d.model, tools: d.tools, maxTokens: d.maxTokens, effort: d.effort || null, contextMode: d.contextMode, autoUse: d.autoUse };
    const r = await withBusy("persona-save", () => (d.id ? updatePersona(d.id, body) : createPersona(body))).catch(() => null);
    setBusy(false);
    if (r && (r.status === 200 || r.status === 201)) { toast(`Saved @${d.name}`); onSaved(); } else setErr(r?.data?.error ?? "Could not save subagent (offline?)");
  };
  return (
    <div class="scrim" onClick={onClose} data-testid="persona-scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label={d.id ? "Edit subagent" : "Add subagent"} onClick={(e) => e.stopPropagation()} data-testid="persona-sheet">
        <h3 class="confirm-title">{d.id ? "Edit subagent" : "Add subagent"}</h3>
        <label class="muted small" for="persona-name">Name (a-z, 0-9, -)</label>
        <input id="persona-name" data-testid="persona-name" value={d.name} maxLength={32} autoCapitalize="none" autoCorrect="off" spellcheck={false} onInput={(e) => setD({ ...d, name: e.currentTarget.value.toLowerCase() })} />
        <label class="muted small" for="persona-desc">Description</label>
        <input id="persona-desc" data-testid="persona-desc" value={d.description} maxLength={MAX_DESCRIPTION} onInput={(e) => setD({ ...d, description: e.currentTarget.value })} />
        <label class="muted small" for="persona-prompt">Instructions (system prompt)</label>
        <textarea id="persona-prompt" class="skilltpl" data-testid="persona-prompt" rows={6} value={d.prompt} maxLength={MAX_PROMPT} onInput={(e) => setD({ ...d, prompt: e.currentTarget.value })} />
        <label class="muted small" for="persona-model">Model</label>
        <select id="persona-model" class="persona-sel" data-testid="persona-model" value={d.model} onChange={(e) => setD({ ...d, model: e.currentTarget.value })}>{options.map((m) => <option value={m.id}>{m.provider && m.provider !== "gateway" ? `${m.name || m.id} (${m.provider})` : m.name || m.id}</option>)}</select>
        {(() => { const cur = models.find((m) => m.id === d.model); return cur && cur.provider && cur.provider !== "gateway" && cur.capabilities?.tools !== true ? <p class="muted small" data-testid="persona-tools-warn">This model may not support tools: the subagent will run without them.</p> : null; })()}
        <label class="muted small" for="persona-effort">Thinking effort</label>
        <select id="persona-effort" class="persona-sel" data-testid="persona-effort" value={d.effort} onChange={(e) => setD({ ...d, effort: e.currentTarget.value as Effort })}>
          <option value="">Default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select>
        <label class="muted small" for="persona-max">Max reply tokens (256-16000)</label>
        <input id="persona-max" type="number" min={256} max={16000} data-testid="persona-max" value={d.maxTokens} onInput={(e) => setD({ ...d, maxTokens: Number(e.currentTarget.value) || 0 })} />
        <label class="muted small chk-row"><input type="checkbox" data-testid="persona-context" checked={d.contextMode === "conversation"} onChange={(e) => setD({ ...d, contextMode: e.currentTarget.checked ? "conversation" : "task" })} />Sees the whole conversation</label>
        <label class="muted small chk-row"><input type="checkbox" data-testid="persona-autouse" checked={d.autoUse} onChange={(e) => setD({ ...d, autoUse: e.currentTarget.checked })} />Allow chat to call it by itself</label>
        {!team && <fieldset class="muted small" data-testid="persona-tools"><legend>Read-only tools it may use</legend>
          {SUBAGENT_TOOL_CHOICES.map((t) => <label class="chk-inline"><input type="checkbox" checked={d.tools.includes(t)} onChange={() => toggle(t)} />{t}</label>)}
        </fieldset>}
        {err && <p class="error" role="alert" data-testid="persona-error">{err}</p>}
        <div class="approve">
          <button class="btn primary" data-testid="persona-save" disabled={!ok || busy} onClick={() => void save()}>Save</button>
          <button class="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
