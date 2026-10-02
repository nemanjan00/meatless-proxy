import { describe, expect, it } from 'vitest'
import { documentLine, withProduced } from '../src/session-outcomes.ts'
import { stack, type Stack } from './helpers.ts'

/** A finished run in a session, with who asked and what it ended with. */
async function finishedRun(
  t: Stack,
  sessionId: string,
  o: { text?: string; requesterId?: string; output?: string; eventId?: string; result?: Record<string, unknown> } = {},
) {
  const run = await t.sessions.createRun({
    sessionId,
    cause: o.eventId ? { type: 'event', eventId: o.eventId } : { type: 'manual' },
    ...(o.requesterId ? { requesterId: o.requesterId } : {}),
    ...(o.text ? { input: [{ kind: 'user', content: { text: o.text } }] } : {}),
  })
  await t.sessions.transition(run.id, 'queued', 'running')
  await t.clock.advance(60_000)
  return t.sessions.transition(run.id, 'running', 'completed', {
    result: { status: 'completed', ...(o.output ? { output: o.output } : {}), ...(o.result ? { result: o.result as any } : {}) },
    endedAt: t.clock.iso(),
  })
}

describe('sessions.get runs', () => {
  it('lists recent runs newest first with who asked, the request and the outcome', async () => {
    const t = await stack()
    const bo = await t.directory.contacts.create({
      name: 'Bo Berg',
      handles: [
        { system: 'mp', id: 'bo' },
        { system: 'slack', id: 'U0TEST0002' },
      ],
    })
    const s = await t.newSession('Footer work')
    await finishedRun(t, s.id, {
      text: 'Make the footer grey',
      requesterId: t.ana.id,
      output: 'Footer is grey now: commit abc123',
    })
    const { event } = await t.events.ingest({
      source: 'chat',
      type: 'message.replied',
      text: 'Bo Berg: can you also make the header blue?',
      actorContactId: bo.id,
    })
    await finishedRun(t, s.id, { eventId: event.id, requesterId: bo.id, output: 'Header is blue: commit def456' })

    const o = await t.out('sessions.get', { sessionId: s.id })
    expect(o.runs).toHaveLength(2)
    expect(o.runs[0]).toMatchObject({
      requestedBy: 'Bo Berg (mp:bo, slack:U0TEST0002)',
      requesterId: bo.id,
      request: 'Bo Berg: can you also make the header blue?',
      outcome: 'Header is blue: commit def456',
      cause: 'event',
      state: 'completed',
    })
    expect(o.runs[1]).toMatchObject({
      requestedBy: 'Ana Lima (mp:ana)',
      request: 'Make the footer grey',
      outcome: 'Footer is grey now: commit abc123',
    })
    expect(o.runs[0].at > o.runs[1].at).toBe(true)
    expect(o.lastOutcome).toBe('Header is blue: commit def456')
  })

  it('pages with runs and runsOffset', async () => {
    const t = await stack()
    const s = await t.newSession('Many')
    for (let i = 1; i <= 5; i++) await finishedRun(t, s.id, { text: `task ${i}`, output: `did ${i}` })
    const page1 = await t.out('sessions.get', { sessionId: s.id, runs: 2 })
    expect(page1.runs.map((r: any) => r.outcome)).toEqual(['did 5', 'did 4'])
    expect(page1.moreRuns).toContain('runsOffset: 2')
    const page3 = await t.out('sessions.get', { sessionId: s.id, runs: 2, runsOffset: 4 })
    expect(page3.runs.map((r: any) => r.outcome)).toEqual(['did 1'])
    expect(page3.moreRuns).toBeUndefined()
    // Defaults to 10, capped at 50.
    expect((await t.out('sessions.get', { sessionId: s.id, runs: 500 })).runs).toHaveLength(5)
  })

  it('shows later requests that reached a run while it worked', async () => {
    const t = await stack()
    const bo = await t.directory.contacts.create({ name: 'Bo Berg', handles: [{ system: 'mp', id: 'bo' }] })
    const { event } = await t.events.ingest({ source: 'chat', type: 'message.replied', text: 'Bo Berg: rename it too' })
    const s = await t.newSession('Busy')
    const run = await t.startRun(s.id, 'Fix the typo', t.ana.id)
    await t.sessions.updateRun(run.id, { requests: [{ eventId: event.id, requesterId: bo.id, at: t.clock.iso() }] })
    const o = await t.out('sessions.get', { sessionId: s.id })
    expect(o.runs[0]).toMatchObject({
      state: 'running',
      requestedBy: 'Ana Lima (mp:ana)',
      request: 'Fix the typo',
      laterRequests: [{ by: 'Bo Berg (mp:bo)', contactId: bo.id, request: 'Bo Berg: rename it too' }],
    })
  })
})

