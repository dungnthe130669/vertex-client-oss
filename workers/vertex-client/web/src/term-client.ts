// Device terminal, app side (vclterm5): the frame client / state machine. No DOM, no xterm: the pane gives it a `sink` and a `send`.
// Contract: docs/vcl-term-hub-api.md (app <-> hub) and vcl-term-frames.md (device). Terminal payload is never stored or logged here.
import { newCid } from "./devices-logic";

export const LABEL_SANDBOX = "Restricted folders, not a vault";
export const LABEL_UNKNOWN = "Terminal mode not confirmed yet.";
export const LABEL_OPEN = "Unrestricted: this shell can read your whole account";
export const HARNESS_NOTE = "A coding assistant you run here talks to its own provider (not Vertex). Files it reads can be sent there under your own account and terms.";
export const PASTE_CHUNK = 45_000;           // raw bytes per term_in => <= 60 000 base64 chars, under the hub's 64 KB limit
export const ACK_EVERY = 32 * 1024;          // device pauses at 128 KB unacked, resumes under 32 KB
export const ACK_MS = 100;
export const STOP_GRACE_MS = 5000;
export const PENDING_MAX = 4096;           // chars of input kept while the shell is still opening

export type Phase = "idle" | "opening" | "live" | "ended";
export type Mode = "sandbox" | "open";
export type TermState = { phase: Phase; cid?: string; sid?: string; mode?: Mode; root?: string; adopted?: boolean; consumed: number; acked: number; notice?: string; endMsg?: string; errorCode?: string; relogin?: boolean };
export type Sink = { write: (b: Uint8Array, done: () => void) => void; reset: () => void; note: (s: string) => void };
type Send = (f: Record<string, unknown>) => boolean;

export const b64enc = (u: Uint8Array): string => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
export const b64dec = (s: string): Uint8Array => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
/** Typed text or a paste -> frames of at most PASTE_CHUNK raw bytes each (order preserved). */
export function chunkInput(text: string): string[] {
  const u = new TextEncoder().encode(text), out: string[] = [];
  for (let i = 0; i < u.length; i += PASTE_CHUNK) out.push(b64enc(u.subarray(i, i + PASTE_CHUNK)));
  return out;
}

/** Plain-words message for a term_error code. `relogin` = the user must log in again; `off` = the device toggle is off. */
export function errorMessage(code: string): { text: string; relogin?: boolean } {
  switch (code) {
    case "login_required": return { text: "For safety, log in again to open a terminal.", relogin: true };
    case "terminal_off": return { text: "Turn on “Allow terminal” on the device: run  vcl set terminal on" };
    case "unsupported": case "no_cap": return { text: "This computer cannot run the terminal. Nothing was opened." };
    case "limit": return { text: "A terminal is already open on this device (one at a time)." };
    case "offline": return { text: "The device is offline. Start vcl on it and try again." };
    case "root_not_allowed": case "bad_root": return { text: "That folder is not allowed on the device. Pick another folder." };
    case "open_timeout": return { text: "The device did not answer. Try again." };
    case "rate_limit": return { text: "Too much input too fast; some of it was dropped." };
    case "forbidden": return { text: "This terminal belongs to another account." };
    case "spawn_failed": return { text: "The device could not start a shell." };
    default: return { text: `The terminal could not start (${code}).` };
  }
}
/** Plain-words message for a term_exit. Hub-originated ends carry signal idle|device_lost|disabled|revoked; the device sends reason idle|closed|disconnect|daemon_exit. */
export function exitMessage(f: { code?: unknown; signal?: unknown; reason?: unknown }): string {
  const sig = typeof f.signal === "string" ? f.signal : "", rs = typeof f.reason === "string" ? f.reason : "";
  if (sig === "idle" || rs === "idle") return "Closed after 30 minutes without typing.";
  if (sig === "device_lost" || rs === "disconnect") return "The device went offline, so the shell was closed.";
  if (sig === "disabled") return "The terminal was turned off.";
  if (sig === "revoked") return "This device was revoked.";
  if (rs === "daemon_exit") return "vcl on the device stopped, so the shell was closed.";
  if (sig === "gone") return "That terminal no longer exists.";
  if (rs === "closed") return "Terminal stopped.";
  return typeof f.code === "number" ? `Shell exited (code ${f.code}).` : "Shell ended.";
}

