// Devices v2 step 3: a normal chat bound to a device environment (docs/vertex-client-devices-v2.md section 10, "Step 3 as implemented").
// Pure helpers, no IO, shared by the Worker (create-chat body), ChatSession (turn bridge) and bun tests.
//   envBody()      validate the `env` field of POST /api/conversations
//   DeviceFolder   fold the hub's ordered event stream for ONE turn into engine operations (messages, approval cards, status events, end)
//   hubEventDev()  the tiny, payload-free copy of a hub event that the page's status line needs
import { DEVICE_ID } from "./device-core";

export type Json = Record<string, unknown>;
export type Block = Record<string, any>;
export type EnvSpec = { device_id: string; dir: string | null };
// eslint-disable-next-line no-control-regex
const BAD_DIR = /[\u0000-\u001f\u007f]/;
/** Reserved for the hub-generated approval cards of a turn; raw device tool ids in this namespace are ignored. */
export const CARD_PREFIX = "dv-";
export const MAX_ENV_DIR = 1024;

/** The `env` of a create-chat body. absent / null / {kind:"cloud"} = cloud (env: null). Anything malformed is refused, never coerced into a different device or into cloud. */
export function envBody(v: unknown): { ok: true; env: EnvSpec | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, env: null };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "bad env" };
  const o = v as Json;
  if (o.kind === "cloud") return { ok: true, env: null };
  if (o.kind !== "device") return { ok: false, error: "bad env" };
  if (typeof o.device_id !== "string" || !DEVICE_ID.test(o.device_id)) return { ok: false, error: "bad env" };
  if (o.dir !== undefined && o.dir !== null && (typeof o.dir !== "string" || o.dir.length > MAX_ENV_DIR || BAD_DIR.test(o.dir))) return { ok: false, error: "bad env" };
  return { ok: true, env: { device_id: o.device_id, dir: typeof o.dir === "string" && o.dir !== "" ? o.dir : null } };
}

const ERROR_TEXT: Record<string, string> = {
  no_roots: "No directory is configured on this device. Run `vcl root add <dir>` there first.",
  dir_outside_roots: "That directory is not under a configured root on the device.",
  busy: "A session is already running on this device.",
  cmd_failed: "The device hit an error running that command.",
};
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
export const sessionErrorMessage = (e: Json) => (ERROR_TEXT[s(e.code)] ?? `Session error (${s(e.code) || "unknown"})${e.message ? `: ${s(e.message)}` : ""}`) + (e.code === "cmd_failed" && e.message ? ` (${s(e.message)})` : "");

export type Op =
  | { k: "live"; e: Json }                                                   // transient stream event (the page's live row)
  | { k: "assistant"; blocks: Block[]; stop: "tool_use" | "end_turn" }        // persist one assistant message
  | { k: "results"; blocks: Block[] }                                         // persist the tool_result message that follows it
  | { k: "dev"; e: Json }                                                     // payload-free status event for the status line
  | { k: "approval"; id: string; rid: string; tool: string; preview: string; expires_at: number }
  | { k: "approval_resolved"; id: string; rid: string; state: string }
  | { k: "end"; status: "done" | "error" | "interrupted"; error?: { type: string; message: string; retryable: boolean } };

/** Hub events that carry no user content and are the page's status line input. Others (text, tool calls, approvals) reach the page as saved messages, never through here. */
const STATUS = new Set(["cmd_sent", "cmd_acked", "session_starting", "session_started", "device_online", "device_offline", "assistant_text", "tool_use", "tool_result", "turn_done", "session_error", "session_ended", "session_stopped"]);
/** null = not for this turn's status line (another command's lifecycle event, an unknown type, anything with content). Keeps cid/cseq/code/reason/is_error/message(<=200) only. */
export function hubEventDev(e: Json, cid: string): Json | null {
  const t = s(e.type);
  if (!STATUS.has(t)) return null;
  if ((t === "cmd_sent" || t === "cmd_acked" || t === "session_starting") && typeof e.cid === "string" && e.cid !== cid) return null;
  const o: Json = { type: t };
  if ((t === "cmd_sent" || t === "cmd_acked" || t === "session_starting") && typeof e.cid === "string") o.cid = e.cid;
  if (typeof e.cseq === "number") o.cseq = e.cseq;
  if (t === "session_error") { o.code = s(e.code); if (typeof e.message === "string") o.message = e.message.slice(0, 200); }
  if (t === "device_offline" && typeof e.reason === "string") o.reason = e.reason.slice(0, 40);
  if (t === "turn_done") o.is_error = !!e.is_error;
  if (t === "tool_result") o.is_error = !!e.is_error;
  return o;
}

/** One turn's fold. Feed it every hub event with seq > the turn's start cursor, in order; it returns the engine operations to run. Events after the end are ignored (replays cannot reopen a turn). */
export class DeviceFolder {
  done = false;
  /** Set with `done`: how the turn ended (the same values as the `end` op). */
  endStatus: "done" | "error" | "interrupted" | null = null;
  endError: { type: string; message: string; retryable: boolean } | undefined;
  /** A session is open on the device (started and not ended/errored/stopped): the NEXT message of this chat is a `say`, otherwise a `start`. */
  sessionActive = false;
  private cur: Block[] = [];                       // assistant blocks not yet persisted
  private res: Block[] = [];                       // tool results not yet persisted
  private open = new Map<string, string>();        // tool_use id -> name, calls without a result yet
  private seen = new Set<string>();                // every tool_use id of this turn
  private answered = new Set<string>();           // every call that already has its result (saved or queued): a replayed result can never be saved a second time
  private appr = new Map<string, string>();        // rid -> call id
  constructor(private cid: string) {}

