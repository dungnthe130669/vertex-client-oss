import { withBusy } from "./busy";
import { IconBack } from "./icons";
import { useEffect, useState } from "preact/hooks";
import { type SkillRow, createSkill, deleteSkill, listSkills, updateSkill } from "./api";
import { ConfirmSheet, useEscape } from "./confirm";
import { errorToast, toast } from "./toast";

const MAX_TEMPLATE = 8000, MAX_DESCRIPTION = 200;
type Draft = { id: string | null; name: string; description: string; template: string };
const blank: Draft = { id: null, name: "", description: "", template: "" };

/** Skills screen (/skills): prompt templates behind the composer's "/" menu. Reached from Settings. */
export function Skills({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<SkillRow[] | null>(null);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<Draft | null>(null);
  const [del, setDel] = useState<SkillRow | null>(null);
  const load = () => {
    setErr("");
    void listSkills().then((r) => { if (r.status === 200 && r.data) setRows(r.data.skills); else setErr(`Could not load skills (${r.status})`); }).catch(() => setErr("Could not load skills (offline?)"));
  };
  useEffect(load, []);
  const remove = async (s: SkillRow) => {
    setDel(null);
    const r = await withBusy("skill-delete", () => deleteSkill(s.id)).catch(() => null);
    if (r?.status === 200) { toast(`Deleted /${s.name}`); load(); } else errorToast(r?.data?.error ?? "Could not delete skill", () => void remove(s));
  };
  return (
    <div class="shell">
      <header class="bar"><button class="rbtn" aria-label="Back" title="Back" onClick={onBack}><IconBack /></button><h2 class="title">Skills</h2></header>
      <main class="page" data-testid="skills-screen">
        <p class="muted small">A skill is a prompt template. Type <strong>/name</strong> in the composer; <code>{"{{input}}"}</code> is replaced by the rest of your message. Skills never run code or skip tool approval.</p>
        <div><button class="btn primary" data-testid="skill-add" onClick={() => setEdit({ ...blank })}>Add skill</button></div>
        {err && <div><p class="error">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
        {!rows && !err && <div aria-busy="true"><div class="skel block" /><div class="skel block" /></div>}
        {rows && rows.length === 0 && <p class="muted" data-testid="skills-empty">No skills yet. Tap “Add skill” above to write your first prompt template.</p>}
        <ul class="models" data-testid="skill-list">
          {rows?.map((s) => (
            <li data-testid="skill-row" data-name={s.name} key={s.id}>
              <div><strong>/{s.name}</strong></div>
              {s.description && <div class="muted small">{s.description}</div>}
              <div class="actions">
                <button class="btn" data-testid="skill-edit" onClick={() => setEdit({ id: s.id, name: s.name, description: s.description, template: s.template })}>Edit</button>
                <button class="btn" data-testid="skill-delete" onClick={() => setDel(s)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      </main>
      {edit && <SkillSheet draft={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {del && <ConfirmSheet title={`Delete /${del.name}?`} body="This removes the skill from the / menu." onConfirm={() => void remove(del)} onCancel={() => setDel(null)} />}
    </div>
  );
}

function SkillSheet({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  useEscape(onClose);
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ok = /^[a-z0-9-]{2,32}$/.test(d.name) && d.template.trim().length > 0 && d.template.length <= MAX_TEMPLATE && d.description.length <= MAX_DESCRIPTION;
  const save = async () => {
    setBusy(true); setErr("");
    const body = { name: d.name, description: d.description, template: d.template };
    const r = await withBusy("skill-save", () => (d.id ? updateSkill(d.id, body) : createSkill(body))).catch(() => null);
    setBusy(false);
    if (r && (r.status === 200 || r.status === 201)) { toast(`Saved /${d.name}`); onSaved(); } else setErr(r?.data?.error ?? "Could not save skill (offline?)");
  };
  return (
    <div class="scrim" onClick={onClose} data-testid="skill-scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label={d.id ? "Edit skill" : "Add skill"} onClick={(e) => e.stopPropagation()} data-testid="skill-sheet">
        <h3 class="confirm-title">{d.id ? "Edit skill" : "Add skill"}</h3>
        <label class="muted small" for="skill-name">Name (a-z, 0-9, -)</label>
        <input id="skill-name" data-testid="skill-name" value={d.name} maxLength={32} autoCapitalize="none" autoCorrect="off" spellcheck={false} onInput={(e) => setD({ ...d, name: e.currentTarget.value.toLowerCase() })} />
        <label class="muted small" for="skill-desc">Description</label>
        <input id="skill-desc" data-testid="skill-desc" value={d.description} maxLength={MAX_DESCRIPTION} onInput={(e) => setD({ ...d, description: e.currentTarget.value })} />
        <label class="muted small" for="skill-template">Template — use {"{{input}}"} for your message</label>
        <textarea id="skill-template" class="skilltpl" data-testid="skill-template" rows={6} value={d.template} maxLength={MAX_TEMPLATE} onInput={(e) => setD({ ...d, template: e.currentTarget.value })} />
        {err && <p class="error" role="alert" data-testid="skill-error">{err}</p>}
        <div class="approve">
          <button class="btn" onClick={onClose} data-testid="skill-cancel">Cancel</button>
          <button class="btn primary" disabled={!ok || busy} onClick={() => void save()} data-testid="skill-save">Save</button>
        </div>
      </div>
    </div>
  );
}
