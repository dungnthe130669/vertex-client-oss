// Provider registry: providers register by id; a model id resolves to its provider by prefix (`<provider>:<model>`), and an id
// without a prefix is the gateway, so every existing conversation / model id keeps working unchanged.
// Adding a provider = one adapter (a ModelProvider) + one config entry. See docs/providers.md.
import { E2E_SCOPE, MAIN_SCOPE, baseOf, isE2eBase, isGuestScope, spaceOf, spaceUsesGateway, withSpace, type BaseScope, type Scope } from "../scope";
import { DEFAULT_PROVIDER_MAX_TOKENS, GEMINI_GATEWAY_MAX_TOKENS, MODELS_META, capabilitiesOfMeta, metaFromProviderModel, applyCatalogListing, beginCatalogListing, metaOf, registerModelMeta, GATEWAY_VISION_VERIFIED, type ModelMeta } from "../models-meta";
import { GATEWAY_ID, PROVIDERS, builtinPresetConfigs, withBuiltinPresets, workerKeyAllowed, prefixed, splitModelId, type ProviderConfig, type ProviderKind } from "./config";
import { openaiCompatProvider } from "./openai-compat";
import { geminiProvider } from "./gemini";
import { cfTeamEnabled, cloudflareProvider } from "./cloudflare";
import { CF_ACCT_PROVIDER, CF_ORIGIN } from "../cf-account";
import { stubProvider } from "./stub";
import { withUserKey, type UserKeys } from "../user-keys";
import { chatRows, imageRows, toConfigured, type Catalog } from "./catalog";
import { descriptorOf, protocolOfKind, type Protocol } from "./descriptor";
import { outcomeOfError, trackStream, type LatencySink } from "../latency";
import { ProviderError, type Capabilities, type ImageRequest, type ImageResult, type ModelKind, type ModelProvider, type ProviderModel, type VideoRequest, type VideoResult } from "./types";

export type KeySource = "user" | "stale" | "worker" | "none";
export type ProviderStatus = "enabled" | "off" | "needs-key";
export interface ProviderInfo { id: string; kind: ProviderKind; enabled: boolean; status: ProviderStatus; modelCount: number; /** UI-managed (D1) provider: editable, key never included */ editable?: boolean; /** built-in provider whose models are the catalog only (no row edits, no model ticking) */ catalogOnly?: boolean; /** persistent data-use warning (vi + en) for the UI */ dataWarning?: { vi: string; en: string }; /** team base: presets only (no custom URL, no row edits) */ presetOnly?: boolean; /** persistent data-use notice (descriptor), shown in Open */ dataUseNotice?: string; keySet?: boolean; key_source?: KeySource; authHeader?: string; host?: string; enabledModels?: string[]; broken?: string[] }
export interface RegModel { id: string; name: string; meta: ModelMeta | null; provider: string; capabilities: Capabilities }
/** The provider-own (unprefixed) model id. */
export const bareModelId = (provider: string, id: string) => (provider === GATEWAY_ID ? id : id.startsWith(`${provider}:`) ? id.slice(provider.length + 1) : id);

export type Adapter = (cfg: ProviderConfig, env: Record<string, unknown>, fetchImpl?: typeof fetch) => ModelProvider;
/** Adapter per PROTOCOL (descriptor.ts). A new wire protocol registers its factory here; a new provider of an existing protocol needs none. The gateway is built by the caller, not here. */
export const ADAPTERS: Partial<Record<Protocol, Adapter>> = {
  openai: (cfg, env, f) => openaiCompatProvider(cfg, env, f),
  "cloudflare-binding": (cfg, env, f) => cloudflareProvider(cfg, env, f),
  "gemini-native": (cfg, env, f) => geminiProvider(cfg, env, f),
  stub: (cfg) => stubProvider(cfg.models.map((m) => ({ id: m.id, displayName: m.displayName, capabilities: m.capabilities, pricePerMTok: m.pricePerMTok })), cfg.id),
};
/** The adapter for a config: kind -> protocol -> factory (`openai-compat` = protocol `openai`). */
export const adapterFor = (kind: ProviderKind): Adapter | undefined => { const p = protocolOfKind(kind); return p ? ADAPTERS[p] : undefined; };

