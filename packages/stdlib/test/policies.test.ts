import { beforeDeliver, type Delivery } from '@mp/router'
import { afterModelCall, afterRun, afterToolCall, beforeFinish, beforeModelCall, beforeToolCall } from '@mp/runner'
import { describe, expect, it } from 'vitest'
import {
  ROUTER_LOG_CHUNK,
  ROUTER_LOG_KEEP,
  routerLogView,
  AI_STREAK_TOPIC,
  AUTO_COMMIT_MESSAGE,
  PROGRESS_EVERY,
  PROGRESS_MIN_MS,
  registerPolicies,
  registerRouterPolicies,
  registerUsagePolicies,
} from '../src/index.ts'
import { checkoutPath, REPO, type Stack, stack } from './helpers.ts'

const finish = async (t: Stack, output?: string, status: 'completed' | 'failed' = 'completed') =>
  t.hooks.decide(beforeFinish, {
    run: await t.sessions.requireRun(t.run.id),
    session: await t.sessions.require(t.session.id),
    status,
    ...(output !== undefined ? { output } : {}),
  })

describe('checklist gate', () => {
  it('blocks while required items are open, listing them, and passes once checked', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    await t.checklists.addItem(t.session.id, { text: 'Tests pass' })
    await t.checklists.addItem(t.session.id, { text: 'Optional', required: false })
    const d = await finish(t, 'done')
    expect(d?.block).toContain('i1 "Tests pass" (not checked)')
    expect(d?.block).not.toContain('Optional')
    expect(await finish(t, 'gave up', 'failed')).toBeUndefined()
    const ev = await t.recordCall(t.run.id, 'env.exec', { exitCode: 0 })
    await t.checklists.check(t.session.id, 'i1', [ev.entryId], { runId: t.run.id })
    expect(await finish(t, 'done')).toBeUndefined()
  })

  it('can be turned off', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps, { checklistGate: false })
    await t.checklists.addItem(t.session.id, { text: 'Tests pass' })
    expect(await finish(t, 'done')).toBeUndefined()
  })
})

describe('docs maintenance', () => {
  it('blocks a run that committed code without writing docs', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    expect(await finish(t, 'done')).toBeUndefined() // no commit, no rule
    await t.recordCall(t.run.id, 'git.commit', { sha: 'abc123', branch: 'mp/x' })
    expect((await finish(t, 'done'))?.block).toContain('updated no docs')
    expect(await finish(t, 'Done. No docs update needed: only a typo in a test.')).toBeUndefined()
    await t.recordCall(t.run.id, 'git.write_file', { path: 'src/x.ts' })
    expect(await finish(t, 'done')).toBeDefined()
    await t.recordCall(t.run.id, 'git.write_file', { path: 'README.md' })
    expect(await finish(t, 'done')).toBeUndefined()
  })

  it('counts an edit of a docs file as a docs update (git.edit_file, not only git.write_file)', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    await t.recordCall(t.run.id, 'git.commit', { sha: 'abc123', branch: 'mp/x' })
    await t.recordCall(t.run.id, 'git.edit_file', { path: 'src/diff.js', replaced: 1 })
    expect((await finish(t, 'done'))?.block).toContain('updated no docs')
    await t.recordCall(t.run.id, 'git.edit_file', { path: 'README.md', replaced: 1 })
    expect(await finish(t, 'done')).toBeUndefined()
  })

  it('accepts docs tools, ignores failed ones and commits with nothing to commit', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    await t.recordCall(t.run.id, 'git.commit', { sha: null, note: 'nothing to commit' })
    expect(await finish(t, 'done')).toBeUndefined()
    await t.recordCall(t.run.id, 'git.commit', { sha: 'abc' })
    await t.recordCall(t.run.id, 'docs.write_chapter', { error: 'nope' }, true)
    expect(await finish(t, 'done')).toBeDefined()
    await t.recordCall(t.run.id, 'docs.write_chapter', { id: 'doc_x' })
    expect(await finish(t, 'done')).toBeUndefined()
  })

  it("only looks at the run's own entries", async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    await t.recordCall(t.run.id, 'git.commit', { sha: 'abc' })
    await t.recordCall(t.run.id, 'docs.write', { id: 'doc_x' })
    await t.sessions.transition(t.run.id, 'running', 'completed')
    await t.sessions.commit(t.run.id)
    const run2 = await t.startRun(t.session.id, 'next')
    await t.recordCall(run2.id, 'git.commit', { sha: 'def' })
    const d = await t.hooks.decide(beforeFinish, {
      run: run2,
      session: await t.sessions.require(t.session.id),
      status: 'completed',
    })
    expect(d?.block).toContain('updated no docs')
  })
})

