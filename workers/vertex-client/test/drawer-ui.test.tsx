// DOM-level tests of the phone drawer (happy-dom + preact): primary list size, collapsible groups, remembered state, team edition,
// Recent grouping / compact rows / Show all. The registrator is installed for this file only and removed afterwards (bun runs every
// test file in one process, so a leaked `document` would change what the other files see).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ConvRow } from "../web/src/api";

type Mod = { DrawerContent: typeof import("../web/src/drawer").DrawerContent; MeCtx: typeof import("../web/src/drawer").MeCtx };
let M: Mod; let render: typeof import("preact").render; let h: typeof import("preact").h; let act: (fn: () => void) => Promise<void>;
let rows: ConvRow[] = [];
let devicesStatus = 404; // what GET /api/devices answers (the "My devices" probe): 404 = feature off
const REAL_FETCH = globalThis.fetch;
const RealDate = Date; // module scope, not a global: nothing of this file may outlive it (test/zz-no-dom-leak.test.ts checks)
const REAL_MATCHMEDIA = (globalThis as { matchMedia?: unknown }).matchMedia;
let NOW = new Date(2026, 9, 23, 15, 0, 0); // Fri 23 Oct 2026, local; tests move it to cross midnight
const at = (daysAgo: number, hour = 9) => new Date(2026, 9, 23 - daysAgo, hour, 0, 0).toISOString();
const mounted: Array<() => void> = [];
const row = (i: number, daysAgo: number, extra: Partial<ConvRow> = {}): ConvRow => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `Chat ${i}`, model: "claude-sonnet-5-5", pinned: 0, costUsd: 0, tokens: 0, projectId: null, createdAt: at(daysAgo), updatedAt: at(daysAgo), ...extra } as ConvRow);

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/chats", width: 390, height: 844 });
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const preact = await import("preact"); render = preact.render; h = preact.h;
  M = (await import("../web/src/drawer")) as Mod;
  act = async (fn) => { fn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
  // Date is read by the component: freeze it so the buckets are deterministic
  class FrozenDate extends RealDate { constructor(...a: unknown[]) { if (a.length === 0) super(NOW.getTime()); else super(...(a as [number])); } static now() { return NOW.getTime(); } }
  (globalThis as { Date: unknown }).Date = FrozenDate;
});
afterAll(() => {
  (globalThis as { Date: unknown }).Date = RealDate;
  globalThis.fetch = REAL_FETCH;
  GlobalRegistrator.unregister();
  if (REAL_MATCHMEDIA === undefined) delete (globalThis as { matchMedia?: unknown }).matchMedia; else (globalThis as { matchMedia?: unknown }).matchMedia = REAL_MATCHMEDIA;
  delete (globalThis as { __RealDate?: unknown }).__RealDate;
});
afterEach(() => { while (mounted.length) mounted.pop()!(); NOW = new Date(2026, 9, 23, 15, 0, 0); }); // unmount clears the midnight timer
beforeEach(() => {
  rows = []; devicesStatus = 404;
  localStorage.clear();
  history.replaceState({}, "", "/chats");
  globalThis.fetch = (async (u: unknown) => String(u).includes("/api/devices") ? new Response("{}", { status: devicesStatus, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ conversations: rows }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
});

type MeLike = { user: string; via: string; csrf: string; defaultModel: string; erichOnly?: boolean; team?: boolean };
const ERICH: MeLike = { user: "erich", via: "sso", csrf: "c", defaultModel: "m", erichOnly: true };
const TEAM: MeLike = { user: "ann@example.com", via: "team", csrf: "c", defaultModel: "m", team: true, erichOnly: false };
async function mount(me: MeLike = ERICH, o: { onSearch?: boolean } = { onSearch: true }) {
  const root = document.createElement("div"); document.body.appendChild(root);
  const went: string[] = [];
  const go = (p: string) => () => { went.push(p); };
  const draw = () => render(h(M.MeCtx.Provider, { value: me as never, children: h(M.DrawerContent, { go, ...(o.onSearch ? { onSearch: () => {} } : {}) }) }), root);
  await act(draw);
  mounted.push(() => render(null, root));
  // preact schedules effects with requestAnimationFrame (or a 100ms timer when the module was loaded before the DOM existed, which depends on test-file order): wait for the Recent skeleton to go away
  for (let i = 0; i < 80 && root.querySelector("[aria-busy]"); i++) await new Promise((r) => setTimeout(r, 25));
  await act(() => {});
  return { root, went, again: async () => { await act(draw); await new Promise((r) => setTimeout(r, 130)); }, /* + preact's 100ms effect fallback */ unmount: () => render(null, root), q: (s: string) => root.querySelector<HTMLElement>(s), qa: (s: string) => [...root.querySelectorAll<HTMLElement>(s)], tid: (t: string) => root.querySelector<HTMLElement>(`[data-testid="${t}"]`), click: (el: Element | null) => act(() => (el as HTMLElement).click()) };
}

describe("drawer: a short primary list, everything else grouped", () => {
  test("Erich: New chat + Search on top; at most 6 primary rows; no flat dump of 15+ items", async () => {
    const d = await mount();
    const top = d.qa(".drawer-top .drow").map((e) => e.dataset.testid);
    expect(top).toEqual(["drawer-new-chat", "menu-search"]);
    const primary = d.qa(".drawer-nav > *");
    expect(primary.length).toBeLessThanOrEqual(6);
    expect(primary.length).toBe(5); // Chats, Library, Projects, Artifacts, Workspaces
    // collapsed groups hold their children back: the visible destination rows stay few
    const visibleDest = d.qa(".drawer-nav .drow");
    expect(visibleDest.length).toBeLessThanOrEqual(5);
    expect(d.tid("menu-mode-cloud")).toBeNull(); expect(d.tid("menu-usage")).toBeNull(); expect(d.tid("menu-theme")).toBeNull();
  });
  test("Computers: a top-level row for Erich (Business) only when the devices probe says 200; not for team, not when the flag is off; highlighted on /devices and /dv/*", async () => {
    const off = await mount(); expect(off.tid("menu-devices")).toBeNull(); expect(off.qa(".drawer-nav > *").length).toBe(5);
    devicesStatus = 200;
    const on = await mount();
    expect(on.qa(".drawer-nav > *").length).toBe(6); // Chats, Library, Projects, Artifacts, Computers, Workspaces
    expect(on.qa(".drawer-nav > *").map((e) => e.dataset.testid).slice(3, 5)).toEqual(["menu-artifacts", "menu-devices"]);
    expect(on.tid("menu-devices")!.textContent).toBe("Computers");
    await on.click(on.tid("menu-devices")); expect(on.went).toEqual(["/computers"]);
    for (const p of ["/computers", "/computers/" + "a".repeat(32), "/devices", "/dv/" + "a".repeat(32)]) { history.replaceState({}, "", p); const m = await mount(); expect(m.tid("menu-devices")!.getAttribute("aria-current"), p).toBe("page"); }
    const team = await mount(TEAM); expect(team.tid("menu-devices")).toBeNull();
  });
  test("Workspaces is collapsed by default (aria-expanded=false) and opens inline on tap; there is no More group", async () => {
    const d = await mount();
    const ws = d.tid("drawer-group-workspaces")!;
    expect(ws.getAttribute("aria-expanded")).toBe("false");
    expect(d.tid("drawer-group-more")).toBeNull();
    await d.click(ws);
    expect(d.tid("drawer-group-workspaces")!.getAttribute("aria-expanded")).toBe("true");
    expect(["menu-mode-agents", "menu-mode-cloud", "menu-mode-desktop", "menu-mode-remote"].every((t) => !!d.tid(t))).toBe(true);
    expect(d.tid("menu-skills")).toBeNull(); // Skills left Workspaces (Settings > App and the palette)
    for (const t of ["menu-usage", "menu-about", "menu-theme", "menu-version"]) expect(d.tid(t), t).toBeNull(); // drawer More group removed
    await d.click(d.tid("drawer-group-workspaces"));
    expect(d.tid("menu-mode-cloud")).toBeNull();
  });
  test("expanded state is remembered per device in localStorage, and restored on the next mount", async () => {
    const a = await mount(); await a.click(a.tid("drawer-group-workspaces"));
    expect(JSON.parse(localStorage.getItem("vc.drawer.sections")!)).toEqual({ workspaces: true });
    a.root.remove();
    const b = await mount();
    expect(b.tid("drawer-group-workspaces")!.getAttribute("aria-expanded")).toBe("true");
    expect(b.tid("menu-mode-cloud")).not.toBeNull();
  });
  test("persisted collapse + deep link: the group of the current screen is open and the item is aria-current=page", async () => {
    localStorage.setItem("vc.drawer.sections", JSON.stringify({ workspaces: false }));
    for (const [path, tid] of [["/cloud", "menu-mode-cloud"], ["/agents", "menu-mode-agents"]] as const) {
      history.replaceState({}, "", path);
      const d = await mount();
      expect(d.tid("drawer-group-workspaces")!.getAttribute("aria-expanded"), path).toBe("true");
      expect(d.tid(tid)!.getAttribute("aria-current"), path).toBe("page");
      d.unmount();
    }
    history.replaceState({}, "", "/skills"); // Skills is no longer a drawer destination: nothing is highlighted and Workspaces is not forced open
    const m = await mount();
    expect(m.tid("drawer-group-workspaces")!.getAttribute("aria-expanded")).toBe("false"); expect(m.qa("[aria-current=page]").length).toBe(0);
  });
  test("collapse after arriving is respected (toggle marked aria-current=true) until the route changes; elsewhere and back opens again; not persisted", async () => {
    history.replaceState({}, "", "/cloud");
    const d = await mount();
    await d.click(d.tid("drawer-group-workspaces"));
    const t = () => d.tid("drawer-group-workspaces")!;
    expect(t().getAttribute("aria-expanded")).toBe("false");
    expect(t().getAttribute("aria-current")).toBe("true"); expect(t().className).toContain("within");
    expect(d.tid("menu-mode-cloud")).toBeNull();
    expect(localStorage.getItem("vc.drawer.sections")).toBeNull(); // a session-local choice
    await d.again(); expect(t().getAttribute("aria-expanded")).toBe("false"); // re-render on the same route: still collapsed
    history.replaceState({}, "", "/library"); await d.again(); // elsewhere: group is not current, remembered state (none, phone) = collapsed
    expect(t().getAttribute("aria-expanded")).toBe("false"); expect(t().getAttribute("aria-current")).toBeNull();
    history.replaceState({}, "", "/cloud"); await d.again(); // and back: opens again
    expect(t().getAttribute("aria-expanded")).toBe("true"); expect(d.tid("menu-mode-cloud")!.getAttribute("aria-current")).toBe("page");
    await d.click(t()); await d.click(t()); // collapse then re-expand on the same route
    expect(t().getAttribute("aria-expanded")).toBe("true");
  });
  test("storage failures never break the drawer (toggle of a non-current group)", async () => {
    const d = await mount();
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("quota"); };
    try { await d.click(d.tid("drawer-group-workspaces")); } finally { Storage.prototype.setItem = real; }
    expect(d.tid("drawer-group-workspaces")!.getAttribute("aria-expanded")).toBe("true"); // still toggles in memory
  });
  test("the current screen is highlighted (aria-current) and a collapsed group that contains it is marked", async () => {
    history.replaceState({}, "", "/library");
    const d = await mount();
    expect(d.tid("menu-library")!.getAttribute("aria-current")).toBe("page");
    expect(d.tid("menu-mode-chat")!.getAttribute("aria-current")).toBeNull();
    localStorage.setItem("vc.drawer.sections", JSON.stringify({ workspaces: false }));
    history.replaceState({}, "", "/agents");
    const e = await mount();
    expect(e.tid("drawer-group-workspaces")!.getAttribute("aria-expanded")).toBe("true"); // the persisted collapse does not hide the current screen
    await e.click(e.tid("drawer-group-workspaces"));
    expect(e.tid("drawer-group-workspaces")!.className).toContain("within");
  });
  test("team edition hides every main-only entry (no Projects/Artifacts/Workspaces), keeps Chats, Library only", async () => {
    const d = await mount(TEAM);
    expect(d.tid("menu-mode-chat")).not.toBeNull(); expect(d.tid("menu-library")).not.toBeNull();
    for (const t of ["menu-projects", "menu-artifacts", "drawer-group-workspaces", "menu-mode-cloud", "menu-skills"]) expect(d.tid(t), t).toBeNull();
    expect(d.tid("drawer-group-more")).toBeNull(); expect(d.tid("menu-usage")).toBeNull();
    expect(d.qa(".drawer-nav > *").length).toBe(2);
  });
  test("Projects stays hidden until the account is erichOnly", async () => {
    const d = await mount({ ...ERICH, erichOnly: false });
    expect(d.tid("menu-projects")).toBeNull(); expect(d.tid("menu-artifacts")).not.toBeNull();
  });
  test("every destination calls go() with its path", async () => {
    localStorage.setItem("vc.drawer.sections", JSON.stringify({ workspaces: true }));
    const calls: Array<[string, boolean | undefined]> = [];
    const root = document.createElement("div"); document.body.appendChild(root);
    await act(() => render(h(M.MeCtx.Provider, { value: ERICH as never, children: h(M.DrawerContent, { go: (p: string, f?: boolean) => () => { calls.push([p, f]); } }) }), root));
    const ids = ["menu-mode-chat", "menu-library", "menu-projects", "menu-artifacts", "menu-mode-agents", "menu-mode-cloud", "menu-mode-desktop", "menu-mode-remote"];
    for (const t of ids) root.querySelector<HTMLElement>(`[data-testid="${t}"]`)!.click();
    expect(calls.map((c) => c[0])).toEqual(["/chats", "/library", "/projects", "/artifacts", "/agents", "/cloud", "/desktop", "/remote"]);
    expect(calls.filter((c) => c[1])).toEqual([]);
  });
  test("the gear is the single Settings entry; the account row is a display-only label (no button, no tab stop, no navigation)", async () => {
    const d = await mount();
    await d.click(d.tid("drawer-avatar"));
    expect(d.went).toEqual([]); // clicking the account label goes nowhere
    const a = d.tid("drawer-avatar")!;
    expect(a.tagName).not.toBe("BUTTON"); expect(a.getAttribute("role")).toBeNull(); expect(a.hasAttribute("tabindex")).toBe(false);
    expect(a.querySelector("button, a, [tabindex]")).toBeNull();
    expect(a.textContent).toContain("erich");
    const gear = d.tid("menu-settings")!;
    expect(gear.getAttribute("aria-label")).toBe("Settings");
    await d.click(gear);
    expect(d.went).toEqual(["/settings"]);
    expect(d.qa(".drawer-foot button, .drawer-foot a").filter((e) => /settings/i.test(e.getAttribute("aria-label") ?? e.textContent ?? "")).length).toBe(1); // one Settings control
  });
});

describe("drawer: Recent list", () => {
  test("rows are grouped Today / Yesterday / Previous 7 days / Older with a labelled group each, in order", async () => {
    rows = [row(1, 0), row(2, 0, { updatedAt: at(0, 11) }), row(3, 1), row(4, 3), row(5, 7), row(6, 8), row(7, 40)];
    const d = await mount();
    const groups = d.qa(".drawer-bucket");
    expect(groups.map((g) => g.dataset.testid)).toEqual(["recent-today", "recent-yesterday", "recent-week", "recent-older"]);
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Today", "Yesterday", "Previous 7 days", "Older"]);
    expect(groups.map((g) => g.querySelectorAll("[data-testid=recent-row]").length)).toEqual([2, 1, 2, 2]);
    expect(d.qa(".drawer-bucket-h").map((e) => e.textContent)).toEqual(["Today", "Yesterday", "Previous 7 days", "Older"]);
  });
  test("empty buckets are not rendered; pinned chats get their own group above and are not repeated in Recent", async () => {
    rows = [row(1, 20, { pinned: 1, title: "Pinned one" }), row(2, 20), row(3, 21)];
    const d = await mount();
    expect(d.qa(".drawer-bucket").map((g) => g.dataset.testid)).toEqual(["recent-older"]);
    expect(d.tid("drawer-pinned")!.querySelectorAll("[data-testid=recent-row]").length).toBe(1);
    expect(d.tid("drawer-recent")!.querySelectorAll("[data-testid=recent-row]").length).toBe(2);
  });
  test("compact rows: single-line ellipsis title (class), no meta line, an accessible Actions button per row", async () => {
    rows = [row(1, 0, { title: "A very long title ".repeat(8) })];
    const d = await mount();
    const r = d.q("[data-testid=recent-row]")!;
    expect(r.classList.contains("drow") && r.classList.contains("conv")).toBe(true);
    expect(r.querySelector(".drow-l")!.classList.contains("ellip")).toBe(true);
    expect(r.children.length).toBe(1); // only the title: no second meta line
    const li = d.q("li[data-testid=chat-item]")!;
    expect(li.classList.contains("c-drawer")).toBe(true);
    expect(li.classList.contains("drawer")).toBe(false); // `.drawer` is the slide-over panel's class: it once blew every row up to ~88px
    expect(d.q("[data-testid=chat-menu-button]")!.getAttribute("aria-label")).toBe(`Actions for ${rows[0].title}`);
    expect(d.q("[data-testid=chat-menu-button]")!.getAttribute("aria-haspopup")).toBe("menu");
  });
  test("shows the first 12, then 'Show all (N)' reveals the rest; the duplicate All chats row is gone", async () => {
    rows = Array.from({ length: 30 }, (_, i) => row(i + 1, 0, { updatedAt: at(0, 14 - Math.floor(i / 3)) }));
    const d = await mount();
    expect(d.qa("[data-testid=recent-row]").length).toBe(12);
    const btn = d.tid("drawer-show-all")!;
    expect(btn.textContent).toContain("Show all (30)");
    await d.click(btn);
    expect(d.qa("[data-testid=recent-row]").length).toBe(30);
    expect(d.tid("drawer-show-all")).toBeNull();
    expect(d.tid("drawer-all-chats")).toBeNull(); // C6: "Chats" (primary) is the one way to the list
  });
  test("12 or fewer chats: no Show all; the current chat is highlighted; loading + empty states", async () => {
    rows = Array.from({ length: 12 }, (_, i) => row(i + 1, 0));
    history.replaceState({}, "", `/c/${rows[3].id}`);
    const d = await mount();
    expect(d.tid("drawer-show-all")).toBeNull();
    const on = d.qa("[data-testid=recent-row][aria-current=page]");
    expect(on.length).toBe(1); expect(on[0].textContent).toContain("Chat 4");
    rows = []; const e = await mount();
    expect(e.root.textContent).toContain("No chats yet.");
  });
  test("failed load shows a note instead of a spinner", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const d = await mount();
    expect(d.root.textContent).toContain("Couldn't load chats.");
  });
});

