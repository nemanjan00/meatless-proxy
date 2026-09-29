import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeniedError, NotFoundError } from '@mp/core'
import { afterAll, describe, expect, it } from 'vitest'
import { fileStorageContract } from '../src/contract.ts'
import { TEMP_PREFIX, directoryStorage, memoryStorage } from '../src/index.ts'

const roots: string[] = []
const tempRoot = async () => {
  const r = await mkdtemp(join(tmpdir(), 'mp-files-'))
  roots.push(r)
  return r
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

fileStorageContract('memory', async () => memoryStorage())
fileStorageContract('directory', async () => directoryStorage({ root: join(await tempRoot(), 'files') }))

const text = (s: string) => new TextEncoder().encode(s)

describe('directoryStorage', () => {
  it('lays files out as <root>/<owner>/<path>, and gives the local path', async () => {
    const root = await tempRoot()
    const fs = directoryStorage({ root })
    await fs.write('emp_a', '/notes/a.md', text('# A'))
    expect(await readdir(join(root, 'emp_a', 'notes'))).toEqual(['a.md'])
    expect(await fs.localPath!('emp_b')).toBe(join(root, 'emp_b'))
    expect(await readdir(root)).toEqual(['emp_a', 'emp_b'])
  })

  it('never follows symbolic links out of the root', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    await writeFile(join(outside, 'secret.txt'), 'top secret')
    const fs = directoryStorage({ root })
    await fs.write('emp_a', '/ok.txt', text('ok'))
    // Links planted inside the tree, e.g. by code in a sandbox.
    await symlink(join(outside, 'secret.txt'), join(root, 'emp_a', 'link.txt'))
    await symlink(outside, join(root, 'emp_a', 'dirlink'))
    await expect(fs.read('emp_a', '/link.txt')).rejects.toBeInstanceOf(DeniedError)
    await expect(fs.read('emp_a', '/dirlink/secret.txt')).rejects.toBeInstanceOf(DeniedError)
    await expect(fs.write('emp_a', '/dirlink/new.txt', text('x'))).rejects.toBeInstanceOf(DeniedError)
    expect(await fs.list('emp_a', '/dirlink')).toEqual([])
    expect(await fs.stat('emp_a', '/link.txt')).toBeNull()
    expect((await fs.list('emp_a', '/')).map((e) => e.path)).toEqual(['/ok.txt'])
    expect((await fs.walk('emp_a')).map((e) => e.path)).toEqual(['/ok.txt'])
    expect(await readdir(outside)).toEqual(['secret.txt'])
    // Writing over a link replaces the link, never the target.
    await fs.write('emp_a', '/link.txt', text('mine'))
    expect(new TextDecoder().decode(await fs.read('emp_a', '/link.txt'))).toBe('mine')
    // Deleting a link removes the link only.
    await symlink(join(outside, 'secret.txt'), join(root, 'emp_a', 'again.txt'))
    await fs.delete('emp_a', '/again.txt')
    expect(await readdir(outside)).toEqual(['secret.txt'])
  })

  it('refuses an owner directory that is a link', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    await mkdir(root, { recursive: true })
    await symlink(outside, join(root, 'emp_x'))
    const fs = directoryStorage({ root })
    await expect(fs.write('emp_x', '/a.txt', text('a'))).rejects.toBeInstanceOf(DeniedError)
    await expect(fs.read('emp_x', '/a.txt')).rejects.toBeInstanceOf(DeniedError)
    expect(await readdir(outside)).toEqual([])
  })

  it('writes atomically through a temporary file it never lists, and cleans up after a failure', async () => {
    const root = await tempRoot()
    const fs = directoryStorage({ root })
    await fs.write('emp_a', '/a.txt', text('a'))
    // A leftover from a crash mid-write.
    await writeFile(join(root, 'emp_a', `${TEMP_PREFIX}deadbeef`), 'partial')
    expect((await fs.walk('emp_a')).map((e) => e.path)).toEqual(['/a.txt'])
    expect((await fs.list('emp_a', '/')).map((e) => e.path)).toEqual(['/a.txt'])
    await expect(fs.read('emp_a', `/${TEMP_PREFIX}nothing`)).rejects.toBeInstanceOf(NotFoundError)
    // Writing into a directory that isn't writable fails, and leaves no temp file behind.
    await fs.write('emp_a', '/ro/x.txt', text('x'))
    const { chmod } = await import('node:fs/promises')
    await chmod(join(root, 'emp_a', 'ro'), 0o555)
    try {
      await expect(fs.write('emp_a', '/ro/y.txt', text('y'))).rejects.toThrow()
      expect(await readdir(join(root, 'emp_a', 'ro'))).toEqual(['x.txt'])
    } finally {
      await chmod(join(root, 'emp_a', 'ro'), 0o755)
    }
  })

  it('removes directories left empty by deletes and moves', async () => {
    const root = await tempRoot()
    const fs = directoryStorage({ root })
    await fs.write('emp_a', '/a/b/c.txt', text('c'))
    await fs.delete('emp_a', '/a/b/c.txt')
    expect(await readdir(join(root, 'emp_a'))).toEqual([])
    await fs.write('emp_a', '/x/y/z.txt', text('z'))
    await fs.move('emp_a', '/x/y/z.txt', '/z.txt')
    expect(await readdir(join(root, 'emp_a'))).toEqual(['z.txt'])
  })
})