export class TermSession {
  st: TermState = { phase: "idle", consumed: 0, acked: 0 };
  private pending = ""; // keystrokes typed while opening (bounded), flushed in order when the shell is ready, dropped if the open fails
  private recv = 0; // end offset of the last byte handed to the screen (dedupe + re-attach point); `consumed` trails it until xterm's write callback
  private timer: ReturnType<typeof setTimeout> | undefined; private stopT: ReturnType<typeof setTimeout> | undefined;
  constructor(private send: Send, private sink: Sink, private onChange: (s: TermState) => void = () => {}) {}
  private set(p: Partial<TermState>) { this.st = { ...this.st, ...p }; this.onChange(this.st); }

  open(root: string, cols: number, rows: number): boolean {
    if (this.st.phase === "opening" || this.st.phase === "live") return false;
    const cid = newCid();
    this.sink.reset();
    this.pending = ""; this.recv = 0; this.st = { phase: "opening", cid, consumed: 0, acked: 0 }; this.onChange(this.st);
    if (!this.send({ t: "term_open", cid, root, cols: clamp(cols, 1, 500), rows: clamp(rows, 1, 200) })) { this.set({ phase: "ended", endMsg: "Not connected: try again in a moment.", cid: undefined }); return false; }
    return true;
  }
  /** Keystrokes / paste. Dropped (false) unless a session is live. */
  input(text: string): boolean {
    if (this.st.phase === "opening" && text) { if (this.pending.length + text.length <= PENDING_MAX) { this.pending += text; return true; } return false; } // typed between Start and the shell being ready: kept in order, sent on term_ready (B3)
    const sid = this.st.sid; if (this.st.phase !== "live" || !sid || !text) return false;
    let ok = true; for (const data of chunkInput(text)) ok = this.send({ t: "term_in", sid, data }) && ok;
    return ok;
  }
  resize(cols: number, rows: number) { const sid = this.st.sid; if (this.st.phase === "live" && sid) this.send({ t: "term_resize", sid, cols: clamp(cols, 1, 500), rows: clamp(rows, 1, 200) }); }
  /** Stop: ask the device to kill the shell; if no term_exit arrives in a few seconds, end locally. */
  stop() {
    const sid = this.st.sid; if (!sid || this.st.phase === "ended" || this.st.phase === "idle") return;
    this.send({ t: "term_close", sid });
    clearTimeout(this.stopT); this.stopT = setTimeout(() => { if (this.st.phase === "live") this.end("Terminal stopped."); }, STOP_GRACE_MS);
  }
  /** The app socket (re)connected: a live session re-attaches from the last byte this client rendered. */
  onLinkLive() {
    const sid = this.st.sid; if (this.st.phase !== "live" || !sid) return;
    this.send({ t: "term_attach", sid, lastSeq: this.recv });
  }
  dispose() { clearTimeout(this.timer); clearTimeout(this.stopT); }

