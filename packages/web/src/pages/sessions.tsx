import type { ApiRecord, ContactData, ProjectData, SessionListItem, SessionListQuery } from '@mp/api'
import { GitFork, ListChecks, Repeat, Search, Workflow, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useLiveReload, useLoad } from '@/lib/api.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { formatDateTime, formatTokens, pluralize, timeAgo } from '@/lib/format.ts'
import { type GroupBy, groupSessions, isSort, isStartedFrom, SORTS, STARTED_FROM } from '@/lib/session-list.ts'
import { type StatusKey, sessionStatusKey } from '@/lib/status.ts'
import { cn } from '@/lib/utils.ts'

export { groupSessions } from '@/lib/session-list.ts'

const FILTERS: { key: string; label: string; statuses?: StatusKey[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live', statuses: ['running', 'suspended', 'waiting', 'paused', 'queued'] },
  { key: 'contexts', label: 'Contexts' },
  { key: 'done', label: 'Done', statuses: ['completed', 'failed', 'cancelled'] },
]

/** Rows per request; "Load more" asks for the next page. */
export const SESSIONS_PAGE = 100
/** URL parameters the filter bar owns ("Clear filters" removes them). */
const FILTER_PARAMS = ['employee', 'project', 'requester', 'origin', 'retired', 'q']
const ALL = 'all'

export function SessionRow({ row, indent = 0 }: { row: SessionListItem; indent?: number }) {
  const s = row.session.data
  const status = sessionStatusKey(s.status, row.runState)
  const loop = s.meta?.loop as { index: number; of: number } | undefined
  const { handle } = useEmployees()
  const activity = row.lastActivityAt ?? row.session.updatedAt
  // What it waits for, else what it did last: a bare status doesn't say.
  const waiting = row.outcome?.waitingFor?.[0]
  const outcome = waiting ? `waiting for ${waiting}` : row.outcome?.lastOutcome
  return (
    <Link
      to={`/sessions/${row.session.id}`}
      className="group flex h-9 min-w-0 items-center gap-3 pr-4 transition-quick [--row-pad:16px] hover:bg-secondary sm:pr-6 sm:[--row-pad:24px]"
      style={{ paddingLeft: `calc(var(--row-pad) + ${indent * 20}px)` }}
      data-testid="session-row"
    >
      <StatusIcon status={status} />
      <span className="min-w-0 truncate text-fg-secondary group-hover:text-foreground">{s.title}</span>
      {outcome && (
        <span className="hidden min-w-0 shrink truncate text-micro text-fg-quaternary lg:inline" data-testid="session-outcome">
          {outcome}
        </span>
      )}
      <span className="hidden shrink-0 font-mono text-micro text-fg-quaternary md:inline">
        @{handle(row.employee)}#{s.slug}
      </span>
      {loop && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border px-1 text-tiny text-fg-tertiary">
          <Repeat className="size-3" />
          {loop.index + 1}/{loop.of}
        </span>
      )}
      {s.meta?.context === true && (
        <span className="hidden shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary sm:inline">context</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-3 text-micro text-fg-tertiary sm:gap-4">
        {row.project && (
          <span
            className="hidden max-w-32 truncate rounded-sm border px-1 text-tiny text-fg-tertiary lg:inline"
            data-testid="session-project"
          >
            {row.project.name}
          </span>
        )}
        {row.children > 0 && (
          <span className="hidden items-center gap-1 sm:flex" title={`${row.children} forks`}>
            <GitFork className="size-3.5" />
            {row.children}
          </span>
        )}
        {row.checklist && (
          <span className="hidden items-center gap-1 tabular-nums sm:flex" title="Checklist">
            <ListChecks className="size-3.5" />
            {row.checklist.done}/{row.checklist.total}
          </span>
        )}
        <span className="hidden w-12 text-right tabular-nums md:inline">{formatTokens(row.tokens.total)}</span>
        <span className="flex w-4 justify-center">
          {row.requester && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span data-testid="session-requester">
                  <PersonAvatar name={row.requester.name} className="size-4" />
                </span>
              </TooltipTrigger>
              <TooltipContent>Requested by {row.requester.name}</TooltipContent>
            </Tooltip>
          )}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <EmployeeAvatar name={row.employee.name} className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{row.employee.name}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <time dateTime={activity} className="w-8 text-right text-fg-quaternary tabular-nums">
              {timeAgo(activity)}
            </time>
          </TooltipTrigger>
          <TooltipContent>Last activity {formatDateTime(activity)}</TooltipContent>
        </Tooltip>
      </span>
    </Link>
  )
}

/** A compact select for the filter bar. */
function BarSelect({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string
  value: string
  onChange(v: string): void
  options: { value: string; label: ReactNode }[]
  className?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn('h-7 max-w-52 gap-1.5 px-2 text-mini data-[size=sm]:h-7', value !== ALL && 'text-foreground', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The "Requested by" filter: a contact picker, or the picked person with a clear button. */
function RequesterFilter({ id, onChange }: { id: string | null; onChange(id: string | null): void }) {
  const contact = useLoad(
    (api) => (id ? api.getRecord<ContactData>('contact', id).catch(() => null) : Promise.resolve(null)),
    [id],
  )
  if (!id)
    return (
      <RecordPicker
        kinds={['contact']}
        filter={(r) => (r.data as ContactData).kind !== 'ai'}
        onPick={(o) => onChange(o.id)}
        placeholder="Requested by…"
        className="w-36"
      />
    )
  const name = contact.data?.data.name ?? '…'
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input pr-1 pl-1.5 text-mini text-foreground">
      <PersonAvatar name={name} className="size-4" />
      <span className="max-w-28 truncate">{name}</span>
      <button
        type="button"
        aria-label="Clear requested by"
        onClick={() => onChange(null)}
        className="rounded-sm p-0.5 text-fg-tertiary hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </span>
  )
}

export function SessionsPage() {
  const [params, setParams] = useSearchParams()
  const filter = params.get('filter') ?? 'all'
  const groupBy = (params.get('group') as GroupBy) ?? 'status'
  const sortParam = params.get('sort')
  const sort = isSort(sortParam) ? sortParam : 'activity'
  const originParam = params.get('origin')
  const origin = isStartedFrom(originParam) ? originParam : null
  const projectId = params.get('project')
  const requesterId = params.get('requester')
  const showRetired = params.get('retired') === '1'
  const [text, setText] = useState(params.get('q') ?? '')
  const { employees, currentId } = useEmployees()
  // The page's own ?employee= wins; without it the list follows the sidebar's employee switcher.
  const employeeValue = params.get('employee') ?? currentId ?? ALL
  const employeeId = employeeValue === ALL ? undefined : employeeValue
  const [pages, setPages] = useState(1)

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }
  const set = (k: string, v: string) => update({ [k]: v })

  // The search box writes ?q= after a short pause, so the URL keeps the whole filter.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get('q') ?? '') !== text) update({ q: text || null })
    }, 250)
    return () => clearTimeout(t)
  })

  const query: SessionListQuery = {
    ...(employeeId ? { employeeId } : {}),
    ...(text ? { text } : {}),
    ...(projectId ? { projectId } : {}),
    ...(requesterId ? { requesterId } : {}),
    ...(origin ? { origin } : {}),
    sort,
    ...(showRetired ? { excludeRoles: 'none' } : {}),
  }
  const queryKey = JSON.stringify(query)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts from the first page again
  useEffect(() => setPages(1), [queryKey])
  const list = useLoad(
    async (api) => {
      const all = await Promise.all(
        Array.from({ length: pages }, (_, i) => api.listSessions({ ...query, limit: SESSIONS_PAGE, offset: i * SESSIONS_PAGE })),
      )
      const seen = new Set<string>()
      const items = all.flatMap((p) => p.items).filter((r) => !seen.has(r.session.id) && seen.add(r.session.id))
      return { items, total: all[0]?.total ?? 0 }
    },
    [queryKey, pages],
  )
  useLiveReload(['now', 'records:session'], list.reload, ['run.state', 'record.changed'], 600)
  const projects = useLoad((api) => api.listRecords<ProjectData>('project', { orderBy: 'name', dir: 'asc', limit: 200 }), [])

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)
    return (list.data?.items ?? []).filter((r) => {
      if (filter === 'contexts') return r.session.data.meta?.context === true
      if (!f?.statuses) return true
      return f.statuses.includes(sessionStatusKey(r.session.data.status, r.runState))
    })
  }, [list.data, filter])
  const groups = useMemo(() => groupSessions(rows, groupBy, sort), [rows, groupBy, sort])
  const loaded = list.data?.items.length ?? 0
  const total = list.data?.total ?? 0
  const hasMore = loaded < total
  const filtersSet = FILTER_PARAMS.some((k) => params.has(k)) || !!text
  const clearFilters = () => {
    setText('')
    update({ ...Object.fromEntries(FILTER_PARAMS.map((k) => [k, null])), filter: null })
  }
  const count = filter === 'all' ? total : rows.length

  const projectOptions = [
    { value: ALL, label: 'All projects' },
    ...(projects.data?.items ?? []).map((p: ApiRecord<ProjectData>) => ({ value: p.id, label: p.data.name })),
  ]
  if (projectId && !projectOptions.some((o) => o.value === projectId)) projectOptions.push({ value: projectId, label: projectId })

  return (
    <Page
      title="Sessions"
      icon={<Workflow />}
      filters={
        <div className="flex w-full min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
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
            <div className="relative w-full sm:ml-2 sm:w-56">
              <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-quaternary" />
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Filter by title, slug or text"
                aria-label="Search sessions"
                className="h-7 pl-7 text-mini"
              />
            </div>
            <div className="flex items-center gap-3 sm:ml-auto">
              <div className="flex items-center gap-1.5 text-micro text-fg-tertiary">
                Sort
                <BarSelect
                  label="Sort"
                  value={sort}
                  onChange={(v) => update({ sort: v === 'activity' ? null : v })}
                  options={SORTS}
                  className="text-foreground"
                />
              </div>
              <div className="flex items-center gap-1 text-micro text-fg-tertiary">
                <span className="hidden sm:inline">Group by</span>
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
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="session-filters">
            <BarSelect
              label="Employee"
              value={employeeValue}
              onChange={(v) => set('employee', v)}
              options={[
                { value: ALL, label: 'All employees' },
                ...employees.map((e) => ({
                  value: e.id,
                  label: (
                    <>
                      <EmployeeAvatar name={e.data.name} className="size-3.5" />
                      {e.data.name}
                    </>
                  ),
                })),
              ]}
            />
            <BarSelect
              label="Project"
              value={projectId ?? ALL}
              onChange={(v) => update({ project: v === ALL ? null : v })}
              options={projectOptions}
            />
            <RequesterFilter id={requesterId} onChange={(id) => update({ requester: id })} />
            <BarSelect
              label="Started from"
              value={origin ?? ALL}
              onChange={(v) => update({ origin: v === ALL ? null : v })}
              options={[{ value: ALL, label: 'Started from anywhere' }, ...STARTED_FROM]}
            />
            <label htmlFor="sessions-hide-retired" className="flex h-7 items-center gap-1.5 text-micro text-fg-tertiary">
              <Checkbox
                id="sessions-hide-retired"
                checked={!showRetired}
                onCheckedChange={(v) => update({ retired: v === true ? null : '1' })}
                aria-label="Hide finished router contexts"
              />
              Hide finished routers
            </label>
            {filtersSet && (
              <button type="button" onClick={clearFilters} className="h-7 px-1 text-micro text-[#828fff] hover:underline">
                Clear filters
              </button>
            )}
            <span className="ml-auto text-micro text-fg-quaternary tabular-nums" data-testid="session-count">
              {list.data ? pluralize(count, 'session') : ''}
            </span>
          </div>
        </div>
      }
    >
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : rows.length === 0 && !hasMore ? (
        filtersSet || filter !== 'all' ? (
          <EmptyState
            text="No sessions match these filters."
            action={
              <button type="button" className="text-[#828fff] hover:underline" onClick={clearFilters}>
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState text="No sessions yet." />
        )
      ) : (
        <div className="pb-10">
          {groups.map((g) => (
            <section key={g.key} className="border-b last:border-b-0">
              <h2 className="sticky top-0 z-10 flex h-9 items-center gap-2 bg-level-1 px-4 text-micro font-medium text-fg-secondary sm:px-6">
                {g.status ? (
                  <StatusIcon status={g.status} tooltip={false} className="size-3.5" />
                ) : groupBy === 'employee' ? (
                  <EmployeeAvatar name={g.label} className="size-4" />
                ) : (
                  <GitFork className="size-3.5 text-fg-tertiary" />
                )}
                <span className="min-w-0 truncate">{g.label}</span>
                <span className="tabular-nums text-fg-quaternary">{g.rows.length}</span>
              </h2>
              {g.rows.map((r) => (
                <SessionRow key={r.session.id} row={r} indent={groupBy === 'tree' ? r.session.data.depth : 0} />
              ))}
            </section>
          ))}
          {hasMore && (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={() => setPages((p) => p + 1)}
                disabled={list.loading}
                className="h-7 rounded-md border px-3 text-mini text-fg-secondary transition-quick hover:bg-secondary hover:text-foreground disabled:opacity-50"
              >
                {list.loading ? 'Loading…' : `Load more (${loaded} of ${total})`}
              </button>
            </div>
          )}
        </div>
      )}
    </Page>
  )
}
