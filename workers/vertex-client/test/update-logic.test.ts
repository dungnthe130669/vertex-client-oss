import { describe, expect, test } from "bun:test";
import { FAIL_NOTICE_AFTER, GUARD_WINDOW_MS, autoReloadAllowed, canUpdateNow, decideUpdate, formatAbout, isIdle, lastResultText, nextLast, noticeVisible, parseLastResult, retryDelayMs, shortReason, parseBuiltAt, parseServerVersion, parseVersionInfo, parseVersionReply, relation, relationText, shortBuild, shortUa } from "../web/src/update-logic";

const idle = { busy: 0, fields: [{ tag: "TEXTAREA", type: "textarea", value: "" }], overlay: false };

describe("decideUpdate (silent path)", () => {
  const base = { waiting: true, visible: true, safeMoment: true, idle: true, autoOk: true };
  test("nothing waiting -> none", () => expect(decideUpdate({ ...base, waiting: false })).toBe("none"));
  test("waiting + safe moment + idle + visible + guard ok -> auto", () => expect(decideUpdate(base)).toBe("auto"));
  test("not a safe moment -> defer (never mid-session on a timer)", () => expect(decideUpdate({ ...base, safeMoment: false })).toBe("defer"));
  test("busy / typing / recording (not idle) -> defer, never reload", () => expect(decideUpdate({ ...base, idle: false })).toBe("defer"));
  test("hidden -> defer", () => expect(decideUpdate({ ...base, visible: false })).toBe("defer"));
  test("first install (page loaded uncontrolled) -> defer, never an automatic reload", () => expect(decideUpdate({ ...base, firstInstall: true })).toBe("defer"));
  test("guard tripped -> defer", () => expect(decideUpdate({ ...base, autoOk: false })).toBe("defer"));
  test("no outcome is ever a user-visible banner", () => {
    for (const w of [true, false]) for (const v of [true, false]) for (const sm of [true, false]) for (const i of [true, false]) for (const a of [true, false])
      expect(["none", "auto", "defer"]).toContain(decideUpdate({ waiting: w, visible: v, safeMoment: sm, idle: i, autoOk: a }));
  });
});

describe("failure-only notice", () => {
  test("no failure -> hidden (success never shows anything)", () => expect(noticeVisible(null, false)).toBe(false));
  test("first failure stays hidden; shown once a retry also failed", () => {
    expect(noticeVisible({ reason: "x", attempts: 1 }, false)).toBe(false);
    expect(noticeVisible({ reason: "x", attempts: FAIL_NOTICE_AFTER }, false)).toBe(true);
  });
  test("dismissed for the session -> hidden", () => expect(noticeVisible({ reason: "x", attempts: 5 }, true)).toBe(false));
  test("retries back off and are capped", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(retryDelayMs(50)).toBe(30 * 60_000);
  });
  test("shortReason trims / bounds / never empty", () => {
    expect(shortReason(new Error("  Failed\n to fetch "))).toBe("Failed to fetch");
    expect(shortReason("x".repeat(200)).length).toBe(80);
    expect(shortReason(undefined)).toBe("Unknown error");
  });
});

describe("last silent-update result", () => {
  const fmt = () => "T";
  test("text per kind", () => {
    expect(lastResultText(null, fmt)).toBe("No background update yet");
    expect(lastResultText({ kind: "uptodate", at: 1 }, fmt)).toBe("Up to date (T)");
    expect(lastResultText({ kind: "updated", at: 1, build: "abcdef0123" }, fmt)).toBe("Updated to abcdef0 at T");
    expect(lastResultText({ kind: "failed", at: 1, reason: "HTTP 503" }, fmt)).toBe("Last update failed: HTTP 503 (T)");
  });
  test("nextLast: up-to-date keeps a recorded update; success replaces failure; failure replaces anything", () => {
    const upd = { kind: "updated" as const, at: 1, build: "b" };
    expect(nextLast(upd, { kind: "uptodate", at: 2 })).toBe(upd);
    expect(nextLast({ kind: "failed", at: 1, reason: "r" }, { kind: "uptodate", at: 2 }).kind).toBe("uptodate");
    expect(nextLast(upd, { kind: "failed", at: 3, reason: "r" }).kind).toBe("failed");
  });
  test("parseLastResult tolerates garbage", () => {
    expect(parseLastResult(JSON.stringify({ kind: "updated", at: 5, build: "b" }))).toEqual({ kind: "updated", at: 5, build: "b", reason: undefined });
    for (const bad of [null, "", "nope", "{}", JSON.stringify({ kind: "x", at: 1 }), JSON.stringify({ kind: "updated" })]) expect(parseLastResult(bad)).toBeNull();
  });
});

describe("isIdle", () => {
  test("empty composer is idle", () => expect(isIdle(idle)).toBe(true));
  test("busy registry (turn/stream/upload) blocks", () => expect(isIdle({ ...idle, busy: 1 })).toBe(false));
  test("unsent text blocks, whitespace does not", () => {
    expect(isIdle({ ...idle, fields: [{ tag: "TEXTAREA", type: "textarea", value: "hello" }] })).toBe(false);
    expect(isIdle({ ...idle, fields: [{ tag: "TEXTAREA", type: "textarea", value: "  \n" }] })).toBe(true);
  });
  test("any text-like input with a value blocks (form screens); checkbox/hidden do not", () => {
    expect(isIdle({ ...idle, fields: [{ tag: "INPUT", type: "text", value: "x" }] })).toBe(false);
    expect(isIdle({ ...idle, fields: [{ tag: "INPUT", type: "url", value: "x" }] })).toBe(false);
    expect(isIdle({ ...idle, fields: [{ tag: "INPUT", type: "checkbox", value: "on" }, { tag: "INPUT", type: "hidden", value: "t" }] })).toBe(true);
  });
  test("open sheet/dialog blocks", () => expect(isIdle({ ...idle, overlay: true })).toBe(false));
});

