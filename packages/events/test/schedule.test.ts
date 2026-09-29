import { ManualClock, ValidationError } from '@mp/core'
import { createRecords } from '@mp/records'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SCHEDULE_FIRED,
  SCHEDULE_SOURCE,
  checkSchedule,
  createEvents,
  dueFiring,
  latestFiring,
  nextFirings,
  scheduleDedupeKey,
  scheduledTriggerId,
  type Events,
  type Trigger,
} from '../src/index.ts'

const EMP = 'emp_01J00000000000000000000001'
const EMP2 = 'emp_01J00000000000000000000002'
const SES = 'ses_01J00000000000000000000001'
const iso = (d: Date | null) => d?.toISOString() ?? null
const isos = (ds: Date[]) => ds.map((d) => d.toISOString())
const MIN = 60_000

describe('schedule helpers', () => {
  it('validates cron expressions', () => {
    expect(checkSchedule({ cron: '0 9 * * 1-5' })).toEqual({ cron: '0 9 * * 1-5', timezone: 'UTC', graceSeconds: 300 })
    expect(checkSchedule({ cron: '  */5   * * * * ' }).cron).toBe('*/5 * * * *')
    expect(checkSchedule({ cron: '@daily', timezone: 'Europe/Berlin', graceSeconds: 0 })).toEqual({
      cron: '@daily',
      timezone: 'Europe/Berlin',
      graceSeconds: 0,
    })
    expect(checkSchedule({ cron: '*/10 * * * * *' }).cron).toBe('*/10 * * * * *')
    for (const bad of [
      { cron: '' },
      { cron: '   ' },
      { cron: 'bogus' },
      { cron: '61 * * * *' },
      { cron: '0 9 * * * * *' },
      { cron: '0 0 30 2 *' },
      { cron: 5 },
      {},
      null,
      'daily',
      [],
    ])
      expect(() => checkSchedule(bad), JSON.stringify(bad)).toThrow(ValidationError)
  })

  it('validates time zones and grace periods', () => {
    expect(checkSchedule({ cron: '0 9 * * *', timezone: 'Asia/Kathmandu' }).timezone).toBe('Asia/Kathmandu')
    for (const timezone of ['Nope/Zone', '', 'Mars/Olympus', 42])
      expect(() => checkSchedule({ cron: '0 9 * * *', timezone: timezone as string })).toThrow(ValidationError)
    for (const graceSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5'])
      expect(() => checkSchedule({ cron: '0 9 * * *', graceSeconds: graceSeconds as number })).toThrow(ValidationError)
  })

  it('lists firings in (from, until], in UTC by default', () => {
    const s = { cron: '0 9 * * *' }
    expect(isos(nextFirings(s, '2026-01-01T09:00:00Z', '2026-01-03T09:00:00Z'))).toEqual([
      '2026-01-02T09:00:00.000Z',
      '2026-01-03T09:00:00.000Z',
    ])
    expect(nextFirings(s, '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toEqual([])
    expect(nextFirings({ cron: '* * * * *' }, 0, 10 * MIN, 3)).toHaveLength(3)
    // Weekdays only.
    expect(isos(nextFirings({ cron: '0 9 * * 1-5' }, '2026-01-02T10:00:00Z', '2026-01-06T10:00:00Z'))).toEqual([
      '2026-01-05T09:00:00.000Z',
      '2026-01-06T09:00:00.000Z',
    ])
  })

  it('reads the expression in the time zone', () => {
    const berlin = { cron: '0 9 * * *', timezone: 'Europe/Berlin' }
    expect(iso(latestFiring(berlin, '2026-01-15T12:00:00Z'))).toBe('2026-01-15T08:00:00.000Z') // CET
    expect(iso(latestFiring(berlin, '2026-07-15T12:00:00Z'))).toBe('2026-07-15T07:00:00.000Z') // CEST
    expect(iso(latestFiring({ cron: '0 9 * * *', timezone: 'Asia/Kathmandu' }, '2026-01-01T04:00:00Z'))).toBe(
      '2026-01-01T03:15:00.000Z',
    )
    expect(iso(latestFiring({ cron: '0 9 * * *' }, '2026-01-01T09:00:00Z'))).toBe('2026-01-01T09:00:00.000Z')
    expect(iso(latestFiring({ cron: '0 9 * * *' }, '2026-01-01T08:59:59Z'))).toBe('2025-12-31T09:00:00.000Z')
  })

  it('handles DST: a skipped wall-clock time fires once, later; a repeated one fires once', () => {
    const s = { cron: '30 2 * * *', timezone: 'Europe/Berlin' }
    // 2026-03-29: 02:00 CET jumps to 03:00 CEST, so 02:30 doesn't exist.
    expect(isos(nextFirings(s, '2026-03-28T12:00:00Z', '2026-03-30T12:00:00Z'))).toEqual([
      '2026-03-29T01:30:00.000Z',
      '2026-03-30T00:30:00.000Z',
    ])
    // 2026-10-25: 03:00 CEST goes back to 02:00 CET, so 02:30 happens twice; it fires once.
    expect(isos(nextFirings(s, '2026-10-24T12:00:00Z', '2026-10-26T12:00:00Z'))).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ])
    // Once fired, the second 02:30 is not due again.
    expect(dueFiring(s, '2026-10-25T00:30:00Z', '2026-10-25T01:31:00Z')).toBeNull()
    // Sub-hourly schedules keep their real-time spacing through the repeated hour.
    const q = { cron: '*/30 * * * *', timezone: 'Europe/Berlin' }
    expect(isos(nextFirings(q, '2026-10-25T00:00:00Z', '2026-10-25T02:00:00Z'))).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ])
  })

  it('dueFiring: the latest firing since last, within grace; misses are not replayed', () => {
    const s = { cron: '0 * * * *', graceSeconds: 300 }
    expect(iso(dueFiring(s, '2026-01-01T08:30:00Z', '2026-01-01T09:00:00Z'))).toBe('2026-01-01T09:00:00.000Z')
    expect(iso(dueFiring(s, '2026-01-01T08:30:00Z', '2026-01-01T09:05:00Z'))).toBe('2026-01-01T09:00:00.000Z')
    expect(dueFiring(s, '2026-01-01T08:30:00Z', '2026-01-01T09:05:01Z')).toBeNull()
    expect(dueFiring(s, '2026-01-01T09:00:00Z', '2026-01-01T09:04:00Z')).toBeNull()
    // Down from 03:10 to 09:02: only 09:00 fires, not 04:00 … 08:00.
    expect(iso(dueFiring(s, '2026-01-01T03:10:00Z', '2026-01-01T09:02:00Z'))).toBe('2026-01-01T09:00:00.000Z')
    // A long outage on a frequent schedule still finds the latest firing.
    expect(iso(dueFiring({ cron: '* * * * * *', graceSeconds: 5 }, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00.500Z'))).toBe(
      '2026-01-02T00:00:00.000Z',
    )
    expect(dueFiring({ cron: '0 * * * *', graceSeconds: 0 }, 0, '2026-01-01T09:00:01Z')).toBeNull()
  })

  it('dedupe keys and scheduled trigger ids', () => {
    expect(scheduleDedupeKey('trg_1', '2026-01-01T09:00:00Z')).toBe('schedule:trg_1:2026-01-01T09:00:00.000Z')
    expect(scheduledTriggerId({ source: SCHEDULE_SOURCE, type: SCHEDULE_FIRED, payload: { triggerId: 'trg_1' } })).toBe('trg_1')
    expect(scheduledTriggerId({ source: 'mcp:x', type: SCHEDULE_FIRED, payload: { triggerId: 'trg_1' } })).toBeUndefined()
    expect(scheduledTriggerId({ source: SCHEDULE_SOURCE, type: 'other', payload: { triggerId: 'trg_1' } })).toBeUndefined()
    expect(scheduledTriggerId({ source: SCHEDULE_SOURCE, type: SCHEDULE_FIRED, payload: {} })).toBeUndefined()
  })
})

describe('schedule triggers', () => {
  let clock: ManualClock
  let events: Events

  beforeEach(() => {
    clock = new ManualClock(Date.parse('2026-01-01T08:50:00Z'))
    const store = memoryStore({ clock })
    events = createEvents({ records: createRecords({ store }), clock })
  })

  const hourly = (over: Record<string, unknown> = {}) =>
    events.triggers.create({
      name: 'hourly triage',
      employeeId: EMP,
      target: { type: 'session', sessionId: SES },
      schedule: { cron: '0 * * * *' },
      ...over,
    })

  /** What a scheduler does: ingest once per slot, then mark it handled. */
  const tick = async () => {
    const fired: string[] = []
    for (const { trigger, at } of await events.triggers.dueSchedules()) {
      const { created } = await events.ingest({
        source: SCHEDULE_SOURCE,
        type: SCHEDULE_FIRED,
        dedupeKey: scheduleDedupeKey(trigger.id, at),
        employeeId: trigger.data.employeeId,
        subject: { system: 'mp', id: trigger.id },
        payload: { triggerId: trigger.id, at },
      })
      if (created) fired.push(`${trigger.id}@${at}`)
      await events.triggers.markScheduled(trigger.id, at)
    }
    return fired
  }

  it('stores a validated schedule and an empty match', async () => {
    const t = await hourly({ schedule: { cron: ' 0 *  * * *', timezone: 'Europe/Berlin' } })
    expect(t.data.schedule).toEqual({ cron: '0 * * * *', timezone: 'Europe/Berlin', graceSeconds: 300 })
    expect(t.data.match).toEqual({})
    expect(t.data.lastScheduledAt).toBe('2026-01-01T08:50:00.000Z')
    await expect(hourly({ schedule: { cron: 'nope' } })).rejects.toThrow(ValidationError)
    await expect(hourly({ schedule: { cron: '0 * * * *', timezone: 'Nope/Zone' } })).rejects.toThrow(ValidationError)
    await expect(hourly({ match: { type: 'task.*' } })).rejects.toThrow(/no event match/)
  })

  it('validates schedules on update, and can turn one off', async () => {
    const t = await hourly()
    await expect(events.triggers.update(t.id, { schedule: { cron: '99 * * * *' } })).rejects.toThrow(ValidationError)
    await expect(events.triggers.update(t.id, { schedule: { cron: '0 * * * *', timezone: 'x/y' } })).rejects.toThrow(
      ValidationError,
    )
    await expect(events.triggers.update(t.id, { match: { source: 'chat' } })).rejects.toThrow(/no event match/)
    const u = await events.triggers.update(t.id, { schedule: { cron: '*/15 * * * *', graceSeconds: 60 } })
    expect(u.data.schedule).toEqual({ cron: '*/15 * * * *', timezone: 'UTC', graceSeconds: 60 })
    const plain = await events.triggers.update(t.id, { schedule: null, match: { type: 'task.*' } })
    expect(plain.data.schedule).toBeUndefined()
    expect(plain.data.lastScheduledAt).toBeUndefined()
    expect(await events.triggers.match({ source: 'x', type: 'task.new', routed: false, receivedAt: '' })).toHaveLength(1)
    // An event trigger can become a schedule trigger only without a match.
    await expect(events.triggers.update(t.id, { schedule: { cron: '0 * * * *' } })).rejects.toThrow(/no event match/)
    const again = await events.triggers.update(t.id, { schedule: { cron: '0 * * * *' }, match: {} })
    expect(again.data.schedule?.cron).toBe('0 * * * *')
  })

  it('is due once per slot', async () => {
    const t = await hourly()
    expect(await events.triggers.dueSchedules()).toEqual([])
    clock.set(Date.parse('2026-01-01T09:00:30Z'))
    const due = await events.triggers.dueSchedules()
    expect(due.map((d) => [d.trigger.id, d.at])).toEqual([[t.id, '2026-01-01T09:00:00.000Z']])
    expect(await tick()).toEqual([`${t.id}@2026-01-01T09:00:00.000Z`])
    expect(await tick()).toEqual([])
    expect((await events.triggers.get(t.id))!.data.lastScheduledAt).toBe('2026-01-01T09:00:00.000Z')
    clock.set(Date.parse('2026-01-01T10:01:00Z'))
    expect(await tick()).toEqual([`${t.id}@2026-01-01T10:00:00.000Z`])
    expect((await events.query({ type: SCHEDULE_FIRED })).length).toBe(2)
  })

  it('does not fire slots from before it was created', async () => {
    clock.set(Date.parse('2026-01-01T09:02:00Z'))
    await hourly()
    expect(await events.triggers.dueSchedules()).toEqual([])
  })

  it('fires only the latest missed slot, and only within grace', async () => {
    const t = await hourly({ schedule: { cron: '0 * * * *', graceSeconds: 120 } })
    clock.set(Date.parse('2026-01-01T13:01:00Z')) // down since 08:50
    expect(await tick()).toEqual([`${t.id}@2026-01-01T13:00:00.000Z`])
    clock.set(Date.parse('2026-01-01T16:03:00Z')) // 16:00 missed by more than the grace period
    expect(await tick()).toEqual([])
    clock.set(Date.parse('2026-01-01T17:00:00Z'))
    expect(await tick()).toEqual([`${t.id}@2026-01-01T17:00:00.000Z`])
  })

  it('never fires twice under concurrent schedulers', async () => {
    const t = await hourly()
    clock.set(Date.parse('2026-01-01T09:00:10Z'))
    const results = await Promise.all(Array.from({ length: 10 }, () => tick()))
    expect(results.flat()).toEqual([`${t.id}@2026-01-01T09:00:00.000Z`])
    expect(await events.query({ type: SCHEDULE_FIRED })).toHaveLength(1)
    expect((await events.triggers.get(t.id))!.data.lastScheduledAt).toBe('2026-01-01T09:00:00.000Z')
    // A restart that forgot to mark the slot still dedupes on the event key.
    await events.triggers.update(t.id, { name: 'renamed' })
    const res = await events.ingest({
      source: SCHEDULE_SOURCE,
      type: SCHEDULE_FIRED,
      dedupeKey: scheduleDedupeKey(t.id, '2026-01-01T09:00:00Z'),
    })
    expect(res.created).toBe(false)
  })

  it('markScheduled only moves forward', async () => {
    const t = await hourly()
    await events.triggers.markScheduled(t.id, '2026-01-01T10:00:00Z')
    await events.triggers.markScheduled(t.id, '2026-01-01T09:00:00Z')
    expect((await events.triggers.get(t.id))!.data.lastScheduledAt).toBe('2026-01-01T10:00:00.000Z')
    await Promise.all(['11', '13', '12'].map((h) => events.triggers.markScheduled(t.id, `2026-01-01T${h}:00:00Z`)))
    expect((await events.triggers.get(t.id))!.data.lastScheduledAt).toBe('2026-01-01T13:00:00.000Z')
    await expect(events.triggers.markScheduled(t.id, 'soon')).rejects.toThrow(ValidationError)
  })

  it('disabled triggers are never due, and re-enabling skips what passed', async () => {
    const t = await hourly()
    await events.triggers.update(t.id, { enabled: false })
    clock.set(Date.parse('2026-01-01T09:01:00Z'))
    expect(await events.triggers.dueSchedules()).toEqual([])
    await events.triggers.update(t.id, { enabled: true })
    expect(await events.triggers.dueSchedules()).toEqual([])
    clock.set(Date.parse('2026-01-01T10:00:00Z'))
    expect(await tick()).toEqual([`${t.id}@2026-01-01T10:00:00.000Z`])
  })

  it('reads schedules in their time zone', async () => {
    const t = await hourly({ schedule: { cron: '0 9 * * *', timezone: 'America/New_York' } })
    clock.set(Date.parse('2026-01-01T09:00:00Z'))
    expect(await tick()).toEqual([])
    clock.set(Date.parse('2026-01-01T14:00:00Z')) // 09:00 EST
    expect(await tick()).toEqual([`${t.id}@2026-01-01T14:00:00.000Z`])
  })

  describe('routing', () => {
    let scheduled: Trigger
    let catchAll: Trigger

    beforeEach(async () => {
      scheduled = await hourly()
      catchAll = await events.triggers.create({
        name: 'everything',
        employeeId: EMP,
        match: {},
        target: { type: 'router' },
        priority: 100,
      })
    })

    const fired = (triggerId: string, over: Record<string, unknown> = {}) => ({
      source: SCHEDULE_SOURCE,
      type: SCHEDULE_FIRED,
      employeeId: EMP,
      payload: { triggerId },
      routed: false,
      receivedAt: clock.iso(),
      ...over,
    })

    it('a schedule.fired event routes to exactly its trigger', async () => {
      expect((await events.triggers.match(fired(scheduled.id))).map((t) => t.id)).toEqual([scheduled.id])
      const { event } = await events.ingest({
        source: SCHEDULE_SOURCE,
        type: SCHEDULE_FIRED,
        payload: { triggerId: scheduled.id },
      })
      expect((await events.triggers.match(event)).map((t) => t.id)).toEqual([scheduled.id])
    })

    it('schedule triggers never match ordinary events', async () => {
      const ordinary = { source: 'chat', type: 'message.posted', employeeId: EMP, routed: false, receivedAt: '' }
      expect((await events.triggers.match(ordinary)).map((t) => t.id)).toEqual([catchAll.id])
    })

    it('matches nothing for a disabled, unknown, non-schedule or other employee trigger', async () => {
      expect(await events.triggers.match(fired('trg_unknown'))).toEqual([])
      expect(await events.triggers.match(fired(catchAll.id))).toEqual([])
      expect(await events.triggers.match(fired(scheduled.id, { employeeId: EMP2 }))).toEqual([])
      await events.triggers.update(scheduled.id, { enabled: false })
      expect(await events.triggers.match(fired(scheduled.id))).toEqual([])
    })

    it('a schedule.fired from another source is an ordinary event', async () => {
      const spoofed = fired(scheduled.id, { source: 'mcp:evil' })
      expect((await events.triggers.match(spoofed)).map((t) => t.id)).toEqual([catchAll.id])
    })
  })
})
