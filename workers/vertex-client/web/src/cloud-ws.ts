// Live transport for a Cloud run: the agent-spike event WebSocket (through /api/cloud/runs/:id/ws), falling back to polling
// /events when the socket can't be opened or drops. Both deliver the same {seq,...} events; the caller dedupes by seq, so switching
// transport (or a replayed frame) can never duplicate or lose an item. Never throws: failures are reported through onProblem.
import type { AgentEvent } from "./cloud-events";
import { withSpaceQuery } from "./space";

export type Live = { stop: () => void };
type Opts = {
  id: string; wsPath?: string; getAfter: () => number;
  onEvents: (e: AgentEvent[]) => void;
  onTick: () => void;            // called on every transport heartbeat (poll round / WS frame) to refresh run state
  poll: (after: number) => Promise<{ events: AgentEvent[] } | null>;  // null = request failed
  onProblem: (msg: string | null) => void;
  pollMs?: number; wsRetryMs?: number; WS?: typeof WebSocket;
};

export function startLive(o: Opts): Live {
  const pollMs = o.pollMs ?? 1200;
  let stopped = false, ws: WebSocket | null = null, timer: ReturnType<typeof setTimeout> | undefined, fails = 0, wsFails = 0;
  const WSctor = o.WS ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);

  let inPoll = false;
  const pollOnce = async () => {
    if (stopped || inPoll) return;
    inPoll = true;
    o.onTick();
    let r: Awaited<ReturnType<Opts["poll"]>> = null;
    try { r = await o.poll(o.getAfter()); } catch { r = null; }
    inPoll = false;
    if (stopped) return;
    if (r) { fails = 0; o.onProblem(null); if (r.events.length) o.onEvents(r.events); }
    else { fails++; o.onProblem("Connection to the run was interrupted — retrying…"); }
    clearTimeout(timer);
    timer = setTimeout(() => void pollOnce(), Math.min(10_000, pollMs * (fails ? 2 ** Math.min(fails, 4) : 1)));
  };

  const openWs = () => {
    if (stopped || !WSctor || wsFails >= 2) { void pollOnce(); return; }
    let opened = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    try { ws = new WSctor(withSpaceQuery(`${proto}://${location.host}${o.wsPath ?? `/api/cloud/runs/${o.id}/ws`}?after=${o.getAfter()}`)); } catch { wsFails++; return openWs(); }
    const mine = ws;
    mine.onopen = () => { opened = true; wsFails = 0; o.onProblem(null); o.onTick(); };
    mine.onmessage = (m) => {
      try { const e = JSON.parse(m.data as string) as AgentEvent; if (typeof e?.seq === "number") o.onEvents([e]); } catch { /* ignore junk frames */ }
    };
    mine.onclose = (ev) => {
      if (ws === mine) ws = null;
      if (stopped) return;
      o.onTick(); // pick up the final status
      if (opened && ev.code === 1000) { timer = setTimeout(() => void pollOnce(), pollMs); return; } // task ended: a last poll drains stragglers, then keeps state fresh
      if (!opened) wsFails++;
      // dropped: catch up by polling immediately, then try the socket again
      void (async () => {
        await pollOnce();
        // the poll loop keeps running by itself; only interleave a socket retry while the socket is still worth trying
        if (!stopped && wsFails < 2) { clearTimeout(timer); timer = setTimeout(openWs, o.wsRetryMs ?? 1500); }
      })();
    };
    mine.onerror = () => { try { mine.close(); } catch { /* already closing */ } };
  };
  openWs();
  return { stop() { stopped = true; clearTimeout(timer); try { ws?.close(); } catch { /* */ } } };
}
