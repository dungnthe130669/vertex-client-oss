// Pure client-side conversation state, driven by server frames. No DOM, no IO: unit-testable under bun.
// The live (in-flight) assistant message is rendered by the shared reducer; finished messages come from the server.
import { initial, reduce, type Event, type RenderModel, type Usage } from "../../src/reducer";
import { ackTurn, beginTurn, foldEvent, type Feed } from "./devices-logic";

export type Block = Record<string, any>;
export type Msg = {
  id: number; role: "user" | "assistant"; content: Block[]; model: string | null; usage: Usage | null; costUsd: number | null;
  stopReason: string | null; status: string; ttftMs: number | null; totalMs: number | null; retries?: number | null; createdAt: number;
  /** Auto / Retry-with: the concrete model + effort this message ran on */
  route?: { by: "auto-route" | "auto-fallback" | "manual-override" | "open-failover"; model: string; effort: "low" | "medium" | "high" | null; reason: string; fallbackFrom?: string } | null;
};
export type TurnError = { status?: number; type?: string; message?: string; retryable?: boolean; /** Open failover: model a one-click re-run would use after a partial answer failed */ continueWith?: string } | null;

export type ChatState = {
  messages: Msg[]; live: RenderModel | null; running: boolean; error: TurnError;
  title: string; model: string | null; costUsd: number; tokens: number;
  lastSeq: number; needResync: boolean; rejected: string | null; /** count of sends cancelled by the user's Stop before they started (settles the send-wait, never an error banner) */ stopped?: number; generating: boolean;
  /** While generating: "image" | "video", and the server time it started (the running card's elapsed timer). */
  genKind: string | null; genStartedAt: number | null;
  /** server clock minus client clock, from the last hello (ms): keeps the elapsed timer right on a phone with a skewed clock. */
  clockSkew: number;
  awaiting: Awaiting; compactions: Array<{ upto: number; ts: number }>;
  /** Live subagent (`delegate`) progress by tool_use id, from `subagent` events. */
  subagents: Record<string, SubagentLive>;
  /** Approval modes (src/approval.ts): this chat's mode, the hosts allowed for this chat, the "Auto-allowed ..." lines by tool_use id, and whether the admin allows Auto at all. */
  approvalMode: "ask" | "auto" | "bypass"; webGrants: string[]; autoLog: Record<string, AutoLogEntry>; approvalAuto: boolean;
  /** Device chat (Devices v2 step 3): the step-1 per-turn status machine, fed by `device_ev`; null outside a device turn. Only `turn` is used (items are dropped on every fold). */
  devFeed: Feed | null;
};
export type AutoLogEntry = { name: string; subject: string; source: "chat-grant" | "user-grant" | "mode-auto" | "mode-bypass" };
import type { SubagentLive } from "../../src/subagent-parse";
export type ApprovalCall = { id: string; name: string; input: unknown; decision: "approve" | "deny" | null; /** exact host a grant may be made for (browse tools), else null */ host?: string | null; /** the persistent "Always allow" button may be offered */ canAlways?: boolean; /** plain-words reason this call always needs a card */ reason?: string | null };
export type Awaiting = { calls: ApprovalCall[]; /** epoch ms the pending cards expire */ expiresAt?: number | null } | null;
export type ServerState = {
  seq: number; running: boolean; inflight: { fromSeq: number } | null; model: string | null; title: string; error: TurnError;
  costUsd: number; tokens: number; generating?: boolean; genKind?: string; genStartedAt?: number | null; messages: Msg[]; awaiting?: Awaiting; compactions?: Array<{ upto: number; ts: number }>;
  approvalMode?: "ask" | "auto" | "bypass"; webGrants?: string[]; autoLog?: Record<string, AutoLogEntry>; approvalAuto?: boolean;
};
export type Frame =
  | { t: "hello"; seq: number; minSeq: number; running: boolean; now: number; resync?: boolean }
  | { t: "ev"; seq: number; ts: number; e: { type: string; [k: string]: any } }
  | { t: "rejected"; error: string; code?: string; est_usd?: number } | { t: "pong" };

