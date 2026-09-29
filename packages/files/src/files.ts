import { ConflictError, DeniedError, NotFoundError, ValidationError, type EventBus, type KindSchema } from '@mp/core'
import type { Records } from '@mp/records'
import type { Actor, StoredRecord } from '@mp/store'
import { SHARED_DIR, basename, employeePath, guessMime, isWithin } from './paths.ts'
import { memoryStorage, type FileStorage, type StoredStat } from './storage.ts'

export type Encoding = 'utf8' | 'base64'
export type SharePermission = 'read' | 'write'

/**
 * A sharing grant: the one thing about employee files kept in the database. The files themselves
 * live in `FileStorage` (a directory on a volume).
 */
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

export interface ShareData extends Record<string, unknown> {
  ownerEmployeeId: string
  path: string
  withContactId: string
  permission: SharePermission
}

export type Share = StoredRecord<ShareData>

/** Bus topic published on every change made through the files service. */
export const FILE_CHANGED = 'file.changed'

export interface FileChanged {
  /** Whose filesystem changed. */
  ownerEmployeeId: string
  op: 'write' | 'delete' | 'move'
  /** Path in the owner's filesystem (the new path, for a move). */
  path: string
  /** The old path, for a move. */
  from?: string
  actor?: Actor
}

/** A file as the reader sees it. `path` is the reader's path (under `/shared/<owner>` for shared files). */
export interface FileView {
  /** `<ownerEmployeeId>:<ownerPath>`. */
  id: string
  path: string
  ownerEmployeeId: string
  /** The path in the owner's filesystem. */
  ownerPath: string
  content: string
  encoding: Encoding
  size: number
  mime: string
  /** Changes with every write (the modification time in ms). Pass it back as `expectedVersion`. */
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
  /** Where the files are. */
  readonly storage: FileStorage
  /** Lists a directory: own files, `/shared` (owners sharing with you), `/shared/<ownerEmployeeId>/…` (what they share). */
  list(employeeId: string, dir?: string): Promise<DirEntry[]>
  read(employeeId: string, path: string): Promise<FileView>
  /** Creates or replaces a file. Writing under `/shared/<owner>/…` needs a `write` share. */
  write(employeeId: string, path: string, content: string, opts?: WriteFileOptions): Promise<FileView>
  /** Moves a file or a directory within one filesystem. Shares of what moved move with it. */
  move(employeeId: string, from: string, to: string, opts?: { overwrite?: boolean; actor?: Actor }): Promise<void>
  /** Deletes a file, or a directory with `recursive`. Shares of what was deleted are removed. */
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
  /** Whether a share's path no longer exists (a dangling grant: ignored in listings and mounts until the path is back). */
  isDangling(share: Share): Promise<boolean>
  /** The contact id of an employee, which shares are matched against. */
  contactOf(employeeId: string): Promise<string | null>
  /** Publishes `FILE_CHANGED` for changes made outside the service (e.g. by code in a sandbox). */
  notifyChanged(change: FileChanged): void
  /** The same operations for an employee, bound to it. */
  forEmployee(employeeId: string): FsView
  /** Access for a person (a contact without a filesystem of its own): only `/shared` paths. */
  forContact(contactId: string): FsView
}

export interface FilesDeps {
  records: Records
  /** Where file contents live. Default: `memoryStorage()`. */
  storage?: FileStorage
  /** Receives `FILE_CHANGED`. */
  bus?: EventBus
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

const shareKey = (owner: string, path: string, contact: string) => `${owner}:${path}:${contact}`
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Content as text when it is valid UTF-8 without NUL bytes, else base64. */
export function encodeContent(bytes: Uint8Array): { content: string; encoding: Encoding } {
  if (!bytes.includes(0)) {
    try {
      return { content: utf8.decode(bytes), encoding: 'utf8' }
    } catch {
      // not text
    }
  }
  return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
}

export function decodeContent(content: string, encoding: Encoding): Uint8Array {
  if (typeof content !== 'string') throw new ValidationError('content must be a string')
  if (encoding === 'utf8') return new TextEncoder().encode(content)
  if (!BASE64.test(content)) throw new ValidationError('content is not valid base64')
  return new Uint8Array(Buffer.from(content, 'base64'))
}

/** The version a file's stat stands for. */
export const versionOf = (s: StoredStat) => Math.floor(s.mtimeMs)

/** Registers the `fs_share` kind and returns the filesystem service. */
export function createFiles({ records, storage = memoryStorage(), bus, contactOf }: FilesDeps): FilesService {
  if (!records.kinds.has('fs_share')) records.kinds.define(shareSchema)

  const resolveContact = async (employeeId: string): Promise<string | null> => {
    if (contactOf) return (await contactOf(employeeId)) ?? null
    if (!records.kinds.has('employee')) return null
    const e = await records.get<{ contactId?: string }>('employee', employeeId)
    return e?.data.contactId ?? null
  }

  const readerOf = async (employeeId: string): Promise<Reader> => ({ employeeId, contactId: await resolveContact(employeeId) })

  const changed = (c: FileChanged) => {
    bus?.publish(FILE_CHANGED, c)
  }

  const resolve = (reader: Reader, raw: string): Target => {
    const path = employeePath(raw)
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

  const isDangling = async (s: Share) => (await storage.stat(s.data.ownerEmployeeId, s.data.path).catch(() => null)) === null

  const entryOf = (s: StoredStat, prefix: string): DirEntry => ({
    name: basename(s.path),
    path: `${prefix}${s.path}`,
    type: s.type,
    ...(s.type === 'file'
      ? { size: s.size, mime: guessMime(s.path, 'utf8'), version: versionOf(s), updatedAt: new Date(s.mtimeMs).toISOString() }
      : {}),
  })

  const sortEntries = (entries: DirEntry[]) =>
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))

