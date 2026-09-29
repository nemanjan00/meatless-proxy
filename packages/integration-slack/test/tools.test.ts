import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSlackIntegration } from '../src/index.ts'
import { BOT_USER, type FakeSlack, startFakeSlack, TOKEN } from './fake-slack.ts'

let slack: FakeSlack
let client: Client
let closeServer: () => Promise<void>

beforeEach(async () => {
  slack = await startFakeSlack()
  const integration = createSlackIntegration({
    secrets: { botToken: TOKEN, signingSecret: 'shh-test' },
    baseUrl: slack.url,
    sleep: async () => {},
  })
  const server = integration.createMcpServer()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientSide)
  closeServer = () => server.close()
})
afterEach(async () => {
  await client.close()
  await closeServer()
  await slack.close()
})

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult
  const text = r.content[0]?.text ?? ''
  let value: unknown = text
  try {
    value = JSON.parse(text)
  } catch {}
  return { isError: r.isError === true, value: value as Record<string, unknown> & { [k: string]: unknown } }
}

describe('slack MCP tools', () => {
  it('lists every tool with a description and read-only hints on reads', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'ask',
        'get_file',
        'list_channels',
        'lookup_user',
        'open_dm',
        'post_blocks',
        'post_message',
        'react',
        'read_channel',
        'read_thread',
        'reply',
        'unreact',
        'update_message',
        'upload_file',
      ].sort(),
    )
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(20)
    expect(tools.find((t) => t.name === 'read_channel')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((t) => t.name === 'post_message')?.annotations?.readOnlyHint).toBe(false)
  })

  it('post_message posts mrkdwn as JSON and returns the ts', async () => {
    const r = await call('post_message', { channel: 'C1', text: '*hi* <@U1>' })
    expect(r.isError).toBe(false)
    expect(r.value).toEqual({ channel: 'C1', ts: expect.stringMatching(/^\d+\.\d+$/) })
    const [c] = slack.callsTo('chat.postMessage')
    expect(c?.contentType).toMatch(/json/)
    expect(c?.params).toEqual({ channel: 'C1', text: '*hi* <@U1>', mrkdwn: true })
  })

  it('post_message with thread_ts posts in the thread', async () => {
    const r = await call('post_message', { channel: 'C1', text: 'in thread', thread_ts: '1712000002.000100' })
    expect(r.value.thread_ts).toBe('1712000002.000100')
    expect(slack.callsTo('chat.postMessage')[0]?.params.thread_ts).toBe('1712000002.000100')
  })

  it('reply answers in a thread; a bad thread is a helpful error', async () => {
    const r = await call('reply', { channel: 'C1', thread_ts: '1712000002.000100', text: 'done' })
    expect(r.isError).toBe(false)
    expect(slack.channels.get('C1')?.messages[0]).toMatchObject({ text: 'done', thread_ts: '1712000002.000100' })
    const bad = await call('reply', { channel: 'C1', thread_ts: '1.2', text: 'x' })
    expect(bad.isError).toBe(true)
    expect(bad.value).toMatchObject({ error: 'thread_not_found', hint: expect.stringContaining('thread root') })
  })

  it('post_message into a channel the app is not in explains how to fix it', async () => {
    const r = await call('post_message', { channel: 'C2', text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.value).toMatchObject({ error: 'not_in_channel', hint: expect.stringContaining('invite') })
  })

  it('rejects invalid arguments', async () => {
    const r = (await client.callTool({ name: 'post_message', arguments: { channel: 'C1' } })) as ToolResult
    expect(r.isError).toBe(true)
    expect(slack.callsTo('chat.postMessage')).toHaveLength(0)
  })

  it('read_channel returns compact top-level messages, newest first, with paging', async () => {
    const first = await call('read_channel', { channel: 'C1', limit: 2 })
    expect(first.value.messages).toEqual([
      { ts: '1712000003.000100', user: 'U2', text: 'third' },
      {
        ts: '1712000002.000100',
        user: 'U1',
        text: 'deploy?',
        thread_ts: '1712000002.000100',
        reply_count: 1,
        reactions: [{ name: 'eyes', count: 1 }],
      },
    ])
    expect(first.value.next_cursor).toEqual(expect.any(String))
    expect(slack.callsTo('conversations.history')[0]?.params).toMatchObject({ channel: 'C1', limit: '2' })
    const second = await call('read_channel', { channel: 'C1', limit: 2, cursor: first.value.next_cursor })
    expect(second.value).toEqual({
      messages: [{ ts: '1712000001.000100', user: BOT_USER, bot_id: 'BBOT', text: 'hello from the bot' }],
      next_cursor: null,
    })
  })

  it('read_channel filters by oldest and latest', async () => {
    const r = await call('read_channel', { channel: 'C1', oldest: '1712000001.500000', latest: '1712000002.900000' })
    expect((r.value.messages as { ts: string }[]).map((m) => m.ts)).toEqual(['1712000002.000100'])
  })

  it('read_thread returns root then replies', async () => {
    const r = await call('read_thread', { channel: 'C1', thread_ts: '1712000002.000100' })
    expect((r.value.messages as { text: string }[]).map((m) => m.text)).toEqual(['deploy?', 'on it'])
    expect(slack.callsTo('conversations.replies')[0]?.params).toMatchObject({ ts: '1712000002.000100', limit: '50' })
  })

  it('react and unreact are idempotent', async () => {
    expect((await call('react', { channel: 'C1', ts: '1712000003.000100', name: ':eyes:' })).value).toEqual({ ok: true })
    expect(slack.callsTo('reactions.add')[0]?.params).toEqual({ channel: 'C1', timestamp: '1712000003.000100', name: 'eyes' })
    expect((await call('react', { channel: 'C1', ts: '1712000003.000100', name: 'eyes' })).value).toEqual({
      ok: true,
      already: true,
    })
    expect((await call('unreact', { channel: 'C1', ts: '1712000003.000100', name: 'eyes' })).value).toEqual({ ok: true })
    expect((await call('unreact', { channel: 'C1', ts: '1712000003.000100', name: 'eyes' })).value).toEqual({
      ok: true,
      already: true,
    })
    const bad = await call('react', { channel: 'C1', ts: '9.9', name: 'eyes' })
    expect(bad.isError).toBe(true)
    expect(bad.value.error).toBe('message_not_found')
  })

  it('lookup_user by id and by email', async () => {
    const byId = await call('lookup_user', { user: 'U1' })
    expect(byId.value).toEqual({
      id: 'U1',
      name: 'ana',
      real_name: 'Ana Example',
      display_name: 'ana',
      email: 'ana@example.com',
      tz: 'Europe/Belgrade',
    })
    const byEmail = await call('lookup_user', { email: 'bo@example.com' })
    expect(byEmail.value).toMatchObject({ id: 'U2', real_name: 'Bo Example' })
    expect(slack.callsTo('users.lookupByEmail')).toHaveLength(1)
    expect((await call('lookup_user', { email: 'nobody@example.com' })).value).toMatchObject({ error: 'users_not_found' })
    expect((await call('lookup_user', {})).isError).toBe(true)
    expect((await call('lookup_user', { user: 'U1', email: 'ana@example.com' })).isError).toBe(true)
  })

  it('open_dm opens a 1:1 or group DM', async () => {
    expect((await call('open_dm', { user: 'U1' })).value).toEqual({ channel: 'DU1' })
    expect(slack.callsTo('conversations.open')[0]?.params).toMatchObject({ users: 'U1' })
    expect((await call('open_dm', { users: ['U1', 'U2', 'U1'] })).value).toEqual({ channel: 'DU1U2' })
    expect((await call('open_dm', {})).isError).toBe(true)
    // The DM channel works with post_message.
    expect((await call('post_message', { channel: 'DU1', text: 'hi' })).isError).toBe(false)
  })

  it('list_channels lists public and private channels the app is in, paginated', async () => {
    const r = await call('list_channels', {})
    expect(r.value).toEqual({
      channels: [
        { id: 'C1', name: 'general', is_member: true, topic: 'Company-wide', members: 3 },
        { id: 'G1', name: 'secret', is_private: true, is_member: true, members: 3 },
      ],
      next_cursor: null,
    })
    expect(slack.callsTo('conversations.list')[0]?.params).toMatchObject({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
    })
    const all = await call('list_channels', { member_only: false, limit: 2 })
    expect((all.value.channels as { id: string }[]).map((c) => c.id)).toEqual(['C1', 'C2'])
    const rest = await call('list_channels', { member_only: false, limit: 2, cursor: all.value.next_cursor })
    expect((rest.value.channels as { id: string }[]).map((c) => c.id)).toEqual(['G1'])
    expect(rest.value.next_cursor).toBeNull()
    // A page with none of the app's channels (C2) isn't returned empty: the next page is read too.
    const first = await call('list_channels', { member_only: false, limit: 1 })
    const skipped = await call('list_channels', { limit: 1, cursor: first.value.next_cursor })
    expect((skipped.value.channels as { id: string }[]).map((c) => c.id)).toEqual(['G1'])
  })

  it("update_message edits the app's own message and refuses others'", async () => {
    const r = await call('update_message', { channel: 'C1', ts: '1712000001.000100', text: 'edited' })
    expect(r.value).toEqual({ channel: 'C1', ts: '1712000001.000100' })
    expect(slack.channels.get('C1')?.messages.find((m) => m.ts === '1712000001.000100')?.text).toBe('edited')
    const other = await call('update_message', { channel: 'C1', ts: '1712000003.000100', text: 'nope' })
    expect(other.isError).toBe(true)
    expect(other.value).toMatchObject({ error: 'cant_update_message', hint: expect.stringContaining('only messages') })
  })

  it('marks rate-limit exhaustion as retryable', async () => {
    const limited = { status: 429, headers: { 'retry-after': '1' } }
    slack.script('conversations.history', limited, limited, limited)
    const r = await call('read_channel', { channel: 'C1' })
    expect(r.isError).toBe(true)
    expect(r.value).toMatchObject({ error: 'unavailable', retryable: true })
  })

  it('serves concurrent tool calls', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call('post_message', { channel: 'C1', text: `m${i}` })),
    )
    expect(results.every((r) => !r.isError)).toBe(true)
    expect(new Set(results.map((r) => r.value.ts)).size).toBe(10)
  })
})
