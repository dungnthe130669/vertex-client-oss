// Plain-text and pure helpers for approval modes (cards, composer chip, Settings list). No DOM: unit-tested under bun.
import type { AutoLogEntry } from "./chat-state";

export const AUTO_CONFIRMED_KEY = "vc.auto-approval-confirmed";
export const AUTO_TITLE = "Turn on Auto for this chat?";
export const AUTO_BODY = "Auto lets the assistant open web pages without asking you each time. It applies only to this chat and stays on until you switch back to Ask. It never covers saving, changing, deleting or sending anything, spending money or changing credentials: those always ask. Every automatic action shows a line in the chat.";
export const EXPIRY_MS = 30 * 60_000;

/** "Auto-allowed web_read example.com - by your setting". */
export const autoLine = (e: AutoLogEntry): string => `${e.source === "mode-bypass" ? "Bypass" : "Auto"}-allowed ${e.name} ${e.subject} - by your setting`;
export const SOURCE_NOTE: Record<AutoLogEntry["source"], string> = { "chat-grant": "allowed for this chat", "user-grant": "always allowed", "mode-auto": "Auto mode", "mode-bypass": "Bypass mode" };

/** "Expires in 12 min" / "Expires in under a minute" / "Expired"; null when the server sent no deadline. */
export function expiryNote(expiresAt: number | null | undefined, now: number): string | null {
  if (typeof expiresAt !== "number") return null;
  const left = expiresAt - now;
  if (left <= 0) return "Expired";
  const m = Math.ceil(left / 60_000);
  return m <= 1 ? "Expires in under a minute" : `Expires in ${m} min`;
}

export type Mode = "ask" | "auto" | "bypass";
export type Bi = { en: string; vi: string };
export const BYPASS_CONFIRMED_KEY = "vc.bypass-approval-confirmed";
export { BYPASS_CONFIRM_VERSION } from "../../src/approval";
export const BYPASS_TITLE: Bi = { en: "Turn on Bypass for this chat?", vi: "Bật chế độ Bypass cho cuộc chat này?" };
/** Plain words: what Bypass skips, what still asks. The two lists are separate paragraphs so a screen reader reads them as two things. */
export const BYPASS_SKIPS: Bi = {
  en: "Bypass stops asking before the assistant opens web pages (including links with a query string from search results), runs the built-in read-only note and task lookups you set to Ask, and saves a note or task before any web page was read in this chat.",
  vi: "Bypass sẽ không hỏi lại khi trợ lý mở trang web (kể cả liên kết có dấu ? lấy từ kết quả tìm kiếm), chạy các công cụ tra cứu ghi chú/công việc chỉ-đọc có sẵn mà bạn đặt là Hỏi, và lưu ghi chú/công việc khi cuộc chat chưa đọc trang web nào.",
};
export const BYPASS_STILL_ASKS: Bi = {
  en: "It still always asks before deleting anything, sending something out, spending money, changing credentials or permissions, using a custom connector tool, opening an IP address, local or unusual address, saving or changing anything after a web page was read, or following a link that redirects. A web page can contain hidden instructions; Bypass gives them a bigger reach, so use it only for chats you trust. It applies to this chat only, has no timer, is not copied to a fork, and every automatic action shows a line in the chat.",
  vi: "Bypass vẫn luôn hỏi trước khi xóa, gửi thông tin ra ngoài, chi tiền, đổi khóa/quyền, dùng công cụ kết nối tùy chỉnh, mở địa chỉ IP, địa chỉ nội bộ hoặc cổng lạ, lưu hay sửa gì sau khi đã đọc trang web, hoặc theo liên kết bị chuyển hướng. Trang web có thể chứa lệnh ẩn; Bypass làm chúng đi xa hơn, nên chỉ dùng cho cuộc chat bạn tin tưởng. Chỉ áp dụng cho cuộc chat này, không có hẹn giờ, không sao chép sang nhánh, và mỗi hành động tự động đều hiện một dòng trong chat.",
};
export const MODE_INFO: Record<Mode, { label: Bi; desc: Bi }> = {
  ask: { label: { en: "Ask", vi: "Hỏi" }, desc: { en: "Ask before each web page after one was read (default).", vi: "Hỏi trước mỗi trang web sau khi đã đọc một trang (mặc định)." } },
  auto: { label: { en: "Auto", vi: "Tự động" }, desc: { en: "Open ordinary web pages without asking. Everything else still asks.", vi: "Mở trang web thông thường không cần hỏi. Mọi thứ khác vẫn hỏi." } },
  bypass: { label: { en: "Bypass", vi: "Bypass" }, desc: { en: "Also skip the cards Auto still shows. Delete, send, money, credentials and unusual addresses always ask.", vi: "Bỏ luôn các thẻ mà Tự động vẫn hiện. Xóa, gửi, tiền, khóa và địa chỉ lạ luôn hỏi." } },
};
export const chipLabel = (mode: Mode): string => MODE_INFO[mode].label.en;
export const chipAria = (mode: Mode): string => `Tool approvals: ${MODE_INFO[mode].label.en}. Change mode`;
/** The picker shows when the admin allows Auto/Bypass, or when this chat is already in one (so it can always be switched off). */
export const chipVisible = (o: { hasChat: boolean; approvalAuto: boolean; mode: Mode }): boolean => o.hasChat && (o.approvalAuto || o.mode !== "ask");
/** Which modes the picker offers: Ask always; Auto and Bypass only while the admin switch allows them (the current one is always listed so it can be left). */
export const offeredModes = (o: { approvalAuto: boolean; mode: Mode }): Mode[] => (["ask", "auto", "bypass"] as Mode[]).filter((m) => m === "ask" || o.approvalAuto || m === o.mode);

export const fmtDate = (ms: number | null | undefined): string => (ms ? new Date(ms).toISOString().slice(0, 10) : "never");
