-- Remote steering simulation for the e2e user ONLY (scope e2e never reaches remote-hub's real commands). Additive.
CREATE TABLE IF NOT EXISTS e2e_commands (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, host TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, text_sha256 TEXT NOT NULL,
  requested_by TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, approved_by TEXT, approved_at INTEGER, rejected_by TEXT, rejected_at INTEGER,
  finished_at INTEGER, nonce_hash TEXT, nonce_expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS e2e_commands_session ON e2e_commands (session_id, created_at);
