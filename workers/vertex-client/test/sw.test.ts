import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-expect-error plain mjs
import { PLACEHOLDER, buildId, gitCommit, precacheAssets, stampSw, versionInfo } from "../scripts/sw-version.mjs";

const SRC = readFileSync(new URL("../web/public/sw.js", import.meta.url), "utf8");
const enc = (s: string) => new TextEncoder().encode(s);

describe("buildId", () => {
  const a = [{ name: "a.js", bytes: enc("1") }, { name: "b.css", bytes: enc("2") }];
  test("deterministic, 12 hex, order-independent", () => {
    expect(buildId(a)).toMatch(/^[0-9a-f]{12}$/);
    expect(buildId(a)).toBe(buildId([...a].reverse()));
  });
  test("changes with content or name", () => {
    expect(buildId(a)).not.toBe(buildId([a[0], { name: "b.css", bytes: enc("3") }]));
    expect(buildId(a)).not.toBe(buildId([a[0], { name: "c.css", bytes: enc("2") }]));
  });
  test("name/bytes boundary is unambiguous", () => {
    expect(buildId([{ name: "ab", bytes: enc("c") }])).not.toBe(buildId([{ name: "a", bytes: enc("bc") }]));
  });
});

describe("stampSw", () => {
  test("stamps placeholder; source has one", () => {
    expect(SRC).toContain(`"${PLACEHOLDER}"`);
    const out = stampSw(SRC, "abcdef012345");
    expect(out).not.toContain(PLACEHOLDER);
    expect(out).toContain('const BUILD = "abcdef012345"');
  });
  test("throws on missing placeholder / bad id", () => {
    expect(() => stampSw("nothing", "abcdef012345")).toThrow();
    expect(() => stampSw(SRC, "nope")).toThrow();
  });
});

// Run the real sw.js against a fake ServiceWorkerGlobalScope.
function boot(id: string, existing: string[] = [], assets: string[] = []) {
  const handlers: Record<string, (e: any) => void> = {};
  const store = new Map<string, Map<string, string>>(existing.map((n) => [n, new Map()]));
  const shown: any[] = [];
  const opened: string[] = [];
  const focused: any[] = [];
  const modes: string[] = [];
  let skipped = false;
  let clientList: any[] = [];
  const self: any = {
    location: { origin: "https://app.test" },
    addEventListener: (t: string, f: any) => { handlers[t] = f; },
    skipWaiting: () => { skipped = true; },
    clients: { claim: async () => {}, matchAll: async () => clientList, openWindow: async (u: string) => { opened.push(u); } },
    registration: { showNotification: async (t: string, o: any) => { shown.push([t, o]); } },
  };
  const caches = {
    keys: async () => [...store.keys()],
    delete: async (k: string) => store.delete(k),
    open: async (k: string) => {
      if (!store.has(k)) store.set(k, new Map());
      const m = store.get(k)!;
      return {
        addAll: async (reqs: (string | Request)[]) => { for (const r of reqs) { if (typeof r !== "string") modes.push(r.cache); const u = typeof r === "string" ? r : new URL(r.url, "https://app.test").pathname; m.set(u, u === "/" ? '<script src="/assets/x-1.js"></script>' : "x"); } },
        match: async (u: string) => (m.has(u) ? { text: async () => m.get(u)! } : undefined),
        put: async () => {},
      };
    },
    match: async () => undefined,
  };
  class Req extends Request { constructor(u: string, i?: RequestInit) { super(new URL(u, "https://app.test"), i); } } // sw scope resolves relative urls
  new Function("self", "caches", "URL", "fetch", "Request", stampSw(SRC, id, {}, assets))(self, caches, URL, async () => new Response("net"), Req);
  const wait = async (fn: (e: any) => void, e: any) => { let p: Promise<unknown> = Promise.resolve(); fn({ ...e, waitUntil: (x: Promise<unknown>) => { p = x; } }); await p; };
  return { modes, handlers, store, shown, opened, focused, wait, isSkipped: () => skipped, setClients: (c: any[]) => { clientList = c; }, self };
}

