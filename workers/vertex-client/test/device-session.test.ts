import { describe, expect, test } from "bun:test";
import { step, initState, deadline, BUF_BYTES, HOLD_RESERVED_MS, HOLD_IDLE_MS, type State, type Input, type InputNoNow, type Effect, type Ev, type Who } from "../src/device-session";

// devv2s3r: the pure session reducer. Part A = one test per round-4 finding. Part B = model-based exploration with invariants checked after EVERY step.
const T0 = 1_700_000_000_000;
const A: Who = { k: "chat", conv: "convAAAA" }, B: Who = { k: "chat", conv: "convBBBB" }, P: Who = { k: "page" };
class M {
  s: State = initState(); now = T0; fx: Effect[] = []; n = 0;
  go(i: InputNoNow & { now?: number }) { const o = step(this.s, { ...i, now: i.now ?? this.now } as Input); this.s = o.s; this.fx = o.fx; return o.r; }
  cmd(who: Who, kind: "start" | "say" | "stop", cid = `c${++this.n}`) { return Object.assign(this.go({ t: "cmd", who, cid, kind, frame: { kind } }), { cid }); }
  online(lastCseq = 0, envOn = true) { this.go({ t: "hello", lastCseq, envOn }); }
  ev(e: Ev) { this.go({ t: "event", e }); return this.fx.filter((f): f is Extract<Effect, { k: "emit" }> => f.k === "emit"); }
  adv(ms: number) { this.now += ms; this.go({ t: "tick" }); }
  get h() { return this.s.holder; }
  sentKinds() { return this.fx.filter((f) => f.k === "send" && !String((f as any).cid).startsWith("barrier:")).map((f: any) => `${f.kind}:${f.cid}`); }   // the devv2s3v replay barrier (a no-op hub deny) is asserted on its own
}

describe("round-4 findings", () => {
  test("1 older daemon: cid-less session_started BEFORE its cack is buffered, then promoted and tagged to the chat", () => {
    const m = new M(); m.online(); const r = m.cmd(A, "start", "s1"); expect(m.sentKinds()).toEqual([]); m.go({ t: "deliver", envOn: true });
    expect(m.sentKinds()).toEqual(["start:s1"]);
    expect(m.ev({ type: "session_started" })).toEqual([]);                          // held back: nothing emitted yet
    expect(m.ev({ type: "assistant_text", text: "hi" })).toEqual([]);
    m.go({ t: "cack", cseq: (r as any).cseq });
    const em = m.fx.filter((f) => f.k === "emit") as any[];
    expect(em.map((x) => [x.e.type, x.tag])).toEqual([["session_started", "convAAAA"], ["assistant_text", "convAAAA"]]);
    expect(m.h?.phase).toBe("active");
    expect(m.cmd(A, "say").ok).toBe(true);                                         // say is accepted (not 409)
  });
  test("2 expired queued start never executes; active expiry reconciles through draining before a replacement is admitted", () => {
    const m = new M(); m.cmd(A, "start"); m.adv(HOLD_RESERVED_MS + 1);              // offline, never sent
    expect(m.h).toBeNull(); expect(m.s.entries).toEqual([]);
    const rb = m.cmd(B, "start", "sb"); m.online(); expect(m.sentKinds()).toEqual(["start:sb"]); expect((rb as any).ok).toBe(true);
    // active session ages out: stop first, replacement refused until confirmed
    const m2 = new M(); m2.online(); const r = m2.cmd(A, "start", "s1"); m2.go({ t: "deliver", envOn: true }); m2.go({ t: "cack", cseq: (r as any).cseq }); m2.ev({ type: "session_started", cid: "s1" });
    m2.adv(HOLD_IDLE_MS + 1); expect(m2.h?.phase).toBe("draining"); expect(m2.fx.some((f) => f.k === "enqueue" && f.kind === "stop")).toBe(true);
    expect(m2.cmd(B, "start")).toMatchObject({ ok: false, code: "busy" });
    m2.ev({ type: "session_stopped" }); expect(m2.h).toBeNull(); expect(m2.cmd(B, "start").ok).toBe(true);
  });
  test("3 foreign events neither release nor refresh a reservation", () => {
    const m = new M(); m.online(); m.cmd(P, "say", "legacy1"); const r = m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true });
    const before = JSON.stringify(m.h);
    m.ev({ type: "session_error", cid: "legacy1", code: "no_session" }); expect(JSON.stringify(m.h)).toBe(before);
    m.adv(5 * 60_000); m.ev({ type: "assistant_text", cid: "other" }); expect(m.h?.since).toBe(T0);   // not renewed
    m.go({ t: "cack", cseq: (r as any).cseq }); m.ev({ type: "session_started", cid: "s1" }); expect(m.h?.phase).toBe("active");
  });
  test("5/7 page start while a holder is ACTIVE is refused and leaves the holder untouched", () => {
    const m = new M(); m.online(); const r = m.cmd(P, "start", "p1"); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: (r as any).cseq }); m.ev({ type: "session_started", cid: "p1" });
    const before = JSON.stringify(m.s.holder); expect(m.cmd(P, "start", "p2")).toMatchObject({ ok: false, code: "busy" }); expect(JSON.stringify(m.s.holder)).toBe(before);
    expect(m.cmd(A, "start")).toMatchObject({ ok: false, code: "busy" });
    m.ev({ type: "session_error", cid: "p2", code: "busy" }); expect(JSON.stringify(m.s.holder)).toBe(before);   // its refusal is foreign
  });
  test("8 approvals carry the generation: a stale answer is rejected with no allow frame, also for the same conversation's NEW session", () => {
    const m = new M(); m.online(); let r: any = m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: r.cseq }); m.ev({ type: "session_started", cid: "s1" });
    m.go({ t: "approval_req", rid: "r1", e: { type: "approval_request" }, ev: {}, tool: "Bash", expiresAt: Math.floor(T0 / 1000) + 600 });
    m.ev({ type: "session_ended" }); expect(m.h).toBeNull();
    expect(m.s.appr[0].state).toBe("expired");                                       // closed on release
    r = m.cmd(A, "start", "s2"); expect(r.ok).toBe(true);
    const a = m.go({ t: "answer", who: A, rid: "r1", allow: true }); expect(a.ok).toBe(false);
    m.go({ t: "deliver", envOn: true }); expect(m.fx.some((f) => f.k === "send" && (f as any).cid === "approval:r1" && m.s.entries.find((e) => e.cseq === (f as any).cseq)?.allow === true)).toBe(false);
    expect(m.s.entries.some((e) => e.kind === "approval" && e.allow === true)).toBe(false);
  });
  test("6 flag_off / chat_deleted / env-off delivery keep a cleanup path: stop allowed, undelivered work cancelled, release after confirmation", () => {
    for (const kill of [(m: M) => m.go({ t: "flag_off", all: false }), (m: M) => m.go({ t: "chat_deleted", conv: "convAAAA" }), (m: M) => m.go({ t: "deliver", envOn: false })]) {
      const m = new M(); m.online(); const r: any = m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: r.cseq }); m.ev({ type: "session_started", cid: "s1" });
      m.cmd(A, "say", "u1");                                                          // queued, unsent
      kill(m); expect(m.h?.phase).toBe("draining"); expect(m.s.entries.some((e) => e.cid === "u1")).toBe(false);
      const k1 = m.sentKinds(); m.go({ t: "deliver", envOn: false }); expect([...k1, ...m.sentKinds()].some((x) => x.startsWith("stop:"))).toBe(true);
      expect(m.cmd(A, "stop").ok).toBe(true);                                         // a stop is accepted for the holder
      m.ev({ type: "session_stopped" }); expect(m.h).toBeNull();
    }
    const m = new M(); m.cmd(A, "start", "s1"); m.go({ t: "flag_off", all: false }); expect(m.h).toBeNull(); expect(m.s.entries).toEqual([]);   // never sent: dropped outright
  });
  test("6b offline daemon: draining is released by offline-expiry and the stop stays queued for the reconnect", () => {
    const m = new M(); m.online(); const r: any = m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: r.cseq }); m.ev({ type: "session_started", cid: "s1" });
    m.go({ t: "flag_off", all: false }); m.go({ t: "offline" }); m.adv(3 * 60_000); expect(m.h).toBeNull(); expect(m.s.entries.some((e) => e.kind === "stop")).toBe(true);
  });
  test("draining is also released by the cack of the hub's stop (daemon had no session: no event)", () => {
    const m = new M(); m.online(); const r: any = m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: r.cseq }); m.ev({ type: "session_started", cid: "s1" });
    m.go({ t: "chat_deleted", conv: "convAAAA" }); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: m.s.entries[0].cseq }); expect(m.h).toBeNull();
  });
  test("stop before send = zero dispatches", () => {
    const m = new M(); m.cmd(A, "start", "s1"); expect(m.cmd(A, "stop").ok).toBe(true); m.online(); expect(m.sentKinds()).toEqual([]); expect(m.h).toBeNull();
  });
  test("replacing an already-sent reservation is refused busy and DRAINS (stop first); the replacement is admitted only after the stop is confirmed (round 5 F4)", () => {
    const m = new M(); m.online(); m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true });
    expect(m.cmd(A, "start", "s2")).toMatchObject({ ok: false, code: "busy" }); expect(m.h?.phase).toBe("draining");
    m.go({ t: "deliver", envOn: true }); expect(m.sentKinds()).toEqual([`stop:hub-stop-1`]);
    expect(m.cmd(A, "start", "s2")).toMatchObject({ ok: false, code: "busy" });                         // still draining
    m.go({ t: "cack", cseq: m.s.entries.find((e) => e.kind === "stop")!.cseq }); expect(m.h).toBeNull();
    expect(m.cmd(A, "start", "s2").ok).toBe(true);
  });
  test("replacing a reservation that never left the hub just replaces it (no stop)", () => {
    const m = new M(); m.cmd(A, "start", "s1"); expect(m.cmd(A, "start", "s2").ok).toBe(true); m.online(); expect(m.sentKinds()).toEqual(["start:s2"]);
  });
});

