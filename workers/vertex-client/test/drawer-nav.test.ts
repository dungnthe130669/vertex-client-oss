import { describe, expect, test } from "bun:test";
import { BUCKET_LABEL, RECENT_PREVIEW, SECTIONS_KEY, bucketOf, drawerNav, groupByBucket, groupOf, groupOpen, loadSections, msUntilMidnight, nextLimit, previewRows, primaryCount, RECENT_PAGE, saveSections } from "../web/src/drawer-nav";

const NOW = new Date(2026, 9, 23, 15, 0, 0); // Fri 23 Oct 2026 15:00 local
const at = (daysAgo: number, h = 9, m = 0) => new Date(2026, 9, 23 - daysAgo, h, m, 0).toISOString();
const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe("drawerNav", () => {
  test("Erich: 5 primary rows (a group counts as one), never more than 6, no More group (Usage/About/Theme live in Settings)", () => {
    const n = drawerNav({ erichOnly: true });
    expect(primaryCount(n)).toBe(5);
    expect(n.primary.map((e) => (e.kind === "item" ? e.key : e.id))).toEqual(["chat", "library", "projects", "artifacts", "workspaces"]);
    expect("more" in n).toBe(false);
    const all = n.primary.flatMap((e) => (e.kind === "item" ? [e.key] : e.items.map((i) => i.key)));
    expect(all).toEqual(["chat", "library", "projects", "artifacts", "agents", "cloud", "desktop", "remote"]); // Usage/About/Skills moved to Settings + palette (menu3)
    expect(all).not.toContain("skills"); expect(all).not.toContain("usage"); expect(all).not.toContain("about");
  });
  test("Computers: only for Erich in Business with the devices probe on, between Artifacts and Workspaces; Remote/Desktop/Cloud/Agents untouched", () => {
    const keys = (n: ReturnType<typeof drawerNav>) => n.primary.map((e) => (e.kind === "item" ? e.key : e.id));
    expect(keys(drawerNav({ erichOnly: true }))).not.toContain("devices"); // probe off (default)
    expect(keys(drawerNav({ erichOnly: true }, "biz", true))).toEqual(["chat", "library", "projects", "artifacts", "devices", "workspaces"]);
    expect(keys(drawerNav({ erichOnly: true }, "open", true))).not.toContain("devices"); // Business-only, like the screens
    expect(keys(drawerNav({ team: true, erichOnly: true }, "biz", true))).toEqual(["chat", "library"]);
    expect(keys(drawerNav({ erichOnly: false }, "biz", true))).not.toContain("devices"); // a non-Erich main account never gets the Devices screens
    expect(keys(drawerNav(null, "biz", true))).not.toContain("devices");
    const d = drawerNav({ erichOnly: true }, "biz", true).primary.find((e) => e.kind === "item" && e.key === "devices")!;
    expect(d.kind === "item" && [d.label, d.path, d.tid]).toEqual(["Computers", "/computers", "menu-devices"]);
    const ws = drawerNav({ erichOnly: true }, "biz", true).primary.find((e) => e.kind === "group")!;
    expect(ws.kind === "group" && ws.items.map((i) => i.key)).toEqual(["agents", "cloud", "desktop", "remote"]);
  });
  test("team edition: only chat, library ; no More group; no main-only entries", () => {
    const n = drawerNav({ team: true, erichOnly: false });
    expect(n.primary.map((e) => e.kind === "item" && e.key)).toEqual(["chat", "library"]);
    expect("more" in n).toBe(false);
  });
  test("a signed-in non-Erich main account sees Artifacts + Workspaces but no Projects; unknown me = the same", () => {
    expect(drawerNav({ erichOnly: false }).primary.map((e) => (e.kind === "item" ? e.key : e.id))).toEqual(["chat", "library", "artifacts", "workspaces"]);
    expect(drawerNav(null).primary.some((e) => e.kind === "item" && e.key === "projects")).toBe(false);
  });
  test("test ids stay stable (e2e hooks) and Skills is no longer a Workspaces item", () => {
    const n = drawerNav({ erichOnly: true });
    const ws = n.primary.find((e) => e.kind === "group")!;
    expect(ws.kind === "group" && ws.items.map((i) => i.tid)).toEqual(["menu-mode-agents", "menu-mode-cloud", "menu-mode-desktop", "menu-mode-remote"]);
  });
  test("groupOf finds the group of a destination", () => {
    const n = drawerNav({ erichOnly: true });
    expect(groupOf(n, "cloud")).toBe("workspaces"); expect(groupOf(n, "usage")).toBeNull(); expect(groupOf(n, "skills")).toBeNull(); expect(groupOf(n, "chat")).toBeNull(); expect(groupOf(n, null)).toBeNull();
  });
});

