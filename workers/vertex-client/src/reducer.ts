// Reference reducer: Anthropic streaming events (+ a few transport/client events) -> render model.
// Pure: reduce(state, event, now) returns a NEW state, never mutates, never touches the clock or IO.
// Spec + rendering rules: docs/vertex-client-stream-events.md. Replayed against every fixture in
// fixtures/stream by test/reducer.test.ts. Reusable as-is in the PWA (no DOM / Worker APIs).

export type Usage = {
  input_tokens?: number; output_tokens?: number
  cache_creation_input_tokens?: number; cache_read_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  output_tokens_details?: { thinking_tokens?: number }
  server_tool_use?: { web_search_requests?: number }
}

export type Phase =
  | 'idle' | 'streaming'
  | 'tool-running'        // stop_reason=tool_use, client is executing tools
  | 'awaiting-approval'   // stop_reason=tool_use and >=1 tool needs a human yes
  | 'paused'              // pause_turn: resend to continue (auto, no user action)
  | 'interrupted' | 'done' | 'error'

export type Citation = Record<string, unknown>

export type TextBlock = { kind: 'text'; index: number; text: string; citations: Citation[]; complete: boolean }
export type ThinkingBlock = {
  kind: 'thinking'; index: number; text: string; hasSignature: boolean; redacted: boolean
  // true once complete with NO text (display:omitted, the norm on Sonnet 5/5.5): render "Thought for Ns", no expander
  omitted: boolean
  startedAt: number; endedAt?: number; elapsedMs?: number; complete: boolean
}
export type ToolStatus = 'streaming-args' | 'awaiting-approval' | 'running' | 'done' | 'error' | 'truncated'
export type ToolBlock = {
  kind: 'tool'; index: number; id: string; name: string; server: boolean
  inputJson: string; input?: unknown; argKeys: string[]; argsSummary: string
  status: ToolStatus; result?: { isError: boolean; chars?: number; count?: number }; complete: boolean
}
// A generated image (src/gen-engine.ts): stored by R2 ref only (never base64), rendered through the authed file endpoint.
export type GenImageBlock = { kind: 'gen_image'; index: number; ref: string; mime: string; prompt: string; model: string; costUsd: number | null; estUsd: number | null; complete: true }
export type Block = TextBlock | ThinkingBlock | ToolBlock | GenImageBlock

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | (string & {})

export type RenderModel = {
  phase: Phase
  messageId?: string; model?: string
  blocks: Block[]
  usage: Usage
  stopReason?: StopReason
  stopDetails?: unknown
  refusal?: { category?: string }              // show refusal banner
  canContinue: boolean                         // max_tokens -> "Continue" affordance
  truncatedTool: boolean                       // max_tokens cut a tool_use: never execute, offer retry
  error?: { status?: number; type?: string; message?: string; retryable: boolean }
  attempts: number                             // gateway strip-and-retry / client retries seen this turn
  retriedByGateway: boolean
  startedAt?: number; endedAt?: number
}

export type Config = {
  /** tool names that need explicit approval before execution */
  needsApproval?: (toolName: string) => boolean
}

export type Event =
  | { type: 'message_start'; message: { id?: string; model?: string; usage?: Usage } }
  | { type: 'ping' }
  | { type: 'content_block_start'; index: number; content_block: Record<string, any> }
  | { type: 'content_block_delta'; index: number; delta: Record<string, any> }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: StopReason; stop_details?: unknown }; usage?: Usage }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type?: string; message?: string } }
  // ---- non-SSE events (transport / client), same reducer so replay is uniform ----
  | { type: 'http_error'; status: number; body: any }
  | { type: 'attempt'; n: number }
  | { type: 'non_stream_message'; message: any }
  | { type: 'client_interrupt' }
  | { type: 'tool_result'; tool_use_id: string; is_error?: boolean; chars?: number }
  | { type: 'tool_approval'; tool_use_id: string; approved: boolean }
  | { type: 'request_shape'; [k: string]: unknown }   // fixture-only header, ignored

