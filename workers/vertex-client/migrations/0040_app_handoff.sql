-- Desktop app sign-in through the system browser (docs/vertex-client-desktop-app.md section 9). Additive only; flag-gated in code (settings row `desktop_login:main`='1'; default OFF).
-- APPLY TO THE MAIN D1 ONLY, before deploying code that reads it (the code fails closed on a missing table: approve answers 503, exchange answers 400/503, never a session).
--   app_handoffs      one-time login handoff codes. Only the SHA-256 of the code is stored (code_hash), plus the PKCE challenge (SHA-256 of the app's verifier) the exchange must match;
--                     the code and the verifier are never stored. TTL 60 s, single use (used_at set by one atomic UPDATE, a wrong verifier burns the code). Swept on every write.
--   app_handoff_fails failed exchanges per hashed client address, for the exchange rate limit; swept on every write.
CREATE TABLE IF NOT EXISTS app_handoffs (
  code_hash  TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  user       TEXT NOT NULL,
  via        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  auth_expires_at INTEGER NOT NULL   -- expiry of the approving session: an e2e handoff session never outlives it (no chained renewal of the e2e-bot's 15 min session)
);
CREATE INDEX IF NOT EXISTS app_handoffs_user ON app_handoffs (user, created_at);
CREATE TABLE IF NOT EXISTS app_handoff_fails (
  ip_hash TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_handoff_fails_ip ON app_handoff_fails (ip_hash, at);
