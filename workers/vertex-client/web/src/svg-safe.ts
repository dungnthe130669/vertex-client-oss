// Inline SVG gate. The picture is only ever shown as <img src=blob:> (scripts never run inside an image, the markup never enters the DOM); this is
// the second layer: refuse anything script-capable or externally-loading and fall back to the code card. REFUSE, never repair: a "cleaned" SVG
// would show something the model did not write.
export const SVG_INLINE_MAX = 256 * 1024;
export type SvgVerdict = { ok: true } | { ok: false; reason: string };

const NAMED: Record<string, string> = { colon: ":", tab: "\t", newline: "\n", lpar: "(", rpar: ")", sol: "/", quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", num: "#" };
/** Decode character references so `&#106;avascript:` / `java&Tab;script:` cannot hide from the checks below; then drop control chars and whitespace runs inside tokens. */
export function normalizeMarkup(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) { // nested encodings (&amp;#106;)
    const next = out.replace(/&#x([0-9a-f]{1,6});?/gi, (_m, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
      .replace(/&#(\d{1,7});?/g, (_m, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
      .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
    if (next === out) break; out = next;
  }
  return out.replace(/\/\*[\s\S]*?\*\//g, "").replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, " ");
}

export function checkSvg(src: string): SvgVerdict {
  if (typeof src !== "string" || !src.trim()) return { ok: false, reason: "empty" };
  if (src.length > SVG_INLINE_MAX) return { ok: false, reason: "too large" };
  if (!/<svg[\s>]/i.test(src)) return { ok: false, reason: "not an svg" };
  const t = normalizeMarkup(src);
  const squashed = t.replace(/ /g, "");
  const bad = (reason: string) => ({ ok: false, reason }) as const;
  if (/<\/?(script|iframe|object|embed|foreignobject|handler|listener|link|meta|base|frame)/i.test(squashed)) return bad("script or embedded content");
  if (/<!\s*(entity|doctype)|<\?xml-stylesheet|<!\[cdata\[[\s\S]*<script/i.test(squashed)) return bad("entity or doctype");
  if (/(^|[\s"'\/<>])on[a-z]{3,}\s*=/i.test(t)) return bad("event handler attribute");
  if (/(javascript|vbscript|livescript)\s*:/i.test(squashed)) return bad("javascript: url");
  if (/data\s*:\s*(text\/html|application\/(xhtml|xml|javascript)|image\/svg)/i.test(squashed)) return bad("data: document url");
  // href / xlink:href may only point inside the document (#id) or at an inline raster image.
  for (const m of t.matchAll(/(?:xlink\s*:\s*)?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!(v.startsWith("#") || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v))) return bad("external href");
  }
  // url(...) (fill, filter, clip-path, mask, style) must reference #id.
  for (const m of t.matchAll(/url\s*\(\s*(["']?)\s*([^)"']*)/gi)) if (!(m[2] ?? "").trim().startsWith("#")) return bad("external url()");
  if (/@\s*import/i.test(squashed)) return bad("css @import");
  if (/\bhttps?\s*:\s*\/\//i.test(t.replace(/xmlns(:\w+)?\s*=\s*(?:"[^"]*"|'[^']*')/gi, ""))) return bad("external reference");
  return { ok: true };
}

/** Completed ```svg / ```xml fences, and raw top-level `<svg ...>...</svg>` blocks outside any code fence, whose body holds an <svg. An unclosed fence or
 *  an unclosed raw <svg (still streaming) never matches. A raw block used to reach the sanitizer, which deletes every svg tag: the reply showed a blank gap. */
export type Seg = { type: "text"; text: string } | { type: "svg"; source: string } | { type: "pending" };
const FENCE = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*(svg|xml|image\/svg\+xml)[^\n]*\n([\s\S]*?)\n[ \t]{0,3}\2[`~]*[ \t]*(?=\n|$)/gi;
/** Any fence, closed or (to the end of the text) still open: raw <svg inside one is code, not a picture. */
const ANY_FENCE = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?\n[ \t]{0,3}\2[`~]*[ \t]*(?=\n|$)|[\s\S]*$)/g;
/** Raw-svg scanning is bounded: only this much of a reply is searched, so a pathological stream cannot make a re-render slow. */
export const RAW_SCAN_MAX = 1024 * 1024;
const indentCols = (line: string, from: number, to: number) => { let n = 0; for (let i = from; i < to; i++) { const ch = line[i]; if (ch === " ") n++; else if (ch === "\t") n += 4 - (n % 4); else break; } return n; };
/** Linear scan for top-level `<svg ...>...</svg>` lines: starts at a line start with up to 3 columns of indent, ends at a `</svg>` followed only by blanks to
 *  the end of the line. Openers and closers are paired in one pass with a stack, so an unclosed `<svg` (never popped) cannot swallow a later valid block;
 *  of nested qualifying pairs only the outermost is kept. */
function rawSvgBlocks(text: string, openers?: number[]): Array<{ start: number; end: number; source: string }> {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return []; // case folding changed offsets (exotic unicode): refuse rather than mis-slice
  const pairs: Array<{ start: number; end: number; source: string }> = [];
  const stack: Array<{ pos: number; ok: boolean }> = [];
  let ls = 0, nextNl = text.indexOf("\n"); // line start / next newline at or after the cursor, advanced monotonically
  for (const m of lower.matchAll(/<svg(?=[\s>]|$)|<\/svg>/g)) {
    const pos = m.index!;
    if (m[0].length > 4 && m[0][1] === "/") {
      const o = stack.pop(); if (!o || !o.ok) continue;
      let e = pos + 6; while (e < text.length && (text[e] === " " || text[e] === "\t")) e++;
      if (e < text.length && text[e] !== "\n") continue;
      pairs.push({ start: o.pos, end: e, source: text.slice(o.pos, pos + 6) });
      continue;
    }
    while (nextNl >= 0 && nextNl < pos) { ls = nextNl + 1; nextNl = text.indexOf("\n", ls); }
    let i = ls; while (i < pos && (text[i] === " " || text[i] === "\t")) i++;
    stack.push({ pos, ok: i === pos && indentCols(text, ls, pos) < 4 });
  }
  if (openers) for (const o of stack) if (o.ok) openers.push(o.pos); // still-unclosed top-level <svg (a stream in progress)
  pairs.sort((a, b) => a.start - b.start);
  const out: typeof pairs = []; let lastEnd = -1;
  for (const p of pairs) if (p.start >= lastEnd) { out.push(p); lastEnd = p.end; }
  return out;
}
/** Ranges that are code, not markup: backtick spans (which may run over lines but never across a blank line) and html <pre>...</pre> (open = to the end). */
function inlineCodeRanges(text: string, skip: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const blanks: number[] = []; for (const m of text.matchAll(/\n[ \t]*\n/g)) blanks.push(m.index!);
  const blankBetween = (a: number, b: number) => { let lo = 0, hi = blanks.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (blanks[mid]! < a) lo = mid + 1; else hi = mid; } return lo < blanks.length && blanks[lo]! < b; };
  const runs: Array<[number, number]> = []; // [pos, len] of every backtick run outside fences
  let sk = 0; // skip is sorted and disjoint, runs come in order: one moving cursor
  for (const m of text.matchAll(/`+/g)) { const p = m.index!; while (sk < skip.length && skip[sk]![1] <= p) sk++; if (!(sk < skip.length && skip[sk]![0] <= p)) runs.push([p, m[0].length]); }
  const next = new Map<number, number[]>(); // len -> indexes of runs, in order
  runs.forEach(([, l], k) => { const a = next.get(l); if (a) a.push(k); else next.set(l, [k]); });
  const used = new Set<number>(); const cursor = new Map<number, number>();
  for (let k = 0; k < runs.length; k++) {
    if (used.has(k)) continue;
    const [p, l] = runs[k]!; const q = next.get(l)!; let c = cursor.get(l) ?? 0; while (c < q.length && q[c]! <= k) c++; cursor.set(l, c);
    if (c >= q.length) continue;
    const close = runs[q[c]!]!;
    if (blankBetween(p, close[0])) continue;
    used.add(q[c]!); out.push([p, close[0] + l]);
  }
  const lower = text.toLowerCase();
  if (lower.length === text.length) for (let a = lower.indexOf("<pre"); a >= 0; a = lower.indexOf("<pre", a + 4)) {
    if (!/[\s>]/.test(text[a + 4] ?? "")) continue;
    const b = lower.indexOf("</pre>", a); if (b < 0) { out.push([a, text.length]); break; }
    out.push([a, b + 6]); a = b;
  }
  return out;
}
/** Start of a svg fence that has no closing fence yet (to the end of the text), or -1. Only ```svg / image/svg+xml, or ```xml once it holds an <svg. */
function openSvgFenceStart(text: string): number {
  let at = -1;
  for (const m of text.matchAll(ANY_FENCE)) {
    if (m.index! + m[0].length < text.length) continue; // a fence still open runs to the very end
    const body = m[0].slice(m[1]!.length);
    const closed = body.includes("\n") && new RegExp(`\\n[ \\t]{0,3}${m[2]}[\`~]*[ \\t]*$`).test(body);
    const lang = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*(svg|xml|image\/svg\+xml)\b/i.exec(body)?.[1]?.toLowerCase();
    if (!closed && lang && (lang !== "xml" || /<svg[\s>]/i.test(body))) at = m.index! + m[1]!.length;
  }
  return at;
}
/** `streaming`: a svg that is still being written (unclosed fence or raw <svg) becomes ONE `pending` segment (the rest of the text is dropped) instead of half-written markup. */
export function splitSvgFences(text: string, streaming = false): Seg[] {
  const found: Array<{ start: number; end: number; source: string }> = [];
  for (const m of text.matchAll(FENCE)) {
    if (!/<svg[\s>]/i.test(m[4]!)) continue;
    found.push({ start: m.index! + m[1]!.length, end: m.index! + m[0].length, source: m[4]! });
  }
  const fenced = [...text.matchAll(ANY_FENCE)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const scan = text.length > RAW_SCAN_MAX ? text.slice(0, RAW_SCAN_MAX) : text;
  const opens: number[] = [];
  const blocks = rawSvgBlocks(scan, opens);
  const code = blocks.length || opens.length ? [...fenced, ...inlineCodeRanges(scan, fenced)].sort((x, y) => x[0] - y[0]) : [];
  let ci = 0, reach = -1; // blocks are sorted by start: sweep the sorted ranges once, tracking the furthest end seen
  for (const b of blocks) {
    while (ci < code.length && code[ci]![0] <= b.start) reach = Math.max(reach, code[ci++]![1]);
    if (b.start >= reach) found.push(b);
  }
  found.sort((a, b) => a.start - b.start);
  let limit = text.length, pending = false;
  if (streaming) {
    const lastEnd = found.length ? found[found.length - 1]!.end : 0;
    const fenceAt = openSvgFenceStart(text);
    let at = fenceAt >= lastEnd ? fenceAt : -1;
    if (at < 0) { // raw: the first unclosed opener after the last complete picture that is not inside code
      let cj = 0, r = -1;
      for (const o of opens) { while (cj < code.length && code[cj]![0] <= o) r = Math.max(r, code[cj++]![1]); if (o >= lastEnd && o >= r) { at = o; break; } }
    }
    if (at >= 0) { limit = at; pending = true; }
  }
  // A FINISHED reply can still end inside a raw <svg (the model hit its output limit): the sanitizer deletes svg tags, so left as markdown it renders as a blank
  // bubble. Show that tail as a code block instead (the text before it stays markdown).
  let tail = -1;
  if (!streaming) {
    const lastEnd = found.length ? found[found.length - 1]!.end : 0;
    let cj = 0, r = -1;
    for (const o of opens) { while (cj < code.length && code[cj]![0] <= o) r = Math.max(r, code[cj++]![1]); if (o >= lastEnd && o >= r) { tail = o; break; } }
    if (tail >= 0) limit = tail;
  }
  const segs: Seg[] = []; let last = 0;
  for (const f of found) {
    if (f.end > limit) break;
    if (f.start < last) continue;
    if (f.start > last) segs.push({ type: "text", text: text.slice(last, f.start) });
    segs.push({ type: "svg", source: f.source }); last = f.end;
  }
  if (pending) { if (limit > last) segs.push({ type: "text", text: text.slice(last, limit) }); segs.push({ type: "pending" }); return segs; }
  if (tail >= 0) { if (limit > last) segs.push({ type: "text", text: text.slice(last, limit) }); segs.push({ type: "text", text: asCodeBlock(text.slice(tail), "xml") }); return segs; }
  if (!segs.length) return [{ type: "text", text }];
  if (last < text.length) segs.push({ type: "text", text: text.slice(last) });
  return segs;
}

/** `text` as one markdown code block (the fence is longer than any backtick run inside it). Used wherever markup would otherwise be sanitized away. */
export function asCodeBlock(text: string, lang = ""): string {
  let run = 2; // iterative max: spreading every backtick run into Math.max throws RangeError on a huge hostile reply
  for (const m of text.matchAll(/`+/g)) if (m[0].length > run) run = m[0].length;
  const f = "`".repeat(run + 1);
  return `${f}${lang}\n${text.replace(/\n+$/, "")}\n${f}`;
}
/** True when sanitized HTML shows nothing (no text, no <img>) although the source had content: the markup was stripped to nothing. */
export function htmlIsBlank(html: string): boolean {
  return !/<img[\s>]/i.test(html) && !html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "").length;
}

/** A model's svg often omits the namespace; as an image blob that fails to load. Add it on the root <svg> when absent (no other change). */
export function ensureXmlns(src: string): string {
  const m = /<svg(?=[\s>/])/i.exec(src);
  if (!m) return src;
  const nameEnd = m.index + 4;
  let i = nameEnd, q = "";
  const names: string[] = [];
  while (i < src.length) { // quote-aware scan of the root start tag: a `>` or `xmlns=` inside a quoted value is not structure
    const c = src[i]!;
    if (q) { if (c === q) q = ""; i++; continue; }
    if (c === ">") break;
    if (c === '"' || c === "'") { q = c; i++; continue; }
    if (/[^\s/=]/.test(c) && /[\s]/.test(src[i - 1] ?? " ")) { const n = /^[^\s/=>]+/.exec(src.slice(i))![0]; names.push(n.toLowerCase()); i += n.length; continue; }
    i++;
  }
  if (i >= src.length || names.includes("xmlns")) return src;
  return src.slice(0, nameEnd) + ' xmlns="http://www.w3.org/2000/svg"' + src.slice(nameEnd);
}
/** Well-formedness via DOMParser where available (absent = no verdict). The parsed tree is discarded, never inserted. */
export function wellFormed(src: string): SvgVerdict {
  if (typeof DOMParser === "undefined") return { ok: true };
  try {
    const d = new DOMParser().parseFromString(src, "image/svg+xml");
    return d.getElementsByTagName("parsererror").length ? { ok: false, reason: "not well-formed XML" } : { ok: true };
  } catch { return { ok: true }; }
}
