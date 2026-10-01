import type { Json } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { stack } from './helpers.ts'

describe('sessions.create', () => {
  it('creates a blank session with the employee prompt, links and a queued run', async () => {
    const t = await stack()
    const o = await t.out('sessions.create', {
      title: 'Refund PAY-9',
      instruction: 'Refund invoice 9',
      links: [{ kind: 'project', id: t.project.id, role: 'works_on' }],
    })
    expect(o).toMatchObject({
      sessionId: expect.stringMatching(/^ses_/),
      runId: expect.stringMatching(/^run_/),
      slug: 'refund-pay-9',
    })
    expect(t.enqueued).toEqual([o.runId])
    const s = await t.sessions.require(o.sessionId)
    expect(s.data.toolset).toEqual(t.session.data.toolset)
    const hist = await t.sessions.history(s.id)
    expect(hist[0]!.kind).toBe('system')
    expect((hist[0]!.content as any).text).toContain('You are Billing Bot')
    const run = await t.sessions.requireRun(o.runId)
    expect(run.data).toMatchObject({ cause: { type: 'fork', parentRunId: t.run.id }, requesterId: t.ana.id, state: 'queued' })
    const roles = (await t.records.links({ from: { kind: 'session', id: s.id } })).map((l) => `${l.role}:${l.to.id}`).sort()
    expect(roles).toEqual([`created_by:${t.session.id}`, `requested_by:${t.ana.id}`, `works_on:${t.project.id}`].sort())
  })

  it('is idempotent per tool call: a retry returns the same session', async () => {
    const t = await stack()
    const c = t.ctx()
    const a = await t.out('sessions.create', { title: 'X', instruction: 'x' }, c)
    const b = await t.out('sessions.create', { title: 'X', instruction: 'x' }, c)
    expect(b).toEqual(a)
    expect(t.enqueued).toHaveLength(1)
  })

  it('creates from a template with params and copies its checklist', async () => {
    const t = await stack()
    const tpl = await t.sessions.createTemplate({
      name: 'Refund {{ticket}}',
      instructions: 'Refund ticket {{ticket}}.',
      params: [{ name: 'ticket', required: true }],
      checklist: [{ text: 'Refund issued' }],
    })
    const o = await t.out('sessions.create', { templateId: tpl.id, params: { ticket: 'PAY-1' } })
    const s = await t.sessions.require(o.sessionId)
    expect(s.data.title).toBe('Refund PAY-1')
    expect(s.data.toolset.length).toBeGreaterThan(10)
    const hist = await t.sessions.history(s.id)
    expect(hist.map((e) => e.kind)).toEqual(['system', 'system'])
    expect((hist[1]!.content as any).text).toBe('Refund ticket PAY-1.')
    expect((await t.checklists.status(s.id)).missing.map((i) => i.text)).toEqual(['Refund issued'])
    // The run adds the employee's current projects after the session's history.
    const runHist = await t.sessions.runHistory(o.runId)
    expect(runHist.map((e) => e.kind)).toEqual(['system', 'system', 'system'])
    expect(runHist[2]!.meta.projectsEntry).toBeDefined()
  })

  it('refuses bad input', async () => {
    const t = await stack()
    expect((await t.call('sessions.create', { title: 'x' })).isError).toBe(true)
    expect((await t.call('sessions.create', { instruction: 'x' })).isError).toBe(true)
    expect((await t.call('sessions.create', { title: 'x', instruction: 'y', templateId: 'tpl_nope' })).isError).toBe(true)
    expect(
      (await t.call('sessions.create', { title: 'x', instruction: 'y', links: [{ kind: 'bogus', id: 'a', role: 'r' }] })).isError,
    ).toBe(true)
  })
})

describe('sessions.fork', () => {
  it('forks at the current point, without the assistant message that asked for the fork', async () => {
    const t = await stack()
    const callId = 'call_fork1'
    const asst = await t.sessions.append(t.run.id, {
      kind: 'assistant',
      content: { text: null, toolCalls: [{ id: callId, name: 'sessions.fork', arguments: '{}' }] },
    })
    const o = await t.out('sessions.fork', { instruction: 'check the invoice' }, t.ctx({ callId }))
    const fork = await t.sessions.require(o.sessionId)
    expect(fork.data.parent).toEqual({ sessionId: t.session.id, entryId: asst.parent })
    const hist = await t.sessions.runHistory(o.runId)
    expect(hist.map((e) => e.kind)).toEqual(['system', 'user', 'system', 'user'])
    expect((hist[2]!.content as any).text).toContain('Your projects')
    expect((hist[3]!.content as any).text).toBe('check the invoice')
    expect(t.enqueued).toEqual([o.runId])
    const run = await t.sessions.requireRun(o.runId)
    expect(run.data.cause).toMatchObject({ type: 'fork', parentRunId: t.run.id })
  })

  it('keeps the parent links on the fork', async () => {
    const t = await stack()
    await t.out('sessions.link', { ref: { kind: 'project', id: t.project.id }, role: 'works_on' })
    const o = await t.out('sessions.fork', { instruction: 'x' })
    const links = await t.records.links({ from: { kind: 'session', id: o.sessionId }, role: 'works_on' })
    expect(links.map((l) => l.to.id)).toEqual([t.project.id])
  })

  it('enforces the depth limit from the config defaults', async () => {
    const t = await stack({ defaults: { maxDepth: 1 } })
    const o = await t.out('sessions.fork', { instruction: 'level 1' })
    const childRun = await t.sessions.transition(o.runId, 'queued', 'running')
    const r = await t.call('sessions.fork', { instruction: 'level 2' }, t.ctxFor(o.sessionId, childRun.id))
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('fork depth 2 is over the limit of 1')
  })

  it("can't fork another employee's session", async () => {
    const t = await stack()
    const other = await t.directory.employees.create({ name: 'Other Bot' })
    const s = await t.newSession('theirs', other.id)
    const r = await t.call('sessions.fork', { instruction: 'x', sessionId: s.id })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('not found')
  })
})

