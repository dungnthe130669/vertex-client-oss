-- Data isolation for the E2E test user (`e2e-bot`): every conversation and usage row carries a scope. Erich's data is 'main'
-- (all existing rows, via the DEFAULT); sessions issued by the /auth/e2e bypass are scope 'e2e' and can only ever see 'e2e' rows.
ALTER TABLE conversations ADD COLUMN scope TEXT NOT NULL DEFAULT 'main';
ALTER TABLE usage ADD COLUMN scope TEXT NOT NULL DEFAULT 'main';
CREATE INDEX idx_conversations_scope ON conversations (scope, pinned DESC, updated_at DESC);
CREATE INDEX idx_usage_scope ON usage (scope, created_at);
