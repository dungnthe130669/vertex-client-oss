import { describe, expect, test } from "bun:test";
import { connNotice, connNoticeDelay, CONN_NOTICE_DELAY_MS, awayFromBottom, decorateCode, dragHasFiles, editDraft, enterAction, escStops, lastUserId, noticeFor, resendFor, sendModel } from "../web/src/chat-ux";

const m = (id: number, role: "user" | "assistant", content: any[]) => ({ id, role, content, model: null, usage: null, costUsd: null, stopReason: null, status: "done", ttftMs: null, totalMs: null, createdAt: 0 }) as any;
const convo = [
  m(1, "user", [{ type: "file_ref", ref: "r1", name: "a.png", mime: "image/png", size: 5 }, { type: "text", text: "look" }]),
  m(2, "assistant", [{ type: "tool_use", id: "t", name: "x", input: {} }]),
  m(3, "user", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
  m(4, "assistant", [{ type: "text", text: "done" }]),
  m(5, "user", [{ type: "text", text: "again" }]),
  m(6, "assistant", [{ type: "text", text: "sure" }]),
];

describe("code blocks", () => {
  test("language label + Copy button, body kept escaped, no inline style/handler", () => {
    const html = decorateCode('<p>x</p><pre><code class="language-ts">const a = &#39;&lt;b&gt;&#39;;\n</code></pre>');
    expect(html).toContain('<span class="lang">ts</span>');
    expect(html).toContain("data-copy");
    expect(html).not.toMatch(/style=|onclick=/i);
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain(";\n</code>");
  });
  test("no language -> text", () => expect(decorateCode("<pre><code>x\n</code></pre>")).toContain('<span class="lang">text</span>'));
});

describe("scroll-to-bottom threshold", () => {
  test("only past 200px", () => {
    expect(awayFromBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 300 })).toBe(false); // 200 away
    expect(awayFromBottom({ scrollHeight: 1000, scrollTop: 499, clientHeight: 300 })).toBe(true);
    expect(awayFromBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 })).toBe(false);
  });
});

describe("regenerate / edit", () => {
  test("regenerate resends the real user turn before the answer, skipping tool results, keeping files", () => {
    expect(resendFor(convo, 4)).toEqual({ text: "look", files: [{ ref: "r1", name: "a.png", mime: "image/png", size: 5 }] });
    expect(resendFor(convo, 6)).toEqual({ text: "again", files: [] });
    expect(resendFor(convo, 1)).toBeNull();
  });
  test("edit is offered on the last real user message only", () => {
    expect(lastUserId(convo)).toBe(5);
    expect(lastUserId(convo.slice(0, 4))).toBe(1);
    expect(lastUserId([m(1, "user", [{ type: "tool_result", tool_use_id: "t", content: "" }])])).toBeNull();
    expect(editDraft(convo, 5)).toEqual({ text: "again", files: [] });
    expect(editDraft(convo, 6)).toBeNull();
  });
});

describe("keys", () => {
  test("desktop Enter sends, Shift+Enter newline, composing never sends", () => {
    expect(enterAction({ key: "Enter", shiftKey: false }, true)).toBe("send");
    expect(enterAction({ key: "Enter", shiftKey: true }, true)).toBe("newline");
    expect(enterAction({ key: "Enter", shiftKey: false, isComposing: true }, true)).toBe("newline");
  });
  test("coarse pointer: Enter is a newline", () => expect(enterAction({ key: "Enter", shiftKey: false }, false)).toBe("newline"));
  test("Esc stops only a running turn on desktop with nothing else open", () => {
    const o = { running: true, finePointer: true, dialogOpen: false };
    expect(escStops({ key: "Escape", defaultPrevented: false }, o)).toBe(true);
    expect(escStops({ key: "Escape", defaultPrevented: false }, { ...o, running: false })).toBe(false);
    expect(escStops({ key: "Escape", defaultPrevented: false }, { ...o, finePointer: false })).toBe(false);
    expect(escStops({ key: "Escape", defaultPrevented: true }, o)).toBe(false);
    expect(escStops({ key: "Escape", defaultPrevented: false }, { ...o, dialogOpen: true })).toBe(false);
  });
  test("drag with files", () => { expect(dragHasFiles(["text/plain", "Files"])).toBe(true); expect(dragHasFiles(["text/plain"])).toBe(false); expect(dragHasFiles(undefined)).toBe(false); });
});