export function initial(): RenderModel {
  return { phase: 'idle', blocks: [], usage: {}, canContinue: false, truncatedTool: false, attempts: 0, retriedByGateway: false }
}

const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
const RETRYABLE_STREAM_ERR = new Set(['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error'])

function mergeUsage(a: Usage, b: Usage | undefined): Usage {
  // message_delta.usage is CUMULATIVE for the message: overwrite, never add. Fields absent in
  // message_delta (e.g. cache_creation breakdown) are kept from message_start.
  if (!b) return a
  return { ...a, ...b }
}

const short = (v: unknown): string => {
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 37) + '…' : v
  if (Array.isArray(v)) return `[${v.length}]`
  if (v && typeof v === 'object') return '{…}'
  return String(v)
}
/** "file_path=…, command=…" - key names + first value, never the full args (they can be huge / private). */
export function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const e = Object.entries(input as Record<string, unknown>)
  if (!e.length) return ''
  const [k, v] = e[0]
  return e.length === 1 ? `${k}=${short(v)}` : `${k}=${short(v)} +${e.length - 1}`
}

function upd<T extends Block>(s: RenderModel, index: number, f: (b: T) => T): RenderModel {
  return { ...s, blocks: s.blocks.map(b => (b.index === index ? f(b as T) : b)) }
}

function finishTurn(s: RenderModel, now: number): RenderModel {
  const reason = s.stopReason
  const tools = s.blocks.filter((b): b is ToolBlock => b.kind === 'tool' && !b.server)
  let phase: Phase = 'done'
  let blocks = s.blocks
  if (reason === 'tool_use') {
    // no safe tool without complete args; awaiting approval wins over running
    const anyApproval = tools.some(t => t.status === 'awaiting-approval')
    phase = anyApproval ? 'awaiting-approval' : 'tool-running'
  } else if (reason === 'pause_turn') phase = 'paused'
  if (reason === 'max_tokens') {
    // a tool_use whose JSON never closed can't run
    blocks = blocks.map(b => (b.kind === 'tool' && !b.server && b.input === undefined ? { ...b, status: 'truncated' as ToolStatus } : b))
  }
  return {
    ...s, blocks, phase, endedAt: now,
    canContinue: reason === 'max_tokens',
    truncatedTool: reason === 'max_tokens' && blocks.some(b => b.kind === 'tool' && b.status === 'truncated'),
    refusal: reason === 'refusal' ? { category: (s.stopDetails as any)?.category } : undefined,
  }
}

