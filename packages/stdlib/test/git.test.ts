import { mkdtemp, rm, symlink, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nodeWorktreeFs, safeRelPath } from '../src/index.ts'
import { REPO, stack } from './helpers.ts'

describe('git tools', () => {
  it('checkout creates a worktree on the session branch and records it', async () => {
    const t = await stack()
    const o = await t.out('git.checkout', { projectId: t.project.id })
    expect(o).toMatchObject({
      key: 'github.com/acme/billing',
      path: `/wt/${t.session.id}/github.com/acme/billing`,
      branch: `mp/billing-bot/${t.session.data.slug}`,
    })
    expect(t.git.worktree(o.path)).toMatchObject({ url: REPO, branch: o.branch })
    const s = await t.sessions.require(t.session.id)
    expect(s.data.meta?.worktrees).toEqual([
      expect.objectContaining({ key: o.key, projectId: t.project.id, path: o.path, branch: o.branch, baseSha: o.head }),
    ])
    expect(await t.records.links({ from: { kind: 'session', id: t.session.id }, role: 'works_on' })).toHaveLength(1)
    // Idempotent.
    expect((await t.out('git.checkout', { projectId: t.project.id })).existing).toBe(true)
    expect(t.git.worktrees()).toHaveLength(1)
    expect((await t.call('git.checkout', { projectId: t.project.id, repo: 3 })).isError).toBe(true)
  })

  it('uses the employee branch prefix when set', async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, {
      git: { name: 'B', email: 'b@example.com', branchPrefix: 'bots/billing/' },
    })
    expect((await t.out('git.checkout', { projectId: t.project.id })).branch).toBe(`bots/billing/${t.session.data.slug}`)
  })

  it('write, read, list, status, diff, commit with trailers, log, push', async () => {
    const t = await stack()
    const w = await t.out('git.checkout', { projectId: t.project.id })
    expect((await t.call('git.status', {})).output).toMatchObject({ clean: true })
    await t.out('git.write_file', { path: 'src/refund.ts', content: 'export const refund = 1' })
    await t.out('git.write_file', { path: '/docs/refunds.md', content: '# Refunds' })
    expect((await t.out('git.read_file', { path: 'src/refund.ts' })).content).toBe('export const refund = 1')
    expect((await t.out('git.list_files', {})).entries.sort()).toEqual(['docs/', 'src/'])
    expect((await t.out('git.status', {})).files).toEqual(['docs/refunds.md', 'src/refund.ts'])
    expect((await t.out('git.diff', {})).diff).toContain('+export const refund = 1')

    const c = await t.out('git.commit', { message: 'Add refunds\n\nWhy: PAY-9' })
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/)
    const call = t.git.calls.find((x) => x.method === 'commitAll')!
    expect(call.args[1]).toMatchObject({
      author: { name: 'Billing Bot', email: 'billing-bot@example.com' },
      trailers: { Session: t.session.id, 'Requested-by': t.ana.id },
    })
    expect((await t.out('git.commit', { message: 'again' })).note).toBe('nothing to commit')
    expect((await t.out('git.log', {})).commits[0].subject).toBe('Add refunds')
    // The diff since checkout still shows the committed work.
    expect((await t.out('git.diff', {})).diff).toContain('docs/refunds.md')

    expect(await t.out('git.push', {})).toMatchObject({ pushed: w.branch })
    expect(t.git.pushes).toEqual([{ url: REPO, branch: w.branch, sha: c.sha }])
  })

  it('never pushes to protected branches', async () => {
    const t = await stack()
    await t.out('git.checkout', { projectId: t.project.id })
    await expect(t.call('git.push', { branch: 'main' })).rejects.toThrow(/protected/)
    await expect(t.call('git.push', { branch: 'feature/x' })).rejects.toThrow(/not allowed/)
    await expect(t.call('git.push', { branch: 'mp/x:main' })).rejects.toThrow(/not a valid branch/)
    expect(t.git.pushes).toEqual([])
    expect(t.git.calls.some((c) => c.method === 'push')).toBe(false)
  })

  it('refuses paths outside the worktree and inside .git', async () => {
    const t = await stack()
    await t.out('git.checkout', { projectId: t.project.id })
    await expect(t.call('git.write_file', { path: '../../etc/passwd', content: 'x' })).rejects.toThrow(/outside the worktree/)
    await expect(t.call('git.read_file', { path: 'a/../../../x' })).rejects.toThrow(/outside the worktree/)
    await expect(t.call('git.write_file', { path: '.git/config', content: 'x' })).rejects.toThrow(/\.git/)
    expect((await t.call('git.write_file', { path: '', content: 'x' })).isError).toBe(true)
  })

  it('needs a checkout, and asks which one when there are several', async () => {
    const t = await stack()
    expect(JSON.stringify((await t.call('git.status', {})).output)).toContain('git.checkout first')
    await t.directory.projects.update(t.project.id, {
      repositories: [{ url: REPO, defaultBranch: 'main' }, { url: 'https://github.com/acme/web.git' }],
    })
    await t.out('git.checkout', { projectId: t.project.id })
    await t.out('git.checkout', { projectId: t.project.id, repo: 1 })
    expect(JSON.stringify((await t.call('git.status', {})).output)).toContain('several checkouts')
    expect((await t.out('git.status', { repo: 'github.com/acme/web' })).clean).toBe(true)
  })

  it('is not registered without a git cache', async () => {
    const t = await stack({ git: false, containers: false })
    expect(t.names.some((n) => n.startsWith('git.') || n.startsWith('env.'))).toBe(false)
  })
})

