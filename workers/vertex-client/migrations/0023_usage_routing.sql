-- Auto model, shadow mode: what the router WOULD have picked for the turn behind this usage row. `model` keeps the model that actually ran, so
-- cost/price lookups are unchanged. NULL = no route recorded (every row before this migration, and every row while `auto_shadow` is off).
-- Additive only. The app writes these columns only when a route exists and falls back to the old INSERT if they are absent, so deploying
-- code before applying this loses nothing.
ALTER TABLE usage ADD COLUMN routed_by TEXT;
ALTER TABLE usage ADD COLUMN routed_model TEXT;
ALTER TABLE usage ADD COLUMN routed_reason TEXT;
