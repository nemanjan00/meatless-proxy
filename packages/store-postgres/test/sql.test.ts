import { ValidationError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { mapPgError } from '../src/index.ts'
import { Params, conditionSql, ident, likePattern, orderSql, pageSql, whereSql } from '../src/sql.ts'

describe('sql builder', () => {
  it('quotes identifiers', () => {
    expect(ident('public')).toBe('"public"')
    expect(ident('a"b')).toBe('"a""b"')
    expect(() => ident('')).toThrow(ValidationError)
  })

  it('escapes like patterns', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%')
  })

  it('binds values as parameters, never inline', () => {
    const p = new Params()
    const sql = whereSql('person', { name: "O'Brien; drop table x" }, p, 'txt')
    expect(sql).not.toContain('Brien')
    expect(p.values).toEqual(['person', ['name'], JSON.stringify("O'Brien; drop table x"), '%txt%'])
  })

  it('uses plain columns for text equality on top-level fields', () => {
    const p = new Params()
    expect(conditionSql({ field: 'id', op: 'eq', value: 'x' }, p)).toBe('r.id = $1')
    expect(conditionSql({ field: 'key', op: 'eq', value: null }, p)).toBe('r.key is null')
  })

  it('orders with an id tiebreaker and validates paging', () => {
    expect(orderSql(undefined, new Params())).toBe('r.created_at asc, r.id collate "C" asc')
    expect(orderSql({ field: 'id', dir: 'desc' }, new Params())).toBe('r.id collate "C" desc')
    expect(pageSql({ limit: 5, offset: 10 }, new Params())).toBe(' limit $1 offset $2')
    expect(() => pageSql({ limit: 1.5 }, new Params())).toThrow(ValidationError)
    expect(() => conditionSql({ field: 'a', op: 'in', value: 'x' as any }, new Params())).toThrow(ValidationError)
    expect(() => conditionSql({ field: 'a', op: 'gt', value: true as any }, new Params())).toThrow(ValidationError)
  })

  it('maps driver errors to typed errors', () => {
    const err = (code: string, message = 'boom') => Object.assign(new Error(message), { code })
    expect((mapPgError(err('23505')) as Error).name).toBe('ConflictError')
    expect((mapPgError(err('23503', 'insert or update on table violates foreign key')) as Error).name).toBe('NotFoundError')
    expect((mapPgError(err('23503', 'update or delete on table violates foreign key')) as Error).name).toBe('ConflictError')
    expect((mapPgError(err('22P05')) as Error).name).toBe('ValidationError')
    expect((mapPgError(err('ECONNREFUSED')) as Error).name).toBe('UnavailableError')
    const plain = new Error('other')
    expect(mapPgError(plain)).toBe(plain)
  })
})
