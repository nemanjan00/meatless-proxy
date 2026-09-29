import {
  ConflictError,
  MpError,
  NotFoundError,
  UnavailableError,
  ValidationError,
  newId,
  silentLogger,
  systemClock,
  type Clock,
  type EventBus,
  type Json,
  type Logger,
} from '@mp/core'
import {
  SYSTEM,
  StoreTopics,
  contentHash,
  type Actor,
  type AppendEntry,
  type Entry,
  type EntryAppended,
  type Link,
  type LinkChanged,
  type LinkQuery,
  type RecordChanged,
  type Ref,
  type Revision,
  type Store,
  type StoredRecord,
} from '@mp/store'
import pg from 'pg'
import { pendingMigrations, runMigrations } from './migrate.ts'
import { Params, ident, likePattern, numericSql, orderSql, pageSql, whereSql } from './sql.ts'

export interface PostgresStoreOptions {
  /** Use this pool. The store never ends a pool it didn't create. */
  pool?: pg.Pool
  /** Create a pool for this connection string (ended by `close()`). */
  connectionString?: string
  /** Schema holding the tables. Defaults to `public`. */
  schema?: string
  bus?: EventBus
  clock?: Clock
  logger?: Logger
  /** Apply pending migrations before returning. Off by default: the server migrates at startup. */
  migrate?: boolean
}

export interface PostgresStore extends Store {
  readonly pool: pg.Pool
  readonly schema: string
}

type Queryable = pg.Pool | pg.PoolClient
type Emit = (topic: string, payload: unknown) => void

/** How a bound store runs its SQL: on the pool, or on one transaction's client. */
interface Exec {
  read<T>(fn: (db: Queryable) => Promise<T>): Promise<T>
  /** Runs `fn` atomically. Events emitted by `fn` are published once its changes are committed. */
  write<T>(fn: (db: Queryable, emit: Emit) => Promise<T>): Promise<T>
  tx: boolean
}

const PG_UNAVAILABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  '57P01',
  '57P03',
  '08000',
  '08003',
  '08006',
])

/** Maps driver errors to the typed errors of `@mp/core`. */
export function mapPgError(e: unknown): unknown {
  if (e instanceof MpError || !(e instanceof Error)) return e
  const code = (e as { code?: string }).code
  const detail = (e as { detail?: string }).detail
  const details = { cause: e.message, ...(detail ? { detail } : {}) }
  switch (code) {
    case '23505':
    case '40001':
    case '40P01':
      return new ConflictError(e.message, details)
    case '23503':
      return /insert or update/.test(e.message)
        ? new NotFoundError('referenced record', undefined, details)
        : new ConflictError(e.message, details)
    case '22P05':
    case '22P02':
    case '22023':
    case '2201B':
      return new ValidationError(e.message, [], details)
  }
  if (code && PG_UNAVAILABLE.has(code)) return new UnavailableError(`postgres unavailable: ${e.message}`, details)
  return e
}

const toIso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())
/** JSON round trip: drops `undefined`, like storing and reading back would. */
const plain = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

interface RecordRow {
  id: string
  kind: string
  key: string | null
  version: number
  data: any
  created_at: Date
  updated_at: Date
}
interface LinkRow {
  id: string
  from_kind: string
  from_id: string
  to_kind: string
  to_id: string
  role: string
  data: any
  created_at: Date
}
interface EntryRow {
  id: string
  parent: string | null
  kind: string
  hash: string
  meta: Record<string, Json>
  content: any
  created_at: Date
}

const toRecord = (r: RecordRow): StoredRecord<any> => ({
  kind: r.kind,
  id: r.id,
  version: r.version,
  key: r.key,
  data: r.data,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
})
const toLink = (r: LinkRow): Link<any> => ({
  id: r.id,
  from: { kind: r.from_kind, id: r.from_id },
  to: { kind: r.to_kind, id: r.to_id },
  role: r.role,
  data: r.data,
  createdAt: toIso(r.created_at),
})
const toEntry = (r: EntryRow): Entry<any> => ({
  id: r.id,
  parent: r.parent,
  kind: r.kind,
  content: r.content,
  hash: r.hash,
  meta: r.meta,
  createdAt: toIso(r.created_at),
})

