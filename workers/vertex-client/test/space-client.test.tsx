// Web client spaces (T6): the space store, the selector on every request, the switcher, the accent contrast, and a scan that no fetch / URL builder
// can omit the selector while Open is active. happy-dom for this file only, removed afterwards (test/zz-no-dom-leak.test.ts checks).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let S: typeof import("../web/src/space"); let A: typeof import("../web/src/api"); let L: typeof import("../web/src/library-logic");
let C: typeof import("../web/src/chat-client"); let UI: typeof import("../web/src/space-ui"); let D: typeof import("../web/src/drawer");
let P: typeof import("../web/src/palette-logic"); let N: typeof import("../web/src/drawer-nav"); let T: typeof import("../web/src/tabs"); let CH: typeof import("../web/src/chat");
let render: typeof import("preact").render; let h: typeof import("preact").h; let act: (fn: () => void) => Promise<void>;
const REAL_FETCH = globalThis.fetch; const REAL_WS = (globalThis as { WebSocket?: unknown }).WebSocket;
type Rec = { url: string; headers: Record<string, string> };
let seen: Rec[] = []; let nav: string[] = [];
const me = (spaces?: Array<"biz" | "open">) => ({ user: "erich", via: "sso", csrf: "c", defaultModel: "m", erichOnly: true, ...(spaces ? { spaces } : {}) });
const hdrs = (init?: RequestInit) => { const o: Record<string, string> = {}; new Headers(init?.headers).forEach((v, k) => { o[k] = v; }); return o; };
const stub = (status = 200, body: unknown = {}) => { globalThis.fetch = (async (u: unknown, init?: RequestInit) => { seen.push({ url: String(u), headers: hdrs(init) }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch; };

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const preact = await import("preact"); render = preact.render; h = preact.h;
  S = await import("../web/src/space"); A = await import("../web/src/api"); L = await import("../web/src/library-logic");
  C = await import("../web/src/chat-client"); UI = await import("../web/src/space-ui"); D = await import("../web/src/drawer"); P = await import("../web/src/palette-logic"); N = await import("../web/src/drawer-nav"); T = await import("../web/src/tabs"); CH = await import("../web/src/chat");
  act = async (fn) => { fn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
});
afterAll(() => {
  globalThis.fetch = REAL_FETCH;
  S.resetSpaceForTest();
  GlobalRegistrator.unregister();
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  if (REAL_WS === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket; else (globalThis as { WebSocket?: unknown }).WebSocket = REAL_WS;
});
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, "", "/"); S.resetSpaceForTest(); delete document.documentElement.dataset.space;
  seen = []; nav = []; S.setNavigateForTest((to) => { nav.push(to); }); stub();
});
afterEach(() => { document.body.innerHTML = ""; });

