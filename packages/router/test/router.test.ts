import { createEventBus, createHooks, type Json } from '@mp/core'
import { createEvents } from '@mp/events'
import { memoryQueue } from '@mp/queue'
import { createRecords } from '@mp/records'
import { createSessions } from '@mp/sessions'
import { memoryStore } from '@mp/store'
import { describe, expect, it } from 'vitest'
import { beforeDeliver, chatTags, createRouter, renderEvent, type RecipientResolver } from '../src/index.ts'

async function setup(opts: { resolvers?: RecipientResolver[] } = {}) {
  const bus = createEventBus()
  const records = createRecords({ store: memoryStore({ bus }) })
  const sessions = createSessions({ records, bus })
  const events = createEvents({ records, bus })
  const queue = memoryQueue()
  const hooks = createHooks()
  const mk = (title: string, employeeId = 'emp_a') =>
    sessions.create({ employeeId, title, entries: [{ kind: 'system', content: { text: title } }] })
  const routerA = await mk('router a')
  const routerB = await mk('router b', 'emp_b')
  const defaultRouter = await mk('default router', 'emp_default')
  const procedureCtx = await mk('access request procedure')
  const router = createRouter({
    events,
    sessions,
    queue,
    hooks,
    bus,
    routerSessionFor: async (employeeId) =>
      employeeId === 'emp_a' ? routerA.id : employeeId === 'emp_b' ? routerB.id : employeeId ? null : defaultRouter.id,
    procedureContext: async (id) => (id === 'prc_access' ? procedureCtx.id : null),
    ...(opts.resolvers ? { resolvers: opts.resolvers } : {}),
  })
  const queued: string[] = []
  queue.process<{ runId: string }>('runs', async (j) => void queued.push(j.data.runId))
  const ingest = (input: Parameters<typeof events.ingest>[0]) => events.ingest(input).then((r) => r.event)
  return {
    bus,
    records,
    sessions,
    events,
    queue,
    hooks,
    router,
    mk,
    routerA,
    routerB,
    defaultRouter,
    procedureCtx,
    queued,
    ingest,
  }
}

const firstEvent = async (sessions: any, runId: string) =>
  (await sessions.runHistory(runId)).find((e: any) => e.kind === 'event')?.content