describe('sessions.loop', () => {
  it('forks one child per item and starts each', async () => {
    const t = await stack()
    const o = await t.out('sessions.loop', { items: ['repo-a', { name: 'repo-b' }], instruction: 'Bump the dependency.' })
    expect(o.children).toHaveLength(2)
    expect(t.enqueued).toEqual(o.runIds)
    const h0 = await t.sessions.runHistory(o.children[0].runId)
    expect((h0.at(-1)!.content as any).text).toContain('Bump the dependency.')
    expect((h0.at(-1)!.content as any).text).toContain('repo-a')
    const run = await t.sessions.requireRun(o.children[1].runId)
    expect(run.data.cause).toMatchObject({ type: 'loop', parentRunId: t.run.id })
    expect((await t.sessions.children(t.session.id)).length).toBe(2)
  })

  it("doesn't start a loop over the fan-out limit (configured limits win over defaults)", async () => {
    const t = await stack({ defaults: { maxFanOut: 10 } })
    await t.usage.limits.set({ target: { type: 'employee', id: t.employee.id }, maxFanOut: 2 })
    const r = await t.call('sessions.loop', { items: [1, 2, 3], instruction: 'x' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('fan-out 3 is over the limit of 2')
    expect(await t.sessions.children(t.session.id)).toHaveLength(0)
    expect(t.enqueued).toHaveLength(0)
  })

  it("doesn't refuse a loop over the concurrency cap: the runner queues the extra runs", async () => {
    const t = await stack({ defaults: { maxConcurrentSessions: 2 } })
    const o = await t.out('sessions.loop', { items: [1, 2, 3], instruction: 'x' })
    expect(o.children).toHaveLength(3)
    expect(t.enqueued).toHaveLength(3)
  })

  it('takes fork limits from the usage defaults', async () => {
    const t = await stack({ usageDefaults: { maxFanOut: 2 } })
    const r = await t.call('sessions.loop', { items: [1, 2, 3], instruction: 'x' })
    expect(JSON.stringify(r.output)).toContain('fan-out 3 is over the limit of 2')
  })

  it('realTasks without a task system explains that it is not configured', async () => {
    const t = await stack()
    const r = await t.call('sessions.loop', { items: ['a'], instruction: 'x', realTasks: true })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('not configured')
    expect(await t.sessions.children(t.session.id)).toHaveLength(0)
  })

  it('realTasks creates a task per item through the configured tool and subscribes the child to it', async () => {
    const t = await stack()
    const calls: any[] = []
    t.tools.register(
      {
        name: 'mcp.linear.create_issue',
        description: 'create',
        parameters: { type: 'object', properties: {} },
        effect: 'non_idempotent',
        source: 'mcp',
        server: 'linear',
      },
      async (args) => {
        calls.push(args)
        return { output: JSON.stringify({ id: `PAY-${100 + calls.length}` }) }
      },
    )
    await t.directory.employees.update(t.employee.id, {
      taskSystem: { server: 'linear', createTool: 'create_issue', args: { teamId: 'T1' }, parentArg: 'parentId' },
    })
    const o = await t.out('sessions.loop', { items: ['a', 'b'], instruction: 'Do it', realTasks: true, parentTaskId: 'PAY-1' })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ teamId: 'T1', parentId: 'PAY-1', title: expect.stringContaining('a') })
    expect(o.children.map((c: any) => c.task)).toEqual([
      { system: 'linear', id: 'PAY-101' },
      { system: 'linear', id: 'PAY-102' },
    ])
    const subs = await t.events.subscriptions.forSubject({ system: 'linear', id: 'PAY-101' })
    expect(subs.map((s) => s.data.sessionId)).toEqual([o.children[0].sessionId])
  })

  it('realTasks starts nothing when a task fails', async () => {
    const t = await stack()
    t.tools.register(
      { name: 'tasks.create', description: 'c', parameters: { type: 'object' }, effect: 'non_idempotent', source: 'mcp' },
      async () => ({ output: 'boom', isError: true }),
    )
    await t.directory.employees.update(t.employee.id, { taskSystem: { tool: 'tasks.create' } })
    const r = await t.call('sessions.loop', { items: ['a'], instruction: 'x', realTasks: true })
    expect(r.isError).toBe(true)
    expect(await t.sessions.children(t.session.id)).toHaveLength(0)
  })
})