export function reduce(s: RenderModel, e: Event, now = 0, cfg: Config = {}): RenderModel {
  switch (e.type) {
    case 'request_shape': case 'ping': return s
    case 'attempt': return { ...s, attempts: s.attempts + 1, retriedByGateway: s.retriedByGateway || e.n > 1, error: undefined, phase: s.phase === 'error' ? 'idle' : s.phase }
    case 'message_start': {
      const m = e.message
      return { ...initial(), attempts: Math.max(s.attempts, 1), retriedByGateway: s.retriedByGateway, phase: 'streaming', messageId: m.id, model: m.model, usage: m.usage ?? {}, startedAt: s.startedAt ?? now }
    }
    case 'content_block_start': {
      const c = e.content_block
      let b: Block
      if (c.type === 'text') b = { kind: 'text', index: e.index, text: c.text ?? '', citations: c.citations ?? [], complete: false }
      else if (c.type === 'thinking' || c.type === 'redacted_thinking')
        b = { kind: 'thinking', index: e.index, text: c.thinking ?? '', hasSignature: !!c.signature, redacted: c.type === 'redacted_thinking', omitted: false, startedAt: now, complete: false }
      else if (c.type === 'tool_use' || c.type === 'server_tool_use')
        b = { kind: 'tool', index: e.index, id: c.id, name: c.name, server: c.type === 'server_tool_use', inputJson: '', argKeys: [], argsSummary: '', status: 'streaming-args', complete: false }
      else if (c.type === 'gen_image')
        b = { kind: 'gen_image', index: e.index, ref: String(c.ref ?? ''), mime: String(c.mime ?? 'image/png'), prompt: String(c.prompt ?? ''), model: String(c.model ?? ''),
              costUsd: typeof c.cost_usd === 'number' ? c.cost_usd : null, estUsd: typeof c.est_usd === 'number' ? c.est_usd : null, complete: true }
      else if (c.type === 'web_search_tool_result') {
        // arrives whole in start (no deltas); attach to its server tool call
        const n = Array.isArray(c.content) ? c.content.length : 0
        const isErr = !Array.isArray(c.content)
        return { ...s, blocks: s.blocks.map(x => (x.kind === 'tool' && x.id === c.tool_use_id ? { ...x, status: isErr ? 'error' : 'done', result: { isError: isErr, count: n } } : x)) }
      } else return s // unknown block type: ignore, forward-compat
      return { ...s, blocks: [...s.blocks, b] }
    }
    case 'content_block_delta': {
      const d = e.delta
      switch (d.type) {
        case 'text_delta': return upd<TextBlock>(s, e.index, b => ({ ...b, text: b.text + d.text }))
        case 'thinking_delta': return upd<ThinkingBlock>(s, e.index, b => ({ ...b, text: b.text + d.thinking }))
        case 'signature_delta': return upd<ThinkingBlock>(s, e.index, b => ({ ...b, hasSignature: true }))
        case 'input_json_delta': return upd<ToolBlock>(s, e.index, b => ({ ...b, inputJson: b.inputJson + d.partial_json }))
        case 'citations_delta': return upd<TextBlock>(s, e.index, b => ({ ...b, citations: [...b.citations, d.citation] }))
        default: return s
      }
    }
    case 'content_block_stop':
      return upd<any>(s, e.index, (b: Block) => {
        if (b.kind === 'text') return { ...b, complete: true }
        if (b.kind === 'gen_image') return b
        if (b.kind === 'thinking') return { ...b, complete: true, endedAt: now, elapsedMs: now - b.startedAt, omitted: !b.redacted && b.text === '' }
        let input: unknown; let argKeys: string[] = []
        try { input = b.inputJson === '' ? {} : JSON.parse(b.inputJson); argKeys = input && typeof input === 'object' ? Object.keys(input as object) : [] } catch { input = undefined }
        const status: ToolStatus = b.server ? 'running' : input === undefined ? 'error' : cfg.needsApproval?.(b.name) ? 'awaiting-approval' : 'running'
        return { ...b, complete: true, input, argKeys, argsSummary: summarizeArgs(input), status }
      })
    case 'message_delta':
      return { ...s, usage: mergeUsage(s.usage, e.usage), stopReason: e.delta.stop_reason ?? s.stopReason, stopDetails: e.delta.stop_details ?? s.stopDetails }
    case 'message_stop': return finishTurn(s, now)
    case 'error': {
      const type = e.error.type
      return { ...s, phase: 'error', endedAt: now, error: { type, message: e.error.message, retryable: !!type && RETRYABLE_STREAM_ERR.has(type) },
               blocks: s.blocks.map(b => (b.kind === 'tool' && !b.complete ? { ...b, status: 'error' as ToolStatus } : b)) }
    }
    case 'http_error': {
      const err = Array.isArray(e.body) ? e.body[0]?.error : e.body?.error
      return { ...s, phase: 'error', endedAt: now, error: { status: e.status, type: err?.type ?? err?.status, message: err?.message, retryable: RETRYABLE_HTTP.has(e.status) } }
    }
    case 'non_stream_message': {
      // fold a whole message through the streaming path so both transports render identically
      const m = e.message
      let st = reduce(s, { type: 'message_start', message: { id: m.id, model: m.model, usage: m.usage } }, now, cfg)
      m.content.forEach((c: any, i: number) => {
        const { text, thinking, input, ...rest } = c
        st = reduce(st, { type: 'content_block_start', index: i, content_block: { ...rest, ...(c.type === 'text' ? { text: '' } : {}) } }, now, cfg)
        if (c.type === 'text' && text) st = reduce(st, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } }, now, cfg)
        if (c.type === 'thinking' && thinking) st = reduce(st, { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking } }, now, cfg)
        if (c.type === 'tool_use') st = reduce(st, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input ?? {}) } }, now, cfg)
        st = reduce(st, { type: 'content_block_stop', index: i }, now, cfg)
      })
      st = reduce(st, { type: 'message_delta', delta: { stop_reason: m.stop_reason, stop_details: m.stop_details }, usage: m.usage }, now, cfg)
      return reduce(st, { type: 'message_stop' }, now, cfg)
    }
    case 'client_interrupt':
      if (s.phase !== 'streaming' && s.phase !== 'tool-running' && s.phase !== 'awaiting-approval') return s
      // keep partial blocks; open thinking gets closed, open tools become non-executable
      return { ...s, phase: 'interrupted', endedAt: now,
        blocks: s.blocks.map(b => b.kind === 'thinking' && !b.complete ? { ...b, complete: true, endedAt: now, elapsedMs: now - b.startedAt } : b.kind === 'tool' && !b.complete ? { ...b, status: 'error' as ToolStatus } : b) }
    case 'tool_approval': {
      const blocks = s.blocks.map(b => (b.kind === 'tool' && b.id === e.tool_use_id && b.status === 'awaiting-approval' ? { ...b, status: (e.approved ? 'running' : 'error') as ToolStatus, result: e.approved ? undefined : { isError: true } } : b))
      const pending = blocks.some(b => b.kind === 'tool' && b.status === 'awaiting-approval')
      return { ...s, blocks, phase: s.phase === 'awaiting-approval' && !pending ? 'tool-running' : s.phase }
    }
    case 'tool_result': {
      const blocks = s.blocks.map(b => (b.kind === 'tool' && b.id === e.tool_use_id ? { ...b, status: (e.is_error ? 'error' : 'done') as ToolStatus, result: { isError: !!e.is_error, chars: e.chars } } : b))
      return { ...s, blocks }
    }
  }
}