describe("sendModel", () => {
  test("an unloaded picker ('') sends no model id (the server rejects '' as bad model id); a real id passes through", () => {
    expect(sendModel("")).toBeUndefined();
    expect(sendModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
  });
});

import { canStop, composerBlock, loadDraft, loadNewChatDraft, dropNewChatDrafts, newChatKey, saveDraft, SHORTCUTS, opensShortcutHelp } from "../web/src/chat-ux";
describe("reliability helpers", () => {
  test("Stop is live while a send is waiting for the server", () => {
    expect(canStop(false, true)).toBe(true); expect(canStop(true, false)).toBe(true); expect(canStop(false, false)).toBe(false);
  });
  test("composerBlock: offline beats reconnecting; the start screen is never blocked", () => {
    expect(composerBlock({ online: false, socket: "closed", draftScreen: false })).toBe("Offline - will send when back");
    expect(composerBlock({ online: true, socket: "connecting", draftScreen: false })).toMatch(/Reconnecting/);
    expect(composerBlock({ online: true, socket: "closed", draftScreen: false })).toMatch(/Not connected/);
    expect(composerBlock({ online: true, socket: "open", draftScreen: false })).toBe("");
    expect(composerBlock({ online: false, socket: "closed", draftScreen: true })).toBe("");
  });
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, m }; };
  test("drafts persist per chat and clear when emptied", () => {
    const s = mem();
    saveDraft("a", "hello", s); saveDraft("b", "other", s);
    expect(loadDraft("a", s)).toBe("hello"); expect(loadDraft("b", s)).toBe("other");
    saveDraft("a", "   ", s);
    expect(loadDraft("a", s)).toBe(""); expect(loadDraft("b", s)).toBe("other");
  });
  test("the unsent new chat is owned by (account, space): Business is not visible in Open, another account sees nothing", () => {
    const s = mem();
    const bizA = newChatKey("a@x", "biz"), openA = newChatKey("a@x", "open"), bizB = newChatKey("b@x", "biz");
    expect(new Set([bizA, openA, bizB]).size).toBe(3);
    saveDraft(bizA, "confidential", s); saveDraft("conv-1", "other", s);
    expect(loadNewChatDraft(bizA, s)).toBe("confidential");
    expect(loadNewChatDraft(openA, s)).toBe("");
    expect(loadNewChatDraft(bizB, s)).toBe("");
    expect(loadDraft("conv-1", s)).toBe("other");
    saveDraft(bizA, "", s);
    expect(loadNewChatDraft(bizA, s)).toBe("");
  });
  test("an ambiguous user name cannot collide across owners (JSON-encoded key)", () => {
    expect(newChatKey("a", "biz")).not.toBe(newChatKey('a","biz', ""));
  });
  test("the legacy shared __new_chat__ entry is discarded on load, never offered", () => {
    const s = mem(); s.setItem("vc:draft:__new_chat__", "old shared text");
    expect(loadNewChatDraft(newChatKey("a@x", "biz"), s)).toBe("");
    expect(s.getItem("vc:draft:__new_chat__")).toBeNull();
  });
  test("sign-out (dropNewChatDrafts) removes every owner's new-chat draft and the legacy one, and nothing else", () => {
    const s = mem(); s.setItem("vc:draft:__new_chat__", "legacy");
    saveDraft(newChatKey("a@x", "biz"), "t1", s); saveDraft(newChatKey("a@x", "open"), "t2", s); saveDraft("conv-1", "keep", s);
    dropNewChatDrafts(s);
    expect(loadDraft(newChatKey("a@x", "biz"), s)).toBe(""); expect(loadDraft(newChatKey("a@x", "open"), s)).toBe("");
    expect(s.getItem("vc:draft:__new_chat__")).toBeNull();
    expect(loadDraft("conv-1", s)).toBe("keep");
  });
  test("storage that throws or is missing never breaks the composer", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => saveDraft("a", "x", bad)).not.toThrow(); expect(loadDraft("a", bad)).toBe("");
    expect(() => saveDraft("a", "x", null)).not.toThrow(); expect(loadDraft("a", null)).toBe("");
  });
  test("the shortcut list names every shortcut the app has", () => {
    const all = SHORTCUTS.flatMap((s) => s.keys).join(" ");
    for (const k of ["Ctrl+K", "Cmd+K", "Ctrl+B", "Cmd+B", "Ctrl+F", "Cmd+F", "Ctrl+Shift+O", "Cmd+Shift+O", "Ctrl+N", "Cmd+N", "Ctrl+,", "Cmd+,", "Enter", "Shift+Enter", "Esc"]) expect(all).toContain(k);
  });
  test("? opens the help only on desktop, outside text fields, with no modifier", () => {
    const ev = (o: object = {}) => ({ key: "?", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: { tagName: "DIV" }, ...o });
    expect(opensShortcutHelp(ev(), true)).toBe(true);
    expect(opensShortcutHelp(ev(), false)).toBe(false);
    expect(opensShortcutHelp(ev({ target: { tagName: "TEXTAREA" } }), true)).toBe(false);
    expect(opensShortcutHelp(ev({ target: { tagName: "INPUT" } }), true)).toBe(false);
    expect(opensShortcutHelp(ev({ target: { tagName: "DIV", isContentEditable: true } }), true)).toBe(false);
    expect(opensShortcutHelp(ev({ ctrlKey: true }), true)).toBe(false);
    expect(opensShortcutHelp(ev({ key: "/" }), true)).toBe(false);
    expect(opensShortcutHelp(ev({ defaultPrevented: true }), true)).toBe(false);
  });
});

