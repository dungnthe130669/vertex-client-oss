import { clearSendPending, markSendPending, setBusy, settlesSend, withBusy } from "./busy";
import { WebApprovalNote, webCallUrl } from "./web-approval";
import { ApprovalButtons, ApprovalChip, AutoLine, BypassSheet, GrantsLine } from "./approval-chip";
import { AUTO_BODY, AUTO_CONFIRMED_KEY, AUTO_TITLE, BYPASS_CONFIRMED_KEY, BYPASS_CONFIRM_VERSION, chipVisible, type Mode as ApMode } from "./approval-logic";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useContext } from "preact/hooks";
import { IconSearch, IconAlert, IconAttach, IconBack, IconCheck, IconCompose, IconChevron, IconChevronDown, IconCopy, IconDown, IconCode, IconFile, IconImage, IconMore, IconTable, IconPlus, IconSend, IconSpark, IconStop, IconTool, IconTrash, IconChat, IconVideo, IconClose } from "./icons";
import { type ConvRow, type GenModel, type Model, type Uploaded, type VideoModel, getGenModels, getVideoModels, getSlash, uploadFile, createConversation, deleteConversation, forkConversation, fileUrl, getConversation, getModels, listConversations } from "./api";
import { priceHint, turnRetryNote, speedHint, waitNote } from "./model-speed";
import { ChatSocket, type ConnStatus } from "./chat-client";
import { type ApprovalCall, type AutoLogEntry, type Block, type ChatState, type Msg, applyServer, emptyAnswerNote, emptyChat, fmtTokenLine, fmtTokens, fromServer, genCostLabel, thinkingMs } from "./chat-state";
import { estimate, fmtEstimate, fmtVideoEstimate, needsConfirm, normalizeCount, GEN_CONFIRM_USD_DEFAULT } from "../../src/gen-cost";
import { fmtElapsed, videoOptions } from "./video-opts";
import { renderMarkdown } from "./markdown";
import { errorToast, toast } from "./toast";
import { awayFromBottom, canStop, HINT_IMAGE_MODEL, pickHintImageModel, showImageHint, composerBlock, connNotice, decorateCode, dragHasFiles, editDraft, enterAction, escStops, lastUserId, loadDraft, loadNewChatDraft, newChatKey, noticeFor, resendFor, saveDraft, sendModel } from "./chat-ux";
import { ConfirmSheet, useEscape } from "./confirm";
import { ChatItem } from "./chat-item";
import { EnvBanner, EnvChip, useDeviceList, useLiveEnv } from "./chat-env";
import { type EnvInfo, defaultChoice, dirFor, envBlock, envChoices } from "./chat-env-logic";
import { inDesktopShell } from "./desk-logic";
import { ListBar } from "./header";
import { ChatFind } from "./chat-find";
import { EditSheet, MsgActions, SelectSheet } from "./msg-actions";
import { ConvInfo } from "./conv-info";
import { AUTO_ID, type Effort, retryChoices, routeLabel, shortModel, takesEffort, withAuto } from "./auto-ui";
import { msgMarkdown, msgPlain, nextStick, starterCards } from "./depth-logic";
import { ChatHeaderMenu, onConvEdit } from "./chat-menu";
import { createPortal } from "preact/compat";
import { useAppbar, useAppbarTitle } from "./appbar-store";
import { hasOpen } from "./space-ui";
import { MenuButton, MeCtx, NEW_CHAT_EVENT, newChat } from "./drawer";
import { FailoverNote, OpenEmpty, SpaceChip } from "./space-ui";
import { getSpace, switchSpace } from "./space";
import { editRow, splitPinned } from "./shell-logic";
import { type DraftFile, type FirstFrame, firstFrameText, greeting, ackPendingFirst, claimNewChatDraft, clearNewChatDraft, lazyStart, newChatDraft, peekPendingFirst, setPendingFirst, shouldSendPending } from "./shell-logic";
import { useNickname } from "./profile";
import { ArtifactCard } from "./artifact-card";
import { parseImageToolResult } from "../../src/image-tool-parse";
import { DELEGATE_TOOL, delegationTotals, parseDelegateResult, type SubagentLive } from "../../src/subagent-parse";
import { InlineSvg, SvgPending } from "./svg-inline";
import { asCodeBlock, htmlIsBlank, splitSvgFences } from "./svg-safe";
import { parseArtifactResult } from "./artifacts-logic";
import { chipKind, refusalFor, prepareFile, tokensLabel } from "./upload";
import { MicButton, cameraWanted } from "./composer-extras";
import { useVoice } from "./voice";
import { NativeBar, VoiceBar } from "./voice-bar";
import { ContextSheet, MODE_LABEL, ModeIcon } from "./composer-sheet";
import { usePromptItems, useInsertPromptRequest, resolvePrompt } from "./prompts";
import { insertPrompt } from "./prompts-logic";
import { advisorAlias, loadRecent, pushRecent, slashQuery, slashRows, type SlashItem } from "../../src/slash";
import { costChip } from "../../src/reducer";
import type { RenderModel } from "../../src/reducer";
import type { ComponentChild } from "preact";

export const go = (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); };
export const useRoute = () => {
  const [p, setP] = useState(location.pathname);
  useEffect(() => { const f = () => setP(location.pathname); addEventListener("popstate", f); return () => removeEventListener("popstate", f); }, []);
  return p;
};

/** Completed ```svg fences become an inline picture (InlineSvg); everything else, and any still-open fence, is ordinary markdown. */
function Md({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const segs = useMemo(() => splitSvgFences(text, streaming), [text, streaming]);
  if (segs.length === 1 && segs[0]!.type === "text") return <MdText text={text} />;
  let n = 0;
  return <>{segs.map((s) => (s.type === "text" ? (s.text.trim() ? <MdText text={s.text} /> : null) : s.type === "pending" ? <SvgPending key="svgpending" /> : <InlineSvg key={`svg${n++}`} source={s.source} title="SVG image" />))}</>;
}
function MdText({ text }: { text: string }) {
  // markup the sanitizer strips to nothing (e.g. a raw <svg> in an odd position) must still show as code, never as an empty bubble
  const html = useMemo(() => { const h = decorateCode(renderMarkdown(text)); return text.trim() && htmlIsBlank(h) ? decorateCode(renderMarkdown(asCodeBlock(text))) : h; }, [text]);
  const onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest?.("[data-copy]") as HTMLElement | null;
    const code = btn?.closest(".codeblock")?.querySelector("pre")?.textContent;
    if (!btn || code == null) return;
    void navigator.clipboard?.writeText(code).then(() => { btn.textContent = "Copied"; toast("Copied"); setTimeout(() => { btn.textContent = "Copy"; }, 1600); }, () => { btn.textContent = "Copy failed"; });
  };
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} onClick={onClick} />;
}

