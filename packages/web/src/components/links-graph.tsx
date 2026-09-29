import type { ApiLinkedRecord } from '@mp/api'
import { useNavigate } from 'react-router'
import { hrefFor, linkRole } from '@/lib/doclinks.ts'

const KIND_COLOR: Record<string, string> = {
  contact: 'var(--blue)',
  project: 'var(--indigo)',
  session: 'var(--yellow)',
  procedure: 'var(--green)',
  memory: 'var(--teal)',
  skill: 'var(--orange)',
}

function titleOf(r: ApiLinkedRecord['record']): string {
  const d = r.data as Record<string, unknown>
  return String(d.title ?? d.name ?? d.summary ?? r.id)
}

export interface GraphNode {
  id: string
  kind: string
  label: string
  role: string
  x: number
  y: number
  outgoing: boolean
}

/** Places linked records on a circle around the centre, grouped by kind. */
export function radialLayout(links: ApiLinkedRecord[], centerId: string, radius: number): GraphNode[] {
  const sorted = [...links].sort((a, b) => a.record.kind.localeCompare(b.record.kind) || a.link.role.localeCompare(b.link.role))
  const n = sorted.length
  return sorted.map((l, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2
    return {
      id: l.record.id,
      kind: l.record.kind,
      label: titleOf(l.record),
      role: linkRole(l.link, centerId),
      x: Math.cos(a) * radius,
      y: Math.sin(a) * radius,
      outgoing: l.link.from.id === centerId,
    }
  })
}

/** For a contact, project, procedure or memory: a graph of what it's linked to. Click a node to open it. */
export function LinksGraph({
  center,
  links,
  height = 300,
}: {
  center: { id: string; kind: string; label: string }
  links: ApiLinkedRecord[]
  height?: number
}) {
  const navigate = useNavigate()
  const r = Math.min(150, height / 2 - 40)
  const nodes = radialLayout(links, center.id, links.length ? r : 0)
  const w = 640
  return (
    <svg
      viewBox={`${-w / 2} ${-height / 2} ${w} ${height}`}
      className="w-full"
      style={{ height }}
      role="img"
      aria-label="Links graph"
      data-testid="links-graph"
    >
      {nodes.map((n) => (
        <g key={`e-${n.id}-${n.role}`}>
          <line x1={0} y1={0} x2={n.x} y2={n.y} stroke="var(--input)" />
          <text x={n.x * 0.62} y={n.y * 0.62 - 3} textAnchor="middle" fontSize={9} fill="var(--fg-quaternary)">
            {n.role}
          </text>
        </g>
      ))}
      <g>
        <circle r={7} fill={KIND_COLOR[center.kind] ?? 'var(--fg-tertiary)'} />
        <text y={22} textAnchor="middle" fontSize={11} fontWeight={590} fill="var(--foreground)">
          {center.label.length > 34 ? `${center.label.slice(0, 33)}…` : center.label}
        </text>
      </g>
      {nodes.map((n) => {
        const right = n.x >= 0
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG group acts as the link
          <g
            key={`n-${n.id}-${n.role}`}
            transform={`translate(${n.x},${n.y})`}
            className="cursor-pointer"
            onClick={() => navigate(hrefFor(n.kind, n.id))}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && navigate(hrefFor(n.kind, n.id))}
          >
            <circle r={5} fill="var(--background)" stroke={KIND_COLOR[n.kind] ?? 'var(--fg-tertiary)'} strokeWidth={2} />
            <text x={right ? 9 : -9} y={4} textAnchor={right ? 'start' : 'end'} fontSize={11} fill="var(--fg-secondary)">
              {n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}
            </text>
          </g>
        )
      })}
      <g transform={`translate(${-w / 2 + 8},${height / 2 - 10})`}>
        {Object.entries(KIND_COLOR)
          .filter(([k]) => k === center.kind || nodes.some((n) => n.kind === k))
          .map(([k, c], i) => (
            <g key={k} transform={`translate(${i * 72},0)`}>
              <circle r={3.5} cy={-3} fill={c} />
              <text x={7} fontSize={9} fill="var(--fg-tertiary)">
                {k}
              </text>
            </g>
          ))}
      </g>
    </svg>
  )
}
