-- Desktop mode (agent-spike image=desktop, computer use + noVNC take-over). Ownership by scope (agent-spike has no per-user filter).
-- notified = last notable state already pushed about (`finished|failed|stopped` or `ask:<controlSince>`), seen_at = epoch ms a client last looked.
-- Costs go to cloud_costs with executor `desktop` (delta-only, baseline = cost_usd here).
CREATE TABLE desktop_runs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_url TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
  cost_usd REAL NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'main',
  notified TEXT NOT NULL DEFAULT '',
  seen_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_desktop_runs_scope ON desktop_runs (scope, created_at);
CREATE INDEX idx_desktop_runs_watch ON desktop_runs (scope, status);
-- Agents mode's agent_msgs was never read or written by any code (README/KNOWN-ISSUES listed it as unused).
DROP TABLE IF EXISTS agent_msgs;
