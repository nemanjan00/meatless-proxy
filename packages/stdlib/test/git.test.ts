import { mkdtemp, rm, symlink, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nodeWorktreeFs, safeRelPath } from '../src/index.ts'
import { checkoutPath, REPO, stack } from './helpers.ts'

describe('git tools', () => {
  it('checkout creates a worktree on the session branch and records it', async () => {
    const t = await stack()
    const o = await t.out('git.checkout', { projectId: t.project.id })
    expect(o).toMatchObject({
      key: 'github.com/acme/billing',
      branch: `mp/billing-bot/${t.session.data.slug}`,
      where: expect.stringContaining('not in your filesystem'),
    })
    // The harness's own disk path isn't the model's business: it took it for one of its files.
    expect(o.path).toBeUndefined()
    const path = `/wt/${t.session.id}/github.com/acme/billing`
    expect(t.git.worktree(path)).toMatchObject({ url: REPO, branch: o.branch })
    const s = await t.sessions.require(t.session.id)
    expect(s.data.meta?.worktrees).toEqual([
      expect.objectContaining({ key: o.key, projectId: t.project.id, path, branch: o.branch, baseSha: o.head }),
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

  it("starts from the remote's own default branch when none is given (no guessed main)", async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { repositories: [{ url: REPO }] })
    await t.out('git.checkout', { projectId: t.project.id })
    const call = t.git.calls.find((c) => c.method === 'createWorktree')!
    expect((call.args[1] as { ref?: string }).ref).toBeUndefined()
  })

  it('reads a range of lines, and edits an exact piece of text', async () => {
    const t = await stack()
    await t.out('git.checkout', { projectId: t.project.id })
    const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
    await t.out('git.write_file', { path: 'big.txt', content: body })
    const part = await t.out('git.read_file', { path: 'big.txt', offset: 10, limit: 3 })
    expect(part).toMatchObject({ totalLines: 50, lines: '10-12', content: '10\tline 10\n11\tline 11\n12\tline 12' })
    expect(part.next).toMatch(/offset 13/)

    expect(await t.out('git.edit_file', { path: 'big.txt', old: 'line 20\n', new: 'line twenty\n' })).toMatchObject({
      replaced: 1,
      line: 20,
    })
    expect((await t.out('git.read_file', { path: 'big.txt', offset: 20, limit: 1 })).content).toBe('20\tline twenty')
    // Not found, not unique, and replaceAll.
    expect((await t.call('git.edit_file', { path: 'big.txt', old: 'nope', new: 'x' })).isError).toBe(true)
    const twice = await t.call('git.edit_file', { path: 'big.txt', old: 'line 1', new: 'L1' })
    expect(twice.isError).toBe(true)
    expect(JSON.stringify(twice.output)).toMatch(/appears \d+ times/)
    expect(await t.out('git.edit_file', { path: 'big.txt', old: 'line 3', new: 'L3', replaceAll: true })).toMatchObject({
      replaced: 11,
    })
  })

  it('is not registered without a git cache', async () => {
    const t = await stack({ git: false, containers: false })
    expect(t.names.some((n) => n.startsWith('git.') || n.startsWith('env.'))).toBe(false)
  })
})

describe('env tools', () => {
  it("picks a profile by name, the project's profile, or refuses an unknown one", async () => {
    const t = await stack()
    await t.out('git.checkout', { projectId: t.project.id })
    expect((await t.call('env.up', { profile: 'nope' })).isError).toBe(true)
    expect(await t.out('env.up', { profile: 'analyst' })).toMatchObject({ profile: 'analyst', image: 'nemanjan00/dev:analyst' })
    await t.out('env.down', {})
    await t.directory.projects.update(t.project.id, { envProfile: 'librarian' })
    expect(await t.out('env.up', {})).toMatchObject({ profile: 'librarian', image: 'nemanjan00/dev:librarian' })
  })

  it('up mounts the checkout, exec runs commands, logs, down', async () => {
    const t = await stack()
    expect((await t.call('env.up', {})).isError).toBe(true) // no image and no checkout
    await t.out('git.checkout', { projectId: t.project.id })
    const w = { path: await checkoutPath(t, t.session.id) }
    const up = await t.out('env.up', { env: { NODE_ENV: 'test' } })
    // No Dockerfile in the checkout and no profile named: the default profile.
    expect(up).toMatchObject({ status: 'running', workspace: '/workspace', profile: 'default', image: 'nemanjan00/dev:default' })
    const spec = t.containers.created[0]!
    expect(spec).toMatchObject({
      image: 'nemanjan00/dev:default',
      // The checkout at /workspace, and every checkout of the session at /repos/<name>.
      mounts: [
        { hostPath: w.path, containerPath: '/workspace' },
        { hostPath: w.path, containerPath: expect.stringMatching(/^\/repos\//) },
      ],
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
    // exec without a running environment starts the default one first, and says so.
    t.containers.on('ls', { exitCode: 0, stdout: 'package.json' })
    const again = await t.out('env.exec', { cmd: ['ls'] })
    expect(again).toMatchObject({ exitCode: 0, stdout: 'package.json', started: { status: 'running', profile: 'default' } })
    expect(t.containers.created).toHaveLength(2)
  })

  it('exec with nothing to start from fails with what env.up said', async () => {
    const t = await stack()
    const r = await t.call('env.exec', { cmd: ['ls'] })
    expect(r.isError).toBe(true)
    expect(t.containers.created).toHaveLength(0)
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

describe('AGENTS.md', () => {
  const root = (t: Awaited<ReturnType<typeof stack>>) => `/wt/${t.session.id}/github.com/acme/billing`

  it('checkout hands over the root AGENTS.md, once', async () => {
    const t = await stack()
    t.worktreeFs.files.set(`${root(t)}/AGENTS.md`, '# Billing\n\nRun `npm test` before committing.')
    const o = await t.out('git.checkout', { projectId: t.project.id })
    expect(o.instructions.note).toContain('never override')
    expect(o.instructions.files).toEqual([{ file: 'AGENTS.md', content: '# Billing\n\nRun `npm test` before committing.' }])
    const again = await t.out('git.checkout', { projectId: t.project.id })
    expect(again.existing).toBe(true)
    expect(again.instructions).toBeUndefined()
  })

  it('falls back to CLAUDE.md and resolves @ includes inside the checkout only', async () => {
    const t = await stack()
    const r = root(t)
    t.worktreeFs.files.set(
      `${r}/CLAUDE.md`,
      'Project notes.\n\n@docs/agents.md\n@../../etc/passwd\n@missing.md\n```\n@docs/agents.md\n```',
    )
    t.worktreeFs.files.set(`${r}/docs/agents.md`, 'Use tabs.\n@../CLAUDE.md')
    const o = await t.out('git.checkout', { projectId: t.project.id })
    const f = o.instructions.files[0]
    expect(f.file).toBe('CLAUDE.md')
    expect(f.includes).toEqual(['docs/agents.md'])
    expect(f.content).toContain('Use tabs.')
    // Outside the checkout, missing, cyclic and fenced includes stay as written.
    expect(f.content).toContain('@../../etc/passwd')
    expect(f.content).toContain('@missing.md')
    expect(f.content.match(/Use tabs\./g)).toHaveLength(1)
  })

  it('hands over nested AGENTS.md files as the session reaches their directories', async () => {
    const t = await stack()
    const r = root(t)
    t.worktreeFs.files.set(`${r}/AGENTS.md`, 'root rules')
    t.worktreeFs.files.set(`${r}/packages/api/AGENTS.md`, 'api rules')
    t.worktreeFs.files.set(`${r}/packages/api/src/deep/AGENTS.md`, 'deep rules')
    t.worktreeFs.files.set(`${r}/packages/api/src/deep/x.ts`, 'x')
    await t.out('git.checkout', { projectId: t.project.id })
    const first = await t.out('git.read_file', { path: 'packages/api/src/deep/x.ts' })
    expect(first.instructions.files.map((f: any) => f.file)).toEqual([
      'packages/api/AGENTS.md',
      'packages/api/src/deep/AGENTS.md',
    ])
    // Once per session.
    expect((await t.out('git.read_file', { path: 'packages/api/src/deep/x.ts' })).instructions).toBeUndefined()
    expect((await t.out('git.write_file', { path: 'packages/api/y.ts', content: 'y' })).instructions).toBeUndefined()
    // Listing a directory counts as reaching it; a new session gets them again.
    const s2 = await t.sessions.fork(t.session.id)
    const listed = await t.out('git.list_files', { path: 'packages/api', sessionId: t.session.id }, t.ctx({ sessionId: s2.id }))
    expect(listed.instructions.files.map((f: any) => f.file)).toEqual(['packages/api/AGENTS.md'])
  })

  it('caps large files', async () => {
    const t = await stack()
    t.worktreeFs.files.set(`${root(t)}/AGENTS.md`, 'x'.repeat(40 * 1024))
    const o = await t.out('git.checkout', { projectId: t.project.id })
    expect(o.instructions.files[0].truncated).toBe(true)
    expect(o.instructions.files[0].content).toContain('truncated')
  })
})

describe('checkout access failures', () => {
  it('explain a refused SSH key, and what to do instead', async () => {
    const { accessFailure } = await import('../src/tools/git.ts')
    const err = new Error(
      'git fetch failed: git@gitlab.example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    )
    const why = accessFailure(err, 'git@gitlab.example.com:acme/app.git', true)!
    expect(why).toContain("don't have access to git@gitlab.example.com:acme/app.git")
    expect(why).toContain('not a member')
    expect(why).toContain('mcp.gitlab.get_file')
    expect(accessFailure(err, 'x', false)).toContain('no SSH key')
    expect(accessFailure(new Error('disk full'), 'x', true)).toBeUndefined()
  })
})
