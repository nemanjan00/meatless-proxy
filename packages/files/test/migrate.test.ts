import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryLogger } from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import { memoryStore } from '@mp/store'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createFiles, directoryStorage, legacyFileSchema, migrateFileRecords, type FileStorage } from '../src/index.ts'

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

let records: Records
let storage: FileStorage
let a: string
let bC: string

/** A deployment from before the move: file contents in `file` records. */
beforeEach(async () => {
  records = createRecords({ store: memoryStore() })
  records.kinds.define({ kind: 'contact', prefix: 'con', core: [{ name: 'name', type: 'string' }] })
  records.kinds.define({ kind: 'employee', prefix: 'emp', core: [{ name: 'contactId', type: 'ref' }] })
  records.kinds.define(legacyFileSchema)
  const aC = (await records.create('contact', { name: 'A' })).id
  bC = (await records.create('contact', { name: 'B' })).id
  a = (await records.create('employee', { contactId: aC })).id
  await records.create('employee', { contactId: bC })
  const root = await mkdtemp(join(tmpdir(), 'mp-files-mig-'))
  roots.push(root)
  storage = directoryStorage({ root })
  const legacy = (path: string, content: string, encoding = 'utf8') =>
    records.create('file', { employeeId: a, path, content, encoding, size: 1 }, { key: `${a}:${path}` })
  await legacy('/notes/a.md', '# A')
  await legacy('/img.png', Buffer.from([0x89, 0x50, 0, 7]).toString('base64'), 'base64')
  await legacy('/reports/q3.md', 'q3')
  // Shares were already their own records.
  createFiles({ records, storage })
  await records.create('fs_share', { ownerEmployeeId: a, path: '/reports', withContactId: bC, permission: 'read' })
})

describe('migrateFileRecords', () => {
  it('writes contents to storage, deletes the records, and keeps the grants', async () => {
    const log = memoryLogger()
    const r = await migrateFileRecords({ records, storage, logger: log })
    expect(r).toEqual({ written: 3, alreadyThere: 0, keptNewer: 0, failed: 0 })
    expect((await records.query('file')).total).toBe(0)
    const fs = createFiles({ records, storage })
    expect((await fs.read(a, '/notes/a.md')).content).toBe('# A')
    expect(Buffer.from((await fs.read(a, '/img.png')).content, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0, 7]))
    const b = (await records.query<{ contactId: string }>('employee', { where: { contactId: bC } })).items[0]!.id
    expect((await fs.read(b, `/shared/${a}/reports/q3.md`)).content).toBe('q3')
    expect(log.lines.some((e) => e.msg.includes('moved file contents'))).toBe(true)
  })

  it('is idempotent, and safe to rerun after an interruption', async () => {
    // Interrupted: one file already written, its record not yet deleted.
    await storage.write(a, '/notes/a.md', new TextEncoder().encode('# A'))
    const r = await migrateFileRecords({ records, storage, batch: 1 })
    expect(r).toEqual({ written: 2, alreadyThere: 1, keptNewer: 0, failed: 0 })
    expect(await migrateFileRecords({ records, storage })).toEqual({ written: 0, alreadyThere: 0, keptNewer: 0, failed: 0 })
    expect((await storage.walk(a)).map((f) => f.path)).toEqual(['/img.png', '/notes/a.md', '/reports/q3.md'])
  })

  it('keeps a newer file already in storage, and leaves broken records for a person to look at', async () => {
    await storage.write(a, '/reports/q3.md', new TextEncoder().encode('edited since'))
    await records.create('file', { employeeId: a, path: '/bad.bin', content: 'not base64!', encoding: 'base64' })
    const log = memoryLogger()
    const r = await migrateFileRecords({ records, storage, logger: log })
    expect(r).toEqual({ written: 2, alreadyThere: 0, keptNewer: 1, failed: 1 })
    expect(new TextDecoder().decode(await storage.read(a, '/reports/q3.md'))).toBe('edited since')
    expect((await records.query<{ path: string }>('file')).items.map((f) => f.data.path)).toEqual(['/bad.bin'])
    expect(log.lines.some((e) => e.level === 'error')).toBe(true)
  })

  it('reads the legacy records straight from the store, without registering their kind', async () => {
    const store = memoryStore()
    await store.records.create('file', { employeeId: a, path: '/raw.txt', content: 'raw' })
    const fresh = createRecords({ store })
    expect(await migrateFileRecords({ records: store.records, storage })).toMatchObject({ written: 1 })
    expect(fresh.kinds.has('file')).toBe(false)
    expect(await store.records.count('file')).toBe(0)
    expect(new TextDecoder().decode(await storage.read(a, '/raw.txt'))).toBe('raw')
    // Nothing left: nothing to do.
    expect(await migrateFileRecords({ records: store.records, storage })).toEqual({
      written: 0,
      alreadyThere: 0,
      keptNewer: 0,
      failed: 0,
    })
  })
})
