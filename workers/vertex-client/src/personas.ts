// Subagent personas: validation, scope-aware CRUD over D1, idempotent seed. A persona is configuration for the `delegate` tool
// (src/subagent.ts); it never runs code itself and can only ever be given READ tools.
import { READ_TOOLS } from "./tools";
import { baseOf, isGuestScope, spaceOf, type BaseScope, type Scope } from "./scope";

export const PERSONA_NAME = /^[a-z0-9-]{2,32}$/;
export const MAX_PERSONA_PROMPT = 8000;
export const MAX_PERSONA_DESC = 200;
export const MAX_PERSONAS = 30;
export const DEFAULT_PERSONA_MODEL = "claude-haiku-5-5";
export const DEFAULT_PERSONA_MAX_TOKENS = 4096;
export const ADVISOR_MODEL = "claude-opus-5-5";
export const RESEARCHER_MODEL = "claude-sonnet-5-5";
export const CONTEXT_MODES = ["task", "conversation"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Persona { id: string; name: string; description: string; prompt: string; model: string; tools: string[]; maxTokens: number; effort: Effort | null; contextMode: ContextMode; autoUse: boolean; createdAt: string; updatedAt: string }
export type PersonaInput = { name?: unknown; description?: unknown; prompt?: unknown; model?: unknown; tools?: unknown; maxTokens?: unknown; effort?: unknown; contextMode?: unknown; autoUse?: unknown };
type Row = { id: string; name: string; description: string; prompt: string; model: string; tools_json: string | null; max_tokens: number; effort: string | null; context_mode: string | null; auto_use: number | null; created_at: string; updated_at: string };
const COLS = "id, name, description, prompt, model, tools_json, max_tokens, effort, context_mode, auto_use, created_at, updated_at";

/** A team user (g:<uid>) has no personal connector, so no persona of theirs may name, show or be offered a personal-connector tool (they could never run: the team tool host is empty). */
const noPersonalTools = (scope: Scope) => isGuestScope(baseOf(scope));
const toPersona = (r: Row, noTools = false): Persona => {
  let tools: string[] = [];
  try { const v = JSON.parse(r.tools_json ?? "[]"); if (Array.isArray(v) && !noTools) tools = v.filter((x) => typeof x === "string" && READ_TOOLS.has(x)); } catch { /* none */ }
  return { id: r.id, name: r.name, description: r.description, prompt: r.prompt, model: r.model, tools, maxTokens: r.max_tokens, effort: (EFFORTS as readonly string[]).includes(r.effort ?? "") ? (r.effort as Effort) : null, contextMode: r.context_mode === "conversation" ? "conversation" : "task", autoUse: r.auto_use !== 0, createdAt: r.created_at, updatedAt: r.updated_at };
};

type Clean = { name?: string; description?: string; prompt?: string; model?: string; tools?: string[]; maxTokens?: number; effort?: Effort | null; contextMode?: ContextMode; autoUse?: boolean };
export function validatePersona(b: PersonaInput, partial: boolean): { ok: true; v: Clean } | { ok: false; error: string } {
  const v: Clean = {};
  if (b.name !== undefined || !partial) {
    if (typeof b.name !== "string" || !PERSONA_NAME.test(b.name)) return { ok: false, error: "name must be 2-32 characters of a-z, 0-9 and -" };
    v.name = b.name;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== "string" || b.description.length > MAX_PERSONA_DESC) return { ok: false, error: `description must be at most ${MAX_PERSONA_DESC} characters` };
    v.description = b.description.trim();
  }
  if (b.prompt !== undefined || !partial) {
    if (typeof b.prompt !== "string" || !b.prompt.trim()) return { ok: false, error: "prompt is required" };
    if (b.prompt.length > MAX_PERSONA_PROMPT) return { ok: false, error: `prompt must be at most ${MAX_PERSONA_PROMPT} characters` };
    v.prompt = b.prompt;
  }
  if (b.model !== undefined) {
    if (typeof b.model !== "string" || !/^[A-Za-z0-9._:/@-]{1,120}$/.test(b.model)) return { ok: false, error: "model is not a valid model id" };
    v.model = b.model;
  }
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools) || b.tools.length > 20 || b.tools.some((x) => typeof x !== "string")) return { ok: false, error: "tools must be a list of tool names" };
    const bad = (b.tools as string[]).find((x) => !READ_TOOLS.has(x));
    if (bad) return { ok: false, error: `tool "${bad}" is not allowed: subagents may only use read-only tools` };
    v.tools = [...new Set(b.tools as string[])];
  }
  if (b.maxTokens !== undefined) {
    if (typeof b.maxTokens !== "number" || !Number.isInteger(b.maxTokens) || b.maxTokens < 256 || b.maxTokens > 16000) return { ok: false, error: "maxTokens must be a whole number from 256 to 16000" };
    v.maxTokens = b.maxTokens;
  }
  if (b.effort !== undefined) {
    if (b.effort !== null && b.effort !== "" && !(EFFORTS as readonly string[]).includes(b.effort as string)) return { ok: false, error: "effort must be low, medium or high" };
    v.effort = b.effort ? (b.effort as Effort) : null;
  }
  if (b.contextMode !== undefined) {
    if (!(CONTEXT_MODES as readonly string[]).includes(b.contextMode as string)) return { ok: false, error: "contextMode must be task or conversation" };
    v.contextMode = b.contextMode as ContextMode;
  }
  if (b.autoUse !== undefined) {
    if (typeof b.autoUse !== "boolean") return { ok: false, error: "autoUse must be true or false" };
    v.autoUse = b.autoUse;
  }
  return { ok: true, v };
}

