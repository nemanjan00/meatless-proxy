import type { LineageNode } from '@mp/api'
import { ArrowRight, GitFork, Link2, Play, Radio, Repeat, Workflow, Zap } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page } from '@/components/page.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { useLiveReload, useLoad } from '@/lib/api.tsx'
import { buildLineage, originChain } from '@/lib/lineage.ts'
import type { StatusKey } from '@/lib/status.ts'
import { cn } from '@/lib/utils.ts'

const TYPE_ICON = { event: Radio, trigger: Zap, subscription: Link2, delivery: ArrowRight, session: Workflow, run: Play } as const
const TYPE_LABEL = {
  event: 'Event',
  trigger: 'Trigger',
  subscription: 'Subscription',
  delivery: 'Delivery',
  session: 'Session',
  run: 'Run',
} as const

function statusOf(n: LineageNode): StatusKey | null {
  if (!n.status) return null
  const s = n.status
  if (n.type === 'session' && ['queued', 'running', 'suspended', 'paused'].includes(s)) return s as StatusKey
  if (n.type === 'session')
    return s === 'done' ? 'completed' : s === 'abandoned' ? 'cancelled' : s === 'waiting' ? 'waiting' : 'idle'
  return s as StatusKey
}

function hrefFor(n: LineageNode): string {
  if (n.type === 'session') return `/sessions/${n.id}`
  return `/lineage/${n.id}`
}

function NodeCard({ n, focus, side }: { n: LineageNode; focus: boolean; side: 'up' | 'down' | 'focus' }) {
  const Icon = TYPE_ICON[n.type]
  const st = statusOf(n)
  const navigate = useNavigate()
  return (
    <button
      type="button"
      data-lineage={n.id}
      onClick={() => navigate(hrefFor(n))}
      className={cn(
        'flex w-44 flex-col gap-0.5 rounded-lg border bg-card px-2.5 py-2 text-left transition-quick hover:border-[var(--fg-quaternary)]',
        focus && 'border-ring ring-1 ring-ring',
        side === 'up' && !focus && 'bg-level-1',
      )}
      title={n.label}
    >
      <span className="flex items-center gap-1.5 text-tiny text-fg-tertiary uppercase">
        <Icon className="size-3" />
        {TYPE_LABEL[n.type]}
        {st && <StatusIcon status={st} tooltip={false} className="ml-auto size-3.5" />}
      </span>
      <span className="truncate text-mini font-medium text-foreground">{n.label}</span>
      {n.detail && <span className="truncate font-mono text-tiny text-fg-quaternary">{n.detail}</span>}
    </button>
  )
}

const EDGE_ICON: Record<string, typeof GitFork> = { forked: GitFork, looped: Repeat }

/**
 * Lineage: where a session, run or event came from (left) and everything it
 * caused (right). Columns are distance from the focus; edges are drawn
 * between the cards.
 */
export function LineagePage() {
  const { id = '' } = useParams()
  const graph = useLoad((a) => a.lineage(id), [id])
  useLiveReload(['now', 'events'], graph.reload, ['run.state', 'event.ingested'], 800)
  const layout = useMemo(() => (graph.data ? buildLineage(graph.data) : null), [graph.data])
  const chain = layout ? originChain(layout) : []
  const box = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<{ d: string; key: string; type: string; hot: boolean }[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = box.current
    if (!el || !layout) return
    const compute = () => {
      const base = el.getBoundingClientRect()
      const rect = (nid: string) => el.querySelector(`[data-lineage="${nid}"]`)?.getBoundingClientRect()
      const hot = new Set(originChain(layout).map((c) => c.id))
      const out: typeof paths = []
      for (const e of layout.edges) {
        const a = rect(e.from)
        const b = rect(e.to)
        if (!a || !b) continue
        const x1 = a.right - base.left + el.scrollLeft
        const y1 = a.top + a.height / 2 - base.top + el.scrollTop
        const x2 = b.left - base.left + el.scrollLeft
        const y2 = b.top + b.height / 2 - base.top + el.scrollTop
        if (x2 < x1) continue
        const mx = (x1 + x2) / 2
        out.push({
          d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
          key: `${e.from}-${e.to}-${e.type}`,
          type: e.type,
          hot: hot.has(e.from) && hot.has(e.to),
        })
      }
      setPaths(out)
      setSize({ w: el.scrollWidth, h: el.scrollHeight })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [layout])

  const focus = layout?.focus
  return (
    <Page title={focus ? `Lineage · ${focus.label}` : 'Lineage'} icon={<GitFork />}>
      {graph.error && !graph.data ? (
        <ErrorState error={graph.error} retry={graph.reload} />
      ) : !layout ? (
        <LoadingRows />
      ) : !focus ? (
        <EmptyState text="Nothing to show for this id." />
      ) : (
        <div className="flex h-full flex-col">
          <div
            className="flex flex-wrap items-center gap-1.5 border-b px-6 py-2.5 text-micro text-fg-tertiary"
            data-testid="origin-chain"
          >
            <span className="mr-1">Origin</span>
            {chain.map((n, i) => (
              <span key={n.id} className="flex items-center gap-1.5">
                {i > 0 && <ArrowRight className="size-3 text-fg-quaternary" />}
                <Link to={hrefFor(n)} className={cn('hover:text-foreground', n.id === focus.id && 'text-foreground')}>
                  {TYPE_LABEL[n.type]}: {n.label}
                </Link>
              </span>
            ))}
            <span className="ml-auto">
              {layout.upstream.size} upstream · {layout.downstream.size} downstream
            </span>
          </div>
          <div ref={box} className="relative min-h-0 flex-1 overflow-auto" data-testid="lineage">
            <svg className="pointer-events-none absolute top-0 left-0" width={size.w} height={size.h} aria-hidden="true">
              {paths.map((p) => (
                <path
                  key={p.key}
                  d={p.d}
                  fill="none"
                  stroke={p.hot ? 'var(--ring)' : 'var(--input)'}
                  strokeWidth={p.hot ? 1.5 : 1}
                  strokeDasharray={p.type === 'looped' ? '4 3' : p.type === 'emitted' ? '2 3' : undefined}
                />
              ))}
            </svg>
            <div className="relative flex min-w-max gap-8 p-6">
              {layout.columns.map((c) => (
                <div key={c.index} className="flex flex-col gap-2.5">
                  <div className="mb-1 text-tiny font-medium text-fg-quaternary uppercase">
                    {c.index === 0 ? 'Focus' : c.index < 0 ? `Upstream ${-c.index}` : `Downstream ${c.index}`}
                  </div>
                  {c.nodes.map((n) => (
                    <NodeCard
                      key={n.id}
                      n={n}
                      focus={n.id === focus.id}
                      side={c.index < 0 ? 'up' : c.index > 0 ? 'down' : 'focus'}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4 border-t px-6 py-2 text-tiny text-fg-quaternary">
            {Object.entries(TYPE_LABEL).map(([k, v]) => {
              const I = TYPE_ICON[k as keyof typeof TYPE_ICON]
              return (
                <span key={k} className="flex items-center gap-1">
                  <I className="size-3" /> {v}
                </span>
              )
            })}
            <span className="ml-auto flex items-center gap-3">
              {Object.entries(EDGE_ICON).map(([k, I]) => (
                <span key={k} className="flex items-center gap-1">
                  <I className="size-3" /> {k}
                </span>
              ))}
              <span>dashed dots: emitted event</span>
            </span>
          </div>
        </div>
      )}
    </Page>
  )
}
