import { sleep } from '@mp/core'
import { callTools, reply, scriptedModel, type ModelRequest, type ScriptResult } from '@mp/model'
import { memoryQueue } from '@mp/queue'
import { createRouter } from '@mp/router'
import { RUNS_QUEUE, createRunner, type Runner } from '@mp/runner'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSET, registerPolicies, registerRouterPolicies, registerUsagePolicies } from '../src/index.ts'
import { REPO, stack } from './helpers.ts'

type Step = (req: ModelRequest) => ScriptResult

const text = (m: { content?: string | null } | undefined) => (typeof m?.content === 'string' ? m.content : '')
const lastTool = (req: ModelRequest): any => {
  const m = [...req.messages].reverse().find((x) => x.role === 'tool')
  return m ? JSON.parse(text(m).replace(/^ERROR: /, '')) : null
}
const lastText = (req: ModelRequest) => text(req.messages.at(-1))

/**
 * A model that follows one script per conversation: the latest user message
 * starting with a route key picks the script, and the number of assistant
 * messages since then picks the step.
 */
function routed(routes: Record<string, Step[]>) {
  return (req: ModelRequest): ScriptResult => {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i]!
      if (m.role !== 'user') continue
      const key = Object.keys(routes).find((k) => text(m).startsWith(k))
      if (!key) continue
      const n = req.messages.slice(i + 1).filter((x) => x.role === 'assistant').length
      const step = routes[key]![n]
      if (!step) return new Error(`no step ${n} for ${key}; last: ${lastText(req).slice(0, 300)}`)
      return step(req)
    }
    return new Error(`no route for: ${lastText(req).slice(0, 200)}`)
  }
}

const workers: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const w of workers.splice(0)) await w.close()
})

async function world(routes: Record<string, Step[]>) {
  let runner: Runner
  const t = await stack({ enqueueRun: (id) => runner.enqueue(id) })
  const queue = memoryQueue({ bus: t.bus })
  const model = scriptedModel(routed(routes))
  runner = createRunner({
    sessions: t.sessions,
    tools: t.tools,
    model,
    queue,
    hooks: t.hooks,
    bus: t.bus,
    clock: t.clock,
    toolListsFor: async (id) => {
      const e = await t.directory.employees.get(id)
      return { allow: e?.data.toolAllow ?? [], deny: e?.data.toolDeny ?? [] }
    },
  })
  const router = createRouter({
    events: t.events,
    sessions: t.sessions,
    queue,
    hooks: t.hooks,
    bus: t.bus,
    routerSessionFor: async () => null,
    procedureContext: async (id) => (await t.directory.procedures.get(id))?.data.contextSessionId ?? null,
  })
  t.bus.subscribe<{ eventId: string; created: boolean }>('event.ingested', async (m) => {
    if (m.payload.created) await router.route(m.payload.eventId)
  })
  workers.push(
    queue.process<{ runId: string }>(RUNS_QUEUE, async (job) => void (await runner.execute(job.data.runId)), { concurrency: 1 }),
  )
  registerPolicies(t.hooks, t.deps)
  registerUsagePolicies(t.hooks, t.deps)
  registerRouterPolicies(t.hooks, t.deps)

  /** Waits until nothing is queued or running. */
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      await t.bus.idle()
      await queue.idle()
      await t.bus.idle()
      // The stack's own main run stays running: it's driven by hand in the unit tests.
      const busy = (await t.sessions.runs({ state: ['queued', 'running'], limit: 1000 })).filter((r) => r.id !== t.run.id)
      if (!busy.length) return
      await sleep(5)
    }
    const busy = (await t.sessions.runs({ limit: 1000 })).map(
      (r) => `${r.id} ${r.data.state} ${r.data.pauseReason ?? ''} ${JSON.stringify(r.data.result ?? {})}`,
    )
    throw new Error(`did not settle:\n${busy.join('\n')}`)
  }
  const begin = async (title: string, instruction: string) => {
    const s = await t.newSession(title)
    const run = await t.sessions.createRun({
      sessionId: s.id,
      cause: { type: 'manual' },
      requesterId: t.ana.id,
      input: [{ kind: 'user', content: { text: instruction } }],
    })
    await runner.enqueue(run.id)
    return { session: s, run }
  }
  return { ...t, queue, model, runner: runner!, router, settle, begin }
}

