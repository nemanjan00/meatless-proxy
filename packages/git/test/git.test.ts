import { ConflictError, DeniedError, NotFoundError, ValidationError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { assertPushAllowed, fakeGitCache, isValidBranchName, mirrorKey } from '../src/index.ts'

describe('mirrorKey', () => {
  it.each([
    ['https://github.com/acme/billing.git', 'github.com/acme/billing'],
    ['https://github.com/acme/billing', 'github.com/acme/billing'],
    ['https://github.com/acme/billing/', 'github.com/acme/billing'],
    ['  https://GitHub.com/acme/Billing.git  ', 'github.com/acme/Billing'],
    ['https://user:pw@github.com/acme/billing.git', 'github.com/acme/billing'],
    ['git@github.com:acme/billing.git', 'github.com/acme/billing'],
    ['git@gitlab.example.com:group/sub/repo.git', 'gitlab.example.com/group/sub/repo'],
    ['ssh://git@github.com/acme/billing.git', 'github.com/acme/billing'],
    ['ssh://git@git.example.com:2222/acme/billing.git', 'git.example.com:2222/acme/billing'],
    ['file:///srv/repos/origin.git', 'local/srv/repos/origin'],
    ['/srv/repos/origin.git', 'local/srv/repos/origin'],
    ['https://github.com//acme///billing.git', 'github.com/acme/billing'],
  ])('%s -> %s', (url, key) => {
    expect(mirrorKey(url)).toBe(key)
  })

  it.each([
    'https://example.com/../../etc/passwd',
    'https://example.com/a/%2e%2e/%2e%2e/b',
    'git@example.com:../../etc',
    'git@example.com:a/..',
    'git@example.com:a/./b',
    '../../etc',
    'file:///srv/../../etc/repo.git',
    'https://example.com/a\\..\\..\\b',
    'git@example.com:a/.../b',
    'git@example.com:a/b c;rm -rf',
  ])('never escapes the cache root: %s', (url) => {
    const key = mirrorKey(url)
    const segments = key.split('/')
    expect(segments.every((s) => s !== '' && s !== '.' && s !== '..' && !/^\.+$/.test(s))).toBe(true)
    expect(key).toMatch(/^[\w.~@:+/-]+$/)
    expect(key.startsWith('/')).toBe(false)
  })

  it.each(['', 'https://example.com/', 'git@example.com:.', 'https://example.com/..git'])('rejects %j', (url) => {
    expect(() => mirrorKey(url)).toThrow(ValidationError)
  })
})

describe('assertPushAllowed', () => {
  const policy = { allow: ['mp/**'], protected: ['main', 'master', 'release/**', 'mp/protected'] }

  it('allows matching branches', () => {
    expect(() => assertPushAllowed('mp/ana/fix-login', policy)).not.toThrow()
    expect(() => assertPushAllowed('refs/heads/mp/ana/x', policy)).not.toThrow()
  })

  it.each(['main', 'refs/heads/main', 'master', 'release/1.0', 'mp/protected'])('denies protected %s', (b) => {
    expect(() => assertPushAllowed(b, policy)).toThrow(DeniedError)
    expect(() => assertPushAllowed(b, { allow: ['**'], protected: policy.protected })).toThrow(/protected/)
  })

  it.each(['feature/x', 'develop', 'mpx/y'])('denies branches not allowed: %s', (b) => {
    expect(() => assertPushAllowed(b, policy)).toThrow(/not allowed/)
  })

  it.each([
    'mp/x:main',
    'mp/x:refs/heads/main',
    '+mp/x',
    'mp/../main',
    'mp/x y',
    '-mp/x',
    'mp/x.lock',
    'mp/.hidden',
    '',
    'mp/x@{1}',
    'mp//x',
  ])('denies invalid names %j', (b) => {
    expect(() => assertPushAllowed(b, { allow: ['**'], protected: [] })).toThrow(/not a valid branch name/)
  })

  it('denies everything with an empty allow list', () => {
    expect(() => assertPushAllowed('mp/x', { allow: [], protected: [] })).toThrow(DeniedError)
  })

  it('validates branch names', () => {
    expect(isValidBranchName('mp/ana/ses-01J')).toBe(true)
    expect(isValidBranchName('a\u0000b')).toBe(false)
    expect(isValidBranchName('a~1')).toBe(false)
    expect(isValidBranchName('a^')).toBe(false)
    expect(isValidBranchName('x/')).toBe(false)
  })
})

describe('fakeGitCache', () => {
  const url = 'https://github.com/acme/billing.git'
  const author = { name: 'Ana', email: 'ana@example.com' }
  const policy = { allow: ['mp/**'], protected: ['main'] }

  it('mirrors, creates worktrees, commits and pushes', async () => {
    const git = fakeGitCache({ root: '/cache' })
    expect(git.mirrorPath(url)).toBe('/cache/github.com/acme/billing')
    expect(await git.ensureMirror(url)).toBe('/cache/github.com/acme/billing')
    const main = git.remote(url).branches.get('main')!
    const wt = await git.createWorktree(url, { path: '/wt/a', newBranch: 'mp/ana/a' })
    expect(wt).toEqual({ path: '/wt/a', branch: 'mp/ana/a', head: main })
    expect(await git.status('/wt/a')).toEqual({ clean: true, files: [] })
    expect(await git.commitAll('/wt/a', { message: 'nothing', author })).toBeNull()

    git.writeFile('/wt/a', 'src/b.ts', 'b')
    git.writeFile('/wt/a', 'src/a.ts', 'a')
    expect(await git.status('/wt/a')).toEqual({ clean: false, files: ['src/a.ts', 'src/b.ts'] })
    expect(await git.diff('/wt/a')).toContain('a/src/a.ts')
    const sha = await git.commitAll('/wt/a', { message: 'Fix billing\n\nbody', author, trailers: { 'Mp-Session': 'ses_1' } })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.status('/wt/a')).toEqual({ clean: true, files: [] })
    expect(await git.log('/wt/a')).toEqual([
      { sha, subject: 'Fix billing', author: 'Ana <ana@example.com>' },
      { sha: main, subject: 'initial commit', author: 'Origin <origin@example.com>' },
    ])
    expect(await git.diff('/wt/a', 'main')).toContain('src/b.ts')
    expect(await git.diff('/wt/a', sha!)).toBe('')

    await git.push('/wt/a', 'mp/ana/a', policy)
    expect(git.remote(url).branches.get('mp/ana/a')).toBe(sha)
    expect(git.pushes).toEqual([{ url, branch: 'mp/ana/a', sha }])
    expect(git.calls.map((c) => c.method)).toContain('push')
  })

  it('enforces the push policy before anything else', async () => {
    const git = fakeGitCache()
    await git.createWorktree(url, { path: '/wt/a', ref: 'main' })
    await expect(git.push('/wt/a', 'main', policy)).rejects.toBeInstanceOf(DeniedError)
    await expect(git.push('/wt/nope', 'main', policy)).rejects.toBeInstanceOf(DeniedError)
    await expect(git.push('/wt/a', 'feature/x', policy)).rejects.toBeInstanceOf(DeniedError)
    expect(git.pushes).toEqual([])
    expect(git.remote(url).branches.size).toBe(1)
  })

  it('forks worktrees at the same commit on different branches', async () => {
    const git = fakeGitCache()
    const a = await git.createWorktree(url, { path: '/wt/a', newBranch: 'mp/a' })
    git.writeFile('/wt/a', 'f', '1')
    const sha = await git.commitAll('/wt/a', { message: 'one', author })
    const b = await git.createWorktree(url, { path: '/wt/b', ref: 'mp/a', newBranch: 'mp/b' })
    expect(b.head).toBe(sha)
    expect(a.head).not.toBe(sha)
    await expect(git.createWorktree(url, { path: '/wt/c', newBranch: 'mp/a' })).rejects.toBeInstanceOf(ConflictError)
    await expect(git.createWorktree(url, { path: '/wt/a' })).rejects.toBeInstanceOf(ConflictError)
    await expect(git.createWorktree(url, { path: '/wt/d', ref: 'nope' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(git.createWorktree(url, { path: '/wt/e', newBranch: 'bad:name' })).rejects.toBeInstanceOf(ValidationError)
    await git.removeWorktree(url, '/wt/b')
    await git.removeWorktree(url, '/wt/b')
    expect(git.worktrees().map((w) => w.path)).toEqual(['/wt/a'])
    await expect(git.status('/wt/b')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('sees upstream commits only after fetch, and rejects non-fast-forward pushes', async () => {
    const git = fakeGitCache()
    await git.ensureMirror(url)
    const upstream = git.addRemoteCommit(url, 'main', 'upstream change')
    await expect(git.createWorktree(url, { path: '/wt/x', ref: upstream })).rejects.toBeInstanceOf(NotFoundError)
    await git.fetch(url)
    expect((await git.createWorktree(url, { path: '/wt/x', ref: 'main' })).head).toBe(upstream)

    await git.createWorktree(url, { path: '/wt/y', newBranch: 'mp/y' })
    git.writeFile('/wt/y', 'f', '1')
    await git.commitAll('/wt/y', { message: 'mine', author })
    git.addRemoteCommit(url, 'mp/y', 'someone else pushed')
    await expect(git.push('/wt/y', 'mp/y', policy)).rejects.toBeInstanceOf(ConflictError)
  })
})
