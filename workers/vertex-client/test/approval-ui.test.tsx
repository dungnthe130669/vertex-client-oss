// Approval modes UI: pure client state + helpers, the card buttons / audit line / composer chip, and Settings > Approvals against the REAL handlers.
// happy-dom for this file only, removed afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { makeSession } from "../src/auth";
import { addGrant, writeAudit } from "../src/grants";
import { scopeFor } from "../src/scope";
import { applyServer, emptyChat, fromServer, type ChatState, type Frame } from "../web/src/chat-state";
import { AUTO_BODY, autoLine, chipAria, chipLabel, chipVisible, expiryNote } from "../web/src/approval-logic";
import { teamMayOpen } from "../web/src/desk-logic";
import { app, mkEnv } from "./user-keys-harness";

const ev = (seq: number, e: any): Frame => ({ t: "ev", seq, ts: 1000, e });
describe("chat state: approval events", () => {
  test("approval_required carries the host, canAlways and the deadline; decisions keep them", () => {
    let s: ChatState = emptyChat();
    s = applyServer(s, ev(1, { type: "approval_required", expiresAt: 5000, calls: [{ id: "a", name: "web_read", input: { url: "https://n.test/x" }, host: "n.test", canAlways: true }] }));
    expect(s.awaiting).toMatchObject({ expiresAt: 5000, calls: [{ id: "a", host: "n.test", canAlways: true, decision: null }] });
    s = applyServer(s, ev(2, { type: "approval_decision", id: "a", decision: "approve" }));
    expect(s.awaiting).toMatchObject({ expiresAt: 5000, calls: [{ id: "a", decision: "approve", host: "n.test" }] });
  });
  test("approval_expired / approval_cancelled clear the card", () => {
    for (const type of ["approval_expired", "approval_cancelled"]) {
      let s = applyServer(emptyChat(), ev(1, { type: "approval_required", calls: [{ id: "a", name: "save_note", input: {} }] }));
      s = applyServer(s, ev(2, { type })); expect(s.awaiting).toBeNull();
    }
  });
  test("approval_auto adds the audit line entry; approval_mode / approval_grants update the chip data", () => {
    let s = applyServer(emptyChat(), ev(1, { type: "approval_auto", id: "u3", name: "web_read", subject: "example.com", source: "mode-auto" }));
    expect(s.autoLog["u3"]).toEqual({ name: "web_read", subject: "example.com", source: "mode-auto" });
    s = applyServer(s, ev(2, { type: "approval_mode", mode: "auto" })); expect(s.approvalMode).toBe("auto");
    s = applyServer(s, ev(3, { type: "approval_mode", mode: "ask" })); expect(s.approvalMode).toBe("ask");
    s = applyServer(s, ev(4, { type: "approval_grants", hosts: ["a.test", "b.test"] })); expect(s.webGrants).toEqual(["a.test", "b.test"]);
  });
  test("fromServer restores mode, grants, audit lines and the admin flag; an old server (no fields) gives safe defaults", () => {
    const base: any = { seq: 3, running: false, inflight: null, model: "m", title: "", error: null, costUsd: 0, tokens: 0, messages: [] };
    expect(fromServer({ ...base, approvalMode: "auto", webGrants: ["a.test"], autoLog: { u: { name: "web_read", subject: "a.test", source: "chat-grant" } }, approvalAuto: true })).toMatchObject({ approvalMode: "auto", webGrants: ["a.test"], approvalAuto: true, autoLog: { u: { subject: "a.test" } } });
    expect(fromServer(base)).toMatchObject({ approvalMode: "ask", webGrants: [], autoLog: {}, approvalAuto: false });
  });
});

describe("team user: no connector screens", () => {
  test("/connectors (and its detail pages) is never opened for a team session; Settings > Approvals and Subagents are", () => {
    for (const p of ["/connectors", "/connectors/new", "/connectors/personal-connector", "/settings/capabilities"]) expect(teamMayOpen(p, true)).toBe(false);
    expect(teamMayOpen("/settings/approvals", true)).toBe(true); expect(teamMayOpen("/settings/subagents", false)).toBe(true);
  });
});

