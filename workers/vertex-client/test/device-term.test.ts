import { describe, expect, it } from "bun:test";
import { MAX_FRAME_BYTES } from "../src/device-core";
import { RateWindow, TERM_FRESH_LOGIN_S, TERM_IDLE_S, TERM_OPEN_TIMEOUT_S, TERM_RATE_BPS, admitOpen, b64Bytes, idleExpired, isTermFrame, openExpired, parseTermApp, parseTermDevice, termDeadline, termStateFrame, type TermSession } from "../src/device-term";

const NOW = 1_800_000_000;
const sess = (o: Partial<TermSession> = {}): TermSession => ({ cid: "c1", sid: "s1", user: "u", root: "/r", mode: null, openedAt: NOW * 1000, lastIn: NOW * 1000, ...o });
const adm = (o: Record<string, unknown> = {}) => admitOpen({ user: "u", owner: "u", lat: NOW - 60, nowS: NOW, online: true, hasCap: true, session: null, ...o } as never);

describe("device-term: app frames", () => {
  it("parses every kind and rebuilds only known fields", () => {
    expect(parseTermApp({ t: "term_open", cid: "c1", root: "/home/x", cols: 80, rows: 24, evil: 1 })).toEqual({ t: "term_open", cid: "c1", root: "/home/x", cols: 80, rows: 24 });
    expect(parseTermApp({ t: "term_in", sid: "s1", data: "aGk=" })).toEqual({ t: "term_in", sid: "s1", data: "aGk=" });
    expect(parseTermApp({ t: "term_resize", sid: "s1", cols: 100, rows: 30 })).toEqual({ t: "term_resize", sid: "s1", cols: 100, rows: 30 });
    expect(parseTermApp({ t: "term_close", sid: "s1" })).toEqual({ t: "term_close", sid: "s1" });
    expect(parseTermApp({ t: "term_attach", sid: "s1", lastSeq: 5 })).toEqual({ t: "term_attach", sid: "s1", lastSeq: 5 });
    expect(parseTermApp({ t: "term_ack", sid: "s1", seq: 9 })).toEqual({ t: "term_ack", sid: "s1", seq: 9 });
  });
  it("rejects malformed, oversize and out-of-range frames", () => {
    expect(parseTermApp({ t: "term_open", cid: "c1", root: "", cols: 80, rows: 24 })).toBeNull();
    expect(parseTermApp({ t: "term_open", cid: "c1", root: "/a\nb", cols: 80, rows: 24 })).toBeNull();
    expect(parseTermApp({ t: "term_open", cid: "c1", root: "/a", cols: 0, rows: 24 })).toBeNull();
    expect(parseTermApp({ t: "term_open", cid: "c1", root: "/a", cols: 80, rows: 201 })).toBeNull();
    expect(parseTermApp({ t: "term_open", cid: "bad cid", root: "/a", cols: 80, rows: 24 })).toBeNull();
    expect(parseTermApp({ t: "term_in", sid: "s1", data: "A".repeat(64 * 1024 + 1) })).toBeNull();
    expect(parseTermApp({ t: "term_in", sid: "s1", data: "not base64!" })).toBeNull();
    expect(parseTermApp({ t: "term_in", sid: "s1", data: "" })).toBeNull();
    expect(parseTermApp({ t: "term_in", sid: "s 1", data: "aGk=" })).toBeNull();
    expect(parseTermApp({ t: "term_ack", sid: "s1", seq: -1 })).toBeNull();
    expect(parseTermApp({ t: "term_wat", sid: "s1" })).toBeNull();
  });
  it("isTermFrame only claims term_*", () => { expect(isTermFrame("term_in")).toBe(true); expect(isTermFrame("cmd")).toBe(false); expect(isTermFrame(undefined)).toBe(false); });
});

describe("device-term: device frames", () => {
  it("parses and strips unknown fields", () => {
    expect(parseTermDevice({ t: "term_ready", cid: "c1", sid: "s1", mode: "landlock", extra: "x" })).toEqual({ t: "term_ready", cid: "c1", sid: "s1", mode: "landlock" });
    expect(parseTermDevice({ t: "term_out", sid: "s1", seq: 0, data: "aGk=", extra: 1 })).toEqual({ t: "term_out", sid: "s1", seq: 0, data: "aGk=" });
    expect(parseTermDevice({ t: "term_exit", sid: "s1", code: null, signal: "SIGHUP" })).toEqual({ t: "term_exit", sid: "s1", code: null, signal: "SIGHUP" });
    expect(parseTermDevice({ t: "term_exit", sid: "s1", code: 0, signal: null })).toEqual({ t: "term_exit", sid: "s1", code: 0, signal: null });
    expect(parseTermDevice({ t: "term_exit", sid: "s1", code: 0, signal: null, reason: "idle" })).toEqual({ t: "term_exit", sid: "s1", code: 0, signal: null, reason: "idle" });
    expect(parseTermDevice({ t: "term_audit", sid: "s1", ev: "close", root: "/r", mode: "sandbox", durationS: 5, reason: "idle" })).toEqual({ t: "term_audit", sid: "s1", mode: "sandbox" });   // vclterm2's audit frame shape
    expect(parseTermDevice({ t: "term_gap", sid: "s1", from: 12 })).toEqual({ t: "term_gap", sid: "s1", from: 12 });
    expect(parseTermDevice({ t: "term_error", cid: "c1", error: "root_not_allowed" })).toEqual({ t: "term_error", cid: "c1", error: "root_not_allowed" });
    expect(parseTermDevice({ t: "term_audit", sid: "s1", mode: "seatbelt" })).toEqual({ t: "term_audit", sid: "s1", mode: "seatbelt" });
  });
  it("rejects bad shapes and oversize payloads", () => {
    expect(parseTermDevice({ t: "term_out", sid: "s1", seq: 1.5, data: "aGk=" })).toBeNull();
    expect(parseTermDevice({ t: "term_out", sid: "s1", seq: 1, data: "A".repeat(MAX_FRAME_BYTES + 4) })).toBeNull();
    expect(parseTermDevice({ t: "term_out", sid: "s1", seq: 1, data: "<script>" })).toBeNull();
    expect(parseTermDevice({ t: "term_exit", sid: "s1", code: "0", signal: null })).toBeNull();
    expect(parseTermDevice({ t: "term_error", error: "has space" })).toBeNull();
    expect(parseTermDevice({ t: "term_in", sid: "s1", data: "aGk=" })).toBeNull();   // an app frame from a device is nothing
  });
});

