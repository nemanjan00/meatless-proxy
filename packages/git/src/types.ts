import { DeniedError, ValidationError, globMatch } from '@mp/core'
import { LOCAL_MIRROR_HOST, localRepoSlug } from './local.ts'

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

/**
 * Credentials for one command that talks to a remote. The key is used only for that command
 * (written to a private temp file and removed afterwards) and never logged.
 */
export interface GitAuth {
  /** An SSH private key (OpenSSH or PEM format). */
  sshPrivateKey?: string
  /** `known_hosts` content. Without it no host keys are remembered. */
  knownHosts?: string
  /** true: only hosts in `knownHosts` (`StrictHostKeyChecking=yes`). Default: accept new hosts (`accept-new`). */
  strictHostKeyChecking?: boolean
}

/** How far a checkout's HEAD is from another ref, in commits. */
export interface RefDivergence {
  /** The ref compared with, as given (`main`, `mp/ana/fix-login`). */
  ref: string
  /** Commits on HEAD the ref doesn't have. */
  ahead: number
  /** Commits on the ref HEAD doesn't have. */
  behind: number
}

/** A checkout against its base branch and its own branch on the remote, as of the last fetch. */
export interface Divergence {
  /** The base branch (the remote's, as of the last fetch). null when the base isn't a branch (a commit, a tag) or is gone. */
  base: RefDivergence | null
  /** The checkout's own branch on the remote. null when it was never pushed (or the checkout has no branch). */
  remote: RefDivergence | null
}

/** One merge `sync` made. */
export interface SyncMerge {
  /** Where the commits came from: `origin/<branch>`. */
  from: string
  /** The commit merged (the tip of `from` at the time). */
  sha: string
  /** How many commits it brought in. */
  commits: number
  /** `fast-forward`: the branch just moved; `merge`: a merge commit. */
  mode: 'fast-forward' | 'merge'
}

export interface SyncResult {
  /** HEAD after the sync (with a conflict: where the merge started). */
  head: string
  /** The merges made, in order (the own remote branch first, then the base). Empty when nothing moved. */
  merged: SyncMerge[]
  /** A merge that stopped on conflicts: left in progress, with conflict markers in `files`. */
  conflict: { from: string; sha: string; files: string[] } | null
  /** Where the checkout stands after the sync. */
  divergence: Divergence
}

export interface GitStatus {
  clean: boolean
  /** Changed, new and deleted files (conflicted ones too). */
  files: string[]
  /** A merge is in progress (stopped on conflicts): finish it with a commit, or abort it. */
  merging: boolean
  /** Files with unresolved conflicts (git's unmerged paths). */
  conflicts: string[]
}

export interface GitCache {
  /** Where the bare mirror for a remote lives: `<root>/<host>/<path>`, like Go's module cache. */
  mirrorPath(url: string): string
  /** Clones the mirror if it isn't there yet. */
  ensureMirror(url: string, auth?: GitAuth): Promise<string>
  fetch(url: string, auth?: GitAuth): Promise<void>
  /** When the mirror of `url` was last fetched (or cloned) by this cache, epoch ms; null if not since it started. */
  lastFetch(url: string): Promise<number | null>
  /** A checkout of `ref` at `path`, optionally on a new branch. `auth` is used if the mirror has to be cloned first. */
  createWorktree(url: string, opts: { path: string; ref?: string; newBranch?: string; auth?: GitAuth }): Promise<WorktreeInfo>
  removeWorktree(url: string, path: string): Promise<void>
  /**
   * Commits every change in the worktree, or only `paths` (files or directories relative to the worktree root;
   * the rest stays uncommitted). Returns the new sha, or null if there was nothing to commit. During a merge
   * (`sync` stopped on conflicts) it completes the merge (a commit with both parents): `paths` is refused then,
   * and so are files that still have conflict markers (`ValidationError`). A path with no changes is a `ValidationError`.
   */
  commitAll(
    path: string,
    opts: { message: string; author: Author; trailers?: Record<string, string>; paths?: string[] },
  ): Promise<string | null>
  /**
   * Pushes a branch. Throws `DeniedError` unless the policy allows the branch, and `ConflictError` while a merge
   * is in progress or conflict markers from one were committed. Never forces.
   */
  push(path: string, branch: string, policy: PushPolicy, auth?: GitAuth): Promise<void>
  diff(path: string, base?: string): Promise<string>
  log(path: string, limit?: number): Promise<{ sha: string; subject: string; author: string }[]>
  status(path: string): Promise<GitStatus>
  /**
   * How far the worktree's HEAD is from `base` (a branch of the remote; default: the remote's default branch)
   * and from its own branch on the remote, as of the last fetch. Doesn't fetch.
   */
  divergence(path: string, opts?: { base?: string }): Promise<Divergence>
  /**
   * Fetches the remote, then merges (never rebases) into the worktree's branch: its own remote branch first, if
   * it moved (a fast-forward when possible), then `base` (default: the remote's default branch). Merge commits
   * are by `author`, with `trailers`. Nothing is pushed or forced. Needs a clean worktree (`ValidationError`)
   * and no merge in progress (`ConflictError`). A merge that conflicts is left in progress (see `SyncResult.conflict`).
   */
  sync(
    path: string,
    opts: { base?: string; author: Author; trailers?: Record<string, string>; auth?: GitAuth },
  ): Promise<SyncResult>
  /** Aborts a merge in progress (`git merge --abort`). Returns false when there was none. */
  abortMerge(path: string): Promise<boolean>
}

/** Whether text has git conflict markers: a `<<<<<<<` line and a `>>>>>>>` line. */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text)
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
 * `ssh://`, `file://` (under `local/`), plain paths, and the harness's own `local:<slug>` (under `harness/`). The result is always a safe relative path:
 * no empty, `.` or `..` segments, and only `[A-Za-z0-9._~@:+-]` characters in each segment.
 */
export function mirrorKey(url: string): string {
  // A repository the harness hosts itself: `local:<slug>` -> `harness/<slug>` (the slug is validated).
  const slug = localRepoSlug(url)
  if (slug) return `${LOCAL_MIRROR_HOST}/${slug}`
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

/**
 * Normalizes paths to commit (`commitAll`'s `paths`): relative to the worktree root, no `..`, nothing in `.git`,
 * no control characters. `./a/` -> `a`; `.` (the whole worktree) stays `.`. Throws `ValidationError`, or for
 * a path outside the worktree `DeniedError`.
 */
export function commitPaths(paths: string[]): string[] {
  if (!Array.isArray(paths) || !paths.length) throw new ValidationError('paths is empty')
  const out = paths.map((raw) => {
    if (typeof raw !== 'string') throw new ValidationError('paths must be strings')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(raw)) throw new ValidationError('path contains control characters')
    const parts = raw
      .replace(/\\/g, '/')
      .trim()
      .split('/')
      .filter((p) => p !== '' && p !== '.')
    if (raw.trim().startsWith('/')) throw new DeniedError(`path ${raw} is outside the worktree (paths are relative to its root)`)
    if (parts.includes('..')) throw new DeniedError(`path ${raw} is outside the worktree`)
    if (parts[0] === '.git') throw new DeniedError("the worktree's .git is off limits")
    return parts.length ? parts.join('/') : '.'
  })
  return [...new Set(out)]
}
