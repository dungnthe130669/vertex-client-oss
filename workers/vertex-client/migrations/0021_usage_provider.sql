-- Which provider served a usage row. NULL = gateway (every row before this migration). Additive. The app writes it only for non-gateway
-- providers and falls back to the old INSERT if the column is absent, so deploying code before applying this loses nothing.
ALTER TABLE usage ADD COLUMN provider TEXT;
