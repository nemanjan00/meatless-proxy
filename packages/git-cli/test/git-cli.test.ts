import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConflictError, DeniedError, ManualClock, NotFoundError, ValidationError } from '@mp/core'
import { mirrorKey } from '@mp/git'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitError, gitCliCache } from '../src/index.ts'

// Keep the developer's and the system's git config, hooks and credential helpers out of the tests.
let base: string
let env: Record<string, string>
const run = (args: string[], cwd?: string) =>
  execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  }).trim()

const author = { name: 'Ana Bot', email: 'ana@example.com' }
const policy = { allow: ['mp/**'], protected: ['main', 'release/**'] }

let n = 0
/** A fresh bare "origin" with one commit on main, and a cache for it. */
function setup() {
  const dir = join(base, `case-${++n}`)
  const origin = join(dir, 'origin.git')
  const seed = join(dir, 'seed')
  run(['init', '--quiet', '--bare', '-b', 'main', origin])
  run(['init', '--quiet', '-b', 'main', seed])
  writeFileSync(join(seed, 'README.md'), '# billing\n')
  run(['add', '-A'], seed)
  run(['commit', '--quiet', '-m', 'initial'], seed)
  run(['remote', 'add', 'origin', origin], seed)
  run(['push', '--quiet', 'origin', 'main'], seed)
  const url = `file://${origin}`
  const clock = new ManualClock(Date.UTC(2026, 4, 1))
  const cache = gitCliCache({ root: join(dir, 'cache'), env, clock })
  /** Commits on origin's main from the seed clone, as someone else would. */
  const upstreamCommit = (file: string, content: string) => {
    writeFileSync(join(seed, file), content)
    run(['add', '-A'], seed)
    run(['commit', '--quiet', '-m', `upstream ${file}`], seed)
    run(['push', '--quiet', 'origin', 'main'], seed)
    return run(['rev-parse', 'HEAD'], seed)
  }
  const originRef = (ref: string) => {
    try {
      return run(['--git-dir', origin, 'rev-parse', '--verify', '--quiet', ref])
    } catch {
      return null
    }
  }
  return { dir, origin, seed, url, cache, clock, upstreamCommit, originRef, wt: (name: string) => join(dir, 'wt', name) }
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mp-git-cli-'))
  env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: base,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('mirrors', () => {
  it('lays mirrors out by url and clones them once', async () => {
    const t = setup()
    const path = t.cache.mirrorPath(t.url)
    expect(path).toBe(join(t.dir, 'cache', mirrorKey(t.url)))
    expect(await t.cache.ensureMirror(t.url)).toBe(path)
    expect(existsSync(join(path, 'HEAD'))).toBe(true)
    expect(run(['--git-dir', path, 'rev-parse', 'refs/remotes/origin/main'])).toBe(t.originRef('main'))
    expect(run(['--git-dir', path, 'config', 'remote.origin.url'])).toBe(t.url)
    expect(await t.cache.ensureMirror(t.url)).toBe(path)
  })

  it('fetch picks up new commits', async () => {
    const t = setup()
    await t.cache.ensureMirror(t.url)
    const sha = t.upstreamCommit('a.txt', 'a\n')
    await expect(t.cache.createWorktree(t.url, { path: t.wt('x'), ref: sha })).rejects.toBeInstanceOf(NotFoundError)
    await t.cache.fetch(t.url)
    const w = await t.cache.createWorktree(t.url, { path: t.wt('y'), ref: 'main' })
    expect(w.head).toBe(sha)
  })

  it('fails cleanly for a missing remote and leaves no half-made mirror', async () => {
    const t = setup()
    const url = `file://${join(t.dir, 'nope.git')}`
    await expect(t.cache.ensureMirror(url)).rejects.toBeInstanceOf(GitError)
    expect(existsSync(t.cache.mirrorPath(url))).toBe(false)
  })
})

describe('worktrees', () => {
  it('creates two worktrees from one mirror at the same commit on different branches', async () => {
    const t = setup()
    const a = await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/ana/a' })
    const b = await t.cache.createWorktree(t.url, { path: t.wt('b'), ref: 'main', newBranch: 'mp/ana/b' })
    expect(a.head).toBe(t.originRef('main'))
    expect(b.head).toBe(a.head)
    expect(a.branch).toBe('mp/ana/a')
    expect(run(['branch', '--show-current'], t.wt('a'))).toBe('mp/ana/a')
    expect(run(['branch', '--show-current'], t.wt('b'))).toBe('mp/ana/b')
    expect(readFileSync(join(t.wt('b'), 'README.md'), 'utf8')).toBe('# billing\n')
    // They share the mirror's object store rather than being clones.
    expect(run(['rev-parse', '--path-format=absolute', '--git-common-dir'], t.wt('a'))).toBe(t.cache.mirrorPath(t.url))
  })

  it('detaches without a new branch, and forks from a session branch', async () => {
    const t = setup()
    const d = await t.cache.createWorktree(t.url, { path: t.wt('d') })
    expect(d.branch).toBeNull()
    expect(run(['rev-parse', '--abbrev-ref', 'HEAD'], t.wt('d'))).toBe('HEAD')

    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    writeFileSync(join(t.wt('a'), 'new.txt'), 'x')
    const sha = await t.cache.commitAll(t.wt('a'), { message: 'work', author })
    const fork = await t.cache.createWorktree(t.url, { path: t.wt('fork'), ref: 'mp/a', newBranch: 'mp/a-fork' })
    expect(fork.head).toBe(sha)
  })

  it('rejects bad input and conflicts', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    await expect(t.cache.createWorktree(t.url, { path: t.wt('b'), newBranch: 'mp/a' })).rejects.toBeInstanceOf(ConflictError)
    await expect(t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/c' })).rejects.toBeInstanceOf(ConflictError)
    await expect(t.cache.createWorktree(t.url, { path: 'relative/x' })).rejects.toBeInstanceOf(ValidationError)
    await expect(t.cache.createWorktree(t.url, { path: t.wt('e'), newBranch: 'mp/x:main' })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(t.cache.createWorktree(t.url, { path: t.wt('f'), ref: '--upload-pack=evil' })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(t.cache.createWorktree(t.url, { path: t.wt('g'), ref: 'no-such-branch' })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('removeWorktree cleans up, idempotently', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    writeFileSync(join(t.wt('a'), 'dirty.txt'), 'uncommitted')
    await t.cache.removeWorktree(t.url, t.wt('a'))
    expect(existsSync(t.wt('a'))).toBe(false)
    expect(run(['--git-dir', t.cache.mirrorPath(t.url), 'worktree', 'list'])).not.toContain(t.wt('a'))
    await t.cache.removeWorktree(t.url, t.wt('a'))
    await expect(t.cache.status(t.wt('a'))).rejects.toBeInstanceOf(NotFoundError)
    // The branch survives, so a later worktree can pick the work up again.
    expect((await t.cache.createWorktree(t.url, { path: t.wt('again'), ref: 'mp/a' })).head).toBe(t.originRef('main'))
  })

  it('prunes worktrees whose directory vanished (after a crash)', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    rmSync(t.wt('a'), { recursive: true, force: true })
    await t.cache.removeWorktree(t.url, t.wt('a'))
    expect(run(['--git-dir', t.cache.mirrorPath(t.url), 'worktree', 'list'])).not.toContain(t.wt('a'))
  })

  it('keeps unpushed session branches across fetch --prune', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    writeFileSync(join(t.wt('a'), 'x.txt'), 'x')
    const sha = await t.cache.commitAll(t.wt('a'), { message: 'local only', author })
    t.upstreamCommit('u.txt', 'u')
    await t.cache.fetch(t.url)
    expect(run(['rev-parse', 'HEAD'], t.wt('a'))).toBe(sha)
    expect(run(['branch', '--show-current'], t.wt('a'))).toBe('mp/a')
  })
})

describe('commits, status, diff and log', () => {
  it('commitAll commits everything with author, date and trailers', async () => {
    const t = setup()
    const w = await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    writeFileSync(join(t.wt('a'), 'new.txt'), 'new\n')
    writeFileSync(join(t.wt('a'), 'README.md'), '# billing v2\n')
    expect(await t.cache.status(t.wt('a'))).toEqual({
      clean: false,
      files: ['README.md', 'new.txt'],
      merging: false,
      conflicts: [],
    })
    const sha = await t.cache.commitAll(t.wt('a'), {
      message: 'Fix the invoice total\n\nIt was off by one.',
      author,
      trailers: { 'Mp-Session': 'ses_01TEST', 'Co-authored-by': 'Someone <someone@example.com>' },
    })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(run(['log', '-1', '--format=%an|%ae|%cn|%ce|%at'], t.wt('a'))).toBe(
      `Ana Bot|ana@example.com|Ana Bot|ana@example.com|${Date.UTC(2026, 4, 1) / 1000}`,
    )
    expect(run(['log', '-1', '--format=%B'], t.wt('a'))).toBe(
      'Fix the invoice total\n\nIt was off by one.\n\nMp-Session: ses_01TEST\nCo-authored-by: Someone <someone@example.com>',
    )
    expect(run(['log', '-1', '--format=%(trailers:key=Mp-Session,valueonly)'], t.wt('a'))).toBe('ses_01TEST')
    expect(await t.cache.status(t.wt('a'))).toEqual({ clean: true, files: [], merging: false, conflicts: [] })
    expect(await t.cache.log(t.wt('a'))).toEqual([
      { sha, subject: 'Fix the invoice total', author: 'Ana Bot <ana@example.com>' },
      { sha: w.head, subject: 'initial', author: 'Seed <seed@example.com>' },
    ])
    expect(await t.cache.log(t.wt('a'), 1)).toHaveLength(1)
  })

  it('returns null when there is nothing to commit', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    expect(await t.cache.commitAll(t.wt('a'), { message: 'nothing', author })).toBeNull()
  })

  it('validates commit input', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    await expect(t.cache.commitAll(t.wt('a'), { message: '  ', author })).rejects.toBeInstanceOf(ValidationError)
    await expect(
      t.cache.commitAll(t.wt('a'), { message: 'm', author: { name: 'x\ny', email: 'e@example.com' } }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(t.cache.commitAll(t.wt('a'), { message: 'm', author, trailers: { 'Bad Key': 'v' } })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(
      t.cache.commitAll(t.wt('a'), { message: 'm', author, trailers: { Key: 'a\nInjected: yes' } }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(t.cache.commitAll(join(t.dir, 'nowhere'), { message: 'm', author })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('diffs against HEAD (including new and deleted files) and against a base', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    writeFileSync(join(t.wt('a'), 'added.txt'), 'hello\n')
    rmSync(join(t.wt('a'), 'README.md'))
    const d = await t.cache.diff(t.wt('a'))
    expect(d).toContain('diff --git a/added.txt b/added.txt')
    expect(d).toContain('+hello')
    expect(d).toContain('deleted file mode')
    // The real index is untouched: nothing got staged by diffing.
    expect(run(['diff', '--cached', '--name-only'], t.wt('a'))).toBe('')

    await t.cache.commitAll(t.wt('a'), { message: 'change', author })
    expect(await t.cache.diff(t.wt('a'))).toBe('')
    const vsMain = await t.cache.diff(t.wt('a'), 'main')
    expect(vsMain).toContain('added.txt')
    expect(vsMain).toContain('README.md')
    // Upstream moving on doesn't show up: the diff is against the merge base.
    t.upstreamCommit('other.txt', 'other')
    await t.cache.fetch(t.url)
    expect(await t.cache.diff(t.wt('a'), 'main')).not.toContain('other.txt')
  })

  it('reports renames once', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    run(['mv', 'README.md', 'README2.md'], t.wt('a'))
    expect(await t.cache.status(t.wt('a'))).toEqual({ clean: false, files: ['README2.md'], merging: false, conflicts: [] })
  })
})

describe('push', () => {
  it('pushes an allowed branch to the original remote and updates the mirror', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/ana/fix' })
    writeFileSync(join(t.wt('a'), 'fix.txt'), 'fix')
    const sha = await t.cache.commitAll(t.wt('a'), { message: 'fix', author })
    await t.cache.push(t.wt('a'), 'mp/ana/fix', policy)
    expect(t.originRef('refs/heads/mp/ana/fix')).toBe(sha)
    expect(run(['--git-dir', t.cache.mirrorPath(t.url), 'rev-parse', 'refs/remotes/origin/mp/ana/fix'])).toBe(sha)
    // Pushing again is a no-op; pushing more commits fast-forwards.
    await t.cache.push(t.wt('a'), 'refs/heads/mp/ana/fix', policy)
    writeFileSync(join(t.wt('a'), 'fix2.txt'), 'fix2')
    const sha2 = await t.cache.commitAll(t.wt('a'), { message: 'fix 2', author })
    await t.cache.push(t.wt('a'), 'mp/ana/fix', policy)
    expect(t.originRef('refs/heads/mp/ana/fix')).toBe(sha2)
  })

  it('never pushes to protected or disallowed branches', async () => {
    const t = setup()
    const main = t.originRef('refs/heads/main')
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    writeFileSync(join(t.wt('a'), 'evil.txt'), 'evil')
    await t.cache.commitAll(t.wt('a'), { message: 'evil', author })
    for (const branch of ['main', 'refs/heads/main', 'release/1.0', 'feature/x', 'mp/a:main', 'mp/a:refs/heads/main', '+mp/a']) {
      await expect(t.cache.push(t.wt('a'), branch, policy)).rejects.toBeInstanceOf(DeniedError)
    }
    // A protected pattern wins over an allow-everything policy.
    await expect(t.cache.push(t.wt('a'), 'main', { allow: ['**'], protected: ['main'] })).rejects.toBeInstanceOf(DeniedError)
    // Denied before git is asked anything, even for a path that isn't a worktree.
    await expect(t.cache.push(join(t.dir, 'nowhere'), 'main', policy)).rejects.toBeInstanceOf(DeniedError)
    expect(t.originRef('refs/heads/main')).toBe(main)
    expect(run(['--git-dir', t.origin, 'for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main')
  })

  it('fails for an unknown branch and for non-fast-forward pushes', async () => {
    const t = setup()
    await t.cache.createWorktree(t.url, { path: t.wt('a'), newBranch: 'mp/a' })
    await expect(t.cache.push(t.wt('a'), 'mp/missing', policy)).rejects.toBeInstanceOf(NotFoundError)

    writeFileSync(join(t.wt('a'), 'a.txt'), 'a')
    await t.cache.commitAll(t.wt('a'), { message: 'a', author })
    await t.cache.push(t.wt('a'), 'mp/a', policy)
    // Someone else rewrites the branch on origin.
    run(['fetch', '--quiet', 'origin', 'mp/a'], t.seed)
    run(['checkout', '--quiet', '-b', 'mp/a', 'origin/main'], t.seed)
    writeFileSync(join(t.seed, 'other.txt'), 'other')
    run(['add', '-A'], t.seed)
    run(['commit', '--quiet', '-m', 'other'], t.seed)
    run(['push', '--quiet', '--force', 'origin', 'mp/a'], t.seed)
    writeFileSync(join(t.wt('a'), 'b.txt'), 'b')
    await t.cache.commitAll(t.wt('a'), { message: 'b', author })
    await expect(t.cache.push(t.wt('a'), 'mp/a', policy)).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('concurrency', () => {
  it('runs many operations on one mirror at once without corrupting it', async () => {
    const t = setup()
    await t.cache.ensureMirror(t.url)
    const names = Array.from({ length: 6 }, (_, i) => `w${i}`)
    const shas = await Promise.all(
      names.map(async (name) => {
        await t.cache.createWorktree(t.url, { path: t.wt(name), newBranch: `mp/${name}` })
        writeFileSync(join(t.wt(name), `${name}.txt`), name)
        const [sha] = await Promise.all([
          t.cache.commitAll(t.wt(name), { message: `commit ${name}`, author }),
          t.cache.fetch(t.url),
          t.cache.status(t.wt(name)),
        ])
        await t.cache.push(t.wt(name), `mp/${name}`, policy)
        return sha
      }),
    )
    names.forEach((name, i) => {
      expect(t.originRef(`refs/heads/mp/${name}`)).toBe(shas[i])
    })
    expect(run(['--git-dir', t.cache.mirrorPath(t.url), 'fsck', '--no-progress'])).toBe('')
    await Promise.all(names.map((name) => t.cache.removeWorktree(t.url, t.wt(name))))
    expect(run(['--git-dir', t.cache.mirrorPath(t.url), 'worktree', 'list']).split('\n')).toHaveLength(1)
  })

  it('clones a mirror only once under concurrent first use', async () => {
    const t = setup()
    const paths = await Promise.all([t.cache.ensureMirror(t.url), t.cache.ensureMirror(t.url), t.cache.fetch(t.url)])
    expect(paths[0]).toBe(paths[1])
  })
})
