-- In-app notifications center (toast + history). Additive only; idempotent. APPLY TO THE MAIN D1 BEFORE deploying code that reads it
-- (the code fails soft on a missing table: recording is skipped and GET /api/notifications answers an empty list).
--   notifications  one row per notification the server decided to send (push) or would send but suppressed because the user is watching.
--                  user_id = the owner's Scope string (src/scope.ts), same isolation key as every other user table. ts = ms since epoch.
--                  Payload is as privacy-minimal as the push: title/body text and an in-app url, never paths or secrets. read_at NULL = unread.
--                  Capped to the latest 200 rows per user, pruned on insert.
CREATE TABLE IF NOT EXISTS notifications (
  id       TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  title    TEXT NOT NULL,
  body     TEXT NOT NULL,
  url      TEXT NOT NULL,
  read_at  INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_user_ts ON notifications (user_id, ts);
