// Saved prompts (migration 0019): reusable composer text for the slash menu and palette. Every query is scoped; another scope's row is simply not found.
import { cleanText } from "./profile";
import type { Scope } from "./scope";

export const MAX_PROMPT_TITLE = 60;
export const MAX_PROMPT_TEXT = 4000;
export const MAX_PROMPTS = 100;

export interface SavedPrompt { id: string; title: string; text: string; createdAt: string; updatedAt: string }
type Row = { id: string; title: string; text: string; created_at: string; updated_at: string };
const toPrompt = (r: Row): SavedPrompt => ({ id: r.id, title: r.title, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at });
export const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Create needs both fields; patch takes any subset. Limits are counted after cleaning. */
export function validatePrompt(b: unknown, create: boolean): { ok: true; v: { title?: string; text?: string } } | { ok: false; error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "expected a JSON object" };
  const o = b as Record<string, unknown>;
  const v: { title?: string; text?: string } = {};
  for (const [key, max, multi] of [["title", MAX_PROMPT_TITLE, false], ["text", MAX_PROMPT_TEXT, true]] as const) {
    if (o[key] === undefined) continue;
    if (typeof o[key] !== "string") return { ok: false, error: `${key} must be text` };
    const c = cleanText(o[key] as string, multi);
    if (c.length > max) return { ok: false, error: `${key} must be at most ${max} characters` };
    if (!c) return { ok: false, error: `${key} must not be empty` };
    v[key] = c;
  }
  if (create && (!v.title || !v.text)) return { ok: false, error: "title and text are required" };
  if (!create && Object.keys(v).length === 0) return { ok: false, error: "nothing to update" };
  return { ok: true, v };
}

export async function listPrompts(db: D1Database, scope: Scope): Promise<SavedPrompt[]> {
  const r = await db.prepare(`SELECT id, title, text, created_at, updated_at FROM saved_prompts WHERE scope=? ORDER BY title COLLATE NOCASE, id LIMIT ${MAX_PROMPTS}`).bind(scope).all<Row>();
  return r.results.map(toPrompt);
}

async function getPrompt(db: D1Database, scope: Scope, id: string): Promise<SavedPrompt | null> {
  if (!PROMPT_ID.test(id)) return null;
  const r = await db.prepare(`SELECT id, title, text, created_at, updated_at FROM saved_prompts WHERE id=? AND scope=?`).bind(id, scope).first<Row>();
  return r ? toPrompt(r) : null;
}

/** null = the per-scope limit is reached. */
export async function createPrompt(db: D1Database, scope: Scope, v: { title?: string; text?: string }): Promise<SavedPrompt | null> {
  const id = crypto.randomUUID();
  const r = await db.prepare(`INSERT INTO saved_prompts (id, scope, title, text) SELECT ?1, ?2, ?3, ?4
    WHERE (SELECT COUNT(*) FROM saved_prompts WHERE scope=?2) < ${MAX_PROMPTS}`).bind(id, scope, v.title ?? "", v.text ?? "").run();
  if (!r.meta?.changes) return null;
  return getPrompt(db, scope, id);
}

export async function updatePrompt(db: D1Database, scope: Scope, id: string, v: { title?: string; text?: string }): Promise<SavedPrompt | null> {
  if (!(await getPrompt(db, scope, id))) return null;
  await db.prepare(`UPDATE saved_prompts SET title=COALESCE(?1,title), text=COALESCE(?2,text), updated_at=datetime('now') WHERE id=?3 AND scope=?4`)
    .bind(v.title ?? null, v.text ?? null, id, scope).run();
  return getPrompt(db, scope, id);
}

export async function deletePrompt(db: D1Database, scope: Scope, id: string): Promise<boolean> {
  if (!(await getPrompt(db, scope, id))) return false;
  await db.prepare(`DELETE FROM saved_prompts WHERE id=? AND scope=?`).bind(id, scope).run();
  return true;
}
