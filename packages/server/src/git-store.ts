import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ValidationError, type Clock, type Logger } from '@mp/core'
import { mirrorKey, type GitCache } from '@mp/git'
import { gitCliCache } from '@mp/git-cli'

/** The employee the current work runs for. The workers set it around each run. */
export const employeeContext = new AsyncLocalStorage<{ employeeId: string }>()

/** Runs `fn` on behalf of an employee (git uses that employee's store and SSH key). */
export function asEmployee<T>(employeeId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return employeeId ? employeeContext.run({ employeeId }, fn) : fn()
}

export interface EmployeeGitOptions {
  /** `<root>/<employeeId>/<host>/<path>`. */
  root: string
  logger: Logger
  clock: Clock
  /** Builds a cache for one employee (default: the git CLI adapter). */
  make?(opts: { root: string }): GitCache
}

export interface EmployeeGit extends GitCache {
  /** The cache of one employee. */
  forEmployee(employeeId: string): Promise<GitCache>
  /** Drops an employee's cache instance (the store on disk stays). */
  reset(employeeId: string): void
  close(): void
}

const safeDir = (id: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ValidationError(`not a valid employee id for a git store: ${id}`)
  return id
}

/**
 * One git store per employee (docs/spec.md#git-repositories), behind the single
 * `GitCache` interface the stdlib uses: every call goes to the store of the
 * employee in `employeeContext` (set by the workers around each run, so tool
 * calls and policy hooks of a run use its employee's store). The employee's
 * SSH key is passed per call by the stdlib (`StdlibDeps.sshKeyFor`).
 */
export function employeeGit(opts: EmployeeGitOptions): EmployeeGit {
  const caches = new Map<string, Promise<GitCache>>()
  const make =
    opts.make ??
    ((o) => {
      mkdirSync(o.root, { recursive: true })
      return gitCliCache({ root: o.root, logger: opts.logger, clock: opts.clock })
    })

  const build = async (employeeId: string): Promise<GitCache> => make({ root: join(opts.root, safeDir(employeeId)) })

  const forEmployee = (employeeId: string) => {
    let c = caches.get(employeeId)
    if (!c) {
      c = build(employeeId)
      caches.set(employeeId, c)
      c.catch(() => caches.delete(employeeId))
    }
    return c
  }

  const current = () => {
    const ctx = employeeContext.getStore()
    if (!ctx) throw new ValidationError('git needs an employee: it is only available inside a run')
    return forEmployee(ctx.employeeId)
  }

  return {
    forEmployee,
    reset(employeeId) {
      caches.delete(employeeId)
    },
    close() {
      caches.clear()
    },
    mirrorPath(url) {
      const ctx = employeeContext.getStore()
      if (!ctx) throw new ValidationError('git needs an employee: it is only available inside a run')
      return join(opts.root, safeDir(ctx.employeeId), mirrorKey(url))
    },
    ensureMirror: async (url) => (await current()).ensureMirror(url),
    fetch: async (url) => (await current()).fetch(url),
    createWorktree: async (url, o) => (await current()).createWorktree(url, o),
    removeWorktree: async (url, path) => (await current()).removeWorktree(url, path),
    commitAll: async (path, o) => (await current()).commitAll(path, o),
    push: async (path, branch, policy) => (await current()).push(path, branch, policy),
    diff: async (path, base) => (await current()).diff(path, base),
    log: async (path, limit) => (await current()).log(path, limit),
    status: async (path) => (await current()).status(path),
  }
}
