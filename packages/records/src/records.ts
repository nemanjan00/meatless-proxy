import {
  NotFoundError,
  ValidationError,
  allFields,
  extendSchema,
  validateRecord,
  type EventBus,
  type FieldDef,
  type KindSchema,
} from '@mp/core'
import {
  SYSTEM,
  type Actor,
  type Link,
  type LinkQuery,
  type Page,
  type RecordQuery,
  type Ref,
  type Revision,
  type Store,
  type StoredRecord,
} from '@mp/store'
import { parseDocLinks } from './doclinks.ts'

/** Role of the links kept automatically from records to what their text fields mention. */
export const MENTIONS = 'mentions'

export interface KindRegistry {
  /** Declares a kind. Declaring the same kind again replaces its core fields but keeps extensions. */
  define(schema: KindSchema): KindSchema
  /** Adds deployment-specific fields to a kind. Core fields can't be touched. */
  extend(kind: string, fields: FieldDef[]): KindSchema
  get(kind: string): KindSchema
  has(kind: string): boolean
  list(): KindSchema[]
}

export interface LinkedRecord<T = Record<string, unknown>> {
  link: Link
  record: StoredRecord<T>
}

export interface Records {
  readonly kinds: KindRegistry
  /** The underlying store, for domain packages that need entries or transactions. */
  readonly store: Store
  create<T extends Record<string, unknown>>(
    kind: string,
    data: T,
    opts?: { actor?: Actor; key?: string; id?: string },
  ): Promise<StoredRecord<T>>
  get<T = Record<string, unknown>>(kind: string, id: string): Promise<StoredRecord<T> | null>
  /** Like `get`, but throws `NotFoundError`. */
  require<T = Record<string, unknown>>(kind: string, id: string): Promise<StoredRecord<T>>
  getByKey<T = Record<string, unknown>>(kind: string, key: string): Promise<StoredRecord<T> | null>
  find<T = Record<string, unknown>>(id: string): Promise<StoredRecord<T> | null>
  update<T = Record<string, unknown>>(
    kind: string,
    id: string,
    patch: Partial<T>,
    opts?: { actor?: Actor; expectedVersion?: number; replace?: boolean; key?: string | null },
  ): Promise<StoredRecord<T>>
  delete(kind: string, id: string, opts?: { actor?: Actor; cascade?: boolean }): Promise<void>
  query<T = Record<string, unknown>>(kind: string, q?: RecordQuery): Promise<Page<T>>
  revisions<T = Record<string, unknown>>(kind: string, id: string): Promise<Revision<T>[]>

  link(from: Ref, to: Ref, role: string, data?: Record<string, unknown>, opts?: { actor?: Actor }): Promise<Link>
  unlink(from: Ref, to: Ref, role: string, opts?: { actor?: Actor }): Promise<void>
  links(q: LinkQuery): Promise<Link[]>
  /**
   * Records linked to `ref`: `out` follows links from it, `in` follows links to
   * it, `both` does both. Filters by role and by the other end's kind.
   */
  linked<T = Record<string, unknown>>(
    ref: Ref,
    opts?: { direction?: 'out' | 'in' | 'both'; role?: string | string[]; kind?: string },
  ): Promise<LinkedRecord<T>[]>
  /** Records whose text fields mention `ref` with `[[kind:id]]`. */
  backlinks(ref: Ref): Promise<StoredRecord[]>
  /**
   * Runs `fn` with a `Records` bound to one store transaction: everything it
   * writes commits together or not at all. Nested calls reuse the transaction.
   */
  transaction<T>(fn: (tx: Records) => Promise<T>): Promise<T>
}

export interface RecordsOptions {
  store: Store
  bus?: EventBus
}

