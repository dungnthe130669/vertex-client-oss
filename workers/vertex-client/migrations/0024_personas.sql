-- Subagent personas (additive only): saved sub-assistants the chat's `delegate` tool can run with their own model/prompt/tools.
--   scope  'main' | 'e2e' | 'g:<uid>' - a caller only sees/changes its own scope; uniqueness is per scope (like skills).
--   tools_json  JSON array of READ tool names the persona may use (never approval tools, never delegate).
--   effort  NULL | 'low' | 'medium' | 'high' -> thinking:{type:"adaptive"} + output_config.effort (never budget_tokens).
CREATE TABLE personas (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL DEFAULT 'main',
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prompt      TEXT NOT NULL,
  model       TEXT NOT NULL,
  tools_json  TEXT,
  max_tokens  INTEGER NOT NULL DEFAULT 4096,
  effort      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, name)
);
-- Usage rows of a subagent call: which persona, and the parent's turn number. NULL = an ordinary row. The app writes them only for subagent
-- rows and falls back to the old INSERT if the columns are absent, so deploying code before applying this loses only the tag.
ALTER TABLE usage ADD COLUMN persona TEXT;
ALTER TABLE usage ADD COLUMN parent_turn INTEGER;
