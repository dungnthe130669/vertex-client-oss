// Plain-text transcript of the parent conversation for a persona with context_mode 'conversation' (the advisor). Pure: no I/O.
// Text only: user/assistant text, tool calls as a one-line mark, tool results cut to RESULT_MAX; images/documents/thinking dropped.
// Total capped at TRANSCRIPT_MAX: the most recent turns are kept, the oldest are dropped behind a marker.
export const TRANSCRIPT_MAX = 60_000;
export const RESULT_MAX = 500;
export const DROPPED_MARK = "[earlier messages omitted]";
type Msg = { role: string; content: Array<Record<string, any>> | string };

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " [cut]" : s);
const resultText = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => String(b.text ?? "")).join("\n") : "");

/** One line-block per message, oldest first. `skip` names tool calls that are not part of the story (the advisor call itself). */
export function transcriptParts(msgs: Msg[], skip: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    const who = m.role === "user" ? "User" : "Assistant";
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    const lines: string[] = [];
    for (const b of blocks) {
      if (b?.type === "text" && String(b.text ?? "").trim()) lines.push(`${who}: ${String(b.text).trim()}`);
      else if (b?.type === "tool_use" && !skip.has(String(b.name))) lines.push(`Assistant called tool ${String(b.name)}`);
      else if (b?.type === "tool_result") { const t = resultText(b.content).trim(); if (t) lines.push(`Tool result: ${cut(t, RESULT_MAX)}`); }
    }
    if (lines.length) out.push(lines.join("\n"));
  }
  return out;
}

/** The transcript text (<= max chars incl. the marker), or "" when there is nothing to show. A single message longer than the cap is itself cut from its start. */
export function buildTranscript(msgs: Msg[], skip: ReadonlySet<string> = new Set(), max = TRANSCRIPT_MAX): string {
  const parts = transcriptParts(msgs, skip);
  if (!parts.length) return "";
  const all = parts.join("\n\n");
  if (all.length <= max) return all;
  const budget = max - DROPPED_MARK.length - 2; // the marker line always leads once anything is dropped
  const kept: string[] = [];
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const cost = parts[i].length + (kept.length ? 2 : 0);
    if (used + cost <= budget) { kept.unshift(parts[i]); used += cost; continue; }
    const room = budget - used - (kept.length ? 2 : 0);
    if (!kept.length && room > 100) kept.unshift("…" + parts[i].slice(parts[i].length - (room - 1)));
    break;
  }
  return DROPPED_MARK + "\n\n" + kept.join("\n\n");
}
