-- User profile (additive only; apply BEFORE deploying the code that reads/writes it).
--   scope         'main' (Erich) | 'e2e' (test user); one row per scope, a caller only ever reads/writes its own row.
--                 Only scope 'main' has its instructions appended to the Chat system prompt (g:* never reads or writes a profile).
--   full_name / nickname / instructions: plain text, lengths enforced by the API (80 / 40 / 4000), control characters stripped there.
CREATE TABLE profile (
  scope        TEXT PRIMARY KEY,
  full_name    TEXT NOT NULL DEFAULT '',
  nickname     TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
