// VCL on Open models (vclopen1 prototype, FLAG OFF by default: settings row `vcl_open:<base>` = '1', never set anywhere).
// A paired device may name `<provider>:<model>` (the Open provider registry's ids). The request is served by the provider registry of the base's OPEN space
// (providers/registry.ts `messages()`: Anthropic Messages in, Anthropic SSE out), with the USER'S OWN key only (stored via Settings > Providers, decrypted per call);
// no shared Worker secret is ever used here (see openRegistry). Business (Vertex) stays Claude-only: a `claude-*` id never reaches this path.
// Money: the device's daily cap stays fail-closed for models with no known price (see OPEN_FALLBACK_PRICE) and for providers that report no usage.
import type { Scope } from "./scope";
import { baseOf, isE2eOpen, scopeFor, spaceOf } from "./scope";
import { vclEnabled } from "./devices";
import { buildRegistry, type Registry } from "./providers/registry";
import { loadProviderConfigs } from "./providers/config";
import { loadCatalog } from "./providers/catalog";
import { descriptorOf } from "./providers/descriptor";
import { splitModelId } from "./providers/config";
import { userKeyIds, userKeysFor } from "./user-keys";
import { featuresOf } from "./features";
import { loadE2eRealProviders } from "./index-d1";
import { LLM_CHARS_PER_TOKEN, type SseUsage, effectiveUsage } from "./bridge-llm-core";
import type { ModelMeta } from "./models-meta";
import type { Usage } from "./reducer";

/** `<provider>:<model>`: a lowercase provider id, a colon, a model id (letters, digits, `. / : @ + - _`). Claude ids (no colon) never match. */
export const OPEN_MODEL_RE = /^[a-z0-9][a-z0-9-]{0,31}:[\w./:@+-]{1,120}$/;
export const isOpenModelId = (m: unknown): m is string => typeof m === "string" && OPEN_MODEL_RE.test(m) && splitModelId(m).provider !== "gateway";

/** Flag (default OFF): this base's devices may use Open models. Needs the VCL feature itself on. Any read problem = off. */
export async function vclOpenEnabled(db: D1Database | undefined, scope: Scope): Promise<boolean> {
  if (!db || !(await vclEnabled(db, scope))) return false;
  const base = baseOf(scope);
  try { return (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`vcl_open:${base}`).first<{ value: string }>())?.value === "1"; } catch { return false; }
}

/** $/Mtok charged against the device's daily cap for an Open model that states no price, or whose provider reports no usage: the dearest Claude rate (Opus 5.5), cache at the input rate.
 *  Deliberately high: a free/unpriced model must not become a way around the cap. It is an ESTIMATE of the cap's accounting, not what the user's provider charges. */
export const OPEN_FALLBACK_PRICE: NonNullable<ModelMeta["price"]> = { input: 4, output: 20, cacheRead: 4, cacheWrite: 4 };
export const openPriceOf = (meta: ModelMeta | null | undefined) => meta?.price ?? OPEN_FALLBACK_PRICE;

/** Worst-case $ reserved at admission (same shape as reserveUsd): input from body size, output = the full max_tokens (the adapter only lowers it for a model with a stated hard cap, so this never under-reserves). Never null: unpriced uses the fallback. */
export function openReserveUsd(meta: ModelMeta | null | undefined, bodyChars: number, maxTokens: number): number {
  const p = openPriceOf(meta);
  return (Math.ceil(bodyChars / LLM_CHARS_PER_TOKEN) * Math.max(p.input, p.cacheWrite) + maxTokens * p.output) / 1e6;
}

/** Usage to bill for an Open call. The adapter always ends a stream with a message_delta (zeros when the provider sent no usage), so zero is not trusted:
 *  no input tokens reported => estimate from the request size; no output tokens but text seen => estimate from the generated characters. */
export function openUsage(s: SseUsage, bodyChars: number): Usage {
  const u = effectiveUsage(s), inAll = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return { ...u, ...(inAll === 0 ? { input_tokens: Math.ceil(bodyChars / LLM_CHARS_PER_TOKEN) } : {}), ...((u.output_tokens ?? 0) === 0 && s.chars > 0 ? { output_tokens: Math.ceil(s.chars / LLM_CHARS_PER_TOKEN) } : {}) };
}

/** The Open-space registry for the device owner's base. Only this base's own stored keys can authenticate: a Worker secret is never reachable from here. */
export async function openRegistry(env: { DB: D1Database } & Record<string, unknown>, scope: Scope, fetchImpl?: typeof fetch): Promise<Registry | null> {
  if (spaceOf(scope) !== "biz") return null;
  const base = baseOf(scope);
  const open = scopeFor(base, "open"), catalog = await loadCatalog(env.DB);
  const reg = buildRegistry({ scope: open, gateway: null, extra: await loadProviderConfigs(env.DB, base, catalog), catalog, userKeys: userKeysFor(env as never, base, await userKeyIds(env.DB, base)),
    ...(isE2eOpen(open) ? { e2eReal: await loadE2eRealProviders(env.DB, base) } : {}), features: await featuresOf(env.DB, base), sharedCf: async () => false, env: {}, fetchImpl });
  return reg; // env: {} on purpose: no Worker secret (keyBinding) can resolve, so `needs-key` unless the user stored their own key
}

/** Server model list for vcl: Open chat models that are usable now (user's own key present, enabled), with tool support and the provider's data-use notice. */
export async function openModelList(reg: Registry): Promise<Array<{ id: string; display_name: string; tools: boolean; data_use_notice?: string }>> {
  const out = [];
  for (const m of await reg.models()) {
    if (!m.id.includes(":") || !m.capabilities.text || m.capabilities["image-gen"] || m.capabilities["video-gen"]) continue;
    const n = descriptorOf(m.provider)?.dataUseNotice;
    out.push({ id: m.id, display_name: m.name, tools: m.capabilities.tools, ...(n ? { data_use_notice: n } : {}) });
  }
  return out;
}
