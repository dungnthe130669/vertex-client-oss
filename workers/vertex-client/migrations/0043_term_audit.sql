-- Device terminal (vclterm3, docs/vcl-term-hub-api.md): audit trail of terminal sessions. Additive only (new table), no backfill, flag-gated in code (settings rows `vcl:<base>` and `vcl_term:<base>`='1').
-- WRITTEN BUT NOT APPLIED REMOTELY. Apply to the main D1 before turning `vcl_term:<base>` on (the hub writes rows best effort: without the table the terminal still works, only the audit row is lost and a console error is logged).
-- One row per open and per close of a session: who, which device, which root, sandbox mode the device reported, duration, why it ended. NEVER terminal input or output. Rows expire after 30 days (expires_at; swept by the hub on write is not done: add to the existing cron purge when the UI lane lands).
CREATE TABLE IF NOT EXISTS term_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  user TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sid TEXT,
  event TEXT NOT NULL,          -- 'open' | 'close'
  root TEXT NOT NULL,
  mode TEXT,                    -- sandbox mode reported by the device (e.g. landlock, seatbelt)
  duration_s INTEGER,           -- close rows
  reason TEXT,                  -- close rows: exit, idle, device_lost, disabled, revoked, ...
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_term_audit_dev ON term_audit (device_id, created_at);
