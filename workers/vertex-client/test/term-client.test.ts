import { describe, expect, test } from "bun:test";
import { PENDING_MAX, ACK_EVERY, ACK_MS, LABEL_OPEN, LABEL_SANDBOX, LABEL_UNKNOWN, PASTE_CHUNK, TermSession, b64dec, b64enc, bannerFor, chunkInput, errorMessage, exitMessage, withCtrl, type Sink } from "../web/src/term-client";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
function rig() {
  const sent: any[] = [], written: string[] = [], log: string[] = [];
  let up = true, hold: (() => void)[] | null = null; // hold = delay xterm write callbacks
  const sink: Sink = { write: (b, done) => { written.push(new TextDecoder().decode(b)); if (hold) hold.push(done); else done(); }, reset: () => { written.length = 0; log.push("reset"); }, note: (s) => log.push(s) };
  const s = new TermSession((f) => { if (up) sent.push(f); return up; }, sink);
  const open = () => { s.open("/r", 80, 24); const cid = sent.at(-1).cid; s.onFrame({ t: "term_ready", cid, sid: "S1", mode: "sandbox" }); };
  return { s, sent, written, log, open, down: () => { up = false; }, upAgain: () => { up = true; }, hold: () => { hold = []; return hold; } };
}
const out = (seq: number, text: string) => ({ t: "term_out", sid: "S1", seq, data: b64enc(new TextEncoder().encode(text)) });

describe("input framing", () => {
  test("chunks a big paste at <= 64 KB base64 each, order preserved, lossless", () => {
    const text = "é".repeat(100_000) + "tail"; const c = chunkInput(text);
    expect(c.length).toBeGreaterThan(3); for (const x of c) expect(x.length).toBeLessThanOrEqual(64 * 1024);
    const bytes = c.flatMap((x) => [...b64dec(x)]); expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe(text);
    expect(PASTE_CHUNK * 4 / 3).toBeLessThanOrEqual(64 * 1024);
  });
  test("input is dropped unless live, and carries the sid", () => {
    const r = rig(); expect(r.s.input("ls")).toBe(false); r.open(); expect(r.s.input("ls\r")).toBe(true);
    expect(r.sent.at(-1)).toMatchObject({ t: "term_in", sid: "S1" }); expect(new TextDecoder().decode(b64dec(r.sent.at(-1).data))).toBe("ls\r");
  });
  test("one-shot Ctrl turns a letter into a control code", () => { expect(withCtrl(true, "c")).toBe("\x03"); expect(withCtrl(true, "d")).toBe("\x04"); expect(withCtrl(false, "c")).toBe("c"); expect(withCtrl(true, "\r")).toBe("\r"); });
});

describe("open / ready / errors", () => {
  test("open sends term_open with clamped size and goes opening -> live with the device's mode", () => {
    const r = rig(); expect(r.s.open("/home/x", 9999, 0)).toBe(true);
    expect(r.sent[0]).toMatchObject({ t: "term_open", root: "/home/x", cols: 500, rows: 1 }); expect(r.s.st.phase).toBe("opening");
    r.s.onFrame({ t: "term_ready", cid: "other", sid: "X" }); expect(r.s.st.phase).toBe("opening"); // foreign cid ignored
    r.s.onFrame({ t: "term_ready", cid: r.sent[0].cid, sid: "S1", mode: "open" }); expect(r.s.st).toMatchObject({ phase: "live", sid: "S1", mode: "open" });
    expect(r.s.open("/x", 80, 24)).toBe(false); // one at a time
  });
  test("a closed socket at open ends with a plain message", () => { const r = rig(); r.down(); expect(r.s.open("/r", 80, 24)).toBe(false); expect(r.s.st.phase).toBe("ended"); expect(r.s.st.endMsg).toContain("Not connected"); });
  test("every error code has a plain message; login_required asks to re-login; terminal_off names the command", () => {
    expect(errorMessage("login_required").relogin).toBe(true);
    expect(errorMessage("terminal_off").text).toContain("vcl set terminal on");
    for (const c of ["unsupported", "limit", "offline", "no_cap", "root_not_allowed", "open_timeout", "spawn_failed", "weird"]) expect(errorMessage(c).text.length).toBeGreaterThan(10);
    const r = rig(); r.s.open("/r", 80, 24); r.s.onFrame({ t: "term_error", cid: r.sent[0].cid, error: "login_required" });
    expect(r.s.st).toMatchObject({ phase: "ended", errorCode: "login_required", relogin: true }); expect(r.s.open("/r", 80, 24)).toBe(true); // can retry
  });
  test("rate_limit while live is a notice, the shell keeps running", () => { const r = rig(); r.open(); r.s.onFrame({ t: "term_error", sid: "S1", error: "rate_limit" }); expect(r.s.st.phase).toBe("live"); expect(r.s.st.notice).toContain("Too much input"); });
});

