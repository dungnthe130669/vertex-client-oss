-- Provider rows managed from Settings > Providers: auth header style + the "answered 404" model list. Additive; the previous columns keep working.
-- No key is stored here or anywhere in the app: key_binding only NAMES a Worker secret (PROVIDER_KEY_<NAME>), provisioned by a human with `wrangler secret put`.
ALTER TABLE provider_configs ADD COLUMN auth_header TEXT;
ALTER TABLE provider_configs ADD COLUMN broken_json TEXT NOT NULL DEFAULT '[]';
