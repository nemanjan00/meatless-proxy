import { createHash } from 'node:crypto'
import { UnavailableError, errorMessage, type Logger } from '@mp/core'
import type { ContainerRuntime, EnvSpec, FileEntry, VolumeMount } from '@mp/containers'
import { type FilesService, type Share, type StoredStat, sandboxPath } from '@mp/files'
import type { Actor } from '@mp/store'
import { MANIFEST_SCRIPT } from './drivers.ts'

/** Where the employee's own files are in the sandbox, and the working directory of kernels. */
export const FILES_DIR = '/work/files'
/** Where files shared with the employee appear: `/work/shared/<owner>/<path>`. */
export const SHARED_DIR = '/work/shared'

/**
 * A file a cell created, changed or deleted. `path` is how the fs.* tools and chat attachments name it
 * (`/chart.png`, `/shared/<owner>/…`); `sandboxPath` is the same file as code sees it (`/work/files/chart.png`).
 */
export interface FileChange {
  path: string
  sandboxPath: string
  change: 'created' | 'modified' | 'deleted' | 'skipped'
  size?: number
  note?: string
}

/** One employee's sandbox container, as the workspace sees it. */
export interface Box {
  employeeId: string
  /** The employee's contact, which shares are granted to. */
  contactId: string | null
  envId: string
}

/** How an employee's files get into its sandbox, and what a cell changed. */
export interface Workspace {
  readonly mode: 'mount' | 'copy'
  /**
   * What the container spec needs for the files, and a signature of it: when the signature changes
   * (a share was added or removed), the container has to be recreated to see it.
   */
  containerSpec(employeeId: string, contactId: string | null): Promise<{ spec: Partial<EnvSpec>; signature: string }>
  /** A new container is up. */
  attached(box: Box): Promise<void>
  /** Before a cell: brings the files up to date in the sandbox and remembers what they were. */
  before(box: Box): Promise<unknown>
  /** After a cell: what changed since `before`, written back to storage where needed. */
  after(box: Box, snapshot: unknown, actor?: Actor): Promise<{ changes: FileChange[]; notes: string[] }>
  /** The container is gone: forget what was copied into it. */
  forget(employeeId: string): void
}

export interface WorkspaceOptions {
  runtime: ContainerRuntime
  files: FilesService
  logger: Logger
  /** `uid:gid` of the sandbox user, for files copied in. */
  user: string
  /** Files larger than this aren't copied in or out (copy mode). */
  maxFileBytes: number
  /** The most changes reported (and, in copy mode, synced) per cell. */
  maxChanges: number
}

type Stamp = [size: number, mtimeMs: number]

