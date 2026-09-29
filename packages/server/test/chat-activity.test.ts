import type { ChatActivityDone, ChatActivityItem } from '@mp/api'
import { sleep } from '@mp/core'
import { callTools, type ModelRequest, reply, type ScriptResult } from '@mp/model'
import { afterEach, describe, expect, it } from 'vitest'
import { describeStep } from '../src/chat-activity.ts'
import { routeEvent } from '../src/workers.ts'
import { ROUTER_MARK, type TestApp, testApp, until } from './helpers.ts'

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

/** What the activity tracker published on the bus. */
function record(app: TestApp) {
  const items: ChatActivityItem[] = []
  const done: ChatActivityDone[] = []
  app.a.services.bus.subscribe<{ item: ChatActivityItem }>('chat.activity', (m) => void items.push(m.payload.item))
  app.a.services.bus.subscribe<ChatActivityDone>('chat.activity.done', (m) => void done.push(m.payload))
  return { items, done }
}

const settle = async (app: TestApp) => {
  await until(
    async () => {
      await app.a.services.queue.idle()
      await app.a.services.bus.idle()
      return (await app.a.services.sessions.runs({ state: ['queued', 'running'] })).length === 0
    },
    'runs to settle',
    10_000,
  )
  await app.settle()
  await app.a.activity.flush()
}

const isRouter = (req: ModelRequest) => req.messages.some((m) => m.role === 'system' && (m.content ?? '').includes(ROUTER_MARK))
const lastTool = (req: ModelRequest) => {
  const last = req.messages.at(-1)
  if (last?.role !== 'tool') return undefined
  for (const m of req.messages) {
    const c = m.tool_calls?.find((x) => x.id === last.tool_call_id)
    if (c) return c.function.name.replace(/__/g, '.')
  }
  return undefined
}

describe('chat activity, end to end', () => {
  it("shows the router's run, then the session it handed the thread to, then a subscribed session's run", async () => {
    let root = ''
    const script = async (req: ModelRequest): Promise<ScriptResult> => {
      if (isRouter(req)) {
        if (lastTool(req) === 'sessions.create') return reply('Passed to a session.')
        return callTools([
          {
            name: 'sessions.create',
            args: { title: 'Pay refund', slug: 'pay-refund', instruction: 'Refund the double charge.' },
          },
        ])
      }
      await until(() => root, 'the root message id')
      if (lastTool(req) === 'chat.reply') return reply('done')
      return callTools([{ name: 'chat.reply', args: { threadId: root, text: 'Refund started.' } }])
    }
    t = await testApp({ script })
    const { items, done } = record(t)
    const s = t.a.services
    const general = (await s.chat.channelByName('general'))!.id
    const posted = await t.req('POST', `/api/chat/channels/${general}/messages`, { text: '@meatless refund PAY-123 please' })
    root = posted.body.id
    await settle(t)

    const routerId = (await s.routerSessionFor())!
    const routerItems = items.filter((i) => i.sessionId === routerId)
    expect(routerItems.length).toBeGreaterThan(0)
    expect(routerItems[0]).toMatchObject({
      channelId: general,
      threadId: root,
      messageId: root,
      sessionLabel: '@meatless',
      router: true,
      employee: { name: expect.any(String), handle: 'meatless' },
    })
    expect(routerItems.map((i) => i.state)).toContain('running')
    expect(routerItems.map((i) => i.step)).toContain('starting a session')

    const handed = done.find((d) => d.sessionId === routerId)!
    expect(handed).toMatchObject({ outcome: 'handed_off', threadId: root, handedTo: { sessionLabel: '@meatless#pay-refund' } })
    const childId = handed.handedTo!.sessionId
    const childItems = items.filter((i) => i.sessionId === childId)
    expect(childItems[0]).toMatchObject({ threadId: root, messageId: root, sessionLabel: '@meatless#pay-refund' })
    expect(childItems.map((i) => i.step)).toContain('writing a reply')
    expect(done.find((d) => d.sessionId === childId)).toMatchObject({ outcome: 'replied', threadId: root })
    // Nothing is left working.
    expect((await t.req('GET', `/api/chat/channels/${general}/activity`)).body).toEqual([])

    // A follow-up goes straight to the session that owns the thread (a subscription): its run shows too.
    items.length = 0
    done.length = 0
    const followUp = await t.req('POST', `/api/chat/channels/${general}/messages`, { text: 'Thanks! Any news?', threadId: root })
    await settle(t)
    expect(items.every((i) => i.sessionId === childId)).toBe(true)
    expect(items[0]).toMatchObject({ threadId: root, messageId: followUp.body.id })
    expect(done).toEqual([expect.objectContaining({ sessionId: childId, outcome: 'replied', messageId: followUp.body.id })])
  })

  it('reports no_reply when the router ends with NO_REPLY, and failed when a run fails', async () => {
    t = await testApp({ script: () => reply('NO_REPLY: people talking') })
    const { done } = record(t)
    const s = t.a.services
    const general = (await s.chat.channelByName('general'))!.id
    const m = await t.req('POST', `/api/chat/channels/${general}/messages`, { text: '@meatless (just saying hi to Bob)' })
    await settle(t)
    const routerId = (await s.routerSessionFor())!
    expect(done).toEqual([
      expect.objectContaining({ outcome: 'no_reply', sessionId: routerId, messageId: m.body.id, sessionLabel: '@meatless' }),
    ])
  })
})

