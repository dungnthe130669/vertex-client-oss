// Devices v2: a DEVICE conversation belongs to the one user pinned in conversations.env_user, not to the scope. Every query that lists or joins conversations of a scope
// (list, keyword/semantic search, project filter, usage top, library) must add this clause, or titles / message text of someone else's device chat leak to the scope.
// Migration 0042 not applied (no env_* columns) => no device chat can exist, so the clause is dropped; any OTHER D1 error propagates (never a silent fail-open).
export const devClause = (alias: string, user: string) => ({ sql: ` AND (${alias}.env_kind IS NULL OR ${alias}.env_kind <> 'device' OR ${alias}.env_user = ?)`, args: [user] as unknown[] });
export const noEnvColumn = (e: unknown) => /no such column/i.test(e instanceof Error ? e.message : String(e)) && /env_/i.test(e instanceof Error ? e.message : String(e));

/** Run `q(clause, args)` with the visibility clause; if the env_* columns do not exist yet, run it once more without. */
export async function withDevVisibility<T>(alias: string, user: string, q: (clause: string, args: unknown[]) => Promise<T>): Promise<T> {
  const c = devClause(alias, user);
  try { return await q(c.sql, c.args); }
  catch (e) { if (!noEnvColumn(e)) throw e; return q("", []); }
}
