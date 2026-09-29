import { describe, expect, it } from 'vitest'
import { describeNetwork } from '../src/components/network-setting.tsx'

describe('employee network setting', () => {
  it('describes each setting in one line', () => {
    expect(describeNetwork(undefined)).toBe("the project's allowlist")
    expect(describeNetwork('project')).toBe("the project's allowlist")
    expect(describeNetwork('none')).toBe('none')
    expect(describeNetwork({ allow: ['pypi.org', '*.github.com:443'] })).toBe('pypi.org, *.github.com:443')
    expect(describeNetwork({ allow: [] })).toBe('none (empty list)')
  })
})
