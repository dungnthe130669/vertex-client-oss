// Provider DESCRIPTOR: one typed record that says everything the platform needs to know about a provider besides its model list (which is data: catalog.ts).
// The registry (`DESCRIPTORS`) holds the built-in ones; adapters stay keyed by protocol. A descriptor is declarative: it never carries a secret, only NAMES an auth style.
// It must be able to express a provider like Groq (reasoning policy per model, parameter deny-list, max_completion_tokens, non-chat filter): see test/provider-descriptor.test.ts.
import type { Capabilities } from "./types";

/** Wire protocol the adapter speaks. `cloudflare-binding` / `gateway` / `stub` are the non-HTTP kinds. */
export type Protocol = "openai" | "anthropic" | "gemini-native" | "cloudflare-binding" | "gateway" | "stub";
export type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key" | `custom:${string}`;
/** user = only a key the user stored; worker = only the operator's Worker secret (preset origin only); user-or-worker = either (a stored key wins). */
export type KeyMode = "user" | "worker" | "user-or-worker" | "none";
export type Space = "open" | "biz";

/** Plain-substring rule for model discovery (no stored regex: bounded, no ReDoS). Case-insensitive. */
export interface DiscoveryRule { contains: string; kind: "skip" | "image" | "chat" }
/** How a provider reports reasoning. `field`: separate response field; `think-tags`: <think> in content; `none`. */
export interface ReasoningPolicy {
  control: "none" | "effort" | "budget";
  /** allowed effort values, when control = effort (per-model values live in the model row's extra_json) */
  effortValues?: string[];
  field?: "reasoning" | "reasoning_content" | "think-tags" | "none";
  /** a request parameter that selects how reasoning comes back (Groq `reasoning_format`); some models reject it, so the model row may override */
  formatParam?: { name: string; value: string };
}
export interface ChatDialect {
  /** `max_tokens` (OpenAI classic) or `max_completion_tokens` (Groq, newer OpenAI). */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /** request fields the provider rejects: stripped before sending (e.g. logprobs, logit_bias, messages[].name). */
  paramDenylist: string[];
  reasoning: ReasoningPolicy;
  /** false = never send parallel tool calls (per-model override in the row). */
  parallelTools: boolean;
  /** provider-side built-in tools exist: they must never be enabled by us. */
  builtinToolsNever?: boolean;
  /** Rate-limit handling. A 429 is retried in-turn at most ONCE, and only when the provider's own hint (retry-after header or "try again in Xs" in the body) is <= maxInlineWaitMs;
   *  a longer hint is shown to the user instead. A 413 is a plain "too large" error and is never retried (the provider's retry-after on a 413 is misleading). */
  rateLimit?: { maxInlineWaitMs: number; tooLarge: string; limited: string };
  /** Text-only models reject array `content`: send text parts as one string. */
  flattenTextContent?: boolean;
}
export interface ProviderDescriptor {
  id: string; label: string; protocol: Protocol;
  baseUrl?: string; authStyle: AuthStyle; keyMode: KeyMode;
  /** `open` for every non-Vertex provider (Business lists only the gateway); enforced in code, stored as data. */
  space: Space;
  /** provider-level declared defaults (the model row refines them) */
  capabilities: Partial<Capabilities>;
  /** informational, shown in the UI: never used to throttle */
  limits?: { rpm?: number; rpd?: number; tpm?: number; tpd?: number; note?: string };
  /** Persistent data-use notice the UI shows for this provider in Open (neutral wording; say plainly what is NOT known). Never a promise. */
  dataUseNotice?: string;
  dialect?: ChatDialect;
  /** model kinds this provider can serve (a kind with no adapter path is never listed) */
  kinds: Array<"chat" | "image" | "video">;
  discovery?: DiscoveryRule[];
  /** persistent warning (vi + en) the UI shows wherever this provider's models are used, e.g. free-tier content is read by the vendor */
  dataWarning?: { vi: string; en: string };
  /** Built-in preset whose origin, catalog and default models are fixed: a stored provider_configs row can only switch it on/off, never replace it (NVIDIA is not locked: its row may carry an edited origin under its own rules). */
  locked?: boolean;
}

export const OPENAI_DIALECT: ChatDialect = { maxTokensParam: "max_tokens", paramDenylist: [], reasoning: { control: "none", field: "none" }, parallelTools: true };

/** Ids that are not chat models (embeddings, rerankers, guards, vision-only encoders, speech, diffusion): never offered for ticking. Same set the old NOT_CHAT regex held. */
export const NVIDIA_DISCOVERY: DiscoveryRule[] = ["embed", "rerank", "reward", "guard", "safety", "retriev", "parse", "ocr", "clip", "-vlm-encoder", "-vlmencoder", "riva", "tts", "asr", "translate", "segment", "diffusion", "flux", "sdxl"]
  .map((contains) => ({ contains, kind: "skip" as const }));

