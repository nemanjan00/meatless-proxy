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
import { ROUTER_MARK, testApp, until, type TestApp } from './helpers.ts'

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
  // Tool results start with the id of their call (`[call …] `).
  const c = (lastMsg(req).content ?? '').replace(/^\[call [^\]]*\] /, '')
  try {
    return JSON.parse(c)
  } catch {
    return c
  }
}

/** Requests in #requests run on the router context itself (docs/spec.md, "The router context"). */
async function requestSessionId(t: TestApp): Promise<string> {
  return (await t.a.services.routerSessionFor())!
}

/** Every run a request in #requests started on the router context, oldest first. */
async function requestRuns(t: TestApp): Promise<Run[]> {
  const s = t.a.services
  const all = await s.sessions.runs({ sessionId: await requestSessionId(t) })
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

  it('1. the router context delegates: it starts a session that owns the thread, and keeps only a one-line decision', async () => {
    let t!: TestApp
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      const rootId = await rootByText(t, 'summary of the planning notes')
      if (has(req, 'WORKER:')) {
        if (lastMsg(req).role === 'tool')
          return reply(lastToolName(req) === 'chat.reply' && has(req, 'Q3 2026') ? 'Answered.' : 'Asked which quarter.')
        if ((lastMsg(req).content ?? '').includes('Q3 2026'))
          return callTools([{ name: 'chat.reply', args: { threadId: rootId, text: 'Here is the Q3 2026 summary: all good.' } }])
        return callTools([{ name: 'chat.reply', args: { threadId: rootId, text: 'On it. Which quarter do you mean?' } }])
      }
      // The router context.
      if (lastToolName(req) === 'sessions.commit') return reply('NO_REPLY')
      if (lastToolName(req) === 'sessions.create')
        return callTools([
          {
            name: 'sessions.commit',
            args: {
              summary: `thread ${rootId} (#requests, from Web user): planning notes summary → started @meatless#planning-summary`,
            },
          },
        ])
      return callTools([
        {
          name: 'sessions.create',
          args: { title: 'Planning summary', instruction: `WORKER: answer the request in thread ${rootId}` },
        },
      ])
    }
    t = await make({ script })
    const requests = await requestsChannel(t)
    const root = await post(t, requests, 'Can I get a summary of the planning notes?')
    await quiet(t)

    const s = t.a.services
    const routerId = (await s.routerSessionFor())!
    const routerRuns = await s.sessions.runs({ sessionId: routerId })
    expect(routerRuns.map((r) => [r.data.state, r.data.mode])).toEqual([['completed', 'ephemeral']])
    const event = await s.rawEvents.require(routerRuns[0]!.data.cause.eventId!)
    expect((event.data as any).routing.deliveries[0].reason).toBe('trigger')
    // Rolled back with a summary: the router's committed history is its prompt, its instructions and one decision.
    const routerHistory = await s.sessions.history(routerId)
    expect(routerHistory.map((e) => e.kind)).toEqual(['system', 'system', 'summary'])
    expect((routerHistory[2]!.content as any).text).toContain('→ started @meatless#planning-summary')

    // The new session owns the thread: a fresh session (not a fork of the router), subscribed as primary.
    const worker = (await s.sessions.query({ text: 'Planning summary' })).items.find((x) => x.data.title === 'Planning summary')!
    expect(worker.data.parent).toBeUndefined()
    const subs = await s.events.subscriptions.forSubject({ system: 'mp', id: root.id })
    expect(subs.map((x) => [x.data.sessionId, x.data.primary])).toEqual([[worker.id, true]])

    // The person answers in the thread: it goes straight to the worker, never through the router.
    await post(t, requests, 'Q3 2026, please', root.id)
    await quiet(t)
    const workerRuns = await s.sessions.runs({ sessionId: worker.id })
    expect(workerRuns.map((r) => r.data.state)).toEqual(['completed', 'completed'])
    const replyEvent = await s.rawEvents.require(workerRuns[1]!.data.cause.eventId!)
    expect((replyEvent.data as any).routing.deliveries.map((d: any) => d.reason)).toEqual(['subscription'])
    expect(await s.sessions.runs({ sessionId: routerId })).toHaveLength(1)

    const thread = await t.req('GET', `/api/chat/threads/${root.id}`)
    expect(thread.body.replies.map((m: any) => m.data.text)).toEqual([
      'On it. Which quarter do you mean?',
      'Q3 2026, please',
      'Here is the Q3 2026 summary: all good.',
    ])
    // Lineage: the reply event led through the subscription to the worker's run.
    const lin = await t.req('GET', `/api/lineage/${replyEvent.id}`)
    expect(lin.status).toBe(200)
    expect(lin.body.nodes.map((n: any) => n.type)).toEqual(expect.arrayContaining(['event', 'subscription', 'run', 'session']))
  })

  it('1b. the router answers directly, never subscribes, and sees its decision when the follow-up comes', async () => {
    let t!: TestApp
    const seen: string[] = []
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      const rootId = await rootByText(t, 'What is 17 * 23')
      if (lastToolName(req) === 'sessions.commit') return reply('NO_REPLY')
      const followUp = has(req, 'and times 2')
      if (lastToolName(req) === 'chat.reply')
        return callTools([
          {
            name: 'sessions.commit',
            args: {
              summary: `thread ${rootId} (#requests, from Web user): ${followUp ? '17*23*2' : '17*23'} → answered directly`,
            },
          },
        ])
      if (followUp) {
        // Its earlier decision is in its context, as a summary (the instructions' example line doesn't count).
        seen.push(
          req.messages
            .filter(
              (m) =>
                m.role === 'user' &&
                (m.content ?? '').startsWith('[summary') &&
                (m.content ?? '').includes('→ answered directly'),
            )
            .length.toString(),
        )
        return callTools([{ name: 'chat.reply', args: { threadId: `mp:${rootId}`, text: '782.' } }])
      }
      return callTools([{ name: 'chat.reply', args: { threadId: rootId, text: '391.' } }])
    }
    t = await make({ script })
    const s = t.a.services
    const requests = await requestsChannel(t)
    const root = await post(t, requests, 'What is 17 * 23?')
    await quiet(t)
    const routerId = (await s.routerSessionFor())!
    expect(await s.events.subscriptions.forSession(routerId)).toEqual([])

    await post(t, requests, 'and times 2?', root.id)
    await quiet(t)
    // The follow-up came back to the router through its trigger, and it saw its earlier decision.
    expect(seen).toEqual(['1'])
    const runs = await s.sessions.runs({ sessionId: routerId })
    expect(runs.map((r) => [r.data.state, r.data.mode])).toEqual([
      ['completed', 'ephemeral'],
      ['completed', 'ephemeral'],
    ])
    const summaries = (await s.sessions.history(routerId)).filter((e) => e.kind === 'summary')
    expect(summaries.map((e) => (e.content as any).text)).toEqual([
      expect.stringContaining('17*23 → answered directly'),
      expect.stringContaining('17*23*2 → answered directly'),
    ])
    const thread = await t.req('GET', `/api/chat/threads/${root.id}`)
    expect(thread.body.replies.map((m: any) => m.data.text)).toEqual(['391.', 'and times 2?', '782.'])
    expect(await s.events.subscriptions.forSession(routerId)).toEqual([])
  })

  it('1c. a plain-text answer from the router is posted in the thread, without subscribing it', async () => {
    const script = async (): Promise<ScriptResult> => reply("I'm Meatless, an AI employee.")
    const t = await make({ script })
    const s = t.a.services
    const root = await post(t, await requestsChannel(t), 'In one sentence: what are you?')
    await quiet(t)
    const thread = await t.req('GET', `/api/chat/threads/${root.id}`)
    expect(thread.body.replies.map((m: any) => [m.data.author.type, m.data.text])).toEqual([
      // The router context speaks as the employee.
      ['employee', "I'm Meatless, an AI employee."],
    ])
    expect(await s.events.subscriptions.forSession((await s.routerSessionFor())!)).toEqual([])
  })

  it('1d. an existing decision: the router forwards new messages about the same work to the session that owns it', async () => {
    let t!: TestApp
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      if (has(req, 'WORKER:')) return reply(has(req, 'any news') ? 'NO_REPLY: noted the question' : 'Looking into PAY-9.')
      if (lastToolName(req) === 'sessions.commit') return reply('NO_REPLY')
      const decided = req.messages.some(
        (m) =>
          m.role === 'user' &&
          (m.content ?? '').startsWith('[summary') &&
          (m.content ?? '').includes('→ started @meatless#pay-9-refunds'),
      )
      if (lastToolName(req) === 'sessions.create')
        return callTools([
          {
            name: 'sessions.commit',
            args: { summary: 'PAY-9 (#requests, from Web user): refunds broken → started @meatless#pay-9-refunds' },
          },
        ])
      if (lastToolName(req) === 'sessions.message')
        return callTools([
          {
            name: 'sessions.commit',
            args: { summary: 'PAY-9 (#requests, from Web user): asked for news → forwarded to @meatless#pay-9-refunds' },
          },
        ])
      if (decided)
        return callTools([
          { name: 'sessions.message', args: { to: '@meatless#pay-9-refunds', text: 'Web user asks: any news on PAY-9?' } },
        ])
      return callTools([
        {
          name: 'sessions.create',
          args: { title: 'PAY-9 refunds', slug: 'pay-9-refunds', instruction: 'WORKER: fix PAY-9, refunds are broken' },
        },
      ])
    }
    t = await make({ script })
    const s = t.a.services
    const requests = await requestsChannel(t)
    await post(t, requests, 'PAY-9: refunds are broken')
    await quiet(t)
    // A new top-level message about the same work, in another thread.
    await post(t, requests, 'any news on PAY-9?')
    await quiet(t)
    const worker = (await s.sessions.bySlug((await s.directory.employees.byHandle('meatless'))!.id, 'pay-9-refunds'))!
    const runs = await s.sessions.runs({ sessionId: worker.id })
    expect(runs).toHaveLength(2)
    const forwarded = await s.rawEvents.require(runs[1]!.data.cause.eventId!)
    expect(forwarded.data.text).toContain('any news on PAY-9')
    // Only one worker was started, and the router kept two one-line decisions.
    expect(
      (await s.sessions.query({ text: 'PAY-9 refunds' })).items.filter((x) => x.data.title === 'PAY-9 refunds'),
    ).toHaveLength(1)
    const summaries = (await s.sessions.history((await s.routerSessionFor())!)).filter((e) => e.kind === 'summary')
    expect(summaries.map((e) => (e.content as any).text)).toEqual([
      expect.stringContaining('→ started @meatless#pay-9-refunds'),
      expect.stringContaining('→ forwarded to @meatless#pay-9-refunds'),
    ])
  })

  it('1e. a router run cannot finish without recording its decision', async () => {
    const raw = Object.assign(
      async (req: ModelRequest): Promise<ScriptResult> => {
        if (lastToolName(req) === 'sessions.commit') return reply('NO_REPLY')
        if ((lastMsg(req).content ?? '').includes('record your decision'))
          return callTools([{ name: 'sessions.commit', args: { summary: 'thread (#requests): hello → answered directly' } }])
        return reply('Hello!')
      },
      { raw: true },
    )
    const t = await make({ script: raw })
    const s = t.a.services
    await post(t, await requestsChannel(t), 'hello')
    await quiet(t)
    const routerId = (await s.routerSessionFor())!
    const [run] = await s.sessions.runs({ sessionId: routerId })
    expect(run!.data.state).toBe('completed')
    const hist = await s.sessions.runHistory(run!.id)
    expect(hist.some((e) => e.kind === 'user' && (e.content as any).text.includes('record your decision'))).toBe(true)
    expect((await s.sessions.history(routerId)).at(-1)!.kind).toBe('summary')
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
    // The router context loops directly; its children start from its first entry, not its decision log.
    expect(tree.body.children.map((c: any) => c.origin)).toEqual(['loop', 'loop', 'loop'])
    expect(tree.body.children[0].loop).toMatchObject({ of: 3 })
    const childHistory = await s.sessions.history(children[0]!.id)
    expect(childHistory.some((e) => JSON.stringify(e.content).includes(ROUTER_MARK))).toBe(false)
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
      if (last.role === 'tool') return reply(`tool said: ${text.replace(/^\[call [^\]]*\] /, '')}`)
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
