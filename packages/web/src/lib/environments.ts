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