export const emptyChat = (): ChatState => ({ messages: [], live: null, running: false, error: null, title: "", model: null, costUsd: 0, tokens: 0, lastSeq: 0, needResync: false, rejected: null, generating: false, genKind: null, genStartedAt: null, clockSkew: 0, awaiting: null, compactions: [], subagents: {}, approvalMode: "ask", webGrants: [], autoLog: {}, approvalAuto: false, devFeed: null });

/** Seed from GET /api/conversations/:id. If a turn is in flight, replay from just before it began (idempotent by id). */
export function fromServer(s: ServerState): ChatState {
  return { ...emptyChat(), messages: s.messages, running: s.running, generating: !!s.generating && s.running,
    genKind: s.generating && s.running ? s.genKind ?? "image" : null, genStartedAt: s.generating && s.running ? s.genStartedAt ?? null : null, error: s.error, title: s.title, model: s.model, costUsd: s.costUsd, tokens: s.tokens, awaiting: s.awaiting ?? null, compactions: s.compactions ?? [], approvalMode: s.approvalMode === "auto" || s.approvalMode === "bypass" ? s.approvalMode : "ask", webGrants: s.webGrants ?? [], autoLog: s.autoLog ?? {}, approvalAuto: s.approvalAuto === true,
    lastSeq: s.inflight ? Math.max(0, s.inflight.fromSeq - 1) : s.seq, live: s.running ? initial() : null };
}

const upsert = (ms: Msg[], m: Msg) => (ms.some((x) => x.id === m.id) ? ms.map((x) => (x.id === m.id ? m : x)) : [...ms, m]);

