-- Open failover circuit breaker (src/provider-health.ts), additive only. APPLY TO BOTH D1s BEFORE deploying the code that writes it (the code swallows a missing table:
-- failover then runs with an isolate-local breaker only). Never message content: counters and timestamps per (scope, provider, model).
--   fails        failures counted since window_start (the window is 5 min; a failure after it restarts the count at 1)
--   open_until   ms epoch until which the model is "unhealthy" (skipped); 0 = closed; after it passes the model is half-open (one try)
-- Bounded: every write prunes the scope's rows older than 1 h and keeps its newest 100; a rate-limited global sweep (<= 500 rows per run, hard TTL 24 h) removes dormant scopes.
CREATE TABLE IF NOT EXISTS provider_health (
  scope        TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  fails        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  open_until   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_health_updated ON provider_health (scope, updated_at);
-- the global 24 h sweep deletes by updated_at alone (dormant scopes): it needs updated_at as the leading column
CREATE INDEX IF NOT EXISTS idx_provider_health_updated_all ON provider_health (updated_at);
