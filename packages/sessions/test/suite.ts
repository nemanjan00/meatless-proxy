import {
  ConflictError,
  ManualClock,
  NotFoundError,
  ValidationError,
  createEventBus,
  type BusMessage,
  type EventBus,
} from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import type { Store } from '@mp/store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionTopics, createSessions, type PointerContent, type Run, type Sessions, type SummaryContent } from '../src/index.ts'

const EMP = 'emp_test'

let clock: ManualClock
let bus: EventBus
let records: Records
let sessions: Sessions
let messages: BusMessage<any>[]

/**
 * The sessions behaviour against any store. Run with the in-memory store by
 * sessions.test.ts; adapters can run it too.
 */
export function sessionsSuite(name: string, makeStore: (o: { bus: EventBus; clock: ManualClock }) => Promise<Store>) {
  describe(`sessions (${name})`, () => {
    let store: Store
    beforeEach(async () => {
      clock = new ManualClock(Date.UTC(2026, 0, 1))
      bus = createEventBus()
      store = await makeStore({ bus, clock })
      records = createRecords({ store, bus })
      records.kinds.define({ kind: 'project', prefix: 'pro', core: [{ name: 'name', type: 'string', required: true }] })
      sessions = createSessions({ records, clock, bus })
      messages = []
      bus.subscribe('**', (m) => void messages.push(m))
    })
    afterEach(async () => {
      await bus.idle()
      await store.close()
    })

    const topics = async (topic: string) => {
      await bus.idle()
      return messages.filter((m) => m.topic === topic).map((m) => m.payload)
    }
    const texts = (entries: { content: any }[]) => entries.map((e) => e.content.text ?? e.content.name)
    const user = (text: string) => ({ kind: 'user' as const, content: { text } })
    const assistant = (text: string) => ({ kind: 'assistant' as const, content: { text } })

    async function started(sessionId: string, mode: 'continuing' | 'ephemeral' = 'continuing'): Promise<Run> {
      const run = await sessions.createRun({ sessionId, mode, cause: { type: 'manual' } })
      return sessions.transition(run.id, 'queued', 'running')
    }

    describe('sessions', () => {
      it('creates a session with an initial chain, a unique slug and links', async () => {
        const project = await records.create('project', { name: 'Billing' })
        const s = await sessions.create({
          employeeId: EMP,
          title: 'Fix the Login bug',
          toolset: ['a', 'b'],
          entries: [
            { kind: 'system', content: { text: 'You are Ana' } },
            { kind: 'user', content: { text: 'hello' }, meta: { sessionId: 'spoofed', extra: 1 } },
          ],
          links: [{ ref: { kind: 'project', id: project.id }, role: 'works_on' }],
        })
        expect(s.id).toMatch(/^ses_/)
        expect(s.key).toBe(`${EMP}:fix-the-login-bug`)
        expect(s.data).toMatchObject({ slug: 'fix-the-login-bug', status: 'active', rootId: s.id, depth: 0, document: '' })
        const h = await sessions.history(s.id)
        expect(texts(h)).toEqual(['You are Ana', 'hello'])
        expect(h[1]!.parent).toBe(h[0]!.id)
        expect(s.data.head).toBe(h[1]!.id)
        expect(h[1]!.meta).toMatchObject({ sessionId: s.id, employeeId: EMP, extra: 1 })
        expect((await records.linked({ kind: 'session', id: s.id }, { role: 'works_on' })).map((l) => l.record.id)).toEqual([
          project.id,
        ])

        const s2 = await sessions.create({ employeeId: EMP, title: 'Fix the login bug' })
        const s3 = await sessions.create({ employeeId: EMP, title: 'x', slug: 'fix-the-login-bug' })
        const other = await sessions.create({ employeeId: 'emp_other', title: 'Fix the login bug' })
        expect([s2.data.slug, s3.data.slug, other.data.slug]).toEqual([
          'fix-the-login-bug-2',
          'fix-the-login-bug-3',
          'fix-the-login-bug',
        ])
        expect(s2.data.head).toBeNull()
        expect(await sessions.history(s2.id)).toEqual([])
        expect((await sessions.bySlug(EMP, 'fix-the-login-bug-2'))?.id).toBe(s2.id)
        expect(await sessions.bySlug(EMP, 'nope')).toBeNull()
        expect((await topics(SessionTopics.sessionCreated)).length).toBe(4)
      })

      it('gives concurrent creates distinct slugs', async () => {
        const all = await Promise.all(Array.from({ length: 5 }, () => sessions.create({ employeeId: EMP, title: 'Same' })))
        expect(new Set(all.map((s) => s.data.slug)).size).toBe(5)
      })

      it('validates input', async () => {
        await expect(sessions.create({ employeeId: EMP, title: '  ' })).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.create({ employeeId: '', title: 'x' })).rejects.toBeInstanceOf(ValidationError)
        await expect(
          sessions.create({ employeeId: EMP, title: 'x', entries: [{ kind: 'nope' as any, content: {} }] }),
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.require('ses_missing')).rejects.toBeInstanceOf(NotFoundError)
        // Nothing half-created.
        expect((await sessions.query({})).total).toBe(0)
      })

      it('queries and updates', async () => {
        const a = await sessions.create({ employeeId: EMP, title: 'Alpha', document: 'retry policy notes' })
        clock.advance(1000)
        const b = await sessions.create({ employeeId: EMP, title: 'Beta' })
        await sessions.create({ employeeId: 'emp_2', title: 'Gamma' })
        expect((await sessions.query({ employeeId: EMP })).items.map((s) => s.id)).toEqual([b.id, a.id])
        await sessions.update(b.id, { status: 'done', title: 'Beta 2', slug: 'hacked' } as any)
        const b2 = await sessions.require(b.id)
        expect(b2.data).toMatchObject({ status: 'done', title: 'Beta 2', slug: 'beta' })
        expect((await sessions.query({ status: ['done', 'waiting'] })).items.map((s) => s.id)).toEqual([b.id])
        expect((await sessions.query({ text: 'retry policy' })).items.map((s) => s.id)).toEqual([a.id])
        expect((await sessions.searchSessions('RETRY')).items.map((s) => s.id)).toEqual([a.id])
        expect((await sessions.query({ limit: 1, offset: 1 })).items.length).toBe(1)
        expect((await sessions.query({ rootId: a.id })).total).toBe(1)
        await expect(sessions.update(a.id, { status: 'bogus' as any })).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.update(a.id, { title: '' })).rejects.toBeInstanceOf(ValidationError)
      })

      it('filters by ids and excluded roles, and orders by the given field with stable ties', async () => {
        const a = await sessions.create({ employeeId: EMP, title: 'beta' })
        clock.advance(1000)
        const b = await sessions.create({ employeeId: EMP, title: 'Alpha', meta: { role: 'router' } })
        clock.advance(1000)
        const c = await sessions.create({ employeeId: EMP, title: 'Gamma', meta: { role: 'router-retired' } })
        clock.advance(1000)
        await sessions.update(a.id, { document: 'touched' })
        const ids = async (q: Parameters<Sessions['query']>[0]) => (await sessions.query(q)).items.map((s) => s.id)
        expect(await ids({})).toEqual([c.id, b.id, a.id])
        expect(await ids({ orderBy: { field: 'createdAt', dir: 'asc' } })).toEqual([a.id, b.id, c.id])
        expect(await ids({ orderBy: { field: 'updatedAt' } })).toEqual([a.id, c.id, b.id])
        // Byte order, like the stores: capitals first.
        expect(await ids({ orderBy: { field: 'title', dir: 'asc' } })).toEqual([b.id, c.id, a.id])
        expect(await ids({ excludeRoles: ['router-retired'] })).toEqual([b.id, a.id])
        expect(await ids({ excludeRoles: ['router', 'router-retired'] })).toEqual([a.id])
        expect(await ids({ ids: [a.id, c.id] })).toEqual([c.id, a.id])
        expect(await sessions.query({ ids: [] })).toEqual({ items: [], total: 0 })
        expect((await sessions.query({ ids: [a.id, b.id, c.id], excludeRoles: ['router'], limit: 1 })).total).toBe(2)
        await expect(sessions.query({ orderBy: { field: 'slug' as any } })).rejects.toBeInstanceOf(ValidationError)
        // Same timestamps: ties break on id, so pages don't overlap.
        const same = await Promise.all([1, 2, 3, 4].map((i) => sessions.create({ employeeId: 'emp_tie', title: `T${i}` })))
        const p1 = await ids({ employeeId: 'emp_tie', limit: 2, orderBy: { field: 'updatedAt' } })
        const p2 = await ids({ employeeId: 'emp_tie', limit: 2, offset: 2, orderBy: { field: 'updatedAt' } })
        expect(new Set([...p1, ...p2])).toEqual(new Set(same.map((s) => s.id)))
      })
    })

    describe('fork and loop', () => {
      it('forks at the head by default, and forks of forks inherit the root', async () => {
        const p = await sessions.create({
          employeeId: EMP,
          title: 'Parent',
          toolset: ['t1'],
          entries: [user('one'), user('two')],
        })
        const f = await sessions.fork(p.id)
        expect(f.data).toMatchObject({
          rootId: p.id,
          depth: 1,
          parent: { sessionId: p.id, entryId: p.data.head },
          toolset: ['t1'],
        })
        expect(f.data.head).toBe(p.data.head)
        expect(f.data.employeeId).toBe(EMP)
        expect(f.data.title).toBe('Parent (fork)')
        const ff = await sessions.fork(f.id, { title: 'Grandchild', toolset: ['t2'] })
        expect(ff.data).toMatchObject({ rootId: p.id, depth: 2, toolset: ['t2'] })
        expect(
          (await records.linked({ kind: 'session', id: ff.id }, { role: 'forked_from', direction: 'out' }))[0]!.record.id,
        ).toBe(f.id)

        // The parent is untouched.
        expect((await sessions.require(p.id)).version).toBe(p.version)
        const tree = await sessions.tree(ff.id)
        expect(tree.session.id).toBe(p.id)
        expect(tree.children.map((c) => c.session.id)).toEqual([f.id])
        expect(tree.children[0]!.children.map((c) => c.session.id)).toEqual([ff.id])
        expect((await sessions.children(p.id)).map((s) => s.id)).toEqual([f.id])
        expect(await sessions.children(ff.id)).toEqual([])
      })

      it('forks at an earlier entry or at an entry of a running run', async () => {
        const p = await sessions.create({ employeeId: EMP, title: 'P', entries: [user('one'), user('two')] })
        const [one] = await sessions.history(p.id)
        const f = await sessions.fork(p.id, { atEntry: one!.id })
        expect(texts(await sessions.history(f.id))).toEqual(['one'])

        const run = await started(p.id)
        const e = await sessions.append(run.id, assistant('uncommitted'))
        const f2 = await sessions.fork(p.id, { atEntry: e.id })
        expect(texts(await sessions.history(f2.id))).toEqual(['one', 'two', 'uncommitted'])

        const empty = await sessions.fork(p.id, { atEntry: null })
        expect(empty.data.head).toBeNull()

        // Entries of other sessions are refused.
        const other = await sessions.create({ employeeId: EMP, title: 'Other', entries: [user('x')] })
        await expect(sessions.fork(p.id, { atEntry: other.data.head })).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.fork(p.id, { atEntry: 'ent_missing' })).rejects.toBeInstanceOf(NotFoundError)
      })

      it('loops: one fork per item with a user entry on top', async () => {
        const p = await sessions.create({ employeeId: EMP, title: 'Intake', entries: [user('start')] })
        const kids = await sessions.loop(p.id, [{ repo: 'a' }, 'b'], { titlePrefix: 'Repo' })
        expect(kids.map((k) => k.data.title)).toEqual(['Repo #1', 'Repo #2'])
        for (const [i, k] of kids.entries()) {
          const h = await sessions.history(k.id)
          expect(h.length).toBe(2)
          expect(h[0]!.id).toBe(p.data.head)
          expect(h[1]!.kind).toBe('user')
          expect(h[1]!.meta).toMatchObject({ sessionId: k.id, loopIndex: i })
          expect(k.data).toMatchObject({ depth: 1, rootId: p.id, parent: { sessionId: p.id, entryId: p.data.head } })
        }
        expect(texts(await sessions.history(kids[0]!.id))[1]).toBe('{"repo":"a"}')
        const rendered = await sessions.loop(p.id, [1, 2, 3], { render: (item, i) => `item ${i}: ${item}` })
        expect(texts(await sessions.history(rendered[2]!.id))[1]).toBe('item 2: 3')
        expect((await sessions.children(p.id)).length).toBe(5)
        expect(await sessions.loop(p.id, [])).toEqual([])
      })

      it('run history of a fork includes the parent history up to the fork point', async () => {
        const p = await sessions.create({ employeeId: EMP, title: 'P', entries: [user('a'), user('b'), user('c')] })
        const h = await sessions.history(p.id)
        const f = await sessions.fork(p.id, { atEntry: h[1]!.id })
        const run = await started(f.id)
        await sessions.append(run.id, assistant('fork work'))
        expect(texts(await sessions.runHistory(run.id))).toEqual(['a', 'b', 'fork work'])
        await sessions.commit(run.id)
        expect(texts(await sessions.history(f.id))).toEqual(['a', 'b', 'fork work'])
        expect(texts(await sessions.history(p.id))).toEqual(['a', 'b', 'c'])
      })
    })

    describe('runs', () => {
      it('creates runs from the session head with optional input', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S', entries: [user('a')], defaultRunMode: 'ephemeral' })
        const r = await sessions.createRun({ sessionId: s.id, cause: { type: 'event', eventId: 'evt_1' }, input: [user('item')] })
        expect(r.id).toMatch(/^run_/)
        expect(r.data).toMatchObject({
          sessionId: s.id,
          employeeId: EMP,
          rootSessionId: s.id,
          mode: 'ephemeral',
          state: 'queued',
          base: s.data.head,
          priority: 0,
          steps: 0,
        })
        const hist = await sessions.runHistory(r.id)
        expect(texts(hist)).toEqual(['a', 'item'])
        expect(r.data.tip).toBe(hist[1]!.id)
        expect(hist[1]!.meta).toMatchObject({ runId: r.id, sessionId: s.id, employeeId: EMP })

        const empty = await sessions.create({ employeeId: EMP, title: 'Empty' })
        const r2 = await sessions.createRun({ sessionId: empty.id, cause: { type: 'manual' }, priority: 5 })
        expect(r2.data).toMatchObject({ mode: 'continuing', base: null, tip: null, priority: 5 })
        expect(await sessions.runHistory(r2.id)).toEqual([])
        await expect(sessions.createRun({ sessionId: 'ses_nope', cause: { type: 'manual' } })).rejects.toBeInstanceOf(
          NotFoundError,
        )
      })

      it('allows at most one active continuing run per session', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const a = await sessions.createRun({ sessionId: s.id, cause: { type: 'manual' } })
        await expect(sessions.createRun({ sessionId: s.id, cause: { type: 'manual' } })).rejects.toBeInstanceOf(ConflictError)
        // Ephemeral runs are fine in parallel.
        await sessions.createRun({ sessionId: s.id, mode: 'ephemeral', cause: { type: 'manual' } })
        await sessions.createRun({ sessionId: s.id, mode: 'ephemeral', cause: { type: 'manual' } })
        expect((await sessions.activeContinuingRun(s.id))?.id).toBe(a.id)
        await sessions.transition(a.id, 'queued', 'cancelled')
        expect(await sessions.activeContinuingRun(s.id)).toBeNull()
        const b = await sessions.createRun({ sessionId: s.id, cause: { type: 'manual' } })
        expect((await sessions.activeContinuingRun(s.id))?.id).toBe(b.id)
      })

      it('races continuing-run creation: exactly one wins', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const res = await Promise.allSettled(
          Array.from({ length: 5 }, () => sessions.createRun({ sessionId: s.id, cause: { type: 'manual' } })),
        )
        expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1)
        for (const r of res) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictError)
      })

      it('transitions follow the state machine and publish run.state', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const r = await sessions.createRun({ sessionId: s.id, cause: { type: 'manual' } })
        const running = await sessions.transition(r.id, 'queued', 'running', { steps: 1, state: 'failed' } as any)
        expect(running.data.state).toBe('running')
        expect(running.data.steps).toBe(1)
        expect(running.data.startedAt).toBe(clock.iso())
        await expect(sessions.transition(r.id, 'queued', 'running')).rejects.toBeInstanceOf(ConflictError)
        await expect(sessions.transition(r.id, 'running', 'running')).rejects.toBeInstanceOf(ConflictError)
        clock.advance(5000)
        const done = await sessions.transition(r.id, ['running', 'suspended'], 'completed', {
          result: { status: 'completed', output: 'ok' },
        })
        expect(done.data.endedAt).toBe(clock.iso())
        expect(done.data.result?.output).toBe('ok')
        expect(done.key).toBeNull()
        await expect(sessions.transition(r.id, 'completed', 'queued')).rejects.toBeInstanceOf(ConflictError)
        expect(await topics(SessionTopics.runState)).toEqual([
          { runId: r.id, sessionId: s.id, employeeId: EMP, from: 'queued', to: 'running' },
          { runId: r.id, sessionId: s.id, employeeId: EMP, from: 'running', to: 'completed' },
        ])
      })

      it('races transitions: exactly one wins, and state-free updates do not get in the way', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const r = await sessions.createRun({ sessionId: s.id, cause: { type: 'manual' } })
        const res = await Promise.allSettled([
          sessions.transition(r.id, 'queued', 'running'),
          sessions.transition(r.id, 'queued', 'running'),
          sessions.transition(r.id, 'queued', 'cancelled'),
          sessions.updateRun(r.id, { steps: 3 }),
        ])
        const won = res.slice(0, 3).filter((x) => x.status === 'fulfilled')
        expect(won.length).toBe(1)
        for (const x of res.slice(0, 3)) if (x.status === 'rejected') expect(x.reason).toBeInstanceOf(ConflictError)
        expect(res[3]!.status).toBe('fulfilled')
        expect((await sessions.requireRun(r.id)).data.steps).toBe(3)
      })

      it('updateRun refuses state changes', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const r = await sessions.createRun({ sessionId: s.id, cause: { type: 'manual' } })
        await expect(sessions.updateRun(r.id, { state: 'running' } as any)).rejects.toBeInstanceOf(ValidationError)
        const u = await sessions.updateRun(r.id, { commit: false, pauseReason: 'x' })
        expect(u.data).toMatchObject({ commit: false, pauseReason: 'x', state: 'queued' })
        await expect(sessions.updateRun('run_nope', { steps: 1 })).rejects.toBeInstanceOf(NotFoundError)
      })

      it('lists runs with filters', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const a = await sessions.createRun({ sessionId: s.id, cause: { type: 'manual' } })
        const b = await sessions.createRun({ sessionId: s.id, mode: 'ephemeral', cause: { type: 'manual' } })
        await sessions.transition(b.id, 'queued', 'running')
        expect((await sessions.runs({ sessionId: s.id })).map((r) => r.id)).toEqual([a.id, b.id])
        expect((await sessions.runs({ state: 'running' })).map((r) => r.id)).toEqual([b.id])
        expect((await sessions.runs({ employeeId: EMP, state: ['queued', 'running'], limit: 1 })).length).toBe(1)
        expect((await sessions.runs({ rootSessionId: s.id })).length).toBe(2)
      })

      it('appends move the tip; concurrent appends chain; terminal runs refuse', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S', entries: [user('a')] })
        const r = await started(s.id)
        const es = await Promise.all([1, 2, 3, 4].map((i) => sessions.append(r.id, assistant(`m${i}`))))
        const hist = await sessions.runHistory(r.id)
        expect(hist.length).toBe(5)
        expect(new Set(hist.map((e) => e.id))).toEqual(new Set([s.data.head!, ...es.map((e) => e.id)]))
        await expect(sessions.append(r.id, { kind: 'bad' as any, content: {} })).rejects.toBeInstanceOf(ValidationError)
        await sessions.transition(r.id, 'running', 'failed')
        await expect(sessions.append(r.id, assistant('late'))).rejects.toBeInstanceOf(ConflictError)
      })
    })

    describe('commit', () => {
      it('moves the head to the tip, and ephemeral runs leave it alone', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S', entries: [user('a')] })
        const eph = await started(s.id, 'ephemeral')
        await sessions.append(eph.id, assistant('eph'))
        await sessions.transition(eph.id, 'running', 'completed')
        expect(texts(await sessions.history(s.id))).toEqual(['a'])

        const r = await started(s.id)
        const e = await sessions.append(r.id, assistant('b'))
        const after = await sessions.commit(r.id)
        expect(after.data.head).toBe(e.id)
        expect(texts(await sessions.history(s.id))).toEqual(['a', 'b'])
        expect((await sessions.requireRun(r.id)).data.committed).toMatchObject({ as: 'full', entryId: e.id })
        // Idempotent.
        expect((await sessions.commit(r.id)).data.head).toBe(e.id)
        expect(await topics(SessionTopics.sessionHead)).toEqual([{ sessionId: s.id, from: s.data.head, to: e.id, runId: r.id }])
      })

      it('is a no-op for a run with no entries', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S', entries: [user('a')] })
        const r = await started(s.id)
        expect((await sessions.commit(r.id)).data.head).toBe(s.data.head)
      })

      it('refuses when the head moved, and commitSummary lands on the new head', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S', entries: [user('a')] })
        const r1 = await started(s.id)
        const r2 = await started(s.id, 'ephemeral')
        await sessions.append(r1.id, assistant('r1'))
        const r2tip = await sessions.append(r2.id, assistant('r2'))
        await sessions.commit(r1.id)
        await expect(sessions.commit(r2.id)).rejects.toBeInstanceOf(ConflictError)
        const after = await sessions.commitSummary(r2.id, 'r2 did things')
        const hist = await sessions.history(s.id)
        expect(texts(hist)).toEqual(['a', 'r1', 'r2 did things'])
        expect(hist[2]!.kind).toBe('summary')
        expect(hist[2]!.content).toEqual({ text: 'r2 did things', rewoundTo: s.data.head, replacesTip: r2tip.id })
        expect(after.data.head).toBe(hist[2]!.id)
        await expect(sessions.commitSummary(r2.id, 'again')).rejects.toBeInstanceOf(ConflictError)
        await expect(sessions.commit(r2.id)).rejects.toBeInstanceOf(ConflictError)
        await expect(sessions.commitSummary(r1.id, ' ')).rejects.toBeInstanceOf(ValidationError)
      })

      it('races commits from the same base: exactly one wins', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S', entries: [user('a')] })
        const runs = await Promise.all([1, 2, 3].map(() => started(s.id, 'ephemeral')))
        for (const [i, r] of runs.entries()) await sessions.append(r.id, assistant(`r${i}`))
        const res = await Promise.allSettled([
          ...runs.map((r) => sessions.commit(r.id)),
          sessions.update(s.id, { title: 'renamed' }),
        ])
        const won = res.slice(0, 3).filter((x) => x.status === 'fulfilled')
        expect(won.length).toBe(1)
        for (const x of res.slice(0, 3)) if (x.status === 'rejected') expect(x.reason).toBeInstanceOf(ConflictError)
        expect(res[3]!.status).toBe('fulfilled')
        const final = await sessions.require(s.id)
        expect(final.data.title).toBe('renamed')
        expect((await sessions.history(s.id)).length).toBe(2)
      })
    })

    describe('rewind, offload, restore, compact', () => {
      async function setup() {
        const s = await sessions.create({
          employeeId: EMP,
          title: 'S',
          entries: [{ kind: 'system', content: { text: 'sys' } }, user('task')],
        })
        const r = await started(s.id)
        const a = await sessions.append(r.id, assistant('a'))
        const b = await sessions.append(r.id, { kind: 'tool_result', content: { toolCallId: 'c1', name: 'read', output: 'BIG' } })
        const c = await sessions.append(r.id, assistant('c'))
        return { s, r, a, b, c }
      }

      it('rewinds to an earlier entry with a summary; the old branch stays', async () => {
        const { s, r, a, c } = await setup()
        const before = await sessions.runHistory(r.id)
        const sum = await sessions.rewind(r.id, a.id, 'tried b and c')
        expect(sum.parent).toBe(a.id)
        expect(sum.content as unknown as SummaryContent).toEqual({ text: 'tried b and c', rewoundTo: a.id, replacesTip: c.id })
        expect(sum.meta).toMatchObject({ runId: r.id, sessionId: s.id, employeeId: EMP })
        const now = await sessions.runHistory(r.id)
        expect(texts(now)).toEqual(['sys', 'task', 'a', 'tried b and c'])
        expect((await sessions.requireRun(r.id)).data.tip).toBe(sum.id)
        // Old path still resolves, unchanged.
        expect(await records.store.entries.path(c.id)).toEqual(before)
        expect((await records.store.entries.children(a.id)).length).toBe(2)
        await expect(sessions.rewind(r.id, c.id, 'x')).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.rewind(r.id, a.id, '')).rejects.toBeInstanceOf(ValidationError)
        // Rewinding into the committed history before the base is allowed; commit moves the head there.
        const [sys] = now
        await sessions.rewind(r.id, sys!.id, 'started over')
        await sessions.commit(r.id)
        expect(texts(await sessions.history(s.id))).toEqual(['sys', 'started over'])
      })

      it('offloads an entry to a pointer and restores it', async () => {
        const { s, r, a, b, c } = await setup()
        const before = await sessions.runHistory(r.id)
        const tip = await sessions.offload(r.id, b.id, {
          text: 'see Retry policy',
          doc: { id: 'doc_1', chapter: 'Retry policy' },
        })
        const h = await sessions.runHistory(r.id)
        expect(h.map((e) => e.kind)).toEqual(['system', 'user', 'assistant', 'pointer', 'assistant'])
        expect(h[2]!.id).toBe(a.id)
        const ptr = h[3]!
        expect(ptr.parent).toBe(a.id)
        expect(ptr.content as unknown as PointerContent).toEqual({
          text: 'see Retry policy',
          original: b.id,
          doc: { id: 'doc_1', chapter: 'Retry policy' },
          // A pointer standing for a tool result names its call, so it can answer it.
          toolCallId: 'c1',
          toolName: 'read',
        })
        expect(ptr.meta).toMatchObject({ op: 'offload', offloadedKind: 'tool_result' })
        expect(tip.id).toBe(h[4]!.id)
        expect(tip.id).not.toBe(c.id)
        expect(tip.hash).toBe(c.hash)
        expect(tip.content).toEqual(c.content)
        expect(tip.meta).toMatchObject({ copiedFrom: c.id, runId: r.id, sessionId: s.id })
        expect(await records.store.entries.path(c.id)).toEqual(before)

        const restored = await sessions.restore(r.id, ptr.id)
        const h2 = await sessions.runHistory(r.id)
        expect(h2.map((e) => e.kind)).toEqual(['system', 'user', 'assistant', 'tool_result', 'assistant'])
        // The original goes straight back (same parent), the rest is re-created.
        expect(h2[3]!.id).toBe(b.id)
        expect(restored.meta.copiedFrom).toBe(tip.id)
        expect(restored.content).toEqual(c.content)
        // Old paths still resolve.
        expect(texts(await records.store.entries.path(tip.id))).toEqual(texts(h))

        await expect(sessions.restore(r.id, b.id)).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.restore(r.id, ptr.id)).rejects.toBeInstanceOf(ValidationError) // no longer on the path
        await expect(sessions.offload(r.id, h2[0]!.id, { text: 'x' })).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.offload(r.id, 'ent_nope', { text: 'x' })).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.offload(r.id, b.id, { text: '' })).rejects.toBeInstanceOf(ValidationError)
      })

      it('offloads the last entry, then restores a pointer that was copied by a later offload', async () => {
        const { r, a, b, c } = await setup()
        const p1 = await sessions.offload(r.id, c.id, { text: 'c offloaded' })
        expect(p1.kind).toBe('pointer')
        expect((await sessions.requireRun(r.id)).data.tip).toBe(p1.id)
        // Offload an earlier entry: the pointer for c gets copied on top.
        await sessions.offload(r.id, a.id, { text: 'a offloaded' })
        let h = await sessions.runHistory(r.id)
        expect(h.map((e) => e.kind)).toEqual(['system', 'user', 'pointer', 'tool_result', 'pointer'])
        expect(h[3]!.meta.copiedFrom).toBe(b.id)
        await expect(sessions.offload(r.id, h[4]!.id, { text: 'x' })).rejects.toBeInstanceOf(ValidationError)
        // Restoring the copied pointer: c's parent is b, not the copy of b, so c is re-created.
        const back = await sessions.restore(r.id, h[4]!.id)
        h = await sessions.runHistory(r.id)
        expect(texts(h)).toEqual(['sys', 'task', 'a offloaded', 'read', 'c'])
        expect(back.id).not.toBe(c.id)
        expect(back.meta.copiedFrom).toBe(c.id)
      })

      it('compacts to the first entry', async () => {
        const { s, r } = await setup()
        const e = await sessions.compact(r.id, 'everything so far')
        expect(texts(await sessions.runHistory(r.id))).toEqual(['sys', 'everything so far'])
        expect(e.meta.op).toBe('compact')
        const empty = await sessions.create({ employeeId: EMP, title: 'E' })
        const r2 = await started(empty.id)
        await expect(sessions.compact(r2.id, 'x')).rejects.toBeInstanceOf(ValidationError)
        expect(s).toBeTruthy()
      })

      it('compacts keeping the latest entries verbatim, with extra meta on the summary', async () => {
        const { s, r, a, b, c } = await setup()
        const before = await sessions.runHistory(r.id)
        const tip = await sessions.compact(r.id, 'what came before', { keepFrom: a.id, meta: { automatic: true } })
        const h = await sessions.runHistory(r.id)
        expect(h.map((e) => e.kind)).toEqual(['system', 'summary', 'assistant', 'tool_result', 'assistant'])
        expect(h[1]!.meta).toMatchObject({ op: 'compact', automatic: true, keptEntries: 3, keptFrom: a.id })
        expect(h[1]!.content as unknown as SummaryContent).toEqual({
          text: 'what came before',
          rewoundTo: before[0]!.id,
          replacesTip: c.id,
        })
        expect(h.slice(2).map((e) => e.meta.copiedFrom)).toEqual([a.id, b.id, c.id])
        expect(h.slice(2).map((e) => e.content)).toEqual([a.content, b.content, c.content])
        expect(tip.id).toBe(h[4]!.id)
        // The detailed branch is still in the tree.
        expect(await records.store.entries.path(c.id)).toEqual(before)
        // Committing a continuing run moves the head onto the compacted branch.
        await sessions.commit(r.id)
        expect((await sessions.history(s.id)).map((e) => e.kind)).toEqual(h.map((e) => e.kind))
      })

      it('compacts with nothing kept, and refuses a keepFrom off the path or at the first entry', async () => {
        const { r } = await setup()
        const first = (await sessions.runHistory(r.id))[0]!
        await expect(sessions.compact(r.id, 'x', { keepFrom: 'ent_nope' })).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.compact(r.id, 'x', { keepFrom: first.id })).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.compact(r.id, ' ', { meta: { automatic: true } })).rejects.toBeInstanceOf(ValidationError)
        await sessions.compact(r.id, 'all of it', { meta: { automatic: true } })
        expect(texts(await sessions.runHistory(r.id))).toEqual(['sys', 'all of it'])
      })

      describe('collapsing a stretch with rewind', () => {
        const call = (...ids: string[]) => ({
          kind: 'assistant' as const,
          content: { text: null, toolCalls: ids.map((id) => ({ id, name: 'files.read', arguments: '{}' })) },
        })
        const result = (id: string, output = `contents of ${id}`) => ({
          kind: 'tool_result' as const,
          content: { toolCallId: id, name: 'files.read', output },
        })
        const kinds = (h: { kind: string }[]) => h.map((e) => e.kind)

        /** sys, task; the reading (two turns); the answer, a new message and a reply. */
        async function reading(mode: 'continuing' | 'ephemeral' = 'continuing') {
          const s = await sessions.create({
            employeeId: EMP,
            title: 'R',
            entries: [{ kind: 'system', content: { text: 'sys' } }, user('what does PAY-7 need?')],
          })
          const r = await started(s.id, mode)
          const a1 = await sessions.append(r.id, call('c1'))
          const r1 = await sessions.append(r.id, result('c1'))
          const a2 = await sessions.append(r.id, call('c2', 'c3'))
          await sessions.append(r.id, result('c2'))
          const r3 = await sessions.append(r.id, result('c3'))
          const answer = await sessions.append(r.id, assistant('PAY-7 needs a refund'))
          const msg = await sessions.append(r.id, user('thanks, and the invoice?'))
          const reply = await sessions.append(r.id, assistant('invoice 9'))
          const task = (await sessions.runHistory(r.id))[1]!
          return { s, r, task, a1, r1, a2, r3, answer, msg, reply }
        }

        it('replaces the stretch with a summary and keeps everything after it verbatim, in order', async () => {
          const { r, task, a1, r3, answer, msg, reply } = await reading()
          const before = await sessions.runHistory(r.id)
          const tip = await sessions.rewind(r.id, task.id, 'read c1-c3: PAY-7 needs a refund', { keepFrom: answer.id })
          const h = await sessions.runHistory(r.id)
          expect(texts(h)).toEqual([
            'sys',
            'what does PAY-7 need?',
            'read c1-c3: PAY-7 needs a refund',
            'PAY-7 needs a refund',
            'thanks, and the invoice?',
            'invoice 9',
          ])
          expect(h.slice(3).map((e) => e.content)).toEqual([answer.content, msg.content, reply.content])
          expect(h.slice(3).map((e) => e.meta.copiedFrom)).toEqual([answer.id, msg.id, reply.id])
          expect(h[2]!.parent).toBe(task.id)
          expect(h[2]!.meta).toMatchObject({
            op: 'rewind',
            collapsedEntries: 5,
            collapsedToolCalls: 3,
            collapsedFrom: a1.id,
            collapsedTo: r3.id,
            keptEntries: 3,
            keptFrom: answer.id,
          })
          expect(h[2]!.content as unknown as SummaryContent).toMatchObject({ rewoundTo: task.id, replacesTip: reply.id })
          expect(tip.id).toBe(h[5]!.id)
          expect((await sessions.requireRun(r.id)).data.tip).toBe(tip.id)
          // The detailed branch is still in the tree.
          expect(await records.store.entries.path(reply.id)).toEqual(before)
        })

        it('takes the last collapsed entry instead (keepAfter)', async () => {
          const { r, task, r3 } = await reading()
          await sessions.rewind(r.id, task.id, 'the reading', { keepAfter: r3.id })
          expect(kinds(await sessions.runHistory(r.id))).toEqual(['system', 'user', 'summary', 'assistant', 'user', 'assistant'])
        })

        it('collapses up to a result in the middle of the latest turn: the later calls come along with their results', async () => {
          const { r, answer } = await reading()
          // The latest turn: read c4, read c5, then the call that collapses (c6), all answered.
          const a = await sessions.append(r.id, call('c4', 'c5', 'c6'))
          const r4 = await sessions.append(r.id, result('c4'))
          const r5 = await sessions.append(r.id, result('c5'))
          const r6 = await sessions.append(r.id, result('c6', 'collapsed'))
          await sessions.rewind(r.id, answer.id, 'read c4: nothing new', { keepAfter: r4.id })
          const h = await sessions.runHistory(r.id)
          expect(kinds(h.slice(-5))).toEqual(['assistant', 'summary', 'assistant', 'tool_result', 'tool_result'])
          const carried = h[h.length - 3]!
          expect((carried.content as any).toolCalls.map((c: { id: string }) => c.id)).toEqual(['c5', 'c6'])
          expect(carried.meta).toMatchObject({ copiedFrom: a.id, trimmedCalls: true })
          expect(h.slice(-2).map((e) => e.content)).toEqual([r5.content, r6.content])
          expect(h[h.length - 4]!.meta).toMatchObject({ collapsedEntries: 4, collapsedToolCalls: 1, keptEntries: 2 })
        })

        it('still jumps back without a kept part', async () => {
          const { r, a1, r1, reply } = await reading()
          const tip = await sessions.rewind(r.id, r1.id, 'dead end after c1')
          expect(texts(await sessions.runHistory(r.id)).slice(-1)).toEqual(['dead end after c1'])
          expect(tip.parent).toBe(r1.id)
          expect(tip.meta.collapsedEntries).toBeUndefined()
          expect((tip.content as unknown as SummaryContent).replacesTip).toBe(reply.id)
          expect(a1).toBeTruthy()
        })

        it('never separates a tool call from its results, and refuses bad points', async () => {
          const { r, task, a1, a2, r1, answer } = await reading()
          const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ValidationError)
          // Between a call and its results, in both modes.
          await refused(sessions.rewind(r.id, a2.id, 'x', { keepFrom: answer.id }))
          await refused(sessions.rewind(r.id, a1.id, 'x'))
          // Off the path, both options, kept part before the point, nothing collapsed.
          await refused(sessions.rewind(r.id, 'ent_nope', 'x', { keepFrom: answer.id }))
          await refused(sessions.rewind(r.id, task.id, 'x', { keepFrom: 'ent_nope' }))
          await refused(sessions.rewind(r.id, task.id, 'x', { keepFrom: answer.id, keepAfter: r1.id }))
          await refused(sessions.rewind(r.id, answer.id, 'x', { keepFrom: a1.id }))
          await refused(sessions.rewind(r.id, task.id, 'x', { keepFrom: a1.id }))
          await refused(sessions.rewind(r.id, task.id, ' ', { keepFrom: answer.id }))
          // Nothing changed.
          expect((await sessions.runHistory(r.id)).length).toBe(10)
        })

        it('refuses to drop a tool call still waiting for its result', async () => {
          const { r, task, answer } = await reading()
          const open = await sessions.append(r.id, call('c8', 'c9'))
          await sessions.append(r.id, result('c8'))
          const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ValidationError)
          await refused(sessions.rewind(r.id, task.id, 'x', { keepAfter: open.id }))
          await refused(sessions.rewind(r.id, task.id, 'x'))
          // A collapse before the open turn leaves it alone (kept verbatim).
          await sessions.rewind(r.id, task.id, 'the reading', { keepFrom: answer.id })
          const h = await sessions.runHistory(r.id)
          expect(kinds(h.slice(-2))).toEqual(['assistant', 'tool_result'])
        })

        it('collapses entries of earlier runs of a continuing session; the commit moves the head and the next run sees it', async () => {
          const { s, r, task, answer, reply } = await reading()
          await sessions.commit(r.id)
          await sessions.transition(r.id, 'running', 'completed')
          const r2 = await started(s.id)
          const m2 = await sessions.append(r2.id, user('is it paid?'))
          await sessions.append(r2.id, assistant('not yet'))
          const base = (await sessions.requireRun(r2.id)).data.base
          expect(base).toBe(reply.id)
          // The stretch lies in the first run; the run's base is no longer on its path afterwards.
          await sessions.rewind(r2.id, task.id, 'read c1-c3', { keepFrom: answer.id })
          const h = await sessions.runHistory(r2.id)
          expect(h.some((e) => e.id === base)).toBe(false)
          expect(texts(h)).toEqual([
            'sys',
            'what does PAY-7 need?',
            'read c1-c3',
            'PAY-7 needs a refund',
            'thanks, and the invoice?',
            'invoice 9',
            'is it paid?',
            'not yet',
          ])
          expect(h[6]!.meta.copiedFrom).toBe(m2.id)
          const session = await sessions.commit(r2.id)
          expect(session.data.head).toBe(h[h.length - 1]!.id)
          expect((await sessions.requireRun(r2.id)).data.committed).toMatchObject({ as: 'full', entryId: session.data.head })
          await sessions.transition(r2.id, 'running', 'completed')
          const r3 = await started(s.id)
          expect(texts(await sessions.runHistory(r3.id))).toEqual(texts(h))
        })

        it('when the head moved meanwhile, the commit is refused and a summary goes on the new head', async () => {
          const { s, r, task, answer } = await reading()
          await sessions.commit(r.id)
          await sessions.transition(r.id, 'running', 'completed')
          const r2 = await started(s.id)
          await sessions.append(r2.id, assistant('working'))
          await sessions.rewind(r2.id, task.id, 'read c1-c3', { keepFrom: answer.id })
          // Someone else moves the head: an ephemeral run that commits.
          const e = await started(s.id, 'ephemeral')
          await sessions.append(e.id, assistant('side note'))
          await sessions.commit(e.id)
          await expect(sessions.commit(r2.id)).rejects.toBeInstanceOf(ConflictError)
          const after = await sessions.commitSummary(r2.id, 'worked; collapsed the reading')
          const h = await sessions.history(s.id)
          expect(texts(h).slice(-2)).toEqual(['side note', 'worked; collapsed the reading'])
          expect(after.data.head).toBe(h[h.length - 1]!.id)
          // The committed history keeps the detail: the collapse was the run's.
          expect(h.length).toBe(12)
        })

        it('in an ephemeral run, collapses only the run: the head stays unless it commits', async () => {
          // A session whose history holds the reading.
          const base = await sessions.create({
            employeeId: EMP,
            title: 'E',
            entries: [{ kind: 'system', content: { text: 'sys' } }, user('q'), call('c1'), result('c1'), assistant('a')],
          })
          const head = base.data.head
          const hist = await sessions.history(base.id)
          const e = await started(base.id, 'ephemeral')
          await sessions.append(e.id, user('more'))
          await sessions.rewind(e.id, hist[1]!.id, 'read c1', { keepFrom: hist[4]!.id })
          expect(texts(await sessions.runHistory(e.id))).toEqual(['sys', 'q', 'read c1', 'a', 'more'])
          expect((await sessions.require(base.id)).data.head).toBe(head)
          await sessions.transition(e.id, 'running', 'completed')
          const next = await started(base.id, 'ephemeral')
          expect((await sessions.runHistory(next.id)).length).toBe(5)
          // Committing an ephemeral run that collapsed moves the head onto the collapsed branch.
          await sessions.append(next.id, user('again'))
          await sessions.rewind(next.id, hist[1]!.id, 'read c1', { keepFrom: hist[4]!.id })
          await sessions.commit(next.id)
          expect(texts(await sessions.history(base.id))).toEqual(['sys', 'q', 'read c1', 'a', 'again'])
        })
      })

      it('refuses tree operations on terminal runs', async () => {
        const { r, a } = await setup()
        await sessions.transition(r.id, 'running', 'cancelled')
        await expect(sessions.rewind(r.id, a.id, 'x')).rejects.toBeInstanceOf(ConflictError)
      })
    })

    describe('waiting', () => {
      it('suspends with a runs wait and tracks waiters via links', async () => {
        const p = await sessions.create({ employeeId: EMP, title: 'P', document: 'parent doc' })
        const [k1, k2] = await sessions.loop(p.id, ['x', 'y'])
        await sessions.update(k1!.id, { document: 'k1 doc' })
        const c1 = await started(k1!.id, 'ephemeral')
        const c2 = await started(k2!.id, 'ephemeral')
        const parent = await started(p.id)
        await expect(sessions.suspend(parent.id, { type: 'runs', runIds: [], mode: 'all' })).rejects.toBeInstanceOf(
          ValidationError,
        )
        await expect(sessions.suspend(parent.id, { type: 'runs', runIds: ['run_nope'], mode: 'all' })).rejects.toBeInstanceOf(
          NotFoundError,
        )
        await expect(sessions.suspend(parent.id, { type: 'runs', runIds: [parent.id], mode: 'all' })).rejects.toBeInstanceOf(
          ValidationError,
        )
        const sus = await sessions.suspend(parent.id, { type: 'runs', runIds: [c1.id, c2.id], mode: 'all' })
        expect(sus.data.state).toBe('suspended')
        expect((await sessions.waitersOf(c1.id)).map((r) => r.id)).toEqual([parent.id])
        expect(await sessions.isWaitSatisfied(sus)).toBe(false)

        await sessions.transition(c1.id, 'running', 'completed', { result: { status: 'completed', output: 'one' } })
        expect(await sessions.isWaitSatisfied(sus)).toBe(false)
        expect(
          await sessions.isWaitSatisfied({
            ...sus,
            data: { ...sus.data, wait: { type: 'runs', runIds: [c1.id, c2.id], mode: 'any' } },
          }),
        ).toBe(true)
        await sessions.transition(c2.id, 'running', 'failed', { result: { status: 'failed', error: 'boom' } })
        expect(await sessions.isWaitSatisfied(sus)).toBe(true)
        expect(await sessions.waitResults(sus)).toEqual([
          {
            runId: c1.id,
            sessionId: k1!.id,
            state: 'completed',
            result: { status: 'completed', output: 'one' },
            document: 'k1 doc',
            done: true,
          },
          {
            runId: c2.id,
            sessionId: k2!.id,
            state: 'failed',
            result: { status: 'failed', error: 'boom' },
            document: '',
            done: true,
          },
        ])

        const woke = await sessions.transition(parent.id, 'suspended', 'queued')
        expect(woke.data.wait).toBeDefined() // kept so the resumed run can read its results
        expect(await sessions.waitersOf(c1.id)).toEqual([])
        expect(await records.links({ from: { kind: 'run', id: parent.id }, role: 'waits_on' })).toEqual([])
      })

      it('only suspends running runs', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const r = await sessions.createRun({ sessionId: s.id, cause: { type: 'manual' } })
        await expect(sessions.suspend(r.id, { type: 'delivery' })).rejects.toBeInstanceOf(ConflictError)
        await sessions.transition(r.id, 'queued', 'running')
        await expect(sessions.transition(r.id, 'running', 'suspended')).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.suspend(r.id, { type: 'timer', until: 'not a date' })).rejects.toBeInstanceOf(ValidationError)
      })

      it('times out runs waits and reports which runs were not done', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const child = await sessions.fork(s.id)
        const c = await started(child.id, 'ephemeral')
        const r = await started(s.id)
        const timeoutAt = new Date(clock.now() + 60_000).toISOString()
        const sus = await sessions.suspend(r.id, { type: 'runs', runIds: [c.id], mode: 'all', timeoutAt })
        expect(await sessions.isWaitSatisfied(sus)).toBe(false)
        clock.advance(60_000)
        expect(await sessions.isWaitSatisfied(sus)).toBe(true)
        expect((await sessions.waitResults(sus))[0]).toMatchObject({ runId: c.id, state: 'running', done: false })
      })

      it('delivery waits are satisfied by unconsumed inbox items, or their timeout', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const r = await started(s.id)
        const sus = await sessions.suspend(r.id, { type: 'delivery', timeoutAt: new Date(clock.now() + 1000).toISOString() })
        expect(await sessions.isWaitSatisfied(sus)).toBe(false)
        expect(await sessions.waitResults(sus)).toEqual([])
        clock.advance(1000)
        expect(await sessions.isWaitSatisfied(sus)).toBe(true)
        clock.advance(-1000)
        await sessions.addToInbox({
          sessionId: s.id,
          eventId: 'evt_1',
          expectedToAct: true,
          trusted: true,
          text: 'hi',
          source: 'chat',
          type: 'message.posted',
        })
        expect(await sessions.isWaitSatisfied(sus)).toBe(true)
      })

      it('timer waits use the clock; runs without a wait are never satisfied', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const r = await started(s.id)
        expect(await sessions.isWaitSatisfied(r)).toBe(false)
        const sus = await sessions.suspend(r.id, { type: 'timer', until: new Date(clock.now() + 5000).toISOString() })
        expect(await sessions.isWaitSatisfied(sus)).toBe(false)
        clock.advance(5000)
        expect(await sessions.isWaitSatisfied(sus)).toBe(true)
      })
    })

    describe('inbox', () => {
      const item = (sessionId: string, eventId: string) => ({
        sessionId,
        eventId,
        expectedToAct: true,
        trusted: false,
        text: `event ${eventId}`,
        source: 'mcp:slack',
        type: 'message.posted',
      })

      it('keeps unconsumed items oldest first, dedupes, and publishes', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const a = await sessions.addToInbox(item(s.id, 'evt_a'))
        const b = await sessions.addToInbox(item(s.id, 'evt_b'))
        const again = await sessions.addToInbox(item(s.id, 'evt_a'))
        expect(again.id).toBe(a.id)
        expect((await sessions.inbox(s.id)).map((i) => i.id)).toEqual([a.id, b.id])
        expect(a.data.consumed).toBe(false)
        expect((await topics(SessionTopics.inboxAdded)).length).toBe(2)
        await expect(sessions.addToInbox(item('ses_nope', 'evt_x'))).rejects.toBeInstanceOf(NotFoundError)
      })

      it('takes items once, even with concurrent takers', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S' })
        const r = await started(s.id)
        for (const e of ['e1', 'e2', 'e3']) await sessions.addToInbox(item(s.id, e))
        const [x, y] = await Promise.all([sessions.takeInbox(s.id, r.id), sessions.takeInbox(s.id, r.id)])
        expect(x!.length + y!.length).toBe(3)
        expect([...x!, ...y!].every((i) => i.data.consumed && i.data.consumedByRun === r.id)).toBe(true)
        expect(await sessions.inbox(s.id)).toEqual([])
        expect(await sessions.takeInbox(s.id, r.id)).toEqual([])
        const other = await sessions.create({ employeeId: EMP, title: 'O' })
        await expect(sessions.takeInbox(other.id, r.id)).rejects.toBeInstanceOf(ValidationError)
      })
    })

    describe('templates', () => {
      it('CRUD and creating sessions from a template', async () => {
        const project = await records.create('project', { name: 'Billing' })
        const t = await sessions.createTemplate({
          name: 'Fix {{ticket}}',
          instructions: 'Fix ticket {{ticket}} in {{repo}}. Notes: {{notes}} {{undeclared}}',
          params: [{ name: 'ticket', required: true }, { name: 'repo', required: true }, { name: 'notes' }],
          toolset: ['git.read'],
          defaultRunMode: 'ephemeral',
          links: [{ ref: { kind: 'project', id: project.id }, role: 'works_on' }],
          document: '# {{ticket}}',
          checklist: [{ text: 'tests pass' }],
        })
        expect(t.id).toMatch(/^tpl_/)
        expect((await sessions.templates()).map((x) => x.id)).toEqual([t.id])
        const t2 = await sessions.updateTemplate(t.id, { description: 'fix a bug' })
        expect(t2.version).toBe(2)
        expect((await sessions.getTemplate(t.id))?.data.description).toBe('fix a bug')

        await expect(sessions.fromTemplate(t.id, { employeeId: EMP, params: { ticket: 'BIL-1' } })).rejects.toThrow(
          'repo is required',
        )
        const s = await sessions.fromTemplate(t.id, {
          employeeId: EMP,
          params: { ticket: 'BIL-1', repo: 'billing' },
          entriesBefore: [{ kind: 'system', content: { text: 'identity' } }],
        })
        expect(s.data).toMatchObject({
          title: 'Fix BIL-1',
          slug: 'fix-bil-1',
          toolset: ['git.read'],
          defaultRunMode: 'ephemeral',
          document: '# BIL-1',
          template: { id: t.id, version: 2 },
        })
        expect(texts(await sessions.history(s.id))).toEqual(['identity', 'Fix ticket BIL-1 in billing. Notes:  {{undeclared}}'])
        expect((await records.linked({ kind: 'session', id: s.id }, { role: 'works_on' })).length).toBe(1)
        const run = await sessions.createRun({ sessionId: s.id, cause: { type: 'event' } })
        expect(run.data.mode).toBe('ephemeral')
      })

      it('validates templates', async () => {
        await expect(sessions.createTemplate({ name: '', instructions: 'x' })).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.createTemplate({ name: 'x', instructions: 'x', params: [{ name: 'a b' }] })).rejects.toBeInstanceOf(
          ValidationError,
        )
        await expect(
          sessions.createTemplate({ name: 'x', instructions: 'x', params: [{ name: 'a' }, { name: 'a' }] }),
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(sessions.fromTemplate('tpl_nope', { employeeId: EMP })).rejects.toBeInstanceOf(NotFoundError)
      })
    })

    describe('search', () => {
      it('finds entries across sessions, attributed to the session that wrote them', async () => {
        const p = await sessions.create({ employeeId: EMP, title: 'P', entries: [user('the retry policy is exponential')] })
        const f = await sessions.fork(p.id)
        const r = await started(f.id)
        await sessions.append(r.id, assistant('retry policy confirmed in fork'))
        await sessions.create({ employeeId: 'emp_other', title: 'O', entries: [user('another retry policy')] })

        const all = await sessions.search({ text: 'RETRY POLICY' })
        expect(all.total).toBe(3)
        const inherited = all.items.find((h) => h.entry.id === p.data.head)!
        expect(inherited.sessionId).toBe(p.id)
        expect(inherited.session?.id).toBe(p.id)
        expect(inherited.snippet).toBe('the retry policy is exponential')

        const inFork = await sessions.search({ text: 'retry', sessionIds: [f.id] })
        expect(inFork.items.map((h) => h.snippet)).toEqual(['retry policy confirmed in fork'])
        expect(inFork.items[0]!.entry.meta.runId).toBe(r.id)
        expect((await sessions.search({ text: 'retry', employeeId: EMP })).total).toBe(2)
        expect((await sessions.search({ text: 'retry', kinds: ['assistant'] })).total).toBe(1)
        expect((await sessions.search({ text: 'retry', limit: 1 })).items.length).toBe(1)
        expect((await sessions.search({ text: 'retry', sessionIds: [] })).total).toBe(0)
        expect((await sessions.search({ text: 'retry', excludeSessionIds: [f.id] })).total).toBe(2)
        expect((await sessions.search({ text: 'policy fork', allWords: true })).items.map((h) => h.sessionId)).toEqual([f.id])
        expect((await sessions.search({ text: 'policy fork' })).total).toBe(0)
        await expect(sessions.search({ text: '' })).rejects.toBeInstanceOf(ValidationError)
      })

      it('attributes summaries, pointers and copies to the run and its session', async () => {
        const s = await sessions.create({ employeeId: EMP, title: 'S', entries: [user('root'), user('big output')] })
        const r = await started(s.id)
        const a = await sessions.append(r.id, assistant('after'))
        const h = await sessions.runHistory(r.id)
        await sessions.offload(r.id, h[1]!.id, { text: 'pointer text' })
        await sessions.rewind(r.id, h[0]!.id, 'summary text')
        for (const text of ['pointer text', 'summary text']) {
          const hit = (await sessions.search({ text })).items[0]!
          expect(hit.entry.meta).toMatchObject({ sessionId: s.id, employeeId: EMP, runId: r.id })
        }
        const copies = (await sessions.search({ text: 'after' })).items
        expect(copies.length).toBe(2)
        expect(copies.find((c) => c.entry.id !== a.id)!.entry.meta.copiedFrom).toBe(a.id)
      })
    })
  })
}
