// Presets for the Settings > Providers "Add" flow. Data only: the server re-validates everything it is sent (config.ts), a preset just prefills.
import { AISTUDIO_DESCRIPTOR, NVIDIA_DESCRIPTOR, discoveredKind } from "./descriptor";
export interface ProviderPreset {
  key: string; label: string; id: string; baseUrl: string; authHeader: string; /** the Worker secret a human provisions (name only; "" = none: the user's own key only) */ secret: string; help: string;
  /** absent = an OpenAI-compatible endpoint with editable models; `gemini` = native Gemini API, models are the catalog only (no row, no Worker secret) */
  kind?: "gemini";
  /** persistent data-use warning the UI shows wherever this provider's models are used (vi + en) */
  warning?: { vi: string; en: string };
}

export const NVIDIA_PRESET: ProviderPreset = {
  key: "nvidia", label: "NVIDIA NIM", id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", authHeader: "bearer", secret: "PROVIDER_KEY_NVIDIA",
  help: "The key is a Worker secret, not entered here: get a free key at build.nvidia.com and run `wrangler secret put PROVIDER_KEY_NVIDIA`. About 40 requests per minute. Only the free-preview models work: the catalog lists many ids that answer 404 (they are hidden once one fails).",
};
export const GROQ_PRESET: ProviderPreset = {
  key: "groq", label: "Groq", id: "groq", baseUrl: "https://api.groq.com/openai/v1", authHeader: "bearer", secret: "PROVIDER_KEY_GROQ",
  help: "Get a free key at console.groq.com and paste it here (stored encrypted, never shown again). The free tier is about 30 requests per minute and 8K tokens per minute per model (shared by your whole Groq organization): long chats are shortened to fit, and a very large message is refused.",
};
/** Google AI Studio (Gemini API, free tier): native API, the user's own key, Open only. The warning is shown persistently: free-tier content may be read and used by Google. */
export const AISTUDIO_WARNING = AISTUDIO_DESCRIPTOR.dataWarning!;
export const AISTUDIO_PRESET: ProviderPreset = {
  key: "aistudio", label: "Google AI Studio", id: "aistudio", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", authHeader: "x-goog-api-key", secret: "",
  help: "Paste your own Google AI Studio key (aistudio.google.com/apikey, free tier). It is stored encrypted and never shown again. Free-tier limits are per model: the default (Gemini 3.5 Flash Lite) allows about 15 requests per minute and 500 per day.",
  warning: AISTUDIO_WARNING,
};
export const PRESETS: ProviderPreset[] = [NVIDIA_PRESET, AISTUDIO_PRESET, GROQ_PRESET];

// The model facts below are VIEWS of providers/seed.ts (the seed behind D1 `provider_models`, migration 0029): kept as the fallback when the table is not there yet and so
// existing callers/tests see the same values. The live catalog is catalog.ts (DB); nothing here is edited by hand any more.
import { NVIDIA_CHAT_SEED, NVIDIA_IMAGE_SEED, NVIDIA_GENAI_BASE as GENAI_BASE } from "./seed";

/** Chat models pre-ticked after "Load models" when the provider lists them: known-good free-preview families. */
export const NVIDIA_VERIFIED = NVIDIA_CHAT_SEED.map((m) => m.id);
/** Verified 2026-10-26 with a live request carrying a trivial `tools` array: these answered with `tool_calls`. */
export const NVIDIA_TOOLS_VERIFIED = NVIDIA_CHAT_SEED.filter((m) => m.caps.tools).map((m) => m.id);
/** Verified 2026-10-26 with a live request carrying a 64x64 PNG: these answered "red". */
export const NVIDIA_VISION_VERIFIED = NVIDIA_CHAT_SEED.filter((m) => m.caps.vision).map((m) => m.id);
export const NVIDIA_GENAI_BASE = GENAI_BASE;
export const NVIDIA_IMAGE_MODELS: Array<{ id: string; label: string; slug: string; steps: number }> = NVIDIA_IMAGE_SEED.map((m) => ({ id: m.id, label: m.name, slug: String(m.extra?.slug), steps: Number(m.extra?.steps) }));
/** aspect ratio -> width x height. Every value is one flux.1-dev accepts (768, 832, ... 1344), which is the strictest of the three. */
export const NVIDIA_IMAGE_DIMS: Record<string, [number, number]> = { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "4:3": [1152, 896], "3:4": [896, 1152] };
export const NVIDIA_PRETICK = NVIDIA_CHAT_SEED.filter((m) => m.suggested).map((m) => m.id);

export const preselect = (id: string) => NVIDIA_PRETICK.includes(id);
export const verified = (id: string) => NVIDIA_VERIFIED.includes(id);
/** Ids that are not chat models (embeddings, rerankers, guards, ...): never offered for ticking. The rule list is the NVIDIA descriptor's `discovery` (plain substrings). */
export const isChatId = (id: string) => discoveredKind(NVIDIA_DESCRIPTOR, id) !== "skip";
export const NVIDIA_LABELS: Record<string, string> = Object.fromEntries(NVIDIA_CHAT_SEED.map((m) => [m.id, m.name]));
