import { ManualClock, ValidationError } from '@mp/core'
import { createRecords } from '@mp/records'
import { memoryStore } from '@mp/store'
import { describe, expect, it } from 'vitest'
import {
  SCHEDULED_TASK_FIRED,
  createEvents,
  createScheduledTasks,
  describeCron,
  describeWhen,
  formatLocal,
  parseAt,
  parseDuration,
  parseEvery,
  parseClock,
  scheduledTaskDedupeKey,
  scheduledTaskEvent,
  scheduledTaskId,
  zonedTime,
} from '../src/index.ts'

const EMP = 'emp_01J00000000000000000000001'
const SES = 'ses_01J00000000000000000000001'
const CON = 'con_01J00000000000000000000001'
const MIN = 60_000
const HOUR = 60 * MIN
const BG = 'Europe/Belgrade'
// Tuesday 2026-09-29 09:00 UTC = 11:00 in Belgrade (CEST).
const NOW = Date.UTC(2026, 8, 29, 9)
const iso = (ms: number) => new Date(ms).toISOString()

describe('one-off times', () => {
  it('reads wall-clock times in the time zone, and ISO times with an offset as given', () => {
    expect(iso(parseAt('2026-10-02 16:00', BG, NOW))).toBe('2026-10-02T14:00:00.000Z')
    expect(iso(parseAt('2026-10-02T16:00', BG, NOW))).toBe('2026-10-02T14:00:00.000Z')
    expect(iso(parseAt('2026-10-02T16:00:00Z', BG, NOW))).toBe('2026-10-02T16:00:00.000Z')
    expect(iso(parseAt('2026-10-02T16:00:00+05:30', BG, NOW))).toBe('2026-10-02T10:30:00.000Z')
    expect(iso(parseAt('2026-10-02 16:00', 'America/New_York', NOW))).toBe('2026-10-02T20:00:00.000Z')
    // Winter time after 2026-10-25 in Belgrade: UTC+1.
    expect(iso(parseAt('2026-11-02 09:00', BG, NOW))).toBe('2026-11-02T08:00:00.000Z')
  })

  it('reads today, tomorrow and weekdays, relative to now in the time zone', () => {
    expect(iso(parseAt('today 17:00', BG, NOW))).toBe('2026-09-29T15:00:00.000Z')
    expect(iso(parseAt('tomorrow 9am', BG, NOW))).toBe('2026-09-30T07:00:00.000Z')
    expect(iso(parseAt('friday 16:00', BG, NOW))).toBe('2026-10-02T14:00:00.000Z')
    expect(iso(parseAt('Fri at 4:30pm', BG, NOW))).toBe('2026-10-02T14:30:00.000Z')
    // Today is Tuesday: later today, else next week.
    expect(iso(parseAt('tuesday 12:00', BG, NOW))).toBe('2026-09-29T10:00:00.000Z')
    expect(iso(parseAt('tuesday 10:00', BG, NOW))).toBe('2026-10-06T08:00:00.000Z')
    // Late in UTC is already the next day further east.
    const late = Date.UTC(2026, 8, 29, 23, 30) // Wednesday 05:00 in Kolkata
    expect(iso(parseAt('today 06:00', 'Asia/Kolkata', late))).toBe('2026-09-30T00:30:00.000Z')
  })

  it('refuses the past, dates without a time, nonsense and times too far ahead', () => {
    for (const bad of ['2026-09-29 10:00', 'today 08:00', '2026-09-28T09:00:00Z'])
      expect(() => parseAt(bad, BG, NOW), bad).toThrow(/already passed/)
    expect(() => parseAt('2026-10-02', BG, NOW)).toThrow(/no time of day/)
    for (const bad of ['soon', 'next week', '', '2026-13-01 10:00', '2026-02-30 10:00', 'friday', 'friday 25:00', 42])
      expect(() => parseAt(bad, BG, NOW), String(bad)).toThrow(ValidationError)
    expect(() => parseAt('2028-01-01 10:00', BG, NOW)).toThrow(/400 days/)
  })

  it('handles daylight saving: skipped times move forward, repeated ones are the first', () => {
    // Belgrade: 2026-03-29 02:00 CET jumps to 03:00 CEST; 2026-10-25 03:00 CEST goes back to 02:00 CET.
    expect(iso(zonedTime(BG, 2026, 3, 29, 2, 30))).toBe('2026-03-29T01:30:00.000Z') // shows 03:30 CEST
    expect(iso(zonedTime(BG, 2026, 10, 25, 2, 30))).toBe('2026-10-25T00:30:00.000Z') // the CEST one
    expect(iso(zonedTime(BG, 2026, 10, 25, 4, 0))).toBe('2026-10-25T03:00:00.000Z')
    expect(formatLocal(Date.UTC(2026, 9, 2, 14), BG)).toBe('Fri 2026-10-02 16:00')
  })

  it('reads delays', () => {
    expect(parseDuration('2 hours')).toBe(2 * HOUR)
    expect(parseDuration('in 90 minutes')).toBe(90 * MIN)
    expect(parseDuration('1h30m')).toBe(90 * MIN)
    expect(parseDuration('1 day and 2 hours')).toBe(26 * HOUR)
    expect(parseDuration('an hour')).toBe(HOUR)
    expect(parseDuration('2 weeks')).toBe(14 * 24 * HOUR)
    expect(parseDuration('1.5 hours')).toBe(90 * MIN)
    for (const bad of ['', 'soon', '2 fortnights', '10 seconds', '500 days', '2 hours later', 5])
      expect(() => parseDuration(bad), String(bad)).toThrow(ValidationError)
  })

  it('reads clock times', () => {
    expect(parseClock('9:00')).toEqual({ hour: 9, minute: 0 })
    expect(parseClock('12am')).toEqual({ hour: 0, minute: 0 })
    expect(parseClock('12:15pm')).toEqual({ hour: 12, minute: 15 })
    expect(parseClock('16h')).toEqual({ hour: 16, minute: 0 })
    for (const bad of ['9', '24:00', '13pm', '9:60', 'noon']) expect(parseClock(bad), bad).toBeNull()
  })
})