describe("space store", () => {
  test("default is Business: nothing stored, no attribute, no header, URL builders unchanged", () => {
    expect(S.getSpace()).toBe("biz");
    expect(localStorage.getItem("vc.space")).toBeNull();
    expect(document.documentElement.dataset.space).toBeUndefined();
    expect(S.spaceHeaders()).toEqual({});
    expect(S.withSpaceQuery("/api/x?a=1")).toBe("/api/x?a=1");
  });
  test("vc.space=open is read, painted on <html>, and becomes a header / query", () => {
    localStorage.setItem("vc.space", "open");
    expect(S.getSpace()).toBe("open");
    expect(document.documentElement.dataset.space).toBe("open");
    expect(S.spaceHeaders()).toEqual({ "x-vc-space": "open" });
    expect(S.withSpaceQuery("/api/x")).toBe("/api/x?space=open");
    expect(S.withSpaceQuery("/api/x?a=1")).toBe("/api/x?a=1&space=open");
    expect(S.withSpaceQuery("/api/x?a=1#h")).toBe("/api/x?a=1&space=open#h");
  });
  test("garbage in storage is ignored (the server decides; the client never invents a space)", () => {
    for (const v of ["OPEN", "main~open", "g:x", "open,biz", "", "x".repeat(300)]) { localStorage.setItem("vc.space", v); S.resetSpaceForTest(); expect(S.getSpace()).toBe("biz"); }
  });
  test("?space=open in the URL wins once, is remembered, and is stripped (other params stay)", () => {
    history.replaceState({}, "", "/c/abc?space=open&keep=1#frag");
    expect(S.getSpace()).toBe("open");
    expect(location.pathname + location.search + location.hash).toBe("/c/abc?keep=1#frag");
    expect(localStorage.getItem("vc.space")).toBe("open");
  });
  test("?space=biz in the URL overrides a remembered open", () => {
    localStorage.setItem("vc.space", "open"); history.replaceState({}, "", "/?space=biz");
    expect(S.getSpace()).toBe("biz"); expect(localStorage.getItem("vc.space")).toBeNull();
  });
  test("a bad ?space= is stripped and ignored", () => {
    history.replaceState({}, "", "/?space=main~open"); expect(S.getSpace()).toBe("biz"); expect(location.search).toBe("");
  });
  test("switchSpace: closes sockets (event), remembers, repaints, reloads to the start screen; same space is a no-op", () => {
    let evt = 0; const on = () => { evt++; }; addEventListener(S.SPACE_SWITCH_EVENT, on);
    S.switchSpace("biz"); expect(nav).toEqual([]); expect(evt).toBe(0);
    S.switchSpace("open");
    expect(evt).toBe(1); expect(nav).toEqual(["/"]); expect(localStorage.getItem("vc.space")).toBe("open"); expect(document.documentElement.dataset.space).toBe("open");
    S.switchSpace("biz");
    expect(localStorage.getItem("vc.space")).toBeNull(); expect(document.documentElement.dataset.space).toBeUndefined();
    removeEventListener(S.SPACE_SWITCH_EVENT, on);
  });
});