describe("output, ack, replay", () => {
  test("renders output in order and acks consumed bytes within 100 ms (only after the screen consumed them)", async () => {
    const r = rig(); r.open(); const gate = r.hold();
    r.s.onFrame(out(0, "hello")); expect(r.written).toEqual(["hello"]);
    await tick(ACK_MS + 40); expect(r.sent.some((f) => f.t === "term_ack")).toBe(false); // xterm has not finished writing: no ack yet
    gate.shift()!(); await tick(ACK_MS + 40);
    expect(r.sent.filter((f) => f.t === "term_ack")).toEqual([{ t: "term_ack", sid: "S1", seq: 5 }]);
  });
  test("acks at once every 32 KB", () => {
    const r = rig(); r.open(); r.s.onFrame(out(0, "x".repeat(ACK_EVERY)));
    expect(r.sent.filter((f) => f.t === "term_ack").at(-1)).toEqual({ t: "term_ack", sid: "S1", seq: ACK_EVERY });
  });
  test("a replay that overlaps what was rendered is trimmed, a full duplicate is dropped", () => {
    const r = rig(); r.open(); r.s.onFrame(out(0, "abcdef")); r.s.onFrame(out(0, "abcdef")); r.s.onFrame(out(3, "defgh"));
    expect(r.written).toEqual(["abcdef", "gh"]);
  });
  test("foreign sid output is ignored", () => { const r = rig(); r.open(); r.s.onFrame({ ...out(0, "x"), sid: "ZZ" }); expect(r.written).toEqual([]); });
  test("garbage base64 does not throw or render", () => { const r = rig(); r.open(); expect(() => r.s.onFrame({ t: "term_out", sid: "S1", seq: 0, data: "!!!" })).not.toThrow(); expect(r.written).toEqual([]); });
});

describe("reconnect and gap", () => {
  test("a reconnect re-attaches with the last byte handed to the screen; nothing is sent when no session", () => {
    const r = rig(); r.s.onLinkLive(); expect(r.sent).toEqual([]);
    r.open(); r.s.onFrame(out(0, "abc")); r.s.onLinkLive();
    expect(r.sent.at(-1)).toEqual({ t: "term_attach", sid: "S1", lastSeq: 3 });
    r.s.onFrame(out(0, "abcde")); expect(r.written.at(-1)).toBe("de"); // replay continues without duplicating
  });
  test("term_gap clears the screen, notes it, and resumes from `from`", () => {
    const r = rig(); r.open(); r.s.onFrame(out(0, "old")); r.s.onFrame({ t: "term_gap", sid: "S1", from: 100 });
    expect(r.log).toContain("reset"); expect(r.s.st.notice).toContain("redrawn"); r.s.onFrame(out(100, "new")); expect(r.written).toEqual(["new"]);
    r.s.onFrame({ t: "term_gap", sid: "S1", from: 200, reason: "rate_limit" }); expect(r.s.st.notice).toContain("too fast");
  });
  test("term_exit signal gone (unknown sid after reconnect) ends the session with a message", () => { const r = rig(); r.open(); r.s.onFrame({ t: "term_exit", sid: "S1", code: null, signal: "gone" }); expect(r.s.st).toMatchObject({ phase: "ended", endMsg: "That terminal no longer exists." }); });
});

describe("exit reasons and stop", () => {
  test("every hub and device exit reason reads as plain words", () => {
    expect(exitMessage({ signal: "idle" })).toContain("30 minutes"); expect(exitMessage({ reason: "idle", code: 0 })).toContain("30 minutes");
    expect(exitMessage({ signal: "device_lost" })).toContain("offline"); expect(exitMessage({ reason: "disconnect" })).toContain("offline");
    expect(exitMessage({ signal: "disabled" })).toContain("turned off"); expect(exitMessage({ signal: "revoked" })).toContain("revoked");
    expect(exitMessage({ reason: "daemon_exit" })).toContain("vcl"); expect(exitMessage({ reason: "closed" })).toContain("stopped"); expect(exitMessage({ code: 2, signal: null })).toBe("Shell exited (code 2).");
    const r = rig(); r.open(); r.s.onFrame({ t: "term_exit", sid: "S1", code: null, signal: "revoked" }); expect(r.s.st.phase).toBe("ended"); expect(r.s.input("x")).toBe(false);
  });
  test("stop sends term_close and the session ends on the device's term_exit", () => { const r = rig(); r.open(); r.s.stop(); expect(r.sent.at(-1)).toEqual({ t: "term_close", sid: "S1" }); r.s.onFrame({ t: "term_exit", sid: "S1", code: null, signal: "SIGHUP", reason: "closed" }); expect(r.s.st.phase).toBe("ended"); r.s.dispose(); });
});

describe("banner", () => {
  test("restricted by default, red unrestricted text only for mode=open", () => {
    expect(bannerFor(undefined)).toEqual({ text: LABEL_UNKNOWN, tone: "warn" }); expect(LABEL_UNKNOWN).not.toMatch(/restrict/i); expect(bannerFor("sandbox").text).toBe("Restricted folders, not a vault");
    expect(bannerFor("open")).toEqual({ text: LABEL_OPEN, tone: "warn" }); expect(LABEL_OPEN).toBe("Unrestricted: this shell can read your whole account");
  });
});

