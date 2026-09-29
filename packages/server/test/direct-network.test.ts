import { fakeSandboxRuntime } from '@mp/sandbox'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { testApp, type TestApp } from './helpers.ts'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function make(opts: Parameters<typeof testApp>[0] = {}) {
  const t = await testApp({ workers: false, ...opts })
  apps.push(t)
  return t
}

async function member(t: TestApp) {
  const c = await t.a.services.directory.contacts.create({ name: 'Mel Member', kind: 'person', access: 'member' })
  return t.as(c.id)
}

describe('DOCKER_DIRECT_NETWORK', () => {
  it('is on by default and can be turned off', () => {
    expect(loadConfig({}).DOCKER_DIRECT_NETWORK).toBe(true)
    expect(loadConfig({ DOCKER_DIRECT_NETWORK: 'false' }).DOCKER_DIRECT_NETWORK).toBe(false)
    expect(loadConfig({ DOCKER_DIRECT_NETWORK: 'true' }).DOCKER_DIRECT_NETWORK).toBe(true)
  })
})

describe('DOCKER_NAME_PREFIX', () => {
  it('defaults to mp-, and must start with mp-, end with - and stay short', async () => {
    const { describeConfig } = await import('../src/config.ts')
    expect(loadConfig({}).DOCKER_NAME_PREFIX).toBe('mp-')
    expect(loadConfig({ DOCKER_NAME_PREFIX: 'mp-e2e-' }).DOCKER_NAME_PREFIX).toBe('mp-e2e-')
    expect(loadConfig({ DOCKER_NAME_PREFIX: 'mp-a-b-1-' }).DOCKER_NAME_PREFIX).toBe('mp-a-b-1-')
    for (const bad of ['e2e-', 'mp-e2e', 'mp-E2E-', 'mp-e2e_1-', 'mp_', 'xmp-', 'mp-/-', 'mp-staging-01-'])
      expect(() => loadConfig({ DOCKER_NAME_PREFIX: bad }), bad).toThrow(/DOCKER_NAME_PREFIX/)
    expect(describeConfig(loadConfig({ DOCKER_ENABLED: 'true', DOCKER_NAME_PREFIX: 'mp-e2e-' })).docker).toEqual({
      namePrefix: 'mp-e2e-',
    })
  })
})

describe('the direct network setting is for admins only', () => {
  it('members get 403 on every route that could set it; admins set it', async () => {
    const t = await make()
    const s = t.a.services
    const emp = (await s.directory.employees.byHandle('meatless'))!
    const h = await member(t)
    const direct = { network: 'direct' }

    expect((await t.req('PATCH', `/api/records/employee/${emp.id}`, { data: direct }, h)).status).toBe(403)
    expect((await t.req('PATCH', `/api/records/employee/${emp.id}`, { data: direct, version: emp.version }, h)).status).toBe(403)
    expect((await t.req('POST', '/api/records/employee', { data: { name: 'Rogue', ...direct } }, h)).status).toBe(403)
    expect((await t.req('POST', '/api/employees', { name: 'Rogue', ...direct }, h)).status).toBe(403)
    expect((await t.req('PATCH', `/api/employees/${emp.id}`, direct, h)).status).toBe(403)
    expect((await t.req('POST', '/api/import', { records: [{ kind: 'employee', id: emp.id, data: direct }] }, h)).status).toBe(
      403,
    )
    expect((await s.directory.employees.require(emp.id)).data.network).toBeUndefined()
    expect((await s.directory.employees.list()).items.some((e) => e.data.network === 'direct')).toBe(false)

    const ok = await t.req('PATCH', `/api/records/employee/${emp.id}`, { data: direct })
    expect(ok.status).toBe(200)
    expect((await s.directory.employees.require(emp.id)).data.network).toBe('direct')
    // Anything else is refused, also for admins.
    const bad = await t.req('PATCH', `/api/records/employee/${emp.id}`, { data: { network: 'host' } })
    expect(bad.status).toBe(422)
  })
})

describe('the code sandbox and a direct network', () => {
  it("joins the employee's direct network, and none when the deployment turns it off", async () => {
    const rt = fakeSandboxRuntime()
    const t = await make({ overrides: { containers: rt } })
    const s = t.a.services
    const emp = (await s.directory.employees.byHandle('meatless'))!
    await s.directory.employees.update(emp.id, { network: 'direct' })
    await s.sandbox!.run({ employeeId: emp.id, sessionId: 'ses_direct', language: 'python', code: '1' })
    const spec = rt.envs().find((e) => e.info.labels['mp.sandbox'] === emp.id)!.spec
    expect(spec.direct).toEqual({ network: 'meatless-direct' })
    expect(spec.egress).toBeUndefined()
    expect(spec).toMatchObject({ readOnlyRootfs: true, user: '1000:1000' })

    const rt2 = fakeSandboxRuntime()
    const off = await make({
      overrides: { containers: rt2 },
      env: { DOCKER_DIRECT_NETWORK: 'false', DEFAULT_EGRESS: 'pypi.org' },
    })
    const emp2 = (await off.a.services.directory.employees.byHandle('meatless'))!
    await off.a.services.directory.employees.update(emp2.id, { network: 'direct' })
    await off.a.services.sandbox!.run({ employeeId: emp2.id, sessionId: 'ses_off', language: 'python', code: '1' })
    const spec2 = rt2.envs().find((e) => e.info.labels['mp.sandbox'] === emp2.id)!.spec
    expect(spec2.direct).toBeUndefined()
    // Not even the deployment default: a direct setting that is turned off is no network.
    expect(spec2.egress).toBeUndefined()
  })
})