  /** Owners (other than the reader) who share something that exists with the reader's contact. */
  const sharingOwners = async (reader: Reader) => {
    if (!reader.contactId) return []
    const owners = new Set<string>()
    for (const s of await api.sharedWith(reader.contactId)) {
      if (s.data.ownerEmployeeId === reader.employeeId || owners.has(s.data.ownerEmployeeId)) continue
      if (!(await isDangling(s))) owners.add(s.data.ownerEmployeeId)
    }
    return [...owners]
  }

  const list = async (reader: Reader, dir = '/'): Promise<DirEntry[]> => {
    const t = resolve(reader, dir)
    if (t.virtual)
      return sortEntries(
        (await sharingOwners(reader)).map((o) => ({ name: o, path: `${SHARED_DIR}/${o}`, type: 'dir' as const })),
      )
    let shares: Share[] = []
    if (t.shared) {
      shares = await sharesFor(t.owner, reader.contactId)
      // Listing is allowed inside a share and on the way down to one.
      const allowed = shares.some((s) => isWithin(s.data.path, t.path) || isWithin(t.path, s.data.path))
      if (!allowed) throw new DeniedError(`no read access to ${t.prefix}${t.path === '/' ? '' : t.path}`)
    }
    const here = await storage.stat(t.owner, t.path)
    if (!here) return []
    if (here.type === 'file') {
      if (t.shared && !permission(shares, here.path)) throw new DeniedError(`no read access to ${t.prefix}${t.path}`)
      return [entryOf(here, t.prefix)]
    }
    const entries: DirEntry[] = []
    for (const child of await storage.list(t.owner, t.path)) {
      if (t.shared) {
        const inside = permission(shares, child.path) !== null
        // Directories on the way down to a deeper share.
        const onTheWay = child.type === 'dir' && shares.some((s) => isWithin(child.path, s.data.path))
        if (!inside && !onTheWay) continue
      }
      entries.push(entryOf(child, t.prefix))
    }
    if (!t.shared && t.path === '/') {
      // An own directory can't be called `shared`: that name is where shares show up.
      const i = entries.findIndex((e) => e.path === SHARED_DIR)
      if (i >= 0) entries.splice(i, 1)
      if ((await sharingOwners(reader)).length) entries.push({ name: 'shared', path: SHARED_DIR, type: 'dir' })
    }
    return sortEntries(entries)
  }

  const concrete = (t: Target, what: string): Extract<Target, { virtual: false }> => {
    if (t.virtual) throw new ValidationError(`${SHARED_DIR} is a directory; ${what} a path under ${SHARED_DIR}/<owner>`)
    return t
  }

  const view = (owner: string, s: StoredStat, prefix: string, bytes: Uint8Array, encoding?: Encoding): FileView => {
    const c = encoding === 'utf8' ? { content: new TextDecoder().decode(bytes), encoding } : encodeContent(bytes)
    return {
      id: `${owner}:${s.path}`,
      path: `${prefix}${s.path}`,
      ownerEmployeeId: owner,
      ownerPath: s.path,
      content: c.content,
      encoding: c.encoding,
      size: s.size,
      mime: guessMime(s.path, c.encoding),
      version: versionOf(s),
      updatedAt: new Date(s.mtimeMs).toISOString(),
    }
  }

  const read = async (reader: Reader, path: string): Promise<FileView> => {
    const t = concrete(resolve(reader, path), 'read')
    await authorize(reader, t, 'read')
    const s = t.path === '/' ? null : await storage.stat(t.owner, t.path)
    if (!s) throw new NotFoundError('file', `${t.prefix}${t.path}`)
    if (s.type === 'dir') throw new ValidationError(`${t.prefix}${t.path} is a directory`)
    const bytes = await storage.read(t.owner, t.path)
    return view(t.owner, { ...s, size: bytes.length }, t.prefix, bytes)
  }

