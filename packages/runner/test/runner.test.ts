import { UnavailableError, type Json } from '@mp/core'
import { callTools, reply } from '@mp/model'
import type { AssistantContent, ToolResultContent } from '@mp/sessions'
import { describe, expect, it } from 'vitest'
import { afterModelCall, beforeFinish, beforeModelCall, beforeToolCall, renderMessages } from '../src/index.ts'
import { harness } from './harness.ts'

const kinds = (entries: { kind: string }[]) => entries.map((e) => e.kind)

describe('runner', () => {
  it('runs a simple reply and commits a continuing run', async () => {
    const h = harness([reply('Done.')])
    const s = await h.session()
    const run = await h.start(s.id, 'say done')
    expect(await h.runner.execute(run.id)).toEqual({ status: 'completed', runId: run.id })
    const r = await h.sessions.requireRun(run.id)
    expect(r.data.state).toBe('completed')
    expect(r.data.result?.output).toBe('Done.')
    expect(kinds(await h.sessions.history(s.id))).toEqual(['system', 'user', 'assistant'])
    expect(h.model.calls[0]!.messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('calls tools, feeds results back, and records them in history', async () => {
    const h = harness([callTools([{ name: 'math__add', args: { a: 2, b: 3 } }]), reply('It is 5.')])
    h.tool(
      {
        name: 'math.add',
        parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      },
      async (args) => ({
        output: args.a + args.b,
      }),
    )
    const s = await h.session(['math.add'])
    const run = await h.start(s.id)
    await h.runner.execute(run.id)
    const hist = await h.sessions.history(s.id)
    expect(kinds(hist)).toEqual(['system', 'user', 'assistant', 'tool_result', 'assistant'])
    expect((hist[3]!.content as unknown as ToolResultContent).output).toBe(5)
    expect(h.model.calls[0]!.tools?.map((t) => t.function.name)).toEqual(['math__add'])
    // The result shows the model the id of its call: sessions.rewind, offload and restore name calls by it.
    const callId = h.model.calls[1]!.messages.at(-2)!.tool_calls![0]!.id
    expect(h.model.calls[1]!.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: callId, content: `[call ${callId}] 5` })
  })

  it('refuses tools outside the toolset or the allow list', async () => {
    const h = harness([callTools([{ name: 'secret__tool' }, { name: 'nope__tool' }]), reply('ok')], {
      toolListsFor: async () => ({ allow: ['**'], deny: ['secret.*'] }),
    })
    h.tool({ name: 'secret.tool' }, async () => ({ output: 'leak' }))
    const s = await h.session(['secret.tool'])
    const run = await h.start(s.id)
    await h.runner.execute(run.id)
    const results = (await h.sessions.history(s.id)).filter((e) => e.kind === 'tool_result').map((e) => e.content as any)
    expect(results.map((r) => r.isError)).toEqual([true, true])
    expect(JSON.stringify(results)).not.toContain('leak')
    expect(h.model.calls[0]!.tools).toBeUndefined()
  })

  it('ephemeral runs leave the session untouched unless they commit', async () => {
    const h = harness([reply('thrown away'), callTools([{ name: 'sessions__commit' }]), reply('kept')])
    h.tool({ name: 'sessions.commit', effect: 'idempotent' }, async () => ({
      output: 'will commit',
      control: [{ type: 'commit' }],
    }))
    const s = await h.session(['sessions.commit'])
    const r1 = await h.start(s.id, 'first', 'ephemeral')
    await h.runner.execute(r1.id)
    expect(kinds(await h.sessions.history(s.id))).toEqual(['system'])
    const r2 = await h.start(s.id, 'second', 'ephemeral')
    await h.runner.execute(r2.id)
    expect(kinds(await h.sessions.history(s.id))).toEqual(['system', 'user', 'assistant', 'tool_result', 'assistant'])
  })

  it('commits a summary when the head moved during the run', async () => {
    const h = harness([reply('parallel result')])
    const s = await h.session()
    const run = await h.start(s.id, 'a', 'ephemeral')
    await h.sessions.updateRun(run.id, { commit: true })
    // Another run commits first.
    const other = await h.start(s.id, 'b', 'ephemeral')
    await h.sessions.transition(other.id, 'queued', 'running')
    await h.sessions.append(other.id, { kind: 'assistant', content: { text: 'other' } as Json })
    await h.sessions.commit(other.id)
    await h.runner.execute(run.id)
    const hist = await h.sessions.history(s.id)
    expect(hist.at(-1)?.kind).toBe('summary')
    expect((hist.at(-1)!.content as any).text).toBe('parallel result')
  })

  it('suspends on a wait for children and resumes with their results', async () => {
    const h = harness((req) => {
      const last = req.messages.at(-1)!
      const text = String(last.content ?? '')
      if (text.startsWith('child:')) return reply(`child result for ${text.slice(6)}`)
      if (text.startsWith('[wait finished]')) return reply(`parent saw: ${text.includes('child result for x')}`)
      if (last.role === 'tool') return reply('unexpected')
      return callTools([{ name: 'work__spawn_and_wait' }])
    })
    const w = h.work()
    h.tool({ name: 'work.spawn_and_wait', effect: 'idempotent' }, async (_args, ctx) => {
      const child = await h.sessions.fork(ctx.sessionId, { title: 'child' })
      const run = await h.sessions.createRun({
        sessionId: child.id,
        cause: { type: 'fork', parentRunId: ctx.runId },
        input: [{ kind: 'user', content: { text: 'child:x' } }],
      })
      await h.runner.enqueue(run.id)
      return {
        output: { started: run.id },
        control: [{ type: 'suspend', wait: { type: 'runs', runIds: [run.id], mode: 'all' } }],
      }
    })
    const s = await h.session(['work.spawn_and_wait'])
    const run = await h.start(s.id, 'parent')
    await h.runner.enqueue(run.id)
    for (let i = 0; i < 100 && (await h.sessions.requireRun(run.id)).data.state !== 'completed'; i++)
      await new Promise((r) => setTimeout(r, 10))
    await w.close()
    const done = await h.sessions.requireRun(run.id)
    expect(done.data.state).toBe('completed')
    expect(done.data.result?.output).toBe('parent saw: true')
  })

  it('pauses when beforeModelCall says so (budgets)', async () => {
    const h = harness([reply('never')])
    h.hooks.on(beforeModelCall, () => ({ pause: 'over budget' }))
    const s = await h.session()
    const run = await h.start(s.id)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'paused', reason: 'over budget' })
    expect((await h.sessions.requireRun(run.id)).data.pauseReason).toBe('over budget')
    expect(h.model.calls).toHaveLength(0)
  })

  it('records usage through afterModelCall', async () => {
    const h = harness([reply('x', { promptTokens: 10, completionTokens: 2 })])
    const seen: number[] = []
    h.hooks.on(afterModelCall, (p) => void seen.push(p.response.usage.promptTokens))
    const s = await h.session()
    await h.runner.execute((await h.start(s.id)).id)
    expect(seen).toEqual([10])
  })

  it('denies tool calls through beforeToolCall and tells the model why', async () => {
    const h = harness([callTools([{ name: 'fs__delete' }]), reply('ok')])
    let called = false
    h.tool({ name: 'fs.delete', effect: 'non_idempotent' }, async () => {
      called = true
      return { output: 'deleted' }
    })
    h.hooks.on(beforeToolCall, (p) => (p.tool.name === 'fs.delete' ? { deny: 'not allowed for this requester' } : undefined))
    const s = await h.session(['fs.delete'])
    await h.runner.execute((await h.start(s.id)).id)
    expect(called).toBe(false)
    expect(h.model.calls[1]!.messages.at(-1)?.content).toContain('not allowed for this requester')
  })

  it('blocks finishing until a policy is satisfied, then pauses after too many blocks', async () => {
    const h = harness([reply('done v1'), reply('done v2'), reply('a'), reply('b'), reply('c'), reply('d')], {
      maxFinishBlocks: 2,
    })
    let docsUpdated = false
    h.hooks.on(beforeFinish, () => (docsUpdated ? undefined : { block: 'update the project docs first' }))
    const s = await h.session()
    const run = await h.start(s.id)
    setTimeout(() => void 0)
    // First attempt: blocked once, then allowed after docs are "updated".
    h.hooks.on(beforeModelCall, (p) => {
      if (p.step === 1) docsUpdated = true
      return undefined
    })
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'completed' })
    expect(h.model.calls[1]!.messages.at(-1)?.content).toContain('update the project docs first')

    docsUpdated = false
    const h2 = harness([reply('a'), reply('b'), reply('c'), reply('d')], { maxFinishBlocks: 2 })
    h2.hooks.on(beforeFinish, () => ({ block: 'never satisfied' }))
    const s2 = await h2.session()
    const run2 = await h2.start(s2.id)
    expect(await h2.runner.execute(run2.id)).toMatchObject({ status: 'paused' })
  })

  it('injects secrets into tools and redacts them from results', async () => {
    const h = harness([callTools([{ name: 'api__call' }]), reply('ok')])
    await h.secrets.set('API_TOKEN', 'tok-very-secret-123', { type: 'global' })
    let seen = ''
    h.tool({ name: 'api.call', secrets: ['API_TOKEN'] }, async (_a, ctx) => {
      seen = ctx.secrets.API_TOKEN ?? ''
      return { output: { echoed: `token was ${ctx.secrets.API_TOKEN}` } }
    })
    const s = await h.session(['api.call'])
    await h.runner.execute((await h.start(s.id)).id)
    expect(seen).toBe('tok-very-secret-123')
    const all = JSON.stringify(await h.sessions.history(s.id))
    expect(all).not.toContain('tok-very-secret-123')
    expect(all).toContain('[secret]')
    expect(JSON.stringify(h.model.calls)).not.toContain('tok-very-secret-123')
  })

  it('recovers from a crash: re-runs idempotent calls, never blindly retries non-idempotent ones', async () => {
    const h = harness([reply('after recovery')])
    const calls: string[] = []
    h.tool({ name: 'db.read', effect: 'read' }, async () => {
      calls.push('read')
      return { output: 'data' }
    })
    h.tool({ name: 'slack.post', effect: 'non_idempotent' }, async () => {
      calls.push('post')
      return { output: 'posted' }
    })
    const s = await h.session(['db.read', 'slack.post'])
    const run = await h.start(s.id)
    // Simulate a worker that died after the model asked for two tools.
    await h.sessions.transition(run.id, 'queued', 'running')
    await h.sessions.append(run.id, {
      kind: 'assistant',
      content: {
        text: null,
        toolCalls: [
          { id: 'c1', name: 'db__read', arguments: '{}' },
          { id: 'c2', name: 'slack__post', arguments: '{}' },
        ],
      } satisfies AssistantContent as unknown as Json,
    })
    await h.sessions.updateRun(run.id, { steps: 1 })
    await h.runner.execute(run.id)
    expect(calls).toEqual(['read'])
    const results = (await h.sessions.history(s.id)).filter((e) => e.kind === 'tool_result').map((e) => e.content as any)
    expect(results[0].output).toBe('data')
    expect(results[1].output.uncertain).toBe(true)
  })

  it('rethrows unavailable model errors so the job retries, then resumes', async () => {
    const h = harness([new UnavailableError('provider down'), reply('back')])
    const s = await h.session()
    const run = await h.start(s.id)
    await expect(h.runner.execute(run.id)).rejects.toThrow('provider down')
    expect((await h.sessions.requireRun(run.id)).data.state).toBe('running')
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'completed' })
  })

  it('fails the run on other errors and records the error', async () => {
    const h = harness([new Error('model broke')])
    const s = await h.session()
    const run = await h.start(s.id)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'failed' })
    expect((await h.sessions.requireRun(run.id)).data.result?.error).toContain('model broke')
  })

  it('takes inbox items into a continuing run at the next step', async () => {
    const h = harness([callTools([{ name: 'noop' }]), reply('saw the reply')])
    const s = await h.session(['noop'])
    const run = await h.start(s.id)
    h.tool({ name: 'noop' }, async () => {
      await h.sessions.addToInbox({
        sessionId: s.id,
        eventId: 'evt_1',
        expectedToAct: true,
        trusted: true,
        text: 'Ana replied: ship it',
        source: 'chat',
        type: 'message.replied',
      })
      return { output: 'ok' }
    })
    await h.runner.execute(run.id)
    const second = h.model.calls[1]!.messages
    expect(second.at(-1)?.content).toContain('Ana replied: ship it')
    expect(await h.sessions.inbox(s.id)).toEqual([])
  })

  it('starts a new run for a delivery that arrived during the last model call', async () => {
    let s!: { id: string }
    let calls = 0
    const h = harness(async () => {
      calls++
      if (calls === 1) {
        // The reply is being written when a new message lands in the inbox.
        await h.sessions.addToInbox({
          sessionId: s.id,
          eventId: 'evt_late',
          expectedToAct: true,
          trusted: true,
          text: 'Ana: did you get this?',
          source: 'chat',
          type: 'message.replied',
        })
        return reply('first answer')
      }
      return reply('yes, got it')
    })
    s = await h.session()
    const run = await h.start(s.id)
    await h.runner.execute(run.id)
    const runs = await h.sessions.runs({ sessionId: s.id })
    expect(runs).toHaveLength(2)
    const next = runs.find((r) => r.id !== run.id)!
    expect(next.data.cause).toMatchObject({ type: 'event', eventId: 'evt_late', note: 'inbox' })
    await h.runner.execute(next.id)
    expect(h.model.calls[1]!.messages.at(-1)?.content).toContain('Ana: did you get this?')
    expect(await h.sessions.inbox(s.id)).toEqual([])
  })

  it('leaves information-only inbox items for next time', async () => {
    let s!: { id: string }
    const h = harness(async () => {
      await h.sessions.addToInbox({
        sessionId: s.id,
        eventId: 'evt_fyi',
        expectedToAct: false,
        trusted: true,
        text: 'fyi',
        source: 'chat',
        type: 'message.replied',
      })
      return reply('done')
    })
    s = await h.session()
    const run = await h.start(s.id)
    await h.runner.execute(run.id)
    expect(await h.sessions.runs({ sessionId: s.id })).toHaveLength(1)
  })

  it('pauses after too many steps', async () => {
    const h = harness(() => callTools([{ name: 'noop' }]), { maxSteps: 3 })
    h.tool({ name: 'noop' }, async () => ({ output: 'ok' }))
    const s = await h.session(['noop'])
    const run = await h.start(s.id)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'paused', reason: 'max steps' })
  })

  it('skips runs that are already finished or claimed', async () => {
    const h = harness([reply('x')])
    const s = await h.session()
    const run = await h.start(s.id)
    await h.runner.execute(run.id)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'skipped' })
    expect(await h.runner.execute('run_missing')).toMatchObject({ status: 'skipped' })
  })

  it('streams deltas and tool activity on the bus', async () => {
    const h = harness([callTools([{ name: 'noop' }]), reply('streamed answer')])
    h.tool({ name: 'noop' }, async () => ({ output: 'ok' }))
    const topics: string[] = []
    h.bus.subscribe('**', (m) => void topics.push(m.topic))
    const s = await h.session(['noop'])
    await h.runner.execute((await h.start(s.id)).id)
    await h.bus.idle()
    expect(topics).toContain('model.delta')
    expect(topics).toContain('tool.called')
    expect(topics).toContain('tool.result')
    expect(topics).toContain('run.state')
  })
})

