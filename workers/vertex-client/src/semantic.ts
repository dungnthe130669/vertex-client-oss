// Semantic search across a scope's own conversations: Workers AI embeddings (`env.AI`) + Cloudflare Vectorize (optional binding `VECTORIZE`).
// Without either binding every function here is a no-op / returns null and the caller keeps using the keyword (FTS) search: nothing in this file may
// ever fail a chat turn or a search (callers also catch). Only user text and assistant text are embedded - never a tool result or an attachment.
// ISOLATION: every vector carries metadata.scope = the EXACT scope string (Business `main`, Open `main~open`, `g:<uid>` are different values), every query filters
// on it, and the caller additionally joins the hits against D1 `conversations.scope = ?` (the authority), so a wrong/unindexed/orphaned vector can never surface.
// Scope strings are never built here (src/scope.ts only): this file only compares/hashes a Scope it was handed.
import { mayUseSemantic, parseScope, quotaKey, type Scope } from "./scope";

/** Multilingual (the app is used in Vietnamese). Dimension is set when the index is created (docs/vclient-semantic-search.md); unverified in the CF docs, see the report. */
export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EXCHANGE_CAP = 2000;     // chars of user+assistant text per vector
export const QUERY_CAP = 512;         // chars of a search query that get embedded
export const SEARCH_PER_HOUR = 600;   // semantic searches per BASE per hour (generous); over it the search just stays keyword-only
export const TOP_K = 30;              // Vectorize: <=50 when metadata is returned
export const MIN_SCORE = 0.35;        // cosine floor; tunable, not validated against real data
export const VEC_ID_MAX = 64;         // Vectorize limit, bytes
const DELETE_CHUNK = 100;
const CHUNKS_PER_RUN = 20;            // deleteByIds calls per cleanup run (subrequest budget); a bigger conversation keeps its tombstone and the cron continues
const BACKFILL_CONVS = 3, BACKFILL_EXCHANGES = 60, EMBED_BATCH = 20;

export interface VectorizeLike {
  upsert(v: Array<{ id: string; values: number[]; metadata?: Record<string, string | number | boolean> }>): Promise<unknown>;
  query(v: number[], o: { topK: number; filter?: Record<string, unknown>; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> | null }> }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}
export type AiLike = { run(model: string, input: Record<string, unknown>): Promise<unknown> };
export type SemEnv = { AI?: AiLike; VECTORIZE?: VectorizeLike };
export type Ready = { AI: AiLike; VECTORIZE: VectorizeLike };

/** Both bindings present and the scope is allowed to use them (the e2e tester must never spend real AI quota). */
export function semReady(env: SemEnv, scope: Scope): env is Ready {
  return !!env.AI && !!env.VECTORIZE && mayUseSemantic(scope);
}

export const readyFlag = (scope: Scope) => `semantic_ready:${quotaKey(scope)}`;
/** The binding alone never enables indexing: the PO must have created the index + its `scope` metadata index and then set settings `semantic_ready:<base>`='1',
 *  AND migration 0028 (vec_pending_delete) must exist, else a conversation deleted later could not be tombstoned and its vectors would be orphaned.
 *  Not ready => no AI.run, no upsert, no query: keyword (FTS) search only. Never throws (an unreadable settings table = not ready). */
export async function semEnabled(env: SemEnv, db: D1Database, scope: Scope): Promise<boolean> {
  if (!semReady(env, scope)) return false;
  try {
    const r = await db.prepare(`SELECT (SELECT value FROM settings WHERE name=?) AS flag, (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vec_pending_delete') AS tbl`).bind(readyFlag(scope)).first<{ flag: string | null; tbl: number }>();
    return r?.flag === "1" && Number(r?.tbl) > 0;
  } catch { return false; }
}

