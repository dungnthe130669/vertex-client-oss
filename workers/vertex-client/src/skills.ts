// Slash skills: prompt templates in D1 (spec §1.3). Validation, scope-aware CRUD, idempotent seed and the pure expansion used by the turn engine.
// A skill is a prompt macro: it never runs code, never forces a tool and never bypasses tool approval.
import { APPROVAL_TOOLS, READ_TOOLS } from "./tools";
import type { SlashItem } from "./slash";
import type { Scope } from "./scope";

export const SKILL_NAME = /^[a-z0-9-]{2,32}$/;
export const MAX_TEMPLATE = 8000;
export const MAX_DESCRIPTION = 200;
export const MAX_SKILLS = 100;
/** Built-in slash commands (incl. ones not enabled yet) + every tool name the client knows: a skill may not shadow them. */
export const RESERVED = new Set(["model", "clear", "compact", "image", "video", "advisor", "list_agents", ...READ_TOOLS, ...APPROVAL_TOOLS]);

export type { Scope };
export interface Skill { id: string; name: string; description: string; template: string; tools: string[]; createdAt: string; updatedAt: string }
export type SkillInput = { name?: unknown; description?: unknown; template?: unknown; tools?: unknown };
type Row = { id: string; name: string; description: string; template: string; tools_json: string | null; created_at: string; updated_at: string };

const toSkill = (r: Row): Skill => {
  let tools: string[] = [];
  try { const v = JSON.parse(r.tools_json ?? "[]"); if (Array.isArray(v)) tools = v.filter((x) => typeof x === "string"); } catch { /* hint list only */ }
  return { id: r.id, name: r.name, description: r.description, template: r.template, tools, createdAt: r.created_at, updatedAt: r.updated_at };
};
const COLS = "id, name, description, template, tools_json, created_at, updated_at";

/** Validates a create (all fields required except description/tools) or a partial update. Returns the cleaned fields or an error. */
/** Bounds expansion: markers x MAX_USER_CHARS stays well under the hard cap on the text sent to the provider. */
export const MAX_INPUT_MARKERS = 5;
export const MAX_SKILL_EXPANDED = 200_000;

export function validateSkill(b: SkillInput, partial: boolean, existingName?: string): { ok: true; v: { name?: string; description?: string; template?: string; tools?: string[] } } | { ok: false; error: string } {
  const v: { name?: string; description?: string; template?: string; tools?: string[] } = {};
  if (b.name !== undefined || !partial) {
    if (typeof b.name !== "string" || !SKILL_NAME.test(b.name)) return { ok: false, error: "name must be 2-32 characters of a-z, 0-9 and -" };
    if (RESERVED.has(b.name) && b.name !== existingName) return { ok: false, error: "name is reserved (built-in command or tool)" };
    v.name = b.name;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== "string" || b.description.length > MAX_DESCRIPTION) return { ok: false, error: `description must be at most ${MAX_DESCRIPTION} characters` };
    v.description = b.description.trim();
  }
  if (b.template !== undefined || !partial) {
    if (typeof b.template !== "string" || !b.template.trim()) return { ok: false, error: "template is required" };
    if (b.template.length > MAX_TEMPLATE) return { ok: false, error: `template must be at most ${MAX_TEMPLATE} characters` };
    if (b.template.split("{{input}}").length - 1 > MAX_INPUT_MARKERS) return { ok: false, error: `template may contain at most ${MAX_INPUT_MARKERS} {{input}} markers` };
    v.template = b.template;
  }
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools) || b.tools.length > 20 || b.tools.some((x) => typeof x !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(x))) return { ok: false, error: "tools must be a list of at most 20 tool names" };
    v.tools = b.tools as string[];
  }
  return { ok: true, v };
}

export const SEED: Array<{ name: string; description: string; template: string }> = [
  { name: "summarize", description: "Summarize the text in a few bullet points", template: "Summarize the following text in 3-5 concise bullet points. Keep names, numbers and decisions; drop filler.\n\n{{input}}" },
  { name: "translate-vi-en", description: "Translate between Vietnamese and English", template: "Dịch đoạn sau: nếu là tiếng Việt thì dịch sang tiếng Anh, nếu là tiếng Anh thì dịch sang tiếng Việt. Giữ nguyên giọng văn và định dạng; chỉ trả về bản dịch.\n\n{{input}}" },
  { name: "explain-simple", description: "Explain it simply, with an example", template: "Explain the following in plain language for someone new to the topic. Use short sentences and one concrete everyday example. Giải thích bằng tiếng Việt nếu câu hỏi viết bằng tiếng Việt.\n\n{{input}}" },
  { name: "code-review", description: "Review code for bugs and clarity", template: "Review the following code. List real bugs and risks first (most severe first), then readability or simplification suggestions. Be specific: quote the line and propose the fix.\n\n{{input}}" },
];

/** Seeds the 4 starter skills for scope main, once: only while the table has no main rows AND the `skills_seeded` flag is unset,
 *  so deleting them all later does not bring them back. INSERT OR IGNORE makes a concurrent double call harmless. */
