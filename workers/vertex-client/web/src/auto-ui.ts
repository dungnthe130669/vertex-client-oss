// Auto model, UI-side pure helpers (picker entry, message label, override choices, Settings counts). Nothing here talks to the network.
import type { Model } from "./api";

export const AUTO_ID = "auto";
export const AUTO_DESCRIPTION = "Picks the model and thinking effort for each message";
export type Effort = "low" | "medium" | "high";
export type RouteView = { by: "auto-route" | "auto-fallback" | "manual-override" | "open-failover"; model: string; effort: Effort | null; reason: string; fallbackFrom?: string };

/** "claude-sonnet-5-5" -> "Sonnet 5.5", "claude-haiku-4-5" -> "Haiku 4.5", "claude-sonnet-5" -> "Sonnet 5". Unknown ids pass through. */
export function shortModel(id: string): string {
  const m = /^claude-(haiku|sonnet|opus)-(\d+)(?:-(\d+))?$/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
}
const eff = (e: Effort | null) => (e ? ` · ${e}` : "");
/** The small label under an answer. Shows what was SENT (effort is null when the model takes none). */
export function routeLabel(r: RouteView): string {
  if (r.by === "open-failover") return `Switched to ${shortModel(r.model.replace(/^[^:]+:/, ""))}`;
  if (r.by === "manual-override") return `Retried with ${shortModel(r.model)}${eff(r.effort)}`;
  return `Auto: ${shortModel(r.model)}${eff(r.effort)}${r.by === "auto-fallback" && r.fallbackFrom && r.fallbackFrom !== AUTO_ID ? ` (fallback from ${shortModel(r.fallbackFrom)})` : ""}`;
}

const isClaudeChat = (m: Model) => String(m.meta?.vendor).toLowerCase() === "anthropic" && (m.capabilities ? m.capabilities.text : true);
/** Models the picker offers, with "Auto" first, only when the scope lists at least one Claude chat model (Auto never picks anything else). Idempotent. */
export function withAuto(models: Model[]): Model[] {
  const rest = models.filter((m) => m.id !== AUTO_ID);
  if (!rest.some(isClaudeChat)) return rest;
  const auto: Model = {
    id: AUTO_ID, name: "Auto", description: AUTO_DESCRIPTION, provider: "gateway",
    meta: { label: "Auto", vendor: "anthropic", tier: "balanced", price: null, caps: { images: true, caching: true, thinking: true, tools: true } },
    capabilities: { text: true, vision: true, tools: true, "image-gen": false, "video-gen": false, reasoning: true },
  };
  return [auto, ...rest];
}
/** Concrete models "Retry with…" may use: the scope's Claude chat models (no Auto). */
export const retryChoices = (models: Model[] | null): Model[] => (models ?? []).filter((m) => m.id !== AUTO_ID && isClaudeChat(m));
/** Does this model take an effort setting? (server-declared in meta.acceptsEffort; haiku-5-5 is not probed) */
export const takesEffort = (m: Model | undefined): boolean => !!(m?.meta as { acceptsEffort?: boolean } | undefined)?.acceptsEffort;

/** Settings: last-30-day counts by chosen model, applied routes only (shadow rows `auto` are a different thing). Sorted by count. */
export function routeCounts(byRoute: Array<{ model: string; routedModel: string | null; routedBy: string; n: number }> | undefined): Array<{ model: string; n: number; fallback: number }> {
  const acc = new Map<string, { model: string; n: number; fallback: number }>();
  for (const r of byRoute ?? []) {
    if (r.routedBy !== "auto-route" && r.routedBy !== "auto-fallback") continue;
    const k = r.model, a = acc.get(k) ?? { model: k, n: 0, fallback: 0 };
    a.n += r.n; if (r.routedBy === "auto-fallback") a.fallback += r.n;
    acc.set(k, a);
  }
  return [...acc.values()].sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));
}
