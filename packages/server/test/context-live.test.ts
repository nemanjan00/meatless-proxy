import { createEventBus, createHooks, type Logger } from '@mp/core'
import { openAiModel } from '@mp/model-openai'
import { memoryQueue } from '@mp/queue'
import { createRecords } from '@mp/records'
import { ContextTopics, createRunner } from '@mp/runner'
import { createSessions } from '@mp/sessions'
import { memoryStore } from '@mp/store'
import { createToolRegistry } from '@mp/tools'
import { employeePrompt } from '@mp/stdlib'
import { afterEach, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

// Opt-in: a real run whose context fills up, so the runner notes it and compacts it with a real summary call
// (MP_LIVE_MODEL_TEST=1, with OPENAI_BASE_URL, OPENAI_API_KEY and MODEL set).
const live = process.env.MP_LIVE_MODEL_TEST === '1'

describe.skipIf(!live)('context management, live (MP_LIVE_MODEL_TEST=1)', () => {
  it('notes the context size, compacts automatically, and the model still knows the facts it needs', {
    timeout: 600_000,
  }, async () => {
    const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env
    if (!OPENAI_BASE_URL || !OPENAI_API_KEY || !MODEL) throw new Error('set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL')
    const model = openAiModel({
      baseUrl: OPENAI_BASE_URL,
      apiKey: OPENAI_API_KEY,
      model: MODEL,
      maxRetries: 1,
      timeoutMs: 170_000,
    })
    const bus = createEventBus()
    const store = memoryStore({ bus })
    const sessions = createSessions({ records: createRecords({ store, bus }), bus })
    const tools = createToolRegistry()
    const filler = (n: number) =>
      Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of page ${n}: routine log output, nothing of note.`).join('\n')
    tools.register(
      {
        name: 'notes.page',
        description: 'Read one page (1 to 6) of the incident notes.',
        parameters: { type: 'object', properties: { page: { type: 'number' } }, required: ['page'] },
        effect: 'read',
        source: 'stdlib',
      },
      async (a) => {
        const page = Number((a as { page?: number }).page)
        const fact =
          page === 1
            ? 'Fact: the fix goes on branch ana/retry-backoff.'
            : page === 2
              ? 'Fact: the ticket is PAY-7, reported by Bo.'
              : 'No facts on this page.'
        return { output: `${fact}\n${filler(page)}` }
      },
    )
    const logged: string[] = []
    const logger: Logger = {
      debug() {},
      info: (msg) => void logged.push(msg),
      warn: (msg) => void logged.push(msg),
      error: (msg) => void logged.push(msg),
      child: () => logger,
    }
    const events: string[] = []
    for (const t of Object.values(ContextTopics)) bus.subscribe(t, () => void events.push(t))
    const runner = createRunner({
      sessions,
      tools,
      model,
      queue: memoryQueue({ bus }),
      hooks: createHooks(),
      bus,
      toolListsFor: async () => ({ allow: ['**'], deny: [] }),
      logger,
      contextWindow: () => 9000,
      compactAt: 70,
      maxSteps: 20,
    })
    const s = await sessions.create({
      employeeId: 'emp_test',
      title: 'Incident',
      toolset: ['notes.page'],
      entries: [{ kind: 'system', content: { text: 'You are a careful engineer. Use the tools you are given.' } }],
    })
    const run = await sessions.createRun({
      sessionId: s.id,
      cause: { type: 'manual' },
      input: [
        {
          kind: 'user',
          content: {
            text: 'Read pages 1 to 6 of the incident notes, one call per page and one page per turn, in order. Then reply with one line: the branch name and the ticket id.',
          },
        },
      ],
    })
    const out = await runner.execute(run.id)
    const r = await sessions.requireRun(run.id)
    const history = await sessions.history(s.id)
    expect(out.status, r.data.pauseReason ?? r.data.result?.error ?? '').toBe('completed')
    expect(events).toContain(ContextTopics.compacted)
    expect(events).not.toContain(ContextTopics.compactFailed)
    expect(events).toContain(ContextTopics.noted)
    // The provider took the summary call without tool definitions.
    expect(logged).not.toContain('summary call without tools was refused; trying with them')
    expect(history.some((e) => e.kind === 'summary' && e.meta.automatic === true)).toBe(true)
    const answer = r.data.result?.output ?? ''
    expect(answer).toContain('ana/retry-backoff')
    expect(answer).toContain('PAY-7')
  })
})

describe.skipIf(!live)('collapsing before automatic compaction, live (MP_LIVE_MODEL_TEST=1)', () => {
  let t: TestApp | undefined
  afterEach(async () => {
    await t?.close()
    t = undefined
  })

  it('a reading-heavy review: the model collapses finished reading after the concrete note, before the harness compacts', {
    timeout: 900_000,
  }, async () => {
    const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env
    if (!OPENAI_BASE_URL || !OPENAI_API_KEY || !MODEL) throw new Error('set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL')
    const model = openAiModel({
      baseUrl: OPENAI_BASE_URL,
      apiKey: OPENAI_API_KEY,
      model: MODEL,
      maxRetries: 1,
      timeoutMs: 170_000,
    })
    t = await testApp({ workers: false, overrides: { model } })
    const s = t.a.services
    const findings: Record<number, { line: number; text: string }> = {
      2: { line: 137, text: 'FINDING: retries use a fixed 50ms delay, no backoff' },
      5: { line: 412, text: 'FINDING: the refund total ignores tax' },
      8: { line: 733, text: 'FINDING: the request timeout is hard-coded to 3 seconds' },
    }
    s.tools.register(
      {
        name: 'code.page',
        description: 'Read one page (1 to 9) of the file under review, 100 numbered lines per page.',
        parameters: { type: 'object', properties: { page: { type: 'number' } }, required: ['page'] },
        effect: 'read',
        source: 'stdlib',
      },
      async (a) => {
        const page = Number((a as { page?: number }).page)
        const lines = Array.from({ length: 100 }, (_, i) => {
          const n = (page - 1) * 100 + i + 1
          const f = findings[page]
          return f && f.line === n ? `${n}: // ${f.text}` : `${n}: const step${n} = apply(state, ${(n * 7) % 13}) // routine`
        })
        return { output: lines.join('\n') }
      },
    )
    // The context rules of the employee prompt, without the rest of it.
    const full = employeePrompt({
      employee: { id: 'emp_test', key: 'ana', data: { name: 'Ana' } } as any,
      contact: { id: 'con_test', data: { name: 'Ana' } } as any,
      now: '2026-10-02T09:00:00.000Z',
    })
    const contextRule = full.split('\n').find((l) => l.startsWith('- Context:'))!
    const bus = createEventBus()
    const order: string[] = []
    bus.subscribe(ContextTopics.noted, (m) => void order.push(`noted:${(m.payload as { percent: number }).percent}`))
    bus.subscribe(ContextTopics.compacted, () => void order.push('compacted'))
    bus.subscribe('tool.called', (m) => {
      const name = (m.payload as { name: string }).name
      if (name.startsWith('sessions.')) order.push(name)
    })
    const runner = createRunner({
      sessions: s.sessions,
      tools: s.tools,
      model,
      queue: memoryQueue({ bus }),
      hooks: createHooks(),
      bus,
      toolListsFor: async () => ({ allow: ['**'], deny: [] }),
      contextWindow: () => 16_000,
      compactAt: 85,
      contextNearAt: 80,
      maxSteps: 40,
    })
    const session = await s.sessions.create({
      employeeId: 'emp_test',
      title: 'Review',
      toolset: ['code.page', 'sessions.rewind', 'sessions.offload', 'sessions.compact', 'sessions.save_metadata'],
      entries: [
        { kind: 'system', content: { text: `You are a careful engineer. Use the tools you are given.\n\n${contextRule}` } },
      ],
    })
    const run = await s.sessions.createRun({
      sessionId: session.id,
      cause: { type: 'manual' },
      input: [
        {
          kind: 'user',
          content: {
            text: 'Review the file: read pages 1 to 9 with code.page, one page per turn, in order. Lines with FINDING are the findings. Then reply with every finding, one per line, as "line N: finding" with the exact line number.',
          },
        },
      ],
    })
    const out = await runner.execute(run.id)
    const r = await s.sessions.requireRun(run.id)
    if (process.env.MP_LIVE_DEBUG) console.log(order.join('\n'), '\n', r.data.result?.output)
    expect(out.status, r.data.pauseReason ?? r.data.result?.error ?? '').toBe('completed')
    const firstNote = order.findIndex((x) => x.startsWith('noted:'))
    const firstCollapse = order.findIndex((x) => x === 'sessions.rewind' || x === 'sessions.compact')
    const firstAuto = order.indexOf('compacted')
    expect(firstNote, order.join(', ')).toBeGreaterThanOrEqual(0)
    expect(firstCollapse, `the model freed space itself: ${order.join(', ')}`).toBeGreaterThan(firstNote)
    if (firstAuto >= 0) expect(firstCollapse, order.join(', ')).toBeLessThan(firstAuto)
    const answer = r.data.result?.output ?? ''
    for (const f of Object.values(findings)) expect(answer).toContain(String(f.line))
    // No stale notes survive in the session's history.
    const history = await s.sessions.history(session.id)
    const lastSummary = history.findLastIndex((e) => e.kind === 'summary')
    const notes = history.slice(lastSummary + 1).filter((e) => e.meta.contextNote !== undefined)
    expect(notes.length).toBeLessThanOrEqual(2)
  })
})