describe('sessions.wait', () => {
  it('suspends on the given runs', async () => {
    const t = await stack()
    const o = await t.out('sessions.fork', { instruction: 'x' })
    const r = await t.call('sessions.wait', { runIds: [o.runId], timeoutSeconds: 60 })
    expect(r.control).toEqual([
      { type: 'suspend', wait: { type: 'runs', runIds: [o.runId], mode: 'all', timeoutAt: '2026-09-29T09:01:00.000Z' } },
    ])
  })

  it('answers right away when the runs are already done (all, or any)', async () => {
    const t = await stack()
    const a = await t.out('sessions.fork', { instruction: 'a' })
    const b = await t.out('sessions.fork', { instruction: 'b' })
    await t.sessions.transition(a.runId, 'queued', 'running')
    await t.sessions.transition(a.runId, 'running', 'completed', { result: { status: 'completed', output: 'A done' } })
    await t.sessions.update(a.sessionId, { document: 'What A did.' })
    const any = await t.call('sessions.wait', { runIds: [a.runId, b.runId], mode: 'any' })
    expect(any.control).toBeUndefined()
    expect(any.output).toMatchObject({
      finished: true,
      results: [
        { runId: a.runId, done: true, state: 'completed', output: 'A done', document: 'What A did.' },
        { runId: b.runId, done: false, state: 'queued' },
      ],
    })
    expect((await t.call('sessions.wait', { runIds: [a.runId, b.runId] })).control?.[0]?.type).toBe('suspend')
  })

  it('refuses unknown runs, itself, and bad modes', async () => {
    const t = await stack()
    expect((await t.call('sessions.wait', { runIds: ['run_nope'] })).isError).toBe(true)
    expect((await t.call('sessions.wait', { runIds: [t.run.id] })).isError).toBe(true)
    const o = await t.out('sessions.fork', { instruction: 'x' })
    expect((await t.call('sessions.wait', { runIds: [o.runId], mode: 'some' })).isError).toBe(true)
    expect((await t.call('sessions.wait', { runIds: [] })).isError).toBe(true)
  })
})

describe('sessions.wait for a delivery', () => {
  it('suspends until the next delivery, with an optional timeout', async () => {
    const t = await stack()
    expect(t.run.data.mode).toBe('continuing')
    const r = await t.call('sessions.wait', { delivery: true, timeoutSeconds: 600 })
    expect(r.output).toMatchObject({ waitingFor: 'delivery', timeoutAt: '2026-09-29T09:10:00.000Z' })
    expect(r.control).toEqual([{ type: 'suspend', wait: { type: 'delivery', timeoutAt: '2026-09-29T09:10:00.000Z' } }])
    expect((await t.call('sessions.wait', { delivery: true })).control).toEqual([{ type: 'suspend', wait: { type: 'delivery' } }])
  })

  it('refuses runIds with delivery, a bad timeout, and an ephemeral run', async () => {
    const t = await stack()
    const o = await t.out('sessions.fork', { instruction: 'x' })
    expect((await t.call('sessions.wait', { delivery: true, runIds: [o.runId] })).isError).toBe(true)
    expect((await t.call('sessions.wait', { delivery: true, timeoutSeconds: 0 })).isError).toBe(true)
    expect((await t.call('sessions.wait', {})).isError).toBe(true)
    const eph = await t.sessions.createRun({ sessionId: t.session.id, mode: 'ephemeral', cause: { type: 'manual' } })
    const r = await t.call('sessions.wait', { delivery: true }, t.ctx({ runId: eph.id }))
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toMatch(/end your turn/)
  })
})

