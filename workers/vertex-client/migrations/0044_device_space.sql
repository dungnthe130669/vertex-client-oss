-- vclspace1 (docs/vcl-open-device-space.md): per-device space. Additive, nullable, NO backfill (NULL = legacy device, behaviour unchanged).
-- NEVER applied by the branch work; apply to the MAIN D1 only, BEFORE deploying code that reads it.
--   devices.space          NULL (legacy) | 'biz' | 'open'. 'open' = may use the base's Open keys/allowance (needs flag vcl_open:<base> too); 'biz' = never.
--   device_pairings.space  the space the pairing code was minted with, copied to devices.space at redeem.
-- ADD COLUMN has no IF NOT EXISTS in SQLite: apply once per database (`wrangler d1 migrations apply` records it).
-- Rollback: deploy the previous code (it ignores the column); the columns may stay. Code fails closed (no Open) if the column is missing; pairing answers 503 until applied.
ALTER TABLE devices ADD COLUMN space TEXT;
ALTER TABLE device_pairings ADD COLUMN space TEXT;
