-- Approval v2: record the MODE (ask / auto / bypass) that approved each auto-approved call. Additive; old rows read as NULL (unknown).
-- Apply to BOTH D1s (main and team) before deploying: the engine writes this column, and an audit write that fails turns the call back into a card (fail closed).
ALTER TABLE approval_audit ADD COLUMN mode TEXT;
