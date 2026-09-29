import { ManualClock, createEventBus, createHooks, type Json } from '@mp/core'
import { SCHEDULE_FIRED, SCHEDULE_SOURCE, createEvents, type MpEvent } from '@mp/events'
import { memoryQueue } from '@mp/queue'
import { createRecords } from '@mp/records'
import { createSessions } from '@mp/sessions'
import { memoryStore } from '@mp/store'
import { describe, expect, it } from 'vitest'
import { beforeDeliver, runInput, chatTags, createRouter, eventTime, renderEvent, type RecipientResolver } from '../src/index.ts'

async function setup(
  opts: {
    resolvers?: RecipientResolver[]
    participantsOf?: (e: any) => Promise<string[]>
    prepareEvent?: (e: MpEvent) => Promise<MpEvent>
  } = {},
) {
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
    ...(opts.participantsOf ? { participantsOf: opts.participantsOf } : {}),
    ...(opts.prepareEvent ? { prepareEvent: opts.prepareEvent } : {}),
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

  it("sends a person's untagged follow-up to the employees already in the thread", async () => {
    const t = await setup({ participantsOf: async () => ['emp_a'] })
    const reply = (payload: Record<string, Json>, actorContactId?: string) =>
      t.ingest({
        source: 'chat',
        type: 'message.replied',
        subject: { system: 'mp', id: 'msg_root' },
        ...(actorContactId ? { actorContactId } : {}),
        payload: payload as Json,
      })
    // A person's untagged follow-up goes to the router of the employee in the thread.
    const plan = await t.router.plan(await reply({ text: 'and which projects?' }, 'con_ana'))
    expect(plan).toEqual([
      expect.objectContaining({ sessionId: t.routerA.id, reason: 'thread_participant', expectedToAct: true }),
    ])
    // Not when the person tags someone else: it's for them.
    const tagged = await t.router.plan(
      await reply({ tags: [{ raw: '@b', type: 'employee', employeeId: 'emp_b' }] as Json }, 'con_ana'),
    )
    expect(tagged.map((d) => d.sessionId)).toEqual([t.routerB.id])
    // Not for messages from AIs (no loops), and not when a session of the employee already handles the thread.
    expect(
      (await t.router.plan(await reply({ author: { kind: 'session', id: 'ses_other' } as Json }))).some(
        (d) => d.reason === 'thread_participant',
      ),
    ).toBe(false)
    const worker = await t.mk('handles the thread')
    await t.events.subscriptions.subscribe(worker.id, { system: 'mp', id: 'msg_root' }, { primary: true })
    const handled = await t.router.plan(await reply({ text: 'thanks, one more thing' }, 'con_ana'))
    expect(handled.map((d) => [d.sessionId, d.reason])).toEqual([[worker.id, 'subscription']])
  })

  it('notes information-only deliveries in the history without starting a model run', async () => {
    const t = await setup()
    const watcher = await t.mk('watcher', 'emp_b')
    const subject = { system: 'mp', id: 'msg_watch' }
    await t.events.subscriptions.subscribe(watcher.id, subject)
    const ev = await t.ingest({ source: 'chat', type: 'message.replied', subject, text: 'fyi: deploy done' })
    const out = await t.router.deliver(ev, {
      sessionId: watcher.id,
      reason: 'subscription',
      expectedToAct: false,
      trusted: true,
      fork: false,
      priority: 0,
    })
    expect(out.type).toBe('noted')
    const run = await t.sessions.getRun((out as any).runId)
    expect(run!.data.state).toBe('completed')
    expect(t.queued).not.toContain(run!.id)
    const history = await t.sessions.history(watcher.id)
    expect(history.at(-1)!.kind).toBe('event')
    expect(JSON.stringify(history.at(-1)!.content)).toContain('fyi: deploy done')
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
    // Plain conversation (no tags, no trigger) doesn't fall back to a router; members still see it.
    expect(plan.map((d) => d.reason).sort()).toEqual(['member'])
    const other = await t.ingest({ source: 'webhook', type: 'ping', text: 'not chat' })
    expect((await t.router.plan(other)).map((d) => d.reason).sort()).toEqual(['fallback', 'member'])
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
    expect(text.startsWith('[mcp:linear task.created linear:X-1; ')).toBe(true)
    expect(text).toContain('truncated')
  })

  it('renders when the event arrived, with the weekday, in UTC', async () => {
    const bus = createEventBus()
    const clock = new ManualClock(Date.UTC(2026, 8, 29, 12, 7, 31))
    const events = createEvents({ records: createRecords({ store: memoryStore({ bus }) }), bus, clock })
    const { event } = await events.ingest({ source: 'chat', type: 'message.posted', text: 'what time is it?' })
    expect(event.data.receivedAt).toBe('2026-09-29T12:07:31.000Z')
    expect(renderEvent(event)).toBe('[chat message.posted; Tue 2026-09-29 12:07 UTC]\nwhat time is it?')
    // Each event carries its own arrival time.
    clock.advance(5 * 24 * 3600_000)
    const later = (await events.ingest({ source: 'chat', type: 'message.posted', text: 'and now?' })).event
    expect(renderEvent(later).split('\n')[0]).toBe('[chat message.posted; Sun 2026-10-04 12:07 UTC]')
  })

  it('formats event times, and leaves out missing or broken ones', () => {
    expect(eventTime('2026-09-29T00:00:00.000Z')).toBe('Tue 2026-09-29 00:00 UTC')
    expect(eventTime('2026-12-31T23:59:59.999+01:00')).toBe('Thu 2026-12-31 22:59 UTC')
    expect(eventTime('')).toBe('')
    expect(eventTime(undefined)).toBe('')
    expect(eventTime('not a date')).toBe('')
  })
})

