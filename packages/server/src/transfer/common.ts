import { allFields, stableStringify } from '@mp/core'
import { slugify } from '@mp/directory'
import type { Records } from '@mp/records'
import type { StoredRecord } from '@mp/store'

const PAGE = 500

/** Every record of a kind, ordered by id (ids are time-ordered, so this is creation order). */
export async function listAll<T>(records: Records, kind: string): Promise<StoredRecord<T>[]> {
  const out: StoredRecord<T>[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { items } = await records.query<T>(kind, { limit: PAGE, offset, orderBy: { field: 'createdAt' } })
    out.push(...items)
    if (items.length < PAGE) break
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Unique, stable slugs: the first record (by id) gets `ana`, the next `ana-2`. */
export function assignSlugs<T extends { id: string }>(
  items: T[],
  name: (t: T) => string,
  fallback = 'item',
): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const it of [...items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const base = slugify(name(it)) || fallback
    let s = base
    for (let n = 2; used.has(s); n++) s = `${base}-${n}`
    used.add(s)
    out.set(it.id, s)
  }
  return out
}

/** Fields never exported: runtime pointers and anything that looks like a credential. */
export const RUNTIME_FIELDS: Record<string, string[]> = {
  employee: ['routerSessionId', 'sshPublicKey', 'sshKeyCreatedAt'],
  procedure: ['contextSessionId'],
}
const SECRETISH = /secret|token|password|passwd|private.?key|api.?key|credential/i

export function exportable(kind: string, field: string): boolean {
  return !(RUNTIME_FIELDS[kind] ?? []).includes(field) && !SECRETISH.test(field)
}

/** Names of a kind's `text` fields (where `[[kind:id]]` links live). */
export function textFields(records: Records, kind: string): string[] {
  return allFields(records.kinds.get(kind))
    .filter((f) => f.type === 'text')
    .map((f) => f.name)
}

/** Keys sorted, `id` first. */
export function orderedFields(id: string | undefined, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = id ? { id } : {}
  for (const k of Object.keys(data).sort()) if (data[k] !== undefined && data[k] !== null) out[k] = data[k]
  return out
}

/** Comparable form of a value: stable JSON, with trailing whitespace of strings ignored. */
export function comparable(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (typeof x === 'string') return x.replace(/\s+$/, '')
    if (Array.isArray(x)) return x.map(norm)
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, norm(y)]))
    return x
  }
  return stableStringify(norm(v) ?? null)
}

export const sameValue = (a: unknown, b: unknown) => comparable(a) === comparable(b)

const LINK_RE = /\[\[([a-z][a-z0-9_-]*):([a-z][a-z0-9]*_[0-9A-Za-z]+)(\|[^\]]*)?\]\]/g

/** Replaces record ids through `map`: whole string values that are ids, and ids inside `[[kind:id]]` links. */
export function remapIds<T>(value: T, map: Map<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = map.get(v)
      if (whole) return whole
      return v.includes('[[')
        ? v.replace(LINK_RE, (m, kind, id, label) => (map.has(id) ? `[[${kind}:${map.get(id)}${label ?? ''}]]` : m))
        : v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

/** A doc path made safe for a file name: each segment slugified. */
export function safeDocPath(path: string | undefined, title: string, id: string): string {
  const segs = (path ?? '')
    .split('/')
    .map((s) => slugify(s))
    .filter(Boolean)
  if (segs.length) return segs.join('/')
  return slugify(title) || id
}

/** The key the skills service gives a skill: its scope and lowercased name. */
export const skillKey = (d: { name: string; scope: { type: string; projectId?: string } }) =>
  `${d.scope.type === 'company' ? 'company' : d.scope.projectId}:${d.name.trim().toLowerCase()}`