describe('session document', () => {
  it('is off by default, and when on needs a document update in the run', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps, { sessionDocument: true })
    expect((await finish(t, 'done'))?.block).toContain('session document')
    await t.out('sessions.save_metadata', { title: 'x' })
    await t.recordCall(t.run.id, 'sessions.save_metadata', { sessionId: t.session.id, updated: ['title'] })
    expect(await finish(t, 'done')).toBeDefined()
    await t.recordCall(t.run.id, 'sessions.save_metadata', { sessionId: t.session.id, updated: ['document'] })
    expect(await finish(t, 'done')).toBeUndefined()

    const t2 = await stack()
    registerPolicies(t2.hooks, t2.deps)
    expect(await finish(t2, 'done')).toBeUndefined()
  })
})

describe('commit on stop', () => {
  it('commits uncommitted worktree changes after the run with trailers', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    await t.out('git.checkout', { projectId: t.project.id })
    const w = { path: await checkoutPath(t, t.session.id) }
    await t.out('git.write_file', { path: 'src/wip.ts', content: 'wip' })
    const run = await t.sessions.requireRun(t.run.id)
    await t.hooks.decide(afterRun, { run, session: t.session, result: { status: 'completed' } })
    expect((await t.git.status(w.path)).clean).toBe(true)
    const c = t.git.calls.filter((x) => x.method === 'commitAll').at(-1)!
    expect(c.args[1]).toMatchObject({
      message: AUTO_COMMIT_MESSAGE,
      trailers: { Session: t.session.id, 'Requested-by': t.ana.id },
    })
    // Clean worktrees aren't committed again; failures are logged, not thrown.
    const before = t.git.calls.length
    await t.hooks.decide(afterRun, { run, session: t.session, result: { status: 'completed' } })
    expect(t.git.calls.filter((x) => x.method === 'commitAll').length).toBe(1)
    expect(t.git.calls.length).toBeGreaterThan(before)
    await t.records.update('session', t.session.id, {
      meta: { worktrees: [{ key: 'k', projectId: 'p', repoIndex: 0, url: 'u', path: '/nope', branch: 'b', baseSha: 's' }] },
    })
    await t.hooks.decide(afterRun, { run, session: t.session, result: { status: 'failed' } })
    expect(t.logger.lines.some((l) => l.msg === 'auto-commit failed')).toBe(true)
  })

  it('leaves a merge with conflict markers in progress, and finishes it once they are fixed', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    await t.out('git.checkout', { projectId: t.project.id })
    const path = await checkoutPath(t, t.session.id)
    await t.out('git.write_file', { path: 'README.md', content: 'ours' })
    await t.out('git.commit', { message: 'ours' })
    t.git.addRemoteCommit(REPO, 'main', 'theirs', { 'README.md': 'theirs' })
    expect((await t.out('git.sync', {})).conflict).toBeDefined()
    const run = await t.sessions.requireRun(t.run.id)
    await t.hooks.decide(afterRun, { run, session: t.session, result: { status: 'completed' } })
    expect((await t.git.status(path)).merging).toBe(true)
    await t.out('git.write_file', { path: 'README.md', content: 'both' })
    await t.hooks.decide(afterRun, { run, session: t.session, result: { status: 'completed' } })
    expect((await t.git.status(path)).merging).toBe(false)
    expect(t.git.worktree(path)!.dirty.size).toBe(0)
  })
})

