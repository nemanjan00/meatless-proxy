import {
  type ApiRecord,
  ApiRequestError,
  type EmployeeData,
  type Me,
  type ScheduleCreateBody,
  type ScheduledTask,
  type ScheduleLastRun,
  type SchedulePatchBody,
  type SchedulePreview,
  type ScheduleWhen,
  type ScheduleWhenInput,
  type SchedulesApi,
  type SessionData,
} from '@mp/api'
import { CHN, CON, EMP, type MockDb, SES, mockId } from './data.ts'

/**
 * Scheduled tasks and follow-ups for the mock API (the server: packages/server/src/schedules). The
 * schedule math is a small stand-in for the server's: wall-clock times are read in UTC, and cron
 * covers the shapes the Schedules page offers (a time on days of the week or a day of the month, and
 * minute or hour intervals).
 */

/** What the schedules mock borrows from the mock API. */
export interface MockSchedulesHelpers {
  db: MockDb
  delay<T>(v: T): Promise<T>
  get<T>(kind: string, id: string): ApiRecord<T> | undefined
  whoami(): Promise<Me>
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const fail = (status: number, code: 'not_found' | 'validation' | 'denied' | 'bad_request', message: string) =>
  Promise.reject(new ApiRequestError(status, code, message))

interface Cron {
  minute: number | { every: number }
  hour: number | '*' | { every: number }
  dom: number | '*'
  dow: number[] | '*'
}

/** Parses the cron shapes the page offers; null for anything else. */
export function mockParseCron(cron: string): Cron | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5 || f[3] !== '*') return null
  const [mi, h, dom, , dow] = f as [string, string, string, string, string]
  const step = (v: string) => /^\*\/(\d+)$/.exec(v)?.[1]
  const num = (v: string, max: number) => (/^\d+$/.test(v) && Number(v) <= max ? Number(v) : null)
  const minute = mi === '*' ? { every: 1 } : step(mi) ? { every: Number(step(mi)) } : num(mi, 59)
  const hour = h === '*' ? '*' : step(h) ? { every: Number(step(h)) } : num(h, 23)
  const d = dom === '*' ? '*' : num(dom, 31)
  let days: number[] | '*' | null = '*'
  if (dow === '1-5') days = [1, 2, 3, 4, 5]
  else if (dow !== '*') {
    const parts = dow.split(',').map((x) => num(x, 7))
    days = parts.some((x) => x === null) ? null : [...new Set((parts as number[]).map((x) => x % 7))].sort()
  }
  if (minute === null || hour === null || d === null || days === null) return null
  return { minute, hour, dom: d, dow: days }
}

const pad = (n: number) => String(n).padStart(2, '0')
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

/** The schedule in words, like the server's `describeWhen`. */
export function mockDescribe(when: ScheduleWhen, tz: string): string {
  if (when.type === 'once') {
    const d = new Date(when.at)
    return `once, ${SHORT[d.getUTCDay()]} ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} ${tz}`
  }
  const c = mockParseCron(when.cron)
  if (!c) return `cron ${when.cron} ${tz}`
  if (typeof c.minute === 'object' && c.hour === '*')
    return `${c.minute.every === 1 ? 'every minute' : `every ${c.minute.every} minutes`} ${tz}`
  if (c.minute === 0 && c.hour === '*') return `every hour ${tz}`
  if (typeof c.hour === 'object') return `every ${c.hour.every} hours ${tz}`
  if (typeof c.minute !== 'number' || typeof c.hour !== 'number') return `cron ${when.cron} ${tz}`
  const time = `${pad(c.hour)}:${pad(c.minute)}`
  if (c.dom !== '*') return `every month on the ${ordinal(c.dom)} ${time} ${tz}`
  if (c.dow === '*') return `every day ${time} ${tz}`
  if (c.dow.join() === '1,2,3,4,5') return `every weekday ${time} ${tz}`
  return `every ${c.dow.map((d) => DAYS[d]).join(', ')} ${time} ${tz}`
}

