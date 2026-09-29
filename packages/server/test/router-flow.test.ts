import { callTools, type ModelRequest, reply, type ScriptResult } from '@mp/model'
import { afterEach, describe, expect, it } from 'vitest'
import { THREAD_CONTEXT_HEADER } from '../src/thread-context.ts'
import { migrateEmployees, OLD_DEFAULT_PERSONALITIES } from '../src/bootstrap.ts'
import { upgradeEmployees } from '../src/upgrade.ts'
import { type TestApp, testApp, until } from './helpers.ts'

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

const settle = async (app: TestApp) => {
  await until(
    async () => {
      await app.a.services.queue.idle()
      await app.a.services.bus.idle()
      return (await app.a.services.sessions.runs({ state: ['queued', 'running'] })).length === 0
    },
    'runs to settle',
    10_000,
  )
  await app.settle()
}

describe('the router flow in any channel', () => {
  it('handles a tag in an ephemeral run, and a follow-up sees the thread so far', async () => {
    const requests: ModelRequest[] = []
    const script = (req: ModelRequest): ScriptResult => {
      requests.push(req)
      const last = req.messages.at(-1)?.content ?? ''
      if (last.includes('who are you?')) return reply("I'm Meatless.")
      return reply('Sure: what do you need?')
    }
    t = await testApp({ script })
    const s = t.a.services
    const general = (await s.chat.channelByName('general'))!.id
    const root = await t.req('POST', `/api/chat/channels/${general}/messages`, { text: '@meatless who are you?' })
    await settle(t)
    await t.req('POST', `/api/chat/channels/${general}/messages`, { text: 'Can you help me?', threadId: root.body.id })
    await settle(t)

    const routerId = (await s.routerSessionFor())!
    const runs = await s.sessions.runs({ sessionId: routerId })
    const byEvent = runs.filter((r) => r.data.cause.type === 'event')
    expect(byEvent.map((r) => r.data.mode)).toEqual(['ephemeral', 'ephemeral'])
    // The follow-up came with the thread: the question and the answer before it.
    const followUp = requests.filter((r) => r.messages.some((m) => (m.content ?? '').includes('Can you help me?')))[0]!
    const thread = followUp.messages.find((m) => (m.content ?? '').includes(THREAD_CONTEXT_HEADER))?.content ?? ''
    expect(thread).toContain('who are you?')
    expect(thread).toContain('Meatless (AI) (')
    expect(thread).toContain("I'm Meatless.")
    // Both answers are in the thread, and the router kept only its decisions.
    const replies = (await t.req('GET', `/api/chat/threads/${root.body.id}`)).body.replies.map((m: any) => m.data.text)
    expect(replies).toEqual(["I'm Meatless.", 'Can you help me?', 'Sure: what do you need?'])
    const history = await s.sessions.history(routerId)
    expect(history.filter((e) => e.kind === 'event')).toHaveLength(0)
    expect(history.filter((e) => e.kind === 'summary')).toHaveLength(2)
  })
})

