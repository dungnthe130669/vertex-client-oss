// Picker speed hint: tier badge + "typically ~Xs to first answer, ~Ys total" from the server's measured aggregates (/api/models `speed`). A model with no tier yet shows a neutral "Not measured yet".
export type SpeedTier = "fast" | "medium" | "slow" | "unknown";
export type ModelSpeed = { tier: SpeedTier; samples: number; firstAnswerMs: number | null; totalMs: number | null; tokensPerS: number | null };
export type PriceEstimate = { inputPerMTok: number; outputPerMTok: number; source: string; estimate: true };

const sec = (ms: number) => { const s = ms / 1000; return s < 10 ? s.toFixed(1) : String(Math.round(s)); };
export const TIER_LABEL: Record<Exclude<SpeedTier, "unknown">, string> = { fast: "Fast", medium: "Medium", slow: "Slow" };
/** Unknown tier (fewer than the server's minimum samples) = a neutral "not measured yet" chip, never nothing. A model without a `speed` field at all (old server) shows nothing. */
export function speedHint(s: ModelSpeed | null | undefined): { tier: SpeedTier; label: string; text: string } | null {
  if (!s) return null;
  if (s.tier === "unknown") return { tier: "unknown", label: "Not measured yet", text: s.samples > 0 ? `${s.samples} measured so far; a speed label appears after a few uses` : "a speed label appears after a few uses" };
  const parts = [s.firstAnswerMs !== null ? `~${sec(s.firstAnswerMs)}s to first answer` : "", s.totalMs !== null ? `~${sec(s.totalMs)}s total` : ""].filter(Boolean);
  if (!parts.length) return null;
  return { tier: s.tier, label: TIER_LABEL[s.tier], text: `typically ${parts.join(", ")} (measured on recent use)` };
}
/** Only a known estimate is shown, and it says so; unknown = nothing (never "free"). */
export const priceHint = (p: PriceEstimate | null | undefined) => (p ? `est. $${p.inputPerMTok}/${p.outputPerMTok} per M tokens` : null);

/** Provider id (the model id's prefix) -> the name shown in wait notes. */
const PROVIDER_NAME: Record<string, string> = { aistudio: "Google", groq: "Groq", nvidia: "NVIDIA", cloudflare: "Cloudflare" };
export const providerName = (modelId: string | null | undefined) => { const i = (modelId ?? "").indexOf(":"); return (i > 0 && PROVIDER_NAME[modelId!.slice(0, i)]) || null; };
export const STILL_WAITING_MS = 10_000;
/** Live note while waiting for the first token: a retry in progress (attempts counts attempt events seen), else "still waiting" after 10 s. null = nothing to add. */
export function waitNote(attempts: number, waitedMs: number, modelId?: string | null): string | null {
  const who = providerName(modelId);
  if (attempts > 1) return `${who ?? "Provider"} busy, retrying (attempt ${attempts})`;
  return waitedMs >= STILL_WAITING_MS ? "still waiting for the provider" : null;
}
/** Details-chip note for a finished turn: how many failed attempts preceded the successful one. */
/** Retry note for a whole turn: retries are summed across its steps (each step stores its own); the provider named is the first retried step's. */
export const turnRetryNote = (turn: ReadonlyArray<{ retries?: number | null; model?: string | null }>) => {
  const n = turn.reduce((a, m) => a + (m.retries && m.retries > 0 ? m.retries : 0), 0);
  return retryNote(n, turn.find((m) => m.retries && m.retries > 0)?.model);
};
export const retryNote = (retries: number | null | undefined, modelId?: string | null) => (retries && retries > 0 ? `${providerName(modelId) ?? "Provider"} busy, retried ${retries}x` : null);
