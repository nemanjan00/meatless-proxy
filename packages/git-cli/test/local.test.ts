import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConflictError, DeniedError, ManualClock, NotFoundError, ValidationError } from '@mp/core'
import { isValidRepoSlug, localRepoSlug, localRepoUrl, mirrorKey } from '@mp/git'
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
const person = { name: 'Mia Example', email: 'mia@example.com' }
const policy = { allow: ['mp/**'], protected: ['main', 'master', 'production', 'release/**'] }

let n = 0
/** Local repositories and an employee's cache that knows where they are. */
function setup() {
  const dir = join(base, `case-${++n}`)
  const clock = new ManualClock(Date.UTC(2026, 8, 29, 9))
  const reposDir = join(dir, 'repos')
  const repos = gitCliLocalRepos({ root: reposDir, env, clock })
  const cache = gitCliCache({ root: join(dir, 'cache'), env, clock, localReposDir: reposDir })
  const wt = (name: string) => join(dir, 'wt', name)
  /** A checkout of `local:<slug>` on `branch`, one committed file, pushed. */
  const pushBranch = async (slug: string, branch: string, file: string, content: string, ref?: string) => {
    const url = localRepoUrl(slug)
    await cache.fetch(url)
    const path = wt(branch.replace(/\//g, '_'))
    await cache.createWorktree(url, { path, newBranch: branch, ...(ref ? { ref } : {}) })
    await writeFile(join(path, file), content)
    const sha = await cache.commitAll(path, { message: `add ${file}`, author })
    await cache.push(path, branch, policy)
    return { path, sha: sha! }
  }
  const ref = (slug: string, r: string) => run(['--git-dir', repos.pathOf(slug), 'rev-parse', r])
  return { dir, reposDir, repos, cache, clock, wt, pushBranch, ref }
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mp-git-local-'))
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

describe('slugs and urls', () => {
  it('accepts plain slugs and refuses anything that could leave the repos dir', () => {
    expect(isValidRepoSlug('billing')).toBe(true)
    expect(isValidRepoSlug('billing-api-2')).toBe(true)
    for (const bad of ['', '-x', 'x-', '../etc', 'a/b', 'a.b', '..', '.', 'A', 'a b', 'x'.repeat(65), 'a\0b', '~root'])
      expect(isValidRepoSlug(bad), bad).toBe(false)
    expect(localRepoUrl('billing')).toBe('local:billing')
    expect(localRepoSlug('local:billing')).toBe('billing')
    expect(localRepoSlug('https://gitlab.example.com/a/b.git')).toBeNull()
    expect(() => localRepoSlug('local:../../etc/passwd')).toThrow(ValidationError)
    expect(() => localRepoSlug('local:')).toThrow(ValidationError)
    expect(mirrorKey('local:billing')).toBe('harness/billing')
    expect(() => mirrorKey('local:../x')).toThrow(ValidationError)
  })

  it('pathOf and every operation refuse a bad slug before touching disk', async () => {
    const t = setup()
    expect(t.repos.pathOf('billing')).toBe(join(t.reposDir, 'billing.git'))
    expect(() => t.repos.pathOf('../outside')).toThrow(ValidationError)
    await expect(t.repos.create('../outside', { author: person })).rejects.toThrow(ValidationError)
    await expect(t.repos.branches('../../etc')).rejects.toThrow(ValidationError)
    await expect(t.repos.merge('a/b', 'mp/x', { author: person })).rejects.toThrow(ValidationError)
    expect(existsSync(join(t.dir, 'outside.git'))).toBe(false)
    // A cache refuses a local url with a bad slug too.
    await expect(async () => t.cache.fetch('local:../outside')).rejects.toThrow(ValidationError)
  })

  it('a cache without localReposDir refuses local urls', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    const other = gitCliCache({ root: join(t.dir, 'other-cache'), env })
    await expect(other.fetch('local:billing')).rejects.toThrow(/not configured/)
  })
})

describe('creating', () => {
  it('creates a bare repository with one empty commit on main, once', async () => {
    const t = setup()
    const r = await t.repos.create('billing', { author: person })
    expect(r).toMatchObject({ slug: 'billing', url: 'local:billing', defaultBranch: 'main' })
    expect(r.head).toMatch(/^[0-9a-f]{40}$/)
    expect(t.ref('billing', 'refs/heads/main')).toBe(r.head)
    expect(run(['--git-dir', t.repos.pathOf('billing'), 'log', '--format=%an <%ae>|%s', 'main'])).toBe(
      'Mia Example <mia@example.com>|Initial commit',
    )
    expect(await t.repos.exists('billing')).toBe(true)
    expect(await t.repos.defaultBranch('billing')).toBe('main')
    await expect(t.repos.create('billing', { author: person })).rejects.toThrow(ConflictError)
    // No temp dirs left behind.
    expect(readdirSync(t.reposDir)).toEqual(['billing.git'])
    await t.repos.remove('billing')
    expect(await t.repos.exists('billing')).toBe(false)
  })

  it('unknown repositories are NotFound', async () => {
    const t = setup()
    await expect(t.repos.branches('nope')).rejects.toThrow(NotFoundError)
    await expect(t.cache.fetch('local:nope')).rejects.toThrow(NotFoundError)
  })
})

describe('employees: checkout and push', () => {
  it('checks out at once, pushes its own branch, and never main', async () => {
    const t = setup()
    const { head } = await t.repos.create('billing', { author: person })
    const url = 'local:billing'
    expect(t.cache.mirrorPath(url)).toBe(join(t.dir, 'cache', 'harness', 'billing'))
    const { path, sha } = await t.pushBranch('billing', 'mp/ana/refunds', 'refund.ts', 'export const r = 1\n')
    expect(t.ref('billing', 'refs/heads/mp/ana/refunds')).toBe(sha)
    // main is untouched.
    expect(t.ref('billing', 'refs/heads/main')).toBe(head)

    // The hard rule: protected branches never, whatever the refspec tricks.
    for (const b of ['main', 'master', 'production', 'release/1.0', 'refs/heads/main'])
      await expect(t.cache.push(path, b, policy), b).rejects.toThrow(DeniedError)
    await expect(t.cache.push(path, 'feature/x', policy)).rejects.toThrow(/not allowed/)
    await expect(t.cache.push(path, 'mp/x:main', policy)).rejects.toThrow(/not a valid branch/)
    expect(t.ref('billing', 'refs/heads/main')).toBe(head)

    const list = await t.repos.branches('billing')
    expect(list).toEqual([
      expect.objectContaining({
        name: 'mp/ana/refunds',
        sha,
        ahead: 1,
        behind: 0,
        subject: 'add refund.ts',
        author: 'Ana Bot <ana@example.com>',
      }),
    ])
  })
})

describe('review and merge', () => {
  it('compares a branch: commits, files and diff', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    await t.pushBranch('billing', 'mp/ana/a', 'a.txt', 'hello\n')
    const c = await t.repos.compare('billing', 'mp/ana/a')
    expect(c).toMatchObject({ branch: 'mp/ana/a', base: 'main', ahead: 1, behind: 0, fastForward: true, truncated: false })
    expect(c.commits.map((x) => x.subject)).toEqual(['add a.txt'])
    expect(c.files).toEqual([{ status: 'A', path: 'a.txt' }])
    expect(c.diff).toContain('+hello')
    const small = await t.repos.compare('billing', 'mp/ana/a', { maxDiffBytes: 10 })
    expect(small.truncated).toBe(true)
    expect(small.diff.length).toBeLessThanOrEqual(10)
    await expect(t.repos.compare('billing', 'mp/none')).rejects.toThrow(NotFoundError)
    await expect(t.repos.compare('billing', 'mp/x:main')).rejects.toThrow(ValidationError)
  })

  it('fast-forwards when it can', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    const { sha } = await t.pushBranch('billing', 'mp/ana/ff', 'ff.txt', 'ff\n')
    const r = await t.repos.merge('billing', 'mp/ana/ff', { author: person })
    expect(r).toEqual({ branch: 'mp/ana/ff', into: 'main', sha, mode: 'fast-forward' })
    expect(t.ref('billing', 'refs/heads/main')).toBe(sha)
    expect((await t.repos.branches('billing'))[0]).toMatchObject({ name: 'mp/ana/ff', ahead: 0, behind: 0 })
    // Merging again: nothing to merge.
    await expect(t.repos.merge('billing', 'mp/ana/ff', { author: person })).rejects.toThrow(/nothing to merge/)
  })

  it('makes a merge commit when main moved on', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    const a = await t.pushBranch('billing', 'mp/ana/a', 'a.txt', 'a\n')
    const b = await t.pushBranch('billing', 'mp/ana/b', 'b.txt', 'b\n')
    await t.repos.merge('billing', 'mp/ana/a', { author: person })
    expect((await t.repos.compare('billing', 'mp/ana/b')).fastForward).toBe(false)
    const r = await t.repos.merge('billing', 'mp/ana/b', { author: person })
    expect(r.mode).toBe('merge-commit')
    expect(t.ref('billing', 'refs/heads/main')).toBe(r.sha)
    const parents = run(['--git-dir', t.repos.pathOf('billing'), 'log', '-1', '--format=%P|%an|%s', 'main'])
    expect(parents).toBe(`${a.sha} ${b.sha}|Mia Example|Merge branch 'mp/ana/b' into main`)
    const files = run(['--git-dir', t.repos.pathOf('billing'), 'ls-tree', '--name-only', 'main']).split('\n')
    expect(files.sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('reports conflicts and changes nothing', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    await t.pushBranch('billing', 'mp/ana/one', 'same.txt', 'one\n')
    await t.pushBranch('billing', 'mp/ana/two', 'same.txt', 'two\n')
    await t.repos.merge('billing', 'mp/ana/one', { author: person })
    const before = t.ref('billing', 'refs/heads/main')
    const err = await t.repos.merge('billing', 'mp/ana/two', { author: person }).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.message).toMatch(/conflict.*same\.txt.*Nothing was changed/)
    expect(err.details).toMatchObject({ files: ['same.txt'], branch: 'mp/ana/two', base: 'main' })
    expect(t.ref('billing', 'refs/heads/main')).toBe(before)
  })

  it('refuses to merge or delete the default branch; deletes others', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    await t.pushBranch('billing', 'mp/ana/gone', 'g.txt', 'g\n')
    await expect(t.repos.merge('billing', 'main', { author: person })).rejects.toThrow(/default branch/)
    await expect(t.repos.deleteBranch('billing', 'main')).rejects.toThrow(/default branch/)
    await t.repos.deleteBranch('billing', 'mp/ana/gone')
    expect(await t.repos.branches('billing')).toEqual([])
    await expect(t.repos.deleteBranch('billing', 'mp/ana/gone')).rejects.toThrow(NotFoundError)
  })

  it('merges of two branches at once both land (one after the other)', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    await t.pushBranch('billing', 'mp/ana/x', 'x.txt', 'x\n')
    await t.pushBranch('billing', 'mp/ana/y', 'y.txt', 'y\n')
    const [x, y] = await Promise.all([
      t.repos.merge('billing', 'mp/ana/x', { author: person }),
      t.repos.merge('billing', 'mp/ana/y', { author: person }),
    ])
    expect([x.mode, y.mode].sort()).toEqual(['fast-forward', 'merge-commit'])
    const files = run(['--git-dir', t.repos.pathOf('billing'), 'ls-tree', '--name-only', 'main']).split('\n')
    expect(files.sort()).toEqual(['x.txt', 'y.txt'])
  })

  it('after a merge, a new checkout starts from the merged main', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    await t.pushBranch('billing', 'mp/ana/first', 'first.txt', '1\n')
    const merged = await t.repos.merge('billing', 'mp/ana/first', { author: person })
    await t.cache.fetch('local:billing')
    const info = await t.cache.createWorktree('local:billing', { path: t.wt('second'), newBranch: 'mp/ana/second' })
    expect(info.head).toBe(merged.sha)
  })
})