describe('router', () => {
  it('delivers to subscribed sessions directly, trusted, as continuing runs', async () => {
    const t = await setup()
    const work = await t.mk('PAY-123 work')
    await t.events.subscriptions.subscribe(work.id, { system: 'linear', id: 'PAY-123' }, { primary: true })
    const ev = await t.ingest({
      source: 'mcp:linear',
      type: 'comment.created',
      subject: { system: 'linear', id: 'PAY-123' },
      text: 'Ana: any news?',
    })
    const res = await t.router.route(ev.id)
    expect(res.deliveries).toHaveLength(1)
    const d = res.deliveries[0]!
    expect(d).toMatchObject({ sessionId: work.id, reason: 'subscription', trusted: true, expectedToAct: true })
    expect(d.outcome.type).toBe('run')
    const run = await t.sessions.requireRun((d.outcome as any).runId)
    expect(run.data.mode).toBe('continuing')
    expect(await firstEvent(t.sessions, run.id)).toMatchObject({ trusted: true, expectedToAct: true })
    expect((await t.events.require(ev.id)).data.routed).toBe(true)
    await t.queue.idle()
    expect(t.queued).toEqual([run.id])
  })

  it('routes new work through triggers to a fork of the context, untrusted and ephemeral', async () => {
    const t = await setup()
    await t.events.triggers.create({
      name: 'access',
      employeeId: 'emp_a',
      match: { type: 'access.*' },
      target: { type: 'procedure', procedureId: 'prc_access' },
    })
    const ev = await t.ingest({ source: 'mcp:linear', type: 'access.requested', employeeId: 'emp_a', payload: { who: 'Bob' } })
    const [d] = (await t.router.route(ev.id)).deliveries
    expect(d).toMatchObject({ reason: 'trigger', trusted: false, fork: true })
    const run = await t.sessions.requireRun((d!.outcome as any).runId)
    expect(run.data.sessionId).not.toBe(t.procedureCtx.id)
    const fork = await t.sessions.require(run.data.sessionId)
    expect(fork.data.parent?.sessionId).toBe(t.procedureCtx.id)
    expect(run.data.mode).toBe('ephemeral')
    expect((await t.events.triggers.list())[0]!.data.fired).toBe(1)
  })

  it('falls back to the employee router, or the default router', async () => {
    const t = await setup()
    const e1 = await t.ingest({ source: 'mcp:slack', type: 'message.posted', employeeId: 'emp_b', text: 'hello?' })
    expect((await t.router.route(e1.id)).deliveries[0]).toMatchObject({
      sessionId: t.routerB.id,
      reason: 'fallback',
      trusted: false,
    })
    const e2 = await t.ingest({ source: 'webhook', type: 'unknown' })
    expect((await t.router.route(e2.id)).deliveries[0]).toMatchObject({ sessionId: t.defaultRouter.id, reason: 'fallback' })
  })

  it('puts deliveries for a busy continuing session in its inbox, and wakes it when it waits for one', async () => {
    const t = await setup()
    const work = await t.mk('thread work')
    const subject = { system: 'mp', id: 'msg_thread' }
    await t.events.subscriptions.subscribe(work.id, subject, { primary: true })
    const active = await t.sessions.createRun({ sessionId: work.id, cause: { type: 'manual' } })
    await t.sessions.transition(active.id, 'queued', 'running')
    const e1 = await t.ingest({ source: 'chat', type: 'message.replied', subject, text: 'first reply' })
    const [d1] = (await t.router.route(e1.id)).deliveries
    expect(d1!.outcome).toMatchObject({ type: 'inbox', runId: active.id })
    await t.sessions.suspend(active.id, { type: 'delivery' })
    const e2 = await t.ingest({ source: 'chat', type: 'message.replied', subject, text: 'second reply' })
    const [d2] = (await t.router.route(e2.id)).deliveries
    expect(d2!.outcome).toMatchObject({ type: 'woke', runId: active.id })
    expect((await t.sessions.requireRun(active.id)).data.state).toBe('queued')
    expect((await t.sessions.inbox(work.id)).map((i) => i.data.text)).toHaveLength(2)
  })

  it('uses chat tags: session tags, employee tags, and never echoes an author', async () => {
    const t = await setup()
    const target = await t.mk('refund work', 'emp_b')
    const author = await t.mk('author', 'emp_a')
    const subject = { system: 'mp', id: 'msg_root' }
    await t.events.subscriptions.subscribe(author.id, subject, { primary: true })
    const ev = await t.ingest({
      source: 'chat',
      type: 'message.posted',
      subject,
      payload: {
        text: '@b#refund-work and @a please look',
        tags: [
          { raw: '@b#refund-work', type: 'session', employeeId: 'emp_b', sessionId: target.id },
          { raw: '@a', type: 'employee', employeeId: 'emp_a' },
        ],
        author: { kind: 'session', id: author.id },
      } as Json,
    })
    const res = await t.router.route(ev.id)
    const bySession = Object.fromEntries(res.deliveries.map((d) => [d.sessionId, d]))
    expect(bySession[target.id]).toMatchObject({ reason: 'session_tag', expectedToAct: true })
    expect(bySession[author.id]).toBeUndefined()
    expect(bySession[t.routerA.id]).toMatchObject({ reason: 'employee_tag' })
    expect(chatTags(ev).sessions).toEqual([target.id])
  })

  it('without tags only the primary subscriber is expected to act; tags override', async () => {
    const t = await setup()
    const primary = await t.mk('primary')
    const watcher = await t.mk('watcher', 'emp_b')
    const subject = { system: 'linear', id: 'PAY-9' }
    await t.events.subscriptions.subscribe(primary.id, subject, { primary: true })
    await t.events.subscriptions.subscribe(watcher.id, subject)
    const plain = await t.ingest({ source: 'mcp:linear', type: 'comment.created', subject, text: 'x' })
    const plan = await t.router.plan(plain)
    expect(plan.find((d) => d.sessionId === primary.id)?.expectedToAct).toBe(true)
    expect(plan.find((d) => d.sessionId === watcher.id)?.expectedToAct).toBe(false)
    const tagged = await t.ingest({
      source: 'chat',
      type: 'message.replied',
      subject,
      payload: { tags: [{ raw: '@b', type: 'employee', employeeId: 'emp_b' }] },
    })
    const plan2 = await t.router.plan(tagged)
    expect(plan2.find((d) => d.sessionId === watcher.id)?.expectedToAct).toBe(true)
    expect(plan2.find((d) => d.sessionId === primary.id)?.expectedToAct).toBe(false)
    expect(plan2.some((d) => d.sessionId === t.routerB.id)).toBe(false)
  })

  it('includes extra recipients from resolvers (e.g. channel members)', async () => {
    let member = ''
    const t = await setup({
      resolvers: [async () => [{ sessionId: member, reason: 'member', expectedToAct: false, trusted: true, fork: false }]],
    })
    member = (await t.mk('member')).id
    const ev = await t.ingest({ source: 'chat', type: 'message.posted', text: 'hi all' })
    const plan = await t.router.plan(ev)
    expect(plan.map((d) => d.reason).sort()).toEqual(['fallback', 'member'])
  })

  it('beforeDeliver can skip or pause deliveries', async () => {
    const t = await setup()
    t.hooks.on(beforeDeliver, ({ event }) => {
      if (event.data.text === 'skip me') return { skip: 'AI streak limit' }
      if (event.data.text === 'pause me') return { pause: 'needs a person' }
      return undefined
    })
    const e1 = await t.ingest({ source: 'x', type: 'y', text: 'skip me' })
    expect((await t.router.route(e1.id)).deliveries[0]!.outcome).toMatchObject({ type: 'skipped', reason: 'AI streak limit' })
    const e2 = await t.ingest({ source: 'x', type: 'y', text: 'pause me' })
    const out = (await t.router.route(e2.id)).deliveries[0]!.outcome as any
    expect((await t.sessions.requireRun(out.runId)).data).toMatchObject({ state: 'paused', pauseReason: 'needs a person' })
  })

  it('is idempotent per event', async () => {
    const t = await setup()
    const ev = await t.ingest({ source: 'x', type: 'y', text: 'once' })
    expect((await t.router.route(ev.id)).deliveries).toHaveLength(1)
    expect((await t.router.route(ev.id)).deliveries).toHaveLength(0)
    expect((await t.sessions.runs({})).length).toBe(1)
  })

  it('gives human-caused runs a higher priority', async () => {
    const t = await setup()
    const ev = await t.ingest({ source: 'x', type: 'y', actorContactId: 'con_ana', text: 'from a person' })
    const out = (await t.router.route(ev.id)).deliveries[0]!.outcome as any
    const run = await t.sessions.requireRun(out.runId)
    expect(run.data.priority).toBe(10)
    expect(run.data.requesterId).toBe('con_ana')
  })

  it('renders events with a size cap', async () => {
    const t = await setup()
    const ev = await t.ingest({
      source: 'mcp:linear',
      type: 'task.created',
      subject: { system: 'linear', id: 'X-1' },
      payload: { body: 'y'.repeat(10_000) },
    })
    const text = renderEvent(ev, 200)
    expect(text.startsWith('[mcp:linear task.created linear:X-1]')).toBe(true)
    expect(text).toContain('truncated')
  })
})
