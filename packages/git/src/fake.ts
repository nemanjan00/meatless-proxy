import { createHash } from 'node:crypto'
import { ConflictError, NotFoundError, ValidationError } from '@mp/core'
import {
  assertPushAllowed,
  isValidBranchName,
  mirrorKey,
  type Author,
  type GitCache,
  type PushPolicy,
  type WorktreeInfo,
} from './types.ts'

export interface FakeCommit {
  sha: string
  parent: string | null
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
}

export interface FakeGitCall {
  method: string
  args: unknown[]
}

export interface FakeGitCache extends GitCache {
  readonly calls: FakeGitCall[]
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
  const pushes: { url: string; branch: string; sha: string }[] = []
  let seq = 0

  const newSha = (seed: string) => createHash('sha1').update(`${++seq}\0${seed}`).digest('hex')

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

  const resolve = (repo: FakeRepo, ref: string): string => {
    const sha =
      repo.branches.get(ref) ??
      (repo.commits.has(ref) ? ref : [...repo.commits.keys()].find((s) => ref.length >= 7 && s.startsWith(ref)))
    if (!sha) throw new NotFoundError('ref', ref)
    return sha
  }

  const history = (repo: FakeRepo, head: string): FakeCommit[] => {
    const out: FakeCommit[] = []
    for (let c = repo.commits.get(head); c; c = c.parent ? repo.commits.get(c.parent) : undefined) out.push(c)
    return out
  }

  const cache: FakeGitCache = {
    calls,
    pushes,
    remote,

    mirrorPath(url) {
      return `${root}/${mirrorKey(url)}`
    },

    async ensureMirror(url) {
      record('ensureMirror', url)
      if (!mirrors.has(url)) mirrors.set(url, cloneRepo(remote(url)))
      return cache.mirrorPath(url)
    },

    async fetch(url) {
      record('fetch', url)
      await cache.ensureMirror(url)
      const m = mirror(url)
      const r = remote(url)
      for (const [sha, c] of r.commits) m.commits.set(sha, c)
      // Remote branches overwrite the mirror's, except branches checked out in a worktree.
      const checkedOut = new Set([...worktrees.values()].filter((w) => w.url === url).map((w) => w.branch))
      for (const [b, sha] of r.branches) if (!checkedOut.has(b)) m.branches.set(b, sha)
    },

    async createWorktree(url, o) {
      record('createWorktree', url, o)
      await cache.ensureMirror(url)
      const m = mirror(url)
      if (worktrees.has(o.path)) throw new ConflictError(`worktree ${o.path} already exists`)
      const head = resolve(m, o.ref ?? m.defaultBranch)
      if (o.newBranch !== undefined) {
        if (!isValidBranchName(o.newBranch)) throw new ValidationError(`not a valid branch name: ${o.newBranch}`)
        if (m.branches.has(o.newBranch)) throw new ConflictError(`branch ${o.newBranch} already exists`)
        m.branches.set(o.newBranch, head)
      }
      const w: FakeWorktree = { url, path: o.path, branch: o.newBranch ?? null, head, dirty: new Map() }
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
      if (!w.dirty.size) return null
      const m = mirror(w.url)
      const sha = newSha(o.message)
      m.commits.set(sha, {
        sha,
        parent: w.head,
        message: o.message,
        author: { ...o.author },
        trailers: { ...o.trailers },
        changes: Object.fromEntries(w.dirty),
      })
      w.head = sha
      w.dirty.clear()
      if (w.branch) m.branches.set(w.branch, sha)
      return sha
    },

    async push(path, branch, policy: PushPolicy) {
      record('push', path, branch, policy)
      assertPushAllowed(branch, policy)
      const w = wt(path)
      const name = branch.replace(/^refs\/heads\//, '')
      const m = mirror(w.url)
      const sha = m.branches.get(name)
      if (!sha) throw new NotFoundError('branch', name)
      const r = remote(w.url)
      const current = r.branches.get(name)
      if (current && current !== sha && !history(m, sha).some((c) => c.sha === current)) {
        throw new ConflictError(`push to ${name} rejected: not a fast-forward`)
      }
      for (const c of history(m, sha)) r.commits.set(c.sha, c)
      r.branches.set(name, sha)
      pushes.push({ url: w.url, branch: name, sha })
    },

    async diff(path, base) {
      record('diff', path, base)
      const w = wt(path)
      const m = mirror(w.url)
      const changes = new Map<string, string | null>()
      if (base !== undefined) {
        const stop = resolve(m, base)
        const commits = history(m, w.head)
        const until = commits.findIndex((c) => c.sha === stop)
        for (const c of (until < 0 ? commits : commits.slice(0, until)).reverse()) {
          for (const [f, v] of Object.entries(c.changes)) changes.set(f, v)
        }
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
      return { clean: w.dirty.size === 0, files: [...w.dirty.keys()].sort() }
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
