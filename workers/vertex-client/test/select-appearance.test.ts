import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const CSS = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

// Flat list of {media, selectors, body} for every rule (one nesting level of @media is enough for this stylesheet).
function rules(css: string) {
  const out: { media: string; sels: string[]; body: string }[] = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const walk = (text: string, media: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i); if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body, head);
      else if (!head.startsWith("@")) out.push({ media: media, sels: head.split(",").map((s) => s.trim()), body });
      i = j;
    }
  };
  walk(src, "");
  return out;
}
const R = rules(CSS);
const isSelect = (s: string) => /\bselect$/.test(s);
const mobile = (m: string) => m.includes("pointer:coarse") || m.includes("max-width:640px");

const floored = new Set<string>();
for (const r of R) if (mobile(r.media) && /min-height:\s*44px/.test(r.body)) for (const s of r.sels) if (isSelect(s) || s === ".artsort") floored.add(s);

describe("native select sizing on mobile WebKit (stylefix2)", () => {

  test("the mobile blocks do floor some selects at 44px", () => {
    expect([...floored].sort()).toEqual([".artdiff-bar select", ".artsort", ".fld select", ".sfield select", ".srow select"]);
  });
  test("every select with the mobile 44px floor also gets appearance:none there", () => {
    for (const sel of floored) {
      const ok = R.some((r) => mobile(r.media) && r.sels.includes(sel) && /(?<![-\w])appearance:\s*none/.test(r.body) && /-webkit-appearance:\s*none/.test(r.body));
      expect({ sel, ok }).toEqual({ sel, ok: true });
    }
  });
  test("the mobile appearance:none rule keeps room for the chevron and draws one", () => {
    const r = R.find((x) => mobile(x.media) && x.sels.includes(".sfield select") && /appearance:\s*none/.test(x.body))!;
    expect(r.body).toMatch(/padding-right:\s*36px/);
    expect(r.body).toMatch(/background-image:\s*url\("data:image\/svg\+xml/);
    expect(r.body).toMatch(/background-color:/);
  });
  test("desktop base select rules do not set appearance", () => {
    for (const r of R) if (!mobile(r.media) && r.sels.some(isSelect)) expect({ sels: r.sels, a: /appearance/.test(r.body) }).toEqual({ sels: r.sels, a: false });
  });
});

// stylefix3: compute the coverage from the sources. Every native <select> in web/src/*.tsx resolves to a CSS selector (its own class, else the nearest known container class before it); that selector must carry the mobile appearance:none rule, or be on the allow-list below with a reason.
const SRC = new URL("../web/src/", import.meta.url);
const ALLOW: Record<string, string> = {
  ".imgbar select": "intentionally compact (13px / 32px) generation options in the chat composer bar; no 44px floor anywhere, so no appearance:none either",
};
const CONTAINERS = ["fld", "sfield", "srow", "artdiff-bar", "imgbar"];
const noneSels = new Set<string>();
for (const r of R) if (mobile(r.media) && /(?<![-\w])appearance:\s*none/.test(r.body) && /-webkit-appearance:\s*none/.test(r.body)) for (const s of r.sels) noneSels.add(s);

function sourceSelects(): { file: string; line: number; sel: string }[] {
  const out: { file: string; line: number; sel: string }[] = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".tsx"))) {
    const text = readFileSync(new URL(f, SRC), "utf8");
    for (const m of text.matchAll(/<select\b([^>]*)>/g)) {
      const own = /\bclass="([^"]+)"/.exec(m[1]);
      const before = text.slice(Math.max(0, m.index! - 3000), m.index!);
      let sel = "";
      if (own) sel = "." + own[1].trim().split(/\s+/)[0];
      else {
        let best = -1;
        for (const c of CONTAINERS) { const i = before.lastIndexOf(`class="${c}"`); if (i > best) { best = i; sel = `.${c} select`; } }
        if (best < 0) { // a select built by a helper defined above its container (artifacts.tsx): take the first container after it
          const after = text.slice(m.index!, m.index! + 1500); let first = Infinity;
          for (const c of CONTAINERS) { const i = after.indexOf(`class="${c}"`); if (i >= 0 && i < first) { first = i; sel = `.${c} select`; } }
          if (first === Infinity) sel = "?";
        }
      }
      out.push({ file: f, line: text.slice(0, m.index!).split("\n").length, sel });
    }
  }
  return out;
}

describe("every <select> in web/src is covered by a mobile appearance:none selector or the documented allow-list (stylefix3)", () => {
  const found = sourceSelects();
  test("the scan finds the known selects", () => {
    expect(found.length).toBeGreaterThanOrEqual(17);
    expect(found.some((s) => s.file === "subagents.tsx" && s.sel === ".persona-sel")).toBe(true);
  });
  test("no select is uncovered", () => {
    // the block may scope a selector for specificity (`.sheet .persona-sel`, `.dv-pick .dv-root`): compare on the last compound
    const last = (x: string) => x.trim().split(/\s+/).slice(-1)[0], noneLast = new Set([...noneSels].map(last));
    const bad = found.filter((s) => s.sel === "?" || !(noneSels.has(s.sel) || (!s.sel.includes(" ") && noneLast.has(s.sel)) || s.sel in ALLOW));
    expect(bad).toEqual([]);
  });
  test("a selector that has a 44px mobile floor is never parked on the allow-list", () => {
    for (const a of Object.keys(ALLOW)) expect({ a, floored: floored.has(a) }).toEqual({ a, floored: false });
  });
  test("every allow-list entry is still used by a select (no stale entries)", () => {
    for (const a of Object.keys(ALLOW)) expect({ a, used: found.some((s) => s.sel === a) }).toEqual({ a, used: true });
  });
});

describe("placeholder colour (stylefix3)", () => {
  test("inputs and textareas use the muted token, not the UA grey", () => {
    const r = R.find((x) => x.media === "" && x.sels.includes("input::placeholder") && x.sels.includes("textarea::placeholder"));
    expect(r?.body).toMatch(/color:\s*var\(--muted\)/);
    expect(r?.body).toMatch(/opacity:\s*1/);
  });
});
