import { useEffect, useState } from "preact/hooks";
import { type ConvRow, type ProjectRow, createProject, deleteProject, getProject, listProjectConversations, listProjects, moveConversation, updateProject } from "./api";
import { withBusy } from "./busy";
import { ChatItem } from "./chat-item";
import { ConfirmSheet, useEscape } from "./confirm";
import { newChat } from "./drawer";
import { RootBar } from "./root-bar";
import { IconBack, IconPlus } from "./icons";
import { editRow } from "./shell-logic";
import { errorToast, toast } from "./toast";

const MAX_NAME = 80, MAX_INSTRUCTIONS = 8000;
const go = (path: string, fromApp = false) => { history.pushState(fromApp ? { fromApp: true } : {}, "", path); dispatchEvent(new PopStateEvent("popstate")); };

/** Projects list (/projects): one card per project (name + chat count). Erich-only: other scopes get 403 and see the error state. */
export function Projects() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const load = () => {
    setErr("");
    void listProjects().then((r) => { if (r.status === 200 && r.data) setRows(r.data.projects); else setErr(r.status === 403 ? "Projects are not available for this account" : `Could not load projects (${r.status})`); }).catch(() => setErr("Could not load projects (offline?)"));
  };
  useEffect(load, []);
  return (
    <div class="shell">
      <RootBar title="Projects" />
      <main class="page" data-testid="projects-screen">
        <p class="muted small">A project groups chats and gives them shared instructions. The instructions are added to the system prompt of every new turn in its chats.</p>
        <div><button class="btn primary" data-testid="project-add" onClick={() => setAdding(true)}><IconPlus /> New project</button></div>
        {err && <div><p class="error" role="alert">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
        {!rows && !err && <div aria-busy="true"><div class="skel block" /><div class="skel block" /></div>}
        {rows && rows.length === 0 && <p class="muted" data-testid="projects-empty">No projects yet. Tap “New project” above to group chats under shared instructions.</p>}
        <ul class="models" data-testid="project-list">
          {rows?.map((p) => (
            <li key={p.id} data-testid="project-card" data-name={p.name}>
              <button class="row" data-testid="project-open" onClick={() => go(`/projects/${p.id}`, true)}>
                <strong class="ellip">{p.name}</strong>
                <span class="muted small">{p.chatCount} {p.chatCount === 1 ? "chat" : "chats"}</span>
              </button>
            </li>
          ))}
        </ul>
      </main>
      {adding && <NewProjectSheet onClose={() => setAdding(false)} onCreated={(p) => { setAdding(false); go(`/projects/${p.id}`, true); }} />}
    </div>
  );
}

function NewProjectSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (p: ProjectRow) => void }) {
  useEscape(onClose);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true); setErr("");
    const r = await withBusy("project-create", () => createProject({ name: name.trim() })).catch(() => null);
    setBusy(false);
    if (r?.status === 201 && r.data) onCreated(r.data); else setErr(r?.data?.error ?? "Could not create project (offline?)");
  };
  return (
    <div class="scrim" onClick={onClose} data-testid="project-scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="New project" onClick={(e) => e.stopPropagation()} data-testid="project-sheet">
        <h3 class="confirm-title">New project</h3>
        <label class="muted small" for="project-name">Name</label>
        <input id="project-name" data-testid="project-name" value={name} maxLength={MAX_NAME} autoFocus onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !busy) void save(); }} />
        {err && <p class="error" role="alert" data-testid="project-error">{err}</p>}
        <div class="approve">
          <button class="btn" onClick={onClose} data-testid="project-cancel">Cancel</button>
          <button class="btn primary" disabled={!name.trim() || busy} onClick={() => void save()} data-testid="project-create">Create</button>
        </div>
      </div>
    </div>
  );
}