export function createKindRegistry(): KindRegistry {
  const kinds = new Map<string, KindSchema>()
  return {
    define(schema) {
      const prev = kinds.get(schema.kind)
      const next = prev?.extensions?.length ? extendSchema({ ...schema, extensions: [] }, prev.extensions) : schema
      kinds.set(schema.kind, next)
      return next
    },
    extend(kind, fields) {
      const next = extendSchema(this.get(kind), fields)
      kinds.set(kind, next)
      return next
    },
    get(kind) {
      const s = kinds.get(kind)
      if (!s) throw new NotFoundError('record kind', kind)
      return s
    },
    has: (kind) => kinds.has(kind),
    list: () => [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
  }
}

/**
 * Generic records on top of the storage port. Every write is validated
 * against the kind's schema, and `[[kind:id]]` mentions in text fields are
 * kept in sync as `mentions` links, so backlinks are a link query.
 */
export function createRecords(opts: RecordsOptions): Records {
  return buildRecords(opts.store, createKindRegistry())
}

function buildRecords(store: Store, kinds: KindRegistry): Records {
  const textFields = (schema: KindSchema) =>
    allFields(schema)
      .filter((f) => f.type === 'text')
      .map((f) => f.name)

  const syncMentions = async (tx: Store, kind: string, id: string, data: Record<string, unknown>, actor: Actor) => {
    const schema = kinds.get(kind)
    const fields = textFields(schema)
    if (!fields.length) return
    const wanted = new Map<string, Ref>()
    for (const f of fields) {
      const v = data[f]
      if (typeof v === 'string') for (const l of parseDocLinks(v)) if (l.id !== id) wanted.set(l.id, { kind: l.kind, id: l.id })
    }
    const from = { kind, id }
    const existing = await tx.links.query({ from, role: MENTIONS })
    for (const l of existing) if (!wanted.has(l.to.id)) await tx.links.unlink(l.id, { actor })
    const have = new Set(existing.map((l) => l.to.id))
    for (const ref of wanted.values()) {
      if (have.has(ref.id)) continue
      // Mentions of records that don't exist (yet) are simply not linked.
      if (await tx.records.get(ref.kind, ref.id)) await tx.links.link(from, ref, MENTIONS, {}, { actor })
    }
  }

  const records: Records = {
    kinds,
    store,

    async create(kind, data, o = {}) {
      const schema = kinds.get(kind)
      validateRecord(schema, data)
      const actor = o.actor ?? SYSTEM
      return store.transaction(async (tx) => {
        const r = await tx.records.create(kind, data, {
          actor,
          prefix: schema.prefix,
          ...(o.key !== undefined ? { key: o.key } : {}),
          ...(o.id !== undefined ? { id: o.id } : {}),
        })
        await syncMentions(tx, kind, r.id, r.data, actor)
        return r
      })
    },

    get: (kind, id) => store.records.get(kind, id),

    async require(kind, id) {
      const r = await store.records.get<any>(kind, id)
      if (!r) throw new NotFoundError(kind, id)
      return r
    },

    getByKey: (kind, key) => store.records.getByKey(kind, key),
    find: (id) => store.records.find(id),

    async update(kind, id, patch, o = {}) {
      const schema = kinds.get(kind)
      const actor = o.actor ?? SYSTEM
      return store.transaction(async (tx) => {
        const current = await tx.records.get<any>(kind, id)
        if (!current) throw new NotFoundError(kind, id)
        const merged = o.replace ? { ...(patch as object) } : { ...current.data, ...(patch as object) }
        for (const [k, v] of Object.entries(merged)) if (v === undefined) delete (merged as any)[k]
        validateRecord(schema, merged)
        const r = await tx.records.update<any>(kind, id, patch as any, {
          actor,
          ...(o.expectedVersion !== undefined ? { expectedVersion: o.expectedVersion } : {}),
          ...(o.replace ? { replace: true } : {}),
          ...(o.key !== undefined ? { key: o.key } : {}),
        })
        await syncMentions(tx, kind, id, r.data, actor)
        return r
      })
    },

    async delete(kind, id, o = {}) {
      const actor = o.actor ?? SYSTEM
      await store.transaction(async (tx) => {
        // Mentions are ours to clean up; other links need an explicit cascade.
        for (const l of await tx.links.query({ from: { kind, id }, role: MENTIONS })) await tx.links.unlink(l.id, { actor })
        for (const l of await tx.links.query({ to: { kind, id }, role: MENTIONS })) await tx.links.unlink(l.id, { actor })
        await tx.records.delete(kind, id, { actor, ...(o.cascade ? { cascade: true } : {}) })
      })
    },

    query: (kind, q) => {
      kinds.get(kind)
      return store.records.query(kind, q)
    },

    revisions: (kind, id) => store.records.revisions(kind, id),

    async link(from, to, role, data, o = {}) {
      if (role === MENTIONS) throw new ValidationError(`the ${MENTIONS} role is managed automatically`)
      return store.links.link(from, to, role, data ?? {}, { actor: o.actor ?? SYSTEM })
    },

    unlink: (from, to, role, o = {}) => store.links.unlinkPair(from, to, role, { actor: o.actor ?? SYSTEM }),

    links: (q) => store.links.query(q),

    async linked(ref, o = {}) {
      const dir = o.direction ?? 'both'
      const role = o.role
      const out: LinkedRecord<any>[] = []
      const collect = async (ls: Link[], other: (l: Link) => Ref) => {
        for (const l of ls) {
          const end = other(l)
          if (o.kind && end.kind !== o.kind) continue
          const r = await store.records.get(end.kind, end.id)
          if (r) out.push({ link: l, record: r })
        }
      }
      if (dir !== 'in') await collect(await store.links.query({ from: ref, ...(role ? { role } : {}) }), (l) => l.to)
      if (dir !== 'out') await collect(await store.links.query({ to: ref, ...(role ? { role } : {}) }), (l) => l.from)
      return out
    },

    transaction: (fn) => store.transaction((tx) => fn(buildRecords(tx, kinds))),

    async backlinks(ref) {
      const ls = await store.links.query({ to: ref, role: MENTIONS })
      const out: StoredRecord[] = []
      for (const l of ls) {
        const r = await store.records.get(l.from.kind, l.from.id)
        if (r) out.push(r)
      }
      return out
    },
  }
  return records
}