export const SEED: Array<{ name: string; description: string; prompt: string; tools: string[]; effort: Effort | null; model: string; maxTokens: number; contextMode: ContextMode; autoUse: boolean }> = [
  { name: "researcher", description: "Looks things up and reports the findings with sources", tools: ["read_url", "search_notes", "get_note"], effort: null, model: RESEARCHER_MODEL, maxTokens: DEFAULT_PERSONA_MAX_TOKENS, contextMode: "task", autoUse: true,
    prompt: "You are a research subagent. Find the facts the task asks for using your tools, check them against more than one source when you can, and report: the answer first, then the evidence, then what you could not verify. Always name the source (URL or note title) next to each claim. Never invent a source." },
  { name: "reviewer", description: "Critical review of a text, plan or piece of code", tools: [], effort: "medium", model: DEFAULT_PERSONA_MODEL, maxTokens: DEFAULT_PERSONA_MAX_TOKENS, contextMode: "task", autoUse: true,
    prompt: "You are a critical reviewer subagent. List real problems first (most severe first), each with the exact quote and a concrete fix; then minor polish. Say plainly if you find nothing wrong. Do not praise filler and do not rewrite the whole thing." },
  { name: "summarizer", description: "Condenses long text to the essentials", tools: [], effort: null, model: DEFAULT_PERSONA_MODEL, maxTokens: DEFAULT_PERSONA_MAX_TOKENS, contextMode: "task", autoUse: true,
    prompt: "You are a summarizing subagent. Condense the material in the task to its essentials: 3-7 bullet points, keeping names, numbers, dates and decisions; drop filler. Use the language of the material. Output only the summary." },
  { name: "advisor", description: "Senior second opinion on the conversation so far (only when you ask)", tools: [], effort: "high", model: ADVISOR_MODEL, maxTokens: 2048, contextMode: "conversation", autoUse: false,
    prompt: "You are a senior second-opinion reviewer. You are given the conversation so far and a question. Read the conversation carefully, then say what is right, what is wrong and what is missing. Name the risks and the better option if there is one. Be concise and direct. Do not redo the work and do not rewrite it. End with a clear recommendation." },
];

/** Scopes that get the built-in set: main and every team user (`g:<uid>`). e2e and anything else start empty. */
export const seedsFor = (scope: BaseScope) => scope === "main" || isGuestScope(scope);
const seedFlag = (scope: Scope) => (scope === "main" ? "personas_seeded" : `personas_seeded:${scope}`);

