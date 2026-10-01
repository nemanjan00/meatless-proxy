import { createHash } from 'node:crypto'
import { ConflictError, NotFoundError, ValidationError } from '@mp/core'
import {
  assertPushAllowed,
  commitPaths,
  hasConflictMarkers,
  isValidBranchName,
  mirrorKey,
  type Author,
  type Divergence,
  type GitAuth,
  type GitCache,
  type PushPolicy,
  type SyncResult,
  type WorktreeInfo,
} from './types.ts'

export interface FakeCommit {
  sha: string
  parent: string | null
  /** The merged commit, for a merge commit. */
  secondParent?: string
  message: string
  author: Author
  trailers: Record<string, string>
  /** Files changed by this commit: path -> content, or null for a deletion. */
  changes: Record<string, string | null>
}

/** A repository's refs and commits (the "remote", or the mirror's copy of it). */
export interface FakeRepo {
  defaultBranch: string
  branches: Map<string, string>
  commits: Map<string, FakeCommit>
}

export interface FakeWorktree {
  url: string
  path: string
  branch: string | null
  head: string
  /** Uncommitted changes: path -> content, or null for a deletion. */
  dirty: Map<string, string | null>
  /** A merge stopped on conflicts (`sync`): what it merges, and the conflicted files. */
  merging: { from: string; sha: string; conflicts: string[] } | null
}

export interface FakeGitCall {
  method: string
  args: unknown[]
}

export interface FakeGitCache extends GitCache {
  readonly calls: FakeGitCall[]
  /** The auth every remote-facing call got (`ensureMirror`, `fetch`, `createWorktree`, `push`), in order. */
  readonly auths: { method: string; target: string; auth: GitAuth | undefined }[]
  /** Every successful push, in order. */
  readonly pushes: { url: string; branch: string; sha: string }[]
  /** The upstream repository for `url` (created on first use with one commit on `main`). */
  remote(url: string): FakeRepo
  /** Adds a commit upstream, as if someone else pushed. Visible in the mirror after `fetch`. */
  addRemoteCommit(url: string, branch: string, message: string, changes?: Record<string, string | null>): string
  /** Simulates editing a file in a worktree (null deletes it). */
  writeFile(path: string, file: string, content: string | null): void
  worktree(path: string): FakeWorktree | undefined
  worktrees(): FakeWorktree[]
}

export interface FakeGitOptions {
  /** Root that `mirrorPath` reports. Nothing is written there. Default `/fake-git`. */
  root?: string
  /** The time `lastFetch` reports (epoch ms). Default `Date.now`. */
  now?: () => number
}

const cloneRepo = (r: FakeRepo): FakeRepo => ({
  defaultBranch: r.defaultBranch,
  branches: new Map(r.branches),
  commits: new Map(r.commits),
})

