import { describe, expect, test } from "bun:test";
import { asCodeBlock, checkSvg, splitSvgFences } from "../web/src/svg-safe";

const wrap = (inner: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;
describe("checkSvg: safe", () => {
  test.each([
    wrap('<circle cx="5" cy="5" r="4" fill="#f00"/>'),
    wrap('<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect width="9" height="9" fill="url(#g)"/>'),
    wrap('<use href="#a"/><g id="a"><path d="M0 0L9 9"/></g>'),
    wrap('<use xlink:href="#a"/>', ' xmlns:xlink="http://www.w3.org/1999/xlink"'),
    wrap('<text x="1" y="5">on a mission</text>'),
    wrap('<image href="data:image/png;base64,AAAA"/>'),
    '<?xml version="1.0"?>\n' + wrap('<style>.a{fill:red}</style><rect class="a" width="3" height="3"/>'),
  ])("renders %#", (s) => expect(checkSvg(s)).toEqual({ ok: true }));
});
describe("checkSvg: hostile corpus is refused", () => {
  const hostile: Array<[string, string]> = [
    ["script", wrap("<script>alert(1)</script>")],
    ["script uppercase", wrap("<SCRIPT>alert(1)</SCRIPT>")],
    ["script spaced", wrap("<  script >1</script>")],
    ["onload attr", wrap("", ' onload="x()"')],
    ["onload slash", '<svg/onload=alert(1)>'],
    ["onclick child", wrap('<rect onclick="x()" width="1" height="1"/>')],
    ["onmouseover single quote", wrap("<g onmouseover='x()'/>")],
    ["javascript href", wrap('<a href="javascript:alert(1)"><rect/></a>')],
    ["javascript entity", wrap('<a href="&#106;avascript:alert(1)"><rect/></a>')],
    ["javascript hex entity", wrap('<a href="&#x6A;avascript:alert(1)"><rect/></a>')],
    ["javascript tab", wrap('<a href="java&Tab;script:alert(1)"><rect/></a>')],
    ["javascript newline", wrap('<a href="java\nscript:alert(1)"><rect/></a>')],
    ["http href", wrap('<image href="https://evil.example/x.png"/>')],
    ["xlink http", wrap('<image xlink:href="http://evil.example/x.png"/>')],
    ["protocol-relative", wrap('<image href="//evil.example/x.png"/>')],
    ["relative href", wrap('<image href="/api/artifacts"/>')],
    ["data html href", wrap('<a href="data:text/html;base64,PHNjcmlwdD4="><rect/></a>')],
    ["use external", wrap('<use href="https://evil.example/s.svg#a"/>')],
    ["url http", wrap('<rect fill="url(https://evil.example/p)"/>')],
    ["url quoted http", wrap('<rect style="fill:url(\'http://evil.example/p\')"/>')],
    ["url data", wrap('<rect fill="url(data:image/svg+xml;base64,AA)"/>')],
    ["css import", wrap("<style>@import url(//evil.example/a.css);</style>")],
    ["foreignObject", wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>')],
    ["iframe", wrap("<iframe src=x></iframe>")],
    ["embed", wrap("<embed src=x>")],
    ["entity decl", '<!DOCTYPE svg [<!ENTITY x "y">]>' + wrap("&x;")],
    ["bare http text ref", wrap('<desc>http://evil.example/track.gif</desc>')],
    ["css comment hiding", wrap('<rect style="fill:ur/**/l(http://e.example/x)"/>')],
    ["too large", wrap("x".repeat(300 * 1024))],
    ["not svg", "<div>hi</div>"],
    ["empty", "  "],
  ];
  test.each(hostile)("%s", (_n, s) => expect(checkSvg(s).ok).toBe(false));
});
describe("splitSvgFences", () => {
  const svg = '<svg viewBox="0 0 1 1"><rect/></svg>';
  test("finds closed svg and xml fences with an <svg body", () => {
    const segs = splitSvgFences(`Here:\n\n\`\`\`svg\n${svg}\n\`\`\`\n\nand\n\n\`\`\`xml\n${svg}\n\`\`\`\nbye`);
    expect(segs.map((s) => s.type)).toEqual(["text", "svg", "text", "svg", "text"]);
    expect((segs[1] as any).source).toBe(svg);
  });
  test("a streaming (unclosed) fence is left as text", () => { expect(splitSvgFences(`x\n\`\`\`svg\n${svg}`)).toEqual([{ type: "text", text: `x\n\`\`\`svg\n${svg}` }]); });
  test("xml fence without <svg, and other languages, are not touched", () => {
    const t = "```xml\n<note/>\n```\n\n```js\nconst a = '<svg>'\n```";
    expect(splitSvgFences(t)).toEqual([{ type: "text", text: t }]);
  });
});

describe("splitSvgFences: raw svg scanning", () => {
  const svg = wrap('<circle r="4"/>');
  test("20000 repeated unclosed <svg blocks scan in linear time", () => {
    const t = "<svg width=1>\n".repeat(20000);
    const t0 = performance.now(); const segs = splitSvgFences(t); const ms = performance.now() - t0;
    expect(segs).toEqual([{ type: "text", text: asCodeBlock(t, "xml") }]); expect(ms).toBeLessThan(50);
  });
  test("20000 closers followed by junk also stay fast", () => {
    const t = "<svg>x</svg> y\n".repeat(20000);
    const t0 = performance.now(); splitSvgFences(t); expect(performance.now() - t0).toBeLessThan(50);
  });
  test("a raw block still becomes a picture, with text around it", () => {
    expect(splitSvgFences(`hi\n${svg}\nbye`)).toEqual([{ type: "text", text: "hi\n" }, { type: "svg", source: svg }, { type: "text", text: "\nbye" }]);
  });
  test("raw <svg inside backtick spans (multiline too), indented code and <pre><code> stays code", () => {
    for (const t of [`see \`a\n${svg}\nb\` ok`, `\`\`${"x"}\n${svg}\n\`\``, `para\n\n    ${svg}\n`, `<pre><code>\n${svg}\n</code></pre>`, `<pre>\n${svg}\n`])
      expect(splitSvgFences(t)).toEqual([{ type: "text", text: t }]);
  });
  test("an unrelated stray backtick before a block does not hide it", () => {
    expect(splitSvgFences(`it's a ` + "`" + `tick\n\n${svg}`).some((s) => s.type === "svg")).toBe(true);
  });
});

import { ensureXmlns, wellFormed } from "../web/src/svg-safe";
describe("streaming: an unfinished svg is one pending segment, never partial markup", () => {
  const pend = (t: string) => splitSvgFences(t, true);
  test("unclosed raw <svg", () => {
    expect(pend('Here:\n<svg viewBox="0 0 1 1"><rect w')).toEqual([{ type: "text", text: "Here:\n" }, { type: "pending" }]);
    expect(pend("<svg")).toEqual([{ type: "pending" }]);
    expect(pend('<svg xmlns="x"><g></svg')).toEqual([{ type: "pending" }]);
  });
  test("unclosed ```svg fence (and xml once it holds <svg)", () => {
    expect(pend("ok\n```svg\n<svg><rect")).toEqual([{ type: "text", text: "ok\n" }, { type: "pending" }]);
    expect(pend("```svg\n")).toEqual([{ type: "pending" }]);
    expect(pend("```xml\n<svg><g>")).toEqual([{ type: "pending" }]);
    expect(pend("```xml\n<?xml version")).toEqual([{ type: "text", text: "```xml\n<?xml version" }]);
  });
  test("the closing tag/fence turns it into the picture; closed non-svg fences and code stay text", () => {
    const raw = wrap("<rect/>");
    expect(pend(`a\n${raw}`).map((s) => s.type)).toEqual(["text", "svg"]);
    expect(pend("```svg\n" + raw + "\n```").map((s) => s.type)).toEqual(["svg"]);
    expect(pend("```python\nx\n```")).toEqual([{ type: "text", text: "```python\nx\n```" }]);
    expect(pend("```md\n<svg><g>").map((s) => s.type)).toEqual(["text"]); // inside an open non-svg fence = code
    expect(pend("use `<svg` tags")).toEqual([{ type: "text", text: "use `<svg` tags" }]);
  });
  test("a complete picture followed by a new unfinished one", () => {
    expect(pend(`${wrap("<g/>")}\nmore\n<svg><circ`).map((s) => s.type)).toEqual(["svg", "text", "pending"]);
  });
  test("non-streaming behaviour is unchanged", () => {
    expect(splitSvgFences("<svg><rect", false)).toEqual([{ type: "text", text: "```xml\n<svg><rect\n```" }]); // cut off: code block (the sanitizer would blank it)
  });
});
describe("ensureXmlns / wellFormed", () => {
  test("adds xmlns only when the root lacks it", () => {
    expect(ensureXmlns('<svg viewBox="0 0 1 1"><g/></svg>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g/></svg>');
    expect(ensureXmlns("<svg><g/></svg>")).toBe('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>');
    const ok = wrap("<g/>"); expect(ensureXmlns(ok)).toBe(ok);
    expect(ensureXmlns("<svg xmlns:xlink='a' xmlns='http://www.w3.org/2000/svg'/>")).toContain("xmlns='http");
    expect(ensureXmlns("no svg")).toBe("no svg");
  });
  test("root tag is parsed quote-aware: `>` and `xmlns=` inside attribute values are not structure", () => {
    expect(ensureXmlns('<svg title="a>b"><g/></svg>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" title="a>b"><g/></svg>');
    expect(ensureXmlns('<svg data-x="xmlns=1"><g/></svg>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" data-x="xmlns=1"><g/></svg>');
    expect(ensureXmlns('<svg title=\'x xmlns="u"\'/>')).toContain(' xmlns="http://www.w3.org/2000/svg" title');
    const real = '<svg title="a>b" xmlns="http://www.w3.org/2000/svg"/>'; expect(ensureXmlns(real)).toBe(real);
    expect(ensureXmlns("<svg title='unclosed")).toBe("<svg title='unclosed");
  });
  test("an unclosed svg is plain text once the stream is over (non-streaming), one placeholder only while streaming", () => {
    const t = "intro\n<svg viewBox='0 0 1 1'><circle r='1'/> trailing words";
    expect(splitSvgFences(t, false)).toEqual([{ type: "text", text: "intro\n" }, { type: "text", text: "```xml\n" + t.slice(6) + "\n```" }]); // aborted / truncated: nothing hidden, shown as code
    expect(splitSvgFences(t, true).at(-1)).toEqual({ type: "pending" });
  });
  test("no DOMParser = no verdict", () => { expect(wellFormed("<svg>").ok).toBe(true); });
});
