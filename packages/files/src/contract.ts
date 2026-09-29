/**
 * The file storage contract. Every implementation of `FileStorage` must pass it:
 *
 *   fileStorageContract('directory', async () => directoryStorage({ root: await mkdtemp(...) }))
 *
 * `make` must return a fresh, empty storage each time.
 */
import { ConflictError, NotFoundError, ValidationError } from '@mp/core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FileStorage } from './storage.ts'

const text = (s: string) => new TextEncoder().encode(s)
const str = (b: Uint8Array) => new TextDecoder().decode(b)

export function fileStorageContract(name: string, make: () => Promise<FileStorage>) {
  describe(`file storage contract: ${name}`, () => {
    let fs: FileStorage
    const A = 'emp_a'
    const B = 'emp_b'

    beforeEach(async () => {
      fs = await make()
    })

    it('writes, reads and stats files, creating parents', async () => {
      const s = await fs.write(A, '/notes/deep/a.md', text('# Hi'))
      expect(s).toMatchObject({ path: '/notes/deep/a.md', type: 'file', size: 4 })
      expect(s.mtimeMs).toBeGreaterThan(0)
      expect(str(await fs.read(A, 'notes//deep/a.md'))).toBe('# Hi')
      expect(await fs.stat(A, '/notes/deep/a.md')).toMatchObject({ type: 'file', size: 4 })
      expect(await fs.stat(A, '/notes')).toMatchObject({ path: '/notes', type: 'dir', size: 0 })
      expect(await fs.stat(A, '/')).toMatchObject({ path: '/', type: 'dir' })
      expect(await fs.stat(A, '/missing')).toBeNull()
      await expect(fs.read(A, '/missing')).rejects.toBeInstanceOf(NotFoundError)
      await expect(fs.read(A, '/notes')).rejects.toBeInstanceOf(ValidationError)
    })

    it('keeps owners apart', async () => {
      await fs.write(A, '/x.txt', text('a'))
      expect(await fs.stat(B, '/x.txt')).toBeNull()
      expect(await fs.walk(B)).toEqual([])
      await expect(fs.read(B, '/x.txt')).rejects.toBeInstanceOf(NotFoundError)
    })

    it('stores binary content byte for byte, and empty files', async () => {
      const bytes = new Uint8Array([0, 255, 1, 128, 0x89, 0x50])
      await fs.write(A, '/b.bin', bytes)
      expect([...(await fs.read(A, '/b.bin'))]).toEqual([...bytes])
      await fs.write(A, '/empty', new Uint8Array())
      expect((await fs.read(A, '/empty')).length).toBe(0)
      expect((await fs.stat(A, '/empty'))!.size).toBe(0)
    })

    it('replaces files with a later modification time', async () => {
      const v1 = await fs.write(A, '/x.txt', text('v1'))
      const v2 = await fs.write(A, '/x.txt', text('v2 longer'))
      expect(v2.mtimeMs).toBeGreaterThan(v1.mtimeMs)
      expect(Math.floor(v2.mtimeMs)).toBeGreaterThan(Math.floor(v1.mtimeMs))
      expect(str(await fs.read(A, '/x.txt'))).toBe('v2 longer')
      expect((await fs.stat(A, '/x.txt'))!.size).toBe(9)
    })

    it('keeps files and directories apart', async () => {
      await fs.write(A, '/d/f.txt', text('x'))
      await expect(fs.write(A, '/d', text('x'))).rejects.toBeInstanceOf(ConflictError)
      await expect(fs.write(A, '/d/f.txt/g', text('x'))).rejects.toBeInstanceOf(ConflictError)
      await expect(fs.write(A, '/', text('x'))).rejects.toBeInstanceOf(ValidationError)
    })

    it('lists directories and walks trees, sorted', async () => {
      await fs.write(A, '/b.txt', text('b'))
      await fs.write(A, '/a/2.txt', text('2'))
      await fs.write(A, '/a/1.txt', text('1'))
      await fs.write(A, '/a/sub/3.txt', text('3'))
      expect((await fs.list(A, '/')).map((e) => [e.path, e.type])).toEqual([
        ['/a', 'dir'],
        ['/b.txt', 'file'],
      ])
      expect((await fs.list(A, '/a')).map((e) => e.path)).toEqual(['/a/1.txt', '/a/2.txt', '/a/sub'])
      expect(await fs.list(A, '/nothing')).toEqual([])
      await expect(fs.list(A, '/b.txt')).rejects.toBeInstanceOf(ValidationError)
      expect((await fs.walk(A)).map((e) => e.path)).toEqual(['/a/1.txt', '/a/2.txt', '/a/sub/3.txt', '/b.txt'])
      expect((await fs.walk(A, '/a/sub')).map((e) => [e.path, e.size])).toEqual([['/a/sub/3.txt', 1]])
      expect((await fs.walk(A, '/b.txt')).map((e) => e.path)).toEqual(['/b.txt'])
      expect(await fs.walk(A, '/nothing')).toEqual([])
    })

    it('deletes files and, recursively, directories', async () => {
      await fs.write(A, '/d/1.txt', text('1'))
      await fs.write(A, '/d/e/2.txt', text('2'))
      await fs.write(A, '/f.txt', text('f'))
      await fs.delete(A, '/f.txt')
      expect(await fs.stat(A, '/f.txt')).toBeNull()
      await expect(fs.delete(A, '/f.txt')).rejects.toBeInstanceOf(NotFoundError)
      await expect(fs.delete(A, '/d')).rejects.toBeInstanceOf(ValidationError)
      await fs.delete(A, '/d', { recursive: true })
      expect(await fs.walk(A)).toEqual([])
      expect(await fs.stat(A, '/d')).toBeNull()
    })

    it('moves files and directories', async () => {
      await fs.write(A, '/d/1.txt', text('1'))
      await fs.write(A, '/d/e/2.txt', text('2'))
      await fs.write(A, '/o.txt', text('o'))
      await fs.move(A, '/o.txt', '/new/place/r.txt')
      expect(str(await fs.read(A, '/new/place/r.txt'))).toBe('o')
      expect(await fs.stat(A, '/o.txt')).toBeNull()
      await fs.move(A, '/d', '/moved')
      expect(str(await fs.read(A, '/moved/e/2.txt'))).toBe('2')
      expect(await fs.walk(A, '/d')).toEqual([])
      await expect(fs.move(A, '/moved', '/moved/inner')).rejects.toBeInstanceOf(ValidationError)
      await expect(fs.move(A, '/nothing', '/x')).rejects.toBeInstanceOf(NotFoundError)
      await fs.write(A, '/t.txt', text('t'))
      await expect(fs.move(A, '/new/place/r.txt', '/t.txt')).rejects.toBeInstanceOf(ConflictError)
      await fs.move(A, '/new/place/r.txt', '/t.txt', { overwrite: true })
      expect(str(await fs.read(A, '/t.txt'))).toBe('o')
      await expect(fs.move(A, '/t.txt', '/moved')).rejects.toBeInstanceOf(ConflictError)
      await expect(fs.move(A, '/t.txt', '/')).rejects.toBeInstanceOf(ValidationError)
    })

    it('rejects traversal and bad owners', async () => {
      await expect(fs.write(A, '../emp_b/x', text('x'))).rejects.toBeInstanceOf(ValidationError)
      await expect(fs.read(A, '/a/../../x')).rejects.toBeInstanceOf(ValidationError)
      await expect(fs.write('../etc', '/x', text('x'))).rejects.toBeInstanceOf(ValidationError)
      await expect(fs.write('a/b', '/x', text('x'))).rejects.toBeInstanceOf(ValidationError)
      await expect(fs.write('', '/x', text('x'))).rejects.toBeInstanceOf(ValidationError)
    })

    it('never shows a half-written file to concurrent readers', async () => {
      const big = (c: string) => text(c.repeat(256 * 1024))
      await fs.write(A, '/big.txt', big('a'))
      const reads: string[] = []
      await Promise.all([
        ...['b', 'c', 'd'].map((c) => fs.write(A, '/big.txt', big(c))),
        ...Array.from({ length: 6 }, async () => {
          const s = str(await fs.read(A, '/big.txt'))
          reads.push(s)
        }),
      ])
      for (const s of reads) {
        expect(s.length).toBe(256 * 1024)
        expect(new Set(s).size).toBe(1)
      }
      expect((await fs.walk(A)).map((e) => e.path)).toEqual(['/big.txt'])
    })
  })
}