/** The next `n` firings after `from` (UTC wall clock). */
export function mockNext(when: ScheduleWhen, from: number, n = 5): string[] {
  if (when.type === 'once') return Date.parse(when.at) > from ? [when.at] : []
  const c = mockParseCron(when.cron)
  if (!c) return []
  const out: string[] = []
  if (typeof c.minute === 'object' || typeof c.hour === 'object' || c.hour === '*') {
    const stepMs = typeof c.minute === 'object' ? c.minute.every * MIN : typeof c.hour === 'object' ? c.hour.every * HOUR : HOUR
    let t = Math.floor(from / stepMs) * stepMs + stepMs
    while (out.length < n) {
      out.push(new Date(t).toISOString())
      t += stepMs
    }
    return out
  }
  const start = new Date(from)
  for (let i = 0; i < 400 && out.length < n; i++) {
    const day = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i, c.hour, c.minute)
    const d = new Date(day)
    if (day <= from) continue
    if (c.dom !== '*' && d.getUTCDate() !== c.dom) continue
    if (c.dow !== '*' && !c.dow.includes(d.getUTCDay())) continue
    out.push(d.toISOString())
  }
  return out
}

/** A `when` from the form: exactly one of at, in, every or cron. */
function resolveWhen(w: ScheduleWhenInput | undefined, now: number): ScheduleWhen | string {
  const given = (['at', 'in', 'every', 'cron'] as const).filter((k) => w?.[k])
  if (given.length !== 1) return given.length ? 'give only one of at, in, every or cron' : 'say when'
  if (w!.at) {
    const text = w!.at.trim()
    const ms = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? Date.parse(text) : Date.parse(`${text.replace(' ', 'T')}Z`)
    if (Number.isNaN(ms)) return `can't read ${JSON.stringify(text)} as a time`
    if (ms <= now) return `${JSON.stringify(text)} has already passed`
    return { type: 'once', at: new Date(ms).toISOString() }
  }
  if (w!.in) {
    const m = /^(\d+)\s*(minutes?|hours?|days?)$/.exec(w!.in.trim())
    if (!m) return `can't read ${JSON.stringify(w!.in)} as a delay`
    const unit = m[2]!.startsWith('m') ? MIN : m[2]!.startsWith('h') ? HOUR : DAY
    return { type: 'once', at: new Date(now + Number(m[1]) * unit).toISOString() }
  }
  if (w!.every) return 'the mock takes cron, not words'
  if (!mockParseCron(w!.cron!)) return `schedule.cron: can't read ${JSON.stringify(w!.cron)}`
  return { type: 'cron', cron: w!.cron!.trim().replace(/\s+/g, ' ') }
}

interface MockTask {
  id: string
  kind: 'task' | 'follow_up'
  instruction: string
  when: ScheduleWhen
  timezone: string
  enabled: boolean
  done: boolean
  employeeId: string
  requesterId: string | null
  sessionId: string | null
  sessionMode: 'continue' | 'fresh'
  report: ScheduledTask['report']
  lastRun: ScheduleLastRun | null
  fired: number
  createdAt: string
}

const state = new WeakMap<MockDb, { tasks: MockTask[]; seq: number }>()