describe("sections state", () => {
  test("round-trips through storage, ignores junk, never throws", () => {
    const s = mem();
    expect(loadSections(s)).toEqual({});
    expect(saveSections({ workspaces: true }, s)).toBe(true);
    expect(JSON.parse(s.m.get(SECTIONS_KEY)!)).toEqual({ workspaces: true });
    expect(loadSections(s)).toEqual({ workspaces: true });
    s.m.set(SECTIONS_KEY, "{not json"); expect(loadSections(s)).toEqual({});
    s.m.set(SECTIONS_KEY, JSON.stringify({ workspaces: "yes", more: true, evil: true })); expect(loadSections(s)).toEqual({}); // a stale "more" key from before menu3 is ignored
    s.m.set(SECTIONS_KEY, "null"); expect(loadSections(s)).toEqual({});
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
    expect(loadSections(broken)).toEqual({}); expect(saveSections({ workspaces: true }, broken)).toBe(false);
    expect(loadSections(null)).toEqual({}); expect(saveSections({}, null)).toBe(false);
  });
  test("groupOpen: the current screen's group is open whatever was persisted; a post-arrival collapse (dismissed) wins; other groups follow the remembered choice, else roomy", () => {
    expect(groupOpen({}, "workspaces", false, false)).toBe(false);
    expect(groupOpen({}, "workspaces", true, false)).toBe(true);
    expect(groupOpen({}, "workspaces", false, true)).toBe(true);
    expect(groupOpen({ workspaces: false }, "workspaces", true, true)).toBe(true); // persisted collapse + deep link: open (was false: the route was hidden)
    expect(groupOpen({ workspaces: false }, "workspaces", true, false)).toBe(true);
    expect(groupOpen({ workspaces: false }, "workspaces", true, false, true)).toBe(false); // user collapsed it after arriving
    expect(groupOpen({ workspaces: false }, "workspaces", false, true)).toBe(false); // explicit choice beats roomy
    expect(groupOpen({ workspaces: true }, "workspaces", false, false)).toBe(true);
    expect(groupOpen({ workspaces: true }, "workspaces", false, false, true)).toBe(true); // dismissed only concerns the current group
  });
});

