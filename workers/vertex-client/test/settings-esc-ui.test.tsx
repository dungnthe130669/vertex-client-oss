// vclui5: Esc closes the desktop Settings modal (and a sub-sheet first). happy-dom + preact, DeskShell mounted for real.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let render: typeof import("preact").render; let h: typeof import("preact").h; let D: typeof import("../web/src/desk"); let root: HTMLElement;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const REAL_FETCH = globalThis.fetch;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/settings", width: 1280, height: 800 });
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
  render = (await import("preact")).render; h = (await import("preact")).h; D = await import("../web/src/desk");
});
afterAll(() => { globalThis.fetch = REAL_FETCH; GlobalRegistrator.unregister(); });
afterEach(() => { render(null, root); root.remove(); document.body.innerHTML = ""; });
const q = (s: string) => document.querySelector<HTMLElement>(`[data-testid=${s}]`);
const esc = (target: Element | Document = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
const mount = async (path: string) => {
  history.replaceState({}, "", path);
  root = document.createElement("div"); document.body.append(root);
  render(h(D.DeskShell as never, { path, render: (p: string) => h("div", { "data-testid": "page" }, p) }), root);
  for (let i = 0; i < 5; i++) await tick();
};
describe("Esc closes the Settings modal", () => {
  test("Esc with the modal open leaves /settings", async () => {
    await mount("/settings"); expect(q("settings-modal")).not.toBeNull();
    esc(); await tick(); await tick();
    expect(location.pathname).not.toBe("/settings");
  });
  test("Esc while focus is on a modal button also closes", async () => {
    await mount("/settings"); q("settings-modal-close")!.focus();
    esc(q("settings-modal-close")!); await tick();
    expect(location.pathname).not.toBe("/settings");
  });
  test("Esc on a Settings sub-pane (profile) leaves the modal", async () => {
    await mount("/settings/profile"); expect(q("settings-modal")).not.toBeNull();
    esc(); await tick(); await tick();
    expect(location.pathname.startsWith("/settings")).toBe(false);
  });
  test("an open sheet takes the Esc first; the modal stays", async () => {
    await mount("/settings"); const s = document.createElement("div"); s.className = "scrim"; document.body.append(s);
    esc(); await tick(); expect(location.pathname).toBe("/settings");
  });
  test("a focused element that swallows Esc (stopPropagation) does not trap the modal", async () => {
    await mount("/settings"); const b = document.createElement("button"); b.className = "stray"; document.body.append(b); b.focus();
    b.addEventListener("keydown", (e) => { if (e.key === "Escape") e.stopPropagation(); });
    esc(b); await tick(); await tick();
    expect(location.pathname).not.toBe("/settings");
  });
  test("an open dropdown/menu gets its Esc first; the modal stays", async () => {
    await mount("/settings"); const m = document.createElement("div"); m.setAttribute("role", "menu"); const i = document.createElement("button"); m.append(i); document.body.append(m); i.focus();
    esc(i); await tick(); expect(location.pathname).toBe("/settings");
    const sel = document.createElement("button"); sel.setAttribute("aria-expanded", "true"); document.body.append(sel); sel.focus();
    esc(sel); await tick(); expect(location.pathname).toBe("/settings");
  });
  test("text input inside Settings: Esc still closes (no dropdown open)", async () => {
    await mount("/settings"); const t = document.createElement("input"); document.body.append(t); t.focus();
    esc(t); await tick(); await tick(); expect(location.pathname).not.toBe("/settings");
  });
  test("one Esc = one navigation (no double history entry)", async () => {
    await mount("/settings"); const n = history.length; esc(); await tick(); await tick();
    expect(history.length - n).toBeLessThanOrEqual(1);
  });
});
