import { ManualClock } from '@mp/core'
import { SCHEDULE_FIRED } from '@mp/events'
import type { ModelRequest } from '@mp/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEDULER_JOB_ID, SCHEDULER_QUEUE, scheduleTick } from '../src/scheduler.ts'
import { errorsIn, testApp, until, type TestApp } from './helpers.ts'
import { realBackend } from './scenarios.ts'

const DB = process.env.DATABASE_URL
const REDIS = process.env.REDIS_URL

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const clock = new ManualClock(Date.parse('2026-03-02T08:50:00Z'))
  const requests: ModelRequest[] = []
  const t = await testApp({
    overrides: { clock },
    script: (req) => {
      requests.push(req)
      return 'Weekly summary written.'
    },
  })
  apps.push(t)
  const s = t.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const context = await s.sessions.create({
    employeeId: employee.id,
    title: 'Weekly summary',
    entries: [{ kind: 'system', content: { text: 'CONTEXT: you write the weekly summary.' } }],
  })
  const trigger = await s.events.triggers.create({
    name: 'weekly summary',
    employeeId: employee.id,
    target: { type: 'session', sessionId: context.id },
    schedule: { cron: '0 9 * * *', timezone: 'Europe/Berlin' },
    fork: true,
  })
  const quiet = async () => {
    await until(async () => {
      await t.settle()
      return (await s.sessions.runs({ state: ['queued', 'running'] })).length === 0
    }, 'runs to finish')
  }
  return { t, s, clock, employee, context, trigger, requests, quiet }
}

describe('scheduler', () => {
  it('fires a schedule trigger once per slot, even with racing ticks, and the run reaches its context', async () => {
    const { t, s, clock, context, trigger, requests, quiet } = await setup()
    expect(await scheduleTick(s)).toEqual({ due: 0, fired: 0 })

    clock.set(Date.parse('2026-03-02T08:00:20Z')) // 09:00 in Berlin (CET)
    // Before the trigger existed: not due.
    expect(await scheduleTick(s)).toEqual({ due: 0, fired: 0 })

    clock.set(Date.parse('2026-03-03T08:00:20Z'))
    const ticks = await Promise.all([scheduleTick(s), scheduleTick(s), scheduleTick(s)])
    expect(ticks.reduce((n, r) => n + r.fired, 0)).toBe(1)
    await quiet()

    const fired = await s.events.query({ type: SCHEDULE_FIRED })
    expect(fired).toHaveLength(1)
    expect(fired[0]!.data).toMatchObject({
      source: 'schedule',
      employeeId: trigger.data.employeeId,
      subject: { system: 'mp', id: trigger.id },
      text: 'Scheduled: weekly summary (0 9 * * *)',
      payload: { triggerId: trigger.id, at: '2026-03-03T08:00:00.000Z' },
      routed: true,
    })
    const forks = await s.sessions.children(context.id)
    expect(forks).toHaveLength(1)
    const [run] = await s.sessions.runs({ sessionId: forks[0]!.id })
    expect(run!.data).toMatchObject({ state: 'completed', cause: { type: 'event', eventId: fired[0]!.id } })
    // The run starts from the context and sees the firing.
    const text = requests[0]!.messages.map((m) => m.content ?? '').join('\n')
    expect(text).toContain('CONTEXT: you write the weekly summary.')
    expect(text).toContain('Scheduled: weekly summary (0 9 * * *)')
    const stored = (await s.events.triggers.get(trigger.id))!
    expect(stored.data).toMatchObject({ fired: 1, lastScheduledAt: '2026-03-03T08:00:00.000Z' })

    // The same slot again: nothing. The next day: once more.
    clock.advance(60_000)
    expect(await scheduleTick(s)).toEqual({ due: 0, fired: 0 })
    clock.set(Date.parse('2026-03-04T08:01:00Z'))
    await Promise.all([scheduleTick(s), scheduleTick(s)])
    await quiet()
    expect(await s.events.query({ type: SCHEDULE_FIRED })).toHaveLength(2)
    expect(await s.sessions.children(context.id)).toHaveLength(2)
    expect(errorsIn(t.logs)).toEqual([])
  })

  it('does not replay missed firings beyond the grace period, and skips disabled triggers', async () => {
    const { s, clock, trigger, quiet } = await setup()
    clock.set(Date.parse('2026-03-05T08:10:00Z')) // 10 minutes late, grace is 5
    expect(await scheduleTick(s)).toEqual({ due: 0, fired: 0 })
    clock.set(Date.parse('2026-03-06T08:04:00Z')) // within grace
    expect(await scheduleTick(s)).toEqual({ due: 1, fired: 1 })
    await quiet()
    await s.events.triggers.update(trigger.id, { enabled: false })
    clock.set(Date.parse('2026-03-07T08:00:00Z'))
    expect(await scheduleTick(s)).toEqual({ due: 0, fired: 0 })
    expect(await s.events.query({ type: SCHEDULE_FIRED })).toHaveLength(1)
  })

  it('drops a firing whose trigger was disabled before it was routed, instead of falling back to the router', async () => {
    const { s, clock, trigger, requests, quiet } = await setup()
    clock.set(Date.parse('2026-03-03T08:00:00Z'))
    const due = await s.rawEvents.triggers.dueSchedules()
    expect(due).toHaveLength(1)
    await s.events.triggers.update(trigger.id, { enabled: false })
    const { event } = await s.events.ingest({
      source: 'schedule',
      type: SCHEDULE_FIRED,
      dedupeKey: `schedule:${trigger.id}:${due[0]!.at}`,
      employeeId: trigger.data.employeeId,
      payload: { triggerId: trigger.id },
      text: 'late',
    })
    await quiet()
    const routed = (await s.events.get(event.id))!
    expect(routed.data.routed).toBe(true)
    expect((routed.data.routing as any).deliveries).toMatchObject([{ reason: 'fallback', outcome: { type: 'skipped' } }])
    expect(requests).toHaveLength(0)
  })

  it('runs as a repeatable queue job', async () => {
    const { t, s, clock, context, quiet } = await setup()
    clock.set(Date.parse('2026-03-03T08:00:05Z'))
    // A second registration of the repeatable is a no-op.
    expect(await s.queue.add(SCHEDULER_QUEUE, {}, { jobId: SCHEDULER_JOB_ID, repeatEveryMs: 20 })).toBe(SCHEDULER_JOB_ID)
    await s.queue.removeRepeatable(SCHEDULER_QUEUE, SCHEDULER_JOB_ID)
    await s.queue.add(SCHEDULER_QUEUE, {}, { jobId: SCHEDULER_JOB_ID, repeatEveryMs: 20 })
    await until(async () => (await s.events.query({ type: SCHEDULE_FIRED })).length === 1, 'the scheduled event')
    await quiet()
    expect(await s.sessions.children(context.id)).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 80)) // a few more ticks: still once
    expect(await s.events.query({ type: SCHEDULE_FIRED })).toHaveLength(1)
    expect(errorsIn(t.logs)).toEqual([])
  })
})

