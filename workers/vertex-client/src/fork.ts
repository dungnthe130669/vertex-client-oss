// Edit-any-message = fork: the transcript BEFORE the chosen user message becomes a new conversation (original untouched);
// the client then sends the edited text into it as an ordinary first turn. Pure logic, unit-tested.
import type { Block } from "./turn-engine";

type Msg = { id: number; role: "user" | "assistant"; content: Block[]; model?: string | null };
export type ForkResult = { ok: true; messages: Array<{ role: "user" | "assistant"; content: Block[]; model?: string | null }> } | { ok: false; status: 400 | 404 | 409; error: string };

const isToolResultOnly = (m: Msg) => m.content.length > 0 && m.content.every((b) => b.type === "tool_result");

/** Attachments live in R2 under the ORIGINAL conversation, so the fork keeps their names as plain text instead of dangling refs. */
const flatten = (content: Block[]): Block[] => content.map((b) => (b.type === "file_ref" ? { type: "text", text: `[Attachment: ${String(b.name ?? "file")}]` } : b));

export function forkPrefix(messages: Msg[], messageId: number, running: boolean): ForkResult {
  if (running) return { ok: false, status: 409, error: "a reply is in progress; stop it first" };
  const i = messages.findIndex((m) => m.id === messageId);
  if (i < 0) return { ok: false, status: 404, error: "message not found" };
  const target = messages[i];
  if (target.role !== "user" || isToolResultOnly(target)) return { ok: false, status: 400, error: "only your own messages can be edited" };
  const prefix = messages.slice(0, i);
  // Every tool call in the copied part must have its result inside it, or the provider rejects the history.
  const used = new Set<string>(), answered = new Set<string>();
  for (const m of prefix) for (const b of m.content) { if (b.type === "tool_use") used.add(String(b.id)); if (b.type === "tool_result") answered.add(String(b.tool_use_id)); }
  for (const id of used) if (!answered.has(id)) return { ok: false, status: 409, error: "cannot fork inside an unfinished tool call" };
  return { ok: true, messages: prefix.filter((m) => m.content.length > 0).map((m) => ({ role: m.role, content: flatten(m.content), ...(m.role === "assistant" && m.model ? { model: m.model } : {}) })) };
}

/** Title of the fork: the original's, marked, within the 120-char title limit. */
export const forkTitle = (title: string) => `${(title || "New chat").slice(0, 105)} (edited)`;
