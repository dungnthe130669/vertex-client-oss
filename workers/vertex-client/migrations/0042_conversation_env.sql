-- Devices v2 step 3 (docs/vertex-client-devices-v2.md): a conversation can be bound to a device environment. Additive only, all nullable, no backfill; NULL env_kind = a normal cloud chat (every existing row).
-- Flag-gated in code: settings row `vcl_env:<base>`='1' (needs `vcl:<base>`='1' too); both default OFF. Merging/deploying changes nothing for anyone until a base is switched on.
-- APPLY TO THE MAIN D1 ONLY, before deploying code that writes it. Code fails closed on a missing column: creating a DEVICE chat answers 503 (nothing created), reading a chat treats it as cloud, every cloud path never touches these columns.
--   conversations.env_kind        'device' for a device chat, NULL (or 'cloud') otherwise
--   conversations.env_device_id   devices.id (32 hex) the chat runs on
--   conversations.env_dir         the folder chosen at creation (root + optional subfolder), as sent to the device; the device remains the authority on which folders are allowed
--   conversations.env_user        devices.user of the creator: the bridge only ever talks to a device with this scope + user and not revoked
-- Not idempotent by itself in SQLite (ADD COLUMN has no IF NOT EXISTS): apply once per database; `wrangler d1 migrations apply` records it.
ALTER TABLE conversations ADD COLUMN env_kind TEXT;
ALTER TABLE conversations ADD COLUMN env_device_id TEXT;
ALTER TABLE conversations ADD COLUMN env_dir TEXT;
ALTER TABLE conversations ADD COLUMN env_user TEXT;
