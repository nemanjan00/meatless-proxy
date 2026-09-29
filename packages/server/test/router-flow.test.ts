import { type ModelRequest, reply, type ScriptResult } from '@mp/model'
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
