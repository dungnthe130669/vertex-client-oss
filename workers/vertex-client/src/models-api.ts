// /api/models payload: the registry's models + what the DB catalog and the latency aggregates add. Pure (tested without a Worker).
//   flags         vision / tools / image: the declared capability flags in picker form
//   priceEstimate $/Mtok ESTIMATE, only when the catalog row carries a priced `source`; null = unknown (never "free", never 0 by omission)
//   limits        free-tier limits {rpm,rpd,tpm,tpd} as a HINT (estimates, never throttling); limited = a very small daily quota: flagged, never the default; shortContext = history is trimmed to the per-minute limit
//   dataWarning   persistent data-use warning {vi,en} of the provider (e.g. free-tier content is read by Google); null = none
//   speed         tier + typical timings measured on recent use; tier "unknown" (and no timings) below SPEED.minSamples
import type { RegModel } from "./providers/registry";
import { bareModelId } from "./providers/registry";
import type { Catalog, ModelLimits } from "./providers/catalog";
import { descriptorOf } from "./providers/descriptor";
import { speedInfo, speedKey, type SpeedInfo, type SpeedStats } from "./latency";

export interface ModelFlags { vision: boolean; tools: boolean; image: boolean }
export interface PriceEstimate { inputPerMTok: number; outputPerMTok: number; source: string; estimate: true }
/** Free-tier limits as the provider's dashboard states them (estimates, never a promise); `shortContext` = history is trimmed to the per-minute token budget; `limited` = a very small daily quota (never the default). `dataWarning` = persistent data-use warning {vi,en} (null = none). */
export type ApiModel = RegModel & { kind: "chat"; flags: ModelFlags; priceEstimate: PriceEstimate | null; speed: SpeedInfo; limits: ModelLimits | null; shortContext: boolean; limited: boolean; dataWarning: { vi: string; en: string } | null };
/** A model with this few requests per day is flagged `limited` and never offered as the default. */
export const LIMITED_RPD = 100;
export const isLimited = (row: { limits: ModelLimits | null; extra: Record<string, unknown> | null } | undefined): boolean => !!row && (row.extra?.limited === true || (row.limits?.rpd !== undefined && row.limits.rpd <= LIMITED_RPD));
/** Open default preference (Erich 2026-10-26: NVIDIA NIM first, no TPM limit), in order: the first one that is in the list and not `limited` wins. This is only how the DEFAULT is picked when a
 *  provider has no key / the model is not listed; a failing model is switched at run time by src/failover.ts (Open only; Auto's escalation stays Claude-only, Business). `unhealthy` (the circuit breaker) skips a model that keeps failing; when every one is unhealthy the plain rule applies. A chat's saved model and a user's own pick never go through here. */
export const OPEN_DEFAULT_ORDER = [
  "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia:nvidia/nemotron-3-ultra-550b-a55b", "nvidia:minimaxai/minimax-m3.1-flash",
  "groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b", "aistudio:gemini-3.1-flash-lite",
  "aistudio:gemini-3.5-flash-lite", // intentionally after 3.1: measured, 3.1 is the faster one (review suggestion to swap declined)
];
/** The default model for an Open list: the first OPEN_DEFAULT_ORDER entry present and not `limited`, else the first model that is not `limited`; null when there is none (a limited model is never the default). */
export const defaultModelId = (models: Array<{ id: string; limited: boolean }>, unhealthy: (id: string) => boolean = () => false): string | null =>
  OPEN_DEFAULT_ORDER.find((id) => models.some((m) => m.id === id && !m.limited) && !unhealthy(id)) ?? models.find((m) => !m.limited && !unhealthy(m.id))?.id ?? models.find((m) => !m.limited)?.id ?? null;

export function decorateModels(models: RegModel[], catalog: Catalog, stats: Map<string, SpeedStats>): ApiModel[] {
  return models.map((m) => {
    const bare = bareModelId(m.provider, m.id);
    const row = (catalog.get(m.provider) ?? []).find((r) => r.id === bare && r.kind === "chat");
    const price = row?.price ?? null;
    return { ...m, kind: "chat" as const,
      flags: { vision: !!m.capabilities.vision, tools: !!m.capabilities.tools, image: !!m.capabilities["image-gen"] },
      priceEstimate: price ? { inputPerMTok: price.input, outputPerMTok: price.output, source: price.source, estimate: true as const } : null,
      limits: row?.limits ?? null, shortContext: row?.extra?.shortContext === true, limited: isLimited(row), dataWarning: descriptorOf(m.provider)?.dataWarning ?? null,
      speed: speedInfo("chat", stats.get(speedKey(m.provider, bare, "chat"))) };
  });
}
