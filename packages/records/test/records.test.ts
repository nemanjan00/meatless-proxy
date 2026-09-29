import { ValidationError, type KindSchema } from '@mp/core'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MENTIONS,
  chapters,
  createDocs,
  createRecords,
  docLink,
  findChapter,
  parseDocLinks,
  upsertChapter,
  type Records,
} from '../src/index.ts'

const contact: KindSchema = {
  kind: 'contact',
  prefix: 'con',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'bio', type: 'text' },
  ],
}
const project: KindSchema = {
  kind: 'project',
  prefix: 'pro',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'description', type: 'text' },
  ],
}

describe('records', () => {
  let records: Records
  beforeEach(() => {
    records = createRecords({ store: memoryStore() })
    records.kinds.define(contact)
    records.kinds.define(project)
  })

  it('validates against the kind schema, including extensions', async () => {
    const r = await records.create('contact', { name: 'Ana' })
    expect(r.id).toMatch(/^con_/)
    await expect(records.create('contact', { bio: 'no name' })).rejects.toBeInstanceOf(ValidationError)
    records.kinds.extend('contact', [{ name: 'timezone', type: 'string', required: true }])
    await expect(records.update('contact', r.id, { bio: 'x' })).rejects.toThrow('timezone is required')
    await records.update('contact', r.id, { timezone: 'Europe/Belgrade' })
    expect(() => records.kinds.extend('contact', [{ name: 'name', type: 'number' }])).toThrow()
    // Redefining a kind keeps its extensions.
    records.kinds.define(contact)
    expect(records.kinds.get('contact').extensions?.map((f) => f.name)).toEqual(['timezone'])
  })

  it('refuses unknown kinds', async () => {
    await expect(records.create('nope', {})).rejects.toThrow('record kind nope not found')
  })

  it('links and follows links in both directions', async () => {
    const ana = await records.create('contact', { name: 'Ana' })
    const pay = await records.create('project', { name: 'Payments' })
    const a = { kind: 'contact', id: ana.id }
    const p = { kind: 'project', id: pay.id }
    await records.link(a, p, 'owner')
    expect((await records.linked(p, { direction: 'in', role: 'owner' })).map((x) => x.record.id)).toEqual([ana.id])
    expect((await records.linked(a, { direction: 'out', kind: 'project' })).map((x) => x.record.id)).toEqual([pay.id])
    expect(await records.linked(a, { direction: 'in' })).toEqual([])
    await records.unlink(a, p, 'owner')
    expect(await records.links({ touching: a })).toEqual([])
    await expect(records.link(a, p, MENTIONS)).rejects.toThrow('managed automatically')
  })

  it('keeps mentions in text fields as links, for backlinks', async () => {
    const ana = await records.create('contact', { name: 'Ana' })
    const bob = await records.create('contact', { name: 'Bob' })
    const pay = await records.create('project', {
      name: 'Payments',
      description: `Owned by ${docLink({ kind: 'contact', id: ana.id }, 'Ana')}, and [[contact:con_01J0000000000000000MISSING]].`,
    })
    expect((await records.backlinks({ kind: 'contact', id: ana.id })).map((r) => r.id)).toEqual([pay.id])
    await records.update('project', pay.id, { description: `Now ${docLink({ kind: 'contact', id: bob.id })}` })
    expect(await records.backlinks({ kind: 'contact', id: ana.id })).toEqual([])
    expect((await records.backlinks({ kind: 'contact', id: bob.id })).map((r) => r.id)).toEqual([pay.id])
    // Deleting a record cleans up its mention links without needing cascade.
    await records.delete('project', pay.id)
    expect(await records.backlinks({ kind: 'contact', id: bob.id })).toEqual([])
  })

  it('records revisions with actors', async () => {
    const actor = { type: 'session' as const, id: 'ses_x' }
    const r = await records.create('contact', { name: 'Ana' }, { actor })
    await records.update('contact', r.id, { name: 'Ana M.' })
    expect((await records.revisions('contact', r.id)).map((x) => x.actor.type)).toEqual(['session', 'system'])
  })
})

describe('doc links and chapters', () => {
  it('parses and deduplicates [[kind:id]] links', () => {
    expect(parseDocLinks('see [[contact:con_01ABC|Ana]] and [[project:pro_01XYZ]] and [[contact:con_01ABC]]')).toEqual([
      { kind: 'contact', id: 'con_01ABC', label: 'Ana' },
      { kind: 'project', id: 'pro_01XYZ' },
    ])
  })

  const md =
    '# Billing\n\nIntro.\n\n## Retry policy\n\nRetry 3 times.\n\n### Details\n\nBackoff.\n\n## Owners\n\nAna.\n\n```\n# not a heading\n```\n'

  it('splits chapters, ignoring code fences', () => {
    expect(chapters(md).map((c) => [c.heading, c.level])).toEqual([
      ['Billing', 1],
      ['Retry policy', 2],
      ['Details', 3],
      ['Owners', 2],
    ])
    expect(findChapter(md, 'retry POLICY')?.body).toBe('Retry 3 times.\n\n### Details\n\nBackoff.')
  })

  it('upserts chapters', () => {
    const replaced = upsertChapter(md, 'Retry policy', 'Retry 5 times.')
    expect(findChapter(replaced, 'Retry policy')?.body).toBe('Retry 5 times.')
    expect(findChapter(replaced, 'Owners')?.body).toContain('Ana.')
    const added = upsertChapter('# Doc\n', 'New', 'Body')
    expect(added).toBe('# Doc\n\n## New\n\nBody\n')
    expect(upsertChapter('', 'First', 'x')).toBe('## First\n\nx\n')
  })
})

describe('docs', () => {
  it('stores documents per owner and edits chapters', async () => {
    const records = createRecords({ store: memoryStore() })
    records.kinds.define(project)
    const docs = createDocs(records)
    const p = await records.create('project', { name: 'Billing' })
    const owner = { kind: 'project', id: p.id }
    const d = await docs.create({ title: 'Architecture', body: '# Architecture\n', owner, path: 'architecture' })
    await docs.writeChapter(d.id, 'Retry policy', 'Retry 3 times.')
    expect(await docs.chapter(d.id, 'Retry policy')).toBe('Retry 3 times.')
    expect(await docs.chapter(d.id, 'Missing')).toBeNull()
    expect((await docs.forOwner(owner)).map((x) => x.id)).toEqual([d.id])
    expect(await docs.forOwner(owner, 'other')).toEqual([])
  })
})
