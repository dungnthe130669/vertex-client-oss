// Web Push for a device "approval_request" when nobody is watching (docs/vertex-client-vcl-protocol.md). Pure + injectable so the hub stays thin:
// the hub passes the real `pushTo`, tests pass a recorder. Opt-in is the same as every other push: the owner's stored subscriptions (Settings -> Notifications);
// there is no per-category toggle in this app, so none is added. Never throws: a failed push must not touch the approval flow.
import { isE2eBase } from "./scope";
import type { PushPayload, PushResult } from "./push";

export const PUSH_DEBOUNCE_MS = 10_000;
const PATHLIKE = /^(?:~|\.{0,2})?\/?(?:[\w.@+-]+\/)+[\w.@+-]+$/; // a/b/c, /a/b, ~/a/b, ./a/b — one token, no spaces, no "//" prefix

/** The only part of the request's preview that may leave the Worker: the basename of a path-looking FIRST token (never the rest: that can be file contents or a command line). */
export function previewBase(preview: string): string {
  const tok = preview.trimStart().split(/\s/, 1)[0] ?? "";
  if (tok.length === 0 || tok.length > 300 || tok.startsWith("//") || !PATHLIKE.test(tok)) return "";
  return tok.split("/").pop()!.slice(0, 60);
}

export function approvalPayload(deviceId: string, deviceName: string, rid: string, tool: string, preview: string): PushPayload {
  const base = previewBase(preview);
  const name = deviceName.replace(/\s+/g, " ").trim().slice(0, 40) || "Device";
  const t = tool.replace(/\s+/g, " ").trim().slice(0, 40);
  const detail = base ? ` (${base})` : "";
  return { title: "Approval needed", body: `${name}: ${t}${detail}`, url: `/dv/${deviceId}`, tag: rid };
}

export type PushDeps = {
  flagOn: () => Promise<boolean>;
  deviceName: () => Promise<string>;
  /** Re-checked after the awaits: answered/expired in the meantime means nothing is sent. */
  pending: () => boolean;
  /** Re-checked right before the push: a visible PWA socket that appeared during the awaits means the toast covers it. */
  unwatched?: () => boolean;
  push: (p: PushPayload) => Promise<Pick<PushResult, "sent" | "failed" | "errors">>;
  /** Notifications center: called for every live approval request (also when watched, debounced or e2e), never throws into the flow. */
  record?: (p: PushPayload) => Promise<void>;
};
/** `watching` = a PWA socket is connected AND visible. `lastPushMs` = when this device last pushed (0 = never). Returns true when a push was attempted (the caller then records the time). */
export async function pushApprovalRequest(
  a: { scope: string; deviceId: string; rid: string; tool: string; preview: string; expiresAt: number; nowMs: number; watching: boolean; lastPushMs: number },
  d: PushDeps,
): Promise<boolean> {
  try {
    if (a.expiresAt * 1000 <= a.nowMs) return false;                              // expired before we got here
    if (!(await d.flagOn())) return false;
    const name = await d.deviceName().catch(() => "");
    if (!d.pending()) return false;
    const p = approvalPayload(a.deviceId, name, a.rid, a.tool, a.preview);
    await d.record?.(p).catch((e) => console.error("device notification", e instanceof Error ? e.message : String(e)));
    if (!d.pending()) return false;                              // answered/expired while the record was being written
    if (a.watching || (d.unwatched && !d.unwatched()) || isE2eBase(String(a.scope))) return false;       // a visible PWA gets the toast instead; the e2e user never reaches Erich's phone
    if (a.nowMs - a.lastPushMs < PUSH_DEBOUNCE_MS) return false;                  // at most 1 push per device per 10 s
    const r = await d.push(p);
    if (r.failed || r.errors.length) console.error("device push", r.errors[0] ?? "failed");
    return true;
  } catch (e) { console.error("device push", e instanceof Error ? e.message : String(e)); return false; }
}