describe('finding sessions', () => {
  it('look_up, list, search, tree and get', async () => {
    const t = await stack()
    await t.out('sessions.save_metadata', { document: 'Refunding the duplicate charge for ACME.' })
    const f = await t.out('sessions.fork', { instruction: 'x', title: 'Child work' })
    await t.out('sessions.link', { ref: { kind: 'contact', id: t.ana.id }, role: 'waiting_on' })
    await t.recordCall(t.run.id, 'docs.read', { note: 'the quarterly ledger says 42' })

    expect((await t.out('sessions.look_up', { id: f.sessionId })).sessions[0].title).toBe('Child work')
    expect((await t.out('sessions.look_up', { slug: `#${f.slug}` })).sessions[0].id).toBe(f.sessionId)
    expect((await t.out('sessions.look_up', { text: 'duplicate charge' })).sessions.map((s: any) => s.id)).toEqual([t.session.id])
    expect(
      (await t.out('sessions.look_up', { linkedTo: { kind: 'contact', id: t.ana.id }, role: 'waiting_on' })).sessions.map(
        (s: any) => s.id,
      ),
    ).toEqual([t.session.id])
    expect((await t.out('sessions.list', {})).total).toBe(2)
    expect((await t.out('sessions.list', { rootId: t.session.id })).total).toBe(2)

    const s = await t.out('sessions.search', { text: 'quarterly ledger', includeThisSession: true })
    expect(s.entries[0]).toMatchObject({ sessionId: t.session.id, kind: 'tool_result' })
    expect(s.entries[0].snippet).toContain('quarterly ledger')
    // By default this session's own entries are left out, and counted.
    const others = await t.out('sessions.search', { text: 'quarterly ledger' })
    expect(others.entries).toHaveLength(0)
    expect(others).toMatchObject({ inThisSession: 1, note: expect.stringContaining('includeThisSession') })

    const tree = await t.out('sessions.tree', {})
    expect(tree.tree).toMatchObject({ id: t.session.id, self: true, children: [{ id: f.sessionId }] })

    const g = await t.out('sessions.get', {})
    expect(g).toMatchObject({
      id: t.session.id,
      document: 'Refunding the duplicate charge for ACME.',
      checklist: { complete: true },
    })
    expect(g.runs[0]).toMatchObject({ runId: t.run.id, state: 'running' })
    expect(g.links.some((l: any) => l.role === 'waiting_on')).toBe(true)
  })

  it('search finds what an earlier session wrote in tool call arguments and got in tool results', async () => {
    const t = await stack()
    // An earlier session wrote a README with git.write_file, and read a file back.
    const old = await t.newSession('Write the parser docs')
    const r = await t.startRun(old.id, 'write the README')
    const readme = '# Invoice parser\n\nParses invoices from PDF into JSON.\n'
    await t.sessions.append(r.id, {
      kind: 'assistant',
      content: {
        text: null,
        toolCalls: [{ id: 'call_w', name: 'git.write_file', arguments: JSON.stringify({ path: 'README.md', content: readme }) }],
      },
    })
    await t.sessions.append(r.id, {
      kind: 'tool_result',
      content: { toolCallId: 'call_w', name: 'git.write_file', output: { path: 'README.md', size: readme.length } },
    })
    await t.recordCall(r.id, 'git.read_file', { path: 'CHANGELOG.md', content: 'v1: first parser release' })
    // This session talks about the README a lot: newest first, its own entries would crowd the old ones out.
    for (let i = 0; i < 12; i++) await t.recordCall(t.run.id, 'chat.read', { text: `read the README of the parser (${i})` })

    const s = await t.out('sessions.search', { text: 'parser README', limit: 5 })
    expect(s.entries.map((e: any) => e.sessionId)).toEqual([old.id])
    expect(s.entries[0]).toMatchObject({ kind: 'assistant', sessionTitle: 'Write the parser docs' })
    // The snippet shows the file's text, not escaped JSON.
    expect(s.entries[0].snippet).toContain('git.write_file')
    expect(s.entries[0].snippet).toContain('Parses invoices from PDF')
    expect(s.inThisSession).toBeGreaterThan(0)
    // Words in any order, across a newline of the file.
    expect((await t.out('sessions.search', { text: 'JSON invoices' })).entries[0].sessionId).toBe(old.id)
    // Tool results too.
    const result = await t.out('sessions.search', { text: 'first parser release' })
    expect(result.entries[0]).toMatchObject({ sessionId: old.id, kind: 'tool_result' })
  })

  it("search doesn't see other employees' sessions", async () => {
    const t = await stack()
    const other = await t.directory.employees.create({ name: 'Other Bot' })
    const s = await t.newSession('secret work', other.id)
    const r = await t.startRun(s.id, 'the zebra password')
    void r
    expect((await t.out('sessions.search', { text: 'zebra' })).entries).toHaveLength(0)
    expect((await t.out('sessions.look_up', { text: 'secret work' })).sessions).toHaveLength(0)
    expect((await t.call('sessions.get', { sessionId: s.id })).isError).toBe(true)
  })
})

