// WebSocket to the ChatSession DO with reconnect + since=<seq> replay. The server keeps the truth; this only transports.
import type { Frame } from "./chat-state";
import { ingest } from "./notif-store";
import { SPACE_SWITCH_EVENT, getSpace, handleSpaceStatus, spaceHeaders, withSpaceQuery } from "./space";

export type ConnStatus = "connecting" | "open" | "closed";
export class ChatSocket {
  private ws: WebSocket | null = null; private closed = false; private retry = 0; private ping: number | undefined; private timer: number | undefined; private neverOpened = 0;
  constructor(private convId: string, private getSince: () => number, private onFrame: (f: Frame) => void, private onStatus: (s: ConnStatus) => void, private onGone?: () => void) {
    this.onVis = this.onVis.bind(this); this.onOff = this.onOff.bind(this); this.onOn = this.onOn.bind(this);
    document.addEventListener("visibilitychange", this.onVis);
    addEventListener("online", this.onOn);
    addEventListener("offline", this.onOff);
    addEventListener(SPACE_SWITCH_EVENT, this.onSwitch);
    this.open();
  }
  private onSwitch = () => this.close(); // a space switch closes the socket before the page reloads: no frame of the old space lands in the new one
  private onVis() { if (!this.closed && document.visibilityState === "visible" && this.ws?.readyState !== WebSocket.OPEN) this.open(); }
  // The browser knows the network is gone before a half-open socket does (and emulated offline never closes it): show it now.
  private onOff() { if (this.closed) return; this.onStatus("closed"); try { this.ws?.close(); } catch {} }
  // Network is back: don't wait out the backoff (up to 8 s) or a socket that was CONNECTING into the void; retry now.
  private onOn() { if (this.closed || this.ws?.readyState === WebSocket.OPEN) return; this.retry = 0; clearTimeout(this.timer); try { this.ws?.close(); } catch {} this.ws = null; this.open(); }
  private open() {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(this.timer);
    this.onStatus(navigator.onLine === false ? "closed" : "connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let opened = false;
    const ws = new WebSocket(withSpaceQuery(`${proto}://${location.host}/api/conversations/${this.convId}/ws?since=${this.getSince()}`));
    this.ws = ws;
    ws.onopen = () => { opened = true; this.retry = 0; this.neverOpened = 0; this.onStatus("open"); clearInterval(this.ping); this.ping = setInterval(() => { try { ws.send('{"t":"ping"}'); } catch {} }, 25000) as unknown as number; };
    ws.onmessage = (m) => { try { const f = JSON.parse(m.data as string); if (f?.t === "notif") ingest(f.n); else this.onFrame(f); } catch {} };
    ws.onclose = (ev) => {
      console.debug("chat ws close", ev?.code, ev?.wasClean, (ev?.reason ?? "").slice(0, 120));
      if (this.ws !== ws) return; // superseded (reconnect / back online): its late close must not flip the new socket to "closed"
      clearInterval(this.ping); this.ws = null;
      this.onStatus("closed");
      if (this.closed) return;
      // A browser can't see the HTTP status of a refused upgrade, so after repeated failures to even open, ask the plain API:
      // 404 means the conversation is gone - stop instead of reconnecting forever.
      if (!opened && ++this.neverOpened >= 2 && this.onGone) {
        void fetch(`/api/conversations/${this.convId}`, { credentials: "same-origin", headers: spaceHeaders() }).then(async (r) => {
          if (r.status === 404) { this.closed = true; this.onGone?.(); }
          else if (r.status === 403 && getSpace() === "open") { // Open was turned off under this tab: leave for Business instead of reconnecting forever
            const d = await r.json().catch(() => null); const before = getSpace(); handleSpaceStatus(403, d);
            if (before !== getSpace()) { this.closed = true; clearTimeout(this.timer); }
          }
        }).catch(() => null);
      }
      const d = Math.min(8000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), d) as unknown as number;
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  /** Force a fresh connection (after a resync, so `since` is re-read). */
  reconnect() { try { this.ws?.close(); } catch {} this.ws = null; this.open(); }
  send(o: unknown): boolean { if (this.ws?.readyState !== WebSocket.OPEN) return false; this.ws.send(JSON.stringify(o)); return true; }
  close() { this.closed = true; clearInterval(this.ping); clearTimeout(this.timer); document.removeEventListener("visibilitychange", this.onVis); removeEventListener("online", this.onOn); removeEventListener("offline", this.onOff); removeEventListener(SPACE_SWITCH_EVENT, this.onSwitch); try { this.ws?.close(); } catch {} }
}
