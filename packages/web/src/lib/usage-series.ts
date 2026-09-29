import type { UsageSeries } from '@mp/api'

/**
 * Helpers for usage over time: parse the API's bucket keys (full ISO
 * timestamps from the server, `2026-09-29` / `2026-09-29T14:00` from the
 * mock), fill empty buckets with 0 so the chart has a real x axis, and label
 * buckets for axes and tooltips. Buckets are UTC hours or UTC days.
 */
export type Interval = 'hour' | 'day'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A bucket key → its start in ms (UTC). NaN when unparseable. */
export function bucketTime(t: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Date.parse(`${t}T00:00:00Z`)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}(:00)?$/.test(t)) return Date.parse(`${t.slice(0, 13)}:00:00Z`)
  return Date.parse(t)
}

/** The start of the bucket a time falls into. */
export function floorBucket(ms: number, interval: Interval): number {
  const step = interval === 'hour' ? HOUR : DAY
  return Math.floor(ms / step) * step
}

/**
 * Every bucket from `since` up to `until` (inclusive of the bucket `until` is
 * in), with the series' values and 0 elsewhere. Keys become ISO timestamps.
 * Points outside the range are kept, so nothing is lost.
 */
export function fillSeries(series: UsageSeries, since: number, until: number): UsageSeries {
  const step = series.interval === 'hour' ? HOUR : DAY
  const byTime = new Map<number, UsageSeries['points'][number]>()
  for (const p of series.points) {
    const t = bucketTime(p.t)
    if (!Number.isNaN(t)) byTime.set(floorBucket(t, series.interval), p)
  }
  const start = floorBucket(since, series.interval)
  const end = floorBucket(until, series.interval)
  const times = new Set<number>()
  for (let t = start; t <= end; t += step) times.add(t)
  for (const t of byTime.keys()) times.add(t)
  const points = [...times]
    .sort((a, b) => a - b)
    .map((t) => {
      const src = byTime.get(t)
      const out: UsageSeries['points'][number] = { t: new Date(t).toISOString() }
      for (const k of series.keys) out[k.key] = Number(src?.[k.key] ?? 0)
      return out
    })
  return { ...series, points }
}

/** Axis label: `14:00` for hours (local time), `Sep 29` for days (UTC, as bucketed). */
export function bucketLabel(t: string, interval: Interval): string {
  const ms = bucketTime(t)
  if (Number.isNaN(ms)) return t
  const d = new Date(ms)
  if (interval === 'day') return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Tooltip label: `Sep 29, 14:00–15:00` for hours, `Tue, Sep 29` for days. */
export function bucketTitle(t: string, interval: Interval): string {
  const ms = bucketTime(t)
  if (Number.isNaN(ms)) return t
  const d = new Date(ms)
  if (interval === 'day')
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  const hm = (x: Date) => x.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${hm(d)}–${hm(new Date(ms + HOUR))}`
}

/** The bucket size for a range: hours up to two days, days beyond. */
export function intervalFor(hours: number): Interval {
  return hours <= 48 ? 'hour' : 'day'
}

/** Breakdown rows keyed by bucket (`groupBy` hour or day) → every bucket from `since` to `until`, empty ones as 0. */
export function fillRows<R extends { key: string; total: number }>(
  rows: R[],
  interval: Interval,
  since: number,
  until: number,
): { key: string; label: string; total: number }[] {
  const filled = fillSeries(
    { interval, keys: [{ key: 'total', label: 'Tokens' }], points: rows.map((r) => ({ t: r.key, total: r.total })) },
    since,
    until,
  )
  return filled.points.map((p) => ({ key: p.t, label: p.t, total: Number(p.total ?? 0) }))
}
