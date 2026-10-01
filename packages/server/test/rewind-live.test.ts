import { createEventBus, createHooks } from '@mp/core'
import { openAiModel } from '@mp/model-openai'
import { memoryQueue } from '@mp/queue'
import { createRunner, renderMessages } from '@mp/runner'
import type { Entry } from '@mp/store'
import { afterEach, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

// Opt-in: a real model reads a few pages over several tool calls, is then asked to collapse the reading, and
// does it with sessions.rewind from/to (MP_LIVE_MODEL_TEST=1, with OPENAI_BASE_URL, OPENAI_API_KEY and MODEL set).
const live = process.env.MP_LIVE_MODEL_TEST === '1'

const text = (e: Entry) => String((e.content as { text?: unknown } | null)?.text ?? '')
const chars = (h: Entry[]) => JSON.stringify(renderMessages(h)).length

describe.skipIf(!live)('sessions.rewind, live (MP_LIVE_MODEL_TEST=1)', () => {
  let t: TestApp | undefined
  afterEach(async () => {
    await t?.close()
    t = undefined
  })

  it('collapses the reading with from and to; the messages and the answer survive and the context shrinks', {
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
    t = await testApp({ workers: false, overrides: { model } })
    const s = t.a.services
    const filler = (n: number) =>
      Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of page ${n}: routine log output, nothing of note.`).join('\n')
    s.tools.register(
      {
        name: 'notes.page',
        description: 'Read one page (1 to 4) of the incident notes.',
        parameters: { type: 'object', properties: { page: { type: 'number' } }, required: ['page'] },
        effect: 'read',
        source: 'stdlib',
      },
      async (a) => {
        const page = Number((a as { page?: number }).page)
        const fact =
          page === 1
            ? 'Fact: the fix goes on branch ana/retry-backoff.'
            : page === 3
              ? 'Fact: the ticket is PAY-7, reported by Bo.'
              : 'No facts on this page.'
        return { output: `${fact}\n${filler(page)}` }
      },
    )
    const bus = createEventBus()
    const runner = createRunner({
      sessions: s.sessions,
      tools: s.tools,
      model,
      queue: memoryQueue({ bus }),
      hooks: createHooks(),
      bus,
      toolListsFor: async () => ({ allow: ['**'], deny: [] }),
      maxSteps: 20,
      compactAt: 0,
    })
    const session = await s.sessions.create({
      employeeId: 'emp_test',
      title: 'Incident',
      toolset: ['notes.page', 'sessions.rewind'],
      entries: [{ kind: 'system', content: { text: 'You are a careful engineer. Use the tools you are given.' } }],
    })
    const ask = async (question: string) => {
      const run = await s.sessions.createRun({
        sessionId: session.id,
        cause: { type: 'manual' },
        input: [{ kind: 'user', content: { text: question } }],
      })
      const out = await runner.execute(run.id)
      const r = await s.sessions.requireRun(run.id)
      expect(out.status, r.data.pauseReason ?? r.data.result?.error ?? '').toBe('completed')
      return r.data.result?.output ?? ''
    }

    const first =
      'Read pages 1 to 4 of the incident notes, one call per page and one page per turn, in order. Then reply with one line: the branch name and the ticket id.'
    const answer = await ask(first)
    expect(answer).toContain('PAY-7')
    const before = await s.sessions.history(session.id)
    expect(before.filter((e) => e.kind === 'tool_result')).toHaveLength(4)

    const second =
      'Your context is getting heavy. Collapse the stretch where you read the notes pages with sessions.rewind, from your first notes.page call to your last, with a summary of what you learned. Then reply with one line: the branch name and the ticket id.'
    const again = await ask(second)
    const after = await s.sessions.history(session.id)
    const summary = after.find((e) => e.kind === 'summary')
    if (!summary || process.env.MP_LIVE_DEBUG)
      console.log(after.map((e) => `${e.kind}: ${JSON.stringify(e.content).slice(0, 300)}`).join('\n'))
    expect(summary, 'the model collapsed the reading with sessions.rewind').toBeDefined()
    expect(summary!.meta).toMatchObject({ op: 'rewind' })
    expect(Number(summary!.meta.collapsedEntries)).toBeGreaterThanOrEqual(8)
    // The reading is gone; the person's messages and the first answer survive.
    expect(after.filter((e) => e.kind === 'tool_result' && (e.content as any).name === 'notes.page')).toHaveLength(0)
    const texts = after.map(text)
    expect(texts).toContain(first)
    expect(texts).toContain(second)
    expect(texts).toContain(answer)
    expect(again).toContain('ana/retry-backoff')
    expect(again).toContain('PAY-7')
    expect(chars(after)).toBeLessThan(chars(before))
  })
})
