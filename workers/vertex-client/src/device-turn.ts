// Devices v2 step 3: the turn driver of a chat bound to a device. One user message -> one command to the device's hub -> follow the hub's event log until the turn ends.
// All IO is behind DeviceIO (ChatSession implements it with the DEVICES Durable Object; tests use a fake), all state changes go through ChatEngine's device* methods.
import { DeviceFolder, type Json, type Op } from "./device-env";
import type { ChatEngine } from "./turn-engine";

export type HubEvent = { seq: number; ts: number; e: Json };
export interface DeviceIO {
  /** Flag on, device is this user's own and not revoked. Called before anything is stored for the turn. */
  check(): Promise<{ ok: true; name: string; dir: string | null } | { ok: false; error: string }>;
  cmd(c: { cid: string; kind: "start" | "say" | "stop"; prompt?: string; text?: string; dir?: string }): Promise<{ ok: true; since: number; queued: boolean; dup: boolean } | { ok: false; error: string; notYourSession?: boolean }>;
  poll(since: number, waitMs: number, signal: AbortSignal): Promise<{ ok: true; events: HubEvent[]; online: boolean; gap: boolean; mine?: boolean } | { ok: false; error: "revoked" | "unavailable" | "aborted" }>;
  approve(rid: string, allow: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
}
export type DeviceTurnOpts = { pollMs?: number; maxMs?: number; now?: () => number; newCid?: () => string };
export const DEVICE_TURN_MAX_MS = 13 * 60_000; // one alarm invocation: a turn that outlives it is ended honestly (the device keeps working; the next message continues its session)

const fail = (type: string, message: string) => ({ type, message, retryable: false });

export async function runDeviceTurn(engine: ChatEngine, io: DeviceIO, text: string, o: DeviceTurnOpts = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = o.now ?? Date.now, pollMs = o.pollMs ?? 10_000, maxMs = o.maxMs ?? DEVICE_TURN_MAX_MS;
  engine.deviceExpect(true);                                           // a Stop during the async check below is remembered for this turn
  let chk: Awaited<ReturnType<DeviceIO["check"]>>;
  try { chk = await io.check(); } catch (e) { engine.deviceExpect(false); throw e; }
  if (!chk.ok) { engine.deviceExpect(false); engine.setMeta("stop_pending", null); return { ok: false, error: chk.error }; } // refused before anything is stored: no user bubble for a message that cannot run
  const b = engine.deviceBegin(text);
  engine.deviceExpect(false);
  if (!b.ok) return b;
  const { turn, signal } = b;
  const cid = (o.newCid ?? (() => `d${turn}-${crypto.randomUUID().slice(0, 12)}`))();
  const folder = new DeviceFolder(cid);
  folder.sessionActive = engine.deviceSessionActive();                // start from the persisted state: a `say` emits no session_started, and only a genuine session-ending event may clear it
  const apply = (ops: Op[]) => engine.deviceApply(turn, ops);
  const finish = async (status: "done" | "error" | "interrupted", error?: { type: string; message: string; retryable: boolean }) => {
    apply(folder.abort(status, error));                                // no-op if the fold already ended the turn; otherwise persists partial output
    await engine.deviceEnd(turn, status, error, text);
  };
  try {
    // First message of this chat's session = start (with the directory chosen at creation); while its session is still open on the device = say.
    // A Stop that arrived before dispatch (while the command waited for its alarm, or during the initial check) means nothing is sent: no prompt reaches the device.
    if (engine.deviceStopRequested) { await finish("interrupted"); return { ok: true }; }
    let kind: "start" | "say" = folder.sessionActive ? "say" : "start";
    let r = await io.cmd(kind === "say" ? { cid, kind, text } : { cid, kind, prompt: text, ...(chk.dir ? { dir: chk.dir } : {}) });
    if (!r.ok && r.notYourSession) {
      engine.setDeviceSessionActive(false); folder.sessionActive = false; kind = "start";
      if (engine.deviceStopRequested) { await finish("interrupted"); return { ok: true }; }   // no fallback start after a Stop
       r = await io.cmd({ cid, kind, prompt: text, ...(chk.dir ? { dir: chk.dir } : {}) }); // the session is gone or another chat's: start a fresh one
    }
    if (!r.ok) { await finish("error", r.error === "busy" ? fail("device_busy", "This device is being used by another chat or its device page right now. Try again when that finishes.") : fail("device_unavailable", r.error === "queue_full" ? "The device has too many waiting commands. Try again later." : "Could not reach this device. Check that it is still paired, then try again.")); return { ok: true }; }
    let since = r.since;
    engine.deviceApply(turn, [{ k: "dev", e: { type: "cmd_ack", cid, queued: r.queued } }]);
    const t0 = now();
    for (;;) {
      if (engine.deviceStopRequested) {
        await io.cmd({ cid: `${cid}s`, kind: "stop" }).catch(() => null);  // best effort: the device ends its session on its own timers otherwise
        engine.setDeviceSessionActive(false);
        await finish("interrupted"); return { ok: true };
      }
      if (now() - t0 > maxMs) { await finish("error", fail("device_timeout", "This chat stopped following the device after 13 minutes. It may still be working; send another message to continue.")); return { ok: true }; }
      const p = await io.poll(since, pollMs, signal);
      if (!p.ok) {
        if (p.error === "aborted") continue;                              // Stop woke the poll: the loop head handles it
        await finish("error", p.error === "revoked" ? fail("device_revoked", "This device was revoked. Pair it again or pick another environment.") : fail("device_unavailable", "Lost contact with the hub. The device may still be working; send another message to check."));
        return { ok: true };
      }
      { // the kill switch and the device row are re-read after EVERY successful poll, before anything is folded: a flag turned off or a device revoked mid-turn ends it within one poll, even under continuous traffic
        const c = await io.check();
        if (!c.ok) { await finish("error", fail("device_unavailable", c.error)); return { ok: true }; }
      }
      if (p.mine === false && p.events.length === 0) { await finish("error", fail("device_released", "This chat no longer holds the device session. Send another message to continue.")); return { ok: true }; } // the device was taken over (or this chat's start was cancelled) and nothing of ours is left to read
      if (p.gap) { await finish("error", fail("device_gap", "Some of the device's activity was no longer available. Send another message to continue.")); return { ok: true }; }
      for (const ev of p.events) {
        since = Math.max(since, ev.seq);
        apply(folder.feed(ev.seq, ev.e));
        if (folder.sessionActive !== engine.deviceSessionActive()) engine.setDeviceSessionActive(folder.sessionActive); // persisted AS events are folded (not only on normal completion): a restart / timeout mid-turn still knows the session is open, so the next message says
        if (folder.done) break;
      }
      if (folder.done) {
        engine.setDeviceSessionActive(folder.sessionActive);
        await engine.deviceEnd(turn, folderStatus(folder), folderError(folder), text);
        return { ok: true };
      }
    }
  } catch (e) {
    console.error("device turn", e instanceof Error ? e.message : String(e)); // never the frames: they carry the user's code and command output
    await finish("error", fail("internal_error", "Something went wrong following the device. Send another message to try again.")).catch(() => {});
    return { ok: true };
  }
}
// The fold already queued its `end` op through apply(); read it back from the folder so deviceEnd gets the same status/error.
function folderStatus(f: DeviceFolder): "done" | "error" | "interrupted" { return f.endStatus ?? "done"; }
function folderError(f: DeviceFolder) { return f.endError; }