export const NVIDIA_DESCRIPTOR: ProviderDescriptor = {
  id: "nvidia", label: "NVIDIA NIM", protocol: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", authStyle: "bearer", keyMode: "user-or-worker", space: "open",
  capabilities: { text: true }, limits: { rpm: 40, note: "free-preview models only; the catalog lists many ids that answer 404" },
  dialect: OPENAI_DIALECT, kinds: ["chat", "image"], discovery: NVIDIA_DISCOVERY,
};
/** Groq (api.groq.com/openai/v1, Bearer; OpenAI-compatible, reuses the openai adapter). Open only: the user brings their own key (encrypted in-app, like NVIDIA); never Business.
 *  Measured size of an Open chat's fixed prefix (SYSTEM_PROMPT_OPEN + the 6 Open tool defs: 4 Cloudflare + 2 artifact tools), LIVE 2026-10-26 through this adapter, Groq's own prompt_tokens:
 *  1545 tokens on gpt-oss-20b (~7.1 KB JSON), 2105 on qwen3.8-27b (delegate prompt variant, ~7.8 KB). That is ~19-26% of the 8K tokens/minute free budget before history and the requested output
 *  (our pre-call estimate is chars/3, ~2.4K: deliberately pessimistic). So Groq free IS usable with tools: ~5.9-6.5K tokens remain for history + output, ~3.4-4K for history after the 2500 output cap. docs/provider-groq.md.
 *  but a long chat only fits because history is trimmed (chat-budget.ts). Free-tier limits are per model per ORG (docs/reference/free-tier-limits-2026-10-26.md). */
export const GROQ_DESCRIPTOR: ProviderDescriptor = {
  id: "groq", label: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", authStyle: "bearer", keyMode: "user", space: "open", locked: true,
  capabilities: { text: true }, limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000, note: "free tier, per model per organization; 8K tokens/minute is the binding limit" },
  dataUseNotice: "Your messages are sent to Groq. Whether Groq may use data from free accounts to train models is not stated in the pages we checked (unverified); do not send anything you would not want a third party to see.",
  dialect: {
    maxTokensParam: "max_completion_tokens",
    // logprobs and n>1 are 400 on Groq; logit_bias/top_logprobs are not offered either
    paramDenylist: ["logprobs", "top_logprobs", "logit_bias", "n"],
    // gpt-oss: `delta.reasoning` (+ an ignorable `channel`), effort low|medium|high; qwen3.8 reasons only when asked. Per-model values live in the row's extra_json. reasoning_format is not needed (and is not sent).
    reasoning: { control: "effort", effortValues: ["low", "medium", "high"], field: "reasoning" },
    parallelTools: true, // per model: gpt-oss rows carry parallelTools=false (one call per turn)
    builtinToolsNever: true, // browser_search / code_interpreter style tools are never sent
    rateLimit: { maxInlineWaitMs: 5000, tooLarge: "This chat is too large for this model's per-minute limit (Groq free tier, about 8K tokens/minute). Start a new chat, shorten it, or pick another model.", limited: "Groq's free limit for this model was reached" },
    flattenTextContent: true,
  },
  kinds: ["chat"],
  // not chat models: speech (whisper, later), TTS (orpheus), classifiers (prompt-guard, safeguard), allam (4K context)
  discovery: ["whisper", "orpheus", "guard", "safeguard", "allam", "tts"].map((contains) => ({ contains, kind: "skip" as const })),
};
export const CLOUDFLARE_DESCRIPTOR: ProviderDescriptor = {
  id: "cloudflare", label: "Cloudflare Workers AI", protocol: "cloudflare-binding", authStyle: "bearer", keyMode: "none", space: "open",
  capabilities: { text: true }, dialect: OPENAI_DIALECT, kinds: ["chat", "image"],
};
/** Google AI Studio (Gemini API), NATIVE protocol (streamGenerateContent). Free tier: the user's own key only, Open only. Built-in tools (Google Search grounding, code execution) are never enabled. */
export const AISTUDIO_DISCOVERY: DiscoveryRule[] = ["tts", "image", "lyria", "embed", "transcribe", "computer-use", "deep-research", "robotics", "antigravity", "live", "native-audio", "veo", "imagen", "aqa", "omni", "nano-banana"]
  .map((contains) => ({ contains, kind: "skip" as const }));
