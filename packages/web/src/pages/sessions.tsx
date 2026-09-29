import type { SessionListItem } from '@mp/api'
import { GitFork, ListChecks, Repeat, Search, Workflow } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useLiveReload, useLoad } from '@/lib/api.tsx'
import { employeeHandle, useEmployees } from '@/lib/employees.tsx'
import { formatTokens, timeAgo } from '@/lib/format.ts'
import { STATUS, STATUS_ORDER, type StatusKey, sessionStatusKey } from '@/lib/status.ts'
import { cn } from '@/lib/utils.ts'

const FILTERS: { key: string; label: string; statuses?: StatusKey[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live', statuses: ['running', 'suspended', 'waiting', 'paused', 'queued'] },
  { key: 'contexts', label: 'Contexts' },
  { key: 'done', label: 'Done', statuses: ['completed', 'failed', 'cancelled'] },
]

type GroupBy = 'status' | 'employee' | 'tree'

export function groupSessions(
  rows: SessionListItem[],
  by: GroupBy,
): { key: string; label: string; status?: StatusKey; rows: SessionListItem[] }[] {
  const groups = new Map<string, { key: string; label: string; status?: StatusKey; rows: SessionListItem[] }>()
  for (const r of rows) {
    const status = sessionStatusKey(r.session.data.status, r.runState)
    const key = by === 'status' ? status : by === 'employee' ? r.employee.id : r.session.data.rootId
    const label =
      by === 'status'
        ? STATUS[status].label
        : by === 'employee'
          ? r.employee.name
          : (rows.find((x) => x.session.id === key)?.session.data.title ?? 'Tree')
    if (!groups.has(key)) groups.set(key, { key, label, ...(by === 'status' ? { status } : {}), rows: [] })
    groups.get(key)!.rows.push(r)
  }
  const list = [...groups.values()]
  if (by === 'status') list.sort((a, b) => STATUS_ORDER.indexOf(a.status!) - STATUS_ORDER.indexOf(b.status!))
  else list.sort((a, b) => a.label.localeCompare(b.label))
  if (by === 'tree')
    for (const g of list)
      g.rows.sort((a, b) => a.session.data.depth - b.session.data.depth || a.session.createdAt.localeCompare(b.session.createdAt))
  return list
}

export function SessionRow({ row, indent = 0 }: { row: SessionListItem; indent?: number }) {
  const s = row.session.data
  const status = sessionStatusKey(s.status, row.runState)
  const loop = s.meta?.loop as { index: number; of: number } | undefined
  return (
    <Link
      to={`/sessions/${row.session.id}`}
      className="group flex h-9 min-w-0 items-center gap-3 pr-6 transition-quick hover:bg-secondary"
      style={{ paddingLeft: 24 + indent * 20 }}
      data-testid="session-row"
    >
      <StatusIcon status={status} />
      <span className="min-w-0 truncate text-fg-secondary group-hover:text-foreground">{s.title}</span>
      <span className="hidden shrink-0 font-mono text-micro text-fg-quaternary md:inline">
        @{employeeHandle(row.employee.name)}#{s.slug}
      </span>
      {loop && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border px-1 text-tiny text-fg-tertiary">
          <Repeat className="size-3" />
          {loop.index + 1}/{loop.of}
        </span>
      )}
      {s.meta?.context === true && <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary">context</span>}
      <span className="ml-auto flex shrink-0 items-center gap-4 text-micro text-fg-tertiary">
        {row.children > 0 && (
          <span className="flex items-center gap-1" title={`${row.children} forks`}>
            <GitFork className="size-3.5" />
            {row.children}
          </span>
        )}
        {row.checklist && (
          <span className="flex items-center gap-1 tabular-nums" title="Checklist">
            <ListChecks className="size-3.5" />
            {row.checklist.done}/{row.checklist.total}
          </span>
        )}
        <span className="w-12 text-right tabular-nums">{formatTokens(row.tokens.total)}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <EmployeeAvatar name={row.employee.name} className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{row.employee.name}</TooltipContent>
        </Tooltip>
        <span className="w-8 text-right text-fg-quaternary">{timeAgo(row.session.updatedAt)}</span>
      </span>
    </Link>
  )
}

export function SessionsPage() {
  const [params, setParams] = useSearchParams()
  const filter = params.get('filter') ?? 'all'
  const groupBy = (params.get('group') as GroupBy) ?? 'status'
  const [text, setText] = useState(params.get('q') ?? '')
  const { currentId } = useEmployees()
  const list = useLoad(
    (api) => api.listSessions({ employeeId: currentId ?? undefined, text: text || undefined, limit: 500 }),
    [currentId, text],
  )
  useLiveReload(['now', 'records:session'], list.reload, ['run.state', 'record.changed'], 600)

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)
    return (list.data?.items ?? []).filter((r) => {
      if (filter === 'contexts') return r.session.data.meta?.context === true
      if (!f?.statuses) return true
      return f.statuses.includes(sessionStatusKey(r.session.data.status, r.runState))
    })
  }, [list.data, filter])
  const groups = useMemo(() => groupSessions(rows, groupBy), [rows, groupBy])
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    next.set(k, v)
    setParams(next, { replace: true })
  }

  return (
    <Page
      title="Sessions"
      icon={<Workflow />}
      filters={
        <>
          <div className="flex items-center gap-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => set('filter', f.key)}
                className={cn(
                  'h-6 rounded-md border border-transparent px-2 text-fg-tertiary transition-quick hover:text-foreground',
                  filter === f.key && 'border-border bg-secondary text-foreground',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative ml-2 w-56">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-quaternary" />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Filter by title, slug or text"
              className="h-7 pl-7 text-mini"
            />
          </div>
          <div className="ml-auto flex items-center gap-1 text-micro text-fg-tertiary">
            Group by
            {(['status', 'employee', 'tree'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => set('group', g)}
                className={cn(
                  'h-6 rounded-md px-1.5 capitalize hover:text-foreground',
                  groupBy === g && 'bg-secondary text-foreground',
                )}
              >
                {g}
              </button>
            ))}
          </div>
        </>
      }
    >
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState
          text="No sessions match these filters."
          action={
            <button
              type="button"
              className="text-[#828fff] hover:underline"
              onClick={() => {
                setText('')
                set('filter', 'all')
              }}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="pb-10">
          {groups.map((g) => (
            <section key={g.key} className="border-b last:border-b-0">
              <h2 className="sticky top-0 z-10 flex h-9 items-center gap-2 bg-level-1 px-6 text-micro font-medium text-fg-secondary">
                {g.status ? (
                  <StatusIcon status={g.status} tooltip={false} className="size-3.5" />
                ) : groupBy === 'employee' ? (
                  <EmployeeAvatar name={g.label} className="size-4" />
                ) : (
                  <GitFork className="size-3.5 text-fg-tertiary" />
                )}
                {g.label}
                <span className="tabular-nums text-fg-quaternary">{g.rows.length}</span>
              </h2>
              {g.rows.map((r) => (
                <SessionRow key={r.session.id} row={r} indent={groupBy === 'tree' ? r.session.data.depth : 0} />
              ))}
            </section>
          ))}
        </div>
      )}
    </Page>
  )
}
