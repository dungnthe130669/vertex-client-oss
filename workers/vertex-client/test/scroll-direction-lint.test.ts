import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

// Mobile scroll direction must stay native: no rule or handler may invert or remap vertical scrolling.
const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
const srcDir = new URL("../web/src/", import.meta.url);
const src = (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f))
  .map((f) => readFileSync(new URL(f, srcDir), "utf8")).join("\n");

describe("scroll direction stays native", () => {
  test("no reversed flex columns, vertical flips or rtl in css", () => {
    expect(css).not.toMatch(/column-reverse/);
    expect(css).not.toMatch(/scaleY\(\s*-1|scale\(\s*-1/);
    expect(css).not.toMatch(/direction\s*:\s*rtl|writing-mode/);
  });
  test("rotate(180deg) only on the find-arrow icon, never on a scroll container", () => {
    const hits = css.split("\n").filter((l) => /rotate\(180deg\)/.test(l));
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatch(/^\.chatfind \.rot\b/);
  });
  test("no scroll remapping in the web client: wheel handlers only flag, never scroll or preventDefault", () => {
    expect(src).not.toMatch(/addEventListener\(\s*["']wheel/);
    expect(src).not.toMatch(/scrollBy\(|scrollTop\s*[-+]?=\s*-/);
    const wheels = src.match(/onWheel=\{\(e\) => \{[^}]*\}\}/g) ?? [];
    expect(wheels.length).toBe(1); // chat.tsx: clears the auto-stick flag on upward wheel
    expect(wheels[0]).not.toMatch(/preventDefault|scroll(Top|To|By)/);
  });
});
