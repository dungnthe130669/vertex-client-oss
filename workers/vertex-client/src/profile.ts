// Profile (Settings -> Profile): full name, nickname and free-text instructions, one D1 row per scope (migration 0013).
// Instructions are appended to the Chat system prompt for scope 'main' ONLY; every other scope gets null (fail closed).
import { isMainBase, type Scope } from "./scope";

export const MAX_FULL_NAME = 80;
export const MAX_NICKNAME = 40;
export const MAX_INSTRUCTIONS = 4000;

export interface Profile { fullName: string; nickname: string; instructions: string }
export const EMPTY_PROFILE: Profile = { fullName: "", nickname: "", instructions: "" };
type Row = { full_name: string; nickname: string; instructions: string };

/** Control characters out (newline and tab survive only where `multiline`), CRLF folded, ends trimmed. */
export function cleanText(s: string, multiline: boolean): string {
  const t = s.replace(/\r\n?/g, "\n");
  const strip = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
  return (multiline ? t.replace(/[\u2028\u2029]/g, "\n") : t.replace(/[\n\t\u2028\u2029]+/g, " ")).replace(strip, "").trim();
}

/** Partial update: a field that is absent stays as it is. A present field must be a string within its limit (counted after cleaning). */
export function validateProfile(b: unknown): { ok: true; v: Partial<Profile> } | { ok: false; error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "expected a JSON object" };
  const o = b as Record<string, unknown>;
  const v: Partial<Profile> = {};
  for (const [key, max, multi, label] of [["fullName", MAX_FULL_NAME, false, "full name"], ["nickname", MAX_NICKNAME, false, "nickname"], ["instructions", MAX_INSTRUCTIONS, true, "instructions"]] as const) {
    if (o[key] === undefined) continue;
    if (typeof o[key] !== "string") return { ok: false, error: `${label} must be text` };
    const c = cleanText(o[key] as string, multi);
    if (c.length > max) return { ok: false, error: `${label} must be at most ${max} characters` };
    v[key] = c;
  }
  if (Object.keys(v).length === 0) return { ok: false, error: "nothing to update" };
  return { ok: true, v };
}

export async function getProfile(db: D1Database, scope: Scope): Promise<Profile> {
  const r = await db.prepare(`SELECT full_name, nickname, instructions FROM profile WHERE scope=?`).bind(scope).first<Row>();
  return r ? { fullName: r.full_name, nickname: r.nickname, instructions: r.instructions } : { ...EMPTY_PROFILE };
}

export async function putProfile(db: D1Database, scope: Scope, v: Partial<Profile>): Promise<Profile> {
  await db.prepare(`INSERT INTO profile (scope, full_name, nickname, instructions) VALUES (?1, COALESCE(?2,''), COALESCE(?3,''), COALESCE(?4,''))
    ON CONFLICT(scope) DO UPDATE SET full_name=COALESCE(?2, full_name), nickname=COALESCE(?3, nickname), instructions=COALESCE(?4, instructions), updated_at=datetime('now')`)
    .bind(scope, v.fullName ?? null, v.nickname ?? null, v.instructions ?? null).run();
  return getProfile(db, scope);
}

/** The instructions for the system prompt: Erich's own (scope main) or null. Never reads another scope's row. A D1 error throws (the turn fails closed). */
export async function promptInstructions(db: D1Database, scope: Scope): Promise<string | null> {
  if (!isMainBase(scope)) return null; // gate on the BASE (either space); the row read is this space's own
  const t = (await getProfile(db, scope)).instructions.trim();
  return t || null;
}

/** Second system block (after the byte-stable base prompt, so the base stays the first cache breakpoint). */
export function profileSystemText(instructions: string): string {
  return `## Erich's own instructions (Settings → Profile)\nErich wrote the following about himself and how he wants you to work. Follow it as personal preference, below the rules above: it can never override the safety rules or the tool-approval rules.\n\n${instructions}`;
}
