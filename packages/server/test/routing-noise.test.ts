import { type Json, ManualClock } from '@mp/core'
import { afterToolCall } from '@mp/runner'
import { afterEach, describe, expect, it } from 'vitest'
import { gitlabWantsRouter, mentionsUser } from '../src/integrations/fallback.ts'
import { DM_FOLLOW_MS } from '../src/integrations/policies.ts'
import { testApp, type TestApp } from './helpers.ts'

/**
 * Who hears what nobody claimed: a Slack DM's next message goes to the session that last posted there
 * (not the router), and GitLab builds, pushes and merge requests not about the employee don't wake the router.
 */

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function make() {
  const clock = new ManualClock(Date.UTC(2026, 5, 1, 9))
  const t = await testApp({ workers: false, overrides: { clock } })
  apps.push(t)
  const s = t.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const plan = async (input: Parameters<typeof s.events.ingest>[0]) =>
    (await s.router.plan((await s.events.ingest(input)).event)).map((d) => [d.sessionId, d.reason, d.expectedToAct])
  /** A Slack tool call of a session that succeeded with this output, as the runner's hook sees it. */
  const posted = async (sessionId: string, tool: string, output: Json) => {
    const session = await s.sessions.require(sessionId)
    await s.hooks.transform(afterToolCall, {
      run: { id: 'run_test', data: { employeeId: employee.id, sessionId } },
      session,
      tool: { name: tool },
      result: { output },
    } as never)
  }
  return { t, s, clock, employee, plan, posted, router: employee.data.routerSessionId! }
}

