// Text -> X11 keysyms for the remote screen. Latin-1 maps to itself, everything else to the Unicode keysym range.
export const keysymOf = (ch: string): number => { const c = ch.codePointAt(0)!; return c < 0x100 ? c : 0x01000000 + c; };
export const SPECIAL: Record<string, [number, string]> = {
  Backspace: [0xff08, "Backspace"], Enter: [0xff0d, "Enter"], Tab: [0xff09, "Tab"], Escape: [0xff1b, "Escape"], Delete: [0xffff, "Delete"],
  ArrowLeft: [0xff51, "ArrowLeft"], ArrowUp: [0xff52, "ArrowUp"], ArrowRight: [0xff53, "ArrowRight"], ArrowDown: [0xff54, "ArrowDown"],
  Home: [0xff50, "Home"], End: [0xff57, "End"], PageUp: [0xff55, "PageUp"], PageDown: [0xff56, "PageDown"],
};
export type KeySink = { sendKey: (keysym: number, code: string | null, down?: boolean) => void };
/** Types a string character by character ("\n" becomes Return). */
export function typeText(rfb: KeySink, text: string) {
  for (const ch of Array.from(text)) { if (ch === "\n") rfb.sendKey(0xff0d, "Enter"); else rfb.sendKey(keysymOf(ch), null); }
}
/** Ctrl+<key> chord (e.g. Ctrl+L to focus the address bar). */
export function chord(rfb: KeySink, key: string, code: string) {
  rfb.sendKey(0xffe3, "ControlLeft", true); rfb.sendKey(keysymOf(key), code, true); rfb.sendKey(keysymOf(key), code, false); rfb.sendKey(0xffe3, "ControlLeft", false);
}