describe("drawer: bounded Recent, landmarks, midnight", () => {
  test("5000 chats: the first Show all mounts at most 62 rows, every Show more adds 50 (never thousands at once)", async () => {
    rows = Array.from({ length: 5000 }, (_, i) => row(i + 1, 0, { updatedAt: at(0, 14) }));
    const d = await mount();
    const n = () => d.qa("[data-testid=recent-row]").length;
    expect(n()).toBe(12);
    await d.click(d.tid("drawer-show-all")); expect(n()).toBe(62);
    expect(d.tid("drawer-show-all")!.textContent).toContain("Show more (4938)");
    await d.click(d.tid("drawer-show-all")); expect(n()).toBe(112);
    await d.click(d.tid("drawer-show-all")); expect(n()).toBe(162);
    expect(d.tid("drawer-all-chats")).toBeNull();
  });
  test("the paging button disappears when everything is shown", async () => {
    rows = Array.from({ length: 70 }, (_, i) => row(i + 1, 0));
    const d = await mount();
    await d.click(d.tid("drawer-show-all")); expect(d.qa("[data-testid=recent-row]").length).toBe(62);
    await d.click(d.tid("drawer-show-all")); expect(d.qa("[data-testid=recent-row]").length).toBe(70);
    expect(d.tid("drawer-show-all")).toBeNull();
  });
  test("one labelled nav landmark (Main) holds the primary list; the removed More landmark is gone", async () => {
    const d = await mount();
    expect(d.qa("nav").map((n) => n.getAttribute("aria-label"))).toEqual(["Main"]);
    expect(d.qa("nav")[0].querySelector('[data-testid="menu-mode-chat"]')).not.toBeNull();
    expect(d.tid("drawer-more-nav")).toBeNull();
    expect(d.qa(".drawer-nav > *").length).toBeLessThanOrEqual(6);
  });
  test("midnight: a timer is armed for the next local midnight, re-buckets rows when it fires, re-arms, and unmount clears it", async () => {
    rows = [row(1, 0, { title: "Today chat", updatedAt: at(0, 9) })];
    const armed: Array<{ fn: () => void; ms: number; id: unknown }> = []; const cleared: unknown[] = [];
    const st = globalThis.setTimeout, ct = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => { const id = st(fn, ms, ...a); if ((ms ?? 0) > 3600e3) armed.push({ fn, ms: ms!, id }); return id; }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: unknown) => { cleared.push(id); return ct(id as never); }) as typeof clearTimeout;
    let d: Awaited<ReturnType<typeof mount>>;
    try {
      d = await mount();
      expect(armed.length).toBe(1);
      expect(armed[0].ms).toBe(9 * 3600e3 + 1000); // 15:00 -> next midnight + 1s
      expect(d.qa(".drawer-bucket").map((g) => g.dataset.testid)).toEqual(["recent-today"]);
      NOW = new Date(2026, 9, 24, 0, 0, 1); // the clock passes midnight
      await act(() => armed[0].fn());
      expect(d.qa(".drawer-bucket").map((g) => g.dataset.testid)).toEqual(["recent-yesterday"]); // same chat, now yesterday
      expect(armed.length).toBe(2); expect(armed[1].ms).toBe(24 * 3600e3); // re-armed for the following midnight
      await act(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); NOW = new Date(2026, 9, 26, 10); document.dispatchEvent(new Event("visibilitychange")); });
      expect(d.qa(".drawer-bucket").map((g) => g.dataset.testid)).toEqual(["recent-week"]); // coming back to the foreground re-evaluates too
      const live = armed[armed.length - 1].id;
      d.unmount();
      expect(cleared).toContain(live);
      NOW = new Date(2026, 9, 30, 10); await act(() => document.dispatchEvent(new Event("visibilitychange"))); // listener removed: nothing throws / re-renders
    } finally { globalThis.setTimeout = st; globalThis.clearTimeout = ct; }
  });
});


