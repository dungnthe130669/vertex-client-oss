// In-process stand-in for the DeviceHub's PWA side (docs/vertex-client-vcl-protocol.md): ordered seq log, hello{seq,minSeq,online,resync,now}, since= replay,
// cmd -> cmd_ack, approval_res -> ok + approval_resolved. MockSocket satisfies both the browser-style (onmessage) and the FakeApp-style (addEventListener) client.
export type Frame = Record<string, any>;
export class MockSocket {
  readyState = 0; onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  private ls: Record<string, ((e: any) => void)[]> = {};
  constructor(public hub: MockHub, public since: number) {}
  accept() {}
  addEventListener(t: string, f: (e: any) => void) { (this.ls[t] ??= []).push(f); }
  fire(t: string, e: any) { (this as any)["on" + t]?.(e); for (const f of this.ls[t] ?? []) f(e); }
  send(s: string) { this.hub.fromClient(this, JSON.parse(s)); }
  close(code = 1000, reason = "") { if (this.readyState === 3) return; this.readyState = 3; this.hub.socks.delete(this); queueMicrotask(() => this.fire("close", { code, reason })); }
  deliver(f: Frame) { if (this.readyState === 1) this.fire("message", { data: JSON.stringify(f) }); }
}
export class MockHub {
  log: { seq: number; ts: number; e: Frame }[] = [];
  socks = new Set<MockSocket>();
  received: Frame[] = [];
  opens: number[] = [];       // the `since` each connection used
  minSeq = 1; resyncNext = false; online = true; skewMs = 0; self: Record<string, unknown> = {};
  readonly WS: any;
  constructor() { const hub = this; this.WS = class { constructor(url: string) { const since = Number(new URL(url.replace(/^ws/, "http")).searchParams.get("since") ?? 0); return hub.accept(since); } }; }
  accept(since: number): MockSocket {
    const s = new MockSocket(this, since); this.opens.push(since);
    setTimeout(() => {
      s.readyState = 1; this.socks.add(s); s.fire("open", {});
      const resync = this.resyncNext; this.resyncNext = false;
      s.deliver({ t: "hello", v: 1, seq: this.seq, minSeq: this.minSeq, online: this.online, resync, now: Date.now() + this.skewMs, ...this.self });
      if (!resync) for (const r of this.log) if (r.seq > since) s.deliver({ t: "ev", ...r });
    }, 0);
    return s;
  }
  get seq() { return this.log.length ? this.log[this.log.length - 1].seq : 0; }
  emit(e: Frame) { const r = { seq: this.seq + 1, ts: Date.now(), e }; this.log.push(r); for (const s of this.socks) s.deliver({ t: "ev", ...r }); return r.seq; }
  drop() { for (const s of [...this.socks]) s.close(1006, "dropped"); }
  fromClient(s: MockSocket, f: Frame) {
    this.received.push(f);
    if (f.t === "ping") s.deliver({ t: "pong" });
    else if (f.t === "cmd") s.deliver({ t: "cmd_ack", cid: f.cid, cseq: this.received.length, dup: false, queued: !this.online });
    else if (f.t === "approval_res") {
      const req = this.log.find((r) => r.e.type === "approval_request" && r.e.rid === f.rid);
      if (!req) return s.deliver({ t: "err", code: "unknown_request", rid: f.rid });
      if (this.log.some((r) => r.e.type === "approval_resolved" && r.e.rid === f.rid)) return s.deliver({ t: "err", code: "already_resolved", rid: f.rid });
      s.deliver({ t: "ok", of: "approval_res", rid: f.rid, state: f.allow ? "allowed" : "denied" });
      this.emit({ type: "approval_resolved", rid: f.rid, state: f.allow ? "allowed" : "denied", by: "me" });
    }
  }
}
