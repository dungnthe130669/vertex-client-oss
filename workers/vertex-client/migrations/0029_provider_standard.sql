-- Provider standard P1 (docs/vertex-client-providers... / providers/descriptor.ts), additive only. APPLY THIS BEFORE deploying the code that reads it (the code falls back to the built-in
-- seed when the table is missing, like 0026, but latency recording and admin edits need it).
--
-- provider_models: the model catalog as DATA (Erich: model lists come from the database + /api/models, never hardcoded). One row per (provider, model).
--   capabilities_json = DECLARED-true capability keys {"text":true,"tools":true,...}; a capability is only ever seeded true where a live request / the vendor docs said so (seed_ref).
--   price_json        = {"input":$/Mtok,"output":$/Mtok,"cacheRead"?,"cacheWrite"?,"source":"seed:<date>:<url>"|"admin"} or NULL = UNKNOWN. NULL is never "free"; a price without a source is ignored.
--   limits_json       = {"context","maxTokens","maxOutput"}; extra_json = adapter parameters (NVIDIA genai {"slug","steps"}).
--   enabled=0 hides a model (kill switch per model); user_edited=1 rows are never rewritten by a later seed; broken=1 hides a model that answered 404.
CREATE TABLE IF NOT EXISTS provider_models (
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'chat',   -- chat | image
  display_name      TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  price_json        TEXT,
  limits_json       TEXT,
  extra_json        TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  sort              INTEGER NOT NULL DEFAULT 0,
  suggested         INTEGER NOT NULL DEFAULT 0,
  origin            TEXT NOT NULL DEFAULT 'seed',   -- seed | discovered | admin
  seed_ref          TEXT,
  user_edited       INTEGER NOT NULL DEFAULT 0,
  verified_at       INTEGER,
  broken            INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, model_id)
);

-- Measured latency (never message content). Raw samples are bounded (last 200 per provider+model+kind, pruned on write); the aggregate row is what /api/models reads.
-- Aggregates carry no user id; samples carry only the space (open | biz).
CREATE TABLE IF NOT EXISTS model_latency_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id  TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'chat',        -- chat | image | video
  space        TEXT NOT NULL DEFAULT 'open',
  started_at   INTEGER NOT NULL,                    -- ms epoch
  ttfb_ms      INTEGER,                             -- until the upstream answered (headers)
  ttfr_ms      INTEGER,                             -- first reasoning token, if any
  ttfa_ms      INTEGER,                             -- first answer token (after thinking)
  total_ms     INTEGER NOT NULL,
  output_tokens INTEGER,
  outcome      TEXT NOT NULL                        -- ok | error | timeout | cancel
);
CREATE INDEX IF NOT EXISTS idx_latency_samples_key ON model_latency_samples (provider_id, model_id, kind, id);
CREATE TABLE IF NOT EXISTS model_latency_stats (
  provider_id  TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'chat',
  samples      INTEGER NOT NULL,                    -- ok samples in the window
  ttfa_p50_ms  INTEGER, ttfa_p90_ms INTEGER,
  total_p50_ms INTEGER, total_p90_ms INTEGER,
  tokens_per_s REAL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id, kind)
);

