import { randomBytes } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ConflictError, DeniedError, NotFoundError, ValidationError } from '@mp/core'
import { ancestors, isWithin, normalizePath } from './paths.ts'
import { checkOwner, type FileStorage, type StoredStat } from './storage.ts'

/** Prefix of the temporary files atomic writes go through. They are never listed. */
export const TEMP_PREFIX = '.mp-tmp-'

export interface DirectoryStorageOptions {
  /** The directory holding one subdirectory per owner (`<root>/<owner>/<path>`). Created when missing. */
  root: string
}

const code = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code

/**
 * `FileStorage` on a local directory: `<root>/<owner>/<path>`. Paths are normalized (no `..`), and
 * symbolic links are never followed: a path through a link is refused, and links inside the tree are
 * neither listed nor read. Writes go to a temporary file in the same directory and are renamed into
 * place, so readers never see half a file.
 */
export function directoryStorage(opts: DirectoryStorageOptions): FileStorage {
  const root = resolve(opts.root)
  let rootReady: Promise<void> | null = null
  const ensureRoot = () => {
    rootReady ??= mkdir(root, { recursive: true }).then(() => undefined)
    return rootReady
  }

  /** The owner's directory (created) and the absolute on-disk path, after checking every existing component. */
  const locate = async (owner: string, raw: string, create = false): Promise<{ dir: string; abs: string; path: string }> => {
    const path = normalizePath(raw)
    await ensureRoot()
    const dir = join(root, checkOwner(owner))
    const top = await lstatOrNull(dir)
    if (top?.isSymbolicLink()) throw new DeniedError(`the files of ${owner} are behind a symbolic link`)
    if (!top) {
      if (create) await mkdir(dir, { recursive: true })
    } else if (!top.isDirectory()) throw new ConflictError(`the files of ${owner} are not a directory`)
    const abs = path === '/' ? dir : join(dir, ...path.split('/').filter(Boolean))
    if (!isWithin(dir, abs)) throw new ValidationError(`path escapes the files root: ${raw}`)
    // Every existing ancestor must be a real directory, not a link.
    for (const a of ancestors(path)) {
      const s = await lstatOrNull(join(dir, a))
      if (!s) break
      if (s.isSymbolicLink()) throw new DeniedError(`${a} is a symbolic link; links are not followed`)
      if (!s.isDirectory()) break
    }
    return { dir, abs, path }
  }

  const statOf = (path: string, s: { isDirectory(): boolean; size: number; mtimeMs: number }): StoredStat => ({
    path,
    type: s.isDirectory() ? 'dir' : 'file',
    size: s.isDirectory() ? 0 : s.size,
    mtimeMs: s.mtimeMs,
  })

  const visible = (d: Dirent) => (d.isFile() || d.isDirectory()) && !d.name.startsWith(TEMP_PREFIX)

  /** Removes empty directories from `abs` up to (not including) the owner's directory. */
  const prune = async (dir: string, abs: string) => {
    let cur = abs
    while (cur.startsWith(`${dir}/`)) {
      try {
        await rmdir(cur)
      } catch {
        return
      }
      cur = cur.slice(0, cur.lastIndexOf('/'))
    }
  }

  /** Creates the parents of `path`, refusing links and files on the way. */
  const mkParents = async (dir: string, path: string) => {
    for (const a of ancestors(path)) {
      const p = join(dir, a)
      const s = await lstatOrNull(p)
      if (s?.isSymbolicLink()) throw new DeniedError(`${a} is a symbolic link; links are not followed`)
      if (s && !s.isDirectory()) throw new ConflictError(`${a} is a file`)
      if (!s) await mkdir(p).catch((e) => (code(e) === 'EEXIST' ? undefined : Promise.reject(e)))
    }
  }

  const storage: FileStorage = {
    async read(owner, raw) {
      const { abs, path } = await locate(owner, raw)
      let fh: Awaited<ReturnType<typeof open>>
      try {
        fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (e) {
        if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') throw new NotFoundError('file', path)
        if (code(e) === 'ELOOP') throw new DeniedError(`${path} is a symbolic link; links are not followed`)
        if (code(e) === 'EISDIR') throw new ValidationError(`${path} is a directory`)
        throw e
      }
      try {
        const s = await fh.stat()
        if (s.isDirectory()) throw new ValidationError(`${path} is a directory`)
        if (!s.isFile()) throw new NotFoundError('file', path)
        return new Uint8Array(await fh.readFile())
      } finally {
        await fh.close()
      }
    },

    async stat(owner, raw) {
      const { dir, abs, path } = await locate(owner, raw)
      const s = await lstatOrNull(abs)
      if (!s) return path === '/' ? { path, type: 'dir', size: 0, mtimeMs: 0 } : null
      if (s.isSymbolicLink() || !(s.isFile() || s.isDirectory())) return null
      if (abs === dir) return { path: '/', type: 'dir', size: 0, mtimeMs: s.mtimeMs }
      return statOf(path, s)
    },

    async write(owner, raw, content) {
      const { dir, abs, path } = await locate(owner, raw, true)
      if (path === '/') throw new ValidationError('/ is a directory')
      await mkParents(dir, path)
      const prev = await lstatOrNull(abs)
      if (prev?.isDirectory()) throw new ConflictError(`${path} is a directory`)
      const tmp = join(abs, '..', `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`)
      const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
      try {
        await fh.writeFile(content)
        await fh.sync()
      } catch (e) {
        await fh.close().catch(() => undefined)
        await unlink(tmp).catch(() => undefined)
        throw e
      }
      await fh.close()
      try {
        await rename(tmp, abs)
      } catch (e) {
        await unlink(tmp).catch(() => undefined)
        if (code(e) === 'EISDIR' || code(e) === 'ENOTEMPTY') throw new ConflictError(`${path} is a directory`)
        throw e
      }
      let s = await lstat(abs)
      if (prev && Math.floor(s.mtimeMs) <= Math.floor(prev.mtimeMs)) {
        // Same millisecond as the replaced file: keep versions (whole milliseconds) distinct.
        const t = new Date(Math.floor(prev.mtimeMs) + 1)
        await utimes(abs, t, t)
        s = await lstat(abs)
      }
      return statOf(path, s)
    },

    async list(owner, raw) {
      const { abs, path } = await locate(owner, raw)
      const s = await lstatOrNull(abs)
      if (!s) return []
      if (s.isSymbolicLink()) return []
      if (!s.isDirectory()) throw new ValidationError(`${path} is a file`)
      const base = path === '/' ? '' : path
      const out: StoredStat[] = []
      for (const d of await readdir(abs, { withFileTypes: true })) {
        if (!visible(d)) continue
        const cs = await lstatOrNull(join(abs, d.name))
        if (cs && (cs.isFile() || cs.isDirectory())) out.push(statOf(`${base}/${d.name}`, cs))
      }
      return out.sort((a, b) => (a.path < b.path ? -1 : 1))
    },

    async walk(owner, raw = '/') {
      const { abs, path } = await locate(owner, raw)
      const top = await lstatOrNull(abs)
      if (!top || top.isSymbolicLink()) return []
      if (top.isFile()) return [statOf(path, top)]
      const out: StoredStat[] = []
      const visit = async (disk: string, rel: string) => {
        let entries: Dirent[]
        try {
          entries = await readdir(disk, { withFileTypes: true })
        } catch (e) {
          if (code(e) === 'ENOENT') return
          throw e
        }
        for (const d of entries) {
          if (!visible(d)) continue
          const p = `${rel}/${d.name}`
          if (d.isDirectory()) await visit(join(disk, d.name), p)
          else {
            const s = await lstatOrNull(join(disk, d.name))
            if (s?.isFile()) out.push(statOf(p, s))
          }
        }
      }
      await visit(abs, path === '/' ? '' : path)
      return out.sort((a, b) => (a.path < b.path ? -1 : 1))
    },

    async delete(owner, raw, o = {}) {
      const { dir, abs, path } = await locate(owner, raw)
      if (path === '/') throw new ValidationError("/ can't be deleted")
      const s = await lstatOrNull(abs)
      if (!s) throw new NotFoundError('file', path)
      // A link isn't a file of the owner's, but deleting it is harmless and cleans up.
      if (s.isSymbolicLink()) return unlink(abs)
      if (s.isDirectory()) {
        if (!o.recursive) throw new ValidationError(`${path} is a directory; pass recursive to delete it`)
        await rm(abs, { recursive: true, force: true })
      } else await unlink(abs)
      await prune(dir, join(abs, '..'))
    },

    async move(owner, rawFrom, rawTo, o = {}) {
      const src = await locate(owner, rawFrom)
      const dst = await locate(owner, rawTo)
      if (src.path === '/' || dst.path === '/') throw new ValidationError("/ can't be moved")
      if (src.path === dst.path) return
      const s = await lstatOrNull(src.abs)
      if (!s || s.isSymbolicLink()) throw new NotFoundError('file', src.path)
      if (s.isDirectory() && isWithin(src.path, dst.path)) throw new ValidationError("a directory can't be moved into itself")
      await mkParents(dst.dir, dst.path)
      const t = await lstatOrNull(dst.abs)
      if (t && !t.isSymbolicLink()) {
        if (t.isDirectory())
          throw new ConflictError(s.isDirectory() ? `${dst.path} already exists` : `${dst.path} is a directory`)
        if (s.isDirectory() || !o.overwrite) throw new ConflictError(`${dst.path} already exists`)
      }
      await rename(src.abs, dst.abs)
      await prune(src.dir, join(src.abs, '..'))
    },

    async localPath(owner) {
      const { dir } = await locate(owner, '/', true)
      return dir
    },
  }
  return storage
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p)
  } catch (e) {
    if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') return null
    throw e
  }
}
