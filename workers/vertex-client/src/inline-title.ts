// Inline chat title: on the FIRST reply of an Open chat the model is asked to START its text with `<vc-title>…</vc-title>`. A leading marker is the easiest to hide
// while streaming (buffer until it closes, or until the text proves it is not one) and gives the sidebar its title with the first token of the answer.
// Pure and free of `cloudflare:workers`: the engine uses it, tests drive it directly. Everything here fails toward "no title" (the existing auto-title call then runs).
import type { Space } from "./scope";

/** Which spaces ask for an inline title. Business stays off: its prompt bytes are pinned (golden hash). Enabling it later is this one line. */
export const INLINE_TITLE_SPACES: Record<Space, boolean> = { biz: false, open: true };
export const inlineTitleEnabled = (sp: Space): boolean => INLINE_TITLE_SPACES[sp] === true;

export const TITLE_OPEN = "<vc-title>";
export const TITLE_CLOSE = "</vc-title>";
/** Extra system block (first turn only, after the cached base prompt, so the base prefix stays byte-stable). */
export const TITLE_INSTRUCTION = `Title marker (this is the first reply of the conversation): begin your reply with exactly one line ${TITLE_OPEN}TITLE${TITLE_CLOSE}, where TITLE is a short title of at most 6 words in the same language as the user's message, plain text only (no quotes, no markdown). The app hides this line from the user. Then write your answer as normal, and never mention or repeat the marker.`;

export const MAX_HOLD = 400;      // buffered chars while waiting for the close tag; beyond that the text is not treated as a marker
const MAX_RAW_TITLE = 200; // a longer marker body is dropped (still hidden)
export const MAX_TITLE_CHARS = 60;