  const write = async (reader: Reader, path: string, content: string, opts: WriteFileOptions = {}): Promise<FileView> => {
    const t = concrete(resolve(reader, path), 'write')
    await authorize(reader, t, 'write')
    if (t.path === '/') throw new ValidationError('/ is a directory')
    const encoding = opts.encoding ?? 'utf8'
    const bytes = decodeContent(content, encoding)
    if (opts.expectedVersion !== undefined) {
      const cur = await storage.stat(t.owner, t.path)
      if (!cur && opts.expectedVersion > 0) throw new NotFoundError('file', `${t.prefix}${t.path}`)
      if (cur && versionOf(cur) !== opts.expectedVersion)
        throw new ConflictError(`${t.prefix}${t.path} changed since version ${opts.expectedVersion}`, { version: versionOf(cur) })
    }
    const s = await storage.write(t.owner, t.path, bytes)
    changed({ ownerEmployeeId: t.owner, op: 'write', path: t.path, ...(opts.actor ? { actor: opts.actor } : {}) })
    return view(t.owner, s, t.prefix, bytes, encoding)
  }

  /** Grants of `owner` on `path` or anything under it. */
  const grantsUnder = async (owner: string, path: string) =>
    (await api.sharesOf(owner)).filter((s) => isWithin(path, s.data.path))

  const move = async (reader: Reader, from: string, to: string, opts: { overwrite?: boolean; actor?: Actor } = {}) => {
    const src = concrete(resolve(reader, from), 'move')
    const dst = concrete(resolve(reader, to), 'move to')
    if (src.owner !== dst.owner) throw new ValidationError("files can't be moved between filesystems")
    await authorize(reader, src, 'write')
    await authorize(reader, dst, 'write')
    if (src.path === '/' || dst.path === '/') throw new ValidationError("/ can't be moved")
    if (src.path === dst.path) return
    await storage.move(src.owner, src.path, dst.path, opts.overwrite ? { overwrite: true } : {})
    const o = opts.actor ? { actor: opts.actor } : {}
    // Grants follow what they grant.
    for (const g of await grantsUnder(src.owner, src.path)) {
      const path = `${dst.path}${g.data.path.slice(src.path.length)}`
      const key = shareKey(src.owner, path, g.data.withContactId)
      const clash = await records.getByKey<ShareData>('fs_share', key)
      if (clash && clash.id !== g.id) await records.delete('fs_share', clash.id, { cascade: true, ...o })
      await records.update<ShareData>('fs_share', g.id, { path }, { ...o, key })
    }
    changed({ ownerEmployeeId: src.owner, op: 'move', path: dst.path, from: src.path, ...o })
  }

  const del = async (reader: Reader, path: string, opts: { recursive?: boolean; actor?: Actor } = {}) => {
    const t = concrete(resolve(reader, path), 'delete')
    await authorize(reader, t, 'write')
    if (t.path === '/') throw new ValidationError("/ can't be deleted")
    try {
      await storage.delete(t.owner, t.path, opts.recursive ? { recursive: true } : {})
    } catch (e) {
      if (e instanceof NotFoundError) throw new NotFoundError('file', `${t.prefix}${t.path}`)
      if (e instanceof ValidationError)
        throw new ValidationError(`${t.prefix}${t.path} is a directory; pass recursive to delete it`)
      throw e
    }
    const o = opts.actor ? { actor: opts.actor } : {}
    for (const g of await grantsUnder(t.owner, t.path)) await records.delete('fs_share', g.id, { cascade: true, ...o })
    changed({ ownerEmployeeId: t.owner, op: 'delete', path: t.path, ...o })
  }

  const bind = (getReader: () => Promise<Reader>): FsView => ({
    list: async (dir) => list(await getReader(), dir),
    read: async (path) => read(await getReader(), path),
    write: async (path, content, opts) => write(await getReader(), path, content, opts),
    move: async (from, to, opts) => move(await getReader(), from, to, opts),
    delete: async (path, opts) => del(await getReader(), path, opts),
  })

  const api: FilesService = {
    storage,
    list: async (employeeId, dir) => list(await readerOf(employeeId), dir),
    read: async (employeeId, path) => read(await readerOf(employeeId), path),
    write: async (employeeId, path, content, opts) => write(await readerOf(employeeId), path, content, opts),
    move: async (employeeId, from, to, opts) => move(await readerOf(employeeId), from, to, opts),
    delete: async (employeeId, path, opts) => del(await readerOf(employeeId), path, opts),

    async share(owner, rawPath, withContactId, perm = 'read', opts = {}) {
      const path = employeePath(rawPath)
      if (isWithin(SHARED_DIR, path)) throw new ValidationError(`only your own files can be shared, not ${SHARED_DIR}`)
      if (!withContactId) throw new ValidationError('withContactId is required')
      if ((await resolveContact(owner)) === withContactId) throw new ValidationError("can't share with yourself")
      // A share of nothing would look like it worked and show the other side an empty folder.
      if (path !== '/' && !(await storage.stat(owner, path)))
        throw new NotFoundError('file', `${path}: not in your filesystem (fs.list shows what is)`)
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
      const s = await records.getByKey<ShareData>('fs_share', shareKey(owner, employeePath(rawPath), withContactId))
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

    isDangling,
    contactOf: resolveContact,
    notifyChanged: changed,
    forEmployee: (employeeId) => bind(() => readerOf(employeeId)),
    forContact: (contactId) => bind(async () => ({ employeeId: null, contactId })),
  }
  return api
}
