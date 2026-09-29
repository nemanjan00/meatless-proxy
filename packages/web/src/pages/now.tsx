import type { LiveEvent, NowItem, NowSnapshot, RunState } from '@mp/api'
import { Activity, Brain, CirclePause, CirclePlay, Hourglass, Link2, Wrench, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Progress } from '@/components/ui/progress.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLive, useLiveReload, useLoad } from '@/lib/api.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { duration, formatCost, formatTokens, timeAgo } from '@/lib/format.ts'
import { STATUS } from '@/lib/status.ts'
import { cn } from '@/lib/utils.ts'

const GROUPS: { state: RunState; title: string }[] = [
  { state: 'running', title: 'Running' },
  { state: 'suspended', title: 'Waiting' },
  { state: 'paused', title: 'Paused' },
  { state: 'queued', title: 'Queued' },
]

/** Applies a live event to the Now snapshot. Returns the same object when nothing changed. */
export function applyNowEvent(snap: NowSnapshot, e: LiveEvent): NowSnapshot {
  const p = e.payload as { runId?: string }
  if (!p.runId) return snap
  const i = snap.items.findIndex((x) => x.run.id === p.runId)
  if (i < 0) return snap
  const item = { ...snap.items[i]! }
  switch (e.topic) {
    case 'model.delta': {
      const s = item.streaming ?? { content: '', reasoning: '' }
      item.streaming = { content: s.content + (e.payload.content ?? ''), reasoning: s.reasoning + (e.payload.reasoning ?? '') }
      break
    }
    case 'step.started':
      item.step = { kind: e.payload.kind, label: e.payload.name ?? 'Thinking', since: e.at }
      if (e.payload.kind === 'model') item.streaming = { content: '', reasoning: '' }
      break
    case 'tool.called':
      item.recentTools = [...item.recentTools, { name: e.payload.name, at: e.at }].slice(-6)
      break
    case 'tool.result':
      item.recentTools = item.recentTools.map((t, j) =>
        j === item.recentTools.length - 1 && t.name === e.payload.name ? { ...t, isError: e.payload.isError } : t,
      )
      break
    case 'usage.recorded': {
      const u = e.payload.usage
      const t = item.tokens
      item.tokens = {
        ...t,
        input: t.input + u.input,
        output: t.output + u.output,
        cached: t.cached + u.cached,
        reasoning: t.reasoning + (u.reasoning ?? 0),
        total: t.total + u.input + u.output,
        cost: t.cost + e.payload.cost,
        calls: t.calls + 1,
      }
      break
    }
    case 'checklist.changed': {
      const items = e.payload.checklist.data.items
      item.checklist = { done: items.filter((x) => x.checked).length, total: items.length }
      break
    }
    default:
      return snap
  }
  const items = [...snap.items]
  items[i] = item
  return { ...snap, items }
}

function Tokens({ item }: { item: NowItem }) {
  const t = item.tokens
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="tabular-nums text-fg-tertiary">
          <span className="text-fg-secondary">{formatTokens(t.total)}</span> tok · {formatCost(t.cost)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-micro">
        in {formatTokens(t.input)} (cached {formatTokens(t.cached)}) · out {formatTokens(t.output)} · reasoning{' '}
        {formatTokens(t.reasoning)} · {t.calls} calls
      </TooltipContent>
    </Tooltip>
  )
}

function StepLine({ item }: { item: NowItem }) {
  const Icon =
    item.step.kind === 'tool' ? Wrench : item.step.kind === 'model' ? Brain : item.step.kind === 'waiting' ? Hourglass : Activity
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-fg-secondary">
      <Icon className="size-3.5 shrink-0 text-fg-tertiary" />
      <span className={cn('truncate', item.step.kind === 'tool' && 'font-mono text-micro')}>{item.step.label}</span>
      <span className="shrink-0 text-fg-quaternary">· {duration(item.step.since)}</span>
    </div>
  )
}

