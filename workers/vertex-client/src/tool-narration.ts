// A weak tool-caller sometimes ANNOUNCES a tool call in prose ("(web_read đang thực hiện...)") and ends the turn with finish_reason "stop" and no tool_calls
// (measured on NIM nemotron-3.5-lightning with reasoning off: 5 of 11 runs; with `tool_choice:"required"` 8 of 8 made the call: docs/reports/toolcall-diag.md).
// Pure and free of `cloudflare:workers`: the engine uses it, tests drive it directly.
import type { Block } from "./turn-engine";
import type { ToolDef } from "./tools";
import { parseTextToolCall } from "./text-tool-call";

const MAX_NARRATION_CHARS = 800; // a real answer is longer; narration is a few lines at most
const MAX_REST_CHARS = 200; // what is left once the announcements are cut out: a short lead-in at most, never a substantive answer
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The regexes that spot an announced-but-never-made call of one of `names` (the tools offered in this request). An ACTION in progress/next only: a mere mention,
 *  a refusal ("(web_read is unavailable)") or an explanation that names a tool does not match. Empty list = nothing can be narrated. */
function patterns(names: string[]): RegExp[] {
  const ns = names.filter((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n)).map(esc);
  if (!ns.length) return [];
  const alt = ns.join("|");
  const prog = "(?:đang|dang|running|calling|executing|invoking|loading|fetching|\\.\\.\\.|…)"; // progress marker right after the tool name
  const lead = "(?:(?:tôi\\s+)?(?:sẽ|đang)\\s+(?:gọi|chạy|dùng|sử dụng)|(?:i'?ll|i\\s+will|let\\s+me)\\s+(?:now\\s+)?(?:call|use|run)|calling|running|invoking|executing|gọi)"; // "Đang gọi", "I'll call", "Calling"
  return [
    new RegExp(`\\(\\s*(?:${alt})\\s*${prog}[^)\\n]*\\)`, "giu"),                                                   // "(web_read đang thực hiện...)" / "(web_read running)"
    new RegExp(`(?<![\\p{L}\`"'“])${lead}\\s+(?:the\\s+)?(?:${alt})\\b(?:[^\\n]{0,30}?(?:\\.\\.\\.|…|\\bnow\\b|\\bngay\\b)|[ \\t]*[.!]?[ \\t]*(?=\\n|$))`, "giu"), // "Đang gọi web_read", "I'll call web_read now"
  ];
}

