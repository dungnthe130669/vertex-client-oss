import { describe, expect, test } from "bun:test";
import { MAX_BYTES, MIN_MS, SILENCE_PEAK, VOICE_IDLE, canFallBack, errFromResponse, errText, insertAtCaret, isIOS, judgeRecording, meterFill, mmss, pickMime, retryLabel, rmsLevel, voiceReduce, type VoiceEvent, type VoiceState } from "../web/src/voice-logic";

const run = (evs: VoiceEvent[], from: VoiceState = VOICE_IDLE) => { let s = from; const fx: (string | null)[] = []; for (const e of evs) { const r = voiceReduce(s, e); s = r.s; fx.push(r.effect); } return { s, fx }; };
const GOOD = { t: "stop", ms: 3000, peak: 0.1, bytes: 50_000 } as const;

describe("pickMime", () => {
  const sup = (...ok: string[]) => (m: string) => ok.includes(m);
  test("iOS prefers audio/mp4, others webm/opus", () => {
    expect(pickMime(sup("audio/mp4", "audio/webm;codecs=opus"), true)).toBe("audio/mp4");
    expect(pickMime(sup("audio/mp4", "audio/webm;codecs=opus"), false)).toBe("audio/webm;codecs=opus");
    expect(pickMime(sup("audio/mp4"), false)).toBe("audio/mp4");
    expect(pickMime(sup("audio/webm"), true)).toBe("audio/webm");
  });
  test("nothing supported or isTypeSupported throwing -> null", () => {
    expect(pickMime(() => false, true)).toBeNull();
    expect(pickMime(() => { throw new Error("x"); }, false)).toBeNull();
  });
  test("isIOS: iPhone/iPad UA and iPadOS-as-Mac with touch, not a desktop Mac", () => {
    expect(isIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(true);
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
    expect(isIOS("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });
});

describe("judgeRecording / limits", () => {
  test("too short, silent, empty -> no-speech; over 25 MB -> too-long; good -> null", () => {
    expect(judgeRecording({ ms: MIN_MS - 1, peak: 0.2, bytes: 9000 })).toBe("no-speech");
    expect(judgeRecording({ ms: 5000, peak: SILENCE_PEAK / 2, bytes: 9000 })).toBe("no-speech");
    expect(judgeRecording({ ms: 5000, peak: 0.2, bytes: 0 })).toBe("no-speech");
    expect(judgeRecording({ ms: 5000, peak: 0.2, bytes: MAX_BYTES + 1 })).toBe("too-long");
    expect(judgeRecording({ ms: MIN_MS, peak: SILENCE_PEAK, bytes: MAX_BYTES })).toBeNull();
  });
});

describe("state machine", () => {
  test("happy path: tap -> mic -> recording -> stop -> send -> text -> insert, back to idle", () => {
    const { s, fx } = run([{ t: "tap" }, { t: "granted" }, GOOD, { t: "text", text: "hi" }]);
    expect(fx).toEqual(["request-mic", null, "send", "insert"]); expect(s).toEqual(VOICE_IDLE);
  });
  test("nothing starts except from a tap: granted/stop/text/retry on idle do nothing (a stray granted discards the stream)", () => {
    expect(run([{ t: "stop", ms: 5000, peak: 1, bytes: 9 }, { t: "text", text: "x" }, { t: "retry" }, { t: "cancel" }]).fx).toEqual([null, null, null, null]);
    expect(voiceReduce(VOICE_IDLE, { t: "granted" })).toEqual({ s: VOICE_IDLE, effect: "discard" });
  });
  test("tap while busy is ignored (no second recorder)", () => {
    expect(run([{ t: "tap" }, { t: "tap" }]).fx).toEqual(["request-mic", null]);
  });
  test("cancel from every active phase releases (discard) and ends idle; a late text is dropped", () => {
    for (const pre of [[{ t: "tap" }], [{ t: "tap" }, { t: "granted" }], [{ t: "tap" }, { t: "granted" }, GOOD]] as VoiceEvent[][]) {
      const r = run([...pre, { t: "cancel" }, { t: "text", text: "late" }]); expect(r.fx.slice(-2)).toEqual(["discard", null]); expect(r.s).toEqual(VOICE_IDLE);
    }
  });
  test("cancel while the permission prompt is up, then granted arrives: stream is discarded", () => {
    expect(run([{ t: "tap" }, { t: "cancel" }, { t: "granted" }]).fx).toEqual(["request-mic", "discard", "discard"]);
  });
  test("short / silent stop -> error no-speech, nothing sent", () => {
    const r = run([{ t: "tap" }, { t: "granted" }, { t: "stop", ms: 400, peak: 0.3, bytes: 5000 }]);
    expect(r.fx[2]).toBe("discard"); expect(r.s).toMatchObject({ phase: "error", error: "no-speech", keep: false });
  });
  test("service failure keeps the audio: Retry resends it; permission failure: Retry records again", () => {
    const a = run([{ t: "tap" }, { t: "granted" }, GOOD, { t: "fail", err: "failed", keep: true }, { t: "retry" }]);
    expect(a.fx.slice(-1)).toEqual(["send"]); expect(a.s.phase).toBe("transcribing");
    const b = run([{ t: "tap" }, { t: "fail", err: "denied" }, { t: "retry" }]);
    expect(b.fx.slice(-1)).toEqual(["request-mic"]); expect(b.s.phase).toBe("starting");
  });
  test("a failure arriving after cancel (idle) is ignored", () => {
    expect(run([{ t: "tap" }, { t: "cancel" }, { t: "fail", err: "failed" }]).s).toEqual(VOICE_IDLE);
  });
  test("error can be dismissed (cancel -> idle)", () => {
    expect(run([{ t: "tap" }, { t: "fail", err: "no-mic" }, { t: "cancel" }]).s).toEqual(VOICE_IDLE);
  });
});

describe("wording and mapping", () => {
  test("errFromResponse", () => {
    expect(errFromResponse(0)).toBe("offline"); expect(errFromResponse(413)).toBe("too-long"); expect(errFromResponse(400, "no-speech")).toBe("no-speech");
    expect(errFromResponse(429)).toBe("rate-limited"); expect(errFromResponse(503, "no-binding")).toBe("unavailable"); expect(errFromResponse(502)).toBe("failed"); expect(errFromResponse(500)).toBe("failed");
  });
  test("every error has plain text; iOS denial explains Settings; fallback only for service-side errors", () => {
    for (const e of ["denied", "no-mic", "no-speech", "too-long", "offline", "rate-limited", "unavailable", "failed"] as const) expect(errText(e).length).toBeGreaterThan(10);
    expect(errText("denied", true)).toContain("Settings"); expect(errText("denied", false)).not.toContain("iPhone");
    expect(["unavailable", "failed", "rate-limited"].every((e) => canFallBack(e as any))).toBe(true);
    expect(["denied", "no-mic", "no-speech", "too-long", "offline", null].some((e) => canFallBack(e as any))).toBe(false);
  });
  test("retryLabel", () => { expect(retryLabel({ keep: true })).toBe("Retry"); expect(retryLabel({ keep: false })).toBe("Record again"); });
  test("mmss", () => { expect(mmss(0)).toBe("00:00"); expect(mmss(61_900)).toBe("01:01"); expect(mmss(120_000)).toBe("02:00"); expect(mmss(-5)).toBe("00:00"); });
});

describe("meter", () => {
  test("silence is 0, full scale square wave is 1, fill is monotonic and clamped", () => {
    expect(rmsLevel(new Uint8Array(64).fill(128))).toBe(0); expect(rmsLevel([])).toBe(0);
    expect(rmsLevel(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 255 : 0)))).toBeGreaterThan(0.99);
    expect(meterFill(0)).toBe(0); expect(meterFill(0.05)).toBeLessThan(meterFill(0.2)); expect(meterFill(5)).toBe(1);
  });
});

describe("insertAtCaret", () => {
  test("appends with one space, never overwrites", () => { expect(insertAtCaret("hello", 5, 5, " world ")).toEqual({ text: "hello world", caret: 11 }); });
  test("empty composer: no leading space", () => { expect(insertAtCaret("", 0, 0, "hi")).toEqual({ text: "hi", caret: 2 }); });
  test("middle of text: spaces on both sides, rest untouched, caret after the insert", () => {
    const r = insertAtCaret("ab cd", 2, 2, "XY"); expect(r.text).toBe("ab XY cd"); expect(r.caret).toBe(5);
    expect(insertAtCaret("ab\ncd", 2, 2, "XY").text).toBe("ab XY\ncd");
  });
  test("a selection is replaced, out-of-range carets clamp, blank speech changes nothing", () => {
    expect(insertAtCaret("ab XX cd", 3, 5, "YY").text).toBe("ab YY cd");
    expect(insertAtCaret("abc", 99, 120, "d").text).toBe("abc d");
    expect(insertAtCaret("abc", 1, 1, "   ")).toEqual({ text: "abc", caret: 1 });
  });
});

import { ChunkBuffer, caretFor, focusTarget, stopOrRelease } from "../web/src/voice-logic";
describe("review fixes", () => {
  test("stopOrRelease: a throwing recorder.stop() still releases the microphone; a normal stop does not release early", () => {
    let released = 0; const boom = { stop() { throw new Error("InvalidStateError"); } }; let stopped = 0; const fine = { stop() { stopped++; } };
    expect(stopOrRelease(boom, () => released++)).toBe(false); expect(released).toBe(1);
    expect(stopOrRelease(fine, () => released++)).toBe(true); expect(stopped).toBe(1); expect(released).toBe(1);
    expect(stopOrRelease(null, () => released++)).toBe(true); expect(released).toBe(1);
  });
  test("ChunkBuffer: take() empties it, clear() drops everything, empty pieces are ignored", () => {
    const b = new ChunkBuffer(); b.push(new Blob(["abc"])); b.push(new Blob([])); b.push(new Blob(["d"]));
    expect(b.size).toBe(2); expect(b.take()).toHaveLength(2); expect(b.size).toBe(0);
    b.push(new Blob(["x"])); b.clear(); expect(b.size).toBe(0); expect(b.take()).toEqual([]);
  });
  test("caretFor: reused only while the draft is unchanged, else the end of the current draft", () => {
    const cap = { text: "hello world", start: 5, end: 5 };
    expect(caretFor(cap, "hello world")).toEqual([5, 5]);
    expect(caretFor(cap, "hello world!!")).toEqual([13, 13]);
    expect(caretFor(cap, "")).toEqual([0, 0]);
    const r = caretFor(cap, "changed"); expect(insertAtCaret("changed", r[0], r[1], "X").text).toBe("changed X");
  });
  test("focusTarget: Stop when recording starts, Retry on error, textarea when the flow ends, nothing otherwise", () => {
    expect(focusTarget("starting", "recording")).toBe("stop");
    expect(focusTarget("transcribing", "error")).toBe("retry");
    expect(focusTarget("transcribing", "idle")).toBe("textarea"); expect(focusTarget("recording", "idle")).toBe("textarea"); expect(focusTarget("error", "idle")).toBe("textarea");
    expect(focusTarget("idle", "starting")).toBeNull(); expect(focusTarget("recording", "transcribing")).toBeNull(); expect(focusTarget("idle", "idle")).toBeNull();
  });
});