describe("device-term: admission", () => {
  it("admits the owner with a fresh login, online, with the cap, no session", () => expect(adm()).toEqual({ ok: true }));
  it("refuses a non-owner", () => { expect(adm({ owner: "someone" })).toEqual({ ok: false, error: "forbidden" }); expect(adm({ owner: undefined })).toEqual({ ok: false, error: "forbidden" }); });
  it("login freshness: 12 h boundary, missing and future lat", () => {
    expect(adm({ lat: NOW - TERM_FRESH_LOGIN_S })).toEqual({ ok: true });
    expect(adm({ lat: NOW - TERM_FRESH_LOGIN_S - 1 })).toEqual({ ok: false, error: "login_required" });
    expect(adm({ lat: undefined })).toEqual({ ok: false, error: "login_required" });
    expect(adm({ lat: NOW + 3600 })).toEqual({ ok: false, error: "login_required" });
  });
  it("offline, no cap, one session per device", () => {
    expect(adm({ online: false })).toEqual({ ok: false, error: "offline" });
    expect(adm({ hasCap: false })).toEqual({ ok: false, error: "no_cap" });
    expect(adm({ session: sess() })).toEqual({ ok: false, error: "limit" });
  });
});

describe("device-term: idle, open timeout, deadline, rate", () => {
  it("idle after 30 min without input", () => { const s = sess(); expect(idleExpired(s, s.lastIn + TERM_IDLE_S * 1000)).toBe(false); expect(idleExpired(s, s.lastIn + TERM_IDLE_S * 1000 + 1)).toBe(true); });
  it("an unanswered open expires, an answered one never does", () => {
    const p = sess({ sid: null }); expect(openExpired(p, p.openedAt + TERM_OPEN_TIMEOUT_S * 1000 + 1)).toBe(true); expect(openExpired(p, p.openedAt + 1000)).toBe(false);
    expect(openExpired(sess(), Number.MAX_SAFE_INTEGER)).toBe(false);
  });
  it("deadline is the open timeout while pending, the idle moment once active, null without a session", () => {
    expect(termDeadline(null)).toBeNull();
    expect(termDeadline(sess({ sid: null }))).toBe(NOW * 1000 + TERM_OPEN_TIMEOUT_S * 1000);
    expect(termDeadline(sess())).toBe(NOW * 1000 + TERM_IDLE_S * 1000);
  });
  it("rate window: budget per second, refused bytes are not counted, a new second resets", () => {
    const w = new RateWindow(1000);
    expect(w.take(600, 0)).toBe(true); expect(w.take(400, 10)).toBe(true); expect(w.take(1, 20)).toBe(false);
    expect(w.take(1000, 999)).toBe(false); expect(w.take(1000, 1000)).toBe(true);
    expect(TERM_RATE_BPS).toBe(2 * 1024 * 1024);
  });
  it("b64Bytes matches real decoding", () => { for (const n of [0, 1, 2, 3, 4, 100, 1001]) { const b = Buffer.alloc(n, 7).toString("base64"); expect(b64Bytes(b)).toBe(n); } });
});

describe("vclterm10 B1: termStateFrame", () => {
  it("owner + running session -> frame (no content); no session / pending / other user -> null", () => {
    expect(termStateFrame(sess({ mode: "seatbelt", cols: 100, rows: 30 }), "u", "u")).toEqual({ t: "term_state", sid: "s1", mode: "seatbelt", root: "/r", cols: 100, rows: 30, since: NOW * 1000 });
    expect(termStateFrame(sess(), "u", "u")).toEqual({ t: "term_state", sid: "s1", root: "/r", since: NOW * 1000 }); // optional fields omitted
    expect(termStateFrame(null, "u", "u")).toBeNull();
    expect(termStateFrame(sess({ sid: null }), "u", "u")).toBeNull();
    expect(termStateFrame(sess(), "v", "u")).toBeNull(); expect(termStateFrame(sess(), "u", "v")).toBeNull(); expect(termStateFrame(sess(), "u", undefined)).toBeNull();
  });
});
