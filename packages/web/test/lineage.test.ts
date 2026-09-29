import type { LineageGraph } from '@mp/api'
import { describe, expect, it } from 'vitest'
import { buildLineage, originChain } from '../src/lib/lineage.ts'

const n = (id: string, type: LineageGraph['nodes'][number]['type']) => ({ id, type, label: id })

// ev1 → d1 ← t1 ; d1 → r1 ← s1 ; r1 → s2 (fork) → r2 → s3 (loop) ; r2 → ev2 (emitted)
const graph: LineageGraph = {
  focus: 's2',
  nodes: [
    n('ev1', 'event'),
    n('t1', 'trigger'),
    n('d1', 'delivery'),
    n('s1', 'session'),
    n('r1', 'run'),
    n('s2', 'session'),
    n('r2', 'run'),
    n('s3', 'session'),
    n('ev2', 'event'),
    n('x', 'session'),
  ],
  edges: [
    { from: 'ev1', to: 'd1', type: 'matched' },
    { from: 't1', to: 'd1', type: 'matched' },
    { from: 'd1', to: 'r1', type: 'delivered' },
    { from: 's1', to: 'r1', type: 'ran' },
    { from: 'r1', to: 's2', type: 'forked' },
    { from: 's2', to: 'r2', type: 'ran' },
    { from: 'r2', to: 's3', type: 'looped' },
    { from: 'r2', to: 'ev2', type: 'emitted' },
    { from: 'missing', to: 's2', type: 'forked' },
  ],
}

describe('buildLineage', () => {
  it('puts causes left and effects right of the focus', () => {
    const l = buildLineage(graph)
    const col = Object.fromEntries(l.columns.flatMap((c) => c.nodes.map((x) => [x.id, c.index])))
    expect(col).toEqual({ ev1: -3, t1: -3, d1: -2, s1: -2, r1: -1, s2: 0, r2: 1, s3: 2, ev2: 2 })
    expect(l.upstream).toEqual(new Set(['ev1', 't1', 'd1', 's1', 'r1']))
    expect(l.downstream).toEqual(new Set(['r2', 's3', 'ev2']))
  })

  it('drops disconnected nodes and edges to unknown nodes', () => {
    const l = buildLineage(graph)
    expect(l.columns.flatMap((c) => c.nodes).some((x) => x.id === 'x')).toBe(false)
    expect(l.edges.some((e) => e.from === 'missing')).toBe(false)
  })

  it('orders nodes in a column by type (events before triggers before deliveries…)', () => {
    const l = buildLineage(graph)
    expect(l.columns.find((c) => c.index === -3)!.nodes.map((x) => x.id)).toEqual(['ev1', 't1'])
    expect(l.columns.find((c) => c.index === -2)!.nodes.map((x) => x.id)).toEqual(['d1', 's1'])
  })

  it('uses the longest path so chains read in order', () => {
    const g: LineageGraph = {
      focus: 'a',
      nodes: [n('a', 'event'), n('b', 'delivery'), n('c', 'run'), n('d', 'session')],
      edges: [
        { from: 'a', to: 'b', type: 'matched' },
        { from: 'b', to: 'c', type: 'delivered' },
        { from: 'c', to: 'd', type: 'forked' },
        { from: 'a', to: 'd', type: 'matched' },
      ],
    }
    const col = Object.fromEntries(buildLineage(g).columns.flatMap((c) => c.nodes.map((x) => [x.id, c.index])))
    expect(col.d).toBe(3)
  })

  it('tolerates cycles', () => {
    const g: LineageGraph = {
      focus: 'a',
      nodes: [n('a', 'run'), n('b', 'event'), n('c', 'run')],
      edges: [
        { from: 'a', to: 'b', type: 'emitted' },
        { from: 'b', to: 'c', type: 'matched' },
        { from: 'c', to: 'a', type: 'emitted' },
      ],
    }
    const l = buildLineage(g)
    expect(l.columns.flatMap((c) => c.nodes)).toHaveLength(3)
  })

  it('returns an empty layout for an unknown focus', () => {
    const l = buildLineage({ ...graph, focus: 'nope' })
    expect(l.focus).toBeNull()
    expect(l.columns).toEqual([])
  })
})

describe('originChain', () => {
  it('follows edges back to the first cause', () => {
    expect(originChain(buildLineage(graph)).map((x) => x.id)).toEqual(['ev1', 'd1', 'r1', 's2'])
  })
  it('is just the focus for a root', () => {
    expect(originChain(buildLineage({ ...graph, focus: 'ev1' })).map((x) => x.id)).toEqual(['ev1'])
  })
})
