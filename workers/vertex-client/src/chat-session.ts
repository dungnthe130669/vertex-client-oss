// ChatSession Durable Object: one per conversation. Owns the SQLite source of truth (via ChatEngine), the hibernatable
// WebSockets, and the turn loop. The turn is awaited inside the webSocketMessage handler so the DO stays alive.
import { DurableObject } from "cloudflare:workers";
import { ChatEngine, parseOverride, type ServerEvent } from "./turn-engine";
import { d1Index, loadE2eRealProviders, loadAutoDelegate, loadAnswerLimit, loadAutoMaxUsd, loadAutoShadow, loadConfirmUsd, loadForceToolCues, loadDebugTurns, loadOpenFailover, loadOpenFailoverAistudio } from "./index-d1";
import { wsDiagLine } from "./ws-diag";
import { buildCandidates } from "./failover";
import { healthOf } from "./provider-health";
import { descriptorOf } from "./providers/descriptor";
import { AUTO_MAX_USD_DEFAULT } from "./auto-route";
import { metaOf } from "./models-meta";
import { connectorTools, type ToolHost } from "./tools";
import { artifactTools, withArtifacts } from "./artifacts";
import { EMPTY_TOOL_HOST, headerScope, hostForScope, resolveScope, toolHostFor } from "./auth-e2e";
import { baseOf, isE2eBiz, isE2eOpen, guestUid, isGuestScope, providerFor, spaceOf, type Scope } from "./scope";
import { teamConfigured, teamGatewayProvider } from "./providers/team-gateway";
import { buildRegistry } from "./providers/registry";
import { loadUserBroken, markBroken } from "./provider-routes";
import { keyEpochOf, userKeyIds, userKeyOf, userKeysFor, type UserKeys } from "./user-keys";
import { featureOn, featuresOf, type Feature } from "./features";
import { CF_ACCT_PROVIDER, CF_ORIGIN, cfAccountOf, linkableEnv } from "./cf-account";
import { loadProviderConfigs, ttlLoader, type ProviderConfig } from "./providers/config";
import { loadCatalog, seedCatalog, type Catalog } from "./providers/catalog";
import { d1Sink } from "./latency";
import { skillTemplate } from "./skills";
import { getPersona, listPersonas } from "./personas";
import { subagentHost, withDelegate } from "./subagent";
import { promptInstructions } from "./profile";
import { projectInstructions } from "./projects";
import { filterHost, loadSettings, pinSettings, type ConnectorSettings } from "./connectors";
import { composeHosts, customHost } from "./custom-connectors";
import { r2Store, destroyOrdered } from "./files";
import { gatewayProvider } from "./providers/gateway";
import { stubImage, stubImageModels } from "./providers/stub-image";
import { loadRunJs, runJsHost, withRunJs } from "./run-js";
import { CF_TOOL_NAMES, cfToolDefs, cfToolFlags, cfToolsAllowed, cfToolsHost, withCfTools, type BrowserBinding } from "./cf-tools";
import { cloudflareProvider } from "./providers/cloudflare";
import { CLOUDFLARE_ID } from "./providers/config";
import { imageToolHost, loadChatImages, withImageTool } from "./image-tool";
import { stubVideo, stubVideoModels } from "./providers/stub-video";
import type { GenCommand } from "./gen-engine";
import type { ModelProvider } from "./providers/types";
import { notifyText, pushTo } from "./push";
import { recordNotification } from "./notifications";
import { addGrant, approvalAutoOn, recordBypassConfirm, userHosts, writeAudit } from "./grants";
import { BYPASS_CONFIRM_VERSION } from "./approval";
import { noRedirect } from "./approval";
import { vclEnvEnabled } from "./devices";
import { runDeviceTurn, type DeviceIO } from "./device-turn";
import type { Env } from "./index";

