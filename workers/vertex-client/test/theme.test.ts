import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../web/public/theme.js", import.meta.url), "utf8");

// Run theme.js against a minimal fake DOM + storage; returns the fake window and the state it touched.
function boot(stored: string | null, opts: { blocked?: boolean } = {}) {
  const attrs: Record<string, string> = {};
  const store: Record<string, string> = stored === null ? {} : { "vc-theme": stored };
  const meta = (scheme: string, content: string) => { const a: Record<string, string> = { "data-scheme": scheme, content }; return { getAttribute: (k: string) => a[k] ?? null, setAttribute: (k: string, v: string) => { a[k] = v; }, a }; };
  const metas = [meta("light", "#F7F8FA"), meta("dark", "#0F1115")];
  const win: Record<string, unknown> = {};
  const document = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; } }, querySelectorAll: () => metas };
  const localStorage = opts.blocked
    ? { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } }
    : { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
  new Function("window", "document", "localStorage", SRC)(win, document, localStorage);
  return { vc: win.vcTheme as { get(): string; set(m: string): void }, attrs, store, metas: metas.map((m) => m.a.content) };
}

describe("theme.js", () => {
  test("no stored value -> auto, no data-theme, meta colours untouched", () => {
    const t = boot(null);
    expect(t.vc.get()).toBe("auto");
    expect(t.attrs["data-theme"]).toBeUndefined();
    expect(t.metas).toEqual(["#F7F8FA", "#0F1115"]);
  });
  test("stored dark is applied at load (before paint) and both theme-color metas follow it", () => {
    const t = boot("dark");
    expect(t.attrs["data-theme"]).toBe("dark");
    expect(t.metas).toEqual(["#0F1115", "#0F1115"]);
  });
  test("set light persists and applies; set auto clears storage + attribute and restores the meta pair", () => {
    const t = boot(null);
    t.vc.set("light");
    expect(t.store["vc-theme"]).toBe("light"); expect(t.attrs["data-theme"]).toBe("light");
    t.vc.set("auto");
    expect(t.store["vc-theme"]).toBeUndefined(); expect(t.attrs["data-theme"]).toBeUndefined();
  });
  test("garbage in storage is treated as auto", () => { expect(boot("purple").vc.get()).toBe("auto"); });
  test("blocked storage never throws; the choice still applies to the page", () => {
    const t = boot(null, { blocked: true });
    expect(t.vc.get()).toBe("auto");
    t.vc.set("dark");
    expect(t.attrs["data-theme"]).toBe("dark");
  });
});
