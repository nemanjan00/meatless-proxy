/** Formatting helpers shared by pages. Pure functions; `now` is injectable for tests. */

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}M`
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** "now", "5s", "3m", "2h", "4d", then a short date. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d`
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Duration between two timestamps, e.g. `1m 20s`. */
export function duration(fromIso: string | undefined, toIso?: string, now: number = Date.now()): string {
  if (!fromIso) return '—'
  const ms = (toIso ? Date.parse(toIso) : now) - Date.parse(fromIso)
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Shortens an id for display: `ses_01JAZ…0042` → `ses_…0042`. */
export function shortId(id: string): string {
  const i = id.indexOf('_')
  if (i < 0 || id.length < i + 8) return id
  return `${id.slice(0, i)}_…${id.slice(-4)}`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase()
}

export function pluralize(n: number, word: string, plural = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`
}

/** `14:05` for today, `Sep 15` otherwise. */
export function clockOrDate(iso: string, now: number = Date.now()): string {
  const d = new Date(iso)
  const n = new Date(now)
  return d.toDateString() === n.toDateString()
    ? formatTime(iso)
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
