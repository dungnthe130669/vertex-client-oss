// Pure fold of agent-spike events into display items. Unknown kinds are ignored; events are deduped by seq;
// `result` carries CUMULATIVE usage so the latest one wins.
export type AgentEvent = { seq: number; ts: number; kind: string; data: Record<string, unknown> };
export type Item =
  | { t: "text"; seq: number; text: string }
  | { t: "tool"; seq: number; id: string; name: string; input: string; output?: string; isError?: boolean }
  | { t: "status"; seq: number; text: string }
  | { t: "followup"; seq: number; text: string }
  | { t: "git"; seq: number; text: string; ok?: boolean }
  | { t: "result"; seq: number; text: string; isError: boolean; costUsd?: number; turns?: number }
  | { t: "error"; seq: number; text: string };
export type Feed = { items: Item[]; seen: number; last: number; costUsd?: number; model?: string };

export const emptyFeed = (): Feed => ({ items: [], seen: 0, last: -1 });
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

export function fold(feed: Feed, events: AgentEvent[]): Feed {
  const items = feed.items.slice();
  let { last, costUsd, model } = feed;
  for (const e of events) {
    if (typeof e?.seq !== "number" || e.seq <= last) continue;
    last = e.seq;
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case "init": model = str(d.model) || model; break;
      case "text": items.push({ t: "text", seq: e.seq, text: str(d.text) }); break;
      case "tool_use": items.push({ t: "tool", seq: e.seq, id: str(d.id), name: str(d.name), input: str(d.input) }); break;
      case "tool_result": {
        const i = items.findIndex((x) => x.t === "tool" && x.id === str(d.tool_use_id));
        const it = items[i];
        if (it && it.t === "tool") items[i] = { ...it, output: str(d.content), isError: !!d.is_error };
        break;
      }
      case "user_followup": items.push({ t: "followup", seq: e.seq, text: str(d.text) }); break;
      case "status": { const s = str(d.state ?? d.status ?? d.text); if (s) items.push({ t: "status", seq: e.seq, text: s }); break; }
      case "git": items.push({ t: "git", seq: e.seq, text: str(d.text ?? d.message ?? d), ...(typeof d.ok === "boolean" ? { ok: d.ok } : {}) }); break;
      case "result": {
        const c = typeof d.total_cost_usd === "number" ? d.total_cost_usd : undefined;
        if (c !== undefined) costUsd = c;
        items.push({ t: "result", seq: e.seq, text: str(d.result), isError: !!d.is_error, costUsd: c, turns: typeof d.num_turns === "number" ? d.num_turns : undefined });
        break;
      }
      case "error": case "llm_error": items.push({ t: "error", seq: e.seq, text: str(d.text ?? d.message ?? d) }); break;
      default: break;
    }
  }
  return { items, seen: feed.seen + events.length, last, costUsd, model };
}

/** Infrastructure chatter from the git/LLM proxy ("allowed info-refs GET …", "upstream headers … -> 200 …", "push accepted: …"). */
const NET_RE = /^(allowed |upstream |push accepted)/i;
/** A proxy line that reports a problem must stay visible: git events with ok:false (checked in isNetLine), 4xx/5xx after "->" (egress.ts emits "-> HTTP 500" and "-> 502"), or a failure word. */
const NET_BAD_RE = /->\s*(HTTP\s*)?[45]\d\d\b|\b(error|denied|forbidden|fail(ed|ure)?|reject(ed)?|refused|timed? ?out|unauthori[sz]ed)\b/i;
export const isNetLine = (it: Item): boolean => (it.t === "status" || it.t === "git") && !(it.t === "git" && it.ok === false) && NET_RE.test(it.text) && !NET_BAD_RE.test(it.text);

export type NetGroup = { t: "net"; seq: number; items: Item[] };
/** Collapse each run of consecutive proxy lines into one group; everything else (agent text, tools, errors, other status) passes through. */
export function groupNet(items: Item[]): (Item | NetGroup)[] {
  const out: (Item | NetGroup)[] = [];
  for (const it of items) {
    if (!isNetLine(it)) { out.push(it); continue; }
    const prev = out[out.length - 1];
    if (prev && prev.t === "net") prev.items.push(it); else out.push({ t: "net", seq: it.seq, items: [it] });
  }
  return out;
}
