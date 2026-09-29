import type { ApiEntry, EntryTree } from '@mp/api'
import { describe, expect, it } from 'vitest'
import { buildEntryRows, entryPreview } from '../src/lib/entry-tree.ts'

let t = 0
const e = (id: string, parent: string | null, kind = 'assistant', content: unknown = { text: id }): ApiEntry =>
  ({
    id,
    parent,
    kind,
    content,
    hash: id,
    meta: {},
    createdAt: new Date(Date.UTC(2026, 8, 29, 10, 0, t++)).toISOString(),
  }) as ApiEntry

describe('buildEntryRows', () => {
  // a → b → c(summary for x2) → d(pointer for o) → f   (head f)
  //         b → x1 → x2        (rewound)
  //         c → o → o2          (offloaded original)
  //         f → r1 → r2         (ephemeral run)
  const entries = [
    e('a', null, 'system'),
    e('b', 'a'),
    e('x1', 'b'),
    e('x2', 'x1'),
    e('c', 'b', 'summary', { text: 'tried x', rewoundTo: 'b', replacesTip: 'x2' }),
    e('o', 'c', 'tool_result', { toolCallId: '1', name: 'big', output: 'lots' }),
    e('o2', 'o'),
    e('d', 'c', 'pointer', { text: 'see doc', original: 'o' }),
    e('f', 'd'),
    e('r1', 'f', 'event', { text: 'ping' }),
    e('r2', 'r1'),
  ]
  const tree: EntryTree = {
    sessionId: 's',
    head: 'f',
    entries,
    runs: [{ id: 'run1', mode: 'ephemeral', state: 'completed', base: 'f', tip: 'r2' }],
  }
  const rows = buildEntryRows(tree)

  it('keeps the committed path on lane 0 in order', () => {
    expect(rows.filter((r) => r.lane === 0).map((r) => r.entry.id)).toEqual(['a', 'b', 'c', 'd', 'f'])
    expect(rows.filter((r) => r.onPath).map((r) => r.entry.id)).toEqual(['a', 'b', 'c', 'd', 'f'])
    expect(rows.find((r) => r.isHead)!.entry.id).toBe('f')
  })

  it('emits every entry once, branches right after their fork point', () => {
    expect(rows.map((r) => r.entry.id)).toEqual(['a', 'b', 'x1', 'x2', 'c', 'o', 'o2', 'd', 'f', 'r1', 'r2'])
    expect(new Set(rows.map((r) => r.entry.id)).size).toBe(entries.length)
  })

  it('classifies branches as rewound, offloaded and run', () => {
    const starts = rows.filter((r) => r.branchStart).map((r) => [r.entry.id, r.branchStart!.kind, r.branchStart!.size])
    expect(starts).toEqual([
      ['x1', 'rewound', 2],
      ['o', 'offloaded', 2],
      ['r1', 'run', 2],
    ])
    expect(rows.find((r) => r.entry.id === 'r1')!.branchStart).toMatchObject({
      runId: 'run1',
      mode: 'ephemeral',
      state: 'completed',
    })
  })

  it('links summaries and pointers to what they stand for', () => {
    expect(rows.find((r) => r.entry.id === 'c')!.standsFor).toBe('x2')
    expect(rows.find((r) => r.entry.id === 'd')!.standsFor).toBe('o')
  })

  it('puts nested branches on further lanes', () => {
    const nested: EntryTree = {
      sessionId: 's',
      head: 'b',
      entries: [e('a', null), e('b', 'a'), e('y', 'a'), e('y1', 'y'), e('y2', 'y')],
      runs: [],
    }
    const r = buildEntryRows(nested)
    expect(r.map((x) => [x.entry.id, x.lane])).toEqual([
      ['a', 0],
      ['y', 1],
      ['y1', 1],
      ['y2', 2],
      ['b', 0],
    ])
  })

  it('handles an empty tree and a missing head', () => {
    expect(buildEntryRows({ sessionId: 's', head: null, entries: [], runs: [] })).toEqual([])
    const r = buildEntryRows({ sessionId: 's', head: null, entries: [e('a', null), e('b', 'a')], runs: [] })
    expect(r.map((x) => x.entry.id)).toEqual(['a', 'b'])
    expect(r.every((x) => !x.onPath)).toBe(true)
  })
})

describe('entryPreview', () => {
  it('previews text, tool calls and results', () => {
    expect(entryPreview(e('1', null, 'user', { text: 'hello\n  world' }))).toBe('hello world')
    expect(entryPreview(e('2', null, 'assistant', { text: null, toolCalls: [{ id: 'c', name: 'a.b', arguments: '{}' }] }))).toBe(
      'a.b()',
    )
    expect(entryPreview(e('3', null, 'tool_result', { toolCallId: 'c', name: 'x', output: { ok: true } }))).toBe(
      'x → {"ok":true}',
    )
    expect(entryPreview(e('4', null, 'user', { text: 'x'.repeat(300) }), 10)).toHaveLength(10)
  })
})