describe('renderMessages', () => {
  const e = (kind: string, content: unknown) => ({
    id: `ent_${Math.random()}`,
    parent: null,
    kind,
    content: content as Json,
    hash: '',
    meta: {},
    createdAt: '',
  })

  it('renders every entry kind and marks untrusted events', () => {
    const msgs = renderMessages([
      e('system', { text: 'sys' }),
      e('event', {
        eventId: 'e',
        source: 'mcp:linear',
        type: 'task.created',
        text: 'New task',
        trusted: false,
        expectedToAct: true,
      }),
      e('assistant', { text: null, toolCalls: [{ id: 't1', name: 'x', arguments: '{}' }] }),
      e('summary', { text: 'did things', rewoundTo: 'a', replacesTip: 'b' }),
      e('pointer', { text: 'long doc', original: 'o', doc: { id: 'doc_1', chapter: 'Retry' } }),
    ] as any)
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user', 'user'])
    expect(msgs[1]!.content).toContain('not expected')
    expect(msgs[3]!.content).toContain('no result recorded')
    expect(msgs[5]!.content).toContain('doc_1')
  })

  it('is deterministic', () => {
    const entries = [e('system', { text: 'a' }), e('user', { text: 'b' })] as any
    expect(JSON.stringify(renderMessages(entries))).toBe(JSON.stringify(renderMessages(entries)))
  })
})

