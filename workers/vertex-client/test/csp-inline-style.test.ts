import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// stylefix3: the CSP is `style-src 'self'` (no unsafe-inline). WebKit reports `el.style.cssText = ...`, `setAttribute("style", ...)` and a STRING `style="..."` prop (Preact applies it with style.cssText) as style-src-attr violations (docs/reports/webkit3.md). Object style props (`style={{ ... }}`) and CSSOM property writes are fine.
const SRC = new URL("../web/src/", import.meta.url);
const files = readdirSync(SRC).filter((n) => /\.(tsx?|jsx?)$/.test(n));
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const PATTERNS: [string, RegExp][] = [
  ["cssText assignment", /\bcssText\b/],
  ["setAttribute('style')", /setAttribute\(\s*["'`]style["'`]/],
  ["string style= prop", /\bstyle=(?:"|'|\{\s*["'`])/],
  ["insertAdjacentHTML/innerHTML carrying style=", /(?:innerHTML|insertAdjacentHTML)[^\n]*style\s*=/],
];
// Legitimate exceptions go here as `file:pattern` with a reason. Empty on purpose.
const ALLOW: Record<string, string> = {};

describe("no CSP-violating inline style in web/src", () => {
  test("scans the source files", () => { expect(files.length).toBeGreaterThan(20); });
  for (const [name, re] of PATTERNS) {
    test(`none of: ${name}`, () => {
      const hits: string[] = [];
      for (const f of files) {
        strip(readFileSync(new URL(f, SRC), "utf8")).split("\n").forEach((l, i) => { if (re.test(l) && !ALLOW[`${f}:${name}`]) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`); });
      }
      expect(hits).toEqual([]);
    });
  }
  test("the pattern set does catch the old shapes (sanity)", () => {
    expect(PATTERNS.every(([, re]) => !!re)).toBe(true);
    expect(PATTERNS[0][1].test("p.style.cssText = `a:b`")).toBe(true);
    expect(PATTERNS[2][1].test('<h1 style="flex:1">')).toBe(true);
    expect(PATTERNS[2][1].test("<h1 style={{ flex: 1 }}>")).toBe(false);
  });
});