/** An in-memory `GitCache` for tests of other packages. Nothing touches disk or runs git. */
export function fakeGitCache(opts: FakeGitOptions = {}): FakeGitCache {
  const root = (opts.root ?? '/fake-git').replace(/\/+$/, '')
  const remotes = new Map<string, FakeRepo>()
  const mirrors = new Map<string, FakeRepo>()
  const worktrees = new Map<string, FakeWorktree>()
  const calls: FakeGitCall[] = []
  const auths: FakeGitCache['auths'] = []
  const pushes: { url: string; branch: string; sha: string }[] = []
  /** The remote's branches as of the last fetch (git's `refs/remotes/origin/*`), per url. */
  const tracking = new Map<string, Map<string, string>>()
  const fetchedAt = new Map<string, number>()
  /** When each commit was made, to apply changes in order. */
  const order = new Map<string, number>()
  const now = opts.now ?? Date.now
  let seq = 0

  const newSha = (seed: string) => {
    const sha = createHash('sha1').update(`${++seq}\0${seed}`).digest('hex')
    order.set(sha, seq)
    return sha
  }

  /** Copies the remote's commits and branches into the mirror (a clone or a fetch). */
  const track = (url: string) => {
    tracking.set(url, new Map(remote(url).branches))
    fetchedAt.set(url, now())
  }
  const ensure = (url: string) => {
    if (!mirrors.has(url)) {
      mirrors.set(url, cloneRepo(remote(url)))
      track(url)
    }
  }

  const remote = (url: string): FakeRepo => {
    mirrorKey(url) // validates
    let r = remotes.get(url)
    if (!r) {
      const sha = newSha(`init ${url}`)
      r = {
        defaultBranch: 'main',
        branches: new Map([['main', sha]]),
        commits: new Map([
          [
            sha,
            {
              sha,
              parent: null,
              message: 'initial commit',
              author: { name: 'Origin', email: 'origin@example.com' },
              trailers: {},
              changes: {},
            },
          ],
        ]),
      }
      remotes.set(url, r)
    }
    return r
  }

  const mirror = (url: string): FakeRepo => {
    const m = mirrors.get(url)
    if (!m) throw new NotFoundError('mirror', url)
    return m
  }

  const wt = (path: string): FakeWorktree => {
    const w = worktrees.get(path)
    if (!w) throw new NotFoundError('worktree', path)
    return w
  }

  const record = (method: string, ...args: unknown[]) => void calls.push({ method, args: structuredClone(args) })
  const recordAuth = (method: string, target: string, auth: GitAuth | undefined) =>
    void auths.push({ method, target, auth: auth ? { ...auth } : undefined })

  const resolve = (repo: FakeRepo, ref: string): string => {
    const sha =
      repo.branches.get(ref) ??
      (repo.commits.has(ref) ? ref : [...repo.commits.keys()].find((s) => ref.length >= 7 && s.startsWith(ref)))
    if (!sha) throw new NotFoundError('ref', ref)
    return sha
  }

  /** Every commit reachable from `head` (itself included). */
  const ancestors = (repo: FakeRepo, head: string): Set<string> => {
    const seen = new Set<string>()
    const todo = [head]
    while (todo.length) {
      const sha = todo.pop()!
      if (seen.has(sha)) continue
      const c = repo.commits.get(sha)
      if (!c) continue
      seen.add(sha)
      if (c.parent) todo.push(c.parent)
      if (c.secondParent) todo.push(c.secondParent)
    }
    return seen
  }
  const byOrder = (shas: Iterable<string>) => [...shas].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  /** Commits reachable from `head`, newest first. */
  const history = (repo: FakeRepo, head: string): FakeCommit[] =>
    byOrder(ancestors(repo, head))
      .reverse()
      .map((s) => repo.commits.get(s)!)
  /** Commits reachable from `to` but not from `from`, oldest first. */
  const between = (repo: FakeRepo, from: string, to: string): FakeCommit[] => {
    const stop = ancestors(repo, from)
    return byOrder([...ancestors(repo, to)].filter((s) => !stop.has(s))).map((s) => repo.commits.get(s)!)
  }
  /** Files changed by commits reachable from `to` but not from `from`, with their content at the last of them. */
  const changesBetween = (repo: FakeRepo, from: string, to: string): Map<string, string | null> => {
    const out = new Map<string, string | null>()
    for (const c of between(repo, from, to)) for (const [f, v] of Object.entries(c.changes)) out.set(f, v)
    return out
  }
  /** A file's content at a commit (null: deleted or never there). */
  const fileAt = (repo: FakeRepo, sha: string, file: string): string | null => {
    let v: string | null = null
    for (const s of byOrder(ancestors(repo, sha))) {
      const ch = repo.commits.get(s)!.changes
      if (file in ch) v = ch[file]!
    }
    return v
  }
  /** The newest commit both reach (git's merge base, near enough); `a` itself when nothing is shared. */
  const forkPoint = (repo: FakeRepo, a: string, b: string): string => {
    const other = ancestors(repo, b)
    return byOrder([...ancestors(repo, a)].filter((s) => other.has(s))).at(-1) ?? a
  }
  const setHead = (w: FakeWorktree, sha: string) => {
    w.head = sha
    if (w.branch) mirror(w.url).branches.set(w.branch, sha)
  }
  /** The base a worktree is compared with: the remote's branch as of the last fetch, else a local branch. */
  const baseSha = (w: FakeWorktree, base: string | undefined): { ref: string; sha: string } | null => {
    const m = mirror(w.url)
    const ref = base ?? m.defaultBranch
    const sha = tracking.get(w.url)?.get(ref) ?? (ref !== w.branch ? m.branches.get(ref) : undefined)
    return sha ? { ref, sha } : null
  }
  const divergenceOf = (w: FakeWorktree, base: string | undefined): Divergence => {
    const m = mirror(w.url)
    const cmp = (ref: string, sha: string) => ({
      ref,
      ahead: between(m, sha, w.head).length,
      behind: between(m, w.head, sha).length,
    })
    const b = baseSha(w, base)
    const own = w.branch ? tracking.get(w.url)?.get(w.branch) : undefined
    return { base: b ? cmp(b.ref, b.sha) : null, remote: own && w.branch ? cmp(w.branch, own) : null }
  }
  const commit = (
    w: FakeWorktree,
    message: string,
    o: { author: Author; trailers?: Record<string, string> },
    changes: Record<string, string | null>,
    secondParent?: string,
  ) => {
    const m = mirror(w.url)
    const sha = newSha(message)
    m.commits.set(sha, {
      sha,
      parent: w.head,
      ...(secondParent ? { secondParent } : {}),
      message,
      author: { ...o.author },
      trailers: { ...o.trailers },
      changes,
    })
    setHead(w, sha)
    return sha
  }

  const cache: FakeGitCache = {
    calls,
    auths,
    pushes,
    remote,

    mirrorPath(url) {
      return `${root}/${mirrorKey(url)}`
    },

    async ensureMirror(url, auth) {
      record('ensureMirror', url)
      recordAuth('ensureMirror', url, auth)
      ensure(url)
      return cache.mirrorPath(url)
    },

    async fetch(url, auth) {
      record('fetch', url)
      recordAuth('fetch', url, auth)
      ensure(url)
      const m = mirror(url)
      const r = remote(url)
      for (const [sha, c] of r.commits) m.commits.set(sha, c)
      // Remote branches overwrite the mirror's, except branches checked out in a worktree.
      const checkedOut = new Set([...worktrees.values()].filter((w) => w.url === url).map((w) => w.branch))
      for (const [b, sha] of r.branches) if (!checkedOut.has(b)) m.branches.set(b, sha)
      track(url)
    },

    async lastFetch(url) {
      return fetchedAt.get(url) ?? null
    },

    async createWorktree(url, o) {
      const { auth, ...rest } = o
      record('createWorktree', url, rest)
      recordAuth('createWorktree', url, auth)
      ensure(url)
      const m = mirror(url)
      if (worktrees.has(o.path)) throw new ConflictError(`worktree ${o.path} already exists`)
      const head = resolve(m, o.ref ?? m.defaultBranch)
      if (o.newBranch !== undefined) {
        if (!isValidBranchName(o.newBranch)) throw new ValidationError(`not a valid branch name: ${o.newBranch}`)
        if (m.branches.has(o.newBranch)) throw new ConflictError(`branch ${o.newBranch} already exists`)
        m.branches.set(o.newBranch, head)
      }
      const w: FakeWorktree = { url, path: o.path, branch: o.newBranch ?? null, head, dirty: new Map(), merging: null }
      worktrees.set(o.path, w)
      const info: WorktreeInfo = { path: o.path, branch: w.branch, head }
      return info
    },

    async removeWorktree(url, path) {
      record('removeWorktree', url, path)
      const w = worktrees.get(path)
      if (w && w.url !== url) throw new ValidationError(`worktree ${path} belongs to another repository`)
      worktrees.delete(path)
    },

    async commitAll(path, o) {
      record('commitAll', path, o)
      const w = wt(path)
      if (!o.message.trim()) throw new ValidationError('commit message is empty')
      if (w.merging) {
        if (o.paths) throw new ValidationError('a merge is in progress: commit everything (without paths) to finish it')
        const left = w.merging.conflicts.filter((f) => {
          const v = w.dirty.get(f)
          return typeof v === 'string' && hasConflictMarkers(v)
        })
        if (left.length) throw new ValidationError(`conflict markers remain in ${left.join(', ')}`)
        const sha = commit(w, o.message, o, Object.fromEntries(w.dirty), w.merging.sha)
        w.merging = null
        w.dirty.clear()
        return sha
      }
      if (o.paths) {
        const picked = new Map<string, string | null>()
        for (const p of commitPaths(o.paths)) {
          const hits = [...w.dirty].filter(([f]) => p === '.' || f === p || f.startsWith(`${p}/`))
          if (!hits.length) throw new ValidationError(`no changes in ${p}`)
          for (const [f, v] of hits) picked.set(f, v)
        }
        const sha = commit(w, o.message, o, Object.fromEntries(picked))
        for (const f of picked.keys()) w.dirty.delete(f)
        return sha
      }
      if (!w.dirty.size) return null
      const sha = commit(w, o.message, o, Object.fromEntries(w.dirty))
      w.dirty.clear()
      return sha
    },

    async push(path, branch, policy: PushPolicy, auth) {
      record('push', path, branch, policy)
      recordAuth('push', path, auth)
      assertPushAllowed(branch, policy)
      const w = wt(path)
      if (w.merging) throw new ConflictError('a merge is in progress: finish it (commit) or abort it before pushing')
      const name = branch.replace(/^refs\/heads\//, '')
      const m = mirror(w.url)
      const sha = m.branches.get(name)
      if (!sha) throw new NotFoundError('branch', name)
      const r = remote(w.url)
      const current = r.branches.get(name)
      if (current && current !== sha && !ancestors(m, sha).has(current)) {
        throw new ConflictError(`push to ${name} rejected: not a fast-forward`)
      }
      for (const c of history(m, sha)) r.commits.set(c.sha, c)
      r.branches.set(name, sha)
      tracking.get(w.url)?.set(name, sha)
      pushes.push({ url: w.url, branch: name, sha })
    },

    async diff(path, base) {
      record('diff', path, base)
      const w = wt(path)
      const m = mirror(w.url)
      const changes = new Map<string, string | null>()
      if (base !== undefined) {
        // Like `git diff --merge-base`: the files that differ between the fork point and HEAD.
        const fork = forkPoint(m, resolve(m, base), w.head)
        for (const [f, v] of changesBetween(m, fork, w.head)) if (fileAt(m, fork, f) !== v) changes.set(f, v)
      }
      for (const [f, v] of w.dirty) changes.set(f, v)
      return [...changes]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([f, v]) => `diff --git a/${f} b/${f}\n${v === null ? 'deleted' : `+${v}`}\n`)
        .join('')
    },

    async log(path, limit = 20) {
      record('log', path, limit)
      const w = wt(path)
      return history(mirror(w.url), w.head)
        .slice(0, limit)
        .map((c) => ({ sha: c.sha, subject: c.message.split('\n')[0]!, author: `${c.author.name} <${c.author.email}>` }))
    },

    async status(path) {
      record('status', path)
      const w = wt(path)
      return {
        clean: w.dirty.size === 0 && !w.merging,
        files: [...w.dirty.keys()].sort(),
        merging: !!w.merging,
        conflicts: [...(w.merging?.conflicts ?? [])].sort(),
      }
    },

    async divergence(path, o = {}) {
      record('divergence', path, o)
      return divergenceOf(wt(path), o.base)
    },

    async sync(path, o) {
      const { auth, ...rest } = o
      record('sync', path, rest)
      const w = wt(path)
      if (w.merging) throw new ConflictError('a merge is already in progress: finish it (commit) or abort it')
      if (w.dirty.size)
        throw new ValidationError(`uncommitted changes (${[...w.dirty.keys()].sort().join(', ')}): commit them first`)
      await cache.fetch(w.url, auth)
      const m = mirror(w.url)
      const merged: SyncResult['merged'] = []
      const own = w.branch ? tracking.get(w.url)?.get(w.branch) : undefined
      const b = baseSha(w, o.base)
      const steps: [string, string][] = []
      if (own && w.branch) steps.push([`origin/${w.branch}`, own])
      if (b) steps.push([`origin/${b.ref}`, b.sha])
      for (const [from, sha] of steps) {
        const commits = between(m, w.head, sha).length
        if (!commits) continue
        if (ancestors(m, sha).has(w.head)) {
          setHead(w, sha)
          merged.push({ from, sha, commits, mode: 'fast-forward' })
          continue
        }
        const fork = forkPoint(m, w.head, sha)
        const ours = changesBetween(m, fork, w.head)
        const theirs = changesBetween(m, fork, sha)
        const conflicts = [...theirs.keys()].filter((f) => ours.has(f) && ours.get(f) !== theirs.get(f)).sort()
        if (conflicts.length) {
          for (const [f, v] of theirs) w.dirty.set(f, v)
          for (const f of conflicts) {
            w.dirty.set(f, `<<<<<<< HEAD\n${fileAt(m, w.head, f) ?? ''}\n=======\n${theirs.get(f) ?? ''}\n>>>>>>> ${from}\n`)
          }
          w.merging = { from, sha, conflicts }
          return { head: w.head, merged, conflict: { from, sha, files: conflicts }, divergence: divergenceOf(w, o.base) }
        }
        commit(w, `Merge ${from} into ${w.branch ?? 'HEAD'}`, o, Object.fromEntries(theirs), sha)
        merged.push({ from, sha, commits, mode: 'merge' })
      }
      return { head: w.head, merged, conflict: null, divergence: divergenceOf(w, o.base) }
    },

    async abortMerge(path) {
      record('abortMerge', path)
      const w = wt(path)
      if (!w.merging) return false
      w.merging = null
      w.dirty.clear()
      return true
    },

    addRemoteCommit(url, branch, message, changes = {}) {
      const r = remote(url)
      const sha = newSha(message)
      r.commits.set(sha, {
        sha,
        parent: r.branches.get(branch) ?? r.branches.get(r.defaultBranch) ?? null,
        message,
        author: { name: 'Someone', email: 'someone@example.com' },
        trailers: {},
        changes,
      })
      r.branches.set(branch, sha)
      return sha
    },

    writeFile(path, file, content) {
      wt(path).dirty.set(file, content)
    },

    worktree: (path) => worktrees.get(path),
    worktrees: () => [...worktrees.values()],
  }
  return cache
}
