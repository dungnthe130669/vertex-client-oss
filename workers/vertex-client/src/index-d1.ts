// D1 side of a conversation: list row, FTS index of message text, usage roll-up. Best-effort by design — the DO's
// SQLite is the source of truth, so callers swallow+log failures instead of failing a turn.
import type { IndexSink } from "./turn-engine";
import { GEN_CONFIRM_USD_DEFAULT } from "./gen-cost";
import { resolveScope } from "./auth-e2e";
import { providerOfModel } from "./providers/config";
import { answerLimitDefault, isAnswerLimit, type AnswerLimit } from "./output-budget";
import { indexExchange, type SemEnv } from "./semantic";
import { GUEST_CEILING, baseOf, isGuestScope, scopeFor, turnCapFor, type Scope } from "./scope";

export const CHUNK = 8000;

export function chunkText(t: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < t.length; i += CHUNK) out.push(t.slice(i, i + CHUNK));
  return out;
}

const SLOT_STALE_MS = 10 * 60_000;

/** `scopeOf` = the owning DO's own fail-closed scope lookup; without it the scope is read from the conversation row (same fail-closed rule). */
export function d1Index(db: D1Database, scopeOf?: () => Promise<Scope>, sem?: SemEnv): IndexSink {
  return {
    ...(sem?.AI && sem.VECTORIZE ? { async indexExchange(e) {
      let scope: Scope; try { scope = await (scopeOf ?? (() => resolveScope(db, e.conversationId)))(); } catch { return; } // unresolvable scope => never indexed
      await indexExchange(sem, db, scope, e);
    } } : {}),
    async acquireSlot(conversationId) {
      // Unknown / unresolvable scope => no slot (the turn is refused), never a default to main.
      let scope: Scope;
      try { scope = await (scopeOf ?? (() => resolveScope(db, conversationId)))(); } catch { return false; }
      const now = Date.now();
      await db.prepare(`DELETE FROM active_turns WHERE started_at < ?`).bind(now - SLOT_STALE_MS).run();
      await db.prepare(`INSERT INTO active_turns (conversation_id, started_at, scope) VALUES (?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET started_at=excluded.started_at, scope=excluded.scope`).bind(conversationId, now, scope).run();
      // Count after inserting: if we are over a limit, give the slot back and refuse (a rare double-refusal on a race is fine).
      // Caps are per scope (main 3, each guest 1) plus one ceiling over all guests together; main only ever counts main rows, so guests cannot starve it.
      // The per-user cap counts by BASE (Business + Open rows together), so opening a second space cannot double it.
      const base = baseOf(scope);
      const n = (await db.prepare(`SELECT COUNT(*) AS n FROM active_turns WHERE scope IN (?,?)`).bind(scopeFor(base, "biz"), scopeFor(base, "open")).first<{ n: number }>())?.n ?? 0;
      const guests = isGuestScope(base) ? (await db.prepare(`SELECT COUNT(*) AS n FROM active_turns WHERE scope LIKE 'g:%'`).first<{ n: number }>())?.n ?? 0 : 0;
      if (n > turnCapFor(base) || guests > GUEST_CEILING) { await db.prepare(`DELETE FROM active_turns WHERE conversation_id=?`).bind(conversationId).run(); return false; }
      return true;
    },
    async releaseSlot(conversationId) { await db.prepare(`DELETE FROM active_turns WHERE conversation_id=?`).bind(conversationId).run(); },
    async indexMessage({ conversationId, seq, role, text }) {
      const chunks = chunkText(text);
      if (!chunks.length) return;
      await db.batch(chunks.map((c, i) =>
        db.prepare(`INSERT INTO messages_index (conversation_id, message_seq, chunk, role, text) VALUES (?,?,?,?,?)
                    ON CONFLICT(conversation_id, message_seq, chunk) DO NOTHING`).bind(conversationId, seq, i, role, c)));
    },
    async updateConversation({ id, model, costUsd, tokens, title }) {
      if (title !== undefined) await db.prepare(`UPDATE conversations SET model=?, cost_usd=?, tokens=?, title=?, updated_at=datetime('now') WHERE id=?`).bind(model, costUsd, tokens, title, id).run();
      else await db.prepare(`UPDATE conversations SET model=?, cost_usd=?, tokens=?, updated_at=datetime('now') WHERE id=?`).bind(model, costUsd, tokens, id).run();
    },
    /** Inline title: write it only while the D1 title is still empty, so a rename made during the first reply is never overwritten. */
    async applyAutoTitle({ id, title }) {
      const r = await db.prepare(`UPDATE conversations SET title=?, updated_at=datetime('now') WHERE id=? AND (title IS NULL OR title='')`).bind(title, id).run();
      return Number((r.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
    },
    /** Counter only (settings row per outcome+model), never any content. */
    async countInlineTitle({ outcome, model }) {
      await db.prepare(`INSERT INTO settings (name, value) VALUES (?, '1') ON CONFLICT(name) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)`).bind(`inline_title:${outcome}:${model.slice(0, 80)}`).run();
    },
    async recordUsage({ conversationId, model, usage, costUsd, kind, estUsd, units, dispatchId, routed, sub }) {
      // The row inherits the conversation's scope. No conversation row => nothing to attribute it to: skip + log, never fall back to main.
      // Generation rows carry kind/est_usd/units (migration 0009). Chat rows keep the original INSERT so they never depend on it.
      // dispatch_id (migration 0011, apply before deploy) makes them idempotent: a retry of the same dispatch is a no-op.
      let r: D1Result;
      if (kind && kind !== "chat") {
        r = await db.prepare(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, kind, est_usd, units, dispatch_id, scope)
          SELECT ?,?,?,?,?,?,?,?,?,?,?, c.scope FROM conversations c WHERE c.id=?
          ON CONFLICT(dispatch_id) WHERE dispatch_id IS NOT NULL DO NOTHING`)
          .bind(conversationId, model, usage.input_tokens ?? 0, usage.output_tokens ?? 0, 0, 0, costUsd, kind, estUsd ?? null, units ?? 1, dispatchId ?? null, conversationId).run();
      } else {
        const base = [conversationId, model, usage.input_tokens ?? 0, usage.output_tokens ?? 0, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0, costUsd];
        const provider = providerOfModel(model);
        // `provider` (migration 0021) is written only for non-gateway providers (NULL = gateway), and a missing column falls back to the
        // original INSERT, so the gateway path never depends on the migration and a non-gateway row is never lost to a not-yet-applied one.
        const plain = () => db.prepare(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, scope)
          SELECT ?,?,?,?,?,?,?, c.scope FROM conversations c WHERE c.id=?`).bind(...base, conversationId).run();
        // Subagent rows (migration 0024): persona + parent turn; a missing column falls back to the plain INSERT (row kept, tag lost).
        if (sub) r = await db.prepare(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, provider, persona, parent_turn, scope)
          SELECT ?,?,?,?,?,?,?,?,?,?, c.scope FROM conversations c WHERE c.id=?`).bind(...base, provider === "gateway" ? null : provider, sub.persona, sub.turn, conversationId).run()
          .catch((e) => { if (!/no such column[^]*(persona|parent_turn)|(persona|parent_turn)[^]*no such column/i.test(String(e))) throw e; return plain(); }); // only a missing 0024 column falls back; anything else surfaces (caller logs)
        else
        // `routed_*` (migration 0023) is written only when auto shadow recorded a route; a missing column falls back to the plain INSERT (row kept, route lost).
        if (routed) r = await db.prepare(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, provider, routed_by, routed_model, routed_reason, scope)
          SELECT ?,?,?,?,?,?,?,?,?,?,?, c.scope FROM conversations c WHERE c.id=?`).bind(...base, provider === "gateway" ? null : provider, routed.by, routed.model, routed.reason, conversationId).run()
          .catch(() => (provider === "gateway" ? plain() : db.prepare(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, provider, scope)
          SELECT ?,?,?,?,?,?,?,?, c.scope FROM conversations c WHERE c.id=?`).bind(...base, provider, conversationId).run().catch(() => plain())));
        else if (provider === "gateway") r = await plain();
        else r = await db.prepare(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, provider, scope)
          SELECT ?,?,?,?,?,?,?,?, c.scope FROM conversations c WHERE c.id=?`).bind(...base, provider, conversationId).run().catch(() => plain());
      }
      if (r?.meta?.changes === 0 && !(await db.prepare(`SELECT 1 AS x FROM conversations WHERE id=?`).bind(conversationId).first())) console.error("usage skipped: conversation not found", conversationId);
    },
  };
}

/** Turn free text into a safe FTS5 MATCH expression: quoted tokens, last one a prefix. null = nothing searchable. */
export function ftsQuery(q: string): string | null {
  const toks = q.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
  if (!toks.length) return null;
  return toks.map((t, i) => `"${t}"${i === toks.length - 1 ? "*" : ""}`).join(" ");
}

/** Auto model SHADOW setting: one `settings` row per scope (`auto_shadow:<scope>`), absent = OFF. Records the route only; never changes the model. */
export async function loadAutoShadow(db: D1Database, scope: string): Promise<boolean> {
  const r = await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`auto_shadow:${scope}`).first<{ value: string }>().catch(() => null);
  return r?.value === "1";
}
export async function saveAutoShadow(db: D1Database, scope: string, on: boolean): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`auto_shadow:${scope}`, on ? "1" : "0").run();
}

