import { DeniedError, ManualClock, NotFoundError, ValidationError, createEventBus, type EventBus } from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import { createSessions, type Sessions } from '@mp/sessions'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import { ChecklistTopics, createChecklists, type Checklists } from '../src/index.ts'

const EMP = 'emp_test'
let clock: ManualClock
let bus: EventBus
let records: Records
let sessions: Sessions
let checklists: Checklists
let changes: unknown[]

beforeEach(() => {
  clock = new ManualClock(Date.UTC(2026, 0, 1))
  bus = createEventBus()
  records = createRecords({ store: memoryStore({ bus, clock }) })
  sessions = createSessions({ records, clock, bus })
  checklists = createChecklists({ records, sessions, clock, bus })
  changes = []
  bus.subscribe(ChecklistTopics.changed, (m) => void changes.push(m.payload))
})

/** A session with a running run that has observed a tool result, an event and a user message. */
async function work() {
  const s = await sessions.create({ employeeId: EMP, title: 'Work', entries: [{ kind: 'system', content: { text: 'sys' } }] })
  const run = await sessions.createRun({
    sessionId: s.id,
    cause: { type: 'manual' },
    input: [{ kind: 'user', content: { text: 'do it' } }],
  })
  await sessions.transition(run.id, 'queued', 'running')
  const said = await sessions.append(run.id, { kind: 'assistant', content: { text: 'running tests' } })
  const tests = await sessions.append(run.id, {
    kind: 'tool_result',
    content: { toolCallId: 'c1', name: 'run_tests', output: 'ok' },
  })
  const ci = await sessions.append(run.id, {
    kind: 'event',
    content: { eventId: 'evt_1', source: 'ci', type: 'ci.passed', text: 'green', trusted: true, expectedToAct: false },
  })
  const hist = await sessions.runHistory(run.id)
  return { s, run, said, tests, ci, sys: hist[0]!, userMsg: hist[1]! }
}

