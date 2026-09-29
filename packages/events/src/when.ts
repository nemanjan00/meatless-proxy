import { ValidationError } from '@mp/core'

/**
 * Times for scheduled tasks (docs/spec.md#scheduled-tasks): one-off times given as an ISO time,
 * a wall-clock time in a time zone ("2026-10-02 16:00", "tomorrow 09:00", "friday 16:00") or a
 * delay ("in 2 hours"), and recurring ones in a friendly form ("every weekday at 09:00") mapped to
 * cron. And the way back: a readable description of a cron expression.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** The furthest ahead a one-off time or delay may be. */
export const MAX_AHEAD_MS = 400 * DAY

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The canonical name of an IANA time zone, or a `ValidationError`. */
export function checkTimeZone(tz: unknown, what = 'timezone'): string {
  if (typeof tz !== 'string' || !tz.trim())
    throw new ValidationError(`${what} must be an IANA time zone name, e.g. Europe/Belgrade`)
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone
  } catch {
    throw new ValidationError(`${what}: unknown time zone ${JSON.stringify(tz)}; use an IANA name, e.g. Europe/Belgrade`)
  }
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday. */
  weekday: number
}

/** The wall-clock time at `ms` in `tz`. */
export function wallClock(ms: number, tz: string): WallClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'long',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  )
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(String(parts.weekday).toLowerCase()),
  }
}

/** The offset of `tz` from UTC at `ms`, in milliseconds (east positive). */
function offsetAt(ms: number, tz: string): number {
  const w = wallClock(ms, tz)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000
}

/**
 * The moment a wall-clock time in `tz` happens. A time skipped by a daylight-saving change is moved
 * forward by the change; a time that happens twice is its first occurrence.
 */
export function zonedTime(tz: string, year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  // The offsets before and after any change near that day.
  const before = guess - offsetAt(guess - DAY, tz)
  const after = guess - offsetAt(guess + DAY, tz)
  const shows = (ms: number) => {
    const w = wallClock(ms, tz)
    return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute
  }
  const found = [before, after].filter(shows)
  if (found.length) return Math.min(...found)
  return before // skipped by the change: read with the offset before it, which moves it forward
}