function RunActions({ item, onChanged }: { item: NowItem; onChanged(): void }) {
  const api = useApi()
  const act = async (what: 'pause' | 'resume' | 'cancel') => {
    const id = item.run.id
    if (what === 'pause') await api.pauseRun(id)
    else if (what === 'resume') await api.resumeRun(id)
    else await api.cancelRun(id)
    toast(`${what === 'pause' ? 'Paused' : what === 'resume' ? 'Resumed' : 'Cancelled'} ${item.session.data.title}`)
    onChanged()
  }
  const paused = item.run.data.state === 'paused'
  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-quick group-hover:opacity-100 group-focus-within:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={paused ? 'Resume' : 'Pause'}
            onClick={() => act(paused ? 'resume' : 'pause')}
          >
            {paused ? <CirclePlay /> : <CirclePause />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{paused ? 'Resume run' : 'Pause at the next step'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Cancel" onClick={() => act('cancel')}>
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Cancel run</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" asChild aria-label="Lineage">
            <Link to={`/lineage/${item.run.id}`}>
              <Link2 />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Where it came from</TooltipContent>
      </Tooltip>
    </div>
  )
}

function RunningCard({ item, onChanged }: { item: NowItem; onChanged(): void }) {
  const s = item.session.data
  const stream = item.streaming
  return (
    <article className="group flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card p-3.5" data-testid="now-card">
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon status={item.run.data.state} />
        <Link to={`/sessions/${item.session.id}`} className="min-w-0 truncate font-medium text-foreground hover:underline">
          {s.title}
        </Link>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <RunActions item={item} onChanged={onChanged} />
          <Tokens item={item} />
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-micro text-fg-tertiary">
        <EmployeeAvatar name={item.employee.name} className="size-4" />
        <span className="truncate">
          {item.employee.name} · <span className="font-mono">#{s.slug}</span> · {item.run.data.mode} · started{' '}
          {timeAgo(item.run.data.startedAt)} ago
        </span>
      </div>
      <StepLine item={item} />
      <div className="min-h-[3.25rem] rounded-lg border bg-level-2 px-3 py-2 font-mono text-micro leading-relaxed">
        {stream && (stream.reasoning || stream.content) ? (
          <>
            {stream.reasoning && <p className="whitespace-pre-wrap text-fg-quaternary italic">{stream.reasoning}</p>}
            {stream.content && <p className="stream-caret mt-1 whitespace-pre-wrap text-fg-secondary">{stream.content}</p>}
            {!stream.content && <span className="stream-caret" />}
          </>
        ) : (
          <p className="text-fg-quaternary">{item.step.kind === 'tool' ? `Waiting for ${item.step.label}…` : 'No output yet'}</p>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-3">
        {item.checklist && (
          <div className="flex w-40 shrink-0 items-center gap-2 text-micro text-fg-tertiary">
            <Progress value={(item.checklist.done / Math.max(1, item.checklist.total)) * 100} className="h-1" />
            <span className="tabular-nums">
              {item.checklist.done}/{item.checklist.total}
            </span>
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden">
          {item.recentTools.slice(-4).map((t, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: tool calls repeat
              key={`${t.name}-${i}`}
              className={cn(
                'truncate rounded-sm border px-1.5 font-mono text-tiny text-fg-tertiary',
                t.isError && 'border-[var(--red)]/40 text-[var(--red)]',
              )}
            >
              {t.name}
            </span>
          ))}
        </div>
      </div>
    </article>
  )
}

function IdleRow({ item, onChanged }: { item: NowItem; onChanged(): void }) {
  const s = item.session.data
  return (
    <div className="group flex h-9 min-w-0 items-center gap-3 px-6 hover:bg-secondary" data-testid="now-row">
      <StatusIcon status={item.run.data.state} />
      <Link
        to={`/sessions/${item.session.id}`}
        className="min-w-0 max-w-[40%] shrink-0 truncate text-fg-secondary hover:text-foreground"
      >
        {s.title}
      </Link>
      <span className="min-w-0 flex-1 truncate text-fg-tertiary">
        {item.waitingOn ? (
          <>
            <Hourglass className="mr-1 inline size-3.5 align-[-2px]" />
            {item.waitingOn.label}
          </>
        ) : item.run.data.pauseReason ? (
          item.run.data.pauseReason
        ) : (
          item.step.label
        )}
      </span>
      <RunActions item={item} onChanged={onChanged} />
      {item.checklist && (
        <span className="shrink-0 text-micro tabular-nums text-fg-tertiary">
          {item.checklist.done}/{item.checklist.total}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1.5 text-micro text-fg-tertiary">
        <EmployeeAvatar name={item.employee.name} className="size-4" />
      </span>
      <span className="w-10 shrink-0 text-right text-micro text-fg-quaternary">{timeAgo(item.step.since)}</span>
    </div>
  )
}

export function NowPage() {
  const api = useApi()
  const { currentId } = useEmployees()
  const snap = useLoad((a) => a.now(), [])
  const [pausing, setPausing] = useState(false)
  useLive(['now'], (e) => snap.setData((prev) => (prev ? applyNowEvent(prev, e) : prev)), [
    'model.delta',
    'step.started',
    'tool.called',
    'tool.result',
    'usage.recorded',
    'checklist.changed',
  ])
  useLiveReload(['now'], snap.reload, ['run.state', 'control.changed'])
  const items = (snap.data?.items ?? []).filter((i) => !currentId || i.employee.id === currentId)
  const paused = snap.data?.paused ?? false

  const toggleAll = async () => {
    setPausing(true)
    try {
      if (paused) await api.resumeAll()
      else await api.pauseAll()
      toast(paused ? 'All employees resumed' : 'All employees paused', {
        description: paused ? undefined : 'Runs stop at their next step boundary.',
      })
      snap.reload()
    } finally {
      setPausing(false)
    }
  }

  const counts = GROUPS.map((g) => ({ ...g, n: items.filter((i) => i.run.data.state === g.state).length }))
  return (
    <Page
      title="Now"
      icon={<Activity />}
      actions={
        <>
          <div className="mr-2 hidden items-center gap-3 text-micro text-fg-tertiary sm:flex">
            {counts.map((c) => (
              <span key={c.state} className="flex items-center gap-1">
                <StatusIcon status={c.state} tooltip={false} className="size-3.5" />
                <span className="tabular-nums">{c.n}</span> {c.title.toLowerCase()}
              </span>
            ))}
          </div>
          <Button size="sm" variant={paused ? 'default' : 'outline'} onClick={toggleAll} disabled={pausing}>
            {paused ? <CirclePlay /> : <CirclePause />}
            {paused ? 'Resume all' : 'Pause all'}
          </Button>
        </>
      }
    >
      {paused && (
        <div className="border-b bg-[var(--orange)]/10 px-6 py-2 text-[var(--orange)]">
          Kill switch on: every employee is paused. Runs stop at their next step boundary.
        </div>
      )}
      {snap.error && !snap.data ? (
        <ErrorState error={snap.error} retry={snap.reload} />
      ) : !snap.data ? (
        <LoadingRows />
      ) : items.length === 0 ? (
        <EmptyState
          text="Nothing is running right now."
          action={
            <Link to="/sessions" className="text-[#828fff] hover:underline">
              Browse sessions
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col pb-10">
          {counts
            .filter((g) => g.n > 0)
            .map((g) => {
              const group = items.filter((i) => i.run.data.state === g.state)
              return (
                <section key={g.state} className="border-b last:border-b-0">
                  <h2 className="flex h-9 items-center gap-2 bg-level-1 px-6 text-micro font-medium text-fg-secondary">
                    <StatusIcon status={g.state} tooltip={false} className="size-3.5" />
                    {g.title}
                    <span className="text-fg-quaternary tabular-nums">{g.n}</span>
                    <span className="sr-only">{STATUS[g.state].label}</span>
                  </h2>
                  {g.state === 'running' ? (
                    <div className="grid grid-cols-1 gap-3 p-4 px-6 xl:grid-cols-2">
                      {group.map((i) => (
                        <RunningCard key={i.run.id} item={i} onChanged={snap.reload} />
                      ))}
                    </div>
                  ) : (
                    group.map((i) => <IdleRow key={i.run.id} item={i} onChanged={snap.reload} />)
                  )}
                </section>
              )
            })}
        </div>
      )}
    </Page>
  )
}
