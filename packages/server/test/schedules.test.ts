import { ManualClock } from '@mp/core'
import { SCHEDULED_TASK_FIRED } from '@mp/events'
import type { ModelRequest } from '@mp/model'
import { afterEach, describe, expect, it } from 'vitest'
import { scheduleTick } from '../src/scheduler.ts'
import { errorsIn, testApp, until, type TestApp } from './helpers.ts'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

const SYSTEM = { type: 'system' as const, id: 'test' }
const textOf = (req: ModelRequest) =>
  req.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n')

async function setup(reply: (req: ModelRequest) => string = () => 'Invoice reminder sent.') {
  // Tuesday 2026-09-29 09:00 UTC.
  const clock = new ManualClock(Date.parse('2026-09-29T09:00:00Z'))
  const requests: ModelRequest[] = []
  const t = await testApp({
    overrides: { clock },
    script: (req) => {
      requests.push(req)
      return reply(req)
    },
  })
  apps.push(t)
  const s = t.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const ana = await s.directory.contacts.create({ name: 'Ana Lima', kind: 'person', handles: [{ system: 'mp', id: 'ana' }] })
  const quiet = async () => {
    await until(async () => {
      await t.settle()
      return (await s.sessions.runs({ state: ['queued', 'running'] })).length === 0
    }, 'runs to finish')
  }
  const fire = async (at: number) => {
    clock.set(at)
    const r = await scheduleTick(s)
    await quiet()
    return r
  }
  return { t, s, clock, employee, ana, requests, quiet, fire }
}