describe("round-5 findings (reducer)", () => {
  const confirmed = (m: M, who: Who = A, cid = "s1") => { m.online(); const r: any = m.cmd(who, "start", cid); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: r.cseq }); m.ev({ type: "session_started", cid }); return r; };
  const appr = (m: M, rid: string, e: Ev = { type: "approval_request" }) => m.go({ t: "approval_req", rid, e, ev: { rid, tool: "Bash" }, tool: "Bash", expiresAt: Math.floor(m.now / 1000) + 600 });
  test("1 an offline reservation has a deadline armed and expires on a tick at it; a hello after expiry never delivers it", () => {
    const m = new M(); m.cmd(A, "start", "s1"); expect(deadline(m.s)).toBe(T0 + HOLD_RESERVED_MS + 1);
    m.now += HOLD_RESERVED_MS + 5; m.online(); expect(m.sentKinds()).toEqual([]); expect(m.h).toBeNull();      // reconnect won the race: expired at hello, nothing sent
    const n = new M(); n.cmd(A, "start", "s1"); n.now += HOLD_RESERVED_MS + 5; expect(n.cmd(B, "start", "sb").ok).toBe(true);   // admission reconciles expiry itself
  });
  test("2 disconnect before the cack keeps the held provisional events; hello.lastCseq confirming the start folds them exactly once", () => {
    const m = new M(); m.online(); const r: any = m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true });
    m.ev({ type: "session_started" }); m.ev({ type: "assistant_text", text: "x" }); m.go({ t: "offline" }); expect(m.s.buf).toHaveLength(2);
    m.go({ t: "hello", lastCseq: r.cseq, envOn: true });
    expect(m.fx.filter((f) => f.k === "emit").map((f: any) => f.e.type)).toEqual(["session_started", "assistant_text"]); expect(m.h?.phase).toBe("active"); expect(m.s.buf).toEqual([]);
    m.go({ t: "offline" }); m.go({ t: "hello", lastCseq: r.cseq, envOn: true }); expect(m.fx.filter((f) => f.k === "emit")).toEqual([]);   // not folded twice
  });
  test("2b held input of a generation that ended is never applied", () => {
    const m = new M(); m.online(); const r: any = m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true }); m.ev({ type: "assistant_text", text: "old" });
    m.cmd(A, "start", "s2"); expect(m.s.buf).toEqual([]);                                                   // replacement refusal drained the generation: held input dropped
    m.go({ t: "cack", cseq: r.cseq }); expect(m.fx.filter((f) => f.k === "emit" && (f as any).e.text === "old")).toEqual([]);
  });
  test("3 a provisional approval is held with its payload, becomes the generation's after the cack, and expires with it", () => {
    const m = new M(); m.online(); const r: any = m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true });
    m.ev({ type: "session_started" }); const o = appr(m, "r1"); expect(o).toMatchObject({ ok: true, buffered: true }); expect(m.s.appr).toEqual([]);
    m.go({ t: "cack", cseq: r.cseq });
    expect(m.s.appr[0]).toMatchObject({ rid: "r1", gen: 1, conv: "convAAAA", state: "pending" });
    expect(m.fx.find((f) => f.k === "approval_new")).toMatchObject({ rid: "r1", tool: "Bash", ev: { rid: "r1", tool: "Bash" } });
    expect(m.go({ t: "answer", who: A, rid: "r1", allow: true }).ok).toBe(true);
    appr(m, "r2"); m.ev({ type: "session_ended" }); expect(m.s.appr.find((a) => a.rid === "r2")?.state).toBe("expired");
  });
  test("5 a user Stop (chat and page) drains and releases on THAT stop's cack, with no session_stopped (daemon restart)", () => {
    for (const who of [A, P]) {
      const m = new M(); confirmed(m, who, "s1"); m.cmd(who, "say", "u1");
      const st: any = m.cmd(who, "stop", "x1"); expect(st.ok).toBe(true); expect(m.h?.phase).toBe("draining"); expect(m.s.entries.some((e) => e.cid === "u1")).toBe(false);   // pending work cancelled
      expect(m.cmd(who.k === "chat" ? B : A, "start")).toMatchObject({ ok: false, code: "busy" });
      m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: st.cseq }); expect(m.h).toBeNull(); expect(m.cmd(B, "start").ok).toBe(true);
    }
  });
  test("7 flag_off with an ACTIVE holder and no queued work drains it; a page holder survives the chat-only switch", () => {
    const m = new M(); confirmed(m); expect(m.s.entries).toEqual([]); m.go({ t: "flag_off", all: false }); expect(m.h?.phase).toBe("draining");
    const p = new M(); confirmed(p, P, "p1"); p.go({ t: "flag_off", all: false }); expect(p.h?.phase).toBe("active");
  });
  test("deadline: every non-free state has one and a tick at it changes the state", () => {
    const m = new M(); expect(deadline(m.s)).toBeNull(); m.cmd(A, "start", "s1"); expect(deadline(m.s)).not.toBeNull();
    const s0 = JSON.stringify(m.s); const o = step(m.s, { t: "tick", now: deadline(m.s)! }); expect(JSON.stringify(o.s)).not.toBe(s0);
  });
});

