// Web-safe half of subagent.ts (no server imports): the shape of a `delegate` tool result, its parser, and the stream-event shape.
export const DELEGATE_TOOL = "delegate";
export type DelegateInfo = { persona: string; model: string; status: "ok" | "error"; rounds: number; input_tokens: number; output_tokens: number };
export type DelegateResult = { subagent: DelegateInfo; summary: string };
/** Live state of a running/finished subagent, from `subagent` stream events (keyed by the delegate tool_use id). */
export type SubagentLive = { persona: string; model: string; status: "queued" | "running" | "done" | "error"; task?: string; rounds: number; input_tokens: number; output_tokens: number; summary?: string };
/** READ tools a persona may be given (must equal tools.ts READ_TOOLS: test/subagent.test.ts checks it). */
export const SUBAGENT_TOOL_CHOICES = ["search_notes", "get_note", "list_projects", "check_tasks", "list_threads", "connector_usage", "fleet_status", "fleet_usage", "read_url"] as const;
/** Card data from a `delegate` tool result (null for anything else / unparsable). */
export function parseDelegateResult(name: string, text: string): DelegateResult | null {
  if (name !== DELEGATE_TOOL) return null;
  try {
    const j = JSON.parse(text) as DelegateResult;
    return j && typeof j === "object" && j.subagent && typeof j.subagent.persona === "string" && typeof j.summary === "string" ? j : null;
  } catch { return null; }
}
/** Delegations in a message list: how many and their summed tokens. Only a tool_result whose `tool_use_id` belongs to a `delegate` tool_use in the SAME list
 *  counts, each id once; token fields must be finite non-negative integers (anything else counts as 0). Tokens only, never a cost. */
export function delegationTotals(msgs: ReadonlyArray<{ content: ReadonlyArray<object> }>): { count: number; input: number; output: number } {
  const t = { count: 0, input: 0, output: 0 };
  const ids = new Set<string>(), seen = new Set<string>();
  for (const m of msgs) for (const b0 of m.content) { const b = b0 as { type?: unknown; name?: unknown; id?: unknown }; if (b.type === "tool_use" && b.name === DELEGATE_TOOL && typeof b.id === "string") ids.add(b.id); }
  const tok = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
  for (const m of msgs) for (const b0 of m.content) {
    const b = b0 as { type?: unknown; tool_use_id?: unknown; content?: unknown };
    if (b.type !== "tool_result" || typeof b.tool_use_id !== "string" || !ids.has(b.tool_use_id) || seen.has(b.tool_use_id) || typeof b.content !== "string") continue;
    const r = parseDelegateResult(DELEGATE_TOOL, b.content);
    if (r) { seen.add(b.tool_use_id); t.count++; t.input += tok(r.subagent.input_tokens); t.output += tok(r.subagent.output_tokens); }
  }
  return t;
}