describe('recurring schedules in words', () => {
  it('maps the friendly forms to cron', () => {
    const cases: [string, string][] = [
      ['every weekday at 09:00', '0 9 * * 1-5'],
      ['weekdays at 9am', '0 9 * * 1-5'],
      ['day at 18:30', '30 18 * * *'],
      ['every day', '0 9 * * *'],
      ['weekend at 10:00', '0 10 * * 0,6'],
      ['monday at 10:30', '30 10 * * 1'],
      ['Monday, Thursday at 9am', '0 9 * * 1,4'],
      ['tue and fri 16:00', '0 16 * * 2,5'],
      ['week on friday at 16:00', '0 16 * * 5'],
      ['month on the 1st at 09:00', '0 9 1 * *'],
      ['month on the 15th', '0 9 15 * *'],
      ['30 minutes', '*/30 * * * *'],
      ['minute', '* * * * *'],
      ['hour', '0 * * * *'],
      ['every 2 hours', '0 */2 * * *'],
    ]
    for (const [words, cron] of cases) expect(parseEvery(words), words).toBe(cron)
    for (const bad of ['', 'fortnight', 'blursday at 9:00', 'month on the 31st', '90 minutes', 'every 30 hours'])
      expect(() => parseEvery(bad), bad).toThrow(ValidationError)
  })

  it('describes cron in words, and anything else as cron', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('every weekday 09:00')
    expect(describeCron('30 18 * * *')).toBe('every day 18:30')
    expect(describeCron('0 9 * * 1,4')).toBe('every Monday, Thursday 09:00')
    expect(describeCron('0 10 * * 0,6')).toBe('every weekend day 10:00')
    expect(describeCron('0 9 1 * *')).toBe('every month on the 1st 09:00')
    expect(describeCron('0 9 22 * *')).toBe('every month on the 22nd 09:00')
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes')
    expect(describeCron('0 */2 * * *')).toBe('every 2 hours')
    expect(describeCron('0 * * * *')).toBe('every hour')
    expect(describeCron('0 9 * 1 *')).toBe('cron 0 9 * 1 *')
    expect(describeCron('@daily')).toBe('cron @daily')
    // The friendly forms describe themselves.
    expect(describeCron(parseEvery('monday, wednesday at 07:45'))).toBe('every Monday, Wednesday 07:45')
    expect(describeWhen({ type: 'cron', cron: '0 9 * * 1-5' }, BG)).toBe('every weekday 09:00 Europe/Belgrade')
    expect(describeWhen({ type: 'once', at: '2026-10-02T14:00:00.000Z' }, BG)).toBe('once, Fri 2026-10-02 16:00 Europe/Belgrade')
  })
})

