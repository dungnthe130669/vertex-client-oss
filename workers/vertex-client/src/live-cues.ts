// The ONE place that lists the "this question needs live data" cues (Vietnamese + English). Open NIM chats with web tools offered use `tool_choice:"required"`
// (restricted to the web_* tools, see turn-engine) for the FIRST model call of a turn whose user message has one of them (settings row `open_force_tool_cues`,
// default ON, '0' disables). A weak tool-caller otherwise answers from memory or only announces a call (docs/reports/toolcall-diag.md).
// STRONG cues are specific phrases; single generic words ("giá", "lịch", "now", "hôm nay") never count alone. Pure: the engine uses it, tests drive it directly.
export const LIVE_CUES_VI = ["thời tiết", "dự báo thời tiết", "tỷ giá", "tỉ giá", "tin tức", "tin mới", "mới nhất", "lịch thi đấu", "lịch chiếu"];
export const LIVE_CUES_EN = ["weather", "forecast", "news", "latest", "stock price", "exchange rate", "price of"];
// cue + qualifier patterns (regex source, already escaped)
export const LIVE_CUE_PAIRS = [
  "giá\\s+(?:vàng|xăng|dầu|bitcoin|btc|cổ\\s+phiếu|chứng\\s+khoán|usd|đô)",
  "kết\\s+quả\\s+(?:bóng\\s+đá|trận|xổ\\s+số|bầu\\s+cử)",
  "score\\s+of",
];
// A time word counts only next to one of these nouns (same message).
export const LIVE_TIME_WORDS = ["hiện tại", "right now"];
export const LIVE_TIME_NOUNS = ["nhiệt độ", "tỉ số", "tỷ số", "bitcoin", "btc", "temperature", "stock", "score", "giá", "price", "rate"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sp = (s: string) => esc(s).replace(/ /g, "\\s+");
// Unicode-aware word edges: "news" must not match inside "newsletter"-like words, "tin tức" not inside longer tokens.
const edge = (alt: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "iu");
const STRONG_RE = edge([...LIVE_CUES_VI, ...LIVE_CUES_EN].map(sp).concat(LIVE_CUE_PAIRS).join("|"));
const TIME_RE = edge(LIVE_TIME_WORDS.map(sp).join("|"));
const NOUN_RE = edge(LIVE_TIME_NOUNS.map(sp).join("|"));

export const hasLiveCue = (text: string): boolean => { const t = text.normalize("NFC"); return STRONG_RE.test(t) || (TIME_RE.test(t) && NOUN_RE.test(t)); };
