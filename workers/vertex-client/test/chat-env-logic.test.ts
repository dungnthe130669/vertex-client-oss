import { describe, expect, test } from "bun:test";
import { defaultChoice, dirFor, envBanner, envBlock, envChoices, liveEnv, liveEnvWith, type EnvInfo } from "../web/src/chat-env-logic";
import { ackTurn, beginTurn, emptyFeed, foldEvent, turnLine } from "../web/src/devices-logic";
import { applyServer, emptyChat, type ChatState } from "../web/src/chat-state";

const dev = (o: Record<string, unknown>) => ({ id: "a".repeat(32), name: "laptop", created_at: 1, last_seen: 1, online: true, ...o }) as any;
const env = (o: Partial<EnvInfo> = {}): EnvInfo => ({ kind: "device", device_id: "a".repeat(32), dir: "/work/app", name: "laptop", state: "ready", ...o });

describe("picker choices", () => {
  test("this computer first, then online, then offline; never revoked (the list has none)", () => {
    const c = envChoices([dev({ id: "1".repeat(32), name: "b", online: false }), dev({ id: "2".repeat(32), name: "a", online: true }), dev({ id: "3".repeat(32), name: "me", online: true, this_install: true })]);
    expect(c.map((x) => x.name)).toEqual(["me", "a", "b"]); expect(c[0].thisDevice).toBe(true); expect(c[2].online).toBe(false);
  });
  test("default: desktop shell picks this computer only; the browser never picks for the user", () => {
    const c = envChoices([dev({ id: "3".repeat(32), name: "me", this_install: true }), dev({ id: "2".repeat(32), name: "a" })]);
    expect(defaultChoice(c, true)?.name).toBe("me"); expect(defaultChoice(c, false)).toBeNull();
    expect(defaultChoice(envChoices([dev({ name: "a" })]), true)).toBeNull(); // shell but no row is this install: nothing guessed
  });
  test("an offline this-computer is still the default (the chat starts queued, as designed)", () => {
    expect(defaultChoice(envChoices([dev({ name: "me", this_install: true, online: false })]), true)?.name).toBe("me");
  });
  test("folder: the only root; the chosen one; unreported roots mean no dir (the device decides)", () => {
    expect(dirFor(envChoices([dev({ roots: [{ label: "w", path: "/w" }] })])[0])).toBe("/w");
    const two = envChoices([dev({ roots: [{ label: "w", path: "/w" }, { label: "x", path: "/x" }] })])[0];
    expect(dirFor(two)).toBe("/w"); expect(dirFor(two, "/x")).toBe("/x"); expect(dirFor(two, "/evil")).toBe("/w"); // a path not offered by the device is ignored
    expect(dirFor(envChoices([dev({})])[0])).toBeNull(); expect(dirFor(envChoices([dev({ roots: [] })])[0])).toBeNull();
  });
});