const secs = (ms?: number) => (ms === undefined ? "" : ` ${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);

/** Hidden per-message token chip (e2e counts these; no $ shown); the visible per-turn summary lives in TurnFooter. */
function Chip({ m }: { m: Msg }) {
  if (!m.usage) return null;
  const c = costChip(m.usage);
  return <div class="chip sr" data-testid="msg-cost">{fmtTokenLine(c)} · cache {Math.round(c.cacheHitRatio * 100)}%{m.ttftMs != null ? ` · ${(m.ttftMs / 1000).toFixed(1)}s first token` : ""}</div>;
}

const textOf = (m: Msg) => m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
/** Auto controls on the last answer: `on` = the conversation is in Auto; `onRetryWith` regenerates this turn on a chosen concrete model/effort (the conversation keeps Auto); `onPin` leaves Auto for this model. */
type AutoCtl = { on: boolean; onRetryWith?: () => void; onPin: (model: string) => void };
function TurnFooter({ turn, results, onRegenerate, actions, auto }: { turn: Msg[]; results: Map<string, Result>; onRegenerate?: () => void; actions?: ComponentChild; auto?: AutoCtl }) {
  const [copied, setCopied] = useState(false);
  const route = [...turn].reverse().find((m) => m.route)?.route ?? null;
  const last = turn[turn.length - 1];
  const interrupted = last.status === "interrupted";
  const tok = turn.reduce((a, m) => { if (!m.usage) return a; const c = costChip(m.usage); return { input: a.input + c.input, output: a.output + c.output, cacheRead: a.cacheRead + c.cacheRead, cacheWrite: a.cacheWrite + c.cacheWrite }; }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const ttft = turn.find((m) => m.ttftMs != null)?.ttftMs;
  const retried = turnRetryNote(turn);
  // children's tokens: the turn's own delegate calls, read from their stored tool results (tool_result messages are not part of `turn`)
  const uses = turn.flatMap((m) => m.content).filter((b) => b.type === "tool_use" && b.name === DELEGATE_TOOL);
  const subs = delegationTotals([{ content: uses }, { content: uses.map((b) => ({ type: "tool_result", tool_use_id: b.id, content: results.get(b.id as string)?.text })) }]);
  const copy = () => void navigator.clipboard?.writeText(turn.map(textOf).filter(Boolean).join("\n\n")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => {});
  return (
    <div class="turn-foot">
      <button class="ghost" type="button" aria-label="Copy answer" onClick={copy}>{copied ? <IconCheck /> : <IconCopy />}<span>{copied ? "Copied" : "Copy"}</span></button>
      {onRegenerate && <button class="ghost" type="button" aria-label="Regenerate answer" data-testid="regenerate" onClick={onRegenerate}><IconCompose /><span>Regenerate</span></button>}
      {auto?.onRetryWith && <button class="ghost" type="button" aria-label="Retry with another model" data-testid="retry-with" onClick={auto.onRetryWith}><IconSpark /><span>Retry with…</span></button>}
      {auto?.on && route && route.by !== "manual-override" && <button class="ghost" type="button" aria-label={`Pin this model (${shortModel(route.model)}) for this conversation`} data-testid="pin-model" onClick={() => auto.onPin(route.model)}><IconCheck /><span>Pin this model</span></button>}
      {actions}
      {route && <span class="chip auto-label" data-testid="auto-label">{routeLabel(route)}</span>}
      {!interrupted && turn.some((m) => m.usage) && (
        <details class="turn-meta"><summary>Details</summary>
          <div class="small muted num">{fmtTokenLine(tok)}{ttft != null ? ` · ${(ttft / 1000).toFixed(1)}s first token` : ""}{turn.length > 1 ? ` · ${turn.length} steps` : ""}{retried ? ` · ${retried}` : ""}</div>
          {route && <div class="small muted" data-testid="auto-reason">{route.by === "manual-override" ? "Chosen by you on this message; the conversation setting is unchanged." : `Why: ${route.reason}`}</div>}
          {subs.count > 0 && <div class="small muted num" data-testid="turn-subagents">subagents: {subs.count} · {fmtTokens(subs.input)} in / {fmtTokens(subs.output)} out</div>}
        </details>)}
    </div>
  );
}

const DENIED = "The user denied this action";
type Result = { text: string; isError: boolean };
const resultsById = (ms: Msg[]) => {
  const out = new Map<string, Result>();
  for (const m of ms) if (m.role === "user") for (const b of m.content) if (b.type === "tool_result") out.set(b.tool_use_id, { text: typeof b.content === "string" ? b.content : JSON.stringify(b.content), isError: !!b.is_error });
  return out;
};
const short = (v: unknown, n = 160) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; };
const pretty = (n: string) => { const s = n.replace(/[_-]+/g, " ").trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const argSummary = (input: unknown) => {
  if (input && typeof input === "object") for (const v of Object.values(input as Record<string, unknown>)) if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").slice(0, 80);
  return "";
};
const fieldStr = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function Field({ k, v }: { k: string; v: unknown }) {
  const [all, setAll] = useState(false);
  const s = fieldStr(v) ?? "";
  const long = s.length > 200 || s.split("\n").length > 4;
  return <div class="field"><dt>{k.replace(/_/g, " ")}</dt><dd class={long && !all ? "clamp" : ""}>{s}{long && <button type="button" class="linkish" onClick={() => setAll(!all)}>{all ? "Show less" : "Show all"}</button>}</dd></div>;
}

const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** Collapsible card for a `delegate` call: persona, model, task, status, TOKENS only (no per-item cost), and the returned summary. Live data from `subagent` events while running; the stored tool result afterwards. */
function SubagentCard({ b, result, live }: { b: Block; result?: Result; live?: SubagentLive }) {
  const done = result ? parseDelegateResult(DELEGATE_TOOL, result.text) : null;
  const inp = (b.input ?? {}) as { persona?: string; task?: string };
  const status = done ? (done.subagent.status === "ok" ? "done" : "error") : result ? "error" : live?.status === "error" ? "error" : live?.status === "done" ? "done" : live?.status === "queued" ? "queued" : "running";
  const persona = done?.subagent.persona ?? live?.persona ?? String(inp.persona ?? "subagent");
  const model = done?.subagent.model ?? live?.model ?? "";
  const tin = done?.subagent.input_tokens ?? live?.input_tokens ?? 0, tout = done?.subagent.output_tokens ?? live?.output_tokens ?? 0;
  const summary = done?.summary ?? (result ? result.text : live?.summary ?? "");
  const label = { queued: "queued", running: "running", done: "done", error: "error" }[status];
  return (
    <details class={`tool subagent ${status === "done" ? "ok" : status}`} data-testid="subagent-card" data-status={status}>
      <summary><span class="t-ic"><IconTool /></span><span class="t-main"><span class="tname" data-testid="subagent-title">{persona === "advisor" ? `advisor · ${/opus|sonnet|haiku/.exec(model)?.[0] ?? (model || "advisor")}` : `subagent · ${persona}`}</span>{inp.task && <span class="t-arg">{String(inp.task).replace(/\s+/g, " ").slice(0, 80)}</span>}</span><span class={`t-stat ${status === "done" ? "ok" : status}`}>{status === "running" && <i class="spin" />}{label}</span><span class="t-chev"><IconChevron /></span></summary>
      <div class="t-body">
        <dl class="fields">
          <div class="field"><dt>persona</dt><dd data-testid="subagent-persona">{persona}</dd></div>
          {model && <div class="field"><dt>model</dt><dd data-testid="subagent-model">{model}</dd></div>}
          {inp.task && <div class="field"><dt>task</dt><dd class="pre" data-testid="subagent-task">{String(inp.task)}</dd></div>}
          <div class="field"><dt>tokens</dt><dd class="num" data-testid="subagent-tokens">{tok(tin)} in · {tok(tout)} out</dd></div>
        </dl>
        {summary && <div class="field"><dt>summary</dt><dd class="pre" data-testid="subagent-summary">{summary}</dd></div>}
      </div>
    </details>
  );
}

function ToolCard({ b, result, call, onDecide, convId, onOpenImage, live, autoEntry, expiresAt }: { live?: SubagentLive; b: Block; result?: Result; call?: ApprovalCall; onDecide: (id: string, d: "approve" | "deny", grant?: "once" | "chat" | "user") => void; convId: string; onOpenImage: (b: Block) => void; autoEntry?: AutoLogEntry; expiresAt?: number | null }) {
  if (b.name === DELEGATE_TOOL) return <SubagentCard b={b} result={result} live={live} />;
  const art = result && !result.isError ? parseArtifactResult(b.name, result.text) : null;
  if (art) return <ArtifactCard {...art} />;
  // generate_image: the picture shows inline like an Image-mode result (same figure, same open/lightbox actions), stored in Library.
  const img = result && !result.isError ? parseImageToolResult(b.name, result.text) : null;
  if (img) { const gb = { type: "gen_image", ...img, cost_usd: img.cost_usd, est_usd: img.est_usd } as unknown as Block; return <GenImage convId={convId} b={gb} onOpen={() => onOpenImage(gb)} />; }
  const pending = call && !call.decision;
  const state = pending ? "awaiting" : (call?.decision === "deny" || (result?.isError && result.text.startsWith(DENIED))) ? "declined" : result ? (result.isError ? "error" : "ok") : "running";
  const label = { awaiting: "needs approval", declined: "declined", error: "error", ok: "done", running: "running" }[state];
  const webUrl = pending ? webCallUrl(b.name, b.input) : null;
  const fields = (b.input && typeof b.input === "object" ? Object.entries(b.input as Record<string, unknown>) : []).filter(([k]) => !(webUrl !== null && k === "url")); // shown in full below
  const sum = argSummary(b.input);
  return (<>
    {autoEntry && <AutoLine e={autoEntry} />}
    <details class={`tool ${state}`} open={!!pending} data-testid="tool-card">
      <summary><span class="t-ic"><IconTool /></span><span class="t-main"><span class="tname">{b.name}</span>{sum && <span class="t-arg">{sum}</span>}</span><span class={`t-stat ${state}`}>{state === "running" && <i class="spin" />}{label}{state === "declined" && <span class="sr"> (Denied)</span>}</span><span class="t-chev"><IconChevron /></span></summary>
      <div class="t-body">
        {webUrl !== null && <WebApprovalNote url={webUrl} />}
        {fields.length > 0 && <dl class="fields">{fields.map(([k, v]) => <Field k={k} v={v} />)}</dl>}
        {pending && <ApprovalButtons id={b.id} host={call?.host ?? null} canAlways={call?.canAlways === true} reason={call?.reason ?? null} expiresAt={expiresAt} onDecide={onDecide} />}
        {call?.decision && !result && <div class="muted small">{call.decision === "approve" ? "Approved — running…" : "Declined"}</div>}
        <details class="small raw"><summary class="muted">Details</summary><div class="pre muted">{short(b.input, 600)}</div></details>
        {result && <details class="small"><summary class="muted">Result</summary><div class="pre muted">{short(result.text, 1500)}</div></details>}
      </div>
    </details>
  </>);
}

const Thought = ({ b }: { b: Block }) => b.thinking
  ? <details class="think"><summary><span>Thought{secs(thinkingMs(b)).replace(/^ /, " for ")}</span><span class="t-chev"><IconChevron /></span></summary><div class="muted small pre">{b.thinking}</div></details>
  : <div class="think none muted small">Thought{secs(thinkingMs(b)).replace(/^ /, " for ")}</div>;

function GenImage({ convId, b, onOpen }: { convId: string; b: Block; onOpen: () => void }) {
  return (
    <figure class="genimg" data-testid="gen-image">
      <button type="button" class="fopen" aria-label="Open generated image" onClick={onOpen}><img src={fileUrl(convId, String(b.ref))} alt={String(b.prompt ?? "Generated image")} loading="lazy" /></button>
      <figcaption class="muted small num" data-testid="gen-cost">{genCostLabel(b)} · {String(b.model)}</figcaption>
    </figure>
  );
}

/** Inline player: Range-served authed URL, metadata-only preload (no poster), playsinline for iOS; plus a download link. */
function GenVideo({ convId, b }: { convId: string; b: Block }) {
  const url = fileUrl(convId, String(b.ref));
  return (
    <figure class="genvid" data-testid="gen-video">
      <video src={url} controls playsInline preload="metadata" aria-label={String(b.prompt ?? "Generated video")} />
      <figcaption class="muted small num"><span data-testid="gen-cost">{genCostLabel(b)}</span> · {Number(b.seconds) || "?"} s{b.resolution ? ` · ${String(b.resolution)}` : ""} · {String(b.model)} · <a href={url} download data-testid="gen-video-download">Download</a></figcaption>
    </figure>
  );
}

/** The running generation: spinner + elapsed time (server clock), so a 2-minute video call does not look like a hang. */
function GenRunning({ kind, startedAt, skew }: { kind: string | null; startedAt: number | null; skew: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const video = kind === "video";
  return (
    <div class={`gencard${video ? " video" : ""}`} data-testid="gen-running" role="status">
      <i class="spin" />
      <span>{video ? "Generating video…" : "Generating image…"}</span>
      {startedAt != null && <span class="muted num" data-testid="gen-elapsed">{fmtElapsed(now + skew - startedAt)}</span>}
      {video && <span class="muted small hint">Usually under a minute, up to 2½ min. Stopping may not stop billing.</span>}
    </div>
  );
}

function Assistant({ m, turn, results, awaiting, autoLog, subagents, onDecide, convId, onOpenImage, onRegenerate, onSelect, isLast, auto }: { auto?: AutoCtl; onRegenerate?: () => void; onSelect: (m: Msg) => void; isLast: boolean; m: Msg; turn: Msg[] | null; results: Map<string, Result>; awaiting: ChatState["awaiting"]; autoLog: ChatState["autoLog"]; subagents: ChatState["subagents"]; onDecide: (id: string, d: "approve" | "deny", grant?: "once" | "chat" | "user") => void; convId: string; onOpenImage: (b: Block) => void }) {
  // consecutive tool_use blocks (parallel calls in one model turn) render as one group
  const items: Array<Block | Block[]> = [];
  for (const b of m.content) {
    if (b.type === "tool_use") { const last = items[items.length - 1]; if (Array.isArray(last)) last.push(b); else items.push([b]); } else items.push(b);
  }
  const hasText = m.content.some((b) => b.type === "text" && b.text.trim());
  return (
    <div class="msg assistant">
      {m.route?.by === "open-failover" && <div class="small muted" data-testid="failover-notice" role="status">{m.route.reason}</div>}
      {items.map((b) => Array.isArray(b)
        ? <div class="toolgroup">{b.length > 1 && <div class="muted small">{b.length} tools in parallel</div>}{b.map((t) => <ToolCard b={t} result={results.get(t.id)} call={awaiting?.calls.find((c) => c.id === t.id)} autoEntry={autoLog[t.id]} expiresAt={awaiting?.expiresAt} live={subagents[t.id]} onDecide={onDecide} convId={convId} onOpenImage={onOpenImage} />)}</div>
        : b.type === "thinking" || b.type === "redacted_thinking"
        ? <Thought b={b} />
        : b.type === "gen_image" ? <GenImage convId={convId} b={b} onOpen={() => onOpenImage(b)} />
        : b.type === "gen_video" ? <GenVideo convId={convId} b={b} />
        : b.type === "text" ? <Md text={b.text} /> : null)}
      {!hasText && m.status === "complete" && !m.content.some((b) => b.type !== "text" && b.type !== "thinking" && b.type !== "redacted_thinking") && (
        <div class="error small" data-testid="empty-answer" role="status"><IconAlert /> {emptyAnswerNote(m.stopReason, m.content.some((b) => b.type === "thinking" && !!b.thinking))}
          {isLast && onRegenerate && <> <button type="button" class="btn" data-testid="empty-retry" onClick={onRegenerate}>Retry</button></>}</div>
      )}
      {hasText && m.stopReason === "max_tokens" && <div class="muted small stopped" data-testid="cut-off">Cut off at the output limit: the answer is incomplete.</div>}
      {m.status === "interrupted" && <div class="muted small stopped">Stopped</div>}
      {m.status === "error" && <div class="error small"><IconAlert /> Interrupted by an error — partial answer</div>}
      <Chip m={m} />
      {(() => {
        const actions = hasText ? <MsgActions markdown={msgMarkdown(m)} onSelect={() => onSelect(m)} /> : null;
        return turn ? <TurnFooter turn={turn} results={results} onRegenerate={onRegenerate} actions={actions} auto={auto} /> : actions && <div class="turn-foot">{isLast && onRegenerate && <button class="ghost" type="button" aria-label="Regenerate answer" data-testid="regenerate" onClick={onRegenerate}><IconCompose /><span>Regenerate</span></button>}{actions}</div>;
      })()}
    </div>
  );
}

/** Typing indicator that adds a short note while the first token is slow or a retry is running (never replaces "Thinking…"). */
function WaitingDots({ attempts, model }: { attempts: number; model: string | null | undefined }) {
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(t0);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  const note = waitNote(attempts, now - t0, model);
  return <div class="typing muted small"><span class="dots"><i /><i /><i /></span>Thinking…{note && <span data-testid="wait-note"> · {note}</span>}</div>;
}

function Live({ live, st }: { live: RenderModel; st: ChatState }) {
  const shown = live.blocks;
  return (
    <div class="msg assistant live">
      {shown.length === 0 && (st.generating ? <GenRunning kind={st.genKind} startedAt={st.genStartedAt} skew={st.clockSkew} />
        : <WaitingDots attempts={live.attempts} model={live.model ?? st.model} />)}
      {shown.map((b, i) => b.kind === "thinking"
        ? <div class="typing muted small">{b.complete ? `Thought${secs(b.elapsedMs)}` : <><span class="dots"><i /><i /><i /></span>Thinking…</>}</div>
        : b.kind === "gen_image" ? null
        : b.kind === "tool" ? <div class="typing muted small"><i class="spin" />Using {pretty(String((b as any).name ?? "tool"))}…</div>
        : <Md text={(b as any).text} streaming={st.running && i === shown.length - 1} />)}
    </div>
  );
}

const ACCEPT_NO_IMG = "application/pdf,text/*,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.toml,.ini,.log,.ts,.tsx,.js,.jsx,.mjs,.py,.go,.rs,.java,.kt,.c,.h,.cpp,.hpp,.cs,.rb,.php,.sh,.sql,.swift,.css,.scss,.vue,.svelte,.tf,.diff,.patch,.docx,.xlsx,.pptx";
const ACCEPT = `image/*,${ACCEPT_NO_IMG}`;
const CHIP_ICON = { image: <IconImage />, pdf: <IconFile />, doc: <IconFile />, code: <IconCode />, sheet: <IconTable /> };
/** One attachment chip: icon by type, name, approx token count; tapping opens the preview when `onOpen` is given. */
function FileChip({ f, onOpen, onRemove }: { f: { name: string; mime: string; tokens?: number }; onOpen?: () => void; onRemove?: () => void }) {
  const tok = tokensLabel(f.tokens);
  const inner = <>{CHIP_ICON[chipKind(f.mime, f.name)]} <span class="fname">{f.name}</span>{tok && <span class="ftok">{tok}</span>}</>;
  return (
    <span class="fchip" title={f.mime} data-testid="file-chip">
      {onOpen ? <button type="button" class="fopen" aria-label={`Preview ${f.name}`} onClick={onOpen}>{inner}</button> : inner}
      {onRemove && <button class="x" aria-label="Remove" onClick={onRemove}>×</button>}
    </span>
  );
}

/** Preview sheet: images inline, text/code/Office (extracted) as text, PDF as a link (the CSP forbids framing it). */
function FilePreview({ convId, f, onClose }: { convId: string; f: { name: string; mime: string; ref: string }; onClose: () => void }) {
  const kind = chipKind(f.mime, f.name);
  const url = fileUrl(convId, f.ref);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (kind === "image" || kind === "pdf") return;
    fetch(url, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then(setText, () => setErr(true));
  }, [url, kind]);
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet preview" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Preview ${f.name}`} data-testid="file-preview">
        <div class="grabber" />
        <strong class="pname">{f.name}</strong>
        {kind === "image" ? <img src={url} alt={f.name} />
          : kind === "pdf" ? <a class="btn" href={url} target="_blank" rel="noopener">Open PDF</a>
          : err ? <div class="error small">Couldn't load the preview.</div>
          : text === null ? <div class="muted small">Loading…</div>
          : <pre class="ptext">{text}</pre>}
        <button class="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/** One conversation, or (id = null) the empty start screen: same composer, the conversation is created lazily on the first send. */
/** "Good evening, <nickname>" (plain greeting until the profile loads, or when no nickname is set). */
function Greeting() { const nickname = useNickname(); return <h2 data-testid="greeting">{greeting(new Date().getHours(), nickname)}</h2>; }

/** The "gone" screen. A real 404 in Business may just be the other space's id (deep link, shared URL): offer the switch if this user has Open. */
export function MissingConversation({ id, notFound }: { id: string | null; notFound: boolean }) {
  const meCtx = useContext(MeCtx);
  return <div class="shell"><header class="bar"><button class="rbtn" aria-label="Back" onClick={() => go("/")}><IconBack /></button></header><main class="empty"><div class="state-card"><h2>Conversation not found</h2><p class="muted">It may have been deleted.</p>{notFound && !!id && getSpace() === "biz" && hasOpen(meCtx) && <><p class="muted small">It may be in your Open space.</p><button class="btn" data-testid="switch-to-open" onClick={() => switchSpace("open", `/c/${id}`)}>Switch to Open</button></>}<button class="btn" data-testid="back-to-list" onClick={() => go("/chats")}>Back to conversations</button></div></main></div>;
}

export function Chat({ id }: { id: string | null }) {
  const draft = id === null;
  const me0 = useContext(MeCtx);
  const ownerKey = newChatKey(me0?.user ?? "", getSpace()); // the unsent new chat belongs to (account, space)
  if (draft) claimNewChatDraft(ownerKey);
  const [st, setSt] = useState<ChatState>(emptyChat());
  const [status, setStatus] = useState<ConnStatus>(draft ? "open" : "connecting");
  const [loaded, setLoaded] = useState<"loading" | "ok" | "missing" | "error">(draft ? "ok" : "loading");
  // first message handed over by the start screen: shown at once, sent as soon as the socket is open
  const pend = useRef(id ? peekPendingFirst(id) : null);
  const drafts = useRef<Map<string, DraftFile>>(id ? new Map() : newChatDraft.held);
  const startGen = useRef(0); // bumped by "New chat": an older in-flight first send is superseded and must not navigate
  const [starting, setStarting] = useState<string | null>(null);
  const [text, setText] = useState(draft ? (newChatDraft.text || loadNewChatDraft(ownerKey)) : (id ? loadDraft(id) : ""));
  // true from the moment a send is accepted by the socket until the server's first event for it: Stop / Esc must work in that gap too
  const [sendWait, setSendWait] = useState(false);
  const seqAtSend = useRef(0);
  const stoppedAtSend = useRef(0);
  const [online, setOnline] = useState(typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => { // the server answered (any event) or refused the send: the optimistic gap is over. 20 s is only a safety net.
    if (!sendWait) return;
    if (st.lastSeq > seqAtSend.current || st.rejected || st.running || (st.stopped ?? 0) > stoppedAtSend.current) { setSendWait(false); return; }
    const t = setTimeout(() => setSendWait(false), 20000);
    return () => clearTimeout(t);
  }, [sendWait, st.lastSeq, st.rejected, st.running, st.stopped]);
  useEffect(() => { saveDraft(id ?? ownerKey, text); }, [id, ownerKey, text]); // unsent text per chat (and the unsent new chat) survives a reload / an updater-forced exit
  useEffect(() => { const on = () => setOnline(true), off = () => setOnline(false); addEventListener("online", on); addEventListener("offline", off); return () => { removeEventListener("online", on); removeEventListener("offline", off); }; }, []);
  const [models, setModels] = useState<Model[] | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const meCtx = useContext(MeCtx);
  const [sheet, setSheet] = useState(false);
  const [info, setInfo] = useState(false);
  const [meta, setMeta] = useState<{ createdAt?: string; updatedAt?: string; projectId: string | null; pinned: boolean }>({ projectId: null, pinned: false });
  const [selecting, setSelecting] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [forking, setForking] = useState(false);
  const [forkErr, setForkErr] = useState("");
  const [finding, setFinding] = useState(false);
  const bar = useAppbar(); // >=1024px: the desktop app bar owns title + controls (portaled into it); below, the header below is the whole bar
  const inBar = (n: ComponentChild) => (bar.right ? createPortal(n, bar.right) : n);
  const [said, setSaid] = useState(""); // screen-reader status for a streaming turn: one line at start and end (never per token)
  const wasRunning = useRef(false);
  useEffect(() => { if (st.running) setSaid("Claude is responding…"); else if (wasRunning.current) setSaid(st.error ? "The response failed." : "Response complete."); wasRunning.current = st.running; }, [st.running]);
  const [away, setAway] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [model, setModel] = useState<string>(draft ? newChatDraft.model : "");
  // Devices v2 step 3: a chat bound to a device (from the conversation) / the environment chosen for a NEW chat. All inert unless the server says environments are on (env_chats) or the chat already has an env.
  const [envBase, setEnvBase] = useState<EnvInfo | null>(null);
  const [envPick, setEnvPick] = useState<{ id: string | null; dir?: string; touched: boolean }>({ id: null, touched: false });
  const devs = useDeviceList(draft || !!envBase, !!envBase, 20_000);
  const env = useLiveEnv(envBase, devs.list, devs.envChats);
  const choices = useMemo(() => (devs.envChats && devs.list ? envChoices(devs.list) : []), [devs.envChats, devs.list]);
  const newEnv = draft && !envPick.touched ? defaultChoice(choices, inDesktopShell())?.id ?? null : envPick.id; // the desktop app defaults to this computer; a browser starts on Cloud
  const newEnvChoice = choices.find((c) => c.id === newEnv) ?? null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { if (!st.devFeed?.turn) return; const t = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(t); }, [!!st.devFeed?.turn]);
  const stRef = useRef(st); stRef.current = st;
  const sock = useRef<ChatSocket | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastSent = useRef<{ text: string; files: Uploaded[] } | null>(null);
  const raf = useRef(0);
  const flush = () => { if (raf.current) return; raf.current = requestAnimationFrame(() => { raf.current = 0; setSt(stRef.current); }); };

  const [notFound, setNotFound] = useState(false); // a real 404 (not 403): the id may belong to the other space
  const load = async () => {
    if (!id) return false;
    const r = await getConversation(id).catch(() => ({ status: 0, data: null }));
    // Only a 404 means "deleted"; a 5xx / network failure is a load error with a Retry, never a lost chat.
    if (r.status !== 200 || !r.data) { setLoaded(r.status === 404 || r.status === 403 ? "missing" : "error"); setNotFound(r.status === 404); return false; }
    const s = fromServer(r.data.state);
    setSt(s); stRef.current = s; setEnvBase(r.data.env ?? null); setModel(r.data.state.model ?? r.data.conversation.model); setMeta({ createdAt: r.data.conversation.createdAt, updatedAt: r.data.conversation.updatedAt, projectId: r.data.conversation.projectId ?? null, pinned: !!r.data.conversation.pinned }); setLoaded("ok");
    return true;
  };
  useEffect(() => onConvEdit((e) => { // a pin / rename done from the sidebar (or this header) keeps the open chat in step
    if (e.id !== id) return;
    if (e.title !== undefined) { stRef.current = { ...stRef.current, title: e.title }; setSt(stRef.current); }
    if (e.pinned !== undefined) setMeta((x) => ({ ...x, pinned: !!e.pinned }));
  }), [id]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let dead = false;
    void (async () => {
      // A missing/deleted conversation must never open the socket: the upgrade 404s and the client would retry it forever.
      if (!id || !(await load()) || dead) return;
      sock.current = new ChatSocket(id, () => stRef.current.lastSeq, (f) => {
        if (settlesSend(f)) clearSendPending();
        if (f.t === "rejected" || (f.t === "ev" && (f.e?.type === "turn_start" || f.e?.type === "user_message"))) ackPendingFirst(id); // only now is the first frame released
        const next = applyServer(stRef.current, f); stRef.current = next; flush(); // one DOM update per animation frame
        if (next.needResync) { void load().then(() => sock.current?.reconnect()); }
      }, setStatus, () => setLoaded("missing"));
    })();
    void getModels().then((r) => { if (r.data?.models) setModels(withAuto(r.data.models)); setNotices(r.data?.providerNotices ?? {}); if (!id && r.data?.default) setModel((cur) => cur || r.data!.default); }).catch(() => {}); // aborted by a reload / offline: the picker keeps its default
    return () => { dead = true; clearSendPending(); sock.current?.close(); if (raf.current) cancelAnimationFrame(raf.current); raf.current = 0; };
  }, [id, attempt]);

  // Connection notice (overlay, never in flow): only after the socket has been away > 2 s (offline: at once), so a quick reconnect shows nothing.
  const notice = useRef<ReturnType<typeof connNotice>>();
  if (!notice.current) notice.current = connNotice(setShowStatus);
  useEffect(() => { notice.current!.update(status, navigator.onLine !== false); }, [status, online]);
  useEffect(() => () => notice.current?.dispose(), []);

  // Layout effect (not a passive one): the pin lands before paint, so a growing block (a code fence opening) never shows one frame of "jump".
  useLayoutEffect(() => { if (stick.current) bottom.current?.scrollIntoView({ block: "end" }); }, [st.messages.length, st.live, st.running]);
  const lastTop = useRef(0);
  // The pending first frame stays registered until the server acks (or refuses) it. After a drop the next open re-reads the state
  // over HTTP and resends only if the server still has no user message (no idempotency key in the protocol).
  useEffect(() => {
    if (!id || status !== "open" || loaded !== "ok") return;
    let dead = false;
    void (async () => {
      const p = peekPendingFirst(id);
      if (!p) return;
      if (p.sent) { await load(); if (dead) return; }
      if (!peekPendingFirst(id) || !shouldSendPending(p, stRef.current.messages.some((m) => m.role === "user"))) { if (stRef.current.messages.some((m) => m.role === "user")) ackPendingFirst(id); return; }
      if (sock.current?.send(p.frame)) { p.sent = true; seqAtSend.current = stRef.current.lastSeq; setSendWait(true); markSendPending(); lastSent.current = { text: firstFrameText(p.frame), files: (p.frame.files as Uploaded[] | undefined) ?? [] }; stick.current = true; }
    })();
    return () => { dead = true; };
  }, [id, status, loaded]);

  const [files, setFiles] = useState<Uploaded[]>(draft ? newChatDraft.files : []);
  const [busyUp, setBusyUp] = useState(0);
  const [upErr, setUpErr] = useState("");
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ name: string; mime: string; ref: string } | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const camIn = useRef<HTMLInputElement>(null);
  const plusBtn = useRef<HTMLButtonElement>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  const cur = models?.find((m) => m.id === model);
  const providerNotice = noticeFor(models, model, notices);
  const canImages = (cur?.capabilities ? cur.capabilities.vision : cur?.meta?.caps.images) ?? true;
  // ---- slash menu ----
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const picked = useRef<{ kind: "tool" | "skill"; name: string } | null>(null);
  useEffect(() => {
    const fetchSlash = () => { void getSlash().then((r) => r.data?.items && setSlashItems(r.data.items)).catch(() => {}); };
    fetchSlash(); addEventListener("focus", fetchSlash);
    return () => removeEventListener("focus", fetchSlash);
  }, []);
  const sq = slashDismissed === text ? null : slashQuery(text);
  const promptItems = usePromptItems();
  const rows = useMemo(() => (sq === null ? [] : slashRows([...slashItems, ...promptItems], sq, recent)), [sq, slashItems, promptItems, recent]);
  useInsertPromptRequest((t) => setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t))); // palette pick
  const slashOpen = rows.length > 0;
  const active = Math.min(slashIdx, Math.max(0, rows.length - 1));
  useEffect(() => { setSlashIdx(0); }, [sq]);
  const acceptSlash = (it: SlashItem) => {
    if (it.disabled) return;
    const at = text.lastIndexOf("/");
    const base = text.slice(0, at);
    pushRecent(it.name); setRecent(loadRecent());
    if (it.kind === "prompt") { const typed = text; void resolvePrompt(it.text ?? "").then((t) => setText(insertPrompt(typed, t))); return; }
    if (it.kind === "builtin") {
      setText(base.trimEnd());
      if (it.name === "model") setSheet(true);
      else if (it.name === "image" || it.name === "video") setMode(it.name);
      else if (it.name === "advisor") setText(`${base}@advisor `);
      return;
    }
    picked.current = { kind: it.kind === "skill" ? "skill" : "tool", name: it.name };
    setText(`${base}/${it.name} `);
  };
  // ---- Image / Video modes (composer chip Chat | Image | Video) ----
  const [mode, setMode] = useState<"chat" | "image" | "video">(pend.current?.mode ?? (draft ? newChatDraft.mode : "chat"));
  const [imgModels, setImgModels] = useState<GenModel[] | null>(null);
  const [imgErr, setImgErr] = useState("");
  const [confirmUsd, setConfirmUsd] = useState(GEN_CONFIRM_USD_DEFAULT);
  const [imgModel, setImgModel] = useState("");
  const hintPick = useRef(false); // the image hint was tapped: prefer FLUX once the image models load
  const [imgN, setImgN] = useState(1);
  const [aspect, setAspect] = useState("");
  const [askGen, setAskGen] = useState(false);
  // Tell the update flow a turn / upload / unsent attachment is in flight (text in the composer is detected from the DOM).
  const inFlight = st.running || !!st.live || busyUp > 0 || files.length > 0;
  useEffect(() => { setBusy("chat", inFlight); return () => setBusy("chat", false); }, [inFlight]);
  useEffect(() => {
    if (mode !== "image" || imgModels) return;
    setImgErr("");
    void getGenModels().then((r) => {
      if (r.status === 200 && r.data?.models) { setImgModels(r.data.models); setConfirmUsd(r.data.confirmUsd); setImgModel((cur) => cur || (hintPick.current ? pickHintImageModel(r.data!.models.map((x) => x.id)) : r.data!.models[0]?.id) || ""); if (!r.data.models.length) setImgErr("No image models are available."); }
      else setImgErr(r.data?.error ?? `Could not load image models (${r.status})`);
    }).catch(() => setImgErr("Could not load image models (offline?)"));
  }, [mode, imgModels]);
  const genEst = estimate("image", imgModel, { n: imgN }, imgModels?.find((m) => m.id === imgModel)?.price);
  // Every outgoing turn goes through here: over the socket in a conversation; on the start screen it creates the conversation first.
  const emit = (frame: FirstFrame): boolean => {
    if (id) { if (sendWait && (frame.t === "send" || frame.t === "generate")) return false;   // one outstanding send at a time: a late reply (e.g. the cancellation of a Stopped send) must never settle the NEXT send
      const ok = !!sock.current?.send(frame); if (ok && (frame.t === "send" || frame.t === "generate")) { seqAtSend.current = stRef.current.lastSeq; stoppedAtSend.current = stRef.current.stopped ?? 0; setSendWait(true); } return ok; }
    if (starting !== null) return false;
    void startDraft(frame);
    return true;
  };
  const startDraft = async (frame: FirstFrame) => {
    const gen = ++startGen.current;
    const snap = new Map(drafts.current); // "New chat" clears the live map; this operation keeps its own snapshot
    setStarting(firstFrameText(frame));
    const r = await withBusy("conv-create", async () => {
      const res = await lazyStart({ model, frame, drafts: snap, isCurrent: () => startGen.current === gen, create: (m) => createConversation(m, new URLSearchParams(location.search).get("project"), newEnvChoice ? { device_id: newEnvChoice.id, dir: dirFor(newEnvChoice, envPick.dir) } : null), upload: uploadFile });
      // the pending registry takes over the busy key BEFORE this transaction's own key releases
      if (res.ok && startGen.current === gen) setPendingFirst({ id: res.id, frame: res.frame, mode });
      return res;
    });
    const orphan = !r.ok ? r.id : undefined;
    if (!r.ok && r.superseded) { // a newer "New chat" replaced this one: never navigate or touch state; just remove the empty conversation
      if (orphan) void withBusy("conv-delete", () => deleteConversation(orphan)).catch(() => {});
      return;
    }
    if (r.ok) { drafts.current.clear(); clearNewChatDraft(); go(`/c/${r.id}`); return; }
    setStarting(null); clearSendPending();
    if (orphan) void withBusy("conv-delete", () => deleteConversation(orphan)).catch(() => {}); // no empty conversation left behind
    const d = lastSent.current; lastSent.current = null;
    if (d) { setText((cur) => cur || d.text); setFiles((cur) => (cur.length ? cur : d.files)); }
    errorToast(r.error, () => void startDraft(frame)); // the failed start left nothing behind (orphan removed, draft restored), so it is safe to run again
  };
  // keep the unsent new-chat draft at shell level so leaving "/" and coming back does not lose it
  useEffect(() => { if (draft) { newChatDraft.text = text; newChatDraft.mode = mode; newChatDraft.model = model; newChatDraft.files = files; } }, [draft, text, mode, model, files]);
  useEffect(() => { // "New chat" while already on the start screen: clear the draft
    if (!draft) return;
    const reset = () => { startGen.current++; setStarting(null); clearSendPending(); clearNewChatDraft(); drafts.current = newChatDraft.held; setText(""); setFiles([]); drafts.current.clear(); setUpErr(""); setMode("chat"); setSlashDismissed(null); };
    addEventListener(NEW_CHAT_EVENT, reset);
    return () => removeEventListener(NEW_CHAT_EVENT, reset);
  }, [draft]);
  const REF_OK = /^image\/(png|jpeg|webp)$/;
  const generate = (confirmed: boolean) => {
    const t = text.trim();
    const refs = files.filter((f) => REF_OK.test(f.mime));
    if (emit({ t: "generate", kind: "image", prompt: t, model: imgModel, n: imgN, ...(aspect ? { aspect_ratio: aspect } : {}), files: refs, ...(confirmed ? { confirmed: true, est_usd: genEst.usd } : {}) })) {
      markSendPending(); lastSent.current = { text: t, files }; if (stRef.current.rejected) { stRef.current = { ...stRef.current, rejected: null }; setSt(stRef.current); }
      setText(""); setFiles([]); setAskGen(false); stick.current = true;
    }
  };
  // Video: one clip per request, no reference images; controls come from the model's /v1/models params (fallback: Omni 3/5/8/10 s, 360p).
  const [vidModels, setVidModels] = useState<VideoModel[] | null>(null);
  const [vidNote, setVidNote] = useState("");
  const [vidModel, setVidModel] = useState("");
  const [vidSecs, setVidSecs] = useState(3);
  const [vidRes, setVidRes] = useState("");
  const [vidAspect, setVidAspect] = useState("");
  const [askVid, setAskVid] = useState(false);
  useEffect(() => {
    if (mode !== "video" || vidModels) return;
    // No hardcoded fallback model: the picker only ever offers what the gateway catalog listed. A refusal (feature off) or a failure is shown as such.
    const fallback = (why: string) => { setVidModels([]); setVidNote(why); };
    void getVideoModels().then((r) => {
      if (r.status === 200 && r.data?.models?.length) { setVidModels(r.data.models); setConfirmUsd(r.data.confirmUsd); setVidModel((cur) => cur || r.data!.models[0].id); setVidNote(""); }
      else if (r.status === 200) { setVidModels([]); setVidNote("No video models are available."); }
      else fallback(r.status === 403 ? (r.data?.error ?? "Video generation is not enabled for your account.") : `Could not load video models (${r.status}).`);
    }).catch(() => fallback("Could not load video models (offline?)."));
  }, [mode, vidModels]);
  const vidOpts = useMemo(() => videoOptions(vidModels?.find((m) => m.id === vidModel)?.params), [vidModels, vidModel]);
  useEffect(() => { // a model switch resets the controls to that model's defaults when the current pick is not offered
    if (!vidOpts.seconds.includes(vidSecs)) setVidSecs(vidOpts.defSeconds);
    if (!vidOpts.resolutions.includes(vidRes)) setVidRes(vidOpts.defResolution);
    if (vidAspect && !vidOpts.aspects.includes(vidAspect)) setVidAspect("");
  }, [vidOpts]);
  const vidEst = estimate("video", vidModel, { seconds: vidSecs, resolution: vidRes || vidOpts.defResolution }, vidModels?.find((m) => m.id === vidModel)?.price);
  const generateVideo = (confirmed: boolean) => {
    const t = text.trim();
    if (emit({ t: "generate", kind: "video", prompt: t, model: vidModel, duration_seconds: vidSecs, resolution: vidRes || vidOpts.defResolution, ...(vidAspect ? { aspect_ratio: vidAspect } : {}), ...(confirmed ? { confirmed: true, est_usd: vidEst.usd } : {}) })) {
      markSendPending(); lastSent.current = { text: t, files: [] }; if (stRef.current.rejected) { stRef.current = { ...stRef.current, rejected: null }; setSt(stRef.current); }
      setText(""); setAskVid(false); stick.current = true;
    }
  };
  const sendVideo = () => {
    const t = text.trim();
    if (!t || st.running || busyUp || !vidModel) return;
    if (files.length) { setUpErr("Video mode takes no attachments: remove them first."); return; }
    setUpErr("");
    if (needsConfirm(vidEst, confirmUsd)) setAskVid(true); // nothing is sent until confirmed
    else generateVideo(false);
  };
  const sendImage = () => {
    const t = text.trim();
    if (!t || st.running || busyUp || !imgModel) return;
    if (files.some((f) => !REF_OK.test(f.mime))) { setUpErr("Image mode takes PNG, JPEG or WebP reference images only."); return; }
    if (files.length > 4) { setUpErr("At most 4 reference images."); return; }
    setUpErr("");
    if (needsConfirm(genEst, confirmUsd)) setAskGen(true); // modal: nothing is sent (no job, no provider call) until the user confirms
    else generate(false);
  };
  const send = () => {
    if (mode === "image") return sendImage();
    if (mode === "video") return sendVideo();
    const t = advisorAlias(text.trim()); // `/advisor ...` is `@advisor ...`
    if ((!t && !files.length) || st.running || busyUp) return;
    // The slash only counts while the pick is still in the text (editing it away drops the hint).
    const p = picked.current;
    const slash = p && new RegExp(`(^|\\s)/${p.name}(\\s|$)`).test(t) ? p : undefined;
    if (emit({ t: "send", text: t, model: sendModel(model), files, ...(slash ? { slash } : {}) })) { markSendPending(); picked.current = null; lastSent.current = { text: t, files }; if (stRef.current.rejected) { stRef.current = { ...stRef.current, rejected: null }; setSt(stRef.current); } setText(""); setFiles([]); stick.current = true; }
  };
  // A send the server refuses (e.g. "busy": it raced the previous turn's start) must not eat the draft: put it back.
  useEffect(() => {
    const d = lastSent.current;
    if ((!st.rejected && !st.stopped) || !d) return;
    lastSent.current = null;
    setText((cur) => cur || d.text); setFiles((cur) => (cur.length ? cur : d.files));
  }, [st.rejected, st.stopped]);
  // Re-runs the failed turn (the server re-sends the SAME user message; nothing is retyped, the composer draft is untouched).
  const retryTurn = () => {
    if (sendWait) return;
    if (sock.current?.send({ t: "retry" })) { seqAtSend.current = stRef.current.lastSeq; stoppedAtSend.current = stRef.current.stopped ?? 0; setSendWait(true); stick.current = true; return; }
    errorToast("Not connected - could not retry", retryTurn);
  };
  const decide = (tid: string, decision: "approve" | "deny", grant: "once" | "chat" | "user" = "once") => { sock.current?.send({ t: "approve", id: tid, decision, ...(grant !== "once" ? { grant } : {}) }); stick.current = true; };
  // Composer mode picker Ask / Auto / Bypass. Turning Auto ON asks once (plain words); Bypass asks once with the full what-it-skips / what-still-asks text; going back to Ask is immediate.
  const [askAuto, setAskAuto] = useState(false);
  const [askBypass, setAskBypass] = useState(false);
  // Bypass is only ever sent from a confirmed path (the dialog, or a remembered confirmation of THIS text version); the server refuses a bare one.
  const setApprovalMode = (m: ApMode, confirmed = false) => { sock.current?.send({ t: "mode", mode: m, ...(m === "bypass" && confirmed ? { confirmed: true, confirmVersion: BYPASS_CONFIRM_VERSION } : {}) }); };
  const pickMode = (m: ApMode) => {
    if (m === "ask") return setApprovalMode("ask");
    const key = m === "bypass" ? BYPASS_CONFIRMED_KEY : AUTO_CONFIRMED_KEY;
    let seen = false; try { seen = localStorage.getItem(key) === (m === "bypass" ? String(BYPASS_CONFIRM_VERSION) : "1"); } catch { /* private mode */ }
    if (seen) setApprovalMode(m, m === "bypass"); else if (m === "bypass") setAskBypass(true); else setAskAuto(true);
  };
  const attach = async (list: FileList | null) => {
    if (!list) return;
    setUpErr("");
    for (const f of Array.from(list)) {
      const refused = refusalFor(mode, canImages, f, model);
      if (refused) { setUpErr(refused); continue; }
      setBusyUp((n) => n + 1);
      try {
        const p = await prepareFile(f, model);
        if (!id) { // start screen: no conversation yet, so hold the file; it is uploaded right after the conversation is created
          const ref = `draft:${drafts.current.size + 1}:${Date.now().toString(36)}`;
          drafts.current.set(ref, p);
          setFiles((cur) => [...cur, { ref, name: p.name, mime: p.blob.type || f.type, size: p.blob.size }]);
          setBusyUp((n) => n - 1);
          continue;
        }
        const r = await withBusy("upload", () => uploadFile(id, p.blob, p.name));
        if (r.ok) setFiles((cur) => [...cur, r.file]); else setUpErr(`${f.name}: ${r.error}`);
      } catch (e) { setUpErr(`${f.name}: ${e instanceof Error ? e.message : "failed"}`); }
      setBusyUp((n) => n - 1);
    }
    if (fileIn.current) fileIn.current.value = "";
  };
  const results = useMemo(() => resultsById(st.messages), [st.messages]);
  const dividers = new Set(st.compactions.map((c) => c.upto));
  const modelLabel = models?.find((m) => m.id === model)?.meta?.label ?? model;
  const visible = st.messages.filter((m) => !(m.role === "user" && m.content.every((b) => b.type === "tool_result")));
  const turnOf = (m: Msg): Msg[] | null => {
    const i = visible.indexOf(m);
    const next = visible[i + 1];
    if (next ? next.role === "assistant" : st.running || !!st.error) return null;
    if (st.awaiting?.calls.some((c) => !c.decision)) return null; // still waiting on an approval: the turn isn't finished
    const turn: Msg[] = [];
    for (let j = i; j >= 0 && visible[j].role === "assistant"; j--) turn.unshift(visible[j]);
    return turn;
  };
  const editId = lastUserId(st.messages);
  const lastAssistantId = [...visible].reverse().find((m) => m.role === "assistant")?.id ?? null;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const voice = useVoice(() => text, setText, textarea);
  // Regenerate: the previous user turn goes out again as a NEW turn through the normal send path (no history rewrite).
  const regenerate = (m: Msg) => {
    const r = resendFor(st.messages, m.id);
    if (!r || st.running || busyUp) return;
    if (emit({ t: "send", text: r.text, model: sendModel(model), files: r.files })) { markSendPending(); lastSent.current = { text: r.text, files: r.files }; stick.current = true; }
  };
  // Auto: "Retry with…" re-sends the previous user turn as a NEW turn with a one-message override; the conversation stays on Auto.
  const [retryFor, setRetryFor] = useState<Msg | null>(null);
  const retryWith = (m: Msg, o: { model: string; effort: Effort | null }) => {
    const r = resendFor(st.messages, m.id);
    setRetryFor(null);
    if (!r || st.running || busyUp) return;
    if (emit({ t: "send", text: r.text, files: r.files, override: o })) { markSendPending(); lastSent.current = { text: r.text, files: r.files }; stick.current = true; }
  };
  // "Pin this model": leave Auto for this conversation (the next message is sent with, and stores, this concrete model).
  const pinModel = (id: string) => { setModel(id); toast(`Pinned ${shortModel(id)} for this chat. Pick Auto in the model list to switch back.`); };
  // Edit: the text (and attachments) go back into the composer; sending it is an ordinary new message.
  const edit = (mid: number) => {
    const d = editDraft(st.messages, mid);
    if (!d) return;
    setText(d.text); setFiles(d.files); setSlashDismissed(d.text);
    requestAnimationFrame(() => { const t = textarea.current; if (t) { t.focus(); t.setSelectionRange(d.text.length, d.text.length); } });
  };
  // Edit an EARLIER message: fork the transcript before it into a new chat and send the edited text there (the original is never changed).
  const submitFork = async (mid: number, t: string) => {
    if (!id || forking) return;
    setForking(true); setForkErr("");
    try {
      const r = await withBusy("conv-fork", () => forkConversation(id, mid));
      if (r.status !== 201 || !r.data?.id) { setForkErr(r.data?.error ?? `Could not start the new chat (${r.status})`); setForking(false); return; }
      setPendingFirst({ id: r.data.id, frame: { t: "send", text: t, model: sendModel(model), files: [] }, mode: "chat" });
      setEditing(null); setForking(false); go(`/c/${r.data.id}`);
    } catch { setForkErr("Could not reach the server (offline?)"); setForking(false); }
  };
  // Ctrl/Cmd+F while focus is in the chat (or nowhere in particular): our own find bar instead of the browser's, which cannot see virtualised/decorated text reliably.
  useEffect(() => {
    if (loaded !== "ok" || draft) return;
    const onFind = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      const a = document.activeElement;
      if (a && a !== document.body && !a.closest(".chat")) return; // focus is elsewhere (palette, a dialog, another pane)
      if (document.querySelector('[role="dialog"]:not(.chatfind)')) return;
      e.preventDefault(); setFinding(true);
    };
    addEventListener("keydown", onFind);
    return () => removeEventListener("keydown", onFind);
  }, [loaded, draft]);
  // Esc stops a running turn from anywhere on desktop (the textarea's own handlers run first and mark the key as taken).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (escStops(e, { running: canStop(st.running, sendWait), finePointer: matchMedia("(pointer:fine)").matches, dialogOpen: !!document.querySelector('[role="dialog"], .chatfind') })) sock.current?.send({ t: "stop" }); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [st.running, sendWait]);
  // Instant, then re-pinned over two frames: a smooth scroll fires onScroll mid-way (near=false clears `stick`) and on iOS WebKit
  // it ends short of content that is still growing (r3 finding A: 238 px above the bottom).
  const toBottom = () => {
    stick.current = true; setAway(false);
    const go = () => bottom.current?.scrollIntoView({ block: "end" });
    go(); requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  };

  useAppbarTitle(draft ? "New chat" : loaded === "ok" ? st.title || "New chat" : null);
  if (loaded === "error") return <div class="shell"><header class="bar"><button class="rbtn" aria-label="Back" onClick={() => go("/")}><IconBack /></button></header><main class="empty"><div class="state-card"><IconAlert /><h2>Couldn't load this conversation</h2><p class="muted">The server had a problem. Your chat is not lost.</p><button class="btn" data-testid="retry-load" onClick={() => { setLoaded("loading"); setAttempt((n) => n + 1); }}>Retry</button></div></main></div>;
  if (loaded === "missing") return <MissingConversation id={id} notFound={notFound} />;
  const envBlk = envBlock(env);
  const canSend = envBlk ? false : mode === "image" ? !(!text.trim() || busyUp > 0 || status !== "open" || !imgModel)
    : mode === "video" ? !(!text.trim() || busyUp > 0 || status !== "open" || !vidModel)
    : !((!text.trim() && !files.length) || busyUp > 0 || status !== "open");
  const blocked = id ? composerBlock({ online, socket: status, draftScreen: false }) : "";
  const empty = loaded === "ok" && visible.length === 0 && !st.live && !st.running && !st.error;
  const optimistic = starting ?? (pend.current && visible.length === 0 && !st.error && !st.rejected ? firstFrameText(pend.current.frame) : null);
  return (
    <div class="shell chat"
      onDragOver={(e) => { if (dragHasFiles(e.dataTransfer?.types)) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => { setDragging(false); const l = e.dataTransfer?.files; if (l?.length) { e.preventDefault(); void attach(l); } }}>
      <header class={`bar chatbar${bar.right ? " bar-lift" : ""}`}>
        <MenuButton />
        {draft ? <><h1 class="sr">New chat</h1><span class="title" /></>
          : loaded !== "ok"
          ? <><div class="title"><div class="skel line wide" data-testid="chat-skel" /></div></>
          : <h2 class="title ellip">{st.title || "New chat"}</h2>}
        {inBar(<>
        {loaded === "ok" && st.tokens > 0 && <span class="chip sr" data-testid="conv-cost">{fmtTokens(st.tokens)} tokens</span>}
        <SpaceChip />
        {!draft && <span class={`dot ${status}`} role="img" aria-label={`Connection ${status}`} title={status} />}
        {!bar.right && !draft && <button class="rbtn" aria-label="New chat" title="New chat" data-testid="header-new-chat" onClick={newChat}><IconCompose /></button>}
        {!draft && <button class={bar.right ? "abtn" : "rbtn"} aria-label="Find in chat" title="Find in chat" data-testid="header-find" aria-pressed={finding} onClick={() => setFinding((f) => !f)} disabled={loaded !== "ok"}><IconSearch /></button>}
        {!draft && id && <ChatHeaderMenu conv={{ id, title: st.title, pinned: meta.pinned }} projectId={meta.projectId} disabled={loaded !== "ok"} messages={st.messages} onInfo={() => setInfo(true)} caretSlot={bar.caret}
          onEdit={(e) => { if (e.title !== undefined) { stRef.current = { ...stRef.current, title: e.title }; setSt(stRef.current); } if (e.pinned !== undefined) setMeta((x) => ({ ...x, pinned: !!e.pinned })); }}
          onRemoved={() => go("/chats")} onMoved={(p) => setMeta((x) => ({ ...x, projectId: p }))} />}
        </>)}
      </header>
      {finding && loaded === "ok" && <ChatFind root={() => document.querySelector(".chat .msgs")} version={`${st.messages.length}:${st.live ? 1 : 0}:${st.running ? 1 : 0}`} onClose={() => setFinding(false)} />}
      {showStatus && (status !== "open" || !online) && <div class="statusline" role="status" data-testid="conn-notice"><IconAlert />{status === "connecting" && online ? "Connecting…" : "Offline. Reconnecting…"}</div>}
      <div class="sr" role="status" aria-live="polite" aria-atomic="true" data-testid="sr-status">{said}</div>
      <main class={`msgs${empty && optimistic === null ? " is-empty" : ""}`} aria-label="Conversation" aria-busy={loaded !== "ok"} onWheel={(e) => { if (e.deltaY < 0) stick.current = false; }} onScroll={(e) => { const el = e.currentTarget; stick.current = nextStick(stick.current, el, lastTop.current); lastTop.current = el.scrollTop; const far = awayFromBottom(el); setAway((a) => (a === far ? a : far)); }}>
        <div class="col">
        {loaded !== "ok" && <><div class="skel skel-user" /><div class="skel skel-line" /><div class="skel skel-line short" /></>}
        {empty && optimistic === null && !id && getSpace() === "open" && models !== null && models.length === 0 && <OpenEmpty me={meCtx} />}
        {empty && optimistic === null && !(!id && getSpace() === "open" && models !== null && models.length === 0) && (
          <div class="hello" data-testid="start-hello">
            <span class="mark"><IconSpark /></span>
            <Greeting />
            <div class="starters" role="group" aria-label="Conversation starters" data-testid="starters">
              {starterCards().map((c) => <button type="button" class="starter" data-testid="starter" onClick={() => { setText(c.text); setSlashDismissed(c.text); requestAnimationFrame(() => textarea.current?.focus()); }}><strong>{c.title}</strong><span class="muted small">{c.text}</span></button>)}
              {promptItems.length > 0 && <button type="button" class="starter saved" data-testid="starter-saved" onClick={() => { setText("/"); setSlashDismissed(null); requestAnimationFrame(() => { const t = textarea.current; if (t) { t.focus(); t.setSelectionRange(1, 1); } }); }}><strong>Your saved prompts</strong><span class="muted small">Pick one from your library ({promptItems.length})</span></button>}
            </div>
          </div>
        )}
        {optimistic !== null && <div class="msg user pending" data-testid="pending-first"><div class="bubble-text">{optimistic}</div></div>}
        {st.messages.map((m) => m.role === "user"
          ? (m.content.every((b) => b.type === "tool_result") ? null :
            <><div class="divider muted small" hidden={!dividers.has(m.id)}>Earlier messages were summarised to save context</div>
            <div class="msg user" key={m.id}>
              {m.content.some((b) => b.type === "file_ref") && <div class="files">{m.content.filter((b) => b.type === "file_ref").map((b) => <FileChip f={{ name: String(b.name), mime: String(b.mime), tokens: undefined }} onOpen={() => setPreview({ name: String(b.name), mime: String(b.mime), ref: String(b.ref) })} />)}</div>}
              <div class="bubble-text">{m.content.filter((b) => b.type === "text").map((b) => b.text).join("")}</div>
              {m.id === lastUserId(st.messages) && !st.running && mode === "chat" && showImageHint({ space: getSpace(), text: m.content.filter((b) => b.type === "text").map((b) => b.text).join(""), caps: cur?.capabilities, imageModels: imgModels }) &&
                <div class="muted small image-hint" data-testid="image-hint">This model can't generate images. <button type="button" class="linkish" data-testid="image-hint-use" onClick={() => { hintPick.current = true; if (imgModels) setImgModel(pickHintImageModel(imgModels.map((x) => x.id))); else setImgModel(""); setText(m.content.filter((b) => b.type === "text").map((b) => b.text).join("")); setMode("image"); }}>{(() => { const id = imgModels ? pickHintImageModel(imgModels.map((x) => x.id)) : HINT_IMAGE_MODEL; const n = imgModels?.find((x) => x.id === id)?.name; return n ? `Use ${n} (image)` : "Use an image model"; })()}</button></div>}
              {m.id === editId && !st.running && mode === "chat" && <button class="ghost msg-edit" type="button" aria-label="Edit message" data-testid="edit-msg" onClick={() => edit(m.id)}><span>Edit</span></button>}
              {m.id !== editId && !st.running && mode === "chat" && !!id && status === "open" && <button class="ghost msg-edit" type="button" aria-label="Edit earlier message" data-testid="edit-earlier" onClick={() => { setForkErr(""); setEditing({ id: m.id, text: editDraft(st.messages, m.id)?.text ?? "" }); }}><span>Edit</span></button>}
            </div></>)
          : <Assistant m={m} key={m.id} turn={turnOf(m)} isLast={m.id === lastAssistantId} onSelect={(x) => setSelecting(msgPlain(x))} onRegenerate={st.running || status !== "open" || mode !== "chat" || env ? undefined : () => regenerate(m)} auto={{ on: model === AUTO_ID, onPin: pinModel, onRetryWith: m.id === lastAssistantId && model === AUTO_ID && !st.running && status === "open" && mode === "chat" ? () => setRetryFor(m) : undefined }} results={results} awaiting={st.awaiting} autoLog={st.autoLog} subagents={st.subagents} onDecide={decide} convId={id ?? ""} onOpenImage={(b) => setPreview({ name: "generated image", mime: String(b.mime), ref: String(b.ref) })} />)}
        {st.awaiting && !st.running && st.awaiting.calls.some((c) => !c.decision) && <div class="muted small caption">Waiting for your approval above ↑</div>}
        {st.live && st.running && <Live live={st.live} st={st} />}
        {st.error && !st.running && (
          <div class="msg err state-card row-card" data-testid="turn-error">
            <IconAlert />
            <div class="error">{st.error.status ? `Error ${st.error.status}: ` : ""}{st.error.message ?? "The request failed."}</div>
            {typeof st.error.continueWith === "string" && <button class="btn" data-testid="continue-with" onClick={() => { const lm = [...st.messages].reverse().find((x) => x.role === "assistant"); if (lm) retryWith(lm, { model: st.error!.continueWith as string, effort: null }); }} disabled={!!blocked}>Continue with {shortModel(st.error.continueWith.replace(/^[^:]+:/, ""))}</button>}
            {st.error.retryable !== false && <button class="btn" data-testid="turn-retry" onClick={retryTurn} disabled={!!blocked}>Retry</button>}
            {blocked && <div class="muted small err-note">{blocked}. Retry is available once you are back.</div>}
          </div>
        )}
        {st.rejected && <div class="error small" role="alert">{st.rejected === "busy" ? "Still answering the previous message — your draft is kept, send it when the reply finishes." : st.rejected}</div>}
        <div ref={bottom} />
        </div>
      </main>
      {away && <button class="jump" type="button" data-testid="jump-bottom" onClick={toBottom}><IconDown />Jump to latest</button>}
      <footer class={`composer${dragging ? " dragover" : ""}`}>
          {env && <EnvBanner env={env} turn={st.devFeed?.turn ?? null} nowMs={nowMs} />}
          <FailoverNote />
          {providerNotice && <p class="muted small provider-notice" role="note" data-testid="provider-notice">{providerNotice}</p>}
          {(files.length > 0 || busyUp > 0 || upErr) && (
            <div class="attachbar">
              {files.map((f) => <FileChip f={f} onOpen={id ? () => setPreview(f) : undefined} onRemove={() => { drafts.current.delete(f.ref); setFiles(files.filter((x) => x.ref !== f.ref)); }} />)}
              {busyUp > 0 && <span class="muted small">Uploading…</span>}
              {upErr && <span class="error small">{upErr}</span>}
            </div>
          )}
          <input ref={fileIn} type="file" hidden multiple accept={canImages ? ACCEPT : ACCEPT_NO_IMG} onChange={(e) => void attach(e.currentTarget.files)} />
          {cameraWanted() && <input ref={camIn} type="file" hidden accept="image/*" capture="environment" data-testid="photo-input" onChange={(e) => { void attach(e.currentTarget.files); e.currentTarget.value = ""; }} />}
          {slashOpen && (
            <div class="slashpop" data-testid="slash-popover">
              <ul role="listbox" id="slash-list" aria-label="Slash commands">
                {rows.map((it, i) => (
                  <>
                    {(i === 0 || rows[i - 1].group !== it.group) && <li role="presentation" class="sgroup" data-testid="slash-group">{it.group}</li>}
                    <li role="option" id={`slash-opt-${i}`} aria-selected={i === active} aria-disabled={it.disabled ? true : undefined} class={`sopt${i === active ? " on" : ""}${it.disabled ? " dis" : ""}`} data-testid="slash-row" data-name={it.name} title={`/${it.name} — ${it.disabled ?? it.description}`}
                      onMouseDown={(e) => e.preventDefault()} onClick={() => acceptSlash(it)}>
                      <span class="sname">/{it.name}</span>
                      <span class="sdesc muted small" data-testid="slash-desc">{it.disabled ?? it.description}</span>
                      {it.approval && <span class="sbadge" data-testid="slash-approval">will ask for approval</span>}
                    </li>
                  </>
                ))}
              </ul>
            </div>
          )}
          {mode === "image" && (
            <div class="imgbar" data-testid="image-bar">
              {imgErr ? <span class="error small" role="alert" data-testid="gen-empty">{imgErr}</span> : !imgModels ? <span class="muted small">Loading image models…</span> : <>
                <select aria-label="Image model" data-testid="img-model" value={imgModel} onChange={(e) => setImgModel(e.currentTarget.value)}>
                  {imgModels.map((m) => <option value={m.id}>{m.name}{m.perImage != null ? ` · $${m.perImage}` : ""}</option>)}
                </select>
                <select aria-label="Number of images" data-testid="img-count" value={imgN} onChange={(e) => setImgN(normalizeCount(e.currentTarget.value))}>
                  {[1, 2, 3, 4].map((n) => <option value={n}>{n} image{n === 1 ? "" : "s"}</option>)}
                </select>
                <select aria-label="Aspect ratio" data-testid="img-aspect" value={aspect} onChange={(e) => setAspect(e.currentTarget.value)}>
                  <option value="">Auto ratio</option>{["1:1", "16:9", "9:16", "4:3", "3:4"].map((a) => <option value={a}>{a}</option>)}
                </select>
                <span class="est num" data-testid="img-estimate" title={genEst.basis}>{fmtEstimate(genEst, imgN)}</span>
              </>}
            </div>
          )}
          {mode === "video" && (
            <div class="imgbar" data-testid="video-bar">
              {!vidModels ? <span class="muted small">Loading video models…</span> : vidModels.length === 0 ? <span class="error small" role="alert" data-testid="gen-empty">{vidNote}</span> : <>
                <select aria-label="Video model" data-testid="vid-model" value={vidModel} onChange={(e) => setVidModel(e.currentTarget.value)}>
                  {vidModels.map((m) => <option value={m.id}>{m.name}</option>)}
                </select>
                <select aria-label="Duration" data-testid="vid-duration" value={vidSecs} onChange={(e) => setVidSecs(Number(e.currentTarget.value))}>
                  {vidOpts.seconds.map((n) => <option value={n}>{n} s</option>)}
                </select>
                <select aria-label="Resolution" data-testid="vid-resolution" value={vidRes || vidOpts.defResolution} onChange={(e) => setVidRes(e.currentTarget.value)}>
                  {vidOpts.resolutions.map((r) => <option value={r}>{r}</option>)}
                </select>
                {vidOpts.aspects.length > 0 && <select aria-label="Aspect ratio" data-testid="vid-aspect" value={vidAspect} onChange={(e) => setVidAspect(e.currentTarget.value)}>
                  <option value="">Auto ratio</option>{vidOpts.aspects.map((a) => <option value={a}>{a}</option>)}
                </select>}
                <span class="est num" data-testid="vid-estimate" title={vidEst.basis}>{fmtVideoEstimate(vidEst, vidSecs)}</span>
                {vidNote && <span class="muted small" data-testid="vid-note">{vidNote}</span>}
              </>}
            </div>
          )}
          {mode !== "chat" && <div class="modechips"><span class="modechip" data-testid="mode-active"><ModeIcon mode={mode} />{MODE_LABEL[mode]}<button type="button" class="x" aria-label={`Remove ${MODE_LABEL[mode]} mode`} data-testid="mode-clear" onClick={() => setMode("chat")}><IconClose /></button></span></div>}
          {blocked && showStatus && <div class="muted small composer-note" role="status" data-testid="composer-blocked">{blocked}{text.trim() ? " - your draft is kept." : ""}</div>}
          {voice.native.show && !voice.active && <NativeBar v={voice} />}
          {voice.active ? <VoiceBar v={voice} /> : <textarea ref={textarea} value={text} rows={1} placeholder={mode === "image" ? "Describe the image…" : mode === "video" ? "Describe the video…" : "Message…"} enterkeyhint="send" aria-label="Message" aria-controls={slashOpen ? "slash-list" : undefined} aria-activedescendant={slashOpen ? `slash-opt-${active}` : undefined} onInput={(e) => setText(e.currentTarget.value)}
            onPaste={(e) => { const l = e.clipboardData?.files; if (l?.length) { e.preventDefault(); void attach(l); } }}
            onKeyDown={(e) => {
              if (slashOpen && !e.isComposing) {
                if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((active + 1) % rows.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((active + rows.length - 1) % rows.length); return; }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); acceptSlash(rows[active]); return; }
                if (e.key === "Escape") { e.preventDefault(); setSlashDismissed(text); return; }
              }
              if (e.key === "Enter" && enterAction(e, matchMedia("(pointer:fine)").matches) === "send") { e.preventDefault(); send(); }
            }} />}
          {id && st.webGrants.length > 0 && <GrantsLine hosts={st.webGrants} onRevoke={(h) => sock.current?.send({ t: "revoke_grant", host: h })} />}
          <div class="controls">
            <button class="round plus" type="button" ref={plusBtn} data-testid="composer-plus" aria-label="Add context" aria-haspopup="dialog" aria-expanded={ctxOpen} onClick={() => setCtxOpen(true)}><IconPlus /></button>
            {mode === "chat" && !env && !newEnvChoice && chipVisible({ hasChat: !!id, approvalAuto: st.approvalAuto, mode: st.approvalMode }) && <ApprovalChip mode={st.approvalMode} approvalAuto={st.approvalAuto} disabled={st.running || status !== "open"} onPick={pickMode} />}
            {mode === "chat" && draft && choices.length > 0 && <EnvChip choices={choices} pickedId={newEnv} dir={envPick.dir} disabled={starting !== null} onPick={(i) => setEnvPick({ id: i, touched: true })} onDir={(d) => setEnvPick((x) => ({ ...x, dir: d }))} />}
            {mode === "chat" && !env && !newEnvChoice && <button class="pill" type="button" data-testid="model-pill" onClick={() => setSheet(true)} aria-label={loaded === "ok" && modelLabel ? `Choose model, ${modelLabel}` : "Choose model"} disabled={loaded !== "ok"}><span class="pill-l">{loaded !== "ok" ? "…" : modelLabel || "model"}</span><IconChevronDown /></button>}
            <span class="grow" />
            <MicButton voice={voice} />
            {canStop(st.running, sendWait)
              ? <button class="round stop" onClick={() => sock.current?.send({ t: "stop" })} aria-label="Stop"><IconStop /></button>
              : <button class="round send" disabled={!canSend || starting !== null || voice.active} onClick={send} aria-label="Send"><IconSend /></button>}
          </div>
      </footer>
      {ctxOpen && <ContextSheet mode={mode} anchor={plusBtn.current} camera={cameraWanted()} photosDisabled={st.running || mode === "video" || !canImages} photosWhy={st.running ? "Photos can be added once the reply finishes." : mode === "video" ? "Video mode doesn't take photos here." : "This model can't read images."} filesDisabled={st.running || mode === "video"}
        onClose={() => setCtxOpen(false)} onMode={(m) => { setMode(m); setCtxOpen(false); }}
        onCamera={() => { camIn.current?.click(); setCtxOpen(false); }}
        onPhotos={() => { if (fileIn.current) { fileIn.current.accept = "image/*"; fileIn.current.click(); } setCtxOpen(false); }}
        onFiles={() => { if (fileIn.current) { fileIn.current.accept = canImages ? ACCEPT : ACCEPT_NO_IMG; fileIn.current.click(); } setCtxOpen(false); }}
        onPrompts={() => { setCtxOpen(false); setText("/"); setSlashDismissed(null); requestAnimationFrame(() => { const t = textarea.current; if (t) { t.focus(); t.setSelectionRange(1, 1); } }); }} />}
      {preview && id && <FilePreview convId={id} f={preview} onClose={() => setPreview(null)} />}
      {askGen && <ConfirmSheet danger={false} title={genEst.certainty === "unknown" ? "Generate with an unpriced model?" : `Generate ${imgN} image${imgN === 1 ? "" : "s"} — about $${genEst.usd.toFixed(2)}`}
        body={`${genEst.basis}. Cancelling later may not stop billing.`} confirmLabel="Generate" onConfirm={() => generate(true)} onCancel={() => setAskGen(false)} />}
      {askVid && <ConfirmSheet danger={false} title={vidEst.certainty === "unknown" ? "Generate with an unpriced video model?" : `Generate ${vidSecs} s video — about $${vidEst.usd.toFixed(2)}`}
        body={`${vidEst.basis}. Cancelling later may not stop billing.`} confirmLabel="Generate" onConfirm={() => generateVideo(true)} onCancel={() => setAskVid(false)} />}
      {askAuto && <ConfirmSheet danger={false} title={AUTO_TITLE} body={AUTO_BODY} confirmLabel="Turn on Auto" onConfirm={() => { try { localStorage.setItem(AUTO_CONFIRMED_KEY, "1"); } catch { /* ignore */ } setAskAuto(false); setApprovalMode("auto"); }} onCancel={() => setAskAuto(false)} />}
      {askBypass && <BypassSheet onConfirm={() => { try { localStorage.setItem(BYPASS_CONFIRMED_KEY, String(BYPASS_CONFIRM_VERSION)); } catch { /* ignore */ } setAskBypass(false); setApprovalMode("bypass", true); }} onCancel={() => setAskBypass(false)} />}
      {retryFor && <RetrySheet models={retryChoices(models)} onRun={(o) => retryWith(retryFor, o)} onClose={() => setRetryFor(null)} />}
      {sheet && <ModelSheet models={models} current={model} onPick={(m) => { setModel(m); setSheet(false); }} onClose={() => setSheet(false)} />}
      {info && id && <ConvInfo d={{ id, title: st.title, model: modelLabel || "", messages: visible.length, createdAt: meta.createdAt, updatedAt: meta.updatedAt, costUsd: st.costUsd, tokens: st.tokens, status, projectId: meta.projectId, subagents: delegationTotals(st.messages) }}
        onClose={() => setInfo(false)} />}
      {selecting !== null && <SelectSheet text={selecting} onClose={() => setSelecting(null)} />}
      {editing && <EditSheet initial={editing.text} busy={forking} error={forkErr} onCancel={() => { if (!forking) setEditing(null); }} onSubmit={(t) => void submitFork(editing.id, t)} />}
    </div>
  );
}