describe('wake race', () => {
  it('a run woken while its own job is still active is picked up again', async () => {
    const h = harness((req) => {
      const last = String(req.messages.at(-1)?.content ?? '')
      if (last.startsWith('fast child')) return reply('child done')
      if (last.startsWith('[wait finished]')) return reply('parent resumed')
      return callTools([{ name: 'spawn' }])
    })
    h.tool({ name: 'spawn', effect: 'idempotent' }, async (_a, ctx) => {
      const child = await h.sessions.fork(ctx.sessionId, { title: 'fast' })
      const run = await h.sessions.createRun({
        sessionId: child.id,
        cause: { type: 'fork', parentRunId: ctx.runId },
        input: [{ kind: 'user', content: { text: 'fast child' } }],
      })
      // The child finishes before the parent suspends.
      await h.runner.execute(run.id)
      return { output: 'spawned', control: [{ type: 'suspend', wait: { type: 'runs', runIds: [run.id], mode: 'all' } }] }
    })
    const w = h.work()
    const s = await h.session(['spawn'])
    const run = await h.start(s.id)
    await h.runner.enqueue(run.id)
    for (let i = 0; i < 200 && (await h.sessions.requireRun(run.id)).data.state !== 'completed'; i++)
      await new Promise((r) => setTimeout(r, 5))
    await w.close()
    expect((await h.sessions.requireRun(run.id)).data.result?.output).toBe('parent resumed')
  })
})

