-- Semantic chat search (src/semantic.ts), additive only. Vectors live in the optional Vectorize index `vclient-chats`; this table only remembers a
-- conversation whose vector cleanup has not been confirmed yet (written BEFORE the conversation's D1 rows go, cleared once deleteByIds succeeded,
-- retried by the cron slice). max_seq = highest message_seq the conversation had, so ids 1..max_seq can be derived without the deleted rows.
CREATE TABLE IF NOT EXISTS vec_pending_delete (
  conversation_id TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  max_seq         INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
