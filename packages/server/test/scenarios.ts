/**
 * End-to-end scenarios through the composition root with a scripted model.
 * `scenarioSuite` runs them against one backend (memory, or Postgres + BullMQ).
 */
import { randomBytes } from 'node:crypto'
import { UnavailableError, isMpError, type Json } from '@mp/core'
import { fakeMcpHub } from '@mp/mcp'
import { callTools, reply, type ModelRequest, type ScriptResult } from '@mp/model'
import type { Run, RunState } from '@mp/sessions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestAppOptions } from './helpers.ts'
import { testApp, until, type TestApp } from './helpers.ts'

export interface Backend {
  name: string
  /** Environment for one app, and a cleanup for what it created. */
  make(): Promise<{ env: Record<string, string>; cleanup(): Promise<void> }>
}

export const memoryBackend: Backend = { name: 'memory', make: async () => ({ env: {}, cleanup: async () => {} }) }

/** Postgres + BullMQ, each app in its own schema and Redis prefix. */
export function realBackend(databaseUrl: string, redisUrl: string): Backend {
  return {
    name: 'postgres+bullmq',
    async make() {
      const id = randomBytes(5).toString('hex')
      const schema = `mp_srv_${id}`
      const prefix = `mp-srv-${id}`
      return {
        env: {
          DATABASE_URL: databaseUrl,
          DATABASE_SCHEMA: schema,
          REDIS_URL: redisUrl,
          REDIS_PREFIX: prefix,
          SECRETS_KEY: 'test-secrets-key-not-a-real-one',
        },
        async cleanup() {
          const pg = (await import('pg')).default
          const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
          await pool.query(`drop schema if exists "${schema}" cascade`).finally(() => pool.end())
          const { Redis } = await import('ioredis')
          const redis = new Redis(redisUrl, { maxRetriesPerRequest: null })
          try {
            let cursor = '0'
            do {
              const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500)
              cursor = next
              if (keys.length) await redis.del(...keys)
            } while (cursor !== '0')
          } finally {
            redis.disconnect()
          }
        },
      }
    },
  }
}

const LIVE: RunState[] = ['queued', 'running']

/** Waits until no run is queued or running and the queues are idle. */
export async function quiet(t: TestApp, timeoutMs = 15_000) {
  await until(
    async () => {
      await t.a.services.queue.idle()
      await t.a.services.bus.idle()
      return (await t.a.services.sessions.runs({ state: LIVE })).length === 0
    },
    'runs to settle',
    timeoutMs,
  )
  await t.settle()
}

type Msg = ModelRequest['messages'][number]
const lastMsg = (req: ModelRequest): Msg => req.messages.at(-1)!
const has = (req: ModelRequest, marker: string) => req.messages.some((m) => (m.content ?? '').includes(marker))
/** The tool name of the call answered by the last tool message. */
const lastToolName = (req: ModelRequest): string | undefined => {
  const last = lastMsg(req)
  if (last.role !== 'tool') return undefined
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const call = req.messages[i]!.tool_calls?.find((c) => c.id === last.tool_call_id)
    if (call) return call.function.name.replace(/__/g, '.')
  }
  return undefined
}
const lastToolOutput = (req: ModelRequest): any => {
  const c = lastMsg(req).content ?? ''
  try {
    return JSON.parse(c)
  } catch {
    return c
  }
}

/**
 * Each request in #requests runs in its own fork of the router context. The
 * newest such fork, i.e. the session handling the latest request.
 */
async function requestSessionId(t: TestApp): Promise<string> {
  const s = t.a.services
  const kids = await s.sessions.children((await s.routerSessionFor())!)
  const id = kids.at(-1)?.id
  if (!id) throw new Error('no request session yet')
  return id
}

