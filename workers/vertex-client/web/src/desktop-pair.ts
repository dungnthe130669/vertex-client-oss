import { withBusy } from "./busy";
import { createPairing, type Pairing } from "./devices-api";
import { pairLimitMessage } from "./devices-logic";
import { installId } from "./install-id";

/** "Add this device" inside the desktop shell (design 3.2): mint a code with the normal call, hand it to the ONE native command, which asks the user natively. */
export type ShellInvoke = (cmd: string, args: { code: string }) => Promise<unknown>;
export type PairOutcome = { ok: true } | { ok: false; message: string; cancelled?: boolean };

/** Tauri injects `__TAURI_INTERNALS__.invoke` into pages of the app window; a browser or installed PWA has none. */
export function shellInvoke(w: object | undefined = typeof window === "undefined" ? undefined : window): ShellInvoke | null {
  const inv = (w as { __TAURI_INTERNALS__?: { invoke?: unknown } } | undefined)?.__TAURI_INTERNALS__?.invoke;
  return typeof inv === "function" ? (inv as ShellInvoke).bind((w as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__) : null;
}

/** Fixed wording for the codes `pair_this_mac` returns (src-tauri `PairError::code`); anything unknown is the generic text, never the raw value. */
const NATIVE_TEXT: Record<string, string> = {
  "not-running": "vcl is not installed or not running on this computer. Install and start vcl first, then try again.",
  "already-paired": "This computer is already paired. Revoke it here first, or run vcl unpair on this computer, to pair it again.",
  "code-refused": "The code was refused. Try again.",
  "rate-limited": "Too many attempts. Wait a few minutes, then try again.",
  "invalid-code": "Could not use that code. Try again.",
  "wrong-origin": "This page is not allowed to add this device.",
};
export const GENERIC_PAIR_ERROR = "Could not add this device. Try again.";
export const CANCELLED_TEXT = "Cancelled. Nothing was changed.";

export const nativePairMessage = (e: unknown): string => (typeof e === "string" && Object.hasOwn(NATIVE_TEXT, e) ? NATIVE_TEXT[e] : GENERIC_PAIR_ERROR);

/** The code lives in this call's local variable only: not stored, not logged, not in a URL, not in any message shown. */
export async function addThisDevice(invoke: ShellInvoke | null = shellInvoke(), mint: () => ReturnType<typeof createPairing> = () => createPairing(installId())): Promise<PairOutcome> {
  if (!invoke) return { ok: false, message: "This works only in the Vertex Client desktop app." };
  const r = await withBusy("add-this-device", async () => {
    const m = await mint().catch(() => null);
    if (!m) return { fail: GENERIC_PAIR_ERROR } as const;
    if (m.status !== 201 || !m.data?.code) return { fail: m.status === 429 ? pairLimitMessage(m.retryAfter) : m.status === 409 ? "Device limit reached, revoke one first." : GENERIC_PAIR_ERROR } as const;
    const p: Pairing = m.data;
    try { await invoke("pair_this_mac", { code: p.code }); return { done: true } as const; }
    catch (e) { return { err: e } as const; }
  });
  if ("done" in r) return { ok: true };
  if ("err" in r) return r.err === "cancelled" ? { ok: false, message: CANCELLED_TEXT, cancelled: true } : { ok: false, message: nativePairMessage(r.err) };
  return { ok: false, message: r.fail };
}