-- Seed: the NVIDIA / Cloudflare facts that used to be code constants (generated from src/providers/seed.ts; test/provider-catalog.test.ts keeps the two identical).
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 'chat', 'Nemotron 3 Ultra 550B', '{"text":true,"tools":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 0, 1, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'chat', 'Nemotron 3.5 Lightning 30B', '{"text":true,"tools":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 1, 1, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'chat', 'Nemotron 3 Nano Omni 30B', '{"text":true,"vision":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 2, 0, 'seed', '2026-10-26: live 2026-10-26: 64x64 PNG answered the colour', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'minimaxai/minimax-m3.1-flash', 'chat', 'MiniMax M3.1 Flash', '{"text":true,"tools":true,"vision":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 3, 0, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls; live 2026-10-26: 64x64 PNG answered the colour', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'openai/gpt-oss-20b', 'chat', 'GPT-OSS 20B', '{"text":true,"tools":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 4, 0, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'deepseek-ai/deepseek-v4.1-flash', 'chat', 'DeepSeek V4.1 Flash', '{"text":true,"tools":true,"vision":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 5, 0, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls; live 2026-10-26: 64x64 PNG answered the colour', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'z-ai/glm-5.3-flash', 'chat', 'GLM 5.3 Flash', '{"text":true,"tools":true,"vision":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 6, 0, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls; live 2026-10-26: 64x64 PNG answered the colour', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'meta/muse-glimmer-30b', 'chat', 'Muse Glimmer 30B', '{"text":true,"tools":true,"vision":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 7, 0, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls; live 2026-10-26: 64x64 PNG answered the colour', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'nvidia/nemotron-3.5-bolt-e4b', 'chat', 'Nemotron 3.5 Bolt E4B', '{"text":true,"tools":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 8, 0, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'meta/llama-3.2-11b-vision-instruct', 'chat', 'Llama 3.2 11B Vision', '{"text":true,"tools":true,"vision":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 9, 0, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls; live 2026-10-26: 64x64 PNG answered the colour', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'poolside/laguna-xs-2.1', 'chat', 'Laguna XS 2.1', '{"text":true,"tools":true}', NULL, '{"maxTokens":16000,"maxOutput":16000}', NULL, 1, 10, 0, 'seed', '2026-10-26: live 2026-10-26: request with a trivial tools array answered tool_calls', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'black-forest-labs/flux.2-klein-4b', 'image', 'FLUX.2 klein 4B', '{"image-gen":true}', NULL, NULL, '{"slug":"flux.2-klein-4b","steps":4}', 1, 11, 0, 'seed', '2026-10-26: live 2026-10-26: text-to-image returned a JPEG', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'black-forest-labs/flux-3-image-klein', 'image', 'FLUX.3 image klein', '{"image-gen":true}', NULL, NULL, '{"slug":"flux-3-image-klein","steps":4}', 1, 12, 0, 'seed', '2026-10-26: live 2026-10-26: text-to-image returned a JPEG', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('nvidia', 'black-forest-labs/flux.1-dev', 'image', 'FLUX.1 dev', '{"image-gen":true}', NULL, NULL, '{"slug":"flux.1-dev","steps":5}', 1, 13, 0, 'seed', '2026-10-26: live 2026-10-26: text-to-image returned a JPEG', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/openai/gpt-oss-120b', 'chat', 'gpt-oss 120B', '{"text":true,"tools":true,"reasoning":true}', NULL, '{"context":128000}', NULL, 1, 14, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/openai/gpt-oss-20b', 'chat', 'gpt-oss 20B', '{"text":true,"reasoning":true}', NULL, '{"context":128000}', NULL, 1, 15, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/google/gemma-4-26b-a4b-it', 'chat', 'Gemma 4 26B', '{"text":true,"tools":true,"vision":true}', NULL, '{"context":256000}', NULL, 1, 16, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/zai-org/glm-4.7-flash', 'chat', 'GLM 4.7 Flash', '{"text":true,"tools":true}', NULL, '{"context":131072}', NULL, 1, 17, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'chat', 'Llama 3.3 70B', '{"text":true}', NULL, NULL, NULL, 1, 18, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 'chat', 'Llama 4 Scout 17B', '{"text":true,"vision":true}', NULL, NULL, NULL, 1, 19, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/meta/llama-3.1-8b-instruct-fp8', 'chat', 'Llama 3.1 8B', '{"text":true}', NULL, NULL, NULL, 1, 20, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8', 'chat', 'Qwen3 30B A3B', '{"text":true,"reasoning":true}', NULL, NULL, NULL, 1, 21, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/mistralai/mistral-small-3.1-24b-instruct', 'chat', 'Mistral Small 3.1 24B', '{"text":true,"vision":true}', NULL, '{"context":128000}', NULL, 1, 22, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'image', 'FLUX.1 schnell', '{"image-gen":true}', NULL, NULL, NULL, 1, 23, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/bytedance/stable-diffusion-xl-lightning', 'image', 'SDXL Lightning', '{"image-gen":true}', NULL, NULL, NULL, 1, 24, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/stabilityai/stable-diffusion-xl-base-1.0', 'image', 'SDXL base 1.0', '{"image-gen":true}', NULL, NULL, NULL, 1, 25, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
INSERT OR IGNORE INTO provider_models (provider_id, model_id, kind, display_name, capabilities_json, price_json, limits_json, extra_json, enabled, sort, suggested, origin, seed_ref, user_edited, broken, updated_at) VALUES ('cloudflare', '@cf/lykon/dreamshaper-8-lcm', 'image', 'DreamShaper 8 LCM', '{"image-gen":true}', NULL, NULL, NULL, 1, 26, 0, 'seed', '2026-10-26: developers.cloudflare.com/workers-ai/models, checked 2026-10-23 (docs, not a live probe)', 0, 0, 0);
