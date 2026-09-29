import type { Json } from '@mp/core'
import type { Condition, RecordQuery, StoredRecord, Where } from './types.ts'

/** Shared query semantics, used by the in-memory store and as the reference for adapters. */
export function normalizeWhere(where: Where | undefined): Condition[] {
  if (!where) return []
  if (Array.isArray(where)) return where
  return Object.entries(where).map(([field, value]) => ({ field, op: 'eq', value }) as Condition)
}

const TOP = new Set(['id', 'key', 'version', 'createdAt', 'updatedAt'])

export function fieldValue(record: StoredRecord<any>, field: string): unknown {
  if (TOP.has(field)) return (record as unknown as Record<string, unknown>)[field]
  let v: unknown = record.data
  for (const part of field.split('.')) {
    if (v === null || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[part]
  }
  return v
}

export function deepMatch(actual: unknown, expected: Json): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => deepMatch(actual[i], e))
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  return Object.entries(expected).every(([k, v]) => deepMatch((actual as Record<string, unknown>)[k], v))
}

function equal(a: unknown, b: Json): boolean {
  if (b !== null && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return a === b
}

export function matches(record: StoredRecord<any>, conditions: Condition[]): boolean {
  return conditions.every((c) => {
    const v = fieldValue(record, c.field)
    switch (c.op) {
      case 'eq':
        return equal(v, c.value)
      case 'ne':
        return !equal(v, c.value)
      case 'in':
        return c.value.some((x) => equal(v, x))
      case 'nin':
        return !c.value.some((x) => equal(v, x))
      case 'gt':
        return v !== undefined && v !== null && (v as any) > c.value
      case 'gte':
        return v !== undefined && v !== null && (v as any) >= c.value
      case 'lt':
        return v !== undefined && v !== null && (v as any) < c.value
      case 'lte':
        return v !== undefined && v !== null && (v as any) <= c.value
      case 'contains':
        return Array.isArray(v) && v.some((item) => deepMatch(item, c.value))
      case 'like':
        return typeof v === 'string' && v.toLowerCase().includes(c.value.toLowerCase())
      case 'exists':
        return (v !== undefined && v !== null) === c.value
      default:
        return false
    }
  })
}

export function applyQuery<T>(records: StoredRecord<T>[], q: RecordQuery = {}): { items: StoredRecord<T>[]; total: number } {
  const conds = normalizeWhere(q.where)
  const text = q.text?.toLowerCase()
  let items = records.filter((r) => matches(r, conds) && (!text || JSON.stringify(r.data).toLowerCase().includes(text)))
  const { field = 'createdAt', dir = 'asc' } = q.orderBy ?? {}
  items.sort((a, b) => {
    const av = fieldValue(a, field) as any
    const bv = fieldValue(b, field) as any
    const c =
      av === bv ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : av === undefined ? 1 : bv === undefined ? -1 : av < bv ? -1 : 1
    return dir === 'desc' ? -c : c
  })
  const total = items.length
  const offset = q.offset ?? 0
  items = items.slice(offset, q.limit === undefined ? undefined : offset + q.limit)
  return { items, total }
}