/** Auto's OPTIONAL worst-case $ ceiling per message (`auto_max_usd:<scope>`); absent/invalid = null = no ceiling. */
export async function loadAutoMaxUsd(db: D1Database, scope: string): Promise<number | null> {
  const r = await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`auto_max_usd:${scope}`).first<{ value: string }>().catch(() => null);
  const v = Number(r?.value);
  return r && Number.isFinite(v) && v > 0 ? v : null;
}

/** Open failover toggle ("Auto-switch models when one fails"): one `settings` row per scope (`open_failover:<scope>`), absent = ON; only "0" turns it off. Open only: Business never reads it. */
/** THE one place the failover default lives (product decision, Erich 2026-10-26: ON; flip it here). */
export const OPEN_FAILOVER_DEFAULT_ON = true;
export async function loadOpenFailover(db: D1Database, scope: string): Promise<boolean> {
  try {
    const r = await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`open_failover:${scope}`).first<{ value: string }>();
    return r?.value === "1" ? true : r?.value === "0" ? false : OPEN_FAILOVER_DEFAULT_ON; // a stored choice always wins; no row = the default
  } catch { return false; } // fail CLOSED: a D1 read error never turns failover on (it could override an opt-out)
}
/** "Allow Google AI Studio as an automatic fallback" (Google may use the conversation to improve its products): `open_failover_aistudio:<scope>`, default OFF; only "1" allows; any read error = off. */
export async function loadOpenFailoverAistudio(db: D1Database, scope: string): Promise<boolean> {
  try { return (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`open_failover_aistudio:${scope}`).first<{ value: string }>())?.value === "1"; } catch { return false; }
}
export async function saveOpenFailoverAistudio(db: D1Database, scope: string, on: boolean): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`open_failover_aistudio:${scope}`, on ? "1" : "0").run();
}
export async function saveOpenFailover(db: D1Database, scope: string, on: boolean): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`open_failover:${scope}`, on ? "1" : "0").run();
}