/** The first entry for each path (parents are listed once per file under them). */
function uniqueByPath(entries: FileEntry[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>()
  for (const e of entries) if (!byPath.has(e.path)) byPath.set(e.path, e)
  return [...byPath.values()]
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

/** Grants to this employee's contact from others, whose paths exist. */
async function liveGrants(files: FilesService, employeeId: string, contactId: string | null): Promise<Share[]> {
  if (!contactId) return []
  const out: Share[] = []
  for (const g of await files.sharedWith(contactId)) {
    if (g.data.ownerEmployeeId === employeeId) continue
    if (!(await files.isDangling(g))) out.push(g)
  }
  return out.sort((a, b) => (a.data.ownerEmployeeId + a.data.path < b.data.ownerEmployeeId + b.data.path ? -1 : 1))
}

/** Before/after stamps of every file in the given trees, by the employee's path. */
async function stampTrees(
  files: FilesService,
  employeeId: string,
  grants: Share[],
  includeShared: (g: Share) => boolean,
): Promise<Map<string, Stamp>> {
  const out = new Map<string, Stamp>()
  const add = (prefix: string, list: StoredStat[]) => {
    for (const f of list) out.set(`${prefix}${f.path}`, [f.size, f.mtimeMs])
  }
  add('', await files.storage.walk(employeeId))
  for (const g of grants)
    if (includeShared(g)) add(`/shared/${g.data.ownerEmployeeId}`, await files.storage.walk(g.data.ownerEmployeeId, g.data.path))
  return out
}

function diff(before: Map<string, Stamp>, after: Map<string, Stamp>): FileChange[] {
  const out: FileChange[] = []
  for (const [p, s] of after) {
    const b = before.get(p)
    if (!b) out.push({ path: p, sandboxPath: sandboxPath(p), change: 'created', size: s[0] })
    else if (b[0] !== s[0] || b[1] !== s[1]) out.push({ path: p, sandboxPath: sandboxPath(p), change: 'modified', size: s[0] })
  }
  for (const p of before.keys()) if (!after.has(p)) out.push({ path: p, sandboxPath: sandboxPath(p), change: 'deleted' })
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** The owner and owner path of an employee path (`/a.txt` is the employee's, `/shared/<owner>/…` someone else's). */
function ownerOf(employeeId: string, path: string): { owner: string; path: string } {
  const m = /^\/shared\/([^/]+)(\/.*)$/.exec(path)
  return m ? { owner: m[1]!, path: m[2]! } : { owner: employeeId, path }
}

const cap = (changes: FileChange[], max: number, notes: string[]) => {
  if (changes.length <= max) return changes
  notes.push(`${changes.length - max} more file changes not listed`)
  return changes.slice(0, max)
}

/**
 * Mount mode: the files volume holds `FileStorage`'s root, so the employee's directory is mounted at
 * /work/files (read-write) and each share at /work/shared/<owner>/<path> (read-only, or read-write for
 * a write share) through volume subpaths. Nothing is copied; a cell's changes are found by comparing
 * sizes and modification times before and after it.
 */
export function mountWorkspace(opts: WorkspaceOptions & { volume: string }): Workspace {
  const { files, volume } = opts
  const grantsOf = new Map<string, Share[]>()
  return {
    mode: 'mount',

    async containerSpec(employeeId, contactId) {
      // Makes sure the employee's directory exists: a subpath mount of a missing directory fails.
      await files.storage.localPath!(employeeId)
      const grants = await liveGrants(files, employeeId, contactId)
      grantsOf.set(employeeId, grants)
      const mounts: VolumeMount[] = [{ volume, subpath: employeeId, containerPath: FILES_DIR }]
      for (const g of grants) {
        const rel = g.data.path.replace(/^\/+/, '')
        mounts.push({
          volume,
          subpath: rel ? `${g.data.ownerEmployeeId}/${rel}` : g.data.ownerEmployeeId,
          containerPath: `${SHARED_DIR}/${g.data.ownerEmployeeId}${g.data.path === '/' ? '' : g.data.path}`,
          readOnly: g.data.permission !== 'write',
        })
      }
      return { spec: { volumeMounts: mounts }, signature: hash(mounts) }
    },

    async attached() {},

    async before(box) {
      const grants = grantsOf.get(box.employeeId) ?? []
      return { grants, stamps: await stampTrees(files, box.employeeId, grants, (g) => g.data.permission === 'write') }
    },

    async after(box, snapshot, actor) {
      const snap = snapshot as { grants: Share[]; stamps: Map<string, Stamp> }
      const after = await stampTrees(files, box.employeeId, snap.grants, (g) => g.data.permission === 'write')
      const notes: string[] = []
      const changes = cap(diff(snap.stamps, after), opts.maxChanges, notes)
      for (const c of changes) {
        const o = ownerOf(box.employeeId, c.path)
        files.notifyChanged({
          ownerEmployeeId: o.owner,
          op: c.change === 'deleted' ? 'delete' : 'write',
          path: o.path,
          ...(actor ? { actor } : {}),
        })
      }
      return { changes, notes }
    },

    forget(employeeId) {
      grantsOf.delete(employeeId)
    },
  }
}

interface CopyState {
  /** Own files copied in: storage modification time, by path. */
  down: Map<string, number>
  /** Signature of what /work/shared holds. */
  shared: string
}

/**
 * Copy mode, for runtimes without volume subpaths or storage that isn't a mounted volume: before a
 * cell, what changed in storage since the last sync is copied into /work/files (and deleted files are
 * removed); after it, the files the cell created, changed or deleted are written back to storage. Shares
 * are read-only copies under /work/shared, refreshed when a grant or a shared file changes.
 */
export function copyWorkspace(opts: WorkspaceOptions): Workspace {
  const { runtime, files, logger } = opts
  const [uid, gid] = opts.user.split(':').map((n) => Number(n))
  const owner = { uid: Number.isInteger(uid) ? uid! : 1000, gid: Number.isInteger(gid) ? gid! : (uid ?? 1000) }
  const states = new Map<string, CopyState>()
  const stateOf = (employeeId: string) => {
    let s = states.get(employeeId)
    if (!s) {
      s = { down: new Map(), shared: '' }
      states.set(employeeId, s)
    }
    return s
  }
  const need = <T>(f: T | undefined, what: string): T => {
    if (!f) throw new UnavailableError(`this container runtime can't ${what}`)
    return f
  }

  /** Directory entries for every ancestor of `rel` (relative), owned as given. */
  const parents = (rel: string, o: { uid: number; gid: number; mode: number }): FileEntry[] => {
    const parts = rel.split('/').slice(0, -1)
    return parts.map((_, i) => ({
      path: parts.slice(0, i + 1).join('/'),
      type: 'dir' as const,
      mode: o.mode,
      uid: o.uid,
      gid: o.gid,
    }))
  }

  const manifest = async (envId: string): Promise<Map<string, Stamp>> => {
    const r = await runtime.exec(envId, ['python3', '-c', MANIFEST_SCRIPT, FILES_DIR], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) throw new UnavailableError(`couldn't list the sandbox's files: ${r.stderr.slice(-500)}`)
    const out = new Map<string, Stamp>()
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const [p, size, mtime] = JSON.parse(line) as [string, number, number]
        out.set(`/${p}`, [size, mtime])
      } catch {
        // not a manifest line
      }
    }
    return out
  }

  const syncShared = async (box: Box, notes: string[]) => {
    const st = stateOf(box.employeeId)
    const grants = await liveGrants(files, box.employeeId, box.contactId)
    const trees = await Promise.all(grants.map((g) => files.storage.walk(g.data.ownerEmployeeId, g.data.path)))
    const signature = hash(grants.map((g, i) => [g.id, g.data.path, trees[i]!.map((f) => [f.path, f.size, f.mtimeMs])]))
    if (signature === st.shared) return
    // Rebuilt as a whole: shares change rarely. Root-owned and read-only, so writes there are refused.
    await runtime.exec(box.envId, ['sh', '-c', `rm -rf ${SHARED_DIR}/* ${SHARED_DIR}/.[!.]* 2>/dev/null; true`], {
      user: '0:0',
      timeoutMs: 60_000,
    })
    const entries: FileEntry[] = []
    const ro = { uid: 0, gid: 0, mode: 0o555 }
    for (const [i, g] of grants.entries()) {
      for (const f of trees[i]!) {
        const rel = `${g.data.ownerEmployeeId}${f.path}`
        if (f.size > opts.maxFileBytes) {
          notes.push(`/shared/${rel} is too large to copy into the sandbox (${f.size} bytes)`)
          continue
        }
        entries.push(...parents(rel, ro), {
          path: rel,
          type: 'file',
          content: await files.storage.read(g.data.ownerEmployeeId, f.path),
          mode: 0o444,
          uid: 0,
          gid: 0,
          mtimeMs: f.mtimeMs,
        })
      }
    }
    const unique = uniqueByPath(entries)
    if (unique.length) await need(runtime.copyIn, 'copy files')(box.envId, SHARED_DIR, unique)
    st.shared = signature
  }

  const syncDown = async (box: Box, notes: string[]) => {
    const st = stateOf(box.employeeId)
    const own = await files.storage.walk(box.employeeId)
    const entries: FileEntry[] = []
    const rw = { ...owner, mode: 0o755 }
    const present = new Set<string>()
    for (const f of own) {
      present.add(f.path)
      if (st.down.get(f.path) === f.mtimeMs) continue
      if (f.size > opts.maxFileBytes) {
        notes.push(`${f.path} is too large to copy into the sandbox (${f.size} bytes)`)
        continue
      }
      const rel = f.path.slice(1)
      entries.push(...parents(rel, rw), {
        path: rel,
        type: 'file',
        content: await files.storage.read(box.employeeId, f.path),
        mode: 0o644,
        ...owner,
        mtimeMs: f.mtimeMs,
      })
      st.down.set(f.path, f.mtimeMs)
    }
    const unique = uniqueByPath(entries)
    if (unique.length) await need(runtime.copyIn, 'copy files')(box.envId, FILES_DIR, unique)
    const gone = [...st.down.keys()].filter((p) => !present.has(p))
    if (gone.length) {
      await runtime.exec(box.envId, ['rm', '-f', '--', ...gone.map((p) => `${FILES_DIR}${p}`)], { timeoutMs: 60_000 })
      for (const p of gone) st.down.delete(p)
    }
  }

  return {
    mode: 'copy',

    async containerSpec() {
      return { spec: {}, signature: 'copy' }
    },

    async attached(box) {
      states.delete(box.employeeId)
      await need(runtime.copyIn, 'copy files')(box.envId, '/work', [
        { path: 'files', type: 'dir', mode: 0o755, ...owner },
        { path: 'shared', type: 'dir', mode: 0o555, uid: 0, gid: 0 },
      ])
    },

    async before(box) {
      const notes: string[] = []
      await syncDown(box, notes)
      await syncShared(box, notes).catch((e) => {
        logger.warn('sandbox: could not copy shared files', { employeeId: box.employeeId, err: errorMessage(e) })
        notes.push('files shared with you could not be copied into the sandbox this time')
      })
      return { stamps: await manifest(box.envId), notes }
    },

    async after(box, snapshot, actor) {
      const snap = snapshot as { stamps: Map<string, Stamp>; notes: string[] }
      const st = stateOf(box.employeeId)
      const notes = [...snap.notes]
      const all = diff(snap.stamps, await manifest(box.envId))
      const changes = cap(all, opts.maxChanges, notes)
      const out: FileChange[] = []
      for (const c of changes) {
        const o = actor ? { actor } : {}
        try {
          if (c.change === 'deleted') {
            const cur = await files.storage.stat(box.employeeId, c.path)
            if (cur?.type === 'file' && st.down.get(c.path) === cur.mtimeMs) {
              await files.storage.delete(box.employeeId, c.path)
              files.notifyChanged({ ownerEmployeeId: box.employeeId, op: 'delete', path: c.path, ...o })
              out.push(c)
            } else if (cur) out.push({ ...c, change: 'skipped', note: 'changed outside the sandbox since, so it was kept' })
            else out.push(c)
            st.down.delete(c.path)
            continue
          }
          if ((c.size ?? 0) > opts.maxFileBytes) {
            out.push({ ...c, change: 'skipped', note: `larger than ${opts.maxFileBytes} bytes, not saved to your files` })
            continue
          }
          const got = (await need(runtime.copyOut, 'copy files')(box.envId, `${FILES_DIR}${c.path}`)).find(
            (e) => e.type === 'file',
          )
          if (!got) {
            out.push({ ...c, change: 'skipped', note: 'gone before it could be saved' })
            continue
          }
          const s = await files.storage.write(box.employeeId, c.path, got.content ?? new Uint8Array())
          st.down.set(c.path, s.mtimeMs)
          files.notifyChanged({ ownerEmployeeId: box.employeeId, op: 'write', path: c.path, ...o })
          out.push(c)
        } catch (e) {
          out.push({ ...c, change: 'skipped', note: `not saved: ${errorMessage(e)}` })
        }
      }
      return { changes: out, notes }
    },

    forget(employeeId) {
      states.delete(employeeId)
    },
  }
}