describe('upgrading employees from earlier versions', () => {
  it('resets an old router context once, gives it the router instructions and toolset, and keeps the old branch', async () => {
    t = await testApp({ script: () => reply('ok') })
    const s = t.a.services
    const routerId = (await s.routerSessionFor())!
    // Make it look like a router from before the router flow: full toolset, no instructions, requests kept in history.
    const before = await s.sessions.require(routerId)
    await s.records.update('session', routerId, { toolset: [...before.data.toolset!, 'git.checkout'], meta: { role: 'router' } })
    const head = (await s.sessions.history(routerId)).at(-1)!
    const actor = { type: 'system' as const, id: 'test' }
    for (const text of ['what time is it?', 'who are you?']) {
      const run = await s.sessions.createRun({ sessionId: routerId, mode: 'continuing', cause: { type: 'manual' }, actor })
      await s.sessions.transition(run.id, 'queued', 'running')
      await s.sessions.append(run.id, {
        kind: 'event',
        content: { text: `[chat message.posted; from a person] #general: ${text}` },
      })
      await s.sessions.append(run.id, { kind: 'assistant', content: { text: 'answered' } })
      await s.sessions.commit(run.id)
      await s.sessions.transition(run.id, 'running', 'completed', { result: { status: 'completed', output: 'answered' } })
    }
    expect((await s.sessions.history(routerId)).length).toBeGreaterThan(4)

    const r = await upgradeEmployees(s)
    expect(r.reset).toBe(1)
    const after = await s.sessions.require(routerId)
    expect(after.data.meta?.routerInstructions).toBeGreaterThanOrEqual(1)
    expect(after.data.toolset).not.toContain('git.checkout')
    const history = await s.sessions.history(routerId)
    expect(history.some((e) => e.kind === 'event')).toBe(false)
    const summary = history.find((e) => e.kind === 'summary')!
    expect(JSON.stringify(summary.content)).toContain('what time is it?')
    expect(history.some((e) => e.kind === 'system' && JSON.stringify(e.content).includes('router context'))).toBe(true)
    expect(head.id).toBeTruthy()

    // Idempotent: a second start changes nothing.
    const again = await upgradeEmployees(s)
    expect(again.reset).toBe(0)
    expect((await s.sessions.history(routerId)).length).toBe(history.length)
  })

  it('keeps the personality note when an old router is reset, and replaces older router instructions', async () => {
    t = await testApp({ script: () => reply('ok') })
    const s = t.a.services
    const employee = (await s.directory.employees.byHandle('meatless'))!
    const routerId = employee.data.routerSessionId!
    await s.directory.employees.update(employee.id, { personality: OLD_DEFAULT_PERSONALITIES[0]! })
    await s.records.update('session', routerId, { meta: { role: 'router' } })
    // The same order as a start: the upgrade (with its one-time reset), then the migration.
    await upgradeEmployees(s)
    await migrateEmployees(s)
    const texts = (await s.sessions.history(routerId)).map((e) => JSON.stringify(e.content))
    expect(texts.some((x) => x.includes("Don't sign off your messages"))).toBe(true)

    // A router on an older instructions version gets the new ones, marked as replacing the old.
    const cur = await s.sessions.require(routerId)
    await s.records.update('session', routerId, { meta: { ...cur.data.meta, routerInstructions: 1 } })
    await upgradeEmployees(s)
    const last = (await s.sessions.history(routerId)).filter((e) => e.kind === 'system').at(-1)!
    expect(JSON.stringify(last.content)).toContain('replace your earlier router instructions')
    expect(JSON.stringify(last.content)).toContain("You don't answer requests yourself")
  })
})

describe('follow-ups in a thread that tagged an employee', () => {
  it('reach the tagged employee even before it posted there (e.g. an alert)', async () => {
    // No workers: nobody answers the root, so the employee is in the thread only through the tag.
    t = await testApp({ script: () => reply('ok'), workers: false })
    const s = t.a.services
    const general = (await s.chat.channelByName('general'))!.id
    // Tagging the employee, like an alert does.
    const root = (await t.req('POST', `/api/chat/channels/${general}/messages`, { text: 'run failed @meatless' })).body
    await t.req('POST', `/api/chat/channels/${general}/messages`, { text: 'why did it fail?', threadId: root.id })
    const events = await s.records.query<any>('event', {
      where: { type: 'message.replied' },
      orderBy: { field: 'createdAt', dir: 'desc' },
      limit: 5,
    })
    const followUp = events.items.find((e: any) => (e.data.text ?? '').includes('why did it fail?'))!
    const plan = await s.router.plan(followUp)
    expect(plan).toContainEqual(
      expect.objectContaining({ sessionId: (await s.routerSessionFor())!, reason: 'thread_participant' }),
    )
  })
})

describe('work the router starts', () => {
  it("gets the employee's full toolset and keeps its work", async () => {
    const script = Object.assign(
      (req: ModelRequest): ScriptResult => {
        const router = req.messages.some((m) => m.role === 'system' && (m.content ?? '').includes('router context'))
        const called = (name: string) =>
          req.messages.some((m) => m.tool_calls?.some((c) => c.function.name.replace(/__/g, '.') === name))
        if (router && !called('sessions.create'))
          return callTools([
            { name: 'sessions.create', args: { title: 'Script help', instruction: 'Write the script.', mode: 'ephemeral' } },
          ])
        if (router && !called('sessions.commit'))
          return callTools([
            { name: 'sessions.commit', args: { summary: 'thread (#general): script → started @meatless#script-help' } },
          ])
        return reply('NO_REPLY')
      },
      { raw: true },
    )
    t = await testApp({ script })
    const s = t.a.services
    const general = (await s.chat.channelByName('general'))!.id
    await t.req('POST', `/api/chat/channels/${general}/messages`, { text: '@meatless write me a script' })
    await settle(t)
    const router = await s.sessions.require((await s.routerSessionFor())!)
    const work = (await s.records.query<any>('session', { where: { slug: 'script-help' } })).items[0]!
    expect(router.data.toolset).not.toContain('fs.read')
    expect(work.data.toolset).toContain('fs.read')
    expect(work.data.toolset!.length).toBeGreaterThan(router.data.toolset!.length)
    // It owns the thread, so it keeps its work even when the router asked for an ephemeral run (Kimi did).
    const workRuns = await s.sessions.runs({ sessionId: work.id })
    expect(workRuns.map((r) => r.data.mode)).toEqual(['continuing'])
  })
})