/** `Fri 2026-10-02 16:00`, the wall-clock time at `ms` in `tz`. */
export function formatLocal(ms: number, tz: string): string {
  const w = wallClock(ms, tz)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${SHORT_DAYS[w.weekday]} ${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`
}

/** Parses `9:00`, `09:30`, `9am`, `4:30pm`, `16h`. Returns hour and minute, or null. */
export function parseClock(input: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|h)?$/i.exec(input.trim())
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] === undefined ? 0 : Number(m[2])
  const suffix = m[3]?.toLowerCase()
  if (m[2] === undefined && !suffix) return null // a bare number is not a time
  if (suffix === 'am' || suffix === 'pm') {
    if (hour < 1 || hour > 12) return null
    if (suffix === 'am' && hour === 12) hour = 0
    if (suffix === 'pm' && hour !== 12) hour += 12
  }
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
  w: 7 * DAY,
  week: 7 * DAY,
  weeks: 7 * DAY,
}

/**
 * A delay such as `2 hours`, `in 90 minutes`, `1h30m`, `3 days`, `1 week 2 days`, in milliseconds.
 * At least one minute and at most `MAX_AHEAD_MS`. Anything else is a `ValidationError`.
 */
export function parseDuration(input: unknown): number {
  if (typeof input !== 'string' || !input.trim()) throw new ValidationError('give a delay such as "2 hours" or "30 minutes"')
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^in\s+/, '')
    .replace(/\s+and\s+/g, ' ')
    .replace(/,/g, ' ')
  const re = /(\d+(?:\.\d+)?|(?<![a-z])(?:an?|one)(?![a-z]))\s*([a-z]+)/g
  let total = 0
  let consumed = ''
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const n = m[1] === 'a' || m[1] === 'an' || m[1] === 'one' ? 1 : Number(m[1])
    const unit = UNIT_MS[m[2]!]
    if (!unit)
      throw new ValidationError(
        `unknown unit ${JSON.stringify(m[2])} in ${JSON.stringify(input)}: use minutes, hours, days or weeks`,
      )
    total += n * unit
    consumed += m[0]
  }
  if (!total || consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, ''))
    throw new ValidationError(`can't read ${JSON.stringify(input)} as a delay: say e.g. "2 hours", "90 minutes" or "3 days"`)
  if (total < MINUTE) throw new ValidationError('a delay must be at least a minute')
  if (total > MAX_AHEAD_MS) throw new ValidationError('a delay must be at most 400 days')
  return Math.round(total)
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i

/**
 * A one-off time: an ISO time with an offset (`2026-10-02T14:00:00Z`), a wall-clock time in `tz`
 * (`2026-10-02 16:00`, `2026-10-02T16:00`), or a day and a time (`today 17:00`, `tomorrow 9am`,
 * `friday 16:00`, `friday at 4pm`: the next such day, today if the time is still ahead). Returns
 * epoch milliseconds. It must be after `now` and at most `MAX_AHEAD_MS` ahead.
 */
export function parseAt(input: unknown, tz: string, now: number): number {
  if (typeof input !== 'string' || !input.trim())
    throw new ValidationError('give a time such as "2026-10-02 16:00", "tomorrow 09:00" or an ISO time')
  const text = input.trim()
  let ms: number
  const dt = DATE_TIME.exec(text)
  if (HAS_OFFSET.test(text) && /^\d{4}-\d{2}-\d{2}T/i.test(text)) {
    ms = Date.parse(text)
    if (Number.isNaN(ms)) throw new ValidationError(`${JSON.stringify(input)} is not a valid ISO time`)
  } else if (dt) {
    if (dt[4] === undefined) throw new ValidationError(`${JSON.stringify(input)} has no time of day: say e.g. "${text} 09:00"`)
    const [y, mo, d, h, mi, s] = dt.slice(1).map((x) => (x === undefined ? 0 : Number(x))) as number[]
    if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59 || s! > 59)
      throw new ValidationError(`${JSON.stringify(input)} is not a valid date and time`)
    ms = zonedTime(tz, y!, mo!, d!, h!, mi!, s!)
    const back = wallClock(ms, tz)
    if (back.day !== d && back.hour === h) throw new ValidationError(`${JSON.stringify(input)} is not a valid date`)
  } else {
    const m =
      /^(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)(?:\s+at)?\s+(.+)$/i.exec(
        text,
      )
    const clock = m ? parseClock(m[2]!) : null
    if (!m || !clock)
      throw new ValidationError(
        `can't read ${JSON.stringify(input)} as a time: use "2026-10-02 16:00" (in the time zone), "tomorrow 09:00", "friday 16:00", or an ISO time with an offset`,
      )
    const word = m[1]!.toLowerCase()
    const today = wallClock(now, tz)
    const on = (daysAhead: number) => {
      const base = new Date(Date.UTC(today.year, today.month - 1, today.day + daysAhead))
      return zonedTime(tz, base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), clock.hour, clock.minute)
    }
    if (word === 'today') ms = on(0)
    else if (word === 'tomorrow') ms = on(1)
    else {
      const target = WEEKDAYS.findIndex((d) => d.startsWith(word))
      let ahead = (target - today.weekday + 7) % 7
      if (ahead === 0 && on(0) <= now) ahead = 7
      ms = on(ahead)
    }
  }
  if (ms <= now) throw new ValidationError(`${JSON.stringify(input)} has already passed (it is ${formatLocal(now, tz)} in ${tz})`)
  if (ms - now > MAX_AHEAD_MS) throw new ValidationError('a one-off time must be at most 400 days ahead')
  return ms
}

const DAY_ALIASES: Record<string, number> = Object.fromEntries(
  WEEKDAYS.flatMap((d, i) => [
    [d, i],
    [`${d}s`, i],
    [d.slice(0, 3), i],
  ]),
)

const EVERY_HELP =
  'say e.g. "weekday at 09:00", "day at 18:30", "monday at 10:00", "monday, thursday at 9am", "month on the 1st at 09:00", "hour" or "30 minutes", or give a cron expression'

/**
 * A recurring schedule in words, as a 5-field cron expression:
 *
 * | Words                              | Cron           |
 * |------------------------------------|----------------|
 * | `30 minutes`, `minute`             | `*\/30 * * * *` |
 * | `2 hours`, `hour`                  | `0 *\/2 * * *`  |
 * | `day at 18:30`                     | `30 18 * * *`  |
 * | `weekday at 09:00`                 | `0 9 * * 1-5`  |
 * | `weekend at 10am`                  | `0 10 * * 0,6` |
 * | `monday, thursday at 9:00`         | `0 9 * * 1,4`  |
 * | `week on friday at 16:00`          | `0 16 * * 5`   |
 * | `month on the 1st at 09:00`        | `0 9 1 * *`    |
 *
 * A leading "every" is optional. Without a time, days start at 09:00.
 */
