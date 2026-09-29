import { ManualClock, ValidationError, createEventBus, type BusMessage } from '@mp/core'
import { createRecords } from '@mp/records'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  EventTopics,
  createEvents,
  defaultDedupeKey,
  internalSubject,
  subjectKey,
  triggerMatches,
  type EventData,
  type EventIngested,
  type Events,
} from '../src/index.ts'

const EMP = 'emp_01J00000000000000000000001'
const EMP2 = 'emp_01J00000000000000000000002'
const SES = 'ses_01J00000000000000000000001'
const SES2 = 'ses_01J00000000000000000000002'
const SES3 = 'ses_01J00000000000000000000003'
const PAY = { system: 'linear', id: 'PAY-123' }

let clock: ManualClock
let events: Events
let messages: BusMessage<EventIngested>[]

beforeEach(() => {
  clock = new ManualClock()
  const bus = createEventBus({ now: () => clock.now() })
  messages = []
  bus.subscribe<EventIngested>(EventTopics.ingested, (m) => void messages.push(m))
  const store = memoryStore({ clock })
  const records = createRecords({ store, bus })
  events = createEvents({ records, clock, bus })
})

const ev = (over: Partial<EventData> = {}): EventData => ({
  source: 'mcp:linear',
  type: 'task.assigned',
  routed: false,
  receivedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('helpers', () => {
  it('subjectKey and internalSubject', () => {
    expect(subjectKey(PAY)).toBe('linear:PAY-123')
    expect(internalSubject('msg_1')).toEqual({ system: 'mp', id: 'msg_1' })
  })
  it('defaultDedupeKey is stable and content-based', () => {
    const a = defaultDedupeKey({ source: 's', type: 't', payload: { a: 1, b: 2 } })
    const b = defaultDedupeKey({ source: 's', type: 't', payload: { b: 2, a: 1 } })
    const c = defaultDedupeKey({ source: 's', type: 't', payload: { a: 2 } })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('s:t:')).toBe(true)
  })
})

describe('ingest', () => {
  it('stores an event with defaults and publishes', async () => {
    const { event, created } = await events.ingest({
      source: 'mcp:linear',
      type: 'task.assigned',
      dedupeKey: 'linear:PAY-123:assigned',
      subject: PAY,
      employeeId: EMP,
      payload: { title: 'Refund', assignee: 'bot' },
      text: 'PAY-123 assigned',
    })
    expect(created).toBe(true)
    expect(event.id).toMatch(/^evt_/)
    expect(event.key).toBe('linear:PAY-123:assigned')
    expect(event.data).toMatchObject({ routed: false, subjectKey: 'linear:PAY-123', receivedAt: clock.iso() })
    await Promise.resolve()
    expect(messages.map((m) => m.payload)).toEqual([{ eventId: event.id, created: true }])
    expect(await events.require(event.id)).toEqual(event)
  })

  it('dedupes by key', async () => {
    const a = await events.ingest({ source: 'x', type: 'y', dedupeKey: 'k1', payload: 1 })
    const b = await events.ingest({ source: 'x', type: 'y', dedupeKey: 'k1', payload: 2 })
    expect(b.created).toBe(false)
    expect(b.event.id).toBe(a.event.id)
    expect(b.event.data.payload).toBe(1)
    expect((await events.query()).length).toBe(1)
  })

  it('dedupes by content when no key is given', async () => {
    const a = await events.ingest({ source: 'x', type: 'y', payload: { n: 1 } })
    const b = await events.ingest({ source: 'x', type: 'y', payload: { n: 1 } })
    const c = await events.ingest({ source: 'x', type: 'y', payload: { n: 2 } })
    const d = await events.ingest({ source: 'x', type: 'y', payload: { n: 1 }, subject: PAY })
    expect(b.event.id).toBe(a.event.id)
    expect(c.created).toBe(true)
    expect(d.created).toBe(true)
  })

  it('dedupes under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => events.ingest({ source: 'x', type: 'y', dedupeKey: 'same', payload: i })),
    )
    expect(results.filter((r) => r.created).length).toBe(1)
    expect(new Set(results.map((r) => r.event.id)).size).toBe(1)
    expect((await events.query()).length).toBe(1)
  })

  it('validates input', async () => {
    await expect(events.ingest({ source: '', type: 'y' })).rejects.toBeInstanceOf(ValidationError)
    await expect(events.ingest({ source: 'x', type: '' })).rejects.toBeInstanceOf(ValidationError)
    await expect(events.ingest({ source: 'x', type: 'y', subject: { system: 'a' } as any })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(events.ingest({ source: 'x', type: 'y', employeeId: 'nope' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('require throws for unknown ids', async () => {
    await expect(events.require('evt_missing')).rejects.toThrow(/not found/)
    expect(await events.get('evt_missing')).toBeNull()
  })

  it('markRouted is idempotent', async () => {
    const { event } = await events.ingest({ source: 'x', type: 'y', dedupeKey: 'k' })
    const r1 = await events.markRouted(event.id)
    const at = r1.data.routedAt
    clock.advance(1000)
    const r2 = await events.markRouted(event.id)
    expect(r2.data.routed).toBe(true)
    expect(r2.data.routedAt).toBe(at)
    expect(r2.version).toBe(r1.version)
  })

  it('queries by source, type, routed, subject, since and limit', async () => {
    const a = await events.ingest({ source: 'chat', type: 'message.posted', dedupeKey: 'a', subject: internalSubject('msg_a') })
    clock.advance(1000)
    const b = await events.ingest({ source: 'chat', type: 'message.replied', dedupeKey: 'b', subject: internalSubject('msg_a') })
    clock.advance(1000)
    const c = await events.ingest({ source: 'mcp:linear', type: 'task.assigned', dedupeKey: 'c', subject: PAY })
    await events.markRouted(a.event.id)
    const ids = (q: Parameters<Events['query']>[0]) => events.query(q).then((l) => l.map((e) => e.id))
    expect(await ids({ source: 'chat' })).toEqual([a.event.id, b.event.id])
    expect(await ids({ type: 'task.assigned' })).toEqual([c.event.id])
    expect(await ids({ routed: false })).toEqual([b.event.id, c.event.id])
    expect(await ids({ subjectKey: 'mp:msg_a' })).toEqual([a.event.id, b.event.id])
    expect(await ids({ since: b.event.data.receivedAt })).toEqual([b.event.id, c.event.id])
    expect(await ids({ limit: 1 })).toEqual([a.event.id])
  })
})

describe('triggerMatches', () => {
  it('matches source and type globs', () => {
    expect(triggerMatches({ type: 'task.*' }, ev())).toBe(true)
    expect(triggerMatches({ type: 'task.*' }, ev({ type: 'task.assigned.again' }))).toBe(false)
    expect(triggerMatches({ type: 'task.**' }, ev({ type: 'task.assigned.again' }))).toBe(true)
    expect(triggerMatches({ source: 'mcp:*' }, ev())).toBe(true)
    expect(triggerMatches({ source: 'chat' }, ev())).toBe(false)
    expect(triggerMatches({}, ev())).toBe(true)
  })
  it('matches subjects', () => {
    expect(triggerMatches({ subject: { system: 'linear' } }, ev())).toBe(false)
    expect(triggerMatches({ subject: { system: 'linear' } }, ev({ subject: PAY }))).toBe(true)
    expect(triggerMatches({ subject: { id: 'PAY-*' } }, ev({ subject: PAY }))).toBe(true)
    expect(triggerMatches({ subject: { id: 'OPS-*' } }, ev({ subject: PAY }))).toBe(false)
  })
  it('matches where paths', () => {
    const e = ev({ subject: PAY, payload: { channelId: 'chn_1', labels: ['a'], team: { key: 'PAY', name: 'Payments' } } })
    expect(triggerMatches({ where: { 'payload.channelId': 'chn_1' } }, e)).toBe(true)
    expect(triggerMatches({ where: { 'payload.channelId': 'chn_2' } }, e)).toBe(false)
    expect(triggerMatches({ where: { 'payload.team': { key: 'PAY' } } }, e)).toBe(true)
    expect(triggerMatches({ where: { 'payload.labels': ['a'] } }, e)).toBe(true)
    expect(triggerMatches({ where: { 'subject.id': 'PAY-123' } }, e)).toBe(true)
    expect(triggerMatches({ where: { 'payload.missing': 'x' } }, e)).toBe(false)
    expect(triggerMatches({ where: { 'payload.missing.deep': null } }, e)).toBe(false)
  })
})

describe('triggers', () => {
  it('creates with defaults and validates the target', async () => {
    const t = await events.triggers.create({
      name: 'tasks',
      employeeId: EMP,
      match: { type: 'task.*' },
      target: { type: 'router' },
    })
    expect(t.id).toMatch(/^trg_/)
    expect(t.data).toMatchObject({ enabled: true, priority: 0, fork: false, mode: 'ephemeral', fired: 0 })
    await expect(
      events.triggers.create({ name: 'bad', employeeId: EMP, match: { type: 'x' }, target: { type: 'session' } as any }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      events.triggers.create({
        name: 'bad',
        employeeId: EMP,
        match: { type: 'x' },
        target: { type: 'router' },
        mode: 'x' as any,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('matches in priority order, respects enabled and the target employee', async () => {
    const low = await events.triggers.create({
      name: 'low',
      employeeId: EMP,
      match: { type: 'task.*' },
      target: { type: 'router' },
    })
    clock.advance(1)
    const high = await events.triggers.create({
      name: 'high',
      employeeId: EMP,
      priority: 10,
      match: { type: 'task.assigned', subject: { system: 'linear' } },
      target: { type: 'session', sessionId: SES },
      fork: true,
    })
    clock.advance(1)
    const low2 = await events.triggers.create({
      name: 'low2',
      employeeId: EMP2,
      match: { type: 'task.*' },
      target: { type: 'router' },
    })
    clock.advance(1)
    const off = await events.triggers.create({
      name: 'off',
      employeeId: EMP,
      enabled: false,
      priority: 100,
      match: { type: 'task.*' },
      target: { type: 'router' },
    })
    clock.advance(1)
    await events.triggers.create({ name: 'chat', employeeId: EMP, match: { source: 'chat' }, target: { type: 'router' } })

    const { event } = await events.ingest({ source: 'mcp:linear', type: 'task.assigned', subject: PAY, dedupeKey: 'x' })
    expect((await events.triggers.match(event)).map((t) => t.id)).toEqual([high.id, low.id, low2.id])
    expect((await events.triggers.match(event.data)).map((t) => t.id)).toEqual([high.id, low.id, low2.id])
    const { event: forEmp2 } = await events.ingest({
      source: 'mcp:linear',
      type: 'task.assigned',
      employeeId: EMP2,
      dedupeKey: 'y',
    })
    expect((await events.triggers.match(forEmp2)).map((t) => t.id)).toEqual([low2.id])

    await events.triggers.update(off.id, { enabled: true })
    expect((await events.triggers.match(event))[0]!.id).toBe(off.id)
  })

  it('lists, updates and removes', async () => {
    const a = await events.triggers.create({ name: 'a', employeeId: EMP, match: { type: 'task.*' }, target: { type: 'router' } })
    const b = await events.triggers.create({
      name: 'b',
      employeeId: EMP2,
      match: { type: 'task.*' },
      target: { type: 'router' },
      enabled: false,
    })
    expect((await events.triggers.list()).map((t) => t.id)).toEqual([a.id, b.id])
    expect((await events.triggers.list({ employeeId: EMP })).map((t) => t.id)).toEqual([a.id])
    expect((await events.triggers.list({ enabled: false })).map((t) => t.id)).toEqual([b.id])
    const u = await events.triggers.update(a.id, { priority: 5, fired: 99 } as any)
    expect(u.data.priority).toBe(5)
    expect(u.data.fired).toBe(0)
    await expect(events.triggers.update(a.id, { target: { type: 'nope' } as any })).rejects.toBeInstanceOf(ValidationError)
    await events.triggers.remove(a.id)
    expect(await events.triggers.get(a.id)).toBeNull()
  })

  it('recordFired counts concurrent firings', async () => {
    const t = await events.triggers.create({ name: 'a', employeeId: EMP, match: { type: 'task.*' }, target: { type: 'router' } })
    await Promise.all(Array.from({ length: 20 }, () => events.triggers.recordFired(t.id)))
    const after = await events.triggers.get(t.id)
    expect(after!.data.fired).toBe(20)
    expect(after!.data.lastFiredAt).toBe(clock.iso())
  })
})

describe('subscriptions', () => {
  it('subscribe is idempotent per session and subject', async () => {
    const a = await events.subscriptions.subscribe(SES, PAY, { primary: true })
    const b = await events.subscriptions.subscribe(SES, PAY, { primary: true })
    expect(a.id).toMatch(/^sub_/)
    expect(b.id).toBe(a.id)
    expect(b.version).toBe(a.version)
    const c = await events.subscriptions.subscribe(SES, PAY, { types: ['comment.*'] })
    expect(c.id).toBe(a.id)
    expect(c.data).toMatchObject({ primary: true, types: ['comment.*'] })
  })

  it('subscribe is idempotent under concurrency', async () => {
    const subs = await Promise.all(Array.from({ length: 10 }, () => events.subscriptions.subscribe(SES, PAY)))
    expect(new Set(subs.map((s) => s.id)).size).toBe(1)
    expect((await events.subscriptions.forSubject(PAY)).length).toBe(1)
  })

  it('filters by event type and returns active only', async () => {
    await events.subscriptions.subscribe(SES, PAY, { primary: true })
    clock.advance(1)
    await events.subscriptions.subscribe(SES2, PAY, { types: ['ci.*'] })
    clock.advance(1)
    await events.subscriptions.subscribe(SES3, { system: 'github', id: 'org/repo#1' })
    const sessions = (l: { data: { sessionId: string } }[]) => l.map((s) => s.data.sessionId)
    expect(sessions(await events.subscriptions.forSubject(PAY))).toEqual([SES, SES2])
    expect(sessions(await events.subscriptions.forSubject(PAY, 'comment.created'))).toEqual([SES])
    expect(sessions(await events.subscriptions.forSubject(PAY, 'ci.failed'))).toEqual([SES, SES2])
    await events.subscriptions.unsubscribe(SES, PAY)
    await events.subscriptions.unsubscribe(SES, PAY)
    await events.subscriptions.unsubscribe(SES, { system: 'none', id: 'x' })
    expect(sessions(await events.subscriptions.forSubject(PAY))).toEqual([SES2])
    expect(await events.subscriptions.forSession(SES)).toEqual([])
  })

  it('resubscribing reactivates', async () => {
    const a = await events.subscriptions.subscribe(SES, PAY, { types: ['x'] })
    await events.subscriptions.unsubscribe(SES, PAY)
    const b = await events.subscriptions.subscribe(SES, PAY)
    expect(b.id).toBe(a.id)
    expect(b.data.active).toBe(true)
    expect(b.data.endedReason).toBeUndefined()
    expect(b.data.types).toBeUndefined()
  })

  it('validates', async () => {
    await expect(events.subscriptions.subscribe(SES, { system: '', id: 'x' })).rejects.toBeInstanceOf(ValidationError)
    await expect(events.subscriptions.subscribe('', PAY)).rejects.toBeInstanceOf(ValidationError)
    await expect(events.subscriptions.subscribe('nope', PAY)).rejects.toBeInstanceOf(ValidationError)
    await expect(events.subscriptions.subscribe(SES, PAY, { types: [1] as any })).rejects.toBeInstanceOf(ValidationError)
  })

  it('transfers to another session', async () => {
    await events.subscriptions.subscribe(SES, PAY, { primary: true, types: ['comment.*'] })
    await events.subscriptions.subscribe(SES, internalSubject('msg_01J00000000000000000000001'))
    const moved = await events.subscriptions.transfer(SES, SES2)
    expect(moved.map((s) => s.data.sessionId)).toEqual([SES2, SES2])
    expect(moved[0]!.data).toMatchObject({ primary: true, types: ['comment.*'] })
    expect(await events.subscriptions.forSession(SES)).toEqual([])
    expect((await events.subscriptions.forSession(SES2)).length).toBe(2)
    expect((await events.subscriptions.transfer(SES2, SES2)).length).toBe(2)
  })

  it('ends by subject and by session', async () => {
    await events.subscriptions.subscribe(SES, PAY)
    await events.subscriptions.subscribe(SES2, PAY)
    await events.subscriptions.subscribe(SES2, { system: 'github', id: 'pr-1' })
    expect(await events.subscriptions.endForSubject(PAY, 'resolved')).toBe(2)
    expect(await events.subscriptions.endForSubject(PAY, 'resolved')).toBe(0)
    expect(await events.subscriptions.forSubject(PAY)).toEqual([])
    expect(await events.subscriptions.endForSession(SES2, 'session ended')).toBe(1)
    expect(await events.subscriptions.forSession(SES2)).toEqual([])
  })
})

describe('no catch-all triggers', () => {
  it('refuses triggers that match everything: that is the router fallback', async () => {
    const records = createRecords({ store: memoryStore() })
    const events = createEvents({ records })
    const make = (match: any) => events.triggers.create({ name: 't', employeeId: 'emp_x', match, target: { type: 'router' } })
    for (const m of [
      {},
      { source: '*' },
      { type: '**' },
      { source: '**', type: '*' },
      { where: {} },
      { filter: {} },
      { subject: { system: '*' } },
    ])
      await expect(make(m), JSON.stringify(m)).rejects.toThrow(/router.*fallback/)
    // Anything that narrows is fine.
    for (const m of [
      { source: 'mcp:*' },
      { type: 'task.*' },
      { subject: { system: 'linear' } },
      { where: { 'payload.x': 1 } },
      { filter: { 'payload.x': 1 } },
    ])
      await expect(make(m)).resolves.toBeTruthy()
    // Updating a trigger into a catch-all is refused too; schedule triggers need no match.
    const t = await make({ type: 'task.*' })
    await expect(events.triggers.update(t.id, { match: {} })).rejects.toThrow(/fallback/)
    await expect(
      events.triggers.create({
        name: 's',
        employeeId: 'emp_x',
        match: {},
        schedule: { cron: '0 9 * * *' },
        target: { type: 'router' },
      }),
    ).resolves.toBeTruthy()
  })
})
