// Prints the seed INSERTs for the provider_models migrations from src/providers/seed.ts:
// NOTE (0032): NVIDIA_RETIRED_IDS rows left NVIDIA_CHAT_SEED, so the index-based `sort` this prints for 0029-0031 no longer equals what those migrations stored; they are applied history, do not regenerate them.
//   bun scripts/gen-provider-seed.ts          -> migration 0029 (the NVIDIA + Cloudflare rows)
//   bun scripts/gen-provider-seed.ts aistudio -> migration 0030 (the Google AI Studio rows; `sort` is the row's index in SEED_MODELS, so it continues after 0029's)
//   bun scripts/gen-provider-seed.ts groq     -> migration 0031 (the Groq rows; sort continues after AI Studio's)
// (test/provider-catalog.test.ts fails if a migration drifts from the seed.)
import { SEED_MODELS } from "../src/providers/seed";
import { SEED_COLUMNS, seedRowValues } from "../src/providers/catalog";
const q = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const only = process.argv[2];
for (const [i, m] of SEED_MODELS.entries()) {
  if (only ? m.provider !== only : m.provider === "aistudio" || m.provider === "groq") continue;
  const v = seedRowValues(m, i);
  console.log(`INSERT OR IGNORE INTO provider_models (${SEED_COLUMNS.join(", ")}) VALUES (${SEED_COLUMNS.map((c) => q(v[c])).join(", ")});`);
}