describe('sessions started before their tools and prompt changed', () => {
  it('get the tools added since, with a note that earlier claims of a missing tool are out of date', async () => {
    const h = harness([reply('first'), reply('second')], {
      currentToolset: async (s) => (s.data.meta?.toolsetFixed ? undefined : ['math.add', 'slack.get_file']),
    })
    h.tool({ name: 'math.add' }, async () => ({ output: 1 }))
    h.tool({ name: 'slack.get_file' }, async () => ({ output: 'bytes' }))
    h.tool({ name: 'old.tool' }, async () => ({ output: 'gone' }))
    const s = await h.session(['math.add', 'old.tool'])
    await h.runner.execute((await h.start(s.id)).id)
    expect((await h.sessions.require(s.id)).data.toolset).toEqual(['math.add', 'slack.get_file'])
    expect(h.model.calls[0]!.tools?.map((t) => t.function.name)).toEqual(['math__add', 'slack__get_file'])
    const note = h.model.calls[0]!.messages.find((m) => m.role === 'system' && String(m.content).includes('tools changed'))
    expect(String(note?.content)).toContain('in addition to the tools you already had: slack.get_file')
    expect(String(note?.content)).toContain('No longer available: old.tool')

    // Up to date: no second note.
    await h.runner.execute((await h.start(s.id)).id)
    const notes = (await h.sessions.history(s.id)).filter((e) => e.meta?.toolsetChanged)
    expect(notes).toHaveLength(1)
  })

  it('keep a toolset the host says is fixed', async () => {
    const h = harness([reply('ok')], { currentToolset: async () => undefined })
    h.tool({ name: 'math.add' }, async () => ({ output: 1 }))
    const s = await h.session(['math.add'])
    await h.runner.execute((await h.start(s.id)).id)
    expect((await h.sessions.require(s.id)).data.toolset).toEqual(['math.add'])
    expect(kinds(await h.sessions.history(s.id))).toEqual(['system', 'user', 'assistant'])
  })

  it('see the current prompt in place of the one stored, without rewriting history', async () => {
    const h = harness([reply('ok')], {
      currentPrompt: async (_s, stored) => (stored === 'You are a test employee.' ? 'You are a test employee, v2.' : undefined),
    })
    const s = await h.session()
    await h.runner.execute((await h.start(s.id)).id)
    expect(h.model.calls[0]!.messages[0]).toMatchObject({ role: 'system', content: 'You are a test employee, v2.' })
    expect((await h.sessions.history(s.id))[0]!.content).toEqual({ text: 'You are a test employee.' })
  })

  it('run anyway when bringing the session up to date fails', async () => {
    const h = harness([reply('ok')], {
      currentToolset: async () => {
        throw new Error('directory down')
      },
    })
    const s = await h.session()
    expect((await h.runner.execute((await h.start(s.id)).id)).status).toBe('completed')
  })
})
