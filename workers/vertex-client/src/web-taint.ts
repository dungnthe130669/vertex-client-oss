// Prompt-injection / exfiltration guard for the Open browse tools (web_read / web_screenshot / web_links). A fetched page is untrusted: it can tell the model
// to call a browse tool again on an attacker URL that carries conversation data in its path/query. Policy (deliberately simple):
//  1. A conversation is TAINTED once ANY untrusted content entered it: a PERSISTENT per-conversation flag (DO meta `webtaint`, set by the engine, never cleared,
//     independent of message history so compaction/summary cannot drop it, inherited by forks). Also derived from history (any web_* result) as a second net.
//     Never reset by a later user message; siblings of a call are not exempt.
//  2. In a tainted conversation every model-initiated web_* call needs the approval card, EXCEPT a URL that, normalized, equals exactly one whitespace-delimited
//     URL token of the LATEST user message (the user just typed it). No host allowance, no tool-returned link, no substring match.
//  3. An untainted conversation auto-allows web_* (no page content in context yet).
// Stateless: derived from the stored messages, so it survives an approval resume or a restart. Pure; imports nothing at runtime (turn-engine uses it).
// web_* tools always strip the URL fragment before the browser call (cf-tools.ts) and normalizeUrl strips it on BOTH sides of the exact-token compare.
// Taint sources are set in turn-engine (callTool: every tool except artifact/image tools; saveUser: attachments) and in seedHistory (forks).
export const WEB_TOOLS = new Set(["web_read", "web_screenshot", "web_links"]);

type Blk = Record<string, any>;
type Msg = { role: string; content: Blk[] };

/** Canonical form for comparing URLs: scheme + host lowercased (URL does that), default port dropped (URL does that), no fragment, no trailing-dot host. http(s) only. */
export function normalizeUrl(s: string): string | null {
  let u: URL; try { u = new URL(s.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = ""; u.hostname = u.hostname.replace(/\.+$/, "");
  return u.toString();
}
const isUserText = (m: Msg) => m.role === "user" && m.content.some((b) => b.type === "text" || b.type === "file_ref");
const textOf = (m: Msg) => m.content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
/** Whole whitespace-delimited tokens of the text that are URLs (surrounding brackets/quotes and trailing sentence punctuation removed), normalized. */
export function urlTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.split(/\s+/)) {
    const n = normalizeUrl(tok.replace(/^[<(\["'`]+/, "").replace(/[>)\]"'`.,;:!?]+$/, ""));
    if (n) out.add(n);
  }
  return out;
}

/** True when a web_* tool result already exists anywhere in the conversation. */
export function isTainted(msgs: Msg[]): boolean {
  const webIds = new Set<string>();
  for (const m of msgs) if (m.role === "assistant") for (const b of m.content) if (b.type === "tool_use" && WEB_TOOLS.has(b.name)) webIds.add(b.id);
  return msgs.some((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result" && webIds.has(b.tool_use_id)));
}

export type WebPolicy = { kind: "auto" } | { kind: "approval"; why: string };
export const WEB_APPROVAL_WHY = "web page content was read earlier in this conversation and is untrusted: it must not be able to send your data to a new address";

/** Decide how a model-initiated browse call is handled. `msgs` = stored messages up to and including the assistant message that holds the call. */
export function webPolicy(name: string, input: unknown, msgs: Msg[], flagged = false): WebPolicy {
  if (!WEB_TOOLS.has(name) || !(flagged || isTainted(msgs))) return { kind: "auto" };
  const raw = typeof (input as any)?.url === "string" ? (input as any).url : "";
  const n = normalizeUrl(raw);
  const latest = [...msgs].reverse().find(isUserText);
  if (n && latest && urlTokens(textOf(latest)).has(n)) return { kind: "auto" }; // the user typed exactly this URL in their latest message
  return { kind: "approval", why: WEB_APPROVAL_WHY };
}

/** Tools whose results are our own output, not outside content: everything else (web_*, read_url, connector/MCP tools, delegate/persona results, notes...) taints. */
export const TRUSTED_RESULT_TOOLS = new Set(["create_artifact", "update_artifact", "generate_image"]);