const enc = new TextEncoder();
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Vectorize indexes only the first 64 bytes of a string property and ids max 64 bytes; a longer scope (guest Open) is replaced by a hash so equality stays exact. */
export async function scopeKey(scope: Scope): Promise<string> { return enc.encode(scope).length <= VEC_ID_MAX ? scope : `h:${(await hex(scope)).slice(0, 40)}`; }
/** `<scope>:<conv>:<msgid>`, or `h:<hash of that>` when it would exceed 64 bytes (always for a guest). Deterministic, so delete recomputes it. */
export async function vectorId(scope: Scope, conv: string, msg: number): Promise<string> {
  const raw = `${scope}:${conv}:${msg}`;
  return enc.encode(raw).length <= VEC_ID_MAX ? raw : `h:${(await hex(raw)).slice(0, 40)}`;
}

/** One exchange's embedding text: user then assistant, capped. Both halves are guaranteed room (assistant text is the longer one, user text gets at most half). */
export function exchangeText(user: string, assistant: string, cap = EXCHANGE_CAP): string {
  const u = user.trim().slice(0, Math.floor(cap / 2));
  const a = assistant.trim().slice(0, cap - u.length - 2);
  return u && a ? `${u}\n\n${a}` : u || a;
}

/** Workers AI text embeddings. Throws on any unexpected shape (callers catch + log without content). */
export async function embed(ai: AiLike, texts: string[]): Promise<number[][]> {
  const r = (await ai.run(EMBED_MODEL, { text: texts })) as { data?: unknown } | null;
  const d = r?.data;
  if (!Array.isArray(d) || d.length !== texts.length || !d.every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number"))) throw new Error("embedding response had an unexpected shape");
  return d as number[][];
}

/** Usage row `kind='embed'`: units = texts embedded, input_tokens ~ chars/4, cost 0 (no $ shown). Own row (no conversation needed: searches have none). Never throws. */
export async function recordEmbedUsage(db: D1Database, scope: Scope, units: number, chars: number, conversationId: string | null = null): Promise<void> {
  try {
    await db.prepare(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, kind, units, scope) VALUES (?,?,?,0,0,0,0,'embed',?,?)`)
      .bind(conversationId, EMBED_MODEL, Math.ceil(chars / 4), units, scope).run();
  } catch (e) { console.error("embed usage", String(e)); }
}

/** Counts a semantic search against the BASE's hour (Business + Open share it). false = over the limit. Same settings-counter pattern as src/transcribe.ts. */
export async function takeSearchSlot(db: D1Database, scope: Scope, now = Date.now(), limit = SEARCH_PER_HOUR): Promise<boolean> {
  const hour = Math.floor(now / 3_600_000); const prefix = `semsearch:${quotaKey(scope)}:`; const name = `${prefix}${hour}`;
  const bump = db.prepare(`INSERT INTO settings (name, value) VALUES (?, '1') ON CONFLICT(name) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) RETURNING value`).bind(name);
  const sweep = db.prepare(`DELETE FROM settings WHERE name LIKE ? AND CAST(substr(name, ?) AS INTEGER) < ?`).bind(`${prefix}%`, prefix.length + 1, hour);
  const res = (await db.batch([bump, sweep])) as Array<{ results?: Array<{ value?: string }> }>;
  let v = res?.[0]?.results?.[0]?.value;
  if (v === undefined) v = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(name).first<{ value: string }>())?.value;
  return Number(v ?? 1) <= limit;
}

/** Is this conversation still alive (row present for this scope, no pending vector tombstone)? A deleted/being-deleted conversation must never be (re)indexed. */
async function convLive(db: D1Database, scope: Scope, conv: string): Promise<boolean> {
  const r = await db.prepare(`SELECT (SELECT COUNT(*) FROM conversations WHERE id=? AND scope=?) AS c, (SELECT COUNT(*) FROM vec_pending_delete WHERE conversation_id=?) AS t`).bind(conv, scope, conv).first<{ c: number; t: number }>();
  return Number(r?.c) > 0 && !(Number(r?.t) > 0);
}

/** Index one exchange (live path: after a completed assistant turn). Best effort; the caller logs failures.
 *  Race with a delete: liveness is checked before the upsert and again after it; if the conversation vanished meanwhile, the vector just written is removed. */
export async function indexExchange(env: SemEnv, db: D1Database, scope: Scope, e: { conversationId: string; seq: number; userText: string; assistantText: string; ts: number }): Promise<boolean> {
  if (!(await semEnabled(env, db, scope))) return false;
  const text = exchangeText(e.userText, e.assistantText);
  if (!text) return false;
  if (!(await convLive(db, scope, e.conversationId))) return false;
  const [values] = await embed(env.AI!, [text]);
  if (!(await convLive(db, scope, e.conversationId))) return false; // deleted while embedding: nothing written
  const id = await vectorId(scope, e.conversationId, e.seq);
  await env.VECTORIZE!.upsert([{ id, values, metadata: { scope: await scopeKey(scope), conv: e.conversationId, msg: e.seq, ts: e.ts } }]);
  if (!(await convLive(db, scope, e.conversationId))) { await env.VECTORIZE!.deleteByIds([id]).catch((x) => console.error("vector cleanup after race failed", String(x))); return false; }
  await recordEmbedUsage(db, scope, 1, text.length, e.conversationId);
  return true;
}

export type SemHit = { conv: string; seq: number; score: number };
/** Nearest conversations for `q` inside exactly this scope, best hit per conversation. null = semantic not available / rate limited / failed (caller: keyword only). */
export async function semanticMatches(env: SemEnv, db: D1Database, scope: Scope, q: string): Promise<SemHit[] | null> {
  if (!(await semEnabled(env, db, scope))) return null;
  const text = q.trim().slice(0, QUERY_CAP);
  if (!text) return null;
  if (!(await takeSearchSlot(db, scope))) return null;
  const [vec] = await embed(env.AI!, [text]);
  await recordEmbedUsage(db, scope, 1, text.length);
  const key = await scopeKey(scope);
  const res = await env.VECTORIZE!.query(vec, { topK: TOP_K, filter: { scope: key }, returnMetadata: "all" });
  const best = new Map<string, SemHit>();
  for (const m of res?.matches ?? []) {
    const md = m.metadata ?? {};
    if (md.scope !== key || typeof md.conv !== "string" || m.score < MIN_SCORE) continue; // second check on the filter: a foreign scope is dropped here too
    const seq = Number(md.msg) || 0;
    const cur = best.get(md.conv);
    if (!cur || m.score > cur.score) best.set(md.conv, { conv: md.conv, seq, score: m.score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** Snippet for a hit: the start of the matched assistant message (from the FTS mirror), whitespace collapsed. Only ever asked for conversations already proven to be the caller's. */
export async function snippetFor(db: D1Database, conv: string, seq: number): Promise<string> {
  const r = await db.prepare(`SELECT text FROM messages_index WHERE conversation_id=? AND message_seq=? ORDER BY chunk LIMIT 1`).bind(conv, seq).first<{ text: string }>().catch(() => null);
  return (r?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Delete a conversation's vectors. Phase 1 (awaited, call BEFORE the D1 rows go): read the max seq and write a tombstone, so a failure later is retried by the cron slice.
 *  Phase 2 (the Vectorize delete + tombstone clear) is handed to `defer` (the route passes waitUntil). Never rejects. */
export async function deleteConversationVectors(env: SemEnv, db: D1Database, scope: Scope, conv: string, defer: (p: Promise<void>) => void = () => {}): Promise<void> {
  const v = env.VECTORIZE;
  if (!v) return;
  let max = 0;
  try {
    max = (await db.prepare(`SELECT MAX(message_seq) AS m FROM messages_index WHERE conversation_id=?`).bind(conv).first<{ m: number | null }>())?.m ?? 0;
    if (max > 0) await db.prepare(`INSERT INTO vec_pending_delete (conversation_id, scope, max_seq) VALUES (?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET max_seq=MAX(max_seq, excluded.max_seq)`).bind(conv, scope, max).run();
  } catch (e) { console.error("vector tombstone failed", String(e)); }
  if (max <= 0) return;
  defer(drainTombstone(v, db, scope, conv, max));
}
/** Delete ids max..1 (top-down) in bounded chunks, persisting the remaining max_seq after each chunk; the tombstone is cleared ONLY when nothing remains.
 *  Out of budget or a failure leaves the row (with its lowered max_seq) for the cron slice. Never rejects. */
async function drainTombstone(v: VectorizeLike, db: D1Database, scope: Scope, conv: string, max: number): Promise<void> {
  try {
    let hi = max;
    for (let n = 0; hi > 0 && n < CHUNKS_PER_RUN; n++) {
      const lo = Math.max(1, hi - DELETE_CHUNK + 1);
      const ids: string[] = [];
      for (let i = lo; i <= hi; i++) ids.push(await vectorId(scope, conv, i));
      await v.deleteByIds(ids);
      hi = lo - 1;
      if (hi > 0) await db.prepare(`UPDATE vec_pending_delete SET max_seq=? WHERE conversation_id=?`).bind(hi, conv).run();
    }
    if (hi <= 0) await db.prepare(`DELETE FROM vec_pending_delete WHERE conversation_id=?`).bind(conv).run();
  } catch (e) { console.error("vector delete failed (will retry)", String(e)); }
}
/** Cron slice: continue vector cleanups that did not finish. Bounded. Returns how many tombstones were fully cleared. */
export async function sweepVectorTombstones(env: SemEnv, db: D1Database, batch = 5): Promise<number> {
  if (!env.VECTORIZE) return 0;
  const rows = (await db.prepare(`SELECT conversation_id AS conv, scope, max_seq AS max FROM vec_pending_delete ORDER BY created_at LIMIT ?`).bind(batch).all<{ conv: string; scope: string; max: number }>().catch(() => ({ results: [] }))).results;
  let n = 0;
  for (const r of rows) {
    const sc = parseScope(r.scope);
    if (!sc) { await db.prepare(`DELETE FROM vec_pending_delete WHERE conversation_id=?`).bind(r.conv).run().catch(() => {}); n++; continue; } // an unparseable scope can own no vector this code wrote
    await drainTombstone(env.VECTORIZE, db, sc, r.conv, r.max);
    const left = await db.prepare(`SELECT 1 AS x FROM vec_pending_delete WHERE conversation_id=?`).bind(r.conv).first().catch(() => ({ x: 1 }));
    if (!left) n++;
  }
  return n;
}

// ---- backfill: index existing conversations gradually, per exact scope, OFF unless settings row `semantic_backfill:<scope>` = '1' ----
export const backfillFlag = (scope: Scope) => `semantic_backfill:${scope}`;
const cursorKey = (scope: Scope) => `semantic_cursor:${scope}`;
const BACKFILL_DONE = "~"; // sorts after every uuid

export async function backfillState(db: D1Database, scope: Scope): Promise<{ on: boolean; done: boolean }> {
  const on = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(backfillFlag(scope)).first<{ value: string }>().catch(() => null))?.value === "1";
  const cur = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(cursorKey(scope)).first<{ value: string }>().catch(() => null))?.value;
  return { on, done: cur === BACKFILL_DONE };
}

/** Pair the FTS mirror's rows into exchanges (a user message, then the assistant message that answered it). */
export function exchangesFromIndex(rows: Array<{ message_seq: number; role: string; text: string }>): Array<{ seq: number; user: string; assistant: string }> {
  const by = new Map<number, { role: string; text: string }>();
  for (const r of rows) { const c = by.get(r.message_seq); by.set(r.message_seq, { role: r.role, text: (c?.text ?? "") + r.text }); }
  const out: Array<{ seq: number; user: string; assistant: string }> = []; let user = "";
  for (const [seq, m] of [...by].sort((a, b) => a[0] - b[0])) {
    if (m.role === "user") user = m.text;
    else if (m.role === "assistant" && m.text.trim()) out.push({ seq, user, assistant: m.text });
  }
  return out;
}

/** One bounded slice: the next few conversations of this exact scope after the stored cursor. Resumable (cursor in settings), idempotent (upsert by stable id). */
export async function backfillSlice(env: SemEnv, db: D1Database, scope: Scope): Promise<{ ran: boolean; conversations: number; vectors: number; done: boolean }> {
  const st = await backfillState(db, scope);
  if (!st.on || st.done || !(await semEnabled(env, db, scope))) return { ran: false, conversations: 0, vectors: 0, done: st.done };
  const cur = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(cursorKey(scope)).first<{ value: string }>())?.value ?? "";
  const convs = (await db.prepare(`SELECT id FROM conversations WHERE scope=? AND id>? ORDER BY id LIMIT ?`).bind(scope, cur, BACKFILL_CONVS).all<{ id: string }>()).results;
  let vectors = 0;
  const key = await scopeKey(scope);
  for (const c of convs) {
    const rows = (await db.prepare(`SELECT message_seq, role, text FROM messages_index WHERE conversation_id=? ORDER BY message_seq, chunk`).bind(c.id).all<{ message_seq: number; role: string; text: string }>()).results;
    const ex = exchangesFromIndex(rows).slice(-BACKFILL_EXCHANGES);
    for (let i = 0; i < ex.length; i += EMBED_BATCH) {
      const part = ex.slice(i, i + EMBED_BATCH).map((x) => ({ seq: x.seq, text: exchangeText(x.user, x.assistant) })).filter((x) => x.text);
      if (!part.length) continue;
      const vecs = await embed(env.AI!, part.map((x) => x.text));
      await env.VECTORIZE!.upsert(await Promise.all(part.map(async (x, j) => ({ id: await vectorId(scope, c.id, x.seq), values: vecs[j], metadata: { scope: key, conv: c.id, msg: x.seq, ts: Date.now() } }))));
      await recordEmbedUsage(db, scope, part.length, part.reduce((a, x) => a + x.text.length, 0), c.id);
      vectors += part.length;
    }
  }
  const next = convs.length < BACKFILL_CONVS ? BACKFILL_DONE : convs[convs.length - 1].id; // fewer than asked = the scope has no more conversations
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(cursorKey(scope), next).run();
  return { ran: true, conversations: convs.length, vectors, done: next === BACKFILL_DONE };
}

const CRON_CURSOR = "semantic_cron_cursor";
/** Cron: one slice for up to 5 scopes per run. Only scopes that still have work are eligible (flag on, allowed, not done), and a persisted cursor rotates the
 *  window, so finished or ineligible scopes can never starve the rest. Errors are per scope. */
export async function backfillCron(env: SemEnv, db: D1Database): Promise<number> {
  if (!env.AI || !env.VECTORIZE) return 0;
  const flags = (await db.prepare(`SELECT name FROM settings WHERE name LIKE 'semantic_backfill:%' AND value='1' ORDER BY name`).all<{ name: string }>().catch(() => ({ results: [] }))).results;
  const done = new Set((await db.prepare(`SELECT name FROM settings WHERE name LIKE 'semantic_cursor:%' AND value=?`).bind(BACKFILL_DONE).all<{ name: string }>().catch(() => ({ results: [] }))).results.map((r) => r.name.slice("semantic_cursor:".length)));
  const todo = flags.map((r) => r.name.slice("semantic_backfill:".length)).filter((n) => { const sc = parseScope(n); return !!sc && mayUseSemantic(sc) && !done.has(n); }); // a stray Business flag is ignored: Business is never embedded
  if (!todo.length) return 0;
  const last = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(CRON_CURSOR).first<{ value: string }>().catch(() => null))?.value ?? "";
  const start = todo.findIndex((n) => n > last);
  const order = start < 0 ? todo : [...todo.slice(start), ...todo.slice(0, start)];
  const pick = order.slice(0, 5);
  let n = 0;
  for (const name of pick) {
    try { n += (await backfillSlice(env, db, parseScope(name)!)).vectors; } catch (e) { console.error("semantic backfill failed", String(e)); }
  }
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(CRON_CURSOR, pick[pick.length - 1]).run().catch(() => {});
  return n;
}