/** One project (/projects/<id>): instructions editor, its chats, "New chat in project". */
export function ProjectPage({ id }: { id: string }) {
  const [p, setP] = useState<ProjectRow | null>(null);
  const [chats, setChats] = useState<ConvRow[] | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [ask, setAsk] = useState(false);
  const [saving, setSaving] = useState(false);
  const back = () => (history.state?.fromApp ? history.back() : go("/projects"));
  const load = () => {
    setErr("");
    void getProject(id).then((r) => { if (r.status === 200 && r.data) { setP(r.data); setName(r.data.name); setText(r.data.instructions); } else setErr(r.status === 404 ? "Project not found" : `Could not load project (${r.status})`); }).catch(() => setErr("Could not load project (offline?)"));
    void listProjectConversations(id).then((r) => { if (r.data) setChats(r.data.conversations); }).catch(() => {});
  };
  useEffect(load, [id]);
  const dirty = !!p && (name.trim() !== p.name || text.trim() !== p.instructions.trim());
  const save = async () => {
    setSaving(true);
    const r = await withBusy("project-save", () => updateProject(id, { name: name.trim(), instructions: text })).catch(() => null);
    setSaving(false);
    if (r?.status === 200 && r.data) { setP(r.data); setName(r.data.name); setText(r.data.instructions); toast("Saved"); } else errorToast(r?.data?.error ?? "Could not save (offline?)", () => void save());
  };
  const remove = async () => {
    setAsk(false);
    const r = await withBusy("project-delete", () => deleteProject(id)).catch(() => null);
    if (r?.status === 200) { toast("Project deleted; its chats are kept"); go("/projects"); } else errorToast(r?.data?.error ?? "Could not delete (offline?)", () => void remove());
  };
  const newInProject = () => { history.pushState({}, "", `/?project=${id}`); dispatchEvent(new PopStateEvent("popstate")); };
  const item = (r: ConvRow) => <ChatItem key={r.id} row={r} variant="list" onOpen={() => go(`/c/${r.id}`, true)}
    onEdit={(cid, e) => setChats((cur) => (cur ? (e.projectId !== undefined && e.projectId !== id ? cur.filter((x) => x.id !== cid) : editRow(cur, cid, e)) : cur))}
    onRemoved={(cid) => setChats((cur) => cur?.filter((x) => x.id !== cid) ?? cur)} />;
  return (
    <div class="shell">
      <header class="bar"><button class="rbtn" aria-label="Back" title="Back" onClick={back}><IconBack /></button><h1 class="title ellip">{p?.name ?? "Project"}</h1></header>
      <main class="page" data-testid="project-page">
        {err && <div><p class="error" role="alert" data-testid="project-load-error">{err}</p><button class="btn" onClick={load}>Retry</button></div>}
        {!p && !err && <div aria-busy="true"><div class="skel block" /><div class="skel block" /></div>}
        {p && <>
          <div class="actions">
            <button class="btn primary" data-testid="project-new-chat" onClick={newInProject}><IconPlus /> New chat in project</button>
            <button class="btn danger" data-testid="project-delete" onClick={() => setAsk(true)}>Delete project</button>
          </div>
          <section class="fld">
            <label class="muted small" for="project-title">Name</label>
            <input id="project-title" data-testid="project-title" value={name} maxLength={MAX_NAME} onInput={(e) => setName(e.currentTarget.value)} />
            <label class="muted small" for="project-instructions">Instructions — added to the system prompt of new turns in this project's chats (not retroactive)</label>
            <textarea id="project-instructions" class="skilltpl" data-testid="project-instructions" rows={8} value={text} maxLength={MAX_INSTRUCTIONS} onInput={(e) => setText(e.currentTarget.value)} />
            <div class="muted small">{text.length} / {MAX_INSTRUCTIONS}</div>
            <div><button class="btn primary" data-testid="project-save" disabled={!dirty || saving || !name.trim()} onClick={() => void save()}>Save</button></div>
          </section>
          <section>
            <h2 class="list-sec">Chats</h2>
            {!chats && <div aria-busy="true"><div class="skel block" /></div>}
            {chats && chats.length === 0 && <p class="muted" data-testid="project-chats-empty">No chats in this project yet.</p>}
            <ul class="list" data-testid="project-chats">{chats?.map(item)}</ul>
          </section>
        </>}
      </main>
      {ask && <ConfirmSheet title="Delete this project?" body="Its chats are kept and become unassigned. The instructions stop applying." onConfirm={() => void remove()} onCancel={() => setAsk(false)} />}
    </div>
  );
}

/** "Move to project…" sheet from the chat menu: pick a project, or "No project". */
export function MoveSheet({ convId, current, onClose, onMoved }: { convId: string; current: string | null; onClose: () => void; onMoved: (projectId: string | null) => void }) {
  useEscape(onClose);
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { void listProjects().then((r) => { if (r.data) setRows(r.data.projects); else setErr(`Could not load projects (${r.status})`); }).catch(() => setErr("Could not load projects (offline?)")); }, []);
  const pick = async (pid: string | null) => {
    if (pid === current) { onClose(); return; }
    const r = await withBusy("conv-move", () => moveConversation(convId, pid)).catch(() => null);
    if (r?.status === 200) { toast(pid ? "Moved to project" : "Removed from project"); onMoved(pid); } else errorToast(r?.data?.error ?? "Could not move (offline?)", () => void pick(pid));
  };
  return (
    <div class="scrim" onClick={onClose} data-testid="move-scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Move to project" onClick={(e) => e.stopPropagation()} data-testid="move-sheet">
        <h3 class="confirm-title">Move to project</h3>
        {err && <p class="error" role="alert">{err}</p>}
        {!rows && !err && <div aria-busy="true"><div class="skel block" /></div>}
        {rows && rows.length === 0 && <p class="muted small" data-testid="move-empty">No projects yet. Create one in Projects.</p>}
        <ul class="models">
          {rows?.map((p) => <li key={p.id}><button class={`row${p.id === current ? " on" : ""}`} data-testid="move-option" data-name={p.name} onClick={() => void pick(p.id)}><strong class="ellip">{p.name}</strong></button></li>)}
        </ul>
        {current && <button class="btn" data-testid="move-none" onClick={() => void pick(null)}>No project</button>}
        <div class="approve"><button class="btn" onClick={onClose} data-testid="move-cancel">Cancel</button></div>
      </div>
    </div>
  );
}
