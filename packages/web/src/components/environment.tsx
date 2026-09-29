import type { EnvContainerProcesses, Environment, EnvironmentExec, EnvironmentStats, LiveEvent } from '@mp/api'
import {
  ArrowDown,
  ArrowUp,
  Globe,
  Monitor,
  RotateCw,
  ScrollText as ScrollTextIcon,
  Shield,
  ShieldOff,
  Square,
  Terminal,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { type Loaded, useApi, useLive } from '@/lib/api.tsx'
import { formatBytes, formatCpu, memoryHigh, networkLabel, runsLabel, totals } from '@/lib/environments.ts'
import { duration, formatDateTime } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

/** The current time, ticking every `ms` (for uptimes and elapsed times). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/**
 * Applies live `env.stats` (metrics and the running env.exec) to a loaded list of environments, and
 * reloads it on `env.changed`. `channel` is `environments`, or a session's channel for one card.
 */
export function useEnvironmentsLive(list: Loaded<{ items: Environment[] }>, channel: 'environments' | `session:${string}`) {
  const { setData, reload } = list
  useLive(
    [channel],
    useCallback(
      (e: LiveEvent) => {
        if (e.topic === 'env.changed') return reload()
        if (e.topic !== 'env.stats') return
        const { envId, stats, exec } = e.payload
        setData((prev) =>
          prev ? { ...prev, items: prev.items.map((x) => (x.envId === envId ? { ...x, stats, exec } : x)) } : prev,
        )
      },
      [setData, reload],
    ),
    ['env.stats', 'env.changed'],
  )
}

/** CPU, memory, network and processes of the whole environment, in one line. */
export function MetricsInline({ stats, className }: { stats: EnvironmentStats | null; className?: string }) {
  const t = totals(stats)
  if (!stats) return <span className={cn('text-micro text-fg-quaternary', className)}>no metrics yet</span>
  return (
    <span className={cn('flex items-center gap-3 text-micro text-fg-tertiary tabular-nums', className)} data-testid="env-metrics">
      <span className="w-11 text-right" title="CPU (100% = one CPU)">
        {formatCpu(t.cpu)}
      </span>
      <span
        className={cn('w-28 whitespace-nowrap text-right', memoryHigh(t.memory, t.memoryLimit) && 'text-[var(--status-paused)]')}
        title="Memory used / limit"
      >
        {formatBytes(t.memory)}
        {t.memoryLimit ? <span className="text-fg-quaternary"> / {formatBytes(t.memoryLimit)}</span> : null}
      </span>
      <span className="hidden w-36 items-center justify-end gap-1 whitespace-nowrap xl:flex" title="Network received / sent">
        <ArrowDown className="size-3 text-fg-quaternary" />
        {formatBytes(t.rx)}
        <ArrowUp className="ml-1 size-3 text-fg-quaternary" />
        {formatBytes(t.tx)}
      </span>
      <span className="hidden w-12 text-right lg:inline" title="Processes">
        {t.pids ?? '—'} pids
      </span>
    </span>
  )
}

/** Per-container metrics: main, services, and the desktop sidecar. */
export function ContainerMetrics({ stats }: { stats: EnvironmentStats | null }) {
  if (!stats?.containers.length) return <p className="text-fg-quaternary">No metrics yet: they arrive every few seconds.</p>
  return (
    <div className="overflow-x-auto" data-testid="container-metrics">
      <table className="w-full min-w-[520px] text-mini">
        <thead>
          <tr className="h-8 text-left text-micro text-fg-tertiary">
            <th className="font-normal">Container</th>
            <th className="text-right font-normal">CPU</th>
            <th className="text-right font-normal">Memory</th>
            <th className="text-right font-normal">Net ↓</th>
            <th className="text-right font-normal">Net ↑</th>
            <th className="text-right font-normal">PIDs</th>
            <th className="text-right font-normal">Up</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {stats.containers.map((c) => (
            <tr key={c.name} className="h-8 border-t">
              <td className="text-fg-secondary">
                <span className="font-mono text-micro">{c.name}</span>
                {c.role !== 'main' && <span className="ml-1.5 text-tiny text-fg-quaternary">{c.role}</span>}
                {c.state !== 'running' && <span className="ml-1.5 text-tiny text-[var(--red)]">{c.state}</span>}
              </td>
              <td className="text-right">{formatCpu(c.cpuPercent)}</td>
              <td className={cn('text-right', memoryHigh(c.memoryBytes, c.memoryLimitBytes) && 'text-[var(--status-paused)]')}>
                {formatBytes(c.memoryBytes)}
                {c.memoryLimitBytes ? <span className="text-fg-quaternary"> / {formatBytes(c.memoryLimitBytes)}</span> : null}
              </td>
              <td className="text-right" title={c.role === 'desktop' ? "Shares the main container's network" : undefined}>
                {formatBytes(c.netRxBytes)}
              </td>
              <td className="text-right">{formatBytes(c.netTxBytes)}</td>
              <td className="text-right">{c.pids ?? '—'}</td>
              <td className="text-right text-fg-tertiary">{c.startedAt ? duration(c.startedAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-micro text-fg-quaternary">Sampled {formatDateTime(stats.at)}. CPU: 100% is one CPU.</p>
    </div>
  )
}

/** The env.exec running now, with how long it has been running. */
export function ExecLine({ exec, now, className }: { exec: EnvironmentExec | null; now: number; className?: string }) {
  if (!exec) return null
  const cmd = exec.cmd.join(' ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex min-w-0 items-center gap-1.5 rounded-sm border bg-level-2 px-1.5 text-micro text-fg-secondary',
            className,
          )}
          data-testid="env-exec"
        >
          <Terminal className="size-3 shrink-0 text-[var(--status-running)]" />
          <span className="min-w-0 truncate font-mono">{cmd}</span>
          <span className="shrink-0 text-fg-quaternary tabular-nums">{duration(exec.startedAt, undefined, now)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-96 font-mono text-micro">
        env.exec {cmd} · since {formatDateTime(exec.startedAt)}
      </TooltipContent>
    </Tooltip>
  )
}

/** The network icon and label. */
export function NetworkBadge({ env, compact }: { env: Pick<Environment, 'network'>; compact?: boolean }) {
  const n = env.network
  const Icon = !n || n.via === 'none' ? ShieldOff : n.via === 'direct' ? Globe : Shield
  const label = networkLabel(n)
  const detail =
    n?.via === 'proxy'
      ? (n.allow ?? []).join(', ') || 'no hosts'
      : n?.via === 'direct'
        ? 'Unrestricted, not logged'
        : (n?.reason ?? 'No network')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex min-w-0 items-center gap-1 text-micro text-fg-tertiary" data-testid="env-network">
          <Icon className={cn('size-3.5 shrink-0', n?.via === 'direct' && 'text-[var(--status-paused)]')} />
          {!compact && <span className="truncate">{label}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        {label}: {detail}
      </TooltipContent>
    </Tooltip>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-7 grid-cols-[96px_1fr] items-start gap-2 py-1">
      <span className="text-fg-tertiary">{label}</span>
      <span className="min-w-0 text-fg-secondary">{children}</span>
    </div>
  )
}

/** Everything the harness knows about an environment, as properties. */
export function EnvironmentFacts({ env, now, showSession = true }: { env: Environment; now: number; showSession?: boolean }) {
  return (
    <div className="flex flex-col" data-testid="env-facts">
      {showSession && (
        <Fact label="Session">
          {env.session ? (
            <Link to={`/sessions/${env.session.id}`} className="hover:text-foreground hover:underline">
              {env.session.title}
            </Link>
          ) : (
            <span className="text-fg-quaternary">none (left behind)</span>
          )}
        </Fact>
      )}
      {showSession && <Fact label="Employee">{env.employee?.name ?? '—'}</Fact>}
      {env.requester && <Fact label="Requested by">{env.requester.name}</Fact>}
      <Fact label="Runs">
        <span className="font-mono text-micro">{env.profile ? `${env.profile} · ${env.image ?? ''}` : runsLabel(env)}</span>
      </Fact>
      <Fact label="Checkouts">
        {env.checkouts.length ? (
          <span className="flex flex-col">
            {env.checkouts.map((c) => (
              <span key={c.path} className="truncate font-mono text-micro">
                {c.path} <span className="text-fg-quaternary">← {c.key}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="text-fg-quaternary">none</span>
        )}
      </Fact>
      <Fact label="Network">
        <span className="flex flex-col gap-0.5">
          <NetworkBadge env={env} />
          {env.network?.via === 'proxy' && env.network.allow?.length ? (
            <span className="font-mono text-tiny text-fg-quaternary">{env.network.allow.join(', ')}</span>
          ) : null}
          {env.network?.via === 'none' && env.network.reason ? (
            <span className="text-tiny text-fg-quaternary">{env.network.reason}</span>
          ) : null}
        </span>
      </Fact>
      <Fact label="Previews">
        {env.ports.length ? (
          <span className="flex flex-wrap gap-1">
            {env.ports.map((p) =>
              env.session ? (
                <Link
                  key={p}
                  to={`/sessions/${env.session.id}?tab=preview&port=${p}`}
                  className="rounded-sm border px-1 font-mono text-micro hover:text-foreground"
                >
                  :{p}
                </Link>
              ) : (
                <span key={p} className="rounded-sm border px-1 font-mono text-micro">
                  :{p}
                </span>
              ),
            )}
          </span>
        ) : (
          <span className="text-fg-quaternary">none</span>
        )}
      </Fact>
      <Fact label="Desktop">{env.desktop ? 'Yes (Xvfb :99, VNC)' : 'No'}</Fact>
      <Fact label="Started">
        <span title={formatDateTime(env.createdAt)}>
          {formatDateTime(env.createdAt)} · up {duration(env.createdAt, undefined, now)}
        </span>
      </Fact>
      <Fact label="Name">
        <span className="font-mono text-micro">{env.envId}</span>
      </Fact>
    </div>
  )
}

/** The environment's latest logs, refreshed every 3 s while shown. */
function LogsView({ envId }: { envId: string }) {
  const api = useApi()
  const [logs, setLogs] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    let live = true
    const load = () =>
      api.environmentLogs(envId, 300).then(
        (r) => {
          if (!live) return
          setLogs(r.logs)
          setError(null)
        },
        (e: unknown) => live && setError(e instanceof Error ? e : new Error(String(e))),
      )
    load()
    const t = setInterval(load, 3000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [api, envId])
  if (error && logs === null) return <ErrorState error={error} />
  if (logs === null) return <LoadingRows rows={4} />
  return (
    <pre
      className="max-h-[60vh] overflow-auto rounded-md border bg-level-2 p-3 font-mono text-micro whitespace-pre-wrap text-fg-secondary"
      data-testid="env-logs"
    >
      {logs.trim() ? logs : 'No output yet.'}
    </pre>
  )
}

/** What runs in each container, on demand (`docker top`). */
function ProcessesView({ envId }: { envId: string }) {
  const api = useApi()
  const [data, setData] = useState<EnvContainerProcesses[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    setBusy(true)
    try {
      setData((await api.environmentProcesses(envId)).containers)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setBusy(false)
    }
  }, [api, envId])
  useEffect(() => {
    load()
  }, [load])
  return (
    <div className="flex flex-col gap-3" data-testid="env-processes">
      <div className="flex items-center">
        <span className="text-micro text-fg-tertiary">Busiest first, per container.</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={load} disabled={busy} aria-label="Refresh processes">
          <RotateCw className={cn(busy && 'animate-spin')} /> Refresh
        </Button>
      </div>
      {error && !data ? (
        <ErrorState error={error} retry={load} />
      ) : !data ? (
        <LoadingRows rows={4} />
      ) : (
        data.map((c) => (
          <div key={c.name}>
            <div className="mb-1 flex items-center gap-1.5 text-micro text-fg-tertiary">
              <span className="font-mono text-fg-secondary">{c.name}</span>
              {c.role !== 'main' && <span>{c.role}</span>}
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full font-mono text-micro">
                <thead>
                  <tr className="h-7 bg-level-2 text-left text-fg-tertiary">
                    {c.titles.map((t) => (
                      <th key={t} className="px-2 font-normal whitespace-nowrap">
                        {t}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.processes.map((row) => (
                    <tr key={row.join(' ')} className="h-7 border-t text-fg-secondary">
                      {row.map((cell, i) => (
                        <td
                          // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                          key={i}
                          className={cn('px-2 whitespace-nowrap', i === row.length - 1 && 'max-w-80 truncate')}
                          title={i === row.length - 1 ? cell : undefined}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/** The details drawer: logs (live), processes (on demand), metrics per container, and the facts. */
export function EnvironmentSheet({
  env,
  open,
  onOpenChange,
  now,
}: {
  env: Environment | null
  open: boolean
  onOpenChange(open: boolean): void
  now: number
}) {
  const [tab, setTab] = useState('logs')
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-2xl" data-testid="env-sheet">
        {env && (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="flex items-center gap-2 pr-6 text-title1">
                {env.desktop && <Monitor className="size-4 text-fg-tertiary" />}
                <span className="truncate">{env.session?.title ?? env.name}</span>
              </SheetTitle>
              <SheetDescription className="font-mono text-micro text-fg-tertiary">{env.envId}</SheetDescription>
              <ExecLine exec={env.exec} now={now} className="mt-1 max-w-full self-start" />
            </SheetHeader>
            <Tabs value={tab} onValueChange={setTab} className="px-4 pt-3 pb-6">
              <TabsList variant="line" className="h-8 w-full justify-start gap-3 border-b pb-0">
                <TabsTrigger value="logs" className="flex-none px-0">
                  Logs
                </TabsTrigger>
                <TabsTrigger value="processes" className="flex-none px-0">
                  Processes
                </TabsTrigger>
                <TabsTrigger value="metrics" className="flex-none px-0">
                  Metrics
                </TabsTrigger>
                <TabsTrigger value="details" className="flex-none px-0">
                  Details
                </TabsTrigger>
              </TabsList>
              <TabsContent value="logs" className="pt-3">
                {tab === 'logs' && <LogsView envId={env.envId} />}
              </TabsContent>
              <TabsContent value="processes" className="pt-3">
                {tab === 'processes' && <ProcessesView envId={env.envId} />}
              </TabsContent>
              <TabsContent value="metrics" className="pt-3">
                <ContainerMetrics stats={env.stats} />
              </TabsContent>
              <TabsContent value="details" className="pt-3">
                <EnvironmentFacts env={env} now={now} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Asks before stopping an environment, then stops it like env.down. */
export function StopEnvironmentDialog({
  env,
  onOpenChange,
  onStopped,
}: {
  env: Environment | null
  onOpenChange(open: boolean): void
  onStopped(env: Environment): void
}) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const stop = async () => {
    if (!env) return
    setBusy(true)
    try {
      await api.stopEnvironment(env.envId)
      toast('Environment stopped', { description: env.session ? `${env.session.title}: noted in its history` : env.envId })
      onStopped(env)
      onOpenChange(false)
    } catch (e) {
      toast.error("Couldn't stop it", { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!env} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-title1">Stop this environment?</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            Its containers, network and volumes are removed, like env.down. Anything running in it stops, and the session's
            history notes that you stopped it. The employee can start a new one with env.up.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={stop} disabled={busy}>
            <Square /> {busy ? 'Stopping…' : 'Stop environment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The full desktop viewer in a large dialog. */
export function DesktopDialog({
  env,
  onOpenChange,
  children,
}: {
  env: Environment | null
  onOpenChange(open: boolean): void
  children: ReactNode
}) {
  return (
    <Dialog open={!!env} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[1180px] sm:max-w-[1180px]" data-testid="desktop-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-title1">
            <Monitor className="size-4 text-fg-tertiary" />
            <span className="truncate">{env?.session?.title ?? env?.name}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-micro text-fg-tertiary">{env?.envId}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/**
 * A session's environment in its properties panel: what it runs, its network, uptime, the env.exec
 * in progress, live metrics, and Logs, Desktop and Stop.
 */
export function EnvironmentCard({
  env,
  now,
  onLogs,
  onDesktop,
  onStop,
}: {
  env: Environment
  now: number
  onLogs(): void
  onDesktop?(): void
  onStop(): void
}) {
  const t = totals(env.stats)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-background/40 p-3" data-testid="env-card">
      <div className="flex min-w-0 items-center gap-2">
        {env.desktop ? <Monitor className="size-3.5 text-fg-tertiary" /> : <Terminal className="size-3.5 text-fg-tertiary" />}
        <span className="min-w-0 truncate font-mono text-micro text-fg-secondary" title={env.image}>
          {runsLabel(env)}
        </span>
        <span className="ml-auto shrink-0 text-micro text-fg-quaternary tabular-nums">
          up {duration(env.createdAt, undefined, now)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <NetworkBadge env={env} />
        {env.ports.length > 0 && (
          <span className="font-mono text-micro text-fg-tertiary">{env.ports.map((p) => `:${p}`).join(' ')}</span>
        )}
        {env.desktop && <span className="text-micro text-fg-tertiary">desktop</span>}
      </div>
      {env.checkouts.length > 0 && (
        <div
          className="truncate font-mono text-tiny text-fg-quaternary"
          title={env.checkouts.map((c) => `${c.path} ← ${c.key}`).join('\n')}
        >
          {env.checkouts.map((c) => c.path).join(' · ')}
        </div>
      )}
      <ExecLine exec={env.exec} now={now} className="max-w-full self-start" />
      <div className="grid grid-cols-3 gap-2 pt-1 text-micro tabular-nums" data-testid="env-card-metrics">
        <span className="flex flex-col">
          <span className="text-fg-quaternary">CPU</span>
          <span className="text-fg-secondary">{formatCpu(t.cpu)}</span>
        </span>
        <span className="flex flex-col">
          <span className="text-fg-quaternary">Memory</span>
          <span className={cn('text-fg-secondary', memoryHigh(t.memory, t.memoryLimit) && 'text-[var(--status-paused)]')}>
            {formatBytes(t.memory)}
          </span>
        </span>
        <span className="flex flex-col">
          <span className="text-fg-quaternary">PIDs</span>
          <span className="text-fg-secondary">{t.pids ?? '—'}</span>
        </span>
      </div>
      <div className="-mx-1 flex flex-wrap items-center gap-0.5 pt-1">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onLogs}>
          <ScrollTextIcon /> Logs
        </Button>
        {env.desktop && onDesktop && (
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onDesktop}>
            <Monitor /> Desktop
          </Button>
        )}
        {env.canStop && (
          <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 hover:text-[var(--red)]" onClick={onStop}>
            <Square /> Stop
          </Button>
        )}
      </div>
    </div>
  )
}