describe('tool gates', () => {
  it('denies git.push to protected branches before the git layer', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    const w = await t.out('git.checkout', { projectId: t.project.id })
    const tool = t.tools.get('git.push')!.def
    const base = { run: t.run, session: t.session, tool, callId: 'c1' }
    expect(await t.hooks.decide(beforeToolCall, { ...base, args: { branch: 'main' } })).toMatchObject({
      deny: expect.stringContaining('protected'),
    })
    expect(await t.hooks.decide(beforeToolCall, { ...base, args: { branch: 'refs/heads/release/1.2' } })).toBeDefined()
    expect(await t.hooks.decide(beforeToolCall, { ...base, args: {} })).toBeUndefined()
    expect(await t.hooks.decide(beforeToolCall, { ...base, args: { branch: w.branch } })).toBeUndefined()
    const other = t.tools.get('git.commit')!.def
    expect(await t.hooks.decide(beforeToolCall, { ...base, tool: other, args: { branch: 'main' } })).toBeUndefined()
  })

  it('removes every policy with the returned function', async () => {
    const t = await stack()
    const off = registerPolicies(t.hooks, t.deps)
    expect(t.hooks.registered().length).toBeGreaterThan(0)
    off()
    expect(t.hooks.registered()).toEqual([])
  })
})

describe('usage policies', () => {
  it('records usage after model calls and pauses when a budget is used up', async () => {
    const t = await stack()
    registerUsagePolicies(t.hooks, t.deps)
    await t.usage.limits.set({ target: { type: 'employee', id: t.employee.id }, maxTokens: 100, period: 'day' })
    const payload = { run: t.run, session: t.session, messages: [], step: 0 }
    expect(await t.hooks.decide(beforeModelCall, payload)).toBeUndefined()
    await t.hooks.decide(afterModelCall, {
      run: t.run,
      session: t.session,
      step: 0,
      model: 'kimi-test',
      response: {
        message: { role: 'assistant', content: 'x' },
        finishReason: 'stop',
        model: 'kimi-test',
        usage: { promptTokens: 90, completionTokens: 20, cachedTokens: 10, reasoningTokens: 5, totalTokens: 110 },
      },
    })
    const totals = await t.usage.totals({ runId: t.run.id })
    expect(totals).toMatchObject({ promptTokens: 90, completionTokens: 20, cachedTokens: 10, totalTokens: 110, calls: 1 })
    const rec = (await t.records.query('usage', {})).items[0]!.data
    expect(rec).toMatchObject({
      sessionId: t.session.id,
      rootSessionId: t.session.id,
      employeeId: t.employee.id,
      requesterId: t.ana.id,
      model: 'kimi-test',
    })
    expect(await t.hooks.decide(beforeModelCall, payload)).toMatchObject({
      pause: expect.stringContaining('token budget is used up'),
    })
  })

  it("pauses when the requester's daily budget is used up", async () => {
    const t = await stack()
    registerUsagePolicies(t.hooks, t.deps)
    await t.usage.limits.set({ target: { type: 'contact', id: t.ana.id }, maxTokens: 50 })
    const payload = { run: t.run, session: t.session, messages: [], step: 0 }
    expect(await t.hooks.decide(beforeModelCall, payload)).toBeUndefined()
    await t.usage.record({ requesterId: t.ana.id, model: 'm', promptTokens: 40, completionTokens: 20 })
    expect(await t.hooks.decide(beforeModelCall, payload)).toEqual({
      pause: "the requester's daily token budget is used up: 60 of 50 tokens today (it resets at 00:00 UTC)",
    })
  })
})

