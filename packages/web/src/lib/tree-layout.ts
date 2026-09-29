/**
 * A small tidy-tree layout for the session fork tree. Top-down: depth maps
 * to y, and x is chosen so that siblings never overlap and every parent is
 * centred over its children.
 *
 * Algorithm: a post-order pass lays out each subtree on its own, then places
 * sibling subtrees side by side, pushing each one right until its left
 * contour clears the right contour of the siblings before it (a simplified
 * Reingold–Tilford). Parents sit midway between their first and last child.
 * Collapsed nodes are laid out as leaves.
 */

export interface TreeInput<T> {
  id: string
  data: T
  children: TreeInput<T>[]
}

export interface LayoutOptions {
  nodeWidth: number
  nodeHeight: number
  /** Horizontal gap between neighbouring nodes. */
  gapX: number
  /** Vertical gap between levels. */
  gapY: number
  /** Ids of nodes whose children are hidden. */
  collapsed?: ReadonlySet<string>
}

export interface LaidOutNode<T> {
  id: string
  data: T
  depth: number
  /** Top-left corner. */
  x: number
  y: number
  /** Number of descendants hidden because this node (or an ancestor) is collapsed. */
  hidden: number
  collapsed: boolean
  hasChildren: boolean
  parentId: string | null
}

export interface LaidOutEdge {
  from: string
  to: string
  /** An SVG path from the bottom centre of the parent to the top centre of the child. */
  path: string
}

export interface TreeLayout<T> {
  nodes: LaidOutNode<T>[]
  edges: LaidOutEdge[]
  width: number
  height: number
}

interface Sub {
  /** Offsets relative to the subtree root's x, per depth below it. */
  left: number[]
  right: number[]
  /** Child subtrees with their x offset relative to this root. */
  kids: { sub: Sub; dx: number }[]
  node: TreeInput<unknown>
  hidden: number
  collapsed: boolean
}

function countDescendants(n: TreeInput<unknown>): number {
  let c = 0
  for (const k of n.children) c += 1 + countDescendants(k)
  return c
}

function build(n: TreeInput<unknown>, opts: LayoutOptions, seen: Set<string>): Sub {
  if (seen.has(n.id)) throw new Error(`cycle or duplicate id in tree: ${n.id}`)
  seen.add(n.id)
  const collapsed = !!opts.collapsed?.has(n.id) && n.children.length > 0
  const step = opts.nodeWidth + opts.gapX
  if (collapsed || n.children.length === 0) {
    return { left: [0], right: [0], kids: [], node: n, hidden: collapsed ? countDescendants(n) : 0, collapsed }
  }
  const subs = n.children.map((c) => build(c, opts, seen))
  // Place children left to right, each as close as its contour allows.
  const placed: { sub: Sub; x: number }[] = []
  const accRight: number[] = []
  for (const sub of subs) {
    let x = 0
    if (placed.length) {
      x = Number.NEGATIVE_INFINITY
      for (let d = 0; d < sub.left.length && d < accRight.length; d++) x = Math.max(x, accRight[d]! - sub.left[d]! + step)
      if (x === Number.NEGATIVE_INFINITY) x = placed.at(-1)!.x + step
    }
    placed.push({ sub, x })
    for (let d = 0; d < sub.right.length; d++) accRight[d] = Math.max(accRight[d] ?? Number.NEGATIVE_INFINITY, x + sub.right[d]!)
  }
  const mid = (placed[0]!.x + placed.at(-1)!.x) / 2
  const kids = placed.map((p) => ({ sub: p.sub, dx: p.x - mid }))
  const left: number[] = [0]
  const right: number[] = [0]
  for (const { sub, dx } of kids) {
    for (let d = 0; d < sub.left.length; d++) {
      left[d + 1] = Math.min(left[d + 1] ?? Number.POSITIVE_INFINITY, dx + sub.left[d]!)
      right[d + 1] = Math.max(right[d + 1] ?? Number.NEGATIVE_INFINITY, dx + sub.right[d]!)
    }
  }
  return { left, right, kids, node: n, hidden: 0, collapsed: false }
}

export function layoutTree<T>(root: TreeInput<T>, opts: LayoutOptions): TreeLayout<T> {
  const sub = build(root as TreeInput<unknown>, opts, new Set())
  const raw: { sub: Sub; x: number; depth: number; parentId: string | null }[] = []
  const walk = (s: Sub, x: number, depth: number, parentId: string | null) => {
    raw.push({ sub: s, x, depth, parentId })
    for (const k of s.kids) walk(k.sub, x + k.dx, depth + 1, s.node.id)
  }
  walk(sub, 0, 0, null)
  const minX = Math.min(...raw.map((r) => r.x))
  const levelH = opts.nodeHeight + opts.gapY
  const nodes: LaidOutNode<T>[] = raw.map((r) => ({
    id: r.sub.node.id,
    data: r.sub.node.data as T,
    depth: r.depth,
    x: r.x - minX,
    y: r.depth * levelH,
    hidden: r.sub.hidden,
    collapsed: r.sub.collapsed,
    hasChildren: r.sub.node.children.length > 0,
    parentId: r.parentId,
  }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges: LaidOutEdge[] = []
  for (const n of nodes) {
    if (!n.parentId) continue
    const p = byId.get(n.parentId)!
    const x1 = p.x + opts.nodeWidth / 2
    const y1 = p.y + opts.nodeHeight
    const x2 = n.x + opts.nodeWidth / 2
    const y2 = n.y
    const my = (y1 + y2) / 2
    edges.push({ from: p.id, to: n.id, path: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}` })
  }
  const width = Math.max(...nodes.map((n) => n.x)) + opts.nodeWidth
  const height = Math.max(...nodes.map((n) => n.y)) + opts.nodeHeight
  return { nodes, edges, width, height }
}

/** True when two laid-out nodes' boxes overlap (used by tests and debug checks). */
export function overlaps(a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number): boolean {
  return a.x < b.x + w && b.x < a.x + w && a.y < b.y + h && b.y < a.y + h
}
