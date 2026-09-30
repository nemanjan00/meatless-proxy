import type { Environment } from '@mp/api'
import { Container, ExternalLink, Hammer, Monitor, ScrollText, Square, TimerOff } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DesktopThumbnail, DesktopViewer } from '@/components/desktop-viewer.tsx'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import {
  DesktopDialog,
  EnvironmentSheet,
  ExecLine,
  MetricsInline,
  NetworkBadge,
  StopEnvironmentDialog,
  StopIdleDialog,
  useEnvironmentsLive,
  useNow,
} from '@/components/environment.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { formatBytes, idleMs, imageSummary, isIdle, sessionWord, shortDuration, shortImage } from '@/lib/environments.ts'
import { duration, formatDateTime, pluralize } from '@/lib/format.ts'
import { type StatusKey, sessionStatusKey } from '@/lib/status.ts'
import { cn } from '@/lib/utils.ts'

const ALL = 'all'

/** An environment's status icon: its session's (running, waiting, …), or stopped. */
function envStatus(env: Environment): StatusKey {
  if (env.status !== 'running') return 'cancelled'
  if (!env.session) return 'idle'
  return sessionStatusKey(env.session.status, env.session.runState)
}

/** A small icon button with a tooltip, for row actions. */
function RowAction({
  label,
  onClick,
  children,
  danger,
}: {
  label: string
  onClick(): void
  children: ReactNode
  danger?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md text-fg-tertiary transition-quick hover:bg-level-3 hover:text-foreground [&_svg]:size-4',
            danger && 'hover:text-[var(--red)]',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export interface EnvActions {
  logs(env: Environment): void
  desktop(env: Environment): void
  stop(env: Environment): void
}

/** Opens the app's live preview on the session page (it mints a token for whoever opens it). */
const previewHref = (env: Environment) => (env.session ? `/sessions/${env.session.id}?tab=preview&port=${env.ports[0]}` : null)

/** Shown as idle once it has been quiet this long. */
const IDLE_SHOWN_MS = 10 * 60_000

/** The image in a row: the profile (or build) badge, the image, its size, and on wide screens what the profile is for. */
function ImageChip({ env }: { env: Environment }) {
  const size = env.imageInfo?.sizeBytes ?? null
  const summary = imageSummary(env)
  const blurb = env.profileDescription ?? env.build
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="hidden min-w-0 max-w-80 items-center gap-1.5 md:inline-flex 2xl:max-w-[36rem]" data-testid="env-image">
          {env.profile ? (
            <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-secondary" data-testid="env-profile">
              {env.profile}
            </span>
          ) : env.build ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm border px-1 text-tiny text-fg-secondary">
              <Hammer className="size-2.5" />
              build
            </span>
          ) : null}
          <span className="min-w-0 truncate font-mono text-micro text-fg-tertiary">{shortImage(env.image)}</span>
          {size !== null && <span className="shrink-0 text-micro text-fg-quaternary tabular-nums">{formatBytes(size)}</span>}
          {blurb && <span className="hidden min-w-0 truncate text-micro text-fg-quaternary 2xl:inline">{blurb}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex max-w-96 flex-col gap-0.5">
        <span className="font-mono">{env.image ?? 'unknown image'}</span>
        {env.profile && (
          <span>
            Profile {env.profile}
            {env.profileDescription ? `: ${env.profileDescription}` : ''}
          </span>
        )}
        {env.build && (
          <span>
            {env.build}
            {env.imageInfo?.base ? `, on ${env.imageInfo.base}` : ''}
          </span>
        )}
        {summary && <span>{summary}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/** Its session's state and how long it has been idle: `done · idle 23h`. */
function EnvState({ env, now, className }: { env: Environment; now: number; className?: string }) {
  const idle = idleMs(env, now)
  const word = sessionWord(env)
  const parts = [...(word === 'active' ? [] : [word]), ...(idle >= IDLE_SHOWN_MS ? [`idle ${shortDuration(idle)}`] : [])]
  if (!parts.length && env.busy) parts.push('working')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('truncate text-right text-micro text-fg-tertiary', className)} data-testid="env-state">
          {parts.join(' · ') || 'active'}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {env.session ? `Session ${env.session.status}` : 'No session points at it any more'}
        {env.busy
          ? ': working now'
          : `. Idle ${shortDuration(idle)}, since ${formatDateTime(env.lastActiveAt)} (its last env.exec or run)`}
      </TooltipContent>
    </Tooltip>
  )
}

function EnvironmentRow({ env, now, actions }: { env: Environment; now: number; actions: EnvActions }) {
  const preview = env.ports.length ? previewHref(env) : null
  const started = env.startedAt ?? env.createdAt
  return (
    <div
      className="group flex h-9 min-w-0 items-center gap-3 px-4 transition-quick hover:bg-secondary sm:px-6"
      data-testid="env-row"
    >
      <StatusIcon status={envStatus(env)} />
      {env.session ? (
        <Link
          to={`/sessions/${env.session.id}`}
          className="min-w-0 flex-1 truncate text-fg-secondary hover:text-foreground md:max-w-[40%] md:flex-initial"
          data-testid="env-title"
        >
          {env.session.title}
        </Link>
      ) : (
        <span
          className="min-w-0 flex-1 truncate font-mono text-micro text-fg-tertiary md:max-w-[40%] md:flex-initial"
          data-testid="env-title"
        >
          {env.name}
        </span>
      )}
      <ImageChip env={env} />
      {env.desktop && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Monitor className="size-3.5 shrink-0 text-fg-tertiary" aria-label="Has a desktop" />
          </TooltipTrigger>
          <TooltipContent>Desktop (Xvfb and VNC)</TooltipContent>
        </Tooltip>
      )}
      <ExecLine exec={env.exec} now={now} className="hidden max-w-72 sm:inline-flex" />
      <span className="ml-auto flex shrink-0 items-center gap-3 sm:gap-4">
        {env.ports.length > 0 && (
          <span className="hidden font-mono text-micro text-fg-tertiary 2xl:inline">
            {env.ports.map((p) => `:${p}`).join(' ')}
          </span>
        )}
        <span className="hidden md:inline-flex">
          <NetworkBadge env={env} compact />
        </span>
        <MetricsInline stats={env.stats} className="hidden md:flex" />
        <EnvState env={env} now={now} className="hidden w-28 sm:inline" />
        <Tooltip>
          <TooltipTrigger asChild>
            <time dateTime={started} className="hidden w-14 text-right text-micro text-fg-quaternary tabular-nums sm:inline">
              {duration(started, undefined, now)}
            </time>
          </TooltipTrigger>
          <TooltipContent>Started {formatDateTime(started)}</TooltipContent>
        </Tooltip>
        {env.employee && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="hidden w-4 sm:inline-flex">
                <EmployeeAvatar name={env.employee.name} className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{env.employee.name}</TooltipContent>
          </Tooltip>
        )}
        <span className="flex shrink-0 items-center justify-end sm:w-28" data-testid="env-actions">
          <RowAction label="Logs and details" onClick={() => actions.logs(env)}>
            <ScrollText />
          </RowAction>
          {preview && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to={preview}
                  aria-label="Open preview"
                  className="inline-flex size-7 items-center justify-center rounded-md text-fg-tertiary transition-quick hover:bg-level-3 hover:text-foreground [&_svg]:size-4"
                >
                  <ExternalLink />
                </Link>
              </TooltipTrigger>
              <TooltipContent>Open preview</TooltipContent>
            </Tooltip>
          )}
          {env.desktop && (
            <RowAction label="Open desktop" onClick={() => actions.desktop(env)}>
              <Monitor />
            </RowAction>
          )}
          {env.canStop && (
            <RowAction label="Stop environment" onClick={() => actions.stop(env)} danger>
              <Square />
            </RowAction>
          )}
        </span>
      </span>
    </div>
  )
}