/** Auto-delegate setting: one `settings` row per scope (`auto_delegate:<scope>`), absent = OFF. ON adds a short paragraph to the system prompt telling the chat when to use `delegate` by itself. */
export async function loadAutoDelegate(db: D1Database, scope: string): Promise<boolean> {
  const r = await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`auto_delegate:${scope}`).first<{ value: string }>().catch(() => null);
  return r?.value === "1";
}
/** e2e real-provider opt-in: settings row `e2e_real_providers:<base>`, '1' enables, absent / anything else / a lookup error = OFF (fail closed). Only ever read for the e2e base. */
export async function loadE2eRealProviders(db: D1Database | undefined, base: string): Promise<boolean> {
  if (base !== "e2e" || !db) return false;
  try { return (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`e2e_real_providers:${base}`).first<{ value: string }>())?.value === "1"; } catch { return false; }
}
/** Open live-data cue nudge: settings row `open_force_tool_cues`, default ON, '0' disables. A lookup error = off (fail closed). */
export async function loadForceToolCues(db: D1Database): Promise<boolean> {
  try { const r = await db.prepare(`SELECT value FROM settings WHERE name='open_force_tool_cues'`).first<{ value: string }>(); return r?.value !== "0"; } catch { return false; }
}
/** Turn diagnostics: settings row `debug_turns:<base>` = '1' (default off; a lookup error = off). */
export async function loadDebugTurns(db: D1Database, base: string): Promise<boolean> {
  try { return (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`debug_turns:${base}`).first<{ value: string }>())?.value === "1"; } catch { return false; }
}
/** Answer-length switch: settings row `answer_limit:<base>` = 'off' | 'default'. Absent / unreadable = the edition default (main/e2e: off = no limit; a team user: default). */
export async function loadAnswerLimit(db: D1Database, base: string, guest: boolean): Promise<AnswerLimit> {
  try { const v = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`answer_limit:${base}`).first<{ value: string }>())?.value; return isAnswerLimit(v) ? v : answerLimitDefault(guest); } catch { return answerLimitDefault(guest); }
}
export async function saveAnswerLimit(db: D1Database, base: string, v: AnswerLimit): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`answer_limit:${base}`, v).run();
}
export async function saveAutoDelegate(db: D1Database, scope: string, on: boolean): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`auto_delegate:${scope}`, on ? "1" : "0").run();
}

/** Generation confirm line: settings row `gen_confirm_usd` (editable without a deploy), default 1.00. A prompt threshold, never a cap. */
export async function loadConfirmUsd(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT value FROM settings WHERE name='gen_confirm_usd'`).first<{ value: string }>().catch(() => null);
  const v = Number(r?.value);
  return r && Number.isFinite(v) && v >= 0 ? v : GEN_CONFIRM_USD_DEFAULT;
}

export async function saveAutoMaxUsd(db: D1Database, scope: string, usd: number | null): Promise<void> {
  if (usd === null) { await db.prepare(`DELETE FROM settings WHERE name=?`).bind(`auto_max_usd:${scope}`).run(); return; }
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(`auto_max_usd:${scope}`, String(usd)).run();
}
