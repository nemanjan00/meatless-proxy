import { ValidationError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { ancestors, basename, employeePath, guessMime, isWithin, joinPath, normalizePath, sandboxPath } from '../src/index.ts'

describe('paths', () => {
  it('normalizes', () => {
    expect(normalizePath('notes/a.md')).toBe('/notes/a.md')
    expect(normalizePath('//notes//./a.md/')).toBe('/notes/a.md')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('')).toBe('/')
    expect(normalizePath('./.')).toBe('/')
    expect(normalizePath('/a..b/c...')).toBe('/a..b/c...')
  })

  it('rejects traversal and odd input', () => {
    for (const p of ['../etc/passwd', '/a/../../b', '/a/..', '..', 'a\\b', 'a\u0000b', 'a\nb', 'x'.repeat(2000)])
      expect(() => normalizePath(p), p).toThrow(ValidationError)
    expect(() => normalizePath(42 as any)).toThrow(ValidationError)
  })

  it('has helpers', () => {
    expect(ancestors('/a/b/c')).toEqual(['/a', '/a/b'])
    expect(ancestors('/a')).toEqual([])
    expect(isWithin('/a', '/a')).toBe(true)
    expect(isWithin('/a', '/a/b')).toBe(true)
    expect(isWithin('/a', '/ab')).toBe(false)
    expect(isWithin('/', '/x')).toBe(true)
    expect(joinPath('/a', 'b/c')).toBe('/a/b/c')
    expect(() => joinPath('/a', '../../x')).toThrow(ValidationError)
    expect(basename('/a/b.md')).toBe('b.md')
    expect(guessMime('/a.md', 'utf8')).toBe('text/markdown')
    expect(guessMime('/a', 'base64')).toBe('application/octet-stream')
    expect(guessMime('/a.weird', 'utf8')).toBe('text/plain')
  })

  it('maps code.run paths to the fs tools form, all three spellings being one file', () => {
    for (const p of ['/work/files/ipwatch.sh', 'ipwatch.sh', '/ipwatch.sh', 'work/files/ipwatch.sh', '/work/files//./ipwatch.sh'])
      expect(employeePath(p), p).toBe('/ipwatch.sh')
    expect(employeePath('/work/files/out/chart.png')).toBe('/out/chart.png')
    expect(employeePath('/work/files')).toBe('/')
    expect(employeePath('/work/files/')).toBe('/')
    expect(employeePath('/work/shared/emp_1/notes/a.md')).toBe('/shared/emp_1/notes/a.md')
    expect(employeePath('/work/shared')).toBe('/shared')
    expect(employeePath('/shared/emp_1/a.md')).toBe('/shared/emp_1/a.md')
    // Only the exact prefixes map.
    expect(employeePath('/work/filesx/a')).toBe('/work/filesx/a')
    expect(employeePath('/work/a.txt')).toBe('/work/a.txt')
    expect(sandboxPath('/ipwatch.sh')).toBe('/work/files/ipwatch.sh')
    expect(sandboxPath('/')).toBe('/work/files')
    expect(sandboxPath('/shared/emp_1/a.md')).toBe('/work/shared/emp_1/a.md')
    expect(employeePath(sandboxPath('/x/y.txt'))).toBe('/x/y.txt')
  })

  it('refuses escapes in every spelling', () => {
    for (const p of [
      '/work/files/../../etc/passwd',
      '/work/files/..',
      '/work/shared/../files/a',
      '/work/shared/emp_1/../../x',
      '../ipwatch.sh',
      '/work/files/a\\b',
      '/work/files/a\u0000',
    ])
      expect(() => employeePath(p), p).toThrow(ValidationError)
  })
})
