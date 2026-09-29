import { DeniedError, globMatch } from '@mp/core'

export interface Author {
  name: string
  email: string
}

export interface PushPolicy {
  /** Branches the harness may push to, as globs. e.g. `['mp/**']`. */
  allow: string[]
  /** Never pushed to, whatever `allow` says. e.g. `['main', 'master', 'release/**']`. */
  protected: string[]
}

export interface WorktreeInfo {
  path: string
  branch: string | null
  head: string
}

export interface GitCache {
  /** Where the bare mirror for a remote lives: `<root>/<host>/<path>`, like Go's module cache. */
  mirrorPath(url: string): string
  /** Clones the mirror if it isn't there yet. */
  ensureMirror(url: string): Promise<string>
  fetch(url: string): Promise<void>
  /** A checkout of `ref` at `path`, optionally on a new branch. */
  createWorktree(url: string, opts: { path: string; ref?: string; newBranch?: string }): Promise<WorktreeInfo>
  removeWorktree(url: string, path: string): Promise<void>
  /** Commits every change in the worktree. Returns the new sha, or null if there was nothing to commit. */
  commitAll(path: string, opts: { message: string; author: Author; trailers?: Record<string, string> }): Promise<string | null>
  /** Pushes a branch. Throws `DeniedError` unless the policy allows the branch. */
  push(path: string, branch: string, policy: PushPolicy): Promise<void>
  diff(path: string, base?: string): Promise<string>
  log(path: string, limit?: number): Promise<{ sha: string; subject: string; author: string }[]>
  status(path: string): Promise<{ clean: boolean; files: string[] }>
}

/** The hard rule: pushing to protected branches is never allowed, whoever asks. */
export function assertPushAllowed(branch: string, policy: PushPolicy): void {
  const name = branch.replace(/^refs\/heads\//, '')
  if (policy.protected.some((p) => globMatch(p, name))) throw new DeniedError(`branch ${name} is protected`)
  if (!policy.allow.some((p) => globMatch(p, name))) throw new DeniedError(`pushing to ${name} is not allowed`)
}

/** `https://github.com/acme/billing.git` -> `github.com/acme/billing`. Also handles `git@host:path`. */
export function mirrorKey(url: string): string {
  let u = url.trim()
  const scp = /^[\w.-]+@([^:]+):(.+)$/.exec(u)
  if (scp) u = `${scp[1]}/${scp[2]}`
  else {
    try {
      const parsed = new URL(u)
      u = parsed.protocol === 'file:' ? `local${parsed.pathname}` : `${parsed.host}${parsed.pathname}`
    } catch {
      u = `local/${u}`
    }
  }
  return u
    .replace(/\.git$/, '')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '')
    .replace(/\.\.+/g, '_')
}