describe("round-6 findings (reducer)", () => {
  const apprIn = (m: M, rid: string, e: Ev = { type: "approval_request" }, ev: Record<string, unknown> = { rid, tool: "Bash" }) => m.go({ t: "approval_req", rid, e, ev, tool: "Bash", expiresAt: Math.floor(m.now / 1000) + 600 });
  /** A runs, disconnects, A's holder drains offline and its expiry frees the device WITHOUT a stop confirmation; B queues a start. */
  const handoff = () => {
    const m = new M(); m.online(); const r: any = m.cmd(A, "start", "a1"); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: r.cseq }); m.ev({ type: "session_started", cid: "a1" });
    m.go({ t: "offline" }); m.go({ t: "flag_off", all: false });                          // A's chat is cleaned up while the daemon is away: stop queued, draining
    m.adv(3 * 60_000); expect(m.h).toBeNull();                                                  // offline expiry frees it, stop unconfirmed
    const rb: any = m.cmd(B, "start", "b1"); expect(rb.ok).toBe(true);
    return { m, rb };
  };
  const emitsFor = (m: M, conv: string) => m.fx.filter((f) => (f.k === "emit" && f.tag === conv) || (f.k === "approval_new" && f.conv === conv));
  test("1 reconnect handoff fence: A's replayed text + approval + turn_done after B's start never enter B; B's own answer works", () => {
    const { m, rb } = handoff();
    m.go({ t: "hello", lastCseq: 0, envOn: true });
    expect(m.sentKinds().filter((k) => k.startsWith("start"))).toEqual([]);              // B's start is held back
    expect(m.sentKinds().some((k) => k.startsWith("stop"))).toBe(true);                  // the stop of the previous generation goes first
    for (const o of [() => m.ev({ type: "assistant_text", text: "A OLD" }), () => apprIn(m, "old1"), () => m.ev({ type: "turn_done" })]) { o(); expect(emitsFor(m, "convBBBB")).toEqual([]); }
    expect(m.s.appr.some((a) => a.rid === "old1" && a.state === "pending")).toBe(false); expect(m.s.buf).toEqual([]); expect(m.h?.phase).toBe("reserved");
    const stopSeq = m.s.entries.find((e) => e.kind === "stop")!.cseq;
    m.go({ t: "cack", cseq: stopSeq }); m.go({ t: "deliver", envOn: true });
    expect(m.sentKinds()).toEqual(["start:b1"]);                                          // delivered only after the stop's cack on THIS connection
    m.go({ t: "cack", cseq: rb.cseq }); expect(m.ev({ type: "assistant_text", text: "B NEW", cid: "b1" }).map((f) => f.tag)).toEqual(["convBBBB"]);
  });
  test("1b hello.lastCseq covering the stop does NOT satisfy the fence: a fresh stop is sent and its cack is awaited", () => {
    const { m } = handoff(); const stopSeq = m.s.entries.find((e) => e.kind === "stop")!.cseq;
    m.go({ t: "hello", lastCseq: stopSeq, envOn: true });
    expect(m.sentKinds().filter((k) => k.startsWith("start"))).toEqual([]); expect(m.sentKinds().some((k) => k.startsWith("stop"))).toBe(true);
    m.ev({ type: "assistant_text", text: "A OLD" }); expect(emitsFor(m, "convBBBB")).toEqual([]);
    m.go({ t: "cack", cseq: m.s.entries.find((e) => e.kind === "stop")!.cseq }); m.go({ t: "deliver", envOn: true }); expect(m.sentKinds()).toEqual(["start:b1"]);
  });
  test("1c a draining holder is not released by hello.lastCseq alone either (old events follow the hello)", () => {
    const m = new M(); m.online(); const r: any = m.cmd(A, "start", "a1"); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: r.cseq }); m.ev({ type: "session_started", cid: "a1" });
    const st: any = m.cmd(A, "stop", "x1"); m.go({ t: "deliver", envOn: true }); m.go({ t: "offline" });
    m.go({ t: "hello", lastCseq: st.cseq, envOn: true }); expect(m.h?.phase).toBe("draining");
    expect(m.cmd(B, "start", "b1")).toMatchObject({ ok: false, code: "busy" });
    m.go({ t: "cack", cseq: m.h!.stopSeq! }); expect(m.h).toBeNull();
  });
  test("2 buffer overflow: an approval at the cap is owner-failed (session_error provisional_overflow), the generation drains, nothing page-answerable is created", () => {
    const m = new M(); m.online(); m.cmd(A, "start", "a1"); m.go({ t: "deliver", envOn: true });
    for (let n = 0; n < 100; n++) m.ev({ type: "assistant_text", text: `p${n}` });
    expect(m.s.buf).toHaveLength(100);
    const r = apprIn(m, "ov"); expect(r).toMatchObject({ ok: false, code: "queue_full" });
    expect(m.fx.find((f) => f.k === "emit" && (f as any).e.code === "provisional_overflow")).toMatchObject({ tag: "convAAAA" });
    expect(m.h?.phase).toBe("draining"); expect(m.s.buf).toEqual([]); expect(m.s.appr.some((a) => a.conv === null && a.gen === 0)).toBe(false);
    expect(m.go({ t: "answer", who: P, rid: "ov", allow: true })).toMatchObject({ ok: false });
  });
  test("2b an approval no chat generation can claim is denied by the hub while a chat holds the device (never conv:null/gen:0 pending)", () => {
    const m = new M(); m.cmd(A, "start", "a1");                                              // reserved, never sent: nothing can legitimately ask for approval
    const r = apprIn(m, "ghost"); expect(r.ok).toBe(true);
    expect(m.s.appr.some((a) => a.state === "pending" && a.conv === null)).toBe(false);
    expect(m.fx.some((f) => f.k === "enqueue" && f.kind === "approval" && (f.frame as any).allow === false)).toBe(true);
  });
  test("3 byte budget: 60 KB events overflow long before 100 entries; the persisted state stays under budget; approvals keep only bounded fields", () => {
    const m = new M(); m.online(); m.cmd(A, "start", "a1"); m.go({ t: "deliver", envOn: true });
    let overflowed = false; for (let n = 0; n < 40 && !overflowed; n++) { m.ev({ type: "assistant_text", text: "x".repeat(60_000) }); overflowed = m.h?.phase === "draining"; expect(JSON.stringify(m.s).length).toBeLessThan(400 * 1024); }
    expect(overflowed).toBe(true);
    const n = new M(); n.online(); n.cmd(A, "start", "a1"); n.go({ t: "deliver", envOn: true });
    for (let k = 0; k < 12; k++) { apprIn(n, `big${k}`, { type: "approval_request", rid: `big${k}`, preview: "y".repeat(190_000) }, { rid: `big${k}`, tool: "Bash", preview: "y".repeat(190_000) }); expect(JSON.stringify(n.s).length).toBeLessThan(400 * 1024); }
    for (const p of n.s.buf) if ("a" in p) { expect(JSON.stringify(p.a.e).length).toBeLessThan(200); expect(JSON.stringify(p.a.ev).length).toBeLessThan(8_300); }
  });
  test("5 a provisional approval buffered at disconnect cannot become pending after reconnect; ordinary provisional events survive", () => {
    const m = new M(); m.online(); const r: any = m.cmd(A, "start", "a1"); m.go({ t: "deliver", envOn: true });
    m.ev({ type: "assistant_text", text: "keep" }); apprIn(m, "ap1"); expect(m.s.buf).toHaveLength(2);
    m.go({ t: "offline" }); expect(m.s.buf.some((p) => "a" in p)).toBe(false); expect(m.s.buf.some((p) => "e" in p)).toBe(true);
    m.go({ t: "hello", lastCseq: r.cseq, envOn: true }); const folded = m.fx.filter((f) => f.k === "emit" && (f as any).e.text === "keep");
    expect(m.s.appr.some((a) => a.rid === "ap1" && a.state === "pending")).toBe(false); expect(m.go({ t: "answer", who: A, rid: "ap1", allow: true })).toMatchObject({ ok: false });
    expect(folded).toHaveLength(1);
  });
});

