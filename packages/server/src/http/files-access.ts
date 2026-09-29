/**
 * Employee files over the API are private (docs/spec.md "Employee filesystem"):
 * admins see and change everything, everyone else only what the employee shared
 * with them (`fs_share` grants to their contact), read or write as granted. The
 * employee's own tools don't come through here.
 */
import type * as Api from '@mp/api'
import { DeniedError, ValidationError } from '@mp/core'
import { type DirEntry, type FileView, SHARED_DIR, employeePath, isWithin } from '@mp/files'
import type { Actor } from '@mp/store'
import type { Principal } from '../auth/guard.ts'
import type { Services } from '../services.ts'

export interface EmployeeFiles {
  list(dir: string): Promise<Api.FileEntry[]>
  read(path: string): Promise<Api.FileContent>
  write(
    path: string,
    content: string,
    opts: { expectedVersion?: number; encoding?: Api.FileEncoding; actor: Actor },
  ): Promise<Api.FileContent>
}

/** The size in bytes of a file's content as sent (base64 decodes to 3/4 of its length, less padding). */
export function fileBytes(content: string, encoding: Api.FileEncoding): number {
  if (encoding === 'utf8') return Buffer.byteLength(content, 'utf8')
  const pad = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
  return Math.floor((content.length * 3) / 4) - pad
}

const content = (f: FileView, path = f.path): Api.FileContent => ({
  path,
  content: f.content,
  encoding: f.encoding,
  size: f.size,
  version: f.version,
  updatedAt: f.updatedAt,
})

const entry = (e: DirEntry, path = e.path, shared?: Api.FileEntry['shared']): Api.FileEntry => ({
  path,
  name: e.name,
  type: e.type,
  size: e.size ?? 0,
  updatedAt: e.updatedAt ?? '',
  ...(shared ? { shared } : {}),
})

/** An employee's files as this person may reach them. */
export function employeeFiles(s: Services, principal: Principal, employeeId: string): EmployeeFiles {
  if (principal.access === 'admin') {
    // Everything, as the employee sees it (what others share with it shows under /shared).
    return {
      async list(dir) {
        return (await s.files.list(employeeId, dir)).map((e) => {
          const m = /^\/shared\/([^/]+)\/.+/.exec(e.path)
          return entry(e, e.path, m ? { ownerEmployeeId: m[1]!, permission: 'read' } : undefined)
        })
      },
      read: async (path) => content(await s.files.read(employeeId, path)),
      write: async (path, text, opts) => content(await s.files.write(employeeId, path, text, opts)),
    }
  }

  // Everyone else: the employee's files shared with them, at the employee's own paths.
  const view = s.files.forContact(principal.contactId)
  const prefix = `${SHARED_DIR}/${employeeId}`
  const own = (raw: string) => {
    const path = employeePath(raw)
    // What other employees shared with this one is theirs to share, not this employee's.
    if (isWithin(SHARED_DIR, path)) throw new DeniedError(`only admins can see what is shared with an employee (${path})`)
    return path
  }
  const strip = (p: string) => (p === prefix ? '/' : p.startsWith(`${prefix}/`) ? p.slice(prefix.length) : p)
  const grants = async () => (await s.files.sharedWith(principal.contactId)).filter((g) => g.data.ownerEmployeeId === employeeId)
  const permissionAt = (gs: Awaited<ReturnType<typeof grants>>, path: string): 'read' | 'write' | null => {
    let best: 'read' | 'write' | null = null
    for (const g of gs) if (isWithin(g.data.path, path)) best = g.data.permission === 'write' ? 'write' : (best ?? 'read')
    return best
  }

  return {
    async list(dir) {
      const path = own(dir || '/')
      let entries: DirEntry[]
      try {
        entries = await view.list(path === '/' ? prefix : `${prefix}${path}`)
      } catch (e) {
        // Nothing shared: an empty filesystem at the top, and no access further down.
        if (e instanceof DeniedError && path === '/') return []
        throw e
      }
      const gs = await grants()
      return entries.map((e) => {
        const p = strip(e.path)
        const permission = permissionAt(gs, p)
        return entry(e, p, permission ? { ownerEmployeeId: employeeId, permission } : undefined)
      })
    },
    async read(path) {
      const p = own(path)
      if (p === '/') throw new ValidationError('/ is a directory')
      const f = await view.read(`${prefix}${p}`)
      return content(f, strip(f.path))
    },
    async write(path, text, opts) {
      const p = own(path)
      if (p === '/') throw new ValidationError('/ is a directory')
      const f = await view.write(`${prefix}${p}`, text, opts)
      return content(f, strip(f.path))
    },
  }
}