/** A desktop environment as a card: its live thumbnail, which opens the viewer. */
function DesktopCard({ env, now, onOpen }: { env: Environment; now: number; onOpen(): void }) {
  return (
    <div className="flex w-full flex-col gap-1.5 sm:w-56" data-testid="desktop-card">
      <DesktopThumbnail env={env} onOpen={onOpen} />
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusIcon status={envStatus(env)} className="size-3.5" />
        <span className="min-w-0 truncate text-fg-secondary">{env.session?.title ?? env.name}</span>
      </div>
      <div className="flex items-center gap-2 text-micro text-fg-tertiary">
        {env.employee && <span className="truncate">{env.employee.name}</span>}
        <span className="ml-auto shrink-0 tabular-nums text-fg-quaternary">up {duration(env.createdAt, undefined, now)}</span>
      </div>
    </div>
  )
}

/**
 * `/environments`: every running environment the viewer may see (their sessions' rule), with live
 * metrics, what's running in it, its logs and processes, its desktop, and Stop.
 */
export function EnvironmentsPage() {
  const [params, setParams] = useSearchParams()
  const { employees, currentId } = useEmployees()
  // The page's own ?employee= wins; without it the list follows the sidebar's employee switcher.
  const employeeValue = params.get('employee') ?? currentId ?? ALL
  const employeeId = employeeValue === ALL ? undefined : employeeValue
  const desktopOnly = params.get('desktop') === '1'
  const now = useNow(1000)
  const list = useLoad(
    (api) => api.environments({ ...(employeeId ? { employeeId } : {}), ...(desktopOnly ? { desktop: true } : {}) }),
    [employeeId, desktopOnly],
  )
  useEnvironmentsLive(list, 'environments')
  const [logsOf, setLogsOf] = useState<string | null>(null)
  const [desktopOf, setDesktopOf] = useState<string | null>(null)
  const [stopOf, setStopOf] = useState<string | null>(null)
  const [stopIdle, setStopIdle] = useState(false)
  const admin = useAuth().can('admin')
  const items = list.data?.items ?? []
  const byId = (id: string | null) => (id ? (items.find((e) => e.envId === id) ?? null) : null)

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }
  const filtersSet = params.has('employee') || desktopOnly

  const groups = useMemo(() => {
    const m = new Map<string, { label: string; rows: Environment[] }>()
    for (const e of items) {
      const key = e.employee?.id ?? '-'
      if (!m.has(key)) m.set(key, { label: e.employee?.name ?? 'No session', rows: [] })
      m.get(key)!.rows.push(e)
    }
    return [...m.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))
  }, [items])
  const desktops = items.filter((e) => e.desktop && e.status === 'running')
  const idleCount = items.filter((e) => isIdle(e, now)).length
  const actions: EnvActions = {
    logs: (e) => setLogsOf(e.envId),
    desktop: (e) => setDesktopOf(e.envId),
    stop: (e) => setStopOf(e.envId),
  }
  const desktopEnv = byId(desktopOf)

  return (
    <Page
      title="Environments"
      icon={<Container />}
      filters={
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2" data-testid="env-filters">
          <Select value={employeeValue} onValueChange={(v) => update({ employee: v })}>
            <SelectTrigger
              size="sm"
              aria-label="Employee"
              className={cn('h-7 max-w-52 gap-1.5 px-2 text-mini data-[size=sm]:h-7', employeeValue !== ALL && 'text-foreground')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value={ALL}>All employees</SelectItem>
              {employees.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  <EmployeeAvatar name={e.data.name} className="size-3.5" />
                  {e.data.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label htmlFor="env-desktop-only" className="flex h-7 items-center gap-1.5 text-micro text-fg-tertiary">
            <Checkbox
              id="env-desktop-only"
              checked={desktopOnly}
              onCheckedChange={(v) => update({ desktop: v === true ? '1' : null })}
              aria-label="With desktop"
            />
            With desktop
          </label>
          {filtersSet && (
            <button
              type="button"
              onClick={() => update({ employee: null, desktop: null })}
              className="h-7 px-1 text-micro text-[#828fff] hover:underline"
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto text-micro text-fg-quaternary tabular-nums" data-testid="env-count">
            {list.data ? pluralize(items.length, 'environment') : ''}
          </span>
          {admin && list.data && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-micro"
              onClick={() => setStopIdle(true)}
              disabled={idleCount === 0}
              title="Stop every environment that has been idle for an hour or more"
            >
              <TimerOff /> Stop idle{idleCount ? ` (${idleCount})` : ''}
            </Button>
          )}
        </div>
      }
    >
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : items.length === 0 ? (
        filtersSet ? (
          <EmptyState
            text="No environments match these filters."
            action={
              <button
                type="button"
                className="text-[#828fff] hover:underline"
                onClick={() => update({ employee: null, desktop: null })}
              >
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState text="No environments are running. Employees start one with env.up." />
        )
      ) : (
        <div className="pb-10">
          {desktops.length > 0 && (
            <section className="border-b px-4 py-3 sm:px-6" data-testid="desktops">
              <h2 className="mb-2 flex items-center gap-2 text-micro font-medium text-fg-secondary">
                <Monitor className="size-3.5 text-fg-tertiary" />
                Desktops
                <span className="tabular-nums text-fg-quaternary">{desktops.length}</span>
              </h2>
              <div className="flex flex-wrap gap-4">
                {desktops.map((e) => (
                  <DesktopCard key={e.envId} env={e} now={now} onOpen={() => setDesktopOf(e.envId)} />
                ))}
              </div>
            </section>
          )}
          {groups.map(([key, g]) => (
            <section key={key} className="border-b last:border-b-0">
              <h2 className="sticky top-0 z-10 flex h-9 items-center gap-2 bg-level-1 px-4 text-micro font-medium text-fg-secondary sm:px-6">
                <EmployeeAvatar name={g.label} className="size-4" />
                <span className="min-w-0 truncate">{g.label}</span>
                <span className="tabular-nums text-fg-quaternary">{g.rows.length}</span>
                <span className="ml-auto hidden items-center gap-4 font-normal text-fg-quaternary md:flex" aria-hidden>
                  <span className="flex gap-3">
                    <span className="w-11 text-right">CPU</span>
                    <span className="w-28 text-right">Memory</span>
                    <span className="hidden w-36 text-right xl:inline">Network</span>
                    <span className="hidden w-12 text-right lg:inline">PIDs</span>
                  </span>
                  <span className="w-28 text-right">State</span>
                  <span className="w-14 text-right">Up</span>
                  {/* Space for the employee avatar and the actions. */}
                  <span className="w-4" />
                  <span className="w-28" />
                </span>
              </h2>
              {g.rows.map((e) => (
                <EnvironmentRow key={e.envId} env={e} now={now} actions={actions} />
              ))}
            </section>
          ))}
        </div>
      )}
      <EnvironmentSheet env={byId(logsOf)} open={!!byId(logsOf)} onOpenChange={(o) => !o && setLogsOf(null)} now={now} />
      <DesktopDialog env={desktopEnv} onOpenChange={(o) => !o && setDesktopOf(null)}>
        {desktopEnv && <DesktopViewer env={desktopEnv} />}
      </DesktopDialog>
      <StopEnvironmentDialog env={byId(stopOf)} onOpenChange={(o) => !o && setStopOf(null)} onStopped={() => list.reload()} />
      <StopIdleDialog open={stopIdle} onOpenChange={setStopIdle} onStopped={() => list.reload()} />
    </Page>
  )
}
