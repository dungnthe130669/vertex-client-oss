// In-repo stand-ins for the two ends of the VCL bridge (docs/vertex-client-vcl-protocol.md): FakeDaemon plays the `vcl` daemon, FakeApp plays the PWA.
// Both take a `connect` function that returns an already-open WebSocket, so the same client runs against the DO in workerd (test-cf/) or any other transport.
// They implement the protocol's reliability rules exactly as a real client must: the daemon keeps every event until acked and resends after `welcome`,
// skips commands whose cseq it already processed, and the app tracks the last seq it applied and fails loudly on a gap or a duplicate.
export type Frame = Record<string, any>;
type Open = () => Promise<WebSocket>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

abstract class Base {
  frames: Frame[] = [];
  ws: WebSocket | null = null;
  closed: { code: number; reason: string } | null = null;
  protected attach(ws: WebSocket) {
    this.ws = ws; this.closed = null; (ws as WebSocket & { accept(): void }).accept(); // workerd: the client end of a Response.webSocket must be accepted
    ws.addEventListener("message", (m: MessageEvent) => { const f = JSON.parse(String(m.data)); this.frames.push(f); this.onFrame(f); });
    ws.addEventListener("close", (e: CloseEvent) => { if (this.ws === ws) this.closed = { code: e.code, reason: e.reason }; });
  }
  protected abstract onFrame(f: Frame): void;
  send(o: Frame) { this.ws!.send(JSON.stringify(o)); }
  drop() { try { this.ws?.close(1001, "dropped"); } catch { /* already closed */ } }
  async until(pred: () => boolean, what = "condition", ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}; frames=${JSON.stringify(this.frames).slice(0, 1500)}`); await sleep(5); } }
  async waitFrame(pred: (f: Frame) => boolean, what = "frame") { await this.until(() => this.frames.some(pred), what); return this.frames.find(pred)!; }
}

export class FakeDaemon extends Base {
  private dseq = 0;
  private unacked: { dseq: number; e: Frame }[] = [];
  private history: { dseq: number; e: Frame }[] = [];   // everything ever emitted, so a test can replay a frame the hub already acked
  lastCseq = 0;
  processed: Frame[] = [];   // commands handed to the "agent", exactly once each
  barriers: Frame[] = [];   // devv2s3v replay-barrier commands (processed + cacked in order, not agent work)
  duplicatesSkipped = 0;
  autoAck = true;            // false: take the command but never send cack (simulates a crash before acking)
  resyncs = 0;
  info: Record<string, unknown> = { name: "fake-daemon", version: "0" };   // what the next hello carries (tests add `roots`)
  constructor(private open: Open) { super(); }
  async connect() { this.frames = []; this.attach(await this.open()); }
  /** Send an event with the next dseq; it stays in `unacked` until the hub acks it, whether or not the socket is up. */
  emit(type: string, fields: Frame = {}) {
    const f = { dseq: ++this.dseq, e: { type, ...fields } };
    this.unacked.push(f); this.history.push(f);
    this.tx(f);
    return f.dseq;
  }
  /** Re-send a frame the hub may already have (a reconnecting daemon cannot know which ones arrived). */
  resend(dseq: number) { const f = this.history.find((x) => x.dseq === dseq); if (f) this.tx(f); }
  private tx(f: { dseq: number; e: Frame }) { if (this.ws && !this.closed) try { this.send({ t: "ev", ...f }); } catch { /* socket gone: stays unacked */ } }
  get pendingAcks() { return this.unacked.length; }
  protected onFrame(f: Frame) {
    if (f.t === "welcome") {
      this.unacked = this.unacked.filter((x) => x.dseq > f.lastDseq);   // the hub already has everything up to lastDseq
      this.send({ t: "hello", lastCseq: this.lastCseq, info: this.info });
      for (const x of this.unacked) this.tx(x);
    } else if (f.t === "ack") this.unacked = this.unacked.filter((x) => x.dseq > f.dseq);
    else if (f.t === "resync") { this.resyncs++; for (const x of this.unacked.filter((y) => y.dseq >= f.expect)) this.tx(x); }
    else if (f.t === "cmd") {
      if (f.cseq <= this.lastCseq) { this.duplicatesSkipped++; this.send({ t: "cack", cseq: this.lastCseq }); return; }   // like the real daemon (vcl hub.mjs): a duplicate is re-cacked cumulatively
      this.lastCseq = f.cseq; if (typeof f.cid === "string" && f.cid.startsWith("barrier:")) this.barriers.push(f); else this.processed.push(f);   // devv2s3v: the hub's replay barrier (a no-op deny) is cacked like any command but is not agent work
      if (this.autoAck) this.send({ t: "cack", cseq: f.cseq });
    }
  }
}

export class FakeApp extends Base {
  seq = 0;                 // last event seq applied
  events: Frame[] = [];    // applied, in order, each exactly once
  errors: string[] = [];
  hello: Frame | null = null;
  constructor(private open: (since: number) => Promise<WebSocket>) { super(); }
  async connect() { this.frames = []; this.attach(await this.open(this.seq)); await this.waitFrame((f) => f.t === "hello", "hello"); }
  protected onFrame(f: Frame) {
    if (f.t === "hello") this.hello = f;
    if (f.t === "ev") {
      if (f.seq <= this.seq) { this.errors.push(`duplicate seq ${f.seq} (have ${this.seq})`); return; }
      if (this.seq > 0 && f.seq !== this.seq + 1) this.errors.push(`gap: ${this.seq} -> ${f.seq}`);
      this.seq = f.seq; this.events.push(f);
    }
  }
  types() { return this.events.map((e) => e.e.type as string); }
}
