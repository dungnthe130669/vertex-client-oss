import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// stylefix3b: a tiny cascade evaluator (specificity, then source order) over the real styles.css under the mobile media condition. It exists because appearance:none rules were beaten by later/more specific base rules (a `background` shorthand resets background-image, `padding` resets padding-right), leaving no chevron.
const CSS = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
type Rule = { media: string; sel: string; decl: [string, string][] };
const rules: Rule[] = [];
function walk(text: string, media: string) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i); if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < text.length && depth) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
    const body = text.slice(open + 1, j - 1);
    if (head.startsWith("@media")) walk(body, head);
    else if (!head.startsWith("@")) {
      const decl: [string, string][] = [];
      let d = 0, cur = "", q = "";
      for (const ch of body + ";") {
        if (q) { cur += ch; if (ch === q) q = ""; continue; }
        if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
        if (ch === "(") d++; if (ch === ")") d--;
        if (ch === ";" && d === 0) { const k = cur.indexOf(":"); if (k > 0) decl.push([cur.slice(0, k).trim().toLowerCase(), cur.slice(k + 1).trim()]); cur = ""; } else cur += ch;
      }
      for (const sel of head.split(",").map((x) => x.trim())) rules.push({ media, sel, decl });
    }
    i = j;
  }
}
walk(CSS, "");
const mobile = (m: string) => m === "" || m.includes("pointer:coarse") || m.includes("max-width:640px");

