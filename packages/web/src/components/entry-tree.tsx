import type { EntryTree } from '@mp/api'
import { Bookmark, GitBranch, GitCommitHorizontal, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { StatusIcon } from '@/components/status-icon.tsx'
import { type BranchKind, buildEntryRows, entryPreview } from '@/lib/entry-tree.ts'
import { clockOrDate, shortId } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

const LANE = 16
const ROW_H = 30

const BRANCH_LABEL: Record<BranchKind, { label: string; color: string }> = {
  run: { label: 'run branch', color: 'var(--yellow)' },
  rewound: { label: 'rewound', color: 'var(--indigo)' },
  offloaded: { label: 'offloaded', color: 'var(--teal)' },
  other: { label: 'branch', color: 'var(--fg-tertiary)' },
}

const KIND_COLOR: Record<string, string> = {
  summary: 'var(--indigo)',
  pointer: 'var(--teal)',
  event: 'var(--blue)',
  user: 'var(--fg-secondary)',
  assistant: 'var(--fg-secondary)',
  tool_result: 'var(--fg-tertiary)',
  system: 'var(--fg-quaternary)',
}

/**
 * The session's history drawn as its entry tree: the committed path on the
 * left lane, and run branches, rewound branches and offloaded entries as
 * branches to the right, like a git graph.
 */
export function EntryTreeView({ tree, highlight }: { tree: EntryTree; highlight?: string | null }) {
  const rows = useMemo(() => buildEntryRows(tree), [tree])
  const maxLane = Math.max(0, ...rows.map((r) => r.lane))
  const gutter = 14 + (maxLane + 1) * LANE
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!highlight) return
    ref.current?.querySelector(`[data-entry="${highlight}"]`)?.scrollIntoView({ block: 'center' })
  }, [highlight])

  // Lane spans: for drawing continuous vertical lines per branch.
  const spans: { lane: number; from: number; to: number; color: string }[] = []
  const openByLane = new Map<number, { from: number; color: string }>()
  rows.forEach((r, i) => {
    if (r.branchStart) {
      const prev = openByLane.get(r.lane)
      if (prev) spans.push({ lane: r.lane, from: prev.from, to: i - 1, color: prev.color })
      openByLane.set(r.lane, { from: i, color: BRANCH_LABEL[r.branchStart.kind].color })
    }
    if (r.lane === 0) {
      for (const [lane, o] of openByLane) if (lane > 0) spans.push({ lane, from: o.from, to: i - 1, color: o.color })
      for (const lane of [...openByLane.keys()]) if (lane > 0) openByLane.delete(lane)
    }
  })
  for (const [lane, o] of openByLane) spans.push({ lane, from: o.from, to: rows.length - 1, color: o.color })

  return (
    <div ref={ref} className="relative font-mono text-micro" data-testid="entry-tree">
      <svg className="pointer-events-none absolute top-0 left-0" width={gutter} height={rows.length * ROW_H} aria-hidden="true">
        <line x1={14} y1={ROW_H / 2} x2={14} y2={(rows.length - 0.5) * ROW_H} stroke="var(--input)" strokeWidth={1.5} />
        {spans.map((s) => {
          const x = 14 + s.lane * LANE
          const y1 = s.from * ROW_H + ROW_H / 2
          const y2 = s.to * ROW_H + ROW_H / 2
          const px = 14 + (s.lane - 1) * LANE
          return (
            <g key={`${s.lane}-${s.from}`}>
              <path
                d={`M${px},${y1 - ROW_H} C${px},${y1 - ROW_H / 3} ${x},${y1 - ROW_H / 1.6} ${x},${y1}`}
                fill="none"
                stroke={s.color}
                strokeOpacity={0.7}
              />
              <line x1={x} y1={y1} x2={x} y2={y2} stroke={s.color} strokeOpacity={0.7} />
            </g>
          )
        })}
        {rows.map((r, i) => (
          <circle
            key={r.entry.id}
            cx={14 + r.lane * LANE}
            cy={i * ROW_H + ROW_H / 2}
            r={r.isHead ? 5 : 3.5}
            fill={r.isHead ? 'var(--ring)' : r.onPath ? (KIND_COLOR[r.entry.kind] ?? 'var(--fg-tertiary)') : 'var(--background)'}
            stroke={r.onPath || r.isHead ? 'none' : (KIND_COLOR[r.entry.kind] ?? 'var(--fg-tertiary)')}
            strokeWidth={1.5}
          />
        ))}
      </svg>
      {rows.map((r) => {
        const b = r.branchStart
        return (
          <div
            key={r.entry.id}
            data-entry={r.entry.id}
            className={cn(
              'flex items-center gap-2 pr-3 hover:bg-secondary',
              !r.onPath && 'text-fg-tertiary',
              highlight === r.entry.id && 'bg-accent-tint',
            )}
            style={{ height: ROW_H, paddingLeft: gutter + 4 }}
          >
            <span className="w-20 shrink-0 font-sans text-fg-quaternary">{r.entry.kind}</span>
            {b && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-sm border px-1 font-sans text-tiny"
                style={{
                  color: BRANCH_LABEL[b.kind].color,
                  borderColor: `color-mix(in srgb, ${BRANCH_LABEL[b.kind].color} 40%, transparent)`,
                }}
              >
                {b.kind === 'rewound' ? (
                  <Undo2 className="size-3" />
                ) : b.kind === 'offloaded' ? (
                  <Bookmark className="size-3" />
                ) : (
                  <GitBranch className="size-3" />
                )}
                {BRANCH_LABEL[b.kind].label}
                {b.mode && ` · ${b.mode}`} · {b.size}
                {b.state && <StatusIcon status={b.state} tooltip={false} className="size-3" />}
              </span>
            )}
            {r.entry.kind === 'summary' && <Undo2 className="size-3 shrink-0 text-[var(--indigo)]" />}
            {r.entry.kind === 'pointer' && <Bookmark className="size-3 shrink-0 text-[var(--teal)]" />}
            <span className={cn('min-w-0 truncate font-sans text-mini', r.onPath ? 'text-fg-secondary' : 'text-fg-tertiary')}>
              {entryPreview(r.entry) || '—'}
            </span>
            {r.isHead && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-accent-tint px-1 font-sans text-tiny text-[#828fff]">
                <GitCommitHorizontal className="size-3" /> head
              </span>
            )}
            {r.standsFor && <span className="shrink-0 text-tiny text-fg-quaternary">→ {shortId(r.standsFor)}</span>}
            <span className="ml-auto shrink-0 text-tiny text-fg-quaternary">{clockOrDate(r.entry.createdAt)}</span>
          </div>
        )
      })}
    </div>
  )
}
