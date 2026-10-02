import { openAiModel } from '@mp/model-openai'
import type { ToolResultContent } from '@mp/sessions'
import { afterEach, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'
import { quiet } from './scenarios.ts'

// Opt-in: real model calls (MP_LIVE_MODEL_TEST=1, with OPENAI_BASE_URL, OPENAI_API_KEY and MODEL set). Through the
// whole harness (chat, router, the session that owns the thread): Ana asks for a doc, Bo asks for a follow-up change
// in the same thread, then someone asks who asked for that change. The answer must name Bo, from the record (the
// run's requester, the thread), not the person who started the work.
const live = process.env.MP_LIVE_MODEL_TEST === '1'

const realModel = () => {
  const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env
  if (!OPENAI_BASE_URL || !OPENAI_API_KEY || !MODEL) throw new Error('set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL')
  return openAiModel({ baseUrl: OPENAI_BASE_URL, apiKey: OPENAI_API_KEY, model: MODEL, maxRetries: 1, timeoutMs: 170_000 })
}

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

describe.skipIf(!live)('who asked, live (MP_LIVE_MODEL_TEST=1)', () => {
  it('names the person who asked for the follow-up change, not the one who started the work', { timeout: 900_000 }, async () => {
    t = await testApp({ workers: true, overrides: { model: realModel() } })
    const s = t.a.services
    const person = (name: string, handle: string) =>
      s.directory.contacts.create({ name, kind: 'person', access: 'member', handles: [{ system: 'mp', id: handle }] })
    const ana = await t.as((await person('Ana Lima', 'ana')).id)
    const bo = await t.as((await person('Bo Berg', 'bo')).id)
    const cy = await t.as((await person('Cy Ode', 'cy')).id)
    const general = (await s.chat.channelByName('general'))!.id
    const posted = new Set<string>()
    const post = (text: string, h: Record<string, string>, threadId?: string) => {
      posted.add(text)
      return t!.req('POST', `/api/chat/channels/${general}/messages`, { text, ...(threadId ? { threadId } : {}) }, h)
    }
    /** The employee's replies in the thread: everything but what the people posted. */
    const aiReplies = async (threadId: string) =>
      ((await t!.req('GET', `/api/chat/threads/${threadId}`)).body.replies as any[])
        .map((m) => String(m.data.text))
        .filter((text) => !posted.has(text))

    // 1. Ana asks for a piece of work.
    const root = await post(
      '@meatless please write a short knowledge doc titled "Team lunch menu" that lists three soups. Tell me here when it is done.',
      ana,
    )
    expect(root.status).toBe(201)
    await quiet(t, 300_000)
    const afterFirst = (await aiReplies(root.body.id)).length
    expect(afterFirst).toBeGreaterThan(0)

    // 2. Bo, in the same thread, asks for a follow-up change.
    await post('@meatless can you also add a desserts section with two desserts to that doc?', bo, root.body.id)
    await quiet(t, 300_000)
    expect((await aiReplies(root.body.id)).length).toBeGreaterThan(afterFirst)

    // 3. Someone asks who asked for the change.
    const before = (await aiReplies(root.body.id)).length
    await post('@meatless quick question: who asked for the desserts change?', cy, root.body.id)
    await quiet(t, 300_000)
    const replies = await aiReplies(root.body.id)
    const answer = replies.slice(before).join('\n')

    // What the session that owns the thread did to answer.
    const owner = (await s.events.subscriptions.forSubject({ system: 'mp', id: root.body.id })).find((x) => x.data.primary)
    if (owner) {
      const last = (await s.sessions.runs({ sessionId: owner.data.sessionId, newestFirst: true, limit: 1 }))[0]!
      const calls = (await s.sessions.runHistory(last.id))
        .filter((e) => e.kind === 'tool_result' && e.meta.runId === last.id)
        .map((e) => (e.content as unknown as ToolResultContent).name)
      console.log('owner session:', owner.data.sessionId, 'last run tool calls:', calls.join(', '))
      const runs = await s.sessions.runs({ sessionId: owner.data.sessionId })
      console.log('runs and requesters:', runs.map((r) => `${r.data.cause.type}:${r.data.requesterId}`).join(', '))
    }
    console.log('answer:', answer)
    expect(answer).toMatch(/\bBo\b/)
    // It must not say Ana asked for it.
    expect(answer).not.toMatch(/\bAna\b[^.\n]*\basked for (the )?dessert/i)
  })
})
