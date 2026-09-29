import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { sleep } from '@mp/core'
import { callTools, reply, type ModelRequest } from '@mp/model'
import { AI_STREAK_TOPIC } from '@mp/stdlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/auth/rate-limit.ts'
import { agentName, randomAgentName } from '../src/mcp-agents/names.ts'
import { snippet } from '../src/mcp-agents/search.ts'
import type { Services } from '../src/services.ts'
import { createMcpToken } from '../src/tokens.ts'
import { testApp, until, type TestApp } from './helpers.ts'
import { memoryBackend, realBackend, type Backend } from './scenarios.ts'

const text = (r: any) => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n')
const json = (r: any) => JSON.parse(text(r))

describe('agent names', () => {
  it('makes adjective-noun names and validates chosen ones', () => {
    expect(randomAgentName(() => 0)).toBe('amber-acorn')
    expect(randomAgentName(() => 0.9999)).toBe('witty-yarrow')
    expect(randomAgentName()).toMatch(/^[a-z]+-[a-z]+$/)
    expect(agentName('@Ordinary-Plum')).toBe('ordinary-plum')
    for (const bad of ['ab', '1abc', 'has space', 'a--b', 'x'.repeat(31), '-abc', 'abc-']) expect(() => agentName(bad)).toThrow()
  })

  it('cuts snippets around the match', () => {
    const long = `${'a '.repeat(100)}needle ${'b '.repeat(100)}`
    const s = snippet(long, 'NEEDLE')
    expect(s).toContain('needle')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(snippet('short one', 'one')).toBe('short one')
  })
})

