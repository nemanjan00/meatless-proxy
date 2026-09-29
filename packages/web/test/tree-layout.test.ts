import { describe, expect, it } from 'vitest'
import { layoutTree, overlaps, type TreeInput } from '../src/lib/tree-layout.ts'

const opts = { nodeWidth: 100, nodeHeight: 40, gapX: 10, gapY: 20 }
const t = (id: string, ...children: TreeInput<string>[]): TreeInput<string> => ({ id, data: id, children })

function noOverlaps(nodes: { x: number; y: number }[]) {
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) expect(overlaps(nodes[i]!, nodes[j]!, opts.nodeWidth, opts.nodeHeight)).toBe(false)
}

describe('layoutTree', () => {
  it('lays out a single node at the origin', () => {
    const l = layoutTree(t('a'), opts)
    expect(l.nodes).toEqual([expect.objectContaining({ id: 'a', x: 0, y: 0, depth: 0, parentId: null, hasChildren: false })])
    expect(l.edges).toEqual([])
    expect(l.width).toBe(100)
    expect(l.height).toBe(40)
  })

  it('centres a parent over its children and spaces siblings', () => {
    const l = layoutTree(t('a', t('b'), t('c'), t('d')), opts)
    const by = Object.fromEntries(l.nodes.map((n) => [n.id, n]))
    expect(by.b!.x).toBe(0)
    expect(by.c!.x).toBe(110)
    expect(by.d!.x).toBe(220)
    expect(by.a!.x).toBe(110)
    expect(by.b!.y).toBe(60)
    expect(l.edges).toHaveLength(3)
    expect(l.edges[0]!.path).toMatch(/^M160,40 C/)
    noOverlaps(l.nodes)
  })

  it('packs subtrees by contour without overlap', () => {
    const tree = t('r', t('a', t('a1'), t('a2', t('a2x'), t('a2y'))), t('b'), t('c', t('c1'), t('c2'), t('c3')))
    const l = layoutTree(tree, opts)
    expect(l.nodes).toHaveLength(11)
    noOverlaps(l.nodes)
    const by = Object.fromEntries(l.nodes.map((n) => [n.id, n]))
    // every parent sits between its first and last child
    for (const n of l.nodes) {
      const kids = l.nodes.filter((k) => k.parentId === n.id)
      if (!kids.length) continue
      const xs = kids.map((k) => k.x)
      expect(n.x).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2)
    }
    expect(by.b!.x).toBeGreaterThan(by.a!.x)
    expect(Math.min(...l.nodes.map((n) => n.x))).toBe(0)
  })

  it('treats collapsed nodes as leaves and counts what is hidden', () => {
    const tree = t('r', t('a', t('a1'), t('a2', t('a2x'))), t('b'))
    const l = layoutTree(tree, { ...opts, collapsed: new Set(['a']) })
    expect(l.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'r'])
    const a = l.nodes.find((n) => n.id === 'a')!
    expect(a.collapsed).toBe(true)
    expect(a.hidden).toBe(3)
    expect(a.hasChildren).toBe(true)
  })

  it('ignores collapsing a leaf', () => {
    const l = layoutTree(t('r', t('a')), { ...opts, collapsed: new Set(['a']) })
    expect(l.nodes.find((n) => n.id === 'a')!.collapsed).toBe(false)
  })

  it('handles a wide loop and a deep chain', () => {
    const loop = t('p', ...Array.from({ length: 20 }, (_, i) => t(`c${i}`)))
    noOverlaps(layoutTree(loop, opts).nodes)
    let deep = t('d9')
    for (let i = 8; i >= 0; i--) deep = t(`d${i}`, deep)
    const l = layoutTree(deep, opts)
    expect(l.height).toBe(9 * 60 + 40)
    expect(new Set(l.nodes.map((n) => n.x)).size).toBe(1)
  })

  it('rejects duplicate ids', () => {
    expect(() => layoutTree(t('a', t('b'), t('b')), opts)).toThrow(/duplicate/)
  })
})
