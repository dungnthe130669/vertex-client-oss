-- Provider configs as data (multi-provider framework). Additive; main scope only. A row only NAMES the env binding that holds the key
-- (must look like PROVIDER_KEY_*); the key itself never lives in D1. No route writes this table: rows are added by an admin.
CREATE TABLE IF NOT EXISTS provider_configs (
  id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'main',
  kind TEXT NOT NULL,                 -- 'openai-compat' | 'stub'
  base_url TEXT,                      -- https only, no credentials in the URL
  key_binding TEXT,                   -- e.g. PROVIDER_KEY_ACME
  enabled INTEGER NOT NULL DEFAULT 0,
  models_json TEXT NOT NULL DEFAULT '[]',   -- [{id, displayName, capabilities, pricePerMTok}]
  allow_guests INTEGER NOT NULL DEFAULT 0,  -- guest scopes get no provider unless this is set on purpose
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, id)
);
