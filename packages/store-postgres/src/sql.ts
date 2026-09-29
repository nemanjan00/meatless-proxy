import { ValidationError } from '@mp/core'
import { normalizeWhere, type Condition, type RecordQuery, type Where } from '@mp/store'

/** Quotes an SQL identifier (schema or table name). */
export function ident(name: string): string {
  if (!name) throw new ValidationError('empty SQL identifier')
  return `"${name.replace(/"/g, '""')}"`
}

/** Collects positional parameters while an SQL string is being built. */
export class Params {
  readonly values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
  /** A JSON value as a `jsonb` parameter. */
  json(value: unknown): string {
    return `${this.add(JSON.stringify(value))}::jsonb`
  }
}

/** Escapes `%`, `_` and `\` so a string matches literally inside LIKE. */
export function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** The record's timestamp formatted exactly like `Date.prototype.toISOString`. */
const iso = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const TOP: Record<string, string> = {
  id: 'to_jsonb(r.id)',
  key: `coalesce(to_jsonb(r.key), 'null'::jsonb)`,
  version: 'to_jsonb(r.version)',
  createdAt: `to_jsonb(${iso('r.created_at')})`,
  updatedAt: `to_jsonb(${iso('r.updated_at')})`,
}

const TEXT_COLS: Record<string, string> = { id: 'r.id', key: 'r.key' }

/**
 * A field as a `jsonb` expression: top-level fields are converted, anything
 * else is a dot path into `data` (SQL NULL when missing, like `undefined`).
 */
export function fieldExpr(field: string, p: Params): string {
  if (Object.hasOwn(TOP, field)) return TOP[field]!
  return `r.data #> ${p.add(field.split('.'))}::text[]`
}

const CMP = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

/** Translates one condition to an SQL boolean expression that is never NULL. */
export function conditionSql(c: Condition, p: Params): string {
  if (c.op === 'eq' && Object.hasOwn(TEXT_COLS, c.field)) {
    if (typeof c.value === 'string') return `${TEXT_COLS[c.field]} = ${p.add(c.value)}`
    if (c.value === null && c.field === 'key') return 'r.key is null'
  }
  const e = fieldExpr(c.field, p)
  switch (c.op) {
    case 'eq':
      return `coalesce(${e} = ${p.json(c.value)}, false)`
    case 'ne':
      return `(${e} = ${p.json(c.value)}) is not true`
    case 'in':
    case 'nin': {
      if (!Array.isArray(c.value)) throw new ValidationError(`${c.op} needs an array value`, [c.field])
      const any = `${e} = any(${p.add(c.value.map((v) => JSON.stringify(v)))}::jsonb[])`
      return c.op === 'in' ? `coalesce(${any}, false)` : `(${any}) is not true`
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const op = CMP[c.op]
      if (typeof c.value === 'number') {
        return `(case when jsonb_typeof(${e}) = 'number' then (${e})::numeric ${op} ${p.add(c.value)}::numeric else false end)`
      }
      if (typeof c.value === 'string') {
        return `(case when jsonb_typeof(${e}) = 'string' then (${e} #>> '{}') collate "C" ${op} ${p.add(c.value)}::text else false end)`
      }
      throw new ValidationError(`${c.op} needs a number or string value`, [c.field])
    }
    case 'contains':
      return `coalesce(jsonb_typeof(${e}) = 'array' and ${e} @> jsonb_build_array(${p.json(c.value)}), false)`
    case 'like':
      if (typeof c.value !== 'string') throw new ValidationError('like needs a string value', [(c as Condition).field])
      return `coalesce(jsonb_typeof(${e}) = 'string' and (${e} #>> '{}') ilike ${p.add(likePattern(c.value))}, false)`
    case 'exists': {
      const has = `coalesce(${e} is not null and jsonb_typeof(${e}) <> 'null', false)`
      return c.value ? has : `not ${has}`
    }
    default:
      throw new ValidationError(`unknown condition op ${(c as { op: string }).op}`)
  }
}

/** `r.kind = $n and …` for a kind plus a `Where`, and optionally a text search. */
export function whereSql(kind: string, where: Where | undefined, p: Params, text?: string): string {
  const parts = [`r.kind = ${p.add(kind)}`, ...normalizeWhere(where).map((c) => conditionSql(c, p))]
  if (text) parts.push(`r.data::text ilike ${p.add(likePattern(text))}`)
  return parts.join(' and ')
}

const ORDER_COLS: Record<string, string> = {
  id: 'r.id collate "C"',
  key: 'r.key collate "C"',
  version: 'r.version',
  createdAt: 'r.created_at',
  updatedAt: 'r.updated_at',
}

/**
 * ORDER BY for a query: top-level columns directly; data paths by number,
 * then string (byte order, like JS), then raw jsonb. Missing values sort last
 * ascending and first descending, like the in-memory store. Ties break on id.
 */
export function orderSql(orderBy: RecordQuery['orderBy'], p: Params): string {
  const field = orderBy?.field ?? 'createdAt'
  const dir = orderBy?.dir ?? 'asc'
  if (dir !== 'asc' && dir !== 'desc') throw new ValidationError(`invalid order direction ${String(dir)}`)
  const keys: string[] = []
  if (Object.hasOwn(ORDER_COLS, field)) keys.push(ORDER_COLS[field]!)
  else {
    const e = fieldExpr(field, p)
    keys.push(
      `(case when jsonb_typeof(${e}) = 'number' then (${e})::numeric end)`,
      `(case when jsonb_typeof(${e}) = 'string' then ${e} #>> '{}' end) collate "C"`,
      e,
    )
  }
  if (field !== 'id') keys.push('r.id collate "C"')
  return keys.map((k) => `${k} ${dir}`).join(', ')
}

/** LIMIT/OFFSET, validated. */
export function pageSql(q: RecordQuery, p: Params): string {
  let out = ''
  const check = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 0) throw new ValidationError(`${name} must be a non-negative integer`)
  }
  if (q.limit !== undefined) {
    check('limit', q.limit)
    out += ` limit ${p.add(q.limit)}`
  }
  if (q.offset) {
    check('offset', q.offset)
    out += ` offset ${p.add(q.offset)}`
  }
  return out
}

/** Numeric value of a field for SUM: non-numbers are ignored, like the in-memory store. */
export function numericSql(field: string, p: Params): string {
  const e = fieldExpr(field, p)
  return `(case when jsonb_typeof(${e}) = 'number' then (${e})::numeric end)`
}
