-- Cloud mode (M4). agent-spike has no per-user filter, so ownership lives here: a run (task `t…` 16 hex, or session `b|s…`) is
-- visible only to the scope that created it. cloud_costs holds cost DELTAS (recorded when we observe a change), for the Usage screen.
CREATE TABLE cloud_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('task','session')),
  repo TEXT NOT NULL,
  base TEXT,
  branch TEXT,
  executor TEXT NOT NULL DEFAULT 'auto',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'starting',
  cost_usd REAL NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cloud_runs_scope ON cloud_runs (scope, created_at DESC);
CREATE TABLE cloud_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT 'auto',
  cost_usd REAL NOT NULL,
  scope TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cloud_costs_scope ON cloud_costs (scope, created_at);
