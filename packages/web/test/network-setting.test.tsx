import { describe, expect, it } from 'vitest'
import { describeNetwork, networkEffect, REGISTRY_HOSTS } from '../src/components/network-setting.tsx'

describe('employee network setting', () => {
  it('describes each setting in one line', () => {
    expect(describeNetwork(undefined)).toBe("the project's allowlist")
    expect(describeNetwork('project')).toBe("the project's allowlist")
    expect(describeNetwork('none')).toBe('none')
    expect(describeNetwork({ allow: ['*'] })).toBe('any public host')
    expect(describeNetwork({ allow: [...REGISTRY_HOSTS].reverse() })).toBe('package registries (PyPI, npm)')
    expect(describeNetwork({ allow: ['pypi.org', '*.github.com:443'] })).toBe('pypi.org, *.github.com:443')
    expect(describeNetwork({ allow: [] })).toBe('none (empty list)')
  })

  it('says what the code sandbox and environments get', () => {
    // The default gives the sandbox nothing: code runs belong to no project.
    expect(networkEffect(undefined).sandbox).toMatch(/^no network/)
    expect(networkEffect('none')).toEqual({ sandbox: 'no network', environments: 'no network' })
    expect(networkEffect({ allow: ['*'] }).sandbox).toBe('any public host')
    expect(networkEffect({ allow: ['*'] }).environments).toContain("narrowed to the project's allowlist")
  })
})