export function replay(events: Event[], cfg: Config = {}, tick = 10): RenderModel {
  return events.reduce((st, ev, i) => reduce(st, ev, i * tick, cfg), initial())
}

/** Consecutive client tools from ONE assistant message render as one "parallel" group (>=2 -> group card). */
export function toolGroups(s: RenderModel): Array<Block | { kind: 'tool-group'; tools: ToolBlock[] }> {
  const out: Array<Block | { kind: 'tool-group'; tools: ToolBlock[] }> = []
  for (const b of s.blocks) {
    const last = out[out.length - 1]
    if (b.kind === 'tool' && !b.server && last && last.kind === 'tool' && !(last as ToolBlock).server) { out[out.length - 1] = { kind: 'tool-group', tools: [last as ToolBlock, b] } }
    else if (b.kind === 'tool' && !b.server && last && last.kind === 'tool-group') last.tools.push(b)
    else out.push(b)
  }
  return out.map(x => (x.kind === 'tool-group' ? x : x))
}

export type CostChip = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; thinking: number; webSearches: number; cacheHitRatio: number }
export function costChip(u: Usage): CostChip {
  const input = u.input_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0
  const total = input + cacheRead + cacheWrite
  return { input, output: u.output_tokens ?? 0, cacheRead, cacheWrite, cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
           thinking: u.output_tokens_details?.thinking_tokens ?? 0, webSearches: u.server_tool_use?.web_search_requests ?? 0,
           cacheHitRatio: total ? cacheRead / total : 0 }
}
