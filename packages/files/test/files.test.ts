import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConflictError, DeniedError, NotFoundError, ValidationError, createEventBus } from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import { memoryStore } from '@mp/store'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  FILE_CHANGED,
  createFiles,
  directoryStorage,
  memoryStorage,
  type FileChanged,
  type FileStorage,
  type FilesService,
} from '../src/index.ts'

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})
const storages: [string, () => Promise<FileStorage>][] = [
  ['memory', async () => memoryStorage()],
  [
    'directory',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'mp-files-svc-'))
      roots.push(root)
      return directoryStorage({ root })
    },
  ],
]

describe.each(storages)('files service on %s storage', (_name, makeStorage) => {
  let records: Records
  let fs: FilesService
  let a: string // employee A
  let b: string // employee B
  let aC: string
  let bC: string
  let person: string
  let storage: FileStorage
  let bus: ReturnType<typeof createEventBus>
  let changes: FileChanged[]

  beforeEach(async () => {
    records = createRecords({ store: memoryStore() })
    records.kinds.define({ kind: 'contact', prefix: 'con', core: [{ name: 'name', type: 'string' }] })
    records.kinds.define({ kind: 'employee', prefix: 'emp', core: [{ name: 'contactId', type: 'ref' }] })
    aC = (await records.create('contact', { name: 'A' })).id
    bC = (await records.create('contact', { name: 'B' })).id
    person = (await records.create('contact', { name: 'Ana' })).id
    a = (await records.create('employee', { contactId: aC })).id
    b = (await records.create('employee', { contactId: bC })).id
    storage = await makeStorage()
    bus = createEventBus()
    changes = []
    bus.subscribe(FILE_CHANGED, (m) => void changes.push(m.payload as FileChanged))
    fs = createFiles({ records, storage, bus })
  })

  describe('own files', () => {
    it('writes, reads, lists', async () => {
      const f = await fs.write(a, 'notes/a.md', '# Hi')
      expect(f).toMatchObject({
        id: `${a}:/notes/a.md`,
        path: '/notes/a.md',
        content: '# Hi',
        encoding: 'utf8',
        size: 4,
        mime: 'text/markdown',
      })
      expect(f.version).toBeGreaterThan(0)
      expect(new TextDecoder().decode(await storage.read(a, '/notes/a.md'))).toBe('# Hi')
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

    it('overwrites with compare-and-swap on the version', async () => {
      const v1 = await fs.write(a, '/x.txt', 'v1')
      const v2 = await fs.write(a, '/x.txt', 'v2', { expectedVersion: v1.version })
      expect(v2.version).toBeGreaterThan(v1.version)
      expect((await fs.read(a, '/x.txt')).version).toBe(v2.version)
      await expect(fs.write(a, '/x.txt', 'v3', { expectedVersion: v1.version })).rejects.toThrow(ConflictError)
      await expect(fs.write(a, '/new.txt', 'v', { expectedVersion: 3 })).rejects.toThrow(NotFoundError)
      expect((await fs.write(a, '/new.txt', 'v', { expectedVersion: 0 })).content).toBe('v')
      expect((await fs.read(a, '/x.txt')).content).toBe('v2')
    })

    it('reads files written to storage directly (e.g. by code), guessing the encoding', async () => {
      await storage.write(a, '/out/chart.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))
      await storage.write(a, '/out/data.csv', new TextEncoder().encode('x,y\n1,2\n'))
      const png = await fs.read(a, '/out/chart.png')
      expect(png).toMatchObject({ encoding: 'base64', mime: 'image/png', size: 6 })
      expect(Buffer.from(png.content, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]))
      expect(await fs.read(a, '/out/data.csv')).toMatchObject({ encoding: 'utf8', content: 'x,y\n1,2\n', mime: 'text/csv' })
      expect((await fs.list(a, '/out')).map((e) => [e.name, e.size])).toEqual([
        ['chart.png', 6],
        ['data.csv', 8],
      ])
      await expect(fs.read(a, '/out')).rejects.toThrow(ValidationError)
    })

    it('publishes a change for every write, move and delete', async () => {
      const actor = { type: 'session' as const, id: 'ses_1' }
      await fs.write(a, '/c.txt', 'c', { actor })
      await fs.move(a, '/c.txt', '/d.txt', { actor })
      await fs.delete(a, '/d.txt', { actor })
      await bus.idle()
      expect(changes).toEqual([
        { ownerEmployeeId: a, op: 'write', path: '/c.txt', actor },
        { ownerEmployeeId: a, op: 'move', path: '/d.txt', from: '/c.txt', actor },
        { ownerEmployeeId: a, op: 'delete', path: '/d.txt', actor },
      ])
    })

    it('handles base64 content', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString('base64')
      const f = await fs.write(a, '/img.png', png, { encoding: 'base64' })
      expect(f).toMatchObject({ size: 7, mime: 'image/png', encoding: 'base64' })
      await expect(fs.write(a, '/bad.bin', 'not base64!', { encoding: 'base64' })).rejects.toThrow(/base64/)
      for (const bad of ['AAA', 'A===', 'AA=A', '===='])
        await expect(fs.write(a, '/bad.bin', bad, { encoding: 'base64' }), bad).rejects.toThrow(/base64/)
      // Megabytes of base64 are checked without overflowing the regex stack.
      const big = Buffer.alloc(4 * 1024 * 1024, 7).toString('base64')
      expect((await fs.write(a, '/big.bin', big, { encoding: 'base64' })).size).toBe(4 * 1024 * 1024)
      expect((await fs.write(a, '/u.txt', 'é')).size).toBe(2)
    })

    it('takes code.run paths: /work/files/<p>, <p> and /<p> are one file', async () => {
      await fs.write(a, '/work/files/ipwatch.sh', 'echo hi')
      expect(await storage.read(a, '/ipwatch.sh')).toEqual(new TextEncoder().encode('echo hi'))
      for (const p of ['/work/files/ipwatch.sh', 'ipwatch.sh', '/ipwatch.sh'])
        expect(await fs.read(a, p), p).toMatchObject({ path: '/ipwatch.sh', content: 'echo hi' })
      expect((await fs.list(a, '/work/files')).map((e) => e.path)).toContain('/ipwatch.sh')
      await fs.move(a, '/work/files/ipwatch.sh', 'moved.sh')
      await fs.delete(a, '/work/files/moved.sh')
      expect(await fs.list(a, '/')).toEqual([])
      await expect(fs.read(a, '/work/files/../../x')).rejects.toThrow(ValidationError)
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

    it('writes concurrently to the same path, ending with one whole version', async () => {
      await Promise.all(Array.from({ length: 8 }, (_, i) => fs.write(a, '/race.txt', `v${i}`)))
      expect((await fs.list(a)).map((e) => e.path)).toEqual(['/race.txt'])
      expect((await fs.read(a, '/race.txt')).content).toMatch(/^v[0-7]$/)
    })

    it('hides an own directory called shared at the root, where shares show up', async () => {
      await storage.write(a, '/shared/x.txt', new TextEncoder().encode('x'))
      expect((await fs.list(a)).map((e) => e.path)).toEqual([])
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

    it('takes /work/shared/<owner>/<p> for /shared/<owner>/<p>, and shares /work/files paths', async () => {
      await fs.share(a, '/work/files/notes', bC, 'read')
      expect((await fs.sharesOf(a)).map((x) => x.data.path)).toEqual(['/notes'])
      expect(await fs.read(b, `/work/shared/${a}/notes/a.md`)).toMatchObject({
        path: `/shared/${a}/notes/a.md`,
        content: 'A notes',
      })
      await expect(fs.read(b, `/work/shared/${a}/private/secret.md`)).rejects.toThrow()
      await expect(fs.share(a, `/work/shared/${b}/x`, bC)).rejects.toThrow(ValidationError)
      await fs.unshare(a, '/work/files/notes', bC)
      expect(await fs.sharesOf(a)).toEqual([])
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

    it('moves grants with what they grant, and removes them with it', async () => {
      await fs.share(a, '/notes', bC, 'read')
      await fs.share(a, '/notes/deep/b.md', person, 'write')
      await fs.share(a, '/reports', bC, 'read')
      await fs.move(a, '/notes', '/archive/notes')
      expect((await fs.sharesOf(a)).map((s) => [s.data.path, s.data.withContactId]).sort()).toEqual(
        [
          ['/archive/notes', bC],
          ['/archive/notes/deep/b.md', person],
          ['/reports', bC],
        ].sort(),
      )
      expect((await fs.read(b, `/shared/${a}/archive/notes/a.md`)).content).toBe('A notes')
      await expect(fs.read(b, `/shared/${a}/notes/a.md`)).rejects.toThrow(DeniedError)
      await fs.delete(a, '/archive', { recursive: true })
      expect((await fs.sharesOf(a)).map((s) => s.data.path)).toEqual(['/reports'])
    })

    it('ignores dangling grants in listings, and reports them', async () => {
      await fs.write(a, '/gone/first.md', 'here')
      await fs.share(a, '/gone', bC, 'read')
      // Gone behind the service's back (a sandbox deleted it on disk): the grant stays, dangling.
      await fs.storage.delete(a, '/gone', { recursive: true })
      const [grant] = await fs.sharedWith(bC)
      expect(await fs.isDangling(grant!)).toBe(true)
      expect(await fs.list(b)).toEqual([])
      expect(await fs.list(b, '/shared')).toEqual([])
      // The path comes back, and so does the share.
      await fs.write(a, '/gone/again.md', 'back')
      expect(await fs.isDangling(grant!)).toBe(false)
      expect((await fs.list(b, '/shared')).map((e) => e.name)).toEqual([a])
    })

    it('validates shares', async () => {
      await expect(fs.share(a, '/shared/x', bC)).rejects.toThrow(ValidationError)
      // Nothing there: refused, rather than a share of an empty folder that looks like it worked.
      await expect(fs.share(a, '/not/here', bC)).rejects.toThrow(/not in your filesystem/)
      await expect(fs.share(a, '/notes', aC)).rejects.toThrow(/yourself/)
      await expect(fs.share(a, '/notes', bC, 'admin' as any)).rejects.toThrow(ValidationError)
      await expect(fs.share(a, '../x', bC)).rejects.toThrow(ValidationError)
    })

    it('accesses own files through /shared/<self>, and uses an injected contactOf', async () => {
      expect((await fs.read(a, `/shared/${a}/private/secret.md`)).content).toBe('no')
      const custom = createFiles({ records, storage, contactOf: (id) => (id === b ? person : null) })
      await custom.share(a, '/notes', person)
      expect((await custom.read(b, `/shared/${a}/notes/a.md`)).content).toBe('A notes')
      expect((await custom.forEmployee(b).list('/shared')).map((e) => e.name)).toEqual([a])
    })
  })
})