describe('scheduled tasks fire', () => {
  it('a one-off starts a run in its session with the instruction, reports in its thread, records the result and is done', async () => {
    const { t, s, employee, ana, requests, fire } = await setup()
    const ch = await s.chat.createChannel({ name: 'finance', createdBy: { kind: 'contact', id: ana.id } })
    const root = await s.chat.post({ channelId: ch.id, author: { kind: 'contact', id: ana.id }, text: 'invoices' })
    const task = await s.schedules!.create(
      {
        employeeId: employee.id,
        instruction: 'Remind Ana to send the ACME invoice',
        when: { type: 'once', at: '2026-09-29T11:00:00.000Z' },
        timezone: 'Europe/Belgrade',
        requesterId: ana.id,
        report: { type: 'chat', channelId: ch.id, threadId: root.id, label: 'thread in #finance' },
      },
      SYSTEM,
    )
    expect(await fire(Date.parse('2026-09-29T10:59:00Z'))).toEqual({ due: 0, fired: 0 })
    // Racing ticks, as with two instances: one firing.
    const ticks = await Promise.all([scheduleTick(s), scheduleTick(s), scheduleTick(s)].map(async (p) => p))
    expect(ticks.reduce((n, r) => n + r.fired, 0)).toBe(0)
    const r = await fire(Date.parse('2026-09-29T11:00:20Z'))
    expect(r).toEqual({ due: 1, fired: 1 })
    expect((await Promise.all([scheduleTick(s), scheduleTick(s)])).reduce((n, x) => n + x.fired, 0)).toBe(0)

    const fired = await s.events.query({ type: SCHEDULED_TASK_FIRED })
    expect(fired).toHaveLength(1)
    const runs = await s.sessions.runs({ sessionId: task.data.sessionId! })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.data).toMatchObject({
      state: 'completed',
      mode: 'continuing',
      requesterId: ana.id,
      cause: { type: 'event', eventId: fired[0]!.id },
    })
    const prompt = textOf(requests.at(-1)!)
    expect(prompt).toContain('Remind Ana to send the ACME invoice')
    expect(prompt).toContain('asked for by Ana Lima')
    expect(prompt).toContain(`chat thread ${root.id} (thread in #finance) with chat.reply`)
    // Trusted: a person set it up.
    expect(prompt).not.toMatch(/untrusted/i)

    // The final answer went to the report thread, and the task's session follows it.
    const thread = await s.chat.thread(root.id)
    expect(thread.map((m) => m.data.text)).toContain('Invoice reminder sent.')
    const after = await s.scheduledTasks.require(task.id)
    expect(after.data).toMatchObject({
      enabled: false,
      done: true,
      fired: 1,
      lastRun: { eventId: fired[0]!.id, runId: runs[0]!.id, state: 'completed', output: 'Invoice reminder sent.' },
    })
    // Later ticks: nothing more.
    expect(await fire(Date.parse('2026-09-29T13:00:00Z'))).toEqual({ due: 0, fired: 0 })
    expect(errorsIn(t.logs)).toEqual([])
  })

  it('a recurring task continues its session, so each run sees the earlier ones; fresh mode forks each time', async () => {
    let n = 0
    const { s, employee, ana, requests, fire } = await setup(() => `Summary #${++n}`)
    const task = await s.schedules!.create(
      {
        employeeId: employee.id,
        instruction: 'Write the daily summary',
        when: { type: 'cron', cron: '0 9 * * *' },
        timezone: 'Europe/Belgrade',
        requesterId: ana.id,
      },
      SYSTEM,
    )
    await fire(Date.parse('2026-09-30T07:00:10Z'))
    await fire(Date.parse('2026-10-01T07:00:10Z'))
    const runs = await s.sessions.runs({ sessionId: task.data.sessionId! })
    expect(runs.map((r) => r.data.state)).toEqual(['completed', 'completed'])
    expect(textOf(requests.at(-1)!)).toContain('Summary #1')
    const rec = await s.scheduledTasks.require(task.id)
    expect(rec.data).toMatchObject({ enabled: true, fired: 2, lastRun: { state: 'completed', output: 'Summary #2' } })
    expect(s.scheduledTasks.nextRun(rec)).toBe('2026-10-02T07:00:00.000Z')

    const fresh = await s.schedules!.create(
      {
        employeeId: employee.id,
        instruction: 'Check the error budget',
        when: { type: 'cron', cron: '0 12 * * *' },
        timezone: 'UTC',
        sessionMode: 'fresh',
      },
      SYSTEM,
    )
    await fire(Date.parse('2026-10-01T12:00:10Z'))
    await fire(Date.parse('2026-10-02T12:00:10Z'))
    const forks = await s.sessions.children(fresh.data.sessionId!)
    expect(forks).toHaveLength(2)
    expect(forks.map((f) => f.data.title).sort()).toEqual(
      ['Check the error budget · Thu 2026-10-01', 'Check the error budget · Fri 2026-10-02'].sort(),
    )
    // The task's own session stays clean.
    expect(await s.sessions.runs({ sessionId: fresh.data.sessionId! })).toHaveLength(0)
    // A fresh fork doesn't see the earlier firing: the instruction is in its context once.
    expect(textOf(requests.at(-1)!).split('Check the error budget\n\n(Scheduled task').length).toBe(2)
  })

  it('a one-off missed while the harness was down is marked missed, not run late; a deleted task fires nowhere', async () => {
    const { s, employee, requests, fire, quiet } = await setup()
    const task = await s.schedules!.create(
      {
        employeeId: employee.id,
        instruction: 'x',
        when: { type: 'once', at: '2026-09-29T10:00:00.000Z' },
        timezone: 'UTC',
        graceSeconds: 600,
      },
      SYSTEM,
    )
    expect(await fire(Date.parse('2026-09-29T10:30:00Z'))).toEqual({ due: 1, fired: 0 })
    expect((await s.scheduledTasks.require(task.id)).data).toMatchObject({ done: true, lastRun: { state: 'missed' } })
    expect(await s.events.query({ type: SCHEDULED_TASK_FIRED })).toHaveLength(0)

    // Deleted between firing and routing: dropped, never sent to the router.
    const gone = await s.schedules!.create(
      { employeeId: employee.id, instruction: 'y', when: { type: 'cron', cron: '0 * * * *' }, timezone: 'UTC' },
      SYSTEM,
    )
    const { scheduledTaskEvent } = await import('@mp/events')
    const input = scheduledTaskEvent(gone, '2026-09-29T11:00:00.000Z')
    await s.scheduledTasks.remove(gone.id)
    const { event } = await s.events.ingest(input)
    await quiet()
    const routed = (await s.events.get(event.id))!
    expect(routed.data.routed).toBe(true)
    expect(
      (routed.data.routing as { deliveries: { outcome: { type: string } }[] }).deliveries.every(
        (d) => d.outcome.type === 'skipped',
      ),
    ).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it('run now starts a run at once and keeps the schedule', async () => {
    const { s, employee, quiet } = await setup()
    const task = await s.schedules!.create(
      { employeeId: employee.id, instruction: 'Weekly numbers', when: { type: 'cron', cron: '0 16 * * 5' }, timezone: 'UTC' },
      SYSTEM,
    )
    const r = await s.schedules!.runNow(task.id, { key: 'k1', byName: 'Ana' })
    const again = await s.schedules!.runNow(task.id, { key: 'k1', byName: 'Ana' })
    expect(again.eventId).toBe(r.eventId)
    await quiet()
    const runs = await s.sessions.runs({ sessionId: task.data.sessionId! })
    expect(runs).toHaveLength(1)
    const rec = await s.scheduledTasks.require(task.id)
    expect(rec.data).toMatchObject({ enabled: true, fired: 1, lastRun: { manual: true, state: 'completed' } })
    expect(s.scheduledTasks.nextRun(rec)).toBe('2026-10-02T16:00:00.000Z')
  })
})

describe('follow-ups', () => {
  it('wake the session later with the note, after its run has finished', async () => {
    const { s, employee, ana, requests, fire, quiet } = await setup((req) =>
      textOf(req).includes('Follow-up you left') ? 'CI is green, nothing to do.' : 'Opened the MR; I will check CI later.',
    )
    const session = await s.sessions.create({
      employeeId: employee.id,
      title: 'MR !42',
      entries: [{ kind: 'system', content: { text: 'You are Meatless.' } }],
    })
    const first = await s.sessions.createRun({
      sessionId: session.id,
      cause: { type: 'manual' },
      requesterId: ana.id,
      input: [{ kind: 'user', content: { text: 'open the MR' } }],
    })
    await s.runner.enqueue(first.id)
    await quiet()
    expect((await s.sessions.requireRun(first.id)).data.state).toBe('completed')

    const f = await s.schedules!.followUp(
      {
        employeeId: employee.id,
        sessionId: session.id,
        note: 'check CI on !42',
        when: { type: 'once', at: '2026-09-29T11:00:00.000Z' },
        timezone: 'UTC',
        requesterId: ana.id,
      },
      SYSTEM,
    )
    // Nothing is held open meanwhile.
    expect(await s.sessions.runs({ sessionId: session.id, state: ['queued', 'running', 'suspended'] })).toHaveLength(0)
    await fire(Date.parse('2026-09-29T11:00:05Z'))
    const runs = await s.sessions.runs({ sessionId: session.id })
    expect(runs).toHaveLength(2)
    expect(runs[1]!.data).toMatchObject({ state: 'completed', mode: 'continuing' })
    const prompt = textOf(requests.at(-1)!)
    expect(prompt).toContain('check CI on !42')
    expect(prompt).toMatch(/still needed/)
    // It continues the session: the earlier work is in its context.
    expect(prompt).toContain('Opened the MR; I will check CI later.')
    expect((await s.scheduledTasks.require(f.id)).data).toMatchObject({
      done: true,
      lastRun: { state: 'completed', output: 'CI is green, nothing to do.' },
    })
  })

  it('arrive in a run that is waiting for a delivery, and wake it', async () => {
    const { s, employee, fire, quiet } = await setup()
    const session = await s.sessions.create({ employeeId: employee.id, title: 'Waiting' })
    const run = await s.sessions.createRun({ sessionId: session.id, cause: { type: 'manual' } })
    await s.sessions.transition(run.id, 'queued', 'running')
    await s.sessions.transition(run.id, 'running', 'suspended', { wait: { type: 'delivery' } })
    await s.schedules!.followUp(
      {
        employeeId: employee.id,
        sessionId: session.id,
        note: 'poke the reviewer',
        when: { type: 'once', at: '2026-09-29T10:00:00.000Z' },
        timezone: 'UTC',
      },
      SYSTEM,
    )
    await fire(Date.parse('2026-09-29T10:00:05Z'))
    await quiet()
    const fired = await s.events.query({ type: SCHEDULED_TASK_FIRED })
    expect(
      (fired[0]!.data.routing as { deliveries: { outcome: { type: string; runId?: string } }[] }).deliveries[0]!.outcome,
    ).toMatchObject({
      type: 'woke',
      runId: run.id,
    })
  })
})

describe('schedules API', () => {
  it('lists, creates, previews, and only admins and the requester run, pause, edit or delete', async () => {
    const { t, s, employee, quiet } = await setup()
    const ana = await s.directory.contacts.create({ name: 'Ana Member', kind: 'person' })
    const bo = await s.directory.contacts.create({ name: 'Bo Member', kind: 'person' })
    const vi = await s.directory.contacts.create({ name: 'Vi Viewer', kind: 'person' })
    const asAna = await t.as(ana.id)
    const asBo = await t.as(bo.id)
    const asVi = await t.as(vi.id, { access: 'viewer' })

    const preview = await t.req(
      'GET',
      '/api/schedules/preview?every=weekday%20at%2009:00&timezone=Europe/Belgrade',
      undefined,
      asVi,
    )
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ description: 'every weekday 09:00 Europe/Belgrade', timezone: 'Europe/Belgrade' })
    expect(preview.body.next.slice(0, 3)).toEqual([
      '2026-09-30T07:00:00.000Z',
      '2026-10-01T07:00:00.000Z',
      '2026-10-02T07:00:00.000Z',
    ])
    expect((await t.req('GET', '/api/schedules/preview?cron=nope')).status).toBe(422)
    expect((await t.req('GET', '/api/schedules/preview?every=day&cron=0%209%20*%20*%20*')).status).toBe(422)

    const body = {
      employeeId: employee.id,
      instruction: 'Post the weekly numbers',
      when: { every: 'friday at 16:00' },
      timezone: 'UTC',
    }
    expect((await t.req('POST', '/api/schedules', body, asVi)).status).toBe(403)
    expect((await t.req('POST', '/api/schedules', body, { authorization: '' })).status).toBe(401)
    expect((await t.req('POST', '/api/schedules', { ...body, when: { at: '2020-01-01 10:00' } }, asAna)).status).toBe(422)
    expect((await t.req('POST', '/api/schedules', { ...body, employeeId: 'emp_nope' }, asAna)).status).toBe(404)
    expect((await t.req('POST', '/api/schedules', { ...body, instruction: '' }, asAna)).status).toBe(400)
    const created = await t.req('POST', '/api/schedules', body, asAna)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      kind: 'task',
      description: 'every Friday 16:00 UTC',
      nextRunAt: '2026-10-02T16:00:00.000Z',
      requester: { id: ana.id, name: 'Ana Member' },
      employee: { id: employee.id },
      canManage: true,
      enabled: true,
    })
    const id = created.body.id as string
    expect(created.body.session.title).toBe('Scheduled: Post the weekly numbers')

    // Everyone signed in sees it; only admins and Ana may manage it.
    const listed = await t.req('GET', '/api/schedules', undefined, asBo)
    expect(listed.body.items.map((x: { id: string; canManage: boolean }) => [x.id, x.canManage])).toEqual([[id, false]])
    expect((await t.req('GET', '/api/schedules')).body.items[0].canManage).toBe(true)
    expect((await t.req('GET', '/api/schedules', undefined, asVi)).body.items[0].canManage).toBe(false)
    for (const [method, path, b] of [
      ['PATCH', `/api/schedules/${id}`, { enabled: false }],
      ['POST', `/api/schedules/${id}/run`, {}],
      ['DELETE', `/api/schedules/${id}`, undefined],
    ] as const) {
      expect((await t.req(method, path, b, asBo)).status, `${method} ${path} as another member`).toBe(403)
      expect((await t.req(method, path, b, asVi)).status, `${method} ${path} as a viewer`).toBe(403)
    }
    const paused = await t.req('PATCH', `/api/schedules/${id}`, { enabled: false }, asAna)
    expect(paused.body).toMatchObject({ enabled: false, nextRunAt: null })
    const edited = await t.req('PATCH', `/api/schedules/${id}`, {
      enabled: true,
      when: { cron: '30 8 * * 1' },
      instruction: 'Monday numbers',
    })
    expect(edited.body).toMatchObject({ enabled: true, description: 'every Monday 08:30 UTC', instruction: 'Monday numbers' })
    expect((await t.req('PATCH', `/api/schedules/${id}`, {}, asAna)).status).toBe(422)
    const ran = await t.req('POST', `/api/schedules/${id}/run`, {}, asAna)
    expect(ran.status).toBe(200)
    expect(ran.body.task.fired).toBe(1)
    await quiet()
    const done = (await t.req('GET', '/api/schedules')).body.items[0]
    expect(done.lastRun).toMatchObject({ state: 'completed', manual: true })
    expect(done.lastRun.runId).toMatch(/^run_/)

    expect((await t.req('DELETE', `/api/schedules/${id}`, undefined, asAna)).status).toBe(204)
    expect((await t.req('DELETE', `/api/schedules/${id}`, undefined, asAna)).status).toBe(404)
    expect((await t.req('GET', '/api/schedules')).body.items).toEqual([])
    expect(errorsIn(t.logs)).toEqual([])
  })

  it('shows follow-ups, and a follow-up is not run now', async () => {
    const { t, s, employee } = await setup()
    const session = await s.sessions.create({ employeeId: employee.id, title: 'MR' })
    const f = await s.schedules!.followUp(
      {
        employeeId: employee.id,
        sessionId: session.id,
        note: 'check CI',
        when: { type: 'once', at: '2026-09-29T11:00:00.000Z' },
        timezone: 'UTC',
      },
      SYSTEM,
    )
    const listed = await t.req('GET', `/api/schedules?sessionId=${session.id}`)
    expect(listed.body.items).toMatchObject([
      {
        id: f.id,
        kind: 'follow_up',
        instruction: 'check CI',
        session: { id: session.id },
        nextRunAt: '2026-09-29T11:00:00.000Z',
      },
    ])
    expect((await t.req('GET', '/api/schedules?kind=weird')).status).toBe(400)
    expect((await t.req('POST', `/api/schedules/${f.id}/run`, {})).status).toBe(422)
    // Moved by an admin.
    const moved = await t.req('PATCH', `/api/schedules/${f.id}`, { when: { in: '3 hours' } })
    expect(moved.body.nextRunAt).toBe('2026-09-29T12:00:00.000Z')
    expect((await t.req('PATCH', `/api/schedules/${f.id}`, { when: { every: 'day' } })).status).toBe(422)
  })
})