const REFUSAL = /(?:\bunavailable\b|\bnot\s+available\b|\bcan(?:no|')?t\s+(?:call|use|run)|\bcannot\s+(?:call|use|run)|\bunable\s+to\b|\bfailed\b|\bnot\s+able\s+to\b|không\s+khả\s+dụng|không\s+thể\s+(?:gọi|dùng|chạy|sử\s+dụng)|không\s+gọi\s+được|không\s+dùng\s+được|thất\s+bại|bị\s+lỗi)/iu;

// Phrasing varies every run ("(web_read đang ...)", "Bước 1: ... Thông qua web_read, ... Kết quả sẽ được xử lý ngay sau khi có."), so besides the exact shapes above
// a SHORT reply with no tool call counts as an announcement when a sentence names an offered tool (non-refusal), or carries a promise/progress cue AND a fetch/lookup verb. A bare ellipsis, \"Bước 1\" or \"Kết quả sẽ\" alone never does.
const PROMISE = /(?<![\p{L}\p{N}])(?:bước\s*\d+|ngay\s+sau\s+khi|kết\s+quả\s+sẽ|(?:tôi|mình|em)\s+sẽ|sẽ\s+(?:lấy|tìm|tra|truy\s*cập|kiểm\s*tra|gọi|dùng|sử\s*dụng|xem|cập\s*nhật|đọc|mở|tải|thực\s*hiện)|đang\s+(?:lấy|tìm|tra|truy\s*cập|kiểm\s*tra|gọi|dùng|sử\s*dụng|xem|cập\s*nhật|đọc|mở|tải|xử\s*lý|thực\s*hiện|chạy|chờ|đợi)|let\s+me|i'?ll|i\s+will|i\s+am\s+going\s+to|now\s+(?:fetching|searching|checking|looking|reading|loading|calling|running)|(?:fetching|searching|checking|looking\s+up|loading)[^.\n]{0,40}(?:\.\.\.|…)|one\s+moment|results?\s+(?:will|are\s+being))(?![\p{L}\p{N}])/iu;
const FETCH_VERB = /(?<![\p{L}\p{N}])(?:lấy\s+dữ\s+liệu|truy\s*cập|tra\s*cứu|tìm\s*kiếm|kiểm\s*tra|fetch(?:ing)?|look(?:ing)?\s+(?:it\s+|that\s+|this\s+)?up|retriev(?:e|ing)|check(?:ing)?|search(?:ing)?)(?![\p{L}\p{N}])/iu;
const quoted = (t: string) => t.replace(/`[^`]*`|"[^"\n]*"|“[^”\n]*”/gu, " "); // a quoted/backticked mention is the user's text or an example, not an action
const sentences = (t: string) => t.split(/(?<=[.!?…)])\s+|\n+/u).map((x) => x.trim()).filter(Boolean);

function mentions(names: string[]): RegExp | null {
  const ns = names.filter((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n)).map(esc);
  return ns.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${ns.join("|")})(?![\\p{L}\\p{N}_-])`, "iu") : null;
}
/** Is this sentence part of the announcement? The offered tool's name as a word (refusals are screened out earlier), or a promise/progress cue next to a fetch/lookup verb. */
function announces(sentence: string, named: RegExp | null): boolean {
  const s = quoted(sentence);
  return (!!named && named.test(s)) || (PROMISE.test(s) && FETCH_VERB.test(s));
}

/** A text-written tool call (one JSON object naming an offered tool, arguments valid against THAT tool's schema, at most a short lead-in): the whole reply, never a snippet inside an explanation.
 *  Only checked when the tool definitions are given (a name list alone cannot validate arguments). */
const blobCall = (text: string, defs?: ToolDef[]) => (defs?.length ? parseTextToolCall(text, defs) : null);

/** True when the reply is a short text that announces an action (an offered tool, or a "Bước 1 ... kết quả sẽ ..." progress promise) and contains no tool call and no substantive answer. */
export function narratesToolCall(blocks: Block[], names: string[], defs?: ToolDef[]): boolean {
  if (blocks.some((b) => b.type === "tool_use")) return false;
  const text = blocks.filter((b) => b.type === "text").map((b: any) => b.text as string).join("\n").trim();
  if (!text || text.length > MAX_NARRATION_CHARS) return false;
  if (!patterns(names).length && !mentions(names)) return false; // no tools offered: nothing can be narrated
  if (REFUSAL.test(text)) return false; // "Calling web_read is unavailable now": a refusal, not an announcement
  if (blobCall(text, defs)) return true; // a text-written tool call (validated, near the whole reply)
  const res = patterns(names);
  if (res.some((re) => { re.lastIndex = 0; return re.test(text); })) {
    let rest = text;
    for (const re of res) rest = rest.replace(re, "");
    if (rest.trim().length <= MAX_REST_CHARS) return true;
  }
  const named = mentions(names);
  const parts = sentences(text);
  const ann = parts.filter((p) => announces(p, named));
  if (!ann.length) return false;
  return parts.filter((p) => !ann.includes(p)).join(" ").length <= MAX_REST_CHARS; // what is left is a lead-in, not an answer
}

/** The same blocks with every announcement removed (so a saved reply never looks like a call is still running); `note` is appended as a last text block when given. */
export function withoutNarration(blocks: Block[], names: string[], note?: string, defs?: ToolDef[]): Block[] {
  const res = patterns(names);
  const out = blocks.flatMap((b): Block[] => {
    if (b.type !== "text") return [b];
    const orig0 = (b as any).text as string;
    const bc = blobCall(orig0, defs);
    const orig = bc ? bc.lead : orig0; // a validated text call: only its lead-in stays
    let t = orig;
    for (const re of res) t = t.replace(re, "");
    if (t === orig) { const named = mentions(names), parts = sentences(orig), any = parts.some((p) => announces(p, named)); t = parts.filter((p) => !announces(p, named) && !(any && PROMISE.test(quoted(p)))).join("\n"); } // a free-form announcement: drop its sentences (and its bare "kết quả sẽ ..." promise)
    t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return t ? [{ ...b, text: t } as Block] : [];
  });
  return note ? [...out, { type: "text", text: note } as Block] : out;
}

export const NARRATION_NOTE_AFTER_TOOL = "_The model did not finish its answer. Earlier tool actions in this turn may have completed; check their results before sending the message again._";
export const NARRATION_NOTE = "_The model said it would use a tool but never made the call, so nothing was fetched. Send the message again to retry._";
