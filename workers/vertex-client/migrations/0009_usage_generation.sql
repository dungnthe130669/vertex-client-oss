-- Image generation usage (additive only). Chat rows keep kind='chat' (default), so every existing query and row is unaffected.
--   kind     'chat' | 'image' (| 'video' later)
--   est_usd  the estimate made BEFORE the call; kept when cost_usd is NULL ("billing uncertain")
--   units    images returned (generation rows)
ALTER TABLE usage ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE usage ADD COLUMN est_usd REAL;
ALTER TABLE usage ADD COLUMN units INTEGER;