describe('session outcomes in sessions.tree and sessions.list', () => {
  it('shows the last outcome, the document line, what it produced and what it waits for', async () => {
    const t = await stack()
    const s = await t.newSession('Login fix')
    await t.sessions.update(s.id, { document: '# Fix the login redirect\n\nDetails…' })
    await finishedRun(t, s.id, {
      output: 'Opened https://gitlab.example.com/acme/portal/-/merge_requests/4 for review.',
    })
    await t.sessions.update(s.id, {
      meta: withProduced({}, { kind: 'branch', what: 'mp/fix-login in local:portal', at: t.clock.iso() }),
    })
    await t.events.subscriptions.subscribe(s.id, { system: 'local-git', id: 'portal/mp/fix-login' }, { primary: true })
    await t.events.subscriptions.subscribe(s.id, { system: 'gitlab', id: 'acme/portal!4' }, { primary: true })
    t.deps.localProjects!.branches = async () => ({
      defaultBranch: 'main',
      branches: [
        { name: 'main', sha: 'a', ahead: 0, behind: 0, subject: '', author: '', date: '' },
        { name: 'mp/fix-login', sha: 'b', ahead: 1, behind: 0, subject: 'Fix', author: 'Billing Bot', date: '' },
      ],
    })
    // A suspended run waiting for a reply.
    const waiting = await t.startRun(s.id, 'wait for Ana')
    await t.sessions.suspend(waiting.id, { type: 'delivery' })

    const list = await t.out('sessions.list', {})
    const row = list.sessions.find((x: any) => x.id === s.id)
    expect(row).toMatchObject({
      document: 'Fix the login redirect',
      lastOutcome: 'Opened https://gitlab.example.com/acme/portal/-/merge_requests/4 for review.',
    })
    expect(row.produced).toEqual(
      expect.arrayContaining([
        'merge request gitlab:acme/portal!4',
        'merge request https://gitlab.example.com/acme/portal/-/merge_requests/4',
        'branch mp/fix-login in local:portal',
      ]),
    )
    expect(row.waitingFor).toEqual([
      'a reply or event delivered to this session',
      'review of mp/fix-login in local project portal (1 commit ahead)',
      'MR !4 review (acme/portal)',
    ])

    const tree = await t.out('sessions.tree', { sessionId: s.id })
    expect(tree.tree).toMatchObject({ id: s.id, document: 'Fix the login redirect' })
    expect(tree.tree.waitingFor).toHaveLength(3)
  })

  it('a merged or deleted local branch is no longer waited for', async () => {
    const t = await stack()
    const s = await t.newSession('Merged')
    await t.events.subscriptions.subscribe(s.id, { system: 'local-git', id: 'portal/mp/done' }, { primary: true })
    t.deps.localProjects!.branches = async () => ({ defaultBranch: 'main', branches: [] })
    const o = await t.out('sessions.get', { sessionId: s.id })
    expect(o.waitingFor).toBeUndefined()
  })

  it('a paused run says why', async () => {
    const t = await stack()
    const s = await t.newSession('Paused')
    const r = await t.startRun(s.id, 'x')
    await t.sessions.transition(r.id, 'running', 'paused', { pauseReason: 'over budget' })
    const o = await t.out('sessions.tree', { sessionId: s.id })
    expect(o.tree.waitingFor).toEqual(['paused: over budget'])
  })

  it('documentLine and withProduced', () => {
    expect(documentLine('\n\n## Purpose: refunds\nmore')).toBe('Purpose: refunds')
    expect(documentLine('')).toBeUndefined()
    let m = withProduced({}, { kind: 'file', what: '/a.csv shared with Ana', at: 't1' })
    m = withProduced(m, { kind: 'branch', what: 'mp/x in local:y', at: 't2' })
    m = withProduced(m, { kind: 'file', what: '/a.csv shared with Ana', at: 't3' })
    expect((m.produced as any[]).map((p) => `${p.what}@${p.at}`)).toEqual(['mp/x in local:y@t2', '/a.csv shared with Ana@t3'])
  })

  it('fs.share records the shared file as produced', async () => {
    const t = await stack()
    await t.files.write(t.employee.id, '/reports/q3.csv', 'a,b\n')
    await t.out('fs.share', { path: '/reports/q3.csv', with: t.ana.id })
    const o = await t.out('sessions.get', {})
    expect(o.produced).toEqual(['file /reports/q3.csv shared with Ana Lima'])
  })
})