describe('checklists', () => {
  it('creates an empty checklist on demand, once per session', async () => {
    const s = await sessions.create({ employeeId: EMP, title: 'S' })
    const [a, b] = await Promise.all([checklists.forSession(s.id), checklists.forSession(s.id)])
    expect(a.id).toBe(b.id)
    expect(a.id).toMatch(/^chk_/)
    expect(a.key).toBe(s.id)
    expect(a.data.items).toEqual([])
    expect(await checklists.status(s.id)).toEqual({ complete: true, total: 0, done: 0, missing: [] })
    await expect(checklists.forSession('ses_nope')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('adds items, from templates too, with defaults', async () => {
    const s = await sessions.create({ employeeId: EMP, title: 'S' })
    await checklists.fromTemplate(s.id, [{ text: 'tests pass' }, { text: 'docs', required: false, review: true }])
    const c = await checklists.addItem(s.id, { text: '  also update the migration docs ', addedBy: s.id })
    expect(c.data.items.map((i) => [i.id, i.text, i.required, i.needsReview, i.review, i.checked])).toEqual([
      ['i1', 'tests pass', true, false, 'none', false],
      ['i2', 'docs', false, true, 'none', false],
      ['i3', 'also update the migration docs', true, false, 'none', false],
    ])
    expect(c.data.items[2]!.addedBy).toBe(s.id)
    await expect(checklists.addItem(s.id, { text: ' ' })).rejects.toBeInstanceOf(ValidationError)
    const st = await checklists.status(s.id)
    expect(st).toMatchObject({ complete: false, total: 3, done: 0 })
    expect(st.missing.map((i) => i.id)).toEqual(['i1', 'i3'])
    await bus.idle()
    expect(changes).toContainEqual({ sessionId: s.id, checklistId: c.id })
  })

  it('checks with evidence from the run history', async () => {
    const { s, run, tests, ci, userMsg } = await work()
    await checklists.addItem(s.id, { text: 'tests pass' })
    await checklists.addItem(s.id, { text: 'ci green', required: false })
    const c = await checklists.check(s.id, 'i1', [tests.id, userMsg.id, tests.id], { runId: run.id })
    expect(c.data.items[0]).toMatchObject({
      checked: true,
      evidence: [tests.id, userMsg.id],
      checkedAt: clock.iso(),
      checkedInRun: run.id,
    })
    expect(await checklists.status(s.id)).toMatchObject({ complete: true, done: 1, total: 2, missing: [] })
    await checklists.check(s.id, 'i2', [ci.id], { runId: run.id })
    expect((await checklists.status(s.id)).done).toBe(2)
  })

  it('refuses evidence that was not observed or is not on the visible history', async () => {
    const { s, run, said, tests, sys } = await work()
    await checklists.addItem(s.id, { text: 'tests pass' })
    await expect(checklists.check(s.id, 'i1', [], { runId: run.id })).rejects.toThrow('needs evidence')
    await expect(checklists.check(s.id, 'i1', [said.id], { runId: run.id })).rejects.toThrow(
      `${said.id} is a assistant entry; evidence must be something observed`,
    )
    await expect(checklists.check(s.id, 'i1', [sys.id], { runId: run.id })).rejects.toThrow('is a system entry')
    await expect(checklists.check(s.id, 'i1', ['ent_made_up'], { runId: run.id })).rejects.toThrow(
      `ent_made_up is not in the history of run ${run.id}`,
    )
    // Without a run, only the committed session history counts; the run's entries aren't there yet.
    await expect(checklists.check(s.id, 'i1', [tests.id])).rejects.toThrow(`is not in the history of session ${s.id}`)
    await sessions.commit(run.id)
    await checklists.check(s.id, 'i1', [tests.id])
    // Evidence from another session's history doesn't count.
    const other = await work()
    await expect(checklists.check(s.id, 'i1', [other.tests.id])).rejects.toBeInstanceOf(ValidationError)
    await expect(checklists.check(s.id, 'i1', [tests.id], { runId: other.run.id })).rejects.toThrow('does not belong to session')
    await expect(checklists.check(s.id, 'i9', [tests.id])).rejects.toBeInstanceOf(NotFoundError)
  })

  it('evidence the parent observed before a fork counts in the fork', async () => {
    const { s, run, tests } = await work()
    await sessions.commit(run.id)
    const f = await sessions.fork(s.id)
    await checklists.addItem(f.id, { text: 'tests pass' })
    await checklists.check(f.id, 'i1', [tests.id])
    expect((await checklists.status(f.id)).complete).toBe(true)
  })

  it('items that need review only count once a different session passed them', async () => {
    const { s, run, tests } = await work()
    const reviewer = await sessions.create({ employeeId: EMP, title: 'Reviewer' })
    await checklists.addItem(s.id, { text: 'feature works', review: true })
    await expect(checklists.requestReview(s.id, 'i1')).rejects.toBeInstanceOf(ValidationError)
    await checklists.check(s.id, 'i1', [tests.id], { runId: run.id })
    expect((await checklists.status(s.id)).complete).toBe(false)
    let c = await checklists.requestReview(s.id, 'i1')
    expect(c.data.items[0]!.review).toBe('requested')
    await expect(checklists.recordReview(s.id, 'i1', { passed: true, reviewerSessionId: s.id })).rejects.toBeInstanceOf(
      DeniedError,
    )
    await expect(checklists.recordReview(s.id, 'i1', { passed: true, reviewerSessionId: 'ses_nope' })).rejects.toBeInstanceOf(
      NotFoundError,
    )

    c = await checklists.recordReview(s.id, 'i1', { passed: false, notes: 'button missing', reviewerSessionId: reviewer.id })
    expect(c.data.items[0]).toMatchObject({ review: 'failed', reviewNotes: 'button missing', reviewerSessionId: reviewer.id })
    expect((await checklists.status(s.id)).complete).toBe(false)
    // Re-checking with new evidence clears the old verdict.
    c = await checklists.check(s.id, 'i1', [tests.id], { runId: run.id })
    expect(c.data.items[0]!.review).toBe('none')
    expect(c.data.items[0]!.reviewNotes).toBeUndefined()
    await checklists.requestReview(s.id, 'i1')
    c = await checklists.recordReview(s.id, 'i1', { passed: true, reviewerSessionId: reviewer.id })
    expect(await checklists.status(s.id)).toMatchObject({ complete: true, done: 1 })
    const revs = await records.revisions('checklist', c.id)
    expect(revs.at(-1)!.actor).toEqual({ type: 'session', id: reviewer.id })

    // An ad-hoc review request on a plain item makes it need review too.
    await checklists.addItem(s.id, { text: 'plain' })
    await checklists.check(s.id, 'i2', [tests.id], { runId: run.id })
    await checklists.requestReview(s.id, 'i2')
    expect((await checklists.status(s.id)).missing.map((i) => i.id)).toEqual(['i2'])
  })

  it('unchecks', async () => {
    const { s, run, tests } = await work()
    await checklists.addItem(s.id, { text: 'x' })
    await checklists.check(s.id, 'i1', [tests.id], { runId: run.id })
    const c = await checklists.uncheck(s.id, 'i1')
    expect(c.data.items[0]).toMatchObject({ checked: false, evidence: [], review: 'none' })
    expect(c.data.items[0]!.checkedAt).toBeUndefined()
    expect((await checklists.status(s.id)).complete).toBe(false)
  })

  it('removes optional items freely, required items only with force and an actor', async () => {
    const s = await sessions.create({ employeeId: EMP, title: 'S' })
    await checklists.fromTemplate(s.id, [{ text: 'required' }, { text: 'optional', required: false }])
    await checklists.removeItem(s.id, 'i2')
    await expect(checklists.removeItem(s.id, 'i1')).rejects.toBeInstanceOf(DeniedError)
    await expect(checklists.removeItem(s.id, 'i1', { force: true })).rejects.toBeInstanceOf(ValidationError)
    const owner = { type: 'contact' as const, id: 'con_owner' }
    const c = await checklists.removeItem(s.id, 'i1', { force: true, actor: owner })
    expect(c.data.items).toEqual([])
    expect((await records.revisions('checklist', c.id)).at(-1)!.actor).toEqual(owner)
    await expect(checklists.removeItem(s.id, 'i1')).rejects.toBeInstanceOf(NotFoundError)
    // Ids are never reused.
    expect((await checklists.addItem(s.id, { text: 'new' })).data.items[0]!.id).toBe('i3')
  })

  it('concurrent changes are not lost', async () => {
    const s = await sessions.create({ employeeId: EMP, title: 'S' })
    await Promise.all(Array.from({ length: 8 }, (_, i) => checklists.addItem(s.id, { text: `item ${i}` })))
    const c = await checklists.forSession(s.id)
    expect(c.data.items.length).toBe(8)
    expect(new Set(c.data.items.map((i) => i.id)).size).toBe(8)
  })
})
