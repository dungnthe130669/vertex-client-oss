-- Connectors P2 (additive only; apply BEFORE deploying the code that reads/writes these). NOT applied remotely by the author.
-- custom_connectors: user-added remote MCP servers (Streamable HTTP). main scope only (the API refuses every other scope).
--   enc_token  AES-GCM(iv||ciphertext, base64) of the bearer token / header value; key = HKDF(SESSION_SECRET, info fixed in code), AAD = scope:id.
--              Never returned by any API (GET exposes `hasToken`), never logged.
--   auth_kind  'none' | 'bearer' (Authorization: Bearer <token>) | 'header' (<auth_header_name>: <token>).
--   last_status 'ok' | 'error' | NULL (never tested), last_error = short scrubbed message.
CREATE TABLE custom_connectors (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  auth_kind        TEXT NOT NULL DEFAULT 'none' CHECK (auth_kind IN ('none','bearer','header')),
  auth_header_name TEXT,
  enc_token        TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_status      TEXT,
  last_error       TEXT
);
CREATE UNIQUE INDEX idx_custom_connectors_name ON custom_connectors(scope, name);
CREATE INDEX idx_custom_connectors_scope ON custom_connectors(scope, created_at);

-- Per-tool mode for any connector row (built-in: only 'ask' overrides are stored, 'block' stays in disabled_tools; custom: 'always'|'ask'|'block',
-- absent = 'ask'). Like every switch, applies to NEW conversations (pinned).
ALTER TABLE connector_settings ADD COLUMN tool_modes TEXT NOT NULL DEFAULT '{}';
