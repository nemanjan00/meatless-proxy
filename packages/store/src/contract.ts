/**
 * The storage contract. Every implementation of `Store` must pass it:
 *
 *   storeContract('postgres', () => postgresStore(...))
 *
 * `make` must return a fresh, empty store each time (or at least one where
 * kinds used here don't collide, e.g. a new schema).
 */
import { ConflictError, NotFoundError, createEventBus, type EventBus } from '@mp/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StoreTopics, type Store } from './types.ts'

export interface ContractContext {
  bus: EventBus
}

export function storeContract(name: string, make: (ctx: ContractContext) => Promise<Store>) {
  describe(`store contract: ${name}`, () => {
    let store: Store
    let bus: EventBus
    let events: { topic: string; payload: any }[]

    beforeEach(async () => {
      bus = createEventBus()
      events = []
      bus.subscribe('**', (m) => void events.push({ topic: m.topic, payload: m.payload }))
      store = await make({ bus })
    })

    afterEach(async () => {
      await store.close()
    })

    describe('records', () => {
      it('creates and reads records', async () => {
        const r = await store.records.create('contact', { name: 'Ana', tags: ['a'] }, { prefix: 'con' })
        expect(r.id).toMatch(/^con_/)
        expect(r.version).toBe(1)
        expect(r.key).toBeNull()
        expect(r.data).toEqual({ name: 'Ana', tags: ['a'] })
        expect(await store.records.get('contact', r.id)).toEqual(r)
        expect(await store.records.find(r.id)).toEqual(r)
        expect(await store.records.get('project', r.id)).toBeNull()
        expect(await store.records.get('contact', 'con_missing')).toBeNull()
      })

      it('accepts a given id and refuses duplicates', async () => {
        await store.records.create('contact', { name: 'A' }, { id: 'con_fixed' })
        await expect(store.records.create('contact', { name: 'B' }, { id: 'con_fixed' })).rejects.toBeInstanceOf(ConflictError)
      })

      it('enforces unique keys per kind', async () => {
        await store.records.create('event', { n: 1 }, { key: 'slack:1' })
        await expect(store.records.create('event', { n: 2 }, { key: 'slack:1' })).rejects.toBeInstanceOf(ConflictError)
        await store.records.create('other', { n: 3 }, { key: 'slack:1' })
        expect((await store.records.getByKey('event', 'slack:1'))?.data).toEqual({ n: 1 })
      })

      it('createOrGet deduplicates by key', async () => {
        const a = await store.records.createOrGet('event', 'k1', { n: 1 })
        const b = await store.records.createOrGet('event', 'k1', { n: 2 })
        expect(a.created).toBe(true)
        expect(b.created).toBe(false)
        expect(b.record.id).toBe(a.record.id)
        expect(b.record.data).toEqual({ n: 1 })
      })

      it('merges updates, removes undefined keys, and bumps the version', async () => {
        const r = await store.records.create('project', { name: 'X', status: 'active', note: 'n' })
        const u = await store.records.update('project', r.id, { status: 'sunset', note: undefined })
        expect(u.version).toBe(2)
        expect(u.data).toEqual({ name: 'X', status: 'sunset' })
        const rep = await store.records.update('project', r.id, { name: 'Y' }, { replace: true })
        expect(rep.data).toEqual({ name: 'Y' })
        expect(rep.version).toBe(3)
      })

      it('compare-and-swap on version', async () => {
        const r = await store.records.create('session', { head: 'a' })
        await store.records.update('session', r.id, { head: 'b' }, { expectedVersion: 1 })
        await expect(store.records.update('session', r.id, { head: 'c' }, { expectedVersion: 1 })).rejects.toBeInstanceOf(
          ConflictError,
        )
        expect((await store.records.get<any>('session', r.id))?.data.head).toBe('b')
      })

      it('only one of many concurrent CAS updates wins', async () => {
        const r = await store.records.create('run', { state: 'queued' })
        const attempts = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) =>
            store.records.update('run', r.id, { state: 'running', worker: `w${i}` }, { expectedVersion: 1 }),
          ),
        )
        expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1)
      })

      it('changes keys', async () => {
        const r = await store.records.create('session', { t: 1 }, { key: 'slug-a' })
        await store.records.create('session', { t: 2 }, { key: 'slug-b' })
        await expect(store.records.update('session', r.id, {}, { key: 'slug-b' })).rejects.toBeInstanceOf(ConflictError)
        await store.records.update('session', r.id, {}, { key: 'slug-c' })
        expect((await store.records.getByKey('session', 'slug-c'))?.id).toBe(r.id)
        expect(await store.records.getByKey('session', 'slug-a')).toBeNull()
      })

      it('fails to update or delete missing records', async () => {
        await expect(store.records.update('x', 'x_nope', {})).rejects.toBeInstanceOf(NotFoundError)
        await expect(store.records.delete('x', 'x_nope')).rejects.toBeInstanceOf(NotFoundError)
      })

      it('deletes records and frees their key', async () => {
        const r = await store.records.create('thing', { a: 1 }, { key: 'k' })
        await store.records.delete('thing', r.id)
        expect(await store.records.get('thing', r.id)).toBeNull()
        await store.records.create('thing', { a: 2 }, { key: 'k' })
      })

      it('keeps revisions with actors', async () => {
        const actor = { type: 'contact' as const, id: 'con_ana' }
        const r = await store.records.create('doc', { body: 'v1' }, { actor })
        await store.records.update('doc', r.id, { body: 'v2' })
        await store.records.delete('doc', r.id, { actor })
        const revs = await store.records.revisions<any>('doc', r.id)
        expect(revs.map((x) => [x.version, x.op, x.data?.body ?? null, x.actor.type])).toEqual([
          [1, 'create', 'v1', 'contact'],
          [2, 'update', 'v2', 'system'],
          [3, 'delete', null, 'contact'],
        ])
      })

      it('queries by conditions, text, order and paging', async () => {
        const mk = (name: string, age: number, tags: string[], extra: Record<string, unknown> = {}) =>
          store.records.create('person', { name, age, tags, ...extra })
        await mk('Ana', 30, ['owner'], { team: { name: 'Payments' } })
        await mk('Bob', 25, ['member'], { handles: [{ system: 'slack', id: 'U2' }] })
        await mk('Cyd', 41, ['owner', 'member'])
        await store.records.create('other', { name: 'Ana' })

        const names = async (q: Parameters<Store['records']['query']>[1]) =>
          (await store.records.query<any>('person', q)).items.map((r) => r.data.name)

        expect(await names({ where: { name: 'Bob' } })).toEqual(['Bob'])
        expect(await names({ where: [{ field: 'age', op: 'gte', value: 30 }], orderBy: { field: 'age', dir: 'desc' } })).toEqual([
          'Cyd',
          'Ana',
        ])
        expect(await names({ where: [{ field: 'tags', op: 'contains', value: 'owner' }] })).toEqual(['Ana', 'Cyd'])
        expect(await names({ where: [{ field: 'handles', op: 'contains', value: { system: 'slack' } }] })).toEqual(['Bob'])
        expect(await names({ where: { 'team.name': 'Payments' } })).toEqual(['Ana'])
        expect(await names({ where: [{ field: 'name', op: 'in', value: ['Ana', 'Cyd'] }] })).toEqual(['Ana', 'Cyd'])
        expect(await names({ where: [{ field: 'name', op: 'nin', value: ['Ana', 'Cyd'] }] })).toEqual(['Bob'])
        expect(await names({ where: [{ field: 'name', op: 'ne', value: 'Ana' }] })).toEqual(['Bob', 'Cyd'])
        expect(await names({ where: [{ field: 'name', op: 'like', value: 'y' }] })).toEqual(['Cyd'])
        expect(await names({ where: [{ field: 'team', op: 'exists', value: true }] })).toEqual(['Ana'])
        expect(await names({ where: [{ field: 'team', op: 'exists', value: false }] })).toEqual(['Bob', 'Cyd'])
        expect(await names({ text: 'payMENTS' })).toEqual(['Ana'])
        expect(await names({ orderBy: { field: 'name', dir: 'asc' }, limit: 2, offset: 1 })).toEqual(['Bob', 'Cyd'])
        const page = await store.records.query('person', { limit: 1 })
        expect(page.total).toBe(3)
        expect(page.items).toHaveLength(1)
        expect(await store.records.count('person', [{ field: 'age', op: 'lt', value: 40 }])).toBe(2)
        expect(await store.records.sum('person', 'age')).toBe(96)
        expect(await store.records.sum('person', 'age', { name: 'Ana' })).toBe(30)
        expect(await store.records.sum('person', 'missing')).toBe(0)
        expect(await store.records.kinds()).toEqual(['other', 'person'])
      })

      it('ne and nin match records where the field is missing', async () => {
        await store.records.create('flag', { n: 1 })
        await store.records.create('flag', { n: 2, deleted: false })
        await store.records.create('flag', { n: 3, deleted: true })
        const ns = async (where: any) =>
          (await store.records.query<any>('flag', { where, orderBy: { field: 'n' } })).items.map((r) => r.data.n)
        expect(await ns([{ field: 'deleted', op: 'ne', value: true }])).toEqual([1, 2])
        expect(await ns([{ field: 'deleted', op: 'nin', value: [true] }])).toEqual([1, 2])
        expect(await ns([{ field: 'deleted', op: 'eq', value: true }])).toEqual([3])
      })

      it('treats `kind` as a data field (queries are per kind)', async () => {
        await store.records.create('memory', { kind: 'fact', n: 1 })
        await store.records.create('memory', { kind: 'preference', n: 2 })
        expect((await store.records.query<any>('memory', { where: { kind: 'fact' } })).items.map((r) => r.data.n)).toEqual([1])
      })

      it('orders by top-level fields', async () => {
        const a = await store.records.create('t', { n: 1 })
        const b = await store.records.create('t', { n: 2 })
        const ids = (await store.records.query('t', { orderBy: { field: 'createdAt', dir: 'desc' } })).items.map((r) => r.id)
        expect(ids).toEqual([b.id, a.id])
        expect((await store.records.query('t', { where: { id: a.id } })).items).toHaveLength(1)
      })

      it('returns copies, not live objects', async () => {
        const r = await store.records.create('t', { list: [1] })
        ;(r.data.list as number[]).push(2)
        expect((await store.records.get<any>('t', r.id))?.data.list).toEqual([1])
      })

      it('publishes record.changed', async () => {
        const r = await store.records.create('t', { a: 1 })
        await store.records.update('t', r.id, { a: 2 })
        await bus.idle()
        const changes = events.filter((e) => e.topic === StoreTopics.recordChanged).map((e) => [e.payload.op, e.payload.version])
        expect(changes).toEqual([
          ['create', 1],
          ['update', 2],
        ])
      })
    })

    describe('links', () => {
      it('links existing records, deduplicates, and queries both ways', async () => {
        const ana = await store.records.create('contact', { name: 'Ana' })
        const bob = await store.records.create('contact', { name: 'Bob' })
        const pay = await store.records.create('project', { name: 'Payments' })
        const a = { kind: 'contact', id: ana.id }
        const b = { kind: 'contact', id: bob.id }
        const p = { kind: 'project', id: pay.id }
        const l1 = await store.links.link(a, p, 'owner', { since: '2026' })
        const again = await store.links.link(a, p, 'owner')
        expect(again.id).toBe(l1.id)
        await store.links.link(a, p, 'reviewer')
        await store.links.link(b, p, 'member')

        expect((await store.links.query({ to: p })).map((l) => l.role).sort()).toEqual(['member', 'owner', 'reviewer'])
        expect((await store.links.query({ from: a })).length).toBe(2)
        expect((await store.links.query({ to: p, role: 'owner' }))[0]?.from.id).toBe(ana.id)
        expect((await store.links.query({ to: p, role: ['member', 'reviewer'] })).length).toBe(2)
        expect((await store.links.query({ from: { kind: 'contact' } })).length).toBe(3)
        expect((await store.links.query({ touching: b })).length).toBe(1)
        expect((await store.links.get(l1.id))?.data).toEqual({ since: '2026' })

        await store.links.update(l1.id, { since: '2025' })
        expect((await store.links.get(l1.id))?.data).toEqual({ since: '2025' })
        await store.links.unlinkPair(a, p, 'reviewer')
        expect((await store.links.query({ from: a })).length).toBe(1)
        await store.links.unlink(l1.id)
        expect(await store.links.get(l1.id)).toBeNull()
      })

      it('refuses links to missing records', async () => {
        const ana = await store.records.create('contact', { name: 'Ana' })
        await expect(
          store.links.link({ kind: 'contact', id: ana.id }, { kind: 'project', id: 'pro_missing' }, 'owner'),
        ).rejects.toBeInstanceOf(NotFoundError)
        await expect(
          store.links.link({ kind: 'project', id: ana.id }, { kind: 'contact', id: ana.id }, 'x'),
        ).rejects.toBeInstanceOf(NotFoundError)
      })

      it('protects linked records from deletion unless cascading', async () => {
        const a = await store.records.create('contact', { name: 'Ana' })
        const p = await store.records.create('project', { name: 'P' })
        await store.links.link({ kind: 'contact', id: a.id }, { kind: 'project', id: p.id }, 'owner')
        await expect(store.records.delete('project', p.id)).rejects.toBeInstanceOf(ConflictError)
        await store.records.delete('project', p.id, { cascade: true })
        expect(await store.links.query({ touching: { kind: 'contact', id: a.id } })).toEqual([])
      })
    })

    describe('entries', () => {
      it('appends a tree and walks paths', async () => {
        const root = await store.entries.append({ parent: null, kind: 'system', content: { text: 'you are…' } })
        const a = await store.entries.append({ parent: root.id, kind: 'user', content: { text: 'hi' }, meta: { run: 'r1' } })
        const b1 = await store.entries.append({ parent: a.id, kind: 'assistant', content: { text: 'branch 1' } })
        const b2 = await store.entries.append({ parent: a.id, kind: 'assistant', content: { text: 'branch 2' } })
        expect((await store.entries.path(b1.id)).map((e) => e.id)).toEqual([root.id, a.id, b1.id])
        expect((await store.entries.path(b2.id)).map((e) => e.id)).toEqual([root.id, a.id, b2.id])
        expect((await store.entries.children(a.id)).map((e) => e.id)).toEqual([b1.id, b2.id])
        expect((await store.entries.get(a.id))?.meta).toEqual({ run: 'r1' })
        expect((await store.entries.getMany([b2.id, 'ent_missing', b1.id])).map((e) => e.id)).toEqual([b2.id, b1.id])
        expect(await store.entries.get('ent_missing')).toBeNull()
      })

      it('stores identical content once, by hash', async () => {
        const big = { text: 'x'.repeat(10_000), n: [1, 2, 3] }
        const e1 = await store.entries.append({ parent: null, kind: 'tool_result', content: big })
        const e2 = await store.entries.append({
          parent: null,
          kind: 'tool_result',
          content: { n: [1, 2, 3], text: 'x'.repeat(10_000) },
        })
        expect(e1.hash).toBe(e2.hash)
        expect(e1.hash).toMatch(/^[0-9a-f]{64}$/)
        expect(await store.entries.blob(e1.hash)).toEqual(big)
        expect(await store.entries.blob('0'.repeat(64))).toBeNull()
      })

      it('searches entry content by text, kinds and meta', async () => {
        const a = await store.entries.append({
          parent: null,
          kind: 'user',
          content: { text: 'Deploy the Billing service' },
          meta: { sessionId: 'ses_a' },
        })
        const b = await store.entries.append({
          parent: a.id,
          kind: 'assistant',
          content: { text: 'billing deploy started' },
          meta: { sessionId: 'ses_a' },
        })
        await store.entries.append({
          parent: null,
          kind: 'user',
          content: { text: 'billing question' },
          meta: { sessionId: 'ses_b' },
        })
        await store.entries.append({ parent: null, kind: 'user', content: { text: 'unrelated' }, meta: { sessionId: 'ses_b' } })
        const all = await store.entries.search({ text: 'BILLING' })
        expect(all.total).toBe(3)
        expect(all.items[0]!.content).toEqual({ text: 'billing question' })
        expect((await store.entries.search({ text: 'billing', meta: { sessionId: 'ses_a' } })).items.map((e) => e.id)).toEqual([
          b.id,
          a.id,
        ])
        expect((await store.entries.search({ text: 'billing', kinds: ['assistant'] })).items.map((e) => e.id)).toEqual([b.id])
        expect((await store.entries.search({ text: 'billing', meta: { sessionId: ['ses_b', 'ses_x'] } })).total).toBe(1)
        const page = await store.entries.search({ text: 'billing', limit: 1, offset: 1 })
        expect(page.items).toHaveLength(1)
        expect(page.total).toBe(3)
        expect((await store.entries.search({ text: 'nothing matches this' })).total).toBe(0)
        // Every word, in any order, instead of one phrase.
        expect((await store.entries.search({ text: 'service deploy' })).total).toBe(0)
        expect((await store.entries.search({ text: 'service  DEPLOY', allWords: true })).items.map((e) => e.id)).toEqual([a.id])
        expect((await store.entries.search({ text: 'billing nope', allWords: true })).total).toBe(0)
        // Leaving out a session's entries.
        expect(
          (await store.entries.search({ text: 'billing', excludeMeta: { sessionId: 'ses_b' } })).items.map((e) => e.id),
        ).toEqual([b.id, a.id])
        expect((await store.entries.search({ text: 'billing', excludeMeta: { sessionId: ['ses_a', 'ses_b'] } })).total).toBe(0)
      })

      it('searches inside tool call arguments, which are JSON strings in the content', async () => {
        await store.entries.append({
          parent: null,
          kind: 'assistant',
          content: {
            text: null,
            toolCalls: [
              {
                id: 'c1',
                name: 'git.write_file',
                arguments: JSON.stringify({ path: 'README.md', content: '# Parser\nParses invoices.' }),
              },
            ],
          },
          meta: { sessionId: 'ses_a' },
        })
        expect((await store.entries.search({ text: 'parses invoices' })).total).toBe(1)
        expect((await store.entries.search({ text: 'parser invoices', allWords: true })).total).toBe(1)
      })

      it('refuses a missing parent', async () => {
        await expect(store.entries.append({ parent: 'ent_nope', kind: 'user', content: 'x' })).rejects.toBeInstanceOf(
          NotFoundError,
        )
      })

      it('publishes entry.appended', async () => {
        await store.entries.append({ parent: null, kind: 'user', content: 'x' })
        await bus.idle()
        expect(events.some((e) => e.topic === StoreTopics.entryAppended)).toBe(true)
      })
    })

    describe('transactions', () => {
      it('commits everything together', async () => {
        const out = await store.transaction(async (tx) => {
          const a = await tx.records.create('a', { n: 1 })
          const b = await tx.records.create('b', { n: 2 })
          await tx.links.link({ kind: 'a', id: a.id }, { kind: 'b', id: b.id }, 'rel')
          const e = await tx.entries.append({ parent: null, kind: 'user', content: 'x' })
          expect(await tx.records.get('a', a.id)).not.toBeNull()
          return { a, b, e }
        })
        expect(await store.records.get('a', out.a.id)).not.toBeNull()
        expect(await store.entries.get(out.e.id)).not.toBeNull()
        expect(await store.links.query({ from: { kind: 'a', id: out.a.id } })).toHaveLength(1)
      })

      it('rolls everything back when the function throws', async () => {
        const before = await store.records.create('a', { n: 0 })
        let createdId = ''
        await expect(
          store.transaction(async (tx) => {
            createdId = (await tx.records.create('a', { n: 1 })).id
            await tx.records.update('a', before.id, { n: 99 })
            await tx.entries.append({ parent: null, kind: 'user', content: 'rolled back', id: 'ent_rolledback0000000000000000' })
            throw new Error('boom')
          }),
        ).rejects.toThrow('boom')
        expect(await store.records.get('a', createdId)).toBeNull()
        expect((await store.records.get<any>('a', before.id))?.data.n).toBe(0)
        expect(await store.entries.get('ent_rolledback0000000000000000')).toBeNull()
      })

      it('nested transactions reuse the outer one', async () => {
        await expect(
          store.transaction(async (tx) => {
            await tx.transaction(async (inner) => {
              await inner.records.create('nested', { n: 1 })
            })
            throw new Error('outer fails')
          }),
        ).rejects.toThrow('outer fails')
        expect(await store.records.count('nested')).toBe(0)
      })

      it('publishes changes only after commit', async () => {
        await store
          .transaction(async (tx) => {
            await tx.records.create('quiet', { n: 1 })
            throw new Error('no')
          })
          .catch(() => undefined)
        await bus.idle()
        expect(events.filter((e) => e.payload?.kind === 'quiet')).toHaveLength(0)
        await store.transaction(async (tx) => {
          await tx.records.create('loud', { n: 1 })
        })
        await bus.idle()
        expect(events.filter((e) => e.payload?.kind === 'loud')).toHaveLength(1)
      })
    })
  })
}
