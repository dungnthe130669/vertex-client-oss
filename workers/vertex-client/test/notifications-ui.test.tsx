// Notifications center UI (happy-dom + preact): bell + badge, top toast (live frame + poll), auto-hide, tap = open + mark read, history page.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let render: typeof import("preact").render; let h: typeof import("preact").h;
let UI: typeof import("../web/src/notifications"); let S: typeof import("../web/src/notif-store");
const REAL_FETCH = globalThis.fetch;
const REAL_MATCHMEDIA = (globalThis as { matchMedia?: unknown }).matchMedia;
let server: { items: any[]; unread: number; next?: string | null }; let gate: Promise<void> | null = null; let calls: Array<{ url: string; method: string; body: any }>;
const row = (id: string, ts: number, read = false) => ({ id, ts, kind: "turn", title: `T-${id}`, body: `B-${id}`, url: `/c/${id}`, read });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const mounted: Array<() => void> = [];

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/notifications", width: 390, height: 844 });
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const p = await import("preact"); render = p.render; h = p.h;
  UI = await import("../web/src/notifications"); S = await import("../web/src/notif-store");
});
afterAll(() => { globalThis.fetch = REAL_FETCH; GlobalRegistrator.unregister(); if (REAL_MATCHMEDIA === undefined) delete (globalThis as { matchMedia?: unknown }).matchMedia; else (globalThis as { matchMedia?: unknown }).matchMedia = REAL_MATCHMEDIA; });
beforeEach(() => {
  gate = null; S.resetNotifs(); server = { items: [], unread: 0 }; calls = []; history.replaceState({}, "", "/notifications");
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null; calls.push({ url: String(url), method: init.method ?? "GET", body });
    if ((init.method ?? "GET") === "GET") { const snap = JSON.stringify({ items: server.items, next: server.next ?? null, unread: server.unread }); if (gate) await gate; return new Response(snap, { status: 200 }); }
    if (false) return new Response(JSON.stringify({ items: server.items, next: server.next ?? null, unread: server.unread }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => { while (mounted.length) mounted.pop()!(); });
const mount = async (node: any) => { const root = document.createElement("div"); document.body.appendChild(root); render(node, root); mounted.push(() => { render(null, root); root.remove(); }); await settle(); return root; };
const tid = (r: Element, t: string) => r.querySelector<HTMLElement>(`[data-testid="${t}"]`);
const tids = (r: Element, t: string) => [...r.querySelectorAll<HTMLElement>(`[data-testid="${t}"]`)];

describe("bell", () => {
  test("no badge at 0; count after a live frame, in the visible badge and the accessible name; 99+ cap", async () => {
    const r = await mount(h(UI.Bell as any, {}));
    expect(tid(r, "notif-badge")).toBeNull(); expect(tid(r, "notif-bell")!.getAttribute("aria-label")).toBe("Notifications");
    S.ingest(row("a", 1)); await settle();
    expect(tid(r, "notif-badge")!.textContent).toBe("1"); expect(tid(r, "notif-bell")!.getAttribute("aria-label")).toBe("Notifications, 1 unread");
    for (let i = 0; i < 120; i++) S.ingest(row(`x${i}`, 10 + i)); await settle();
    expect(tid(r, "notif-badge")!.textContent).toBe("99+");
  });
  test("click opens /notifications", async () => {
    history.replaceState({}, "", "/chats");
    const r = await mount(h(UI.Bell as any, {})); tid(r, "notif-bell")!.click(); await settle();
    expect(location.pathname).toBe("/notifications");
  });
});

describe("toast", () => {
  test("a live frame shows a top toast (polite live region), a duplicate does not repeat, tap opens the url and marks it read", async () => {
    const r = await mount(h(UI.NotifToasts, {}));
    expect(tid(r, "notif-toasts")!.getAttribute("aria-live")).toBe("polite");
    S.ingest(row("a", 1)); S.ingest(row("a", 1)); await settle();
    expect(tids(r, "notif-toast").length).toBe(1); expect(tid(r, "notif-toast")!.textContent).toContain("T-a");
    tid(r, "notif-toast")!.querySelector<HTMLElement>(".ntoast-main")!.click(); await settle();
    expect(location.pathname).toBe("/c/a"); expect(tids(r, "notif-toast").length).toBe(0);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ ids: ["a"] }); expect(S.getState().unread).toBe(0);
  });
  test("auto-hides after ~5 s", async () => {
    const real = globalThis.setTimeout; const timers: Array<[() => void, number]> = [];
    (globalThis as any).setTimeout = (f: () => void, ms?: number) => { if (ms === 5000) { timers.push([f, ms]); return 0 as any; } return real(f, ms); };
    try {
      const r = await mount(h(UI.NotifToasts, {})); S.ingest(row("a", 1)); await settle();
      expect(tids(r, "notif-toast").length).toBe(1); expect(timers.length).toBe(1);
      timers[0][0](); await settle(); expect(tids(r, "notif-toast").length).toBe(0); expect(S.getState().unread).toBe(1); // hiding does not mark read
    } finally { (globalThis as any).setTimeout = real; }
  });
  test("at most 3 stacked; dismiss button removes one", async () => {
    const r = await mount(h(UI.NotifToasts, {}));
    for (const i of [1, 2, 3, 4]) S.ingest(row(`t${i}`, i)); await settle();
    expect(tids(r, "notif-toast").length).toBe(3);
    r.querySelector<HTMLElement>(".ntoast .x")!.click(); await settle(); expect(tids(r, "notif-toast").length).toBe(2);
  });
  test("poll: the first load adopts history silently; a later poll toasts only the new unread row", async () => {
    const r = await mount(h(UI.NotifToasts, {}));
    server = { items: [row("old", 1)], unread: 1 }; await S.refresh(); await settle();
    expect(tids(r, "notif-toast").length).toBe(0); expect(S.getState().unread).toBe(1);
    server = { items: [row("new", 5), row("old", 1)], unread: 2 }; await S.refresh(); await settle();
    expect(tids(r, "notif-toast").map((t) => t.textContent)).toEqual([expect.stringContaining("T-new")]); expect(S.getState().unread).toBe(2);
  });
});

describe("history page", () => {
  test("empty state", async () => {
    const r = await mount(h(UI.NotificationsPage, {})); await settle();
    expect(tid(r, "notif-empty")).not.toBeNull(); expect(tid(r, "notif-mark-all")!.hasAttribute("disabled")).toBe(true);
  });
  test("newest first, unread highlighted + announced, tap opens + marks read, mark all read", async () => {
    server = { items: [row("b", 20), row("a", 10, true)], unread: 1 };
    const r = await mount(h(UI.NotificationsPage, {})); await settle();
    const rows = tids(r, "notif-row");
    expect(rows.map((x) => x.textContent!.includes("T-b"))).toEqual([true, false]);
    expect(rows.map((x) => x.dataset.unread)).toEqual(["1", "0"]); expect(rows[0].textContent).toContain("(unread)");
    tid(r, "notif-mark-all")!.click(); await settle();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ all: true });
    expect(tids(r, "notif-row").every((x) => x.dataset.unread === "0")).toBe(true); expect(S.getState().unread).toBe(0);
    tids(r, "notif-row")[1].click(); await settle(); expect(location.pathname).toBe("/c/a");
  });
});

