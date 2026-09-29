import { createRecords } from '@mp/records'
import { memoryStore } from '@mp/store'
import { describe, expect, it } from 'vitest'
import { createEvents, eventFilter, triggerMatches } from '../src/index.ts'

const setup = () => createEvents({ records: createRecords({ store: memoryStore() }) })

describe('sift filters', () => {
  const ev = {
    source: 'mcp:linear',
    type: 'task.updated',
    subject: { system: 'linear', id: 'PAY-1' },
    payload: { priority: 3, labels: ['bug', 'billing'], author: { kind: 'contact' } },
    routed: false,
    receivedAt: '2026-01-01T00:00:00.000Z',
  }

  it('compiles MongoDB-style queries over events', () => {
    expect(eventFilter({ 'payload.priority': { $gte: 2 } })(ev)).toBe(true)
    expect(eventFilter({ 'payload.labels': { $in: ['bug'] } })(ev)).toBe(true)
    expect(eventFilter({ $or: [{ 'payload.priority': 1 }, { 'subject.id': { $regex: '^PAY-' } }] })(ev)).toBe(true)
    expect(eventFilter({ 'payload.author.kind': 'session' })(ev)).toBe(false)
    expect(() => eventFilter({ $bogus: 1 } as any)).toThrow('invalid filter')
    expect(() => eventFilter([] as any)).toThrow('query object')
  })

  it('applies trigger filters', async () => {
    expect(triggerMatches({ type: 'task.*', filter: { 'payload.priority': { $gt: 2 } } }, ev)).toBe(true)
    expect(triggerMatches({ type: 'task.*', filter: { 'payload.priority': { $gt: 5 } } }, ev)).toBe(false)
    const events = setup()
    await expect(
      events.triggers.create({
        name: 't',
        employeeId: 'emp_x',
        match: { filter: { $nope: 1 } as any },
        target: { type: 'router' },
      }),
    ).rejects.toThrow('invalid filter')
  })

  it('applies subscription filters in forEvent', async () => {
    const events = setup()
    const subject = { system: 'linear', id: 'PAY-1' }
    await events.subscriptions.subscribe('ses_humans', subject, { filter: { 'payload.author.kind': 'contact' } })
    await events.subscriptions.subscribe('ses_all', subject)
    await events.subscriptions.subscribe('ses_bugs', subject, { filter: { 'payload.labels': 'feature' } })
    expect((await events.subscriptions.forEvent(ev)).map((s) => s.data.sessionId).sort()).toEqual(['ses_all', 'ses_humans'])
    expect(await events.subscriptions.forEvent({ ...ev, subject: undefined } as any)).toEqual([])
    await expect(events.subscriptions.subscribe('ses_bad', subject, { filter: { $x: 1 } as any })).rejects.toThrow(
      'invalid filter',
    )
  })
})
