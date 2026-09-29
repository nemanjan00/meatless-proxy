import { ConflictError, DeniedError, NotFoundError, ValidationError } from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import { createFiles, type FilesService } from '../src/index.ts'

let records: Records
let fs: FilesService
let a: string // employee A
let b: string // employee B
let aC: string
let bC: string
let person: string

beforeEach(async () => {
  records = createRecords({ store: memoryStore() })
  records.kinds.define({ kind: 'contact', prefix: 'con', core: [{ name: 'name', type: 'string' }] })
  records.kinds.define({ kind: 'employee', prefix: 'emp', core: [{ name: 'contactId', type: 'ref' }] })
  aC = (await records.create('contact', { name: 'A' })).id
  bC = (await records.create('contact', { name: 'B' })).id
  person = (await records.create('contact', { name: 'Ana' })).id
  a = (await records.create('employee', { contactId: aC })).id
  b = (await records.create('employee', { contactId: bC })).id
  fs = createFiles({ records })
})

describe('own files', () => {
  it('writes, reads, lists', async () => {
    const f = await fs.write(a, 'notes/a.md', '# Hi')
    expect(f).toMatchObject({
      path: '/notes/a.md',
      content: '# Hi',
      encoding: 'utf8',
      size: 4,
      mime: 'text/markdown',
      version: 1,
    })
    expect(f.id).toMatch(/^fil_/)
    expect((await records.get('file', f.id))?.key).toBe(`${a}:/notes/a.md`)
    await fs.write(a, '/notes/sub/b.txt', 'b')
    await fs.write(a, '/top.json', '{}')
    expect((await fs.read(a, '/notes//a.md')).content).toBe('# Hi')
    expect((await fs.list(a)).map((e) => [e.name, e.type])).toEqual([
      ['notes', 'dir'],
      ['top.json', 'file'],
    ])
    expect((await fs.list(a, '/notes')).map((e) => e.path)).toEqual(['/notes/sub', '/notes/a.md'])
    expect((await fs.list(a, '/notes/a.md')).map((e) => e.path)).toEqual(['/notes/a.md'])
    expect(await fs.list(a, '/empty')).toEqual([])
    // Private by default.
    expect(await fs.list(b)).toEqual([])
    await expect(fs.read(b, '/notes/a.md')).rejects.toThrow(NotFoundError)
  })

  it('overwrites with history and compare-and-swap', async () => {
    await fs.write(a, '/x.txt', 'v1')
    const v2 = await fs.write(a, '/x.txt', 'v2', { expectedVersion: 1 })
    expect(v2.version).toBe(2)
    await expect(fs.write(a, '/x.txt', 'v3', { expectedVersion: 1 })).rejects.toThrow(ConflictError)
    await expect(fs.write(a, '/new.txt', 'v', { expectedVersion: 3 })).rejects.toThrow(NotFoundError)
    expect((await records.revisions('file', v2.id)).map((r) => (r.data as any)?.content)).toEqual(['v1', 'v2'])
  })

  it('handles base64 content', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString('base64')
    const f = await fs.write(a, '/img.png', png, { encoding: 'base64' })
    expect(f).toMatchObject({ size: 7, mime: 'image/png', encoding: 'base64' })
    await expect(fs.write(a, '/bad.bin', 'not base64!', { encoding: 'base64' })).rejects.toThrow(/base64/)
    expect((await fs.write(a, '/u.txt', 'é')).size).toBe(2)
  })

  it('protects against traversal and invalid paths', async () => {
    await expect(fs.write(a, '../b/x', 'x')).rejects.toThrow(ValidationError)
    await expect(fs.read(a, `/shared/${b}/../../x`)).rejects.toThrow(ValidationError)
    await expect(fs.write(a, '/', 'x')).rejects.toThrow(ValidationError)
    await expect(fs.write(a, '/shared', 'x')).rejects.toThrow(ValidationError)
    await expect(fs.write(a, '/x', 42 as any)).rejects.toThrow(ValidationError)
  })

  it('keeps files and directories apart', async () => {
    await fs.write(a, '/d/f.txt', 'x')
    await expect(fs.write(a, '/d', 'x')).rejects.toThrow(ConflictError)
    await expect(fs.write(a, '/d/f.txt/g', 'x')).rejects.toThrow(ConflictError)
  })

  it('moves files and directories', async () => {
    await fs.write(a, '/d/1.txt', '1')
    await fs.write(a, '/d/e/2.txt', '2')
    await fs.write(a, '/other.txt', 'o')
    await fs.move(a, '/other.txt', '/renamed.txt')
    expect((await fs.read(a, '/renamed.txt')).content).toBe('o')
    await expect(fs.read(a, '/other.txt')).rejects.toThrow(NotFoundError)
    await fs.move(a, '/d', '/moved')
    expect((await fs.read(a, '/moved/e/2.txt')).content).toBe('2')
    expect(await fs.list(a, '/d')).toEqual([])
    await expect(fs.move(a, '/moved', '/moved/inner')).rejects.toThrow(ValidationError)
    await expect(fs.move(a, '/nothing', '/x')).rejects.toThrow(NotFoundError)
    await fs.write(a, '/t.txt', 't')
    await expect(fs.move(a, '/renamed.txt', '/t.txt')).rejects.toThrow(ConflictError)
    await fs.move(a, '/renamed.txt', '/t.txt', { overwrite: true })
    expect((await fs.read(a, '/t.txt')).content).toBe('o')
    await expect(fs.move(a, '/t.txt', '/moved')).rejects.toThrow(ConflictError)
    await expect(fs.move(a, '/t.txt', `/shared/${b}/t.txt`)).rejects.toThrow(ValidationError)
  })

  it('deletes files and, recursively, directories', async () => {
    await fs.write(a, '/d/1.txt', '1')
    await fs.write(a, '/d/2.txt', '2')
    await fs.write(a, '/f.txt', 'f')
    await fs.delete(a, '/f.txt')
    await expect(fs.read(a, '/f.txt')).rejects.toThrow(NotFoundError)
    await expect(fs.delete(a, '/d')).rejects.toThrow(/recursive/)
    await fs.delete(a, '/d', { recursive: true })
    expect(await fs.list(a)).toEqual([])
    await expect(fs.delete(a, '/d')).rejects.toThrow(NotFoundError)
  })

  it('writes concurrently to the same path without duplicates', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => fs.write(a, '/race.txt', `v${i}`)))
    expect((await records.query('file')).total).toBe(1)
  })
})