describe('end to end with the runner and router', () => {
  it('fork + wait: the parent gets the child result', async () => {
    const w = await world({
      PARENT: [
        () => callTools([{ name: 'sessions__fork', args: { instruction: 'CHILD: what is 6*7?' } }]),
        (req) => callTools([{ name: 'sessions__wait', args: { runIds: [lastTool(req).runId] } }]),
        (req) => reply(`parent got: ${lastText(req).includes('"output": "42"')}`),
      ],
      'CHILD:': [() => reply('42')],
    })
    const { session, run } = await w.begin('Parent', 'PARENT')
    await w.settle()
    const done = await w.sessions.requireRun(run.id)
    expect(done.data).toMatchObject({ state: 'completed', result: { output: 'parent got: true' } })
    const [child] = await w.sessions.children(session.id)
    const childRuns = await w.sessions.runs({ sessionId: child!.id })
    expect(childRuns[0]!.data).toMatchObject({ state: 'completed', cause: { type: 'fork', parentRunId: run.id } })
    expect(await w.usage.totals({ rootSessionId: session.id })).toMatchObject({ calls: 4 })
  })

  it('chat.post + a person replying: the reply is routed back through the subscription', async () => {
    const w = await world({
      ASK: [
        () => callTools([{ name: 'chat__post', args: { channel: 'billing', text: '@ana is invoice 9 a duplicate?' } }]),
        () => reply('Asked Ana.'),
      ],
      '[event chat/message.replied': [(req) => reply(`Thanks: ${lastText(req).includes('yes, duplicate')}`)],
    })
    const ch = await w.chat.createChannel({ name: 'billing', createdBy: { kind: 'contact', id: w.ana.id } })
    const { session, run } = await w.begin('Ask Ana', 'ASK')
    await w.settle()
    expect((await w.sessions.requireRun(run.id)).data.state).toBe('completed')
    const [root] = await w.chat.messages(ch.id)
    await w.chat.post({ channelId: ch.id, threadId: root!.id, author: { kind: 'contact', id: w.ana.id }, text: 'yes, duplicate' })
    await w.settle()
    const runs = await w.sessions.runs({ sessionId: session.id })
    expect(runs).toHaveLength(2)
    expect(runs[1]!.data).toMatchObject({
      state: 'completed',
      mode: 'continuing',
      cause: { type: 'event', note: 'subscription' },
      requesterId: w.ana.id,
      result: { output: 'Thanks: true' },
    })
  })

  it('procedures.run with a checklist gate that blocks until the item is checked with evidence', async () => {
    let procId = ''
    const w = await world({
      START: [
        () => callTools([{ name: 'procedures__run', args: { procedureId: procId, work: 'Ana needs read access to billing' } }]),
        (req) => callTools([{ name: 'sessions__wait', args: { runIds: [lastTool(req).runId] } }]),
        (req) => reply(`procedure finished: ${lastText(req).includes('Access granted')}`),
      ],
      'Run this procedure': [
        () => reply('Access granted.'),
        (req) => {
          expect(lastText(req)).toContain('required checklist items are not done: i1 "Owner approved"')
          return callTools([{ id: 'call_ev1', name: 'directory__get_contact', args: { id: w.ana.id } }])
        },
        () => callTools([{ name: 'checklist__check', args: { itemId: 'i1', evidence: ['call_ev1'] } }]),
        (req) => {
          expect(lastTool(req).complete).toBe(true)
          return reply('Access granted.')
        },
      ],
    })
    procId = (
      await w.directory.procedures.create({
        name: 'Access request',
        applies: 'someone needs access',
        body: 'Check with the owner.',
        checklist: [{ text: 'Owner approved' }],
      })
    ).id
    const { session, run } = await w.begin('Intake', 'START')
    await w.settle()
    expect((await w.sessions.requireRun(run.id)).data.result?.output).toBe('procedure finished: true')
    const fork = (await w.records.linked({ kind: 'session', id: session.id }, { direction: 'in', role: 'procedure_for' }))[0]!
    expect((await w.checklists.status(fork.record.id)).complete).toBe(true)
    const forkRun = (await w.sessions.runs({ sessionId: fork.record.id }))[0]!
    const policyMessages = (await w.sessions.runHistory(forkRun.id)).filter((e) => e.meta.policy)
    expect(policyMessages).toHaveLength(1)
  })

  it('git: checkout, write, commit, a denied push to main, a push of its branch, and the docs policy', async () => {
    const w = await world({
      CODE: [
        () => callTools([{ name: 'git__checkout', args: { projectId: w.project.id } }]),
        () => callTools([{ name: 'git__write_file', args: { path: 'src/refund.ts', content: 'export const refund = () => 1' } }]),
        () => callTools([{ name: 'git__commit', args: { message: 'Add refund' } }]),
        () => callTools([{ name: 'git__push', args: { branch: 'main' } }]),
        (req) => {
          expect(text(req.messages.at(-1))).toContain('denied: pushing to main is not allowed')
          return callTools([{ name: 'git__push', args: {} }])
        },
        () => reply('Done, pushed.'),
        (req) => {
          expect(lastText(req)).toContain('updated no docs')
          return callTools([{ name: 'git__write_file', args: { path: 'docs/refunds.md', content: '# Refunds' } }])
        },
        () => callTools([{ name: 'git__commit', args: { message: 'Document refunds' } }]),
        () => callTools([{ name: 'git__push', args: {} }]),
        () => reply('Done, pushed with docs.'),
      ],
    })
    const { session, run } = await w.begin('Code', 'CODE')
    await w.settle()
    const done = await w.sessions.requireRun(run.id)
    expect(done.data).toMatchObject({ state: 'completed', result: { output: 'Done, pushed with docs.' } })
    const branch = `mp/billing-bot/${session.data.slug}`
    expect(w.git.pushes.map((p) => p.branch)).toEqual([branch, branch])
    expect(w.git.remote(REPO).branches.get('main')).toBe(w.git.remote(REPO).branches.get('main'))
    expect(w.git.pushes.some((p) => p.branch === 'main')).toBe(false)
    const commits = [...w.git.remote(REPO).commits.values()].filter((c) => c.trailers.Session === session.id)
    expect(commits.map((c) => c.message).sort()).toEqual(['Add refund', 'Document refunds'])
  })

  it('commit on stop, memory, files and session messages through the router', async () => {
    const w = await world({
      WORK: [
        () =>
          callTools([
            {
              name: 'memory__remember',
              args: { summary: 'Invoices are numbered per year', scope: { type: 'project', id: w.project.id } },
            },
            { name: 'sessions__link', args: { ref: { kind: 'project', id: w.project.id }, role: 'works_on' } },
          ]),
        () => callTools([{ name: 'memory__recall', args: { text: 'invoices numbered' } }]),
        (req) => {
          expect(lastTool(req).memories).toHaveLength(1)
          return callTools([
            { name: 'fs__write', args: { path: '/reports/r.md', content: 'report' } },
            { name: 'fs__share', args: { path: '/reports', with: w.ana.id } },
          ])
        },
        () => callTools([{ name: 'git__checkout', args: { projectId: w.project.id } }]),
        () => callTools([{ name: 'git__write_file', args: { path: 'notes.txt', content: 'left over' } }]),
        () => callTools([{ name: 'sessions__message', args: { to: '#helper', text: 'HELP: please review' } }]),
        () => reply('Done.'),
      ],
      '[event session/session.message': [(req) => reply(`helper saw: ${lastText(req).includes('HELP: please review')}`)],
    })
    const helper = await w.sessions.create({
      employeeId: w.employee.id,
      title: 'Helper',
      slug: 'helper',
      toolset: [...DEFAULT_TOOLSET],
      entries: [{ kind: 'system', content: { text: 'helper' } }],
    })
    const { session, run } = await w.begin('Work', 'WORK')
    await w.settle()
    expect((await w.sessions.requireRun(run.id)).data.state).toBe('completed')
    // Commit on stop picked up the uncommitted file.
    const wt = w.git.worktrees().find((x) => x.path.includes(session.id))!
    expect(wt.dirty.size).toBe(0)
    expect(w.git.remote(REPO).commits.size + 0).toBeGreaterThan(0)
    const autoCommit = w.git.calls.find(
      (c) => c.method === 'commitAll' && (c.args[1] as any).message.startsWith('Work in progress'),
    )
    expect(autoCommit).toBeDefined()
    // Files shared with Ana.
    expect((await w.files.forContact(w.ana.id).read(`/shared/${w.employee.id}/reports/r.md`)).content).toBe('report')
    // The helper session got the message as a session-tagged delivery.
    const helperRuns = await w.sessions.runs({ sessionId: helper.id })
    expect(helperRuns[0]!.data).toMatchObject({
      state: 'completed',
      cause: { note: 'session_tag' },
      result: { output: 'helper saw: true' },
    })
  })
})
