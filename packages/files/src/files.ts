import { ConflictError, DeniedError, NotFoundError, ValidationError, type KindSchema } from '@mp/core'
import type { Records } from '@mp/records'
import type { Actor, StoredRecord } from '@mp/store'
import { SHARED_DIR, ancestors, basename, guessMime, isWithin, normalizePath } from './paths.ts'

export type Encoding = 'utf8' | 'base64'
export type SharePermission = 'read' | 'write'

export const fileSchema: KindSchema = {
  kind: 'file',
  prefix: 'fil',
  description: "A file in an employee's own filesystem. Keyed by `<employeeId>:<path>`.",
  titleField: 'path',
  core: [
    { name: 'employeeId', type: 'ref', ref: 'employee', required: true },
    { name: 'path', type: 'string', required: true, description: 'Normalized absolute POSIX path, e.g. /notes/a.md.' },
    { name: 'content', type: 'string', required: true },
    { name: 'encoding', type: 'enum', values: ['utf8', 'base64'] },
    { name: 'size', type: 'number', description: 'Bytes.' },
    { name: 'mime', type: 'string' },
  ],
}

export const shareSchema: KindSchema = {
  kind: 'fs_share',
  prefix: 'fsh',
  description: "A file or directory of an employee's filesystem shared with a person or another employee.",
  titleField: 'path',
  core: [
    { name: 'ownerEmployeeId', type: 'ref', ref: 'employee', required: true },
    { name: 'path', type: 'string', required: true, description: 'A file, or a directory covering everything under it.' },
    { name: 'withContactId', type: 'ref', ref: 'contact', required: true, description: "A person, or an employee's contact." },
    { name: 'permission', type: 'enum', values: ['read', 'write'], required: true },
  ],
}

export interface FileData extends Record<string, unknown> {
  employeeId: string
  path: string
  content: string
  encoding?: Encoding
  size?: number
  mime?: string
}

export interface ShareData extends Record<string, unknown> {
  ownerEmployeeId: string
  path: string
  withContactId: string
  permission: SharePermission
}

export type FileRecord = StoredRecord<FileData>
export type Share = StoredRecord<ShareData>

/** A file as the reader sees it. `path` is the reader's path (under `/shared/<owner>` for shared files). */
export interface FileView {
  id: string
  path: string
  ownerEmployeeId: string
  /** The path in the owner's filesystem. */
  ownerPath: string
  content: string
  encoding: Encoding
  size: number
  mime: string
  version: number
  updatedAt: string
}

export interface DirEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  mime?: string
  version?: number
  updatedAt?: string
}

export interface WriteFileOptions {
  encoding?: Encoding
  mime?: string
  /** Compare-and-swap against the current file version. */
  expectedVersion?: number
  actor?: Actor
}

/** Operations for one reader. */
export interface FsView {
  list(dir?: string): Promise<DirEntry[]>
  read(path: string): Promise<FileView>
  write(path: string, content: string, opts?: WriteFileOptions): Promise<FileView>
  move(from: string, to: string, opts?: { overwrite?: boolean; actor?: Actor }): Promise<void>
  delete(path: string, opts?: { recursive?: boolean; actor?: Actor }): Promise<void>
}

export interface FilesService {
  /** Lists a directory: own files, `/shared` (owners sharing with you), `/shared/<ownerEmployeeId>/…` (what they share). */
  list(employeeId: string, dir?: string): Promise<DirEntry[]>
  read(employeeId: string, path: string): Promise<FileView>
  /** Creates or replaces a file. Writing under `/shared/<owner>/…` needs a `write` share. */
  write(employeeId: string, path: string, content: string, opts?: WriteFileOptions): Promise<FileView>
  /** Moves a file or a directory within one filesystem. */
  move(employeeId: string, from: string, to: string, opts?: { overwrite?: boolean; actor?: Actor }): Promise<void>
  /** Deletes a file, or a directory with `recursive`. */
  delete(employeeId: string, path: string, opts?: { recursive?: boolean; actor?: Actor }): Promise<void>
  /** Shares a file or directory (by prefix). Sharing the same path with the same contact again changes the permission. */
  share(
    ownerEmployeeId: string,
    path: string,
    withContactId: string,
    permission?: SharePermission,
    opts?: { actor?: Actor },
  ): Promise<Share>
  unshare(ownerEmployeeId: string, path: string, withContactId: string, opts?: { actor?: Actor }): Promise<void>
  /** Shares received by a contact. */
  sharedWith(contactId: string): Promise<Share[]>
  /** Shares made by an employee. */
  sharesOf(ownerEmployeeId: string): Promise<Share[]>
  /** The same operations for an employee, bound to it. */
  forEmployee(employeeId: string): FsView
  /** Access for a person (a contact without a filesystem of its own): only `/shared` paths. */
  forContact(contactId: string): FsView
}

