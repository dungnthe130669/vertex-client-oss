// In-chat search bar. Highlights with the CSS Custom Highlight API (ranges over the rendered text, no DOM mutation), so the markdown
// renderer / DOMPurify output and its event handlers are never touched. Matches inside a single text node; Esc closes.
import { useEffect, useRef, useState } from "preact/hooks";
import { IconClose, IconDown } from "./icons";
import { matchPlan, stepMatch } from "./library-logic";

type HL = { set(name: string, h: unknown): void; delete(name: string): void };
const hl = (): { reg: HL; make: (r: Range[]) => unknown } | null => {
  const reg = (globalThis.CSS as unknown as { highlights?: HL } | undefined)?.highlights;
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  return reg && H ? { reg, make: (r) => new H(...r) } : null;
};
const SKIP = "script,style,textarea,input,[hidden],.sr,.chatfind";

function textNodes(root: Element): Text[] {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest(SKIP) || !n.nodeValue?.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const out: Text[] = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
  return out;
}
const mk = (n: Text, [a, b]: [number, number]) => { const r = document.createRange(); r.setStart(n, a); r.setEnd(n, b); return r; };

/** `root` = the scrolling message list; `version` changes whenever messages render anew (re-run the search). */
export function ChatFind({ root, version, onClose }: { root: () => Element | null; version: unknown; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(-1);
  const [total, setTotal] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => { // Esc with focus elsewhere in the chat (the bar's own handler covers the input)
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  useEffect(() => () => { const h = hl(); h?.reg.delete("find"); h?.reg.delete("find-cur"); }, []);
  const paint = (idx: number) => {
    const h = hl();
    if (h) { h.reg.set("find", h.make(ranges.current)); if (idx >= 0) h.reg.set("find-cur", h.make([ranges.current[idx]])); else h.reg.delete("find-cur"); }
    if (idx >= 0) ranges.current[idx].startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "auto" });
  };
  useEffect(() => { // new query or new content: rebuild the match list, keep the position when it still exists
    const r = root();
    const nodes = r ? textNodes(r) : [];
    const { flat } = matchPlan(nodes.map((n) => n.nodeValue ?? ""), q);
    ranges.current = flat.map((m) => mk(nodes[m.node], m.range));
    setTotal(flat.length);
    const idx = flat.length ? Math.min(Math.max(cur, 0), flat.length - 1) : -1;
    setCur(idx);
    paint(idx);
  }, [q, version]);
  const step = (dir: 1 | -1) => { const i = stepMatch(cur, ranges.current.length, dir); setCur(i); paint(i); };
  return (
    <div class="chatfind" role="search" data-testid="chat-find" onKeyDown={(e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    }}>
      <input ref={input} type="search" value={q} placeholder="Find in chat" aria-label="Find in chat" data-testid="find-input" enterkeyhint="search" onInput={(e) => setQ(e.currentTarget.value)} />
      <span class="muted small num" data-testid="find-count" aria-live="polite">{q.trim() ? (total ? `${cur + 1}/${total}` : "No matches") : ""}</span>
      <button class="rbtn" type="button" aria-label="Previous match" title="Previous (Shift+Enter)" data-testid="find-prev" disabled={!total} onClick={() => step(-1)}><span class="rot"><IconDown /></span></button>
      <button class="rbtn" type="button" aria-label="Next match" title="Next (Enter)" data-testid="find-next" disabled={!total} onClick={() => step(1)}><IconDown /></button>
      <button class="rbtn" type="button" aria-label="Close search" title="Close (Esc)" data-testid="find-close" onClick={onClose}><IconClose /></button>
    </div>
  );
}
