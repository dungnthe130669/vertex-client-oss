-- P0 hardening (additive only; apply BEFORE deploying the code that reads/writes these columns).
-- Every existing row is Erich's: the DEFAULT 'main' backfills them with no data change.
-- push_subscriptions: subscriptions belong to a scope; sends/config/unsubscribe filter on it (a g:* scope must never reach Erich's phone).
ALTER TABLE push_subscriptions ADD COLUMN scope TEXT NOT NULL DEFAULT 'main';
CREATE INDEX idx_push_subscriptions_scope ON push_subscriptions (scope);
-- active_turns: per-scope turn caps (main 3, each other scope 1) so a non-main scope can never starve main.
ALTER TABLE active_turns ADD COLUMN scope TEXT NOT NULL DEFAULT 'main';
CREATE INDEX idx_active_turns_scope ON active_turns (scope, started_at);
