import { MpError, type Json } from '@mp/core'
import { callTools, contextWindowOf, reply, type ModelRequest } from '@mp/model'
import type { AssistantContent, PointerContent, SummaryContent } from '@mp/sessions'
import type { Entry } from '@mp/store'
import { describe, expect, it } from 'vitest'
import {
  COMPACTION_PROMPT,
  compactionCut,
  contextNoteDecision,
  ContextTopics,
  notedInHistory,
  renderMessages,
} from '../src/index.ts'
import { harness } from './harness.ts'

const kinds = (entries: { kind: string }[]) => entries.map((e) => e.kind)
const isSummaryCall = (req: ModelRequest) => {
  const last = req.messages.at(-1)
  return last?.role === 'user' && last.content === COMPACTION_PROMPT
}
const overflow = () =>
  new MpError('model_request', 'model request failed: HTTP 400: context length exceeded: 300000 tokens', { status: 400 })

/** Every assistant entry with tool calls is followed directly by the answers to all of them. */
function expectPairsIntact(path: Entry[]) {
  path.forEach((e, i) => {
    if (e.kind !== 'assistant') return
    const calls = (e.content as unknown as AssistantContent).toolCalls ?? []
    const next = path.slice(i + 1, i + 1 + calls.length)
    expect(next.map((x) => (x.content as any).toolCallId)).toEqual(calls.map((c) => c.id))
  })
  // Nothing in the history answers a call whose assistant entry isn't there.
  const made = new Set(path.flatMap((e) => ((e.content as any)?.toolCalls ?? []).map((c: { id: string }) => c.id)))
  for (const e of path) {
    const id = (e.content as any)?.toolCallId
    if ((e.kind === 'tool_result' || e.kind === 'pointer') && id) expect(made.has(id)).toBe(true)
  }
}

/** A model that calls `grow` `times` times (any summary call gets `summary`), then replies. */
function growScript(times: number, summary: (req: ModelRequest) => string | Error = () => 'SUMMARY: the goal, the ids') {
  let main = 0
  return (req: ModelRequest) => {
    if (isSummaryCall(req)) return summary(req)
    main++
    return main <= times ? callTools([{ name: 'grow', id: `call_g${main}` }]) : reply('done')
  }
}

function withGrow(h: ReturnType<typeof harness>, chars = 800) {
  h.tool({ name: 'grow' }, async () => ({ output: 'x'.repeat(chars) }))
}

describe('context windows', () => {
  it('knows the windows of common models and falls back to 128k', () => {
    expect(contextWindowOf('kimi-k2.7-code')).toBe(262_144)
    expect(contextWindowOf('kimi-k3')).toBe(262_144)
    expect(contextWindowOf('moonshot/kimi-k2-0711-preview')).toBe(131_072)
    expect(contextWindowOf('claude-sonnet-4-5')).toBe(200_000)
    expect(contextWindowOf('claude-fable-5')).toBe(200_000)
    expect(contextWindowOf('claude-haiku-4-5')).toBe(200_000)
    expect(contextWindowOf('something-else')).toBe(128_000)
    expect(contextWindowOf('kimi-k2.7-code', 90_000)).toBe(90_000)
  })

  it('notes each threshold once per crossing, and again after falling back below it', () => {
    const t = [50, 75]
    expect(contextNoteDecision(10, 0, t)).toEqual({ noted: 0 })
    expect(contextNoteDecision(55, 0, t)).toEqual({ note: 50, noted: 50 })
    expect(contextNoteDecision(60, 50, t)).toEqual({ noted: 50 })
    expect(contextNoteDecision(80, 50, t)).toEqual({ note: 75, noted: 75 })
    expect(contextNoteDecision(90, 75, t)).toEqual({ noted: 75 })
    // Straight past both: one note, for the higher one.
    expect(contextNoteDecision(80, 0, t)).toEqual({ note: 75, noted: 75 })
    // A compaction brought it down: armed again.
    expect(contextNoteDecision(30, 75, t)).toEqual({ noted: 0 })
    expect(contextNoteDecision(60, 75, t)).toEqual({ noted: 50 })
  })

  it('reads the notes already in a history, reset by a summary', () => {
    const e = (kind: string, meta: Record<string, Json> = {}) => ({ kind, meta, content: {} }) as unknown as Entry
    expect(notedInHistory([e('system'), e('system', { contextNote: 50 }), e('user')])).toBe(50)
    expect(notedInHistory([e('system', { contextNote: 75 }), e('summary'), e('user')])).toBe(0)
  })
})

