import type { GatewayPrice } from "../../src/providers/types";
import { clearPaneCache } from "./pane-cache";
import { dropMe } from "./me-cache";
import { libQuery } from "./library-logic";
import { getSpace, handleSpaceStatus, spaceHeaders, withSpaceQuery } from "./space";
export type ModelMeta = { label: string; vendor: string; tier: string; price: { input: number; output: number } | null; caps: { images: boolean; caching: boolean; thinking: boolean; tools: boolean } } | null;
export type Capabilities = { text: boolean; vision: boolean; tools: boolean; "image-gen": boolean; "video-gen": boolean; reasoning: boolean };
/** `provider` / `capabilities` are absent only from an older server: treat as gateway / meta-derived. */
export type Model = { id: string; name: string; meta: ModelMeta; provider?: string; capabilities?: Capabilities; /** shown instead of the id in the picker (the Auto entry) */ description?: string; /** measured speed tier + typical timings (server-side, unknown below ~5 samples) */ speed?: import("./model-speed").ModelSpeed; /** $/Mtok ESTIMATE, only when a priced source is known */ priceEstimate?: import("./model-speed").PriceEstimate | null; /** free-tier limits (estimates) / history is trimmed to a per-minute token budget / very small daily quota (never the default) / persistent provider data-use warning (vi + en) */ limits?: { rpm?: number; rpd?: number; tpm?: number; tpd?: number } | null; shortContext?: boolean; limited?: boolean; dataWarning?: { vi: string; en: string } | null };
export type ProviderInfo = { id: string; kind: string; enabled: boolean; status: "enabled" | "off" | "needs-key"; modelCount: number; editable?: boolean; presetOnly?: boolean; keySet?: boolean; key_source?: "user" | "stale" | "worker" | "none"; authHeader?: string; host?: string; enabledModels?: string[]; broken?: string[]; /** built-in provider whose models are the catalog only (key only: no model ticking, not removable) */ catalogOnly?: boolean; dataWarning?: { vi: string; en: string } };
export type ProviderPreset = { key: string; label: string; id: string; baseUrl: string; authHeader: string; /** name of the Worker secret (never a value) */ secret: string; help: string; warning?: { vi: string; en: string } };
export type ListedModel = { id: string; enabled: boolean; broken: boolean; suggested: boolean; verified?: boolean };
export const getProviderPresets = () => call<{ presets: ProviderPreset[] }>("/api/providers/presets");
/** Create/update a provider row (no key here: see putProviderKey, or an admin-provisioned Worker secret). */
export const putProvider = (id: string, b: { baseUrl?: string; authHeader?: string; enabled?: boolean; models?: string[] }) => call<{ provider?: unknown; error?: string }>(`/api/providers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(b) });
export const deleteProvider = (id: string) => call<{ ok?: boolean; error?: string }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
export const loadProviderModels = (id: string) => call<{ models?: ListedModel[]; error?: string }>(`/api/providers/${encodeURIComponent(id)}/models`, { method: "POST", body: "{}" });
/** The key is sent once in the request body and is never returned; callers must not keep it. */
export const putProviderKey = (id: string, key: string) => call<{ ok?: boolean; key_source?: "user" | "stale" | "worker" | "none"; error?: string }>(`/api/providers/${encodeURIComponent(id)}/key`, { method: "PUT", body: JSON.stringify({ key }) });
export const deleteProviderKey = (id: string) => call<{ ok?: boolean; key_source?: "user" | "stale" | "worker" | "none"; error?: string }>(`/api/providers/${encodeURIComponent(id)}/key`, { method: "DELETE" });
/** The Open space's list (that is where the provider configs live), whichever space the app is in; if Open is not available, the plain list as before. */
export const getProviders = async () => { const r = await call<{ providers: ProviderInfo[]; error?: string }>("/api/providers", { headers: { "x-vc-space": "open" } }); return r.status === 403 ? call<{ providers: ProviderInfo[]; error?: string }>("/api/providers") : r; };
export type Me = { user: string; via: string; csrf: string; defaultModel: string; /** true only for scopes that may use cloud/agents/desktop/remote (main, e2e); absent/false hides them (fail closed) */ erichOnly?: boolean; /** true for a team-gateway (g:*) session: Erich-only modes and pages are hidden, not dead links (the server 403s them regardless) */ team?: boolean; /** spaces this user may use: absent from an older server = Business only */ spaces?: Array<"biz" | "open">; /** the space this request resolved to */ space?: "biz" | "open" };
export type AuthConfig = { github: boolean; /** email-first dev login enabled */ emailStep?: boolean; sso?: boolean; /** team instance: the "Sign in with team gateway" button is shown only when true */ team?: boolean };

let csrf = "";
export const setCsrf = (t: string) => { csrf = t; clearPaneCache(); }; // a new session token = a possibly different user: nothing cached may carry over

export async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; data: T | null; retryAfter?: number }> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (method !== "GET") { headers.set("x-csrf-token", csrf); headers.set("content-type", "application/json"); }
  for (const [k, v] of Object.entries(spaceHeaders())) headers.set(k, v);
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const data = (await res.json().catch(() => null)) as T | null;
  handleSpaceStatus(res.status, data);
  if (res.status === 401) dropMe(); // any 401 = the session is gone: the offline identity cache must not outlive it
  const ra = Number(res.headers.get("retry-after")); // seconds; the pairing endpoint sends its whole window (600), so treat it as "up to"
  return { status: res.status, data, ...(Number.isFinite(ra) && ra > 0 ? { retryAfter: ra } : {}) };
}

export const getMe = () => call<Me>("/api/me");
export const getModels = () => call<{ default: string; models: Model[]; providerNotices?: Record<string, string>; error?: string }>("/api/models");
export const devLoginCheck = (email: string) => call<{ password?: boolean }>("/auth/dev-login/check", { method: "POST", body: JSON.stringify({ email }) });
export const devLoginPost = (email: string, password: string) => call<{ ok?: boolean }>("/auth/dev-login", { method: "POST", body: JSON.stringify({ email, password }) });
export const getAuthConfig = () => call<AuthConfig>("/auth/config");
export const logout = () => { clearPaneCache(); return call<{ ok: boolean; ssoLogout?: string | null }>("/auth/logout", { method: "POST", body: "{}" }); };

import type { SlashItem } from "../../src/slash";
import type { VideoParams } from "./video-opts";
export type GenModel = { id: string; name: string; perImage: number | null; priceVerified: boolean; price?: GatewayPrice | null; params?: VideoParams | null };
export const getGenModels = () => call<{ kind: string; confirmUsd: number; models: GenModel[]; error?: string }>("/api/gen/models?kind=image");
export type VideoModel = { id: string; name: string; params: VideoParams; priced: boolean; priceVerified: boolean; price?: GatewayPrice | null };
export const getVideoModels = () => call<{ kind: string; confirmUsd: number; models: VideoModel[]; error?: string }>("/api/gen/models?kind=video");
export type ProfileData = { fullName: string; nickname: string; instructions: string };
export const getChatImages = () => call<{ enabled: boolean; available: boolean }>("/api/settings/chat-images");
export const getOpenFailover = () => call<{ enabled: boolean }>("/api/settings/open-failover");
export const putOpenFailover = (enabled: boolean) => call<{ enabled?: boolean; error?: string }>("/api/settings/open-failover", { method: "PUT", body: JSON.stringify({ enabled }) });
export const getOpenFailoverAistudio = () => call<{ enabled: boolean; available?: boolean }>("/api/settings/open-failover-aistudio");
export const putOpenFailoverAistudio = (enabled: boolean) => call<{ enabled?: boolean; error?: string }>("/api/settings/open-failover-aistudio", { method: "PUT", body: JSON.stringify({ enabled }) });
export const getAnswerLimit = () => call<{ limit: "off" | "default"; default: "off" | "default" }>("/api/settings/answer-limit");
export const putAnswerLimit = (limit: "off" | "default") => call<{ limit?: "off" | "default"; error?: string }>("/api/settings/answer-limit", { method: "PUT", body: JSON.stringify({ limit }) });
export const getAutoDelegate = () => call<{ enabled: boolean }>("/api/settings/auto-delegate");
export const putAutoDelegate = (enabled: boolean) => call<{ enabled?: boolean; error?: string }>("/api/settings/auto-delegate", { method: "PUT", body: JSON.stringify({ enabled }) });
export const getAutoShadow = () => call<{ enabled: boolean }>("/api/settings/auto-shadow");
export const getAutoMaxUsd = () => call<{ usd: number | null }>("/api/settings/auto-max-usd");
export const putAutoMaxUsd = (usd: number | null) => call<{ usd?: number | null; error?: string }>("/api/settings/auto-max-usd", { method: "PUT", body: JSON.stringify({ usd }) });
export const putAutoShadow = (enabled: boolean) => call<{ enabled?: boolean; error?: string }>("/api/settings/auto-shadow", { method: "PUT", body: JSON.stringify({ enabled }) });
export const putChatImages = (enabled: boolean) => call<{ enabled?: boolean; error?: string }>("/api/settings/chat-images", { method: "PUT", body: JSON.stringify({ enabled }) });
export const getProfile = () => call<ProfileData>("/api/profile");
export const putProfile = (p: Partial<ProfileData>) => call<ProfileData & { error?: string }>("/api/profile", { method: "PUT", body: JSON.stringify(p) });
export const getSlash = () => call<{ items: SlashItem[] }>("/api/slash");

import type { ServerState } from "./chat-state";
export type Uploaded = { ref: string; name: string; mime: string; size: number; kind?: string; tokens?: number };
/** URL of the preview endpoint for one attachment (cookie-authed GET). */
export const fileUrl = (convId: string, ref: string) => withSpaceQuery(`/api/conversations/${convId}/files/${ref.split("/").slice(2).map(encodeURIComponent).join("/")}`);
export async function uploadFile(convId: string, blob: Blob, name: string): Promise<{ ok: true; file: Uploaded } | { ok: false; error: string }> {
  const res = await fetch(`/api/conversations/${convId}/files?name=${encodeURIComponent(name)}`, { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": csrf, "content-type": blob.type, ...spaceHeaders() }, body: blob });
  const j = (await res.json().catch(() => null)) as (Uploaded & { error?: string }) | null;
  handleSpaceStatus(res.status, j);
  return res.ok && j ? { ok: true, file: j } : { ok: false, error: j?.error ?? `upload failed (${res.status})` };
}
export type ConvRow = { id: string; title: string; model: string; pinned: number; costUsd: number; tokens: number; projectId?: string | null; createdAt: string; updatedAt: string; /** semantic-only hit: where it matched */ match?: "semantic"; snippet?: string };
export const listConversations = (q = "") => call<{ conversations: ConvRow[] }>(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`);
export const listProjectConversations = (projectId: string) => call<{ conversations: ConvRow[] }>(`/api/conversations?project=${encodeURIComponent(projectId)}`);
export const createConversation = (model?: string, projectId?: string | null, env?: { device_id: string; dir?: string | null } | null) => call<{ id: string }>("/api/conversations", { method: "POST", body: JSON.stringify({ model, ...(projectId ? { project_id: projectId } : {}), ...(env ? { env: { kind: "device", device_id: env.device_id, ...(env.dir ? { dir: env.dir } : {}) } } : {}) }) });
export const moveConversation = (id: string, projectId: string | null) => call<{ ok?: boolean; error?: string }>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ project_id: projectId }) });