/** Which configs a scope may use. main: all. e2e: only offline stubs (never a real provider, never money). guest: only configs that opt in. */
export const scopeMayUse = (scope: BaseScope, cfg: ProviderConfig, e2eReal = false) =>
  scope === MAIN_SCOPE ? true : isE2eBase(scope) ? cfg.kind === "stub" || (e2eReal && E2E_REAL_PROVIDERS.has(cfg.id) && (cfg.kind === "openai-compat" || cfg.kind === "gemini")) : isGuestScope(scope) && cfg.allowGuests === true;
/** Opt-in (settings row `e2e_real_providers:<base>` = '1', loadE2eRealProviders): the e2e base's Open space may use these real NON-Vertex providers (never the gateway, never custom rows). */
export const E2E_REAL_PROVIDERS: ReadonlySet<string> = new Set(["nvidia", "groq", "aistudio"]);
export const scopeGetsGateway = (scope: BaseScope) => scope === MAIN_SCOPE || isE2eBase(scope);

const hasWorkerKey = (cfg: ProviderConfig, env: Record<string, unknown>) => !!cfg.keyBinding && workerKeyAllowed(cfg) && typeof env[cfg.keyBinding] === "string" && (env[cfg.keyBinding] as string).length > 0;
export const keySourceOf = (cfg: ProviderConfig, env: Record<string, unknown>): KeySource => (cfg.userKeySet ? (cfg.userKeyStale ? "stale" : "user") : hasWorkerKey(cfg, env) ? "worker" : "none");
const hasKey = (cfg: ProviderConfig, env: Record<string, unknown>) => keySourceOf(cfg, env) !== "none";
export function statusOf(cfg: ProviderConfig, env: Record<string, unknown>): ProviderStatus {
  if (!cfg.enabled) return "off";
  if (cfg.kind === "cloudflare" && !env.AI && !cfg.userKeySet) return "off"; // a linked Cloudflare account does not need the shared binding
  if ((cfg.kind === "openai-compat" || cfg.kind === "gemini") && !hasKey(cfg, env)) return "needs-key";
  return "enabled";
}

export interface Registry {
  /** For GET /api/providers: ids, kinds, status, counts. No key material and no binding names. */
  list(): ProviderInfo[];
  /** Merged chat models of every usable provider. A gateway failure propagates (never an empty list); other providers are static config. */
  models(): Promise<RegModel[]>;
  /** One ModelProvider that routes by the prefix of body.model. */
  router: ModelProvider;
}

