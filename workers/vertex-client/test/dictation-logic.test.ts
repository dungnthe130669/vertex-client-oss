import { describe, expect, test } from "bun:test";
import { nativeFocus, CAP_TEXT, IDLE, MAX_RESTARTS, NO_SPEECH_MS, NO_SPEECH_TEXT, nativeNoSpeech, pickPath, dictError, retryableError, dictLang, dictReduce, dictText, splitResults, type DictEvent, type DictState } from "../web/src/dictation-logic";

const run = (events: DictEvent[], s: DictState = IDLE) => { const effects: Array<string | null> = []; for (const e of events) { const r = dictReduce(s, e); s = r.s; effects.push(r.effect); } return { s, effects }; };

describe("dictation state machine", () => {
  test("tap starts, results update, second tap asks to stop, end returns to idle with the text kept by the caller", () => {
    const { s, effects } = run([{ t: "tap", text: "hello" }, { t: "result", final: "good", interim: " mor" }, { t: "result", final: "good morning", interim: "" }, { t: "tap", text: "ignored" }]);
    expect(effects).toEqual(["start", null, null, "stop"]);
    expect(s.phase).toBe("listening");           // still listening until the engine reports end
    expect(s.stopping).toBe(true);
    expect(dictText(s)).toBe("hello good morning");
    expect(dictReduce(s, { t: "end" }).s).toEqual(IDLE);
  });
  test("a result after the engine ended (late event) is dropped", () => {
    expect(dictReduce(IDLE, { t: "result", final: "x", interim: "" }).s).toEqual(IDLE);
  });
  test("never starts by itself: only a tap leaves idle", () => {
    for (const e of [{ t: "result", final: "a", interim: "" }, { t: "end" }, { t: "error", code: "network" }, { t: "started" }, { t: "halt" }] as DictEvent[]) expect(dictReduce(IDLE, e).s.phase).toBe("idle");
    expect(dictReduce(IDLE, { t: "tap", text: "" }).effect).toBe("start");
  });
  test("auto-restart: an end the user did not ask for restarts and the text carries over, 3 cycles", () => {
    let s = run([{ t: "tap", text: "hi" }]).s;
    const words = ["one", "two", "three"];
    for (let i = 0; i < 3; i++) {
      s = dictReduce(s, { t: "result", final: words[i], interim: "" }).s;
      const r = dictReduce(s, { t: "end" });
      expect(r.effect).toBe("restart"); s = r.s;
      expect(s.phase).toBe("listening"); expect(s.restarts).toBe(i + 1);
    }
    s = dictReduce(s, { t: "result", final: "four", interim: " fi" }).s; // new instance's list REPLACES final/interim only
    expect(dictText(s)).toBe("hi one two three four fi");
  });
  test("self-end: only FINAL text is promoted; the trailing interim waits as `pending` and is still shown", () => {
    const s = run([{ t: "tap", text: "" }, { t: "result", final: "a", interim: "b" }, { t: "end" }]).s;
    expect(s.carry).toBe("a"); expect(s.pending).toBe("b"); expect(dictText(s)).toBe("a b");
  });
  test('"hel" then the next instance says "hello": the result is "hello", never "hel hello"', () => {
    let s = run([{ t: "tap", text: "" }, { t: "result", final: "", interim: "hel" }, { t: "end" }]).s;
    expect(dictText(s)).toBe("hel");                     // shown until replaced
    s = dictReduce(s, { t: "result", final: "hello", interim: "" }).s;
    expect(dictText(s)).toBe("hello"); expect(s.pending).toBe("");
  });
  test("pending is replaced by ANY new text (default REPLACE), kept through an empty result, even when unrelated", () => {
    let s = run([{ t: "tap", text: "x" }, { t: "result", final: "one", interim: "two thr" }, { t: "end" }]).s;
    s = dictReduce(s, { t: "result", final: "", interim: "" }).s;
    expect(dictText(s)).toBe("x one two thr");
    s = dictReduce(s, { t: "result", final: "", interim: "three" }).s;
    expect(dictText(s)).toBe("x one three");
  });
  test("iOS-like: the final arrives BEFORE the end (interim empty at end): nothing pending, no duplicate", () => {
    let s = run([{ t: "tap", text: "" }, { t: "result", final: "", interim: "hel" }, { t: "result", final: "hello", interim: "" }, { t: "end" }]).s;
    expect(s.pending).toBe(""); expect(dictText(s)).toBe("hello");
    s = dictReduce(s, { t: "result", final: "world", interim: "" }).s;
    expect(dictText(s)).toBe("hello world");
  });
  test("Stop with a pending interim keeps it in the composer text (nothing replaced it)", () => {
    const s = run([{ t: "tap", text: "" }, { t: "result", final: "a", interim: "b" }, { t: "end" }, { t: "tap", text: "" }]).s;
    expect(s.stopping).toBe(true); expect(dictText(s)).toBe("a b");
  });
  test("pending counts as heard for the no-speech hint", () => {
    const s = run([{ t: "tap", text: "" }, { t: "result", final: "", interim: "hi" }, { t: "end" }]).s;
    expect(nativeNoSpeech(s, NO_SPEECH_MS * 3)).toBe(false);
  });
  test("busy (an old instance could not be confirmed ended): idle with the plain busy message + Retry, even while stopping", () => {
    for (const evs of [[{ t: "tap", text: "" }], [{ t: "tap", text: "" }, { t: "tap", text: "" }]] as DictEvent[][]) {
      const s = run([...evs, { t: "busy" }]).s;
      expect(s.phase).toBe("idle"); expect(s.error).toContain("busy or unavailable"); expect(retryableError(s.errCode)).toBe(true);
    }
  });
  test("retries share the restart budget: results re-arm retried but every retry spends one attempt, so the loop ends at the cap", () => {
    let s = run([{ t: "tap", text: "" }]).s; let n = 0;
    for (; n < MAX_RESTARTS * 2; n++) {
      s = dictReduce(s, { t: "result", final: "x", interim: "" }).s;          // a result re-arms the one retry
      const r = dictReduce(s, { t: "error", code: "audio-capture" });
      if (r.effect !== "retry") { expect(r.s.phase).toBe("idle"); expect(r.s.error).toBe(CAP_TEXT); expect(r.s.errCode).toBe("cap"); break; }
      s = dictReduce(r.s, { t: "started" }).s;
    }
    expect(n).toBe(MAX_RESTARTS);
  });
  test("restarts and retries draw on the same budget", () => {
    let s = run([{ t: "tap", text: "" }]).s;
    for (let i = 0; i < MAX_RESTARTS - 1; i++) s = dictReduce(s, { t: "end" }).s;
    s = dictReduce(dictReduce(s, { t: "error", code: "not-allowed" }).s, { t: "started" }).s; // the last unit of budget goes to the retry
    expect(dictReduce(s, { t: "end" }).s.errCode).toBe("cap");
  });
  test("restart cap: the (MAX+1)th end closes with a plain message, text untouched", () => {
    let s = run([{ t: "tap", text: "" }]).s;
    for (let i = 0; i < MAX_RESTARTS; i++) { const r = dictReduce(s, { t: "end" }); expect(r.effect).toBe("restart"); s = r.s; }
    const r = dictReduce(s, { t: "end" });
    expect(r.effect).toBeNull(); expect(r.s.phase).toBe("idle"); expect(r.s.error).toBe(CAP_TEXT); expect(retryableError(r.s.errCode)).toBe(true);
  });
  test("Stop (also during a restart gap): the next end is final, no restart", () => {
    const s0 = run([{ t: "tap", text: "" }, { t: "result", final: "x", interim: "" }, { t: "end" }]).s; // restart pending
    const st = dictReduce(s0, { t: "tap", text: "" });
    expect(st.effect).toBe("stop");
    const e = dictReduce(st.s, { t: "end" });
    expect(e.s).toEqual(IDLE); expect(e.effect).toBeNull();
  });
  test("an error while stopping just closes", () => {
    const st = run([{ t: "tap", text: "" }, { t: "tap", text: "" }]).s;
    expect(dictReduce(st, { t: "error", code: "audio-capture" }).s).toEqual(IDLE);
  });
  test("no-speech and aborted are ignored while listening (no state change, no restart)", () => {
    const l = run([{ t: "tap", text: "" }, { t: "result", final: "a", interim: "" }]).s;
    for (const code of ["no-speech", "aborted"]) { const r = dictReduce(l, { t: "error", code }); expect(r.s).toBe(l); expect(r.effect).toBeNull(); }
  });
  test("mic errors: retry ONCE with a fresh instance (the failing instance's end is swallowed), then a plain message", () => {
    for (const code of ["audio-capture", "service-not-allowed", "not-allowed"]) {
      const l = run([{ t: "tap", text: "keep" }, { t: "result", final: "kept", interim: "" }]).s;
      const r1 = dictReduce(l, { t: "error", code });
      expect(r1.effect).toBe("retry"); expect(r1.s.phase).toBe("listening");
      expect(dictReduce(r1.s, { t: "end" })).toEqual({ s: r1.s, effect: null }); // no second restart on top of the retry
      const up = dictReduce(r1.s, { t: "started" }).s; expect(up.awaiting).toBe(false);
      const r2 = dictReduce(up, { t: "error", code });
      expect(r2.effect).toBeNull(); expect(r2.s.phase).toBe("idle"); expect(r2.s.error).toBe(dictError(code)); expect(r2.s.errCode).toBe(code);
      expect(retryableError(code)).toBe(true);
    }
  });
  test("a result after a retry re-arms the one retry", () => {
    let s = run([{ t: "tap", text: "" }, { t: "error", code: "audio-capture" }, { t: "started" }, { t: "result", final: "ok", interim: "" }]).s;
    expect(s.retried).toBe(false);
    expect(dictReduce(s, { t: "error", code: "audio-capture" }).effect).toBe("retry");
  });
  test("other errors are final at once; the following end keeps the message; the next tap clears it", () => {
    const a = run([{ t: "tap", text: "" }, { t: "error", code: "network" }]);
    expect(a.s.phase).toBe("idle"); expect(a.s.error).toContain("network"); expect(retryableError(a.s.errCode)).toBe(false);
    expect(dictReduce(a.s, { t: "end" }).s.error).toContain("network");
    expect(dictReduce(a.s, { t: "tap", text: "" }).s.error).toBeNull();
    expect(dictReduce(a.s, { t: "clear" }).s).toEqual(IDLE);
  });
  test("halt (page hidden / navigation) goes idle without an error", () => {
    expect(dictReduce(run([{ t: "tap", text: "" }, { t: "result", final: "a", interim: "" }]).s, { t: "halt" }).s).toEqual(IDLE);
  });
  test("error wording: iOS permission text kept, audio-capture is NOT 'no microphone found'", () => {
    expect(dictError("aborted")).toBeNull();
    expect(dictError("no-speech")).toBeNull();
    expect(dictError("audio-capture")).toContain("busy or unavailable");
    expect(dictError("audio-capture")).toContain("Whisper in Settings > Voice");
    expect(dictError("audio-capture")).not.toContain("No microphone was found");
    expect(dictError("not-allowed")).toContain("Settings > Safari > Microphone");
    expect(dictError("network")).toContain("network");
    expect(dictError("weird")).toContain("stopped unexpectedly");
  });
});