describe('context notes', () => {
  it('tells the model at 50% and 75%, once each, never between a call and its result', async () => {
    const h = harness(growScript(6), { contextWindow: () => 1000, compactAt: 0 })
    withGrow(h)
    const s = await h.session(['grow'])
    const run = await h.start(s.id)
    expect((await h.runner.execute(run.id)).status).toBe('completed')
    const path = await h.sessions.history(s.id)
    const notes = path.filter((e) => typeof e.meta.contextNote === 'number')
    expect(notes.map((n) => n.meta.contextNote)).toEqual([50, 75])
    for (const n of notes) {
      expect(n.kind).toBe('system')
      expect((n.content as any).text).toMatch(/^\[context: about [\d.]+k? of 1k tokens \(\d+%\)\] Keep it lean: sessions\.rewind/)
    }
    expectPairsIntact(path)
    // The model saw them, right before its next call.
    const sawNote = h.model.calls.filter((c) =>
      c.messages.some((m) => m.role === 'system' && /^\[context:/.test(m.content ?? '')),
    )
    expect(sawNote.length).toBeGreaterThan(0)
    // The run records how full its context was at the last call.
    const ctx = (await h.sessions.requireRun(run.id)).data.context!
    expect(ctx).toMatchObject({ window: 1000, noted: 75, model: 'scripted' })
    expect(ctx.tokens).toBeGreaterThan(750)
    expect(ctx.chars).toBeGreaterThan(0)
  })

  it("doesn't repeat a note a continuing session already has, but an ephemeral run gets its own", async () => {
    const h = harness(growScript(4), { contextWindow: () => 1000, compactAt: 0 })
    withGrow(h)
    const s = await h.session(['grow'])
    await h.runner.execute((await h.start(s.id)).id)
    const committed = (await h.sessions.history(s.id)).filter((e) => e.meta.contextNote !== undefined).length
    expect(committed).toBeGreaterThan(0)
    // A next continuing run starts over the threshold already noted: no new note.
    const r2 = await h.sessions.createRun({
      sessionId: s.id,
      cause: { type: 'manual' },
      input: [{ kind: 'user', content: { text: 'more' } }],
    })
    await h.runner.execute(r2.id)
    expect((await h.sessions.history(s.id)).filter((e) => e.meta.contextNote !== undefined).length).toBe(committed)
    // An ephemeral run's notes go with it; the session stays as it was.
    const r3 = await h.start(s.id, 'look', 'ephemeral')
    const before = (await h.sessions.history(s.id)).length
    await h.runner.execute(r3.id)
    expect((await h.sessions.history(s.id)).length).toBe(before)
  })
})

describe('automatic compaction', () => {
  it('summarises near the limit, keeps the latest turns verbatim, never splits a call from its result', async () => {
    const h = harness(growScript(8), { contextWindow: () => 2000, compactAt: 85, compactKeep: 0.15, contextNotes: [] })
    withGrow(h)
    const seen: unknown[] = []
    h.bus.subscribe(ContextTopics.compacted, (m) => void seen.push(m.payload))
    const s = await h.session(['grow'])
    const run = await h.start(s.id, 'grow it')
    expect((await h.runner.execute(run.id)).status).toBe('completed')

    const summaryCalls = h.model.calls.filter(isSummaryCall)
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1)
    // No tools in the summary call, and a length cap.
    expect(summaryCalls[0]!.tools).toBeUndefined()
    expect(summaryCalls[0]!.maxTokens).toBe(8000)

    const path = await h.sessions.history(s.id)
    expect(path[0]!.kind).toBe('system')
    const sums = path.filter((e) => e.kind === 'summary')
    expect(sums.length).toBeGreaterThanOrEqual(1)
    const sum = sums.at(-1)!
    expect((sum.content as unknown as SummaryContent).text).toBe('SUMMARY: the goal, the ids')
    expect(sum.meta).toMatchObject({ op: 'compact', automatic: true, window: 2000 })
    expect(sum.meta.tokensBefore).toBeGreaterThanOrEqual(1700)
    // The latest entries were kept verbatim (copies), starting with an assistant entry, not a result.
    const i = path.indexOf(sum)
    const kept = path.slice(i + 1)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept[0]!.kind).toBe('assistant')
    expect(kept.some((e) => typeof e.meta.copiedFrom === 'string')).toBe(true)
    expectPairsIntact(path)
    // The model went on from the summary.
    const after = h.model.calls[h.model.calls.indexOf(summaryCalls.at(-1)!) + 1]!
    expect(after.messages[1]!.content).toMatch(/^\[summary of earlier work in this session, written automatically/)
    expect(seen[0]).toMatchObject({ runId: run.id, sessionId: s.id, automatic: true, window: 2000 })
    // The detailed branch is still stored.
    expect((await h.store.entries.get((sum.content as unknown as SummaryContent).replacesTip))?.kind).toBeTruthy()
  })

  it('keeps a turn whole or summarises it whole', () => {
    const mk = (id: string, kind: string, content: Json) => ({ id, kind, content, meta: {} }) as unknown as Entry
    const history = [
      mk('e0', 'system', { text: 'sys' }),
      mk('e1', 'user', { text: 'u'.repeat(400) }),
      mk('e2', 'assistant', {
        text: null,
        toolCalls: [
          { id: 'a', name: 't', arguments: '{}' },
          { id: 'b', name: 't', arguments: '{}' },
        ],
      }),
      mk('e3', 'tool_result', { toolCallId: 'a', name: 't', output: 'r'.repeat(400) }),
      mk('e4', 'tool_result', { toolCallId: 'b', name: 't', output: 'r'.repeat(40) }),
      mk('e5', 'assistant', { text: 'ok' }),
    ]
    // A budget that would cut between the two results moves past them instead.
    const cut = compactionCut(history, 40, 0.25)
    expect(history[cut]?.id).toBe('e5')
    // A big budget keeps everything after the first entry; a tiny one keeps nothing.
    expect(compactionCut(history, 100_000, 0.25)).toBe(1)
    expect(compactionCut([...history, mk('e6', 'tool_result', { toolCallId: 'z', output: 'x'.repeat(5000) })], 10, 0.25)).toBe(7)
  })

  it('carries on when the summary call fails', async () => {
    const h = harness(
      growScript(6, () => new Error('provider hiccup')),
      { contextWindow: () => 1000, compactAt: 60, contextNotes: [] },
    )
    withGrow(h, 300)
    const failed: unknown[] = []
    h.bus.subscribe(ContextTopics.compactFailed, (m) => void failed.push(m.payload))
    const s = await h.session(['grow'])
    const run = await h.start(s.id)
    expect((await h.runner.execute(run.id)).status).toBe('completed')
    expect(failed.length).toBeGreaterThan(0)
    expect(failed[0]).toMatchObject({ runId: run.id, error: 'provider hiccup' })
    expect((await h.sessions.history(s.id)).some((e) => e.kind === 'summary')).toBe(false)
  })

  it('pauses with a clear reason when the summary fails and the request no longer fits', async () => {
    const h = harness(
      growScript(10, () => new Error('provider hiccup')),
      { contextWindow: () => 1000, compactAt: 85, contextNotes: [], toolResultMaxChars: 0 },
    )
    withGrow(h, 1500)
    const s = await h.session(['grow'])
    const run = await h.start(s.id)
    const out = await h.runner.execute(run.id)
    expect(out.status).toBe('paused')
    const r = await h.sessions.requireRun(run.id)
    expect(r.data.state).toBe('paused')
    expect(r.data.pauseReason).toMatch(
      /^context full: about [\d.]+k tokens for a 1k-token context window, and automatic compaction failed: provider hiccup\. Resuming/,
    )
  })

  it('compacts when the provider says the request is too long, then retries', async () => {
    let calls = 0
    const h = harness(
      (req) => {
        if (isSummaryCall(req)) return 'SUMMARY: so far'
        calls++
        if (calls === 1) return callTools([{ name: 'grow', id: 'call_1' }])
        if (calls === 2) return callTools([{ name: 'grow', id: 'call_2' }])
        if (calls === 3) return overflow()
        return reply('done')
      },
      { contextWindow: () => 1_000_000, contextNotes: [] },
    )
    withGrow(h, 100)
    const s = await h.session(['grow'])
    const run = await h.start(s.id)
    expect((await h.runner.execute(run.id)).status).toBe('completed')
    expect(h.model.calls.filter(isSummaryCall)).toHaveLength(1)
    expect((await h.sessions.history(s.id)).some((e) => e.kind === 'summary' && e.meta.automatic === true)).toBe(true)
  })

  it('pauses when the request is still too long after compacting, or compaction is off', async () => {
    const h = harness((req) => (isSummaryCall(req) ? 'SUMMARY' : overflow()), {
      contextWindow: () => 1_000_000,
      contextNotes: [],
    })
    const s = await h.session()
    const run = await h.start(s.id, 'a '.repeat(50))
    // Nothing to summarise but the first entry and the input: compaction keeps the input, still too long.
    expect((await h.runner.execute(run.id)).status).toBe('paused')
    expect((await h.sessions.requireRun(run.id)).data.pauseReason).toMatch(/^context full: .*context window/)

    const off = harness([overflow()], { compactAt: 0 })
    const s2 = await off.session()
    const r2 = await off.start(s2.id)
    expect((await off.runner.execute(r2.id)).status).toBe('paused')
    expect((await off.sessions.requireRun(r2.id)).data.pauseReason).toMatch(/\(automatic compaction is off\)/)
  })

  it('compacts an ephemeral run only for itself; a continuing run commits the compacted history', async () => {
    const opts = { contextWindow: () => 2000, compactAt: 85, contextNotes: [] }
    const eph = harness(growScript(8), opts)
    withGrow(eph)
    const s1 = await eph.session(['grow'])
    const r1 = await eph.start(s1.id, 'go', 'ephemeral')
    expect((await eph.runner.execute(r1.id)).status).toBe('completed')
    expect(eph.model.calls.some(isSummaryCall)).toBe(true)
    // The run compacted its own branch; the session's head never moved.
    expect(kinds(await eph.sessions.history(s1.id))).toEqual(['system'])
    expect(kinds(await eph.sessions.runHistory(r1.id))).toContain('summary')

    const cont = harness(growScript(8), opts)
    withGrow(cont)
    const s2 = await cont.session(['grow'])
    const r2 = await cont.start(s2.id, 'go', 'continuing')
    await cont.runner.execute(r2.id)
    const h2 = await cont.sessions.history(s2.id)
    expect(h2[0]!.kind).toBe('system')
    expect(h2.some((e) => e.kind === 'summary' && e.meta.automatic === true)).toBe(true)
    expect((await cont.sessions.requireRun(r2.id)).data.committed?.as).toBe('full')
  })
})

