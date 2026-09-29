import {
  type ApiEntry,
  type ChecklistData,
  channelsFor,
  type EventData,
  type LiveChannel,
  type LiveEvent,
  type LiveHandler,
  type LiveSource,
  type LiveStatus,
  type LiveTopic,
  type LiveTopics,
  type MessageData,
  type RunData,
  type SessionData,
} from '@mp/api'
import { advancePreviewCommit, CHN, CON, EMP, type MockDb, RUN, SES, mockId } from './data.ts'

/** An in-memory `LiveSource`: `emit` delivers to subscribers on the channels the server would use. */
export interface MockLive extends LiveSource {
  emit<T extends LiveTopic>(topic: T, payload: LiveTopics[T]): void
}

export function createMockLive(now: () => number = Date.now): MockLive {
  const handlers = new Set<{ chans: Set<LiveChannel>; fn: LiveHandler }>()
  const statusHandlers = new Set<(s: LiveStatus) => void>()
  let status: LiveStatus = 'open'
  return {
    get status() {
      return status
    },
    subscribe(chans, fn) {
      const h = { chans: new Set(chans), fn }
      handlers.add(h)
      return () => handlers.delete(h)
    },
    onStatus(fn) {
      statusHandlers.add(fn)
      fn(status)
      return () => statusHandlers.delete(fn)
    },
    close() {
      status = 'closed'
      for (const h of statusHandlers) h(status)
      handlers.clear()
    },
    emit(topic, payload) {
      const at = new Date(now()).toISOString()
      for (const channel of channelsFor(topic, payload)) {
        const ev = { type: 'event', channel, topic, payload, at } as LiveEvent
        for (const h of [...handlers]) if (h.chans.has(channel)) h.fn(ev)
      }
    },
  }
}

// ─── the simulator ──────────────────────────────────────────────────────────

type Step =
  | { kind: 'model'; reasoning: string; content: string; calls?: { name: string; args: Record<string, unknown> }[] }
  | { kind: 'tool'; name: string; output: unknown; isError?: boolean; ms: number }

const SCRIPTS: Record<string, Step[]> = {
  [RUN.r2]: [
    {
      kind: 'model',
      reasoning:
        'INV-1002 has the duplicate. The refund is $412.00, above the $250 limit, so the refund procedure applies and Ana has to approve. ',
      content: 'The duplicate is on INV-1002: $412.00. Starting the refund approval procedure and asking Ana in the thread.',
      calls: [{ name: 'procedures.run', args: { procedure: 'Refund approval', for: 'PAY-123' } }],
    },
    { kind: 'tool', name: 'procedures.run', output: { session: SES.refund123, state: 'suspended' }, ms: 1400 },
    {
      kind: 'model',
      reasoning: 'While waiting, write down the retry-key finding so PAY-140 can use it. ',
      content: 'Writing the retry-key finding to the runbook chapter before waiting.',
      calls: [{ name: 'docs.write', args: { doc: 'Payments API', chapter: 'Runbooks' } }],
    },
    { kind: 'tool', name: 'docs.write', output: { ok: true, version: 14 }, ms: 1100 },
    {
      kind: 'model',
      reasoning: 'Update the session document with what is done and what is open. ',
      content: 'Updated the session document. Waiting for the approval and the last invoice check.',
      calls: [{ name: 'sessions.save_metadata', args: { document: '…' } }],
    },
    { kind: 'tool', name: 'sessions.save_metadata', output: { ok: true }, ms: 700 },
  ],
  [RUN.r4]: [
    {
      kind: 'model',
      reasoning: 'Two charges on the invoice. Compare their idempotency keys. ',
      content: 'INV-1002 has two charges with keys INV-1002-1 and INV-1002-2.',
      calls: [{ name: 'billing.get_charge', args: { id: 'ch_example_2' } }],
    },
    { kind: 'tool', name: 'billing.get_charge', output: { id: 'ch_example_2', retryOf: 'ch_example_1' }, ms: 1600 },
  ],
  [RUN.r21]: [
    {
      kind: 'model',
      reasoning: 'Postgres is the big one. Check replication slots, a stale slot keeps WAL around. ',
      content: 'Checking replication slots on the staging database.',
      calls: [
        {
          name: 'containers.exec',
          args: { env: 'staging-eu-1', command: "psql -c 'select slot_name, active from pg_replication_slots'" },
        },
      ],
    },
    { kind: 'tool', name: 'containers.exec', output: 'slot_name       | active\n test_slot_0921 | f', ms: 1800 },
    {
      kind: 'model',
      reasoning: 'An inactive slot from last week. Bob said not to drop anything without asking. Ask him. ',
      content: '@bob there is an inactive replication slot `test_slot_0921` holding about 180G of WAL. OK to drop it?',
      calls: [{ name: 'chat.post', args: { channel: '#inc-42-staging-disk' } }],
    },
    { kind: 'tool', name: 'chat.post', output: { ok: true }, ms: 600 },
  ],
}