function agentSuite(backend: Backend) {
  let t: TestApp & { port: number | null }
  let s: Services
  let cleanup: () => Promise<void>
  let anaId: string
  let bobId: string
  let anaToken: string
  let bobToken: string
  let viewerToken: string
  /** What the employee's model was shown, newest last. */
  const seen: string[] = []

  beforeAll(async () => {
    const b = await backend.make()
    cleanup = b.cleanup
    t = await testApp({
      http: true,
      env: b.env,
      script: async (req: ModelRequest) => {
        const last = req.messages.at(-1)!
        if (last.role === 'tool') return reply('done')
        const content = last.content ?? ''
        seen.push(content)
        const thread = /thread (msg_[A-Za-z0-9]+)/.exec(content)?.[1]
        if (/PING/.test(content) && thread) return callTools([{ name: 'chat.reply', args: { threadId: thread, text: 'pong' } }])
        return reply('ok')
      },
    })
    s = t.a.services
    const ana = await s.directory.contacts.create({
      name: 'Ana Example',
      kind: 'person',
      access: 'member',
      handles: [{ system: 'mp', id: 'ana' }],
    })
    const bob = await s.directory.contacts.create({
      name: 'Bob Example',
      kind: 'person',
      access: 'member',
      handles: [{ system: 'mp', id: 'bob' }],
    })
    const vic = await s.directory.contacts.create({ name: 'Vic Viewer', kind: 'person', handles: [{ system: 'mp', id: 'vic' }] })
    anaId = ana.id
    bobId = bob.id
    anaToken = (await createMcpToken(s, ana.id, 'test')).token
    bobToken = (await createMcpToken(s, bob.id, 'test')).token
    viewerToken = (await createMcpToken(s, vic.id, 'test')).token
  })
  afterAll(async () => {
    await t?.close()
    await cleanup?.()
  })

  async function connect(tok: string) {
    const client = new Client({ name: 'test-agent', version: '0.0.0' })
    const notes: any[] = []
    const channel: any[] = []
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void notes.push(n.params.data))
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/claude/channel') channel.push(n.params)
    }
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${t.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tok}` } },
    })
    await client.connect(transport)
    await client.listTools()
    await sleep(300) // the client opens its notification stream right after initializing
    const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args })
    const disconnect = async () => {
      await transport.terminateSession().catch(() => {})
      await client.close()
    }
    return { client, notes, channel, call, disconnect }
  }

  const settle = async () => {
    await t.settle()
    await t.a.mcp.agents.idle()
  }
  const general = async () => (await s.chat.channelByName('general'))!
  const meatless = async () => (await s.directory.employees.byHandle('meatless'))!
  /** Posts as Bob (a person) straight into chat. */
  const bobPosts = async (channelId: string, body: string, threadId?: string) =>
    s.chat.post({ channelId, author: { kind: 'contact', id: bobId }, text: body, ...(threadId ? { threadId } : {}) })

  it('offers the chat participant tools and declares the Claude Code channel capability', async () => {
    const c = await connect(anaToken)
    const tools = (await c.client.listTools()).tools.map((x) => x.name)
    expect(tools).toEqual(
      expect.arrayContaining([
        'chat_join',
        'chat_leave',
        'chat_join_channel',
        'chat_leave_channel',
        'chat_inbox',
        'chat_search',
        'chat_react',
      ]),
    )
    expect(c.client.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} })
    await c.disconnect()
  })

  it('joins with a chosen name, posts as the agent, and reclaims it on a new connection', async () => {
    const c = await connect(anaToken)
    const joined = json(await c.call('chat_join', { name: 'Ordinary-Plum' }))
    expect(joined).toMatchObject({ name: 'ordinary-plum', handle: '@ordinary-plum', reclaimed: false })
    expect(joined.howTo).toContain('chat_inbox')
    const agent = (await s.directory.contacts.get(joined.contactId))!
    expect(agent.data).toMatchObject({
      kind: 'agent',
      sponsor: anaId,
      online: true,
      handles: [{ system: 'mp', id: 'ordinary-plum' }],
    })

    const posted = json(await c.call('chat_post', { channel: 'general', text: 'Hello from ordinary-plum' }))
    const msg = (await s.chat.getMessage(posted.messageId))!
    expect(msg.data.author).toEqual({ kind: 'contact', id: joined.contactId })
    const read = json(await c.call('chat_read', { channel: 'general' }))
    expect(read.at(-1)).toMatchObject({ author: 'ordinary-plum (agent of Ana Example)', text: 'Hello from ordinary-plum' })
    await c.disconnect()
    await settle()
    expect((await s.directory.contacts.get(joined.contactId))!.data.online).toBe(false)

    const again = await connect(anaToken)
    const back = json(await again.call('chat_join', { name: 'ordinary-plum' }))
    expect(back).toMatchObject({ contactId: joined.contactId, reclaimed: true })
    expect((await s.directory.contacts.get(joined.contactId))!.data.online).toBe(true)

    // Another person can't take it, nor a name a person already has.
    const bob = await connect(bobToken)
    const refused = await bob.call('chat_join', { name: 'ordinary-plum' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/another person's agent/)
    const person = await bob.call('chat_join', { name: 'ana' })
    expect(person.isError).toBe(true)
    expect(text(person)).toMatch(/taken/)
    expect((await bob.call('chat_join', { name: 'x y' })).isError).toBe(true)
    await bob.disconnect()

    // chat_leave goes offline and keeps the contact and its history.
    const left = json(await again.call('chat_leave'))
    expect(left.left).toBe('ordinary-plum')
    expect((await s.directory.contacts.get(joined.contactId))!.data.online).toBe(false)
    expect((await s.chat.getMessage(posted.messageId))!.data.author.id).toBe(joined.contactId)
    // After leaving, posts are the person's again.
    const mine = json(await again.call('chat_post', { channel: 'general', text: 'As Ana again' }))
    expect((await s.chat.getMessage(mine.messageId))!.data.author).toEqual({ kind: 'contact', id: anaId })
    await again.disconnect()
  })

  it('picks a random name, retrying when one is taken', async () => {
    await s.directory.contacts.create({ name: 'Amber', kind: 'person', handles: [{ system: 'mp', id: 'amber-acorn' }] })
    const seq = [0, 0, 0.9999, 0.9999]
    t.a.mcp.agents.random = () => seq.shift() ?? 0.5
    try {
      const c = await connect(bobToken)
      const joined = json(await c.call('chat_join'))
      expect(joined.name).toBe('witty-yarrow')
      expect(joined.handle).toBe('@witty-yarrow')
      // Joining again on the same connection keeps the identity.
      expect(json(await c.call('chat_join')).contactId).toBe(joined.contactId)
      await c.disconnect()
    } finally {
      t.a.mcp.agents.random = Math.random
    }
  })

  it("a viewer's token can read and search, but not join or post", async () => {
    const c = await connect(viewerToken)
    const join = await c.call('chat_join', { name: 'viewer-bot' })
    expect(join.isError).toBe(true)
    expect(text(join)).toMatch(/viewer/)
    expect((await c.call('chat_post', { channel: 'general', text: 'hi' })).isError).toBe(true)
    expect((await c.call('ask', { employee: 'meatless', question: 'hi' })).isError).toBe(true)
    expect((await c.call('chat_read', { channel: 'general' })).isError).toBeFalsy()
    expect((await c.call('chat_search', { query: 'Hello' })).isError).toBeFalsy()
    await c.disconnect()
  })

  it('delivers mentions, DMs, thread replies and joined-channel messages, never its own', async () => {
    const c = await connect(anaToken)
    const me = json(await c.call('chat_join', { name: 'ordinary-plum' }))
    const g = await general()
    const byReason = (reason: string, textPart: string) =>
      until(
        () => c.notes.find((n) => n.type === 'chat.message' && n.reason === reason && n.text.includes(textPart)),
        reason,
        10_000,
      )

    // A mention.
    const mention = await bobPosts(g.id, 'Hey @ordinary-plum, can you look?')
    const m = await byReason('mention', 'can you look')
    expect(m).toMatchObject({ channel: 'general', channelId: g.id, threadId: mention.id, messageId: mention.id })
    expect(m.author).toBe('Bob Example')
    // The Claude Code channel notification carries the same, as string meta with identifier keys.
    const ch = await until(() => c.channel.find((n) => n.meta.message_id === mention.id), 'a channel notification')
    expect(ch.content).toBe('Hey @ordinary-plum, can you look?')
    expect(ch.meta).toMatchObject({ channel: 'general', channel_id: g.id, thread_id: mention.id, reason: 'mention' })
    for (const k of Object.keys(ch.meta)) expect(k).toMatch(/^[A-Za-z0-9_]+$/)

    // Tagged in a thread, then the replies that follow (untagged) reach it too.
    await bobPosts(g.id, 'follow-up without a tag', mention.id)
    expect((await byReason('thread', 'follow-up without a tag')).threadId).toBe(mention.id)

    // A reply in a thread it started.
    const root = json(await c.call('chat_post', { channel: 'general', text: 'Starting a thread' }))
    await bobPosts(g.id, 'reply to plum', root.messageId)
    expect((await byReason('thread', 'reply to plum')).threadId).toBe(root.messageId)

    // A DM: an employee's DM with the agent (made by `ask`).
    const asked = json(await c.call('ask', { employee: 'meatless', question: 'Just saying hi' }))
    const emp = await meatless()
    await s.chat.post({ channelId: asked.channelId, author: { kind: 'contact', id: emp.data.contactId }, text: 'DM for plum' })
    expect((await byReason('dm', 'DM for plum')).channelId).toBe(asked.channelId)

    // A channel it joined.
    const lounge = await s.chat.createChannel({ name: 'lounge', createdBy: { kind: 'contact', id: bobId } })
    expect(json(await c.call('chat_join_channel', { channel: 'lounge' }))).toMatchObject({ joined: 'lounge' })
    expect((await s.chat.members(lounge.id)).some((x) => x.id === me.contactId)).toBe(true)
    await bobPosts(lounge.id, 'news in the lounge')
    expect((await byReason('channel', 'news in the lounge')).channel).toBe('lounge')

    // Its own messages aren't delivered back.
    const own = json(await c.call('chat_post', { channel: 'lounge', text: 'my own lounge post' }))
    await settle()
    expect(c.notes.some((n) => n.messageId === own.messageId)).toBe(false)
    expect(c.notes.some((n) => n.messageId === root.messageId)).toBe(false)

    // Pushed deliveries are read: the inbox is empty.
    expect(json(await c.call('chat_inbox')).messages).toEqual([])

    // After leaving the channel, its messages stop.
    await c.call('chat_leave_channel', { channel: 'lounge' })
    await bobPosts(lounge.id, 'nobody following')
    await settle()
    expect(c.notes.some((n) => n.text === 'nobody following')).toBe(false)

    // A second live connection for the same identity is notified too.
    const d = await connect(anaToken)
    await d.call('chat_join', { name: 'ordinary-plum' })
    await bobPosts(g.id, 'both of you @ordinary-plum')
    await until(() => c.notes.find((n) => n.text === 'both of you @ordinary-plum'), 'first connection')
    await until(() => d.notes.find((n) => n.text === 'both of you @ordinary-plum'), 'second connection')
    await d.disconnect()
    await c.disconnect()
  })

  it('keeps messages missed while disconnected for chat_inbox', async () => {
    const c = await connect(anaToken)
    const me = json(await c.call('chat_join', { name: 'inbox-otter' }))
    await c.disconnect()
    await settle()
    expect((await s.directory.contacts.get(me.contactId))!.data.online).toBe(false)
    const g = await general()
    const first = await bobPosts(g.id, '@inbox-otter first while away')
    await bobPosts(g.id, '@inbox-otter second while away')
    await bobPosts(g.id, 'not for the otter')
    await settle()

    const again = await connect(anaToken)
    await again.call('chat_join', { name: 'inbox-otter' })
    const page = json(await again.call('chat_inbox', { limit: 1 }))
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({ messageId: first.id, reason: 'mention', author: 'Bob Example', channel: 'general' })
    expect(page.more).toBe(true)
    const rest = json(await again.call('chat_inbox'))
    expect(rest.messages.map((x: any) => x.text)).toEqual(['@inbox-otter second while away'])
    expect(rest.more).toBe(false)
    expect(json(await again.call('chat_inbox')).messages).toEqual([])
    // Only for joined connections.
    await again.call('chat_leave')
    expect((await again.call('chat_inbox')).isError).toBe(true)
    await again.disconnect()
  })

  it("searches only what the caller can see, paged with a cursor, and hides others' DMs from agents", async () => {
    const emp = await meatless()
    const g = await general()
    const secret = await s.chat.openDm(
      [
        { kind: 'contact', id: bobId },
        { kind: 'employee', id: emp.id },
      ],
      { kind: 'contact', id: bobId },
    )
    await s.chat.post({ channelId: secret.id, author: { kind: 'contact', id: bobId }, text: 'zebra secret in a DM' })
    for (let i = 1; i <= 5; i++) await bobPosts(g.id, `zebra number ${i}`)
    await settle()

    const c = await connect(anaToken)
    await c.call('chat_join', { name: 'ordinary-plum' })
    const texts: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res: any = json(await c.call('chat_search', { query: 'zebra', limit: 2, ...(cursor ? { cursor } : {}) }))
      expect(res.results.length).toBeLessThanOrEqual(2)
      texts.push(...res.results.map((r: any) => r.snippet))
      for (const r of res.results) expect(r).toMatchObject({ channel: 'general', channelId: g.id, author: 'Bob Example' })
      cursor = res.nextCursor
      pages++
    } while (cursor && pages < 10)
    expect(texts).toEqual(['zebra number 5', 'zebra number 4', 'zebra number 3', 'zebra number 2', 'zebra number 1'])
    expect(pages).toBe(3)

    // Filters: channel, author, time.
    expect(json(await c.call('chat_search', { query: 'zebra', from: '@bob', limit: 100 })).results).toHaveLength(5)
    expect(json(await c.call('chat_search', { query: 'zebra', from: 'meatless' })).results).toHaveLength(0)
    expect(json(await c.call('chat_search', { query: 'zebra', after: '2999-01-01T00:00:00Z' })).results).toHaveLength(0)
    expect(json(await c.call('chat_search', { query: 'zebra', before: '2000-01-01T00:00:00Z' })).results).toHaveLength(0)
    expect((await c.call('chat_search', { query: 'zebra', after: 'yesterday' })).isError).toBe(true)
    expect((await c.call('chat_search', { query: 'zebra', channel: secret.id })).isError).toBe(true)
    expect((await c.call('chat_read', { channel: secret.id })).isError).toBe(true)
    expect((await c.call('chat_post', { channel: secret.id, text: 'sneaking in' })).isError).toBe(true)
    await c.disconnect()

    // Bob, a member of that DM, finds it.
    const b = await connect(bobToken)
    const bobs = json(await b.call('chat_search', { query: 'zebra secret' }))
    expect(bobs.results.map((r: any) => r.channelId)).toEqual([secret.id])
    await b.disconnect()
  })

  it('an agent message in #requests starts work, labelled as from an AI agent on behalf of its person', async () => {
    const c = await connect(anaToken)
    await c.call('chat_join', { name: 'ordinary-plum' })
    await c.call('chat_post', { channel: 'requests', text: 'Please REQ-42 check the build' })
    const shown = await until(() => seen.find((x) => x.includes('REQ-42')), 'the request reaching the employee', 10_000)
    expect(shown).toContain('from another AI agent (ordinary-plum, on behalf of Ana Example)')
    const ev = (
      await s.records.query('event', { where: { source: 'chat' }, orderBy: { field: 'id', dir: 'desc' }, limit: 20 })
    ).items
      .map((e: any) => e.data.payload)
      .find((p: any) => p?.text === 'Please REQ-42 check the build')
    expect(ev.author).toMatchObject({ kind: 'contact', contactKind: 'agent', name: 'ordinary-plum', onBehalfOf: 'Ana Example' })
    await c.disconnect()
  })

  it('caps employee <-> agent ping-pong with the AI-streak limit', async () => {
    const emp = await meatless()
    await s.usage.limits.set({ target: { type: 'employee', id: emp.id }, maxAiStreak: 2 })
    const streaks: any[] = []
    const off = s.bus.subscribe(AI_STREAK_TOPIC, (m) => void streaks.push(m.payload))
    try {
      const c = await connect(anaToken)
      await c.call('chat_join', { name: 'ordinary-plum' })
      const root = json(await c.call('chat_post', { channel: 'general', text: '@meatless PING one' }))
      const pong = await until(
        () => c.notes.find((n) => n.type === 'chat.message' && n.threadId === root.messageId && n.text === 'pong'),
        'the employee answering in the thread',
        15_000,
      )
      expect(pong.reason).toBe('thread')
      await c.call('chat_post', { channel: 'general', thread_id: root.messageId, text: '@meatless PING two' })
      const hit = await until(() => streaks.find((x) => x.threadId === root.messageId), 'the AI-streak limit', 15_000)
      expect(hit).toMatchObject({ max: 2 })
      expect(hit.streak).toBeGreaterThan(2)
      await c.disconnect()
    } finally {
      off()
    }
  })

  it('marks agents left online by an earlier process as offline', async () => {
    const c = await connect(bobToken)
    const me = json(await c.call('chat_join', { name: 'stale-heron' }))
    const person = (await s.directory.contacts.get(bobId))!
    await t.a.mcp.agents.resetPresence()
    expect((await s.directory.contacts.get(me.contactId))!.data.online).toBe(false)
    expect((await s.directory.contacts.get(bobId))!.version).toBe(person.version)
    await c.disconnect()
  })

  it('rate-limits posts per agent', async () => {
    const before = t.a.mcp.agents.postLimiter
    t.a.mcp.agents.postLimiter = new RateLimiter(2, 60_000)
    try {
      const c = await connect(bobToken)
      await c.call('chat_join', { name: 'busy-beaver' })
      expect((await c.call('chat_post', { channel: 'general', text: 'one' })).isError).toBeFalsy()
      expect((await c.call('chat_post', { channel: 'general', text: 'two' })).isError).toBeFalsy()
      const third = await c.call('chat_post', { channel: 'general', text: 'three' })
      expect(third.isError).toBe(true)
      expect(text(third)).toMatch(/too many messages/)
      // The person's own posts (not joined) aren't counted against the agent.
      await c.call('chat_leave')
      expect((await c.call('chat_post', { channel: 'general', text: 'as bob' })).isError).toBeFalsy()
      await c.disconnect()
    } finally {
      t.a.mcp.agents.postLimiter = before
    }
  })
}

describe('MCP chat participants (memory)', () => agentSuite(memoryBackend))

const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL
describe.skipIf(!DATABASE_URL || !REDIS_URL)('MCP chat participants (postgres+bullmq)', () =>
  agentSuite(realBackend(DATABASE_URL!, REDIS_URL!)),
)
