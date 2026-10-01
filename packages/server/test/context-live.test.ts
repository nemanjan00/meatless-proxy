import { createEventBus, createHooks, type Logger } from '@mp/core'
import { openAiModel } from '@mp/model-openai'
import { memoryQueue } from '@mp/queue'
import { createRecords } from '@mp/records'
import { ContextTopics, createRunner } from '@mp/runner'
import { createSessions } from '@mp/sessions'
import { memoryStore } from '@mp/store'
import { createToolRegistry } from '@mp/tools'
import { describe, expect, it } from 'vitest'

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
