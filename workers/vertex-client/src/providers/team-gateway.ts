// Team gateway provider: for a `g:<uid>` session on the team instance. vclient never holds a per-user secret. It calls the team gateway server to
// server with ONE trusted caller key (`vertex-client-team`, Worker secret VCLIENT_TEAM_CALLER_KEY) plus `x-act-as: <email>`; the gateway honours act-as only
// for that caller and re-checks the user's features and Google link on every call. This module adds an early refusal on top (entitlement cache <= 60 s,
// FAIL CLOSED: gateway down / unreadable / non-200 => 503 and no generation; a stale allow is never reused after the TTL).
// It reuses gatewayProvider (same request shapes, error mapping, size caps) through a Fetcher that rewrites the URL and swaps the auth headers.
// Prefix-less model ids route here for team scopes (registry.ts). The model list is the team gateway's own DB-driven catalog (/v1/models: kind, price,
// capabilities, already filtered by the user's features); nothing here lists model ids. Video goes through POST /v1/videos, gated by video_gen.
import { gatewayProvider } from "./gateway";
import { ProviderError, type ModelKind, type ModelProvider } from "./types";

export interface TeamEnv {
  TEAM_GATEWAY_URL?: string;
  /** Worker secret, caller `vertex-client-team` on the team gateway. Only ever sent as the Authorization header; never logged or returned. */
  VCLIENT_TEAM_CALLER_KEY?: string;
  /** Optional service binding to the team gateway (a workers.dev gateway cannot be fetched worker-to-worker over its public URL). */
  TEAM_GATEWAY?: { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export const teamConfigured = (env: TeamEnv) => !!env.TEAM_GATEWAY_URL && !!env.VCLIENT_TEAM_CALLER_KEY;

export const FEATURE_APP = "vclient_app", FEATURE_CHAT = "chat", FEATURE_IMAGE = "image_gen", FEATURE_VIDEO = "video_gen";
export const ENTITLEMENT_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const EMAIL = /^[^\s@,<>"']{1,64}@[^\s@,<>"']{1,255}$/;

type Fetch = typeof fetch;
const cache = new Map<string, { at: number; features: string[] }>();
/** Test hook. */
export const clearEntitlementCache = () => cache.clear();

function actAsFetcher(env: TeamEnv, email: string, fetchImpl?: Fetch) {
  const base = (env.TEAM_GATEWAY_URL ?? "").replace(/\/+$/, "");
  return {
    fetch(input: string, init: RequestInit = {}): Promise<Response> {
      if (!base || !env.VCLIENT_TEAM_CALLER_KEY) return Promise.reject(new ProviderError("team gateway not configured", 503));
      if (!EMAIL.test(email)) return Promise.reject(new ProviderError("bad team user", 403));
      const u = new URL(input);
      const h = new Headers(init.headers);
      h.delete("x-api-key"); // gatewayProvider's own header: never sent to the team gateway
      h.set("authorization", `Bearer ${env.VCLIENT_TEAM_CALLER_KEY}`);
      h.set("x-act-as", email);
      const f = env.TEAM_GATEWAY ? (url: string, i: RequestInit) => env.TEAM_GATEWAY!.fetch(url, i) : (url: string, i: RequestInit) => (fetchImpl ?? fetch)(url, i);
      return f(base + u.pathname + u.search, { ...init, headers: h });
    },
  };
}

/** The act-as fetcher for raw passthrough (the vcl bridge): same caller key + x-act-as, x-api-key stripped. */
export const teamActAsFetcher = actAsFetcher;

/** Features the gateway currently grants this email. Cached <= 60 s on success only. Throws ProviderError(503) when the gateway cannot answer. */
export async function teamFeatures(env: TeamEnv, email: string, fetchImpl?: Fetch, now: () => number = Date.now): Promise<string[]> {
  const hit = cache.get(email);
  if (hit && now() - hit.at < ENTITLEMENT_TTL_MS) return hit.features;
  cache.delete(email); // expired: never serve it again
  const unavailable = () => new ProviderError("The team gateway is unavailable. Try again shortly.", 503, { type: "api_error", retryable: false });
  let res: Response;
  try {
    res = await actAsFetcher(env, email, fetchImpl).fetch("https://gateway.internal/v1/entitlements", { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) { if (e instanceof ProviderError && e.status !== 503) throw e; throw unavailable(); }
  if (res.status === 401 || res.status === 403 || res.status === 404) { void res.body?.cancel().catch(() => {}); return []; } // refused: no features (not cached)
  if (!res.ok) { void res.body?.cancel().catch(() => {}); throw unavailable(); }
  const body = (await res.json().catch(() => null)) as { features?: unknown } | null;
  if (!body || !Array.isArray(body.features)) throw unavailable();
  const features = body.features.filter((f): f is string => typeof f === "string");
  if (cache.size > 500) cache.clear();
  cache.set(email, { at: now(), features });
  return features;
}

export async function requireFeature(env: TeamEnv, email: string, feature: string, fetchImpl?: Fetch, now?: () => number): Promise<void> {
  const f = await teamFeatures(env, email, fetchImpl, now);
  if (!f.includes(FEATURE_APP) || !f.includes(feature)) throw new ProviderError("Your team account does not have access to this feature.", 403, { type: "permission_error" });
}

const titleCase = (id: string) => id.split("-").map((w) => (w === "gemini" ? "Gemini" : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
/** The team gateway's catalog says what each entry is (`kind`, `capabilities`). Embeddings are never listed. A chat model the gateway marks `messages_api: false`
 *  (served on /v1/chat/completions only) is hidden because the app talks /v1/messages. Against an older gateway that sends no kind/capabilities the ids are
 *  classified as before (`-image` => image, `gemini-*` chat => hidden). */
export function classifyTeamModel(m: { id?: string; kind?: string; display_name?: string; capabilities?: { messages_api?: boolean } | null }): typeof m | null {
  const id = typeof m.id === "string" ? m.id : "";
  if (!id || m.kind === "embedding" || (m.kind === undefined && /embedding/i.test(id))) return null;
  const kind = m.kind ?? (/-image\b/.test(id) ? "image" : "chat");
  if (kind === "chat") {
    const api = m.capabilities && typeof m.capabilities === "object" ? m.capabilities.messages_api : undefined;
    if (api === false || (api === undefined && /^gemini-/i.test(id))) return null;
  }
  return { ...m, kind, display_name: m.display_name ?? titleCase(id) };
}

const NOT_ENABLED: Record<string, string> = {
  [FEATURE_IMAGE]: "Image generation is not enabled for your account. Ask an admin to turn it on.",
  [FEATURE_VIDEO]: "Video generation is not enabled for your account. Ask an admin to turn it on.",
};
/** Shown when the feature is on but the team catalog currently offers no model of the kind (admin disabled them or withdrew the permission). */
export const NO_MODELS: Record<"image" | "video", string> = {
  image: "No image models are enabled for the team right now. Ask an admin to turn one on.",
  video: "No video models are enabled for the team right now. Ask an admin to turn one on.",
};
export function teamGatewayProvider(env: TeamEnv, email: string, fetchImpl?: Fetch): ModelProvider {
  const base = gatewayProvider(actAsFetcher(env, email, fetchImpl) as never, env.VCLIENT_TEAM_CALLER_KEY ?? "", classifyTeamModel);
  // A feature that is off is a clear 403 with its own message (the UI shows it instead of an empty picker); the gateway re-checks on every call anyway.
  const need = async (f: string) => {
    try { await requireFeature(env, email, f, fetchImpl); }
    catch (e) { if (e instanceof ProviderError && e.status === 403 && NOT_ENABLED[f]) throw new ProviderError(NOT_ENABLED[f], 403, { type: "feature_not_enabled" }); throw e; }
  };
  return {
    name: "team-gateway", id: "gateway",
    async listModels(kind?: ModelKind) {
      await need(kind === "image" ? FEATURE_IMAGE : kind === "video" ? FEATURE_VIDEO : FEATURE_CHAT);
      const list = await base.listModels(kind);
      // The user holds the feature but an admin has switched every model of that kind off in the catalog: say so plainly instead of an empty picker.
      if (!list.length && (kind === "image" || kind === "video")) throw new ProviderError(NO_MODELS[kind], 403, { type: "models_not_enabled" });
      return list;
    },
    async messages(body, signal) { await need(FEATURE_CHAT); return base.messages(body, signal); },
    async image(req, signal) { await need(FEATURE_IMAGE); return base.image!(req, signal); },
    async video(req, signal) { await need(FEATURE_VIDEO); return base.video!(req, signal); },
  };
}