describe("approval-logic", () => {
  test("audit line text", () => expect(autoLine({ name: "web_read", subject: "example.com", source: "mode-auto" })).toBe("Auto-allowed web_read example.com - by your setting"));
  test("expiry note", () => {
    expect(expiryNote(null, 0)).toBeNull(); expect(expiryNote(undefined, 0)).toBeNull();
    expect(expiryNote(30 * 60_000, 0)).toBe("Expires in 30 min"); expect(expiryNote(30_000, 0)).toBe("Expires in under a minute"); expect(expiryNote(10, 20)).toBe("Expired");
  });
  test("chip: labels, aria, visibility (admin off hides it unless the chat is already in Auto)", () => {
    expect(chipLabel("ask")).toBe("Ask"); expect(chipLabel("auto")).toBe("Auto"); expect(chipAria("ask")).toContain("Change mode"); expect(chipLabel("bypass")).toBe("Bypass");
    expect(chipVisible({ hasChat: true, approvalAuto: true, mode: "ask" })).toBe(true);
    expect(chipVisible({ hasChat: true, approvalAuto: false, mode: "ask" })).toBe(false);
    expect(chipVisible({ hasChat: true, approvalAuto: false, mode: "auto" })).toBe(true);
    expect(chipVisible({ hasChat: false, approvalAuto: true, mode: "ask" })).toBe(false);
  });
  test("the confirm text says plainly what Auto does and does not cover", () => {
    for (const w of ["web pages", "this chat", "Ask", "never", "deleting", "spending money", "credentials", "line in the chat"]) expect(AUTO_BODY).toContain(w);
  });
});

let CS: typeof import("../web/src/composer-sheet"); let render: typeof import("preact").render; let h: typeof import("preact").h; let C: typeof import("../web/src/approval-chip"); let P: typeof import("../web/src/settings-pages"); let A: typeof import("../web/src/api"); let S: typeof import("../web/src/space");
const REAL_FETCH = globalThis.fetch; const NativeRequest = Request, NativeHeaders = Headers;
const wait = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const until = async (f: () => unknown) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); };
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const preact = await import("preact"); render = preact.render; h = preact.h;
  C = await import("../web/src/approval-chip"); P = await import("../web/src/settings-pages"); A = await import("../web/src/api"); S = await import("../web/src/space"); CS = await import("../web/src/composer-sheet");
});
afterAll(() => { globalThis.fetch = REAL_FETCH; S.resetSpaceForTest(); GlobalRegistrator.unregister(); delete (globalThis as { matchMedia?: unknown }).matchMedia; });