function seed(db: MockDb): { tasks: MockTask[]; seq: number } {
  const now = db.now()
  const at = (ms: number) => new Date(ms).toISOString()
  const task = (
    n: number,
    t: Omit<MockTask, 'id' | 'fired' | 'createdAt' | 'done' | 'sessionMode'> & Partial<MockTask>,
  ): MockTask => ({
    id: mockId('tsk', n),
    fired: 0,
    done: false,
    sessionMode: 'continue',
    createdAt: at(now - 20 * DAY + n * HOUR),
    ...t,
  })
  const tasks = [
    task(1, {
      kind: 'task',
      instruction: 'Post the weekly invoice summary in #billing: invoices sent, paid, overdue, and anything odd.',
      when: { type: 'cron', cron: '0 14 * * 5' },
      timezone: 'Europe/Belgrade',
      enabled: true,
      employeeId: EMP.billing,
      requesterId: CON.ana,
      sessionId: SES.billingIntake,
      report: { label: '#billing', channelId: CHN.billing },
      fired: 3,
      lastRun: {
        at: at(now - 5 * DAY),
        state: 'completed',
        runId: mockId('run', 1),
        sessionId: SES.billingIntake,
        output: '14 invoices sent, 11 paid, 2 overdue (ACME, Globex). INV-1002 was charged twice: PAY-123 is on it.',
      },
    }),
    task(2, {
      kind: 'task',
      instruction: 'Triage new PAY issues in Linear: label them, ask for missing details, and assign the obvious ones.',
      when: { type: 'cron', cron: '0 7 * * 1-5' },
      timezone: 'Europe/Belgrade',
      enabled: true,
      employeeId: EMP.billing,
      requesterId: CON.bob,
      sessionId: SES.billingIntake,
      sessionMode: 'fresh',
      report: null,
      fired: 12,
      lastRun: {
        at: at(now - DAY),
        state: 'failed',
        runId: mockId('run', 2),
        output: 'Linear answered 401: the token has expired.',
      },
    }),
    task(3, {
      kind: 'task',
      instruction: 'Remind Chen to rotate the staging TLS certificate before it expires on Friday.',
      when: { type: 'once', at: at(Math.ceil((now + 3 * HOUR) / MIN) * MIN) },
      timezone: 'UTC',
      enabled: true,
      employeeId: EMP.infra,
      requesterId: CON.chen,
      sessionId: SES.inc42,
      report: { label: 'thread in #deploys', channelId: CHN.deploys, threadId: mockId('msg', 3) },
      lastRun: null,
    }),
    task(4, {
      kind: 'follow_up',
      instruction: 'Check CI on !481, and poke the reviewer if there is no answer yet.',
      when: { type: 'once', at: at(Math.ceil((now + 2 * HOUR) / MIN) * MIN) },
      timezone: 'UTC',
      enabled: true,
      employeeId: EMP.billing,
      requesterId: CON.ana,
      sessionId: SES.pay123,
      report: null,
      lastRun: null,
    }),
    task(5, {
      kind: 'task',
      instruction: 'Export last month’s invoices as CSV for finance and share the file with Dana.',
      when: { type: 'cron', cron: '0 8 1 * *' },
      timezone: 'UTC',
      enabled: false,
      employeeId: EMP.support,
      requesterId: CON.dana,
      sessionId: null,
      report: null,
      fired: 4,
      lastRun: { at: at(now - 28 * DAY), state: 'completed', output: 'Shared invoices-2026-08.csv with Dana.' },
    }),
    task(6, {
      kind: 'task',
      instruction: 'Remind Eli about the vendor call at 15:00.',
      when: { type: 'once', at: at(now - 2 * DAY) },
      timezone: 'UTC',
      enabled: false,
      done: true,
      employeeId: EMP.support,
      requesterId: CON.eli,
      sessionId: null,
      report: null,
      fired: 1,
      lastRun: { at: at(now - 2 * DAY), state: 'completed', output: 'Reminded Eli in #support.' },
    }),
  ]
  return { tasks, seq: 100 }
}

function stateOf(db: MockDb) {
  let s = state.get(db)
  if (!s) {
    s = seed(db)
    state.set(db, s)
  }
  return s
}

