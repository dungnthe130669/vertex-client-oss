import { describe, expect, test } from "bun:test";
import { DictSession, type Host, type Timing } from "../web/src/dictation-session";

// A fake engine: every instance records what happened to it; `ignoreAbort` makes abort() a no-op (iOS delaying it), `throwAbort` makes it throw, `startThrows` makes start() throw
// (optionally after "opening the mic", i.e. the instance counts as live until aborted).
const T: Timing = { settle: 5, endWait: 40, stopAbort: 30, zombieAttempts: 2, zombieRetry: 20, zombieRetryCap: 3, launchStuck: 80 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Fake {
  static all: Fake[] = []; static ignoreAbort = false; static throwAbort = false; static startThrows = false; static ctorThrows = false; static aborts = 0;
  ended = false; started = false; aborted = 0; lang = ""; continuous = false; interimResults = false;
  onresult: any = null; onerror: any = null; onend: any = null;
  constructor() { if (Fake.ctorThrows) throw new Error("ctor"); Fake.all.push(this); }
  end() { if (this.ended) return; this.ended = true; this.onend && this.onend(); }
  start() { this.started = true; if (Fake.startThrows) throw new Error("start"); }
  stop() { setTimeout(() => this.end(), 5); }
  abort() { this.aborted++; Fake.aborts++; if (Fake.throwAbort) throw new Error("abort"); if (!Fake.ignoreAbort) setTimeout(() => this.end(), 5); }
}
const reset = () => { Fake.all = []; Fake.ignoreAbort = Fake.throwAbort = Fake.startThrows = Fake.ctorThrows = false; Fake.aborts = 0; };
const mk = (listening = true) => {
  const ev: string[] = [];
  const host: Host = { ctor: () => Fake as any, lang: () => "en-US", listening: () => listening, onResult: () => ev.push("result"), onError: (c) => ev.push(`error:${c}`), onEnd: () => ev.push("end"), onStarted: () => ev.push("started"), onBusy: () => ev.push("busy") };
  const s = new DictSession(host, T);
  return { s, ev, setListening: (v: boolean) => { listening = v; } };
};
const live = () => Fake.all.filter((i) => i.started && !i.ended).length;

describe("DictSession: an instance is released only when its onend came", () => {
  test("baseline: launch starts one configured instance", async () => {
    reset(); const { s, ev } = mk(); s.launch(0); await wait(40);
    expect(Fake.all.length).toBe(1); expect(live()).toBe(1); expect(ev).toEqual(["started"]);
    expect(Fake.all[0].continuous && Fake.all[0].interimResults && Fake.all[0].lang === "en-US").toBe(true);
  });
  test("restart waits for the old onend: never two live instances", async () => {
    reset(); const { s } = mk(); s.launch(0); await wait(40);
    Fake.all[0].end(); s.launch(5); await wait(50);
    expect(Fake.all.length).toBe(2); expect(live()).toBe(1);
  });
  test("abort() ignored (no onend): NO new instance starts, host is told busy, the zombie stays registered", async () => {
    reset(); const { s, ev } = mk(); s.launch(0); await wait(40);
    Fake.ignoreAbort = true; s.launch(0); await wait(250);
    expect(Fake.all.length).toBe(1);                 // a second instance was never created
    expect(ev).toContain("busy"); expect(s.unconfirmed()).toBe(1);
    expect(Fake.all[0].aborted).toBeGreaterThan(1);  // abort() was retried
  });
  test("abort() throwing is not release either", async () => {
    reset(); const { s, ev } = mk(); s.launch(0); await wait(40);
    Fake.throwAbort = true; s.launch(0); await wait(250);
    expect(Fake.all.length).toBe(1); expect(ev).toContain("busy");
  });
  test("Retry after busy re-attempts the abort and starts once the engine finally ends the zombie", async () => {
    reset(); const { s, ev } = mk(); s.launch(0); await wait(40);
    Fake.ignoreAbort = true; s.launch(0); await wait(250); expect(ev).toContain("busy");
    Fake.ignoreAbort = false; s.launch(0); await wait(150);
    expect(Fake.all.length).toBe(2); expect(live()).toBe(1); expect(s.unconfirmed()).toBe(1);
    expect(Fake.all[0].ended).toBe(true);
  });
  test("zombie abort retries are capped", async () => {
    reset(); const { s } = mk(); s.launch(0); await wait(40);
    Fake.ignoreAbort = true; s.launch(0); await wait(400); const n = Fake.all[0].aborted; await wait(150);
    expect(Fake.all[0].aborted).toBe(n);
  });
  test("Stop: stop() then abort(); if the engine never ends, idle is NOT reported, busy is", async () => {
    reset(); const { s, ev } = mk(); s.launch(0); await wait(40);
    Fake.all[0].stop = () => {}; Fake.ignoreAbort = true; s.stop(); await wait(250);
    expect(ev).not.toContain("end"); expect(ev).toContain("busy"); expect(Fake.all[0].aborted).toBeGreaterThan(0);
  });
  test("Stop: a normal engine ends after stop() -> end, no abort needed", async () => {
    reset(); const { s, ev } = mk(); s.launch(0); await wait(40); s.stop(); await wait(60);
    expect(ev).toEqual(["started", "end"]); expect(Fake.all[0].aborted).toBe(0);
  });
  test("Stop when abort is needed and works: end after confirmation", async () => {
    reset(); const { s, ev } = mk(); s.launch(0); await wait(40);
    Fake.all[0].stop = () => {}; s.stop(); await wait(120);
    expect(ev).toEqual(["started", "end"]); expect(Fake.all[0].aborted).toBeGreaterThan(0); expect(Fake.all[0].ended).toBe(true);
  });
  test("Stop during a restart gap: nothing live, end at once, no instance gets created later", async () => {
    reset(); const { s, ev, setListening } = mk(); s.launch(0); await wait(40);
    Fake.all[0].end(); ev.length = 0; s.launch(50); await wait(10); setListening(false); s.stop(); await wait(100);
    expect(ev).toEqual(["end"]); expect(Fake.all.length).toBe(1);
  });
});

describe("DictSession: launch failures", () => {
  test("start() throws: the instance is aborted/retired first, then audio-capture is reported; the retry waits for it", async () => {
    reset(); const { s, ev } = mk(); Fake.startThrows = true; s.launch(0); await wait(100);
    expect(Fake.all[0].aborted).toBeGreaterThan(0); expect(Fake.all[0].ended).toBe(true);
    expect(ev).toEqual(["error:audio-capture"]);
    // the retry: previous instance already confirmed ended, so exactly one new instance, no overlap
    Fake.startThrows = false; s.launch(0); await wait(60);
    expect(Fake.all.length).toBe(2); expect(live()).toBe(1);
  });
  test("start() throws and the abort is ignored: the zombie blocks the retry (busy), not a second instance", async () => {
    reset(); const { s, ev } = mk(); Fake.startThrows = true; Fake.ignoreAbort = true; s.launch(0); await wait(120);
    expect(ev).toContain("error:audio-capture");
    Fake.startThrows = false; s.launch(0); await wait(250);
    expect(Fake.all.length).toBe(1); expect(ev).toContain("busy");
  });
  test("constructor throws: launching is released and the error path runs", async () => {
    reset(); const { s, ev } = mk(); Fake.ctorThrows = true; s.launch(0); await wait(60);
    expect(s.launching).toBe(false); expect(ev).toEqual(["error:audio-capture"]);
  });
  test("a launch stuck longer than launchStuck is detected and can be abandoned", async () => {
    reset(); const { s } = mk(); const x = s as any;
    x.launching = true; x.launchedAt = Date.now() - 10;  expect(s.launchStuck()).toBe(false);
    x.launchedAt = Date.now() - 100;                      expect(s.launchStuck()).toBe(true);
    s.abandonLaunch(); expect(s.launching).toBe(false); expect(s.launchStuck()).toBe(false);
  });
});