export interface FilesDeps {
  records: Records
  /**
   * The contact id of an employee, used to match shares. Defaults to the
   * `contactId` of the `employee` record, when that kind is registered.
   */
  contactOf?: (employeeId: string) => Promise<string | null | undefined> | string | null | undefined
}

interface Reader {
  employeeId: string | null
  contactId: string | null
}

type Target =
  | { virtual: true }
  | {
      virtual: false
      owner: string
      /** Path in the owner's filesystem. */
      path: string
      /** What to put in front of owner paths to get the reader's path. */
      prefix: string
      shared: boolean
    }

const fileKey = (owner: string, path: string) => `${owner}:${path}`
const shareKey = (owner: string, path: string, contact: string) => `${owner}:${path}:${contact}`
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function byteSize(content: string, encoding: Encoding): number {
  if (encoding === 'utf8') return Buffer.byteLength(content, 'utf8')
  if (!BASE64.test(content)) throw new ValidationError('content is not valid base64')
  return Buffer.from(content, 'base64').length
}

/** Registers the `file` and `fs_share` kinds and returns the filesystem service. */
export function createFiles({ records, contactOf }: FilesDeps): FilesService {
  records.kinds.define(fileSchema)
  records.kinds.define(shareSchema)

  const resolveContact = async (employeeId: string): Promise<string | null> => {
    if (contactOf) return (await contactOf(employeeId)) ?? null
    if (!records.kinds.has('employee')) return null
    const e = await records.get<{ contactId?: string }>('employee', employeeId)
    return e?.data.contactId ?? null
  }

  const readerOf = async (employeeId: string): Promise<Reader> => ({ employeeId, contactId: await resolveContact(employeeId) })

  const resolve = (reader: Reader, raw: string): Target => {
    const path = normalizePath(raw)
    if (path === SHARED_DIR) return { virtual: true }
    if (isWithin(SHARED_DIR, path)) {
      const [, , owner, ...rest] = path.split('/')
      const ownPath = `/${rest.join('/')}`
      if (owner === reader.employeeId) return { virtual: false, owner, path: ownPath, prefix: '', shared: false }
      return { virtual: false, owner: owner!, path: ownPath, prefix: `${SHARED_DIR}/${owner}`, shared: true }
    }
    if (!reader.employeeId) throw new DeniedError('only paths under /shared are available')
    return { virtual: false, owner: reader.employeeId, path, prefix: '', shared: false }
  }

  const sharesFor = async (owner: string, contactId: string | null) =>
    contactId
      ? (await records.query<ShareData>('fs_share', { where: { ownerEmployeeId: owner, withContactId: contactId } })).items
      : []

  const permission = (shares: Share[], path: string): SharePermission | null => {
    let best: SharePermission | null = null
    for (const s of shares) if (isWithin(s.data.path, path)) best = s.data.permission === 'write' ? 'write' : (best ?? 'read')
    return best
  }

  /** Throws `DeniedError` unless the reader may access the target as asked. Returns the shares that apply. */
  const authorize = async (reader: Reader, t: Extract<Target, { virtual: false }>, need: SharePermission): Promise<Share[]> => {
    if (!t.shared) return []
    const shares = await sharesFor(t.owner, reader.contactId)
    const p = permission(shares, t.path)
    if (!p || (need === 'write' && p !== 'write'))
      throw new DeniedError(`no ${need} access to ${t.prefix}${t.path === '/' ? '' : t.path}`, { owner: t.owner, path: t.path })
    return shares
  }

  const filesUnder = async (owner: string, dir: string) => {
    const where: any[] = [{ field: 'employeeId', op: 'eq', value: owner }]
    if (dir !== '/') where.push({ field: 'path', op: 'like', value: `${dir}/` })
    const { items } = await records.query<FileData>('file', { where, orderBy: { field: 'path' } })
    return items.filter((f) => dir === '/' || f.data.path.startsWith(`${dir}/`))
  }

  const getFile = (owner: string, path: string) => records.getByKey<FileData>('file', fileKey(owner, path))

  const view = (f: FileRecord, prefix: string): FileView => ({
    id: f.id,
    path: `${prefix}${f.data.path}`,
    ownerEmployeeId: f.data.employeeId,
    ownerPath: f.data.path,
    content: f.data.content,
    encoding: f.data.encoding ?? 'utf8',
    size: f.data.size ?? byteSize(f.data.content, f.data.encoding ?? 'utf8'),
    mime: f.data.mime ?? guessMime(f.data.path, f.data.encoding ?? 'utf8'),
    version: f.version,
    updatedAt: f.updatedAt,
  })

  /** Refuses to create a file where a directory is, or inside a file. */
  const assertPlaceable = async (owner: string, path: string) => {
    if (path === '/') throw new ValidationError('/ is a directory')
    for (const a of ancestors(path)) if (await getFile(owner, a)) throw new ConflictError(`${a} is a file`)
    if ((await filesUnder(owner, path)).length) throw new ConflictError(`${path} is a directory`)
  }

  const sortEntries = (entries: DirEntry[]) =>
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))

  const list = async (reader: Reader, dir = '/'): Promise<DirEntry[]> => {
    const t = resolve(reader, dir)
    if (t.virtual) {
      if (!reader.contactId) return []
      const owners = new Set((await api.sharedWith(reader.contactId)).map((s) => s.data.ownerEmployeeId))
      owners.delete(reader.employeeId ?? '')
      return sortEntries([...owners].map((o) => ({ name: o, path: `${SHARED_DIR}/${o}`, type: 'dir' as const })))
    }
    let shares: Share[] = []
    if (t.shared) {
      shares = await sharesFor(t.owner, reader.contactId)
      // Listing is allowed inside a share and on the way down to one.
      const allowed = shares.some((s) => isWithin(s.data.path, t.path) || isWithin(t.path, s.data.path))
      if (!allowed) throw new DeniedError(`no read access to ${t.prefix}${t.path === '/' ? '' : t.path}`)
    }
    const exact = t.path === '/' ? null : await getFile(t.owner, t.path)
    if (exact) {
      if (t.shared && !permission(shares, exact.data.path)) throw new DeniedError(`no read access to ${t.prefix}${t.path}`)
      const v = view(exact, t.prefix)
      return [
        {
          name: basename(v.path),
          path: v.path,
          type: 'file',
          size: v.size,
          mime: v.mime,
          version: v.version,
          updatedAt: v.updatedAt,
        },
      ]
    }
    const base = t.path === '/' ? '' : t.path
    const entries = new Map<string, DirEntry>()
    const addDir = (name: string) => {
      if (!entries.has(name)) entries.set(name, { name, path: `${t.prefix}${base}/${name}`, type: 'dir' })
    }
    for (const f of await filesUnder(t.owner, t.path)) {
      if (t.shared && !permission(shares, f.data.path)) continue
      const rel = f.data.path.slice(base.length + 1).split('/')
      if (rel.length > 1) addDir(rel[0]!)
      else {
        const v = view(f, t.prefix)
        entries.set(rel[0]!, {
          name: rel[0]!,
          path: v.path,
          type: 'file',
          size: v.size,
          mime: v.mime,
          version: v.version,
          updatedAt: v.updatedAt,
        })
      }
    }
    // Directories on the way down to a deeper share.
    for (const s of shares) {
      if (s.data.path === t.path || !isWithin(t.path, s.data.path)) continue
      const rel = s.data.path.slice(base.length + 1).split('/')
      if (rel.length > 1) addDir(rel[0]!)
    }
    if (!t.shared && t.path === '/' && reader.contactId) {
      const incoming = (await api.sharedWith(reader.contactId)).filter((s) => s.data.ownerEmployeeId !== reader.employeeId)
      if (incoming.length) entries.set('shared', { name: 'shared', path: SHARED_DIR, type: 'dir' })
    }
    return sortEntries([...entries.values()])
  }

  const concrete = (t: Target, what: string): Extract<Target, { virtual: false }> => {
    if (t.virtual) throw new ValidationError(`${SHARED_DIR} is a directory; ${what} a path under ${SHARED_DIR}/<owner>`)
    return t
  }

  const read = async (reader: Reader, path: string): Promise<FileView> => {
    const t = concrete(resolve(reader, path), 'read')
    await authorize(reader, t, 'read')
    const f = t.path === '/' ? null : await getFile(t.owner, t.path)
    if (!f) throw new NotFoundError('file', `${t.prefix}${t.path}`)
    return view(f, t.prefix)
  }

  const write = async (reader: Reader, path: string, content: string, opts: WriteFileOptions = {}): Promise<FileView> => {
    const t = concrete(resolve(reader, path), 'write')
    await authorize(reader, t, 'write')
    if (typeof content !== 'string') throw new ValidationError('content must be a string')
    const encoding = opts.encoding ?? 'utf8'
    const size = byteSize(content, encoding)
    await assertPlaceable(t.owner, t.path)
    const data: FileData = {
      employeeId: t.owner,
      path: t.path,
      content,
      encoding,
      size,
      mime: opts.mime ?? guessMime(t.path, encoding),
    }
    const o = opts.actor ? { actor: opts.actor } : {}
    const key = fileKey(t.owner, t.path)
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await records.getByKey<FileData>('file', key)
      if (existing) {
        const f = await records.update<FileData>('file', existing.id, data, {
          ...o,
          replace: true,
          ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        })
        return view(f, t.prefix)
      }
      if (opts.expectedVersion !== undefined && opts.expectedVersion > 0) throw new NotFoundError('file', `${t.prefix}${t.path}`)
      try {
        return view(await records.create<FileData>('file', data, { ...o, key }), t.prefix)
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e
      }
    }
    throw new ConflictError(`${path} keeps changing`)
  }

  const move = async (reader: Reader, from: string, to: string, opts: { overwrite?: boolean; actor?: Actor } = {}) => {
    const src = concrete(resolve(reader, from), 'move')
    const dst = concrete(resolve(reader, to), 'move to')
    if (src.owner !== dst.owner) throw new ValidationError("files can't be moved between filesystems")
    await authorize(reader, src, 'write')
    await authorize(reader, dst, 'write')
    if (src.path === '/' || dst.path === '/') throw new ValidationError("/ can't be moved")
    if (src.path === dst.path) return
    const o = opts.actor ? { actor: opts.actor } : {}
    const moveOne = async (f: FileRecord, target: string) => {
      const existing = await getFile(src.owner, target)
      if (existing) {
        if (!opts.overwrite) throw new ConflictError(`${dst.prefix}${target} already exists`)
        await records.delete('file', existing.id, { cascade: true, ...o })
      }
      for (const a of ancestors(target)) if (await getFile(src.owner, a)) throw new ConflictError(`${a} is a file`)
      await records.update<FileData>('file', f.id, { path: target }, { ...o, key: fileKey(src.owner, target) })
    }
    const file = await getFile(src.owner, src.path)
    if (file) {
      if ((await filesUnder(src.owner, dst.path)).length) throw new ConflictError(`${dst.prefix}${dst.path} is a directory`)
      return moveOne(file, dst.path)
    }
    const under = await filesUnder(src.owner, src.path)
    if (!under.length) throw new NotFoundError('file', `${src.prefix}${src.path}`)
    if (isWithin(src.path, dst.path)) throw new ValidationError("a directory can't be moved into itself")
    if (await getFile(src.owner, dst.path)) throw new ConflictError(`${dst.prefix}${dst.path} is a file`)
    for (const f of under) await moveOne(f, `${dst.path}${f.data.path.slice(src.path.length)}`)
  }

  const del = async (reader: Reader, path: string, opts: { recursive?: boolean; actor?: Actor } = {}) => {
    const t = concrete(resolve(reader, path), 'delete')
    await authorize(reader, t, 'write')
    const o = opts.actor ? { actor: opts.actor } : {}
    const file = t.path === '/' ? null : await getFile(t.owner, t.path)
    if (file) return records.delete('file', file.id, { cascade: true, ...o })
    const under = await filesUnder(t.owner, t.path)
    if (!under.length) throw new NotFoundError('file', `${t.prefix}${t.path}`)
    if (!opts.recursive) throw new ValidationError(`${t.prefix}${t.path} is a directory; pass recursive to delete it`)
    for (const f of under) await records.delete('file', f.id, { cascade: true, ...o })
  }

  const bind = (getReader: () => Promise<Reader>): FsView => ({
    list: async (dir) => list(await getReader(), dir),
    read: async (path) => read(await getReader(), path),
    write: async (path, content, opts) => write(await getReader(), path, content, opts),
    move: async (from, to, opts) => move(await getReader(), from, to, opts),
    delete: async (path, opts) => del(await getReader(), path, opts),
  })

  const api: FilesService = {
    list: async (employeeId, dir) => list(await readerOf(employeeId), dir),
    read: async (employeeId, path) => read(await readerOf(employeeId), path),
    write: async (employeeId, path, content, opts) => write(await readerOf(employeeId), path, content, opts),
    move: async (employeeId, from, to, opts) => move(await readerOf(employeeId), from, to, opts),
    delete: async (employeeId, path, opts) => del(await readerOf(employeeId), path, opts),

    async share(owner, rawPath, withContactId, perm = 'read', opts = {}) {
      const path = normalizePath(rawPath)
      if (isWithin(SHARED_DIR, path)) throw new ValidationError(`only your own files can be shared, not ${SHARED_DIR}`)
      if (!withContactId) throw new ValidationError('withContactId is required')
      if ((await resolveContact(owner)) === withContactId) throw new ValidationError("can't share with yourself")
      const data: ShareData = { ownerEmployeeId: owner, path, withContactId, permission: perm }
      const key = shareKey(owner, path, withContactId)
      const o = opts.actor ? { actor: opts.actor } : {}
      const existing = await records.getByKey<ShareData>('fs_share', key)
      if (existing) return records.update<ShareData>('fs_share', existing.id, { permission: perm }, o)
      try {
        return await records.create<ShareData>('fs_share', data, { ...o, key })
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e
        const again = await records.getByKey<ShareData>('fs_share', key)
        if (!again) throw e
        return records.update<ShareData>('fs_share', again.id, { permission: perm }, o)
      }
    },

    async unshare(owner, rawPath, withContactId, opts = {}) {
      const s = await records.getByKey<ShareData>('fs_share', shareKey(owner, normalizePath(rawPath), withContactId))
      if (s) await records.delete('fs_share', s.id, { cascade: true, ...(opts.actor ? { actor: opts.actor } : {}) })
    },

    async sharedWith(contactId) {
      return (
        await records.query<ShareData>('fs_share', { where: { withContactId: contactId }, orderBy: { field: 'createdAt' } })
      ).items
    },

    async sharesOf(owner) {
      return (await records.query<ShareData>('fs_share', { where: { ownerEmployeeId: owner }, orderBy: { field: 'createdAt' } }))
        .items
    },

    forEmployee: (employeeId) => bind(() => readerOf(employeeId)),
    forContact: (contactId) => bind(async () => ({ employeeId: null, contactId })),
  }
  return api
}