describe('sharing', () => {
  beforeEach(async () => {
    await fs.write(a, '/notes/a.md', 'A notes')
    await fs.write(a, '/notes/deep/b.md', 'B')
    await fs.write(a, '/private/secret.md', 'no')
    await fs.write(a, '/reports/q3/sum.md', 'sum')
  })

  it('shows shared owners under /shared and what they shared', async () => {
    await fs.share(a, '/notes', bC, 'read')
    expect((await fs.list(b)).map((e) => e.path)).toEqual(['/shared'])
    expect(await fs.list(b, '/shared')).toEqual([{ name: a, path: `/shared/${a}`, type: 'dir' }])
    expect((await fs.list(b, `/shared/${a}`)).map((e) => e.path)).toEqual([`/shared/${a}/notes`])
    expect((await fs.list(b, `/shared/${a}/notes`)).map((e) => e.path)).toEqual([
      `/shared/${a}/notes/deep`,
      `/shared/${a}/notes/a.md`,
    ])
    const f = await fs.read(b, `/shared/${a}/notes/deep/b.md`)
    expect(f).toMatchObject({
      content: 'B',
      ownerEmployeeId: a,
      ownerPath: '/notes/deep/b.md',
      path: `/shared/${a}/notes/deep/b.md`,
    })
    // The owner sees no /shared entry: nothing was shared with them.
    expect((await fs.list(a)).map((e) => e.name)).toEqual(['notes', 'private', 'reports'])
  })

  it('denies what is not shared, and writes without write permission', async () => {
    await fs.share(a, '/notes', bC, 'read')
    await expect(fs.read(b, `/shared/${a}/private/secret.md`)).rejects.toThrow(DeniedError)
    // No existence leaks: missing and unshared look the same.
    await expect(fs.read(b, `/shared/${a}/private/missing.md`)).rejects.toThrow(DeniedError)
    await expect(fs.list(b, `/shared/${a}/private`)).rejects.toThrow(DeniedError)
    await expect(fs.write(b, `/shared/${a}/notes/a.md`, 'hacked')).rejects.toThrow(DeniedError)
    await expect(fs.delete(b, `/shared/${a}/notes/a.md`)).rejects.toThrow(DeniedError)
    await expect(fs.read(b, `/shared/${a}/notes/missing.md`)).rejects.toThrow(NotFoundError)
    // /notes is a prefix share, /notesx is not inside it.
    await fs.write(a, '/notesx/y.md', 'y')
    await expect(fs.read(b, `/shared/${a}/notesx/y.md`)).rejects.toThrow(DeniedError)
    // Someone without any share.
    await expect(fs.read(person, `/shared/${a}/notes/a.md`)).rejects.toThrow()
    await expect(fs.forContact(person).read(`/shared/${a}/notes/a.md`)).rejects.toThrow(DeniedError)
  })

  it('lets write shares write, move and delete in the owner filesystem', async () => {
    await fs.share(a, '/notes', bC, 'write')
    const w = await fs.write(b, `/shared/${a}/notes/new.md`, 'from B')
    expect(w).toMatchObject({ ownerEmployeeId: a, ownerPath: '/notes/new.md', path: `/shared/${a}/notes/new.md` })
    expect((await fs.read(a, '/notes/new.md')).content).toBe('from B')
    await fs.move(b, `/shared/${a}/notes/new.md`, `/shared/${a}/notes/moved.md`)
    expect((await fs.read(a, '/notes/moved.md')).content).toBe('from B')
    // Can't move out of the share.
    await expect(fs.move(b, `/shared/${a}/notes/moved.md`, `/shared/${a}/private/x.md`)).rejects.toThrow(DeniedError)
    await fs.delete(b, `/shared/${a}/notes/moved.md`)
    await expect(fs.read(a, '/notes/moved.md')).rejects.toThrow(NotFoundError)
  })

  it('shares single files and shows the directories on the way', async () => {
    await fs.share(a, '/reports/q3/sum.md', person, 'read')
    const ana = fs.forContact(person)
    expect(await ana.list('/shared')).toEqual([{ name: a, path: `/shared/${a}`, type: 'dir' }])
    expect((await ana.list(`/shared/${a}`)).map((e) => e.name)).toEqual(['reports'])
    expect((await ana.list(`/shared/${a}/reports`)).map((e) => e.name)).toEqual(['q3'])
    expect((await ana.list(`/shared/${a}/reports/q3`)).map((e) => e.name)).toEqual(['sum.md'])
    expect((await ana.read(`/shared/${a}/reports/q3/sum.md`)).content).toBe('sum')
    await expect(ana.list('/')).rejects.toThrow(DeniedError)
    await expect(ana.write('/mine.txt', 'x')).rejects.toThrow(DeniedError)
    await expect(ana.write(`/shared/${a}/reports/q3/sum.md`, 'x')).rejects.toThrow(DeniedError)
  })

  it('upgrades, lists and revokes shares', async () => {
    const s1 = await fs.share(a, 'notes/', bC)
    expect(s1.data).toEqual({ ownerEmployeeId: a, path: '/notes', withContactId: bC, permission: 'read' })
    const s2 = await fs.share(a, '/notes', bC, 'write')
    expect(s2.id).toBe(s1.id)
    expect(s2.data.permission).toBe('write')
    await fs.share(a, '/reports', person)
    expect((await fs.sharedWith(bC)).map((s) => s.data.path)).toEqual(['/notes'])
    expect((await fs.sharesOf(a)).length).toBe(2)
    await fs.unshare(a, '/notes', bC)
    expect(await fs.sharedWith(bC)).toEqual([])
    await expect(fs.read(b, `/shared/${a}/notes/a.md`)).rejects.toThrow(DeniedError)
    expect(await fs.list(b, '/shared')).toEqual([])
    await fs.unshare(a, '/notes', bC) // no-op
  })

  it('validates shares', async () => {
    await expect(fs.share(a, '/shared/x', bC)).rejects.toThrow(ValidationError)
    await expect(fs.share(a, '/notes', aC)).rejects.toThrow(/yourself/)
    await expect(fs.share(a, '/notes', bC, 'admin' as any)).rejects.toThrow(ValidationError)
    await expect(fs.share(a, '../x', bC)).rejects.toThrow(ValidationError)
  })

  it('accesses own files through /shared/<self>, and uses an injected contactOf', async () => {
    expect((await fs.read(a, `/shared/${a}/private/secret.md`)).content).toBe('no')
    const custom = createFiles({ records, contactOf: (id) => (id === b ? person : null) })
    await custom.share(a, '/notes', person)
    expect((await custom.read(b, `/shared/${a}/notes/a.md`)).content).toBe('A notes')
    expect((await custom.forEmployee(b).list('/shared')).map((e) => e.name)).toEqual([a])
  })
})