describe("round-7 findings (reducer)", () => {
  const apprIn = (m: M, rid: string) => m.go({ t: "approval_req", rid, e: { type: "approval_request" }, ev: { rid, tool: "Bash" }, tool: "Bash", expiresAt: Math.floor(m.now / 1000) + 600 });
  const running = () => { const m = new M(); m.online(); const r: any = m.cmd(A, "start", "s1"); m.go({ t: "deliver", envOn: true }); m.go({ t: "cack", cseq: r.cseq }); m.ev({ type: "session_started", cid: "s1" }); return m; };
  const barrierSeq = (m: M) => { const e = [...m.s.entries].reverse().find((x) => x.src === "hub" && x.kind === "approval" && x.cid.startsWith("barrier:")); return e?.cseq ?? 0; };
  const pending = (m: M, rid: string) => m.s.appr.some((a) => a.rid === rid && a.state === "pending");
  const reconnected = () => { const m = running(); m.go({ t: "offline" }); m.go({ t: "hello", lastCseq: 1, envOn: true }); return m; };
  test("3 devv2s3v: a request replayed after a disconnect gap is never offered, at +16 s, +10 min, and after DO eviction (reviewer round-8 probe); the daemon is told to deny", () => {
    for (const waitMs of [0, 16_000, 600_000]) for (const evict of [false, true]) {
      const m = reconnected(); m.adv(waitMs); if (evict) m.s = JSON.parse(JSON.stringify(m.s));
      apprIn(m, "old-denied");
      expect(pending(m, "old-denied")).toBe(false);
      expect(m.fx.some((f) => f.k === "approval_new")).toBe(false);
      expect(m.fx.some((f) => f.k === "enqueue" && f.kind === "approval" && (f.frame as any).allow === false && (f.frame as any).rid === "old-denied")).toBe(true);
      expect(m.go({ t: "answer", who: A, rid: "old-denied", allow: true })).toMatchObject({ ok: false });
    }
  });
  test("3a the barrier is a hub-origin no-op deny that is SENT after the hello, and a request after ITS cack on the current connection is offered normally", () => {
    const m = reconnected(); const seq = barrierSeq(m); expect(seq).toBeGreaterThan(0);
    expect(m.fx.some((f) => f.k === "send" && f.cseq === seq)).toBe(true);
    m.adv(5 * 60_000); apprIn(m, "early"); expect(pending(m, "early")).toBe(false);          // time never opens it
    m.go({ t: "cack", cseq: seq }); expect(m.s.barrier ?? null).toBeNull();
    apprIn(m, "fresh"); expect(pending(m, "fresh")).toBe(true); expect(m.fx.some((f) => f.k === "approval_new")).toBe(true);
  });
  test("3b barrier persists across DO reconstruction and a reconnect before its cack: the same command is re-sent, still closed; hello.lastCseq does not open it; a second gap keeps/re-opens it", () => {
    const m = reconnected(); const seq = barrierSeq(m); m.s = JSON.parse(JSON.stringify(m.s));
    m.go({ t: "offline" }); m.go({ t: "hello", lastCseq: seq, envOn: true });                 // the daemon ran it on the old connection, but its cack never reached us
    expect(m.fx.some((f) => f.k === "send" && f.cseq === seq)).toBe(true); expect(barrierSeq(m)).toBe(seq);
    apprIn(m, "r1"); expect(pending(m, "r1")).toBe(false);
    m.go({ t: "cack", cseq: seq }); apprIn(m, "r2"); expect(pending(m, "r2")).toBe(true);
    m.go({ t: "offline" }); m.go({ t: "hello", lastCseq: seq, envOn: true }); apprIn(m, "r3"); expect(pending(m, "r3")).toBe(false);
    const seq2 = barrierSeq(m); expect(seq2).toBeGreaterThan(seq); m.go({ t: "cack", cseq: seq }); apprIn(m, "r4"); expect(pending(m, "r4")).toBe(false);   // a cack of the OLD barrier does not open the new one
    m.go({ t: "cack", cseq: seq2 }); apprIn(m, "r5"); expect(pending(m, "r5")).toBe(true);
  });
  test("3c a cack that arrives while offline does not open the barrier; revoke clears it", () => {
    const m = reconnected(); const seq = barrierSeq(m); m.go({ t: "offline" }); m.go({ t: "cack", cseq: seq }); expect(m.s.barrier).toBeTruthy();
    m.go({ t: "revoke" }); expect(m.s.barrier ?? null).toBeNull();
  });
});