describe('router pause into a busy session', () => {
  it('a pause decision pauses a suspended continuing run instead of waking it', async () => {
    const t = await setup()
    t.hooks.on(beforeDeliver, () => ({ pause: 'AI streak' }))
    const work = await t.mk('busy')
    const subject = { system: 'mp', id: 'msg_t' }
    await t.events.subscriptions.subscribe(work.id, subject, { primary: true })
    const active = await t.sessions.createRun({ sessionId: work.id, cause: { type: 'manual' } })
    await t.sessions.transition(active.id, 'queued', 'running')
    await t.sessions.suspend(active.id, { type: 'delivery' })
    const ev = await t.ingest({ source: 'chat', type: 'message.replied', subject, text: 'ping' })
    await t.router.route(ev.id)
    expect((await t.sessions.requireRun(active.id)).data).toMatchObject({ state: 'paused', pauseReason: 'AI streak' })
  })
})

describe('reactions', () => {
  it("a person's reaction reaches the session that wrote the message; a session's own reaction doesn't echo", async () => {
    const t = await setup()
    const writer = await t.mk('writer')
    const subject = { system: 'mp', id: 'msg_root2' }
    await t.events.subscriptions.subscribe(writer.id, subject, { primary: true })
    const byPerson = await t.ingest({
      source: 'chat',
      type: 'reaction.added',
      subject,
      actorContactId: 'con_ana',
      payload: {
        messageId: 'msg_root2',
        emoji: '✅',
        author: { kind: 'session', id: writer.id },
        by: { kind: 'contact', id: 'con_ana' },
      },
    })
    expect((await t.router.plan(byPerson)).map((d) => d.sessionId)).toEqual([writer.id])
    const bySelf = await t.ingest({
      source: 'chat',
      type: 'reaction.added',
      subject,
      payload: {
        messageId: 'msg_root2',
        emoji: '👀',
        author: { kind: 'contact', id: 'con_ana' },
        by: { kind: 'session', id: writer.id },
      },
    })
    expect((await t.router.plan(bySelf)).map((d) => d.sessionId)).toEqual([])
  })

  describe('runInput', () => {
    it('adds entries to a fork after the fork point and before the event', async () => {
      const t = await setup()
      const ctx = await t.mk('requests context')
      await t.events.triggers.create({
        name: 'tasks',
        employeeId: 'emp_a',
        match: { type: 'task.*' },
        target: { type: 'session', sessionId: ctx.id },
        fork: true,
      })
      const seen: { context: string; fork: string; reason: string }[] = []
      t.hooks.onTransform(runInput, (p) => {
        seen.push({ context: p.context.id, fork: p.session.id, reason: p.delivery.reason })
        return { ...p, entries: [...p.entries, { kind: 'system' as const, content: { text: 'remember: Ana prefers mornings' } }] }
      })
      t.hooks.onTransform(runInput, (p) => ({
        ...p,
        entries: [...p.entries, { kind: 'system' as const, content: { text: 'second' }, meta: { from: 'test' } }],
      }))
      const ev = await t.ingest({ source: 'mcp:linear', type: 'task.assigned', employeeId: 'emp_a', text: 'New task' })
      const res = await t.router.route(ev.id)
      const out = res.deliveries[0]!.outcome as { runId: string; sessionId: string }
      expect(seen).toEqual([{ context: ctx.id, fork: out.sessionId, reason: 'trigger' }])
      const fork = await t.sessions.require(out.sessionId)
      expect(fork.data.parent?.sessionId).toBe(ctx.id)
      // The fork's committed history is the context's: the entries belong to the run, on top of it.
      expect((await t.sessions.history(fork.id)).map((e) => e.id)).toEqual((await t.sessions.history(ctx.id)).map((e) => e.id))
      const hist = await t.sessions.runHistory(out.runId)
      expect(hist.map((e) => [e.kind, (e.content as any).text ?? null])).toEqual([
        ['system', 'requests context'],
        ['system', 'remember: Ana prefers mornings'],
        ['system', 'second'],
        ['event', expect.stringContaining('New task')],
      ])
      expect(hist[2]!.meta.from).toBe('test')
    })

    it('also runs for runs in the context itself (no fork), and not for inbox deliveries', async () => {
      const t = await setup()
      const seen: { context: string; session: string; forked: boolean }[] = []
      t.hooks.onTransform(runInput, (p) => {
        seen.push({ context: p.context.id, session: p.session.id, forked: !!p.fork })
        return { ...p, entries: [...p.entries, { kind: 'system' as const, content: { text: 'remembered' } }] }
      })
      const ev = await t.ingest({ source: 'mcp:linear', type: 'task.assigned', employeeId: 'emp_a', text: 'x' })
      const res = await t.router.route(ev.id)
      expect(res.deliveries[0]!.reason).toBe('fallback')
      expect(seen).toEqual([{ context: t.routerA.id, session: t.routerA.id, forked: false }])
      const hist = await t.sessions.runHistory((res.deliveries[0]!.outcome as { runId: string }).runId)
      expect(hist.map((e) => e.kind)).toEqual(['system', 'system', 'event'])
      // A delivery into a running continuing run's inbox doesn't start a run, so no input is added.
      const work = await t.mk('busy')
      const subject = { system: 'mp', id: 'msg_busy' }
      await t.events.subscriptions.subscribe(work.id, subject, { primary: true })
      const active = await t.sessions.createRun({ sessionId: work.id, cause: { type: 'manual' } })
      await t.sessions.transition(active.id, 'queued', 'running')
      await t.router.route((await t.ingest({ source: 'chat', type: 'message.replied', subject, text: 'hi' })).id)
      expect(seen).toHaveLength(1)
    })
  })

  it('routes a schedule.fired event to its schedule trigger only', async () => {
    const t = await setup()
    const ctx = await t.mk('weekly summary')
    const scheduled = await t.events.triggers.create({
      name: 'weekly',
      employeeId: 'emp_a',
      target: { type: 'session', sessionId: ctx.id },
      schedule: { cron: '0 9 * * 5' },
      fork: true,
    })
    // A catch-all trigger with a higher priority does not take it.
    await t.events.triggers.create({
      name: 'all',
      employeeId: 'emp_a',
      match: { source: 'schedule' },
      target: { type: 'router' },
      priority: 99,
    })
    const ev = await t.ingest({
      source: SCHEDULE_SOURCE,
      type: SCHEDULE_FIRED,
      employeeId: 'emp_a',
      subject: { system: 'mp', id: scheduled.id },
      payload: { triggerId: scheduled.id },
      text: 'Scheduled: weekly (0 9 * * 5)',
    })
    const res = await t.router.route(ev.id)
    expect(res.deliveries).toHaveLength(1)
    expect(res.deliveries[0]).toMatchObject({ reason: 'trigger', triggerId: scheduled.id, fork: true })
    const fork = await t.sessions.require(res.deliveries[0]!.outcome.sessionId)
    expect(fork.data.parent?.sessionId).toBe(ctx.id)
    expect((await t.events.triggers.get(scheduled.id))!.data.fired).toBe(1)
  })
})

