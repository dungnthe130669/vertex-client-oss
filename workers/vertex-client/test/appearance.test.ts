import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { navKey } from "../web/src/shell-logic";

const SRC = readFileSync(new URL("../web/public/appearance.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

// Run appearance.js against a fake DOM + storage (same approach as theme.test.ts).
function boot(stored: string | null, opts: { blocked?: boolean } = {}) {
  const attrs: Record<string, string> = {};
  const store: Record<string, string> = stored === null ? {} : { "vc-appearance": stored };
  const win: Record<string, unknown> = {};
  const document = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; } } };
  const localStorage = opts.blocked
    ? { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }
    : { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  new Function("window", "document", "localStorage", SRC)(win, document, localStorage);
  return { vc: win.vcAppearance as { get(): any; set(p: any): any }, attrs, store };
}

describe("appearance.js", () => {
  test("nothing stored -> defaults applied as data attributes (no data-wrap)", () => {
    const t = boot(null);
    expect(t.vc.get()).toEqual({ fs: 3, tf: "system", cf: "system", wrap: false });
    expect(t.attrs).toEqual({ "data-fs": "3", "data-tf": "system", "data-cf": "system" });
  });
  test("stored values are applied at load (before paint)", () => {
    const t = boot(JSON.stringify({ fs: 5, tf: "serif", cf: "sf", wrap: true }));
    expect(t.attrs).toEqual({ "data-fs": "5", "data-tf": "serif", "data-cf": "sf", "data-wrap": "1" });
  });
  test("garbage / out-of-range / unknown values fall back per field", () => {
    expect(boot("{not json").vc.get()).toEqual({ fs: 3, tf: "system", cf: "system", wrap: false });
    expect(boot(JSON.stringify({ fs: 9, tf: "comic-sans", cf: "x", wrap: "yes" })).vc.get()).toEqual({ fs: 3, tf: "system", cf: "system", wrap: false });
    expect(boot(JSON.stringify({ fs: 2.5 })).vc.get().fs).toBe(3);
    expect(boot(JSON.stringify({ fs: 1, tf: "mono" })).vc.get()).toEqual({ fs: 1, tf: "mono", cf: "system", wrap: false });
  });
  test("set merges a patch, persists, applies, and clears data-wrap when turned off", () => {
    const t = boot(null);
    t.vc.set({ fs: 4, wrap: true });
    expect(JSON.parse(t.store["vc-appearance"])).toEqual({ fs: 4, tf: "system", cf: "system", wrap: true });
    expect(t.attrs["data-fs"]).toBe("4"); expect(t.attrs["data-wrap"]).toBe("1");
    t.vc.set({ wrap: false, tf: "serif" });
    expect(t.attrs["data-wrap"]).toBeUndefined(); expect(t.attrs["data-tf"]).toBe("serif"); expect(t.attrs["data-fs"]).toBe("4");
    t.vc.set({ fs: 99 });
    expect(t.vc.get().fs).toBe(3); // an invalid patch value is rejected per field, never stored
  });
  test("blocked storage: still works for this page, no throw", () => {
    const t = boot(null, { blocked: true });
    expect(t.vc.set({ fs: 2 }).fs).toBe(2);
    expect(t.attrs["data-fs"]).toBe("2");
  });
  test("every value the script can emit has a CSS rule (no option that does nothing)", () => {
    for (const n of [1, 2, 4, 5]) expect(CSS).toContain(`:root[data-fs="${n}"]`);
    for (const f of ["serif", "mono"]) expect(CSS).toContain(`:root[data-tf="${f}"]`);
    for (const f of ["system", "sf"]) expect(CSS).toContain(`:root[data-cf="${f}"]`);
    expect(CSS).toContain(':root[data-wrap="1"] .md .codeblock pre code');
  });
  test("no webfont downloads: appearance CSS declares no @font-face / url()", () => {
    expect(CSS).not.toMatch(/@font-face/);
    expect(CSS).not.toMatch(/--(?:t|c)-font:[^;]*url\(/);
  });
});

describe("settings routes", () => {
  test("navKey: sub-pages highlight Settings; lookalikes do not", () => {
    for (const p of ["/settings", "/settings/profile", "/settings/appearance", "/settings/capabilities"]) expect(navKey(p)).toBe("settings");
    expect(navKey("/settingsx")).toBeNull();
  });
});