/** "Retry with…": pick a concrete model (+ effort where the model takes one); runs that one message, the conversation keeps its Auto setting. */
function RetrySheet({ models, onRun, onClose }: { models: Model[]; onRun: (o: { model: string; effort: Effort | null }) => void; onClose: () => void }) {
  const [sel, setSel] = useState(models.find((m) => m.id === "claude-sonnet-5-5")?.id ?? models[0]?.id ?? "");
  const [effort, setEffort] = useState<Effort | null>(null);
  const cur = models.find((m) => m.id === sel);
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Retry with" data-testid="retry-sheet">
        <h3>Retry this answer with…</h3>
        <ul class="list">{models.map((m) => <li><button class={m.id === sel ? "row on" : "row"} type="button" data-testid={`retry-model-${m.id}`} onClick={() => { setSel(m.id); if (!takesEffort(m)) setEffort(null); }}><strong>{m.meta?.label ?? m.name}</strong><span class="muted small">{m.id}</span></button></li>)}</ul>
        {takesEffort(cur) && <div class="row-inline" role="group" aria-label="Thinking effort">{([null, "low", "medium", "high"] as Array<Effort | null>).map((e) => <button class={effort === e ? "pill on" : "pill"} type="button" data-testid={`retry-effort-${e ?? "default"}`} aria-pressed={effort === e} onClick={() => setEffort(e)}>{e ?? "default"}</button>)}</div>}
        <p class="muted small">Only this message changes. The conversation stays on Auto.</p>
        <button class="btn primary" type="button" data-testid="retry-run" disabled={!sel} onClick={() => onRun({ model: sel, effort })}>Retry</button>
      </div>
    </div>
  );
}

