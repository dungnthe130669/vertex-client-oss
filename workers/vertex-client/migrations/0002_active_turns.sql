-- Concurrency guard (M3): one row per conversation that is generating right now. Rows older than the stale window
-- are ignored (a DO evicted mid-turn never releases its slot).
CREATE TABLE active_turns (
  conversation_id TEXT PRIMARY KEY,
  started_at      INTEGER NOT NULL
);
