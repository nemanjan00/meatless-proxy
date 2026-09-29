import { ValidationError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { ancestors, basename, guessMime, isWithin, joinPath, normalizePath } from '../src/index.ts'

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
})
