import type { SessionTreeNode } from '@mp/api'
import { Maximize2, Minus, Plus, Repeat } from 'lucide-react'
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react'
import { useNavigate } from 'react-router'
import { StatusIcon } from '@/components/status-icon.tsx'
import { Button } from '@/components/ui/button.tsx'
import { employeeHandle } from '@/lib/employees.tsx'
import { formatTokens } from '@/lib/format.ts'
import { sessionStatusKey } from '@/lib/status.ts'
import { type TreeInput, layoutTree } from '@/lib/tree-layout.ts'
import { cn } from '@/lib/utils.ts'

const NODE_W = 216
const NODE_H = 66
const GAP_X = 20
const GAP_Y = 44

export function toTreeInput(n: SessionTreeNode): TreeInput<SessionTreeNode> {
  return { id: n.id, data: n, children: n.children.map(toTreeInput) }
}

/** Counts nodes and live ones, for the header. */
export function treeStats(n: SessionTreeNode): { sessions: number; live: number; tokens: number } {
  let sessions = 1
  let live = n.runState && ['running', 'queued', 'suspended', 'paused'].includes(n.runState) ? 1 : 0
  let tokens = n.tokens
  for (const c of n.children) {
    const s = treeStats(c)
    sessions += s.sessions
    live += s.live
    tokens += s.tokens
  }
  return { sessions, live, tokens }
}

interface View {
  k: number
  x: number
  y: number
}

/**
 * The fork tree as a graph: one node per session with status, slug,
 * employee and tokens. Wheel to zoom, drag to pan, click a node to open it,
 * and use the badge under a node to collapse its subtree.
 */