describe('AI streak (router)', () => {
  const setup = async (maxAiStreak?: number) => {
    const t = await stack()
    registerRouterPolicies(t.hooks, t.deps, maxAiStreak !== undefined ? { maxAiStreak } : {})
    const ch = await t.chat.createChannel({ name: 'ai-talk', createdBy: { kind: 'contact', id: t.ana.id } })
    const other = await t.newSession('Other')
    const delivery: Delivery = {
      sessionId: other.id,
      reason: 'subscription',
      expectedToAct: true,
      trusted: true,
      fork: false,
      priority: 0,
    }
    const decide = async (messageId: string) => {
      const ev = (await t.events.query({ source: 'chat' })).find((e) => (e.data.payload as any).messageId === messageId)!
      return t.hooks.decide(beforeDeliver, { event: ev, delivery })
    }
    return { t, ch, other, decide }
  }

  it('pauses deliveries after maxAiStreak AI messages in a row, until a person posts', async () => {
    const { t, ch, other, decide } = await setup(2)
    const seen: unknown[] = []
    t.bus.subscribe(AI_STREAK_TOPIC, (m) => void seen.push(m.payload))
    const root = await t.chat.post({ channelId: ch.id, author: { kind: 'session', id: t.session.id }, text: 'one' })
    expect(await decide(root.id)).toBeUndefined()
    const m2 = await t.chat.post({ channelId: ch.id, threadId: root.id, author: { kind: 'session', id: other.id }, text: 'two' })
    expect(await decide(m2.id)).toBeUndefined()
    const m3 = await t.chat.post({
      channelId: ch.id,
      threadId: root.id,
      author: { kind: 'session', id: t.session.id },
      text: 'three',
    })
    expect(await decide(m3.id)).toMatchObject({ pause: expect.stringContaining('3 messages between AI employees') })
    await t.bus.idle()
    expect(seen).toHaveLength(1)
    // A person joins: their message goes through and resets the streak.
    const p = await t.chat.post({ channelId: ch.id, threadId: root.id, author: { kind: 'contact', id: t.ana.id }, text: 'stop' })
    expect(await decide(p.id)).toBeUndefined()
    const m5 = await t.chat.post({ channelId: ch.id, threadId: root.id, author: { kind: 'session', id: other.id }, text: 'ok' })
    expect(await decide(m5.id)).toBeUndefined()
    // AI contacts count as AI.
    const m6 = await t.chat.post({
      channelId: ch.id,
      threadId: root.id,
      author: { kind: 'contact', id: t.employee.data.contactId },
      text: 'me too',
    })
    expect(await decide(m6.id)).toBeUndefined()
    const m7 = await t.chat.post({
      channelId: ch.id,
      threadId: root.id,
      author: { kind: 'session', id: other.id },
      text: 'again',
    })
    expect(await decide(m7.id)).toBeDefined()
  })

  it('reads the limit from the employee limits, and ignores other events', async () => {
    const { t, ch, other, decide } = await setup()
    await t.usage.limits.set({ target: { type: 'employee', id: t.employee.id }, maxAiStreak: 1 })
    const root = await t.chat.post({ channelId: ch.id, author: { kind: 'session', id: t.session.id }, text: 'one' })
    expect(await decide(root.id)).toBeUndefined()
    const m2 = await t.chat.post({
      channelId: ch.id,
      threadId: root.id,
      author: { kind: 'session', id: t.session.id },
      text: 'two',
    })
    expect(await decide(m2.id)).toBeDefined()
    const { event } = await t.events.ingest({ source: 'mcp:linear', type: 'comment', text: 'x' })
    expect(
      await t.hooks.decide(beforeDeliver, {
        event,
        delivery: { sessionId: other.id, reason: 'trigger', expectedToAct: true, trusted: false, fork: false, priority: 0 },
      }),
    ).toBeUndefined()
  })
})

