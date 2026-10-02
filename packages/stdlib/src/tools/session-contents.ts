import type { Json } from '@mp/core'
import type { PointerContent, SummaryContent } from '@mp/sessions'
import type { Entry } from '@mp/store'
import { fail, line, ok, str, type Kit } from '../kit.ts'

/**
 * sessions.contents: a table of contents of a session's history (docs/spec.md#context). Every collapse
 * (sessions.rewind with from and to), jump back, compaction (by the model or automatic), run committed as a
 * summary, and offload on the current path, oldest first, with what it replaced (entry range, entries, size),
 * the summary's first line, and how to get the detail back: an offload is put back with sessions.restore; the
 * entries of a collapsed or compacted stretch are listed with `item`, and each is read back with
 * sessions.restore { entryId, offset: 0 } (it reads, it doesn't put the stretch back).
 */

/** Characters of an entry as the context estimates count them. */
const chars = (e: Entry): number => JSON.stringify(e.content).length

/** The most entries `item` lists. */
const ITEM_MAX = 60

type Op = 'collapse' | 'jump_back' | 'compaction' | 'run_summary' | 'offload'

const opOf = (e: Entry): Op | null => {
  if (e.kind === 'pointer') return 'offload'
  if (e.kind !== 'summary') return null
  const op = e.meta?.op
  if (op === 'compact') return 'compaction'
  if (op === 'commitSummary') return 'run_summary'
  if (op === 'rewind') return typeof e.meta?.collapsedFrom === 'string' ? 'collapse' : 'jump_back'
  return null
}

const toolOf = (e: Entry): string | undefined => {
  const c = e.content as { name?: unknown; toolCalls?: { name: string }[] } | null
  if (e.kind === 'tool_result' && typeof c?.name === 'string') return c.name
  if (e.kind === 'assistant' && c?.toolCalls?.length) return c.toolCalls.map((t) => t.name).join(', ')
  return undefined
}

const textOf = (e: Entry): string => {
  const c = e.content as Record<string, unknown> | null
  if (c && typeof c.text === 'string') return c.text
  if (e.kind === 'tool_result') return typeof c?.output === 'string' ? c.output : JSON.stringify(c?.output ?? '')
  return JSON.stringify(c)
}

export function registerSessionContents(kit: Kit): void {
  const { sessions, records } = kit.deps
  const store = records.store.entries

  /** The entries a summary stands for, on the branch it replaced (oldest first). */
  const replacedBy = async (summary: Entry): Promise<Entry[]> => {
    const c = summary.content as unknown as SummaryContent
    const m = summary.meta ?? {}
    const op = opOf(summary)
    // A collapse names its stretch; a compaction or run summary replaced what followed its rewind point.
    const last = op === 'collapse' ? String(m.collapsedTo) : c.replacesTip
    if (!last || !c.rewoundTo) return []
    let path: Entry[]
    try {
      path = await store.path(last)
    } catch {
      return []
    }
    const from = path.findIndex((e) => e.id === c.rewoundTo)
    let to = path.length
    // A compaction that kept the end: the kept part isn't replaced.
    if (op !== 'collapse' && typeof m.keptFrom === 'string') {
      const k = path.findIndex((e) => e.id === m.keptFrom)
      if (k >= 0) to = k
    }
    return path.slice(from + 1, to)
  }

  kit.tool(
    {
      name: 'sessions.contents',
      description:
        "A table of contents of your history: every collapse, jump back, compaction and offload, oldest first, with the entries it replaced, their size, the summary's first line, and how to get the detail back. Use it to find where something happened before it was summarized. item: <the item's entryId> lists the entries of one collapsed or compacted stretch, each with a ready sessions.restore call that reads it back. Default: this session.",
      effect: 'read',
      params: {
        properties: {
          item: { type: 'string', description: 'The entryId of one item: list the entries it replaced.' },
          sessionId: { type: 'string', description: 'Another of your sessions (its committed history).' },
          offset: { type: 'number', description: 'With item: skip this many of its entries.' },
        },
      },
    },
    async (a, ctx) => {
      const s = await kit.ownSession(a.sessionId, ctx)
      let path: Entry[]
      if (s.id === ctx.sessionId) {
        const run = await sessions.getRun(ctx.runId)
        path = run && run.data.sessionId === s.id ? await sessions.runHistory(run.id) : await sessions.history(s.id)
      } else path = await sessions.history(s.id)

      const itemId = str(a.item)
      if (itemId) {
        const e = path.find((x) => x.id === itemId)
        if (!e || !opOf(e)) return fail(`${itemId} is not an item of this history: sessions.contents lists them`)
        if (e.kind === 'pointer') {
          const original = (e.content as unknown as PointerContent).original
          return ok({
            item: itemId,
            op: 'offload',
            original,
            restore: { tool: 'sessions.restore', args: { entryId: original } },
            read: { tool: 'sessions.restore', args: { entryId: original, offset: 0 } },
          })
        }
        const replaced = await replacedBy(e)
        const offset = Math.max(0, Math.floor(Number(a.offset ?? 0)) || 0)
        const shown = replaced.slice(offset, offset + ITEM_MAX)
        return ok({
          item: itemId,
          op: opOf(e),
          entries: replaced.length,
          shown: shown.map((x) => ({
            entryId: x.id,
            kind: x.kind,
            ...(toolOf(x) ? { tool: toolOf(x) } : {}),
            chars: chars(x),
            text: line(textOf(x), 120),
            read: { tool: 'sessions.restore', args: { entryId: x.id, offset: 0 } },
          })),
          ...(offset + shown.length < replaced.length ? { next: `offset ${offset + shown.length} lists more` } : {}),
          note: "Reading an entry back doesn't change your history. A collapsed or compacted stretch can't be put back whole.",
        })
      }

      const items: Json[] = []
      for (const [i, e] of path.entries()) {
        const op = opOf(e)
        if (!op) continue
        const m = e.meta ?? {}
        const text = line((e.content as { text?: string }).text ?? '', 160)
        if (op === 'offload') {
          const p = e.content as unknown as PointerContent
          items.push({
            entryId: e.id,
            index: i,
            op,
            at: e.createdAt,
            original: p.original,
            ...(p.toolName ? { tool: p.toolName } : {}),
            ...(typeof m.chars === 'number' ? { chars: m.chars } : {}),
            ...(m.automatic === true ? { automatic: true } : {}),
            text,
            restore: { tool: 'sessions.restore', args: { entryId: p.original } },
          })
          continue
        }
        const replaced = await replacedBy(e)
        items.push({
          entryId: e.id,
          index: i,
          op,
          at: e.createdAt,
          ...(m.automatic === true ? { automatic: true } : {}),
          ...(replaced.length
            ? { from: replaced[0]!.id, to: replaced[replaced.length - 1]!.id, entries: replaced.length }
            : { entries: 0 }),
          chars: replaced.reduce((n, x) => n + chars(x), 0),
          ...(typeof m.collapsedToolCalls === 'number' ? { toolCalls: m.collapsedToolCalls } : {}),
          summary: text,
          ...(replaced.length ? { detail: { tool: 'sessions.contents', args: { item: e.id } } } : {}),
        })
      }
      return ok({
        sessionId: s.id,
        historyEntries: path.length,
        items,
        ...(items.length
          ? {}
          : { note: 'Nothing in this history was collapsed, compacted or offloaded: everything is still there word for word.' }),
      })
    },
  )
}
