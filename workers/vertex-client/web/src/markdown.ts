import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });
/** Our own images only: a same-origin path or a data: URI. Anything else (http(s), protocol-relative, ...) is remote: it would load on its own and can carry
 *  conversation data in the URL (prompt-injected exfiltration), so the model's markdown image becomes a plain link the user has to click. */
export function isLocalImageSrc(src: string): boolean {
  const s = src.trim();
  if (/^data:image\//i.test(s)) return true;
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\");
}
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
marked.use({ renderer: { image({ href, title, text }) {
  if (isLocalImageSrc(href)) return `<img src="${esc(href)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""}>`;
  return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}>${esc(text || href)}</a>`;
} } });
const MEDIA_TAGS = ["img", "video", "audio", "source", "picture", "embed", "object", "iframe", "link", "meta", "base", "area", "map", "svg", "math", "image", "use", "style", "form", "input", "button", "track"];
/** One DOMPurify config for every renderer of assistant/tool text (all go through renderMarkdown). No remote media can load: media tags are gone except <img> with a
 *  local src (hook below), and the URL-carrying attributes are stripped everywhere. `style` goes too (CSP forbids it, and it is where css url() hides). */
export const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: MEDIA_TAGS.filter((t) => t !== "img"),
  FORBID_ATTR: ["style", "srcset", "imagesrcset", "poster", "ping", "formaction", "action", "background", "lowsrc", "dynsrc", "xlink:href", "data", "codebase", "manifest"],
};
/** Installs the link/img hook on a DOMPurify instance (exported so a test can run it on an instance bound to a real DOM). */
export function installSanitizer(p: Pick<typeof DOMPurify, "addHook">) {
  p.addHook("afterSanitizeAttributes", (n) => {
    if (n.tagName === "IMG") { // raw <img> HTML in a message: same rule as the markdown renderer above
      const src = n.getAttribute("src") ?? "";
      if (!isLocalImageSrc(src)) {
        if (!/^https?:\/\//i.test(src.trim())) { n.remove(); return; } // not a link either (javascript:, ...): drop it
        const a = n.ownerDocument.createElement("a"); a.setAttribute("href", src); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer nofollow");
        a.textContent = n.getAttribute("alt") || src; n.replaceWith(a);
      }
      return;
    }
    if (n.tagName === "A") { n.removeAttribute("ping"); n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer nofollow"); return; }
    for (const attr of ["src", "href"]) n.removeAttribute(attr); // only <a href> and a local <img src> may carry an address
  });
}
if (DOMPurify.isSupported) installSanitizer(DOMPurify); // no DOM (bun tests without a registrator): nothing to hook

/** Markdown -> HTML before sanitizing (exported so the image rule is testable without a DOM). */
export function markdownToHtml(src: string): string {
  // Tables get their own horizontal scroll container so a wide one never widens the message column / page (mobile, r3 QA).
  return (marked.parse(src, { async: false }) as string).replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, "</table></div>");
}
/** Markdown -> sanitized HTML. CSP forbids inline styles, so `style` is stripped along with anything script-capable. */
export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(markdownToHtml(src), SANITIZE_CONFIG) as unknown as string;
}