  /** Feed every term_* frame from the hub. Returns true if it was a terminal frame. */
  onFrame(f: Record<string, any>): boolean {
    switch (f.t) {
      case "term_ready":
        if (this.st.phase !== "opening" || f.cid !== this.st.cid || typeof f.sid !== "string") return true; // stale / foreign
        this.set({ phase: "live", sid: f.sid, mode: f.mode === "sandbox" ? "sandbox" : "open", errorCode: undefined, endMsg: undefined });
        { const p = this.pending; this.pending = ""; if (p) this.input(p); }
        return true;
      case "term_out": return this.out(f);
      case "term_gap":
        if (f.sid !== this.st.sid) return true;
        this.sink.reset();
        { const from = typeof f.from === "number" ? f.from : this.recv; this.recv = from; this.st = { ...this.st, consumed: from, acked: from }; }
        this.set({ notice: f.reason === "rate_limit" ? "Output was too fast; some of it was skipped and the screen was redrawn." : "Some earlier output is no longer available; the screen was redrawn from what is left." }); return true;
      case "term_exit":
        if (f.sid !== this.st.sid) return true;
        this.end(exitMessage(f)); return true;
      case "term_error": {
        const mine = f.cid ? f.cid === this.st.cid && this.st.phase === "opening" : f.sid === this.st.sid;
        if (!mine) return true;
        const code = String(f.error ?? "error"), m = errorMessage(code);
        if (this.st.phase === "opening") this.pending = "";
        if (this.st.phase === "opening") this.set({ phase: "ended", cid: undefined, errorCode: code, endMsg: m.text, relogin: !!m.relogin });
        else this.set({ notice: m.text, errorCode: code }); // an in-session error (rate_limit) does not end the shell
        return true;
      }
      case "term_state": return this.adopt(f);
      case "term_caps": return true; // handled by the screen (tab visibility)
    }
    return false;
  }
  /** The hub says a session of ours is already running (a page of ours died without Stop, or Start met it): show it and re-attach from byte 0 (the device replays its ring or answers term_gap). */
  private adopt(f: Record<string, any>): boolean {
    if (typeof f.sid !== "string") return true;
    if (this.st.phase === "live" && this.st.sid === f.sid) return true;      // already showing it (onLinkLive re-attaches from the last byte)
    this.sink.reset(); this.recv = 0; clearTimeout(this.timer); this.timer = undefined;
    this.st = { phase: "live", sid: f.sid, mode: f.mode === "sandbox" ? "sandbox" : "open", root: typeof f.root === "string" ? f.root : undefined, adopted: true, consumed: 0, acked: 0 };
    this.onChange(this.st);
    this.send({ t: "term_attach", sid: f.sid, lastSeq: 0 });
    return true;
  }
  private out(f: Record<string, any>): boolean {
    if (f.sid !== this.st.sid || this.st.phase !== "live" || typeof f.data !== "string" || typeof f.seq !== "number") return true;
    let b: Uint8Array; try { b = b64dec(f.data); } catch { return true; }
    const end = f.seq + b.length;
    if (end <= this.recv) return true;                                // replay overlap: already handed to the screen
    const chunk = f.seq < this.recv ? b.subarray(this.recv - f.seq) : b; // partial overlap: only the new tail
    this.recv = end;
    this.sink.write(chunk, () => { this.st = { ...this.st, consumed: Math.max(this.st.consumed, end) }; this.ackSoon(); });
    return true;
  }
  /** Ack = bytes the screen has actually consumed (after xterm's write callback): immediately every 32 KB, else within 100 ms. */
  private ackSoon() {
    const sid = this.st.sid; if (!sid || this.st.phase !== "live") return;
    if (this.st.consumed - this.st.acked >= ACK_EVERY) return this.flushAck();
    if (!this.timer) this.timer = setTimeout(() => this.flushAck(), ACK_MS);
  }
  private flushAck() {
    clearTimeout(this.timer); this.timer = undefined;
    const sid = this.st.sid; if (!sid || this.st.phase !== "live" || this.st.consumed <= this.st.acked) return;
    if (this.send({ t: "term_ack", sid, seq: this.st.consumed })) this.st = { ...this.st, acked: this.st.consumed };
  }
  private end(msg: string) { this.pending = ""; clearTimeout(this.timer); clearTimeout(this.stopT); this.timer = undefined; this.set({ phase: "ended", endMsg: msg, sid: undefined, cid: undefined }); }
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n) || lo));

/** Banner for the session mode. Only a CONFIRMED sandbox session says "restricted"; unknown mode (idle/opening, before term_ready) never over-claims (Windows has no folder confinement). */
export const bannerFor = (mode: Mode | undefined): { text: string; tone: "ok" | "warn" } => mode === "sandbox" ? { text: LABEL_SANDBOX, tone: "ok" } : mode === "open" ? { text: LABEL_OPEN, tone: "warn" } : { text: LABEL_UNKNOWN, tone: "warn" };

/** Extra-key bar for phones: what each key sends, Ctrl as a one-shot modifier. */
export const KEYS: { id: string; label: string; seq: string }[] = [
  { id: "esc", label: "Esc", seq: "\x1b" }, { id: "tab", label: "Tab", seq: "\t" },
  { id: "up", label: "↑", seq: "\x1b[A" }, { id: "down", label: "↓", seq: "\x1b[B" }, { id: "left", label: "←", seq: "\x1b[D" }, { id: "right", label: "→", seq: "\x1b[C" },
  { id: "pipe", label: "|", seq: "|" }, { id: "tilde", label: "~", seq: "~" }, { id: "slash", label: "/", seq: "/" },
];
/** Apply a one-shot Ctrl to the next typed character: Ctrl+letter -> control code. Anything else passes unchanged. */
export function withCtrl(ctrl: boolean, data: string): string {
  if (!ctrl || data.length < 1) return data;
  const c = data[0].toUpperCase().charCodeAt(0);
  return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) + data.slice(1) : data;
}
