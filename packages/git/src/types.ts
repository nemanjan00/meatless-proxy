import { DeniedError, ValidationError, globMatch } from '@mp/core'

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

/**
 * A branch name git would accept that can't be abused in a refspec: no `:`, `+`, spaces,
 * control characters, `..`, `@{`, glob characters, leading `-` or `.` components.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name === '@' || name.length > 255) return false
  if ([...name].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f) || /[~^:?*[\\+]/.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false
  return name.split('/').every((c) => !c.startsWith('.') && !c.endsWith('.lock'))
}

/** The hard rule: pushing to protected branches is never allowed, whoever asks. Invalid names are denied too. */
export function assertPushAllowed(branch: string, policy: PushPolicy): void {
  const name = branch.replace(/^refs\/heads\//, '')
  if (!isValidBranchName(name)) throw new DeniedError(`not a valid branch name: ${JSON.stringify(branch)}`)
  if (policy.protected.some((p) => globMatch(p, name))) throw new DeniedError(`branch ${name} is protected`)
  if (!policy.allow.some((p) => globMatch(p, name))) throw new DeniedError(`pushing to ${name} is not allowed`)
}

/**
 * `https://github.com/acme/billing.git` -> `github.com/acme/billing`. Also handles `git@host:path`,
 * `ssh://`, `file://` (under `local/`) and plain paths. The result is always a safe relative path:
 * no empty, `.` or `..` segments, and only `[A-Za-z0-9._~@:+-]` characters in each segment.
 */
export function mirrorKey(url: string): string {
  let u = url.trim().replace(/\\/g, '/')
  let host = ''
  let path: string
  const scp = /^[\w.-]+@([^:/]+):(.*)$/.exec(u)
  if (scp) {
    host = scp[1]!
    path = scp[2]!
  } else {
    let parsed: URL | null = null
    try {
      parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? new URL(u) : null
    } catch {
      parsed = null
    }
    if (parsed && parsed.protocol !== 'file:') {
      host = parsed.host
      path = parsed.pathname
    } else {
      host = 'local'
      path = parsed ? parsed.pathname : u
    }
  }
  u = path.replace(/\/+$/, '').replace(/\.git$/, '')
  const segments = [host.toLowerCase(), ...u.split('/')]
    .filter((s) => s !== '' && s !== '.')
    .map((s) => (/^\.+$/.test(s) ? '_' : s.replace(/[^\w.~@:+-]/g, '_')))
  if (segments.length < 2) throw new ValidationError(`not a repository url: ${url}`)
  return segments.join('/')
}