describe("Recent buckets (fixed clock: Fri 23 Oct 2026 15:00)", () => {
  test("calendar-day boundaries", () => {
    expect(bucketOf(at(0, 0, 0), NOW)).toBe("today");
    expect(bucketOf(at(0, 23, 59), NOW)).toBe("today");
    expect(bucketOf(at(1, 23, 59), NOW)).toBe("yesterday");
    expect(bucketOf(at(1, 0, 0), NOW)).toBe("yesterday");
    expect(bucketOf(at(2, 23, 59), NOW)).toBe("week");
    expect(bucketOf(at(7, 0, 0), NOW)).toBe("week");
    expect(bucketOf(at(8, 23, 59), NOW)).toBe("older");
    expect(bucketOf(at(365), NOW)).toBe("older");
  });
  test("a few hours ago across midnight is yesterday, not today (it is the calendar day, not 24h)", () => {
    const early = new Date(2026, 9, 23, 0, 30);
    expect(bucketOf(new Date(2026, 9, 22, 23, 50).toISOString(), early)).toBe("yesterday");
  });
  test("future timestamps are today; unparseable ones are Older", () => {
    expect(bucketOf(new Date(2026, 9, 25).toISOString(), NOW)).toBe("today");
    expect(bucketOf("garbage", NOW)).toBe("older"); expect(bucketOf("", NOW)).toBe("older"); // unparseable: Older, not Today
  });
  test("DST change does not shift a bucket (calendar days, not 24h multiples)", () => {
    const now = new Date(2026, 10, 2, 12); // after the EU/US autumn change
    expect(bucketOf(new Date(2026, 9, 26, 12).toISOString(), now)).toBe("week"); // 7 calendar days earlier
    expect(bucketOf(new Date(2026, 9, 25, 12).toISOString(), now)).toBe("older");
  });
  test("groupByBucket keeps order, skips empty buckets, labels", () => {
    const rows = [{ id: "a", updatedAt: at(0) }, { id: "b", updatedAt: at(0, 8) }, { id: "c", updatedAt: at(2) }, { id: "d", updatedAt: at(30) }];
    const g = groupByBucket(rows, NOW);
    expect(g.map((x) => x.bucket)).toEqual(["today", "week", "older"]);
    expect(g.map((x) => x.label)).toEqual([BUCKET_LABEL.today, BUCKET_LABEL.week, BUCKET_LABEL.older]);
    expect(g[0].rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(groupByBucket([], NOW)).toEqual([]);
  });
  test("groupByBucket is canonical: one group per label in the fixed order, for unsorted input and invalid dates", () => {
    const rows = [{ id: "old", updatedAt: at(30) }, { id: "t1", updatedAt: at(0) }, { id: "bad", updatedAt: "not a date" }, { id: "y", updatedAt: at(1) }, { id: "t2", updatedAt: at(0, 8) }, { id: "old2", updatedAt: at(99) }];
    const g = groupByBucket(rows, NOW);
    expect(g.map((x) => x.label)).toEqual(["Today", "Yesterday", "Older"]);
    expect(new Set(g.map((x) => x.bucket)).size).toBe(g.length); // unique keys
    expect(g[0].rows.map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(g[2].rows.map((r) => r.id)).toEqual(["old", "bad", "old2"]); // invalid is Older, in input order
    const g2 = groupByBucket([{ id: "t", updatedAt: at(0) }, { id: "y", updatedAt: at(1) }, { id: "bad", updatedAt: "garbage" }], NOW);
    expect(g2.map((x) => x.bucket)).toEqual(["today", "yesterday", "older"]); // garbage is NOT merged into the adjacent Yesterday/Today
  });
  test("msUntilMidnight: to the next local midnight (+1s); correct across the day boundary", () => {
    expect(msUntilMidnight(new Date(2026, 9, 23, 15, 0, 0))).toBe(9 * 3600e3 + 1000);
    expect(msUntilMidnight(new Date(2026, 9, 23, 23, 59, 59))).toBe(2000);
    expect(msUntilMidnight(new Date(2026, 9, 23, 0, 0, 0))).toBe(24 * 3600e3 + 1000);
  });
  test("paging: 12 first, the first expansion shows 62, then +50 per step", () => {
    expect(nextLimit(RECENT_PREVIEW)).toBe(62); expect(nextLimit(62)).toBe(112); expect(RECENT_PAGE).toBe(50);
  });
  test("previewRows: first 12 until Show all", () => {
    const r = Array.from({ length: 20 }, (_, i) => i);
    expect(RECENT_PREVIEW).toBe(12);
    expect(previewRows(r)).toEqual(r.slice(0, 12)); expect(previewRows(r, 62)).toEqual(r); expect(previewRows([1])).toEqual([1]);
  });
});
