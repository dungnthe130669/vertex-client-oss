-- Slash skills (additive only): prompt templates the composer's "/" menu offers and the turn engine expands server-side.
--   scope      'main' (Erich) | 'e2e' (test user); a caller only ever sees/changes its own scope, like conversations.
--              Uniqueness is per scope so the e2e user can never learn (or collide with) a main skill name.
--   tools_json optional JSON array of tool names - a hint list only, never forces or approves anything.
CREATE TABLE skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  template    TEXT NOT NULL,
  tools_json  TEXT,
  scope       TEXT NOT NULL DEFAULT 'main',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, name)
);
