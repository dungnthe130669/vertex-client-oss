import { afterEach, describe, expect, test } from "bun:test";
import { safeStore } from "../web/src/update-logic";

// Drives update.ts against fakes (no DOM). Each test imports a FRESH module copy (module state is per-import).
const g = globalThis as any;
let n = 0;
type Fake = ReturnType<typeof setup>;
function setup(o: { register?: () => Promise<any>; online?: boolean; sessionThrows?: boolean; localThrows?: boolean; controller?: boolean } = {}) {
  const posts: any[] = [];
  const reloads: string[] = [];
  const listeners: Record<string, Array<(e?: any) => void>> = {};
  const on = (t: string, f: any) => { (listeners[t] ??= []).push(f); };
  const waiting = { postMessage: (m: any) => { if (m.t === "SKIP_WAITING") posts.push(m); }, addEventListener() {}, state: "installed" };
  const reg: any = { waiting, installing: null, active: {}, update: async () => {}, addEventListener() {} };
  const swListeners: Record<string, Array<(e?: any) => void>> = {};
  g.navigator = { onLine: o.online ?? true, serviceWorker: { controller: o.controller === false ? null : {}, register: o.register ?? (async () => reg), addEventListener: (t: string, f: any) => { (swListeners[t] ??= []).push(f); } } };
  g.document = { visibilityState: "visible", readyState: "complete", addEventListener: on, querySelectorAll: () => [], querySelector: () => null };
  g.addEventListener = on;
  g.location = { reload: () => reloads.push("reload") };
  const mk = (throws?: boolean) => { const m = new Map<string, string>(); return { getItem: (k: string) => { if (throws) throw new Error("denied"); return m.get(k) ?? null; }, setItem: (k: string, v: string) => { if (throws) throw new Error("denied"); m.set(k, v); } }; };
  g.sessionStorage = mk(o.sessionThrows); g.localStorage = mk(o.localThrows);
  return { posts, reloads, reg, waiting, listeners, swListeners, fire: (t: string) => (listeners[t] ?? []).forEach((f) => f()), ctrlChange: () => (swListeners.controllerchange ?? []).forEach((f) => f()) };
}
const load = async () => (await import(`../web/src/update?t${++n}`)) as typeof import("../web/src/update");
const tickMs = (ms = 20) => new Promise((r) => setTimeout(r, ms));
afterEach(() => { for (const k of ["navigator", "document", "addEventListener", "location", "sessionStorage", "localStorage"]) delete g[k]; });

describe("fix 1: popstate is never an apply moment", () => {
  test("a popstate with an update waiting does not apply or reload", async () => {
    const f: Fake = setup({ controller: true });
    const u = await load();
    // register succeeds but cold start must not apply when the page is not idle: simulate a typed draft via a busy key
    const { setBusy } = await import("../web/src/busy");
    setBusy("draft", true);
    u.registerSw(() => {}); await tickMs();
    f.posts.length = 0;
    setBusy("draft", false); // user navigates away: draft gone, new screen idle
    f.fire("popstate"); await tickMs(400);
    expect(f.posts).toEqual([]);
    expect(f.reloads).toEqual([]);
  });
});

describe("fix 2: registration failure counts as an update failure", () => {
  test("online + register rejects twice -> notice-worthy failure with attempts 2; offline -> none", async () => {
    const f = setup({ register: async () => { throw new Error("sw.js 503"); } });
    const u = await load();
    u.registerSw(() => {}); await tickMs();
    expect(u.getState().failure).toEqual({ reason: "sw.js 503", attempts: 1 });
    await u.silentCheck(); // retry path re-registers
    expect(u.getState().failure).toEqual({ reason: "sw.js 503", attempts: 2 });
    expect(u.getState().last?.kind).toBe("failed");
    void f;
  });
  test("offline registration failure is not a failure", async () => {
    setup({ online: false, register: async () => { throw new Error("offline"); } });
    const u = await load();
    u.registerSw(() => {}); await tickMs();
    expect(u.getState().failure).toBeNull();
  });
  test("retry succeeds -> failure cleared", async () => {
    let ok = false;
    const f = setup();
    g.navigator.serviceWorker.register = async () => { if (!ok) throw new Error("x"); return f.reg; };
    const u = await load();
    u.registerSw(() => {}); await tickMs();
    expect(u.getState().failure?.attempts).toBe(1);
    ok = true; await u.silentCheck(); await tickMs();
    expect(u.getState().failure).toBeNull();
  });
});

describe("fix 3: storage errors never abort apply", () => {
  test("safeStore falls back to memory", () => {
    const s = safeStore(() => { throw new Error("denied"); });
    expect(s.get("k")).toBeNull(); s.set("k", "v"); expect(s.get("k")).toBe("v");
  });
  test("throwing sessionStorage/localStorage: auto-apply still posts SKIP_WAITING", async () => {
    const f = setup({ sessionThrows: true, localThrows: true, controller: true });
    const u = await load();
    u.registerSw(() => {}); await tickMs();
    expect(f.posts).toContainEqual({ t: "SKIP_WAITING" });
  });
});

