/**
 * vertex-client — Worker serving the PWA (Workers Static Assets) plus /api/* and /auth/* (run worker-first).
 * Secrets (wrangler secret put / secret-run; never in this file):
 *   SESSION_SECRET, GATEWAY_KEY (caller `vertex-client`), GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET (OAuth app)
 */
import { watchRuns } from "./cloud-watch";
import { Hono, type Context } from "hono";
import {
  type AuthEnv, authenticate, clearSessionCookie, githubCallback, githubLoginRedirect, loginMethods, loginRoute, ssoExchange, ssoLogoutUrl,
} from "./auth";
import { withSecurityHeaders } from "./headers";
import { apiGate } from "./gate";
import { adminFeatureRoutes } from "./admin-features";
import { adminHealthRoutes } from "./admin-health";
import { DEFAULT_MODEL, MODELS_META, sortModels } from "./models-meta";
import { gatewayProvider } from "./providers/gateway";
import { ProviderError, type ModelProvider, type ProviderModel } from "./providers/types";
import { buildRegistry } from "./providers/registry";
import { descriptorOf } from "./providers/descriptor";
import { loadProviderConfigs } from "./providers/config";
import { loadCatalog } from "./providers/catalog";
import { d1Sink, loadSpeedStats } from "./latency";
import { decorateModels, defaultModelId } from "./models-api";
import { healthOf } from "./provider-health";
import { FAILOVER_AI_STUDIO } from "./failover";
import { loadUserBroken, markBroken, providerWriteRoutes } from "./provider-routes";
import { cfAccountRoutes } from "./cf-routes";
import { approvalAutoOn, approvalRoutes, purgeAudit } from "./grants";
import { featureOn, featuresOf } from "./features";
import { answerLimitDefault, isAnswerLimit } from "./output-budget";
import { ftsQuery, loadE2eRealProviders, loadAutoDelegate, loadAutoMaxUsd, loadAutoShadow, loadConfirmUsd, loadOpenFailover, loadOpenFailoverAistudio, saveOpenFailover, saveOpenFailoverAistudio, saveAutoDelegate, loadAnswerLimit, saveAnswerLimit, saveAutoMaxUsd, saveAutoShadow } from "./index-d1";
import { estimate } from "./gen-cost";
import { stubImageModels } from "./providers/stub-image";
import { loadChatImages, saveChatImages } from "./image-tool";
import { stubVideoModels } from "./providers/stub-video";
import { rangeResponse } from "./range";
import { validEndpoint, pushTo } from "./push";
import { usageReport } from "./usage";
import { devLogin, devLoginCheck, devLoginEnabled } from "./auth-dev";
import { appAuthRoutes } from "./auth-app";
import { e2eLogin, E2E_TOOLS, DATA_SCOPE_HEADER } from "./auth-e2e";
import { resolveSpace, spacesFor } from "./open-space";
import { MAIN_SCOPE, isE2eBiz, baseOf, isE2eOpen, guardPersonal, guardPrefix, isGuestScope, isMainBase, mayUseErichOnlyModes, mayUseErichOnlyModesIn, mayUseSemantic, providerFor, scopeOfSession, spaceOf, withSpace, type Scope, type Space } from "./scope";
import { teamCallback, teamLoginEnabled, teamLoginRedirect, type TeamAuthEnv } from "./team-auth";
import { teamConfigured, teamGatewayProvider, requireFeature, FEATURE_APP } from "./providers/team-gateway";
import { versionReply } from "./version";
import { CONNECTOR_ID, applyPatch, connectorView, loadSettings, saveSettings } from "./connectors";
import { MAX_CUSTOM, MODES, clientFor, deleteCustom, encryptToken, fetchStoredTools, getCustom, listCustom, effectiveModes, listForSettings, loadState, saveState, toolHash, scrub, setStatus, slugOf, validateNew, type CustomRow, type Mode } from "./custom-connectors";
import { slashItems, type SlashItem, type SlashTool } from "./slash";
import { getProfile, putProfile, validateProfile } from "./profile";
import { libraryPage, parseCursor } from "./library";
import { withDevVisibility } from "./dev-visibility";
import { listNotifications, markRead, parseNotifCursor, parseReadBody } from "./notifications";
import { MAX_PROMPTS, createPrompt, deletePrompt, listPrompts, updatePrompt, validatePrompt } from "./prompts";
import { archiveProject, assignConversation, createProject, getProject, listProjects, updateProject, validateProject, MAX_PROJECTS } from "./projects";
import { createSkill, deleteSkill, listSkills, slashSkills, updateSkill } from "./skills";
import { createPersona, deletePersona, listPersonas, updatePersona } from "./personas";
import { cloudRoutes, repoList } from "./cloud";
import { envBody } from "./device-env";
import { bindDeviceEnv, envView } from "./conv-env";
import { agentRoutes, watchAgents } from "./agents";
import { desktopRoutes, watchDesktop } from "./desktop";
import { forkPrefix, forkTitle } from "./fork";
import { remoteRoutes } from "./remote";
import { devicesRoutes } from "./devices";
import { bridgeLlmRoutes } from "./bridge-llm";
import { transcribeRoutes } from "./transcribe";
import { backfillCron, backfillSlice, backfillState, deleteConversationVectors, semanticMatches, semEnabled, semReady, snippetFor, sweepVectorTombstones } from "./semantic";
import { artifactFrameRoute, artifactRoutes, sweepDeleted } from "./artifacts";
import { checkUpload, classifyFile, fileKey, cleanName, refBelongsTo, sidecarKey, MAX_FILE_BYTES, FILE_PREFIX, GEN_VIDEO_MIMES } from "./files";
import { ExtractError, approxTokens, decodeText, extractOffice, officeKindOf, textForModel } from "./extract";
import { isModelIdSyntax } from "./model-id";
import { featureFlags, featuresEffective } from "./feature-registry";
import { userKeyIds, userKeysFor } from "./user-keys";

/** Typed message of the 503 a Vertex request gets when the GATEWAY binding is absent (self-host). */
export const GATEWAY_ABSENT = "Vertex models are not configured on this deployment";

export interface Env extends AuthEnv, Omit<TeamAuthEnv, keyof AuthEnv | "DB"> {
  ASSETS: Fetcher;
  /** Vertex gateway service binding. Absent (self-host) = no Vertex models: they are not listed and a Vertex request fails with a typed 503. */
  GATEWAY?: Fetcher;
  DB: D1Database;
  CHAT: DurableObjectNamespace;
  /** VCL device bridge (src/devices.ts): DeviceHub Durable Object namespace. Absent = every device route answers 404. Also needs the settings row `vcl:<base>`='1'. */
  DEVICES?: DurableObjectNamespace;
  GATEWAY_KEY?: string;
  CONNECTOR?: Fetcher;
  FILES?: R2Bucket;
  /** Bearer for personal-connector /internal/mcp (caller `vertex-client`). Absent = no tools. */
  CONNECTOR_TOKEN?: string;
  /** Web Push: public key is a var; private scalar is the secret VAPID_PRIVATE_KEY. Absent = push disabled. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Cloud mode: service binding to agent-spike + its INTERNAL_SECRET (Worker secret) + comma list of allowed owner/repo. Absent = Cloud off. */
  AGENT?: Fetcher;
  AGENT_INTERNAL_SECRET?: string;
  CLOUD_REPOS?: string;
  /** Remote mode: service binding to remote-hub (RemoteHubRpc entrypoint). Absent = Remote off. Read-only. */
  REMOTE?: unknown;
  /** Workers version_metadata binding (wrangler.jsonc): id of the deployed Worker version. Absent in tests / dev. */
  /** Workers AI binding (wrangler `ai`): Whisper transcription for the composer mic. Absent = POST /api/transcribe answers 503 and the client falls back to SpeechRecognition. */
  /** Spaces: `on` = Open for every user, `off` = nobody, absent/`per-user` = main yes, team users yes unless a settings row `open_space:<base>`=0 (kill switch); D1 error = off (fail closed). */
  OPEN_SPACE?: string;
  /** Encrypts provider keys entered in Settings > Providers (AES-256-GCM via HKDF). Absent = the app cannot store keys (PUT answers 409); Worker secrets still work. */
  KEY_ENC_SECRET?: string;
  /** Browser Rendering binding (wrangler `browser`): Open-space web_read/web_screenshot/web_links. Absent = those tools are not offered. */
  BROWSER?: import("./cf-tools").BrowserBinding;
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  /** Vectorize index `vclient-chats` (wrangler `vectorize`): semantic chat search (src/semantic.ts). Absent = keyword (FTS) search only, nothing else changes. */
  VECTORIZE?: import("./semantic").VectorizeLike;
  /** Worker Loader binding (wrangler `worker_loaders`): the run_js sandbox. Absent = run_js is not offered. */
  LOADER?: import("./run-js").WorkerLoaderLike;
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
}