describe("dictText / splitResults / dictLang", () => {
  test("joins with exactly one space, none when the base ends in whitespace or is empty", () => {
    expect(dictText({ base: "", final: "", interim: "" })).toBe("");
    expect(dictText({ base: "a", final: "", interim: "" })).toBe("a");
    expect(dictText({ base: "a", final: "b", interim: "c" })).toBe("a b c");
    expect(dictText({ base: "a\n", final: " b ", interim: "" })).toBe("a\nb");
    expect(dictText({ base: "", final: "xin chào", interim: "" })).toBe("xin chào");
  });
  test("splits final from interim results", () => {
    const list = [{ isFinal: true, 0: { transcript: "one " } }, { isFinal: true, 0: { transcript: "two" } }, { isFinal: false, 0: { transcript: " thr" } }];
    expect(splitResults(list)).toEqual({ final: "one two", interim: " thr" });
  });
  test("language: saved choice wins, then the browser's, then en-US", () => {
    expect(dictLang("vi-VN", "en-GB")).toBe("vi-VN");
    expect(dictLang("", "vi-VN")).toBe("vi-VN");
    expect(dictLang(null, "")).toBe("en-US");
    expect(dictLang("  ", undefined)).toBe("en-US");
  });
});

describe("voice path selection (Settings > Voice > Whisper)", () => {
  test("default off = native; on + recorder = whisper; on without recorder falls back to native; neither = no mic", () => {
    expect(pickPath(false, true, true)).toBe("native");
    expect(pickPath(false, true, false)).toBe("none");   // toggle off: a recorder alone does not show the mic
    expect(pickPath(true, true, true)).toBe("whisper");
    expect(pickPath(true, true, false)).toBe("whisper");
    expect(pickPath(true, false, true)).toBe("native");
    expect(pickPath(true, false, false)).toBe("none");
  });
});