describe('sessions.finish and sessions.wait results', () => {
  it('finish carries a structured result in its end signal; a huge one is refused', async () => {
    const t = await stack()
    const r = await t.call('sessions.finish', { output: 'counted', result: { count: 3 } })
    expect(r.control).toEqual([{ type: 'end', status: 'completed', output: 'counted', result: { count: 3 } }])
    const plain = await t.call('sessions.finish', { output: 'done' })
    expect(plain.control).toEqual([{ type: 'end', status: 'completed', output: 'done' }])
    const big = await t.call('sessions.finish', { output: 'x', result: { blob: 'x'.repeat(25_000) } })
    expect(big.isError).toBe(true)
  })

  it('wait returns each finished child result as is', async () => {
    const t = await stack()
    const child = await t.newSession('Child')
    const done = await finishedRun(t, child.id, { output: 'two', result: { files: ['a', 'b'] } })
    const o = await t.out('sessions.wait', { runIds: [done.id] })
    expect(o.results[0]).toMatchObject({ runId: done.id, output: 'two', result: { files: ['a', 'b'] } })
  })
})

describe('sessions.contents', () => {
  it('lists collapses, compactions and offloads with ranges, sizes and ready calls', async () => {
    const t = await stack()
    const a = await t.recordCall(t.run.id, 'docs.read', 'first doc '.repeat(50))
    const b = await t.recordCall(t.run.id, 'docs.read', 'second doc')
    const big = await t.recordCall(t.run.id, 'docs.read', 'huge '.repeat(1000))
    await t.sessions.offload(t.run.id, big.entryId, { text: 'the huge doc' })
    // Collapse the two reads.
    const path = await t.sessions.runHistory(t.run.id)
    const startIdx = path.findIndex((e) => e.kind === 'assistant')
    const endIdx = path.findIndex((e) => e.id === b.entryId)
    await t.sessions.rewind(t.run.id, path[startIdx - 1]!.id, 'Read two docs: first and second.\nMore detail.', {
      keepAfter: path[endIdx]!.id,
    })

    const o = await t.out('sessions.contents', {})
    expect(o.items.map((i: any) => i.op)).toEqual(['collapse', 'offload'])
    const collapse = o.items[0]
    expect(collapse).toMatchObject({
      op: 'collapse',
      entries: 4,
      summary: 'Read two docs: first and second. More detail.',
      detail: { tool: 'sessions.contents', args: { item: collapse.entryId } },
    })
    expect(collapse.chars).toBeGreaterThan(500)
    expect(o.items[1]).toMatchObject({
      op: 'offload',
      tool: 'docs.read',
      restore: { tool: 'sessions.restore', args: { entryId: big.entryId } },
    })

    // The entries of the collapsed stretch, each readable with sessions.restore.
    const item = await t.out('sessions.contents', { item: collapse.entryId })
    expect(item.entries).toBe(4)
    expect(item.shown.map((e: any) => e.kind)).toEqual(['assistant', 'tool_result', 'assistant', 'tool_result'])
    const firstResult = item.shown[1]
    expect(firstResult.entryId).toBe(a.entryId)
    const read = await t.out('sessions.restore', firstResult.read.args)
    expect(read.text).toContain('first doc')
    // Putting a collapsed entry back isn't possible: the error points to the contents.
    const back = await t.call('sessions.restore', { entryId: a.entryId })
    expect(back.isError).toBe(true)
    expect(JSON.stringify(back.output)).toContain('sessions.contents')
  })

  it('lists a compaction and says when nothing was summarized', async () => {
    const t = await stack()
    expect((await t.out('sessions.contents', {})).note).toContain('Nothing in this history')
    await t.recordCall(t.run.id, 'docs.read', 'something')
    await t.sessions.compact(t.run.id, 'Everything so far: read one doc.', { meta: { automatic: true } })
    const o = await t.out('sessions.contents', {})
    expect(o.items).toHaveLength(1)
    expect(o.items[0]).toMatchObject({ op: 'compaction', automatic: true, summary: 'Everything so far: read one doc.' })
    expect(o.items[0].entries).toBeGreaterThanOrEqual(3)
    expect((await t.call('sessions.contents', { item: 'ent_nope' })).isError).toBe(true)
  })
})