/** Once per scope (main, g:<uid>): only while the scope has no rows AND its seeded flag is unset (deleting them all later does not bring them back). */
export async function seedPersonasIfEmpty(db: D1Database, scope: Scope = "main"): Promise<void> {
  if (spaceOf(scope) === "open" || !seedsFor(baseOf(scope))) return; // Open never gets the (Claude-model) built-in seeds
  const flag = await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(seedFlag(scope)).first<{ value: string }>();
  if (flag) return;
  const n = (await db.prepare(`SELECT COUNT(*) AS n FROM personas WHERE scope=?`).bind(scope).first<{ n: number }>())?.n ?? 0;
  if (n === 0) {
    const team = noPersonalTools(scope); // team seeds carry no connector tools and no "note title" wording
    await db.batch(SEED.map((s) => db.prepare(`INSERT OR IGNORE INTO personas (id, scope, name, description, prompt, model, tools_json, max_tokens, effort, context_mode, auto_use) VALUES (?, ?, ?,?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), scope, s.name, s.description, team ? s.prompt.replace("(URL or note title)", "(URL or other source)") : s.prompt, s.model, !team && s.tools.length ? JSON.stringify(s.tools) : null, s.maxTokens, s.effort, s.contextMode, s.autoUse ? 1 : 0)));
  }
  await db.prepare(`INSERT OR IGNORE INTO settings (name, value) VALUES (?, '1')`).bind(seedFlag(scope)).run();
}

export async function listPersonas(db: D1Database, scope: Scope): Promise<Persona[]> {
  await seedPersonasIfEmpty(db, scope);
  return (await db.prepare(`SELECT ${COLS} FROM personas WHERE scope=? ORDER BY name LIMIT ${MAX_PERSONAS}`).bind(scope).all<Row>()).results.map((r) => toPersona(r, noPersonalTools(scope)));
}

/** One persona by name in the caller's own scope (null = unknown). Seeds main first so a fresh install's built-ins resolve. */
export async function getPersona(db: D1Database, scope: Scope, name: string): Promise<Persona | null> {
  if (!PERSONA_NAME.test(name)) return null;
  await seedPersonasIfEmpty(db, scope);
  const r = await db.prepare(`SELECT ${COLS} FROM personas WHERE scope=? AND name=?`).bind(scope, name).first<Row>();
  return r ? toPersona(r, noPersonalTools(scope)) : null;
}

export type CrudResult<T> = { status: number; body: T | { error: string } };
const err = (status: number, error: string) => ({ status, body: { error } });

export async function createPersona(db: D1Database, scope: Scope, b: PersonaInput): Promise<CrudResult<{ persona: Persona }>> {
  const p = validatePersona(b, false);
  if (!p.ok) return err(400, p.error);
  if (p.v.tools?.length && noPersonalTools(scope)) return err(400, "this account has no personal tools to give a subagent");
  await seedPersonasIfEmpty(db, scope);
  const n = (await db.prepare(`SELECT COUNT(*) AS n FROM personas WHERE scope=?`).bind(scope).first<{ n: number }>())?.n ?? 0;
  if (n >= MAX_PERSONAS) return err(409, `at most ${MAX_PERSONAS} personas`);
  const id = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO personas (id, scope, name, description, prompt, model, tools_json, max_tokens, effort, context_mode, auto_use) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, scope, p.v.name, p.v.description ?? "", p.v.prompt, p.v.model ?? DEFAULT_PERSONA_MODEL, p.v.tools?.length ? JSON.stringify(p.v.tools) : null, p.v.maxTokens ?? DEFAULT_PERSONA_MAX_TOKENS, p.v.effort ?? null, p.v.contextMode ?? "task", p.v.autoUse === false ? 0 : 1).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return err(409, "a persona with this name already exists");
    throw e;
  }
  return { status: 201, body: { persona: toPersona((await db.prepare(`SELECT ${COLS} FROM personas WHERE id=? AND scope=?`).bind(id, scope).first<Row>())!, noPersonalTools(scope)) } };
}

export async function updatePersona(db: D1Database, scope: Scope, id: string, b: PersonaInput): Promise<CrudResult<{ persona: Persona }>> {
  const p = validatePersona(b, true);
  if (!p.ok) return err(400, p.error);
  if (p.v.tools?.length && noPersonalTools(scope)) return err(400, "this account has no personal tools to give a subagent");
  const cur = await db.prepare(`SELECT ${COLS} FROM personas WHERE id=? AND scope=?`).bind(id, scope).first<Row>();
  if (!cur) return err(404, "not found");
  const tools = p.v.tools === undefined ? cur.tools_json : p.v.tools.length ? JSON.stringify(p.v.tools) : null;
  try {
    await db.prepare(`UPDATE personas SET name=?, description=?, prompt=?, model=?, tools_json=?, max_tokens=?, effort=?, context_mode=?, auto_use=?, updated_at=datetime('now') WHERE id=? AND scope=?`)
      .bind(p.v.name ?? cur.name, p.v.description ?? cur.description, p.v.prompt ?? cur.prompt, p.v.model ?? cur.model, tools, p.v.maxTokens ?? cur.max_tokens, p.v.effort === undefined ? cur.effort : p.v.effort, p.v.contextMode ?? (cur.context_mode ?? "task"), p.v.autoUse === undefined ? (cur.auto_use ?? 1) : p.v.autoUse ? 1 : 0, id, scope).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return err(409, "a persona with this name already exists");
    throw e;
  }
  return { status: 200, body: { persona: toPersona((await db.prepare(`SELECT ${COLS} FROM personas WHERE id=? AND scope=?`).bind(id, scope).first<Row>())!, noPersonalTools(scope)) } };
}

export async function deletePersona(db: D1Database, scope: Scope, id: string): Promise<CrudResult<{ ok: true }>> {
  if (!(await db.prepare(`SELECT id FROM personas WHERE id=? AND scope=?`).bind(id, scope).first())) return err(404, "not found");
  await db.prepare(`DELETE FROM personas WHERE id=? AND scope=?`).bind(id, scope).run();
  return { status: 200, body: { ok: true } };
}
