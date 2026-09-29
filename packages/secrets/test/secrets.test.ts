import { describe, expect, it } from 'vitest'
import { secretStoreContract } from '../src/contract.ts'
import { createRedactor, memorySecretStore, scopeKey, scopesFor } from '../src/index.ts'

secretStoreContract('memory', ({ clock }) => memorySecretStore({ clock }))

describe('scopes', () => {
  it('keys scopes', () => {
    expect(scopeKey({ type: 'global' })).toBe('global')
    expect(scopeKey({ type: 'employee', id: 'emp_1' })).toBe('employee:emp_1')
    expect(scopeKey({ type: 'project', id: 'prj_1' })).toBe('project:prj_1')
    expect(scopeKey({ type: 'tool', name: 'mcp.linear' })).toBe('tool:mcp.linear')
  })

  it('orders the scopes of a context from most to least specific', () => {
    expect(scopesFor({ employeeId: 'e', projectId: 'p', tool: 't' }).map(scopeKey)).toEqual([
      'tool:t',
      'project:p',
      'employee:e',
      'global',
    ])
    expect(scopesFor({}).map(scopeKey)).toEqual(['global'])
  })
})

describe('createRedactor', () => {
  it('masks values in strings', () => {
    const redact = createRedactor(['sk-test-abcdef'])
    expect(redact('token=sk-test-abcdef; again sk-test-abcdef')).toBe('token=[secret]; again [secret]')
    expect(redact('nothing here')).toBe('nothing here')
  })

  it('masks deeply in JSON, including arrays and nested objects, and keeps other types', () => {
    const redact = createRedactor(['hunter22'])
    const input = {
      a: 'pw hunter22',
      list: ['x', { deep: ['hunter22hunter22'] }],
      n: 42,
      b: true,
      nil: null,
      hunter22: 'key names are left alone',
    }
    expect(redact(input)).toEqual({
      a: 'pw [secret]',
      list: ['x', { deep: ['[secret][secret]'] }],
      n: 42,
      b: true,
      nil: null,
      hunter22: 'key names are left alone',
    })
    expect(input.a).toBe('pw hunter22') // input not mutated
  })

  it('prefers the longest of overlapping values', () => {
    const redact = createRedactor(['abcd', 'abcdefgh', 'cdef'])
    expect(redact('xx abcdefgh yy')).toBe('xx [secret] yy')
    expect(redact('abcd cdef')).toBe('[secret] [secret]')
  })

  it('ignores short and duplicate values, and uses a custom mask', () => {
    const redact = createRedactor(['abc', '', 'a', 'longer-one', 'longer-one'], '***')
    expect(redact('abc a longer-one')).toBe('abc a ***')
    const noop = createRedactor(['ab', ''])
    const obj = { x: 'ab' }
    expect(noop(obj)).toBe(obj)
  })

  it('treats values literally, not as patterns', () => {
    const redact = createRedactor(['a.b*c+(d)', '$1$&'])
    expect(redact('see a.b*c+(d) and axbbbc')).toBe('see [secret] and axbbbc')
    expect(redact('x $1$& y')).toBe('x [secret] y')
  })
})