describe.skipIf(!DB || !REDIS)('scheduler on Postgres and BullMQ', () => {
  it('two app instances on one database fire a slot once', async () => {
    const backend = await realBackend(DB!, REDIS!).make()
    const clock = new ManualClock(Date.parse('2026-03-02T08:50:00Z'))
    try {
      const one = await testApp({ env: backend.env, overrides: { clock }, script: () => 'ok' })
      apps.push(one)
      const two = await testApp({ env: { ...backend.env, MP_BOOTSTRAP: '0' }, overrides: { clock }, script: () => 'ok' })
      apps.push(two)
      const s1 = one.a.services
      const employee = (await s1.directory.employees.byHandle('meatless'))!
      const context = await s1.sessions.create({ employeeId: employee.id, title: 'Daily' })
      await s1.events.triggers.create({
        name: 'daily',
        employeeId: employee.id,
        target: { type: 'session', sessionId: context.id },
        schedule: { cron: '0 9 * * *' },
        fork: true,
      })
      clock.set(Date.parse('2026-03-03T09:00:01Z'))
      const ticks = await Promise.all([
        scheduleTick(s1),
        scheduleTick(two.a.services),
        scheduleTick(s1),
        scheduleTick(two.a.services),
      ])
      expect(ticks.reduce((n, r) => n + r.fired, 0)).toBe(1)
      await until(async () => (await s1.sessions.children(context.id)).length === 1, 'the fork')
      await until(async () => (await s1.events.query({ type: SCHEDULE_FIRED, routed: true })).length === 1, 'routing')
      expect(await s1.events.query({ type: SCHEDULE_FIRED })).toHaveLength(1)
    } finally {
      for (const t of apps.splice(0)) await t.close()
      await backend.cleanup()
    }
  })
})
