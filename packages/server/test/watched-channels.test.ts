import type { Json } from '@mp/core'
import { afterEach, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function make() {
  const t = await testApp({ workers: false })
  apps.push(t)
  const s = t.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const ana = await s.directory.contacts.create({ name: 'Ana Lopez', kind: 'person', status: 'active' })
  const watch = (w: { source: 'slack' | 'chat'; channel: string; when?: string }[]) =>
    s.directory.employees.update(employee.id, { watch: w })
  const plan = async (input: Parameters<typeof s.events.ingest>[0]) =>
    (await s.router.plan((await s.events.ingest(input)).event)).map((d) => [d.sessionId, d.reason, d.expectedToAct])
  return { t, s, employee, ana, watch, plan, router: employee.data.routerSessionId! }
}

const slackMessage = (payload: Record<string, Json>, extra: Record<string, unknown> = {}) => ({
  source: 'integration:slack',
  type: 'message.posted',
  dedupeKey: `slack:${Math.random()}`,
  subject: { system: 'slack', id: `C0TEST0001:${Math.random()}` },
  payload: { channel: 'C0TEST0001', channel_name: 'bugs', plainConversation: true, ...payload } as Json,
  ...extra,
})

describe('watched channels', () => {
  it("routes a harness channel's unclaimed messages, by channel name, to the watcher's router as information", async () => {
    const { s, ana, watch, plan, router } = await make()
    const bugs = await s.chat.createChannel({ name: 'bugs', createdBy: { kind: 'contact', id: ana.id } })
    const random = await s.chat.createChannel({ name: 'random', createdBy: { kind: 'contact', id: ana.id } })
    const post = (channelId: string) =>
      plan({
        source: 'chat',
        type: 'message.posted',
        dedupeKey: `chat:${Math.random()}`,
        actorContactId: ana.id,
        payload: { channelId, text: 'checkout is broken', author: { kind: 'contact', id: ana.id } } as Json,
      })
    expect(await post(bugs.id)).toEqual([])
    await watch([{ source: 'chat', channel: '#Bugs', when: 'bug reports from support' }])
    expect(await post(bugs.id)).toEqual([[router, 'watch', false]])
    expect(await post(random.id)).toEqual([])
  })

  it('watches a Slack channel by name or id, not for AI authors, and through its own app only', async () => {
    const { s, employee, ana, watch, plan, router } = await make()
    await watch([{ source: 'slack', channel: 'C0TEST0001' }])
    expect(await plan(slackMessage({ text: 'login fails' }, { actorContactId: ana.id }))).toEqual([[router, 'watch', false]])
    // Thread replies nobody owns, and messages from bots without a contact (an alert app), count too.
    expect(await plan({ ...slackMessage({ text: 'same here' }), type: 'message.replied' })).toEqual([[router, 'watch', false]])
    await watch([{ source: 'slack', channel: 'bugs' }])
    expect(await plan(slackMessage({ text: 'login fails' }, { actorContactId: ana.id }))).toEqual([[router, 'watch', false]])
    expect(await plan(slackMessage({ channel: 'C0TEST0002', channel_name: 'general' }))).toEqual([])
    // A message for someone else, or a bare acknowledgement, doesn't either.
    expect(await plan(slackMessage({ text: '<@U0TEST0002> can you look?', addressedToOthers: true }))).toEqual([])
    for (const text of ['thanks!', ':+1:', '👍', 'ok', '<@U0TEST0002> +1'])
      expect(await plan(slackMessage({ text })), text).toEqual([])
    expect(await plan(slackMessage({ text: 'ok, but login still fails' }))).toEqual([[router, 'watch', false]])
    // Edits and reactions don't wake it.
    expect(await plan({ ...slackMessage({}), type: 'message.edited' })).toEqual([])
    // Another AI employee talking there doesn't wake it.
    const other = await s.directory.employees.create({ name: 'Other Bot' })
    const otherContact = other.data.contactId
    expect(await plan(slackMessage({ text: 'deploy done' }, { actorContactId: otherContact }))).toEqual([])
    // With its own Slack app, another employee's copy of the message isn't its own: only its copy wakes it.
    await s.secrets.set('SLACK_SIGNING_SECRET', 'sk-test-signing', { type: 'employee', id: employee.id })
    expect(await plan(slackMessage({}, { employeeId: other.id }))).toEqual([])
    expect(await plan(slackMessage({}, { employeeId: employee.id }))).toEqual([[router, 'watch', false]])
  })
})