describe("menu2-fix1: pin / rename done elsewhere reaches the sidebar copy (vc:conv-edit)", () => {
  test("an edit published by the chat header moves the matching row only, in both directions", async () => {
    rows = [row(1, 20, { title: "One" }), row(2, 20, { title: "Two" })];
    const d = await mount();
    const { publishConvEdit } = await import("../web/src/chat-menu");
    const pinnedTitles = () => d.tid("drawer-pinned") ? [...d.tid("drawer-pinned")!.querySelectorAll("[data-testid=recent-row]")].map((e) => e.textContent) : [];
    expect(pinnedTitles()).toEqual([]);
    await act(() => publishConvEdit({ id: rows[0].id, pinned: true }));
    expect(pinnedTitles()).toEqual(["One"]); // pinned from the header: the sidebar now lists it under Pinned
    await d.click(d.tid("drawer-pinned")!.querySelector("[data-testid=chat-menu-button]"));
    expect(d.root.ownerDocument.querySelector("[data-testid=chat-menu-pin]")!.textContent).toBe("Unpin"); // and its menu offers Unpin
    await act(() => (document.querySelector("[data-testid=chat-menu-root] .cmenu-scrim") as HTMLElement).click());
    await act(() => publishConvEdit({ id: rows[0].id, pinned: false }));
    expect(pinnedTitles()).toEqual([]); // unpinned from the header: back in Recent
    await act(() => publishConvEdit({ id: "00000000-0000-4000-8000-999999999999", pinned: true }));
    expect(pinnedTitles()).toEqual([]); // an unknown id changes nothing
    await act(() => publishConvEdit({ id: rows[1].id, title: "Renamed" }));
    expect(d.qa("[data-testid=recent-row]").map((e) => e.textContent)).toEqual(["One", "Renamed"]);
  });
  test("pinning from a sidebar row's menu publishes the edit the open chat listens for", async () => {
    rows = [row(1, 20, { title: "One" })];
    const d = await mount();
    const { onConvEdit } = await import("../web/src/chat-menu");
    const seen: unknown[] = []; const off = onConvEdit((e) => seen.push(e));
    try {
      await d.click(d.tid("chat-menu-button"));
      await d.click(document.querySelector("[data-testid=chat-menu-pin]"));
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toEqual([{ id: rows[0].id, pinned: true }]);
    } finally { off(); }
  });
});