export class ChatSession extends DurableObject<Env> {
  engine: ChatEngine;
  private scopeCache: Scope | null = null;
  /** Data scope of this conversation ('main' = Erich, 'e2e' = the test user, 'g:<uid>' = a team user), read once from the D1 index. */
  private async scope(): Promise<Scope> {
    if (this.scopeCache) return this.scopeCache;
    return (this.scopeCache = await resolveScope(this.env.DB, this.engine.convId)); // fail closed: throws, only positive results are cached
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const raw = connectorTools(env.CONNECTOR, env.CONNECTOR_TOKEN);
    // Tool host by scope (explicit table in auth-e2e.ts): main = the raw personal connector, e2e = the guarded subset, anything else = empty.
    this.rawTools = raw;
    // Connector switches (Settings → Connectors) are resolved once per conversation and pinned in the DO's meta: the tool block is a prompt-cache
    // breakpoint, so a toggle applies to NEW conversations only. The filter sits outside the scope table, so it can only remove tools.
    const personal = async (): Promise<ToolHost> => { const sc = await this.scope(); return raw ? filterHost(toolHostFor(sc, raw), await this.pinnedSettings(sc)) : EMPTY_TOOL_HOST; };
    // User-added MCP connectors (Settings → Connectors → +): main scope only, tool set pinned per conversation like the switches above.
    let custom: ToolHost | null = null;
    const customFor = async (): Promise<ToolHost> => {
      const sc = await this.scope();
      return (custom ??= customHost({ db: env.DB, scope: sc, secret: env.SESSION_SECRET, store: { get: () => this.engine.meta("custom_connectors"), set: (v) => this.engine.setMeta("custom_connectors", v) } }));
    };
    // Artifacts (create_artifact / update_artifact): client-side tools over D1 + R2, offered to main only (artifactTools returns an empty host for any other scope).
    let cfHost: ToolHost | null = null; // memoised: per-turn image counter
    let imageHost: ToolHost | null = null; // memoised: its per-turn image counter must live as long as the DO
    let delegateHost: ToolHost | null = null; // memoised: its per-turn cap lives as long as the DO
    // run_js (src/run-js.ts): wraps whatever host the conversation resolved to; absent LOADER or flag off = adds nothing.
    const runJs = runJsHost(env.LOADER, async () => loadRunJs(env.DB, baseOf(await this.scope())));
    const resolved = async () => withRunJs(await resolvedBase(), runJs);
    const resolvedBase = async () => {
      const sc = await this.scope();
      const base = raw || env.SESSION_SECRET ? composeHosts(await personal(), await customFor()) : EMPTY_TOOL_HOST;
      const withArt = withArtifacts(base, artifactTools({ db: env.DB, files: env.FILES, scope: sc, conv: this.engine.convId }));
      // Subagents (`delegate`): offered when the caller has personas. Its own tools are drawn from `base` (the parent's personal + custom connector
      // tools), never from artifacts/images/delegate; the persona's READ-only list is enforced again inside subagentHost.
      const withSub = withDelegate(withArt, delegateHost ??= subagentHost({
        provider, personas: async () => listPersonas(env.DB, await this.scope()),
        models: () => provider.listModels("chat"),
        metaOf: (id) => metaOf(this.scopeCache, id),
        tools: async () => base, index: d1Index(env.DB, () => this.scope()), conv: () => this.engine.convId,
        transcript: () => this.engine.messages(),
        pin: { get: () => this.engine.meta("personas_tool"), set: (v) => this.engine.setMeta("personas_tool", v) },
      }));
      // Open (not e2e): the Cloudflare layer (web_read/web_screenshot/web_links via BROWSER, generate_image via AI). With the AI binding it also replaces the
      // generic generate_image (which cannot price Workers AI models and would always refuse); without any binding it adds nothing. Business never reaches this.
      // A user who linked their own Cloudflare account (Settings > Cloudflare) gets the tools even when this deployment has no shared binding.
      // e2e opt-in (e2e_real_providers): ONLY the shared-browser web tools (web_read/web_links/web_screenshot) on an EMPTY base: no personal connector, no notes, no generate_image / paid media.
      if (isE2eOpen(sc) && env.BROWSER && (await loadE2eRealProviders(env.DB, baseOf(sc)))) {
        return withCfTools(EMPTY_TOOL_HOST, cfHost ??= cfToolsHost({ browser: env.BROWSER, image: null, nvidia: null, shared: async () => true, account: null, linkable: false, db: env.DB, scope: sc, files: null, index: d1Index(env.DB, () => this.scope()), conv: () => this.engine.convId }));
      }
      const linkable = linkableEnv(env);
      if (cfToolsAllowed(sc) && (env.BROWSER || env.AI || linkable)) {
        const account = () => cfAccountOf(env, baseOf(sc));
        // generate_image: NVIDIA FLUX first (through the Open registry: user key > Worker secret rules, origin binding), Cloudflare Workers AI as the fallback (the user's own
        // account if linked, else the shared one while the `workers-ai` flag allows it). The shared AI/BROWSER bindings are never used without that flag (cf-tools + provider).
        const cfImage = env.AI || linkable ? cloudflareProvider({ id: CLOUDFLARE_ID, kind: "cloudflare", enabled: true, models: [], resolveKey: () => userKeyOf(env, baseOf(sc), CF_ACCT_PROVIDER, CF_ORIGIN), sharedAllowed: sharedCfOf(sc) }, env as unknown as Record<string, unknown>).image!.bind(null) : null;
        const cf = (cfHost ??= cfToolsHost({
          browser: env.BROWSER ?? null,
          image: cfImage,
          nvidia: async (req, sig) => (await routerOfScope(await this.scope())).image!(req, sig),
          shared: sharedCfOf(sc),
          account, linkable,
          db: env.DB, scope: sc, files: env.FILES ? r2Store(env.FILES) : null, index: d1Index(env.DB, () => this.scope()), conv: () => this.engine.convId,
        }));
        return withCfTools(withSub, cf);
      }
      return withImageTool(withSub, imageHost ??= makeImageHost());
    };
    const makeImageHost = () => (
      imageToolHost({
        provider: provider, enabled: async () => loadChatImages(env.DB, await this.scope()),
        models: async () => (isE2eBiz(await this.scope()) ? stubImageModels() : provider.listModels("image")),
        files: env.FILES ? r2Store(env.FILES) : null, index: d1Index(env.DB, () => this.scope()), conv: () => this.engine.convId, confirmUsd: () => loadConfirmUsd(env.DB),
        pin: { get: () => this.engine.meta("image_tool"), set: (v) => this.engine.setMeta("image_tool", v) },
      }));
    const tools: ToolHost = {
      list: async () => (await resolved()).list(),
      call: async (n, a, ctx) => (await resolved()).call(n, a, ctx),
    };
    // Erich's gateway credential is only handed to main/e2e conversations (providerFor throws "no provider for scope" for anything else).
    const real0: ModelProvider | null = env.GATEWAY ? gatewayProvider(env.GATEWAY, env.GATEWAY_KEY ?? "") : null;
    // Provider registry (gateway + enabled provider configs this scope may use), routed by the model id's prefix. D1 configs (main only) load
    // once at start (best effort); the built-in list is available immediately. Scope is resolved per call, fail closed.
    // Provider rows are re-read from D1 at most every 15 s (on use), so removing/disabling a provider reaches running conversations quickly.
    // The model catalog (D1 provider_models, seed fallback) with the same 15 s refresh.
    const catalogLd = ttlLoader((_sc: Scope) => loadCatalog(env.DB), seedCatalog() as Catalog);
    const latency = d1Sink(env.DB, (p) => this.ctx.waitUntil(p));
    const extraCfg = ttlLoader((sc: Scope) => loadProviderConfigs(env.DB, baseOf(sc), catalogLd.value), [] as ProviderConfig[]);
    // Which providers this base stored an in-app key for (presence only, same 15 s refresh). The key itself is decrypted per request inside the adapter and never held here:
    // a removed key therefore stops being used on the very next call.
    const keyIds = ttlLoader((sc: Scope) => userKeyIds(env.DB, baseOf(sc)), new Map<string, string>());
    const e2eRealLd = ttlLoader((sc: Scope) => loadE2eRealProviders(env.DB, baseOf(sc)), false);
    const featOn = ttlLoader((sc: Scope) => featuresOf(env.DB, baseOf(sc)), new Set<Feature>() as ReadonlySet<Feature>);
    // A link/unlink in this isolate bumps the base's key epoch: the 15 s presence cache is dropped at once instead of waiting out its window.
    let keyEpochSeen = new Map<string, number>();
    const refreshExtra = (sc: Scope) => {
      const gb = baseOf(sc); const e = keyEpochOf(gb);
      if (keyEpochSeen.get(gb) !== e) { keyEpochSeen.set(gb, e); keyIds.invalidate(); }
      return Promise.all([catalogLd.refresh(sc), extraCfg.refresh(sc), keyIds.refresh(sc), featOn.refresh(sc), brokenLd.refresh(sc), e2eRealLd.refresh(sc)]);
    };
    // May this base use the operator's shared Cloudflare account NOW: the per-user `workers-ai` flag (default on, explicit '0' off), read fresh from D1 per call, never from a cache.
    const sharedCfOf = (sc: Scope) => () => featureOn(env.DB, baseOf(sc), "workers-ai");
    const brokenLd = ttlLoader((sc: Scope) => loadUserBroken(env.DB, baseOf(sc)), {} as Record<string, string[]>);
    const userKeysOf = (scope: Scope): UserKeys => userKeysFor(env, baseOf(scope), keyIds.value);
    const registryFor = (scope: Scope, team: ModelProvider | null = null) => buildRegistry({ scope, gateway: real0, ...(real0 ? {} : { noGateway: true }), team, extra: extraCfg.value, catalog: catalogLd.value, latency, userKeys: userKeysOf(scope), e2eReal: e2eRealLd.value, features: featOn.value, sharedCf: sharedCfOf(scope), onBroken: (pid, m) => void markBroken(env.DB, pid, m, baseOf(scope)), userBroken: brokenLd.value, env: env as unknown as Record<string, unknown> });
    const routerFor = (scope: Scope) => registryFor(scope).router;
    const guestRouter = (scope: Scope, team: ModelProvider | null = null) => { const r = registryFor(scope, team); return r.list().length ? r.router : null; };
    // Team instance: a g:<uid> conversation acts as that user's email (team_users row, status active) through the team gateway. No row / disabled / not
    // configured => null => "no provider for scope". Erich's GATEWAY_KEY is never involved (providerFor only hands it to main/e2e).
    const teamFor = async (sc: Scope): Promise<ModelProvider | null> => {
      const gb = baseOf(sc);
      if (spaceOf(sc) !== "biz" || !isGuestScope(gb) || !teamConfigured(env)) return null;
      const row = await env.DB.prepare(`SELECT email, status FROM team_users WHERE uid=?`).bind(guestUid(gb)).first<{ email: string; status: string }>();
      return row && row.status === "active" ? teamGatewayProvider(env, row.email) : null;
    };
    // The model router of one scope. Business: providerFor (gateway / team act-as, as before). Open: the Open registry's router (live Open providers
    // only; providerFor refuses Open by design so the gateway key can never be reached from there).
    const routerOfScope = async (sc: Scope): Promise<ModelProvider> => {
      await refreshExtra(sc);
      if (spaceOf(sc) === "open") return routerFor(sc);
      const tp = await teamFor(sc);
      return providerFor(sc, () => routerFor(sc), () => guestRouter(sc, tp));
    };
    const real: ModelProvider = {
      name: real0?.name ?? "no-gateway",
      listModels: async (k) => (await routerOfScope(await this.scope())).listModels(k),
      // `return await` (not a bare return): registry `pick` rejects synchronously (no provider for the scope/model), and a promise adopted by an async
      // function without an awaiting frame reports an unhandled rejection in workerd even though the caller catches it.
      messages: async (b, sig) => { const r = await routerOfScope(await this.scope()); return await r.messages(b, sig); },
      image: async (r, sig) => (await routerOfScope(await this.scope())).image!(r, sig),
      video: async (r, sig) => (await routerOfScope(await this.scope())).video!(r, sig),
    };
    // Image and video calls of the e2e user's conversations (scope 'e2e', session minted by POST /auth/e2e) go to a deterministic stub: no network,
    // no money (README in e2e/vertex-client). Everything else, and every 'main' conversation, uses the real gateway.
    // The same scope rule applies to the media LISTING (the estimate reads it): an e2e conversation sees the stubs, never a gateway it cannot reach.
    const provider: ModelProvider = { name: real.name, messages: real.messages,
      listModels: async (k) => (isE2eBiz(await this.scope()) && (k === "image" || k === "video") ? (k === "image" ? stubImageModels() : stubVideoModels()) : real.listModels(k)),
      image: async (req, signal) => (isE2eBiz(await this.scope()) ? stubImage(req) : real.image!(req, signal)),
      video: async (req, signal) => (isE2eBiz(await this.scope()) ? await stubVideo(req, signal) : real.video!(req, signal)) };
    const health = () => healthOf(env.DB, (p) => this.ctx.waitUntil(p), this.scopeCache ?? "?");
    this.engine = new ChatEngine({
      sql: ctx.storage.sql,
      provider,
      metaScope: () => this.scopeCache,
      resolveMetaScope: async () => this.scope(),
      // First turn of a new chat: the scope and the registry metas are not loaded yet; without them the model reads as "no tools".
      loadMetas: async () => { const sc = await this.scope(); await refreshExtra(sc); await registryFor(sc, await teamFor(sc)).models(); },
      // Confirm line for generation (settings row `gen_confirm_usd`, default 1.00): a prompt, not a cap.
      genConfirmUsd: () => loadConfirmUsd(env.DB),
      // Auto model SHADOW mode (settings row `auto_shadow:<scope>`, default off): records the route per turn, never changes the model.
      autoShadow: async () => loadAutoShadow(env.DB, await this.scope()),
      // Auto-delegate (settings row `auto_delegate:<scope>`, default off): adds the "delegate by yourself" paragraph to the system prompt.
      autoDelegate: async () => loadAutoDelegate(env.DB, await this.scope()),
      // "Limit answer length" (settings row `answer_limit:<base>`; main/e2e default off = no limit, a team user default): read once per turn.
      answerLimit: async () => {
        const sc = await this.scope();
        const gb = baseOf(sc);
        return loadAnswerLimit(env.DB, gb, isGuestScope(gb));
      },
      // Open live-data cue nudge (settings row `open_force_tool_cues`, default ON, '0' off): first call of a cue turn requires a tool call. See src/live-cues.ts.
      forceToolCues: () => loadForceToolCues(env.DB),
      // Turn diagnostics (settings row `debug_turns:<base>` = '1', default off): one DBGTURN console line per model call.
      debugTurns: async () => loadDebugTurns(env.DB, baseOf(await this.scope())),
      // Is the default model a plausible fallback for this scope? Only the gateway scopes (main, e2e); a team scope has its own list, so no guess.
      autoDefaultPlausible: async () => { const sc = await this.scope(); return sc === "main" || isE2eBiz(sc); }, // exact strings: an Open scope is never plausible
      // Auto is a Vertex (Claude) feature: hidden in Open, and a stray "auto" model there is refused instead of routed.
      autoAllowed: async () => spaceOf(await this.scope()) === "biz",
      openSpace: async () => spaceOf(await this.scope()) === "open",
      autoMaxUsd: async () => (await loadAutoMaxUsd(env.DB, await this.scope())) ?? AUTO_MAX_USD_DEFAULT,
      autoCandidates: async () => (await provider.listModels("chat")).map((m) => ({ id: m.id, meta: metaOf(this.scopeCache, m.id) ?? null, kind: m.kind })),
      // Open failover (src/failover.ts): the engine only uses it in an Open conversation. Toggle `open_failover:<scope>` (default ON), breaker per scope (in this isolate).
      failover: {
        // (the scope is cached by the time enabled() has run; before that no breaker call happens)
        enabled: async () => loadOpenFailover(env.DB, await this.scope()),
        candidates: async () => { const sc = await this.scope(); return buildCandidates(await provider.listModels("chat"), catalogLd.value, (p) => userKeysOf(sc).ids.has(p), (p) => descriptorOf(p)?.dataUseNotice, { aistudioAllowed: await loadOpenFailoverAistudio(env.DB, sc), broken: brokenLd.value }); },
        breaker: () => health(), // D1-backed (migration 0033), shared across isolates via a ~10 s cached read
        refresh: () => health().refresh(),
      },
      index: d1Index(env.DB, () => this.scope(), env),
      tools,
      // Approval modes (src/approval.ts, src/grants.ts): grants, Auto, audit. Every lookup reads D1 fresh per batch and fails closed (the card stays).
      approvals: {
        autoOn: async () => { const sc = await this.scope(); return approvalAutoOn(env.DB, baseOf(sc)); },
        userHosts: async () => userHosts(env.DB, await this.scope()),
        audit: async (e) => writeAudit(env.DB, await this.scope(), e),
        saveUserGrant: async (tool, host) => addGrant(env.DB, await this.scope(), tool, host),
        noRedirect: (url, host) => noRedirect(url, host, fetch, AbortSignal.timeout(5000)),
        scheduleExpiry: (at) => { void this.ctx.storage.getAlarm().then((cur) => (cur === null || cur > at ? this.ctx.storage.setAlarm(at) : undefined)).catch(() => {}); },
      },
      // A team user (g:<uid>) has no personal connector: their system prompt must not describe one.
      personalTools: async () => {
        const sc = await this.scope();
        const gb = baseOf(sc);
        return !isGuestScope(gb);
      },
      // Skill templates are looked up in this conversation's own data scope (fail closed: an unresolvable scope throws -> plain message).
      skills: async (name) => skillTemplate(env.DB, await this.scope(), name),
      personaExists: async (name) => !!(await getPersona(env.DB, await this.scope(), name)),
      // Profile instructions: scope main only (promptInstructions returns null for every other scope; an unresolvable scope throws).
      instructions: async () => promptInstructions(env.DB, await this.scope()),
      project: async () => projectInstructions(env.DB, await this.scope(), this.engine.convId),
      files: env.FILES ? r2Store(env.FILES) : null,
      // Push only when nobody is watching: no live client socket on this conversation. (Cloud task end can call the same hook.)
      onTurnEnd: (n) => {
        this.lastTurnEnd = Date.now();
        // A device chat belongs to ONE user, but notifications are stored and pushed per SCOPE: its answer preview would reach every other user of the scope. Silenced until owner-level targeting exists; the in-app turn state is unaffected.
        if (this.devEnv()) return;
        const watched = this.ctx.getWebSockets().length > 0;
        const t = notifyText(n.status, n.title, n.preview, n.media);
        // Every notification is stored for the history page (also the e2e user's, which never pushes); a watching socket also gets it live as a toast.
        const stored = this.scope().then(async (sc) => {
          const row = await recordNotification(env.DB, sc, { kind: "turn", ...t, url: `/c/${n.conversationId}` });
          if (row && watched) this.broadcast({ t: "notif", n: row });
          return sc;
        });
        if (watched) { this.ctx.waitUntil(stored.catch(() => {})); return; }
        // Push goes only to the conversation owner's own subscriptions; never to Erich's phone for the e2e test user.
        this.ctx.waitUntil(stored.then((sc) => isE2eBiz(sc) ? { failed: 0, errors: [] as string[] } : pushTo(env, sc, { ...t, url: `/c/${n.conversationId}`, tag: n.conversationId })).then((r) => { if (r.failed || r.errors.length) console.error("push", r.errors.join("; ")); }).catch((e) => console.error("push skipped", String(e))));
      },
      sink: { broadcast: (seq, ts, e) => this.broadcast({ t: "ev", seq, ts, e }) },
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    void ctx.blockConcurrencyWhile(async () => {
      await this.engine.init();
      try { const sc = await this.scope(); catalogLd.set(await loadCatalog(env.DB)); extraCfg.set(await loadProviderConfigs(env.DB, baseOf(sc), catalogLd.value)); keyIds.set(await userKeyIds(env.DB, baseOf(sc))); featOn.set(await featuresOf(env.DB, baseOf(sc))); brokenLd.set(await loadUserBroken(env.DB, baseOf(sc))); routerFor(sc); } catch { /* unscoped / no configs: built-in list only */ }
    });
  }

  /** This conversation's pinned connector switches: read from D1 on first use, then fixed for the conversation's life. */
  private pinnedSettings(scope: Scope): Promise<ConnectorSettings> {
    return pinSettings({ get: () => this.engine.meta("connectors"), set: (v) => this.engine.setMeta("connectors", v) }, () => loadSettings(this.env.DB, scope));
  }

  /** ToolHost.list() minus schemas, grouped by MCP server (one server today). Unclassified tools never reach list(); list_agents stays hidden. */
  private rawTools: ToolHost | null = null;
  /** `scope` = the caller's scope handed over by the Worker (catalog DO, no conversation row); null = resolve from this conversation (fail closed). */
  private async slashTools(scope: Scope | null) {
    const host = hostForScope(scope, this.rawTools);
    // Catalog (no conversation): the CURRENT switches, i.e. what a NEW chat would get. A conversation (scope null) uses its pinned set via engine.listTools.
    const defs = await (scope === null ? this.engine.listTools() : host ? loadSettings(this.env.DB, scope).then((s) => filterHost(host, s).list()) : Promise.resolve([])).catch(() => []);
    const all = scope !== null && cfToolsAllowed(scope) ? [...defs, ...cfToolDefs(cfToolFlags({ browser: this.env.BROWSER ?? null, linkable: linkableEnv(this.env), image: this.env.AI ?? null, nvidia: true } /* the Open host always wires NVIDIA FLUX */))] : defs; // Open: the read-only Cloudflare list (a conversation's own list already includes them)
    return all.map((t) => ({ name: t.name, description: t.description, group: t.name.includes("__") ? t.name.split("__")[0]! : CF_TOOL_NAMES.has(t.name) && scope !== null && cfToolsAllowed(scope) ? "cloudflare" : "personal-connector", approval: t.approval }));
  }

  // ---- device environment (Devices v2 step 3). `env` meta = {device_id, dir, user}: set once by the Worker at creation (POST /env) after it checked the device is the creator's own live device. ----
  private devEnv(): { device_id: string; dir: string | null; user: string } | null {
    try { const v = JSON.parse(this.engine.meta("env") ?? "null") as { device_id?: unknown; dir?: unknown; user?: unknown } | null; return v && typeof v.device_id === "string" && typeof v.user === "string" ? { device_id: v.device_id, dir: typeof v.dir === "string" ? v.dir : null, user: v.user } : null; } catch { return null; }
  }
  /** Bumped by every user Stop on the socket: a send that began before it (and is still awaiting the environment guard) is dropped. */
  private stopEpoch = 0;
  /** Before ANY executable dispatch (send / generate / retry / resume / device turn): the authoritative D1 row must agree with this chat's DO pin. A device row with a missing or different pin (failed pin + failed cleanup, a half-created chat)
   *  is an incomplete environment: the chat refuses and nothing is stored, forwarded or run, in particular never on the cloud engine. A cloud row / no row = nothing to compare. A D1 error fails closed. Migration tolerant: SELECT * (no env columns = no device chat can exist). */
  private async envSetupIncomplete(): Promise<boolean> {
    const conv = this.engine.convId; if (!conv || !this.env.DB) return false;
    let row: Record<string, unknown> | null;
    try { row = await this.env.DB.prepare(`SELECT * FROM conversations WHERE id=?`).bind(conv).first<Record<string, unknown>>(); }
    catch (e) { console.error("env guard read", e instanceof Error ? e.message : String(e)); return true; }
    if (!row || row.env_kind !== "device") return false;
    const de = this.devEnv();
    return !de || de.device_id !== row.env_device_id || de.user !== row.env_user || (de.dir ?? null) !== ((row.env_dir as string | null | undefined) ?? null);
  }
  /** The bridge to this chat's device hub. Every call re-derives trust from D1 (flag, device row: same scope + same user + not revoked) and from the pinned owner headers the hub checks again; no device token is ever read or sent. */
  private deviceIO(de: { device_id: string; dir: string | null; user: string }): DeviceIO {
    const hub = async (path: string, init: RequestInit = {}) => {
      if (!this.env.DEVICES) throw new Error("no DEVICES binding");
      const sc = await this.scope();
      return this.env.DEVICES.get(this.env.DEVICES.idFromName(de.device_id)).fetch(new Request(`https://do.internal${path}`, { ...init, headers: { "x-vcl-device": de.device_id, "x-vcl-scope": sc, "x-vcl-user": de.user, ...(init.body ? { "content-type": "application/json" } : {}) } }));
    };
    const post = (path: string, body: unknown) => hub(path, { method: "POST", body: JSON.stringify(body) });
    return {
      check: async () => {
        try {
          const sc = await this.scope();
          if (!this.env.DEVICES || !(await vclEnvEnabled(this.env.DB, sc))) return { ok: false as const, error: "Devices are turned off for this account." };
          const row = await this.env.DB.prepare(`SELECT name FROM devices WHERE id=? AND scope=? AND user=? AND revoked_at IS NULL`).bind(de.device_id, sc, de.user).first<{ name: string }>();
          return row ? { ok: true as const, name: row.name, dir: de.dir } : { ok: false as const, error: "This device is no longer available (revoked or removed)." };
        } catch (e) { console.error("device check", e instanceof Error ? e.message : String(e)); return { ok: false as const, error: "Could not check this device. Try again." }; }
      },
      cmd: async (c) => {
        try {
          const r = await post("/bridge/cmd", { conv: this.engine.convId, ...c });
          const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; since?: number; queued?: boolean; dup?: boolean } | null;
          if (r.ok && j?.ok && typeof j.since === "number") return { ok: true as const, since: j.since, queued: !!j.queued, dup: !!j.dup };
          return { ok: false as const, error: j?.error ?? `hub ${r.status}`, ...(r.status === 409 && j?.error === "not_your_session" ? { notYourSession: true } : {}) };
        } catch { return { ok: false as const, error: "unavailable" }; }
      },
      poll: async (since, waitMs, signal) => {
        try {
          const r = await hub(`/bridge/events?since=${since}&wait=${waitMs}&conv=${encodeURIComponent(this.engine.convId)}`, { signal });
          if (r.status === 410 || r.status === 404) return { ok: false as const, error: "revoked" as const };
          if (!r.ok) return { ok: false as const, error: "unavailable" as const };
          const j = (await r.json()) as { events: Array<{ seq: number; ts: number; e: Record<string, unknown> }>; online: boolean; gap: boolean; mine?: boolean };
          return { ok: true as const, events: j.events, online: j.online, gap: j.gap, ...(typeof j.mine === "boolean" ? { mine: j.mine } : {}) };
        } catch (e) { return signal.aborted || (e instanceof Error && e.name === "AbortError") ? { ok: false as const, error: "aborted" as const } : { ok: false as const, error: "unavailable" as const }; }
      },
      approve: async (rid, allow) => {
        try {
          const r = await post("/bridge/approval", { rid, allow, conv: this.engine.convId });
          const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          return r.ok && j?.ok ? { ok: true as const } : { ok: false as const, error: j?.error === "expired" ? "This approval expired; ask again." : j?.error === "already_resolved" ? "That approval was already answered." : "Could not deliver the answer to the device." };
        } catch { return { ok: false as const, error: "Could not deliver the answer to the device." }; }
      },
    };
  }

  private broadcast(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch { /* closed */ } }
  }