export const AISTUDIO_DESCRIPTOR: ProviderDescriptor = {
  id: "aistudio", label: "Google AI Studio", protocol: "gemini-native", baseUrl: "https://generativelanguage.googleapis.com/v1beta", authStyle: "x-goog-api-key", keyMode: "user", space: "open", locked: true,
  capabilities: { text: true }, limits: { note: "free tier, per model and per project; see each model's limits" },
  dialect: { maxTokensParam: "max_tokens", paramDenylist: [], reasoning: { control: "budget", field: "none" }, parallelTools: true, builtinToolsNever: true },
  kinds: ["chat"], discovery: AISTUDIO_DISCOVERY,
  dataUseNotice: "Open mode uses Google's free AI Studio tier: Google may read and use your conversations to improve its products. Do not send personal, secret or confidential content.",
  dataWarning: { vi: "Chế độ Mở dùng Google AI Studio miễn phí: Google có thể đọc và dùng nội dung hội thoại để cải thiện sản phẩm. Đừng gửi thông tin cá nhân, mật khẩu hay tài liệu mật.", en: "Open mode uses Google's free AI Studio tier: Google may read and use your conversations to improve its products. Do not send personal, secret or confidential content." },
};
export const GATEWAY_DESCRIPTOR: ProviderDescriptor = { id: "gateway", label: "Vertex (Claude)", protocol: "gateway", authStyle: "bearer", keyMode: "none", space: "biz", capabilities: { text: true }, kinds: ["chat", "image", "video"] };
export const STUB_DESCRIPTOR: ProviderDescriptor = { id: "stub", label: "Stub", protocol: "stub", authStyle: "bearer", keyMode: "none", space: "open", capabilities: { text: true }, kinds: ["chat"] };

/** Built-in descriptors by provider id. Adding a provider = a descriptor here (or, later, a row) + rows in `provider_models`; an adapter only when the protocol is new. */
export const DESCRIPTORS: Record<string, ProviderDescriptor> = Object.fromEntries([NVIDIA_DESCRIPTOR, GROQ_DESCRIPTOR, CLOUDFLARE_DESCRIPTOR, AISTUDIO_DESCRIPTOR, GATEWAY_DESCRIPTOR, STUB_DESCRIPTOR].map((d) => [d.id, d]));
export const descriptorOf = (id: string): ProviderDescriptor | null => DESCRIPTORS[id] ?? null;
/** config kind -> protocol (back-fill rule: `openai-compat` = `openai`). */
export const protocolOfKind = (kind: string): Protocol | null => (kind === "openai-compat" ? "openai" : kind === "cloudflare" ? "cloudflare-binding" : kind === "gemini" ? "gemini-native" : kind === "gateway" ? "gateway" : kind === "stub" ? "stub" : null);

/** Model-id filter from a descriptor's discovery rules: false = skip. Rules are checked in order, first match wins; no match = chat. */
export function discoveredKind(d: ProviderDescriptor | null | undefined, id: string): "chat" | "image" | "skip" {
  const l = id.toLowerCase();
  for (const r of d?.discovery ?? []) if (l.includes(r.contains.toLowerCase())) return r.kind === "skip" ? "skip" : r.kind === "image" ? "image" : "chat";
  return "chat";
}

const AUTH = /^(bearer|x-api-key|x-goog-api-key|custom:[a-z][a-z0-9-]{0,39})$/;
const RESERVED_HEADER = /^(authorization|host|content-type|content-length|accept|accept-encoding|connection|transfer-encoding|upgrade|cookie|set-cookie|origin|referer|user-agent|cf-.*|x-forwarded-.*)$/i;
/** Structural lint for a descriptor (built-in or future row): returns the problems, [] = fine. No secrets, https only, a known auth style, non-Vertex = open only. */
export function validateDescriptor(d: ProviderDescriptor): string[] {
  const p: string[] = [];
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(d.id)) p.push("id");
  if (d.baseUrl !== undefined && !/^https:\/\/[^\s/@?#]+(\/[^\s?#]*)?$/.test(d.baseUrl)) p.push("baseUrl must be https, no userinfo/query/fragment");
  if (!AUTH.test(d.authStyle)) p.push("authStyle");
  if (d.authStyle.startsWith("custom:") && RESERVED_HEADER.test(d.authStyle.slice(7))) p.push("authStyle names a reserved header");
  if (d.protocol !== "gateway" && d.space !== "open") p.push("only the Vertex gateway may be space=biz");
  if ((d.protocol === "openai" || d.protocol === "anthropic" || d.protocol === "gemini-native") && !d.baseUrl) p.push("HTTP protocols need a baseUrl");
  if (d.keyMode === "worker" || d.keyMode === "user-or-worker") { if (!d.baseUrl) p.push("worker key needs a preset baseUrl"); }
  if (d.dialect && d.dialect.reasoning.control === "effort" && !(d.dialect.reasoning.effortValues?.length)) { /* per-model values allowed */ }
  if (d.discovery && (d.discovery.length > 100 || d.discovery.some((r) => !r.contains || r.contains.length > 60))) p.push("discovery rules bounded: <=100 rules, <=60 chars");
  if (JSON.stringify(d).match(/(sk-|nvapi-|AIza|gsk_)[A-Za-z0-9]{8,}/)) p.push("looks like a secret");
  return p;
}
