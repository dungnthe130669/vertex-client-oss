-- Cloud push: `notified` = last status we already pushed about (dedupe across cron ticks / re-syncs), `seen_at` = epoch ms of the last
-- time a client watched the run (no push while someone is looking at it).
ALTER TABLE cloud_runs ADD COLUMN notified TEXT NOT NULL DEFAULT '';
ALTER TABLE cloud_runs ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0;
UPDATE cloud_runs SET notified = status;
CREATE INDEX idx_cloud_runs_watch ON cloud_runs (scope, status);