describe("poll races", () => {
  test("a poll that started before a live frame does not overwrite the newer unread count", async () => {
    server = { items: [], unread: 0 }; await S.refresh();                       // loaded, empty
    let release!: () => void; gate = new Promise<void>((r) => { release = r; });
    const p = S.refresh();                                                      // snapshot says unread 0
    await settle(); S.ingest(row("live", 50));                                  // live frame arrives meanwhile
    gate = null; release(); await p; await settle();
    expect(S.getState().unread).toBe(1); expect(S.getState().items.map((n) => n.id)).toEqual(["live"]);
  });
  test("polling does not rewind 'Show older': the history cursor only advances through loadMore()", async () => {
    server = { items: [row("a", 30)], unread: 1, next: "30~a" }; await S.refresh();
    expect(S.getState().next).toBe("30~a");
    server = { items: [row("b", 20)], unread: 1, next: "20~b" }; await S.loadMore();
    expect(S.getState().next).toBe("20~b");
    server = { items: [row("a", 30)], unread: 1, next: "30~a" }; await S.refresh(); // 60 s poll: head page again
    expect(S.getState().next).toBe("20~b");
    const more = calls.filter((c) => c.url.includes("before=")); expect(more.length).toBe(1); expect(decodeURIComponent(more[0].url)).toContain("before=30~a");
    server = { items: [row("c", 10)], unread: 1, next: null }; await S.loadMore();
    expect(decodeURIComponent(calls.filter((c) => c.url.includes("before=")).at(-1)!.url)).toContain("before=20~b"); expect(S.getState().next).toBeNull();
  });
});
