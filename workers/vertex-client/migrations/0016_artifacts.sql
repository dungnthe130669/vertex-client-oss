-- Artifacts v1a (additive only; apply BEFORE deploying the code that reads/writes these). NOT applied remotely by the author.
-- artifacts: documents the model creates with create_artifact / update_artifact (markdown | code | svg). main scope writes them (via the model);
--   every query filters by scope. Content lives in R2 FILES under vertex-client/artifacts/<scope-hash>/<id>/v<n> (key derived from the row, never client input).
--   conv_id   nullable back-link only; deleting a conversation does not delete its artifacts.
--   preview   first ~200 chars of the text, for the gallery thumbnail + LIKE search.
--   deleted_at soft delete; the cron removes the row + R2 objects after a short undo grace.
CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  conv_id         TEXT,
  title           TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('markdown','code','svg')),
  language        TEXT,
  current_version INTEGER NOT NULL DEFAULT 1,
  preview         TEXT NOT NULL DEFAULT '',
  bytes           INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX idx_artifacts_scope ON artifacts(scope, deleted_at, updated_at DESC, id);

-- One row per stored version. conv_id/turn record which model turn wrote it (the per-turn create/update cap counts these).
CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  conv_id     TEXT,
  turn        INTEGER,
  PRIMARY KEY (artifact_id, version)
);
CREATE INDEX idx_artifact_versions_turn ON artifact_versions(conv_id, turn);
