import { ConflictError, NotFoundError, ValidationError } from '@mp/core'
import { ancestors, isWithin, normalizePath } from './paths.ts'

/** A file or directory in storage. */
export interface StoredStat {
  /** Normalized absolute path in the owner's filesystem, e.g. `/notes/a.md`. */
  path: string
  type: 'file' | 'dir'
  /** Bytes (0 for directories). */
  size: number
  /** Last modification, milliseconds since the epoch. */
  mtimeMs: number
}

/**
 * Where employee files live: one tree per owner (an employee id). Paths are the owner's absolute
 * POSIX paths (`/notes/a.md`), normalized by the caller or here. Directories exist implicitly: writing
 * a file creates its parents, and a directory with nothing left in it may disappear.
 *
 * Implementations: `memoryStorage` (tests) and `directoryStorage` (a directory on disk, one
 * subdirectory per owner). The contract is `fileStorageContract` in `@mp/files/contract`.
 */
export interface FileStorage {
  /** A file's bytes. `NotFoundError` when missing, `ValidationError` for a directory. */
  read(owner: string, path: string): Promise<Uint8Array>
  /** A file or directory, or null. The owner's root `/` is always a directory. */
  stat(owner: string, path: string): Promise<StoredStat | null>
  /**
   * Creates or replaces a file atomically (readers see the old or the new content, never a mix),
   * creating parent directories. The new `mtimeMs` is always later than the replaced file's.
   * `ConflictError` when the path is a directory or an ancestor is a file.
   */
  write(owner: string, path: string, content: Uint8Array): Promise<StoredStat>
  /** A directory's direct children, sorted by name. `[]` for a missing directory, `ValidationError` for a file. */
  list(owner: string, dir: string): Promise<StoredStat[]>
  /** Every file under `dir` (default `/`), recursively, sorted by path. Directories aren't listed. */
  walk(owner: string, dir?: string): Promise<StoredStat[]>
  /** Deletes a file, or a directory with `recursive`. `NotFoundError` when missing, `ValidationError` for a directory without it. */
  delete(owner: string, path: string, opts?: { recursive?: boolean }): Promise<void>
  /**
   * Moves a file or a directory within one owner. `NotFoundError` when `from` is missing,
   * `ConflictError` when `to` exists (unless `overwrite`, for files), `ValidationError` for a move into itself.
   */
  move(owner: string, from: string, to: string, opts?: { overwrite?: boolean }): Promise<void>
  /**
   * The directory on the local disk holding an owner's files, created when missing. Only for
   * storage backed by a local directory (for mounting it into containers).
   */
  localPath?(owner: string): Promise<string>
}

/** Owner ids are single path segments. */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

export function checkOwner(owner: string): string {
  if (typeof owner !== 'string' || !OWNER_RE.test(owner) || owner.includes('..'))
    throw new ValidationError(`bad file owner: ${String(owner)}`)
  return owner
}

interface MemFile {
  content: Uint8Array
  mtimeMs: number
}

/** `FileStorage` in memory, for tests and deployments without a files directory. */
export function memoryStorage(opts: { now?: () => number } = {}): FileStorage {
  const now = opts.now ?? (() => Date.now())
  const owners = new Map<string, Map<string, MemFile>>()
  let last = 0
  const tick = (after = 0) => {
    last = Math.max(now(), last + 1, after + 1)
    return last
  }
  const tree = (owner: string) => {
    checkOwner(owner)
    let t = owners.get(owner)
    if (!t) {
      t = new Map()
      owners.set(owner, t)
    }
    return t
  }
  const fileStat = (path: string, f: MemFile): StoredStat => ({ path, type: 'file', size: f.content.length, mtimeMs: f.mtimeMs })
  const under = (t: Map<string, MemFile>, dir: string) => [...t.keys()].filter((p) => p !== dir && isWithin(dir, p))
  const dirStat = (t: Map<string, MemFile>, dir: string): StoredStat | null => {
    const inside = under(t, dir)
    if (dir !== '/' && !inside.length) return null
    return { path: dir, type: 'dir', size: 0, mtimeMs: Math.max(0, ...inside.map((p) => t.get(p)!.mtimeMs)) }
  }

  const storage: FileStorage = {
    async read(owner, raw) {
      const path = normalizePath(raw)
      const t = tree(owner)
      const f = t.get(path)
      if (f) return new Uint8Array(f.content)
      if (dirStat(t, path)) throw new ValidationError(`${path} is a directory`)
      throw new NotFoundError('file', path)
    },

    async stat(owner, raw) {
      const path = normalizePath(raw)
      const t = tree(owner)
      const f = t.get(path)
      return f ? fileStat(path, f) : dirStat(t, path)
    },

    async write(owner, raw, content) {
      const path = normalizePath(raw)
      if (path === '/') throw new ValidationError('/ is a directory')
      const t = tree(owner)
      for (const a of ancestors(path)) if (t.has(a)) throw new ConflictError(`${a} is a file`)
      if (under(t, path).length) throw new ConflictError(`${path} is a directory`)
      const f = { content: new Uint8Array(content), mtimeMs: tick(t.get(path)?.mtimeMs) }
      t.set(path, f)
      return fileStat(path, f)
    },

    async list(owner, raw) {
      const dir = normalizePath(raw)
      const t = tree(owner)
      if (t.has(dir)) throw new ValidationError(`${dir} is a file`)
      const base = dir === '/' ? '' : dir
      const out = new Map<string, StoredStat>()
      for (const p of under(t, dir)) {
        const name = p.slice(base.length + 1).split('/')[0]!
        const child = `${base}/${name}`
        if (!out.has(child)) out.set(child, t.has(child) ? fileStat(child, t.get(child)!) : dirStat(t, child)!)
      }
      return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
    },

    async walk(owner, raw = '/') {
      const dir = normalizePath(raw)
      const t = tree(owner)
      const f = t.get(dir)
      if (f) return [fileStat(dir, f)]
      return under(t, dir)
        .sort()
        .map((p) => fileStat(p, t.get(p)!))
    },

    async delete(owner, raw, o = {}) {
      const path = normalizePath(raw)
      const t = tree(owner)
      if (t.delete(path)) return
      const inside = under(t, path)
      if (!inside.length) throw new NotFoundError('file', path)
      if (!o.recursive) throw new ValidationError(`${path} is a directory; pass recursive to delete it`)
      for (const p of inside) t.delete(p)
    },

    async move(owner, rawFrom, rawTo, o = {}) {
      const from = normalizePath(rawFrom)
      const to = normalizePath(rawTo)
      if (from === '/' || to === '/') throw new ValidationError("/ can't be moved")
      if (from === to) return
      const t = tree(owner)
      for (const a of ancestors(to)) if (t.has(a)) throw new ConflictError(`${a} is a file`)
      const file = t.get(from)
      if (file) {
        if (under(t, to).length) throw new ConflictError(`${to} is a directory`)
        if (t.has(to) && !o.overwrite) throw new ConflictError(`${to} already exists`)
        t.delete(from)
        t.set(to, file)
        return
      }
      const inside = under(t, from)
      if (!inside.length) throw new NotFoundError('file', from)
      if (isWithin(from, to)) throw new ValidationError("a directory can't be moved into itself")
      if (t.has(to) || under(t, to).length) throw new ConflictError(`${to} already exists`)
      for (const p of inside) {
        t.set(`${to}${p.slice(from.length)}`, t.get(p)!)
        t.delete(p)
      }
    },
  }
  return storage
}