describe("components", () => {
  test("card buttons: a web call shows Approve once / Allow <host> in this chat / Always allow <host> / Deny, each reporting the right grant; a hard-ask call shows only Approve / Deny", async () => {
    const root = document.createElement("div"); document.body.appendChild(root); const got: unknown[][] = [];
    const q = (t: string) => root.querySelector<HTMLElement>(`[data-testid="${t}"]`);
    render(h(C.ApprovalButtons, { id: "u2", host: "news.test", canAlways: true, expiresAt: Date.now() + 29 * 60_000, onDecide: (...a: unknown[]) => got.push(a) }), root);
    expect(q("approve-once")!.textContent).toBe("Approve once"); expect(q("allow-chat")!.textContent).toBe("Allow news.test in this chat"); expect(q("allow-always")!.textContent).toBe("Always allow news.test"); expect(q("approval-expiry")!.textContent).toMatch(/^Expires in 2[89] min/);
    q("approve-once")!.click(); q("allow-chat")!.click(); q("allow-always")!.click(); q("deny")!.click();
    expect(got).toEqual([["u2", "approve"], ["u2", "approve", "chat"], ["u2", "approve", "user"], ["u2", "deny"]]);
    render(h(C.ApprovalButtons, { id: "u3", host: "news.test", canAlways: false, onDecide: () => {} }), root); expect(q("allow-always")).toBeNull(); expect(q("allow-chat")).not.toBeNull();
    expect(q("approval-reason")).toBeNull();
    render(h(C.ApprovalButtons, { id: "u4", host: null, canAlways: false, reason: "This address is a raw IP number rather than a website name, so it always needs your approval.", onDecide: () => {} }), root);
    expect(q("approval-reason")!.textContent).toContain("raw IP number");
    expect(q("approve-once")!.textContent).toBe("Approve"); expect(q("allow-chat")).toBeNull(); expect(q("allow-always")).toBeNull(); expect(q("deny")).not.toBeNull();
    render(null, root);
  });
  test("audit line, composer chip and the allowed-hosts line", async () => {
    const root = document.createElement("div"); document.body.appendChild(root); const q = (t: string) => root.querySelector<HTMLElement>(`[data-testid="${t}"]`);
    render(h(C.AutoLine, { e: { name: "web_read", subject: "example.com", source: "user-grant" } }), root);
    expect(q("auto-allowed")!.textContent).toBe("Auto-allowed web_read example.com - by your setting"); expect(q("auto-allowed")!.getAttribute("data-source")).toBe("user-grant");
    const picked: string[] = [];
    render(h(C.ApprovalChip, { mode: "ask", disabled: false, approvalAuto: true, onPick: (m: string) => picked.push(m) }), root);
    expect(q("approval-chip")!.textContent).toBe("Ask"); q("approval-chip")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(["mode-ask", "mode-auto", "mode-bypass"].map((t) => !!q(t))).toEqual([true, true, true]); expect(q("mode-ask")!.getAttribute("aria-checked")).toBe("true");
    q("mode-bypass")!.click(); expect(picked).toEqual(["bypass"]);
    render(h(C.ApprovalChip, { mode: "bypass", disabled: true, approvalAuto: false, onPick: () => {} }), root);
    expect(q("approval-chip")!.textContent).toBe("Bypass"); expect(q("approval-chip")!.className).toContain("bypass"); expect((q("approval-chip") as HTMLButtonElement).disabled).toBe(true);
    const revoked: string[] = [];
    render(h(C.GrantsLine, { hosts: ["a.test", "b.test"], onRevoke: (x: string) => revoked.push(x) }), root);
    root.querySelectorAll<HTMLElement>('[data-testid="revoke-chat-grant"]')[1]!.click(); expect(revoked).toEqual(["b.test"]);
    expect(root.querySelector('[data-testid="revoke-chat-grant"]')!.getAttribute("aria-label")).toBe("Stop allowing a.test in this chat");
    render(null, root);
  });
});

describe("Settings > Approvals against the real handlers", () => {
  test("lists the user's grants and the audit, Revoke removes one, Revoke all clears the rest; another user's rows never appear", async () => {
    const env = mkEnv(); const m = await makeSession(env, "example-user", "github");
    const MO = scopeFor("main", "open");
    await addGrant(env.DB, MO, "web_read", "news.test"); await addGrant(env.DB, MO, "web_read", "wttr.in"); await addGrant(env.DB, "e2e~open" as any, "web_read", "other-user.test");
    await writeAudit(env.DB, MO, { conversationId: "c1", tool: "web_read", subject: "news.test", source: "user-grant", mode: "ask" });
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
      const headers = new NativeHeaders(); new Headers(init?.headers).forEach((v, k) => headers.set(k, v)); headers.set("cookie", m.cookie.split(";")[0]!); headers.set("origin", "https://app.test");
      return app.fetch(new NativeRequest("https://app.test" + String(u), { ...init, headers }), env);
    }) as typeof fetch;
    await A.getMe().catch(() => {}); (A as any).setCsrf?.(m.session.csrf);
    const root = document.createElement("div"); document.body.appendChild(root); const q = (t: string) => root.querySelector<HTMLElement>(`[data-testid="${t}"]`); const all = (t: string) => [...root.querySelectorAll<HTMLElement>(`[data-testid="${t}"]`)];
    render(h(P.ApprovalsPage, { onBack: () => {} }), root); await until(() => all("approval-grant").length);
    expect(all("approval-grant-host").map((x) => x.textContent)).toEqual(["news.test", "wttr.in"]); expect(root.innerHTML).not.toContain("other-user.test");
    expect(all("approval-audit-row")).toHaveLength(1); expect(q("approval-audit-row")!.textContent).toContain("news.test");
    all("approval-revoke")[0]!.click(); await until(() => all("approval-grant").length === 1); await wait(5);
    expect(all("approval-grant-host").map((x) => x.textContent)).toEqual(["wttr.in"]);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tool_grants WHERE scope=?`).bind(MO).first<{ n: number }>(); expect(row!.n).toBe(1);
    const other = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tool_grants WHERE scope='e2e~open'`).first<{ n: number }>(); expect(other!.n).toBe(1); // untouched
    render(null, root);
  });
});