export async function seedIfEmpty(db: D1Database): Promise<void> {
  const flag = await db.prepare(`SELECT value FROM settings WHERE name='skills_seeded'`).first<{ value: string }>();
  if (flag) return;
  const n = (await db.prepare(`SELECT COUNT(*) AS n FROM skills WHERE scope='main'`).first<{ n: number }>())?.n ?? 0;
  if (n === 0) {
    await db.batch(SEED.map((s) => db.prepare(`INSERT OR IGNORE INTO skills (id, name, description, template, tools_json, scope) VALUES (?,?,?,?,NULL,'main')`).bind(crypto.randomUUID(), s.name, s.description, s.template)));
  }
  await db.prepare(`INSERT OR IGNORE INTO settings (name, value) VALUES ('skills_seeded','1')`).run();
}

export async function listSkills(db: D1Database, scope: Scope): Promise<Skill[]> {
  if (scope === "main") await seedIfEmpty(db);
  const r = await db.prepare(`SELECT ${COLS} FROM skills WHERE scope=? ORDER BY name LIMIT ${MAX_SKILLS}`).bind(scope).all<Row>();
  return r.results.map(toSkill);
}

export async function skillTemplate(db: D1Database, scope: Scope, name: string): Promise<string | null> {
  if (!SKILL_NAME.test(name)) return null;
  const r = await db.prepare(`SELECT template FROM skills WHERE scope=? AND name=?`).bind(scope, name).first<{ template: string }>();
  return r?.template ?? null;
}

export async function slashSkills(db: D1Database, scope: Scope): Promise<SlashItem[]> {
  return (await listSkills(db, scope)).map((s) => ({ kind: "skill", name: s.name, description: s.description, group: "Skills" }));
}

export type CrudResult<T> = { status: number; body: T | { error: string } };
const err = (status: number, error: string) => ({ status, body: { error } });

export async function createSkill(db: D1Database, scope: Scope, b: SkillInput): Promise<CrudResult<{ skill: Skill }>> {
  const p = validateSkill(b, false);
  if (!p.ok) return err(400, p.error);
  if (scope === "main") await seedIfEmpty(db);
  const n = (await db.prepare(`SELECT COUNT(*) AS n FROM skills WHERE scope=?`).bind(scope).first<{ n: number }>())?.n ?? 0;
  if (n >= MAX_SKILLS) return err(409, `at most ${MAX_SKILLS} skills`);
  const id = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO skills (id, name, description, template, tools_json, scope) VALUES (?,?,?,?,?,?)`)
      .bind(id, p.v.name, p.v.description ?? "", p.v.template, p.v.tools?.length ? JSON.stringify(p.v.tools) : null, scope).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return err(409, "a skill with this name already exists");
    throw e;
  }
  const row = await db.prepare(`SELECT ${COLS} FROM skills WHERE id=? AND scope=?`).bind(id, scope).first<Row>();
  return { status: 201, body: { skill: toSkill(row!) } };
}

export async function updateSkill(db: D1Database, scope: Scope, id: string, b: SkillInput): Promise<CrudResult<{ skill: Skill }>> {
  const cur = await db.prepare(`SELECT ${COLS} FROM skills WHERE id=? AND scope=?`).bind(id, scope).first<Row>();
  if (!cur) return err(404, "not found");
  // An EXISTING row whose name later became reserved (e.g. a user skill `advisor`) stays editable under that same name; only new/changed names are checked.
  const p = validateSkill(b, true, cur.name);
  if (!p.ok) return err(400, p.error);
  const next = { name: p.v.name ?? cur.name, description: p.v.description ?? cur.description, template: p.v.template ?? cur.template, tools: p.v.tools === undefined ? cur.tools_json : p.v.tools.length ? JSON.stringify(p.v.tools) : null };
  try {
    await db.prepare(`UPDATE skills SET name=?, description=?, template=?, tools_json=?, updated_at=datetime('now') WHERE id=? AND scope=?`)
      .bind(next.name, next.description, next.template, next.tools, id, scope).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return err(409, "a skill with this name already exists");
    throw e;
  }
  const row = await db.prepare(`SELECT ${COLS} FROM skills WHERE id=? AND scope=?`).bind(id, scope).first<Row>();
  return { status: 200, body: { skill: toSkill(row!) } };
}

export async function deleteSkill(db: D1Database, scope: Scope, id: string): Promise<CrudResult<{ ok: true }>> {
  const cur = await db.prepare(`SELECT id FROM skills WHERE id=? AND scope=?`).bind(id, scope).first();
  if (!cur) return err(404, "not found");
  await db.prepare(`DELETE FROM skills WHERE id=? AND scope=?`).bind(id, scope).run();
  return { status: 200, body: { ok: true } };
}

/** What the model sees for `/name rest`: the template with `{{input}}` replaced by the rest of the user's text (the `/name` token removed);
 *  a template without the placeholder is followed by the user text. The stored/visible message is untouched (caller's job). */
export function expandSkill(template: string, name: string, userText: string): string {
  const esc = name.replace(/[^a-z0-9-]/g, "");
  const tok = new RegExp(`(^|\\s)/${esc}(\\s|$)`);
  const input = userText.replace(tok, (_m, pre: string, post: string) => (pre && post ? " " : "")).trim();
  if (template.includes("{{input}}")) return template.split("{{input}}").join(input);
  return input ? `${template}\n\n${input}` : template;
}