describe("selector on every request", () => {
  test("Business: api() sends exactly what it sent before spaces (no x-vc-space)", async () => {
    await A.call("/api/models"); await A.call("/api/prompts", { method: "POST", body: "{}" });
    expect(seen.every((r) => !("x-vc-space" in r.headers))).toBe(true);
    expect(seen[0]!.url).toBe("/api/models");
  });
  test("Open: api() GET and POST carry the header", async () => {
    S.setSpace("open"); await A.call("/api/models"); await A.call("/api/prompts", { method: "POST", body: "{}" });
    expect(seen.map((r) => r.headers["x-vc-space"])).toEqual(["open", "open"]);
  });
  test("Open: the raw upload fetches (file upload, transcribe) carry the header", async () => {
    S.setSpace("open");
    await A.uploadFile("c1", new Blob(["x"], { type: "text/plain" }), "a.txt");
    await A.transcribeAudio(new Blob(["x"], { type: "audio/mp4" }), "");
    expect(seen.length).toBe(2); expect(seen.every((r) => r.headers["x-vc-space"] === "open")).toBe(true);
  });
  test("Business: the raw uploads still send no selector", async () => {
    await A.uploadFile("c1", new Blob(["x"], { type: "text/plain" }), "a.txt");
    expect("x-vc-space" in seen[0]!.headers).toBe(false);
  });
  test("Open: fileUrl / libUrl carry ?space=open; Business unchanged", () => {
    const ref = "u/c1/a b.png"; const it = { conv: "c1", ref: "a b.png" };
    expect(A.fileUrl("c1", ref)).toBe("/api/conversations/c1/files/a%20b.png"); expect(L.libUrl(it)).toBe("/api/conversations/c1/files/a%20b.png");
    S.setSpace("open");
    expect(A.fileUrl("c1", ref)).toBe("/api/conversations/c1/files/a%20b.png?space=open"); expect(L.libUrl(it)).toBe("/api/conversations/c1/files/a%20b.png?space=open");
  });
  test("chat WebSocket: ?space=open in Open (+ the 404 probe carries the header), nothing extra in Business", async () => {
    const urls: string[] = [];
    class FakeWS { static OPEN = 1; static CONNECTING = 0; readyState = 0; onopen: unknown; onclose: ((e?: unknown) => void) | null = null; onmessage: unknown; onerror: unknown; constructor(u: string) { urls.push(u); } close() {} send() {} }
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;
    const a = new C.ChatSocket("c1", () => 7, () => {}, () => {}); a.close();
    S.setSpace("open");
    const b = new C.ChatSocket("c1", () => 7, () => {}, () => {}); b.close();
    expect(urls[0]).toBe("ws://localhost/api/conversations/c1/ws?since=7");
    expect(urls[1]).toBe("ws://localhost/api/conversations/c1/ws?since=7&space=open");
  });
  test("a space switch closes the open chat socket (no late frame of the old space)", () => {
    class FakeWS { static OPEN = 1; static CONNECTING = 0; readyState = 1; closed = false; onopen: unknown; onclose: unknown; onmessage: unknown; onerror: unknown; constructor() { made.push(this); } close() { this.closed = true; } send() {} }
    const made: FakeWS[] = []; (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;
    new C.ChatSocket("c1", () => 0, () => {}, () => {});
    S.switchSpace("open");
    expect(made[0]!.closed).toBe(true);
  });
});

describe("stale Open: 403 'space unavailable'", () => {
  test("clears vc.space and reloads into Business", async () => {
    localStorage.setItem("vc.space", "open"); stub(403, { error: "space unavailable" });
    const r = await A.call("/api/models");
    expect(r.status).toBe(403); expect(localStorage.getItem("vc.space")).toBeNull(); expect(S.getSpace()).toBe("biz"); expect(nav).toEqual(["/"]);
    expect(document.documentElement.dataset.space).toBeUndefined();
  });
  test("the same through a raw upload", async () => {
    S.setSpace("open"); stub(403, { error: "space unavailable" });
    await A.uploadFile("c1", new Blob(["x"]), "a.txt");
    expect(localStorage.getItem("vc.space")).toBeNull(); expect(nav).toEqual(["/"]);
  });
  test("any other 403 (and a 403 in Business) does not touch the selector, so no reload loop", async () => {
    S.setSpace("open"); stub(403, { error: "forbidden" }); await A.call("/api/x");
    expect(localStorage.getItem("vc.space")).toBe("open"); expect(nav).toEqual([]);
    S.setSpace("biz"); stub(403, { error: "space unavailable" }); await A.call("/api/x"); expect(nav).toEqual([]);
  });
});

describe("no request can omit the selector in Open", () => {
  const SRC = new URL("../web/src/", import.meta.url).pathname;
  const files = readdirSync(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
  // Not space-scoped on purpose: the app-shell version probes and the reset fetch are global, and the artifact frame URL is a signed token that
  // already embeds its storage scope (credentials omitted, absolute view URL). Anything new must carry the selector or be added here with a reason.
  const ALLOW: Array<[string, RegExp]> = [["update.ts", /\/version\.json|\/api\/version|vc-reset/], ["artifacts.tsx", /alive = \(url: string\)/]];
  test("static: every fetch( / new WebSocket( / new RFB( in web/src uses the selector or is allowlisted", () => {
    const bad: string[] = [];
    for (const f of files) {
      const lines = readFileSync(SRC + f, "utf8").split("\n");
      lines.forEach((ln, i) => {
        if (!/\bfetch\(|new WebSocket\(|new RFB\(|new WSctor\(/.test(ln) || /^\s*(\/\/|\*)/.test(ln)) return;
        const win = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        if (/spaceHeaders|withSpaceQuery/.test(win)) return;
        if (ALLOW.some(([af, re]) => af === f && re.test(ln))) return;
        if (f === "chat.tsx" && /fetch\(url,/.test(ln) && /const url = fileUrl\(/.test(readFileSync(SRC + f, "utf8"))) return; // url is built by fileUrl()
        bad.push(`${f}:${i + 1}: ${ln.trim().slice(0, 100)}`);
      });
    }
    expect(bad).toEqual([]);
  });
  test("static: every URL builder that returns an /api/ media path goes through withSpaceQuery", () => {
    expect(readFileSync(SRC + "api.ts", "utf8")).toMatch(/fileUrl = .*withSpaceQuery\(/);
    expect(readFileSync(SRC + "library-logic.ts", "utf8")).toMatch(/libUrl = .*withSpaceQuery\(/);
  });
  test("dynamic: with Open on, EVERY function exported by api.ts sends the selector (header, or ?space= for the URL builders)", async () => {
    S.setSpace("open");
    const fns = Object.entries(A).filter(([k, v]) => typeof v === "function" && !["call", "setCsrf", "getProviders"].includes(k)) /* getProviders deliberately asks for the Open list (server-gated); covered below */ as Array<[string, (...a: unknown[]) => unknown]>;
    expect(fns.length).toBeGreaterThan(40);
    const urlBuilders: string[] = [];
    for (const [name, fn] of fns) {
      const before = seen.length;
      let out: unknown;
      try { out = fn("a1", "b1", "c1"); await out; } catch { /* dummy args: the call itself may throw after the request was made */ }
      if (typeof out === "string") { urlBuilders.push(name); expect(out, name).toContain("space=open"); continue; }
      const made = seen.slice(before);
      expect(made.length, `${name} made no request`).toBeGreaterThan(0);
      for (const r of made) expect(r.headers["x-vc-space"] ?? (r.url.includes("space=open") ? "open" : ""), `${name} -> ${r.url}`).toBe("open");
    }
    expect(urlBuilders).toContain("fileUrl");
  });
  test("getProviders always asks for the Open list (the provider configs live there), falling back to the plain list when Open is unavailable", async () => {
    seen.length = 0; try { await A.getProviders(); } catch {}
    expect(seen[0]!.headers["x-vc-space"]).toBe("open");
  });
  test("dynamic: Business, the same sweep sends no selector anywhere", async () => {
    const fns = Object.entries(A).filter(([k, v]) => typeof v === "function" && !["call", "setCsrf", "getProviders"].includes(k)) as Array<[string, (...a: unknown[]) => unknown]>;
    for (const [, fn] of fns) { try { await fn("a1", "b1", "c1"); } catch {} }
    expect(seen.every((r) => !("x-vc-space" in r.headers) && !r.url.includes("space="))).toBe(true);
  });
});

describe("switcher", () => {
  const mount = async (m: ReturnType<typeof me>, ui: import("preact").VNode<any> = h(UI.SpaceSwitcher, {})) => {
    const root = document.createElement("div"); document.body.appendChild(root);
    await act(() => render(h(D.MeCtx.Provider, { value: m as never, children: ui }), root));
    return root;
  };
  test("hidden when /api/me.spaces is absent or has one entry (today's UI)", async () => {
    expect((await mount(me())).querySelector("[data-testid=space-switcher]")).toBeNull();
    expect((await mount(me(["biz"]))).querySelector("[data-testid=space-switcher]")).toBeNull();
  });
  test("shown with both spaces: Business | Open, aria-pressed on the active one, Business first; no Open note in Business", async () => {
    const root = await mount(me(["biz", "open"]));
    const btns = [...root.querySelectorAll<HTMLElement>(".space-opt")];
    expect(btns.map((b) => b.textContent)).toEqual(["Business", "Open"]);
    expect(btns.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(root.querySelector("[data-testid=space-note]")).toBeNull();
  });
  test("tapping Open switches (remember + reload to /); in Open the subtitle is shown and Open is pressed", async () => {
    const root = await mount(me(["biz", "open"]));
    await act(() => root.querySelector<HTMLElement>("[data-testid=space-open]")!.click());
    expect(localStorage.getItem("vc.space")).toBe("open"); expect(nav).toEqual(["/"]);
    const again = await mount(me(["biz", "open"]));
    expect(again.querySelector("[data-testid=space-open]")!.getAttribute("aria-pressed")).toBe("true");
    expect(again.querySelector("[data-testid=space-note]")!.textContent).toContain("not Vertex");
  });
  test("drawer content renders the switcher under the name row, only for two-space users", async () => {
    const draw = (m: ReturnType<typeof me>) => mount(m, h(D.DrawerContent, { go: () => () => {} }));
    const two = await draw(me(["biz", "open"])); expect(two.querySelector(".drawer-head + [data-testid=space-switcher]")).not.toBeNull();
    const one = await draw(me(["biz"])); expect(one.querySelector("[data-testid=space-switcher]")).toBeNull();
  });
  test("chat chip: only in Open", async () => {
    const chip = h(UI.SpaceChip, {});
    expect((await mount(me(["biz", "open"]), chip)).querySelector("[data-testid=space-chip]")).toBeNull();
    S.setSpace("open");
    expect((await mount(me(["biz", "open"]), chip)).querySelector("[data-testid=space-chip]")!.textContent).toBe("Open");
  });
  test("empty Open state: CTA to add a provider; a team user gets no pointer to credentials", async () => {
    const m1 = me(["biz", "open"]);
    const a = await mount(m1, h(UI.OpenEmpty, { me: m1 as never }));
    expect(a.textContent).toContain("Open space"); expect(a.textContent).toContain("Your Business chats are not visible here"); expect(a.querySelector("[data-testid=open-empty-cta]")!.textContent).toBe("Add a provider");
    const team = { ...m1, team: true };
    const b = await mount(team, h(UI.OpenEmpty, { me: team as never }));
    expect(b.querySelector("[data-testid=open-empty-cta]")).toBeNull(); expect(b.textContent).toContain("No providers are available for your account");
  });
});

describe("palette + accent", () => {
  const src = { chats: [], artifacts: [], erichOnly: true };
  test("'Switch to Open' only when the user has both spaces; 'Switch to Business' while in Open", () => {
    expect(P.buildItems("", src).some((i) => i.act === "switch-space")).toBe(false);
    expect(P.buildItems("", { ...src, switchTo: "open" }).find((i) => i.act === "switch-space")!.label).toBe("Switch to Open");
    expect(P.buildItems("switch", { ...src, switchTo: "biz" }).find((i) => i.act === "switch-space")!.label).toBe("Switch to Business");
  });
  const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  test("Open accent is AA (>=4.5) as button text and as chip/underline on the surface, light and dark; all three CSS blocks use the same values", () => {
    const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
    const light = /:root\[data-space="open"\] \{ --accent:(#[0-9A-Fa-f]{6}); --on-accent:(#[0-9A-Fa-f]{6})/.exec(css)!;
    const dark = /data-theme="dark"\] \{ --accent:(#[0-9A-Fa-f]{6}); --on-accent:(#[0-9A-Fa-f]{6})/.exec(css.slice(css.indexOf('[data-space="open"][data-theme="dark"]') - 40))!;
    expect(ratio(light[1]!, light[2]!)).toBeGreaterThanOrEqual(4.5); expect(ratio(light[1]!, "#FFFFFF")).toBeGreaterThanOrEqual(4.5); // on the light surface
    expect(ratio(dark[1]!, dark[2]!)).toBeGreaterThanOrEqual(4.5); expect(ratio(dark[1]!, "#171A20")).toBeGreaterThanOrEqual(4.5); // on the dark surface
    expect(css.match(/data-space="open"\]:not\(\[data-theme="light"\]\) \{ --accent:#4FD1B8; --on-accent:#0F1115/)).not.toBeNull();
  });
});

const until = async (ok: () => boolean, ms = 4000) => { const t0 = Date.now(); while (!ok() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); };
describe("review fixes: reconcile, probe 403, Business-only modes, deep-link 404", () => {
  const both = { spaces: ["biz", "open"], space: "open" };
  test("reconcile: stored open + /api/me confirming open and listing it = ok, nothing reloads, guard cleared", () => {
    S.setSpace("open"); sessionStorage.setItem("vc.space.fallback", "1");
    expect(S.reconcileSpace(both)).toBe("ok"); expect(nav).toEqual([]); expect(S.getSpace()).toBe("open"); expect(sessionStorage.getItem("vc.space.fallback")).toBeNull();
  });
  test("reconcile: Business stored = ok without looking at me", () => { expect(S.reconcileSpace(null)).toBe("ok"); expect(nav).toEqual([]); });
  test.each([["older server (no spaces)", {}], ["spaces without open", { spaces: ["biz"], space: "biz" }], ["revoked: lists open but resolved biz", { spaces: ["biz", "open"], space: "biz" }], ["no me at all", null]])(
    "reconcile: stored open but %s -> cleared, accent gone, ONE reload into Business", (_n, m) => {
      localStorage.setItem("vc.space", "open"); expect(S.getSpace()).toBe("open"); expect(document.documentElement.dataset.space).toBe("open");
      expect(S.reconcileSpace(m as never)).toBe("reload");
      expect(localStorage.getItem("vc.space")).toBeNull(); expect(S.getSpace()).toBe("biz"); expect(document.documentElement.dataset.space).toBeUndefined(); expect(nav).toEqual(["/"]);
    });
  test("reconcile: loop guard - a second fall-back in the same tab session does not reload again", () => {
    S.setSpace("open"); expect(S.reconcileSpace({})).toBe("reload");
    S.setSpace("open"); expect(S.reconcileSpace({})).toBe("stay"); expect(nav).toEqual(["/"]); expect(S.getSpace()).toBe("biz");
  });
  test("stale 403 through api(): the guard stops a second reload", async () => {
    S.setSpace("open"); stub(403, { error: "space unavailable" }); await A.call("/api/x"); expect(nav).toEqual(["/"]);
    S.setSpace("open"); await A.call("/api/x"); expect(nav).toEqual(["/"]); expect(S.getSpace()).toBe("biz");
  });
  test("failed-WebSocket probe: 403 'space unavailable' clears vc.space, reloads into Business, stops reconnecting", async () => {
    const made: Array<{ onclose: (() => void) | null }> = [];
    class FakeWS { static OPEN = 1; static CONNECTING = 0; readyState = 0; onopen: unknown; onclose: (() => void) | null = null; onmessage: unknown; onerror: unknown; constructor() { made.push(this); } close() {} send() {} }
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;
    localStorage.setItem("vc.space", "open"); S.resetSpaceForTest(); stub(403, { error: "space unavailable" });
    let gone = 0; const sock = new C.ChatSocket("c1", () => 0, () => {}, () => {}, () => { gone++; });
    made[0]!.onclose!(); await until(() => made.length === 2); expect(made.length).toBe(2);
    made[1]!.onclose!(); await new Promise((r) => setTimeout(r, 30));
    expect(localStorage.getItem("vc.space")).toBeNull(); expect(nav).toEqual(["/"]); expect(S.getSpace()).toBe("biz"); expect(gone).toBe(0);
    await new Promise((r) => setTimeout(r, 1200)); expect(made.length).toBe(2); // no third socket
    sock.close();
  });
  test("failed-WebSocket probe: a plain 403 in Open does not leave Open", async () => {
    const made: Array<{ onclose: (() => void) | null }> = [];
    class FakeWS { static OPEN = 1; static CONNECTING = 0; readyState = 0; onopen: unknown; onclose: (() => void) | null = null; onmessage: unknown; onerror: unknown; constructor() { made.push(this); } close() {} send() {} }
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;
    S.setSpace("open"); stub(403, { error: "forbidden" });
    const sock = new C.ChatSocket("c1", () => 0, () => {}, () => {}, () => {});
    made[0]!.onclose!(); await until(() => made.length === 2); made[1]!.onclose!(); await new Promise((r) => setTimeout(r, 30));
    expect(S.getSpace()).toBe("open"); expect(nav).toEqual([]); sock.close();
  });
  test("mode tabs: Cloud/Agents/Desktop gone in Open (Chat and Remote stay), all five in Business", async () => {
    const tabs = async () => { const r = document.createElement("div"); document.body.appendChild(r); await act(() => render(h(T.ModeTabs, { mode: "chat" }), r)); return [...r.querySelectorAll("[role=tab]")].map((e) => e.getAttribute("data-testid")); };
    expect(await tabs()).toEqual(["tab-chat", "tab-cloud", "tab-agents", "tab-desktop", "tab-remote"]);
    S.setSpace("open"); expect(await tabs()).toEqual(["tab-chat", "tab-remote"]);
  });
  test("drawer nav and palette: no Cloud/Agents/Desktop entry in Open; Business unchanged", () => {
    const keys = (n: ReturnType<typeof N.drawerNav>) => n.primary.flatMap((e) => (e.kind === "group" ? e.items : [e])).map((i) => i.key);
    const me = { erichOnly: true };
    expect(keys(N.drawerNav(me))).toEqual(expect.arrayContaining(["cloud", "agents", "desktop"]));
    expect(keys(N.drawerNav(me, "open")).filter((k) => ["cloud", "agents", "desktop"].includes(k))).toEqual([]);
    expect(keys(N.drawerNav(me, "open"))).toEqual(expect.arrayContaining(["remote"]));
    const paths = (o: boolean) => P.navItems(true, o).map((i) => i.path);
    expect(paths(false)).toEqual(expect.arrayContaining(["/cloud", "/agents", "/desktop"]));
    expect(paths(true).filter((p) => ["/cloud", "/agents", "/desktop"].includes(p!))).toEqual([]);
    expect(P.buildItems("cloud", { chats: [], artifacts: [], erichOnly: true, openSpace: true }).some((i) => i.path === "/cloud")).toBe(false);
  });
  test("Business-only route matcher (deep link / stale tab in Open lands on the start screen)", () => {
    for (const p of ["/cloud", "/agents", "/desktop", "/devices", "/d/0123456789abcdef", "/a/helper", "/r/0123456789abcdef"]) expect(S.isBizOnlyPath(p)).toBe(true);
    for (const p of ["/", "/chats", "/c/00000000-0000-0000-0000-000000000000", "/remote", "/settings", "/library"]) expect(S.isBizOnlyPath(p)).toBe(false);
  });
  test("deep link to an Open conversation while in Business: the 404 screen keeps the message and offers Switch to Open (id preserved)", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const root = document.createElement("div"); document.body.appendChild(root);
    await act(() => render(h(D.MeCtx.Provider, { value: me(["biz", "open"]) as never, children: h(CH.MissingConversation, { id, notFound: true }) }), root));
    expect(root.textContent).toContain("Conversation not found");
    const btn = root.querySelector<HTMLButtonElement>("[data-testid=switch-to-open]"); expect(btn).not.toBeNull();
    await act(() => btn!.click());
    expect(S.getSpace()).toBe("open"); expect(localStorage.getItem("vc.space")).toBe("open"); expect(nav).toEqual([`/c/${id}`]);
  });
  test("404 screen: no Switch action without Open, in Open, or when it was not a 404", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const probe = async (m: ReturnType<typeof me>, notFound: boolean) => { const r = document.createElement("div"); document.body.appendChild(r);
      await act(() => render(h(D.MeCtx.Provider, { value: m as never, children: h(CH.MissingConversation, { id, notFound }) }), r)); expect(r.textContent).toContain("Conversation not found"); expect(r.querySelector("[data-testid=back-to-list]")).not.toBeNull(); return r.querySelector("[data-testid=switch-to-open]"); };
    expect(await probe(me(), true)).toBeNull(); expect(await probe(me(["biz"]), true)).toBeNull(); expect(await probe(me(["biz", "open"]), false)).toBeNull();
    S.setSpace("open"); expect(await probe(me(["biz", "open"]), true)).toBeNull();
  });
});
