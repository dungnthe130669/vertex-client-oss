-- Artifacts v1b: allow type 'html'. SQLite cannot alter a CHECK constraint, so the table is rebuilt (no foreign keys reference it; artifact_versions is untouched).
-- Apply BEFORE deploying the code that writes html artifacts. NOT applied remotely by the author. Existing rows are copied unchanged; the code only ADDS a type, so
-- the previous Worker version keeps working against the new table (rollback-safe).
CREATE TABLE artifacts_new (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  conv_id         TEXT,
  title           TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('markdown','code','svg','html')),
  language        TEXT,
  current_version INTEGER NOT NULL DEFAULT 1,
  preview         TEXT NOT NULL DEFAULT '',
  bytes           INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
INSERT INTO artifacts_new (id, scope, conv_id, title, type, language, current_version, preview, bytes, created_at, updated_at, deleted_at)
  SELECT id, scope, conv_id, title, type, language, current_version, preview, bytes, created_at, updated_at, deleted_at FROM artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;
CREATE INDEX idx_artifacts_scope ON artifacts(scope, deleted_at, updated_at DESC, id);
