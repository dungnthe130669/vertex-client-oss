// PWA socket to one device's hub: WS /api/devices/:id/session?since=<seq>. Applies each event exactly once, in order (seq protocol),
// and after a drop reconnects with since=<last applied seq> so replay is lossless. A gap or duplicate never reaches the UI.
import { withSpaceQuery } from "./space";
import type { Frame } from "./devices-logic";
import { ingest } from "./notif-store";

export type LinkState = "connecting" | "live" | "reconnecting" | "closed" | "revoked"; // revoked = the hub closed with 4003: terminal, never retried
export const CLOSE_REVOKED = 4003;
type Opts = {
  id: string; WS?: typeof WebSocket; baseMs?: number; maxMs?: number; pingMs?: number;
  onEvent: (seq: number, e: Frame, ts: number) => void;
  onHello?: (f: Frame) => void;           // resync:true => events after `since` were pruned, state must be treated as incomplete
  onFrame?: (f: Frame) => void;           // cmd_ack / ok / err replies
  onState: (s: LinkState) => void;
};
export type Link = { send: (f: Frame) => boolean; stop: () => void; last: () => number; /** manual Reconnect: drop the current socket (if any) and connect now, resuming from the last applied seq */ reconnect: () => void };

export function openDeviceLink(o: Opts): Link {
  const WSctor = o.WS ?? WebSocket;
  let ws: WebSocket | null = null, last = 0, stopped = false, fails = 0, timer: ReturnType<typeof setTimeout> | undefined, ping: ReturnType<typeof setInterval> | undefined;
  const connect = () => {
    if (stopped) return;
    o.onState(fails ? "reconnecting" : "connecting");
    const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws";
    const host = typeof location !== "undefined" ? location.host : "localhost";
    let s: WebSocket;
    try { s = new WSctor(withSpaceQuery(`${proto}://${host}/api/devices/${o.id}/session?since=${last}`)); } catch { return retry(); }
    ws = s;
    s.onopen = () => { fails = 0; };
    s.onmessage = (m) => {
      let f: Frame; try { f = JSON.parse(String(m.data)); } catch { return; }
      if (f.t === "hello") { if (f.resync && typeof f.seq === "number") last = f.seq; o.onState("live"); o.onHello?.(f); }
      else if (f.t === "ev" && typeof f.seq === "number") {
        if (f.seq <= last) return;                                   // duplicate: already applied
        if (last > 0 && f.seq !== last + 1) { try { s.close(); } catch { /* */ } return; } // gap: drop the socket, reconnect resumes from `last`
        last = f.seq; o.onEvent(f.seq, f.e ?? {}, f.ts);
      } else if ((f as { t?: string }).t === "notif") ingest((f as { n?: unknown }).n);
      else if (f.t !== "pong") o.onFrame?.(f);
    };
    s.onclose = (ev?: { code?: number }) => {
      if (ws === s) ws = null;
      if (stopped) return;
      if (ev?.code === CLOSE_REVOKED) { stopped = true; clearTimeout(timer); clearInterval(ping); o.onState("revoked"); return; } // revoked device: stop hammering a 404/410
      retry();
    };
    s.onerror = () => { try { s.close(); } catch { /* */ } };
  };
  const retry = () => {
    fails++; o.onState("reconnecting");
    clearTimeout(timer);
    timer = setTimeout(connect, Math.min(o.maxMs ?? 15_000, (o.baseMs ?? 1000) * 2 ** Math.min(fails - 1, 4)));
  };
  ping = setInterval(() => { try { if (ws?.readyState === 1) ws.send('{"t":"ping"}'); } catch { /* */ } }, o.pingMs ?? 25_000);
  connect();
  return {
    send: (f) => { if (!ws || ws.readyState !== 1) return false; try { ws.send(JSON.stringify(f)); return true; } catch { return false; } },
    stop: () => { stopped = true; clearTimeout(timer); clearInterval(ping); o.onState("closed"); try { ws?.close(); } catch { /* */ } },
    last: () => last,
    reconnect: () => {
      if (stopped) return;
      clearTimeout(timer); fails = 0;
      const old = ws; ws = null;
      if (old) { old.onclose = null; old.onmessage = null; old.onerror = null; try { old.close(); } catch { /* */ } }
      connect();
    },
  };
}
