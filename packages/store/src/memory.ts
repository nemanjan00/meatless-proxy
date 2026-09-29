import { ConflictError, NotFoundError, ValidationError, newId, systemClock, type Clock, type EventBus, type Json } from '@mp/core'
import { contentHash } from './hash.ts'
import { applyQuery, fieldValue, normalizeWhere, matches } from './match.ts'
import {
  SYSTEM,
  StoreTopics,
  type Actor,
  type AppendEntry,
  type Entry,
  type Link,
  type LinkQuery,
  type RecordChanged,
  type Ref,
  type Revision,
  type Store,
  type StoredRecord,
} from './types.ts'

export interface StoreOptions {
  bus?: EventBus
  clock?: Clock
}

interface State {
  records: Map<string, StoredRecord<any>> // by id
  keys: Map<string, string> // `${kind}\0${key}` -> id
  revisions: Map<string, Revision<any>[]> // by id
  links: Map<string, Link<any>>
  entries: Map<string, Omit<Entry, 'content'>>
  blobs: Map<string, Json>
  children: Map<string, string[]>
}

const clone = <T>(v: T): T => structuredClone(v)

function emptyState(): State {
  return {
    records: new Map(),
    keys: new Map(),
    revisions: new Map(),
    links: new Map(),
    entries: new Map(),
    blobs: new Map(),
    children: new Map(),
  }
}

function copyState(s: State): State {
  return {
    records: new Map(s.records),
    keys: new Map(s.keys),
    revisions: new Map([...s.revisions].map(([k, v]) => [k, [...v]])),
    links: new Map(s.links),
    entries: new Map(s.entries),
    blobs: new Map(s.blobs),
    children: new Map([...s.children].map(([k, v]) => [k, [...v]])),
  }
}

/**
 * The reference implementation of the storage port. Everything is kept in
 * memory; values are cloned on the way in and out, so callers can't mutate
 * stored data by accident.
 */