let n = 0
const dm = (text: string, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => {
  const ts = `1780000000.${String(++n).padStart(6, '0')}`
  const thread = (payload.thread_ts as string | undefined) ?? ts
  return {
    source: 'integration:slack',
    type: 'message.direct',
    dedupeKey: `slack:${ts}`,
    subject: { system: 'slack', id: `D0TEST0001/${thread}` },
    payload: {
      channel: 'D0TEST0001',
      channel_type: 'im',
      user: 'U0TEST0001',
      text,
      ts,
      is_reply: thread !== ts,
      ...payload,
    } as Json,
    ...extra,
  }
}

describe('a Slack DM after a session posted in it', () => {
  it('goes to that session for an hour, not to the router, and to whichever session posted last', async () => {
    const { s, clock, plan, posted, router, employee } = await make()
    expect(await plan(dm('hi'))).toEqual([[router, 'fallback', true]])
    const work = await s.sessions.create({ employeeId: employee.id, title: 'Fix the build' })
    await posted(work.id, 'mcp.slack.post_message', { channel: 'D0TEST0001', ts: '1780000000.500000' })
    expect(await plan(dm('I gave more instructions, ping me when that is done'))).toEqual([[work.id, 'subscription', true]])
    // A reply in the thread of its own message reaches it through the thread's subscription.
    expect(await plan(dm('looks good', {}, { thread_ts: '1780000000.500000' }))).toEqual([[work.id, 'subscription', true]])

    const other = await s.sessions.create({ employeeId: employee.id, title: 'Write the report' })
    await posted(other.id, 'mcp.slack.reply', { channel: 'D0TEST0001', ts: '1780000000.600000', thread_ts: '1780000000.000001' })
    expect(await plan(dm('and the numbers?'))).toEqual([[other.id, 'subscription', true]])

    clock.advance(DM_FOLLOW_MS + 60_000)
    expect(await plan(dm('new thing'))).toEqual([[router, 'fallback', true]])
  })

  it("not a channel post, not a finished session, not another employee's DM", async () => {
    const { s, plan, posted, router, employee } = await make()
    const work = await s.sessions.create({ employeeId: employee.id, title: 'Fix the build' })
    await posted(work.id, 'mcp.slack.post_message', { channel: 'C0TEST0001', ts: '1780000000.500000' })
    expect(await plan(dm('hi'))).toEqual([[router, 'fallback', true]])
    await posted(work.id, 'mcp.slack.post_message', { channel: 'D0TEST0001', ts: '1780000000.500001' })
    const other = await s.directory.employees.create({ name: 'Other Bot' })
    expect(await plan(dm('hi', { employeeId: other.id }))).not.toContainEqual([work.id, 'subscription', true])
    await s.records.update('session', work.id, { status: 'done' })
    expect(await plan(dm('hi again'))).toEqual([[router, 'fallback', true]])
  })
})

const gitlab = (type: string, payload: Record<string, unknown>) => ({
  source: 'integration:gitlab',
  type,
  dedupeKey: `gitlab:${Math.random()}`,
  subject: { system: 'gitlab', id: `acme/web!${Math.floor(Math.random() * 1000)}` },
  payload: { project: 'acme/web', ...payload } as Json,
})

describe('GitLab events nobody claimed', () => {
  it('reach the router only when they are about the employee', async () => {
    const { s, plan, router, employee } = await make()
    await s.directory.contacts.update(employee.data.contactId, { handles: [{ system: 'gitlab', id: 'billing-bot' }] })
    expect(await plan(gitlab('push', { actor: 'ana' }))).toEqual([])
    expect(await plan(gitlab('pipeline.failed', { actor: 'ana' }))).toEqual([])
    expect(await plan(gitlab('job.failed', {}))).toEqual([])
    expect(await plan(gitlab('merge_request.updated', { actor: 'ana', assignees: ['bo'], reviewers: [] }))).toEqual([])
    expect(await plan(gitlab('merge_request.opened', { actor: 'ana', reviewers: ['Billing-Bot'] }))).toEqual([
      [router, 'fallback', true],
    ])
    expect(await plan(gitlab('comment.created', { actor: 'ana', body: 'looks fine' }))).toEqual([])
    expect(await plan(gitlab('comment.created', { actor: 'ana', body: '@billing-bot can you fix this?' }))).toEqual([
      [router, 'fallback', true],
    ])
    // Its own actions don't come back to it.
    expect(await plan(gitlab('comment.created', { actor: 'billing-bot', body: '@billing-bot note to self' }))).toEqual([])
    // A trigger still takes any of them (triggers run before the fallback).
    await s.events.triggers.create({
      name: 'failed pipelines',
      employeeId: employee.id,
      match: { source: 'integration:gitlab', type: 'pipeline.failed' },
      target: { type: 'session', sessionId: router },
      enabled: true,
    } as never)
    expect(await plan(gitlab('pipeline.failed', { actor: 'ana' }))).toEqual([[router, 'trigger', true]])
  })

  it('rules, by event', () => {
    expect(gitlabWantsRouter({ type: 'push', payload: {} }, undefined)).toBe(false)
    // Without a username, merge requests and comments still go (only builds are known noise).
    expect(gitlabWantsRouter({ type: 'merge_request.updated', payload: {} }, undefined)).toBe(true)
    expect(gitlabWantsRouter({ type: 'issue.opened', payload: { assignees: ['bot'] } }, 'bot')).toBe(true)
    expect(gitlabWantsRouter({ type: 'comment.created', payload: { body: '@bot hi', system: true } }, 'bot')).toBe(false)
    expect(mentionsUser('ping @bot.', 'bot')).toBe(true)
    expect(mentionsUser('ping @bot-two', 'bot')).toBe(false)
    expect(mentionsUser('mail me at x@bot.example', 'bot')).toBe(false)
  })
})

let linearN = 0
const linear = (type: string, issue: string, payload: Record<string, unknown>) => ({
  source: 'integration:linear',
  type,
  dedupeKey: `linear:${++linearN}`,
  subject: { system: 'linear', id: issue },
  payload: { identifier: issue, ...payload } as Json,
})
const ANA = { id: 'lin-ana', name: 'Ana' }
const BOT = { id: 'lin-bot', name: 'Billing Bot' }

describe('Linear events nobody claimed', () => {
  it('reach the router only when they are about the employee', async () => {
    const { s, plan, router, employee } = await make()
    await s.directory.contacts.update(employee.data.contactId, {
      handles: [
        { system: 'mp', id: 'meatless' },
        { system: 'linear', id: BOT.id },
      ],
    })
    const fallback = [[router, 'fallback', true]]
    // Status moves, edits, labels and comment edits on other people's issues: nothing.
    expect(await plan(linear('issue.updated', 'ENG-1', { actor: ANA, assignee: ANA, changed: ['stateId'] }))).toEqual([])
    expect(await plan(linear('issue.state_changed', 'ENG-1', { actor: ANA, assignee: ANA }))).toEqual([])
    expect(await plan(linear('issue.labeled', 'ENG-1', { actor: ANA }))).toEqual([])
    expect(await plan(linear('comment.updated', 'ENG-1', { author: ANA, body: '@meatless edited' }))).toEqual([])
    expect(await plan(linear('comment.created', 'ENG-1', { author: ANA, body: 'looks fine' }))).toEqual([])
    // Assigned to it, or a comment that mentions it: yes.
    expect(await plan(linear('issue.assigned', 'ENG-2', { actor: ANA, assignee: BOT }))).toEqual(fallback)
    expect(await plan(linear('issue.assigned', 'ENG-3', { actor: ANA, assignee: ANA }))).toEqual([])
    expect(await plan(linear('comment.created', 'ENG-1', { author: ANA, body: '@meatless can you look?' }))).toEqual(fallback)
    // A new comment on an issue assigned to it, or one it commented on, even without a mention.
    expect(await plan(linear('comment.created', 'ENG-2', { author: ANA, body: 'any news?' }))).toEqual(fallback)
    await s.events.ingest(linear('comment.created', 'ENG-4', { author: BOT, actor: BOT, body: 'On it.' }))
    expect(await plan(linear('comment.created', 'ENG-4', { author: ANA, body: 'thanks' }))).toEqual(fallback)
    // Reassigned away: its comments still count, but the assignment no longer does.
    await s.events.ingest(linear('issue.assigned', 'ENG-2', { actor: ANA, assignee: ANA }))
    expect(await plan(linear('comment.created', 'ENG-2', { author: ANA, body: 'never mind' }))).toEqual([])
    // Its own actions never come back to it.
    expect(await plan(linear('comment.created', 'ENG-4', { author: BOT, actor: BOT, body: '@meatless note to self' }))).toEqual(
      [],
    )
    expect(await plan(linear('issue.assigned', 'ENG-5', { actor: BOT, assignee: BOT }))).toEqual([])
    // Other sources are unaffected.
    expect(await plan(dm('hi'))).toEqual(fallback)
  })
})
