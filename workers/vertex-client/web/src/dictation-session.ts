// The SpeechRecognition instance lifecycle behind the composer's dictation, kept free of preact/DOM so bun:test drives it with a fake engine.
// Rules: ONE live instance. An instance is "released" only when its own onend has fired; a timeout or an abort() exception never counts. An instance whose onend did not
// come stays in the registry as a zombie (abort() is retried), and no new instance starts while any zombie is unconfirmed: the host shows "busy" with Retry instead.
import { END_WAIT_MS, LAUNCH_STUCK_MS, SETTLE_MS, STOP_ABORT_MS, ZOMBIE_ATTEMPTS, ZOMBIE_RETRY_CAP, ZOMBIE_RETRY_MS } from "./dictation-logic";

export type Rec = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null };
export type Inst = { r: Rec; ended: boolean; stopping: boolean };
export interface Host {
  ctor(): (new () => Rec) | null;
  lang(): string;
  listening(): boolean;                  // the state machine still wants a live instance
  onResult(list: any): void;
  onError(code: string): void;           // engine error of the CURRENT instance, or a launch failure ("audio-capture")
  onEnd(): void;                         // the CURRENT instance ended by itself or after stop()
  onStarted(): void;
  onBusy(): void;                        // a previous instance could not be confirmed ended
}
export interface Timing { settle: number; endWait: number; stopAbort: number; zombieAttempts: number; zombieRetry: number; zombieRetryCap: number; launchStuck: number }
export const TIMING: Timing = { settle: SETTLE_MS, endWait: END_WAIT_MS, stopAbort: STOP_ABORT_MS, zombieAttempts: ZOMBIE_ATTEMPTS, zombieRetry: ZOMBIE_RETRY_MS, zombieRetryCap: ZOMBIE_RETRY_CAP, launchStuck: LAUNCH_STUCK_MS };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DictSession {
  cur: Inst | null = null;
  private all = new Set<Inst>();          // every instance created and not yet confirmed ended
  private epoch = 0;                      // bumped to cancel any launch in flight
  launching = false;
  private launchedAt = 0;
  lastEvt = 0;
  constructor(private host: Host, private t: Timing = TIMING) {}

  /** Instances whose onend has not been seen. */
  unconfirmed(): number { let n = 0; for (const i of this.all) if (!i.ended) n++; return n; }
  /** `launching` has stayed true too long (a hung launch): the host's watchdog calls this. */
  launchStuck(): boolean { return this.launching && Date.now() - this.launchedAt > this.t.launchStuck; }

  private note() { this.lastEvt = Date.now(); }
  private track(i: Inst) { i.r.onend = () => { i.ended = true; this.all.delete(i); if (this.cur === i) this.host.onEnd(); }; }

  /** abort() it (handlers off, its own end tracker kept) and wait up to endWait for onend. True only when onend really came. */
  private async retire(i: Inst): Promise<boolean> {
    if (i.ended) return true;
    i.r.onresult = null; i.r.onerror = null;
    try { i.r.abort(); } catch { /* an exception is NOT release: wait for onend like any other */ }
    const t0 = Date.now();
    while (!i.ended && Date.now() - t0 < this.t.endWait) await sleep(Math.min(25, this.t.endWait));
    if (!i.ended) this.zombie(i);
    return i.ended;
  }
  private zombieTimers = new Map<Inst, ReturnType<typeof setTimeout>>();
  private zombie(i: Inst) {
    if (this.zombieTimers.has(i)) return;
    let n = 0;
    const tick = () => {
      if (i.ended) { this.zombieTimers.delete(i); return; }
      if (n++ >= this.t.zombieRetryCap) { this.zombieTimers.delete(i); return; }
      try { i.r.abort(); } catch { /* retry later */ }
      this.zombieTimers.set(i, setTimeout(tick, this.t.zombieRetry));
    };
    this.zombieTimers.set(i, setTimeout(tick, this.t.zombieRetry));
  }
  /** abort + wait, up to `zombieAttempts` rounds, over everything still unconfirmed. True when nothing is left holding the mic. */
  private async drain(): Promise<boolean> {
    for (let k = 0; k < this.t.zombieAttempts; k++) {
      const open = [...this.all].filter((i) => !i.ended);
      if (!open.length) return true;
      await Promise.all(open.map((i) => this.retire(i)));
    }
    return this.unconfirmed() === 0;
  }

  /** Start (or replace with) a fresh instance after the old one is confirmed ended. */
  launch(delayMs: number) {
    const my = ++this.epoch;
    const old = this.cur; this.cur = null;
    this.launching = true; this.launchedAt = Date.now();
    void (async () => {
      let inst: Inst | null = null;
      try {
        if (old) { old.r.onresult = null; old.r.onerror = null; } // its end tracker stays: it is how a zombie gets confirmed
        if (!(await this.drain())) { if (this.epoch === my) { this.launching = false; this.host.onBusy(); } return; }
        await sleep(Math.max(delayMs, this.t.settle));
        if (this.epoch !== my || !this.host.listening()) { if (this.epoch === my) this.launching = false; return; }
        const C = this.host.ctor();
        if (!C) { this.launching = false; this.host.onError("network"); return; }
        const created: Inst = { r: new C(), ended: false, stopping: false };
        inst = created; this.all.add(created);
        const r = created.r;
        r.lang = this.host.lang(); r.continuous = true; r.interimResults = true;
        r.onresult = (e) => { if (this.cur === created) { this.note(); this.host.onResult(e.results); } };
        r.onerror = (e) => { if (this.cur === created) { this.note(); this.host.onError(String(e?.error ?? "")); } };
        this.track(created);
        this.cur = created; this.launching = false; this.note();
        r.start();
        this.host.onStarted();
      } catch {
        if (this.epoch !== my) return;        // superseded (Stop / newer launch) while failing: that path owns the cleanup
        this.launching = false;
        if (inst) { if (this.cur === inst) this.cur = null; await this.retire(inst); }
        if (this.epoch !== my) return;
        this.host.onError("audio-capture");   // same retry-once path as an engine audio-capture
      }
    })();
  }

  /** Stop: stop(), then abort() after stopAbort if onend has not come. Idle only once the instance is confirmed ended; else the host is told "busy". */
  stop() {
    const inst = this.cur;
    if (!inst || inst.ended) { this.epoch++; this.launching = false; this.cur = null; this.host.onEnd(); return; } // Stop during a restart gap: nothing live to wait for
    if (inst.stopping) return;
    inst.stopping = true;
    const my = this.epoch;
    try { inst.r.stop(); } catch { /* abort below */ }
    setTimeout(() => {
      if (inst.ended || this.cur !== inst || this.epoch !== my) return;
      this.cur = null; inst.r.onresult = null; inst.r.onerror = null;
      void this.drain().then((ok) => { if (this.epoch !== my) return; if (ok) this.host.onEnd(); else this.host.onBusy(); });
    }, this.t.stopAbort);
  }

  /** Back to idle / unmount / page hidden: nothing may keep the audio session. Zombies are retried in the background. */
  release() {
    this.epoch++; this.launching = false;
    const c = this.cur; this.cur = null;
    if (c) { c.r.onresult = null; c.r.onerror = null; }
    void this.drain();
  }
  /** Give up on a hung launch (watchdog). */
  abandonLaunch() { this.epoch++; this.launching = false; void this.drain(); }
}
