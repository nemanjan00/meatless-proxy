import type { ScheduledTask, ScheduleWhen } from '@mp/api'
import type { StatusKey } from '@/lib/status.ts'

/** How the Schedules page groups tasks: still to come, paused, and finished one-offs. */
export type ScheduleGroup = 'upcoming' | 'paused' | 'finished'

export function groupOf(t: ScheduledTask): ScheduleGroup {
  if (t.done) return 'finished'
  if (!t.enabled) return 'paused'
  return 'upcoming'
}

export const GROUP_TITLES: Record<ScheduleGroup, string> = {
  upcoming: 'Upcoming',
  paused: 'Paused',
  finished: 'Finished',
}

/** `in 5m`, `in 3h`, `in 2d`, then a short date. */
export function untilPhrase(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—'
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return '—'
  if (ms <= 30_000) return 'now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `in ${h}h`
  const d = Math.round(h / 24)
  if (d < 30) return `in ${d}d`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** The status icon for a task's last run (`missed` shows as failed). */
export function lastRunStatus(t: ScheduledTask): StatusKey | null {
  if (!t.lastRun) return null
  return t.lastRun.state === 'missed' ? 'failed' : t.lastRun.state
}

/** The recurring presets of the form, each a way to build cron. */
export type RecurringPreset = 'day' | 'weekday' | 'week' | 'month' | 'hour' | 'cron'

export const PRESETS: { value: RecurringPreset; label: string }[] = [
  { value: 'weekday', label: 'Every weekday' },
  { value: 'day', label: 'Every day' },
  { value: 'week', label: 'Every week on…' },
  { value: 'month', label: 'Every month on day…' },
  { value: 'hour', label: 'Every hour' },
  { value: 'cron', label: 'Custom (cron)' },
]

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface RecurringForm {
  preset: RecurringPreset
  /** `HH:MM`, for day, weekday, week and month. */
  time: string
  /** 0 = Sunday, for week. */
  weekday: number
  /** 1 to 28, for month. */
  monthDay: number
  cron: string
}

/** The cron expression a recurring form means, or null while it is incomplete. */
export function cronOf(f: RecurringForm): string | null {
  if (f.preset === 'cron') return f.cron.trim() || null
  if (f.preset === 'hour') return '0 * * * *'
  const m = /^(\d{1,2}):(\d{2})$/.exec(f.time)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  const t = `${minute} ${hour}`
  if (f.preset === 'day') return `${t} * * *`
  if (f.preset === 'weekday') return `${t} * * 1-5`
  if (f.preset === 'week') return `${t} * * ${f.weekday}`
  return `${t} ${f.monthDay} * *`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The form for an existing cron expression: its preset when it has one, else custom. */
export function formOfCron(cron: string): RecurringForm {
  const base: RecurringForm = { preset: 'cron', time: '09:00', weekday: 1, monthDay: 1, cron }
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5 || f[3] !== '*') return base
  const [mi, h, dom, , dow] = f as [string, string, string, string, string]
  if (cron.trim() === '0 * * * *') return { ...base, preset: 'hour' }
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(h)) return base
  const time = `${pad(Number(h))}:${pad(Number(mi))}`
  if (dom === '*' && dow === '*') return { ...base, preset: 'day', time }
  if (dom === '*' && dow === '1-5') return { ...base, preset: 'weekday', time }
  if (dom === '*' && /^[0-6]$/.test(dow)) return { ...base, preset: 'week', time, weekday: Number(dow) }
  if (dow === '*' && /^\d+$/.test(dom) && Number(dom) <= 28) return { ...base, preset: 'month', time, monthDay: Number(dom) }
  return base
}

/** `YYYY-MM-DDTHH:MM` of an ISO time in a time zone, for a `datetime-local` input. */
export function localInputOf(iso: string, timezone: string): string {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .formatToParts(new Date(iso))
        .map((p) => [p.type, p.value]),
    )
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
  } catch {
    return iso.slice(0, 16)
  }
}

/** The browser's time zone, the form's default. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** A time in a time zone, for lists: `Fri Oct 2, 16:00`. */
export function formatIn(iso: string, timezone: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return iso
  }
}

/** Whether a `when` is a one-off. */
export const isOnce = (w: ScheduleWhen): w is Extract<ScheduleWhen, { type: 'once' }> => w.type === 'once'