type Vars = { session: import("./auth").Session; space?: Space };
type App = { Bindings: Env; Variables: Vars };

// Injectable for tests.
// `scopeOf` is a TEST-ONLY seam (lets the isolation suite run a fake g:* tenant); production (server/worker.ts, the default export) never passes it,
// and no route, header or cookie can set it.
export type Deps = { provider?: (env: Env) => ModelProvider; /** test seam: the act-as provider of a team session (default: teamGatewayProvider) */ teamProvider?: (env: Env, email: string) => ModelProvider; fetchImpl?: typeof fetch; gate?: boolean; scopeOf?: (s: import("./auth").Session) => Scope };

export function createApp(deps: Deps = {}) {
  const app = new Hono<App>();
  const provider = deps.provider ?? ((env: Env) => { if (!env.GATEWAY) throw new ProviderError(GATEWAY_ABSENT, 503, { type: "api_error" }); return gatewayProvider(env.GATEWAY, env.GATEWAY_KEY ?? ""); });
  const noStore = { "cache-control": "no-store" };

  // ---- public auth surface ----
  app.get("/auth/login", (c) => loginRoute(c.req.raw, c.env));
  app.get("/auth/github", (c) => githubLoginRedirect(c.req.raw, c.env)); // direct GitHub login, kept as fallback
  app.get("/auth/callback", (c) => githubCallback(c.req.raw, c.env, deps.fetchImpl));
  app.post("/auth/e2e", (c) => e2eLogin(c.req.raw, c.env));
  app.post("/auth/dev-login/check", (c) => devLoginCheck(c.req.raw, c.env));
  app.post("/auth/dev-login", (c) => devLogin(c.req.raw, c.env));
  // Team instance only (TEAM_GATEWAY_URL set); on Erich's instance both routes are 404 and /auth/config reports team:false.
  app.get("/auth/team", (c) => teamLoginRedirect(c.env as TeamAuthEnv));
  app.get("/auth/team/callback", (c) => teamCallback(c.req.raw, c.env as TeamAuthEnv));
  app.get("/auth/config", async (c) => c.json({ github: loginMethods(c.env).github, sso: loginMethods(c.env).sso, ...(teamLoginEnabled(c.env) ? { team: true } : {}), ...((await devLoginEnabled(c.env)) ? { emailStep: true } : {}) }, 200, noStore));

  // ---- everything under /api/* requires a session; mutating calls also need Origin + CSRF ----
  // In production this gate is server/middleware.ts (cf-lite generates it in front of the routes below); `gate: false` = the
  // worker entry supplies it. Tests build the app with the gate included.
  if (deps.gate !== false) app.use("/api/*", apiGate);

  // Team sessions: the gateway stays the authority. Every /api request re-checks vclient_app (cache <= 60 s, fail closed: gateway down => 503, revoked => 403),
  // so a block takes effect within a minute even though the cookie lives up to 7 d. The WS upgrade is an /api request too; generation re-checks per call.
  app.use("/api/*", async (c, next) => {
    const s = c.get("session");
    if (s?.via !== "team") return next();
    try { await requireFeature(c.env, s.u, FEATURE_APP, deps.fetchImpl); }
    catch (e) { const st = e instanceof ProviderError ? e.status : 503; return c.json({ error: st === 403 ? "forbidden" : "team gateway unavailable" }, (st === 403 ? 403 : 503) as 403, noStore); }
    return next();
  });

  app.post("/auth/logout", async (c) => {
    const a = await authenticate(c.req.raw, c.env);
    if ("err" in a) return a.err;
    // The browser must also visit auth /logout, or the shared cookie signs it straight back in.
    return c.json({ ok: true, ssoLogout: c.env.SSO_PUBLIC_KEYS && a.session.via === "github" ? ssoLogoutUrl(c.req.raw, c.env) : null }, 200, { ...noStore, "set-cookie": clearSessionCookie() });
  });

  // Data scope of the caller: Erich's data is 'main'; the E2E bypass user only ever sees/creates 'e2e' rows.
  // The session's Business scope (who), then the space the resolution middleware validated (absent = Business, exactly as before spaces).
  const sessionScope = (c: Context<App>): Scope => (deps.scopeOf ?? scopeOfSession)(c.get("session"));
  const scopeOf = (c: Context<App>): Scope => (c.get("space") === "open" ? (deps.scopeOf ? withSpace(sessionScope(c), "open") : scopeOfSession(c.get("session"), "open")) : sessionScope(c));
  // THE space resolution point: x-vc-space header / ?space= query -> 400 bad value, 403 Open not available to this user, else sets the space for scopeOf.
  app.use("/api/*", resolveSpace(sessionScope, (c, sp) => c.set("space", sp)));
  // Credential by scope: Erich's gateway key serves main and e2e only; any other scope throws "no provider for scope" -> 403 on the model routes.
  // Team session -> the act-as provider (only when configured; and only for a via:"team" session, so the P0 test seam's g:* tenants still get none).
  const teamProviderOf = (c: Context<App>): ModelProvider | null => {
    const s = c.get("session");
    if (s?.via !== "team" || !isGuestScope(baseOf(scopeOf(c))) || spaceOf(scopeOf(c)) !== "biz" || !teamConfigured(c.env)) return null;
    return (deps.teamProvider ?? ((e: Env, email: string) => teamGatewayProvider(e, email, deps.fetchImpl)))(c.env, s.u);
  };
  // Business: the gateway / team provider as before. Open: the Open registry's router (live Open providers only, never the gateway; resolved below).
  const providerOf = async (c: Context<App>): Promise<ModelProvider> => {
    if (spaceOf(scopeOf(c)) === "open") return (await registryOf(c)).router;
    try { return providerFor(scopeOf(c), () => provider(c.env), () => teamProviderOf(c)); } catch (e) { throw e instanceof ProviderError && e.message === GATEWAY_ABSENT ? e : new ProviderError(e instanceof Error ? e.message : "no provider for scope", 403); }
  };
  // Push: each scope sees only its own subscriptions. Closed to the e2e user entirely (it must never reach Erich's phone);
  // /config answers 200 "not configured" for them (the Settings screen probes it on load; a 403 there is a console error).
  app.use("/api/push/*", async (c, next) => {
    if (!isE2eBiz(scopeOf(c))) return next();
    return c.req.path === "/api/push/config" && c.req.method === "GET" ? c.json({ publicKey: null, subscriptions: 0 }) : c.json({ error: "forbidden" }, 403);
  });

  app.get("/api/me", async (c) => {
    const s = c.get("session");
    const spaces = await spacesFor(c.env, sessionScope(c));
    return c.json({ spaces, space: spaceOf(scopeOf(c)), user: s.u, via: s.via, csrf: s.csrf, defaultModel: spaceOf(scopeOf(c)) === "open" ? null : DEFAULT_MODEL, erichOnly: mayUseErichOnlyModesIn(scopeOf(c)), features: featureFlags(await featuresEffective(c.env as never, c.env.DB, scopeOf(c), { user: s.u, ...(s.via === "team" ? { email: s.u } : {}) })), ...(s.via === "team" && s.own !== true ? { team: true } : {}) });
  });

  // Deployed-version facts for the About screen. Same for every scope (build facts, nothing per-user); only ids/timestamps, no secrets.
  app.get("/api/version", async (c) => c.json(await versionReply(c.env), 200, noStore));

  // Provider registry for the caller's scope: the gateway (main/e2e only) plus every enabled provider config that scope may use.
  const registryOf = async (c: Context<App>) => {
    const scope = scopeOf(c);
    const catalog = await loadCatalog(c.env.DB);
    let gw: ModelProvider | null = null;
    try { gw = providerFor(scope, () => provider(c.env)); } catch { gw = null; }
    const open = spaceOf(scope) === "open";
    return buildRegistry({ scope, gateway: gw, ...(c.env.GATEWAY ? {} : { noGateway: true }), team: teamProviderOf(c), extra: open ? await loadProviderConfigs(c.env.DB, baseOf(scope), catalog) : [], catalog, userKeys: open ? userKeysFor(c.env, baseOf(scope), await userKeyIds(c.env.DB, baseOf(scope))) : undefined, ...(isE2eOpen(scope) ? { e2eReal: await loadE2eRealProviders(c.env.DB, baseOf(scope)) } : {}), features: open ? await featuresOf(c.env.DB, baseOf(scope)) : undefined, sharedCf: () => featureOn(c.env.DB, baseOf(scope), "workers-ai"), onBroken: (pid, m) => void markBroken(c.env.DB, pid, m, baseOf(scope)), ...(open ? { userBroken: await loadUserBroken(c.env.DB, baseOf(scope)) } : {}), env: c.env as unknown as Record<string, unknown>, fetchImpl: deps.fetchImpl });
  };

  // Configured providers and their status. Ids, kinds and counts only: never a key, a key binding name or a base URL. Same scopes as the
  // other Erich-only surfaces (main, plus the e2e tester which only ever sees offline stubs); guests are refused. No write route exists:
  // adding a provider (and its credential) is an admin action.
  // Business lists only the Vertex gateway; Open lists the shared provider configs (never the gateway). Guests stay refused in both spaces.
  app.get("/api/providers", async (c) => {
    // main/e2e as before; a team user only inside its own (flag-gated, already validated by resolveSpace) Open space
    if (!mayUseErichOnlyModes(baseOf(scopeOf(c))) && !(isGuestScope(baseOf(scopeOf(c))) && spaceOf(scopeOf(c)) === "open")) return c.json({ error: "forbidden" }, 403, noStore);
    const reg = await registryOf(c);
    const providers = reg.list();
    // gateway's model count is only known from its own listing; best effort, a failure leaves 0 (status stays accurate)
    const gw = providers.find((p) => p.id === "gateway");
    if (gw) gw.modelCount = (await reg.models().then((ms) => ms.filter((m) => m.provider === "gateway").length).catch(() => 0));
    return c.json({ providers }, 200, noStore);
  });

  adminFeatureRoutes(app);
  adminHealthRoutes(app);
  providerWriteRoutes(app, scopeOf, { fetchImpl: deps.fetchImpl });
  cfAccountRoutes(app, scopeOf, { fetchImpl: deps.fetchImpl });
  approvalRoutes(app, scopeOf, { baseAuto: (c) => approvalAutoOn(c.env.DB, baseOf(scopeOf(c))) });

  app.get("/api/models", async (c) => {
    try {
      const reg = await registryOf(c);
      const isOpen = spaceOf(scopeOf(c)) === "open";
      if (!isOpen && !reg.list().length) throw !c.env.GATEWAY && !teamProviderOf(c) ? new ProviderError(GATEWAY_ABSENT, 503, { type: "api_error" }) : new ProviderError("no provider for scope", 403);
      const all = await reg.models();
      // Gateway models keep the old ordering (Claude first); other providers follow, grouped by provider.
      const ordered = [...sortModels(all.filter((m) => m.provider === "gateway")), ...all.filter((m) => m.provider !== "gateway")];
      // catalog flags / price estimate / measured speed tier (one query each; a missing table just means "unknown")
      const models = decorateModels(ordered, await loadCatalog(c.env.DB), await loadSpeedStats(c.env.DB));
      // Business: the Vertex default as always. Open: the first Open model that is not flagged `limited` (tiny daily quota), or null (empty state); never a Claude id.
      // Provider notices (data-use warning) for the providers present in this list: persistent, shown in Open next to the model. { <providerId>: text }
      const providerNotices = Object.fromEntries([...new Set(models.map((m) => m.provider))].flatMap((p) => { const n = descriptorOf(p)?.dataUseNotice; return n ? [[p, n]] : []; }));
      const health = isOpen ? healthOf(c.env.DB, (p) => c.executionCtx.waitUntil(p), scopeOf(c)) : null;
      await health?.refresh().catch(() => {});
      return c.json({ default: isOpen ? defaultModelId(models, (id) => health!.unhealthy(id, Date.now())) : DEFAULT_MODEL, models, ...(Object.keys(providerNotices).length ? { providerNotices } : {}) });
    } catch (e) {
      const status = e instanceof ProviderError ? e.status : 502;
      return c.json({ error: e instanceof Error ? e.message : "provider error" }, status as 502, noStore);
    }
  });

  // Media models for the composer's Image / Video modes (kept apart from /api/models so a media model can never show in the chat sheet).
  // The e2e user gets the deterministic stub models (their calls are stubbed in the DO too); everyone else the gateway's kind=image|video list.
  app.get("/api/gen/models", async (c) => {
    const kind = c.req.query("kind") ?? "image";
    if (kind === "video") {
      try {
        const listed = isE2eBiz(scopeOf(c)) ? stubVideoModels() : await (await providerOf(c)).listModels("video");
        // params (allowed / defaults / values) drive the UI's duration, resolution and aspect controls; the UI has its own fallback.
        const models = listed.filter((m) => m.kind === "video").map((m) => {
          const e = estimate("video", m.id, { seconds: 3 }, m.price);
          return { id: m.id, name: m.displayName, params: m.params ?? null, priced: e.certainty !== "unknown", priceVerified: e.price_verified, ...priceKey(m.price) };
        });
        return c.json({ kind: "video", confirmUsd: await loadConfirmUsd(c.env.DB), models }, 200, noStore);
      } catch (e) {
        const status = e instanceof ProviderError ? e.status : 502;
        return c.json({ error: e instanceof Error ? e.message : "provider error" }, status as 502, noStore);
      }
    }
    if (kind !== "image") return c.json({ error: "unsupported kind" }, 400);
    try {
      const listed = isE2eBiz(scopeOf(c)) ? stubImageModels() : await (await providerOf(c)).listModels("image");
      const models = listed.filter((m) => m.kind === "image" || m.kind === undefined).map((m) => { const e = estimate("image", m.id, { n: 1 }, m.price); return { id: m.id, name: m.displayName, perImage: e.certainty === "unknown" ? null : e.usd, priceVerified: e.price_verified, ...priceKey(m.price), params: m.params ?? null }; });
      return c.json({ kind: "image", confirmUsd: await loadConfirmUsd(c.env.DB), models }, 200, noStore);
    } catch (e) {
      const status = e instanceof ProviderError ? e.status : 502;
      return c.json({ error: e instanceof Error ? e.message : "provider error" }, status as 502, noStore);
    }
  });

  // ---- Web Push ----
  app.get("/api/push/config", async (c) => {
    const n = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE scope=?`).bind(scopeOf(c)).first<{ n: number }>())?.n ?? 0;
    return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY ? c.env.VAPID_PUBLIC_KEY : null, subscriptions: n });
  });
  app.post("/api/push/subscribe", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const { endpoint } = b, p256dh = b.keys?.p256dh, auth = b.keys?.auth;
    if (typeof endpoint !== "string" || !validEndpoint(endpoint)) return c.json({ error: "unsupported push endpoint" }, 400);
    if (typeof p256dh !== "string" || typeof auth !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{20,30}$/.test(auth)) return c.json({ error: "bad subscription keys" }, 400);
    // A re-subscribed endpoint is overwritten INCLUDING its scope: the newest subscriber owns the endpoint, so a device can never keep
    // receiving another scope's pushes.
    await c.env.DB.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, scope) VALUES (?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent, scope=excluded.scope`)
      .bind(endpoint, p256dh, auth, (c.req.header("user-agent") ?? "").slice(0, 200), scopeOf(c)).run();
    return c.json({ ok: true }, 201);
  });
  app.post("/api/push/unsubscribe", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
    if (typeof b.endpoint !== "string") return c.json({ error: "endpoint required" }, 400);
    await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=? AND scope=?`).bind(b.endpoint, scopeOf(c)).run();
    return c.json({ ok: true });
  });
  app.post("/api/push/test", async (c) => {
    const r = await pushTo(c.env, scopeOf(c), { title: "Vertex Client", body: "Test notification — push is working.", url: "/", tag: "test" }, deps.fetchImpl);
    return c.json(r, r.configured ? 200 : 503);
  });

  // ---- Cloud mode (agent-spike) ----
  cloudRoutes(app, scopeOf);
  agentRoutes(app, scopeOf, repoList);
  artifactRoutes(app, scopeOf);
  artifactFrameRoute(app); // GET /af/:id/:version - html artifacts, view-token auth, own headers
  desktopRoutes(app, scopeOf);
  remoteRoutes(app, scopeOf);
  devicesRoutes(app, scopeOf);
  bridgeLlmRoutes(app);
  transcribeRoutes(app, scopeOf);

  // ---- slash menu: tools from the DO's ToolHost + static client-side builtins (api/slash.ts is the pure part) ----
  app.get("/api/slash", async (c) => {
    let tools: SlashTool[] = [];
    try {
      const r = await c.env.CHAT.get(c.env.CHAT.idFromName("slash-catalog")).fetch(new Request("https://do.internal/tools", { headers: { [DATA_SCOPE_HEADER]: scopeOf(c) } })); // fresh Request: the client's own headers never reach the DO
      if (r.ok) tools = ((await r.json()) as { tools: SlashTool[] }).tools;
    } catch (e) { console.error("slash", String(e)); }
    let skills: SlashItem[] = [];
    try { skills = await slashSkills(c.env.DB, scopeOf(c)); } catch (e) { console.error("slash skills", String(e)); }
    return c.json({ items: slashItems(tools, isE2eBiz(scopeOf(c)) ? E2E_TOOLS : null, skills) });
  });

  // ---- profile (Settings -> Profile): name, nickname, system-prompt instructions. Every scope reads/writes only its OWN row (WHERE scope=?).
  // Instructions are only ever applied to main's system prompt, so a g:* scope may not store them (400) instead of silently ignoring them. ----
  app.get("/api/profile", async (c) => c.json(await getProfile(c.env.DB, scopeOf(c)), 200, noStore));
  // "Let chat create images" (Settings -> General): per-scope on/off, default ON. `available` = this user can generate images at all (image models listed,
  // so a team user without image_gen sees no toggle); the model only gets the tool when both are true.
  app.get("/api/settings/chat-images", async (c) => {
    const sc = scopeOf(c);
    let available = false;
    try { available = (isE2eBiz(sc) ? stubImageModels() : await (await providerOf(c)).listModels("image")).length > 0; } catch { available = false; }
    return c.json({ enabled: await loadChatImages(c.env.DB, sc), available }, 200, noStore);
  });
  app.put("/api/settings/chat-images", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!b || typeof b.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    await saveChatImages(c.env.DB, scopeOf(c), b.enabled);
    return c.json({ enabled: b.enabled }, 200, noStore);
  });
  // "Auto model (shadow, records only)" (Settings -> General): per-scope on/off, default OFF. It records what the router would pick on each turn's usage rows; it never changes the model.
  app.get("/api/settings/auto-shadow", async (c) => c.json({ enabled: await loadAutoShadow(c.env.DB, scopeOf(c)) }, 200, noStore));
  app.put("/api/settings/auto-shadow", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!b || typeof b.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    await saveAutoShadow(c.env.DB, scopeOf(c), b.enabled);
    return c.json({ enabled: b.enabled }, 200, noStore);
  });
  // Auto's OPTIONAL per-message spend ceiling (estimate), per scope; null = none (default). With one set and everything over it Auto picks the cheapest eligible model, never refuses.
  app.get("/api/settings/auto-max-usd", async (c) => c.json({ usd: await loadAutoMaxUsd(c.env.DB, scopeOf(c)) }, 200, noStore));
  app.put("/api/settings/auto-max-usd", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { usd?: unknown } | null;
    if (!b || !("usd" in b)) return c.json({ error: "usd must be a positive number or null" }, 400);
    if (b.usd !== null && !(typeof b.usd === "number" && Number.isFinite(b.usd) && b.usd > 0 && b.usd <= 1000)) return c.json({ error: "usd must be a positive number (max 1000) or null" }, 400);
    await saveAutoMaxUsd(c.env.DB, scopeOf(c), b.usd as number | null);
    return c.json({ usd: b.usd }, 200, noStore);
  });
  // "Let chat delegate to subagents by itself" (Settings -> Subagents): per-scope on/off, default OFF. ON adds a system-prompt paragraph; OFF = `delegate` only for an explicit @persona.
  app.get("/api/settings/auto-delegate", async (c) => c.json({ enabled: await loadAutoDelegate(c.env.DB, scopeOf(c)) }, 200, noStore));
  app.put("/api/settings/auto-delegate", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!b || typeof b.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    await saveAutoDelegate(c.env.DB, scopeOf(c), b.enabled);
    return c.json({ enabled: b.enabled }, 200, noStore);
  });
  // "Limit answer length" (Settings -> Profile): per user base. off = Vertex-gateway models write as long as they can (src/output-budget.ts); default = the model's own cap. Edition default: main/e2e off, team user default.
  app.get("/api/settings/answer-limit", async (c) => { const g = isGuestScope(baseOf(scopeOf(c))); return c.json({ limit: await loadAnswerLimit(c.env.DB, baseOf(scopeOf(c)), g), default: answerLimitDefault(g) }, 200, noStore); });
  app.put("/api/settings/answer-limit", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { limit?: unknown } | null;
    if (!b || !isAnswerLimit(b.limit)) return c.json({ error: 'limit must be "off" or "default"' }, 400);
    await saveAnswerLimit(c.env.DB, baseOf(scopeOf(c)), b.limit);
    return c.json({ limit: b.limit, default: answerLimitDefault(isGuestScope(baseOf(scopeOf(c)))) }, 200, noStore);
  });
  // "Auto-switch models when one fails" (Open): per user base, default ON. Business conversations never use it.
  app.get("/api/settings/open-failover", async (c) => c.json({ enabled: await loadOpenFailover(c.env.DB, scopeOf(c)) }, 200, noStore));
  app.put("/api/settings/open-failover", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!b || typeof b.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    await saveOpenFailover(c.env.DB, scopeOf(c), b.enabled);
    return c.json({ enabled: b.enabled }, 200, noStore);
  });
  // "Allow Google AI Studio as an automatic fallback" (Open): separate opt-in, default OFF; with it off AI Studio is never an automatic target.
  app.get("/api/settings/open-failover-aistudio", async (c) => c.json({ available: FAILOVER_AI_STUDIO.enabled, enabled: FAILOVER_AI_STUDIO.enabled && (await loadOpenFailoverAistudio(c.env.DB, scopeOf(c))) }, 200, noStore)); // v1: not an automatic target at all (src/failover.ts): the UI hides the setting
  app.put("/api/settings/open-failover-aistudio", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!b || typeof b.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    await saveOpenFailoverAistudio(c.env.DB, scopeOf(c), b.enabled);
    return c.json({ enabled: b.enabled }, 200, noStore);
  });
  app.put("/api/profile", async (c) => {
    const v = validateProfile(await c.req.json().catch(() => null));
    if (!v.ok) return c.json({ error: v.error }, 400);
    if (v.v.instructions !== undefined && isGuestScope(baseOf(scopeOf(c)))) return c.json({ error: "instructions are not available for this account" }, 400);
    return c.json(await putProfile(c.env.DB, scopeOf(c), v.v), 200, noStore);
  });

  // ---- connectors: real tool list + per-scope switches. main/e2e only (g:* -> 403); each scope has its own rows ----
  // Custom (user-added) MCP connectors are main-only: e2e sees none and cannot add/change/delete one. Tokens never leave the server (`hasToken` only).
  guardPersonal(app, "/api/connectors", scopeOf);
  const customView = (r: CustomRow) => ({ id: r.id, name: r.name, kind: "remote-mcp" as const, url: r.url, authKind: r.auth_kind, authHeaderName: r.auth_header_name, hasToken: !!r.enc_token,
    status: r.last_status === "error" ? "unreachable" as const : "ok" as const, ...(r.last_error ? { error: r.last_error } : {}), enabled: r.enabled !== 0, toolCount: null as number | null, enabledCount: 0, tools: [] as unknown[] });
  const customTools = (list: Array<{ name: string; description: string }>, modes: Record<string, Mode>) => list.map((t) => { const mode = modes[t.name] ?? "ask";
    return { name: t.name, description: t.description, approval: mode === "ask", enabled: mode !== "block", mode, canAlways: true }; });
  app.get("/api/connectors", async (c) => {
    const sc = scopeOf(c);
    let defs: import("./tools").ToolDef[] = []; let error: string | undefined;
    try {
      const r = await c.env.CHAT.get(c.env.CHAT.idFromName("slash-catalog")).fetch(new Request("https://do.internal/connector-tools", { headers: { [DATA_SCOPE_HEADER]: sc } }));
      const j = (await r.json()) as { tools?: import("./tools").ToolDef[]; error?: string };
      defs = j.tools ?? []; error = j.error;
    } catch (e) { error = e instanceof Error ? e.message : "connector unreachable"; }
    try {
      const custom = isMainBase(sc) ? (await listCustom(c.env.DB, sc)).map(customView) : [];
      return c.json({ connectors: [connectorView(defs, await loadSettings(c.env.DB, sc), error), ...custom] }, 200, noStore);
    } catch (e) { console.error("connectors", String(e)); return c.json({ error: "could not load connector settings" }, 500); }
  });
  // One custom connector with its LIVE tool list (this is where the server is contacted; also refreshes the stored status).
  app.get("/api/connectors/:id", async (c) => {
    const sc = scopeOf(c); const id = c.req.param("id");
    if (id === CONNECTOR_ID || !isMainBase(sc)) return c.json({ error: "unknown connector" }, 404);
    const row = await getCustom(c.env.DB, sc, id);
    if (!row) return c.json({ error: "unknown connector" }, 404);
    const st = await loadState(c.env.DB, sc, id);
    try {
      const raw = await fetchStoredTools(c.env.SESSION_SECRET, row, deps.fetchImpl);
      const eff = await effectiveModes(raw, st.modes, st.hashes);
      const list = listForSettings(raw);
      const modes = eff.modes;
      await setStatus(c.env.DB, sc, id, true, null);
      return c.json({ connector: { ...customView({ ...row, last_status: "ok", last_error: null }), toolCount: list.length, enabledCount: row.enabled ? list.filter((t) => (modes[t.name] ?? "ask") !== "block").length : 0, tools: customTools(list, modes).map((t) => ({ ...t, changed: eff.changed.has(t.name) })) } }, 200, noStore);
    } catch (e) {
      const msg = scrub(e);
      await setStatus(c.env.DB, sc, id, false, msg);
      return c.json({ connector: { ...customView({ ...row, last_status: "error", last_error: msg }), tools: [] } }, 200, noStore);
    }
  });
  app.post("/api/connectors", async (c) => {
    const sc = scopeOf(c);
    if (!isMainBase(sc)) return c.json({ error: "custom connectors are not available for this account" }, 403);
    const v = validateNew(await c.req.json().catch(() => null));
    if (!v.ok) return c.json({ error: v.error }, 400);
    const rows = await listCustom(c.env.DB, sc);
    if (rows.length >= MAX_CUSTOM) return c.json({ error: `at most ${MAX_CUSTOM} custom connectors` }, 409);
    const slug = slugOf(v.v.name);
    if (rows.some((r) => slugOf(r.name) === slug) || slug === "personal-connector") return c.json({ error: "a connector with that name already exists" }, 409);
    // Test before saving: initialize + tools/list must work, otherwise nothing is stored.
    const probe = { url: v.v.url, auth_kind: v.v.authKind, auth_header_name: v.v.headerName };
    try { await (await clientFor(probe, v.v.token, deps.fetchImpl)).tools(); }
    catch (e) { return c.json({ error: scrub(e, v.v.token) }, 400); }
    const id = "cc_" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const encToken = v.v.token ? await encryptToken(c.env.SESSION_SECRET, `${sc}:${id}`, v.v.token) : null;
    await c.env.DB.prepare(`INSERT INTO custom_connectors (id, scope, name, url, auth_kind, auth_header_name, enc_token, enabled, last_status) VALUES (?,?,?,?,?,?,?,1,'ok')`)
      .bind(id, sc, v.v.name, v.v.url, v.v.authKind, v.v.headerName, encToken).run();
    return c.json({ connector: customView((await getCustom(c.env.DB, sc, id))!) }, 201, noStore);
  });
  app.put("/api/connectors/:id", async (c) => {
    const sc = scopeOf(c); const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) ?? {};
    if (id !== CONNECTOR_ID) { // custom: {enabled?} and/or {tool: {name, mode}}
      if (!isMainBase(sc)) return c.json({ error: "unknown connector" }, 404);
      const row = await getCustom(c.env.DB, sc, id);
      if (!row) return c.json({ error: "unknown connector" }, 404);
      const b = body as { enabled?: unknown; tool?: { name?: unknown; mode?: unknown } };
      if (b.enabled === undefined && b.tool === undefined) return c.json({ error: "nothing to change" }, 400);
      if (b.enabled !== undefined && typeof b.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
      if (b.tool !== undefined) {
        const t = b.tool;
        if (!t || typeof t !== "object" || typeof t.name !== "string" || !/^[\w.-]{1,128}$/.test(t.name) || !MODES.includes(t.mode as Mode)) return c.json({ error: "tool must be {name, mode: always|ask|block}" }, 400);
        const st = await loadState(c.env.DB, sc, id);
        if (t.mode === "ask") delete st.modes[t.name]; else st.modes[t.name] = t.mode as Mode; // absent = Ask first
        delete st.hashes[t.name];
        if (t.mode === "always") { // Always pins the definition Erich is looking at now; a later change downgrades it to Ask first until he confirms again
          let live: Awaited<ReturnType<typeof fetchStoredTools>>;
          try { live = await fetchStoredTools(c.env.SESSION_SECRET, row, deps.fetchImpl); } catch (e) { return c.json({ error: `could not read the server's tools to confirm: ${scrub(e)}` }, 502); }
          const tool = live.find((x) => x.name === t.name);
          if (!tool) return c.json({ error: "that tool is not on the server (any more)" }, 409);
          st.hashes[t.name] = await toolHash(tool);
        }
        if (Object.keys(st.modes).length > 100) return c.json({ error: "too many tool settings" }, 400);
        await saveState(c.env.DB, sc, id, st);
      }
      if (b.enabled !== undefined) await c.env.DB.prepare(`UPDATE custom_connectors SET enabled=?, updated_at=datetime('now') WHERE scope=? AND id=?`).bind(b.enabled ? 1 : 0, sc, id).run();
      return c.json({ ok: true }, 200, noStore);
    }
    const r = applyPatch(await loadSettings(c.env.DB, sc), body);
    if (!r.ok) return c.json({ error: r.error }, 400);
    await saveSettings(c.env.DB, sc, r.next);
    return c.json({ ok: true, enabled: r.next.enabled, disabled: r.next.disabled }, 200, noStore);
  });
  // Disconnect a custom connector: the row (and with it the encrypted token) and its tool settings are deleted. The built-in cannot be deleted
  // (its "Disconnect" is the master switch).
  app.delete("/api/connectors/:id", async (c) => {
    const sc = scopeOf(c); const id = c.req.param("id");
    if (id === CONNECTOR_ID) return c.json({ error: "the built-in connector cannot be deleted; turn it off instead" }, 400);
    if (!isMainBase(sc) || !(await getCustom(c.env.DB, sc, id))) return c.json({ error: "unknown connector" }, 404);
    await deleteCustom(c.env.DB, sc, id);
    return c.json({ ok: true }, 200, noStore);
  });

  // ---- skills (prompt templates for the slash menu; scope-aware exactly like conversations) ----
  // Skills are Erich's prompt templates: team users can read their (empty) list but not write, per the team-instance brief.
  app.use("/api/skills", async (c, next) => (c.req.method !== "GET" && isGuestScope(baseOf(scopeOf(c))) ? c.json({ error: "forbidden" }, 403) : next()));
  app.use("/api/skills/*", async (c, next) => (c.req.method !== "GET" && isGuestScope(baseOf(scopeOf(c))) ? c.json({ error: "forbidden" }, 403) : next()));
  app.get("/api/skills", async (c) => c.json({ skills: await listSkills(c.env.DB, scopeOf(c)) }, 200, noStore));
  app.post("/api/skills", async (c) => { const r = await createSkill(c.env.DB, scopeOf(c), (await c.req.json().catch(() => ({}))) ?? {}); return c.json(r.body, r.status as 201); });
  app.patch("/api/skills/:id", async (c) => { const r = await updateSkill(c.env.DB, scopeOf(c), c.req.param("id"), (await c.req.json().catch(() => ({}))) ?? {}); return c.json(r.body, r.status as 200); });
  app.delete("/api/skills/:id", async (c) => { const r = await deleteSkill(c.env.DB, scopeOf(c), c.req.param("id")); return c.json(r.body, r.status as 200); });
  // ---- subagent personas (the `delegate` tool's configuration): every scope manages its OWN rows, team users included (data is per g:<uid>) ----
  app.get("/api/personas", async (c) => c.json({ personas: await listPersonas(c.env.DB, scopeOf(c)) }, 200, noStore));
  app.post("/api/personas", async (c) => { const r = await createPersona(c.env.DB, scopeOf(c), (await c.req.json().catch(() => ({}))) ?? {}); return c.json(r.body, r.status as 201); });
  app.patch("/api/personas/:id", async (c) => { const r = await updatePersona(c.env.DB, scopeOf(c), c.req.param("id"), (await c.req.json().catch(() => ({}))) ?? {}); return c.json(r.body, r.status as 200); });
  app.delete("/api/personas/:id", async (c) => { const r = await deletePersona(c.env.DB, scopeOf(c), c.req.param("id")); return c.json(r.body, r.status as 200); });

  // ---- usage ----
  app.get("/api/usage", async (c) => c.json(await usageReport(c.env.DB, Date.now(), Number(c.req.query("tz") ?? 0) || 0, scopeOf(c), c.get("session").u)));

  // ---- saved prompts: every scope (main, e2e, g:*) has its own rows (every query filters by scope); a prompt of another scope is 404 ----
  app.get("/api/prompts", async (c) => c.json({ prompts: await listPrompts(c.env.DB, scopeOf(c)) }, 200, noStore));
  app.post("/api/prompts", async (c) => {
    const v = validatePrompt(await c.req.json().catch(() => null), true);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const p = await createPrompt(c.env.DB, scopeOf(c), v.v);
    return p ? c.json(p, 201, noStore) : c.json({ error: `at most ${MAX_PROMPTS} prompts` }, 409);
  });
  const editPrompt = async (c: Context<App>) => {
    const v = validatePrompt(await c.req.json().catch(() => null), false);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const p = await updatePrompt(c.env.DB, scopeOf(c), c.req.param("id") ?? "", v.v);
    return p ? c.json(p, 200, noStore) : c.json({ error: "not found" }, 404);
  };
  app.patch("/api/prompts/:id", editPrompt);
  app.put("/api/prompts/:id", editPrompt);
  app.delete("/api/prompts/:id", async (c) => (await deletePrompt(c.env.DB, scopeOf(c), c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404));

  // ---- projects: main + e2e (own rows each); every g:* scope gets 403 before the handler; a project of another scope is 404 ----
  guardPersonal(app, "/api/projects", scopeOf);
  app.get("/api/projects", async (c) => c.json({ projects: await listProjects(c.env.DB, scopeOf(c)) }, 200, noStore));
  app.post("/api/projects", async (c) => {
    const v = validateProject(await c.req.json().catch(() => null), true);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const p = await createProject(c.env.DB, scopeOf(c), v.v);
    return p ? c.json(p, 201, noStore) : c.json({ error: `at most ${MAX_PROJECTS} projects` }, 409);
  });
  app.get("/api/projects/:id", async (c) => {
    const p = await getProject(c.env.DB, scopeOf(c), c.req.param("id"));
    return p ? c.json(p, 200, noStore) : c.json({ error: "not found" }, 404);
  });
  app.patch("/api/projects/:id", async (c) => {
    const v = validateProject(await c.req.json().catch(() => null), false);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const p = await updateProject(c.env.DB, scopeOf(c), c.req.param("id"), v.v);
    return p ? c.json(p, 200, noStore) : c.json({ error: "not found" }, 404);
  });
  app.delete("/api/projects/:id", async (c) => (await archiveProject(c.env.DB, scopeOf(c), c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404));

  // ---- notifications center: the caller's own stored notifications (user_id = scope). A missing table (migration 0039 not applied) reads as empty. ----
  app.get("/api/notifications", async (c) => {
    const lq = c.req.query("limit"), bq = c.req.query("before");
    if (lq !== undefined && !/^\d{1,3}$/.test(lq)) return c.json({ error: "invalid limit" }, 400);
    const before = parseNotifCursor(bq);
    if (before === null) return c.json({ error: "invalid cursor" }, 400);
    try { return c.json(await listNotifications(c.env.DB, scopeOf(c), { limit: lq === undefined ? undefined : Number(lq), before }), 200, noStore); }
    catch (e) { console.error("notifications list", e instanceof Error ? e.message : String(e)); return c.json({ items: [], next: null, unread: 0 }, 200, noStore); }
  });
  app.post("/api/notifications/read", async (c) => {
    const v = parseReadBody(await c.req.json().catch(() => null));
    if (!v.ok) return c.json({ error: v.error }, 400);
    try { return c.json({ ok: true, changed: await markRead(c.env.DB, scopeOf(c), v.which) }); }
    catch (e) { console.error("notifications read", e instanceof Error ? e.message : String(e)); return c.json({ error: "unavailable" }, 503); }
  });

  // ---- library: the scope's generated images/videos, newest first (R2 listing of the scope's own conversations; no secrets, no index table) ----
  app.get("/api/library", async (c) => {
    const type = c.req.query("type");
    if (type !== undefined && type !== "image" && type !== "video") return c.json({ error: "type must be image or video" }, 400);
    const before = parseCursor(c.req.query("before"));
    if (before === null) return c.json({ error: "invalid cursor" }, 400);
    if (!c.env.FILES) return c.json({ error: "file storage not configured" }, 503);
    return c.json(await libraryPage(c.env.DB, c.env.FILES, scopeOf(c), { type, before, user: c.get("session").u }), 200, noStore);
  });

  // ---- conversations (index in D1, content in the ChatSession DO) ----
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // Open-space chats call Google AI Studio from inside the DO, and Google blocks some regions (HKG). A DO is created lazily by the FIRST fetch to its id (the POST above only writes D1), so every
  // Open-space call passes the hint; it is ignored once the DO exists. Business (Vertex) keeps the default nearest-colo placement: no hint.
  const hintFor = (scope: Scope): string | undefined => (spaceOf(scope) === "open" ? "wnam" : undefined);
  const stub = (env: Env, id: string, hint?: string) => env.CHAT.get(env.CHAT.idFromName(id), hint ? { locationHint: hint } : undefined);
  // The hint is derived from the request's scope HERE, so no call site can forget it (every conversation route's first DO touch is hinted when Open).
  const convFetch = (c: Context<App>, id: string, path: string, init?: RequestInit) =>
    stub(c.env, id, hintFor(scopeOf(c))).fetch(new Request(`https://do.internal${path}`, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-conv-id": id } }));

  app.get("/api/conversations", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const cols = "c.id, c.title, c.model, c.pinned, c.cost_usd AS costUsd, c.tokens, c.project_id AS projectId, c.created_at AS createdAt, c.updated_at AS updatedAt";
    const sc = scopeOf(c), me = c.get("session").u;
    const rows = await withDevVisibility("c", me, async (dv, dva) => {
    const fq = q ? ftsQuery(q) : null;
    if (q && fq) {
      const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
      return c.env.DB.prepare(
        `SELECT ${cols} FROM conversations c WHERE (c.id IN (
           SELECT mi.conversation_id FROM messages_fts f JOIN messages_index mi ON mi.id=f.rowid WHERE messages_fts MATCH ?)
         OR c.title LIKE ? ESCAPE '\\') AND c.scope = ?${dv} ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 50`).bind(fq, like, sc, ...dva).all();
    } else if (q) {
      return c.env.DB.prepare(`SELECT ${cols} FROM conversations c WHERE c.title LIKE ? ESCAPE '\\' AND c.scope = ?${dv} ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 50`).bind(`%${q.replace(/[%_\\]/g, "\\$&")}%`, sc, ...dva).all();
    } else if (c.req.query("project")) {
      // ?project=<id>: only that project's chats in this scope (an unknown / foreign id simply matches nothing)
      return c.env.DB.prepare(`SELECT ${cols} FROM conversations c WHERE c.scope = ? AND c.project_id = ?${dv} ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 200`).bind(sc, c.req.query("project"), ...dva).all();
    } else {
      return c.env.DB.prepare(`SELECT ${cols} FROM conversations c WHERE c.scope = ?${dv} ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 200`).bind(sc, ...dva).all();
    }
    });
    // Semantic mode (VECTORIZE + AI present, query of 3+ chars): FTS/title hits stay first, semantic-only conversations follow (deduped by id). Any failure => keyword result.
    let list = rows.results as Array<Record<string, unknown>>;
    let mode: "keyword" | "semantic" = "keyword";
    if (q.length >= 3 && (await semEnabled(c.env, c.env.DB, sc))) {
      try {
        const hits = await semanticMatches(c.env, c.env.DB, sc, q);
        if (hits) {
          mode = "semantic";
          const have = new Set(list.map((r) => r.id as string));
          const fresh = hits.filter((h) => !have.has(h.conv)).slice(0, 20);
          if (fresh.length) {
            // c.scope = ? is the authority: a vector pointing at a foreign / deleted conversation simply matches no row.
            const extra = await withDevVisibility("c", me, (dv, dva) => c.env.DB.prepare(`SELECT ${cols} FROM conversations c WHERE c.scope = ? AND c.id IN (${fresh.map(() => "?").join(",")})${dv}`).bind(sc, ...fresh.map((h) => h.conv), ...dva).all<Record<string, unknown>>());
            const byId = new Map(extra.results.map((r) => [r.id as string, r]));
            const added: Array<Record<string, unknown>> = [];
            for (const h of fresh) { const r = byId.get(h.conv); if (r) added.push({ ...r, match: "semantic", snippet: await snippetFor(c.env.DB, h.conv, h.seq) }); }
            list = [...list, ...added].slice(0, 50);
          }
        }
      } catch (e) { console.error("semantic search failed", e instanceof Error ? e.message : "error"); }
    }
    return c.json({ conversations: list, mode });
  });

  // Semantic search status + the opt-in backfill (settings row `semantic_backfill:<scope>` = '1', default off; the PO flips it). One bounded slice per POST.
  app.get("/api/semantic", async (c) => c.json({ available: await semEnabled(c.env, c.env.DB, scopeOf(c)), backfill: await backfillState(c.env.DB, scopeOf(c)) }, 200, noStore));
  app.post("/api/semantic/backfill", async (c) => {
    const sc = scopeOf(c);
    if (!mayUseSemantic(sc)) return c.json({ error: "semantic search is Open-space only" }, 409, noStore); // Business text never goes to Workers AI
    if (!semReady(c.env, sc)) return c.json({ error: "semantic search is not available on this deployment" }, 503, noStore);
    if (!(await semEnabled(c.env, c.env.DB, sc))) return c.json({ error: "semantic search is not enabled (readiness flag or migration 0028 missing)" }, 409, noStore);
    if (!(await backfillState(c.env.DB, sc)).on) return c.json({ error: "backfill is off" }, 409, noStore);
    try { return c.json(await backfillSlice(c.env, c.env.DB, sc), 200, noStore); } catch (e) { console.error("semantic backfill failed", e instanceof Error ? e.message : "error"); return c.json({ error: "backfill failed" }, 502, noStore); }
  });

  app.post("/api/conversations", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; project_id?: unknown };
    let model = isModelIdSyntax(body.model) ? body.model : DEFAULT_MODEL;
    if (spaceOf(scopeOf(c)) === "open") {
      // Open: the model must be a member of THIS space's list (provider:model ids allowed); otherwise the space default, never a Claude id.
      let ids: string[];
      try { ids = (await (await registryOf(c)).models()).map((m) => m.id); } catch { return c.json({ error: "models unavailable" }, 502, noStore); }
      const want = typeof body.model === "string" && /^[A-Za-z0-9._:/@-]{1,120}$/.test(body.model) ? body.model : null;
      const pick = want && ids.includes(want) ? want : ids[0];
      if (!pick) return c.json({ error: "no model available in this space" }, 409, noStore);
      model = pick;
    }
    const id = crypto.randomUUID();
    let projectId: string | null = null;
    if (body.project_id !== undefined && body.project_id !== null) {
      if (typeof body.project_id !== "string" || !(await getProject(c.env.DB, scopeOf(c), body.project_id))) return c.json({ error: "project not found" }, 404);
      projectId = body.project_id;
    }
    // Devices v2 step 3: `env:{kind:"device",device_id,dir}` binds the chat to the caller's own device (flag `vcl_env:<base>`, default OFF => plain 404 as if the field did not exist). Anything malformed is refused, never turned into a cloud chat.
    const eb = envBody((body as { env?: unknown }).env);
    if (!eb.ok) return c.json({ error: eb.error }, 400, noStore);
    if (eb.env) {
      const r = await bindDeviceEnv(c.env, scopeOf(c), c.get("session").u, eb.env,
        async (cols) => { await c.env.DB.prepare(`INSERT INTO conversations (id, model, scope, project_id, env_kind, env_device_id, env_dir, env_user) VALUES (?,?,?,?,?,?,?,?)`).bind(id, model, scopeOf(c), projectId, cols.env_kind, cols.env_device_id, cols.env_dir, cols.env_user).run(); },
        () => convFetch(c, id, "/env", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: eb.env!.device_id, dir: eb.env!.dir, user: c.get("session").u }) }),
        async () => { await c.env.DB.prepare(`DELETE FROM conversations WHERE id=? AND scope=?`).bind(id, scopeOf(c)).run(); });
      if (!r.ok) return c.json({ error: r.error }, r.status, noStore);
      return c.json({ id, model, title: "", projectId, env: { kind: "device", device_id: eb.env.device_id, dir: eb.env.dir } }, 201);
    }
    await c.env.DB.prepare(`INSERT INTO conversations (id, model, scope, project_id) VALUES (?,?,?,?)`).bind(id, model, scopeOf(c), projectId).run();
    return c.json({ id, model, title: "", projectId }, 201);
  });

  const owned = async (c: Context<App>, id: string) => {
    if (!UUID.test(id)) return null;
    // SELECT * (not named env_* columns): still works before migration 0042 is applied. A DEVICE conversation belongs to the one user pinned in env_user (its commands and approvals run under that identity), not to everyone in the scope: anyone else gets the same 404 as an unknown id, before any DO is touched.
    const r = await c.env.DB.prepare(`SELECT * FROM conversations WHERE id=? AND scope=?`).bind(id, scopeOf(c)).first<Record<string, unknown>>();
    if (!r) return null;
    if (r.env_kind === "device" && r.env_user !== c.get("session").u) return null;
    return { id: r.id, envKind: r.env_kind ?? null, title: r.title, model: r.model, pinned: r.pinned, costUsd: r.cost_usd, tokens: r.tokens, projectId: r.project_id, createdAt: r.created_at, updatedAt: r.updated_at } as Record<string, unknown>;
  };

  app.get("/api/conversations/:id/ws", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket upgrade" }, 426);
    const id = c.req.param("id");
    if (!(await owned(c, id))) return c.json({ error: "not found" }, 404);
    const since = Number(c.req.query("since") ?? 0) || 0;
    const r = await convFetch(c, id, `/ws?since=${since}`, { headers: { upgrade: "websocket" } });
    // The DO's 101 has immutable headers; re-wrap so the /api/* middleware can still append cookies/cache headers.
    return r.status === 101 ? new Response(null, { status: 101, webSocket: (r as { webSocket?: WebSocket }).webSocket }) : r;
  });

  // Upload one attachment (raw body, name in ?name=). Stored in R2 under vertex-client/<conv>/; the client then sends the
  // returned ref with its next message. Size is checked from Content-Length first, then again on the bytes actually read.
  // Text-like files are validated as text (binary disguised as .txt is refused); Office files are extracted here and the
  // text kept in a `<ref>.txt` sidecar, so the per-turn expansion never has to unzip anything.
  app.post("/api/conversations/:id/files", async (c) => {
    const id = c.req.param("id");
    if (!(await owned(c, id))) return c.json({ error: "not found" }, 404);
    if (!c.env.FILES) return c.json({ error: "file storage not configured" }, 503);
    const mime = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const name = cleanName(c.req.query("name") ?? "file");
    const declared = Number(c.req.header("content-length") ?? 0);
    const pre = checkUpload(mime, declared || 1, name);
    if (pre || declared > MAX_FILE_BYTES) return c.json({ error: pre?.error ?? "file too large" }, (pre?.status ?? 413) as 413);
    const buf = await c.req.arrayBuffer();
    const bad = checkUpload(mime, buf.byteLength, name);
    if (bad) return c.json({ error: bad.error }, bad.status as 413);
    const cls = classifyFile(mime, name)!;
    const bytes = new Uint8Array(buf);
    let tokens: number | undefined; let sidecar: string | undefined;
    try {
      if (cls.kind === "text") tokens = approxTokens(textForModel(bytes, cls.mime, name));
      else if (cls.kind === "office") { sidecar = extractOffice(bytes, officeKindOf(cls.mime, name)!); tokens = approxTokens(sidecar); }
    } catch (e) {
      if (e instanceof ExtractError) return c.json({ error: `${name}: ${e.message}` }, 415);
      console.error("extract failed", name, String(e)); // never the content
      return c.json({ error: `${name}: could not read this file` }, 415);
    }
    const ref = fileKey(id, name);
    await c.env.FILES.put(ref, buf, { httpMetadata: { contentType: cls.mime }, customMetadata: { conversation: id } });
    if (sidecar !== undefined) await c.env.FILES.put(sidecarKey(ref), sidecar, { httpMetadata: { contentType: "text/plain; charset=utf-8" }, customMetadata: { conversation: id, extractedFrom: ref } });
    return c.json({ ref, name, mime: cls.mime, size: buf.byteLength, kind: cls.kind, ...(tokens !== undefined ? { tokens } : {}) }, 201);
  });

  // Preview one attachment. :ref is the full key or just its tail after vertex-client/<conv>/. Text is re-served as UTF-8
  // text/plain (never as the uploaded type), Office files as their extracted text, images/PDF as stored, generated video (gen/*.mp4)
  // with Range support (206/416; iOS Safari needs it to play at all).
  app.get("/api/conversations/:id/files/:ref{.+}", async (c) => {
    const id = c.req.param("id");
    if (!(await owned(c, id))) return c.json({ error: "not found" }, 404);
    if (!c.env.FILES) return c.json({ error: "file storage not configured" }, 503);
    const raw = c.req.param("ref");
    const ref = raw.startsWith(FILE_PREFIX) ? raw : `${FILE_PREFIX}${id}/${raw}`;
    if (!refBelongsTo(ref, id)) return c.json({ error: "not found" }, 404);
    const files = c.env.FILES;
    if (ref.startsWith(`${FILE_PREFIX}${id}/gen/`) && ref.endsWith(".mp4")) {
      const head = await files.head(ref);
      const mime = head?.httpMetadata?.contentType;
      if (!head || !mime || !GEN_VIDEO_MIMES[mime]) return c.json({ error: "not found" }, 404);
      return rangeResponse(head.size, mime, c.req.header("range"), async (r) => (await files.get(ref, r ? { range: r } : undefined))?.body ?? null,
        { "x-content-type-options": "nosniff", "cache-control": "private, max-age=300" });
    }
    const o = await files.get(ref);
    if (!o) return c.json({ error: "not found" }, 404);
    const stored = o.httpMetadata?.contentType ?? "application/octet-stream";
    const cls = classifyFile(stored, ref);
    const h = { "x-content-type-options": "nosniff", "cache-control": "private, max-age=300" };
    if (cls?.kind === "text") return new Response(decodeText(new Uint8Array(await o.arrayBuffer())), { headers: { ...h, "content-type": "text/plain; charset=utf-8" } });
    if (cls?.kind === "office") {
      const side = await c.env.FILES.get(sidecarKey(ref));
      if (!side) return c.json({ error: "not found" }, 404);
      return new Response(new TextDecoder().decode(await side.arrayBuffer()), { headers: { ...h, "content-type": "text/plain; charset=utf-8" } });
    }
    if (cls?.kind === "image" || cls?.kind === "pdf") return new Response(o.body, { headers: { ...h, "content-type": cls.mime } });
    return c.json({ error: "not found" }, 404);
  });

  app.get("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const row = await owned(c, id);
    if (!row) return c.json({ error: "not found" }, 404);
    const st = await (await convFetch(c, id, "/state")).json();
    const envv = await envView(c.env, scopeOf(c), id); // null for every cloud chat (the page then shows nothing new)
    return c.json({ conversation: row, state: st, ...(envv ? { env: envv } : {}) });
  });

  app.patch("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await owned(c, id))) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { title?: unknown; pinned?: unknown; project_id?: unknown };
    if (b.project_id !== undefined) {
      if (b.project_id !== null && typeof b.project_id !== "string") return c.json({ error: "project_id must be text or null" }, 400);
      if (!(await assignConversation(c.env.DB, scopeOf(c), id, b.project_id as string | null))) return c.json({ error: "project not found" }, 404);
    }
    if (typeof b.title === "string") await c.env.DB.prepare(`UPDATE conversations SET title=? WHERE id=? AND scope=?`).bind(b.title.slice(0, 120), id, scopeOf(c)).run();
    if (typeof b.pinned === "boolean") await c.env.DB.prepare(`UPDATE conversations SET pinned=? WHERE id=? AND scope=?`).bind(b.pinned ? 1 : 0, id, scopeOf(c)).run();
    return c.json({ ok: true });
  });

  // Fork for "edit an earlier message": copies the transcript before that user message into a NEW conversation of the same scope/project.
  // The original is never modified. The edited text is sent by the client into the fork as its first turn.
  app.post("/api/conversations/:id/fork", async (c) => {
    const id = c.req.param("id");
    const row = await owned(c, id);
    if (!row) return c.json({ error: "not found" }, 404);
    // A fork would copy private device output into a NEW, scope-readable cloud chat (no env_user): refused until a device-aware fork exists. Nothing is created.
    if (row.envKind === "device") return c.json({ error: "Device conversation forks are unsupported." }, 409);
    const b = (await c.req.json().catch(() => ({}))) as { message_id?: unknown };
    if (typeof b.message_id !== "number" || !Number.isInteger(b.message_id)) return c.json({ error: "message_id must be a number" }, 400);
    const st = (await (await convFetch(c, id, "/state")).json()) as { running?: boolean; webTainted?: boolean; messages?: Array<{ id: number; role: "user" | "assistant"; content: any[]; model?: string | null }>; model?: string | null };
    const r = forkPrefix(st.messages ?? [], b.message_id, !!st.running);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    const nid = crypto.randomUUID();
    const model = String(st.model ?? row.model ?? DEFAULT_MODEL);
    const title = forkTitle(String(row.title ?? ""));
    const pid = (row.projectId as string | null) ?? null;
    await c.env.DB.prepare(`INSERT INTO conversations (id, model, scope, project_id, title) VALUES (?,?,?,?,?)`).bind(nid, model, scopeOf(c), pid, title).run();
    const seeded = await convFetch(c, nid, "/seed", { method: "POST", body: JSON.stringify({ model, title, messages: r.messages, tainted: st.webTainted !== false }) }).catch(() => null);
    if (!seeded?.ok) { // no half-made fork left behind
      await convFetch(c, nid, "/destroy", { method: "POST" }).catch(() => null);
      await removeConversationRows(c.env, nid, scopeOf(c), waitOrAwait(c));
      return c.json({ error: "could not create the fork" }, 500);
    }
    return c.json({ id: nid, model, title, projectId: pid }, 201);
  });

  app.delete("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await owned(c, id))) return c.json({ error: "not found" }, 404);
    // The DO sweeps R2 (files + generated images) first, then clears its own storage; D1 rows go only after that succeeded.
    const d = await convFetch(c, id, "/destroy", { method: "POST" });
    if (!d.ok) return c.json({ error: "conversation cleanup failed; conversation not deleted, retry" }, 500);
    await removeConversationRows(c.env, id, scopeOf(c), waitOrAwait(c));
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  appAuthRoutes(app as never); // /auth/app/*: desktop sign-in through the system browser, flag-gated (auth-app.ts). Must come before the /auth/* 404 below.
  app.all("/auth/*", (c) => c.json({ error: "not found" }, 404));

  // Static assets are served by the platform (SPA fallback); this only runs if a request reaches the Worker anyway.
  app.all("*", (c: Context<App>) => c.env.ASSETS.fetch(c.req.raw));

  app.onError((e, c) => {
    console.error("unhandled", e instanceof Error ? e.message : String(e));
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}

/** THE conversation-removal path (delete route, failed-fork rollback): vector tombstone first (needs the index rows' max seq), then the D1 rows. Any new removal path must call this. */
export async function removeConversationRows(env: Env, id: string, scope: Scope, defer: (p: Promise<void>) => void | Promise<void>): Promise<void> {
  let vtail: Promise<void> | undefined;
  await deleteConversationVectors(env, env.DB, scope, id, (p) => { vtail = p; });
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM messages_index WHERE conversation_id=?`).bind(id),
    env.DB.prepare(`DELETE FROM conversations WHERE id=? AND scope=?`).bind(id, scope),
  ]);
  if (vtail) await defer(vtail); // after the rows are gone: a concurrent in-flight index sees no conversation row and removes what it wrote
}
const waitOrAwait = (c: Context<App>) => async (p: Promise<void>) => { try { c.executionCtx.waitUntil(p); } catch { await p; } };

/** Cron (every minute). Exported for server/worker.ts. */
export async function scheduled(_ev: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(watchRuns(env).then((r) => { if (r.errors.length) console.error("cloud-watch", r.errors.join("; ")); }).catch((e) => console.error("cloud-watch failed", String(e))));
  ctx.waitUntil(watchDesktop(env).then((r) => { if (r.errors.length) console.error("desktop-watch", r.errors.join("; ")); }).catch((e) => console.error("desktop-watch failed", String(e))));
  ctx.waitUntil(sweepDeleted(env.DB, env.FILES).then((n) => { if (n) console.log(`artifact sweep: ${n} removed`); }).catch((e) => console.error("artifact sweep failed", String(e))));
  ctx.waitUntil(sweepVectorTombstones(env, env.DB).catch((e) => console.error("vector sweep failed", String(e))));
  ctx.waitUntil(backfillCron(env, env.DB).catch((e) => console.error("semantic backfill failed", String(e))));
  ctx.waitUntil(purgeAudit(env.DB).catch((e) => console.error("approval audit purge failed", String(e)))); // 30-day TTL backstop (also purged on every audit write)
  ctx.waitUntil(watchAgents(env).then((r) => { if (r.errors.length) console.error("agent-watch", r.errors.join("; ")); }).catch((e) => console.error("agent-watch failed", String(e))));
}

// Whole app as one handler (gate included) - what the bun tests drive; production uses server/worker.ts (same routes, gate from server/middleware.ts). Lazy: no cost at startup.
let single: ReturnType<typeof createApp> | undefined;
/** `price` is emitted only when the listing carries the key: `null` = a catalog row WITHOUT a price (honestly unknown), absent = a legacy listing with no catalog row
 *  (the UI then falls back to the rates tables, like the engine's priceOf does). Collapsing absent into null forced "price unknown" + the unpriced confirm. */
export const priceKey = (p: ProviderModel["price"]) => (p === undefined ? {} : { price: p });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withSecurityHeaders(await (single ??= createApp()).fetch(req, env, ctx), req);
  },
  scheduled,
} as ExportedHandler<Env> & { scheduled(ev: unknown, env: Env, ctx: ExecutionContext): Promise<void> };