/**
 * The storage port on Postgres. Records, links and entries live in a few
 * tables of one schema (see `migrations/`). Every write is atomic; writes
 * inside `transaction` share one connection and publish their change
 * notifications only after COMMIT.
 */
export async function postgresStore(opts: PostgresStoreOptions = {}): Promise<PostgresStore> {
  const schema = opts.schema ?? 'public'
  const logger = opts.logger ?? silentLogger
  const clock = opts.clock ?? systemClock
  const bus = opts.bus
  const owns = !opts.pool
  if (!opts.pool && !opts.connectionString) throw new ValidationError('postgresStore needs a pool or a connectionString')
  const pool = opts.pool ?? new pg.Pool({ connectionString: opts.connectionString })
  if (owns) pool.on('error', (e) => logger.error('postgres pool error', { error: e.message }))

  try {
    if (opts.migrate) await runMigrations({ pool, schema, logger })
    const found = await pool.query<{ t: string | null }>('select to_regclass($1) as t', [`${ident(schema)}.records`])
    if (!found.rows[0]?.t) {
      throw new UnavailableError(`schema ${schema} has no store tables; run runMigrations() first`, { schema })
    }
    const pending = await pendingMigrations({ pool, schema })
    if (pending.length) logger.warn('store schema has pending migrations', { schema, pending })
  } catch (e) {
    if (owns) await pool.end().catch(() => undefined)
    throw mapPgError(e)
  }

  const s = ident(schema)
  const T = {
    records: `${s}.records`,
    revisions: `${s}.record_revisions`,
    links: `${s}.links`,
    entries: `${s}.entries`,
    blobs: `${s}.blobs`,
  }
  const publish: Emit = (t, p) => bus?.publish(t, p)

  const root: Exec = {
    tx: false,
    async read(fn) {
      try {
        return await fn(pool)
      } catch (e) {
        throw mapPgError(e)
      }
    },
    async write(fn) {
      let client: pg.PoolClient
      try {
        client = await pool.connect()
      } catch (e) {
        throw mapPgError(e)
      }
      const events: [string, unknown][] = []
      try {
        await client.query('begin')
        const result = await fn(client, (t, p) => void events.push([t, p]))
        await client.query('commit')
        client.release()
        for (const [t, p] of events) publish(t, p)
        return result
      } catch (e) {
        try {
          await client.query('rollback')
          client.release()
        } catch {
          client.release(true)
        }
        throw mapPgError(e)
      }
    },
  }

  /** One transaction on one client. Operations run one at a time, each under a savepoint. */
  const txExec = (client: pg.PoolClient, queued: [string, unknown][]) => {
    let chain: Promise<unknown> = Promise.resolve()
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn, fn)
      chain = run.catch(() => undefined)
      return run
    }
    const exec: Exec & { serial: typeof serial } = {
      tx: true,
      serial,
      read: (fn) =>
        serial(async () => {
          try {
            return await fn(client)
          } catch (e) {
            throw mapPgError(e)
          }
        }),
      write: (fn) =>
        serial(async () => {
          const events: [string, unknown][] = []
          await client.query('savepoint mp_op')
          try {
            const result = await fn(client, (t, p) => void events.push([t, p]))
            await client.query('release savepoint mp_op')
            queued.push(...events)
            return result
          } catch (e) {
            await client.query('rollback to savepoint mp_op')
            await client.query('release savepoint mp_op')
            throw mapPgError(e)
          }
        }),
    }
    return exec
  }

  const now = () => new Date(clock.now()).toISOString()

  const build = (x: Exec): PostgresStore => {
    const recordChanged = (emit: Emit, r: { kind: string; id: string; version: number }, op: RecordChanged['op'], actor: Actor) =>
      emit(StoreTopics.recordChanged, { kind: r.kind, id: r.id, version: r.version, op, actor } satisfies RecordChanged)
    const linkChanged = (emit: Emit, l: Link<any>, op: LinkChanged['op']) =>
      emit(StoreTopics.linkChanged, { id: l.id, from: l.from, to: l.to, role: l.role, op } satisfies LinkChanged)

    const addRevision = (
      db: Queryable,
      r: { kind: string; id: string; version: number },
      op: Revision['op'],
      data: unknown,
      actor: Actor,
    ) =>
      db.query(
        `insert into ${T.revisions} (record_id, kind, version, op, data, actor, at) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [r.id, r.kind, r.version, op, data === null ? null : JSON.stringify(data), JSON.stringify(actor), now()],
      )

    /** Inserts a record; returns null on a key or id conflict (without aborting the transaction). */
    const insertRecord = async (
      db: Queryable,
      emit: Emit,
      kind: string,
      data: Record<string, unknown>,
      o: { id?: string; prefix?: string; key?: string; actor?: Actor },
    ): Promise<StoredRecord<any> | null> => {
      if (!kind) throw new ValidationError('kind is required')
      if (data === null || typeof data !== 'object' || Array.isArray(data))
        throw new ValidationError('record data must be an object')
      const id = o.id ?? newId(o.prefix ?? kind.slice(0, 3), clock.now())
      const at = now()
      const res = await db.query<RecordRow>(
        `insert into ${T.records} (id, kind, key, version, data, created_at, updated_at)
         values ($1, $2, $3, 1, $4::jsonb, $5, $5) on conflict do nothing returning *`,
        [id, kind, o.key ?? null, JSON.stringify(data), at],
      )
      const row = res.rows[0]
      if (!row) return null
      const record = toRecord(row)
      const actor = o.actor ?? SYSTEM
      await addRevision(db, record, 'create', record.data, actor)
      recordChanged(emit, record, 'create', actor)
      return record
    }

    const conflictOnInsert = async (db: Queryable, kind: string, id: string | undefined, key: string | undefined) => {
      if (id !== undefined && (await db.query(`select 1 from ${T.records} where id = $1`, [id])).rowCount)
        return new ConflictError(`id ${id} already exists`)
      return new ConflictError(`${kind} with key ${key} already exists`, { key })
    }

    const getRecord = async (db: Queryable, kind: string, id: string, lock = false) =>
      (
        await db.query<RecordRow>(`select * from ${T.records} where id = $1 and kind = $2${lock ? ' for update' : ''}`, [
          id,
          kind,
        ])
      ).rows[0]

    const selectEntries = `select e.id, e.parent, e.kind, e.hash, e.meta, e.created_at, b.content from ${T.entries} e join ${T.blobs} b on b.hash = e.hash`

    const store: PostgresStore = {
      pool,
      schema,
      records: {
        create: (kind, data, o = {}) =>
          x.write(async (db, emit) => {
            const r = await insertRecord(db, emit, kind, data, o)
            if (!r) throw await conflictOnInsert(db, kind, o.id, o.key)
            return r as any
          }),

        createOrGet: (kind, key, data, o = {}) =>
          x.write(async (db, emit) => {
            for (let attempt = 0; attempt < 3; attempt++) {
              const existing = (await db.query<RecordRow>(`select * from ${T.records} where kind = $1 and key = $2`, [kind, key]))
                .rows[0]
              if (existing) return { record: toRecord(existing) as any, created: false }
              const r = await insertRecord(db, emit, kind, data, { ...o, key })
              if (r) return { record: r as any, created: true }
              if (o.id !== undefined && (await db.query(`select 1 from ${T.records} where id = $1`, [o.id])).rowCount) {
                const byKey = (await db.query<RecordRow>(`select * from ${T.records} where kind = $1 and key = $2`, [kind, key]))
                  .rows[0]
                if (byKey) return { record: toRecord(byKey) as any, created: false }
                throw new ConflictError(`id ${o.id} already exists`)
              }
            }
            throw new ConflictError(`${kind} with key ${key} is being created and deleted concurrently`)
          }),

        get: (kind, id) =>
          x.read(async (db) => {
            const row = await getRecord(db, kind, id)
            return (row ? toRecord(row) : null) as any
          }),

        getByKey: (kind, key) =>
          x.read(async (db) => {
            const row = (await db.query<RecordRow>(`select * from ${T.records} where kind = $1 and key = $2`, [kind, key]))
              .rows[0]
            return (row ? toRecord(row) : null) as any
          }),

        find: (id) =>
          x.read(async (db) => {
            const row = (await db.query<RecordRow>(`select * from ${T.records} where id = $1`, [id])).rows[0]
            return (row ? toRecord(row) : null) as any
          }),

        update: (kind, id, patch, o = {}) =>
          x.write(async (db, emit) => {
            const p = new Params()
            const sets = ['version = version + 1', `updated_at = ${p.add(now())}`]
            if (o.replace) sets.push(`data = ${p.json(patch ?? {})}`)
            else {
              const entries = Object.entries((patch ?? {}) as Record<string, unknown>)
              const removed = entries.filter(([, v]) => v === undefined).map(([k]) => k)
              const set = Object.fromEntries(entries.filter(([, v]) => v !== undefined))
              sets.push(`data = (data || ${p.json(set)}) - ${p.add(removed)}::text[]`)
            }
            if (o.key !== undefined) sets.push(`key = ${p.add(o.key)}`)
            let where = `id = ${p.add(id)} and kind = ${p.add(kind)}`
            if (o.expectedVersion !== undefined) where += ` and version = ${p.add(o.expectedVersion)}`
            const row = (
              await db.query<RecordRow>(`update ${T.records} set ${sets.join(', ')} where ${where} returning *`, p.values)
            ).rows[0]
            if (!row) {
              const current = await getRecord(db, kind, id)
              if (!current) throw new NotFoundError(kind, id)
              throw new ConflictError(`${kind} ${id} is at version ${current.version}, expected ${o.expectedVersion}`, {
                version: current.version,
              })
            }
            const next = toRecord(row)
            const actor = o.actor ?? SYSTEM
            await addRevision(db, next, 'update', next.data, actor)
            recordChanged(emit, next, 'update', actor)
            return next as any
          }),

        delete: (kind, id, o = {}) =>
          x.write(async (db, emit) => {
            const r = await getRecord(db, kind, id, true)
            if (!r) throw new NotFoundError(kind, id)
            if (o.expectedVersion !== undefined && r.version !== o.expectedVersion) {
              throw new ConflictError(`${kind} ${id} is at version ${r.version}, expected ${o.expectedVersion}`, {
                version: r.version,
              })
            }
            if (o.cascade) {
              const gone = await db.query<LinkRow>(`delete from ${T.links} where from_id = $1 or to_id = $1 returning *`, [id])
              for (const l of gone.rows.sort((a, b) => (a.id < b.id ? -1 : 1))) linkChanged(emit, toLink(l), 'unlink')
            } else {
              const n = Number(
                (await db.query<{ n: string }>(`select count(*) as n from ${T.links} where from_id = $1 or to_id = $1`, [id]))
                  .rows[0]!.n,
              )
              if (n) throw new ConflictError(`${kind} ${id} still has ${n} link(s)`)
            }
            await db.query(`delete from ${T.records} where id = $1`, [id])
            const actor = o.actor ?? SYSTEM
            const gone = { kind, id, version: r.version + 1 }
            await addRevision(db, gone, 'delete', null, actor)
            recordChanged(emit, gone, 'delete', actor)
          }),

        query: (kind, q = {}) =>
          x.read(async (db) => {
            const p = new Params()
            const where = whereSql(kind, q.where, p, q.text)
            const cp = new Params()
            const countWhere = whereSql(kind, q.where, cp, q.text)
            const order = orderSql(q.orderBy, p)
            const page = pageSql(q, p)
            const rows = await db.query<RecordRow>(
              `select r.* from ${T.records} r where ${where} order by ${order}${page}`,
              p.values,
            )
            const total = await db.query<{ n: string }>(`select count(*) as n from ${T.records} r where ${countWhere}`, cp.values)
            return { items: rows.rows.map(toRecord), total: Number(total.rows[0]!.n) } as any
          }),

        count: (kind, where) =>
          x.read(async (db) => {
            const p = new Params()
            const res = await db.query<{ n: string }>(
              `select count(*) as n from ${T.records} r where ${whereSql(kind, where, p)}`,
              p.values,
            )
            return Number(res.rows[0]!.n)
          }),

        sum: (kind, field, where) =>
          x.read(async (db) => {
            const p = new Params()
            const v = numericSql(field, p)
            const res = await db.query<{ s: number }>(
              `select coalesce(sum(${v}), 0)::float8 as s from ${T.records} r where ${whereSql(kind, where, p)}`,
              p.values,
            )
            return Number(res.rows[0]!.s)
          }),

        revisions: (kind, id) =>
          x.read(async (db) => {
            const res = await db.query<{
              kind: string
              record_id: string
              version: number
              op: Revision['op']
              data: any
              actor: Actor
              at: Date
            }>(
              `select kind, record_id, version, op, data, actor, at from ${T.revisions} where record_id = $1 and kind = $2 order by id`,
              [id, kind],
            )
            return res.rows.map((r) => ({
              kind: r.kind,
              id: r.record_id,
              version: r.version,
              op: r.op,
              data: r.data,
              actor: r.actor,
              at: toIso(r.at),
            }))
          }),

        kinds: () =>
          x.read(async (db) =>
            (await db.query<{ kind: string }>(`select distinct kind collate "C" as kind from ${T.records} order by 1`)).rows.map(
              (r) => r.kind,
            ),
          ),
      },

      links: {
        link: (from, to, role, data, _o = {}) =>
          x.write(async (db, emit) => {
            const ends = await db.query<{ id: string; kind: string }>(
              `select id, kind from ${T.records} where id = any($1::text[]) for key share`,
              [[from.id, to.id]],
            )
            const has = (ref: Ref) => ends.rows.some((r) => r.id === ref.id && r.kind === ref.kind)
            if (!has(from)) throw new NotFoundError(from.kind, from.id)
            if (!has(to)) throw new NotFoundError(to.kind, to.id)
            const existing = (
              await db.query<LinkRow>(`select * from ${T.links} where from_id = $1 and to_id = $2 and role = $3`, [
                from.id,
                to.id,
                role,
              ])
            ).rows[0]
            if (existing) return toLink(existing) as any
            const row = (
              await db.query<LinkRow>(
                `insert into ${T.links} (id, from_kind, from_id, to_kind, to_id, role, data, created_at)
                 values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) on conflict (from_id, to_id, role) do nothing returning *`,
                [newId('lnk', clock.now()), from.kind, from.id, to.kind, to.id, role, JSON.stringify(data ?? {}), now()],
              )
            ).rows[0]
            if (!row) {
              // Lost a race with an identical link: return the winner.
              const winner = (
                await db.query<LinkRow>(`select * from ${T.links} where from_id = $1 and to_id = $2 and role = $3`, [
                  from.id,
                  to.id,
                  role,
                ])
              ).rows[0]
              if (!winner) throw new ConflictError(`link ${from.id} -> ${to.id} (${role}) changed concurrently`)
              return toLink(winner) as any
            }
            const link = toLink(row)
            linkChanged(emit, link, 'link')
            return link as any
          }),

        get: (id) =>
          x.read(async (db) => {
            const row = (await db.query<LinkRow>(`select * from ${T.links} where id = $1`, [id])).rows[0]
            return row ? toLink(row) : null
          }),

        update: (id, data) =>
          x.write(async (db, emit) => {
            const row = (
              await db.query<LinkRow>(`update ${T.links} set data = $2::jsonb where id = $1 returning *`, [
                id,
                JSON.stringify(data ?? {}),
              ])
            ).rows[0]
            if (!row) throw new NotFoundError('link', id)
            const link = toLink(row)
            linkChanged(emit, link, 'update')
            return link as any
          }),

        unlink: (id) =>
          x.write(async (db, emit) => {
            const row = (await db.query<LinkRow>(`delete from ${T.links} where id = $1 returning *`, [id])).rows[0]
            if (row) linkChanged(emit, toLink(row), 'unlink')
          }),

        unlinkPair: (from, to, role) =>
          x.write(async (db, emit) => {
            const rows = (
              await db.query<LinkRow>(`delete from ${T.links} where from_id = $1 and to_id = $2 and role = $3 returning *`, [
                from.id,
                to.id,
                role,
              ])
            ).rows
            for (const row of rows) linkChanged(emit, toLink(row), 'unlink')
          }),

        query: (q: LinkQuery) =>
          x.read(async (db) => {
            const p = new Params()
            const parts: string[] = []
            const end = (col: 'from' | 'to', ref: Ref | { kind: string }) => {
              parts.push(`${col}_kind = ${p.add(ref.kind)}`)
              if ('id' in ref) parts.push(`${col}_id = ${p.add(ref.id)}`)
            }
            if (q.from) end('from', q.from)
            if (q.to) end('to', q.to)
            if (q.touching) {
              const t = p.add(q.touching.id)
              parts.push(`(from_id = ${t} or to_id = ${t})`)
            }
            if (q.role !== undefined) parts.push(`role = any(${p.add(Array.isArray(q.role) ? q.role : [q.role])}::text[])`)
            const where = parts.length ? ` where ${parts.join(' and ')}` : ''
            return (await db.query<LinkRow>(`select * from ${T.links}${where} order by id collate "C"`, p.values)).rows.map(
              toLink,
            )
          }),
      },

      entries: {
        append: (e: AppendEntry<any>) =>
          x.write(async (db, emit) => {
            if (
              e.parent !== null &&
              !(await db.query(`select 1 from ${T.entries} where id = $1 for key share`, [e.parent])).rowCount
            ) {
              throw new NotFoundError('entry', e.parent)
            }
            const id = e.id ?? newId('ent', clock.now())
            const hash = contentHash(e.content)
            const content = JSON.stringify(e.content === undefined ? null : e.content)
            await db.query(`insert into ${T.blobs} (hash, content) values ($1, $2::jsonb) on conflict (hash) do nothing`, [
              hash,
              content,
            ])
            const row = (
              await db.query<EntryRow>(
                `insert into ${T.entries} (id, parent, kind, hash, meta, created_at) values ($1, $2, $3, $4, $5::jsonb, $6)
                 on conflict (id) do nothing returning *`,
                [id, e.parent, e.kind, hash, JSON.stringify(e.meta ?? {}), now()],
              )
            ).rows[0]
            if (!row) throw new ConflictError(`entry ${id} already exists`)
            emit(StoreTopics.entryAppended, { id, parent: e.parent, kind: e.kind } satisfies EntryAppended)
            return toEntry({ ...row, content: plain(e.content) })
          }),

        get: (id) =>
          x.read(async (db) => {
            const row = (await db.query<EntryRow>(`${selectEntries} where e.id = $1`, [id])).rows[0]
            return (row ? toEntry(row) : null) as any
          }),

        getMany: (ids) =>
          x.read(async (db) => {
            if (!ids.length) return []
            const rows = (await db.query<EntryRow>(`${selectEntries} where e.id = any($1::text[])`, [ids])).rows
            const byId = new Map(rows.map((r) => [r.id, r]))
            return ids.flatMap((id) => {
              const r = byId.get(id)
              return r ? [toEntry(r) as any] : []
            })
          }),

        path: (head) =>
          x.read(async (db) => {
            const rows = (
              await db.query<EntryRow>(
                `with recursive p as (
                   select id, parent, 0 as depth from ${T.entries} where id = $1
                   union all
                   select e.id, e.parent, p.depth + 1 from ${T.entries} e join p on e.id = p.parent
                 )
                 select e.id, e.parent, e.kind, e.hash, e.meta, e.created_at, b.content
                 from p join ${T.entries} e on e.id = p.id join ${T.blobs} b on b.hash = e.hash
                 order by p.depth desc`,
                [head],
              )
            ).rows
            if (!rows.length) throw new NotFoundError('entry', head)
            return rows.map(toEntry) as any
          }),

        children: (id) =>
          x.read(
            async (db) =>
              (await db.query<EntryRow>(`${selectEntries} where e.parent = $1 order by e.seq`, [id])).rows.map(toEntry) as any,
          ),

        search: (q) =>
          x.read(async (db) => {
            const p = new Params()
            const parts = [`b.content::text ilike ${p.add(likePattern(q.text ?? ''))}`]
            if (q.kinds) parts.push(`e.kind = any(${p.add(q.kinds)}::text[])`)
            for (const [k, v] of Object.entries(q.meta ?? {})) {
              if (Array.isArray(v))
                parts.push(`coalesce(e.meta -> ${p.add(k)} = any(${p.add(v.map((x) => JSON.stringify(x)))}::jsonb[]), false)`)
              else if (v === null || typeof v !== 'object') parts.push(`e.meta @> ${p.json({ [k]: v })}`)
              else parts.push(`coalesce(e.meta -> ${p.add(k)} = ${p.json(v)}, false)`)
            }
            const where = parts.join(' and ')
            const cp = p.values.length
            const page = pageSql(q, p)
            const rows = await db.query<EntryRow>(
              `${selectEntries} where ${where} order by e.id collate "C" desc${page}`,
              p.values,
            )
            const total = await db.query<{ n: string }>(
              `select count(*) as n from ${T.entries} e join ${T.blobs} b on b.hash = e.hash where ${where}`,
              p.values.slice(0, cp),
            )
            return { items: rows.rows.map(toEntry) as any, total: Number(total.rows[0]!.n) }
          }),

        blob: (hash) =>
          x.read(async (db) => {
            const row = (await db.query<{ content: any }>(`select content from ${T.blobs} where hash = $1`, [hash])).rows[0]
            return row === undefined ? null : row.content
          }),
      },

      async transaction(fn) {
        if (x.tx) return fn(store)
        let client: pg.PoolClient
        try {
          client = await pool.connect()
        } catch (e) {
          throw mapPgError(e)
        }
        const queued: [string, unknown][] = []
        const exec = txExec(client, queued)
        try {
          await client.query('begin')
        } catch (e) {
          client.release(true)
          throw mapPgError(e)
        }
        let result: Awaited<ReturnType<typeof fn>>
        try {
          result = await fn(build(exec))
          const done = await exec.serial(() => client.query('commit'))
          // COMMIT of a transaction that hit an error outside a savepoint silently rolls back.
          if (done.command === 'ROLLBACK') throw new ConflictError('transaction was aborted by an earlier error and rolled back')
        } catch (e) {
          try {
            await exec.serial(() => client.query('rollback'))
            client.release()
          } catch {
            client.release(true)
          }
          throw mapPgError(e)
        }
        client.release()
        for (const [t, p] of queued) publish(t, p)
        return result
      },

      async close() {
        if (x.tx) return
        if (owns && !closed) {
          closed = true
          await pool.end()
        }
      },
    }
    return store
  }

  let closed = false
  return build(root)
}