describe("banner + composer block", () => {
  test("ready / offline / revoked / unavailable", () => {
    expect(envBanner(env())).toMatchObject({ tone: "info", text: "Running on laptop · /work/app" });
    expect(envBanner(env({ dir: null }))?.text).toBe("Running on laptop");
    expect(envBanner(env({ state: "offline" }))).toMatchObject({ tone: "warn" }); expect(envBanner(env({ state: "offline" }))!.text).toContain("offline");
    expect(envBanner(env({ state: "revoked" }))).toMatchObject({ tone: "error" }); expect(envBanner(env({ state: "revoked" }))!.text).toContain("revoked");
    expect(envBanner(env({ state: "unavailable" }))!.text).toContain("turned off");
  });
  test("only revoked/unavailable block sending, with the reason; offline is allowed (queued)", () => {
    expect(envBlock(env())).toBe(""); expect(envBlock(env({ state: "offline" }))).toBe("");
    expect(envBlock(env({ state: "revoked" }))).toContain("revoked"); expect(envBlock(env({ state: "unavailable" }))).toContain("turned off");
    expect(envBlock(null)).toBe("");
  });
  test("wording is computer-neutral: no OS names anywhere", () => {
    for (const s of ["ready", "offline", "revoked", "unavailable"] as const) expect(envBanner(env({ state: s }))!.text).not.toMatch(/mac|windows|linux/i);
  });
  test("liveEnv re-derives ready/offline from the latest list; a revoked/missing row is revoked; unknown list keeps the state", () => {
    expect(liveEnv(env(), [dev({ online: false })]).state).toBe("offline"); expect(liveEnv(env({ state: "offline" }), [dev({ online: true })]).state).toBe("ready");
    expect(liveEnv(env(), [dev({ id: "9".repeat(32) })]).state).toBe("revoked"); expect(liveEnv(env(), null).state).toBe("ready");
    expect(liveEnv(env({ state: "unavailable" }), [dev({})]).state).toBe("ready");       // devv2s3t: a chat loaded while the switch was OFF recovers once a refresh succeeds (not sticky)
    expect(liveEnv(env({ state: "unavailable" }), [dev({ online: false })]).state).toBe("offline"); expect(liveEnv(env({ state: "unavailable" }), [dev({ id: "9".repeat(32) })]).state).toBe("revoked");
    expect(liveEnv(env({ state: "unavailable" }), null).state).toBe("unavailable");      // an unreadable list keeps what we know
    expect(liveEnv(env({ state: "revoked" }), [dev({})]).state).toBe("revoked");          // a revoked device never comes back
  });
});

describe("initially-disabled chat recovers (round 6)", () => {
  test("liveEnvWith: base unavailable + confirmed ON + list => ready/offline and the composer is not blocked; confirmed OFF keeps it unavailable; unknown (null) never reads as OFF; revoked stays sticky", () => {
    const base = env({ state: "unavailable" });
    expect(liveEnvWith(base, [dev({})], true).state).toBe("ready"); expect(envBlock(liveEnvWith(base, [dev({})], true))).toBe("");
    expect(liveEnvWith(base, [dev({ online: false })], true).state).toBe("offline"); expect(envBlock(liveEnvWith(base, [dev({ online: false })], true))).toBe("");
    expect(liveEnvWith(base, [dev({})], false).state).toBe("unavailable");
    expect(liveEnvWith(base, null, null).state).toBe("unavailable");
    expect(liveEnvWith(env({ state: "revoked" }), [dev({})], true).state).toBe("revoked");
    expect(liveEnvWith(env(), [dev({})], false).state).toBe("unavailable"); expect(liveEnvWith(env(), [dev({})], true).state).toBe("ready");   // ON -> OFF -> ON still works
  });
});