describe("menu3: everything the drawer's More group held (and Skills) is still reachable", () => {
  const once = async (c: unknown, fetcher?: typeof fetch) => {
    if (fetcher) globalThis.fetch = fetcher;
    const root = document.createElement("div"); document.body.appendChild(root);
    await act(() => render(c as never, root)); await new Promise((r) => setTimeout(r, 150)); await act(() => {});
    mounted.push(() => render(null, root));
    return root;
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  test("phone Settings: Usage & costs, Skills, Theme (segmented), Version/About each have a control; team keeps Usage + About but no Skills", async () => {
    const S = await import("../web/src/settings");
    const ask = async (me: MeLike) => {
      const root = await once(h(M.MeCtx.Provider, { value: me as never, children: h(S.Settings, { me: me as never, onBack() {}, onSignOut() {} }) }), (async () => json({ models: [], default: "" })) as unknown as typeof fetch);
      const q = (t: string) => root.querySelector(`[data-testid="${t}"]`);
      const r = { usage: !!q("open-usage"), skills: !!q("open-skills"), theme: !!q("theme-setting") && !!q("theme-dark"), about: !!q("open-about") && !!q("app-version"), aboutI: !!q("settings-about") };
      render(null, root); return r;
    };
    expect(await ask(ERICH)).toEqual({ usage: true, skills: true, theme: true, about: true, aboutI: true });
    expect(await ask(TEAM)).toEqual({ usage: true, skills: false, theme: true, about: true, aboutI: true });
  });
  test("desktop Settings modal nav: Skills + Usage panes (Erich) and Usage (team); General keeps Theme and Version", async () => {
    const D = await import("../web/src/desk-logic");
    const labels = (me: object) => D.settingsPanes(me as never, "biz", false, false).map((p) => p.label);
    expect(labels(ERICH)).toEqual(expect.arrayContaining(["Skills", "Usage"]));
    expect(labels(TEAM)).toContain("Usage");
    expect(labels(TEAM)).not.toContain("Skills");
  });
  test("palette: Usage, About, Skills and Toggle theme are listed", async () => {
    const P = await import("../web/src/palette-logic");
    const paths = P.navItems(true).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["/usage", "/about", "/skills"]));
    expect(P.navItems(false).map((i) => i.path)).toEqual(expect.arrayContaining(["/usage", "/about"])); // team / non-Erich keep Usage + About
    expect(P.buildItems("theme", { chats: [], artifacts: [], erichOnly: true }).some((i) => i.label === "Toggle theme")).toBe(true);
  });
  test("Devices probe retries when the Settings modal is reopened after a transient 503 (and does not probe while closed)", async () => {
    const A = await import("../web/src/devices-available");
    let status = 503; let calls = 0;
    globalThis.fetch = (async () => { calls++; return status === 200 ? json({ devices: [] }) : json({ error: "x" }, status); }) as unknown as typeof fetch;
    let setOpen: (v: boolean) => void = () => {};
    const { useState } = await import("preact/hooks");
    const Probe = () => { const [open, s] = useState(false); setOpen = s; return h("span", { "data-testid": "dev" }, String(A.useDevicesAvailable(open))); };
    const root = await once(h(Probe, {}));
    const shown = () => root.querySelector('[data-testid="dev"]')!.textContent;
    expect(calls).toBe(0); expect(shown()).toBe("false"); // closed: no probe
    await act(() => setOpen(true)); await new Promise((r) => setTimeout(r, 150)); await act(() => {});
    expect(calls).toBe(1); expect(shown()).toBe("false"); // startup 503
    await act(() => setOpen(false)); await new Promise((r) => setTimeout(r, 150)); await act(() => {});
    status = 200;
    await act(() => setOpen(true)); await new Promise((r) => setTimeout(r, 150)); await act(() => {});
    expect(calls).toBe(2); expect(shown()).toBe("true"); // reopened after recovery: Devices shows
  });
  test("desk.tsx gates the probe on the Settings modal being open", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("../web/src/desk.tsx", import.meta.url), "utf8")).toMatch(/useDevicesAvailable\(!!place\.modal && /);
  });
});