export type PromptRow = { id: string; title: string; text: string; createdAt: string; updatedAt: string };
export const listPrompts = () => call<{ prompts: PromptRow[] }>("/api/prompts");
export const createPrompt = (b: { title: string; text: string }) => call<PromptRow & { error?: string }>("/api/prompts", { method: "POST", body: JSON.stringify(b) });
export const updatePrompt = (id: string, b: { title?: string; text?: string }) => call<PromptRow & { error?: string }>(`/api/prompts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(b) });
export const deletePrompt = (id: string) => call<{ ok?: boolean; error?: string }>(`/api/prompts/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
export type ProjectRow = { id: string; name: string; instructions: string; createdAt: string; updatedAt: string; chatCount: number };
export const listProjects = () => call<{ projects: ProjectRow[] }>("/api/projects");
export const getProject = (id: string) => call<ProjectRow & { error?: string }>(`/api/projects/${encodeURIComponent(id)}`);
export const createProject = (b: { name: string; instructions?: string }) => call<ProjectRow & { error?: string }>("/api/projects", { method: "POST", body: JSON.stringify(b) });
export const updateProject = (id: string, b: { name?: string; instructions?: string }) => call<ProjectRow & { error?: string }>(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(b) });
export const deleteProject = (id: string) => call<{ ok?: boolean; error?: string }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
export const getConversation = (id: string) => call<{ conversation: ConvRow; state: ServerState; /** Devices v2 step 3: present only for a chat bound to a device */ env?: import("./chat-env-logic").EnvInfo }>(`/api/conversations/${id}`);
export const deleteConversation = (id: string) => call<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE", body: "{}" });
export const pinConversation = (id: string, pinned: boolean) => call<{ ok: boolean }>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ pinned }) });
export const renameConversation = (id: string, title: string) => call<{ ok: boolean }>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });

export type Totals = { units: number; calls: number; costUsd: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; cacheHit: number | null; unratedCalls: number };
export type Group = Totals & { key: string };
export type Period = { total: Totals; byMode: Group[]; byModel: Group[]; gen: Group[] };
export type Reconcile = { at: string; since: string; client: Record<string, number>; gateway: Record<string, number>; drift: Record<string, number>; note?: string };
export type UsageReport = {
  asOf: number; tz: number; today: Period; month: Period; daily: Array<{ day: string; costUsd: number; tokens: number }>;
  topConversations: Array<{ id: string; title: string; costUsd: number; tokens: number; calls: number }>; reconcile: Reconcile | null;
  /** last 30 days, by how the model was chosen; absent from an older server */
  byRoute?: Array<{ model: string; routedModel: string | null; routedBy: string; n: number }>;
};
export const getUsage = () => call<UsageReport>(`/api/usage?tz=${-new Date().getTimezoneOffset()}`);

export type SkillRow = { id: string; name: string; description: string; template: string; tools: string[]; createdAt: string; updatedAt: string };
export type SkillBody = { name: string; description: string; template: string };
export type PersonaRow = { id: string; name: string; description: string; prompt: string; model: string; tools: string[]; maxTokens: number; effort: "low" | "medium" | "high" | null; contextMode: "task" | "conversation"; autoUse: boolean; createdAt: string; updatedAt: string };
export type PersonaBody = { name: string; description: string; prompt: string; model: string; tools: string[]; maxTokens: number; effort: "low" | "medium" | "high" | null; contextMode: "task" | "conversation"; autoUse: boolean };
export const listPersonas = () => call<{ personas: PersonaRow[] }>("/api/personas");
export const createPersona = (b: PersonaBody) => call<{ persona?: PersonaRow; error?: string }>("/api/personas", { method: "POST", body: JSON.stringify(b) });
export const updatePersona = (id: string, b: PersonaBody) => call<{ persona?: PersonaRow; error?: string }>(`/api/personas/${id}`, { method: "PATCH", body: JSON.stringify(b) });
export const deletePersona = (id: string) => call<{ ok?: boolean; error?: string }>(`/api/personas/${id}`, { method: "DELETE", body: "{}" });
export const listSkills = () => call<{ skills: SkillRow[] }>("/api/skills");
export const createSkill = (b: SkillBody) => call<{ skill?: SkillRow; error?: string }>("/api/skills", { method: "POST", body: JSON.stringify(b) });
export const updateSkill = (id: string, b: SkillBody) => call<{ skill?: SkillRow; error?: string }>(`/api/skills/${id}`, { method: "PATCH", body: JSON.stringify(b) });
export const deleteSkill = (id: string) => call<{ ok?: boolean; error?: string }>(`/api/skills/${id}`, { method: "DELETE", body: "{}" });