describe('answer where asked: needsAutoReply', async () => {
  const { needsAutoReply } = await import('../src/policies.ts')
  const ev = (expectedToAct: boolean, source = 'chat') =>
    ({
      kind: 'event',
      content: { source, expectedToAct, text: 'q', type: 'message.posted', eventId: 'e', trusted: false },
    }) as any
  const res = (name: string, isError = false) =>
    ({ kind: 'tool_result', content: { toolCallId: 'c', name, output: {}, isError } }) as any

  it('posts only for chat requests it was expected to act on, with an answer', () => {
    expect(needsAutoReply([ev(true)], 'The answer.')).toBe(true)
    expect(needsAutoReply([ev(true)], '   ')).toBe(false)
    expect(needsAutoReply([ev(true)], undefined)).toBe(false)
    expect(needsAutoReply([ev(false)], 'fyi only')).toBe(false)
    expect(needsAutoReply([ev(true, 'mcp:linear')], 'not chat')).toBe(false)
  })

  it('does not post when the run already answered in chat or handed the work off', () => {
    for (const name of [
      'chat.post',
      'chat.reply',
      'chat.invite',
      'sessions.fork',
      'sessions.loop',
      'sessions.create',
      'sessions.message',
      'procedures.run',
    ])
      expect(needsAutoReply([ev(true), res(name)], 'done'), name).toBe(false)
    // A failed reply doesn't count as having answered.
    expect(needsAutoReply([ev(true), res('chat.reply', true)], 'done')).toBe(true)
    expect(needsAutoReply([ev(true), res('docs.read')], 'done')).toBe(true)
  })
})

describe('answer where asked: the agent may decide not to answer', async () => {
  const { needsAutoReply, NO_REPLY_RE } = await import('../src/policies.ts')
  const ev = {
    kind: 'event',
    content: { source: 'chat', expectedToAct: true, text: 'thanks!', type: 'message.replied', eventId: 'e', trusted: true },
  } as any
  it('posts nothing when the run ends with NO_REPLY', () => {
    for (const out of ['NO_REPLY', 'no reply', '[NO_REPLY]', 'NO_REPLY: just a thanks', '  no_reply  '])
      expect(needsAutoReply([ev], out), out).toBe(false)
    expect(needsAutoReply([ev], 'No reply is needed, but here is the answer: 42')).toBe(true)
    expect(NO_REPLY_RE.test('Reply sent.')).toBe(false)
    // Thinking aloud before deciding: the decision is the last line, and nothing is posted.
    expect(
      NO_REPLY_RE.test(
        'The person asked @vegan, not me. Nothing needed from me here.\n\nNO_REPLY: question directed at @vegan; another session is re-counting.',
      ),
    ).toBe(true)
    expect(NO_REPLY_RE.test('NO_REPLY\nit was only a thanks')).toBe(true)
    expect(NO_REPLY_RE.test('No reply from the vendor yet, so I will check again tomorrow.')).toBe(false)
    expect(NO_REPLY_RE.test('The vendor sent no reply yet.')).toBe(false)
  })
})

describe('router decisions', () => {
  it('a watched channel run that stays out (NO_REPLY) records nothing; any other router run must commit', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    const run = await t.sessions.requireRun(t.run.id)
    const session = await t.sessions.require(t.session.id)
    const router = { ...session, data: { ...session.data, meta: { role: 'router' } } }
    const asRouter = (note: string, output: string) =>
      t.hooks.decide(beforeFinish, {
        run: { ...run, data: { ...run.data, mode: 'ephemeral', cause: { type: 'event', eventId: 'evt_x', note } } },
        session: router,
        status: 'completed',
        output,
      })
    const needsCommit = (d: { block?: string } | undefined) => !!d?.block?.includes('record your decision')
    expect(needsCommit(await asRouter('watch', 'NO_REPLY: people chatting'))).toBe(false)
    // Getting involved is a decision like any other.
    expect(needsCommit(await asRouter('watch', 'Started a session for the checkout bug'))).toBe(true)
    // Asked directly, staying out still gets its line: the harness writes it, no more model calls.
    expect(needsCommit(await asRouter('fallback', 'NO_REPLY: just a thanks'))).toBe(false)
    expect((await t.sessions.requireRun(run.id)).data).toMatchObject({
      commit: true,
      commitSummary: 'request → NO_REPLY (just a thanks)',
    })
  })

  it('an event that is not a message, with nothing to do, records nothing unless the router acted', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    const session = await t.sessions.require(t.session.id)
    const router = { ...session, data: { ...session.data, meta: { role: 'router' } } }
    const ingest = async (source: string, type: string) =>
      (await t.events.ingest({ source, type, dedupeKey: `${type}:${Math.random()}`, payload: {} })).event.id
    const finish = async (eventId: string, output: string) => {
      const run = await t.sessions.requireRun(t.run.id)
      return t.hooks.decide(beforeFinish, {
        run: { ...run, data: { ...run.data, mode: 'ephemeral', cause: { type: 'event', eventId, note: 'fallback' } } },
        session: router,
        status: 'completed',
        output,
      })
    }
    const needsCommit = (d: { block?: string } | undefined) => !!d?.block?.includes('record your decision')
    const mr = await ingest('integration:gitlab', 'merge_request.updated')
    expect(needsCommit(await finish(mr, 'NO_REPLY: not about me'))).toBe(false)
    expect(needsCommit(await finish(mr, 'Started a session for the review'))).toBe(true)
    const dm = await ingest('integration:slack', 'message.direct')
    expect(needsCommit(await finish(dm, 'NO_REPLY'))).toBe(false)
    expect((await t.sessions.requireRun(t.run.id)).data.commitSummary).toMatch(/message\.direct.* → NO_REPLY$/)
  })
})

