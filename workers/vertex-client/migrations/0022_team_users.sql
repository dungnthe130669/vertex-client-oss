-- Team gateway users (instance `vertex-client-team`). Additive only: two new tables, nothing existing is touched.
-- uid = vclient's own stable scope id (24 lowercase hex, derived from the gateway's user id, see src/team-auth.ts); the data scope is `g:<uid>`.
CREATE TABLE IF NOT EXISTS team_users (
  uid           TEXT PRIMARY KEY,
  gateway_uid   TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_users_email ON team_users(email);
-- Single-use assertion ids: INSERT OR FAIL on the primary key is the replay check. Rows past exp are swept on every login.
CREATE TABLE IF NOT EXISTS team_assertions (
  jti  TEXT PRIMARY KEY,
  exp  INTEGER NOT NULL
);
