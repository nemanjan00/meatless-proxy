import { describe, expect, it } from 'vitest'
import { REVIEWER_TOOLSET } from '../src/index.ts'
import { stack } from './helpers.ts'

describe('checklist', () => {
  it('show, add_item, and check with tool call ids as evidence', async () => {
    const t = await stack()
    const c = t.ctx()
    const item = await t.out('checklist.add_item', { text: 'Tests pass' }, c)
    expect(item).toMatchObject({ id: 'i1', text: 'Tests pass', required: true, checked: false })
    // Idempotent per call.
    expect(await t.out('checklist.add_item', { text: 'Tests pass' }, c)).toEqual(item)
    await t.out('checklist.add_item', { text: 'Nice to have', required: false })
    let show = await t.out('checklist.show', {})
    expect(show).toMatchObject({ complete: false, done: 0, total: 2 })

    // No evidence, or evidence that isn't in the history, is refused.
    expect((await t.call('checklist.check', { itemId: 'i1', evidence: [] })).isError).toBe(true)
    expect((await t.call('checklist.check', { itemId: 'i1', evidence: ['call_made_up'] })).isError).toBe(true)

    const test = await t.recordCall(t.run.id, 'env.exec', { exitCode: 0, stdout: '12 passed' })
    const ck = await t.out('checklist.check', { itemId: 'i1', evidence: [test.callId] })
    expect(ck).toMatchObject({ complete: true, item: { checked: true, evidence: [test.entryId] } })
    show = await t.out('checklist.show', {})
    expect(show).toMatchObject({ complete: true, done: 1 })
    expect((await t.checklists.forSession(t.session.id)).data.items[0]!.checkedInRun).toBe(t.run.id)
  })

  it('accepts entry ids and event ids as evidence', async () => {
    const t = await stack()
    await t.checklists.addItem(t.session.id, { text: 'Owner said yes' })
    await t.sessions.append(t.run.id, {
      kind: 'event',
      content: {
        eventId: 'evt_approval',
        source: 'chat',
        type: 'message.replied',
        text: 'yes',
        trusted: true,
        expectedToAct: true,
      },
    })
    expect((await t.out('checklist.check', { itemId: 'i1', evidence: ['evt_approval'] })).complete).toBe(true)
    const e = (await t.sessions.runHistory(t.run.id)).find((x) => x.kind === 'user')!
    await t.checklists.addItem(t.session.id, { text: 'Asked' })
    expect((await t.out('checklist.check', { itemId: 'i2', evidence: [e.id] })).item.checked).toBe(true)
  })

  it('request_review starts a fresh reviewer; only that reviewer can record the verdict', async () => {
    const t = await stack()
    await t.checklists.addItem(t.session.id, { text: 'Migration is reversible', review: true })
    const ev = await t.recordCall(t.run.id, 'git.diff', { diff: '+ALTER TABLE invoices ADD COLUMN x; -- down: DROP COLUMN x' })
    expect((await t.call('checklist.request_review', { itemId: 'i1' })).isError).toBe(true) // not checked yet
    const ck = await t.out('checklist.check', { itemId: 'i1', evidence: [ev.callId] })
    expect(ck.note).toContain('needs a review')
    expect(ck.complete).toBe(false)

    const r = await t.out('checklist.request_review', { itemId: 'i1', result: 'Added a down migration.' })
    const reviewer = await t.sessions.require(r.reviewerSessionId)
    expect(reviewer.data.parent).toBeUndefined()
    expect(reviewer.data.toolset).toEqual([...REVIEWER_TOOLSET])
    expect(reviewer.data.meta?.reviewFor).toEqual({ sessionId: t.session.id, itemId: 'i1' })
    const instruction = (await t.sessions.runHistory(r.runId)).at(-1)!.content as any
    expect(instruction.text).toContain('Migration is reversible')
    expect(instruction.text).toContain('DROP COLUMN x')
    expect(instruction.text).toContain('Added a down migration.')
    expect(t.enqueued).toContain(r.runId)
    const item = (await t.checklists.forSession(t.session.id)).data.items[0]!
    expect(item.review).toBe('requested')

    // The builder can't record its own review, and neither can another session.
    await expect(t.call('checklist.record_review', { itemId: 'i1', passed: true })).rejects.toThrow(/only the reviewer/)
    const stranger = await t.sessions.create({
      employeeId: t.employee.id,
      title: 'fake reviewer',
      toolset: [],
      meta: { reviewFor: { sessionId: t.session.id, itemId: 'i1' } },
    })
    const sr = await t.startRun(stranger.id)
    await expect(t.call('checklist.record_review', { itemId: 'i1', passed: true }, t.ctxFor(stranger.id, sr.id))).rejects.toThrow(
      /not the reviewer recorded/,
    )

    const rr = await t.sessions.transition(r.runId, 'queued', 'running')
    const rc = t.ctxFor(reviewer.id, rr.id)
    // The reviewer reads the builder's session with its read-only tools.
    expect((await t.out('checklist.show', { sessionId: t.session.id }, rc)).items[0].review).toBe('requested')
    expect((await t.out('sessions.get', { sessionId: t.session.id }, rc)).id).toBe(t.session.id)
    const v = await t.out('checklist.record_review', { itemId: 'i1', passed: true, notes: 'down migration present' }, rc)
    expect(v.item).toMatchObject({ review: 'passed', reviewNotes: 'down migration present' })
    expect((await t.checklists.status(t.session.id)).complete).toBe(true)
  })
})
