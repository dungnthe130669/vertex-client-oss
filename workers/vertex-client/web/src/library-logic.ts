// Pure pieces of Library / Export / in-chat search (no DOM, so bun:test covers them).
import type { Block, Msg } from "./chat-state";
import { withSpaceQuery } from "./space";

// ---- in-chat search ----
/** Case-insensitive, non-overlapping [start,end) ranges of `q` in `text`. A blank query matches nothing. */
export function findRanges(text: string, q: string): Array<[number, number]> {
  const n = q.trim().toLowerCase();
  if (!n) return [];
  const t = text.toLowerCase();
  // toLowerCase can change length for a few characters (e.g. "İ"); then indices would drift, so refuse rather than highlight the wrong text
  if (t.length !== text.length) return [];
  const out: Array<[number, number]> = [];
  for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + n.length)) out.push([i, i + n.length]);
  return out;
}
/** Matches per text node, in document order; `flat` lists every match once so next/prev is a modular index. */
export function matchPlan(texts: readonly string[], q: string): { perNode: Array<Array<[number, number]>>; flat: Array<{ node: number; range: [number, number] }> } {
  const perNode = texts.map((t) => findRanges(t, q));
  const flat = perNode.flatMap((rs, node) => rs.map((range) => ({ node, range })));
  return { perNode, flat };
}
/** Next/previous index with wrap-around (-1 = none). */
export const stepMatch = (i: number, n: number, dir: 1 | -1): number => (n <= 0 ? -1 : i < 0 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n);

// ---- export ----
const clean = (s: unknown) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const fileNames = (m: Msg): string[] => m.content.filter((b) => b.type === "file_ref").map((b) => clean(b.name)).filter(Boolean);
/** The conversation as the user sees it: tool-result-only user turns are plumbing, not conversation. */
export const visibleMessages = (msgs: readonly Msg[]): Msg[] => msgs.filter((m) => !(m.role === "user" && m.content.every((b) => b.type === "tool_result")));

function blockLines(b: Block): string[] {
  switch (b.type) {
    case "text": return [String(b.text ?? "")];
    case "tool_use": return [`> Tool: ${clean(b.name)}`];
    case "gen_image": return [`> Generated image${b.prompt ? `: ${clean(b.prompt)}` : ""}`];
    case "gen_video": return [`> Generated video${b.prompt ? `: ${clean(b.prompt)}` : ""}`];
    default: return []; // thinking, tool_result, unknown: not part of the visible conversation
  }
}

/** Markdown transcript. Attachments are named, never linked (their storage keys carry the conversation id). */
export function exportMarkdown(title: string, msgs: readonly Msg[], exportedAt = new Date()): string {
  const out = [`# ${clean(title) || "Chat"}`, "", `_Exported ${exportedAt.toISOString()}_`, ""];
  for (const m of visibleMessages(msgs)) {
    out.push(`## ${m.role === "user" ? "You" : "Assistant"}`, "");
    const names = fileNames(m);
    if (names.length) out.push(`Attachments: ${names.join(", ")}`, "");
    const body = m.content.flatMap(blockLines).map((s) => s.trimEnd()).filter((s) => s.trim()).join("\n\n");
    if (body) out.push(body, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export type ExportMessage = { role: "user" | "assistant"; createdAt: string | null; text: string; attachments: string[]; model: string | null };
export function exportJson(title: string, msgs: readonly Msg[], exportedAt = new Date()): string {
  const messages: ExportMessage[] = visibleMessages(msgs).map((m) => ({
    role: m.role, createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
    text: m.content.flatMap(blockLines).filter((s) => s.trim()).join("\n\n"), attachments: fileNames(m), model: m.model,
  }));
  return JSON.stringify({ title: clean(title) || "Chat", exportedAt: exportedAt.toISOString(), messages }, null, 2) + "\n";
}

/** Safe file name: letters/digits/._- only, never empty. */
export function exportFileName(title: string, ext: "md" | "json", now = new Date()): string {
  const base = clean(title).normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 60) || "chat";
  return `${base}-${now.toISOString().slice(0, 10)}.${ext}`;
}

// ---- library ----
export type LibItem = { conv: string; title: string; ref: string; type: "image" | "video"; mime: string; size: number; createdAt: string };
/** Authed file URL for a library item (ref is the tail after vertex-client/<conv>/, e.g. gen/<uuid>.png). */
export const libUrl = (it: Pick<LibItem, "conv" | "ref">) => withSpaceQuery(`/api/conversations/${it.conv}/files/${it.ref.split("/").map(encodeURIComponent).join("/")}`);
export const libFileName = (it: Pick<LibItem, "ref">) => it.ref.split("/").pop() ?? "download";
export const libQuery = (type: "" | "image" | "video", before: string | null) => {
  const p = new URLSearchParams();
  if (type) p.set("type", type);
  if (before) p.set("before", before);
  const s = p.toString();
  return `/api/library${s ? `?${s}` : ""}`;
};