/** Every run started by a request in #requests (one per request fork), oldest first. */
async function requestRuns(t: TestApp): Promise<Run[]> {
  const s = t.a.services
  const kids = await s.sessions.children((await s.routerSessionFor())!)
  const all = (await Promise.all(kids.map((k) => s.sessions.runs({ sessionId: k.id })))).flat()
  return all.filter((r) => r.data.cause.type === 'event').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

async function requestsChannel(t: TestApp): Promise<string> {
  const ch = await t.a.services.chat.channelByName('requests')
  return ch!.id
}

async function post(t: TestApp, channelId: string, text: string, threadId?: string) {
  const r = await t.req('POST', `/api/chat/channels/${channelId}/messages`, { text, ...(threadId ? { threadId } : {}) })
  expect(r.status).toBe(201)
  return r.body
}

async function rootByText(t: TestApp, text: string): Promise<string> {
  const found = await t.a.services.chat.search(text)
  const m = found.find((x) => !x.data.threadId)
  if (!m) throw new Error(`no message ${text}`)
  return m.id
}

export function scenarioSuite(backend: Backend) {
  const apps: { t: TestApp; cleanup(): Promise<void> }[] = []
  const make = async (opts: TestAppOptions = {}) => {
    const b = await backend.make()
    const t = await testApp({ ...opts, env: { ...b.env, ...opts.env } })
    apps.push({ t, cleanup: b.cleanup })
    return t
  }
  afterAll(async () => {
    for (const x of apps) {
      await x.t.close().catch(() => {})
      await x.cleanup().catch(() => {})
    }
  })

  it('1b. a request answered directly in its fork: the follow-up in the thread comes back to the same session', async () => {
    let t!: TestApp
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      const rootId = await rootByText(t, 'What is 17 * 23')
      if (lastMsg(req).role === 'tool') return reply('Replied in the thread.')
      if ((lastMsg(req).content ?? '').includes('and times 2'))
        return callTools([{ name: 'chat.reply', args: { threadId: `mp:${rootId}`, text: '782.' } }])
      return callTools([{ name: 'chat.reply', args: { threadId: rootId, text: '391.' } }])
    }
    t = await make({ script })
    const s = t.a.services
    const requests = await requestsChannel(t)
    const root = await post(t, requests, 'What is 17 * 23?')
    await quiet(t)
    const reqId = await requestSessionId(t)
    expect((await s.sessions.require(reqId)).data.title).toBe('#requests: What is 17 * 23?')

    await post(t, requests, 'and times 2?', root.id)
    await quiet(t)
    // Only one request session: the follow-up did not become a new request.
    expect(await s.sessions.children((await s.routerSessionFor())!)).toHaveLength(1)
    const runs = await s.sessions.runs({ sessionId: reqId })
    expect(runs.map((r) => [r.data.state, r.data.mode])).toEqual([
      ['completed', 'continuing'],
      ['completed', 'continuing'],
    ])
    const followUp = await s.rawEvents.require(runs[1]!.data.cause.eventId!)
    expect((followUp.data as any).routing.deliveries.map((d: any) => d.reason)).toEqual(['subscription'])
    // The second run saw the first exchange: the conversation was committed to the session.
    const history = await s.sessions.history(reqId)
    expect(history.filter((e) => e.kind === 'event')).toHaveLength(2)
    const thread = await t.req('GET', `/api/chat/threads/${root.id}`)
    expect(thread.body.replies.map((m: any) => m.data.text)).toEqual(['391.', 'and times 2?', '782.'])
  })

  it('1c. a run that answers with plain text (no chat tool) gets its answer posted in the thread', async () => {
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      if ((lastMsg(req).content ?? '').includes('and in French')) return reply('Je suis Meatless.')
      return reply("I'm Meatless, an AI employee.")
    }
    const t = await make({ script })
    const s = t.a.services
    const requests = await requestsChannel(t)
    const root = await post(t, requests, 'In one sentence: what are you?')
    await quiet(t)
    const thread = await t.req('GET', `/api/chat/threads/${root.id}`)
    expect(thread.body.replies.map((m: any) => [m.data.author.type, m.data.text])).toEqual([
      ['session', "I'm Meatless, an AI employee."],
    ])
    // The answering session is subscribed, so a follow-up comes back to it and is answered in the thread too.
    await post(t, requests, 'and in French?', root.id)
    await quiet(t)
    const after = await t.req('GET', `/api/chat/threads/${root.id}`)
    expect(after.body.replies.map((m: any) => m.data.text)).toEqual([
      "I'm Meatless, an AI employee.",
      'and in French?',
      'Je suis Meatless.',
    ])
    expect(await s.sessions.children((await s.routerSessionFor())!)).toHaveLength(1)
  })

  it('1. a request in #requests is routed to the router, which forks a worker; the reply comes back to the worker', async () => {
    let t!: TestApp
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      const rootId = await rootByText(t, 'summary of the planning notes')
      if (has(req, 'WORKER:')) {
        if (lastMsg(req).role === 'tool')
          return reply(lastToolName(req) === 'chat.reply' && has(req, 'Q3 2026') ? 'Answered.' : 'Asked which quarter.')
        if ((lastMsg(req).content ?? '').includes('Q3 2026'))
          return callTools([{ name: 'chat.reply', args: { threadId: rootId, text: 'Here is the Q3 2026 summary: all good.' } }])
        return callTools([
          { name: 'subscriptions.subscribe', args: { subject: { system: 'mp', id: rootId }, primary: true } },
          { name: 'chat.reply', args: { threadId: rootId, text: 'On it. Which quarter do you mean?' } },
        ])
      }
      if (lastMsg(req).role === 'tool') return reply('Handed to a worker.')
      return callTools([
        {
          name: 'sessions.fork',
          args: { instruction: `WORKER: answer the request in thread ${rootId}`, title: 'Planning summary' },
        },
      ])
    }
    t = await make({ script })
    const requests = await requestsChannel(t)
    const root = await post(t, requests, 'Can I get a summary of the planning notes?')
    await quiet(t)

    const s = t.a.services
    const routerId = await requestSessionId(t)
    expect((await s.sessions.require(routerId)).data.parent?.sessionId).toBe(await s.routerSessionFor())
    const routerRuns = await s.sessions.runs({ sessionId: routerId })
    expect(routerRuns).toHaveLength(1)
    expect(routerRuns[0]!.data.state).toBe('completed')
    expect(routerRuns[0]!.data.result?.output).toBe('Handed to a worker.')
    const event = await s.rawEvents.require(routerRuns[0]!.data.cause.eventId!)
    expect((event.data as any).routing.deliveries[0].reason).toBe('trigger')

    const forks = await s.sessions.children(routerId)
    expect(forks).toHaveLength(1)
    const worker = forks[0]!
    let workerRuns = await s.sessions.runs({ sessionId: worker.id })
    expect(workerRuns.map((r) => r.data.state)).toEqual(['completed'])
    expect(workerRuns[0]!.data.cause).toMatchObject({ type: 'fork', parentRunId: routerRuns[0]!.id })

    // The person answers in the thread: the subscription delivers it straight to the worker.
    await post(t, requests, 'Q3 2026, please', root.id)
    await quiet(t)
    workerRuns = await s.sessions.runs({ sessionId: worker.id })
    expect(workerRuns.map((r) => r.data.state)).toEqual(['completed', 'completed'])
    expect(workerRuns[1]!.data.mode).toBe('continuing')
    const replyEvent = await s.rawEvents.require(workerRuns[1]!.data.cause.eventId!)
    expect(replyEvent.data.type).toBe('message.replied')
    expect((replyEvent.data as any).routing.deliveries.map((d: any) => d.reason)).toEqual(['subscription'])
    expect(await s.sessions.runs({ sessionId: routerId })).toHaveLength(1)

    const thread = await t.req('GET', `/api/chat/threads/${root.id}`)
    expect(thread.body.replies.map((m: any) => m.data.text)).toEqual([
      'On it. Which quarter do you mean?',
      'Q3 2026, please',
      'Here is the Q3 2026 summary: all good.',
    ])
    expect(thread.body.replies[0].data.author.type).toBe('session')
    expect(thread.body.sessions.map((x: any) => x.id)).toEqual([worker.id])

    // Lineage: the reply event led through the subscription to the worker's run.
    const lin = await t.req('GET', `/api/lineage/${replyEvent.id}`)
    expect(lin.status).toBe(200)
    expect(lin.body.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: replyEvent.id, type: 'matched' })]))
    expect(lin.body.nodes.map((n: any) => n.type)).toEqual(expect.arrayContaining(['event', 'subscription', 'run', 'session']))
    // And the worker's first run leads back to the #requests event and its trigger.
    const up = await t.req('GET', `/api/lineage/${workerRuns[0]!.id}`)
    expect(up.body.nodes.map((n: any) => n.type)).toEqual(expect.arrayContaining(['event', 'trigger', 'run', 'session']))
    expect(up.body.edges).toEqual(expect.arrayContaining([{ from: routerRuns[0]!.id, to: worker.id, type: 'forked' }]))
  })

  it('2. an MCP notification becomes an event, and a trigger forks the procedure context for it', async () => {
    const hub = fakeMcpHub({
      servers: {
        linear: {
          tools: [
            {
              name: 'get_issue',
              description: 'Get an issue',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            },
          ],
          call: (_tool, args) => ({ id: args.id, title: 'Refunds fail for EUR', state: 'Todo' }),
        },
      },
    })
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      if (!has(req, 'PROCEDURE: task intake')) return reply('not for me')
      const last = lastMsg(req)
      if (last.role === 'tool') {
        if (lastToolName(req) === 'mcp.linear.get_issue')
          return callTools([
            { name: 'subscriptions.subscribe', args: { subject: { system: 'linear', id: 'PAY-123' }, primary: true } },
          ])
        return reply('Took PAY-123.')
      }
      if ((last.content ?? '').includes('comment on PAY-123')) return reply('Noted the comment.')
      return callTools([{ name: 'mcp.linear.get_issue', args: { id: 'PAY-123' } }])
    }
    const t = await make({
      script,
      overrides: { mcpHub: hub },
      env: {
        MCP_SERVERS: JSON.stringify([
          {
            name: 'linear',
            transport: 'http',
            url: 'http://linear.invalid/mcp',
            effect: 'read',
            events: [
              {
                method: 'notifications/linear/issue',
                type: 'task.assigned',
                subjectFrom: 'issue.identifier',
                subjectSystem: 'linear',
                idFrom: 'eventId',
                textFrom: 'issue.title',
              },
              {
                method: 'notifications/linear/comment',
                type: 'comment.created',
                subjectFrom: 'issue',
                subjectSystem: 'linear',
                idFrom: 'eventId',
                textFrom: 'text',
              },
            ],
          },
        ]),
      },
    })
    const s = t.a.services
    expect(s.mcpTools).toEqual(['mcp.linear.get_issue'])
    const employee = (await s.directory.employees.byHandle('meatless'))!
    const toolset = s.tools.allowed(await s.toolListsFor(employee.id)).map((x) => x.name)
    const context = await s.sessions.create({
      employeeId: employee.id,
      title: 'Task intake',
      toolset,
      entries: [{ kind: 'system', content: { text: 'PROCEDURE: task intake. Take new Linear tasks in.' } }],
    })
    const procedure = await s.directory.procedures.create({
      name: 'Task intake',
      applies: 'New Linear tasks',
      contextSessionId: context.id,
    })
    const trigger = await s.events.triggers.create({
      name: 'Linear: assigned tasks',
      employeeId: employee.id,
      match: { source: 'mcp:linear', type: 'task.assigned' },
      target: { type: 'procedure', procedureId: procedure.id },
    })

    const params = { eventId: 'lin-1', issue: { identifier: 'PAY-123', title: 'Refunds fail for EUR' } }
    hub.notify('linear', 'notifications/linear/issue', params)
    hub.notify('linear', 'notifications/linear/issue', params) // delivered twice, stored once
    await until(async () => (await s.rawEvents.query({ source: 'mcp:linear' })).length === 1, 'the event')
    await quiet(t)

    const events = await s.rawEvents.query({ source: 'mcp:linear' })
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.data).toMatchObject({
      type: 'task.assigned',
      subject: { system: 'linear', id: 'PAY-123' },
      text: 'Refunds fail for EUR',
      routed: true,
    })
    expect(e.key).toBe('mcp:linear:notifications/linear/issue:lin-1')

    const forks = await s.sessions.children(context.id)
    expect(forks).toHaveLength(1)
    const runs = await s.sessions.runs({ sessionId: forks[0]!.id })
    expect(runs.map((r) => [r.data.state, r.data.mode, r.data.result?.output])).toEqual([
      ['completed', 'ephemeral', 'Took PAY-123.'],
    ])
    expect(hub.calls).toEqual([{ server: 'linear', tool: 'get_issue', args: { id: 'PAY-123' } }])
    expect((await s.sessions.require(context.id)).data.head).toBe(context.data.head)
    expect((await s.sessions.runs({ sessionId: context.id })).length).toBe(0)

    const triggers = await t.req('GET', '/api/triggers')
    const stats = triggers.body.find((x: any) => x.trigger.id === trigger.id)
    expect(stats).toMatchObject({
      fires: 1,
      context: { id: context.id },
      trigger: { data: { source: 'mcp:linear', type: 'task.assigned', fork: true } },
    })
    expect(stats.recentEvents.map((x: any) => x.id)).toEqual([e.id])

    const detail = await t.req('GET', `/api/events/${e.id}`)
    expect(detail.body.deliveries[0].data).toMatchObject({ rule: 'trigger', triggerId: trigger.id, sessionId: forks[0]!.id })
    expect(detail.body.event.data).toMatchObject({ subject: { system: 'linear', ref: 'PAY-123' }, matched: ['trigger'] })
    const lin = await t.req('GET', `/api/lineage/${e.id}`)
    expect(lin.body.edges).toEqual(
      expect.arrayContaining([
        { from: e.id, to: trigger.id, type: 'matched' },
        { from: context.id, to: forks[0]!.id, type: 'forked' },
      ]),
    )

    // A comment on the ticket goes straight to the fork that subscribed to it.
    hub.notify('linear', 'notifications/linear/comment', { eventId: 'lin-2', issue: 'PAY-123', text: 'A comment on PAY-123' })
    await until(async () => (await s.rawEvents.query({ source: 'mcp:linear' })).length === 2, 'the comment event')
    await quiet(t)
    const after = await s.sessions.runs({ sessionId: forks[0]!.id })
    expect(after.map((r) => [r.data.state, r.data.cause.note])).toEqual([
      ['completed', 'trigger'],
      ['completed', 'subscription'],
    ])
    expect(after[1]!.data.result?.output).toBe('Noted the comment.')
    expect(await s.sessions.children(context.id)).toHaveLength(1)
  })

  it('3. a loop fans out, waits for every child and resumes with their results', async () => {
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      if (has(req, 'CHILD:')) {
        const item = /Your item \(\d+ of 3\):\n(\w+)/.exec(req.messages.map((m) => m.content ?? '').join('\n'))?.[1]
        return reply(`done: ${item}`)
      }
      const last = lastMsg(req)
      if (last.role === 'tool' && lastToolName(req) === 'sessions.loop') {
        return callTools([{ name: 'sessions.wait', args: { runIds: lastToolOutput(req).runIds, mode: 'all' } }])
      }
      if (last.role === 'user' && (last.content ?? '').startsWith('[wait finished]')) return reply('All three children are done.')
      return callTools([
        { name: 'sessions.loop', args: { items: ['alpha', 'beta', 'gamma'], instruction: 'CHILD: say your item back' } },
      ])
    }
    const t = await make({ script })
    await post(t, await requestsChannel(t), 'LOOP over the three items')
    await quiet(t)
    const s = t.a.services
    const routerId = await requestSessionId(t)
    const [parentRun] = await s.sessions.runs({ sessionId: routerId })
    expect(parentRun!.data.state).toBe('completed')
    expect(parentRun!.data.result?.output).toBe('All three children are done.')
    const children = await s.sessions.children(routerId)
    expect(children).toHaveLength(3)
    expect(children.map((c) => (c.data.meta?.loop as any)?.index).sort()).toEqual([0, 1, 2])
    for (const c of children) {
      const rs = await s.sessions.runs({ sessionId: c.id })
      expect(rs.map((r) => r.data.state)).toEqual(['completed'])
    }
    const history = await s.sessions.runHistory(parentRun!.id)
    const wake = history.find((e) => e.kind === 'user' && (e.content as any).text.startsWith('[wait finished]'))
    expect((wake!.content as any).text).toContain('done: alpha')
    expect((wake!.content as any).text).toContain('done: gamma')

    const tree = await t.req('GET', `/api/sessions/${routerId}/tree`)
    // The tree starts at the router context; the request's fork holds the loop.
    expect(tree.body.children.map((c: any) => c.origin)).toEqual(['fork'])
    const loop = tree.body.children[0].children
    expect(loop.map((c: any) => c.origin)).toEqual(['loop', 'loop', 'loop'])
    expect(loop[0].loop).toMatchObject({ of: 3 })
  })

  it('4. the checklist gate keeps a run going until required items are checked with evidence', async () => {
    let addCall = ''
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      const last = lastMsg(req)
      if (last.role === 'tool' && lastToolName(req) === 'checklist.add_item') {
        addCall = last.tool_call_id!
        return reply('Done, I think.')
      }
      if (last.role === 'user' && (last.content ?? '').startsWith('[harness] Not finished yet'))
        return callTools([{ name: 'checklist.check', args: { itemId: 'i1', evidence: [addCall] } }])
      if (last.role === 'tool' && lastToolName(req) === 'checklist.check') return reply('Now it is really done.')
      return callTools([{ name: 'checklist.add_item', args: { text: 'Confirm the request was understood', required: true } }])
    }
    const t = await make({ script })
    await post(t, await requestsChannel(t), 'Please do the checklist thing')
    await quiet(t)
    const s = t.a.services
    const [run] = await s.sessions.runs({ sessionId: await requestSessionId(t) })
    expect(run!.data.state).toBe('completed')
    expect(run!.data.result?.output).toBe('Now it is really done.')
    const history = await s.sessions.runHistory(run!.id)
    expect(history.some((e) => e.kind === 'user' && (e.content as any).text.includes('Not finished yet'))).toBe(true)
    const status = await s.checklists.status(run!.data.sessionId)
    expect(status.complete).toBe(true)
    const detail = await t.req('GET', `/api/sessions/${run!.data.sessionId}`)
    expect(detail.body.checklist.data.items[0]).toMatchObject({ id: 'i1', checked: true, required: true })
  })

  it('5. crash recovery: an unavailable provider and a crashed tool call resume from the journal', async () => {
    const calls = { flaky: 0, send: 0 }
    const script = async (req: ModelRequest, i: number): Promise<ScriptResult> => {
      const last = lastMsg(req)
      const text = last.content ?? ''
      if (text.includes('PROVIDER') && i === 0) return new UnavailableError('provider is down')
      if (text.includes('PROVIDER')) return reply('Recovered after the outage.')
      if (text.includes('FLAKY')) return callTools([{ name: 'test.flaky', args: {} }])
      if (text.includes('SEND')) return callTools([{ name: 'test.send', args: {} }])
      if (last.role === 'tool') return reply(`tool said: ${text}`)
      return reply('?')
    }
    const t = await make({
      script,
      overrides: {
        setup(s) {
          s.tools.register(
            {
              name: 'test.flaky',
              description: 'An idempotent tool that crashes once',
              parameters: { type: 'object', properties: {} },
              effect: 'idempotent',
              source: 'stdlib',
            },
            async () => {
              calls.flaky++
              if (calls.flaky === 1) throw new UnavailableError('worker died mid-call')
              return { output: { ok: true, attempt: calls.flaky } }
            },
          )
          s.tools.register(
            {
              name: 'test.send',
              description: 'A non-idempotent tool that crashes once',
              parameters: { type: 'object', properties: {} },
              effect: 'non_idempotent',
              source: 'stdlib',
            },
            async () => {
              calls.send++
              if (calls.send === 1) throw new UnavailableError('worker died mid-call')
              return { output: { sent: true } }
            },
          )
        },
      },
    })
    const requests = await requestsChannel(t)
    const finished = async (n: number) =>
      until(
        async () => {
          const rs = await requestRuns(t)
          return rs.length >= n && rs.every((r) => ['completed', 'failed'].includes(r.data.state)) ? rs : null
        },
        'runs to finish',
        15_000,
      )

    await post(t, requests, 'PROVIDER outage test')
    let runs = await finished(1)
    expect(runs[0]!.data.state).toBe('completed')
    expect(runs[0]!.data.result?.output).toBe('Recovered after the outage.')

    await post(t, requests, 'FLAKY tool test')
    runs = await finished(2)
    expect(runs[1]!.data.result?.output).toBe('tool said: {"ok":true,"attempt":2}')
    expect(calls.flaky).toBe(2)

    await post(t, requests, 'SEND tool test')
    runs = await finished(3)
    expect(calls.send).toBe(1) // never blindly retried
    const out = runs[2]!.data.result?.output ?? ''
    expect(out).toContain('uncertain')
  })

  it('6. a budget limit pauses a run, and it resumes after the limit is raised', async () => {
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      if (lastMsg(req).role === 'tool') return reply('Finished after the resume.')
      return callTools([{ name: 'checklist.show', args: {} }], undefined, {
        promptTokens: 1500,
        completionTokens: 20,
        totalTokens: 1520,
      })
    }
    const t = await make({ script })
    const s = t.a.services
    const employee = (await s.directory.employees.byHandle('meatless'))!
    await s.usage.limits.set({ target: { type: 'employee', id: employee.id }, maxTokens: 1000, period: 'run' })
    await post(t, await requestsChannel(t), 'Something expensive')
    await quiet(t)
    const [run] = await s.sessions.runs({ sessionId: await requestSessionId(t) })
    expect(run!.data.state).toBe('paused')
    expect(run!.data.pauseReason).toBeTruthy()
    const inbox = await t.req('GET', '/api/inbox')
    expect(inbox.body.find((i: any) => i.runId === run!.id)).toMatchObject({ type: 'limit' })
    const totals = await t.req('GET', `/api/usage/totals?sessionId=${run!.data.sessionId}`)
    expect(totals.body).toMatchObject({ input: 1500, output: 20, calls: 1 })

    await s.usage.limits.set({ target: { type: 'employee', id: employee.id }, maxTokens: 100_000, period: 'run' })
    const resumed = await t.req('POST', `/api/runs/${run!.id}/resume`, {})
    expect(resumed.status).toBe(200)
    expect(resumed.body.data.state).toBe('queued')
    await quiet(t)
    const done = (await s.sessions.getRun(run!.id)) as Run
    expect(done.data.state).toBe('completed')
    expect(done.data.result?.output).toBe('Finished after the resume.')
  })
}

export const isConflict = (e: unknown) => isMpError(e, 'conflict')
export type { Json }

/** Registers the suite for a backend, skipped with a reason when it isn't configured. */
export function describeScenarios(backend: Backend | null, name: string, reason: string) {
  if (!backend) {
    describe.skip(`scenarios: ${name} (${reason})`, () => {
      it('skipped', () => {})
    })
    return
  }
  describe(`scenarios: ${backend.name}`, () => {
    beforeAll(() => {})
    scenarioSuite(backend)
  })
}
