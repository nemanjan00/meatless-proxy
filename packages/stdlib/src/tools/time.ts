import { ValidationError } from '@mp/core'
import { ok, str, type Kit } from '../kit.ts'

/** The timezone `time.now` uses when neither the call nor the company setting names one. */
export const DEFAULT_TIMEZONE = 'UTC'

export interface TimeNow {
  /** UTC, e.g. `2026-09-29T12:07:31.000Z`. */
  iso: string
  /** Wall-clock time in `timezone` with its offset, e.g. `2026-09-29T14:07:31+02:00`. */
  local: string
  timezone: string
  /** e.g. `Tuesday`, in `timezone`. */
  weekday: string
  /** Seconds since the epoch. */
  unix: number
}

/** A canonical IANA timezone name, or `ValidationError` for one `Intl` doesn't know. */
export function checkTimezone(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone
  } catch {
    throw new ValidationError(
      `unknown timezone ${JSON.stringify(tz)}: use an IANA name, e.g. Europe/Belgrade or America/New_York`,
    )
  }
}

/** What time `ms` is in `timezone` (an IANA name). */
export function timeIn(ms: number, timezone: string): TimeNow {
  const tz = checkTimezone(timezone)
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
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!)
  const offsetMin = Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000)
  const sign = offsetMin < 0 ? '-' : '+'
  const abs = Math.abs(offsetMin)
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return {
    iso: new Date(ms).toISOString(),
    local: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`,
    timezone: tz,
    weekday: parts.weekday!,
    unix: Math.floor(ms / 1000),
  }
}

export function registerTimeTools(kit: Kit): void {
  kit.tool(
    {
      name: 'time.now',
      description:
        "The current date and time, in the company's timezone or the one you name (IANA, e.g. Europe/Belgrade). Messages and events already carry the time they arrived; use this for the time now, or for another timezone.",
      effect: 'read',
      params: {
        properties: {
          timezone: { type: 'string', description: 'IANA timezone name, e.g. America/New_York. Default: the company timezone.' },
        },
      },
    },
    async (a) => {
      const tz = str(a.timezone) ?? (await kit.deps.defaultTimezone?.()) ?? DEFAULT_TIMEZONE
      return ok(timeIn(kit.deps.clock.now(), tz.trim()))
    },
  )
}