export function SessionTreeGraph({
  root,
  currentId,
  className,
  height = 460,
}: {
  root: SessionTreeNode
  currentId?: string
  className?: string
  height?: number
}) {
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const layout = useMemo(
    () => layoutTree(toTreeInput(root), { nodeWidth: NODE_W, nodeHeight: NODE_H, gapX: GAP_X, gapY: GAP_Y, collapsed }),
    [root, collapsed],
  )
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ k: 1, x: 24, y: 24 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)

  const fitView = useCallback(() => {
    const el = box.current
    if (!el) return
    const w = el.clientWidth || 800
    const h = el.clientHeight || height
    // Fit, but never below a readable zoom; wide trees are panned instead, centred on the current session.
    const k = Math.min(1, Math.max(0.85, Math.min((w - 48) / layout.width, (h - 48) / layout.height)))
    const root = layout.nodes.find((n) => n.id === currentId) ?? layout.nodes[0]!
    const x = layout.width * k <= w - 48 ? (w - layout.width * k) / 2 : w / 2 - (root.x + NODE_W / 2) * k
    setView({ k, x, y: 32 })
  }, [layout, height, currentId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: fitView once per tree shape
  useEffect(() => fitView(), [root.id, collapsed.size])

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.2, v.k * factor))
      const f = k / v.k
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f }
    })
  const onWheel = (e: WheelEvent) => {
    const r = box.current!.getBoundingClientRect()
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top)
  }
  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-node]')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    d.moved = true
    setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
  }
  const onUp = () => {
    drag.current = null
  }
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const onPath = useMemo(() => {
    const byId = new Map(layout.nodes.map((n) => [n.id, n]))
    const set = new Set<string>()
    for (let id: string | null | undefined = currentId; id; id = byId.get(id)?.parentId) set.add(id)
    return set
  }, [layout.nodes, currentId])

  return (
    <div
      ref={box}
      className={cn('relative overflow-hidden rounded-xl border bg-level-1 select-none', className)}
      style={{ height, touchAction: 'none', cursor: drag.current ? 'grabbing' : 'grab' }}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      data-testid="session-tree"
    >
      <svg width="100%" height="100%" role="img" aria-label="Session fork tree">
        <defs>
          <pattern id="mp-dots" width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.8" fill="var(--border)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#mp-dots)" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {layout.edges.map((e) => (
            <path
              key={`${e.from}-${e.to}`}
              d={e.path}
              fill="none"
              stroke={onPath.has(e.to) ? 'var(--ring)' : 'var(--input)'}
              strokeWidth={onPath.has(e.to) ? 1.5 : 1}
              strokeDasharray={layout.nodes.find((n) => n.id === e.to)?.data.origin === 'loop' ? '4 3' : undefined}
            />
          ))}
          {layout.nodes.map((n) => {
            const d = n.data
            const status = sessionStatusKey(d.status, d.runState)
            const current = n.id === currentId
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                <foreignObject width={NODE_W} height={NODE_H} data-node>
                  <button
                    type="button"
                    onClick={() => navigate(`/sessions/${n.id}`)}
                    className={cn(
                      'flex h-full w-full flex-col justify-center gap-0.5 rounded-lg border bg-card px-2.5 text-left transition-quick hover:border-[var(--fg-quaternary)]',
                      current && 'border-ring ring-1 ring-ring',
                    )}
                    title={d.title}
                    data-testid="tree-node"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <StatusIcon status={status} tooltip={false} className="size-3.5" />
                      <span className="min-w-0 truncate text-mini font-medium text-foreground">{d.title}</span>
                    </span>
                    <span className="truncate font-mono text-tiny text-fg-tertiary">
                      @{employeeHandle(d.employee.name)}#{d.slug}
                    </span>
                    <span className="flex items-center gap-2 text-tiny text-fg-quaternary">
                      <span className="tabular-nums">{formatTokens(d.tokens)} tok</span>
                      {d.loop && (
                        <span className="inline-flex items-center gap-0.5">
                          <Repeat className="size-2.5" /> {d.loop.index + 1}/{d.loop.of}
                        </span>
                      )}
                      {d.origin === 'root' && <span>root</span>}
                    </span>
                  </button>
                </foreignObject>
                {n.hasChildren && (
                  <foreignObject x={NODE_W / 2 - 18} y={NODE_H - 2} width={36} height={20} data-node>
                    <button
                      type="button"
                      onClick={() => toggle(n.id)}
                      className="mx-auto mt-[2px] flex h-4 min-w-7 items-center justify-center rounded-full border bg-background px-1 text-tiny text-fg-tertiary hover:text-foreground"
                      aria-label={n.collapsed ? `Expand ${d.title}` : `Collapse ${d.title}`}
                    >
                      {n.collapsed ? `+${n.hidden}` : '−'}
                    </button>
                  </foreignObject>
                )}
              </g>
            )
          })}
        </g>
      </svg>
      <div className="absolute right-2 bottom-2 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-low">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out"
          onClick={() => zoomAt(1 / 1.2, (box.current?.clientWidth ?? 0) / 2, height / 2)}
        >
          <Minus />
        </Button>
        <span className="w-9 text-center text-tiny tabular-nums text-fg-tertiary">{Math.round(view.k * 100)}%</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom in"
          onClick={() => zoomAt(1.2, (box.current?.clientWidth ?? 0) / 2, height / 2)}
        >
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Fit" onClick={fitView}>
          <Maximize2 />
        </Button>
      </div>
      <div className="absolute bottom-2 left-3 flex items-center gap-3 text-tiny text-fg-quaternary">
        <span className="flex items-center gap-1">
          <svg width="18" height="2" aria-hidden="true">
            <line x1="0" y1="1" x2="18" y2="1" stroke="var(--input)" />
          </svg>
          fork
        </span>
        <span className="flex items-center gap-1">
          <svg width="18" height="2" aria-hidden="true">
            <line x1="0" y1="1" x2="18" y2="1" stroke="var(--input)" strokeDasharray="4 3" />
          </svg>
          loop
        </span>
      </div>
    </div>
  )
}

/** A compact, collapsible outline of the tree for the properties side panel. */
export function TreeOutline({ root, currentId }: { root: SessionTreeNode; currentId?: string }) {
  const navigate = useNavigate()
  const render = (n: SessionTreeNode, depth: number) => (
    <div key={n.id}>
      <button
        type="button"
        onClick={() => navigate(`/sessions/${n.id}`)}
        className={cn(
          'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left hover:bg-secondary',
          n.id === currentId && 'bg-accent-tint text-foreground',
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <StatusIcon status={sessionStatusKey(n.status, n.runState)} tooltip={false} className="size-3.5" />
        <span className="min-w-0 truncate text-fg-secondary">{n.title}</span>
        {n.loop && <Repeat className="ml-auto size-3 shrink-0 text-fg-quaternary" />}
      </button>
      {n.children.map((c) => render(c, depth + 1))}
    </div>
  )
  return <div className="flex flex-col">{render(root, 0)}</div>
}