/** Plain-text title from a marker body: no controls/bidi/zero-width/markup/quotes, collapsed spaces, <= 60 chars. "" = unusable (malformed markup included). */
export function sanitizeInlineTitle(raw: string): string {
  if (raw.length > MAX_RAW_TITLE || raw.includes(TITLE_OPEN)) return "";
  const noHidden = raw.replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g, "").replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ");
  const noTags = noHidden.replace(/<[^<>]*>/g, " ");
  if (/[<>]/.test(noTags)) return ""; // a lone < or a missing >: malformed markup, not a title
  const t = noTags.replace(/[`*#\[\]{}"“”‘’]+/g, "").replace(/\s+/g, " ").trim().replace(/^[.:;,\-–—\s]+|[.:;,\s]+$/g, "");
  if (!t) return "";
  if (t.split(" ").length > 12) return ""; // a sentence, not a title (reasoning leaked in)
  return t.length > MAX_TITLE_CHARS ? t.slice(0, MAX_TITLE_CHARS).replace(/\s+\S*$/, "").trim() || t.slice(0, MAX_TITLE_CHARS) : t;
}

/** Remove every marker from stored/replayed assistant text: runs the same Scrub as the live stream, so saved and streamed text always agree (closed marker,
 *  unclosed marker ending at its first newline, stray closers, CRLF, leading whitespace). Used on save, on the history sent to models, and on indexing/export input. */
export function stripTitleMarkers(text: string): string {
  if (!text.includes("vc-title>")) return text;
  const sc = new Scrub(() => {});
  return sc.push(text) + sc.flush();
}

/** A stored/replayed content block without any marker. A thinking block that held one loses its signature too (the signed text no longer matches; an
 *  unsigned thinking block is dropped from what is sent to a model). */
export function scrubBlock<T extends Record<string, any>>(b: T): T {
  if (b.type === "text" && typeof b.text === "string" && b.text.includes("vc-title>")) return { ...b, text: stripTitleMarkers(b.text) };
  if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.includes("vc-title>")) {
    const { signature: _sig, ...rest } = b as any;
    return { ...rest, thinking: stripTitleMarkers(b.thinking) } as T;
  }
  return b;
}

type Ev = { type: string; [k: string]: any };

/** Incremental marker remover for one block's text: complete markers (and stray closers) never come out, a prefix that could still become a marker is held,
 *  a marker with no close tag ends at its line's newline (the answer after it is kept); one that never gets a newline, or is oversize, is dropped (never shown), the newline that ended a marker's line is eaten. */
class Scrub {
  touched = false; // a marker (or stray closer) was seen
  private buf = "";      // held tail that may still turn into a tag
  private ws = "";       // leading whitespace held until real text or a leading marker shows up
  private lead = true;   // nothing but whitespace emitted so far
  private dropping = false;
  private acc = "";
  private capped = false;  // the marker passed the cap without a closer and without a newline: drop up to the next newline
  private skipNl = false;
  constructor(private readonly onMarker: (body: string, oversize: boolean, leading: boolean) => void) {}

  private emit(t: string): string {
    if (!t) return "";
    if (this.lead) { if (!t.trim()) { this.ws += t; return ""; } const o = this.ws + t; this.ws = ""; this.lead = false; return o; }
    return t;
  }
  push(text: string): string {
    let s = this.buf + text; this.buf = ""; let out = "";
    for (;;) {
      if (this.skipNl) { s = s.replace(/^[ \t]*[\r\n]*/, ""); if (!s) return out; this.skipNl = false; }
      if (this.dropping) {
        if (this.capped) { // no closer within the cap: the marker is dropped up to the end of its first line
          const nl = s.indexOf("\n");
          if (nl < 0) return out;
          this.onMarker("", true, this.lead);
          s = s.slice(nl + 1); this.dropping = false; this.capped = false; this.skipNl = true;
          continue;
        }
        this.acc += s; s = "";
        const i = this.acc.indexOf(TITLE_CLOSE);
        const nested = i >= 0 && this.acc.slice(0, i).includes(TITLE_OPEN) && this.acc.slice(0, i).includes("\n"); // a second opener after a newline: the first was never closed
        if (i >= 0 && i <= MAX_HOLD && !nested) { // closed within the cap: a normal marker, its title may span lines
          this.onMarker(this.acc.slice(0, i), false, this.lead);
          s = this.acc.slice(i + TITLE_CLOSE.length); this.dropping = false; this.acc = ""; this.skipNl = true;
          continue;
        }
        if (!nested && this.acc.length < MAX_HOLD + TITLE_CLOSE.length) return out; // a closer may still arrive in time
        const nl = this.acc.indexOf("\n"); // cap exceeded without a closer: unclosed rule, the marker ends at its first newline
        if (nl < 0) { this.acc = ""; this.capped = true; return out; }
        this.onMarker(this.acc.slice(0, nl), nl > MAX_HOLD, this.lead);
        s = this.acc.slice(nl + 1); this.dropping = false; this.acc = ""; this.skipNl = true;
        continue;
      }
      const o = s.indexOf(TITLE_OPEN), c = s.indexOf(TITLE_CLOSE);
      const i = o < 0 ? c : c < 0 ? o : Math.min(o, c);
      if (i >= 0) {
        out += this.emit(s.slice(0, i)); this.touched = true;
        if (i === o) { this.dropping = true; this.ws = this.lead ? "" : this.ws; s = s.slice(i + TITLE_OPEN.length); }
        else s = s.slice(i + TITLE_CLOSE.length);
        continue;
      }
      let k = Math.min(s.length, TITLE_CLOSE.length - 1);
      for (; k > 0; k--) { const tail = s.slice(s.length - k); if (TITLE_OPEN.startsWith(tail) || TITLE_CLOSE.startsWith(tail)) break; }
      out += this.emit(s.slice(0, s.length - k)); this.buf = s.slice(s.length - k);
      return out;
    }
  }
  /** Block end: a held non-marker prefix is real text; an unclosed marker is dropped. */
  flush(): string {
    if (this.dropping) {
      const nl = this.capped ? -1 : this.acc.indexOf("\n"); // unclosed: ends at its first newline, what follows is the answer; no newline = nothing follows
      const rest = nl >= 0 ? this.acc.slice(nl + 1) : "";
      if (nl >= 0) this.onMarker(this.acc.slice(0, nl), false, this.lead);
      this.dropping = false; this.capped = false; this.acc = ""; this.buf = ""; this.skipNl = true;
      if (nl < 0) { this.ws = ""; return ""; }
      const o = this.push(rest); return o + this.flush();
    }
    const o = this.emit(this.buf); this.buf = "";
    const w = this.ws; this.ws = ""; return o + w;
  }
}

/** Stream filter. With `strip` on, EVERY text and thinking block of the response is scrubbed live (`feed(ev)` returns the events to relay/store), so a marker
 *  never reaches the stream, the event log or the saved message wherever the model puts it. `title` is only ever taken from a LEADING marker of the FIRST text
 *  block, and only when `allowTitle` (the first model response of the conversation); any other marker is removed and ignored. */
export class TitleStream {
  title: string | null = null;
  /** a marker (valid or not) was seen and hidden */
  sawMarker = false;
  private blocks = new Map<number, { kind: "text" | "thinking"; scrub: Scrub }>();
  private textSeen = false;
  constructor(private readonly strip: boolean, private readonly allowTitle = strip) {}

  feed(ev: Ev): Ev[] {
    if (!this.strip) return [ev];
    if (ev.type === "content_block_start") {
      const k = ev.content_block?.type;
      if (k === "text" || k === "thinking") {
        const candidate = k === "text" && !this.textSeen; if (k === "text") this.textSeen = true;
        const scrub = new Scrub((body, oversize, leading) => {
          this.sawMarker = true;
          if (!(candidate && this.allowTitle && leading && !oversize && this.title === null)) return;
          const t = sanitizeInlineTitle(body); if (t) this.title = t;
        });
        this.blocks.set(ev.index, { kind: k, scrub });
      }
      return [ev];
    }
    const h = this.blocks.get(ev.index);
    if (!h) return [ev];
    if (ev.type === "content_block_delta") {
      const d = ev.delta;
      if (h.kind === "text" && d?.type === "text_delta") return this.delta(ev, "text_delta", "text", h.scrub.push(String(d.text ?? "")));
      if (h.kind === "thinking" && d?.type === "thinking_delta") return this.delta(ev, "thinking_delta", "thinking", h.scrub.push(String(d.thinking ?? "")));
      if (h.kind === "thinking" && d?.type === "signature_delta" && h.scrub.touched) return []; // edited thinking can no longer carry its signature
      return [ev];
    }
    if (ev.type === "content_block_stop") {
      this.blocks.delete(ev.index);
      if (h.scrub.touched) this.sawMarker = true;
      const rest = this.delta(ev, h.kind === "text" ? "text_delta" : "thinking_delta", h.kind, h.scrub.flush());
      return [...rest, ev];
    }
    return [ev];
  }

  private delta(like: Ev, type: string, field: string, text: string): Ev[] { return text ? [{ type: "content_block_delta", index: like.index, delta: { type, [field]: text } }] : []; }
}
