import type { Json } from '@mp/core'
import { callTools, reply } from '@mp/model'
import { currentRequester } from '@mp/sessions'
import { describe, expect, it } from 'vitest'
import { harness } from './harness.ts'

describe('requests and structured results', () => {
  it('records a later request delivered into a running run, and works for its requester from then on', async () => {
    const seen: (string | undefined)[] = []
    const h = harness([callTools([{ name: 'noop' }]), callTools([{ name: 'noop' }]), reply('done for Bo')])
    const s = await h.session(['noop'])
    const run = await h.sessions.createRun({
      sessionId: s.id,
      cause: { type: 'manual' },
      requesterId: 'con_ana',
      input: [{ kind: 'user', content: { text: 'change the footer' } as Json }],
    })
    let first = true
    h.tool({ name: 'noop' }, async (_a, ctx) => {
      seen.push(ctx.requesterId)
      if (first) {
        first = false
        // Bo asks for a follow-up in the same thread while the run works.
        await h.sessions.addToInbox({
          sessionId: s.id,
          eventId: 'evt_bo',
          expectedToAct: true,
          trusted: true,
          text: 'Bo: also make the header blue',
          source: 'chat',
          type: 'message.replied',
          requesterId: 'con_bo',
        })
        // An FYI that asks nothing doesn't change who the run works for.
        await h.sessions.addToInbox({
          sessionId: s.id,
          eventId: 'evt_fyi',
          expectedToAct: false,
          trusted: true,
          text: 'Cy: fyi, lunch is late',
          source: 'chat',
          type: 'message.replied',
          requesterId: 'con_cy',
        })
      }
      return { output: 'ok' }
    })
    await h.runner.execute(run.id)
    const done = await h.sessions.requireRun(run.id)
    expect(done.data.requesterId).toBe('con_ana')
    expect(done.data.requests).toEqual([{ eventId: 'evt_bo', requesterId: 'con_bo', at: expect.any(String) }])
    expect(currentRequester(done)).toBe('con_bo')
    expect(seen).toEqual(['con_ana', 'con_bo'])
  })

  it('a run picking up a late delivery is for whoever sent it', async () => {
    let s!: { id: string }
    let calls = 0
    const h = harness(async () => {
      calls++
      if (calls === 1)
        await h.sessions.addToInbox({
          sessionId: s.id,
          eventId: 'evt_late',
          expectedToAct: true,
          trusted: true,
          text: 'Bo: one more thing',
          source: 'chat',
          type: 'message.replied',
          requesterId: 'con_bo',
        })
      return reply('ok')
    })
    s = await h.session()
    const run = await h.sessions.createRun({ sessionId: s.id, cause: { type: 'manual' }, requesterId: 'con_ana' })
    await h.runner.execute(run.id)
    const next = (await h.sessions.runs({ sessionId: s.id })).find((r) => r.id !== run.id)!
    expect(next.data.requesterId).toBe('con_bo')
  })

  it('stores a structured result from the end signal and hands it to a waiting parent as is', async () => {
    const h = harness((req) => {
      const last = req.messages.at(-1)!
      const text = String(last.content ?? '')
      if (text.startsWith('child:')) return callTools([{ name: 'finish' }])
      if (text.startsWith('[wait finished]')) return reply(text.includes('"count": 3') ? 'parent got the result' : 'no result')
      if (last.role === 'tool') return reply('unexpected')
      return callTools([{ name: 'spawn' }])
    })
    const w = h.work()
    h.tool({ name: 'finish', effect: 'idempotent' }, async () => ({
      output: { finishing: 'completed' },
      control: [{ type: 'end', status: 'completed', output: 'three files', result: { count: 3, files: ['a', 'b', 'c'] } }],
    }))
    h.tool({ name: 'spawn', effect: 'idempotent' }, async (_a, ctx) => {
      const child = await h.sessions.fork(ctx.sessionId, { title: 'child' })
      const r = await h.sessions.createRun({
        sessionId: child.id,
        cause: { type: 'fork', parentRunId: ctx.runId },
        input: [{ kind: 'user', content: { text: 'child:count' } }],
      })
      await h.runner.enqueue(r.id)
      return { output: { started: r.id }, control: [{ type: 'suspend', wait: { type: 'runs', runIds: [r.id], mode: 'all' } }] }
    })
    const s = await h.session(['spawn', 'finish'])
    const run = await h.start(s.id, 'parent')
    await h.runner.enqueue(run.id)
    for (let i = 0; i < 100 && (await h.sessions.requireRun(run.id)).data.state !== 'completed'; i++)
      await new Promise((r) => setTimeout(r, 10))
    await w.close()
    expect((await h.sessions.requireRun(run.id)).data.result?.output).toBe('parent got the result')
    const child = (await h.sessions.runs({})).find((r) => r.data.cause.type === 'fork')!
    expect(child.data.result).toEqual({
      status: 'completed',
      output: 'three files',
      result: { count: 3, files: ['a', 'b', 'c'] },
    })
  })
})
