-- Schema only (M1). Source of truth for message content is the per-conversation ChatSession DO (M2);
-- D1 holds the cross-conversation index, search, usage roll-ups and push subscriptions.
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat','cloud')),
  pinned      INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  tokens      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_conversations_updated ON conversations (pinned DESC, updated_at DESC);

-- Message index: text chunked (D1 caps a row at 2 MB), one row per chunk, mirrored into FTS5 for search.
CREATE TABLE messages_index (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_seq     INTEGER NOT NULL,
  chunk           INTEGER NOT NULL DEFAULT 0,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  text            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (conversation_id, message_seq, chunk)
);
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages_index', content_rowid='id');
CREATE TRIGGER messages_index_ai AFTER INSERT ON messages_index BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_index_ad AFTER DELETE ON messages_index BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER messages_index_au AFTER UPDATE ON messages_index BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Per-assistant-message usage; day/month roll-ups are queries over this table.
CREATE TABLE usage (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  mode             TEXT NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat','cloud')),
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read       INTEGER NOT NULL DEFAULT 0,
  cache_write      INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL,            -- NULL = no known rate, tokens only
  day              TEXT NOT NULL DEFAULT (date('now')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_usage_day ON usage (day, mode, model);

CREATE TABLE push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at   TEXT
);

CREATE TABLE settings (
  name   TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