describe('metadata, links and templates', () => {
  it('save_metadata updates fields and merges meta, but not reserved keys', async () => {
    const t = await stack()
    const o = await t.out('sessions.save_metadata', { title: 'Renamed', status: 'waiting', meta: { ticket: 'PAY-1' } })
    expect(o.updated).toEqual(['title', 'status', 'meta'])
    await t.out('sessions.save_metadata', { meta: { other: 1, ticket: null } })
    const s = await t.sessions.require(t.session.id)
    expect(s.data).toMatchObject({ title: 'Renamed', status: 'waiting', meta: { other: 1 } })
    expect((await t.call('sessions.save_metadata', { meta: { worktrees: [] } })).isError).toBe(true)
    expect((await t.call('sessions.save_metadata', {})).isError).toBe(true)
  })

  it('link and unlink', async () => {
    const t = await stack()
    await t.out('sessions.link', { ref: { kind: 'project', id: t.project.id }, role: 'affects' })
    expect(await t.records.links({ from: { kind: 'session', id: t.session.id }, role: 'affects' })).toHaveLength(1)
    await t.out('sessions.unlink', { ref: { kind: 'project', id: t.project.id }, role: 'affects' })
    expect(await t.records.links({ from: { kind: 'session', id: t.session.id }, role: 'affects' })).toHaveLength(0)
    expect((await t.call('sessions.link', { ref: { kind: 'session', id: t.session.id }, role: 'related' })).isError).toBe(true)
  })

  it('save_template turns a session into a template', async () => {
    const t = await stack()
    await t.checklists.addItem(t.session.id, { text: 'Tests pass' })
    await t.out('sessions.link', { ref: { kind: 'project', id: t.project.id }, role: 'works_on' })
    const o = await t.out('sessions.save_template', {
      name: 'Refund',
      instructions: 'Refund {{ticket}}',
      params: [{ name: 'ticket' }],
    })
    const tpl = await t.sessions.getTemplate(o.templateId)
    expect(tpl!.data).toMatchObject({
      name: 'Refund',
      instructions: 'Refund {{ticket}}',
      checklist: [{ text: 'Tests pass', required: true, review: false }],
      links: [{ ref: { kind: 'project', id: t.project.id }, role: 'works_on' }],
    })
  })
})

