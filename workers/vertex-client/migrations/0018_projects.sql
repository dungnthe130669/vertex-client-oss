-- Projects v1 (additive only; apply BEFORE deploying the code that reads/writes these). NOT applied remotely by the author.
-- projects: a named bundle of instructions that chats can belong to. Every query filters by scope. archived=1 is the soft delete.
-- conversations.project_id: nullable back-reference (no FK; deleting/archiving a project un-assigns its chats in code).
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  archived     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_projects_scope ON projects(scope, archived, updated_at DESC);
ALTER TABLE conversations ADD COLUMN project_id TEXT;
CREATE INDEX idx_conversations_project ON conversations(project_id, scope);