describe("no-speech timeout", () => {
  const listening = (final = "", interim = "") => ({ phase: "listening" as const, final, interim });
  test("fires only after NO_SPEECH_MS of listening with nothing recognised", () => {
    expect(nativeNoSpeech(listening(), 0)).toBe(false);
    expect(nativeNoSpeech(listening(), NO_SPEECH_MS - 1)).toBe(false);
    expect(nativeNoSpeech(listening(), NO_SPEECH_MS)).toBe(true);
    expect(nativeNoSpeech(listening("", "  "), NO_SPEECH_MS + 5000)).toBe(true);
    expect(NO_SPEECH_MS).toBe(8000);
  });
  test("text captured in an EARLIER instance (carry) also keeps the hint away; restart cycles alone never raise it early", () => {
    expect(nativeNoSpeech({ phase: "listening", carry: "earlier", final: "", interim: "" }, NO_SPEECH_MS * 3)).toBe(false);
    const s = run([{ t: "tap", text: "" }, { t: "end" }, { t: "end" }]).s; // empty restart cycles
    expect(nativeNoSpeech(s, NO_SPEECH_MS - 1)).toBe(false);
    expect(nativeNoSpeech(s, NO_SPEECH_MS)).toBe(true); // measured from bar open, not from the last restart
  });
  test("any recognised text (interim or final) clears it; idle never shows it", () => {
    expect(nativeNoSpeech(listening("", "hel"), NO_SPEECH_MS * 3)).toBe(false);
    expect(nativeNoSpeech(listening("hello"), NO_SPEECH_MS * 3)).toBe(false);
    expect(nativeNoSpeech({ ...IDLE }, NO_SPEECH_MS * 3)).toBe(false);
  });
  test("wording and the clear event", () => {
    expect(NO_SPEECH_TEXT).toContain("No speech heard");
    expect(NO_SPEECH_TEXT).toContain("Whisper in Settings > Voice");
    const a = run([{ t: "tap", text: "" }, { t: "error", code: "network" }, { t: "end" }]);
    expect(a.s.error).toContain("network");
    expect(dictReduce(a.s, { t: "clear" }).s).toEqual(IDLE);
    const l = run([{ t: "tap", text: "x" }]).s;
    expect(dictReduce(l, { t: "clear" }).s).toBe(l); // clear never stops a live session
  });
});

describe("focus", () => {
  test("Stop when listening starts (also after Retry); the composer when it ends or the message is dismissed", () => {
    const idle = { listening: false, message: false };
    expect(nativeFocus(idle, { listening: true, message: false })).toBe("stop");
    expect(nativeFocus({ listening: false, message: true }, { listening: true, message: false })).toBe("stop"); // Retry
    expect(nativeFocus({ listening: true, message: false }, idle)).toBe("composer");
    expect(nativeFocus({ listening: true, message: false }, { listening: false, message: true })).toBe("composer");
    expect(nativeFocus({ listening: false, message: true }, idle)).toBe("composer");      // dismiss
    expect(nativeFocus({ listening: true, message: false }, { listening: true, message: true })).toBeNull(); // hint appears while listening: leave focus
    expect(nativeFocus(idle, idle)).toBeNull();
  });
});
