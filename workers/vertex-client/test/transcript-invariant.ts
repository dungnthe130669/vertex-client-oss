// Reusable invariant over a SAVED chat transcript (the `messages` of a conversation state): every tool_use has exactly one tool_result and every tool_result belongs to exactly one earlier tool_use,
// ids are unique on both sides. Returns the list of violations (empty = valid) so a test can print them; `expectValidTranscript` throws.
// Deliberately NOT asserted: that a result sits in the message immediately after its call. A device chat shows approval cards as calls that are saved BEFORE their answer exists, so a later
// assistant message can legitimately sit in between; device transcripts are display-only and never replayed to a model (retry/generate/fork are refused for them).
type Msg = { role: string; content: unknown };
export function transcriptViolations(messages: Msg[]): string[] {
  const bad: string[] = [];
  const uses = new Map<string, number>(); // tool_use id -> index of the assistant message
  const results = new Map<string, number>();
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    for (const b of m.content as Array<Record<string, any>>) {
      if (b?.type === "tool_use") {
        if (m.role !== "assistant") bad.push(`tool_use ${b.id} in a ${m.role} message #${i}`);
        if (uses.has(b.id)) bad.push(`duplicate tool_use id ${b.id}`);
        uses.set(b.id, i);
      } else if (b?.type === "tool_result") {
        if (m.role !== "user") bad.push(`tool_result ${b.tool_use_id} in a ${m.role} message #${i}`);
        if (results.has(b.tool_use_id)) bad.push(`duplicate tool_result for ${b.tool_use_id}`);
        results.set(b.tool_use_id, i);
      }
    }
  });
  for (const [id, i] of uses) { if (!results.has(id)) bad.push(`tool_use ${id} has no tool_result`); else if (results.get(id)! <= i) bad.push(`tool_result for ${id} is not after its tool_use`); }
  for (const id of results.keys()) if (!uses.has(id)) bad.push(`tool_result for unknown tool_use ${id}`);
  return bad;
}
export function expectValidTranscript(messages: Msg[]) {
  const v = transcriptViolations(messages);
  if (v.length) throw new Error("invalid transcript: " + v.join("; "));
}
