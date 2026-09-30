import type { EnvContainerStats, Environment, EnvironmentNetwork, EnvironmentStats } from '@mp/api'

/** `1.2 GB`, `310 MB`, `4 KB`, binary units with short names. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Math.max(0, n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** `86%`, `1.4%`, or `—` before the second sample. */
export function formatCpu(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—'
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`
}

/** One line for the network: `No network`, `Direct network`, `Proxy · 3 hosts`. */
export function networkLabel(n: EnvironmentNetwork | null): string {
  if (!n || n.via === 'none') return 'No network'
  if (n.via === 'direct') return 'Direct network'
  const hosts = n.allow?.length ?? 0
  return `Proxy · ${hosts} ${hosts === 1 ? 'host' : 'hosts'}`
}

/** What the environment runs: its profile, else its image. */
export function runsLabel(e: Pick<Environment, 'profile' | 'image'>): string {
  return e.profile ? e.profile : (e.image ?? 'image')
}

/** The image without a registry host or `library/`: `ghcr.io/acme/app:1` → `acme/app:1`. */
export function shortImage(ref: string | undefined): string {
  if (!ref) return 'unknown image'
  const parts = ref.split('/')
  // A first part with a dot or a port is a registry host.
  const rest = parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!) ? parts.slice(1) : parts
  return rest.join('/').replace(/^library\//, '')
}

/** `45s`, `12m`, `3h 20m`, `2d 4h`: a compact length of time. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** How long it has been idle (0 while busy). */
export function idleMs(e: Pick<Environment, 'busy' | 'lastActiveAt'>, now: number): number {
  if (e.busy) return 0
  const t = Date.parse(e.lastActiveAt)
  return Number.isNaN(t) ? 0 : Math.max(0, now - t)
}

/** What Stop idle stops by default: running, not busy, idle at least an hour (the server's default). */
export const STOP_IDLE_MINUTES = 60
export function isIdle(e: Pick<Environment, 'busy' | 'lastActiveAt' | 'status'>, now: number, minutes = STOP_IDLE_MINUTES) {
  return e.status === 'running' && !e.busy && idleMs(e, now) >= minutes * 60_000
}

/** Its session's state in a word: `active`, `waiting`, `done`, `abandoned`, or `left behind` without one. */
export function sessionWord(e: Pick<Environment, 'session'>): string {
  return e.session ? e.session.status : 'left behind'
}

/** `linux/amd64 · 1.9 GB`: the image's platform and size, where known. */
export function imageSummary(e: Pick<Environment, 'imageInfo'>): string {
  const i = e.imageInfo
  if (!i) return ''
  return [i.sizeBytes !== null ? formatBytes(i.sizeBytes) : null, i.platform].filter(Boolean).join(' · ')
}

/** An environment's totals over its containers: CPU and memory summed, the main container's network. */
export function totals(stats: EnvironmentStats | null): {
  cpu: number | null
  memory: number | null
  memoryLimit: number | null
  rx: number | null
  tx: number | null
  pids: number | null
} {
  const cs = stats?.containers ?? []
  if (!cs.length) return { cpu: null, memory: null, memoryLimit: null, rx: null, tx: null, pids: null }
  const sum = (pick: (c: EnvContainerStats) => number | null) => {
    const vals = cs.map(pick).filter((v): v is number => typeof v === 'number')
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null
  }
  const main = cs.find((c) => c.role === 'main') ?? cs[0]!
  return {
    cpu: sum((c) => c.cpuPercent),
    memory: sum((c) => c.memoryBytes),
    // The main container's limit (every container gets the environment's limit).
    memoryLimit: main.memoryLimitBytes,
    // The desktop shares the main container's network namespace: count it once.
    rx: sum((c) => (c.role === 'desktop' ? null : c.netRxBytes)),
    tx: sum((c) => (c.role === 'desktop' ? null : c.netTxBytes)),
    pids: sum((c) => c.pids),
  }
}

/** Whether a container is using most of its memory limit (shown in the warning colour). */
export function memoryHigh(used: number | null, limit: number | null): boolean {
  return !!used && !!limit && used / limit >= 0.85
}
