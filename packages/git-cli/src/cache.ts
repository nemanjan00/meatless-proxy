import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ConflictError, NotFoundError, ValidationError, silentLogger, systemClock, type Clock, type Logger } from '@mp/core'
import {
  assertPushAllowed,
  commitPaths,
  hasConflictMarkers,
  isValidBranchName,
  localRepoSlug,
  mirrorKey,
  type Author,
  type Divergence,
  type GitAuth,
  type GitCache,
  type RefDivergence,
  type SyncResult,
  type WorktreeInfo,
} from '@mp/git'
import { GitError, gitRunner, withAuth } from './exec.ts'

export { GitError } from './exec.ts'

export interface GitCliOptions {
  /** Cache root. Mirrors live at `<root>/<host>/<path>`. */
  root: string
  /** The git binary. Default `git`. */
  git?: string
  /** Environment for git processes. Default: the harness's own environment. */
  env?: Record<string, string | undefined>
  logger?: Logger
  /** Used for commit dates. */
  clock?: Clock
  /** Kills a git command that runs longer than this. Default 10 minutes. */
  timeoutMs?: number
  /**
   * Where the harness's own repositories are (`LOCAL_REPOS_DIR`): a `local:<slug>` url is fetched from
   * and pushed to `<localReposDir>/<slug>.git` directly, without auth. Without it `local:` urls are refused.
   */
  localReposDir?: string
}

/** Remote-tracking layout: remote branches under `refs/remotes/origin/*`, session branches are local `refs/heads/*`. */
const FETCH_REFSPECS = ['+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']

const TRAILER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/

/** In a worktree's git dir: the files a merge by `sync` left conflicted, checked again before commit and push. */
const CONFLICTS_FILE = 'MP_CONFLICTS'

/** Checks an author and trailers, and returns the message with the trailers appended. */
function commitMessage(message: string, author: Author, trailers: Record<string, string> = {}): string {
  if (!message.trim()) throw new ValidationError('commit message is empty')
  const bad = [author.name, author.email].some((s) => !s.trim() || /[<>\n\r\0]/.test(s))
  if (bad) throw new ValidationError('author name and email must be non-empty, without <, > or newlines')
  const entries = Object.entries(trailers)
  for (const [k, v] of entries) {
    if (!TRAILER_KEY_RE.test(k) || /[\n\r\0]/.test(v)) throw new ValidationError(`bad trailer: ${k}`)
  }
  return entries.length ? `${message.trimEnd()}\n\n${entries.map(([k, v]) => `${k}: ${v}`).join('\n')}\n` : message
}

/** A pathspec that matches `p` literally (`.`: everything). */
const literal = (p: string) => (p === '.' ? '.' : `:(literal)${p}`)

/** Another git process holds the worktree's index lock: say so plainly. */
function lockError(e: unknown): unknown {
  if (e instanceof GitError && /index\.lock/.test(e.message)) {
    return new ConflictError(
      'another git operation is running in this checkout (its index.lock exists): try again in a moment; if it persists, a crashed git process left the lock behind',
    )
  }
  return e
}

/**
 * `GitCache` on the git CLI. Each remote gets one bare cache repository (the "mirror"),
 * and sessions get worktrees of it. Every operation on one mirror, including those on its
 * worktrees, runs one at a time.
 */