describe('chat activity, step by step', () => {
  /** Without workers the queue never idles: wait for the bus, the live hub and the tracker only. */
  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      await t!.a.services.bus.idle()
      await t!.a.live.flush()
      await t!.a.activity.flush()
      await sleep(2)
    }
  }
  /** A test app without workers: routing and run states are driven by the test. */
  const manual = async () => {
    t = await testApp({ script: [reply('ok')], workers: false })
    const s = t.a.services
    const rec = record(t)
    const general = (await s.chat.channelByName('general'))!.id
    const post = async (text: string, channelId = general, headers?: Record<string, string>) => {
      const m = await t!.req('POST', `/api/chat/channels/${channelId}/messages`, { text }, headers)
      expect(m.status).toBe(201)
      const e = (await s.records.getByKey('event', `chat:${m.body.id}`))!
      await routeEvent(s, e.id)
      await flush()
      return { messageId: m.body.id as string, eventId: e.id }
    }
    const runOf = async (eventId: string) =>
      (await s.records.query<any>('run', { where: { 'cause.eventId': eventId } })).items[0]!
    return { s, general, post, runOf, ...rec }
  }

  it('tracks a queued run, its states and pause reason, and serves them on the endpoint', async () => {
    const { s, general, post, runOf, items } = await manual()
    const { messageId, eventId } = await post('@meatless what is the refund policy?')
    const run = await runOf(eventId)
    expect(items.at(-1)).toMatchObject({ runId: run.id, state: 'queued', messageId, threadId: messageId })
    let list = (await t!.req('GET', `/api/chat/channels/${general}/activity`)).body
    expect(list).toEqual([expect.objectContaining({ runId: run.id, state: 'queued', sessionLabel: '@meatless' })])

    await s.sessions.transition(run.id, 'queued', 'running')
    await flush()
    expect(items.at(-1)).toMatchObject({ runId: run.id, state: 'running' })
    s.bus.publish('tool.called', { runId: run.id, sessionId: run.data.sessionId, name: 'code.run', args: {} })
    await flush()
    expect(items.at(-1)).toMatchObject({ step: 'running code' })
    await s.sessions.transition(run.id, 'running', 'paused', { pauseReason: 'needs approval' })
    await flush()
    expect(items.at(-1)).toMatchObject({ state: 'paused', pauseReason: 'needs approval' })
    list = (await t!.req('GET', `/api/chat/channels/${general}/activity`)).body
    expect(list[0]).toMatchObject({ state: 'paused', pauseReason: 'needs approval', step: 'running code' })
    await s.sessions.transition(run.id, 'paused', 'queued')
    await flush()
    expect(items.at(-1)).toMatchObject({ state: 'queued' })
    expect(items.at(-1)!.pauseReason).toBeUndefined()
  })

  it('reports failed with the reason, and drops the item', async () => {
    const { s, general, post, runOf, done } = await manual()
    const { messageId, eventId } = await post('@meatless deploy it')
    const run = await runOf(eventId)
    await s.sessions.transition(run.id, 'queued', 'running')
    await s.sessions.transition(run.id, 'running', 'failed', { result: { status: 'failed', error: 'model unavailable' } })
    await flush()
    expect(done).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'model unavailable', runId: run.id, messageId })])
    expect((await t!.req('GET', `/api/chat/channels/${general}/activity`)).body).toEqual([])
  })

  it('reports replied for a run that answered in chat', async () => {
    const { s, post, runOf, done } = await manual()
    const { eventId } = await post('@meatless hello')
    const run = await runOf(eventId)
    await s.sessions.transition(run.id, 'queued', 'running')
    s.bus.publish('tool.called', { runId: run.id, sessionId: run.data.sessionId, name: 'chat.reply', args: {} })
    await s.sessions.transition(run.id, 'running', 'completed', { result: { status: 'completed', output: 'done' } })
    await flush()
    expect(done.at(-1)).toMatchObject({ outcome: 'replied' })
  })

  it('reports a sessions.message hand-off, and follows the session it messaged', async () => {
    const { s, post, runOf, done, items } = await manual()
    const employee = (await s.directory.employees.byHandle('meatless'))!
    const target = await s.sessions.create({ employeeId: employee.id, title: 'Refunds', slug: 'refunds' })
    const { messageId, eventId } = await post('@meatless another refund')
    const run = await runOf(eventId)
    await s.sessions.transition(run.id, 'queued', 'running')
    s.bus.publish('tool.called', {
      runId: run.id,
      sessionId: run.data.sessionId,
      name: 'sessions.message',
      args: { to: '@meatless#refunds', text: 'another refund' },
    })
    await flush()
    // What sessions.message does: an event for the target session, routed to it.
    const { event } = await s.events.ingest({
      source: 'session',
      type: 'session.message',
      dedupeKey: 'session.message:test',
      subject: { system: 'mp', id: target.id },
      employeeId: employee.id,
      payload: {
        text: 'another refund',
        fromSessionId: run.data.sessionId,
        author: { kind: 'session', id: run.data.sessionId },
        tags: [{ raw: '@meatless#refunds', type: 'session', employeeId: employee.id, sessionId: target.id }],
      },
    })
    await routeEvent(s, event.id)
    await s.sessions.transition(run.id, 'running', 'completed', { result: { status: 'completed', output: 'Passed on.' } })
    await flush()
    expect(done).toEqual([
      expect.objectContaining({ outcome: 'handed_off', handedTo: { sessionId: target.id, sessionLabel: '@meatless#refunds' } }),
    ])
    expect(items.at(-1)).toMatchObject({ sessionId: target.id, threadId: messageId, sessionLabel: '@meatless#refunds' })
  })

  it('reports unrouted for a message nobody picked up, and nothing for plain chat', async () => {
    const { s, post, done, items } = await manual()
    const admin = (await t!.admin()).contactId
    const ch = await s.chat.createChannel({ name: 'orphans', createdBy: { kind: 'contact', id: admin } })
    const employee = (await s.directory.employees.byHandle('meatless'))!
    // A trigger whose context is gone: routing plans a delivery, which is skipped.
    await s.events.triggers.create(
      {
        name: 'Orphans',
        employeeId: employee.id,
        match: { source: 'chat', type: 'message.posted', where: { 'payload.channelId': ch.id } },
        target: { type: 'session', sessionId: 'ses_01JBGONE0000000000000000000' },
      },
      { type: 'system', id: 'test' },
    )
    const { messageId } = await post('anyone here?', ch.id)
    expect(done).toEqual([{ channelId: ch.id, threadId: messageId, messageId, outcome: 'unrouted' }])
    expect(items).toEqual([])

    // People talking in a channel nobody listens to: nothing to say.
    done.length = 0
    const quiet = await s.chat.createChannel({ name: 'watercooler', createdBy: { kind: 'contact', id: admin } })
    await post('lunch at 12?', quiet.id)
    expect(done).toEqual([])
  })

  it("hides a DM's activity from people who aren't in it, on the endpoint and live", async () => {
    const { s, post } = await manual()
    const anaId = (await s.directory.contacts.create({ name: 'Ana Example', kind: 'person', access: 'member' })).id
    const bobId = (await s.directory.contacts.create({ name: 'Bob Example', kind: 'person', access: 'member' })).id
    const ana = await t!.as(anaId)
    const bob = await t!.as(bobId)
    const employee = (await s.directory.employees.byHandle('meatless'))!
    const dm = (await t!.req('POST', '/api/chat/dms', { members: [{ kind: 'employee', id: employee.id }] }, ana)).body

    // Live: Ana's socket gets it on chat:<dm>; Bob can't subscribe.
    const socket = (who: string) => {
      const got: any[] = []
      const conn = t!.a.live.connect({ send: (d) => void got.push(JSON.parse(d)), close() {} }, { contactId: who })
      conn.message(JSON.stringify({ type: 'subscribe', channels: [`chat:${dm.id}`] }))
      return { got, conn }
    }
    const a = socket(anaId)
    const b = socket(bobId)
    await t!.a.live.flush()
    expect(b.got.find((m) => m.type === 'error')?.message).toContain(`chat:${dm.id}`)

    const { messageId } = await post('what is my salary?', dm.id, ana)
    await t!.a.live.flush()
    const live = a.got.filter((m) => m.type === 'event' && m.topic === 'chat.activity')
    expect(live[0]).toMatchObject({ channel: `chat:${dm.id}`, payload: { channelId: dm.id, item: { messageId } } })
    expect(b.got.some((m) => m.topic === 'chat.activity')).toBe(false)

    expect((await t!.req('GET', `/api/chat/channels/${dm.id}/activity`, undefined, ana)).body).toHaveLength(1)
    expect((await t!.req('GET', `/api/chat/channels/${dm.id}/activity`, undefined, bob)).status).toBe(404)
    expect((await t!.req('GET', '/api/chat/channels/chn_01JBNOPE000000000000000000/activity')).status).toBe(404)
    a.conn.close()
    b.conn.close()
  })

  it('picks up runs that were going before a restart', async () => {
    const { s, general, post, runOf } = await manual()
    const { eventId, messageId } = await post('@meatless still there?')
    const run = await runOf(eventId)
    // A fresh tracker (as after a restart) finds the queued run from the database.
    const { ChatActivity } = await import('../src/chat-activity.ts')
    const fresh = new ChatActivity(s)
    await sleep(5)
    expect(await fresh.items(general)).toEqual([expect.objectContaining({ runId: run.id, messageId, state: 'queued' })])
    fresh.close()
  })
})

describe('describeStep', () => {
  it('puts tool calls in plain words', () => {
    expect(describeStep('chat.read')).toBe('reading the thread')
    expect(describeStep('code.run')).toBe('running code')
    expect(describeStep('env.up')).toBe('starting an environment')
    expect(describeStep('docs.write_chapter')).toBe('writing docs')
    expect(describeStep('memory.recall')).toBe('checking its memory')
    expect(describeStep('gitlab__create_merge_request')).toBe('using gitlab')
    expect(describeStep('mystery')).toBe('using mystery')
  })
})
