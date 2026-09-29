import type { ApiEntry, EntryTree, PointerContent, RunMode, RunState, SummaryContent } from '@mp/api'

/**
 * Lays out a session's entry tree as rows for a git-graph-like view. The
 * committed path (root → head) is lane 0. Everything else hangs off it as
 * branches: ephemeral or uncommitted run branches, rewound branches (which a
 * summary on the main path stands for), and offloaded entries (replaced by a
 * pointer). Rows are in history order; a branch's rows follow the entry it
 * leaves from.
 */
export type BranchKind = 'run' | 'rewound' | 'offloaded' | 'other'

export interface EntryRow {
  entry: ApiEntry
  lane: number
  onPath: boolean
  isHead: boolean
  /** Set on the first row of a branch. */
  branchStart?: { kind: BranchKind; runId?: string; mode?: RunMode; state?: RunState; size: number }
  /** For summaries: the tip of the branch they stand for. For pointers: the offloaded entry. */
  standsFor?: string
}

export function buildEntryRows(tree: EntryTree): EntryRow[] {
  const byId = new Map(tree.entries.map((e) => [e.id, e]))
  const kids = new Map<string | null, ApiEntry[]>()
  for (const e of tree.entries) {
    const p = e.parent && byId.has(e.parent) ? e.parent : null
    kids.set(p, [...(kids.get(p) ?? []), e])
  }
  for (const list of kids.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  const path = new Set<string>()
  for (let id = tree.head; id && byId.has(id); id = byId.get(id)!.parent) path.add(id)

  // Which entries are tips of rewound branches or offloaded originals.
  const rewoundTips = new Map<string, string>() // tip → summary id
  const offloaded = new Map<string, string>() // original → pointer id
  for (const e of tree.entries) {
    if (e.kind === 'summary') rewoundTips.set((e.content as unknown as SummaryContent).replacesTip, e.id)
    if (e.kind === 'pointer') offloaded.set((e.content as unknown as PointerContent).original, e.id)
  }
  const runByEntry = new Map<string, EntryTree['runs'][number]>()
  for (const r of tree.runs) {
    for (let id = r.tip; id && byId.has(id) && id !== r.base; id = byId.get(id)!.parent) {
      if (!runByEntry.has(id)) runByEntry.set(id, r)
    }
  }
  const subtreeSize = (id: string): number => 1 + (kids.get(id) ?? []).reduce((n, k) => n + subtreeSize(k.id), 0)
  const containsAny = (id: string, set: Map<string, string>): boolean =>
    set.has(id) || (kids.get(id) ?? []).some((k) => containsAny(k.id, set))

  const rows: EntryRow[] = []
  const emitBranch = (start: ApiEntry, lane: number) => {
    let kind: BranchKind = 'other'
    if (offloaded.has(start.id)) kind = 'offloaded'
    else if (containsAny(start.id, rewoundTips)) kind = 'rewound'
    else if (runByEntry.has(start.id)) kind = 'run'
    const run = runByEntry.get(start.id)
    const walk = (e: ApiEntry, first: boolean) => {
      rows.push({
        entry: e,
        lane,
        onPath: false,
        isHead: false,
        ...(first
          ? {
              branchStart: {
                kind,
                ...(run ? { runId: run.id, mode: run.mode, state: run.state } : {}),
                size: subtreeSize(start.id),
              },
            }
          : {}),
        ...standsFor(e),
      })
      const children = kids.get(e.id) ?? []
      children.forEach((c, i) => {
        if (i === 0) walk(c, false)
        else emitBranch(c, lane + 1)
      })
    }
    walk(start, true)
  }
  const standsFor = (e: ApiEntry): { standsFor?: string } => {
    if (e.kind === 'summary') return { standsFor: (e.content as unknown as SummaryContent).replacesTip }
    if (e.kind === 'pointer') return { standsFor: (e.content as unknown as PointerContent).original }
    return {}
  }

  const roots = kids.get(null) ?? []
  const mainRoot = roots.find((r) => path.has(r.id)) ?? roots[0]
  let current: ApiEntry | undefined = mainRoot
  while (current) {
    const onPath = path.has(current.id)
    rows.push({ entry: current, lane: 0, onPath, isHead: current.id === tree.head, ...standsFor(current) })
    const children: ApiEntry[] = kids.get(current.id) ?? []
    const next: ApiEntry | undefined = children.find((c) => path.has(c.id)) ?? (onPath ? undefined : children[0])
    for (const c of children) if (c !== next) emitBranch(c, 1)
    current = next
  }
  for (const r of roots) if (r !== mainRoot) emitBranch(r, 1)
  return rows
}

/** One-line preview of an entry's content. */
export function entryPreview(e: ApiEntry, max = 140): string {
  const c = e.content as Record<string, unknown> | null
  let text = ''
  if (c && typeof c === 'object') {
    if (typeof c.text === 'string') text = c.text
    else if (Array.isArray(c.toolCalls) && c.toolCalls.length)
      text = (c.toolCalls as { name: string }[]).map((t) => `${t.name}()`).join(', ')
    else if (typeof c.name === 'string')
      text = `${c.name} → ${typeof c.output === 'string' ? c.output : JSON.stringify(c.output)}`
  } else if (typeof c === 'string') text = c
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