export function gitCliCache(opts: GitCliOptions): GitCache {
  const root = resolve(opts.root)
  const gitBin = opts.git ?? 'git'
  const log = opts.logger ?? silentLogger
  const clock = opts.clock ?? systemClock
  const timeout = opts.timeoutMs ?? 10 * 60_000
  const baseEnv = { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

  const locks = new Map<string, Promise<unknown>>()
  const commonDirs = new Map<string, string>()
  /** When each mirror was last fetched (or cloned), by its real path. */
  const fetchedAt = new Map<string, number>()
  const realKey = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const markFetched = (mirror: string) => void fetchedAt.set(realKey(mirror), clock.now())

  /** Runs `fn` after every earlier operation on the same key finished. */
  function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    locks.set(key, tail)
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return run
  }

  const git = gitRunner({ git: gitBin, env: baseEnv, timeoutMs: timeout })

  const mirrorPath = (url: string) => join(root, mirrorKey(url))

  /** What git fetches from and pushes to for a repository url: a local repository's path, else the url itself. */
  const remoteOf = async (url: string): Promise<string> => {
    const slug = localRepoSlug(url)
    if (!slug) return url
    if (!opts.localReposDir) throw new ValidationError('local repositories are not configured here')
    const path = join(resolve(opts.localReposDir), `${slug}.git`)
    if (!(await exists(join(path, 'HEAD')))) throw new NotFoundError('local repository', slug)
    return path
  }

  async function exists(p: string) {
    try {
      await stat(p)
      return true
    } catch {
      return false
    }
  }

  async function ensureMirrorUnlocked(url: string, auth?: GitAuth): Promise<string> {
    const path = mirrorPath(url)
    if (await exists(join(path, 'HEAD'))) return path
    if (url.startsWith('-')) throw new ValidationError(`not a repository url: ${url}`)
    const remote = await remoteOf(url)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`
    try {
      await git(['init', '--bare', '--quiet', tmp])
      await git(['--git-dir', tmp, 'config', 'remote.origin.url', remote])
      for (const spec of FETCH_REFSPECS) await git(['--git-dir', tmp, 'config', '--add', 'remote.origin.fetch', spec])
      await git(['--git-dir', tmp, 'config', 'gc.worktreePruneExpire', 'now'])
      await withAuth(auth, async (env) => {
        await git(['--git-dir', tmp, 'fetch', '--prune', '--quiet', 'origin'], { env })
        await git(['--git-dir', tmp, 'remote', 'set-head', 'origin', '--auto'], { env, allowFail: true })
      })
      await rename(tmp, path)
    } catch (e) {
      await rm(tmp, { recursive: true, force: true })
      throw e
    }
    markFetched(path)
    log.info('git mirror created', { mirror: path })
    return path
  }

  /** The mirror a worktree belongs to. */
  async function commonDir(path: string): Promise<string> {
    const cached = commonDirs.get(path)
    if (cached) return cached
    if (!isAbsolute(path) || !(await exists(path))) throw new NotFoundError('worktree', path)
    const { stdout } = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path }).catch(() => {
      throw new NotFoundError('worktree', path)
    })
    const dir = stdout.trim()
    commonDirs.set(path, dir)
    return dir
  }

  async function onWorktree<T>(path: string, fn: (mirror: string) => Promise<T>): Promise<T> {
    const mirror = await commonDir(path)
    return locked(mirror, () => fn(mirror))
  }

  async function revParse(gitDir: string, ref: string): Promise<string | null> {
    const r = await git(['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
      allowFail: true,
    })
    return r.code === 0 ? r.stdout.trim() : null
  }

  /** Local branch first (a session's own work), then the remote's branch, then any rev (sha, tag). */
  async function resolveRef(gitDir: string, ref: string | undefined): Promise<string> {
    const candidates =
      ref === undefined
        ? ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']
        : [`refs/heads/${ref}`, `refs/remotes/origin/${ref}`, ref]
    if (ref !== undefined && (ref.startsWith('-') || !ref.trim())) throw new ValidationError(`bad ref: ${ref}`)
    for (const c of candidates) {
      const sha = await revParse(gitDir, c)
      if (sha) return sha
    }
    throw new NotFoundError('ref', ref ?? 'default branch')
  }

  /** Fetches a mirror from its origin. */
  async function fetchMirror(m: string, auth: GitAuth | undefined) {
    await withAuth(auth, async (env) => {
      await git(['--git-dir', m, 'remote', 'update', '--prune'], { env })
      await git(['--git-dir', m, 'remote', 'set-head', 'origin', '--auto'], { env, allowFail: true })
    })
    markFetched(m)
  }

  /** The worktree's own git dir (where MERGE_HEAD and its index live). */
  const gitDirOf = async (path: string) =>
    (await git(['rev-parse', '--path-format=absolute', '--absolute-git-dir'], { cwd: path })).stdout.trim()

  const isMerging = async (path: string) => exists(join(await gitDirOf(path), 'MERGE_HEAD'))

  /** The branch checked out in a worktree, or null when detached. */
  async function currentBranch(path: string): Promise<string | null> {
    const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: path, allowFail: true })
    return r.code === 0 ? r.stdout.trim() || null : null
  }

  /** The base branch to compare with and merge from: the remote's (as of the last fetch), else a local branch. */
  async function baseRef(
    m: string,
    base: string | undefined,
    branch: string | null,
  ): Promise<{ name: string; sha: string } | null> {
    let name = base
    if (name === undefined) {
      const head = await git(['--git-dir', m, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true })
      name = head.code === 0 ? head.stdout.trim().replace(/^refs\/remotes\/origin\//, '') : undefined
      if (!name) {
        for (const guess of ['main', 'master']) if (await revParse(m, `refs/remotes/origin/${guess}`)) name = guess
      }
      if (!name) return null
    }
    if (!name.trim() || name.startsWith('-')) return null
    const remote = await revParse(m, `refs/remotes/origin/${name}`)
    if (remote) return { name, sha: remote }
    // Another session's branch that was never pushed: compare with it as it is here.
    const local = name !== branch ? await revParse(m, `refs/heads/${name}`) : null
    return local ? { name, sha: local } : null
  }

  async function compare(path: string, ref: string, sha: string): Promise<RefDivergence> {
    const { stdout } = await git(['rev-list', '--left-right', '--count', `HEAD...${sha}`], { cwd: path })
    const [ahead, behind] = stdout.trim().split(/\s+/).map(Number) as [number, number]
    return { ref, ahead, behind }
  }

  async function divergenceUnlocked(path: string, m: string, base: string | undefined): Promise<Divergence> {
    const branch = await currentBranch(path)
    const b = await baseRef(m, base, branch)
    const own = branch ? await revParse(m, `refs/remotes/origin/${branch}`) : null
    return {
      base: b ? await compare(path, b.name, b.sha) : null,
      remote: own && branch ? await compare(path, branch, own) : null,
    }
  }

  /** Changed files in a worktree (git status), with the unmerged ones. */
  async function statusUnlocked(path: string) {
    const { stdout } = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: path })
    const parts = stdout.split('\0')
    const files: string[] = []
    const conflicts: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!
      if (p.length < 4) continue
      const xy = p.slice(0, 2)
      files.push(p.slice(3))
      if (xy.includes('U') || xy === 'AA' || xy === 'DD') conflicts.push(p.slice(3))
      if (p[0] === 'R' || p[0] === 'C') i++ // the next part is the rename's source
    }
    return { files: files.sort(), conflicts: conflicts.sort() }
  }

  /** The files the last conflicted merge by `sync` left (cleared by an abort or a clean push). */
  async function recordedConflicts(gitDir: string): Promise<string[]> {
    try {
      const v = JSON.parse(await readFile(join(gitDir, CONFLICTS_FILE), 'utf8'))
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  /** Those of `files` whose content (in the worktree, or at `rev`) still has conflict markers. */
  async function withMarkers(path: string, files: string[], rev?: string): Promise<string[]> {
    const out: string[] = []
    for (const f of files) {
      let text: string | null = null
      if (rev) {
        const r = await git(['show', `${rev}:${f}`], { cwd: path, allowFail: true })
        text = r.code === 0 ? r.stdout : null
      } else {
        text = await readFile(join(path, f), 'utf8').catch(() => null)
      }
      if (text !== null && hasConflictMarkers(text)) out.push(f)
    }
    return out
  }

  const identityArgs = (author: Author) => ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`]
  const identityEnv = (author: Author) => {
    const date = `${Math.floor(clock.now() / 1000)} +0000`
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: date,
    }
  }

  const cache: GitCache = {
    mirrorPath,

    ensureMirror(url, auth) {
      return locked(mirrorPath(url), () => ensureMirrorUnlocked(url, auth))
    },

    fetch(url, auth) {
      return locked(mirrorPath(url), async () => {
        const m = await ensureMirrorUnlocked(url, auth)
        await fetchMirror(m, auth)
      })
    },

    async lastFetch(url) {
      return fetchedAt.get(realKey(mirrorPath(url))) ?? null
    },

    createWorktree(url, o) {
      if (!isAbsolute(o.path)) return Promise.reject(new ValidationError(`worktree path must be absolute: ${o.path}`))
      if (o.newBranch !== undefined && !isValidBranchName(o.newBranch)) {
        return Promise.reject(new ValidationError(`not a valid branch name: ${o.newBranch}`))
      }
      return locked(mirrorPath(url), async () => {
        const m = await ensureMirrorUnlocked(url, o.auth)
        const sha = await resolveRef(m, o.ref)
        if (o.newBranch !== undefined && (await revParse(m, `refs/heads/${o.newBranch}`))) {
          throw new ConflictError(`branch ${o.newBranch} already exists`)
        }
        await mkdir(dirname(o.path), { recursive: true })
        const args = o.newBranch !== undefined ? ['-b', o.newBranch, '--no-track'] : ['--detach']
        try {
          await git(['--git-dir', m, 'worktree', 'add', '--quiet', ...args, '--', o.path, sha])
        } catch (e) {
          if (e instanceof GitError && /already exists|already checked out|is a missing but/.test(e.message)) {
            throw new ConflictError(`worktree ${o.path}: ${e.message}`)
          }
          throw e
        }
        const head = (await git(['rev-parse', 'HEAD'], { cwd: o.path })).stdout.trim()
        commonDirs.set(o.path, m)
        log.info('worktree created', { mirror: m, path: o.path, branch: o.newBranch ?? null })
        const info: WorktreeInfo = { path: o.path, branch: o.newBranch ?? null, head }
        return info
      })
    },

    removeWorktree(url, path) {
      return locked(mirrorPath(url), async () => {
        const m = mirrorPath(url)
        commonDirs.delete(path)
        if (!(await exists(join(m, 'HEAD')))) return
        const r = await git(['--git-dir', m, 'worktree', 'remove', '--force', '--', path], { allowFail: true })
        if (r.code !== 0 && !/is not a working tree|does not exist|No such file/i.test(r.stderr)) {
          throw new GitError(`git worktree remove failed: ${r.stderr.trim()}`, {
            args: ['worktree', 'remove'],
            exitCode: r.code,
            stderr: r.stderr,
          })
        }
        await git(['--git-dir', m, 'worktree', 'prune'])
      })
    },

    async commitAll(path, o) {
      const message = commitMessage(o.message, o.author, o.trailers)
      const paths = o.paths !== undefined ? commitPaths(o.paths) : undefined
      return onWorktree(path, async () => {
        try {
          const gitDir = await gitDirOf(path)
          const merging = await exists(join(gitDir, 'MERGE_HEAD'))
          if (merging) {
            if (paths) throw new ValidationError('a merge is in progress: commit everything (without paths) to finish it')
            const conflicted = [...new Set([...(await statusUnlocked(path)).conflicts, ...(await recordedConflicts(gitDir))])]
            const left = await withMarkers(path, conflicted)
            if (left.length) throw new ValidationError(`conflict markers remain in ${left.join(', ')}`)
          }
          if (paths) {
            for (const p of paths) {
              const r = await git(['status', '--porcelain', '--untracked-files=all', '--', literal(p)], { cwd: path })
              if (!r.stdout.trim()) throw new ValidationError(`no changes in ${p}`)
            }
            // Only these paths: whatever else the index holds stays out of the commit.
            await git(['reset', '--quiet'], { cwd: path })
            await git(['add', '-A', '--', ...paths.map(literal)], { cwd: path })
          } else {
            await git(['add', '-A'], { cwd: path })
          }
          // A merge commit is made even when the merge changed nothing (both parents are what matters).
          if (!merging) {
            const staged = await git(['diff', '--cached', '--quiet'], { cwd: path, allowFail: true })
            if (staged.code === 0) return null
          }
          await git([...identityArgs(o.author), 'commit', '--quiet', '--no-verify', '--cleanup=whitespace', '-m', message], {
            cwd: path,
            env: identityEnv(o.author),
          })
          return (await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()
        } catch (e) {
          throw lockError(e)
        }
      })
    },

    async push(path, branch, policy, auth) {
      // The hard rule comes first, before git is even asked anything.
      assertPushAllowed(branch, policy)
      const name = branch.replace(/^refs\/heads\//, '')
      await onWorktree(path, async (m) => {
        const sha = await revParse(m, `refs/heads/${name}`)
        if (!sha) throw new NotFoundError('branch', name)
        const gitDir = await gitDirOf(path)
        if (await exists(join(gitDir, 'MERGE_HEAD'))) {
          throw new ConflictError('a merge is in progress: finish it (commit) or abort it before pushing')
        }
        const recorded = await recordedConflicts(gitDir)
        const left = await withMarkers(path, recorded, sha)
        if (left.length) throw new ConflictError(`conflict markers were committed in ${left.join(', ')}: fix them before pushing`)
        const url = (await git(['--git-dir', m, 'config', '--get', 'remote.origin.url'])).stdout.trim()
        if (!url || url.startsWith('-')) throw new ValidationError('mirror has no usable origin url')
        try {
          await withAuth(auth, (env) =>
            git(['push', '--porcelain', '--no-verify', '--', url, `refs/heads/${name}:refs/heads/${name}`], { cwd: path, env }),
          )
        } catch (e) {
          if (e instanceof GitError && /rejected|non-fast-forward|fetch first/.test(e.message + String(e.details?.stderr))) {
            throw new ConflictError(`push to ${name} rejected: ${e.message}`)
          }
          throw e
        }
        await git(['--git-dir', m, 'update-ref', `refs/remotes/origin/${name}`, sha])
        if (recorded.length) await rm(join(gitDir, CONFLICTS_FILE), { force: true })
        log.info('pushed', { mirror: m, branch: name, sha })
      })
    },

    diff(path, base) {
      return onWorktree(path, async (m) => {
        // Stage everything into a throwaway index, so new and deleted files show without touching the real one.
        const tmp = await mkdtemp(join(tmpdir(), 'mp-git-index-'))
        try {
          const index = join(tmp, 'index')
          const real = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: path })).stdout.trim()
          if (await exists(real)) await copyFile(real, index)
          const env = { GIT_INDEX_FILE: index }
          await git(['add', '-A'], { cwd: path, env })
          const args = base === undefined ? ['HEAD'] : ['--merge-base', await resolveRef(m, base)]
          return (await git(['diff', '--cached', '--no-color', '--no-ext-diff', ...args], { cwd: path, env })).stdout
        } finally {
          await rm(tmp, { recursive: true, force: true })
        }
      })
    },

    log(path, limit = 20) {
      return onWorktree(path, async () => {
        const n = Math.max(1, Math.floor(limit))
        const { stdout } = await git(['log', '-n', String(n), '--format=%H%x1f%s%x1f%an <%ae>%x1e'], { cwd: path })
        return stdout
          .split('\x1e')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [sha, subject, author] = l.split('\x1f') as [string, string, string]
            return { sha, subject, author }
          })
      })
    },

    status(path) {
      return onWorktree(path, async () => {
        const { files, conflicts } = await statusUnlocked(path)
        const merging = await isMerging(path)
        return { clean: files.length === 0 && !merging, files, merging, conflicts }
      })
    },

    divergence(path, o = {}) {
      return onWorktree(path, (m) => divergenceUnlocked(path, m, o.base))
    },

    async sync(path, o) {
      commitMessage('merge', o.author, o.trailers) // checks the author and trailers before anything runs
      return onWorktree(path, async (m) => {
        try {
          const gitDir = await gitDirOf(path)
          if (await exists(join(gitDir, 'MERGE_HEAD'))) {
            throw new ConflictError('a merge is already in progress: finish it (commit) or abort it')
          }
          const before = await statusUnlocked(path)
          if (before.files.length) {
            throw new ValidationError(
              `uncommitted changes (${before.files.slice(0, 20).join(', ')}${before.files.length > 20 ? ', …' : ''}): commit them first`,
            )
          }
          await fetchMirror(m, o.auth)
          const branch = await currentBranch(path)
          const steps: { from: string; sha: string }[] = []
          const own = branch ? await revParse(m, `refs/remotes/origin/${branch}`) : null
          if (own) steps.push({ from: `origin/${branch}`, sha: own })
          const b = await baseRef(m, o.base, branch)
          if (b)
            steps.push({ from: (await revParse(m, `refs/remotes/origin/${b.name}`)) ? `origin/${b.name}` : b.name, sha: b.sha })
          const merged: SyncResult['merged'] = []
          for (const step of steps) {
            const commits = Number((await git(['rev-list', '--count', `HEAD..${step.sha}`], { cwd: path })).stdout.trim())
            if (!commits) continue
            const ff = (await git(['merge-base', '--is-ancestor', 'HEAD', step.sha], { cwd: path, allowFail: true })).code === 0
            const message = commitMessage(`Merge ${step.from} into ${branch ?? 'HEAD'}`, o.author, o.trailers)
            const r = await git(
              [
                ...identityArgs(o.author),
                '-c',
                'rerere.enabled=false',
                'merge',
                '--no-stat',
                '--no-edit',
                '--no-verify',
                ff ? '--ff-only' : '--no-ff',
                '-m',
                message,
                step.sha,
              ],
              { cwd: path, env: identityEnv(o.author), allowFail: true },
            )
            if (r.code !== 0) {
              if (!(await exists(join(gitDir, 'MERGE_HEAD')))) {
                throw lockError(
                  new GitError(`git merge failed: ${(r.stderr || r.stdout).trim()}`, {
                    args: ['merge'],
                    exitCode: r.code,
                    stderr: r.stderr,
                  }),
                )
              }
              const files = (await statusUnlocked(path)).conflicts
              await writeFile(join(gitDir, CONFLICTS_FILE), JSON.stringify(files))
              log.info('sync stopped on conflicts', { mirror: m, path, from: step.from, files: files.length })
              const head = (await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()
              return {
                head,
                merged,
                conflict: { from: step.from, sha: step.sha, files },
                divergence: await divergenceUnlocked(path, m, o.base),
              }
            }
            merged.push({ from: step.from, sha: step.sha, commits, mode: ff ? 'fast-forward' : 'merge' })
          }
          const head = (await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()
          if (merged.length) log.info('synced', { mirror: m, path, head, merged: merged.length })
          const result: SyncResult = { head, merged, conflict: null, divergence: await divergenceUnlocked(path, m, o.base) }
          return result
        } catch (e) {
          throw lockError(e)
        }
      })
    },

    abortMerge(path) {
      return onWorktree(path, async () => {
        const gitDir = await gitDirOf(path)
        if (!(await exists(join(gitDir, 'MERGE_HEAD')))) return false
        try {
          await git(['merge', '--abort'], { cwd: path })
        } catch (e) {
          throw lockError(e)
        }
        await rm(join(gitDir, CONFLICTS_FILE), { force: true })
        return true
      })
    },
  }
  return cache
}
