import { ManualClock, NotFoundError, ValidationError } from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import { ABOUT, createMemory, normalizeSummary, type MemoryService } from '../src/index.ts'

let clock: ManualClock
let records: Records
let mem: MemoryService
let ana: string
let jim: string
let checkout: string
let search: string
let session: string

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 8, 1))
  records = createRecords({ store: memoryStore({ clock }) })
  for (const [kind, prefix] of [
    ['contact', 'con'],
    ['project', 'pro'],
    ['session', 'ses'],
  ] as const)
    records.kinds.define({ kind, prefix, core: [{ name: 'name', type: 'string' }] })
  mem = createMemory({ records, clock })
  ana = (await records.create('contact', { name: 'Ana' })).id
  jim = (await records.create('contact', { name: 'Jim' })).id
  checkout = (await records.create('project', { name: 'Checkout' })).id
  search = (await records.create('project', { name: 'Search' })).id
  session = (await records.create('session', { name: 's' })).id
})

describe('remember', () => {
  it('creates a memory with defaults', async () => {
    const { memory, created } = await mem.remember({
      summary: 'Deploys happen on Tuesdays.',
      source: { sessionId: session, contactId: ana },
    })
    expect(created).toBe(true)
    expect(memory.id).toMatch(/^mem_/)
    expect(memory.data).toMatchObject({
      kind: 'fact',
      scope: { type: 'company' },
      source: { sessionId: session, contactId: ana },
    })
    expect(await mem.get(memory.id)).toMatchObject({ id: memory.id })
  })

  it('updates the same fact instead of duplicating it', async () => {
    const a = await mem.remember({ summary: 'Deploys happen on Tuesdays.', content: 'v1' })
    const b = await mem.remember({ summary: '  deploys happen   on TUESDAYS ', content: 'v2', kind: 'decision' })
    expect(b.created).toBe(false)
    expect(b.memory.id).toBe(a.memory.id)
    expect(b.memory.version).toBe(2)
    expect(b.memory.data).toMatchObject({ content: 'v2', kind: 'decision' })
    expect((await records.query('memory')).total).toBe(1)
    expect(normalizeSummary('A  b.!')).toBe('a b')
  })

  it('keeps the same summary apart across scopes and employees', async () => {
    const s = 'Prefers async communication'
    const company = await mem.remember({ summary: s })
    const aboutAna = await mem.remember({ summary: s, kind: 'preference', scope: { type: 'contact', id: ana } })
    const aboutJim = await mem.remember({ summary: s, kind: 'preference', scope: { type: 'contact', id: jim } })
    const own = await mem.remember({ summary: s, employeeId: 'emp_01J00000000000000000000000' })
    expect(new Set([company, aboutAna, aboutJim, own].map((r) => r.memory.id)).size).toBe(4)
    // Scoped memories are linked to what they're about.
    const links = await mem.links(aboutAna.memory.id)
    expect(links.map((l) => [l.to.id, l.role])).toEqual([[ana, ABOUT]])
  })

  it('updates by explicit id, or creates with it', async () => {
    const a = await mem.remember({ summary: 'Old wording' })
    const b = await mem.remember({ id: a.memory.id, summary: 'New wording', content: 'x' })
    expect(b).toMatchObject({ created: false, memory: { id: a.memory.id, data: { summary: 'New wording' } } })
    // The dedupe key follows the new summary.
    expect((await mem.remember({ summary: 'new wording' })).memory.id).toBe(a.memory.id)
    const fresh = await mem.remember({ id: 'mem_01J9ZZZZZZZZZZZZZZZZZZZZZZ', summary: 'Given id' })
    expect(fresh).toMatchObject({ created: true, memory: { id: 'mem_01J9ZZZZZZZZZZZZZZZZZZZZZZ' } })
  })

  it('validates', async () => {
    await expect(mem.remember({ summary: '  ' })).rejects.toThrow(ValidationError)
    await expect(mem.remember({ summary: 'x', scope: { type: 'project' } })).rejects.toThrow(/scope.id/)
    await expect(mem.remember({ summary: 'x', scope: { type: 'company', id: checkout } })).rejects.toThrow(ValidationError)
    await expect(mem.remember({ summary: 'x', kind: 'rumour' as any })).rejects.toThrow(ValidationError)
    await expect(mem.remember({ summary: 'x', about: [{ kind: 'contact', id: 'con_missing' }] })).rejects.toThrow(NotFoundError)
  })

  it('does not duplicate under concurrent remembers', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => mem.remember({ summary: 'Same fact', content: `c${i}` })),
    )
    expect(new Set(results.map((r) => r.memory.id)).size).toBe(1)
    expect(results.filter((r) => r.created).length).toBe(1)
    expect((await records.query('memory')).total).toBe(1)
  })
})

