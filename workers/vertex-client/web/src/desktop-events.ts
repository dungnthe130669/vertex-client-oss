// Pure fold of desktop-task events into a feed. Unknown kinds are ignored, seq dedupes, `frame` (seq -1, transient) never reaches here.
import type { AgentEvent } from "./cloud-events";
export type DItem =
  | { t: "text"; seq: number; text: string }
  | { t: "action"; seq: number; text: string }
  | { t: "ask"; seq: number; text: string }
  | { t: "control"; seq: number; text: string }
  | { t: "result"; seq: number; text: string; isError: boolean; turns?: number }
  | { t: "log"; seq: number; text: string };
export type DFeed = { items: DItem[]; last: number; asking: string | null };
export const emptyDFeed = (): DFeed => ({ items: [], last: -1, asking: null });
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const short = (s: string, n = 140) => (s.length > n ? s.slice(0, n) + "…" : s);

export function foldDesktop(feed: DFeed, events: AgentEvent[]): DFeed {
  const items = feed.items.slice();
  let { last, asking } = feed;
  for (const e of events) {
    if (typeof e?.seq !== "number" || e.seq <= last) continue;
    last = e.seq;
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case "text": if (str(d.text).trim()) items.push({ t: "text", seq: e.seq, text: str(d.text) }); break;
      case "action": {
        const inp = d.input && typeof d.input === "object" ? Object.entries(d.input as Record<string, unknown>).map(([k, v]) => `${k}=${str(v)}`).join(" ") : str(d.input);
        items.push({ t: "action", seq: e.seq, text: short(`${str(d.name)}${inp ? " " + inp : ""}`) });
        break;
      }
      case "ask_human": asking = str(d.reason) || "The agent needs you"; items.push({ t: "ask", seq: e.seq, text: asking }); break;
      case "ask_timeout": asking = null; items.push({ t: "control", seq: e.seq, text: "Ask timed out, the agent carries on" }); break;
      case "control": {
        const s = str(d.state);
        if (s !== "asking") asking = null;
        items.push({ t: "control", seq: e.seq, text: s === "human" ? "You have control" : s === "agent" ? (d.by === "idle-timeout" ? "Control returned (idle timeout)" : "Control returned to the agent") : short(`control: ${s}`) });
        break;
      }
      case "result": asking = null; items.push({ t: "result", seq: e.seq, text: str(d.result), isError: !!d.is_error, turns: typeof d.turns === "number" ? d.turns : undefined }); break;
      case "log": case "status": { const s = str(d.text ?? d.state ?? d.status ?? d.message); if (s) items.push({ t: "log", seq: e.seq, text: short(s) }); break; }
      default: break;
    }
  }
  return { items, last, asking };
}
