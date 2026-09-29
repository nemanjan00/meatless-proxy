import { describe, expect, it } from 'vitest'
import { directNetworkName, networkFor } from '../src/index.ts'

describe('networkFor', () => {
  it("defaults to the project's list, then the deployment default, then nothing, saying why", () => {
    expect(networkFor({ projectAllow: ['registry.npmjs.org'] })).toEqual({ allow: ['registry.npmjs.org'], source: 'project' })
    expect(networkFor({ fallback: ['pypi.org'] })).toEqual({ allow: ['pypi.org'], source: 'default' })
    expect(networkFor({ projectAllow: [], fallback: ['pypi.org'] }).source).toBe('default')
    const none = networkFor({})
    expect(none.allow).toEqual([])
    expect(none.reason).toMatch(/^no network: this session has no project with an egress allowlist and the employee has none/)
  })

  it('none overrides the project and the default', () => {
    const n = networkFor({ network: 'none', projectAllow: ['a.test'], fallback: ['b.test'] })
    expect(n).toMatchObject({ allow: [], source: 'employee-none' })
    expect(n.reason).toMatch(/network setting is none/)
  })

  it("an employee's own list: alone without a project, intersected with one", () => {
    expect(networkFor({ network: { allow: ['pypi.org'] }, fallback: ['x.test'] })).toEqual({
      allow: ['pypi.org'],
      source: 'employee',
    })
    expect(networkFor({ network: { allow: ['*'] }, projectAllow: ['registry.npmjs.org'] }).allow).toEqual(['registry.npmjs.org'])
    const disjoint = networkFor({ network: { allow: ['pypi.org'] }, projectAllow: ['registry.npmjs.org'] })
    expect(disjoint.allow).toEqual([])
    expect(disjoint.reason).toMatch(/none of the project's allowed hosts/)
  })

  it('treats a malformed setting as no network', () => {
    expect(networkFor({ network: 'everything' as never, projectAllow: ['a.test'] })).toMatchObject({
      allow: [],
      source: 'employee-none',
    })
  })

  it("direct: a real network, never narrowed by the project's allowlist or the default", () => {
    const d = { allow: [], direct: true, source: 'employee-direct' }
    expect(networkFor({ network: 'direct' })).toEqual(d)
    expect(networkFor({ network: 'direct', projectAllow: ['registry.npmjs.org'], fallback: ['pypi.org'] })).toEqual(d)
    expect(networkFor({ network: 'direct', direct: true })).toEqual(d)
  })

  it('direct turned off by the deployment falls back to no network, saying why', () => {
    const off = networkFor({ network: 'direct', projectAllow: ['registry.npmjs.org'], fallback: ['pypi.org'], direct: false })
    expect(off).toMatchObject({ allow: [], source: 'direct-disabled' })
    expect(off.direct).toBeUndefined()
    expect(off.reason).toMatch(/^no network: .*DOCKER_DIRECT_NETWORK=false/)
    // Turning direct off changes nothing for the other settings.
    expect(networkFor({ projectAllow: ['a.test'], direct: false })).toEqual({ allow: ['a.test'], source: 'project' })
    expect(networkFor({ network: { allow: ['*'] }, direct: false }).allow).toEqual(['*'])
  })
})

describe('the deployment default network (DEFAULT_NETWORK)', () => {
  it('applies to an employee with no setting of its own, and never over one it has', () => {
    expect(networkFor({ defaultNetwork: 'direct', projectAllow: ['pypi.org'] })).toMatchObject({
      direct: true,
      source: 'employee-direct',
    })
    expect(networkFor({ defaultNetwork: 'none' }).allow).toEqual([])
    expect(networkFor({ defaultNetwork: 'project', projectAllow: ['pypi.org'] })).toMatchObject({
      allow: ['pypi.org'],
      source: 'project',
    })
    // The employee's own setting wins.
    expect(networkFor({ network: 'none', defaultNetwork: 'direct' }).direct).toBeUndefined()
    expect(networkFor({ network: { allow: ['a.example.com'] }, defaultNetwork: 'direct' })).toMatchObject({
      allow: ['a.example.com'],
    })
    // Direct turned off for the deployment: no network, saying why.
    expect(networkFor({ defaultNetwork: 'direct', direct: false })).toMatchObject({ allow: [], source: 'direct-disabled' })
  })
})

describe('directNetworkName', () => {
  it('is <handle>-direct, cleaned, short and distinct', () => {
    expect(directNetworkName('ana')).toBe('ana-direct')
    expect(directNetworkName('Billing Bot!')).toBe('billing-bot-direct')
    expect(directNetworkName('')).toBe('employee-direct')
    const a = directNetworkName('x'.repeat(80))
    const b = directNetworkName(`${'x'.repeat(79)}y`)
    expect(a).not.toBe(b)
    for (const n of [a, b]) {
      expect(n).toMatch(/^[a-z0-9][a-z0-9-]*-direct$/)
      expect(n.length).toBeLessThanOrEqual(47)
    }
  })
})
