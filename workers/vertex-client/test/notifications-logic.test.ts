// Notifications center client logic: merge, "new since last poll", badge/labels, time, socket-frame validation. No DOM.
import { describe, expect, test } from "bun:test";
import { badgeText, bellLabel, freshFrom, mergeNotifs, parseNotif, timeAgo, type Notif } from "../web/src/notif-logic";

const n = (id: string, ts: number, read = false): Notif => ({ id, ts, kind: "turn", title: id, body: "b", url: "/c/x", read });
describe("notif logic", () => {
  test("mergeNotifs: newest first, de-duplicated, incoming (server truth) wins, capped at 200", () => {
    expect(mergeNotifs([n("a", 1), n("b", 2)], [n("a", 1, true), n("c", 3)]).map((x) => `${x.id}${x.read ? "*" : ""}`)).toEqual(["c", "b", "a*"]);
    expect(mergeNotifs([], Array.from({ length: 250 }, (_, i) => n(`i${i}`, i))).length).toBe(200);
  });
  test("freshFrom: unread rows not seen before, oldest first; read or seen rows never toast", () => {
    expect(freshFrom([n("a", 3), n("b", 1), n("c", 2, true), n("d", 4)], new Set(["d"])).map((x) => x.id)).toEqual(["b", "a"]);
  });
  test("badge and label: hidden at 0, capped at 99+, count in the accessible name", () => {
    expect(badgeText(0)).toBe(""); expect(badgeText(7)).toBe("7"); expect(badgeText(100)).toBe("99+");
    expect(bellLabel(0)).toBe("Notifications"); expect(bellLabel(3)).toBe("Notifications, 3 unread");
  });
  test("timeAgo", () => {
    const now = 10_000_000_000;
    expect(timeAgo(now - 5_000, now)).toBe("just now"); expect(timeAgo(now - 120_000, now)).toBe("2 min ago");
    expect(timeAgo(now - 3 * 3600_000, now)).toBe("3 h ago"); expect(timeAgo(now - 2 * 86400_000, now)).toBe("2 d ago");
  });
  test("parseNotif: well-formed row only; off-site or protocol-relative urls rejected", () => {
    expect(parseNotif({ id: "a", ts: 1, kind: "turn", title: "t", body: "b", url: "/c/1", read: false })?.id).toBe("a");
    for (const bad of [null, 1, {}, { id: "a", ts: "1", title: "t", body: "b", url: "/" }, { id: "a", ts: 1, title: "t", body: "b", url: "https://x.y" }, { id: "a", ts: 1, title: "t", body: "b", url: "//x.y" }]) expect(parseNotif(bad)).toBeNull();
  });
});