describe("precache list (code-split screens)", () => {
  test("precacheAssets keeps hashed js/css under assets/, drops the VNC chunk, html and anything outside", () => {
    expect(precacheAssets(["index.html", "sw.js", "assets/index-a.js", "assets/cloud-b.js", "assets/index-c.css", "assets/rfb-d.js", "assets/xterm-e.js", "assets/xterm-f.css", "assets/term-pane-g.js", "icons/icon-192.png", "assets/sub/x.js"])).toEqual(["assets/cloud-b.js", "assets/index-a.js", "assets/index-c.css"]);
  });
  test("stampSw writes the list into sw.js; no list = empty (and the placeholder is gone)", () => {
    const out = stampSw(SRC, "abcdef012345", {}, ["assets/a-1.js", "assets/b-2.css"]);
    expect(out).toContain('const ASSETS = ["/assets/a-1.js","/assets/b-2.css"]');
    expect(stampSw(SRC, "abcdef012345")).toContain("const ASSETS = []");
    expect(() => stampSw(SRC, "abcdef012345", {}, ['assets/x"];evil();//'])).toThrow();
  });
  test("install precaches the stamped lazy chunks, not just what index.html references", async () => {
    const s = boot("aaaaaaaaaaaa", [], ["assets/cloud-9.js"]);
    await s.wait(s.handlers.install, {});
    const keys = [...s.store.get("vc-shell-aaaaaaaaaaaa")!.keys()];
    expect(keys).toContain("/assets/x-1.js");
    expect(keys).toContain("/assets/cloud-9.js");
  });
});

describe("sw.js behaviour", () => {
  test("install precaches shell + referenced assets into versioned cache", async () => {
    const s = boot("aaaaaaaaaaaa");
    await s.wait(s.handlers.install, {});
    expect([...s.store.keys()]).toEqual(["vc-shell-aaaaaaaaaaaa"]);
    expect([...s.store.get("vc-shell-aaaaaaaaaaaa")!.keys()]).toContain("/assets/x-1.js");
    expect(s.isSkipped()).toBe(false); // waits for the toast
  });
  test("install fetches shell + assets with cache:reload (never from the HTTP cache)", async () => {
    const s = boot("aaaaaaaaaaaa");
    await s.wait(s.handlers.install, {});
    expect(s.modes.length).toBeGreaterThanOrEqual(5);
    expect(s.modes.every((m) => m === "reload")).toBe(true);
  });
  test("VERSION message answers with BUILD via the port, else via the source", () => {
    const s = boot("abcdef012345");
    const got: any[] = [];
    s.handlers.message({ data: { t: "VERSION" }, ports: [{ postMessage: (m: any) => got.push(m) }] });
    s.handlers.message({ data: { t: "VERSION" }, ports: [], source: { postMessage: (m: any) => got.push(m) } });
    expect(got).toEqual([{ t: "VERSION", build: "abcdef012345", commit: "unknown" }, { t: "VERSION", build: "abcdef012345", commit: "unknown" }]);
  });
  test("SKIP_WAITING message skips waiting; other messages don't", () => {
    const s = boot("aaaaaaaaaaaa");
    s.handlers.message({ data: { t: "other" } });
    expect(s.isSkipped()).toBe(false);
    s.handlers.message({ data: { t: "SKIP_WAITING" } });
    expect(s.isSkipped()).toBe(true);
  });
  test("activate deletes stale vc-shell caches only", async () => {
    const s = boot("bbbbbbbbbbbb", ["vc-shell-aaaaaaaaaaaa", "vc-shell-bbbbbbbbbbbb", "other-cache"]);
    await s.wait(s.handlers.activate, {});
    expect([...s.store.keys()].sort()).toEqual(["other-cache", "vc-shell-bbbbbbbbbbbb"]);
  });
  test("fetch ignores /api, /auth, non-GET and cross-origin", () => {
    const s = boot("aaaaaaaaaaaa");
    let responded = 0;
    for (const [url, method] of [["https://app.test/api/x", "GET"], ["https://app.test/auth/me", "GET"], ["https://app.test/assets/a.js", "POST"], ["https://evil.test/a.js", "GET"]] as const) {
      s.handlers.fetch({ request: { url, method, mode: "cors" }, respondWith: () => { responded++; } });
    }
    expect(responded).toBe(0);
    s.handlers.fetch({ request: { url: "https://app.test/assets/a.js", method: "GET", mode: "cors" }, respondWith: () => { responded++; } });
    expect(responded).toBe(1);
  });
  test("push always shows a notification; rejects non-relative urls", async () => {
    const s = boot("aaaaaaaaaaaa");
    await s.wait(s.handlers.push, { data: { json: () => ({ title: "T", body: "B", url: "/c/1", tag: "1" }) } });
    await s.wait(s.handlers.push, { data: { json: () => ({ title: "T", url: "https://evil.test/" }) } });
    await s.wait(s.handlers.push, { data: { json: () => { throw new Error("bad"); }, text: () => "raw" } });
    expect(s.shown[0][1].data.url).toBe("/c/1");
    expect(s.shown[1][1].data.url).toBe("/");
    expect(s.shown.length).toBe(3);
  });
  test("notificationclick focuses existing client and navigates, else opens window", async () => {
    const s = boot("aaaaaaaaaaaa");
    const msgs: any[] = [];
    const client = { url: "https://app.test/", focus: async () => { s.focused.push(1); }, postMessage: (m: any) => msgs.push(m) };
    s.setClients([client]);
    const n = { close() {}, data: { url: "/c/9" } };
    await s.wait(s.handlers.notificationclick, { notification: n });
    expect(s.focused.length).toBe(1);
    expect(msgs).toEqual([{ t: "nav", url: "/c/9" }]);
    s.setClients([]);
    await s.wait(s.handlers.notificationclick, { notification: n });
    expect(s.opened).toEqual(["/c/9"]);
  });
});