describe("fix 4: the 15-minute timer only downloads", () => {
  test("silentCheck(false) with a waiting worker does not apply; silentCheck(true) does", async () => {
    const f = setup({ controller: true });
    const u = await load();
    const { setBusy } = await import("../web/src/busy");
    setBusy("x", true); u.registerSw(() => {}); await tickMs(); setBusy("x", false); // cold start deferred
    f.posts.length = 0;
    await u.silentCheck(false);
    expect(f.posts).toEqual([]);
    await u.silentCheck(true);
    expect(f.posts).toEqual([{ t: "SKIP_WAITING" }]);
  });
});

describe("fix 5: 'Updated' only after activation", () => {
  test("SKIP_WAITING lost -> no 'updated', a failure is recorded", async () => {
    const f = setup({ controller: true });
    const u = await load();
    u.registerSw(() => {}); await tickMs();
    expect(f.posts).toEqual([{ t: "SKIP_WAITING" }]);
    expect(u.getState().last?.kind).not.toBe("updated");
    await tickMs(4100);
    expect(u.getState().failure?.reason).toBe("Activation timed out");
    expect(u.getState().last?.kind).toBe("failed");
    expect(f.reloads).toEqual([]); // auto path never reloads blindly
  }, 10_000);
  test("controllerchange after SKIP_WAITING -> 'updated' recorded, then reload", async () => {
    const f = setup({ controller: true });
    const u = await load();
    u.registerSw(() => {}); await tickMs();
    expect(u.getState().last?.kind).not.toBe("updated");
    f.ctrlChange();
    expect(u.getState().last?.kind).toBe("updated");
    expect(f.reloads).toEqual(["reload"]);
  });
});

describe("no-SW fallback: build from /version.json is the deployed build, not the running one", () => {
  const VJ = { build: "dep123", commit: "c0ffee", builtAt: "2026-10-30T00:00:00Z" };
  const mockFetch = (impl: () => Promise<any>) => { g.fetch = async () => impl(); };
  const ok = (body: any) => async () => ({ ok: true, status: 200, json: async () => body });
  afterEach(() => { delete g.fetch; });

  test("(a) no SW + fetch ok -> rows filled, source deployed, relation unknown", async () => {
    setup({ controller: false });
    mockFetch(ok(VJ));
    const u = await load();
    await u.refreshBuild(); await tickMs();
    const s = u.getState();
    expect([s.build, s.commit, s.builtAt, s.buildSource]).toEqual(["dep123", "c0ffee", "2026-10-30T00:00:00Z", "deployed"]);
    const { relation } = await import("../web/src/update-logic");
    expect(relation(u.runningBuild(s), "dep123")).toBe("unknown");
  });
  test("(b1) worker reply first -> deployed fetch never overrides it, relation computed", async () => {
    const f = setup({ controller: true });
    g.navigator.serviceWorker.controller = { postMessage: (_m: any, [port]: any[]) => { port.postMessage({ t: "VERSION", build: "run999", commit: "abc" }); } };
    mockFetch(ok(VJ));
    const u = await load();
    await u.refreshBuild(); await tickMs();
    const s = u.getState();
    expect([s.build, s.buildSource]).toEqual(["run999", "worker"]);
    const { relation } = await import("../web/src/update-logic");
    expect(relation(u.runningBuild(s), "dep123")).toBe("older");
    void f;
  });
  test("(b2) deployed first, then worker reply -> worker value wins", async () => {
    setup({ controller: false });
    mockFetch(ok(VJ));
    const u = await load();
    await u.refreshBuild(); await tickMs();
    expect(u.getState().buildSource).toBe("deployed");
    g.navigator.serviceWorker.controller = { postMessage: (_m: any, [port]: any[]) => { port.postMessage({ t: "VERSION", build: "run999", commit: "abc" }); } };
    await u.refreshBuild(); await tickMs();
    expect([u.getState().build, u.getState().buildSource]).toEqual(["run999", "worker"]);
  });
  test("(b3) worker reply lands while the deployed fetch is in flight -> worker wins", async () => {
    setup({ controller: false });
    let release!: () => void;
    mockFetch(() => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => VJ }); }));
    const u = await load();
    const p = u.refreshBuild(); await tickMs();
    g.navigator.serviceWorker.controller = { postMessage: (_m: any, [port]: any[]) => { port.postMessage({ t: "VERSION", build: "run999", commit: "abc" }); } };
    await u.refreshBuild();
    release(); await p; await tickMs();
    expect([u.getState().build, u.getState().buildSource]).toEqual(["run999", "worker"]);
  });
  test("(c) fetch rejects / non-200 / bad JSON -> no throw, state unchanged", async () => {
    for (const impl of [async () => { throw new Error("net"); }, async () => ({ ok: false, status: 503, json: async () => VJ }), async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }), ok({ build: "unknown" }), ok(null)]) {
      setup({ controller: false });
      mockFetch(impl);
      const u = await load();
      await u.refreshBuild(); await tickMs();
      const s = u.getState();
      expect([s.build, s.commit, s.builtAt, s.buildSource]).toEqual([null, null, null, null]);
    }
  });
});
