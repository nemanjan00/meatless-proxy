import { CronExpressionParser } from 'cron-parser'
import { ValidationError } from '@mp/core'

/** When a schedule trigger fires (docs/spec.md#schedules). */
export interface TriggerSchedule {
  /** A cron expression: 5 fields (minute first), 6 fields (seconds first) or a preset such as `@daily`. */
  cron: string
  /** IANA time zone the expression is read in, e.g. `Europe/Berlin`. Default `UTC`. */
  timezone?: string
  /** How late a missed firing may still fire, e.g. after a restart. Default 300. */
  graceSeconds?: number
}

export const DEFAULT_SCHEDULE_TIMEZONE = 'UTC'
export const DEFAULT_GRACE_SECONDS = 300
/** The most firings `nextFirings` returns unless told otherwise. */
export const MAX_FIRINGS = 1000

/** The time-zone name as given (trimmed), or a `ValidationError` when it isn't a known IANA zone. */
function checkTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz.trim()) throw new ValidationError('schedule.timezone must be an IANA time zone name')
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz.trim() })
    return tz.trim()
  } catch {
    throw new ValidationError(`schedule.timezone: unknown time zone ${JSON.stringify(tz)}`)
  }
}

const parse = (s: TriggerSchedule, currentDate: number) =>
  CronExpressionParser.parse(s.cron, { tz: s.timezone ?? DEFAULT_SCHEDULE_TIMEZONE, currentDate: new Date(currentDate) })

/**
 * Validates a schedule and fills in its defaults. Invalid cron expressions,
 * unknown time zones and negative grace periods are a `ValidationError`.
 */
export function checkSchedule(input: unknown): Required<TriggerSchedule> {
  const s = input as TriggerSchedule
  if (!s || typeof s !== 'object' || Array.isArray(s))
    throw new ValidationError('schedule must be { cron, timezone?, graceSeconds? }')
  if (typeof s.cron !== 'string' || !s.cron.trim()) throw new ValidationError('schedule.cron is required')
  const timezone = s.timezone === undefined ? DEFAULT_SCHEDULE_TIMEZONE : checkTimezone(s.timezone)
  const graceSeconds = s.graceSeconds ?? DEFAULT_GRACE_SECONDS
  if (typeof graceSeconds !== 'number' || !Number.isFinite(graceSeconds) || graceSeconds < 0)
    throw new ValidationError('schedule.graceSeconds must be a number >= 0')
  const cron = s.cron.trim().replace(/\s+/g, ' ')
  try {
    // Parsing is lazy about impossible dates (`0 0 30 2 *`), so also look for a first firing.
    parse({ cron, timezone }, 0).next()
  } catch (err) {
    throw new ValidationError(`schedule.cron: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { cron, timezone, graceSeconds }
}

/**
 * Firings after `from` (exclusive) up to `until` (inclusive), oldest first, at most `limit`.
 * Times are epoch milliseconds or ISO strings. On a DST change a wall-clock
 * time that doesn't exist fires at the first valid moment after it, and one
 * that happens twice fires once.
 */
export function nextFirings(
  schedule: TriggerSchedule,
  from: number | string | Date,
  until: number | string | Date,
  limit = MAX_FIRINGS,
): Date[] {
  const start = new Date(from).getTime()
  const end = new Date(until).getTime()
  const out: Date[] = []
  if (!(end > start)) return out
  const it = parse(schedule, start)
  while (out.length < limit) {
    let d: Date
    try {
      d = it.next().toDate()
    } catch {
      break // no further firing
    }
    if (d.getTime() > end) break
    out.push(d)
  }
  return out
}

/** The latest firing at or before `now`, or null when there is none. */
export function latestFiring(schedule: TriggerSchedule, now: number | string | Date): Date | null {
  try {
    return parse(schedule, new Date(now).getTime() + 1)
      .prev()
      .toDate()
  } catch {
    return null
  }
}

/**
 * The firing that is due at `now` for a schedule last handled at `last`: the
 * latest firing in `(last, now]`, if it is at most `graceSeconds` old. Older
 * missed firings are never replayed. Iteration starts from `last` (so a
 * wall-clock time repeated by a DST change isn't fired twice), unless that
 * is more than `MAX_FIRINGS` firings ago.
 */
export function dueFiring(schedule: TriggerSchedule, last: number | string | Date, now: number | string | Date): Date | null {
  const nowMs = new Date(now).getTime()
  const graceMs = (schedule.graceSeconds ?? DEFAULT_GRACE_SECONDS) * 1000
  let firings = nextFirings(schedule, last, nowMs, MAX_FIRINGS + 1)
  if (firings.length > MAX_FIRINGS) {
    const from = Math.max(new Date(last).getTime(), nowMs - graceMs - 1)
    firings = nextFirings(schedule, from, nowMs, Number.MAX_SAFE_INTEGER)
  }
  const latest = firings.at(-1)
  if (!latest || nowMs - latest.getTime() > graceMs) return null
  return latest
}