describe('browsing', () => {
  it('lists directories and reads files of main, and refuses paths outside the repository', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    const { path } = await t.pushBranch('billing', 'mp/ana/docs', 'README.md', '# Billing\n')
    await writeFile(join(path, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    execFileSync('mkdir', ['-p', join(path, 'src')])
    await writeFile(join(path, 'src', 'index.ts'), 'export {}\n')
    await t.cache.commitAll(path, { message: 'more', author })
    await t.cache.push(path, 'mp/ana/docs', policy)
    await t.repos.merge('billing', 'mp/ana/docs', { author: person })

    const root = await t.repos.tree('billing')
    expect(root).toMatchObject({ path: '', ref: 'main' })
    expect(root.entries).toEqual([
      { name: 'src', type: 'dir' },
      { name: 'bin.dat', type: 'file', size: 4 },
      { name: 'README.md', type: 'file', size: 10 },
    ])
    expect((await t.repos.tree('billing', { path: 'src' })).entries).toEqual([{ name: 'index.ts', type: 'file', size: 10 }])
    expect(await t.repos.readFile('billing', { path: 'README.md' })).toMatchObject({
      content: '# Billing\n',
      binary: false,
      size: 10,
    })
    expect(await t.repos.readFile('billing', { path: 'bin.dat' })).toMatchObject({ binary: true, content: null })
    expect(await t.repos.readFile('billing', { path: 'README.md', maxBytes: 3 })).toMatchObject({ tooLarge: true, content: null })
    await expect(t.repos.readFile('billing', { path: 'nope.txt' })).rejects.toThrow(NotFoundError)
    await expect(t.repos.readFile('billing', { path: 'src' })).rejects.toThrow(/directory/)
    for (const bad of ['../../etc/passwd', 'src/../../x', '-rf'])
      await expect(t.repos.readFile('billing', { path: bad }), bad).rejects.toThrow(ValidationError)
    await expect(t.repos.tree('billing', { path: '..' })).rejects.toThrow(ValidationError)
  })
})

describe('attaching a remote', () => {
  it('pushes every branch to an empty remote', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    const { sha } = await t.pushBranch('billing', 'mp/ana/wip', 'w.txt', 'w\n')
    const remote = join(t.dir, 'remote.git')
    run(['init', '--quiet', '--bare', '-b', 'main', remote])
    const r = await t.repos.pushAll('billing', `file://${remote}`)
    expect(r.branches.sort()).toEqual(['main', 'mp/ana/wip'])
    expect(run(['--git-dir', remote, 'rev-parse', 'refs/heads/mp/ana/wip'])).toBe(sha)
    expect(run(['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).toBe(t.ref('billing', 'refs/heads/main'))
    // Pushing again is a no-op.
    await t.repos.pushAll('billing', `file://${remote}`)
  })

  it('refuses a remote with other history, and bad urls', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    const remote = join(t.dir, 'busy.git')
    const seed = join(t.dir, 'seed')
    run(['init', '--quiet', '--bare', '-b', 'main', remote])
    run(['init', '--quiet', '-b', 'main', seed])
    await writeFile(join(seed, 'x'), 'x')
    run(['add', '-A'], seed)
    run(['commit', '--quiet', '-m', 'theirs'], seed)
    run(['push', '--quiet', remote, 'main'], seed)
    await expect(t.repos.pushAll('billing', `file://${remote}`)).rejects.toThrow(ConflictError)
    for (const bad of ['', '--upload-pack=x', 'local:billing', 'a b'])
      await expect(t.repos.pushAll('billing', bad), bad).rejects.toThrow(ValidationError)
  })

  it('says clearly when the remote refuses access', async () => {
    const t = setup()
    await t.repos.create('billing', { author: person })
    // An ssh remote whose "ssh" always refuses, like a key the host doesn't know.
    const bin = join(t.dir, 'bin')
    execFileSync('mkdir', ['-p', bin])
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\necho "git@example.com: Permission denied (publickey)." >&2\nexit 255\n', {
      mode: 0o755,
    })
    const repos = gitCliLocalRepos({ root: t.reposDir, env: { ...env, PATH: `${bin}:${env.PATH}` } })
    const err = await repos.pushAll('billing', 'git@gitlab.example.com:acme/billing.git').catch((e) => e)
    expect(err).toBeInstanceOf(DeniedError)
    expect(err.message).toMatch(/refused these credentials/)
  })
})