export function buildRegistry(o: { scope: Scope; /** per-user flags (src/features.ts) */ features?: ReadonlySet<string>; gateway: ModelProvider | null; /** self-host: the GATEWAY binding is absent, so the Vertex provider is neither listed nor routable */ noGateway?: boolean; /** team instance: the act-as provider that prefix-less ids route to for a g:* scope (never Erich's gateway) */ team?: ModelProvider | null; extra?: ProviderConfig[]; /** a model answered 404 (D1 write is the caller's) */ onBroken?: (providerId: string, model: string) => void; /** this user's own broken-model lists per provider (provider-routes loadUserBroken) */ userBroken?: Record<string, string[]>; env: Record<string, unknown>; fetchImpl?: typeof fetch; /** keys this base entered in the app (presence + per-request decrypt); absent = Worker secrets only */ userKeys?: UserKeys; /** e2e base only: the `e2e_real_providers` opt-in (default off; ignored for every other base) */ e2eReal?: boolean; /** live "may this base use the shared Cloudflare account now" (src/features.ts `workers-ai`, default on). Absent: main yes, a team base only per `features` (or the legacy PROVIDER_CF_TEAM when no features are given) */ sharedCf?: () => Promise<boolean>; /** model catalog (D1 provider_models, seed fallback). Absent = the built-in seed */ catalog?: Catalog; /** latency sink: every routed call is timed (never content) */ latency?: LatencySink; now?: () => number }): Registry {
  const { scope, env } = o;
  // Business (Vertex) lists NO provider config: gateway / team act-as only. Open lists the shared configs (credentials read by the BASE) the base may use,
  // never the gateway. The e2e base's Open space gets one built-in offline stub (no network, no money) so e2e~open can be exercised.
  const open = spaceOf(scope) === "open";
  // Shared Cloudflare account listing: the per-user flag (default on, explicit off) when features are supplied, else the legacy global PROVIDER_CF_TEAM flag.
  const sharedListed = o.features ? o.features.has("workers-ai") : cfTeamEnabled(env);
  const base = baseOf(scope);
  const sharedNow = o.sharedCf ?? (async () => base === MAIN_SCOPE || sharedListed);
  const builtin = PROVIDERS.filter((p) => p.id !== GATEWAY_ID).map((p) => (p.kind === "stub" && isE2eBase(withSpace(scope, "biz")) ? { ...p, enabled: true } : p));
  // e2e opt-in: the built-in presets as main sees them (nvidia keeps its Worker-secret binding; groq/aistudio are user-key only), never D1 rows.
  const e2eReal = o.e2eReal === true && base === E2E_SCOPE;
  const presets = e2eReal ? builtinPresetConfigs(MAIN_SCOPE, o.catalog).filter((c) => E2E_REAL_PROVIDERS.has(c.id)) : withBuiltinPresets(baseOf(scope), o.extra ?? [], o.catalog);
  const configs = !open ? [] : [...builtin, ...presets].filter((c) => scopeMayUse(baseOf(scope), c, e2eReal) || (c.kind === "cloudflare" && isGuestScope(baseOf(scope)) && (sharedListed || !!o.userKeys?.ids.has(CF_ACCT_PROVIDER))))
    // a team base never reaches the shared Worker secret: only its own stored key can authenticate a provider
    .map((c) => (isGuestScope(baseOf(scope)) && c.keyBinding ? { ...c, keyBinding: undefined } : c))
    .map((c) => (o.userKeys && (c.kind === "openai-compat" || c.kind === "gemini") ? withUserKey(c, o.userKeys) : c))
    // Cloudflare: the resolver is ALWAYS attached (the call path decides from its own read: a linked account is used, an unreadable row fails closed, no row = shared binding)
    .map((c) => (c.kind === "cloudflare" ? { ...c, sharedAllowed: sharedNow } : c))
    .map((c) => (o.userKeys && c.kind === "cloudflare" ? { ...c, resolveKey: () => o.userKeys!.get(CF_ACCT_PROVIDER, CF_ORIGIN), ...(o.userKeys.ids.has(CF_ACCT_PROVIDER) ? { userKeySet: true } : {}) } : c))
    // The model lists are DATA: the catalog (D1 rows, seed fallback) replaces the built-in Cloudflare list and gives NVIDIA image endpoint its model rows.
    .map((c) => (o.catalog && c.kind === "cloudflare" ? { ...c, models: [...chatRows(o.catalog, c.id), ...imageRows(o.catalog, c.id)].map(toConfigured) } : c))
    .map((c) => (o.catalog && c.id === "nvidia" && c.kind === "openai-compat" ? { ...c, mediaModels: imageRows(o.catalog, c.id).map((r) => ({ id: r.id, label: r.name, slug: String(r.extra?.slug ?? ""), steps: Number(r.extra?.steps) || 4 })) } : c))
    .map((c) => (o.userBroken?.[c.id]?.length ? { ...c, broken: [...new Set([...(c.broken ?? []), ...o.userBroken[c.id]!])] } : c))
    .map((c) => (o.onBroken ? { ...c, onBroken: (m: string) => { (c.broken ??= []).includes(m) || c.broken.push(m); o.onBroken!(c.id, m); } } : c));
  const live = new Map<string, { cfg: ProviderConfig; provider: ModelProvider }>();
  for (const cfg of configs) {
    if (statusOf(cfg, env) !== "enabled") continue;
    const make = adapterFor(cfg.kind);
    if (make) live.set(cfg.id, { cfg, provider: make(cfg, env, o.fetchImpl) });
    for (const m of cfg.models) registerModelMeta(prefixed(cfg.id, m.id), metaFromProviderModel(m.displayName, m.capabilities, m.pricePerMTok, m.contextWindow, m.maxOutput ? Math.min(m.maxTokens ?? DEFAULT_PROVIDER_MAX_TOKENS, m.maxOutput) : m.maxTokens, m.extra));
  }
  const gateway = spaceUsesGateway(scope) && scopeGetsGateway(baseOf(scope)) && !o.noGateway; // gateopt1: `noGateway` (self-host, GATEWAY binding absent) = no Vertex entry
  const gw = gateway ? o.gateway : spaceUsesGateway(scope) && isGuestScope(baseOf(scope)) ? o.team ?? null : null;

  const list = (): ProviderInfo[] => [
    ...(gateway || gw ? [{ id: GATEWAY_ID, kind: "gateway" as const, enabled: true, status: "enabled" as const, modelCount: 0 }] : []),
    ...configs.map((c) => ({ id: c.id, kind: c.kind, enabled: c.enabled, status: statusOf(c, env), modelCount: c.kind === "cloudflare" ? c.models.filter((m) => (m.kind ? m.kind !== "image" : !m.capabilities["image-gen"])).length : c.models.length,
      ...(descriptorOf(c.id)?.dataUseNotice ? { dataUseNotice: descriptorOf(c.id)!.dataUseNotice } : {}),
      ...(c.kind === "gemini" ? { editable: true, catalogOnly: true, ...(descriptorOf(c.id)?.dataWarning ? { dataWarning: descriptorOf(c.id)!.dataWarning } : {}), ...(isGuestScope(baseOf(scope)) ? { presetOnly: true } : {}), keySet: hasKey(c, env), key_source: keySourceOf(c, env), authHeader: c.authHeader ?? "bearer", host: (() => { try { return new URL(c.baseUrl ?? "").hostname; } catch { return ""; } })(), enabledModels: c.models.map((m) => m.id), broken: c.broken ?? [] } : {}),
      ...(c.kind === "openai-compat" ? { editable: true, ...(isGuestScope(baseOf(scope)) ? { presetOnly: true } : {}), keySet: hasKey(c, env), key_source: keySourceOf(c, env), authHeader: c.authHeader ?? "bearer", host: (() => { try { return new URL(c.baseUrl ?? "").hostname; } catch { return ""; } })(), enabledModels: c.models.map((m) => m.id), broken: c.broken ?? [] } : {}) })),
  ];
  const NOT_IN_SPACE = "model not available in this space"; // generic on purpose: never says what exists in the other space
  const pick = (model: unknown): { p: ModelProvider; bare: string } => {
    const { provider, model: bare } = splitModelId(String(model ?? ""));
    if (provider === GATEWAY_ID) { if (!gw) throw open ? new ProviderError(NOT_IN_SPACE, 400, { type: "invalid_request_error" }) : new ProviderError("no provider for scope", 403); return { p: gw, bare }; }
    const e = live.get(provider);
    if (!e) throw new ProviderError(configs.some((c) => c.id === provider) ? `Provider "${provider}" is not available.` : NOT_IN_SPACE, 400, { type: "invalid_request_error" });
    return { p: e.provider, bare };
  };
  // Latency: the same wrapper for every provider (gateway included). Timing + outcome only; the sink swallows its own errors.
  const space = spaceOf(scope) === "open" ? "open" as const : "biz" as const, now = o.now ?? Date.now;
  const timed = async <T>(kind: ModelKind, model: unknown, signal: AbortSignal | undefined, call: (bare: string, p: ModelProvider) => Promise<T>, stream?: (r: T, t: { startedAt: number; ttfbMs: number }, b: { providerId: string; modelId: string; kind: ModelKind; space: "open" | "biz" }) => T): Promise<T> => {
    const { p, bare } = pick(model);
    const sink = o.latency; if (!sink) return call(bare, p);
    const providerId = splitModelId(String(model ?? "")).provider, startedAt = now(), base = { providerId, modelId: bare, kind, space };
    let r: T;
    try { r = await call(bare, p); }
    catch (e) { try { sink.record({ ...base, startedAt, ttfbMs: null, ttfrMs: null, ttfaMs: null, totalMs: now() - startedAt, outputTokens: null, outcome: outcomeOfError(e, signal) }); } catch { /* never breaks a turn */ } throw e; }
    const ttfbMs = now() - startedAt;
    if (stream) return stream(r, { startedAt, ttfbMs }, base);
    try { sink.record({ ...base, startedAt, ttfbMs, ttfrMs: null, ttfaMs: null, totalMs: ttfbMs, outputTokens: null, outcome: "ok" }); } catch { /* never breaks a turn */ }
    return r;
  };
  const router: ModelProvider = {
    name: "registry", id: "registry",
    async listModels(kind?: ModelKind) {
      const out: ProviderModel[] = [];
      if (gw) out.push(...(await gw.listModels(kind)));
      for (const [id, e] of live) for (const m of await e.provider.listModels(kind)) out.push({ ...m, id: prefixed(id, m.id) });
      return out;
    },
    messages: (body: any, signal) => timed("chat", body?.model, signal, (bare, p) => p.messages({ ...body, model: bare }, signal),
      (res, t, b) => trackStream(res, t, b, o.latency!, signal, now)),
    // Media models are gateway-only unless a provider's own adapter offers them (prefixed id).
    image: (req: ImageRequest, signal): Promise<ImageResult> => timed("image", req.model, signal, (bare, p) => { if (!p.image) throw new ProviderError("Image generation is not available for this model.", 400); return p.image({ ...req, model: bare }, signal); }),
    video: (req: VideoRequest, signal): Promise<VideoResult> => timed("video", req.model, signal, (bare, p) => { if (!p.video) throw new ProviderError("Video generation is not available for this model.", 400); return p.video({ ...req, model: bare }, signal); }),
  };
  return {
    list,
    router,
    async models() {
      const out: RegModel[] = [];
      if (gw) {
        const catScope = String(scope), ticket = beginCatalogListing(catScope), entries = new Map<string, ModelMeta>(), rows: Array<{ m: ProviderModel }> = [];
        for (const listed of await gw.listModels()) if (!listed.kind || listed.kind === "chat") {
          // The gateway catalog is the source of truth for bare gateway ids: a stated `images_in` decides vision (true => allowed, false => refused up front).
          // Only a catalog that does not state it (older gateway, team catalog) falls back to the live-proven GATEWAY_VISION_VERIFIED list.
          const vision = typeof listed.imagesIn === "boolean" ? listed.imagesIn : GATEWAY_VISION_VERIFIED.has(listed.id);
          const m: ProviderModel = listed.capabilities || vision ? { ...listed, capabilities: { ...(listed.capabilities ?? capabilitiesOfMeta(null)), vision } } : listed; // no declared caps and no vision: unchanged (no meta entry is invented)
          // PRECEDENCE (PO decision, gemcap3): curated MODELS_META wins over this entry (metaOf reads MODELS_META first), so a curated, live-proven Claude id keeps its images even if the catalog says images_in:false
          // (the gateway does that for ids outside SO's verified list, e.g. the dated claude-haiku-4-5-20251001); honouring it would regress Claude image sends. Only uncurated ids follow the catalog.
          // Curated MODELS_META wins; otherwise the gateway catalog's own price/capabilities make the model priced and usable (no price => unrated, tokens only).
          // Refreshed on EVERY listing and keyed by scope: a changed catalog price/caps replaces this scope's entry, a catalog that no longer states one drops it.
          if (m.pricePerMTok || m.capabilities) entries.set(m.id, metaFromProviderModel(m.displayName, m.capabilities ?? capabilitiesOfMeta(null), m.pricePerMTok, m.contextWindow, m.maxTokens ?? (/^gemini-/.test(m.id) ? GEMINI_GATEWAY_MAX_TOKENS : undefined)));
          rows.push({ m });
        }
        applyCatalogListing(catScope, ticket, entries); // returns false for a stale listing: it then reads what the scope holds now, never its own older prices
        for (const { m } of rows) {
          // A stale listing (a newer one already applied) must not hand out its own old price: read whatever the scope holds now.
          const meta = metaOf(catScope, m.id) ?? null;
          out.push({ id: m.id, name: m.displayName, meta, provider: GATEWAY_ID, capabilities: m.capabilities ?? capabilitiesOfMeta(meta) });
        }
      }
      for (const [id, e] of live) for (const m of await e.provider.listModels()) {
        const pid = prefixed(id, m.id);
        out.push({ id: pid, name: m.displayName, meta: MODELS_META[pid] ?? null, provider: id, capabilities: m.capabilities ?? capabilitiesOfMeta(MODELS_META[pid]) });
      }
      return out;
    },
  };
}
