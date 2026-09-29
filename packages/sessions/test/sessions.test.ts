import { describe, expect, it } from 'vitest'
import { memoryStore } from '@mp/store'
import { fillPlaceholders, slugify, snippet } from '../src/index.ts'
import { sessionsSuite } from './suite.ts'

sessionsSuite('memory', async ({ bus, clock }) => memoryStore({ bus, clock }))

describe('helpers', () => {
  it('slugifies titles', () => {
    expect(slugify('Fix the Login bug!')).toBe('fix-the-login-bug')
    expect(slugify('  Crème brûlée  ')).toBe('creme-brulee')
    expect(slugify('!!!')).toBe('session')
    expect(slugify('a'.repeat(100)).length).toBe(60)
  })
  it('fills placeholders', () => {
    expect(fillPlaceholders('{{a}} {{ b }} {{c}}', { a: '1', b: '2' }, ['c'])).toBe('1 2 ')
    expect(fillPlaceholders('{{x}}', {}, [])).toBe('{{x}}')
  })
  it('makes snippets around the match', () => {
    const text = `${'a '.repeat(200)}NEEDLE${' b'.repeat(200)}`
    const s = snippet(text, 'needle')
    expect(s).toContain('NEEDLE')
    expect(s.length).toBeLessThanOrEqual(162)
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true)
    expect(snippet('short text', 'x')).toBe('short text')
  })
})