describe('run control', () => {
  it('commit, discard, compact and finish return control signals', async () => {
    const t = await stack()
    expect((await t.call('sessions.commit', {})).control).toEqual([{ type: 'commit' }])
    expect((await t.call('sessions.commit', { summary: 'did x' })).control).toEqual([{ type: 'commit', summary: 'did x' }])
    expect((await t.call('sessions.discard', {})).control).toEqual([{ type: 'discard' }])
    expect((await t.call('sessions.compact', { summary: 'all of it' })).control).toEqual([
      { type: 'compact', summary: 'all of it' },
    ])
    expect((await t.call('sessions.finish', { output: 'Done.' })).control).toEqual([
      { type: 'end', status: 'completed', output: 'Done.' },
    ])
    expect((await t.call('sessions.finish', { output: 'no', status: 'failed' })).control).toEqual([
      { type: 'end', status: 'failed', output: 'no' },
    ])
  })

  it('offload and rewind take a tool call id; rewind keeps the whole turn', async () => {
    const t = await stack()
    const id1 = 'call_t1'
    const id2 = 'call_t2'
    const a = await t.sessions.append(t.run.id, {
      kind: 'assistant',
      content: {
        text: null,
        toolCalls: [
          { id: id1, name: 'docs.read', arguments: '{}' },
          { id: id2, name: 'docs.read', arguments: '{}' },
        ],
      },
    })
    const r1 = await t.sessions.append(t.run.id, {
      kind: 'tool_result',
      content: { toolCallId: id1, name: 'docs.read', output: 'one' },
    })
    const r2 = await t.sessions.append(t.run.id, {
      kind: 'tool_result',
      content: { toolCallId: id2, name: 'docs.read', output: 'two' },
    })
    await t.recordCall(t.run.id, 'docs.read', 'later')
    // Rewinding to the first call of a turn lands after the turn's last result.
    const rw = await t.call('sessions.rewind', { toEntry: id1, summary: 'read both' })
    expect(rw.control).toEqual([{ type: 'rewind', toEntry: r2.id, summary: 'read both' }])
    expect(a.id).toBeTruthy()
    const off = await t.call('sessions.offload', { entryId: id1, text: 'doc one' })
    expect((off.control![0] as any).entryId).toBe(r1.id)
    expect((await t.call('sessions.offload', { entryId: 'call_nope', text: 'x' })).isError).toBe(true)
    expect((await t.call('sessions.rewind', { toEntry: 'call_nope', summary: 'x' })).isError).toBe(true)
  })

  it('restore reads a piece of an offloaded result without changing anything', async () => {
    const t = await stack()
    const text = 'abcdefghij'.repeat(5000)
    const big = await t.recordCall(t.run.id, 'docs.read', text)
    await t.sessions.offload(t.run.id, big.entryId, { text: 'preview' })
    const before = await t.sessions.runHistory(t.run.id)
    const r = await t.call('sessions.restore', { entryId: big.entryId, offset: 10, length: 25 })
    expect(r.control).toBeUndefined()
    expect(r.output).toMatchObject({ entryId: big.entryId, offset: 10, end: 35, total: 50_000, text: text.slice(10, 35) })
    // The default piece is capped; the last piece says it's done.
    const all = (await t.call('sessions.restore', { entryId: big.callId, offset: 0 })).output as any
    expect(all.text.length).toBe(20_000)
    expect(all.next).toMatch(/offset 20000/)
    expect(((await t.call('sessions.restore', { entryId: big.entryId, offset: 45_000 })).output as any).done).toBe(true)
    expect(await t.sessions.runHistory(t.run.id)).toEqual(before)
    // Only entries of this session.
    const other = await t.newSession('Other')
    expect(
      (await t.call('sessions.restore', { entryId: (await t.sessions.history(other.id))[0]?.id ?? 'ent_nope', offset: 0 }))
        .isError,
    ).toBe(true)
  })

  describe('sessions.rewind with from and to', () => {
    /** Three reads over two turns, the answer and a new message, then the turn that calls sessions.rewind. */
    async function readingThenRewind(t: Awaited<ReturnType<typeof stack>>, extraCalls: string[] = []) {
      const c1 = await t.recordCall(t.run.id, 'docs.read', 'one')
      const a2 = await t.sessions.append(t.run.id, {
        kind: 'assistant',
        content: {
          text: null,
          toolCalls: [
            { id: 'call_r2', name: 'docs.read', arguments: '{}' },
            { id: 'call_r3', name: 'docs.read', arguments: '{}' },
          ],
        },
      })
      await t.sessions.append(t.run.id, {
        kind: 'tool_result',
        content: { toolCallId: 'call_r2', name: 'docs.read', output: 'two' },
      })
      const r3 = await t.sessions.append(t.run.id, {
        kind: 'tool_result',
        content: { toolCallId: 'call_r3', name: 'docs.read', output: 'three' },
      })
      await t.sessions.append(t.run.id, { kind: 'assistant', content: { text: 'PAY-7 needs a refund' } })
      await t.sessions.append(t.run.id, { kind: 'user', content: { text: 'thanks, and the invoice?' } })
      const callId = 'call_rewind'
      const ids = [...extraCalls, callId]
      const current = await t.sessions.append(t.run.id, {
        kind: 'assistant',
        content: {
          text: null,
          toolCalls: ids.map((id) => ({ id, name: id === callId ? 'sessions.rewind' : 'docs.read', arguments: '{}' })),
        },
      })
      return { c1, a2, r3, current, callId, ctx: t.ctx({ callId }) }
    }

    it('collapses from the first read through the last one, keeping what follows', async () => {
      const t = await stack()
      const { c1, r3, callId, ctx } = await readingThenRewind(t)
      await t.sessions.updateRun(t.run.id, {
        context: { tokens: 10_000, window: 100_000, chars: 35_000, model: 'm', at: new Date(0).toISOString() },
      })
      const path = await t.sessions.runHistory(t.run.id)
      const first = path.findIndex((e) => e.kind === 'assistant')
      const r = await t.call('sessions.rewind', { from: c1.callId, to: 'call_r3', summary: 'read one to three: a refund' }, ctx)
      expect(r.isError).toBeFalsy()
      expect(r.control).toEqual([
        { type: 'rewind', toEntry: path[first - 1]!.id, summary: 'read one to three: a refund', keepAfter: r3.id },
      ])
      const o = r.output as any
      expect(o.collapsed).toEqual({ from: path[first]!.id, to: r3.id, entries: 5, toolCalls: 3 })
      // The answer, the message and this turn stay, plus this call's result.
      expect(o.keptEntries).toBe(4)
      expect(o.context.tokensBefore).toBe(10_000)
      expect(o.context.tokensAfter).toBeLessThan(10_000)
      expect(o.context.window).toBe(100_000)
      expect(o.reminder).toMatch(/every fact, id, path, decision and open item/)
      expect(o.ephemeral).toBeUndefined()

      // Applied like the runner does it (after this call's result): the person's messages and the answer survive.
      await t.sessions.append(t.run.id, {
        kind: 'tool_result',
        content: { toolCallId: callId, name: 'sessions.rewind', output: o },
      })
      const c = r.control![0] as { toEntry: string; summary: string; keepAfter: string }
      await t.sessions.rewind(t.run.id, c.toEntry, c.summary, { keepAfter: c.keepAfter })
      const h = await t.sessions.runHistory(t.run.id)
      expect(h.slice(first - 1).map((e) => e.kind)).toEqual(['user', 'summary', 'assistant', 'user', 'assistant', 'tool_result'])
      expect((h[first + 1]!.content as any).text).toBe('PAY-7 needs a refund')
      expect((h[first + 2]!.content as any).text).toBe('thanks, and the invoice?')
    })

    it('collapses up to a result in the current turn: the later calls, this one included, stay', async () => {
      const t = await stack()
      const { c1, callId, ctx } = await readingThenRewind(t, ['call_r4', 'call_r5'])
      const r4 = await t.sessions.append(t.run.id, {
        kind: 'tool_result',
        content: { toolCallId: 'call_r4', name: 'docs.read', output: 'four' },
      })
      await t.sessions.append(t.run.id, {
        kind: 'tool_result',
        content: { toolCallId: 'call_r5', name: 'docs.read', output: 'five' },
      })
      const r = await t.call('sessions.rewind', { from: c1.callId, to: 'call_r4', summary: 'read one to four' }, ctx)
      expect((r.control![0] as any).keepAfter).toBe(r4.id)
      const o = r.output as any
      // A1 r1, A2 r2 r3, the answer, the message, this turn's assistant entry and r4.
      expect(o.collapsed).toMatchObject({ entries: 9, toolCalls: 4 })
      // r5 and this call's result, with a copy of this turn's assistant entry carrying their calls.
      expect(o.keptEntries).toBe(3)
      await t.sessions.append(t.run.id, {
        kind: 'tool_result',
        content: { toolCallId: callId, name: 'sessions.rewind', output: 'ok' },
      })
      const c = r.control![0] as { toEntry: string; summary: string; keepAfter: string }
      await t.sessions.rewind(t.run.id, c.toEntry, c.summary, { keepAfter: c.keepAfter })
      const h = await t.sessions.runHistory(t.run.id)
      expect(h.slice(-4).map((e) => e.kind)).toEqual(['summary', 'assistant', 'tool_result', 'tool_result'])
      expect((h.at(-3)!.content as any).toolCalls.map((x: { id: string }) => x.id)).toEqual(['call_r5', callId])
    })

    it('refuses bad ids, a call without a result, this call, and a stretch the wrong way round', async () => {
      const t = await stack()
      const { c1, ctx } = await readingThenRewind(t, ['call_r4'])
      const err = async (args: Record<string, unknown>) => {
        const r = await t.call('sessions.rewind', { summary: 's', ...args }, ctx)
        expect(r.isError).toBe(true)
        return (r.output as { error: string }).error
      }
      expect(await err({ from: 'call_nope', to: 'call_r3' })).toMatch(/call_nope is not a tool call or entry/)
      expect(await err({ from: c1.callId, to: 'ent_nope' })).toMatch(/ent_nope is not a tool call or entry/)
      // call_r4 is in this turn and has no result yet.
      expect(await err({ from: c1.callId, to: 'call_r4' })).toMatch(/has no result yet/)
      expect(await err({ from: c1.callId, to: 'call_rewind' })).toMatch(/this sessions\.rewind call/)
      expect(await err({ from: 'call_r3', to: c1.callId })).toMatch(/comes before/)
      const path = await t.sessions.runHistory(t.run.id)
      expect(await err({ from: path[0]!.id, to: 'call_r3' })).toMatch(/first entry/)
      expect(await err({ to: 'call_r3' })).toMatch(/from is required/)
      expect((await t.call('sessions.rewind', { from: c1.callId, to: 'call_r3' }, ctx)).isError).toBe(true)
      // Jumping back into this turn can't work: the turn's own results would be cut off from it.
      expect(await err({ from: 'call_r4' })).toMatch(/in this turn/)
    })

    it('jumps back without to, and says what it drops', async () => {
      const t = await stack()
      const { c1, ctx } = await readingThenRewind(t)
      const r = await t.call('sessions.rewind', { from: c1.callId, summary: 'dead end' }, ctx)
      expect(r.control).toEqual([{ type: 'rewind', toEntry: c1.entryId, summary: 'dead end' }])
      expect(r.output).toMatchObject({ rewindTo: c1.entryId, dropped: { entries: 6, toolCalls: 2 } })
      expect((r.output as any).note).toMatch(/dropped/)
    })

    it('says an ephemeral run keeps the change only until it ends, unless it commits', async () => {
      const t = await stack()
      const run = await t.sessions.createRun({
        sessionId: t.session.id,
        mode: 'ephemeral',
        cause: { type: 'manual' },
        input: [{ kind: 'user', content: { text: 'look around' } }],
      })
      await t.sessions.transition(run.id, 'queued', 'running')
      const c1 = await t.recordCall(run.id, 'docs.read', 'one')
      const c2 = await t.recordCall(run.id, 'docs.read', 'two')
      const ctx = t.ctx({ runId: run.id })
      const r = await t.call('sessions.rewind', { from: c1.callId, to: c2.callId, summary: 'read two docs' }, ctx)
      expect((r.output as any).ephemeral).toMatch(/unless the run commits/)
    })
  })

  it('rewind checks the entry is on the current path', async () => {
    const t = await stack()
    const path = await t.sessions.runHistory(t.run.id)
    const r = await t.call('sessions.rewind', { toEntry: path[0]!.id, summary: 'tried a, found b' })
    expect(r.control).toEqual([{ type: 'rewind', toEntry: path[0]!.id, summary: 'tried a, found b' }])
    expect((await t.call('sessions.rewind', { toEntry: 'ent_nope', summary: 'x' })).isError).toBe(true)
  })

  it('offload writes the chapter first, then points to it; restore undoes it', async () => {
    const t = await stack()
    const big = await t.recordCall(t.run.id, 'docs.read', 'a very long document …')
    const r = await t.call('sessions.offload', {
      entryId: big.entryId,
      text: 'The retry policy doc',
      chapter: 'Retry policy',
      content: 'Retry 3 times with backoff.',
    })
    expect(r.isError).toBeUndefined()
    const control = r.control![0] as any
    expect(control).toMatchObject({ type: 'offload', entryId: big.entryId })
    // The pointer names the original, so the model can read it back.
    expect(control.pointer.text).toBe(
      `The retry policy doc (the original is entry ${big.entryId}: sessions.restore reads it back)`,
    )
    const docId = control.pointer.doc.id
    expect(await t.docs.chapter(docId, 'Retry policy')).toBe('Retry 3 times with backoff.')
    // Applying it (as the runner would) and restoring.
    await t.sessions.offload(t.run.id, big.entryId, control.pointer)
    const pointer = (await t.sessions.runHistory(t.run.id)).find((e) => e.kind === 'pointer')!
    const rr = await t.call('sessions.restore', { pointerEntryId: pointer.id })
    expect(rr.control).toEqual([{ type: 'restore', pointerEntryId: pointer.id }])
    // The original entry id and the tool call id name the same pointer.
    expect((await t.call('sessions.restore', { entryId: big.entryId })).control).toEqual(rr.control)
    expect((await t.call('sessions.restore', { entryId: big.callId })).control).toEqual(rr.control)
    expect((await t.call('sessions.restore', { entryId: first0(await t.sessions.runHistory(t.run.id)) })).isError).toBe(true)
    expect((await t.call('sessions.restore', {})).isError).toBe(true)
    // The first entry can't be offloaded; content needs a chapter.
    const first = (await t.sessions.runHistory(t.run.id))[0]!
    expect((await t.call('sessions.offload', { entryId: first.id, text: 'x' })).isError).toBe(true)
    expect((await t.call('sessions.offload', { entryId: big.entryId, text: 'x', content: 'y' })).isError).toBe(true)
  })
})