type El = { tag: string; cls: string[]; type?: string };
// Descendant-combinator selectors made of tag/.class compounds only; anything else (>, +, :, [, *) is skipped (none of those target these selects).
function matches(sel: string, chain: El[]): boolean {
  if (/[>+~:*#]|\[(?!type=\w+\])/.test(sel)) return false;
  const parts = sel.split(/\s+/).map((c) => ({ tag: /^[a-z][\w-]*/i.exec(c)?.[0], cls: [...c.matchAll(/\.([\w-]+)/g)].map((m) => m[1]), type: /\[type=(\w+)\]/.exec(c)?.[1] }));
  const ok = (p: (typeof parts)[0], e: El) => (!p.tag || p.tag === e.tag) && p.cls.every((c) => e.cls.includes(c)) && (!p.type || p.type === e.type);
  let ci = chain.length - 1;
  if (!ok(parts[parts.length - 1], chain[ci])) return false;
  for (let pi = parts.length - 2; pi >= 0; pi--) { ci--; while (ci >= 0 && !ok(parts[pi], chain[ci])) ci--; if (ci < 0) return false; }
  return true;
}
const spec = (sel: string) => { const c = (sel.match(/\.[\w-]+|\[type=\w+\]/g) ?? []).length; const t = sel.replace(/\.[\w-]+|\[[^\]]*\]/g, " ").split(/\s+/).filter((x) => /^[a-z]/i.test(x)).length; return c * 100 + t; };

function expand(prop: string, v: string): [string, string][] {
  if (prop === "padding") { const a = v.split(/\s+/); const [t, r = t, b = t, l = r] = a; return [["padding-top", t], ["padding-right", r], ["padding-bottom", b], ["padding-left", l]]; }
  if (prop === "background") return [["background-image", /url\(/.test(v) ? v : "none"], ["background-color", v]];
  if (prop === "padding-inline") return [["padding-right", v.split(/\s+/).pop()!]];
  return [[prop, v]];
}
function computed(chain: El[]): Record<string, string> {
  const win: Record<string, { s: number; o: number; v: string }> = {};
  rules.forEach((r, o) => {
    if (!mobile(r.media) || !matches(r.sel, chain)) return;
    const s = spec(r.sel);
    for (const [p, v] of r.decl) for (const [ep, ev] of expand(p, v)) { const w = win[ep]; if (!w || s > w.s || (s === w.s && o >= w.o)) win[ep] = { s, o, v: ev }; }
  });
  return Object.fromEntries(Object.entries(win).map(([k, w]) => [k, w.v]));
}
const el = (tag: string, ...cls: string[]): El => ({ tag, cls });

// Every select class found by the scan in select-appearance.test.ts, with its real ancestors.
const TARGETS: [string, El[]][] = [
  ["persona-sel in .sheet", [el("div", "scrim"), el("div", "sheet"), el("select", "persona-sel")]],
  ["dv-root in .dv-pick", [el("div", "dv-composer"), el("div", "dv-pick"), el("select", "dv-root")]],
  ["artsort", [el("div", "artbar"), el("select", "artsort")]],
  ["sfield select", [el("main", "page", "settings"), el("div", "scard"), el("div", "sfield"), el("select")]],
  ["fld select", [el("label", "fld"), el("select")]],
  ["srow select", [el("div", "srow"), el("select")]],
  ["artdiff-bar select", [el("div", "artdiff"), el("div", "artdiff-bar"), el("select")]],
];

describe("mobile select cascade: the appearance:none rule really wins (stylefix3b)", () => {
  test("evaluator sanity: dv-root resolves to appearance none", () => {
    expect(computed([el("div", "dv-pick"), el("select", "dv-root")])["appearance"]).toBe("none");
  });
  for (const [name, chain] of TARGETS) {
    test(name, () => {
      const c = computed(chain);
      expect({ name, appearance: c["appearance"] }).toEqual({ name, appearance: "none" });
      expect({ name, bg: c["background-image"] }).toEqual({ name, bg: expect.stringContaining("url(\"data:image/svg+xml") });
      expect({ name, pr: c["padding-right"] }).toEqual({ name, pr: "36px" });
      expect({ name, mh: c["min-height"] }).toEqual({ name, mh: "44px" });
    });
  }
});

// stylefix3c: the global `input{width:100%}` must not reach any checkbox/radio. The list is computed from the sources (every `<input type="checkbox|radio"`, its own class, else the nearest enclosing label/div class), not typed by hand.
import { readdirSync } from "node:fs";
const SRCDIR = new URL("../web/src/", import.meta.url);
function checkboxChains(): [string, El[]][] {
  const out: [string, El[]][] = [];
  for (const f of readdirSync(SRCDIR).filter((n) => n.endsWith(".tsx"))) {
    const text = readFileSync(new URL(f, SRCDIR), "utf8");
    for (const m of text.matchAll(/<input\b[^>]*type=(?:"|\{\s*")(checkbox|radio)"[^>]*>/g)) {
      const own = /\bclass="([^"]+)"/.exec(m[0]);
      const before = text.slice(Math.max(0, m.index! - 400), m.index!);
      const encl = [...before.matchAll(/<(label|div|li|fieldset)\b[^>]*\bclass="([^"]+)"/g)].pop();
      const chain: El[] = [];
      if (/persona|chk-/.test(encl?.[2] ?? "") && f === "subagents.tsx") chain.push(el("div", "scrim"), el("div", "sheet"));
      if (encl) chain.push(el(encl[1], ...encl[2].split(/\s+/)));
      chain.push({ ...el("input", ...(own ? own[1].split(/\s+/) : [])), type: m[1] });
      out.push([`${f}:${text.slice(0, m.index!).split("\n").length} ${encl ? "." + encl[2].split(/\s+/).join(".") : "(bare)"} > input${own ? "." + own[1] : ""}`, chain]);
    }
  }
  return out;
}
describe("checkbox/radio inputs never inherit width:100% (stylefix3c)", () => {
  const found = checkboxChains();
  test("the scan finds the known checkboxes", () => { expect(found.length).toBeGreaterThanOrEqual(5); });
  for (const [name, chain] of found) {
    test(name, () => {
      const w = computed(chain)["width"];
      expect({ name, ok: !!w && w !== "100%" }).toEqual({ name, ok: true });
    });
  }
});