describe("chat state: device status events drive the step-1 status line", () => {
  const ev = (st: ChatState, seq: number, e: Record<string, unknown>, ts = 1000) => applyServer(st, { t: "ev", seq, ts, e: e as any });
  test("ack(queued) -> queued; ack -> sent; delivered; accepted; working; done; cleared on turn_end", () => {
    let s = ev(emptyChat(), 1, { type: "turn_start", turn: 1 });
    s = ev(s, 2, { type: "device_ev", e: { type: "cmd_ack", cid: "c1", queued: true } }); expect(turnLine(s.devFeed!.turn, 1000, "laptop")!.state).toBe("queued");
    s = ev(emptyChat(), 1, { type: "turn_start", turn: 1 }); s = ev(s, 2, { type: "device_ev", e: { type: "cmd_ack", cid: "c1", queued: false } }); expect(turnLine(s.devFeed!.turn, 1000, "laptop")!.text).toBe("Sent to laptop…");
    s = ev(s, 3, { type: "device_ev", e: { type: "cmd_sent", cid: "c1", cseq: 1 } }); expect(turnLine(s.devFeed!.turn, 1000, "laptop")!.text).toBe("Waiting for laptop…");
    s = ev(s, 4, { type: "device_ev", e: { type: "cmd_acked", cid: "c1", cseq: 1 } }); expect(turnLine(s.devFeed!.turn, 1000, "laptop")!.text).toBe("laptop received it");
    s = ev(s, 5, { type: "device_ev", e: { type: "assistant_text" } }); expect(turnLine(s.devFeed!.turn, 1000, "laptop")!.state).toBe("working");
    s = ev(s, 6, { type: "turn_end", status: "done", error: null }); expect(s.devFeed).toBeNull();
  });
  test("silence is never invisible: sent for 16 s with no ack reads 'not answering', accepted for 21 s reads 'did not start a session'", () => {
    let s = ev(emptyChat(), 1, { type: "turn_start", turn: 1 }); s = ev(s, 2, { type: "device_ev", e: { type: "cmd_ack", cid: "c1", queued: false } }, 1000);
    expect(turnLine(s.devFeed!.turn, 1000 + 16_000, "laptop")!.state).toBe("unreachable");
    s = ev(s, 3, { type: "device_ev", e: { type: "cmd_acked", cid: "c1", cseq: 1 } }, 2000); expect(turnLine(s.devFeed!.turn, 2000 + 21_000, "laptop")!.state).toBe("not_started");
  });
  test("a new turn starts with a clean line; replayed events (seq <= lastSeq) change nothing", () => {
    let s = ev(emptyChat(), 1, { type: "turn_start", turn: 1 }); s = ev(s, 2, { type: "device_ev", e: { type: "cmd_ack", cid: "c1", queued: false } });
    const again = ev(s, 2, { type: "device_ev", e: { type: "cmd_ack", cid: "zzz", queued: true } }); expect(again).toBe(s);
    s = ev(s, 3, { type: "turn_end", status: "done" }); s = ev(s, 4, { type: "turn_start", turn: 2 }); expect(s.devFeed).toBeNull();
  });
  test("device approvals ride the existing awaiting cards (approval_required / decision / cancelled)", () => {
    let s = ev(emptyChat(), 1, { type: "approval_required", expiresAt: 5000, calls: [{ id: "t1", name: "Bash", input: { preview: "rm x" } }] });
    expect(s.awaiting!.calls[0]).toMatchObject({ id: "t1", decision: null });
    s = ev(s, 2, { type: "approval_decision", id: "t1", decision: "approve" }); expect(s.awaiting!.calls[0].decision).toBe("approve");
    s = ev(s, 3, { type: "approval_cancelled" }); expect(s.awaiting).toBeNull();
  });
  test("step-1 line functions are unchanged by this reuse (guard)", () => {
    const f = ackTurn(beginTurn(emptyFeed(), "c", {}, 0), "c", false, 0); expect(turnLine(foldEvent(f, 1, { type: "turn_done", is_error: false }).turn, 0)!.state).toBe("done");
  });
  test("devv2s3s F8 liveEnvWith: a CONFIRMED switch-off makes the chat unavailable; unknown (null) and a later ON never read as off; revoked stays revoked", () => {
    expect(liveEnvWith(env(), [dev({ online: true })], false).state).toBe("unavailable");
    expect(liveEnvWith(env(), null, false).state).toBe("unavailable");                       // master switch off: the list is a 404 -> null, still confirmed off
    expect(liveEnvWith(env(), [dev({ online: true })], null).state).toBe("ready");           // loading / transient error: not off
    expect(liveEnvWith(env(), [dev({ online: true })], true).state).toBe("ready");
    expect(liveEnvWith(env({ state: "unavailable" }), [dev({})], false).state).toBe("unavailable");
    expect(liveEnvWith(env(), [dev({ id: "9".repeat(32) })], false).state).toBe("revoked");
    const off = liveEnvWith(env(), [dev({ online: true })], false); expect(liveEnvWith(env(), [dev({ online: true })], true).state).toBe("ready"); expect(off.state).toBe("unavailable");   // ON again restores (the input env was never mutated)
  });
});