describe("noticeFor", () => {
  const models = [{ id: "auto" }, { id: "claude-x", provider: "gateway" }, { id: "g1", provider: "groq" }];
  const notices = { groq: "Data goes to Groq" };
  test("returns the notice of the selected model's provider, generic by provider id", () => {
    expect(noticeFor(models, "g1", notices)).toBe("Data goes to Groq");
    expect(noticeFor(models, "g1", { groq: "x", other: "y" })).toBe("x");
  });
  test("empty for Auto, a provider without a notice, unknown model, no models or no notices", () => {
    expect(noticeFor(models, "auto", notices)).toBe(""); expect(noticeFor(models, "claude-x", notices)).toBe(""); expect(noticeFor(models, "nope", notices)).toBe("");
    expect(noticeFor(null, "g1", notices)).toBe(""); expect(noticeFor(models, "g1", undefined)).toBe("");
  });
});

describe("connection notice (debounced, overlay)", () => {
  const rig = () => {
    let now = 0; const q: Array<{ at: number; f: () => void; id: number }> = []; let n = 0; const seen: boolean[] = [];
    const t = { set: (f: () => void, ms: number) => { const id = ++n; q.push({ at: now + ms, f, id }); return id; }, clear: (h: unknown) => { const i = q.findIndex((x) => x.id === h); if (i >= 0) q.splice(i, 1); } };
    const c = connNotice((v) => seen.push(v), t);
    const adv = (ms: number) => { now += ms; for (const x of q.filter((y) => y.at <= now)) { q.splice(q.indexOf(x), 1); x.f(); } };
    return { c, adv, seen };
  };
  test("delay: none when open, 0 offline, 2 s otherwise", () => {
    expect(connNoticeDelay("open", true)).toBeNull();
    expect(connNoticeDelay("open", false)).toBe(0); // offline wins over an open-looking socket
    expect(connNoticeDelay("closed", false)).toBe(0);
    expect(connNoticeDelay("connecting", true)).toBe(CONN_NOTICE_DELAY_MS);
  });
  test("a blip shorter than the delay never shows anything", () => {
    const { c, adv, seen } = rig();
    c.update("closed", true); adv(1500); c.update("connecting", true); adv(400); c.update("open", true); adv(5000);
    expect(seen).toEqual([]);
  });
  test("away > 2 s shows once (connecting<->closed flaps do not restart the clock), open hides", () => {
    const { c, adv, seen } = rig();
    c.update("closed", true); adv(1000); c.update("connecting", true); adv(900); c.update("closed", true); adv(200);
    expect(seen).toEqual([true]);
    c.update("open", true); expect(seen).toEqual([true, false]);
  });
  test("offline shows at once; dispose cancels a pending show", () => {
    const a = rig(); a.c.update("closed", false); expect(a.seen).toEqual([true]);
    const b = rig(); b.c.update("connecting", true); b.c.dispose(); b.adv(5000); expect(b.seen).toEqual([]);
  });
});
