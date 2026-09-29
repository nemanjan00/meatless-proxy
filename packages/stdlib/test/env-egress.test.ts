import { generateSshKeypair } from '@mp/git'
import { describe, expect, it } from 'vitest'
import { MAX_ENV_NAME, envNameFor } from '../src/tools/env.ts'
import { PROXY_NOTE } from '../src/index.ts'
import { checkoutPath, REPO, stack } from './helpers.ts'

describe('environment names', () => {
  it('are <employee>-<session>, sanitised', () => {
    expect(envNameFor('billing-bot', 'fix-refunds')).toBe('billing-bot-fix-refunds')
    expect(envNameFor('Billing Bot!', 'Fix_Refunds  (PAY-9)')).toBe('billing-bot-fix-refunds-pay-9')
    expect(envNameFor('', '---')).toBe('employee-session')
  })

  it('are capped with a hash suffix, and stay distinct', () => {
    const a = envNameFor('billing-bot', 'a-very-long-session-slug-about-refund-edge-cases-one')
    const b = envNameFor('billing-bot', 'a-very-long-session-slug-about-refund-edge-cases-two')
    for (const n of [a, b]) {
      expect(n.length).toBeLessThanOrEqual(MAX_ENV_NAME)
      expect(n).toMatch(/^[a-z0-9][a-z0-9-]*-[0-9a-f]{6}$/)
      expect(n.startsWith('billing-bot-a-very-long')).toBe(true)
      // Every Docker name the runtime derives stays under 63 characters.
      expect(`mp-${n}-egress`.length).toBeLessThan(63)
    }
    expect(a).not.toBe(b)
    expect(envNameFor('billing-bot', 'a-very-long-session-slug-about-refund-edge-cases-one')).toBe(a)
  })
})

describe('env.up naming and egress', () => {
  it('names the environment after the employee and the session, keeping the labels', async () => {
    const t = await stack()
    await t.out('env.up', { image: 'node:22' })
    const spec = t.containers.created[0]!
    expect(spec.name).toBe(envNameFor('billing-bot', t.session.data.slug))
    expect(spec.name.startsWith('billing-bot-')).toBe(true)
    expect(spec.labels).toEqual({ 'mp.session': t.session.id, 'mp.employee': t.employee.id })
    expect(spec.egress).toBeUndefined()
  })

  it("passes the checkout's project egress allowlist", async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org', '*.github.com:443'] } })
    await t.out('git.checkout', { projectId: t.project.id })
    const up = await t.out('env.up', {})
    expect(t.containers.created[0]!.egress).toEqual({ allow: ['registry.npmjs.org', '*.github.com:443'] })
    expect(up.network).toEqual({ via: 'proxy', allow: ['registry.npmjs.org', '*.github.com:443'], note: PROXY_NOTE })
    expect(t.containers.egressAllowed(up.envId, 'api.github.com', 443)).toBe(true)
    expect(t.containers.egressAllowed(up.envId, 'evil.example.com', 443)).toBe(false)
  })

  it('uses the first linked project without a checkout', async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org'] } })
    await t.records.link({ kind: 'session', id: t.session.id }, { kind: 'project', id: t.project.id }, 'works_on')
    await t.out('env.up', { image: 'node:22' })
    expect(t.containers.created[0]!.egress).toEqual({ allow: ['registry.npmjs.org'] })
  })

  it('lets the tool narrow the allowlist, never widen it', async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org', '*.github.com:443'] } })
    await t.out('git.checkout', { projectId: t.project.id })

    const wider = await t.call('env.up', { egress: ['registry.npmjs.org', 'evil.example.com', '*.github.com'] })
    expect(wider.isError).toBe(true)
    expect(wider.output).toMatchObject({ notAllowed: ['evil.example.com', '*.github.com'] })
    expect((await t.call('env.up', { egress: ['*'] })).isError).toBe(true)
    expect((await t.call('env.up', { egress: 'registry.npmjs.org' })).isError).toBe(true)
    expect(t.containers.created).toHaveLength(0)

    await t.out('env.up', { egress: ['api.github.com:443'] })
    expect(t.containers.created[0]!.egress).toEqual({ allow: ['api.github.com:443'] })
  })

  it('narrowing to nothing is allowed; without a project allowlist there is no network', async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org'] } })
    await t.out('git.checkout', { projectId: t.project.id })
    await t.out('env.up', { egress: [] })
    expect(t.containers.created[0]!.egress).toEqual({ allow: [] })

    const u = await stack()
    await u.out('git.checkout', { projectId: u.project.id })
    expect((await u.call('env.up', { egress: ['registry.npmjs.org'] })).isError).toBe(true)
    const up = await u.out('env.up', { egress: [] })
    expect(up.network).toMatchObject({ via: 'none', reason: expect.stringMatching(/^no network: this session has no project/) })
    expect(u.containers.created.at(-1)!.egress).toBeUndefined()
    expect(u.containers.egressAllowed(up.envId, 'registry.npmjs.org', 443)).toBe(false)
  })
})

