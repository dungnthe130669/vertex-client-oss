import type { Usage } from "./reducer";
import type { ModelMeta } from "./models-meta";

/** $ for one model call from its FINAL usage. null = no known rate (show tokens only). Applies the model's high-prompt tier (prompt =
 *  input + cache read + cache write tokens) and bills the 1h part of cache writes at the 1h rate when usage reports the split. */
export function costOf(u: Usage, price: ModelMeta["price"] | undefined): number | null {
  if (!price) return null;
  const input = u.input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
  const r = price.highTier && input + read + write > price.highTier.aboveTokens ? price.highTier : price;
  const w1h = Math.min(write, Math.max(0, u.cache_creation?.ephemeral_1h_input_tokens ?? 0));
  const rate1h = r.cacheWrite1h ?? r.cacheWrite;
  return (input * r.input + (u.output_tokens ?? 0) * r.output + read * r.cacheRead + (write - w1h) * r.cacheWrite + w1h * rate1h) / 1e6;
}
export const totalTokens = (u: Usage) =>
  (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