async function setup() {
  const clock = new ManualClock(NOW)
  const records = createRecords({ store: memoryStore() })
  const tasks = createScheduledTasks({ records, clock })
  const events = createEvents({ records, clock })
  return { clock, records, tasks, events }
}

describe('scheduled tasks', () => {
  it('validates what it stores', async () => {
    const { tasks } = await setup()
    const base = {
      instruction: 'Post the standup summary',
      employeeId: EMP,
      when: { type: 'cron' as const, cron: '0 9 * * 1-5' },
    }
    const t = await tasks.create({ ...base, timezone: 'europe/belgrade' as string })
    expect(t.id).toMatch(/^tsk_/)
    expect(t.data).toMatchObject({
      kind: 'task',
      timezone: BG,
      graceSeconds: 300,
      sessionMode: 'continue',
      enabled: true,
      fired: 0,
    })
    const bad: [unknown, RegExp][] = [
      [{ ...base, instruction: '  ' }, /instruction is required/],
      [{ ...base, instruction: 'x'.repeat(4001) }, /at most 4000/],
      [{ ...base, when: { type: 'cron', cron: 'nope' } }, /schedule.cron/],
      [{ ...base, when: { type: 'once', at: 'friday' } }, /ISO time/],
      [{ ...base, when: { type: 'once', at: '2026-09-29T08:00:00Z' } }, /already passed/],
      [{ ...base, when: { type: 'weekly' } }, /when must be/],
      [{ ...base, timezone: 'Mars/Olympus' }, /unknown time zone/],
      [{ ...base, graceSeconds: -5 }, /graceSeconds/],
      [{ ...base, sessionMode: 'sometimes' }, /sessionMode/],
      [{ ...base, report: { type: 'chat' } }, /report must be/],
      [{ ...base, employeeId: '' }, /employeeId/],
      [{ ...base, kind: 'follow_up', when: { type: 'once', at: '2026-09-29T12:00:00Z' } }, /needs the session/],
      [{ ...base, kind: 'follow_up', sessionId: SES }, /happens once/],
    ]
    for (const [input, re] of bad) await expect(tasks.create(input as never), re.source).rejects.toThrow(re)
    // A one-off gets the longer grace period by default.
    const once = await tasks.create({ ...base, when: { type: 'once', at: '2026-10-02T14:00:00Z' } })
    expect(once.data.graceSeconds).toBe(3600)
  })

  it('fires a one-off once, at its time, and is done', async () => {
    const { tasks, clock } = await setup()
    const t = await tasks.create({ instruction: 'Remind Ana', employeeId: EMP, when: { type: 'once', at: iso(NOW + 2 * HOUR) } })
    expect(await tasks.due()).toEqual([])
    expect(tasks.nextRun(t)).toBe(iso(NOW + 2 * HOUR))
    clock.advance(2 * HOUR + 20_000)
    const due = await tasks.due()
    expect(due.map((d) => [d.task.id, d.at, d.missed])).toEqual([[t.id, iso(NOW + 2 * HOUR), undefined]])
    // Two instances mark the same slot: it counts once.
    const [a, b] = await Promise.all([tasks.markFired(t.id, due[0]!.at, 'evt_1'), tasks.markFired(t.id, due[0]!.at, 'evt_1')])
    const after = await tasks.require(t.id)
    expect(after.data).toMatchObject({ fired: 1, done: true, enabled: false, lastRun: { eventId: 'evt_1', state: 'queued' } })
    expect([a.data.fired, b.data.fired]).toEqual([1, 1])
    expect(await tasks.due()).toEqual([])
    expect(tasks.nextRun(after)).toBeNull()
    // It can't be resumed as is, only given a new time.
    await expect(tasks.update(t.id, { enabled: true })).rejects.toThrow(/already ran/)
    const again = await tasks.update(t.id, { when: { type: 'once', at: iso(clock.now() + HOUR) } })
    expect(again.data).toMatchObject({ enabled: true })
    expect(again.data.done).toBeUndefined()
    expect(tasks.nextRun(again)).toBe(iso(clock.now() + HOUR))
  })

  it('marks a one-off missed beyond its grace period instead of firing it late', async () => {
    const { tasks, clock } = await setup()
    const t = await tasks.create({
      instruction: 'Ping the reviewer',
      employeeId: EMP,
      when: { type: 'once', at: iso(NOW + HOUR) },
      graceSeconds: 600,
    })
    clock.advance(HOUR + 11 * MIN) // the harness was down
    const [d] = await tasks.due()
    expect(d).toMatchObject({ at: iso(NOW + HOUR), missed: true })
    const missed = await tasks.markMissed(t.id, d!.at)
    expect(missed.data).toMatchObject({ done: true, enabled: false, lastRun: { state: 'missed' } })
    expect(await tasks.due()).toEqual([])
  })

  it('fires a recurring task per slot in its time zone, skips slots missed beyond grace, and resumes from now', async () => {
    const { tasks, clock } = await setup()
    const t = await tasks.create({
      instruction: 'Triage new issues',
      employeeId: EMP,
      when: { type: 'cron', cron: '0 9 * * 1-5' },
      timezone: BG,
    })
    // Next: Wednesday 09:00 in Belgrade = 07:00 UTC.
    expect(tasks.nextRun(t)).toBe('2026-09-30T07:00:00.000Z')
    clock.set(Date.parse('2026-09-30T07:00:30Z'))
    const [d] = await tasks.due()
    expect(d?.at).toBe('2026-09-30T07:00:00.000Z')
    await tasks.markFired(t.id, d!.at, 'evt_a')
    expect(await tasks.due()).toEqual([])
    // Thursday's slot, but the harness came back 20 minutes late: not replayed.
    clock.set(Date.parse('2026-10-01T07:20:00Z'))
    expect(await tasks.due()).toEqual([])
    // Paused over Friday, resumed on Friday afternoon: Friday's slot doesn't fire late.
    await tasks.update(t.id, { enabled: false })
    clock.set(Date.parse('2026-10-02T07:02:00Z'))
    expect(await tasks.due()).toEqual([])
    const resumed = await tasks.update(t.id, { enabled: true })
    expect(await tasks.due()).toEqual([])
    // Monday is next (the weekend is skipped).
    expect(tasks.nextRun(resumed)).toBe('2026-10-05T07:00:00.000Z')
    expect((await tasks.require(t.id)).data.fired).toBe(1)
  })

  it('run now counts, keeps the schedule, and finishes a one-off', async () => {
    const { tasks } = await setup()
    const rec = await tasks.create({ instruction: 'Weekly summary', employeeId: EMP, when: { type: 'cron', cron: '0 16 * * 5' } })
    const r = await tasks.markRunNow(rec.id, 'evt_now')
    expect(r.data).toMatchObject({ fired: 1, enabled: true, lastRun: { eventId: 'evt_now', manual: true, state: 'queued' } })
    expect(r.data.lastScheduledAt).toBe(rec.data.lastScheduledAt)
    // The same request again changes nothing.
    expect((await tasks.markRunNow(rec.id, 'evt_now')).data.fired).toBe(1)
    const once = await tasks.create({ instruction: 'x', employeeId: EMP, when: { type: 'once', at: iso(NOW + HOUR) } })
    expect((await tasks.markRunNow(once.id, 'evt_once')).data).toMatchObject({ done: true, enabled: false })
    expect(await tasks.due(NOW + 2 * HOUR)).toEqual([])
  })

  it('records the last run, newest wins, the same firing is updated', async () => {
    const { tasks } = await setup()
    const t = await tasks.create({ instruction: 'x', employeeId: EMP, when: { type: 'cron', cron: '0 9 * * *' } })
    await tasks.recordRun(t.id, { at: '2026-09-30T09:00:00.000Z', eventId: 'e2', state: 'queued' })
    await tasks.recordRun(t.id, {
      at: '2026-09-30T09:00:00.000Z',
      eventId: 'e2',
      runId: 'run_2',
      state: 'completed',
      output: 'ok',
    })
    // An older firing finishing later doesn't replace it.
    await tasks.recordRun(t.id, { at: '2026-09-29T09:00:00.000Z', eventId: 'e1', runId: 'run_1', state: 'failed' })
    expect((await tasks.require(t.id)).data.lastRun).toEqual({
      at: '2026-09-30T09:00:00.000Z',
      eventId: 'e2',
      runId: 'run_2',
      state: 'completed',
      output: 'ok',
    })
    expect(await tasks.recordRun('tsk_gone', { at: '2026-09-30T09:00:00.000Z', state: 'completed' })).toBeNull()
  })

  it('builds the firing event: instruction first, who asked, where to report, deduplicated by slot', async () => {
    const { tasks, events } = await setup()
    const t = await tasks.create({
      instruction: 'Post the weekly numbers',
      employeeId: EMP,
      requesterId: CON,
      when: { type: 'cron', cron: '0 16 * * 5' },
      timezone: BG,
      sessionId: SES,
      report: { type: 'chat', channelId: 'chn_1', threadId: 'msg_1', label: '#finance' },
    })
    const at = '2026-10-02T14:00:00.000Z'
    const input = scheduledTaskEvent(t, at, { requesterName: 'Ana Lima' })
    expect(input).toMatchObject({
      source: 'schedule',
      type: SCHEDULED_TASK_FIRED,
      dedupeKey: scheduledTaskDedupeKey(t.id, at),
      employeeId: EMP,
      actorContactId: CON,
      subject: { system: 'mp', id: t.id },
      payload: { taskId: t.id, kind: 'task', at, report: { type: 'chat', threadId: 'msg_1' } },
    })
    expect(input.text!.split('\n')[0]).toBe('Post the weekly numbers')
    expect(input.text).toContain('every Friday 16:00 Europe/Belgrade, asked for by Ana Lima')
    expect(input.text).toContain('This firing: Fri 2026-10-02 16:00 Europe/Belgrade')
    expect(input.text).toContain('chat thread msg_1 (#finance) with chat.reply')
    const first = await events.ingest(input)
    const second = await events.ingest(scheduledTaskEvent(t, at))
    expect([first.created, second.created]).toEqual([true, false])
    expect(scheduledTaskId(first.event.data)).toBe(t.id)
    expect(scheduledTaskId({ source: 'chat', type: SCHEDULED_TASK_FIRED, payload: { taskId: t.id } })).toBeUndefined()
    // Slack and no report.
    const slack = await tasks.update(t.id, { report: { type: 'subject', subject: { system: 'slack', id: 'C1/1700.1' } } })
    expect(scheduledTaskEvent(slack, at).text).toContain('channel C1, thread 1700.1 (mcp.slack.reply)')
    const none = await tasks.update(t.id, { report: null })
    expect(scheduledTaskEvent(none, at, { manual: true, byName: 'Ana' }).text).toContain('Run now by Ana')
    expect(scheduledTaskEvent(none, at).text).toContain('Nobody asked for a report')
  })

  it('renders a follow-up as a note that asks whether it is still needed', async () => {
    const { tasks } = await setup()
    const f = await tasks.create({
      kind: 'follow_up',
      instruction: 'check CI on !42',
      employeeId: EMP,
      sessionId: SES,
      when: { type: 'once', at: iso(NOW + 2 * HOUR) },
    })
    expect(f.data.sessionMode).toBe('continue')
    const text = scheduledTaskEvent(f, iso(NOW + 2 * HOUR)).text!
    expect(text).toContain('Follow-up you left for yourself')
    expect(text).toContain('check CI on !42')
    expect(text).toMatch(/still needed/)
    // A follow-up can't become recurring.
    await expect(tasks.update(f.id, { when: { type: 'cron', cron: '0 9 * * *' } })).rejects.toThrow(/happens once/)
  })

  it('lists by employee, kind and session', async () => {
    const { tasks } = await setup()
    const a = await tasks.create({ instruction: 'a', employeeId: EMP, when: { type: 'cron', cron: '0 9 * * *' } })
    await tasks.create({ instruction: 'b', employeeId: 'emp_other', when: { type: 'cron', cron: '0 9 * * *' } })
    const f = await tasks.create({
      kind: 'follow_up',
      instruction: 'c',
      employeeId: EMP,
      sessionId: SES,
      when: { type: 'once', at: iso(NOW + HOUR) },
    })
    expect((await tasks.list({ employeeId: EMP })).map((t) => t.id).sort()).toEqual([a.id, f.id].sort())
    expect((await tasks.list({ kind: 'follow_up' })).map((t) => t.id)).toEqual([f.id])
    expect((await tasks.list({ sessionId: SES })).map((t) => t.id)).toEqual([f.id])
    await tasks.remove(a.id)
    expect(await tasks.get(a.id)).toBeNull()
    await expect(tasks.require(a.id)).rejects.toThrow(/not found/)
  })
})