describe("vclterm10 B1: term_state adopts a running session", () => {
  test("idle page + term_state -> live with the hub's sid/mode/root, term_attach from 0, screen reset; Stop then works", () => {
    const r = rig(); r.s.onFrame({ t: "term_state", sid: "S9", mode: "open", root: "/home/x/proj", cols: 90, rows: 30, since: 1 });
    expect(r.s.st).toMatchObject({ phase: "live", sid: "S9", mode: "open", root: "/home/x/proj" });
    expect(r.sent.at(-1)).toEqual({ t: "term_attach", sid: "S9", lastSeq: 0 }); expect(r.log).toContain("reset");
    r.s.onFrame({ t: "term_out", sid: "S9", seq: 0, data: b64enc(new TextEncoder().encode("prompt$ ")) }); expect(r.written.join("")).toBe("prompt$ ");
    r.s.stop(); expect(r.sent.at(-1)).toEqual({ t: "term_close", sid: "S9" }); r.s.dispose();
  });
  test("Start meeting an existing session (opening + term_state) turns into live, not an error", () => {
    const r = rig(); r.s.open("/r", 80, 24); r.s.onFrame({ t: "term_state", sid: "S1", root: "/r", since: 1 });
    expect(r.s.st).toMatchObject({ phase: "live", sid: "S1" }); expect(r.s.st.errorCode).toBeUndefined();
    expect(r.sent.at(-1)).toMatchObject({ t: "term_attach", sid: "S1", lastSeq: 0 });
  });
  test("term_state for the session already shown changes nothing (no second attach); ended page adopts a new one", () => {
    const r = rig(); r.open(); r.s.onFrame(out(0, "abc")); const n = r.sent.length;
    r.s.onFrame({ t: "term_state", sid: "S1", root: "/r", since: 1 }); expect(r.sent.length).toBe(n); expect(r.written.join("")).toBe("abc");
    r.s.onFrame({ t: "term_exit", sid: "S1", code: 0, signal: null }); expect(r.s.st.phase).toBe("ended");
    r.s.onFrame({ t: "term_state", sid: "S2", root: "/r", since: 2 }); expect(r.s.st).toMatchObject({ phase: "live", sid: "S2" });
  });
  test("vclterm11: adopted session that is already gone -> term_exit gone ends the pane cleanly, Start enabled", () => {
    const r = rig(); r.s.onFrame({ t: "term_state", sid: "S1", root: "/r", since: 1 });
    r.s.onFrame({ t: "term_exit", sid: "S1", code: null, signal: "gone" });
    expect(r.s.st.phase).toBe("ended"); expect(r.s.st.endMsg).toBe("That terminal no longer exists.");
    r.s.open("/r", 80, 24); expect(r.s.st.phase).toBe("opening");
  });
  test("malformed term_state is ignored", () => { const r = rig(); r.s.onFrame({ t: "term_state", sid: 5 }); expect(r.s.st.phase).toBe("idle"); });
});

describe("vclterm10 B3: keystrokes typed while opening are kept and sent in order at term_ready", () => {
  test("queued, flushed in order after ready; dropped when the open fails; bounded", () => {
    const r = rig(); r.s.open("/r", 80, 24); const cid = r.sent[0].cid;
    expect(r.s.input("echo ")).toBe(true); expect(r.s.input("hi\r")).toBe(true); expect(r.sent.filter((f) => f.t === "term_in").length).toBe(0);
    r.s.onFrame({ t: "term_ready", cid, sid: "S1", mode: "sandbox" });
    const ins = r.sent.filter((f) => f.t === "term_in"); expect(ins.length).toBe(1);
    expect(new TextDecoder().decode(b64dec(ins[0].data))).toBe("echo hi\r"); expect(ins[0].sid).toBe("S1");
    const q = rig(); q.s.open("/r", 80, 24); q.s.input("secret"); q.s.onFrame({ t: "term_error", cid: q.sent[0].cid, error: "offline" });
    q.s.open("/r", 80, 24); q.s.onFrame({ t: "term_ready", cid: q.sent.at(-1).cid, sid: "S2" }); expect(q.sent.filter((f) => f.t === "term_in").length).toBe(0);
    const b = rig(); b.s.open("/r", 80, 24); expect(b.s.input("x".repeat(PENDING_MAX))).toBe(true); expect(b.s.input("y")).toBe(false);
  });
});

describe("vclwin4: web terminal never over-claims folder restriction", () => {
  test("every string visible without a confirmed sandbox mode (unknown/open banner, error messages) has no restriction claim", () => {
    const claim = /(?<!un)restrict|confin|only works inside|sandbox/i;
    expect(bannerFor(undefined).text).not.toMatch(claim);
    for (const c of ["unsupported", "no_cap", "terminal_off", "root_not_allowed", "bad_root", "limit", "offline", "open_timeout", "login_required", "forbidden", "rate_limit", "root_changed", "job_failed", "job_cleanup_failed", "spawn_failed", "weird"]) expect(errorMessage(c).text).not.toMatch(claim);
    expect(bannerFor("sandbox").text).toBe(LABEL_SANDBOX);
  });
});
