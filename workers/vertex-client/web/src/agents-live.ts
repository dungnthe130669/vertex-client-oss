// Live transport for an agent: ONE WebSocket (/api/agents/:name/events) that stays open across session replacements, falling back to
// paging the same endpoint. Resume is by agent-spike's cursor ("<session>:<seq>"); frames without one (agent_hello, agent_session) never move it.
// Session seqs restart per session, so every frame is re-numbered locally before it reaches the feed (fold dedupes by seq).
import type { AgentEvent } from "./cloud-events";
import { withSpaceQuery } from "./space";

type Frame = { kind: string; cursor?: string; session?: string; previous?: string | null; ts?: number; data?: Record<string, unknown> };
export type AgentLive = { stop: () => void };
type Opts = {
  name: string; onEvents: (e: AgentEvent[]) => void; onProblem: (msg: string | null) => void;
  page: (after: string | null) => Promise<{ events: Frame[]; next?: string | null } | null>;
  pollMs?: number; WS?: typeof WebSocket;
};

export function startAgentLive(o: Opts): AgentLive {
  let stopped = false, ws: WebSocket | null = null, timer: ReturnType<typeof setTimeout> | undefined, cursor: string | null = null, n = 0, wsFails = 0, fails = 0, inPoll = false;
  const WSctor = o.WS ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
  const toEvents = (frames: Frame[]): AgentEvent[] => {
    const out: AgentEvent[] = [];
    for (const f of frames) {
      if (typeof f?.kind !== "string") continue;
      if (typeof f.cursor === "string") cursor = f.cursor;
      if (f.kind === "agent_hello" || f.kind === "agent_msg") continue; // state comes from the detail poll
      const data = f.kind === "agent_session" ? { text: f.previous ? "Session replaced — continuing on a new one" : "Session started" } : f.data ?? {};
      out.push({ seq: ++n, ts: f.ts ?? Date.now(), kind: f.kind === "agent_session" ? "status" : f.kind, data });
    }
    return out;
  };
  const deliver = (frames: Frame[]) => { const ev = toEvents(frames); if (ev.length) o.onEvents(ev); };

  const poll = async () => {
    if (stopped || inPoll) return;
    inPoll = true;
    let r: Awaited<ReturnType<Opts["page"]>> = null;
    try { r = await o.page(cursor); } catch { r = null; }
    inPoll = false;
    if (stopped) return;
    if (r) { fails = 0; o.onProblem(null); deliver(r.events); if (r.next) cursor = r.next; } else { fails++; o.onProblem("Connection to the agent was interrupted — retrying…"); }
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), Math.min(10_000, (o.pollMs ?? 1500) * (fails ? 2 ** Math.min(fails, 4) : 1)));
  };

  const open = () => {
    if (stopped || !WSctor || wsFails >= 2) { void poll(); return; }
    let opened = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
    try { ws = new WSctor(withSpaceQuery(`${proto}://${location.host}/api/agents/${encodeURIComponent(o.name)}/events${q}`)); } catch { wsFails++; return open(); }
    const mine = ws;
    mine.onopen = () => { opened = true; wsFails = 0; o.onProblem(null); };
    mine.onmessage = (m) => { try { deliver([JSON.parse(m.data as string) as Frame]); } catch { /* junk frame */ } };
    mine.onclose = () => {
      if (ws === mine) ws = null;
      if (stopped) return;
      if (!opened) wsFails++;
      // dropped: page from the last cursor (no loss, no duplicates), then try the socket again
      void (async () => { await poll(); if (!stopped && wsFails < 2) { clearTimeout(timer); timer = setTimeout(open, 1500); } })();
    };
    mine.onerror = () => { try { mine.close(); } catch { /* closing */ } };
  };
  open();
  return { stop() { stopped = true; clearTimeout(timer); try { ws?.close(); } catch { /* */ } } };
}
