import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConflictError, DeniedError, ManualClock, ValidationError } from '@mp/core'
import { localRepoUrl } from '@mp/git'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitCliCache, gitCliLocalRepos } from '../src/index.ts'

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
const trailers = { Session: 'ses_test1', 'Requested-by': 'con_bo' }
const policy = { allow: ['mp/**'], protected: ['main', 'release/**'] }
const BRANCH = 'mp/ana/fix-login'

let n = 0
/** A bare "origin" with one commit on main, a cache, and a checkout on BRANCH with one commit of its own. */
async function setup(opts: { ownCommit?: boolean } = {}) {
  const dir = join(base, `case-${++n}`)
  const origin = join(dir, 'origin.git')
  const seed = join(dir, 'seed')
  run(['init', '--quiet', '--bare', '-b', 'main', origin])
  run(['init', '--quiet', '-b', 'main', seed])
  writeFileSync(join(seed, 'README.md'), '# billing\n\nline one\n')
  run(['add', '-A'], seed)
  run(['commit', '--quiet', '-m', 'initial'], seed)
  run(['remote', 'add', 'origin', origin], seed)
  run(['push', '--quiet', 'origin', 'main'], seed)
  const url = `file://${origin}`
  const clock = new ManualClock(Date.UTC(2026, 4, 1))
  const cache = gitCliCache({ root: join(dir, 'cache'), env, clock })
  /** Commits on one of origin's branches from the seed clone, as someone else would. */
  const upstreamCommit = (file: string, content: string, branch = 'main') => {
    run(['fetch', '--quiet', 'origin'], seed)
    const known = run(['branch', '-r', '--list', `origin/${branch}`], seed)
    run(['checkout', '--quiet', '-B', branch, known ? `origin/${branch}` : 'origin/main'], seed)
    writeFileSync(join(seed, file), content)
    run(['add', '-A'], seed)
    run(['commit', '--quiet', '-m', `upstream ${file}`], seed)
    run(['push', '--quiet', 'origin', branch], seed)
    return run(['rev-parse', 'HEAD'], seed)
  }
  const path = join(dir, 'wt', 'one')
  const info = await cache.createWorktree(url, { path, newBranch: BRANCH })
  if (opts.ownCommit !== false) {
    writeFileSync(join(path, 'own.txt'), 'mine\n')
    await cache.commitAll(path, { message: 'own work', author })
  }
  const parents = (rev = 'HEAD') => run(['rev-list', '--parents', '-n', '1', rev], path).split(' ').slice(1)
  return { dir, origin, seed, url, cache, clock, upstreamCommit, path, info, parents }
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mp-git-sync-'))
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

describe('sync', () => {
  it('merges new commits from the base as a merge commit by the employee, with trailers, and stays pushable', async () => {
    const t = await setup()
    const own = run(['rev-parse', 'HEAD'], t.path)
    const up = t.upstreamCommit('b.txt', 'theirs\n')
    // Before a fetch nothing is known; after it the checkout is behind.
    expect((await t.cache.divergence(t.path)).base).toEqual({ ref: 'main', ahead: 1, behind: 0 })
    await t.cache.fetch(t.url)
    expect(await t.cache.divergence(t.path)).toEqual({ base: { ref: 'main', ahead: 1, behind: 1 }, remote: null })

    const r = await t.cache.sync(t.path, { author, trailers })
    expect(r.merged).toMatchObject([{ from: 'origin/main', commits: 1, mode: 'merge' }])
    expect(r.conflict).toBeNull()
    expect(r.head).toBe(run(['rev-parse', 'HEAD'], t.path))
    expect(t.parents()).toEqual([own, up])
    expect(run(['log', '-1', '--format=%an <%ae>|%cn', 'HEAD'], t.path)).toBe('Ana Bot <ana@example.com>|Ana Bot')
    const msg = run(['log', '-1', '--format=%B', 'HEAD'], t.path)
    expect(msg).toContain(`Merge origin/main into ${BRANCH}`)
    expect(msg).toContain('Session: ses_test1')
    expect(msg).toContain('Requested-by: con_bo')
    expect(readFileSync(join(t.path, 'b.txt'), 'utf8')).toBe('theirs\n')
    expect(r.divergence.base).toEqual({ ref: 'main', ahead: 2, behind: 0 })

    // A plain push works (nothing was rewritten), and main itself is untouched.
    await t.cache.push(t.path, BRANCH, policy)
    expect(run(['--git-dir', t.origin, 'rev-parse', BRANCH])).toBe(r.head)
    expect(run(['--git-dir', t.origin, 'rev-parse', 'main'])).toBe(up)
    // Nothing more to merge.
    expect((await t.cache.sync(t.path, { author })).merged).toEqual([])
  })

  it('fast-forwards when the branch has no commits of its own', async () => {
    const t = await setup({ ownCommit: false })
    const up = t.upstreamCommit('b.txt', 'b\n')
    const r = await t.cache.sync(t.path, { author })
    expect(r.merged).toMatchObject([{ from: 'origin/main', commits: 1, mode: 'fast-forward' }])
    expect(r.head).toBe(up)
    expect(r.divergence.base).toEqual({ ref: 'main', ahead: 0, behind: 0 })
  })

  it('brings in its own remote branch first (fast-forward), then the base', async () => {
    const t = await setup()
    await t.cache.push(t.path, BRANCH, policy)
    // Someone else (another run, a colleague) pushed to the branch, and main moved too.
    const onBranch = t.upstreamCommit('pushed.txt', 'p\n', BRANCH)
    const onMain = t.upstreamCommit('main.txt', 'm\n')
    await t.cache.fetch(t.url)
    expect(await t.cache.divergence(t.path)).toEqual({
      base: { ref: 'main', ahead: 1, behind: 1 },
      remote: { ref: BRANCH, ahead: 0, behind: 1 },
    })
    const r = await t.cache.sync(t.path, { author })
    expect(r.merged).toMatchObject([
      { from: `origin/${BRANCH}`, commits: 1, mode: 'fast-forward' },
      { from: 'origin/main', commits: 1, mode: 'merge' },
    ])
    expect(t.parents()).toEqual([onBranch, onMain])
    expect(r.divergence).toEqual({ base: { ref: 'main', ahead: 3, behind: 0 }, remote: { ref: BRANCH, ahead: 2, behind: 0 } })
    await t.cache.push(t.path, BRANCH, policy)
  })

  it('merges from the base the checkout was made from', async () => {
    const t = await setup()
    t.upstreamCommit('dev.txt', 'd\n', 'develop')
    t.upstreamCommit('main.txt', 'm\n')
    const r = await t.cache.sync(t.path, { author, base: 'develop' })
    expect(r.merged).toMatchObject([{ from: 'origin/develop', commits: 1, mode: 'merge' }])
    // A commit is not a branch: nothing moves there.
    const pinned = await t.cache.sync(t.path, { author, base: t.info.head })
    expect(pinned.merged).toEqual([])
    expect(pinned.divergence.base).toBeNull()
  })

  it('leaves a conflict in progress; commit finishes it with both parents; push waits for it', async () => {
    const t = await setup()
    writeFileSync(join(t.path, 'README.md'), '# billing\n\nline one, ours\n')
    const own = await t.cache.commitAll(t.path, { message: 'ours', author })
    const up = t.upstreamCommit('README.md', '# billing\n\nline one, theirs\n')
    t.upstreamCommit('clean.txt', 'c\n')

    const r = await t.cache.sync(t.path, { author, trailers })
    expect(r.conflict).toMatchObject({ from: 'origin/main', files: ['README.md'] })
    expect(r.merged).toEqual([])
    expect(r.head).toBe(own)
    expect(readFileSync(join(t.path, 'README.md'), 'utf8')).toMatch(/^<{7} HEAD\n[\s\S]*^={7}\n[\s\S]*^>{7} /m)
    expect(await t.cache.status(t.path)).toMatchObject({ merging: true, clean: false, conflicts: ['README.md'] })

    // Push refuses while the merge is in progress; so does another sync.
    await expect(t.cache.push(t.path, BRANCH, policy)).rejects.toThrow(ConflictError)
    await expect(t.cache.sync(t.path, { author })).rejects.toThrow(/already in progress/)
    // A merge commit takes everything: no paths. Markers left in a file are refused.
    await expect(t.cache.commitAll(t.path, { message: 'x', author, paths: ['README.md'] })).rejects.toThrow(
      /merge is in progress/,
    )
    await expect(t.cache.commitAll(t.path, { message: 'x', author })).rejects.toThrow(/conflict markers remain in README.md/)

    writeFileSync(join(t.path, 'README.md'), '# billing\n\nline one, both\n')
    const sha = await t.cache.commitAll(t.path, { message: 'Merge main: keep both', author, trailers })
    expect(t.parents()).toEqual([own, run(['rev-parse', 'refs/remotes/origin/main'], t.path)])
    expect(run(['merge-base', '--is-ancestor', up, 'HEAD'], t.path)).toBe('')
    expect(sha).toBe(run(['rev-parse', 'HEAD'], t.path))
    expect(await t.cache.status(t.path)).toEqual({ clean: true, files: [], merging: false, conflicts: [] })
    expect(readFileSync(join(t.path, 'clean.txt'), 'utf8')).toBe('c\n')
    await t.cache.push(t.path, BRANCH, policy)
    expect(run(['--git-dir', t.origin, 'rev-parse', BRANCH])).toBe(sha)
  })

  it('a merge resolved to exactly our side is still a merge commit', async () => {
    const t = await setup()
    writeFileSync(join(t.path, 'README.md'), 'ours\n')
    const own = await t.cache.commitAll(t.path, { message: 'ours', author })
    t.upstreamCommit('README.md', 'theirs\n')
    expect((await t.cache.sync(t.path, { author })).conflict?.files).toEqual(['README.md'])
    writeFileSync(join(t.path, 'README.md'), 'ours\n')
    await t.cache.commitAll(t.path, { message: 'keep ours', author })
    expect(t.parents()[0]).toBe(own)
    expect(t.parents()).toHaveLength(2)
  })

  it('refuses to push committed conflict markers from a sync', async () => {
    const t = await setup()
    writeFileSync(join(t.path, 'README.md'), 'ours\n')
    await t.cache.commitAll(t.path, { message: 'ours', author })
    t.upstreamCommit('README.md', 'theirs\n')
    await t.cache.sync(t.path, { author })
    // Finished behind the harness's back (as git would let anyone): markers committed.
    run(['add', '-A'], t.path)
    run(['commit', '--quiet', '--no-edit'], t.path)
    await expect(t.cache.push(t.path, BRANCH, policy)).rejects.toThrow(/conflict markers were committed in README.md/)
    writeFileSync(join(t.path, 'README.md'), 'fixed\n')
    await t.cache.commitAll(t.path, { message: 'fix markers', author })
    await t.cache.push(t.path, BRANCH, policy)
  })

  it('abort backs out of a conflicted merge', async () => {
    const t = await setup()
    writeFileSync(join(t.path, 'README.md'), 'ours\n')
    const own = await t.cache.commitAll(t.path, { message: 'ours', author })
    t.upstreamCommit('README.md', 'theirs\n')
    await t.cache.sync(t.path, { author })
    expect(await t.cache.abortMerge(t.path)).toBe(true)
    expect(await t.cache.status(t.path)).toEqual({ clean: true, files: [], merging: false, conflicts: [] })
    expect(run(['rev-parse', 'HEAD'], t.path)).toBe(own)
    expect(readFileSync(join(t.path, 'README.md'), 'utf8')).toBe('ours\n')
    expect(await t.cache.abortMerge(t.path)).toBe(false)
    await t.cache.push(t.path, BRANCH, policy)
  })

  it('needs a clean checkout and valid identity', async () => {
    const t = await setup()
    t.upstreamCommit('b.txt', 'b\n')
    writeFileSync(join(t.path, 'wip.txt'), 'wip\n')
    await expect(t.cache.sync(t.path, { author })).rejects.toThrow(/uncommitted changes \(wip\.txt\)/)
    await expect(t.cache.sync(t.path, { author: { name: 'A', email: 'a<b>' } })).rejects.toThrow(ValidationError)
    await expect(t.cache.sync(t.path, { author, trailers: { 'bad key': 'x' } })).rejects.toThrow(/bad trailer/)
  })

  it('surfaces a held index lock clearly', async () => {
    const t = await setup()
    t.upstreamCommit('b.txt', 'b\n')
    const gitDir = run(['rev-parse', '--absolute-git-dir'], t.path)
    writeFileSync(join(gitDir, 'index.lock'), '')
    await expect(t.cache.sync(t.path, { author })).rejects.toThrow(/another git operation is running/)
    writeFileSync(join(t.path, 'c.txt'), 'c\n')
    await expect(t.cache.commitAll(t.path, { message: 'c', author })).rejects.toThrow(ConflictError)
    rmSync(join(gitDir, 'index.lock'))
    expect(await t.cache.commitAll(t.path, { message: 'c', author })).toMatch(/^[0-9a-f]{40}$/)
  })

  it('serializes with a concurrent commit', async () => {
    const t = await setup()
    t.upstreamCommit('b.txt', 'b\n')
    // A commit racing a sync: whichever runs first, both finish and nothing is lost.
    const [s, c] = await Promise.allSettled([
      t.cache.sync(t.path, { author }),
      (async () => {
        await writeFile(join(t.path, 'race.txt'), 'r\n')
        return t.cache.commitAll(t.path, { message: 'race', author })
      })(),
    ])
    expect(c.status).toBe('fulfilled')
    if (s.status === 'rejected') expect(String(s.reason)).toMatch(/uncommitted changes/)
    await t.cache.sync(t.path, { author })
    expect(readFileSync(join(t.path, 'b.txt'), 'utf8')).toBe('b\n')
    expect(run(['log', '--format=%s'], t.path)).toContain('race')
  })

  it('records when the mirror was last fetched', async () => {
    const t = await setup()
    expect(await t.cache.lastFetch(t.url)).toBe(t.clock.now())
    t.clock.advance(60_000)
    await t.cache.fetch(t.url)
    expect(await t.cache.lastFetch(t.url)).toBe(t.clock.now())
    t.clock.advance(60_000)
    await t.cache.sync(t.path, { author })
    expect(await t.cache.lastFetch(t.url)).toBe(t.clock.now())
    const other = gitCliCache({ root: join(t.dir, 'cache'), env, clock: t.clock })
    expect(await other.lastFetch(t.url)).toBeNull()
  })
})

describe('partial commits', () => {
  it('commits only the given files and directories; the rest stays uncommitted', async () => {
    const t = await setup()
    await mkdir(join(t.path, 'src'), { recursive: true })
    writeFileSync(join(t.path, 'src', 'a.ts'), 'a\n')
    writeFileSync(join(t.path, 'src', 'b.ts'), 'b\n')
    writeFileSync(join(t.path, 'notes.txt'), 'n\n')
    writeFileSync(join(t.path, 'README.md'), 'changed\n')
    rmSync(join(t.path, 'own.txt'))
    const sha = await t.cache.commitAll(t.path, { message: 'src only', author, paths: ['./src/', 'own.txt'] })
    expect(run(['show', '--name-status', '--format=', sha!], t.path).split('\n').sort()).toEqual([
      'A\tsrc/a.ts',
      'A\tsrc/b.ts',
      'D\town.txt',
    ])
    expect((await t.cache.status(t.path)).files).toEqual(['README.md', 'notes.txt'])
    await t.cache.commitAll(t.path, { message: 'rest', author, paths: ['.'] })
    expect((await t.cache.status(t.path)).clean).toBe(true)
  })

  it('refuses paths with no changes and paths outside the checkout', async () => {
    const t = await setup()
    writeFileSync(join(t.path, 'a.txt'), 'a\n')
    await expect(t.cache.commitAll(t.path, { message: 'x', author, paths: ['README.md'] })).rejects.toThrow(
      /no changes in README.md/,
    )
    await expect(t.cache.commitAll(t.path, { message: 'x', author, paths: ['nope/'] })).rejects.toThrow(/no changes in nope/)
    await expect(t.cache.commitAll(t.path, { message: 'x', author, paths: ['../x'] })).rejects.toThrow(DeniedError)
    await expect(t.cache.commitAll(t.path, { message: 'x', author, paths: ['/etc/passwd'] })).rejects.toThrow(DeniedError)
    await expect(t.cache.commitAll(t.path, { message: 'x', author, paths: ['.git/config'] })).rejects.toThrow(DeniedError)
    await expect(t.cache.commitAll(t.path, { message: 'x', author, paths: [] })).rejects.toThrow(ValidationError)
    // Pathspec magic is taken literally.
    writeFileSync(join(t.path, '*.txt'), 'star\n')
    await t.cache.commitAll(t.path, { message: 'star', author, paths: ['*.txt'] })
    expect((await t.cache.status(t.path)).files).toEqual(['a.txt'])
  })
})

describe('local repositories', () => {
  it('syncs a checkout of local:<slug> with what a person merged into main', async () => {
    const dir = join(base, `local-${++n}`)
    const clock = new ManualClock(Date.UTC(2026, 8, 29, 9))
    const reposDir = join(dir, 'repos')
    const repos = gitCliLocalRepos({ root: reposDir, env, clock })
    const cache = gitCliCache({ root: join(dir, 'cache'), env, clock, localReposDir: reposDir })
    await repos.create('billing', { author: { name: 'Mia Example', email: 'mia@example.com' } })
    const url = localRepoUrl('billing')
    await cache.fetch(url)
    const mine = join(dir, 'wt', 'mine')
    const theirs = join(dir, 'wt', 'theirs')
    await cache.createWorktree(url, { path: mine, newBranch: 'mp/ana/one' })
    await cache.createWorktree(url, { path: theirs, newBranch: 'mp/ana/two' })
    writeFileSync(join(mine, 'a.txt'), 'a\n')
    await cache.commitAll(mine, { message: 'a', author })
    writeFileSync(join(theirs, 'b.txt'), 'b\n')
    await cache.commitAll(theirs, { message: 'b', author })
    await cache.push(theirs, 'mp/ana/two', policy)
    await repos.merge('billing', 'mp/ana/two', { author: { name: 'Mia Example', email: 'mia@example.com' } })

    await cache.fetch(url)
    expect((await cache.divergence(mine)).base).toEqual({ ref: 'main', ahead: 1, behind: 1 })
    const r = await cache.sync(mine, { author, base: 'main' })
    expect(r.merged).toMatchObject([{ from: 'origin/main', commits: 1, mode: 'merge' }])
    expect(readFileSync(join(mine, 'b.txt'), 'utf8')).toBe('b\n')
    await cache.push(mine, 'mp/ana/one', policy)
  })
})