const PROVIDER_LABELS: Record<string, string> = { gateway: "Vertex (Claude)", cloudflare: "Cloudflare", nvidia: "NVIDIA", aistudio: "Google AI Studio", groq: "Groq" };
const providerLabel = (id: string) => PROVIDER_LABELS[id] ?? id;
export function ModelSheet({ models, current, onPick, onClose }: { models: Model[] | null; current: string; onPick: (id: string) => void; onClose: () => void }) {
  useEscape(onClose);
  const [all, setAll] = useState(false);
  const rated = models?.filter((m) => m.meta) ?? [], unrated = models?.filter((m) => !m.meta) ?? [];
  const hint = (m: Model) => speedHint(m.speed);
  const row = (m: Model) => (
    <li><button class={m.id === current ? "row on" : "row"} onClick={() => onPick(m.id)}>
      <strong>{m.meta?.label ?? m.name}</strong><span class="muted small">{m.description ?? m.id}{m.meta?.price ? ` · $${m.meta.price.input}/${m.meta.price.output}` : ""}{m.capabilities && !m.capabilities.tools ? " · no tools" : ""}{m.capabilities && !m.capabilities.vision ? " · no images" : ""}{priceHint(m.priceEstimate) ? ` · ${priceHint(m.priceEstimate)}` : ""}{m.limited ? " · limited daily quota" : ""}{m.limits?.rpm && m.limits?.rpd ? ` · ~${m.limits.rpm}/min, ${m.limits.rpd}/day free` : ""}</span>{m.dataWarning && <span class="muted small" role="note" data-testid="model-data-warning" lang="en">{m.dataWarning.en}</span>}{hint(m) && <span class={`speed speed-${hint(m)!.tier}`} data-testid="model-speed" title={hint(m)!.text}><strong>{hint(m)!.label}</strong> <span class="muted small">{hint(m)!.text}</span></span>}
    </button></li>);
  // Grouped by provider (a small label) only when more than one provider has models; with just the gateway the list looks exactly as before.
  const groupsOf = (ms: Model[]) => { const g = new Map<string, Model[]>(); for (const m of ms) { const k = m.provider ?? "gateway"; (g.get(k) ?? g.set(k, []).get(k)!).push(m); } return [...g]; };
  const multi = new Set(models?.map((m) => m.provider ?? "gateway")).size > 1 || !!models?.some((m) => m.provider && m.provider !== "gateway");
  const list = (ms: Model[]) => multi
    ? groupsOf(ms).map(([p, items]) => <section key={p} aria-label={`${providerLabel(p)} models`}><h3 class="provider-label muted small" data-testid="provider-label">{providerLabel(p)}</h3><ul class="list">{items.map(row)}</ul></section>)
    : <ul class="list">{ms.map(row)}</ul>;
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Models">
        {!models && <p class="muted">Loading…</p>}
        {list(rated)}
        {unrated.length > 0 && <button class="btn" onClick={() => setAll(!all)}>{all ? "Hide" : "Show"} {unrated.length} unrated models</button>}
        {all && list(unrated)}
      </div>
    </div>
  );
}