export type ConnectorMode = "always" | "ask" | "block";
export type ConnectorTool = { name: string; description: string; approval: boolean; enabled: boolean; mode: ConnectorMode; canAlways: boolean; changed?: boolean };
export type AuthKind = "none" | "bearer" | "header";
export type ConnectorRow = { id: string; name: string; kind: "internal-binding" | "remote-mcp"; url?: string; authKind?: AuthKind; authHeaderName?: string | null; hasToken?: boolean;
  status: "ok" | "unreachable"; error?: string; enabled: boolean; toolCount: number | null; enabledCount: number; tools: ConnectorTool[] };
export type ConnectorPut = { enabled?: boolean; tool?: { name: string; mode: ConnectorMode } };
export type NewConnector = { name: string; url: string; authKind: AuthKind; headerName?: string; token?: string };
export const getConnectors = () => call<{ connectors: ConnectorRow[]; error?: string }>("/api/connectors");
export const putConnector = (id: string, b: ConnectorPut) => call<{ ok?: boolean; error?: string }>(`/api/connectors/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(b) });
export const getConnector = (id: string) => call<{ connector: ConnectorRow; error?: string }>(`/api/connectors/${encodeURIComponent(id)}`);
export const postConnector = (b: NewConnector) => call<{ connector?: ConnectorRow; error?: string }>("/api/connectors", { method: "POST", body: JSON.stringify(b) });
export const deleteConnector = (id: string) => call<{ ok?: boolean; error?: string }>(`/api/connectors/${encodeURIComponent(id)}`, { method: "DELETE" });

export type ArtifactType = "markdown" | "code" | "svg" | "html";
export type ArtifactRow = { id: string; title: string; type: ArtifactType; language: string | null; version: number; bytes: number; createdAt: string; updatedAt: string; preview: string };
export type ArtifactFull = Omit<ArtifactRow, "preview"> & { shown: number; content: string; versions: Array<{ version: number; bytes: number; createdAt: string }> };
export const listArtifacts = (q = "", cursor = "", deleted = false) => call<{ items: ArtifactRow[]; next: string | null; error?: string }>(`/api/artifacts?q=${encodeURIComponent(q)}${deleted ? "&deleted=1" : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
export const getArtifact = (id: string, v?: number) => call<ArtifactFull & { error?: string }>(`/api/artifacts/${encodeURIComponent(id)}${v ? `?v=${v}` : ""}`);
export const deleteArtifact = (id: string) => call<{ ok?: boolean; error?: string }>(`/api/artifacts/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
export const undeleteArtifact = (id: string) => call<{ ok?: boolean; error?: string }>(`/api/artifacts/${encodeURIComponent(id)}/undelete`, { method: "POST", body: "{}" });
export const viewArtifact = (id: string, version: number) => call<{ url?: string; expiresAt?: number; error?: string }>(`/api/artifacts/${encodeURIComponent(id)}/view`, { method: "POST", body: JSON.stringify({ version }) });
export const restoreArtifact = (id: string, version: number) => call<{ version?: number; error?: string }>(`/api/artifacts/${encodeURIComponent(id)}/restore`, { method: "POST", body: JSON.stringify({ version }) });

export type LibraryPage = { items: import("./library-logic").LibItem[]; next: string | null; error?: string };
export const getLibrary = (type: "" | "image" | "video", before: string | null) => call<LibraryPage>(libQuery(type, before));

/** "Edit an earlier message": forks the transcript before that user message into a NEW conversation (the original stays as it is). */
export const forkConversation = (id: string, messageId: number) => call<{ id?: string; model?: string; error?: string }>(`/api/conversations/${id}/fork`, { method: "POST", body: JSON.stringify({ message_id: messageId }) });

/** POST the recording to /api/transcribe (nothing is stored server-side). `lang` is the Dictation setting ("" = auto). status 0 = the request never reached the server. */
export async function transcribeAudio(blob: Blob, lang: string, signal?: AbortSignal): Promise<{ status: number; text?: string; code?: string }> {
  try {
    const res = await fetch(`/api/transcribe${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`, { method: "POST", credentials: "same-origin", signal, headers: { "x-csrf-token": csrf, "content-type": blob.type || "audio/mp4", ...spaceHeaders() }, body: blob });
    const j = (await res.json().catch(() => null)) as { text?: string; code?: string; error?: string } | null;
    handleSpaceStatus(res.status, j);
    return { status: res.status, text: j?.text, code: j?.code };
  } catch { return { status: 0 }; }
}

// ---- Settings > Cloudflare: the caller's OWN Cloudflare account (the token is sent once, never returned: only its last 4 characters) ----
export type CfScope = { feature: string; permission: string; used_for: string };
export type CfAccountView = { using: "shared" | "own" | "broken"; token_last4?: string; account_last4?: string; storage: boolean; origin: string; scopes: CfScope[]; ok?: boolean; error?: string };
export const getCfAccount = () => call<CfAccountView>("/api/cloudflare/account");
export const putCfAccount = (accountId: string, token: string) => call<CfAccountView>("/api/cloudflare/account", { method: "PUT", body: JSON.stringify({ accountId, token }) });
export const deleteCfAccount = () => call<CfAccountView>("/api/cloudflare/account", { method: "DELETE" });
export const testCfAccount = () => call<{ ok: boolean; detail?: string; error?: string }>("/api/cloudflare/account/test", { method: "POST", body: "{}" });

// ---- Settings > Approvals: the caller's "always allow this domain" list (grants are created only from an approval card, never from here) ----
export type ApprovalsView = { autoAllowed: boolean; grants: Array<{ tool: string; host: string; createdAt: number; lastUsedAt: number | null }>; audit: Array<{ tool: string; host: string; source: string; at: number; conversationId: string }> };
export const getApprovals = () => call<ApprovalsView>("/api/approvals");
export const revokeApproval = (host: string) => call<{ ok?: boolean; error?: string }>(`/api/approvals/grants/${encodeURIComponent(host)}`, { method: "DELETE" });
export const revokeAllApprovals = () => call<{ ok?: boolean; error?: string }>("/api/approvals/grants", { method: "DELETE" });
