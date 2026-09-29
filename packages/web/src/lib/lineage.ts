import type { LineageEdge, LineageGraph, LineageNode } from '@mp/api'

/**
 * Turns a lineage graph into columns for a left-to-right flow view:
 * upstream nodes (causes) to the left of the focus, downstream nodes
 * (effects) to the right. A node's column is its longest distance from the
 * focus, so chains read in order even when paths have different lengths.
 * Nodes not connected to the focus are dropped. Cycles are tolerated.
 */
export interface LineageColumn {
  /** Negative: upstream, 0: focus, positive: downstream. */
  index: number
  nodes: LineageNode[]
}

export interface LineageLayout {
  focus: LineageNode | null
  columns: LineageColumn[]
  edges: LineageEdge[]
  upstream: Set<string>
  downstream: Set<string>
}

function longestDistances(start: string, next: Map<string, string[]>): Map<string, number> {
  // Longest path in a graph that may contain cycles: relax along a BFS, but
  // never revisit a node that is on the current chain (bounded by node count).
  const dist = new Map<string, number>([[start, 0]])
  const limit = next.size + 1
  const queue: { id: string; d: number; chain: Set<string> }[] = [{ id: start, d: 0, chain: new Set([start]) }]
  let guard = 0
  while (queue.length && guard++ < 10_000) {
    const { id, d, chain } = queue.shift()!
    for (const to of next.get(id) ?? []) {
      if (chain.has(to) || d + 1 > limit) continue
      if ((dist.get(to) ?? -1) >= d + 1) continue
      dist.set(to, d + 1)
      queue.push({ id: to, d: d + 1, chain: new Set([...chain, to]) })
    }
  }
  return dist
}

export function buildLineage(graph: LineageGraph): LineageLayout {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const focus = byId.get(graph.focus) ?? null
  if (!focus) return { focus: null, columns: [], edges: [], upstream: new Set(), downstream: new Set() }
  const out = new Map<string, string[]>()
  const inc = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue
    out.set(e.from, [...(out.get(e.from) ?? []), e.to])
    inc.set(e.to, [...(inc.get(e.to) ?? []), e.from])
  }
  const down = longestDistances(focus.id, out)
  const up = longestDistances(focus.id, inc)
  const col = new Map<string, number>()
  col.set(focus.id, 0)
  for (const [id, d] of up) if (id !== focus.id) col.set(id, -d)
  for (const [id, d] of down) if (id !== focus.id && !col.has(id)) col.set(id, d)

  const groups = new Map<number, LineageNode[]>()
  for (const n of graph.nodes) {
    const c = col.get(n.id)
    if (c === undefined) continue
    groups.set(c, [...(groups.get(c) ?? []), n])
  }
  const order: Record<LineageNode['type'], number> = { event: 0, subscription: 1, trigger: 2, delivery: 3, session: 4, run: 5 }
  const columns = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, nodes]) => ({
      index,
      nodes: [...nodes].sort(
        (a, b) => order[a.type] - order[b.type] || (a.at ?? '').localeCompare(b.at ?? '') || a.id.localeCompare(b.id),
      ),
    }))
  const edges = graph.edges.filter((e) => col.has(e.from) && col.has(e.to) && e.from !== e.to)
  const upstream = new Set([...up.keys()].filter((id) => id !== focus.id))
  const downstream = new Set([...down.keys()].filter((id) => id !== focus.id && !upstream.has(id)))
  return { focus, columns, edges, upstream, downstream }
}

/** The chain from the focus back to its first cause: one node per upstream column, following edges. */
export function originChain(layout: LineageLayout): LineageNode[] {
  if (!layout.focus) return []
  const byCol = new Map(layout.columns.map((c) => [c.index, c.nodes]))
  const chain: LineageNode[] = [layout.focus]
  let current = layout.focus
  for (let c = -1; byCol.has(c); c--) {
    const candidates = byCol.get(c)!
    const parent = candidates.find((n) => layout.edges.some((e) => e.from === n.id && e.to === current.id)) ?? null
    if (!parent) break
    chain.unshift(parent)
    current = parent
  }
  return chain
}