  private live(ops: Op[], b: Block) {
    const index = this.cur.length;
    if (b.type === "text") ops.push({ k: "live", e: { type: "content_block_start", index, content_block: { type: "text", text: "" } } }, { k: "live", e: { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } } }, { k: "live", e: { type: "content_block_stop", index } });
    else ops.push({ k: "live", e: { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } } }, { k: "live", e: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } } }, { k: "live", e: { type: "content_block_stop", index } });
  }
  private flushAssistant(ops: Op[], end: boolean) {
    if (!this.cur.length) return;
    ops.push({ k: "assistant", blocks: this.cur, stop: !end && this.cur.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" });
    this.cur = [];
  }
  private flushResults(ops: Op[]) { if (this.res.length) { ops.push({ k: "results", blocks: this.res }); this.res = []; } }
  private finish(ops: Op[], status: "done" | "error" | "interrupted", error?: { type: string; message: string; retryable: boolean }) {
    this.flushAssistant(ops, true);
    // A turn can end with calls that never got a result (Stop mid-approval, a session error, turn_done without one). Every saved call gets exactly one result, so history never keeps a call that looks like it is still running.
    const why = status === "interrupted" ? "Stopped before this finished." : status === "error" ? "Not completed: the turn ended with an error." : "No result was reported.";
    for (const id of this.open.keys()) { this.res.push({ type: "tool_result", tool_use_id: id, content: why, is_error: true }); this.answered.add(id); }
    this.open.clear();
    this.flushResults(ops);
    ops.push({ k: "end", status, ...(error ? { error } : {}) });
    this.done = true; this.endStatus = status; this.endError = error;
  }

  feed(_seq: number, e: Json): Op[] {
    if (this.done) return [];
    const ops: Op[] = [], t = s(e.type);
    const dev = hubEventDev(e, this.cid);
    if (dev) ops.push({ k: "dev", e: dev });
    switch (t) {
      case "session_started": this.sessionActive = true; break;
      case "assistant_text": {
        const text = s(e.text); if (!text) break;
        this.flushResults(ops);
        if (this.cur.some((b) => b.type === "tool_use")) this.flushAssistant(ops, false); // text after a call opens a new message
        this.live(ops, { type: "text", text }); this.cur.push({ type: "text", text });
        break;
      }
      case "tool_use": {
        const id = s(e.id); if (!id || id.startsWith(CARD_PREFIX) || this.seen.has(id)) break; // dv- is the hub's namespace (approval cards): a device-sent id there is ignored, never merged with a card
        this.flushResults(ops);
        const b = { type: "tool_use", id, name: s(e.name) || "tool", input: e.input && typeof e.input === "object" ? e.input : typeof e.input === "string" && e.input ? { preview: e.input.slice(0, 4000) } : {} };
        this.live(ops, b); this.cur.push(b); this.open.set(id, b.name); this.seen.add(id);
        break;
      }
      case "tool_result": {
        const id = s(e.id); if (id.startsWith(CARD_PREFIX) || !this.seen.has(id) || this.answered.has(id)) break; // a raw result can never close a dv- card: only approval_resolved / the turn's end do
        this.flushAssistant(ops, false);
        this.res.push({ type: "tool_result", tool_use_id: id, content: s(e.content), ...(e.is_error ? { is_error: true } : {}) });
        this.open.delete(id); this.answered.add(id);
        break;
      }
      case "approval_request": {
        const rid = s(e.rid), tool = s(e.tool); if (!rid || this.appr.has(rid)) break;
        // One card per request, bound to its request id: never matched to a tool_use by NAME (two pending same-name requests would share a card and approving one could resolve the other).
        const id = `${CARD_PREFIX}${rid}`;
        this.flushResults(ops);
        const b = { type: "tool_use", id, name: tool || "tool", input: { preview: s(e.preview).slice(0, 4000) } };
        this.live(ops, b); this.cur.push(b); this.open.set(id, b.name); this.seen.add(id);
        this.flushAssistant(ops, false);                    // the call must be a saved, visible card before the approval buttons appear on it
        this.appr.set(rid, id);
        ops.push({ k: "approval", id, rid, tool, preview: s(e.preview).slice(0, 4000), expires_at: Number(e.expires_at) || 0 });
        break;
      }
      case "approval_resolved": {
        const rid = s(e.rid), id = this.appr.get(rid); if (!id) break;
        const state = s(e.state);
        ops.push({ k: "approval_resolved", id, rid, state });
        if (this.open.has(id)) { // the card is its own call: close it with the answer so history never keeps a call that looks like it is still running
          this.flushAssistant(ops, false);
          this.res.push({ type: "tool_result", tool_use_id: id, content: state === "allowed" ? "Allowed." : state === "denied" ? "Denied." : state === "expired" ? "Expired without an answer." : "Not approved.", ...(state === "allowed" ? {} : { is_error: true }) });
          this.open.delete(id); this.answered.add(id);
        }
        break;
      }
      case "turn_done": this.finish(ops, e.is_error ? "error" : "done", e.is_error ? { type: "device_turn_error", message: "The turn ended with an error on the device.", retryable: false } : undefined); break;
      case "session_error": this.sessionActive = false; this.finish(ops, "error", { type: "device_session_error", message: sessionErrorMessage(e), retryable: false }); break;
      case "session_stopped": this.sessionActive = false; this.finish(ops, "interrupted"); break;
      case "session_ended": this.sessionActive = false; this.finish(ops, "done"); break;
    }
    return ops;
  }

  /** The caller stopped waiting (Stop, timeout, revoke): persist what exists and end with `status`. */
  abort(status: "done" | "interrupted" | "error", error?: { type: string; message: string; retryable: boolean }): Op[] {
    if (this.done) return [];
    const ops: Op[] = []; this.finish(ops, status, error); return ops;
  }
}
