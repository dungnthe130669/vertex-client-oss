-- NIM nemotron-3-ultra-550b-a55b answers tool_choice:"required" with the tool call as TEXT (tool_calls empty); `auto` works 6/6 (docs/reports/nim-textcall-diag.md).
-- Flag the row so the engine sends a forced first call as auto + web tools only + a system nudge. Idempotent and metadata-preserving: NULL -> the flag alone; a valid JSON object -> json_set keeps its other keys;
-- already flagged or not-valid-JSON rows are left alone. Rows that are not there are not touched.
-- Rollback = UPDATE provider_models SET extra_json = CASE WHEN json_remove(extra_json, '$.forceViaAuto') = '{}' THEN NULL ELSE json_remove(extra_json, '$.forceViaAuto') END WHERE provider_id = 'nvidia' AND model_id = 'nvidia/nemotron-3-ultra-550b-a55b' AND json_valid(extra_json);
UPDATE provider_models SET extra_json = CASE WHEN extra_json IS NULL THEN '{"forceViaAuto":true}' ELSE json_set(extra_json, '$.forceViaAuto', json('true')) END
  WHERE provider_id = 'nvidia' AND model_id = 'nvidia/nemotron-3-ultra-550b-a55b'
    AND (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object' AND json_extract(extra_json, '$.forceViaAuto') IS NOT 1));
