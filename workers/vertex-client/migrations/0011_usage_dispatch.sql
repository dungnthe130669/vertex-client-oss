-- Idempotent generation usage rows (additive only). A generation dispatch gets a stable id persisted BEFORE the provider call;
-- the usage insert is ON CONFLICT(dispatch_id) DO NOTHING, so retrying after a failed/evicted insert can never double-bill.
-- Chat rows keep dispatch_id NULL (the partial index ignores them). Apply BEFORE deploying code that writes dispatch_id.
ALTER TABLE usage ADD COLUMN dispatch_id TEXT;
CREATE UNIQUE INDEX usage_dispatch_id ON usage(dispatch_id) WHERE dispatch_id IS NOT NULL;