describe('router decision logs', async () => {
  const { isRouterLog } = await import('../src/policies.ts')
  const router = { data: { meta: { role: 'router' } } }
  it("are not posted as replies; a router's plain answer and any work session's text are", () => {
    for (const out of [
      'Logged.',
      'Decision recorded.',
      'slack:C0TEST0001/1700000000.000100 (#general, from a person): :eyes: reaction → NO_REPLY (acknowledgment reaction, nothing needed)',
      'thread msg_1 (#requests, from Bob): capital of Serbia → started @meatless#capital-of-serbia (ses_1)',
      'Decision recorded: NO_REPLY — slack:C0TEST0001/1700000000.000200 (Slack #general, from Bo): "lunch anyone?" is a casual remark',
      'Decision recorded and committed.',
      'No reply needed — casual chatter, NO_REPLY.',
    ])
      expect(isRouterLog(router, out), out).toBe(true)
    expect(isRouterLog(router, "I'm Meatless, an AI employee.")).toBe(false)
    expect(isRouterLog({ data: { meta: {} } }, 'Logged.')).toBe(false)
  })
})

describe('a router context’s view of its decision lines', () => {
  const line = (i: number) => ({ id: `l${i}`, kind: 'summary', meta: { op: 'commitSummary' } as Record<string, unknown> })
  const other = (id: string, kind = 'system') => ({ id, kind, meta: {} as Record<string, unknown> })
  const history = (n: number) => [other('prompt'), other('instructions'), ...Array.from({ length: n }, (_, i) => line(i))]
  const ids = (n: number) => routerLogView(history(n)).map((e) => e.id)

  it('shows every line up to KEEP + CHUNK - 1, then drops the oldest a whole chunk at a time', () => {
    expect(ids(10)).toEqual(history(10).map((e) => e.id))
    const most = ROUTER_LOG_KEEP + ROUTER_LOG_CHUNK - 1
    expect(ids(most)).toHaveLength(most + 2)
    const after = ids(most + 1)
    expect(after).toHaveLength(ROUTER_LOG_KEEP + 2)
    expect(after.slice(0, 3)).toEqual(['prompt', 'instructions', `l${ROUTER_LOG_CHUNK}`])
    // Between drops the start of the view stays the same (the cached prefix).
    expect(ids(most + 2).slice(0, 3)).toEqual(after.slice(0, 3))
    expect(ids(most + 1 + ROUTER_LOG_CHUNK)[2]).toBe(`l${2 * ROUTER_LOG_CHUNK}`)
  })

  it('keeps every other entry, wherever it is', () => {
    const h = [other('prompt'), ...Array.from({ length: 100 }, (_, i) => line(i)), other('note', 'user')]
    const v = routerLogView(h).map((e) => e.id)
    expect(v[0]).toBe('prompt')
    expect(v.at(-1)).toBe('note')
    expect(v.filter((x) => x.startsWith('l'))).toHaveLength(
      100 - Math.floor((100 - ROUTER_LOG_KEEP) / ROUTER_LOG_CHUNK) * ROUTER_LOG_CHUNK,
    )
  })
})

