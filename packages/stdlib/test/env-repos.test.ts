import { describe, expect, it } from 'vitest'
import { REPO, stack, type Stack } from './helpers.ts'

const WEB = 'https://github.com/acme/web.git'

/** A second project, with a branch waiting upstream. */
async function webProject(t: Stack) {
  const web = await t.directory.projects.create({ name: 'Web', repositories: [{ url: WEB, defaultBranch: 'main' }] })
  t.git.addRemoteCommit(WEB, 'mp/bo/docs', 'Add README', { 'README.md': '# Web\n' })
  return web
}

const mountsOf = (t: Stack, i = 0) => t.containers.created[i]!.mounts ?? []

describe('env.up with several repositories', () => {
  it('checks out what is missing, mounts a read-only worktree of a ref, and lists every repository', async () => {
    const t = await stack()
    const web = await webProject(t)
    const up = await t.out('env.up', { image: 'node:22', repos: [t.project.id, { project: web.id, ref: 'mp/bo/docs' }] })
    // Billing wasn't checked out: it is now, on the session's own branch.
    const s = await t.sessions.require(t.session.id)
    const worktrees = s.data.meta?.worktrees as { key: string; path: string; branch: string }[]
    expect(worktrees.map((w) => w.key)).toEqual(['github.com/acme/billing'])
    const refs = s.data.meta?.refWorktrees as { key: string; ref: string; path: string; sha: string }[]
    expect(refs).toEqual([expect.objectContaining({ key: 'github.com/acme/web', ref: 'mp/bo/docs' })])
    // The ref's worktree is detached (no branch of its own) at the branch's head.
    expect(t.git.worktree(refs[0]!.path)).toMatchObject({ url: WEB, branch: null })

    expect(up.workspace).toBe('/workspace')
    expect(up.checkout).toBe('github.com/acme/billing')
    expect(up.repos).toEqual([
      { path: '/repos/billing', key: 'github.com/acme/billing', branch: worktrees[0]!.branch, writable: true },
      { path: '/repos/web', key: 'github.com/acme/web', ref: 'mp/bo/docs', sha: refs[0]!.sha.slice(0, 12), writable: false },
    ])
    expect(mountsOf(t)).toEqual([
      { hostPath: worktrees[0]!.path, containerPath: '/workspace' },
      { hostPath: worktrees[0]!.path, containerPath: '/repos/billing' },
      { hostPath: refs[0]!.path, containerPath: '/repos/web', readOnly: true },
      // The mirrors the worktrees' .git files point into: read-only, at the same paths.
      { hostPath: '/fake-git/github.com/acme/billing', containerPath: '/fake-git/github.com/acme/billing', readOnly: true },
      { hostPath: '/fake-git/github.com/acme/web', containerPath: '/fake-git/github.com/acme/web', readOnly: true },
    ])
    expect(t.containers.created[0]!.env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory' })
    expect(up.note).toMatch(/git log, show, diff/)
    expect(up.note).toMatch(/git commit inside fails/)
    const env = s.data.meta?.env as { checkouts: unknown[] }
    expect(env.checkouts).toContainEqual({ key: 'github.com/acme/web', path: '/repos/web', ref: 'mp/bo/docs', writable: false })
  })

  it('puts the primary one at /workspace, read-only when it is a ref', async () => {
    const t = await stack()
    const web = await webProject(t)
    const up = await t.out('env.up', {
      image: 'node:22',
      repos: [t.project.id, { project: web.id, ref: 'mp/bo/docs', primary: true }],
    })
    expect(up.checkout).toBe('github.com/acme/web')
    expect(up.workspaceIs).toBe('/repos/web')
    expect(mountsOf(t)[0]).toMatchObject({ containerPath: '/workspace', readOnly: true })
    expect(
      (
        await t.call('env.up', {
          image: 'x',
          repos: [
            { project: 'a', primary: true },
            { project: 'b', primary: true },
          ],
        })
      ).isError,
    ).toBe(true)
  })

  it('mounts every checkout without repos, the most recent at /workspace, and says so', async () => {
    const t = await stack()
    const web = await webProject(t)
    await t.out('git.checkout', { projectId: t.project.id })
    await t.out('git.checkout', { projectId: web.id })
    const up = await t.out('env.up', { image: 'node:22' })
    expect(up.checkout).toBe('github.com/acme/web')
    expect(up.repos.map((r: any) => r.path)).toEqual(['/repos/billing', '/repos/web'])
    expect(up.note).toContain('/workspace is github.com/acme/web, your most recent checkout')
    await t.out('env.down', {})
    // repo still picks one.
    expect((await t.out('env.up', { image: 'node:22', repo: t.project.id })).checkout).toBe('github.com/acme/billing')
  })

  it('refuses unknown projects and bad entries before changing anything', async () => {
    const t = await stack()
    expect((await t.call('env.up', { image: 'x', repos: ['prj_nope'] })).isError).toBe(true)
    expect((await t.call('env.up', { image: 'x', repos: [{ project: t.project.id, ref: '-x' }] })).isError).toBe(true)
    expect((await t.call('env.up', { image: 'x', repos: 'billing' })).isError).toBe(true)
    expect((await t.call('env.up', { repos: [t.project.id], profile: 'nope' })).isError).toBe(true)
    expect(t.git.worktrees()).toHaveLength(0)
    expect(t.containers.created).toHaveLength(0)
    // A ref that doesn't exist.
    const r = await t.call('env.up', { image: 'x', repos: [{ project: t.project.id, ref: 'mp/nope' }] })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('no branch or commit mp/nope')
  })

  it('a running environment asked for more repositories says how to restart, and restarts with restart: true', async () => {
    const t = await stack()
    const web = await webProject(t)
    await t.out('git.checkout', { projectId: t.project.id })
    const first = await t.out('env.up', { image: 'node:22' })
    // Already there: nothing to say.
    const same = await t.out('env.up', { repos: [t.project.id] })
    expect(same).toMatchObject({ existing: true, envId: first.envId })
    expect(same.missing).toBeUndefined()
    const asked = { repos: [t.project.id, { project: web.id, ref: 'mp/bo/docs' }] }
    const more = await t.out('env.up', asked)
    expect(more).toMatchObject({ existing: true, missing: ['github.com/acme/web@mp/bo/docs'] })
    expect(more.note).toContain(`env.up ${JSON.stringify({ ...asked, restart: true })}`)
    expect(t.containers.created).toHaveLength(1)
    expect(t.git.worktrees()).toHaveLength(1) // nothing made yet

    const again = await t.out('env.up', { ...asked, image: 'node:22', restart: true })
    expect(again.restarted).toBe(true)
    expect(again.note).toContain('restarted to add github.com/acme/web@mp/bo/docs')
    expect(t.containers.created).toHaveLength(2)
    expect(t.containers.envs()).toHaveLength(1)
    expect(again.repos.map((r: any) => [r.path, r.writable])).toEqual([
      ['/repos/billing', true],
      ['/repos/web', false],
    ])
    expect(again.envId).not.toBe(first.envId)
  })

  it('makes a fresh worktree of a ref each time (a branch moves)', async () => {
    const t = await stack()
    const web = await webProject(t)
    await t.out('env.up', { image: 'node:22', repos: [{ project: web.id, ref: 'mp/bo/docs' }] })
    const s1 = await t.sessions.require(t.session.id)
    const sha1 = (s1.data.meta!.refWorktrees as { sha: string }[])[0]!.sha
    const sha2 = t.git.addRemoteCommit(WEB, 'mp/bo/docs', 'More docs', { 'docs.md': 'more' })
    await t.out('env.up', { image: 'node:22', repos: [{ project: web.id, ref: 'mp/bo/docs' }], restart: true })
    const s2 = await t.sessions.require(t.session.id)
    const refs = s2.data.meta?.refWorktrees as { sha: string }[]
    expect(refs).toHaveLength(1)
    expect(refs[0]!.sha).toBe(sha2)
    expect(sha2).not.toBe(sha1)
    expect(t.git.worktrees()).toHaveLength(1)
    void REPO
  })
})