describe("autoReloadAllowed (reload-loop guard)", () => {
  const now = 1_000_000;
  test("no marker -> allowed", () => expect(autoReloadAllowed(null, now)).toBe(true));
  test("recent marker -> refused", () => expect(autoReloadAllowed(String(now - 5000), now)).toBe(false));
  test("old marker -> allowed again", () => expect(autoReloadAllowed(String(now - GUARD_WINDOW_MS - 1), now)).toBe(true));
  test("garbage / future marker -> allowed (cannot wedge updates forever)", () => {
    expect(autoReloadAllowed("nope", now)).toBe(true);
    expect(autoReloadAllowed(String(now + 99999), now)).toBe(true);
  });
});

describe("version message", () => {
  test("parses only a well-formed VERSION reply", () => {
    expect(parseVersionReply({ t: "VERSION", build: "abc123def456" })).toBe("abc123def456");
    for (const bad of [null, undefined, {}, { t: "VERSION" }, { t: "VERSION", build: "" }, { t: "nav", build: "x" }, { t: "VERSION", build: 5 }]) expect(parseVersionReply(bad)).toBeNull();
  });
  test("shortBuild", () => { expect(shortBuild("abcdef0123456")).toBe("abcdef0"); expect(shortBuild(null)).toBe("unknown"); });
});

describe("about: version compare / decision", () => {
  test("relation: same build matches, different is older, anything missing is unknown", () => {
    expect(relation("aaaaaaaaaaaa", "aaaaaaaaaaaa")).toBe("match");
    expect(relation("aaaaaaaaaaaa", "bbbbbbbbbbbb")).toBe("older");
    expect(relation(null, "bbbbbbbbbbbb")).toBe("unknown");
    expect(relation("aaaaaaaaaaaa", null)).toBe("unknown");
  });
  test("Update now enabled when a worker waits OR the server is ahead; not when matching/unknown", () => {
    expect(canUpdateNow(true, "match")).toBe(true);
    expect(canUpdateNow(false, "older")).toBe(true);
    expect(canUpdateNow(false, "match")).toBe(false);
    expect(canUpdateNow(false, "unknown")).toBe(false);
  });
  test("texts", () => {
    expect(relationText("match")).toBe("This device matches the server");
    expect(relationText("older")).toBe("This device is older than the server (update available)");
  });
  test("parseBuiltAt: only when /version.json describes the build this device runs", () => {
    const j = { build: "abc", commit: "1234567", builtAt: "2026-10-20T01:02:03Z" };
    expect(parseBuiltAt(j, "abc")).toBe("2026-10-20T01:02:03Z");
    expect(parseBuiltAt(j, "other")).toBeNull();
    expect(parseBuiltAt(j, null)).toBeNull();
    expect(parseBuiltAt({ ...j, builtAt: "unknown" }, "abc")).toBeNull();
    expect(parseBuiltAt("x", "abc")).toBeNull();
  });
  test("parseVersionInfo: commit, 'unknown' -> null, bad shape -> null", () => {
    expect(parseVersionInfo({ t: "VERSION", build: "abc", commit: "1234567", builtAt: "ignored" })).toEqual({ build: "abc", commit: "1234567" });
    expect(parseVersionInfo({ t: "VERSION", build: "abc", commit: "unknown" })).toEqual({ build: "abc", commit: null });
    expect(parseVersionInfo({ t: "VERSION", build: "abc" })).toEqual({ build: "abc", commit: null });
    expect(parseVersionInfo({ t: "nope" })).toBeNull();
  });
  test("parseServerVersion", () => {
    expect(parseServerVersion({ worker_version_id: "w", build: "b", commit: null, builtAt: 5 })).toEqual({ worker_version_id: "w", build: "b", commit: null, builtAt: null });
    expect(parseServerVersion(null)).toBeNull();
    expect(parseServerVersion("x")).toBeNull();
  });
  test("formatAbout is one 'Label: value' line per row; shortUa", () => {
    expect(formatAbout([["App build", "abc"], ["Network", "online"]])).toBe("App build: abc\nNetwork: online");
    expect(shortUa("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile Safari/604")).toBe("Safari 17 · iPhone");
  });
});

describe("parseDeployedVersion (no-SW shell fallback)", () => {
  test("valid / unknown / junk", async () => {
    const { parseDeployedVersion } = await import("../web/src/update-logic");
    expect(parseDeployedVersion({ build: "abc", commit: "c1", builtAt: "2026-01-01T00:00:00Z" })).toEqual({ build: "abc", commit: "c1", builtAt: "2026-01-01T00:00:00Z" });
    expect(parseDeployedVersion({ build: "abc", commit: "unknown" })).toEqual({ build: "abc", commit: null, builtAt: null });
    for (const d of [null, 5, {}, { build: "unknown" }, { build: 3 }]) expect(parseDeployedVersion(d)).toBeNull();
  });
});