describe('progress reminders', () => {
  const call = (t: Stack, run: Record<string, unknown>, name: string, output: unknown = { ok: true }, meta = {}) =>
    t.hooks.transform(afterToolCall, {
      run: { id: 'run_p1', createdAt: '2026-09-29T08:00:00.000Z', data: { mode: 'continuing', requesterId: 'con_ana', ...run } },
      session: { id: 'ses_p1', data: { meta } },
      tool: { name },
      result: { output },
    } as never)

  it('asks for a one-line update after a dozen tool calls without one, and again a dozen later', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    for (let i = 1; i < PROGRESS_EVERY; i++) expect((await call(t, {}, 'mcp.crm.query')).result.output).toEqual({ ok: true })
    const nth = await call(t, {}, 'mcp.crm.query')
    expect(nth.result.output).toMatchObject({ ok: true, harnessNote: expect.stringContaining('progress update') })
    // A text output gets the note appended.
    for (let i = 1; i < PROGRESS_EVERY; i++) await call(t, {}, 'fs.read', 'file text')
    expect((await call(t, {}, 'fs.read', 'file text')).result.output).toMatch(/^file text\n\n\[harness note\]/)
  })

  it('starts counting again after a reply, and leaves routers and runs nobody asked for alone', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    for (let i = 1; i < PROGRESS_EVERY; i++) await call(t, {}, 'mcp.crm.query')
    await call(t, {}, 'mcp.slack.reply')
    expect((await call(t, {}, 'mcp.crm.query')).result.output).toEqual({ ok: true })
    for (let i = 0; i < PROGRESS_EVERY * 2; i++) {
      expect((await call(t, { id: 'x' }, 'mcp.crm.query', { ok: 1 }, { role: 'router' })).result.output).toEqual({ ok: 1 })
      expect((await call(t, { requesterId: undefined }, 'mcp.crm.query', { ok: 2 })).result.output).toEqual({ ok: 2 })
    }
  })

  it('waits two minutes after the person last heard anything', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    await call(t, {}, 'mcp.slack.reply')
    for (let i = 0; i < PROGRESS_EVERY * 2; i++) expect((await call(t, {}, 'mcp.crm.query')).result.output).toEqual({ ok: true })
    t.clock.advance(PROGRESS_MIN_MS)
    expect((await call(t, {}, 'mcp.crm.query')).result.output).toHaveProperty('harnessNote')
  })

  it('leaves a scheduled run alone until someone writes into it', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps)
    const { event } = await t.events.ingest({
      source: 'schedule',
      type: 'scheduled_task.fired',
      dedupeKey: 'tick-1',
      text: 'brief',
    })
    const fired = { cause: { type: 'event', eventId: event.id } }
    for (let i = 0; i < PROGRESS_EVERY * 2; i++)
      expect((await call(t, fired, 'mcp.crm.query')).result.output).toEqual({ ok: true })
    const asked = { ...fired, requests: [{ eventId: 'evt_x', requesterId: 'con_ana', at: '2026-09-29T09:00:00.000Z' }] }
    const out = []
    for (let i = 0; i < PROGRESS_EVERY; i++) out.push((await call(t, asked, 'mcp.crm.query')).result.output)
    expect(out.some((o) => o && typeof o === 'object' && 'harnessNote' in o)).toBe(true)
  })

  it('can be turned off', async () => {
    const t = await stack()
    registerPolicies(t.hooks, t.deps, { progressEvery: 0 })
    for (let i = 0; i < PROGRESS_EVERY * 2; i++) expect((await call(t, {}, 'mcp.crm.query')).result.output).toEqual({ ok: true })
  })
})
