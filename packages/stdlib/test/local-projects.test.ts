import { globMatch } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSET, ROUTER_EXCLUDED_TOOLS } from '../src/index.ts'
import { stack } from './helpers.ts'

describe('local projects (projects.create_local and git on local:<slug>)', () => {
  it('creates a project the employee is a member of, once per call', async () => {
    const t = await stack()
    const c = t.ctx()
    const o = await t.out('projects.create_local', { name: 'Invoice parser', description: 'Parses invoices.' }, c)
    expect(o).toMatchObject({ name: 'Invoice parser', url: 'local:invoice-parser', defaultBranch: 'main', role: 'member' })
    expect(t.localCreated).toEqual([{ name: 'Invoice parser', description: 'Parses invoices.', employeeId: t.employee.id }])
    // The same call again (a retried run) doesn't make a second project.
    await t.out('projects.create_local', { name: 'Invoice parser' }, c)
    expect(t.localCreated).toHaveLength(1)
    const mine = await t.directory.projects.forContact(t.employee.data.contactId)
    expect(mine.map((m) => [m.project.data.name, m.roles])).toEqual([['Invoice parser', ['member']]])
    expect((await t.call('projects.create_local', { name: '  ' })).isError).toBe(true)
  })

  it('is in the default toolset, not the router, and not registered without the dependency', async () => {
    expect(DEFAULT_TOOLSET).toContain('projects.create_local')
    expect(ROUTER_EXCLUDED_TOOLS.some((p) => globMatch(p, 'projects.create_local'))).toBe(true)
    const t = await stack({ localProjects: false })
    expect(t.names).not.toContain('projects.create_local')
  })

  it('there is no tool that merges, whatever it is called', async () => {
    const t = await stack()
    expect(t.names.filter((n) => /merge|accept|approve_mr|fast.?forward/i.test(n))).toEqual([])
  })

  it('checks out and pushes its own branch without its SSH key, and subscribes to the branch', async () => {
    const t = await stack()
    t.deps.sshKeyFor = async () => 'fake-key-not-used'
    const { projectId } = await t.out('projects.create_local', { name: 'Parser' })
    const w = await t.out('git.checkout', { projectId })
    expect(w).toMatchObject({ key: 'harness/parser', branch: `mp/billing-bot/${t.session.data.slug}` })
    await t.out('git.write_file', { path: 'a.txt', content: 'a' })
    await t.out('git.commit', { message: 'Add a' })
    const pushed = await t.out('git.push', {})
    expect(pushed).toMatchObject({ pushed: w.branch, url: 'local:parser', review: expect.stringContaining('web UI') })
    expect(t.git.pushes).toEqual([expect.objectContaining({ url: 'local:parser', branch: w.branch })])
    // Local repositories need no credentials: the key never reaches git for them.
    expect(t.git.auths.every((a) => a.auth === undefined)).toBe(true)
    const subs = await t.events.subscriptions.forSession(t.session.id)
    expect(subs.map((s) => [s.data.subject, s.data.types, s.data.primary])).toEqual([
      [{ system: 'local-git', id: `parser/${w.branch}` }, ['branch.*'], true],
    ])
  })

  it('never pushes a protected branch of a local repository', async () => {
    const t = await stack()
    const { projectId } = await t.out('projects.create_local', { name: 'Parser' })
    await t.out('git.checkout', { projectId })
    for (const b of ['main', 'master', 'release/2026', 'refs/heads/main'])
      await expect(t.call('git.push', { branch: b }), b).rejects.toThrow(/protected/)
    await expect(t.call('git.push', { branch: 'feature/x' })).rejects.toThrow(/not allowed/)
    expect(t.git.pushes).toEqual([])
    expect(await t.events.subscriptions.forSession(t.session.id)).toEqual([])
  })
})