  private lastTurnEnd: number | null = null; // in-memory (diagnostics only; null after hibernation/eviction)
  private colo: string | null = null; // edge colo of the last /ws upgrade
  private diag(ev: "ws_close" | "ws_error", extra: { code?: number; reason?: string; wasClean?: boolean }) {
    try { console.log(wsDiagLine({ ev, conv: this.engine.convId, ...extra, colo: this.colo, lastTurnEnd: this.lastTurnEnd, turnActive: this.engine.running, now: Date.now(), sockets: this.ctx.getWebSockets().length })); } catch { /* diagnostics must never throw */ }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const conv = req.headers.get("x-conv-id");
    if (conv) this.engine.setConvId(conv);
    if (url.pathname === "/tools") return Response.json({ tools: await this.slashTools(headerScope(req.headers)) });
    if (url.pathname === "/connector-tools") { // Settings → Connectors: the scope-visible list BEFORE the switches, plus reachability
      const scope = headerScope(req.headers); const host = hostForScope(scope, this.rawTools);
      if (!scope || !host) return Response.json({ tools: [], error: "connector not configured" });
      try { return Response.json({ tools: await host.list() }); } catch (e) { return Response.json({ tools: [], error: String(e instanceof Error ? e.message : e) }); }
    }
    if (url.pathname === "/state") {
      const st = this.engine.state();
      let approvalAuto = false; try { const sc = await this.scope(); approvalAuto = await approvalAutoOn(this.env.DB, baseOf(sc)); } catch { /* fail closed: no chip */ }
      return Response.json({ ...st, approvalAuto });
    }
    if (url.pathname === "/env" && req.method === "POST") { // Worker only: bind this (new, empty) chat to the creator's device. Once; never changed afterwards (switching environment = a new chat in step 4).
      const b = (await req.json().catch(() => null)) as { device_id?: unknown; dir?: unknown; user?: unknown } | null;
      if (!b || typeof b.device_id !== "string" || !/^[0-9a-f]{32}$/.test(b.device_id) || typeof b.user !== "string" || !b.user || (b.dir !== null && b.dir !== undefined && typeof b.dir !== "string")) return Response.json({ error: "bad env" }, { status: 400 });
      if (this.engine.meta("env") !== null || this.engine.messages().length) return Response.json({ error: "conversation not empty" }, { status: 409 });
      this.engine.setMeta("env", JSON.stringify({ device_id: b.device_id, dir: typeof b.dir === "string" ? b.dir : null, user: b.user }));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/seed" && req.method === "POST") {
      const b = (await req.json().catch(() => null)) as { model?: string; title?: string; tainted?: boolean; messages?: Array<{ role: "user" | "assistant"; content: any[]; model?: string | null }> } | null;
      if (!b || !Array.isArray(b.messages)) return Response.json({ error: "bad seed" }, { status: 400 });
      return this.engine.seedHistory(String(b.model ?? ""), String(b.title ?? ""), b.messages, b.tainted === true) ? Response.json({ ok: true }) : Response.json({ error: "conversation not empty" }, { status: 409 });
    }
    if (url.pathname === "/destroy" && req.method === "POST") {
      // R2 first, inside the DO (serialized with generation: stop a running one so it cannot write after the sweep). On failure nothing else
      // is touched: transcript and D1 row stay readable and the delete can simply be retried.
      if (this.engine.running) {
        this.engine.stop();
        // Wait (bounded) for the aborted turn to finish so it cannot write to R2/storage after the sweep.
        for (let i = 0; i < 100 && this.engine.running; i++) await new Promise((r) => setTimeout(r, 100));
        if (this.engine.running) return Response.json({ error: "generation still stopping, retry delete" }, { status: 409 });
      }
      { // devv2s3r: a deleted device chat releases its device session through the hub's cleanup path (stop, cancel undelivered work, expire approvals). Best effort: the hub's own expiry frees the device otherwise.
        const de = this.devEnv();
        if (de && this.env.DEVICES) { try { const sc = await this.scope(); await this.env.DEVICES.get(this.env.DEVICES.idFromName(de.device_id)).fetch(new Request("https://do.internal/bridge/release", { method: "POST", headers: { "x-vcl-device": de.device_id, "x-vcl-scope": sc, "x-vcl-user": de.user, "content-type": "application/json" }, body: JSON.stringify({ conv: this.engine.convId }) })); } catch { /* */ } }
      }
      const res = await destroyOrdered(this.env.FILES, conv, async () => { await this.ctx.storage.deleteAll(); });
      if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
      for (const w of this.ctx.getWebSockets()) try { w.close(1000, "deleted"); } catch {} return Response.json({ ok: true }); }
    if (url.pathname === "/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      this.colo = String((req as any).cf?.colo ?? "") || null;
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      const e = this.engine;
      const replay = e.canReplayFrom(since);
      pair[1].send(JSON.stringify({ t: "hello", seq: e.lastSeq(), minSeq: e.minSeq(), running: e.running, now: Date.now(), resync: !replay }));
      if (replay) for (const ev of e.eventsSince(since)) pair[1].send(JSON.stringify({ t: "ev", seq: ev.seq, ts: ev.ts, e: ev.e }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  // A turn must outlive the socket that asked for it (phone locks, tab closes): a handler running inside
  // webSocketMessage is cancelled when that socket drops, killing the turn mid-stream (observed live). So the socket
  // only records the command and arms an alarm; the alarm handler runs the turn to completion on its own.
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let m: GenCommand & { t?: string; text?: string; model?: string; files?: any[]; id?: string; decision?: string; grant?: string; mode?: string; confirmed?: unknown; confirmVersion?: unknown; host?: string; slash?: { kind?: unknown; name?: unknown }; override?: unknown };
    try { m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const reply = (o: unknown) => { try { ws.send(JSON.stringify(o)); } catch {} };
    const e = this.engine;
    if (m.t === "stop") { this.stopEpoch++; e.stop(); return; }
    const epoch = this.stopEpoch;   // captured BEFORE any await below: a Stop that lands while the environment guard awaits D1 cancels THIS send (and only it)
    if ((m.t === "send" || m.t === "generate" || m.t === "retry" || m.t === "approve") && (await this.envSetupIncomplete())) return reply({ t: "rejected", error: "Environment setup incomplete." });
    const de = this.devEnv();
    if ((m.t === "send" || m.t === "retry" || m.t === "generate" || m.t === "approve") && epoch !== this.stopEpoch) return reply({ t: "rejected", error: "Stopped before it started.", code: "stopped" });   // answered, never silent: the client's send-wait ends on a frame // a Stop that landed while the guard awaited cancels THIS command (send/retry/generate/approve all pass the guard above), device or cloud alike (a later one is new)
    if (de && (m.t === "generate" || m.t === "retry")) return reply({ t: "rejected", error: "This chat runs on a device. Image/video generation and retry are not available here yet." });
    if (de && m.t === "send") { // a device chat NEVER falls back to the model: it either runs on its device or is refused
      if (Array.isArray(m.files) && m.files.length) return reply({ t: "rejected", error: "Attachments are not supported in device chats yet." });
      const err = e.precheck(String(m.text ?? ""));
      if (err) return reply({ t: "rejected", error: err });
      e.setMeta("pending", JSON.stringify({ cmd: "device", text: String(m.text ?? "") }));
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    if (de && m.t === "approve") { // device approval cards: answered through the hub, never through the engine's own tool approvals
      const r = e.deviceDecide(String(m.id ?? ""), m.decision === "approve" ? "approve" : "deny");
      if (!r.ok) return reply({ t: "rejected", error: r.error });
      const a = await this.deviceIO(de).approve(r.rid, m.decision === "approve");
      if (!a.ok) { e.deviceUndecide(String(m.id ?? "")); reply({ t: "rejected", error: a.error }); }
      return;
    }
    if (m.t === "send") {
      const files = Array.isArray(m.files) ? m.files : [];
      const err = e.precheck(String(m.text ?? ""), m.model, files, m.override);
      if (err) return reply({ t: "rejected", error: err });
      // "Retry with…": a one-message model/effort override (never stored as the conversation's model). A malformed one is rejected, not ignored.
      const override = m.override === undefined || m.override === null ? null : parseOverride(m.override);
      if (m.override != null && !override) return reply({ t: "rejected", error: "bad override" });
      e.setMeta("pending", JSON.stringify({ cmd: "send", text: String(m.text ?? ""), model: m.model, files, ...(override ? { override } : {}), slash: m.slash && typeof m.slash === "object" ? { kind: m.slash.kind, name: m.slash.name } : undefined }));
      await this.ctx.storage.setAlarm(Date.now());
    } else if (m.t === "generate") {
      // Server-side gate: validation AND the >$1 / unknown-price confirmation are enforced here, not by the client modal.
      const p = await e.genPlan(m);
      if (!p.ok) return reply({ t: "rejected", error: p.reject.error, code: p.reject.code, ...(p.reject.est_usd !== undefined ? { est_usd: p.reject.est_usd } : {}) });
      e.setMeta("pending", JSON.stringify({ cmd: "generate", gen: { kind: m.kind, prompt: m.prompt, model: m.model, n: m.n, aspect_ratio: m.aspect_ratio, files: m.files, confirmed: m.confirmed, est_usd: m.est_usd,
        duration_seconds: m.duration_seconds, resolution: m.resolution } }));
      await this.ctx.storage.setAlarm(Date.now());
    } else if (m.t === "approve") {
      const r = e.decide(String(m.id ?? ""), m.decision === "approve" ? "approve" : "deny", m.grant === "chat" || m.grant === "user" ? m.grant : "once");
      if (!r.ok) return reply({ t: "rejected", error: r.error });
      if (r.userGrant) { // "Always allow this domain": the host came from the parked call itself; a failed save leaves the approve-once and says so
        const saved = await addGrant(this.env.DB, await this.scope(), r.userGrant.tool, r.userGrant.host).catch(() => false);
        if (!saved) reply({ t: "rejected", error: "Could not save the permanent allowance. This one call is still approved." });
      }
      if (r.ready) { e.setMeta("pending", JSON.stringify({ cmd: "resume" })); await this.ctx.storage.setAlarm(Date.now()); }
    } else if (m.t === "mode") { // composer chip Ask / Auto: a user socket command only; Auto is refused when the admin switch is off
      const mode = m.mode === "auto" ? "auto" : m.mode === "bypass" ? "bypass" : m.mode === "ask" ? "ask" : null;
      if (!mode) return reply({ t: "rejected", error: "bad mode" });
      if (mode !== "ask" && !(await approvalAutoOn(this.env.DB, baseOf(await this.scope())))) return reply({ t: "rejected", error: `${mode === "bypass" ? "Bypass" : "Auto"} approval is turned off for this account.` });
      // Bypass needs an explicit confirmation IN the command (the dialog is client-side, so the server cannot trust that it was shown): confirmed:true + the current text version.
      if (mode === "bypass" && e.approvalMode() !== "bypass") {
        if (m.confirmed !== true || m.confirmVersion !== BYPASS_CONFIRM_VERSION) return reply({ t: "rejected", error: "Bypass needs an explicit confirmation. Pick Bypass again and confirm the dialog." });
        if (e.running || e.meta("pending")) return reply({ t: "rejected", error: "busy" });
        try { await recordBypassConfirm(this.env.DB, await this.scope(), e.convId, BYPASS_CONFIRM_VERSION); } // fail closed: no record of who/when/chat, no Bypass
        catch (err) { console.error("bypass confirm record", err instanceof Error ? err.message : String(err)); return reply({ t: "rejected", error: "Could not record the Bypass confirmation. Bypass stays off." }); }
      }
      const r = e.setApprovalMode(mode);
      if (!r.ok) return reply({ t: "rejected", error: r.error });
    } else if (m.t === "revoke_grant") { // chip popover: drop one chat-level host grant
      if (typeof m.host === "string") e.revokeChatGrant(m.host.toLowerCase());
    } else if (m.t === "retry") {
      if (e.running || e.meta("pending")) return reply({ t: "rejected", error: "busy" });
      e.setMeta("pending", JSON.stringify({ cmd: "retry" }));
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  async alarm() {
    const e = this.engine;
    const raw = e.meta("pending");
    if (!raw) { // the expiry wake-up: close a parked approval whose 30 minutes ran out (and re-arm if it is still waiting for a later moment)
      if (!e.sweepExpired()) { const at = e.awaitingExpiresAt(); if (at !== null && at > Date.now()) await this.ctx.storage.setAlarm(at + 1000); }
      return;
    }
    // `pending` stays set across the guard's D1 await: a Stop that arrives meanwhile sees pending work and is remembered (stop_pending), so the dispatch below produces nothing. Cleared immediately before the executor (synchronously), or on rejection.
    if (await this.envSetupIncomplete()) { e.setMeta("pending", null); e.setMeta("stop_pending", null); this.broadcast({ t: "rejected", error: "Environment setup incomplete." }); return; } // the alarm path re-checks: nothing queued earlier can reach an executor of the wrong kind
    e.setMeta("pending", null);
    const dev = this.devEnv();
    if (dev || JSON.parse(raw).cmd === "device") { // device chat: only the device path exists; a device command on a chat without an env (or the reverse) is refused, never run on the other executor
      const pd = JSON.parse(raw) as { cmd: string; text?: string };
      if (!dev || pd.cmd !== "device") { this.broadcast({ t: "rejected", error: "This chat runs on a device." }); return; }
      const r = await runDeviceTurn(e, this.deviceIO(dev), pd.text ?? "");
      e.setMeta("stop_pending", null);
      if (!r.ok) this.broadcast({ t: "rejected", error: r.error });
      return;
    }
    const p = JSON.parse(raw) as { cmd: string; text?: string; model?: string; files?: any[]; slash?: { kind?: unknown; name?: unknown }; override?: unknown; gen?: GenCommand };
    const r = p.cmd === "generate" ? await e.generate(p.gen ?? {}) : p.cmd === "retry" ? await e.retry() : p.cmd === "resume" ? await e.resume() : await e.send(p.text ?? "", p.model, p.files ?? [], p.slash, parseOverride(p.override));
    e.setMeta("stop_pending", null); // a queued stop applies to the turn it was sent for only
    if (!r.ok) this.broadcast({ t: "rejected", error: r.error });
  }
  webSocketClose(ws: WebSocket, code: number, reason?: string, wasClean?: boolean) {
    this.diag("ws_close", { code, reason: reason ?? "", wasClean });
    try { ws.close(code, "bye"); } catch {}
  }
  webSocketError(_ws?: WebSocket, err?: unknown) { this.diag("ws_error", { reason: String((err as any)?.message ?? err ?? "") }); }
}
export type { ServerEvent };