/** The schedules part of the mock API. */
export function createMockSchedulesApi(h: MockSchedulesHelpers): SchedulesApi {
  const { db, delay, get } = h

  const view = async (t: MockTask): Promise<ScheduledTask> => {
    const me = await h.whoami()
    const emp = get<EmployeeData>('employee', t.employeeId)
    const requester = t.requesterId ? get<{ name: string }>('contact', t.requesterId) : undefined
    const session = t.sessionId ? get<SessionData>('session', t.sessionId) : undefined
    const next = t.enabled && !t.done ? (mockNext(t.when, db.now(), 1)[0] ?? null) : null
    return {
      id: t.id,
      kind: t.kind,
      instruction: t.instruction,
      when: t.when,
      timezone: t.timezone,
      description: mockDescribe(t.when, t.timezone),
      enabled: t.enabled,
      done: t.done,
      nextRunAt: next,
      employee: { id: t.employeeId, name: emp?.data.name ?? t.employeeId },
      requester: t.requesterId ? { id: t.requesterId, name: requester?.data.name ?? t.requesterId } : null,
      session: session ? { id: session.id, title: session.data.title, slug: session.data.slug } : null,
      sessionMode: t.sessionMode,
      report: t.report,
      lastRun: t.lastRun,
      fired: t.fired,
      createdAt: t.createdAt,
      canManage: me.access === 'admin' || (me.access === 'member' && !!t.requesterId && t.requesterId === me.contactId),
    }
  }

  const order = (a: ScheduledTask, b: ScheduledTask) => {
    const rank = (x: ScheduledTask) => (x.nextRunAt ? 0 : x.done ? 2 : 1)
    return rank(a) - rank(b) || (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? '') || b.createdAt.localeCompare(a.createdAt)
  }

  const find = (id: string) => stateOf(db).tasks.find((t) => t.id === id)
  const manageable = async (id: string): Promise<MockTask> => {
    const t = find(id)
    if (!t) throw new ApiRequestError(404, 'not_found', `scheduled task ${id} not found`)
    const me = await h.whoami()
    if (me.access === 'viewer' || (me.access !== 'admin' && t.requesterId !== me.contactId))
      throw new ApiRequestError(403, 'denied', 'only admins and the person who asked for it can change a scheduled task')
    return t
  }

  return {
    async schedules(q = {}) {
      const items = await Promise.all(
        stateOf(db)
          .tasks.filter(
            (t) =>
              (!q.employeeId || t.employeeId === q.employeeId) &&
              (!q.kind || t.kind === q.kind) &&
              (!q.sessionId || t.sessionId === q.sessionId),
          )
          .map(view),
      )
      return delay({ items: items.sort(order) })
    },

    async previewSchedule(w) {
      const when = resolveWhen(w, db.now())
      if (typeof when === 'string') return fail(422, 'validation', when)
      const timezone = w.timezone || 'UTC'
      return delay({
        when,
        timezone,
        description: mockDescribe(when, timezone),
        next: mockNext(when, db.now()),
      } satisfies SchedulePreview)
    },

    async createSchedule(body: ScheduleCreateBody) {
      const me = await h.whoami()
      if (me.access === 'viewer') return fail(403, 'denied', 'members and admins create scheduled tasks')
      if (!body.instruction?.trim()) return fail(400, 'bad_request', 'instruction is required')
      if (!get('employee', body.employeeId)) return fail(404, 'not_found', `employee ${body.employeeId} not found`)
      const when = resolveWhen(body.when, db.now())
      if (typeof when === 'string') return fail(422, 'validation', when)
      const s = stateOf(db)
      const channel = body.report?.channelId ? get<{ name: string }>('channel', body.report.channelId) : undefined
      const t: MockTask = {
        id: mockId('tsk', ++s.seq),
        kind: 'task',
        instruction: body.instruction.trim(),
        when,
        timezone: body.timezone || 'UTC',
        enabled: true,
        done: false,
        employeeId: body.employeeId,
        requesterId: me.contactId,
        sessionId: null,
        sessionMode: body.sessionMode ?? 'continue',
        report: channel ? { label: `#${channel.data.name}`, channelId: body.report!.channelId! } : null,
        lastRun: null,
        fired: 0,
        createdAt: new Date(db.now()).toISOString(),
      }
      s.tasks.push(t)
      return delay(await view(t))
    },

    async updateSchedule(id, patch: SchedulePatchBody) {
      const t = await manageable(id)
      if (patch.instruction !== undefined) {
        if (!patch.instruction.trim()) return fail(400, 'bad_request', 'instruction is required')
        t.instruction = patch.instruction.trim()
      }
      if (patch.timezone) t.timezone = patch.timezone
      if (patch.when) {
        const when = resolveWhen(patch.when, db.now())
        if (typeof when === 'string') return fail(422, 'validation', when)
        if (t.kind === 'follow_up' && when.type !== 'once') return fail(422, 'validation', 'a follow-up happens once')
        t.when = when
        if (t.done) {
          t.done = false
          t.enabled = true
        }
      }
      if (patch.enabled !== undefined) {
        if (patch.enabled && t.done) return fail(422, 'validation', 'this one-off already ran: give it a new time to run again')
        t.enabled = patch.enabled
      }
      if (patch.sessionMode) t.sessionMode = patch.sessionMode
      return delay(await view(t))
    },

    async deleteSchedule(id) {
      await manageable(id)
      const s = stateOf(db)
      s.tasks = s.tasks.filter((t) => t.id !== id)
      return delay(undefined)
    },

    async runSchedule(id) {
      const t = await manageable(id)
      if (t.kind !== 'task') return fail(422, 'validation', 'a follow-up comes back to its session on its own')
      t.fired++
      t.lastRun = {
        at: new Date(db.now()).toISOString(),
        state: 'queued',
        manual: true,
        ...(t.sessionId ? { sessionId: t.sessionId } : {}),
      }
      if (t.when.type === 'once') {
        t.done = true
        t.enabled = false
      }
      return delay({ task: await view(t), eventId: mockId('evt', 900 + t.fired) })
    },
  }
}
