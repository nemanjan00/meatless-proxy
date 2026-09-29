import type { ApiEvent, Subscription, TriggerStats } from '@mp/api'
import { AlertTriangle, Link2, Radio, Workflow, Zap } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { type Connector, ConnectorLayer, useConnectors } from '@/components/connectors.tsx'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { useLiveReload, useLoad } from '@/lib/api.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { pluralize, timeAgo } from '@/lib/format.ts'
import { eventTitle, routingOutcome } from '@/lib/routing.ts'
import { cn } from '@/lib/utils.ts'

export interface TriggerMap {
  sources: { id: string; source: string; type: string; count: number }[]
  contexts: { id: string; title: string; employee: string }[]
  connectors: Connector[]
}

/** Source/type → trigger → context, as three columns with connectors. */
export function buildTriggerMap(stats: TriggerStats[], events: ApiEvent[]): TriggerMap {
  const sources = new Map<string, { id: string; source: string; type: string; count: number }>()
  const contexts = new Map<string, { id: string; title: string; employee: string }>()
  const connectors: Connector[] = []
  for (const s of stats) {
    const sid = `src:${s.trigger.data.source}|${s.trigger.data.type}`
    if (!sources.has(sid)) sources.set(sid, { id: sid, source: s.trigger.data.source, type: s.trigger.data.type, count: 0 })
    if (s.context && !contexts.has(s.context.id))
      contexts.set(s.context.id, { id: s.context.id, title: s.context.title, employee: s.employee.name })
    connectors.push({ from: sid, to: s.trigger.id, key: `${sid}>${s.trigger.id}`, dashed: !s.trigger.data.enabled })
    if (s.context)
      connectors.push({
        from: s.trigger.id,
        to: `ctx:${s.context.id}`,
        key: `${s.trigger.id}>${s.context.id}`,
        dashed: s.trigger.data.fork,
      })
  }
  for (const e of events) {
    const src = sources.get(`src:${e.data.source}|${e.data.type}`)
    if (src) src.count++
  }
  return {
    sources: [...sources.values()].sort((a, b) => a.source.localeCompare(b.source) || a.type.localeCompare(b.type)),
    contexts: [...contexts.values()],
    connectors,
  }
}

