-- Connectors v1 (additive only; apply BEFORE deploying the code that reads/writes this table).
-- One row per (scope, connector): a caller only ever sees/changes its own scope's rows (main = Erich, e2e = the test user).
--   enabled        0 = the whole connector is hidden from the model and calls are refused.
--   disabled_tools JSON array of tool names switched off. A switch can only REMOVE a tool; approval tiers live in code and never change.
-- No row = defaults (enabled, nothing disabled). Toggles apply to NEW conversations: each conversation pins its resolved set.
CREATE TABLE connector_settings (
  scope          TEXT NOT NULL,
  connector_id   TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  disabled_tools TEXT NOT NULL DEFAULT '[]',
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, connector_id)
);
