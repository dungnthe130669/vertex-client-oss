-- Approval modes (docs/design/approval-modes.md, option B), additive only; no existing row or table is touched. APPLY TO BOTH D1s (main and team) BEFORE deploying the
-- code that reads/writes them (the code fails closed on a missing table: no grant applies, nothing is auto-approved, the card asks as before).
--   tool_grants   "Always allow this domain": one row per (scope, tool, subject). `scope` is the full Scope string of the Open space of the user (built only by src/scope.ts),
--                 so a grant never crosses users or spaces. `tool` is the browse tool the grant was made on ("web_read" ...), `subject` the exact lowercase host. Deleted by
--                 Revoke; never expires on its own (the Settings list shows created/last used).
--   approval_audit  one row per auto-approved call (written BEFORE the call runs; a failed write turns the call back into a card). `source` is chat-grant | user-grant |
--                 mode-auto. Never the URL path/query or any message text: tool + host only. `expires_at` = created_at + 30 days (ms epoch); rows past it are deleted on every
--                 write, by the every-minute cron and when the Settings list is read.
-- Admin kill switch needs no table: settings row `approval_auto:<base>` = '0' disables Auto and persistent grants for that base (default enabled).
CREATE TABLE IF NOT EXISTS tool_grants (
  scope        TEXT NOT NULL,
  tool         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (scope, tool, subject)
);
CREATE TABLE IF NOT EXISTS approval_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scope           TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  tool            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  source          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_audit_expires ON approval_audit (expires_at);
CREATE INDEX IF NOT EXISTS idx_approval_audit_scope ON approval_audit (scope, created_at);