describe('git tools with the employee SSH key', () => {
  it('pass the key to fetch, checkout and push', async () => {
    const t = await stack()
    const kp = generateSshKeypair('billing-bot@example.com')
    const asked: string[] = []
    t.deps.sshKeyFor = async (id) => {
      asked.push(id)
      return kp.privateKeyOpenssh
    }
    await t.out('git.checkout', { projectId: t.project.id })
    const w = { path: await checkoutPath(t, t.session.id) }
    await t.out('git.write_file', { path: 'a.txt', content: 'a' })
    await t.out('git.commit', { message: 'a' })
    await t.out('git.push', {})
    const auth = { sshPrivateKey: kp.privateKeyOpenssh }
    expect(t.git.auths).toEqual([
      { method: 'fetch', target: REPO, auth },
      { method: 'createWorktree', target: REPO, auth },
      { method: 'push', target: w.path, auth },
    ])
    expect(new Set(asked)).toEqual(new Set([t.employee.id]))
    // The key never reaches tool output.
    expect(JSON.stringify(await t.out('git.push', {}))).not.toContain('PRIVATE')
  })

  it('run without auth when there is no key', async () => {
    const t = await stack()
    t.deps.sshKeyFor = async () => undefined
    await t.out('git.checkout', { projectId: t.project.id })
    expect(t.git.auths.map((a) => a.auth)).toEqual([undefined, undefined])
    const u = await stack()
    await u.out('git.checkout', { projectId: u.project.id })
    expect(u.git.auths.map((a) => a.auth)).toEqual([undefined, undefined])
  })
})

describe('the employee network setting', () => {
  const allowOf = (t: Awaited<ReturnType<typeof stack>>) => t.containers.created.at(-1)!.egress

  it("defaults to the project's allowlist", async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org'] } })
    await t.out('git.checkout', { projectId: t.project.id })
    await t.out('env.up', {})
    expect(allowOf(t)).toEqual({ allow: ['registry.npmjs.org'] })
  })

  it('none overrides a project list, and says why', async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org'] } })
    await t.directory.employees.update(t.employee.id, { network: 'none' })
    await t.out('git.checkout', { projectId: t.project.id })
    const up = await t.out('env.up', {})
    expect(allowOf(t)).toBeUndefined()
    expect(up.network).toEqual({ via: 'none', reason: expect.stringContaining("this employee's network setting is none") })
  })

  it('with a project, only what both allow', async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org', '*.github.com:443'] } })
    await t.directory.employees.update(t.employee.id, { network: { allow: ['api.github.com', 'pypi.org'] } })
    await t.out('git.checkout', { projectId: t.project.id })
    const up = await t.out('env.up', {})
    expect(allowOf(t)).toEqual({ allow: ['api.github.com:443'] })
    expect(t.containers.egressAllowed(up.envId, 'api.github.com', 443)).toBe(true)
    expect(t.containers.egressAllowed(up.envId, 'pypi.org', 443)).toBe(false)
    expect(t.containers.egressAllowed(up.envId, 'registry.npmjs.org', 443)).toBe(false)
  })

  it("an employee's ['*'] still only gets the project's hosts", async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org'] } })
    await t.directory.employees.update(t.employee.id, { network: { allow: ['*'] } })
    await t.out('git.checkout', { projectId: t.project.id })
    await t.out('env.up', {})
    expect(allowOf(t)).toEqual({ allow: ['registry.npmjs.org'] })
  })

  it("without a project, the employee's list, else the deployment default", async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: { allow: ['pypi.org'] } })
    await t.out('env.up', { image: 'python:3' })
    expect(allowOf(t)).toEqual({ allow: ['pypi.org'] })

    const u = await stack()
    u.deps.config.defaultEgress = ['files.pythonhosted.org']
    const up = await u.out('env.up', { image: 'python:3' })
    expect(allowOf(u)).toEqual({ allow: ['files.pythonhosted.org'] })
    expect(up.network).toMatchObject({ via: 'proxy', allow: ['files.pythonhosted.org'] })
  })

  it("the model can't widen the list, only narrow it", async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: { allow: ['pypi.org', 'files.pythonhosted.org'] } })
    const wide = await t.call('env.up', { image: 'python:3', egress: ['pypi.org', 'evil.example.com'] })
    expect(wide.isError).toBe(true)
    expect(wide.output).toMatchObject({ notAllowed: ['evil.example.com'], allowed: ['pypi.org', 'files.pythonhosted.org'] })
    expect((await t.call('env.up', { image: 'python:3', egress: ['*'] })).isError).toBe(true)
    await t.out('env.up', { image: 'python:3', egress: ['pypi.org'] })
    expect(allowOf(t)).toEqual({ allow: ['pypi.org'] })
  })

  it('rejects malformed settings', async () => {
    const t = await stack()
    await expect(t.directory.employees.update(t.employee.id, { network: 'everything' as never })).rejects.toThrow(
      /network must be/,
    )
    await expect(t.directory.employees.update(t.employee.id, { network: { allow: 'x' } as never })).rejects.toThrow(
      /network must be/,
    )
  })
})
