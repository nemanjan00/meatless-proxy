import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConflictError, ManualClock, UnavailableError, ValidationError, createEventBus, memoryLogger, type Json } from '@mp/core'
import { StoreTopics, memoryStore, type Condition, type RecordQuery, type Store } from '@mp/store'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestSchema,
  loadMigrations,
  migrationsDir,
  pendingMigrations,
  postgresStore,
  runMigrations,
  type TestSchema,
} from '../src/index.ts'
import { ident } from '../src/sql.ts'

const url = process.env.DATABASE_URL
const unique = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`

describe.skipIf(!url)('postgres store adapter', () => {
  const pool = new pg.Pool({ connectionString: url, max: 16 })
  const toDrop: string[] = []
  const fresh = async (prefix = 'mp_test_pg') => {
    const s = await createTestSchema(pool, prefix)
    toDrop.push(s.schema)
    return s
  }

  afterAll(async () => {
    for (const s of toDrop) await pool.query(`drop schema if exists ${ident(s)} cascade`)
    await pool.end()
  })

  describe('migrations', () => {
    it('are recorded and idempotent', async () => {
      const schema = unique('mp_test_mig')
      toDrop.push(schema)
      const logger = memoryLogger()
      const first = await runMigrations({ pool, schema, logger })
      expect(first.applied).toEqual(loadMigrations().map((m) => m.name))
      expect(first.applied[0]).toBe('0001_init')
      expect(logger.lines.some((l) => l.msg === 'migration applied')).toBe(true)
      const second = await runMigrations({ pool, schema })
      expect(second.applied).toEqual([])
      const rows = (await pool.query(`select version, name, applied_at from ${ident(schema)}.schema_migrations order by version`))
        .rows
      expect(rows.map((r) => r.name)).toEqual(first.applied)
      expect(rows[0].applied_at).toBeInstanceOf(Date)
      expect(await pendingMigrations({ pool, schema })).toEqual([])
    })

    it('reports everything as pending for an empty schema', async () => {
      expect(await pendingMigrations({ pool, schema: unique('mp_test_none') })).toEqual(loadMigrations().map((m) => m.name))
    })

    it('does not race when several instances migrate at once', async () => {
      const schema = unique('mp_test_race')
      toDrop.push(schema)
      const results = await Promise.all(Array.from({ length: 6 }, () => runMigrations({ pool, schema })))
      const applied = results.flatMap((r) => r.applied)
      expect(applied).toEqual(loadMigrations().map((m) => m.name))
      const n = (await pool.query(`select count(*)::int as n from ${ident(schema)}.schema_migrations`)).rows[0].n
      expect(n).toBe(loadMigrations().length)
    })

    it('rolls back a failing migration and keeps earlier ones', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mp-mig-'))
      try {
        writeFileSync(join(dir, '0001_ok.sql'), 'create table a (id int primary key);')
        writeFileSync(join(dir, '0002_bad.sql'), 'create table b (id int); insert into a values (1); select no_such_function();')
        writeFileSync(join(dir, 'README.txt'), 'ignored')
        const schema = unique('mp_test_fail')
        toDrop.push(schema)
        await expect(runMigrations({ pool, schema, dir })).rejects.toThrow(/no_such_function/)
        const s = ident(schema)
        expect((await pool.query(`select name from ${s}.schema_migrations`)).rows.map((r) => r.name)).toEqual(['0001_ok'])
        expect((await pool.query('select to_regclass($1) as t', [`${s}.b`])).rows[0].t).toBeNull()
        expect((await pool.query(`select count(*)::int as n from ${s}.a`)).rows[0].n).toBe(0)
        // The lock was released: fixing the file lets the next run continue.
        writeFileSync(join(dir, '0002_bad.sql'), 'create table b (id int);')
        expect((await runMigrations({ pool, schema, dir })).applied).toEqual(['0002_bad'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses duplicate versions', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mp-mig-'))
      try {
        writeFileSync(join(dir, '0001_a.sql'), '')
        writeFileSync(join(dir, '0001_b.sql'), '')
        expect(() => loadMigrations(dir)).toThrow(/duplicate/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('ships its migrations next to the package', () => {
      expect(migrationsDir).toMatch(/store-postgres[/\\]migrations[/\\]?$/)
    })
  })

  describe('setup', () => {
    it('refuses an unmigrated schema unless asked to migrate', async () => {
      const schema = unique('mp_test_unmig')
      toDrop.push(schema)
      await expect(postgresStore({ pool, schema })).rejects.toBeInstanceOf(UnavailableError)
      const store = await postgresStore({ pool, schema, migrate: true })
      expect((await store.records.create('t', { a: 1 })).version).toBe(1)
      await store.close()
    })

    it('needs a pool or a connection string', async () => {
      await expect(postgresStore({})).rejects.toBeInstanceOf(ValidationError)
    })

    it('reuses a given pool and leaves it open on close', async () => {
      const { schema } = await fresh()
      const a = await postgresStore({ pool, schema })
      const b = await postgresStore({ pool, schema })
      const r = await a.records.create('t', { n: 1 })
      await a.close()
      await a.close()
      expect((await b.records.get('t', r.id))?.data).toEqual({ n: 1 })
      expect(b.pool).toBe(pool)
      expect((await pool.query('select 1 as x')).rows[0].x).toBe(1)
    })

    it('owns and ends a pool it created', async () => {
      const { schema } = await fresh()
      const store = await postgresStore({ connectionString: url!, schema })
      await store.records.create('t', { n: 1 })
      await store.close()
      await store.close()
      expect(store.pool.ended).toBe(true)
    })

    it('keeps schemas apart', async () => {
      const one = await postgresStore({ pool, schema: (await fresh()).schema })
      const two = await postgresStore({ pool, schema: (await fresh()).schema })
      await one.records.create('t', { n: 1 }, { key: 'k' })
      await two.records.create('t', { n: 2 }, { key: 'k' })
      expect(await one.records.count('t')).toBe(1)
      expect((await two.records.getByKey('t', 'k'))?.data).toEqual({ n: 2 })
    })

    it('works with an awkward schema name', async () => {
      const schema = unique('Mp "Test" Schema')
      toDrop.push(schema)
      const store = await postgresStore({ pool, schema, migrate: true })
      const r = await store.records.create('t', { a: 1 })
      expect(await store.records.find(r.id)).toEqual(r)
    })
  })

  describe('data', () => {
    let store: Store
    let schema: TestSchema
    beforeAll(async () => {
      schema = await fresh()
      store = await postgresStore({ pool, schema: schema.schema })
    })

    it('stores large content', async () => {
      const big = 'ü'.repeat(3_000_000)
      const r = await store.records.create('big', { big, list: Array.from({ length: 10_000 }, (_, i) => i) })
      expect((await store.records.get<any>('big', r.id))?.data.big.length).toBe(big.length)
      const e = await store.entries.append({ parent: null, kind: 'tool_result', content: { big } })
      expect((await store.entries.get<any>(e.id))!.content.big).toBe(big)
      expect((await store.entries.search({ text: 'üüü', limit: 1 })).total).toBeGreaterThanOrEqual(1)
    })

    it('round-trips JSON edge cases', async () => {
      const data: Record<string, Json> = {
        unicode: 'Zdravo, šđčćž, 日本語, العربية, 🚀👩‍💻',
        nested: [[1, [2, [3, []]]], [{ a: [{ b: null }] }]],
        numbers: [0, -1, 1.5, 1e-7, 123456789012345, Number.MAX_SAFE_INTEGER],
        flags: [true, false],
        empty: { o: {}, a: [], s: '' },
        'dotted.key': 'x',
        'q\'uo"te': 'back\\slash\nnewline\ttab',
        nothing: null,
        deep: { a: { b: { c: { d: { e: { f: 'deep' } } } } } },
      }
      const r = await store.records.create('json', data)
      expect(r.data).toEqual(data)
      expect((await store.records.get('json', r.id))?.data).toEqual(data)
      const e = await store.entries.append({ parent: null, kind: 'x', content: data, meta: { '🚀': 'y' } })
      expect((await store.entries.get(e.id))?.content).toEqual(data)
      expect(await store.entries.blob(e.hash)).toEqual(data)
      expect((await store.entries.get(e.id))?.meta).toEqual({ '🚀': 'y' })
      const s = await store.entries.append({ parent: null, kind: 'x', content: 'just a string' })
      expect((await store.entries.get(s.id))?.content).toBe('just a string')
      const n = await store.entries.append({ parent: null, kind: 'x', content: null })
      expect((await store.entries.get(n.id))?.content).toBeNull()
      expect(await store.records.count('json', { 'deep.a.b.c.d.e.f': 'deep' })).toBe(1)
      expect(await store.records.count('json', [{ field: 'unicode', op: 'like', value: '日本' }])).toBe(1)
      expect(await store.records.count('json', [{ field: 'nested', op: 'contains', value: [{ a: [{ b: null }] }] }])).toBe(1)
    })

    it('rejects NUL characters with a ValidationError', async () => {
      await expect(store.records.create('json', { bad: 'a\u0000b' })).rejects.toBeInstanceOf(ValidationError)
    })

    it('keeps revisions after deletion and re-creation with the same id', async () => {
      const r = await store.records.create('doc', { v: 1 }, { id: 'doc_reused' })
      await store.records.update('doc', r.id, { v: 2 })
      await store.records.delete('doc', r.id)
      await store.records.create('doc', { v: 'again' }, { id: 'doc_reused' })
      const revs = await store.records.revisions<any>('doc', 'doc_reused')
      expect(revs.map((x) => [x.version, x.op, x.data?.v ?? null])).toEqual([
        [1, 'create', 1],
        [2, 'update', 2],
        [3, 'delete', null],
        [1, 'create', 'again'],
      ])
      expect(revs[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      expect(await store.records.revisions('other', 'doc_reused')).toEqual([])
    })

    it('rejects an unknown op and bad paging', async () => {
      await expect(store.records.query('t', { where: [{ field: 'a', op: 'regex', value: 'x' } as any] })).rejects.toBeInstanceOf(
        ValidationError,
      )
      await expect(store.records.query('t', { limit: -1 })).rejects.toBeInstanceOf(ValidationError)
      await expect(store.records.query('t', { orderBy: { field: 'a', dir: 'sideways' as any } })).rejects.toBeInstanceOf(
        ValidationError,
      )
    })

    it('treats like patterns literally', async () => {
      await store.records.create('pct', { s: '100% done_ok' })
      await store.records.create('pct', { s: '100 done' })
      expect(await store.records.count('pct', [{ field: 's', op: 'like', value: '0% d' }])).toBe(1)
      expect(await store.records.count('pct', [{ field: 's', op: 'like', value: 'e_o' }])).toBe(1)
      expect((await store.records.query('pct', { text: '%' })).total).toBe(1)
    })

    it('uses the injected clock for timestamps', async () => {
      const clock = new ManualClock(Date.UTC(2030, 4, 6, 7, 8, 9, 123))
      const s = await postgresStore({ pool, schema: schema.schema, clock })
      const r = await s.records.create('clocked', { a: 1 })
      expect(r.createdAt).toBe('2030-05-06T07:08:09.123Z')
      clock.advance(1000)
      expect((await s.records.update('clocked', r.id, { a: 2 })).updatedAt).toBe('2030-05-06T07:08:10.123Z')
      expect((await s.records.get('clocked', r.id))?.createdAt).toBe('2030-05-06T07:08:09.123Z')
      expect(await s.records.count('clocked', [{ field: 'createdAt', op: 'lt', value: '2030-05-06T07:08:10' }])).toBe(1)
      expect(await s.records.count('clocked', [{ field: 'updatedAt', op: 'lt', value: '2030-05-06T07:08:10' }])).toBe(0)
    })

    it('walks long entry paths', async () => {
      let parent: string | null = null
      const ids: string[] = []
      for (let i = 0; i < 300; i++) {
        const e: { id: string } = await store.entries.append({ parent, kind: 'user', content: { i: i % 7 } })
        ids.push(e.id)
        parent = e.id
      }
      const path = await store.entries.path(parent!)
      expect(path.map((e) => e.id)).toEqual(ids)
      await expect(store.entries.path('ent_missing')).rejects.toThrow(/not found/)
      expect(await store.entries.getMany([])).toEqual([])
    })
  })

  describe('concurrency and transactions', () => {
    let store: Store
    const events: { topic: string; payload: any }[] = []
    const bus = createEventBus()
    bus.subscribe('**', (m) => void events.push({ topic: m.topic, payload: m.payload }))
    beforeAll(async () => {
      store = await postgresStore({ pool, schema: (await fresh()).schema, bus })
    })

    it('createOrGet under contention creates exactly one record', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.records.createOrGet('ev', 'same-key', { i })))
      expect(results.filter((r) => r.created)).toHaveLength(1)
      expect(new Set(results.map((r) => r.record.id)).size).toBe(1)
      await expect(store.records.createOrGet('ev', 'other-key', {}, { id: results[0]!.record.id })).rejects.toBeInstanceOf(
        ConflictError,
      )
    })

    it('concurrent links of the same pair dedupe', async () => {
      const a = await store.records.create('n', {})
      const b = await store.records.create('n', {})
      const links = await Promise.all(
        Array.from({ length: 8 }, () => store.links.link({ kind: 'n', id: a.id }, { kind: 'n', id: b.id }, 'rel')),
      )
      expect(new Set(links.map((l) => l.id)).size).toBe(1)
      expect(await store.links.query({ from: { kind: 'n', id: a.id } })).toHaveLength(1)
    })

    it('concurrent merge updates all apply', async () => {
      const r = await store.records.create('counter', {})
      await Promise.all(Array.from({ length: 10 }, (_, i) => store.records.update('counter', r.id, { [`k${i}`]: i })))
      const after = await store.records.get<any>('counter', r.id)
      expect(after?.version).toBe(11)
      expect(Object.keys(after!.data)).toHaveLength(10)
      expect((await store.records.revisions('counter', r.id)).map((x) => x.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    })

    it('a failed operation inside a transaction does not poison it', async () => {
      await store.records.create('tx', { n: 0 }, { key: 'taken' })
      const out = await store.transaction(async (tx) => {
        const a = await tx.records.create('tx', { n: 1 })
        await expect(tx.records.create('tx', { n: 2 }, { key: 'taken' })).rejects.toBeInstanceOf(ConflictError)
        await expect(tx.records.update('tx', a.id, {}, { key: 'taken' })).rejects.toBeInstanceOf(ConflictError)
        await expect(tx.records.update('tx', a.id, { n: 5 }, { expectedVersion: 7 })).rejects.toBeInstanceOf(ConflictError)
        return tx.records.update('tx', a.id, { n: 3 })
      })
      expect((await store.records.get<any>('tx', out.id))?.data.n).toBe(3)
      expect(await store.records.count('tx')).toBe(2)
    })

    it('isolates uncommitted writes and serialises parallel calls within a transaction', async () => {
      const seen = await store.transaction(async (tx) => {
        const made = await Promise.all(Array.from({ length: 5 }, (_, i) => tx.records.create('iso', { i })))
        const outside = await store.records.count('iso')
        return { made: made.length, outside, inside: await tx.records.count('iso') }
      })
      expect(seen).toEqual({ made: 5, outside: 0, inside: 5 })
      expect(await store.records.count('iso')).toBe(5)
    })

    it('publishes events in order after commit, and drops events of failed operations', async () => {
      events.length = 0
      await store.transaction(async (tx) => {
        const a = await tx.records.create('pub', { n: 1 })
        await tx.records.update('pub', a.id, { n: 2 })
        await tx.records.update('pub', a.id, { n: 3 }, { expectedVersion: 1 }).catch(() => undefined)
        await bus.idle()
        expect(events).toHaveLength(0)
      })
      await bus.idle()
      expect(events.map((e) => [e.topic, e.payload.op, e.payload.version])).toEqual([
        [StoreTopics.recordChanged, 'create', 1],
        [StoreTopics.recordChanged, 'update', 2],
      ])
    })

    it('publishes cascade unlinks', async () => {
      const a = await store.records.create('cas', {})
      const b = await store.records.create('cas', {})
      await store.links.link({ kind: 'cas', id: a.id }, { kind: 'cas', id: b.id }, 'x')
      events.length = 0
      await store.records.delete('cas', a.id, { cascade: true })
      await bus.idle()
      expect(events.map((e) => [e.topic, e.payload.op])).toEqual([
        [StoreTopics.linkChanged, 'unlink'],
        [StoreTopics.recordChanged, 'delete'],
      ])
    })

    it('racing transactions with CAS: exactly one wins', async () => {
      const r = await store.records.create('race', { owner: null })
      // Every transaction reads before any of them writes, so they all race on the same version
      // (without the barrier, a late starter reads the winner's version and rightly succeeds too).
      const n = 6
      let read = 0
      let allRead!: () => void
      const barrier = new Promise<void>((resolve) => (allRead = resolve))
      const results = await Promise.allSettled(
        Array.from({ length: n }, (_, i) =>
          store.transaction(async (tx) => {
            const cur = await tx.records.get('race', r.id)
            if (++read === n) allRead()
            await barrier
            return tx.records.update('race', r.id, { owner: `w${i}` }, { expectedVersion: cur!.version })
          }),
        ),
      )
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      expect(
        results.filter((x) => x.status === 'rejected').every((x) => (x as PromiseRejectedResult).reason instanceof ConflictError),
      ).toBe(true)
    })
  })

  describe('query parity with the in-memory store', () => {
    let pgStore: Store
    let mem: Store
    beforeAll(async () => {
      const clock = new ManualClock()
      pgStore = await postgresStore({ pool, schema: (await fresh()).schema, clock })
      const memClock = new ManualClock()
      mem = memoryStore({ clock: memClock })
      const rows: Record<string, unknown>[] = [
        { name: 'Ana', age: 30, tags: ['owner', 'x'], team: { name: 'Pay', size: 3 }, score: 1.5, active: true },
        { name: 'bob', age: 25, tags: ['member'], handles: [{ system: 'slack', id: 'U2' }], active: false },
        { name: 'Cyd', age: 41, tags: [], team: null, nested: [[1, 2], [3]] },
        { name: 'dee', tags: ['owner'], team: { name: 'Core', size: 10 }, score: -2 },
        {
          name: 'Émile',
          age: 30,
          handles: [
            { system: 'slack', id: 'U9' },
            { system: 'mail', id: 'e@example.com' },
          ],
        },
        { name: 'Zed', code: '30', status: 'active' },
        { name: 'ana', age: 18, status: 'sunset', list: [{ a: 1, b: [1, 2] }] },
      ]
      for (const [i, data] of rows.entries()) {
        const id = `per_${String(i).padStart(3, '0')}`
        const key = i % 2 ? `k${i}` : undefined
        await pgStore.records.create('person', data, { id, key })
        await mem.records.create('person', data, { id, key })
        clock.advance(i % 3 === 0 ? 0 : 5)
        memClock.advance(i % 3 === 0 ? 0 : 5)
      }
    })

    const conditions: Condition[][] = [
      [{ field: 'name', op: 'eq', value: 'Ana' }],
      [{ field: 'age', op: 'eq', value: 30 }],
      [{ field: 'code', op: 'eq', value: '30' }],
      [{ field: 'code', op: 'eq', value: 30 }],
      [{ field: 'team', op: 'eq', value: null }],
      [{ field: 'team', op: 'eq', value: { name: 'Pay', size: 3 } }],
      [{ field: 'team', op: 'ne', value: null }],
      [{ field: 'status', op: 'ne', value: 'active' }],
      [{ field: 'age', op: 'in', value: [25, 41, '30'] }],
      [{ field: 'age', op: 'in', value: [] }],
      [{ field: 'age', op: 'nin', value: [30] }],
      [{ field: 'age', op: 'gt', value: 25 }],
      [{ field: 'age', op: 'gte', value: 30 }],
      [{ field: 'age', op: 'lt', value: 30 }],
      [{ field: 'code', op: 'lte', value: '4' }],
      [{ field: 'name', op: 'gt', value: 'Zed' }],
      [{ field: 'name', op: 'lt', value: 'b' }],
      [{ field: 'score', op: 'lt', value: 0 }],
      [{ field: 'tags', op: 'contains', value: 'owner' }],
      [{ field: 'tags', op: 'contains', value: 'nope' }],
      [{ field: 'handles', op: 'contains', value: { system: 'slack' } }],
      [{ field: 'handles', op: 'contains', value: { system: 'mail', id: 'e@example.com' } }],
      [{ field: 'nested', op: 'contains', value: [3] }],
      [{ field: 'name', op: 'contains', value: 'Ana' }],
      [{ field: 'name', op: 'like', value: 'AN' }],
      [{ field: 'name', op: 'like', value: 'mil' }],
      [{ field: 'age', op: 'like', value: '3' }],
      [{ field: 'team', op: 'exists', value: true }],
      [{ field: 'team', op: 'exists', value: false }],
      [{ field: 'team.size', op: 'gte', value: 5 }],
      [{ field: 'team.name', op: 'exists', value: true }],
      [{ field: 'tags.0', op: 'eq', value: 'owner' }],
      [{ field: 'active', op: 'eq', value: false }],
      [{ field: 'key', op: 'eq', value: null }],
      [{ field: 'key', op: 'exists', value: true }],
      [{ field: 'key', op: 'in', value: ['k1', 'k3'] }],
      [{ field: 'id', op: 'gte', value: 'per_004' }],
      [{ field: 'id', op: 'in', value: ['per_000', 'per_006'] }],
      [{ field: 'version', op: 'eq', value: 1 }],
      [{ field: 'kind', op: 'eq', value: 'person' }],
      [
        { field: 'age', op: 'gte', value: 20 },
        { field: 'tags', op: 'exists', value: true },
      ],
    ]

    it.each(conditions.map((c) => [JSON.stringify(c), c] as const))('where %s', async (_label, where) => {
      const ids = async (s: Store) => (await s.records.query('person', { where })).items.map((r) => r.id)
      expect(await ids(pgStore)).toEqual(await ids(mem))
      expect(await pgStore.records.count('person', where)).toBe(await mem.records.count('person', where))
      expect(await pgStore.records.sum('person', 'age', where)).toBe(await mem.records.sum('person', 'age', where))
    })

    const queries: RecordQuery[] = [
      {},
      { orderBy: { field: 'name' } },
      { orderBy: { field: 'name', dir: 'desc' } },
      { orderBy: { field: 'age' } },
      { orderBy: { field: 'score', dir: 'desc' } },
      { orderBy: { field: 'team.size' } },
      { orderBy: { field: 'createdAt', dir: 'desc' } },
      { orderBy: { field: 'id', dir: 'desc' }, limit: 3, offset: 2 },
      { orderBy: { field: 'key' }, where: [{ field: 'key', op: 'exists', value: true }] },
      { text: 'slack' },
      { text: 'ÉMILE' },
      { text: 'owner', limit: 1 },
      { offset: 5 },
      { offset: 50, limit: 5 },
      { limit: 0 },
    ]

    it.each(queries.map((q) => [JSON.stringify(q), q] as const))('query %s', async (_label, q) => {
      const run = async (s: Store) => {
        const page = await s.records.query('person', q)
        return { ids: page.items.map((r) => r.id), total: page.total }
      }
      expect(await run(pgStore)).toEqual(await run(mem))
    })

    it('compares only values of the same type (a documented difference from JS coercion)', async () => {
      expect(await pgStore.records.count('person', [{ field: 'code', op: 'gte', value: 30 }])).toBe(0)
      expect(await pgStore.records.count('person', [{ field: 'age', op: 'lte', value: '99' }])).toBe(0)
    })

    it('agrees on sums and kinds', async () => {
      for (const f of ['age', 'score', 'team.size', 'version', 'missing']) {
        expect(await pgStore.records.sum('person', f)).toBe(await mem.records.sum('person', f))
      }
      expect(await pgStore.records.kinds()).toEqual(await mem.records.kinds())
    })
  })
})
