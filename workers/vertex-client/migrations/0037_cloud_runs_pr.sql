-- Open PR on a finished Cloud run: the draft PR agent-spike opened for the run's agent/<id> branch (NULL = none yet).
-- NOT applied anywhere yet. Rollback = ALTER TABLE cloud_runs DROP COLUMN pr_url; ALTER TABLE cloud_runs DROP COLUMN pr_number;
ALTER TABLE cloud_runs ADD COLUMN pr_number INTEGER;
ALTER TABLE cloud_runs ADD COLUMN pr_url TEXT;