const BOB_LINES = [
  'Checking the slot now, give me a minute.',
  'Yes, `test_slot_0921` is from my load test. OK to drop it.',
  'Disk back at 41% on my side too. Thanks.',
  'Can you add a note to the staging runbook about test slots?',
]

interface RunSim {
  runId: string
  step: number
  pos: number
  phase: 'reasoning' | 'content' | 'tool'
  toolUntil: number
  callSeq: number
  steps: number
}

export interface SimulationOptions {
  tickMs?: number
  /** Characters per delta. */
  chunk?: number
  /** How often a background event or chat message arrives, in ticks. */
  backgroundEvery?: number
}

/**
 * Makes the mock feel alive: running runs stream model output token by
 * token, call tools, append entries and record usage; now and then an event
 * arrives or someone posts in chat. Mutates `db` so reloads agree with the
 * stream. Returns a stop function.
 */
export function startSimulation(db: MockDb, live: MockLive, opts: SimulationOptions = {}): () => void {
  const tickMs = opts.tickMs ?? 70
  const chunk = opts.chunk ?? 4
  const every = opts.backgroundEvery ?? 110
  const sims = new Map<string, RunSim>()
  for (const runId of Object.keys(SCRIPTS))
    sims.set(runId, { runId, step: 0, pos: 0, phase: 'reasoning', toolUntil: 0, callSeq: 100, steps: 0 })
  let ticks = 0
  const iso = () => new Date(db.now()).toISOString()
  const runRec = (id: string) =>
    db.records.get('run')!.get(id)! as unknown as { data: RunData; version: number; updatedAt: string }
  const append = (runId: string, kind: string, content: unknown, meta: Record<string, unknown> = {}) => {
    const run = runRec(runId)
    const entry: ApiEntry = {
      id: mockId('ent', ++db.seq),
      parent: run.data.tip,
      kind,
      content: content as ApiEntry['content'],
      hash: String(db.seq).padStart(64, '0'),
      meta: { runId, ...meta } as ApiEntry['meta'],
      createdAt: iso(),
    }
    db.entries.set(entry.id, entry)
    run.data = { ...run.data, tip: entry.id, steps: run.data.steps + (kind === 'assistant' ? 1 : 0) }
    run.version++
    run.updatedAt = iso()
    live.emit('entry.appended', { sessionId: run.data.sessionId, runId, entry })
    return entry
  }

  const tickRun = (sim: RunSim) => {
    const run = runRec(sim.runId)
    if (run?.data.state !== 'running' || db.control.paused) return
    const script = SCRIPTS[sim.runId]!
    const step = script[sim.step % script.length]!
    const sessionId = run.data.sessionId
    if (step.kind === 'model') {
      const stream = db.streaming.get(sim.runId) ?? { content: '', reasoning: '' }
      if (sim.pos === 0 && sim.phase === 'reasoning') {
        db.steps.set(sim.runId, { kind: 'model', label: 'Thinking', since: iso() })
        live.emit('step.started', { runId: sim.runId, sessionId, step: ++sim.steps, kind: 'model' })
        stream.content = ''
        stream.reasoning = ''
      }
      const text = sim.phase === 'reasoning' ? step.reasoning : step.content
      const piece = text.slice(sim.pos, sim.pos + chunk)
      sim.pos += chunk
      if (sim.phase === 'reasoning') stream.reasoning += piece
      else stream.content += piece
      db.streaming.set(sim.runId, stream)
      if (piece)
        live.emit('model.delta', {
          runId: sim.runId,
          sessionId,
          ...(sim.phase === 'reasoning' ? { reasoning: piece } : { content: piece }),
        })
      if (sim.pos >= text.length) {
        if (sim.phase === 'reasoning') {
          sim.phase = 'content'
          sim.pos = 0
          return
        }
        // model call done: entry, usage, tool calls
        const calls = (step.calls ?? []).map((c) => ({
          id: `c${++sim.callSeq}`,
          name: c.name,
          arguments: JSON.stringify(c.args),
        }))
        const input = 24_000 + sim.steps * 700
        const usage = { input, output: 120 + step.content.length, cached: input - 900, reasoning: step.reasoning.length }
        append(
          sim.runId,
          'assistant',
          { text: step.content, reasoning: step.reasoning, ...(calls.length ? { toolCalls: calls } : {}) },
          { usage },
        )
        const model = run.data.employeeId === EMP.infra ? 'k3' : 'kimi-k2-7-code'
        const cost = (900 * 0.6 + (input - 900) * 0.15 + usage.output * 2.5) / 1_000_000
        db.usage.push({
          runId: sim.runId,
          sessionId,
          rootSessionId: (db.records.get('session')!.get(sessionId)!.data as SessionData).rootId,
          employeeId: run.data.employeeId,
          model,
          ...(calls[0] ? { tool: calls[0].name } : {}),
          input,
          output: usage.output,
          cached: usage.cached,
          reasoning: usage.reasoning,
          cost,
          at: iso(),
        })
        live.emit('usage.recorded', { runId: sim.runId, sessionId, employeeId: run.data.employeeId, model, usage, cost })
        db.streaming.delete(sim.runId)
        for (const c of calls) {
          live.emit('tool.called', { runId: sim.runId, sessionId, callId: c.id, name: c.name, args: JSON.parse(c.arguments) })
          live.emit('step.started', { runId: sim.runId, sessionId, step: ++sim.steps, kind: 'tool', name: c.name })
          db.steps.set(sim.runId, { kind: 'tool', label: c.name, since: iso() })
          db.recentTools.set(sim.runId, [...(db.recentTools.get(sim.runId) ?? []), { name: c.name, at: iso() }].slice(-6))
        }
        sim.step++
        sim.pos = 0
        sim.phase = 'tool'
        sim.toolUntil = 0
      }
      return
    }
    // tool step
    if (!sim.toolUntil) {
      sim.toolUntil = db.now() + step.ms
      return
    }
    if (db.now() < sim.toolUntil) return
    const callId = `c${sim.callSeq}`
    append(sim.runId, 'tool_result', {
      toolCallId: callId,
      name: step.name,
      output: step.output,
      ...(step.isError ? { isError: true } : {}),
    })
    live.emit('tool.result', { runId: sim.runId, sessionId, callId, name: step.name, isError: !!step.isError })
    if (step.name === 'docs.write') checkItem(sessionId, 'itm_6')
    sim.step++
    sim.pos = 0
    sim.phase = 'reasoning'
    sim.toolUntil = 0
  }

  const checkItem = (sessionId: string, itemId: string) => {
    const list = [...(db.records.get('checklist')?.values() ?? [])].find((c) => (c.data as ChecklistData).sessionId === sessionId)
    if (!list) return
    const data = list.data as ChecklistData
    const item = data.items.find((i) => i.id === itemId)
    if (!item || item.checked) return
    item.checked = true
    item.checkedAt = iso()
    list.version++
    live.emit('checklist.changed', { sessionId, checklist: list as never })
  }

  const backgroundEvents: (() => void)[] = [
    () => {
      const id = mockId('evt', ++db.seq)
      const data: EventData = {
        source: 'mcp:slack',
        type: 'message.posted',
        dedupeKey: `slack:${id}`,
        subject: { system: 'slack', ref: '#general' },
        payload: { channel: '#general', text: 'is the office wifi down for anyone else?' },
        receivedAt: iso(),
        routed: true,
        matched: ['fallback'],
      }
      const rec = { kind: 'event', id, version: 1, key: null, data, createdAt: iso(), updatedAt: iso() }
      db.records.get('event')!.set(id, rec)
      live.emit('event.ingested', { event: rec })
    },
    () => {
      const id = mockId('msg', ++db.seq)
      const root = mockId('msg', 20)
      const data: MessageData = {
        channelId: CHN.inc42,
        threadId: root,
        author: { type: 'person', id: CON.bob, name: 'Bob Smith' },
        text: BOB_LINES[bobLine++ % BOB_LINES.length]!,
        tags: [],
        mentions: [],
      }
      const rec = { kind: 'message', id, version: 1, key: null, data, createdAt: iso(), updatedAt: iso() }
      db.records.get('message')!.set(id, rec)
      const r = db.records.get('message')!.get(root)!
      const rd = r.data as MessageData
      r.data = { ...rd, replyCount: (rd.replyCount ?? 0) + 1, lastReplyAt: iso() }
      live.emit('chat.message', { channelId: CHN.inc42, message: rec as never })
    },
    () => {
      const id = mockId('evt', ++db.seq)
      const data: EventData = {
        source: 'mcp:linear',
        type: 'comment.added',
        dedupeKey: `linear:${id}`,
        subject: { system: 'linear', ref: 'PAY-140', title: 'Webhook retries give up too early' },
        actorId: CON.ana,
        payload: { text: 'Raising the limit for this one, go ahead.' },
        receivedAt: iso(),
        routed: true,
        matched: ['subscription'],
      }
      const rec = { kind: 'event', id, version: 1, key: null, data, createdAt: iso(), updatedAt: iso() }
      db.records.get('event')!.set(id, rec)
      live.emit('event.ingested', { event: rec })
    },
    () => {
      // The employee commits: the demo preview reloads on the new commit.
      const c = advancePreviewCommit(db, SES.pay123)
      if (c) live.emit('preview.commit', c)
    },
  ]
  let bg = 0
  let bobLine = 0

  const timer = setInterval(() => {
    ticks++
    for (const sim of sims.values()) tickRun(sim)
    if (ticks % every === 0) backgroundEvents[bg++ % backgroundEvents.length]!()
  }, tickMs)
  return () => clearInterval(timer)
}