describe("version stamp (commit / builtAt)", () => {
  test("sw.js has the commit placeholder and NO wall-clock one; stampSw writes the commit, defaults to unknown", () => {
    expect(SRC).toContain('"__COMMIT__"');
    expect(SRC).not.toMatch(/BUILT_AT|builtAt/);
    const out = stampSw(SRC, "abcdef012345", { commit: "0123456789ab", builtAt: "2026-10-20T01:02:03Z" });
    expect(out).toContain('const COMMIT = "0123456789ab"');
    expect(out).not.toContain("2026-10-20");
    const d = stampSw(SRC, "abcdef012345");
    expect(d).toContain('const COMMIT = "unknown"');
    expect(d).not.toContain("__COMMIT__");
  });
  test("malformed meta can never inject into sw.js", () => {
    const out = stampSw(SRC, "abcdef012345", { commit: '"; evil()//', builtAt: "yesterday" });
    expect(out).toContain('const COMMIT = "unknown"');
    expect(versionInfo("abcdef012345", { commit: "abc" })).toEqual({ build: "abcdef012345", commit: "unknown", builtAt: "unknown" });
  });
  test("gitCommit: real repo gives a short sha; a non-repo / missing dir gives unknown and never throws", () => {
    expect(gitCommit(new URL("..", import.meta.url).pathname)).toMatch(/^[0-9a-f]{7,40}$/);
    expect(gitCommit("/nonexistent-dir-xyz")).toBe("unknown");
    expect(gitCommit("/tmp")).toBe("unknown");
  });
  test("sw.js is a pure function of content + commit: same input => byte-identical, builtAt ignored, other commit => different", () => {
    const a = stampSw(SRC, "abcdef012345", { commit: "0123456789ab", builtAt: "2026-10-20T01:02:03Z" });
    expect(stampSw(SRC, "abcdef012345", { commit: "0123456789ab", builtAt: "2031-01-01T00:00:00Z" })).toBe(a);
    expect(stampSw(SRC, "abcdef012345", { commit: "0123456789ab" })).toBe(a);
    expect(stampSw(SRC, "abcdef012345", { commit: "fedcba987654" })).not.toBe(a);
    expect(stampSw(SRC, "abcdef012346", { commit: "0123456789ab" })).not.toBe(a);
  });
  test("version.json carries builtAt (the only place), sw.js reply does not", () => {
    expect(versionInfo("abcdef012345", { commit: "0123456789ab", builtAt: "2026-10-20T01:02:03Z" })).toEqual({ build: "abcdef012345", commit: "0123456789ab", builtAt: "2026-10-20T01:02:03Z" });
  });
  test("VERSION reply carries build and commit only", async () => {
    const out = stampSw(SRC, "abcdef012345", { commit: "0123456789ab", builtAt: "2026-10-20T01:02:03Z" });
    const handlers: Record<string, (e: any) => void> = {};
    const self: any = { location: { origin: "https://x" }, addEventListener: (t: string, f: any) => { handlers[t] = f; } };
    new Function("self", "caches", out)(self, {});
    const got: any[] = [];
    handlers.message({ data: { t: "VERSION" }, ports: [{ postMessage: (m: any) => got.push(m) }] });
    expect(got).toEqual([{ t: "VERSION", build: "abcdef012345", commit: "0123456789ab" }]);
  });
});