export function applyServer(st: ChatState, f: Frame): ChatState {
  if (f.t === "rejected" && f.code === "stopped") return { ...st, stopped: (st.stopped ?? 0) + 1 };   // the user's own Stop: no red banner
  if (f.t === "rejected") return { ...st, rejected: f.error };
  if (f.t !== "hello" && f.t !== "ev") return st;
  if (f.t === "hello") return { ...st, running: f.running, needResync: !!f.resync, rejected: null, clockSkew: typeof f.now === "number" ? f.now - Date.now() : st.clockSkew };
  if (f.seq <= st.lastSeq) return st;                       // duplicate (replay overlap)
  const e = f.e; let s: ChatState = { ...st, lastSeq: f.seq };
  switch (e.type) {
    case "user_message": return { ...s, messages: upsert(s.messages, e.message), live: null, rejected: null };
    case "turn_start": { const gen = e.kind === "image" || e.kind === "video";
      return { ...s, devFeed: null, running: true, error: null, live: initial(), generating: gen, genKind: gen ? e.kind : null, genStartedAt: gen ? f.ts : null, model: gen ? s.model : e.model ?? s.model }; }
    case "assistant_saved": return { ...s, messages: upsert(s.messages, e.message), live: null };
    // "Still answering…" (busy) is only true while the turn runs: it must not outlive it (exploratory finding 20260930T054353Z-9ae57b)
    case "turn_end": return { ...s, devFeed: null, running: false, generating: false, genKind: null, genStartedAt: null, live: null, rejected: s.rejected === "busy" ? null : s.rejected, error: e.error ?? null, costUsd: e.costUsd ?? s.costUsd, tokens: e.tokens ?? s.tokens };
    case "title": return { ...s, title: e.title, costUsd: e.costUsd ?? s.costUsd, tokens: e.tokens ?? s.tokens }; // title call is real spend
    case "device_ev": { // Devices v2 step 3: hub lifecycle events of a device turn, folded by the SAME machine as the device page's status line (devices-logic.ts)
      const ev = e.e as { type?: string; cid?: string; queued?: boolean } | null; if (!ev || typeof ev.type !== "string") return s;
      let feed = s.devFeed ?? { items: [], online: false, active: false, approvals: [], resynced: false, turn: null };
      if (ev.type === "cmd_ack" && typeof ev.cid === "string") feed = ackTurn(beginTurn(feed, ev.cid, {}, f.ts), ev.cid, !!ev.queued, f.ts);
      else feed = foldEvent(feed, f.seq, ev as Record<string, unknown>, f.ts);
      return { ...s, devFeed: { ...feed, items: [] } }; // only the turn is kept: the messages themselves come from saved messages
    }
    case "tool_results": return { ...s, messages: upsert(s.messages, e.message), awaiting: null };
    case "approval_required": return { ...s, awaiting: { expiresAt: typeof e.expiresAt === "number" ? e.expiresAt : null, calls: (e.calls as Array<{ id: string; name: string; input: unknown; host?: string | null; canAlways?: boolean; reason?: string | null }>).map((c) => ({ ...c, decision: null })) } };
    case "approval_decision": return s.awaiting ? { ...s, awaiting: { ...s.awaiting, calls: s.awaiting.calls.map((c) => (c.id === e.id ? { ...c, decision: e.decision } : c)) } } : s;
    case "approval_cancelled": case "approval_expired": return { ...s, awaiting: null };
    case "approval_auto": return { ...s, autoLog: { ...s.autoLog, [String(e.id)]: { name: String(e.name), subject: String(e.subject), source: e.source } } };
    case "approval_mode": return { ...s, approvalMode: e.mode === "auto" || e.mode === "bypass" ? e.mode : "ask" };
    case "approval_grants": return { ...s, webGrants: Array.isArray(e.hosts) ? e.hosts.map(String) : s.webGrants };
    case "subagent": { const id = String(e.id ?? ""); if (!id) return s; const prev = s.subagents[id];
      return { ...s, subagents: { ...s.subagents, [id]: { persona: String(e.persona), model: String(e.model), status: e.status, task: e.task ?? prev?.task, rounds: Number(e.rounds) || prev?.rounds || 0, input_tokens: Number(e.input_tokens) || 0, output_tokens: Number(e.output_tokens) || 0, summary: e.summary ?? prev?.summary } } }; }
    case "compaction": return { ...s, compactions: [...s.compactions, { upto: e.upto, ts: f.ts }] };
    default: return { ...s, live: reduce(s.live ?? initial(), e as Event, f.ts) };
  }
}

/** Rendered blocks of a stored assistant message (thinking summarised, elapsed from the persisted _ms). */
export function thinkingMs(b: Block): number | undefined { return typeof b._ms === "number" ? b._ms : undefined; }

export const fmtCost = (usd: number | null | undefined) => (usd == null ? "–" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** Token line for one message / turn: input, output, cache read/write when present. Never a dollar amount (usage1). */
export function fmtTokenLine(c: { input: number; output: number; cacheRead: number; cacheWrite: number }): string {
  const cache = [c.cacheRead ? `cache read ${fmtTokens(c.cacheRead)}` : "", c.cacheWrite ? `cache write ${fmtTokens(c.cacheWrite)}` : ""].filter(Boolean).join(" · ");
  return `${fmtTokens(c.input + c.cacheRead + c.cacheWrite)} in / ${fmtTokens(c.output)} out${cache ? ` · ${cache}` : ""}`;
}
/** Caption under a generated image/video: media is billed per unit, not per token, so no per-item amount is shown. */
export function genCostLabel(_b: Block): string {
  return "no token count (billed per image/video)";
}

/** Why an assistant turn shows nothing: said plainly, with what to do about it. */
export function emptyAnswerNote(stop: string | null, thought: boolean): string {
  if (stop === "max_tokens") return thought ? "The model used its whole output budget thinking and returned no answer. Retry, or pick a non-reasoning model." : "The model hit its output limit before writing an answer. Retry, or pick another model.";
  return thought ? "The model finished thinking but returned no answer. Retry, or pick another model." : "The model returned an empty answer. Retry, or pick another model.";
}
