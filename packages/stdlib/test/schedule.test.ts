import { globMatch } from '@mp/core'
import { SCHEDULED_TASK_FIRED } from '@mp/events'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSET, ROUTER_EXCLUDED_TOOLS, scheduleService } from '../src/index.ts'
import { stack } from './helpers.ts'

const errorOf = (r: { isError?: boolean; output: unknown }) => {
  expect(r.isError, JSON.stringify(r.output)).toBe(true)
  return (r.output as { error: string }).error
}

describe('schedule.create', () => {
  it('schedules a one-off in a while, with its own session for the employee and the requester', async () => {
    const t = await stack()
    const out = await t.out('schedule.create', { instruction: 'Remind Ana to send the invoice', in: '2 hours' })
    expect(out).toMatchObject({
      kind: 'task',
      enabled: true,
      nextRun: '2026-09-29T11:00:00.000Z',
      nextRunLocal: 'Tue 2026-09-29 11:00 UTC',
      schedule: 'once, Tue 2026-09-29 11:00 UTC',
      requesterId: t.ana.id,
    })
    const task = await scheduleService(t.deps).tasks.require(out.id)
    expect(task.data).toMatchObject({ employeeId: t.employee.id, sessionMode: 'continue', timezone: 'UTC', graceSeconds: 3600 })
    const s = await t.sessions.require(task.data.sessionId!)
    expect(s.data).toMatchObject({ employeeId: t.employee.id, title: 'Scheduled: Remind Ana to send the invoice' })
    expect(s.data.meta?.scheduledTaskId).toBe(task.id)
    expect(s.data.toolset).toEqual([...DEFAULT_TOOLSET])
    const [first] = await t.sessions.history(s.id)
    expect(first!.kind).toBe('system')
    expect(String((first!.content as { text: string }).text)).toContain('You are Billing Bot')
    const links = await t.records.links({ from: { kind: 'session', id: s.id } })
    expect(links.map((l) => [l.role, l.to.id])).toContainEqual(['requested_by', t.ana.id])
    // A retry of the same call doesn't schedule twice.
    const c = t.ctx({ callId: 'call_same' })
    const a = await t.out('schedule.create', { instruction: 'x', in: '1 hour' }, c)
    const b = await t.out('schedule.create', { instruction: 'x', in: '1 hour' }, c)
    expect(a.id).toBe(b.id)
  })

  it('reads times in the company time zone unless told otherwise, and recurring schedules in words or cron', async () => {
    const t = await stack()
    t.deps.defaultTimezone = async () => 'Europe/Belgrade'
    const fri = await t.out('schedule.create', { instruction: 'Weekly summary', at: 'friday 16:00' })
    expect(fri).toMatchObject({ nextRun: '2026-10-02T14:00:00.000Z', schedule: 'once, Fri 2026-10-02 16:00 Europe/Belgrade' })
    const ny = await t.out('schedule.create', { instruction: 'x', at: '2026-10-02 16:00', timezone: 'America/New_York' })
    expect(ny.nextRun).toBe('2026-10-02T20:00:00.000Z')
    const daily = await t.out('schedule.create', { instruction: 'Triage', every: 'weekday at 09:00', session: 'fresh' })
    expect(daily).toMatchObject({ schedule: 'every weekday 09:00 Europe/Belgrade', nextRun: '2026-09-30T07:00:00.000Z' })
    expect((await scheduleService(t.deps).tasks.require(daily.id)).data.sessionMode).toBe('fresh')
    const cron = await t.out('schedule.create', { instruction: 'x', cron: '30 8 1 * *' })
    expect(cron.schedule).toBe('every month on the 1st 08:30 Europe/Belgrade')
  })

  it('refuses bad input with a reason the model can act on', async () => {
    const t = await stack()
    const cases: [unknown, RegExp][] = [
      [{ in: '2 hours' }, /instruction is required/],
      [{ instruction: '  ', in: '2 hours' }, /instruction is required/],
      [{ instruction: 'x' }, /say when/],
      [{ instruction: 'x', in: '2 hours', every: 'day' }, /only one of at, in, every or cron \(got in and every\)/],
      [{ instruction: 'x', in: 'a while' }, /unknown unit "while"/],
      [{ instruction: 'x', in: 'later' }, /can't read "later" as a delay/],
      [{ instruction: 'x', at: 'yesterday 10:00' }, /can't read/],
      [{ instruction: 'x', at: '2026-09-29 08:00' }, /already passed/],
      [{ instruction: 'x', every: 'blue moon' }, /can't read "blue moon" as a schedule/],
      [{ instruction: 'x', cron: '99 * * * *' }, /schedule.cron/],
      [{ instruction: 'x', in: '1 hour', timezone: 'Mars/Olympus' }, /unknown time zone/],
      [{ instruction: 'x', in: '1 hour', report: { threadId: 'msg_nope' } }, /not found/],
      [{ instruction: 'x', in: '1 hour', report: { channel: 'nowhere' } }, /not found/],
      [{ instruction: 'x', in: '1 hour', report: 42 }, /report must be/],
      [{ instruction: 'x', in: '1 hour', session: 'sometimes' }, /sessionMode/],
    ]
    for (const [args, re] of cases) expect(errorOf(await t.call('schedule.create', args)), JSON.stringify(args)).toMatch(re)
    expect(await scheduleService(t.deps).tasks.list()).toEqual([])
  })

  it('reports here by default: the thread this session owns; or where it is told, or nowhere', async () => {
    const t = await stack()
    const ch = await t.chat.createChannel({ name: 'finance', createdBy: { kind: 'contact', id: t.ana.id } })
    const root = await t.chat.post({ channelId: ch.id, author: { kind: 'contact', id: t.ana.id }, text: 'remind me friday' })
    await t.events.subscriptions.subscribe(t.session.id, { system: 'mp', id: root.id }, { primary: true })
    const here = await t.out('schedule.create', { instruction: 'Remind Ana', in: '1 hour' })
    expect(here.report).toBe('thread in #finance')
    const svc = scheduleService(t.deps)
    const task = await svc.tasks.require(here.id)
    expect(task.data.report).toEqual({ type: 'chat', channelId: ch.id, threadId: root.id, label: 'thread in #finance' })
    // The task's session follows that thread too, as context (this session owns it).
    const subs = await t.events.subscriptions.forSubject({ system: 'mp', id: root.id })
    expect(subs.map((x) => [x.data.sessionId, x.data.primary])).toContainEqual([task.data.sessionId, false])

    const channel = await t.out('schedule.create', { instruction: 'x', in: '1 hour', report: { channel: '#finance' } })
    expect(channel.report).toBe('#finance')
    const slack = await t.out('schedule.create', {
      instruction: 'x',
      in: '1 hour',
      report: { subject: { system: 'slack', id: 'C1/1700.1' } },
    })
    expect(slack.report).toBe('slack:C1/1700.1')
    const none = await t.out('schedule.create', { instruction: 'x', in: '1 hour', report: 'none' })
    expect(none.report).toBeUndefined()
  })
})

describe('schedule.list, update, cancel and run_now', () => {
  it('lists, changes, pauses, runs now and cancels, only the employee’s own', async () => {
    const t = await stack()
    const svc = scheduleService(t.deps)
    const a = await t.out('schedule.create', { instruction: 'Weekly numbers', every: 'friday at 16:00' })
    const b = await t.out('schedule.create', { instruction: 'Ping', in: '30 minutes' })
    expect((await t.out('schedule.list')).items.map((x: { id: string }) => x.id).sort()).toEqual([a.id, b.id].sort())

    const moved = await t.out('schedule.update', { id: a.id, every: 'monday at 9am', instruction: 'Monday numbers' })
    expect(moved).toMatchObject({ schedule: 'every Monday 09:00 UTC', instruction: 'Monday numbers' })
    const paused = await t.out('schedule.update', { id: a.id, enabled: false })
    expect(paused.enabled).toBe(false)
    expect(paused.nextRun).toBeUndefined()
    expect(errorOf(await t.call('schedule.update', { id: a.id }))).toMatch(/nothing to change/)
    expect(errorOf(await t.call('schedule.update', { id: a.id, in: '1 hour', at: 'friday 10:00' }))).toMatch(/only one/)

    const now = await t.out('schedule.run_now', { id: a.id })
    const fired = await t.events.query({ type: SCHEDULED_TASK_FIRED })
    expect(fired).toHaveLength(1)
    expect(fired[0]!.data).toMatchObject({
      source: 'schedule',
      employeeId: t.employee.id,
      actorContactId: t.ana.id,
      payload: { taskId: a.id, manual: true },
    })
    expect(now).toMatchObject({ eventId: fired[0]!.id, fired: 1, lastRun: { manual: true, state: 'queued' } })

    // Another employee's task is not found, and so is a made-up id.
    const other = await t.directory.employees.create({ name: 'Other Bot' })
    const theirs = await svc.create(
      { employeeId: other.id, instruction: 'theirs', when: { type: 'once', at: '2026-09-30T09:00:00Z' }, timezone: 'UTC' },
      { type: 'system', id: 'test' },
    )
    for (const tool of ['schedule.update', 'schedule.cancel', 'schedule.run_now'])
      expect(errorOf(await t.call(tool, { id: theirs.id, enabled: false })), tool).toMatch(/not found/)
    expect(errorOf(await t.call('schedule.cancel', { id: 'tsk_nope' }))).toMatch(/not found/)
    expect(errorOf(await t.call('schedule.cancel', {}))).toMatch(/id is required/)

    const sessionId = (await svc.tasks.require(a.id)).data.sessionId!
    expect(await t.out('schedule.cancel', { id: a.id })).toMatchObject({ cancelled: a.id })
    expect(await svc.tasks.get(a.id)).toBeNull()
    expect((await t.sessions.require(sessionId)).data.status).toBe('done')
    expect((await t.out('schedule.list')).items.map((x: { id: string }) => x.id)).toEqual([b.id])
  })
})

describe('sessions.follow_up', () => {
  it('leaves a note for this session, once, and refuses schedules', async () => {
    const t = await stack()
    const out = await t.out('sessions.follow_up', { note: 'check CI on !42', in: '2 hours' })
    expect(out).toMatchObject({ at: '2026-09-29T11:00:00.000Z', note: 'check CI on !42' })
    const f = await scheduleService(t.deps).tasks.require(out.followUpId)
    expect(f.data).toMatchObject({ kind: 'follow_up', sessionId: t.session.id, sessionMode: 'continue', requesterId: t.ana.id })
    const listed = await t.out('schedule.list', { kind: 'follow_up' })
    expect(listed.items.map((x: { id: string }) => x.id)).toEqual([f.id])
    expect(errorOf(await t.call('sessions.follow_up', { in: '2 hours' }))).toMatch(/note is required/)
    expect(errorOf(await t.call('sessions.follow_up', { note: 'x', every: 'day' }))).toMatch(/happens once/)
    expect(errorOf(await t.call('sessions.follow_up', { note: 'x' }))).toMatch(/say when/)
    expect(errorOf(await t.call('schedule.run_now', { id: f.id }))).toMatch(/comes back to its session/)
  })
})

describe('schedule tools and the router', () => {
  it('are in the default toolset; a router can look but hands scheduling to the session it starts', () => {
    for (const n of [
      'schedule.create',
      'schedule.list',
      'schedule.update',
      'schedule.cancel',
      'schedule.run_now',
      'sessions.follow_up',
    ])
      expect(DEFAULT_TOOLSET).toContain(n)
    const excluded = (n: string) => ROUTER_EXCLUDED_TOOLS.some((p) => globMatch(p, n))
    expect(excluded('schedule.list')).toBe(false)
    for (const n of ['schedule.create', 'schedule.update', 'schedule.cancel', 'schedule.run_now', 'sessions.follow_up'])
      expect(excluded(n), n).toBe(true)
  })
})
