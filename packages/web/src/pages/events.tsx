import type { ApiEvent } from '@mp/api'
import { AlertTriangle, Radio } from 'lucide-react'
import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { type DataColumn, DataTable } from '@/components/data-table.tsx'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page } from '@/components/page.tsx'
import { useLiveReload, useLoad } from '@/lib/api.tsx'
import { formatDateTime, shortId, timeAgo } from '@/lib/format.ts'
import { eventTitle, routingOutcome } from '@/lib/routing.ts'
import { cn } from '@/lib/utils.ts'

const ROUTED = [
  { key: '', label: 'All' },
  { key: 'unmatched', label: 'Unmatched' },
  { key: 'false', label: 'Not routed' },
] as const

/** Every stored event, newest first; unmatched ones stand out. Click for its lineage. */
export function EventsPage() {
  const [params, setParams] = useSearchParams()
  const routed = params.get('routed') ?? ''
  const source = params.get('source') ?? ''
  const navigate = useNavigate()
  const list = useLoad(
    (api) =>
      api.listEvents({
        routed: (routed || undefined) as 'unmatched' | 'false' | undefined,
        source: source || undefined,
        limit: 200,
      }),
    [routed, source],
  )
  useLiveReload(['events'], list.reload)
  const sources = useMemo(() => [...new Set((list.data?.items ?? []).map((e) => e.data.source))].sort(), [list.data])
  const columns = useMemo<DataColumn<ApiEvent>[]>(
    () => [
      {
        id: 'source',
        header: 'Source',
        value: (e) => e.data.source,
        cell: (e) => <span className="font-mono text-micro">{e.data.source}</span>,
        className: 'w-28 max-sm:hidden',
      },
      { id: 'type', header: 'Type', value: (e) => e.data.type, className: 'w-36 max-md:hidden' },
      {
        id: 'subject',
        header: 'Subject',
        value: (e) => eventTitle(e) ?? e.data.subject?.ref ?? '',
        cell: (e) => {
          const title = eventTitle(e)
          return (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-fg-secondary">{title ?? e.data.subject?.ref ?? '—'}</span>
              {title && e.data.subject && (
                <span className="hidden shrink-0 font-mono text-micro text-fg-quaternary lg:inline">
                  {e.data.subject.system}:{shortId(e.data.subject.ref)}
                </span>
              )}
            </span>
          )
        },
        // A zero max width lets the cell shrink, so long texts truncate instead of widening the table.
        className: 'max-w-0 w-full',
      },
      {
        id: 'routing',
        header: 'Routing',
        value: (e) => routingOutcome(e),
        cell: (e) => {
          const outcome = routingOutcome(e)
          const unmatched = outcome === 'unmatched'
          return (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-micro',
                unmatched ? 'text-[var(--orange)]' : outcome === 'nowhere' ? 'text-fg-quaternary' : 'text-fg-tertiary',
              )}
              title={outcome === 'nowhere' ? 'Delivered to nobody (e.g. a session’s own message)' : undefined}
            >
              {unmatched && <AlertTriangle className="size-3" />}
              {outcome === 'pending'
                ? 'waiting'
                : outcome === 'unmatched'
                  ? 'unmatched → router'
                  : outcome === 'nowhere'
                    ? 'not delivered'
                    : (e.data.matched ?? []).join(', ').replace(/_/g, ' ')}
            </span>
          )
        },
        className: 'w-36 sm:w-44',
      },
      {
        id: 'received',
        header: 'Received',
        value: (e) => e.data.receivedAt,
        cell: (e) => (
          <span className="text-micro text-fg-quaternary" title={formatDateTime(e.data.receivedAt)}>
            {timeAgo(e.data.receivedAt)}
          </span>
        ),
        align: 'right',
        className: 'w-24',
      },
    ],
    [],
  )
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    if (v) n.set(k, v)
    else n.delete(k)
    setParams(n, { replace: true })
  }
  return (
    <Page
      title="Events"
      icon={<Radio />}
      filters={
        <>
          {ROUTED.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => set('routed', r.key)}
              className={cn(
                'h-6 rounded-md border border-transparent px-2 text-fg-tertiary hover:text-foreground',
                routed === r.key && 'border-border bg-secondary text-foreground',
              )}
            >
              {r.label}
            </button>
          ))}
          <span className="mx-2 h-4 w-px bg-border" />
          <select
            value={source}
            onChange={(e) => set('source', e.target.value)}
            className="h-6 rounded-md border bg-transparent px-1.5 text-mini text-fg-secondary"
            aria-label="Source"
          >
            <option value="">Any source</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="ml-auto text-micro text-fg-tertiary">{list.data?.total ?? 0} events</span>
        </>
      }
    >
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : list.data.items.length === 0 ? (
        <EmptyState text="No events match." />
      ) : (
        <div className="px-3">
          <DataTable
            rows={list.data.items}
            columns={columns}
            rowKey={(e) => e.id}
            onRowClick={(e) => navigate(`/lineage/${e.id}`)}
            initialSort={[{ id: 'received', desc: true }]}
          />
        </div>
      )}
    </Page>
  )
}
