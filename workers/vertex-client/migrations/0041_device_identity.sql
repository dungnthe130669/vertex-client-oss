-- Devices v2 step 2 (docs/vertex-client-devices-v2.md): identity. Additive only, nullable, no backfill; flag-gated in code (settings row `vcl:<base>`='1').
-- APPLY TO THE MAIN D1 ONLY, before deploying code that reads it (the code fails closed on a missing column: GET /api/devices, POST /api/devices/pair and /device/pair answer 503).
--   devices.install_id        the desktop app's random install id (not a secret, grants nothing), set only when a pairing code was minted by "Add this device" in the app; NULL for CLI-paired rows.
--   devices.last_online_at    unix seconds, written by DeviceHub when the daemon says hello and when its socket goes away: the honest "last online" (last_seen only slides on dial-in).
--   device_pairings.install_id  the install id the code was minted with, copied to devices.install_id at redeem.
-- Not idempotent by itself in SQLite (ADD COLUMN has no IF NOT EXISTS): apply once per database; `wrangler d1 migrations apply` records it.
ALTER TABLE devices ADD COLUMN install_id TEXT;
ALTER TABLE devices ADD COLUMN last_online_at INTEGER;
ALTER TABLE device_pairings ADD COLUMN install_id TEXT;