// ---------------- Part B: model-based exploration ----------------
// devv2s3s: the alphabet now also covers disconnect/reconnect (hello.lastCseq, both "cack lost" and "everything sent was processed"), DO reconstruction (JSON round trip of the persisted state), user Stop (chat and page, with the
// daemon-restart variant: cack of the stop and NO session_stopped), provisional approvals (cid-less, also with the holder's cid), replacement of a sent reservation and flag_off with an active holder and no queued work.
// Three interposition modes insert a reconnect / a reconstruction between EVERY pair of steps of every sequence.
type Act = string;
const ACTS: Act[] = ["startA", "startB", "startP", "sayA", "sayB", "sayP", "stopA", "stopB", "stopP", "started", "startedLegacy", "startedForeign", "ended", "stopped", "errNoSession", "errBusyForeign", "errOwnStart", "text", "apprReq", "apprOwn", "answerA", "answerB", "answerP", "cack", "cackStop", "cackAll", "hello", "reconnect", "reconnectP", "reconstruct", "deliver", "deliverEnvOff", "offline", "tick16", "tick61", "age16", "age61", "flagOff", "flagOffAll", "deleteA", "revoke", "replayOldText", "replayOldAppr", "replayOldDone", "replayGapAppr"];
type Mode = "plain" | "reconnect" | "reconnectP" | "reconstruct";
// devv2s3t: `old*` = the daemon replays, after a reconnect, output / an approval / turn_done of a generation whose stop the hub never saw confirmed. Enabled while such a handoff is open (oldOpen), carries the generation it belongs to.
type Ctx = { s: State; now: number; n: number; maxGen: number; ackedHi: number; sentMax: number; trace: string[]; mode: Mode; steps: number; oldOpen: boolean; oldGen: number; oldStop: number; gapPend: boolean; barrierSeq: number };
const fresh = (mode: Mode): Ctx => ({ s: initState(), now: T0, n: 0, maxGen: 0, ackedHi: 0, sentMax: 0, trace: [], mode, steps: 0, oldOpen: false, oldGen: 0, oldStop: 0, gapPend: false, barrierSeq: 0 });
const who = (x: string): Who => (x.endsWith("A") ? A : x.endsWith("B") ? B : P);
/** Acts that are one reducer input. The special acts (reconnect, reconstruct) are handled in `exec`. */
function resolve(c: Ctx, a: Act): Input | null {
  const h = c.s.holder, now = c.now, cid = `c${++c.n}`;
  const rid = c.s.appr.length ? c.s.appr[c.s.appr.length - 1].rid : "r0";
  const stopSeq = [...c.s.entries].reverse().find((e) => e.kind === "stop")?.cseq ?? 0;
  const maxSeq = c.s.entries.reduce((m, e) => Math.max(m, e.cseq), 0);
  switch (a) {
    case "startA": case "startB": case "startP": return { t: "cmd", who: who(a), cid, kind: "start", frame: {}, now };
    case "sayA": case "sayB": case "sayP": return { t: "cmd", who: who(a), cid, kind: "say", frame: {}, now };
    case "stopA": case "stopB": case "stopP": return { t: "cmd", who: who(a), cid, kind: "stop", frame: {}, now };
    case "started": return { t: "event", e: { type: "session_started", cid: h?.cid ?? "none" }, now };
    case "startedLegacy": return { t: "event", e: { type: "session_started" }, now };
    case "startedForeign": return { t: "event", e: { type: "session_started", cid: "zz" }, now };
    case "ended": return { t: "event", e: { type: "session_ended" }, now };
    case "stopped": return { t: "event", e: { type: "session_stopped" }, now };
    case "errNoSession": return { t: "event", e: { type: "session_error", code: "no_session", cid: "zz" }, now };
    case "errBusyForeign": return { t: "event", e: { type: "session_error", code: "busy", cid: "zz" }, now };
    case "errOwnStart": return { t: "event", e: { type: "session_error", code: "cmd_failed", cid: h?.cid ?? "none" }, now };
    case "text": return { t: "event", e: { type: "assistant_text" }, now };
    case "apprReq": return { t: "approval_req", rid: `r${c.n}`, e: { type: "approval_request" }, ev: {}, tool: "Bash", expiresAt: Math.floor(now / 1000) + 300, now };
    case "apprOwn": return { t: "approval_req", rid: `r${c.n}`, e: { type: "approval_request", cid: h?.cid ?? "none" }, ev: {}, tool: "Bash", expiresAt: Math.floor(now / 1000) + 300, now };
    case "answerA": case "answerB": case "answerP": return { t: "answer", who: who(a), rid, allow: true, now };
    case "cack": return { t: "cack", cseq: c.s.entries.length ? c.s.entries[0].cseq : 0, now };
    case "cackStop": return stopSeq ? { t: "cack", cseq: stopSeq, now } : null;                      // the daemon processed the stop (also: restarted, no session_stopped)
    case "cackAll": return maxSeq ? { t: "cack", cseq: maxSeq, now } : null;
    case "hello": return { t: "hello", lastCseq: c.ackedHi, envOn: true, now };
    case "deliver": return { t: "deliver", envOn: true, now };
    case "deliverEnvOff": return { t: "deliver", envOn: false, now };
    case "offline": return { t: "offline", now };
    case "tick16": c.now += 16 * 60_000; return { t: "tick", now: c.now };
    case "tick61": c.now += 61 * 60_000; return { t: "tick", now: c.now };
    case "flagOff": return { t: "flag_off", all: false, now };
    case "flagOffAll": return { t: "flag_off", all: true, now };
    case "deleteA": return { t: "chat_deleted", conv: "convAAAA", now };
    case "revoke": return { t: "revoke", now };
    case "replayGapAppr": return c.barrierSeq > 0 ? { t: "approval_req", rid: `g${c.n}`, e: { type: "approval_request", gapReplay: true }, ev: { gapReplay: true }, tool: "Bash", expiresAt: Math.floor(now / 1000) + 300, now } : null;   // devv2s3u/v: the daemon replays, after a hello and BEFORE the barrier command is processed (at any logical time: no clock is involved), an approval request it already denied locally on disconnect
    case "replayOldText": return c.oldOpen ? { t: "event", e: { type: "assistant_text", old: c.oldGen }, now } : null;
    case "replayOldDone": return c.oldOpen ? { t: "event", e: { type: "turn_done", old: c.oldGen }, now } : null;
    case "replayOldAppr": return c.oldOpen ? { t: "approval_req", rid: `o${c.n}`, e: { type: "approval_request", old: c.oldGen }, ev: { old: c.oldGen }, tool: "Bash", expiresAt: Math.floor(now / 1000) + 300, now } : null;
  }
  return null;
}
const own = (h: NonNullable<State["holder"]>, e: Ev) => typeof e.cid !== "string" || e.cid === h.cid || h.cids.includes(e.cid);
const J = (x: unknown) => JSON.stringify(x);
const sizeOf = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;
const roundtrip = (s: State): State => JSON.parse(JSON.stringify(s));