describe('prepareEvent', () => {
  it('renders the prepared event (e.g. with image descriptions), leaves the stored one alone, and falls back on errors', async () => {
    let fail = false
    const t = await setup({
      prepareEvent: async (e) => {
        if (fail) throw new Error('lookup failed')
        return { ...e, data: { ...e.data, text: `${e.data.text} (prepared)` } }
      },
    })
    const work = await t.mk('work')
    await t.events.subscriptions.subscribe(work.id, { system: 'mp', id: 'msg_1' }, { primary: true })
    const ev = await t.ingest({ source: 'chat', type: 'message.replied', subject: { system: 'mp', id: 'msg_1' }, text: 'hello' })
    const res = await t.router.route(ev.id)
    const runId = (res.deliveries[0]!.outcome as any).runId
    expect((await firstEvent(t.sessions, runId)).text).toMatch(/hello \(prepared\)$/)
    expect((await t.events.require(ev.id)).data.text).toBe('hello')
    // A failing prepareEvent: rendered as stored.
    fail = true
    const other = await t.mk('other')
    const ev2 = await t.ingest({ source: 'chat', type: 'message.replied', subject: { system: 'mp', id: 'msg_2' }, text: 'again' })
    await t.events.subscriptions.subscribe(other.id, { system: 'mp', id: 'msg_2' }, { primary: true })
    const res2 = await t.router.route(ev2.id)
    const run2 = (res2.deliveries[0]!.outcome as any).runId
    expect((await firstEvent(t.sessions, run2)).text).toMatch(/\nagain$/)
  })
})