const first0 = (h: { id: string }[]) => h[0]!.id

describe('sessions.message', () => {
  it('ingests a tagged event addressed to the target session', async () => {
    const t = await stack()
    const other = await t.newSession('Intake')
    const o = await t.out('sessions.message', { to: `@billing-bot#${other.data.slug}`, text: 'Can you take PAY-7?' })
    const ev = await t.events.require(o.eventId)
    expect(ev.data).toMatchObject({
      source: 'session',
      type: 'session.message',
      subject: { system: 'mp', id: other.id },
      employeeId: t.employee.id,
    })
    const p = ev.data.payload as any
    expect(p.tags).toEqual([
      { raw: `@billing-bot#${other.data.slug}`, type: 'session', employeeId: t.employee.id, sessionId: other.id },
    ])
    expect(p.author).toEqual({ kind: 'session', id: t.session.id })
    expect(ev.data.text).toContain(`@billing-bot#${t.session.data.slug}`)
    // By slug and id too; retrying the same call doesn't send twice.
    const c = t.ctx()
    const a1 = await t.out('sessions.message', { to: `#${other.data.slug}`, text: 'again' }, c)
    const a2 = await t.out('sessions.message', { to: other.id, text: 'again' }, c)
    expect(a2.eventId).toBe(a1.eventId)
  })

  it('stops two sessions that keep messaging each other, or paste files at each other', async () => {
    const t = await stack()
    const other = await t.newSession('Verifier')
    for (let i = 0; i < 20; i++) await t.out('sessions.message', { to: other.id, text: `batch ${i}` })
    const r = await t.call('sessions.message', { to: other.id, text: 'batch 20' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('tell the person who asked')
    // A third session is a separate exchange; so is the same pair once the window has passed.
    const third = await t.newSession('Someone else')
    expect((await t.call('sessions.message', { to: third.id, text: 'hi' })).isError).toBeFalsy()
    // One big paste is enough to hit the character budget.
    const fourth = await t.newSession('Paste target')
    await t.out('sessions.message', { to: fourth.id, text: 'x'.repeat(30_000) })
    const paste = await t.call('sessions.message', { to: fourth.id, text: 'y'.repeat(15_000) })
    expect(JSON.stringify(paste.output)).toContain('fs.share')
  })

  it('refuses unknown targets and itself', async () => {
    const t = await stack()
    expect((await t.call('sessions.message', { to: '@nobody#x', text: 'hi' })).isError).toBe(true)
    expect((await t.call('sessions.message', { to: t.session.id, text: 'hi' })).isError).toBe(true)
  })
})

describe('registration', () => {
  it('gives every tool a description, an object schema and an effect class', async () => {
    const t = await stack()
    for (const def of t.tools.list()) {
      if (def.source !== 'stdlib') continue
      expect(def.description.length).toBeGreaterThan(20)
      expect(def.parameters).toMatchObject({ type: 'object' })
      expect(['read', 'idempotent', 'non_idempotent']).toContain(def.effect)
    }
    const effects = Object.fromEntries(t.tools.list().map((d) => [d.name, d.effect])) as Record<string, Json>
    expect(effects).toMatchObject({
      'sessions.get': 'read',
      'sessions.loop': 'non_idempotent',
      'env.exec': 'non_idempotent',
      'triggers.create': 'non_idempotent',
      'git.commit': 'idempotent',
    })
  })
})