function check(c: Ctx, before: State, i: Input, after: State, fx: Effect[], r: any) {
  const trace = c.trace.join(",");
  const bad = (w: string) => { throw new Error(`INVARIANT ${w}\n  mode: ${c.mode}\n  trace: ${trace}\n  input: ${J(i)}\n  state: ${J(after)}`); };
  if (after.gen < before.gen) bad("generation decreased");
  if (after.gen < c.maxGen) bad("generation not monotonic");
  c.maxGen = after.gen;
  const h = after.holder;
  // every queued non-hub start/say/approval-allow belongs to the live generation (expired generations leave no executable work)
  const seenC = new Set<number>();
  for (const e of after.entries) {
    if (seenC.has(e.cseq) || e.cseq >= after.nextCseq) bad("duplicate/invalid cseq"); seenC.add(e.cseq);
    const exec = (e.kind === "start" || e.kind === "say" || (e.kind === "approval" && e.allow === true)) && e.src !== "hub" && e.gen !== 0;
    if (exec && !(h && h.gen === e.gen && h.phase !== "draining")) bad(`executable entry of a dead generation: ${J(e)}`);
    if (e.gen > after.gen) bad("entry from the future");
  }
  if (h && h.phase === "reserved" && !h.sent && !after.entries.some((e) => e.cseq === h.startCseq)) bad("unsent reservation without its start entry");
  // no approval answerable after its generation ended
  for (const a of after.appr) if (a.state === "pending" && a.gen !== 0 && !(h && h.gen === a.gen && h.phase !== "draining")) bad(`pending approval of an ended generation: ${a.rid}`);
  // delivered frames: none of a dead generation
  for (const f of fx) if (f.k === "send") {
    const e = after.entries.find((x) => x.cseq === f.cseq); if (!e) bad("sent entry unknown");
    else if (e.kind === "start" || e.kind === "say") { if (e.gen !== 0 && !(h && h.gen === e.gen)) bad("delivered start/say of an expired generation"); if (e.kind === "start" && h && h.phase === "reserved" && c.now - h.since > HOLD_RESERVED_MS) bad("delivered the start of a reservation whose 15 minutes had run out (expiry not reconciled before delivery)"); }
    else if (e.kind === "approval" && e.allow === true && e.gen !== 0 && !(h && h.gen === e.gen && h.phase !== "draining")) bad("delivered allow of an ended generation");
  }
  // events of conv X never produce effects for conv Y
  if (i.t === "event") for (const f of fx) if (f.k === "emit" && f.tag !== null) { const hb = before.holder; if (!hb || f.tag !== hb.conv) bad(`event tagged ${f.tag} while holder was ${hb?.conv}`); }
  if (i.t === "event" && before.holder && !own(before.holder, i.e) && before.holder.phase !== "reserved") { if (J(after.holder) !== J(before.holder)) bad("foreign event changed the holder"); }
  if (i.t === "event" && before.holder?.phase === "reserved" && typeof i.e.cid === "string" && i.e.cid !== before.holder.cid && J(after.holder) !== J(before.holder)) bad("foreign cid changed a reservation");
  if (i.t === "answer") for (const f of fx) if (f.k === "enqueue" && f.src !== "hub") { if (i.who.k === "chat" && f.conv !== i.who.conv) bad("answer produced a frame for another conv"); }
  // the holder as it stands when this command is looked at (expiry that is already due is reconciled first)
  const bh = step(before, { t: "tick", now: c.now }).s.holder;
  // single holder admission
  if (i.t === "cmd" && i.kind === "start" && !bh && !r.ok) bad(`start refused (${r.code}) although no live holder exists once expiry is reconciled`);
  if (i.t === "cmd" && i.kind === "start" && r.ok && bh) { const ic = i.who.k === "chat" ? i.who.conv : "page"; if (!(bh.conv === ic && bh.phase === "reserved" && !bh.sent)) bad("start admitted over a holder (or over a sent reservation that was not drained)"); }
  if (i.t === "cmd" && i.kind === "start" && bh?.phase === "active" && J(after.holder) !== J(bh)) bad("start touched an active holder");
  // (e) replacement of a SENT reservation by its own party: refused busy, and it drains
  if (i.t === "cmd" && i.kind === "start" && bh && bh.phase === "reserved" && bh.sent && bh.conv === (i.who.k === "chat" ? i.who.conv : "page")) { if (r.ok || r.code !== "busy" || after.holder?.phase !== "draining") bad("replacing a sent reservation did not refuse+drain"); }
  for (const f of fx) if (f.k === "release" && f.reason === "replaced" && before.holder?.sent) bad("a SENT generation was released by replacement (not drained)");
  // (c) a user Stop of the holder: draining, released by THAT stop's cack alone (no session_stopped)
  if (i.t === "cmd" && i.kind === "stop" && r.ok && bh && !(bh.phase === "reserved" && !bh.sent) && r.cseq) {
    if (after.holder?.phase !== "draining") bad("user stop did not enter draining");
    const rel = step(after, { t: "cack", cseq: r.cseq, now: c.now }).s.holder; if (rel) bad("user stop's cack did not release the holder");
  }
  // (f) the chat environment switch off drains an active chat even with nothing queued; the page survives the chat-only switch
  if (i.t === "flag_off" && h) { if (!(h.phase === "draining" || (!i.all && h.conv === "page"))) bad("flag_off left a chat holder undrained"); }
  // a stop is always accepted for the holder
  if (h) { const w: Who = h.conv === "page" ? P : { k: "chat", conv: h.conv }; if (step(after, { t: "tick", now: c.now }).s.holder) { const o = step(after, { t: "cmd", who: w, cid: "probe-stop", kind: "stop", frame: {}, full: false, now: c.now }); if (!o.r.ok) bad("stop refused for its holder"); } }
  // liveness: nothing can keep a holder forever
  if (h) {
    let t = step(after, { t: "flag_off", all: true, now: c.now }).s; t = step(t, { t: "tick", now: c.now + HOLD_IDLE_MS + 1 }).s; t = step(t, { t: "offline", now: c.now + HOLD_IDLE_MS + 2 }).s; t = step(t, { t: "tick", now: c.now + 2 * HOLD_IDLE_MS }).s;
    if (t.holder) bad("holder cannot be released (liveness)");
  }
  // every non-free state waits on a timer: a deadline is armed, and a tick AT it changes the state (so no state can wait forever on nothing)
  if (h) {
    const d = deadline(after); if (d === null || d > c.now + HOLD_IDLE_MS + 1) bad("holder without an armed deadline");
    else if (J(step(after, { t: "tick", now: d }).s) === J(after)) bad("a tick at the deadline changes nothing (the alarm would re-arm forever)");
  }
  for (const a of after.appr) if (a.state === "pending") { const d = deadline(after); if (d === null || d > a.expiresAt * 1000) bad("pending approval without a deadline"); }
  // held (provisional) input: only while its generation is live and unconfirmed; never dropped meanwhile; folded once on confirmation; never applied after the generation ended
  if (after.buf.length) { if (!(h && h.phase === "reserved" && !h.acked)) bad("held input outside an unconfirmed reservation"); if (after.buf.some((p) => p.gen !== h!.gen)) bad("held input of another generation"); }
  if (before.buf.length && h && before.holder && h.gen === before.holder.gen && h.phase === "reserved" && !h.acked) { if (J(after.buf.slice(0, before.buf.length)) !== J(i.t === "offline" ? before.buf.filter((p) => !("a" in p)) : before.buf)) bad("held input of a live unconfirmed generation was dropped"); /* a disconnect invalidates held APPROVALS only (the daemon denied them) */ }
  if (before.buf.length && before.holder && !before.holder.acked && (i.t === "cack" || i.t === "hello") && (after.holder?.acked || !after.holder) && after.holder?.gen === before.holder.gen || (before.buf.length && before.holder && !before.holder.acked && after.holder === null && (i.t === "cack" || i.t === "hello") && !fx.some((f) => f.k === "release" && f.reason !== "start_refused" && f.reason !== "session_error"))) {
    const folded = fx.filter((f) => f.k === "emit" || f.k === "approval_new").length; if (after.buf.length || folded < before.buf.length) bad(`held input not folded exactly once on confirmation (held ${before.buf.length}, folded ${folded})`);
  }
  // ---- devv2s3t ----
  // handoff fence: a generation freed without its stop confirmed leaves a fence; nothing but the hub's own frames leaves while it stands; input received behind it is discarded
  if (after.fence) for (const f of fx) if (f.k === "send") { const e = after.entries.find((x) => x.cseq === f.cseq); if (e && e.src !== "hub" && e.cseq > after.fence.seq) bad(`delivered ${e.kind} (cseq ${e.cseq}) of src ${e.src} behind the handoff fence at ${after.fence.seq}`); }
  if (before.fence && (i.t === "event" || i.t === "approval_req") && J(after) !== J(before)) bad("input behind a handoff fence changed the state");
  // no emit / approval / held entry tagged for generation X derives from input of an OLDER generation
  const oldTag = (i.t === "event" ? (i.e as any).old : i.t === "approval_req" ? (i.e as any).old : undefined) as number | undefined;
  if (oldTag !== undefined) {
    const hg = before.holder?.gen;
    for (const f of fx) { if (f.k === "emit" && f.tag !== null && (f.e as any).old !== undefined && hg !== oldTag) bad(`old-generation (${oldTag}) event tagged for generation ${hg}`); if (f.k === "approval_new" && f.conv !== null && hg !== oldTag) bad("old-generation approval attributed to a live chat generation"); }
    if (after.buf.some((p) => (("e" in p ? (p.e as any).old : (p.a.e as any).old) === oldTag) && p.gen !== oldTag)) bad("old-generation input held under a newer generation");
    if (after.appr.some((a) => a.rid.startsWith("o") && a.state === "pending" && a.gen !== oldTag && a.gen !== 0)) bad("old-generation approval pending under a newer generation");
  }
  // devv2s3v: no approval request that arrives before the barrier cack of the CURRENT connection (tracked by the model independently of the reducer: opened by the hello after a gap, cleared by a cack >= it on a live connection) becomes a card / allowed. No clock.
  // a request replayed before the barrier cack after a disconnect gap is never actionable: no card, not pending, a hub deny is queued, an answer is refused
  if (i.t === "approval_req" && (i.e as any).gapReplay) {
    if (fx.some((f) => f.k === "approval_new")) bad("a replayed approval of a disconnect gap became a card");
    if (after.appr.some((a) => a.rid === i.rid && a.state === "pending")) bad("a replayed approval of a disconnect gap is pending");
    if (!before.fence && !fx.some((f) => f.k === "enqueue" && f.kind === "approval" && (f.frame as any).allow === false && (f.frame as any).rid === i.rid)) bad("no hub deny for a replayed approval of a disconnect gap");
    if (step(after, { t: "answer", who: A, rid: i.rid, allow: true, now: c.now }).r.ok || step(after, { t: "answer", who: P, rid: i.rid, allow: true, now: c.now }).r.ok) bad("an allow was accepted for a replayed approval of a disconnect gap");
  }
  // an approval is never created page-answerable (conv null) while a chat holds the device
  for (const f of fx) if (f.k === "approval_new" && f.conv === null && h && h.conv !== "page") bad("approval of unknown origin created while a chat holds the device");
  // held input is bounded by count AND serialized bytes; the whole state stays far below the SQLite row limit
  if (after.buf.length > 100 || sizeOf(after.buf) > BUF_BYTES || J(after).length > 900 * 1024) bad("held input exceeds its bounds");
  // reconstruction round trip is the identity on behaviour: the rebuilt state answers the next input exactly like the live one
  const probe: Input = { t: "tick", now: c.now + 1 };
  if (J(step(after, probe)) !== J(step(roundtrip(after), probe))) bad("reconstruction changed behaviour");
}
/** Runs one act (possibly several inputs) through the reducer, checking every invariant after every input. */
function exec(c: Ctx, a: Act): void {
  const feed = (i: Input) => {
    const before = c.s; const o = step(before, i);
    for (const f of o.fx) if (f.k === "send") c.sentMax = Math.max(c.sentMax, f.cseq);
    if (i.t === "cack") c.ackedHi = Math.max(c.ackedHi, i.cseq);
    if (i.t === "hello") c.ackedHi = Math.max(c.ackedHi, i.lastCseq);
    // a draining generation freed with its stop still unacknowledged (any path but that stop's cack): the daemon may still replay its output after the next hello
    const bh = before.holder; if (bh && bh.phase === "draining" && bh.stopSeq !== undefined && o.fx.some((f) => f.k === "release") && before.entries.some((e) => e.cseq === bh.stopSeq) && i.t !== "cack" && i.t !== "revoke") { c.oldOpen = true; c.oldGen = bh.gen; c.oldStop = bh.stopSeq; }
    if (i.t === "offline" && before.online) c.gapPend = true; if (i.t === "hello" && c.gapPend) { c.gapPend = false; if (!c.barrierSeq) { if (!o.s.barrier) throw new Error(`INVARIANT hello after a gap opened no barrier\n trace: ${c.trace.join(",")}`); c.barrierSeq = o.s.barrier.seq; } } if (i.t === "cack" && before.online && c.barrierSeq && i.cseq >= c.barrierSeq) c.barrierSeq = 0; if (i.t === "revoke") { c.gapPend = false; c.barrierSeq = 0; }
    if (i.t === "revoke") c.oldOpen = false;                                                        // a revoked device never talks again
    if (c.oldOpen && i.t === "cack" && before.online && i.cseq >= c.oldStop) c.oldOpen = false;
    c.s = o.s; c.steps++; check(c, before, i, o.s, o.fx, o.r);
    if (c.oldOpen && !o.s.fence && !(o.s.holder?.phase === "draining")) throw new Error(`INVARIANT handoff open without a fence\n trace: ${c.trace.join(",")}\n state: ${J(o.s)}`);
  };
  const reconnect = (p: boolean) => { feed({ t: "offline", now: c.now }); feed({ t: "hello", lastCseq: p ? c.sentMax : c.ackedHi, envOn: true, now: c.now }); };
  if (a === "reconnect") { c.trace.push(a); reconnect(false); return; }
  if (a === "reconnectP") { c.trace.push(a); reconnect(true); return; }
  if (a === "age16" || a === "age61") { c.trace.push(a); c.now += (a === "age16" ? 16 : 61) * 60_000; return; }   // the clock moves and NO alarm has run yet (a reconnect / admission / delivery must reconcile expiry itself)
  if (a === "reconstruct") { c.trace.push(a); c.s = roundtrip(c.s); return; }
  const i = resolve(c, a); if (!i) return; c.trace.push(a); feed(i);
  if (c.mode === "reconnect") reconnect(false); else if (c.mode === "reconnectP") reconnect(true); else if (c.mode === "reconstruct") c.s = roundtrip(c.s);
}
const clone = (c: Ctx): Ctx => ({ ...c, trace: [...c.trace] });
let explored = 0, stepsTotal = 0;
function dfs(c: Ctx, depth: number) {
  for (const a of ACTS) { const d = clone(c); exec(d, a); explored++; stepsTotal += d.steps - c.steps; if (depth > 1) dfs(d, depth - 1); }
}
const FAST = process.env.MODEL_FAST === "1";   // mutation checks only: shallower plain suite + fewer random runs
const SUITES: [Mode, number][] = [["plain", FAST ? 3 : 4], ["reconnect", 3], ["reconnectP", 3], ["reconstruct", 3]];
describe("model-based: invariants after every step", () => {
  for (const [mode, len] of SUITES) test(`exhaustive: every sequence of length <= ${len} over the full input alphabet, mode ${mode}${mode === "plain" ? "" : " (an interposed " + (mode === "reconstruct" ? "DO reconstruction" : "disconnect/reconnect") + " between every pair of steps)"}`, () => {
    const n = ACTS.length; explored = 0; stepsTotal = 0; dfs(fresh(mode), len);
    console.log(`exhaustive[${mode}] sequences explored: ${explored} (alphabet ${n}, max length ${len}), reducer steps checked: ${stepsTotal}`);
    expect(explored).toBe(Array.from({ length: len }, (_, k) => n ** (k + 1)).reduce((x, y) => x + y, 0));
  }, 1_800_000);
  test("seeded random: 60000 runs of 7-14 inputs over the full alphabet, mode drawn per run, fixed seeds", () => {
    let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const modes: Mode[] = ["plain", "plain", "reconnect", "reconnectP", "reconstruct"]; let runs = 0, steps = 0;
    for (let k = 0; k < (FAST ? 12_000 : 60_000); k++) { const len = 7 + Math.floor(rnd() * 8); const c = fresh(modes[Math.floor(rnd() * modes.length)]); for (let j = 0; j < len; j++) exec(c, ACTS[Math.floor(rnd() * ACTS.length)]); runs++; steps += c.steps; }
    console.log(`random runs: ${runs}, reducer steps checked: ${steps}`); expect(runs).toBe(FAST ? 12_000 : 60_000);
  }, 1_800_000);
});
