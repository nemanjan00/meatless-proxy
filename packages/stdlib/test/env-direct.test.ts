import { describe, expect, it } from 'vitest'
import { DIRECT_NOTE, PROXY_NOTE } from '../src/index.ts'
import { stack } from './helpers.ts'

type Stack = Awaited<ReturnType<typeof stack>>
const lastSpec = (t: Stack) => t.containers.created.at(-1)!

describe('env.up with a direct network', () => {
  it("gets the employee's direct network, not narrowed by the project's allowlist, and says so", async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org'] } })
    await t.directory.employees.update(t.employee.id, { network: 'direct' })
    await t.out('git.checkout', { projectId: t.project.id })
    const up = await t.out('env.up', { services: [{ name: 'db', image: 'postgres:18' }] })
    expect(up.network).toEqual({ via: 'direct', note: DIRECT_NOTE })
    expect(DIRECT_NOTE).toBe('unrestricted network, not logged')
    const spec = lastSpec(t)
    expect(spec.direct).toEqual({ network: 'billing-bot-direct' })
    expect(spec.egress).toBeUndefined()
    expect(spec.allowInternet).toBeUndefined()
    expect(t.containers.egressAllowed(up.envId, 'gitlab.example.com', 22)).toBe(true)
    expect(await t.containers.egressLog(up.envId)).toEqual([])
  })

  it('works without a project, and each session of the employee shares the one network', async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: 'direct' })
    await t.out('env.up', { image: 'alpine:3' })
    expect(lastSpec(t).direct).toEqual({ network: 'billing-bot-direct' })
  })

  it('the model can narrow a direct network to proxied hosts, never ask for direct', async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: 'direct' })
    const up = await t.out('env.up', { image: 'python:3', egress: ['pypi.org'] })
    expect(up.network).toEqual({ via: 'proxy', allow: ['pypi.org'], note: PROXY_NOTE })
    expect(lastSpec(t)).toMatchObject({ egress: { allow: ['pypi.org'] } })
    expect(lastSpec(t).direct).toBeUndefined()
    await t.out('env.down', {})
    // Not a hostname: refused, and nothing is created.
    const n = t.containers.created.length
    const bad = await t.call('env.up', { image: 'python:3', egress: ['not a host'] })
    expect(bad.isError).toBe(true)
    expect(t.containers.created).toHaveLength(n)
  })

  it("can't widen a proxied or empty network to direct", async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: { allow: ['*'] } })
    // An IP literal isn't covered by ['*']; a host called "direct" is just a host, through the proxy.
    expect((await t.call('env.up', { image: 'alpine:3', egress: ['1.1.1.1:53'] })).isError).toBe(true)
    const named = await t.out('env.up', { image: 'alpine:3', egress: ['direct'] })
    expect(named.network).toMatchObject({ via: 'proxy', allow: ['direct'] })
    expect(lastSpec(t).direct).toBeUndefined()
    await t.out('env.down', {})
    // Unknown params (a made-up `direct` flag) don't give one either.
    await t.out('env.up', { image: 'alpine:3', direct: true, allowInternet: true, network: 'direct' })
    expect(lastSpec(t).direct).toBeUndefined()
    expect(lastSpec(t).allowInternet).toBeUndefined()
    expect(lastSpec(t).egress).toEqual({ allow: ['*'] })

    const u = await stack()
    await u.directory.employees.update(u.employee.id, { network: 'none' })
    expect((await u.call('env.up', { image: 'alpine:3', egress: ['direct'] })).isError).toBe(true)
    expect(u.containers.created).toHaveLength(0)
  })

  it('falls back to no network when the deployment turns direct networks off', async () => {
    const t = await stack()
    t.deps.config.directNetwork = false
    await t.directory.projects.update(t.project.id, { egress: { allow: ['registry.npmjs.org'] } })
    await t.directory.employees.update(t.employee.id, { network: 'direct' })
    await t.out('git.checkout', { projectId: t.project.id })
    const up = await t.out('env.up', {})
    expect(up.network).toEqual({ via: 'none', reason: expect.stringContaining('DOCKER_DIRECT_NETWORK=false') })
    expect(lastSpec(t).direct).toBeUndefined()
    expect(lastSpec(t).egress).toBeUndefined()
    expect(t.containers.egressAllowed(up.envId, 'registry.npmjs.org', 443)).toBe(false)
  })

  it('a running environment keeps the network it started with, and says so after a change', async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: { allow: ['pypi.org'] } })
    const first = await t.out('env.up', { image: 'python:3' })
    expect(first.network).toMatchObject({ via: 'proxy' })

    const same = await t.out('env.up', { image: 'python:3' })
    expect(same).toMatchObject({ existing: true, network: { via: 'proxy', allow: ['pypi.org'] } })
    expect(same.note).toBeUndefined()

    await t.directory.employees.update(t.employee.id, { network: 'direct' })
    const again = await t.out('env.up', { image: 'python:3' })
    expect(again).toMatchObject({ existing: true, envId: first.envId, network: { via: 'proxy' } })
    expect(again.note).toMatch(/network setting changed since this environment started: it keeps the network it started with/)
    expect(t.containers.created).toHaveLength(1)

    // After env.down, the new setting applies.
    await t.out('env.down', {})
    const fresh = await t.out('env.up', { image: 'python:3' })
    expect(fresh.network).toEqual({ via: 'direct', note: DIRECT_NOTE })
    await t.directory.employees.update(t.employee.id, { network: 'none' })
    expect((await t.out('env.up', { image: 'python:3' })).note).toMatch(/keeps the network it started with/)
  })
})
