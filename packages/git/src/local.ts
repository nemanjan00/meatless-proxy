import { ValidationError } from '@mp/core'
import type { Author, GitAuth } from './types.ts'

// ─── Local repositories: bare repositories the harness hosts itself ─────────
//
// A project repository with `url: 'local:<slug>'` lives in the harness, at `<local repos root>/<slug>.git`.
// Only the harness's own checkouts use it (no git-over-SSH or HTTP). Employees push their own branches
// there like to any remote; people review and merge them in the web UI. See docs/spec.md#local-projects.

/** The URL scheme of a local repository: `local:<slug>`. */
export const LOCAL_REPO_SCHEME = 'local:'

/** The first segment of a local repository's `mirrorKey`: `harness/<slug>`. */
export const LOCAL_MIRROR_HOST = 'harness'

/** The branch a new local repository starts with. */
export const LOCAL_DEFAULT_BRANCH = 'main'

/**
 * The event source and subject system of local repository events (`branch.merged`, `branch.deleted`): a person
 * merged or deleted a branch in the web UI. `git.push` subscribes the pushing session to its branch.
 */
export const LOCAL_GIT_SYSTEM = 'local-git'

/** The subject of one branch of a local repository: `{ system: 'local-git', id: '<slug>/<branch>' }`. */
export const localBranchSubject = (slug: string, branch: string): { system: string; id: string } => ({
  system: LOCAL_GIT_SYSTEM,
  id: `${slug}/${branch}`,
})

/** Lowercase letters, digits and inner dashes, at most 64: nothing that can name another directory. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Whether `slug` names a local repository: `[a-z0-9-]`, 1-64 characters, no leading or trailing dash. */
export function isValidRepoSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_RE.test(slug)
}

/** Throws `ValidationError` unless `slug` is a valid local repository name. */
export function assertRepoSlug(slug: string): string {
  if (!isValidRepoSlug(slug))
    throw new ValidationError(
      `not a valid local repository name: ${JSON.stringify(slug)} (lowercase letters, digits and dashes, at most 64)`,
    )
  return slug
}

/** Whether a repository URL is a local one (`local:…`), valid or not. */
export const isLocalRepoUrl = (url: string): boolean => url.trim().toLowerCase().startsWith(LOCAL_REPO_SCHEME)

/** `local:<slug>`, for a valid slug. */
export function localRepoUrl(slug: string): string {
  return `${LOCAL_REPO_SCHEME}${assertRepoSlug(slug)}`
}

/** The slug of a local repository URL, or null for any other URL. A `local:` URL with a bad slug throws. */
export function localRepoSlug(url: string): string | null {
  if (!isLocalRepoUrl(url)) return null
  return assertRepoSlug(url.trim().slice(LOCAL_REPO_SCHEME.length))
}

/** A slug from a project name: `Billing API v2` -> `billing-api-v2`. Empty when nothing usable is left. */
export function slugifyRepoName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

/** A branch of a local repository other than its default branch, compared with the default branch. */
export interface LocalBranch {
  name: string
  sha: string
  /** Commits on the branch that the default branch doesn't have. */
  ahead: number
  /** Commits on the default branch that the branch doesn't have. */
  behind: number
  subject: string
  author: string
  /** The last commit's date (ISO). */
  date: string
}

export interface LocalCommit {
  sha: string
  subject: string
  author: string
  date: string
}

export interface LocalComparison {
  branch: string
  /** The default branch it is compared with. */
  base: string
  ahead: number
  behind: number
  /** Commits on the branch that the default branch doesn't have, newest first (at most 200). */
  commits: LocalCommit[]
  /** Changed files since the merge base: git's status letter (A, M, D, R…) and path. */
  files: { status: string; path: string }[]
  /** The diff since the merge base (what merging would bring in). */
  diff: string
  /** The diff was cut at the size limit. */
  truncated: boolean
  /** Whether merging would be a fast-forward. */
  fastForward: boolean
}

export interface LocalMergeResult {
  branch: string
  into: string
  /** The default branch's new head. */
  sha: string
  mode: 'fast-forward' | 'merge-commit'
}

export interface LocalTreeEntry {
  name: string
  type: 'file' | 'dir'
  /** Bytes, for files. */
  size?: number
}

/**
 * The harness's own bare repositories (L1 port; `@mp/git-cli` has the adapter). Everything here is
 * a person's action, through the web UI and admin API: employees reach a local repository only
 * through `GitCache` (checkouts and guarded pushes of their own branches). There is no merge tool.
 */
export interface LocalRepos {
  /** The directory the repositories are in. */
  readonly root: string
  /** `<root>/<slug>.git`. Throws `ValidationError` for an invalid slug. */
  pathOf(slug: string): string
  exists(slug: string): Promise<boolean>
  /**
   * A new bare repository with one empty commit on `main` (by `author`), so checkouts work at once.
   * `ConflictError` if the slug is taken.
   */
  create(
    slug: string,
    opts: { author: Author; message?: string },
  ): Promise<{ slug: string; url: string; defaultBranch: string; head: string }>
  /** Removes a repository (rolls back a create whose project couldn't be written). */
  remove(slug: string): Promise<void>
  /** The default branch (what `HEAD` points at). */
  defaultBranch(slug: string): Promise<string>
  /** Every branch but the default one, most recently committed first. */
  branches(slug: string): Promise<LocalBranch[]>
  /** A branch against the default branch: its commits and diff. */
  compare(slug: string, branch: string, opts?: { maxDiffBytes?: number }): Promise<LocalComparison>
  /**
   * Merges a branch into the default branch: a fast-forward when possible, else a merge commit by
   * `author`. Conflicts are a `ConflictError` with `details.files`; nothing is written then.
   * A branch with nothing to merge is a `ValidationError`.
   */
  merge(slug: string, branch: string, opts: { author: Author; message?: string }): Promise<LocalMergeResult>
  /** Deletes a branch. The default branch can't be deleted. */
  deleteBranch(slug: string, branch: string): Promise<void>
  /** A directory of a ref (default: the default branch). `path` is relative to the repository root. */
  tree(slug: string, opts?: { ref?: string; path?: string }): Promise<{ path: string; ref: string; entries: LocalTreeEntry[] }>
  /** A file of a ref (default: the default branch). Binary files and files over `maxBytes` come without content. */
  readFile(
    slug: string,
    opts: { ref?: string; path: string; maxBytes?: number },
  ): Promise<{ path: string; ref: string; size: number; binary: boolean; tooLarge: boolean; content: string | null }>
  /**
   * Pushes every branch and tag to a remote (attaching one to a local project). A person's action,
   * with the credentials they chose. Access problems are `DeniedError`, a remote with other history `ConflictError`.
   */
  pushAll(slug: string, remoteUrl: string, auth?: GitAuth): Promise<{ branches: string[] }>
}
