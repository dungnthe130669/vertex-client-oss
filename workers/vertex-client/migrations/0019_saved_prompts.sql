-- Saved prompts (additive only; apply BEFORE deploying the code that reads/writes it). NOT applied remotely by the author.
-- Reusable composer text, shown in the slash menu and the palette. Every query filters by scope (main + e2e only; g:* is 403 at the route).
CREATE TABLE saved_prompts (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  title      TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_saved_prompts_scope ON saved_prompts(scope, updated_at DESC);
