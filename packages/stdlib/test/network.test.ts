import { describe, expect, it } from 'vitest'
import { networkFor } from '../src/index.ts'

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
})
