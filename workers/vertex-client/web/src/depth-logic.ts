// Pure helpers for the chat-depth features (starters, scroll pinning, message copy, info sheet). No DOM, no IO: unit-tested under bun.
import type { Msg } from "./chat-state";

export type Starter = { title: string; text: string };
/** The four tappable cards on an empty chat: short titles, varied intent (explain, write, plan, debug). They only fill the composer. */
export const starterCards = (): Starter[] => [
  { title: "Explain something", text: "Explain how DNS resolution works, step by step, as if I were new to networking." },
  { title: "Draft a message", text: "Help me write a short, friendly email asking a colleague for a status update." },
  { title: "Plan my week", text: "Help me plan a focused week: ask me about my goals and commitments first." },
  { title: "Debug some code", text: "I have a bug. I'll paste the code and the error; walk me through finding the cause." },
];

/** Scroll pinning while a reply streams: re-pin only when the reader is (nearly) at the bottom; unpin the moment they scroll up.
 *  Content growing under a stationary reader fires no scroll-up, so it never unpins and never yanks a reader who left. */
export const PIN_PX = 24;
export function nextStick(prev: boolean, el: { scrollHeight: number; scrollTop: number; clientHeight: number }, lastTop: number): boolean {
  if (el.scrollHeight - el.scrollTop - el.clientHeight < PIN_PX) return true;
  return el.scrollTop < lastTop ? false : prev;
}

/** Markdown source of an assistant message: its text blocks only (thinking and tool calls are not part of the answer). */
export const msgMarkdown = (m: Pick<Msg, "content">): string => m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");

/** Plain text of the same (markdown syntax kept readable, fences dropped): what "Select text" shows. */
export const msgPlain = (m: Pick<Msg, "content">): string => msgMarkdown(m).replace(/^```[\w+#.-]*\n?/gm, "").replace(/^```$/gm, "").trim();

/** "2026-10-21 09:15:00" (D1, UTC) -> a locale string; unreadable input comes back as given. */
export function fmtWhen(s: string | undefined, locale?: string): string {
  if (!s) return "—";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}