describe('recall', () => {
  beforeEach(async () => {
    await mem.remember({
      summary: 'Checkout deploys need a feature flag',
      content: 'Use the flags service.',
      scope: { type: 'project', id: checkout },
    })
    await mem.remember({ summary: 'Search index rebuilds take an hour', scope: { type: 'project', id: search } })
    await mem.remember({ summary: 'Ana prefers async, no calls', kind: 'preference', scope: { type: 'contact', id: ana } })
    await mem.remember({ summary: 'Company deploy freeze in December', kind: 'decision' })
    await mem.remember({ summary: 'Private note about deploy tooling', employeeId: 'emp_01JA0000000000000000000000' })
  })

  it('scores by keywords, summary above content', async () => {
    const res = await mem.recall({ text: 'deploy flags' })
    expect(res[0]?.memory.data.summary).toBe('Checkout deploys need a feature flag')
    expect(res.map((r) => r.memory.data.summary)).toContain('Company deploy freeze in December')
    expect(res.every((r) => r.score > 0)).toBe(true)
  })

  it('only returns memories visible in the context', async () => {
    const ctx = { employeeId: 'emp_01JB0000000000000000000000', projectIds: [search], contactIds: [] }
    const res = await mem.recall({ text: 'deploy index async', context: ctx })
    expect(res.map((r) => r.memory.data.summary).sort()).toEqual([
      'Company deploy freeze in December',
      'Search index rebuilds take an hour',
    ])
    const own = await mem.recall({ text: 'deploy', context: { employeeId: 'emp_01JA0000000000000000000000' } })
    expect(own.map((r) => r.memory.data.summary).sort()).toEqual([
      'Company deploy freeze in December',
      'Private note about deploy tooling',
    ])
    const withAna = await mem.recall({ text: 'async', context: { contactIds: [ana] } })
    expect(withAna.map((r) => r.memory.data.summary)).toEqual(['Ana prefers async, no calls'])
  })

  it('finds memories by links and scope refs', async () => {
    const { memory } = await mem.remember({ summary: 'Jim reviews billing changes', about: [{ kind: 'contact', id: jim }] })
    await mem.link(memory.id, { kind: 'session', id: session }, 'learned_in')
    const byJim = await mem.recall({ refs: [{ kind: 'contact', id: jim }] })
    expect(byJim.map((r) => r.memory.id)).toEqual([memory.id])
    expect(byJim[0]?.matchedRefs).toEqual([{ kind: 'contact', id: jim }])
    const bySession = await mem.recall({ refs: [{ kind: 'session', id: session }] })
    expect(bySession.map((r) => r.memory.id)).toEqual([memory.id])
    const byProject = await mem.recall({ refs: [{ kind: 'project', id: checkout }], text: 'deploy' })
    expect(byProject[0]?.memory.data.summary).toBe('Checkout deploys need a feature flag')
    // Link matches rank above plain keyword matches.
    expect(byProject[0]!.score).toBeGreaterThan(byProject[1]?.score ?? 0)
    await mem.unlink(memory.id, { kind: 'session', id: session }, 'learned_in')
    expect(await mem.recall({ refs: [{ kind: 'session', id: session }] })).toEqual([])
  })

  it('filters by kind, limits, and lists recent memories without a query', async () => {
    expect((await mem.recall({ text: 'deploy', kinds: ['decision'] })).map((r) => r.memory.data.kind)).toEqual(['decision'])
    expect((await mem.recall({ text: 'deploy', limit: 1 })).length).toBe(1)
    clock.advance(1000)
    const { memory } = await mem.remember({ summary: 'Newest thing' })
    const recent = await mem.recall({ limit: 2 })
    expect(recent[0]?.memory.id).toBe(memory.id)
    expect(recent.length).toBe(2)
    const recentVisible = await mem.recall({ context: {} })
    expect(recentVisible.map((r) => r.memory.data.summary).sort()).toEqual(['Company deploy freeze in December', 'Newest thing'])
    expect(await mem.recall({ text: 'nothing matches zzz' })).toEqual([])
  })
})

describe('link, verify, forget', () => {
  it('verifies with the clock', async () => {
    const { memory } = await mem.remember({ summary: 'x' })
    clock.set(Date.UTC(2026, 8, 15))
    expect((await mem.verify(memory.id)).data.verified).toBe('2026-09-15T00:00:00.000Z')
    await expect(mem.verify('mem_missing')).rejects.toThrow(NotFoundError)
  })

  it('forgets a memory with its links', async () => {
    const { memory } = await mem.remember({ summary: 'x', scope: { type: 'contact', id: ana } })
    const other = await mem.remember({ summary: 'y' })
    await mem.link(other.memory.id, { kind: 'memory', id: memory.id }, 'related')
    await mem.forget(memory.id)
    expect(await mem.get(memory.id)).toBeNull()
    expect(await mem.links(other.memory.id)).toEqual([])
    await expect(mem.forget(memory.id)).rejects.toThrow(NotFoundError)
    await expect(mem.link(other.memory.id, { kind: 'memory', id: other.memory.id })).rejects.toThrow(ValidationError)
    await expect(mem.link('mem_missing', { kind: 'contact', id: ana })).rejects.toThrow(NotFoundError)
  })

  it('updates, moving the dedupe key', async () => {
    const { memory } = await mem.remember({ summary: 'a' })
    await mem.update(memory.id, { summary: 'b', scope: { type: 'project', id: checkout } })
    expect((await mem.remember({ summary: 'B', scope: { type: 'project', id: checkout } })).memory.id).toBe(memory.id)
    expect((await mem.remember({ summary: 'a' })).created).toBe(true)
    await expect(mem.update(memory.id, { scope: { type: 'contact' } })).rejects.toThrow(ValidationError)
  })

  it('keeps [[kind:id]] mentions in content as backlinks', async () => {
    const { memory } = await mem.remember({ summary: 'z', content: `Ask [[contact:${ana}]]` })
    expect((await records.backlinks({ kind: 'contact', id: ana })).map((r) => r.id)).toEqual([memory.id])
  })
})
