-- feat2 (docs/reports/feat1.md §2/§4 step 3): audit trail of feature lock/unlock changes by an owner. Additive only (new table), no backfill.
-- WRITTEN BUT NOT APPLIED REMOTELY: the PO applies it at deploy (migrations before code). No code writes it yet (the owner-only admin route is feat1 step 4);
-- append-only by convention exactly like term_audit (0043): rows are inserted, never updated or deleted by the app.
CREATE TABLE IF NOT EXISTS feature_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,          -- owner identity that made the change
  class TEXT NOT NULL,          -- 'm' | 'g' | 'o'
  feature TEXT NOT NULL,        -- feature id from src/feature-registry.ts
  old TEXT,                     -- previous unlock row value ('1' | '0' | NULL = no row)
  new TEXT                      -- new value ('1' | '0' | NULL = row removed)
);
CREATE INDEX IF NOT EXISTS idx_feature_audit_ts ON feature_audit (ts);
CREATE INDEX IF NOT EXISTS idx_feature_audit_feature ON feature_audit (feature, class, ts);