describe('env tools', () => {
  it('up mounts the checkout, exec runs commands, logs, down', async () => {
    const t = await stack()
    expect((await t.call('env.up', {})).isError).toBe(true) // no image and no checkout
    const w = await t.out('git.checkout', { projectId: t.project.id })
    const up = await t.out('env.up', { env: { NODE_ENV: 'test' } })
    expect(up).toMatchObject({ status: 'running', workspace: '/workspace' })
    const spec = t.containers.created[0]!
    expect(spec).toMatchObject({
      build: { context: w.path },
      mounts: [{ hostPath: w.path, containerPath: '/workspace' }],
      env: { NODE_ENV: 'test' },
      labels: { 'mp.session': t.session.id },
    })
    expect((await t.out('env.up', {})).existing).toBe(true)
    expect(t.containers.created).toHaveLength(1)

    t.containers.on('npm test', { exitCode: 0, stdout: '12 passed' })
    t.containers.on('false', { exitCode: 1, stderr: 'nope' })
    expect(await t.out('env.exec', { cmd: ['npm', 'test'] })).toMatchObject({ exitCode: 0, stdout: '12 passed' })
    const bad = await t.call('env.exec', { cmd: ['false'] })
    expect(bad).toMatchObject({ isError: true, output: { exitCode: 1, stderr: 'nope' } })
    t.containers.appendLog(up.envId, 'server started')
    expect((await t.out('env.logs', {})).logs).toContain('server started')
    await t.out('env.down', {})
    expect(t.containers.envs()).toHaveLength(0)
    expect((await t.out('env.down', {})).note).toContain('no environment')
    expect((await t.call('env.exec', { cmd: ['ls'] })).isError).toBe(true)
  })

  it('can run a plain image without a checkout', async () => {
    const t = await stack()
    await t.out('env.up', { image: 'node:22' })
    expect(t.containers.created[0]).toMatchObject({ image: 'node:22' })
    expect(t.containers.created[0]!.mounts).toBeUndefined()
  })
})

describe('worktree paths', () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true })
  })

  it('safeRelPath normalizes and refuses escapes', () => {
    expect(safeRelPath('/wt/s', 'src/a.ts')).toBe('src/a.ts')
    expect(safeRelPath('/wt/s', '/src/./a.ts')).toBe('src/a.ts')
    expect(safeRelPath('/wt/s', '/wt/s/src/a.ts')).toBe('src/a.ts')
    expect(safeRelPath('/wt/s', '')).toBe('')
    expect(safeRelPath('/wt/s', 'a/../b')).toBe('b')
    expect(() => safeRelPath('/wt/s', '../x')).toThrow(/outside/)
    expect(() => safeRelPath('/wt/s', '/wt/other/x')).not.toThrow() // read as relative: /wt/s/wt/other/x
    expect(() => safeRelPath('/wt/s', '.git/HEAD')).toThrow(/\.git/)
    expect(() => safeRelPath('/wt/s', 'a\u0000b')).toThrow(/control/)
  })

  it('nodeWorktreeFs reads, writes, lists and refuses symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mp-stdlib-'))
    const outside = await mkdtemp(join(tmpdir(), 'mp-stdlib-out-'))
    dirs.push(root, outside)
    await mkdir(join(root, '.git'))
    const fs = nodeWorktreeFs()
    await fs.write(root, 'src/a.ts', 'A')
    expect(await fs.read(root, 'src/a.ts')).toBe('A')
    expect(await fs.list(root, '')).toEqual([{ name: 'src', type: 'dir' }])
    await writeFile(join(outside, 'secret'), 'S')
    await symlink(outside, join(root, 'link'))
    await expect(fs.read(root, 'link/secret')).rejects.toThrow(/outside the worktree/)
    await expect(fs.write(root, 'link/new', 'x')).rejects.toThrow(/outside the worktree/)
  })
})
