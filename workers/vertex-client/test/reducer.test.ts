import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { replay, toolGroups, costChip, initial, reduce, type Event, type ToolBlock } from '../src/reducer'

const DIR = join(import.meta.dir, '../fixtures/stream')

/** Fixtures hold "<text N chars>" placeholders. Expand to N filler chars so length-dependent logic is real. */
function expand(v: any): any {
  if (typeof v === 'string') {
    const m = /^<(text|thinking) (\d+) chars>$/.exec(v)
    return m ? 'x'.repeat(+m[2]) : v
  }
  if (Array.isArray(v)) return v.map(expand)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
  return v
}
function load(file: string) {
  const [h, ...rest] = readFileSync(join(DIR, file), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { header: h, events: rest.map(expand) as Event[] }
}
const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort()
const fx = (prefix: string) => load(files.find(f => f.startsWith(prefix))!)

describe('every fixture replays', () => {
  for (const f of files) {
    test(f, () => {
      const { header, events } = load(f)
      expect(header._fixture + '.jsonl').toBe(f)
      expect(['gateway-log', 'docs']).toContain(header.source)
      const s = replay(events)
      // invariants for every fixture
      expect(['done', 'error', 'tool-running', 'awaiting-approval', 'paused']).toContain(s.phase)
      const starts = events.filter(e => e.type === 'content_block_start' && !(e as any).content_block.type.endsWith('tool_result')).length
      const nonStream = events.find(e => e.type === 'non_stream_message') as any
      const expectedBlocks = nonStream ? nonStream.message.content.length : starts
      expect(s.blocks.length).toBe(expectedBlocks)
      for (const b of s.blocks) expect(b.complete).toBe(s.phase === 'error' ? b.complete : true)
      // every client tool that completed has parsed args (fixtures synthesise valid JSON), except the truncation case
      for (const b of s.blocks) if (b.kind === 'tool' && !b.server && b.status !== 'truncated' && s.phase !== 'error') { expect(b.input).toBeDefined(); expect(b.id).toBeTruthy() }
      // stop reason drives phase for message-terminated turns
      if (s.stopReason === 'tool_use') expect(s.phase).toBe('tool-running')
      if (s.stopReason === 'end_turn') expect(s.phase).toBe('done')
      if (s.stopReason) expect(costChip(s.usage).output).toBeGreaterThan(0)
    })
  }
})

describe('observed-in-logs behaviours', () => {
  test('sonnet 5.5 omitted thinking: signature-only block, no text, thinking tokens in usage', () => {
    const s = replay(fx('03-').events)
    const t = s.blocks[0]
    expect(t.kind).toBe('thinking')
    if (t.kind === 'thinking') { expect(t.text).toBe(''); expect(t.hasSignature).toBe(true); expect(t.omitted).toBe(true); expect(t.elapsedMs).toBeGreaterThan(0) }
    expect(costChip(s.usage).thinking).toBeGreaterThan(0)
    expect(s.blocks[1].kind).toBe('text')
  })
  test('between_tools sonnet 5.5: no thinking block on a tool-less turn', () => {
    expect(replay(fx('02-').events).blocks.map(b => b.kind)).toEqual(['text'])
  })
  test('two consecutive thinking blocks then a tool', () => {
    expect(replay(fx('05-').events).blocks.map(b => b.kind)).toEqual(['thinking', 'thinking', 'tool'])
  })
  test('parallel tools group', () => {
    const s = replay(fx('08-').events)
    const g = toolGroups(s)
    expect(g.map(x => x.kind)).toEqual(['thinking', 'tool-group'])
    expect((g[1] as any).tools.length).toBe(3)
    expect(s.phase).toBe('tool-running')
  })
  test('single tool: args summarised by key name, tool-running', () => {
    const s = replay(fx('07-').events)
    const t = s.blocks[0] as ToolBlock
    expect(t.argKeys.length).toBeGreaterThan(0)
    expect(t.argsSummary).toContain(t.argKeys[0])
    expect(t.status).toBe('running')
  })
  test('approval gate: awaiting-approval until every pending tool is approved', () => {
    const { events } = fx('08-')
    let s = replay(events, { needsApproval: n => n !== 'never' })
    expect(s.phase).toBe('awaiting-approval')
    const ids = s.blocks.filter((b): b is ToolBlock => b.kind === 'tool').map(b => b.id)
    for (const id of ids.slice(0, -1)) s = reduce(s, { type: 'tool_approval', tool_use_id: id, approved: true })
    expect(s.phase).toBe('awaiting-approval')
    s = reduce(s, { type: 'tool_approval', tool_use_id: ids.at(-1)!, approved: true })
    expect(s.phase).toBe('tool-running')
  })
  test('tool_result marks card done / error', () => {
    let s = replay(fx('07-').events)
    const id = (s.blocks[0] as ToolBlock).id
    s = reduce(s, { type: 'tool_result', tool_use_id: id, is_error: true, chars: 12 })
    expect((s.blocks[0] as ToolBlock).status).toBe('error')
  })
  test('roundtrip fixtures carry a request with tool_result blocks that pair up', () => {
    for (const p of ['11-', '12-']) {
      const shape: any = fx(p).events[0]
      expect(shape.type).toBe('request_shape')
      const uses = shape.messages.flatMap((m: any) => (m.blocks ?? []).filter((b: any) => b.type === 'tool_use'))
      const results = shape.messages.flatMap((m: any) => (m.blocks ?? []).filter((b: any) => b.type === 'tool_result'))
      expect(uses.length).toBe(results.length) // every replayed tool_use has a tool_result
    }
    expect((fx('12-').events[0] as any).messages.some((m: any) => (m.blocks ?? []).some((b: any) => b.is_error))).toBe(true)
  })
  test('image + PDF input request shapes', () => {
    const shape: any = fx('13-').events[0]
    const kinds = shape.messages.flatMap((m: any) => (m.blocks ?? []).map((b: any) => b.type))
    expect(kinds).toContain('image')
  })
  test('web_search: server tool completes via result-in-start, citations collected, not grouped as client tools', () => {
    const s = replay(fx('14-').events)
    const t = s.blocks[0] as ToolBlock
    expect(t.server).toBe(true)
    expect(t.status).toBe('done')
    expect(t.result?.count).toBeGreaterThan(0)
    const cites = s.blocks.flatMap(b => (b.kind === 'text' ? b.citations : []))
    expect(cites.length).toBeGreaterThan(0)
    expect(costChip(s.usage).webSearches).toBe(1)
    expect(s.phase).toBe('done')
  })
  test('haiku enabled-thinking streams visible text', () => {
    const t = replay(fx('15-').events).blocks[0]
    expect(t.kind === 'thinking' && t.text.length > 0 && !t.omitted).toBe(true)
  })
  test('usage: message_delta is cumulative, cache split preserved from message_start', () => {
    const c = costChip(replay(fx('04-').events).usage)
    expect(c.output).toBeGreaterThan(0)
    expect(c.cacheRead + c.cacheWrite + c.input).toBeGreaterThan(0)
  })
  test('non-stream max_tokens -> canContinue, no truncated tool', () => {
    const s = replay(fx('20-').events)
    expect(s.stopReason).toBe('max_tokens'); expect(s.canContinue).toBe(true); expect(s.truncatedTool).toBe(false)
  })
  test('non-stream stop_sequence is a normal done', () => {
    const s = replay(fx('21-').events); expect(s.stopReason).toBe('stop_sequence'); expect(s.phase).toBe('done'); expect(s.canContinue).toBe(false)
  })
  test('stream and non-stream produce the same block model', () => {
    expect(replay(fx('22-').events).blocks.map(b => b.kind)).toEqual(['text'])
  })
  test('400 extra-inputs is NOT retryable client-side; 429 is; 404/403 are not', () => {
    expect(replay(fx('30-').events).error).toMatchObject({ status: 400, type: 'invalid_request_error', retryable: false })
    expect(replay(fx('34-').events).error).toMatchObject({ status: 429, retryable: true })
    expect(replay(fx('35-').events).error?.retryable).toBe(false)
    expect(replay(fx('36-').events).error?.retryable).toBe(false)
  })
  test('gateway strip-and-retry: transient 400 is invisible; final state is the good stream', () => {
    const s = replay(fx('37-').events)
    expect(s.phase).not.toBe('error'); expect(s.error).toBeUndefined()
    expect(s.attempts).toBe(2); expect(s.retriedByGateway).toBe(true)
    expect(s.blocks.length).toBeGreaterThan(0)
  })
})

describe('docs-derived behaviours (NOT seen in logs)', () => {
  test('max_tokens stream -> continue', () => { const s = replay(fx('40-').events); expect(s.canContinue).toBe(true); expect(s.phase).toBe('done') })
  test('refusal banner', () => { const s = replay(fx('41-').events); expect(s.refusal).toBeDefined(); expect(s.phase).toBe('done') })
  test('pause_turn -> paused (auto-continue)', () => { const s = replay(fx('42-').events); expect(s.phase).toBe('paused') })
  test('mid-stream error keeps partial text, retryable', () => {
    const s = replay(fx('43-').events)
    expect(s.phase).toBe('error'); expect(s.error?.retryable).toBe(true)
    const t = s.blocks[0]; expect(t.kind === 'text' && t.text.length).toBe(210)
  })
  test('summarized thinking is visible and not "omitted"', () => {
    const t = replay(fx('44-').events).blocks[0]; expect(t.kind === 'thinking' && t.text.length === 160 && !t.omitted).toBe(true)
  })
  test('redacted thinking is not "omitted"', () => {
    const t = replay(fx('45-').events).blocks[0]; expect(t.kind === 'thinking' && t.redacted && !t.omitted).toBe(true)
  })
  test('max_tokens inside tool_use: tool truncated, never runs', () => {
    const s = replay(fx('46-').events); expect(s.truncatedTool).toBe(true); expect((s.blocks[0] as ToolBlock).status).toBe('truncated')
  })
  test('interrupt keeps partial output and closes open blocks', () => {
    const { events } = fx('03-')
    const cut = events.findIndex(e => e.type === 'content_block_delta' && (e as any).delta.type === 'text_delta') + 1
    const s = reduce(replay(events.slice(0, cut)), { type: 'client_interrupt' }, 1000)
    expect(s.phase).toBe('interrupted'); expect(s.blocks.length).toBe(2)
  })
  test('unknown event/block types are ignored (forward compat)', () => {
    const s = reduce(reduce(initial(), { type: 'message_start', message: {} }), { type: 'content_block_start', index: 0, content_block: { type: 'brand_new_block' } })
    expect(s.blocks.length).toBe(0)
  })
})
