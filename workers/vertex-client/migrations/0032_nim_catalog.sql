-- NVIDIA NIM catalog fix from measured facts (nim-speed.md, live 2026-10-26). Additive + idempotent (UPDATEs are re-runnable, no DELETE, no INSERT): safe on the main and the team D1.
--   1. Disable the NIM ids measured dead/unusable: 404 no function for the account (nemotron-3-super-120b-a12b), 410 end of life (gpt-oss-120b), 404 (qwen3.8-27b), read timeouts (gpt-oss-20b,
--      deepseek-v4.1-flash, llama-3.2-11b-vision-instruct), 20-78 s (muse-glimmer-30b), empty reply (laguna-xs-2.1). Rows that are not there are simply not touched.
--   2. Order the working NIM models after the Groq rows (sort 37..42; the enabled flag is left alone so an admin disable survives; sort only matters within a provider): lightning, ultra, minimax, bolt, nano-omni, glm. They already exist (0029): tools/vision flags
--      are left as the repo recorded them (not re-tested), price stays NULL = unknown. Generated list = NVIDIA_RETIRED_IDS / NVIDIA_CHAT_SEED in src/providers/seed.ts (test/provider-catalog.test.ts fails on drift).
-- Rollback = UPDATE provider_models SET enabled=1 WHERE provider_id='nvidia' AND model_id IN (...) (or redeploy the previous Worker: the extra disabled rows are inert for it only if it reads `enabled`).
UPDATE provider_models SET enabled = 0 WHERE provider_id = 'nvidia' AND model_id IN ('nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'deepseek-ai/deepseek-v4.1-flash', 'meta/llama-3.2-11b-vision-instruct', 'meta/muse-glimmer-30b', 'poolside/laguna-xs-2.1');
UPDATE provider_models SET sort = 37 WHERE provider_id = 'nvidia' AND model_id = 'nvidia/nemotron-3.5-lightning-30b-a3b';
UPDATE provider_models SET sort = 38 WHERE provider_id = 'nvidia' AND model_id = 'nvidia/nemotron-3-ultra-550b-a55b';
UPDATE provider_models SET sort = 39 WHERE provider_id = 'nvidia' AND model_id = 'minimaxai/minimax-m3.1-flash';
UPDATE provider_models SET sort = 40 WHERE provider_id = 'nvidia' AND model_id = 'nvidia/nemotron-3.5-bolt-e4b';
UPDATE provider_models SET sort = 41 WHERE provider_id = 'nvidia' AND model_id = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
UPDATE provider_models SET sort = 42 WHERE provider_id = 'nvidia' AND model_id = 'z-ai/glm-5.3-flash';