export function parseEvery(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new ValidationError(`every is empty: ${EVERY_HELP}`)
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^every\s+/, '')
    .replace(/\s+/g, ' ')
  const fail = (): never => {
    throw new ValidationError(`can't read ${JSON.stringify(input)} as a schedule: ${EVERY_HELP}`)
  }
  // Intervals.
  const interval = /^(\d+ )?(minutes?|mins?|hours?|hrs?)$/.exec(text)
  if (interval) {
    const n = interval[1] ? Number(interval[1]) : 1
    if (interval[2]!.startsWith('m')) {
      if (n < 1 || n > 59) fail()
      return n === 1 ? '* * * * *' : `*/${n} * * * *`
    }
    if (n < 1 || n > 23) fail()
    return n === 1 ? '0 * * * *' : `0 */${n} * * *`
  }
  // "<days> [at <time>]"
  const at = /^(.*?)(?: at | )(\d{1,2}(?:[:.h]\d{2})?\s*(?:am|pm|h)?)$/.exec(text)
  let days = text
  let hour = 9
  let minute = 0
  if (at && parseClock(at[2]!)) {
    const c = parseClock(at[2]!)!
    days = at[1]!.trim()
    hour = c.hour
    minute = c.minute
  }
  const time = `${minute} ${hour}`
  days = days.replace(/^(the )?week on /, '').replace(/^on /, '')
  if (days === 'day' || days === 'daily' || days === 'morning' || days === '') return `${time} * * *`
  if (days === 'weekday' || days === 'weekdays' || days === 'working day' || days === 'workday') return `${time} * * 1-5`
  if (days === 'weekend' || days === 'weekends' || days === 'weekend day') return `${time} * * 0,6`
  const month = /^month(?: on)?(?: the)?(?: day)? ?(\d{1,2})?(?:st|nd|rd|th)?$/.exec(days)
  if (month) {
    const d = month[1] ? Number(month[1]) : 1
    if (d < 1 || d > 28) throw new ValidationError('a monthly schedule runs on day 1 to 28 (every month has those)')
    return `${time} ${d} * *`
  }
  const names = days
    .split(/,| and | & /)
    .map((d) => d.trim())
    .filter(Boolean)
  if (!names.length) fail()
  const nums = names.map((n) => DAY_ALIASES[n])
  if (nums.some((n) => n === undefined)) fail()
  const unique = [...new Set(nums as number[])].sort((a, b) => a - b)
  return `${time} * * ${unique.join(',')}`
}

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th')
  return `${n}${s}`
}

/**
 * A cron expression in words: `every weekday 09:00`, `every Monday, Thursday 09:00`, `every month
 * on the 1st 09:00`, `every 30 minutes`. Shapes it doesn't know come back as `cron <expression>`.
 */
export function describeCron(cron: string): string {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return `cron ${cron.trim()}`
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string]
  if (mon !== '*') return `cron ${cron.trim()}`
  if (h === '*' && dom === '*' && dow === '*') {
    if (mi === '*') return 'every minute'
    const step = /^\*\/(\d+)$/.exec(mi)
    if (step) return `every ${step[1]} minutes`
    if (/^\d+$/.test(mi)) return mi === '0' ? 'every hour' : `every hour at :${mi.padStart(2, '0')}`
  }
  if (/^\d+$/.test(mi) && dom === '*' && dow === '*') {
    if (h === '*') return mi === '0' ? 'every hour' : `every hour at :${mi.padStart(2, '0')}`
    const step = /^\*\/(\d+)$/.exec(h)
    if (step && mi === '0') return `every ${step[1]} hours`
  }
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(h)) return `cron ${cron.trim()}`
  const time = `${h.padStart(2, '0')}:${mi.padStart(2, '0')}`
  if (dom === '*' && dow === '*') return `every day ${time}`
  if (dom === '*') {
    if (dow === '1-5') return `every weekday ${time}`
    if (dow === '0,6' || dow === '6,0') return `every weekend day ${time}`
    if (/^[0-7](,[0-7])*$/.test(dow)) {
      const days = [...new Set(dow.split(',').map((d) => Number(d) % 7))].sort((a, b) => a - b)
      return `every ${days.map((d) => WEEKDAY_NAMES[d]).join(', ')} ${time}`
    }
  }
  if (dow === '*' && /^\d+$/.test(dom)) return `every month on the ${ordinal(Number(dom))} ${time}`
  return `cron ${cron.trim()}`
}