export function memoryStore(opts: StoreOptions = {}): Store {
  const clock = opts.clock ?? systemClock
  const shared = { state: emptyState() }
  let lock: Promise<unknown> = Promise.resolve()

  // Serialises writes and transactions, like row locks would.
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => undefined)
    return run
  }

  const build = (getState: () => State, publish: (topic: string, payload: unknown) => void, inTx: boolean): Store => {
    const write = <T>(fn: (s: State) => T | Promise<T>): Promise<T> =>
      inTx ? Promise.resolve(fn(getState())) : exclusive(async () => fn(getState()))

    const keyOf = (kind: string, key: string) => `${kind}\u0000${key}`
    const now = () => new Date(clock.now()).toISOString()
    const addRevision = (s: State, r: StoredRecord<any>, op: Revision['op'], actor: Actor, data: unknown) => {
      const list = s.revisions.get(r.id) ?? []
      list.push({ kind: r.kind, id: r.id, version: r.version, op, data: data === null ? null : clone(data), actor, at: now() })
      s.revisions.set(r.id, list)
    }
    const recordChanged = (r: StoredRecord<any>, op: RecordChanged['op'], actor: Actor) =>
      publish(StoreTopics.recordChanged, { kind: r.kind, id: r.id, version: r.version, op, actor } satisfies RecordChanged)

    const createIn = (
      s: State,
      kind: string,
      data: Record<string, unknown>,
      o: { id?: string; prefix?: string; key?: string; actor?: Actor },
    ) => {
      if (!kind) throw new ValidationError('kind is required')
      const id = o.id ?? newId(o.prefix ?? kind.slice(0, 3), clock.now())
      if (s.records.has(id)) throw new ConflictError(`id ${id} already exists`)
      if (o.key !== undefined && s.keys.has(keyOf(kind, o.key)))
        throw new ConflictError(`${kind} with key ${o.key} already exists`, { key: o.key })
      const at = now()
      const record: StoredRecord<any> = {
        kind,
        id,
        version: 1,
        key: o.key ?? null,
        data: clone(data),
        createdAt: at,
        updatedAt: at,
      }
      s.records.set(id, record)
      if (o.key !== undefined) s.keys.set(keyOf(kind, o.key), id)
      const actor = o.actor ?? SYSTEM
      addRevision(s, record, 'create', actor, record.data)
      recordChanged(record, 'create', actor)
      return clone(record)
    }

    const getIn = (s: State, kind: string, id: string) => {
      const r = s.records.get(id)
      return r && r.kind === kind ? r : undefined
    }

    const linkEnd = (s: State, ref: Ref) => {
      if (!getIn(s, ref.kind, ref.id)) throw new NotFoundError(ref.kind, ref.id)
    }

    const refMatch = (actual: Ref, q: Ref | { kind: string }) => actual.kind === q.kind && (!('id' in q) || actual.id === q.id)

    const store: Store = {
      records: {
        create: (kind, data, o = {}) => write((s) => createIn(s, kind, data, o)),

        createOrGet: (kind, key, data, o = {}) =>
          write((s) => {
            const existing = s.keys.get(keyOf(kind, key))
            if (existing) return { record: clone(s.records.get(existing)!), created: false }
            return { record: createIn(s, kind, data, { ...o, key }), created: true }
          }),

        async get(kind, id) {
          const r = getIn(getState(), kind, id)
          return r ? clone(r) : null
        },

        async getByKey(kind, key) {
          const s = getState()
          const id = s.keys.get(keyOf(kind, key))
          return id ? clone(s.records.get(id)!) : null
        },

        async find(id) {
          const r = getState().records.get(id)
          return r ? clone(r) : null
        },

        update: (kind, id, patch, o = {}) =>
          write((s) => {
            const r = getIn(s, kind, id)
            if (!r) throw new NotFoundError(kind, id)
            if (o.expectedVersion !== undefined && r.version !== o.expectedVersion) {
              throw new ConflictError(`${kind} ${id} is at version ${r.version}, expected ${o.expectedVersion}`, {
                version: r.version,
              })
            }
            let data: Record<string, unknown>
            if (o.replace) data = clone(patch as Record<string, unknown>)
            else {
              data = { ...r.data }
              for (const [k, v] of Object.entries(clone(patch as Record<string, unknown>))) {
                if (v === undefined) delete data[k]
                else data[k] = v
              }
            }
            let key = r.key
            if (o.key !== undefined && o.key !== r.key) {
              if (o.key !== null && s.keys.has(keyOf(kind, o.key)))
                throw new ConflictError(`${kind} with key ${o.key} already exists`)
              if (r.key !== null) s.keys.delete(keyOf(kind, r.key))
              if (o.key !== null) s.keys.set(keyOf(kind, o.key), id)
              key = o.key
            }
            const next: StoredRecord<any> = { ...r, key, data, version: r.version + 1, updatedAt: now() }
            s.records.set(id, next)
            const actor = o.actor ?? SYSTEM
            addRevision(s, next, 'update', actor, data)
            recordChanged(next, 'update', actor)
            return clone(next)
          }),

        delete: (kind, id, o = {}) =>
          write((s) => {
            const r = getIn(s, kind, id)
            if (!r) throw new NotFoundError(kind, id)
            if (o.expectedVersion !== undefined && r.version !== o.expectedVersion) {
              throw new ConflictError(`${kind} ${id} is at version ${r.version}, expected ${o.expectedVersion}`)
            }
            const touching = [...s.links.values()].filter((l) => l.from.id === id || l.to.id === id)
            if (touching.length && !o.cascade) throw new ConflictError(`${kind} ${id} still has ${touching.length} link(s)`)
            for (const l of touching) {
              s.links.delete(l.id)
              publish(StoreTopics.linkChanged, { id: l.id, from: l.from, to: l.to, role: l.role, op: 'unlink' })
            }
            s.records.delete(id)
            if (r.key !== null) s.keys.delete(keyOf(kind, r.key))
            const actor = o.actor ?? SYSTEM
            addRevision(s, { ...r, version: r.version + 1 }, 'delete', actor, null)
            recordChanged({ ...r, version: r.version + 1 }, 'delete', actor)
          }),

        async query(kind, q) {
          const all = [...getState().records.values()].filter((r) => r.kind === kind)
          const res = applyQuery(all, q)
          return { items: res.items.map(clone), total: res.total } as any
        },

        async count(kind, where) {
          const conds = normalizeWhere(where)
          return [...getState().records.values()].filter((r) => r.kind === kind && matches(r, conds)).length
        },

        async sum(kind, field, where) {
          const conds = normalizeWhere(where)
          let total = 0
          for (const r of getState().records.values()) {
            if (r.kind !== kind || !matches(r, conds)) continue
            const v = fieldValue(r, field)
            if (typeof v === 'number') total += v
          }
          return total
        },

        async revisions(kind, id) {
          return clone((getState().revisions.get(id) ?? []).filter((r) => r.kind === kind)) as any
        },

        async kinds() {
          return [...new Set([...getState().records.values()].map((r) => r.kind))].sort()
        },
      },

      links: {
        link: (from, to, role, data, o = {}) =>
          write((s) => {
            linkEnd(s, from)
            linkEnd(s, to)
            const existing = [...s.links.values()].find((l) => l.from.id === from.id && l.to.id === to.id && l.role === role)
            if (existing) return clone(existing) as any
            const link: Link<any> = {
              id: newId('lnk', clock.now()),
              from: { kind: from.kind, id: from.id },
              to: { kind: to.kind, id: to.id },
              role,
              data: clone(data ?? {}),
              createdAt: now(),
            }
            s.links.set(link.id, link)
            void o
            publish(StoreTopics.linkChanged, { id: link.id, from: link.from, to: link.to, role, op: 'link' })
            return clone(link)
          }),

        async get(id) {
          const l = getState().links.get(id)
          return l ? clone(l) : null
        },

        update: (id, data) =>
          write((s) => {
            const l = s.links.get(id)
            if (!l) throw new NotFoundError('link', id)
            const next = { ...l, data: clone(data) }
            s.links.set(id, next)
            publish(StoreTopics.linkChanged, { id, from: l.from, to: l.to, role: l.role, op: 'update' })
            return clone(next) as any
          }),

        unlink: (id) =>
          write((s) => {
            const l = s.links.get(id)
            if (!l) return
            s.links.delete(id)
            publish(StoreTopics.linkChanged, { id, from: l.from, to: l.to, role: l.role, op: 'unlink' })
          }),

        unlinkPair: (from, to, role) =>
          write((s) => {
            for (const l of [...s.links.values()]) {
              if (l.from.id === from.id && l.to.id === to.id && l.role === role) {
                s.links.delete(l.id)
                publish(StoreTopics.linkChanged, { id: l.id, from: l.from, to: l.to, role, op: 'unlink' })
              }
            }
          }),

        async query(q: LinkQuery) {
          const roles = q.role === undefined ? undefined : Array.isArray(q.role) ? q.role : [q.role]
          return [...getState().links.values()]
            .filter(
              (l) =>
                (!q.from || refMatch(l.from, q.from)) &&
                (!q.to || refMatch(l.to, q.to)) &&
                (!q.touching || l.from.id === q.touching.id || l.to.id === q.touching.id) &&
                (!roles || roles.includes(l.role)),
            )
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map(clone)
        },
      },

      entries: {
        append: (e: AppendEntry<any>) =>
          write((s) => {
            if (e.parent !== null && !s.entries.has(e.parent)) throw new NotFoundError('entry', e.parent)
            const id = e.id ?? newId('ent', clock.now())
            if (s.entries.has(id)) throw new ConflictError(`entry ${id} already exists`)
            const hash = contentHash(e.content)
            if (!s.blobs.has(hash)) s.blobs.set(hash, clone(e.content))
            const entry = { id, parent: e.parent, kind: e.kind, hash, meta: clone(e.meta ?? {}), createdAt: now() }
            s.entries.set(id, entry)
            if (e.parent !== null) s.children.set(e.parent, [...(s.children.get(e.parent) ?? []), id])
            publish(StoreTopics.entryAppended, { id, parent: e.parent, kind: e.kind })
            return { ...clone(entry), content: clone(e.content) }
          }),

        async get(id) {
          const s = getState()
          const e = s.entries.get(id)
          return e ? ({ ...clone(e), content: clone(s.blobs.get(e.hash)) } as any) : null
        },

        async getMany(ids) {
          const s = getState()
          return ids.flatMap((id) => {
            const e = s.entries.get(id)
            return e ? [{ ...clone(e), content: clone(s.blobs.get(e.hash)) } as any] : []
          })
        },

        async path(head) {
          const s = getState()
          const out: Entry<any>[] = []
          let cur: string | null = head
          while (cur !== null) {
            const e = s.entries.get(cur)
            if (!e) throw new NotFoundError('entry', cur)
            out.push({ ...clone(e), content: clone(s.blobs.get(e.hash)) })
            cur = e.parent
          }
          return out.reverse()
        },

        async children(id) {
          const s = getState()
          return (s.children.get(id) ?? []).map((cid) => {
            const e = s.entries.get(cid)!
            return { ...clone(e), content: clone(s.blobs.get(e.hash)) } as any
          })
        },

        async search(q) {
          const s = getState()
          const text = q.text.toLowerCase()
          const metaOk = (meta: Record<string, Json>) =>
            Object.entries(q.meta ?? {}).every(([k, v]) =>
              Array.isArray(v)
                ? v.some((x) => JSON.stringify(x) === JSON.stringify(meta[k]))
                : JSON.stringify(v) === JSON.stringify(meta[k]),
            )
          const all = [...s.entries.values()]
            .filter((e) => (!q.kinds || q.kinds.includes(e.kind)) && metaOk(e.meta))
            .filter((e) => JSON.stringify(s.blobs.get(e.hash)).toLowerCase().includes(text))
            .sort((a, b) => (a.id < b.id ? 1 : -1))
          const offset = q.offset ?? 0
          const page = all.slice(offset, q.limit === undefined ? undefined : offset + q.limit)
          return { items: page.map((e) => ({ ...clone(e), content: clone(s.blobs.get(e.hash)) }) as any), total: all.length }
        },

        async blob(hash) {
          const b = getState().blobs.get(hash)
          return b === undefined ? null : (clone(b) as any)
        },
      },

      async transaction(fn) {
        if (inTx) return fn(store)
        return exclusive(async () => {
          const draft = { state: copyState(shared.state) }
          const queued: [string, unknown][] = []
          const tx = build(
            () => draft.state,
            (t, p) => void queued.push([t, p]),
            true,
          )
          const result = await fn(tx)
          shared.state = draft.state
          for (const [t, p] of queued) publish(t, p)
          return result
        })
      },

      async close() {},
    }
    return store
  }

  return build(
    () => shared.state,
    (t, p) => opts.bus?.publish(t, p),
    false,
  )
}