describe('oversized tool results', () => {
  it('keeps a preview and a pointer; the full result is stored and restore brings it back', async () => {
    const big = `HEAD-${'m'.repeat(6000)}-TAIL`
    let pointerId = ''
    const h = harness(
      [
        callTools([
          { name: 'dump', id: 'call_big' },
          { name: 'small', id: 'call_small' },
        ]),
        callTools([{ name: 'restore', id: 'call_restore' }]),
        reply('done'),
      ],
      { toolResultMaxChars: 1000 },
    )
    let dumps = 0
    h.tool({ name: 'dump' }, async () => {
      dumps++
      return { output: big }
    })
    h.tool({ name: 'small' }, async () => ({ output: 'tiny' }))
    h.tool({ name: 'restore', effect: 'idempotent' }, async (_a, ctx) => {
      const p = (await h.sessions.runHistory(ctx.runId)).find((e) => e.kind === 'pointer')!
      pointerId = p.id
      return { output: 'restoring', control: [{ type: 'restore', pointerEntryId: p.id }] }
    })
    const offloaded: unknown[] = []
    h.bus.subscribe(ContextTopics.resultOffloaded, (m) => void offloaded.push(m.payload))
    const s = await h.session(['dump', 'small', 'restore'])
    const run = await h.start(s.id)
    expect((await h.runner.execute(run.id)).status).toBe('completed')
    // Each tool ran once: the pointer counts as the big call's result.
    expect(dumps).toBe(1)

    // The second model call saw the preview, as the answer to the big call, next to the small result.
    const second = h.model.calls[1]!.messages
    const toolMsgs = second.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['call_big', 'call_small'])
    const preview = toolMsgs[0]!.content!
    expect(preview.startsWith('[offloaded tool result]')).toBe(true)
    expect(preview).toContain('HEAD-')
    expect(preview).toContain('-TAIL')
    expect(preview).toContain('sessions.restore')
    expect(preview.length).toBeLessThan(big.length)
    expect(second.at(-2)!.role).toBe('tool')

    const ptr = (await h.store.entries.get(pointerId))!
    const pc = ptr.content as unknown as PointerContent
    expect(pc).toMatchObject({ toolCallId: 'call_big', toolName: 'dump' })
    expect(ptr.meta).toMatchObject({ automatic: true, chars: big.length, offloadedKind: 'tool_result' })
    expect(pc.text).toContain(`entryId "${pc.original}"`)
    expect(((await h.store.entries.get(pc.original))!.content as any).output).toBe(big)
    expect(offloaded[0]).toMatchObject({ callId: 'call_big', name: 'dump', chars: big.length, entryId: pc.original })

    // After the restore the model saw the whole result again.
    const third = h.model.calls[2]!.messages
    expect(third.find((m) => m.role === 'tool' && m.tool_call_id === 'call_big')!.content).toBe(big)
    expectPairsIntact(await h.sessions.history(s.id))
  })

  it('leaves image results and small results alone, and can be turned off', async () => {
    const ref = { source: 'file' as const, owner: 'emp_test', path: 'a.png', sha256: 'x', name: 'a.png', mime: 'image/png' }
    const h = harness([callTools([{ name: 'shot', id: 'c1' }]), reply('ok')], { toolResultMaxChars: 100 })
    h.tool({ name: 'shot' }, async () => ({ output: 'y'.repeat(500), images: [ref] }))
    const s = await h.session(['shot'])
    await h.runner.execute((await h.start(s.id)).id)
    expect((await h.sessions.history(s.id)).some((e) => e.kind === 'pointer')).toBe(false)

    const off = harness([callTools([{ name: 'dump', id: 'c1' }]), reply('ok')], { toolResultMaxChars: 0 })
    off.tool({ name: 'dump' }, async () => ({ output: 'z'.repeat(50_000) }))
    const s2 = await off.session(['dump'])
    await off.runner.execute((await off.start(s2.id)).id)
    expect((await off.sessions.history(s2.id)).some((e) => e.kind === 'pointer')).toBe(false)
  })

  it('renders a pointer for a tool result as the answer to its call', () => {
    const e = (id: string, kind: string, content: Json, meta: Record<string, Json> = {}) =>
      ({ id, kind, content, meta }) as unknown as Entry
    const msgs = renderMessages([
      e('1', 'system', { text: 's' }),
      e('2', 'assistant', { text: null, toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }] }),
      e('3', 'pointer', { text: 'preview', original: 'x', toolCallId: 'c1', toolName: 't' }),
      e('4', 'pointer', { text: 'old note', original: 'y' }),
    ])
    expect(msgs.slice(2)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: '[offloaded tool result] preview' },
      { role: 'user', content: '[offloaded message] old note' },
    ])
  })
})