function Card({
  anchor,
  className,
  children,
  active,
  onClick,
}: {
  anchor: string
  className?: string
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      data-anchor={anchor}
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border bg-card px-3 py-2 text-left transition-quick hover:border-[var(--fg-quaternary)]',
        active && 'border-ring ring-1 ring-ring',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function TriggersPage() {
  const { currentId } = useEmployees()
  const data = useLoad(
    (api) =>
      Promise.all([
        api.triggers(),
        api.listEvents({ limit: 200 }),
        api.listEvents({ routed: 'unmatched', limit: 50 }),
        api.listEvents({ routed: 'false', limit: 50 }),
        api.subscriptions(),
        api.listSessions({ limit: 500 }),
      ]),
    [],
  )
  useLiveReload(['events', 'records:trigger'], data.reload, undefined, 800)
  const [selected, setSelected] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const stats = useMemo(
    () => (data.data?.[0] ?? []).filter((s) => !currentId || s.employee.id === currentId),
    [data.data, currentId],
  )
  const map = useMemo(() => buildTriggerMap(stats, data.data?.[1].items ?? []), [stats, data.data])
  const sel = stats.find((s) => s.trigger.id === selected) ?? null
  const hot = new Set(
    sel
      ? [`src:${sel.trigger.data.source}|${sel.trigger.data.type}`, sel.trigger.id, sel.context ? `ctx:${sel.context.id}` : '']
      : [],
  )
  const connectors = map.connectors.map((c) => ({ ...c, to: c.to, hot: hot.has(c.from) && hot.has(c.to) }))
  const lines = useConnectors(box, connectors, data.data)
  // Only events that went to a fallback router; events delivered to nobody are counted separately, quietly.
  const unmatched = (data.data?.[2].items ?? []).filter((e) => routingOutcome(e) === 'unmatched')
  const nowhere = (data.data?.[1].items ?? []).filter((e) => routingOutcome(e) === 'nowhere').length
  const unrouted = data.data?.[3].items ?? []
  const subs: Subscription[] = data.data?.[4] ?? []
  const titles = new Map((data.data?.[5].items ?? []).map((r) => [r.session.id, r.session.data.title]))

  return (
    <Page title="Triggers" icon={<Zap />}>
      {data.error && !data.data ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : !data.data ? (
        <LoadingRows />
      ) : (
        <div className="flex min-h-full flex-col lg:flex-row">
          <div className="min-w-0 flex-1 lg:border-r">
            <div className="flex flex-col gap-2 px-4 pt-4 md:hidden" data-testid="trigger-list">
              {stats.map((s) => (
                <Card
                  key={s.trigger.id}
                  anchor={`list:${s.trigger.id}`}
                  active={selected === s.trigger.id}
                  onClick={() => setSelected(selected === s.trigger.id ? null : s.trigger.id)}
                  className={cn(!s.trigger.data.enabled && 'opacity-60')}
                >
                  <div className="flex items-center gap-1.5">
                    <Zap className="size-3.5 shrink-0 text-[var(--yellow)]" />
                    <span className="min-w-0 truncate font-medium text-foreground">{s.trigger.data.name}</span>
                    <span className="ml-auto rounded-sm bg-level-3 px-1 text-tiny tabular-nums text-fg-secondary">{s.fires}</span>
                  </div>
                  <div className="truncate pl-5 font-mono text-micro text-fg-tertiary">
                    {s.trigger.data.source} · {s.trigger.data.type}
                  </div>
                  <div className="truncate pl-5 text-micro text-fg-quaternary">
                    → {s.context?.title ?? 'no context'} · {s.employee.name}
                  </div>
                </Card>
              ))}
            </div>
            <div className="hidden grid-cols-3 gap-3 px-6 pt-5 text-micro font-medium text-fg-tertiary md:grid">
              <span>Source · event type</span>
              <span>Trigger · fires</span>
              <span>Context · employee</span>
            </div>
            <div ref={box} className="relative max-md:hidden" data-testid="trigger-map">
              <ConnectorLayer {...lines} />
              <div className="relative grid grid-cols-3 items-center gap-x-16 px-6 py-4">
                <div className="flex flex-col gap-2">
                  {map.sources.map((s) => (
                    <Card key={s.id} anchor={s.id} className="py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Radio className="size-3.5 text-fg-tertiary" />
                        <span className="truncate font-mono text-micro text-fg-secondary">{s.source}</span>
                        <span className="ml-auto text-tiny tabular-nums text-fg-quaternary">{s.count}</span>
                      </div>
                      <div className="truncate pl-5 text-micro text-fg-tertiary">{s.type}</div>
                    </Card>
                  ))}
                </div>
                <div className="flex flex-col gap-2">
                  {stats.map((s) => (
                    <Card
                      key={s.trigger.id}
                      anchor={s.trigger.id}
                      active={selected === s.trigger.id}
                      onClick={() => setSelected(selected === s.trigger.id ? null : s.trigger.id)}
                      className={cn(!s.trigger.data.enabled && 'opacity-60')}
                    >
                      <div className="flex items-center gap-1.5">
                        <Zap className="size-3.5 text-[var(--yellow)]" />
                        <span className="truncate font-medium text-foreground">{s.trigger.data.name}</span>
                        <span
                          className="ml-auto rounded-sm bg-level-3 px-1 text-tiny tabular-nums text-fg-secondary"
                          title="Fires"
                        >
                          {s.fires}
                        </span>
                      </div>
                      <div className="truncate pl-5 text-micro text-fg-quaternary">
                        {!s.trigger.data.enabled ? 'disabled' : s.trigger.data.fork ? 'forks the context' : 'runs in the context'}
                        {s.lastFiredAt && ` · ${timeAgo(s.lastFiredAt)} ago`}
                      </div>
                    </Card>
                  ))}
                </div>
                <div className="flex flex-col gap-2">
                  {map.contexts.map((c) => (
                    <Card key={c.id} anchor={`ctx:${c.id}`}>
                      <Link to={`/sessions/${c.id}`} className="flex items-center gap-1.5 hover:underline">
                        <Workflow className="size-3.5 text-fg-tertiary" />
                        <span className="truncate text-fg-secondary">{c.title}</span>
                      </Link>
                      <div className="flex items-center gap-1 pl-5 text-micro text-fg-tertiary">
                        <EmployeeAvatar name={c.employee} className="size-3.5" />
                        {c.employee}
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-4 border-t px-4 py-4 md:mt-0 md:px-6">
              <SectionTitle className="mb-2">Subscriptions · events that skip routing</SectionTitle>
              {subs.length === 0 && <p className="text-fg-tertiary">No session is subscribed to anything.</p>}
              {subs.map((s) => (
                <div key={s.id} className="flex h-8 items-center gap-2 text-mini">
                  <Link2 className="size-3.5 text-fg-tertiary" />
                  <span className="w-16 shrink-0 font-mono text-micro text-fg-tertiary">
                    {s.data.subject.system === 'mp' ? 'thread' : s.data.subject.system}
                  </span>
                  <span className="min-w-0 truncate text-fg-secondary">{s.data.subject.title ?? s.data.subject.ref}</span>
                  <span className="text-fg-quaternary">→</span>
                  <Link to={`/sessions/${s.data.sessionId}`} className="min-w-0 truncate text-fg-tertiary hover:text-foreground">
                    {titles.get(s.data.sessionId) ?? s.data.sessionId}
                  </Link>
                  <span className="ml-auto shrink-0 text-tiny text-fg-quaternary">
                    {s.data.primary ? 'primary' : 'context'} · {s.data.active ? 'active' : 'ended'}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <aside className="w-full shrink-0 bg-level-1 px-4 py-5 lg:w-80">
            {sel ? (
              <>
                <SectionTitle className="mb-2">Recent events · {sel.trigger.data.name}</SectionTitle>
                <div className="mb-3 rounded-md border bg-card p-2 font-mono text-micro text-fg-tertiary">
                  {sel.trigger.data.source} · {sel.trigger.data.type}
                  {sel.trigger.data.filters && (
                    <div className="text-fg-quaternary">{JSON.stringify(sel.trigger.data.filters)}</div>
                  )}
                </div>
                {sel.recentEvents.length === 0 && <p className="text-fg-tertiary">It hasn't fired yet.</p>}
                {sel.recentEvents.map((e) => (
                  <Link
                    key={e.id}
                    to={`/lineage/${e.id}`}
                    className="flex h-8 items-center gap-2 rounded-md px-1 hover:bg-secondary"
                  >
                    <Radio className="size-3.5 text-fg-tertiary" />
                    <span className="min-w-0 truncate text-fg-secondary">{e.subject?.title ?? e.text ?? e.type}</span>
                    {e.subject && !e.subject.title && !e.text && (
                      <span className="shrink-0 font-mono text-tiny text-fg-quaternary">{e.subject.system}</span>
                    )}
                    <span className="ml-auto shrink-0 text-micro text-fg-quaternary">{timeAgo(e.receivedAt)}</span>
                  </Link>
                ))}
              </>
            ) : (
              <p className="mb-4 text-fg-tertiary">Select a trigger to see its recent events.</p>
            )}
            <SectionTitle className="mt-6 mb-2">
              <span className={cn('flex items-center gap-1.5', unmatched.length > 0 && 'text-[var(--orange)]')}>
                {unmatched.length > 0 && <AlertTriangle className="size-3.5" />} Unmatched · went to a router
              </span>
            </SectionTitle>
            <div data-testid="unmatched">
              {unmatched.length === 0 && <p className="text-fg-tertiary">Every event matched a rule.</p>}
              {unmatched.map((e) => (
                <Link
                  key={e.id}
                  to={`/lineage/${e.id}`}
                  className="flex flex-col rounded-md border border-[var(--orange)]/30 bg-[var(--orange)]/5 px-2 py-1.5 mb-1.5 hover:border-[var(--orange)]/60"
                >
                  <span className="flex items-center gap-1.5 text-micro">
                    <span className="font-mono text-fg-secondary">{e.data.source}</span>
                    <span className="text-fg-tertiary">{e.data.type}</span>
                    <span className="ml-auto text-fg-quaternary">{timeAgo(e.data.receivedAt)}</span>
                  </span>
                  <span className="truncate text-mini text-fg-secondary">{eventTitle(e) ?? e.data.subject?.ref ?? '—'}</span>
                </Link>
              ))}
            </div>
            {nowhere > 0 && (
              <Link
                to="/events"
                className="mt-2 block text-micro text-fg-quaternary hover:text-fg-tertiary"
                data-testid="not-delivered"
              >
                {pluralize(nowhere, 'event')} delivered to nobody, such as sessions’ own replies
              </Link>
            )}
            {unrouted.length > 0 && (
              <>
                <SectionTitle className="mt-6 mb-2">Waiting to be routed</SectionTitle>
                {unrouted.map((e) => (
                  <div key={e.id} className="flex h-7 items-center gap-2 text-micro">
                    <span className="font-mono text-fg-secondary">{e.data.source}</span>
                    <span className="text-fg-tertiary">{e.data.type}</span>
                    <span className="ml-auto text-fg-quaternary">{timeAgo(e.data.receivedAt)}</span>
                  </div>
                ))}
              </>
            )}
          </aside>
        </div>
      )}
    </Page>
  )
}
