-- VCL device bridge (docs/vertex-client-vcl-protocol.md). Additive only; flag-gated in code (settings row `vcl:<base>`='1'; default OFF, team OFF).
-- APPLY TO THE MAIN D1 ONLY, before deploying code that reads it (the code fails closed on a missing table: every /api/devices route and /device answer 404/503).
--   devices         one row per paired daemon. `scope` = owner (full Scope string of the paired session, built by src/scope.ts). Only the SHA-256 of the device token is stored
--                   (token_hash, NULL once revoked); the token itself is shown once to the daemon at pairing. `last_seen` slides the 30-day token life.
--   device_pairings short-lived single-use pairing codes (8 base32 chars), stored as SHA-256 only. A row is dead once used_at is set or expires_at has passed; swept on every write.
--   device_pair_fails  failed redeem attempts per hashed client address, for the redeem rate limit; swept on every write.
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  user        TEXT NOT NULL,
  name        TEXT NOT NULL,
  token_hash  TEXT,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS devices_scope ON devices (scope, created_at);
CREATE TABLE IF NOT EXISTS device_pairings (
  code_hash   TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  user        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX IF NOT EXISTS device_pairings_scope ON device_pairings (scope, created_at);
CREATE TABLE IF NOT EXISTS device_pair_fails (
  ip_hash TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_pair_fails_ip ON device_pair_fails (ip_hash, at);
