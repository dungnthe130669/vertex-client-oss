// "Something is in flight" registry: a screen marks itself busy while a turn / stream / upload runs or a draft exists,
// so the update flow never reloads the page under it.
const keys = new Set<string>();
export function setBusy(key: string, on: boolean) { if (on) keys.add(key); else keys.delete(key); }
export const busyCount = () => keys.size;

let seq = 0;
/** Hold a unique busy key for the whole of a browser+server transaction (released in finally, even on throw). */
export async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const k = `tx:${label}:${++seq}`;
  setBusy(k, true);
  try { return await fn(); } finally { setBusy(k, false); }
}

/** A sent WS message is "pending" from the same tick as send() until the server accepts/rejects it (or the safety timeout). */
export const PENDING_SEND_MS = 30_000;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
export function markSendPending(ms = PENDING_SEND_MS) {
  setBusy("chat-send", true);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => setBusy("chat-send", false), ms);
}
export function clearSendPending() { clearTimeout(pendingTimer); pendingTimer = undefined; setBusy("chat-send", false); }
/** Frames that settle a pending send: acceptance (turn_start / user_message), rejection, or a state snapshot (hello). */
export function settlesSend(f: { t: string; e?: { type?: string } }): boolean {
  return f.t === "rejected" || f.t === "hello" || (f.t === "ev" && (f.e?.type === "turn_start" || f.e?.type === "user_message"));
}