export function ConversationList({ onSettings }: { onSettings: () => void }) {
  const [rows, setRows] = useState<ConvRow[] | null>(null);
  const [q, setQ] = useState("");
  const [failed, setFailed] = useState(false);
  const load = (query: string) => {
    setFailed(false);
    void listConversations(query).then((r) => { if (r.status === 200 && r.data?.conversations) setRows(r.data.conversations); else { setFailed(true); errorToast(`Could not load chats (${r.status})`, () => load(query)); } })
      .catch(() => { setFailed(true); errorToast("Could not load chats (offline?)", () => load(query)); });
  };
  useEffect(() => { const t = setTimeout(() => load(q.trim()), q ? 250 : 0); return () => clearTimeout(t); }, [q]);
  const create = newChat; // the empty start screen; the conversation itself is created lazily on the first send
  const groups = q ? { pinned: [] as ConvRow[], rest: rows ?? [] } : splitPinned(rows);
  const item = (r: ConvRow) => <ChatItem key={r.id} row={r} variant="list" onOpen={() => go(`/c/${r.id}`)}
    onEdit={(id, e) => setRows((cur) => (cur ? editRow(cur, id, e) : cur))} onRemoved={(id) => setRows((cur) => cur?.filter((x) => x.id !== id) ?? cur)} />;
  return (
    <div class="shell">
      <ListBar mode="chat" title="Chats" onSettings={onSettings} />
      <div class="searchbar"><input type="search" placeholder="Search chats" value={q} onInput={(e) => setQ(e.currentTarget.value)} /></div>
      <main class="list-page">
        {!rows && !failed && <ul class="list" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <li key={i}><div class="skel row-skel" /></li>)}</ul>}
        {failed && !rows && <div class="empty"><h2>Couldn't load chats</h2><button class="btn" onClick={() => load(q.trim())}>Retry</button></div>}
        {rows && rows.length === 0 && (q
          ? <div class="empty"><h2>No matches</h2><p class="muted">Nothing found for “{q}”.</p></div>
          : <div class="empty"><h2>No conversations yet</h2><p class="muted">Start one with the New chat button.</p><button class="btn primary" onClick={create}>New chat</button></div>)}
        {groups.pinned.length > 0 && <><h2 class="list-sec" data-testid="list-pinned-h">Pinned</h2><ul class="list" data-testid="list-pinned">{groups.pinned.map(item)}</ul></>}
        {groups.pinned.length > 0 && groups.rest.length > 0 && <h2 class="list-sec">Recent</h2>}
        <ul class="list">{groups.rest.map(item)}</ul>
      </main>
      <button class="fab" onClick={create} aria-label="New chat"><IconPlus /></button>
    </div>
  );
}
